/**
 * `index/reindex.ts` -- M2.14, the full-rebuild-from-`BoardState` half of
 * the SQLite index cache.
 *
 * **Controller ruling (binding, not PLAN.md's text): `reindex` takes an
 * already-folded `BoardState` as input, never ticket files or the event
 * log.** `PLAN.md:288` describes this file as a "full rebuild from store +
 * event log" -- that is wrong and following it produces illegal code:
 * M2.8's `Wires` line makes `state/` "the only module that combines
 * ticket files and events. Nothing else may read both," and this task's
 * `Depends on` is `#31` (M2.8) alone. The caller does `list()` -> `read()`
 * -> `observeAndFold()` and hands the result here; this file never calls
 * any of those three itself, and never imports `store/`, `events/`,
 * `git/`, `board/`, `ticket/` or `config/` (R1). This is also what makes
 * "a query result matches the fold's own answer" **structurally true**
 * rather than a permanent divergence risk between two independent readers
 * of the same tickets/events -- see `query.ts`'s own comment.
 *
 * ## Performance -- prepared statements, reused, inside one transaction
 *
 * The whole perf story (issue #37: a 5k-ticket board reindexes in under
 * 2s) is "prepare each `INSERT` once, `.run()` it once per row, all inside
 * one `db.transaction(...)`" -- never a fresh `db.exec`/`db.run` string
 * per row, and never one transaction per row. `bun:sqlite` is
 * synchronous, so this whole function is synchronous too.
 *
 * ## R4 -- `blockedBy` stays out of scope, on purpose
 *
 * This file stores each ticket's raw `deps` entries verbatim
 * (JSON-encoded) and nothing more: no dependency resolution, no readiness
 * column. Reproducing `blockedBy`'s alias/display-id resolution here would
 * be exactly the divergence risk R1 exists to kill (it needs
 * `buildIdentifierIndex`, which `index/` cannot import), and readiness is
 * M2.11's (`deps/ready.ts`). A caller who needs `blockedBy` reconstructs a
 * `BoardState` with `query.ts`'s `queryBoardState` and calls `blockedBy`
 * on it directly -- see `query.ts`'s own comment for why that is exact,
 * not approximate.
 */
import type { BoardState } from "../state/index";
import { CanKanError } from "../errors";
import type { BoardIndex } from "./db";
import { isIndexCorruptionError } from "./db";
import { IndexErrorCodes } from "./errors";

export interface ReindexOptions {
  readonly index: BoardIndex;
  /** An already-folded `BoardState` -- see this file's header comment. Never files, never the event log. */
  readonly state: BoardState;
  /** `cankan_meta`'s `built_at_ms`, in epoch ms. Defaults to `Date.now()`. */
  readonly now?: number;
  /**
   * `cankan_meta`'s `validity` row -- M2.15's slot (#38, Round 5). Opaque:
   * stored verbatim, never interpreted here, and never validated. `undefined`
   * writes `NULL` (M2.15 has not landed yet, so there is no prior value
   * this call could be preserving by omission -- `reindex` is the only
   * writer of this row today).
   */
  readonly validity?: string;
}

export interface ReindexResult {
  readonly ticketCount: number;
  readonly orphanedEventCount: number;
  readonly duplicateTicketIdCount: number;
}

const DELETE_STATEMENTS = [
  "DELETE FROM tickets",
  "DELETE FROM ticket_aliases",
  "DELETE FROM ticket_deps",
  "DELETE FROM orphaned_events",
  "DELETE FROM duplicate_ticket_ids",
] as const;

const INSERT_TICKET_SQL = `
  INSERT INTO tickets (
    ordinal, id, path, status_from_frontmatter, status_from_events, status,
    closed, close_reason, display_id,
    lease_actor, lease_event_id, lease_kind, lease_until_display,
    lease_first_seen_ms, lease_expires_at_ms, lease_expired_at_reindex
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
`;

const INSERT_ALIAS_SQL =
  "INSERT INTO ticket_aliases (ticket_ordinal, source, position, alias) VALUES (?1, ?2, ?3, ?4)";

const INSERT_DEP_SQL = "INSERT INTO ticket_deps (ticket_ordinal, position, dep_json) VALUES (?1, ?2, ?3)";

const INSERT_ORPHAN_SQL =
  "INSERT INTO orphaned_events (position, ticket_id, event_count, cause, reason) VALUES (?1, ?2, ?3, ?4, ?5)";

const INSERT_DUPLICATE_SQL =
  "INSERT INTO duplicate_ticket_ids (position, path_position, ticket_id, path) VALUES (?1, ?2, ?3, ?4)";

const UPSERT_META_SQL =
  "INSERT INTO cankan_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/**
 * Full rebuild of `options.index`'s content tables from
 * `options.state` -- every row deleted, then every row reinserted, all
 * inside one transaction so a crash mid-rebuild leaves the previous
 * (still-valid) contents intact rather than a half-written table.
 *
 * `dep_json` round-trips each `deps[]` entry through `JSON.stringify` --
 * see `query.test.ts`/`reindex.test.ts` for the empirical check of which
 * assertion (`toEqual` vs `toStrictEqual`) that round-trip needs, and why.
 */
export function reindex(options: ReindexOptions): ReindexResult {
  const { index, state } = options;
  const db = index.db;
  const now = options.now ?? Date.now();

  const run = db.transaction(() => {
    for (const sql of DELETE_STATEMENTS) {
      db.exec(sql);
    }

    const insertTicket = db.prepare(INSERT_TICKET_SQL);
    const insertAlias = db.prepare(INSERT_ALIAS_SQL);
    const insertDep = db.prepare(INSERT_DEP_SQL);
    const insertOrphan = db.prepare(INSERT_ORPHAN_SQL);
    const insertDuplicate = db.prepare(INSERT_DUPLICATE_SQL);
    const upsertMeta = db.prepare(UPSERT_META_SQL);

    state.tickets.forEach((ticket, ordinal) => {
      const lease = ticket.lease;
      insertTicket.run(
        ordinal,
        ticket.id,
        ticket.path,
        ticket.statusFromFrontmatter,
        ticket.statusFromEvents ?? null,
        ticket.status,
        ticket.closed ? 1 : 0,
        ticket.closeReason ?? null,
        ticket.displayId ?? null,
        lease?.actor ?? null,
        lease?.eventId ?? null,
        lease?.kind ?? null,
        lease?.leaseUntilDisplay ?? null,
        lease?.firstSeenMs ?? null,
        lease?.expiresAtMs ?? null,
        // Fix round 3: `lease_expired_at_reindex` is a debug-only
        // snapshot of `lease.expired` at THIS instant -- `query.ts`
        // never reads it back for anything. The authoritative value is
        // recomputed at query time from `lease_expires_at_ms` (see that
        // file's `rowToLease`).
        lease === undefined ? null : lease.expired ? 1 : 0,
      );

      ticket.frontmatterAliases.forEach((alias, position) => {
        insertAlias.run(ordinal, "frontmatter", position, alias);
      });
      ticket.eventAliases.forEach((alias, position) => {
        insertAlias.run(ordinal, "event", position, alias);
      });
      ticket.aliases.forEach((alias, position) => {
        insertAlias.run(ordinal, "merged", position, alias);
      });

      ticket.deps.forEach((dep, position) => {
        insertDep.run(ordinal, position, JSON.stringify(dep));
      });
    });

    state.orphanedEvents.forEach((orphan, position) => {
      insertOrphan.run(position, orphan.ticketId, orphan.eventCount, orphan.cause, orphan.reason);
    });

    state.duplicateTicketIds.forEach((duplicate, position) => {
      duplicate.paths.forEach((path, pathPosition) => {
        insertDuplicate.run(position, pathPosition, duplicate.ticketId, path);
      });
    });

    upsertMeta.run("built_at_ms", String(now));
    upsertMeta.run("validity", options.validity ?? null);
  });

  try {
    run();
  } catch (cause) {
    // Fix round 1, S2: before `IndexErrorCodes.CORRUPT` existed, a
    // corrupt-past-the-probe file's own `DELETE FROM tickets` failed
    // here on `SQLITE_CORRUPT`/`SQLITE_NOTADB` and was folded into the
    // generic `REINDEX_FAILED` -- indistinguishable from a genuine
    // programming error and, worse, the caller's *only* offered remedy
    // failing for the same reason it was needed (verified directly,
    // security review: `e6.ts`'s three-round wedge). Mapped to the same
    // code `query.ts` uses so one `catch` handles corruption discovered
    // by either a read or a write -- see that code's own doc comment for
    // the documented recovery (`rebuildIndex()` then `reindex()` again).
    if (isIndexCorruptionError(cause)) {
      throw new CanKanError(
        IndexErrorCodes.CORRUPT,
        "the index cache is corrupt -- call rebuildIndex() then reindex() again",
        { cause },
      );
    }
    throw new CanKanError(IndexErrorCodes.REINDEX_FAILED, "reindex failed to write the index cache", {
      cause,
    });
  }

  return {
    ticketCount: state.tickets.length,
    orphanedEventCount: state.orphanedEvents.length,
    duplicateTicketIdCount: state.duplicateTicketIds.length,
  };
}
