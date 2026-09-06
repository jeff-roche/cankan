/**
 * `index/query.ts` -- M2.14, filtered reads over the SQLite index cache
 * that reconstruct `TicketState`/`BoardState` values interchangeable with
 * `state/`'s own fold output.
 *
 * **Why "interchangeable with the fold's own output" is a structural fact,
 * not a hope**: `reindex.ts` only ever writes what a `BoardState` handed
 * it already contains, verbatim (R1 -- this whole module never reads a
 * ticket file or the event log itself), so a query here is reading back
 * exactly what one fold produced, not independently re-deriving anything.
 * `db.test.ts`/`query.test.ts` assert this directly: `queryBoardState`
 * and `queryTickets` results `toEqual` the real `state/queries.ts`
 * `byStatus`/`claimedBy` outputs over the same `BoardState`.
 *
 * **R4 -- `blockedBy` is out of scope here, by design, not by omission.**
 * This file never resolves a `deps[].id` against anything -- that needs
 * `buildIdentifierIndex`'s alias/display-id resolution, which lives in
 * `state/queries.ts` and which `index/` cannot import (R1) without
 * reimplementing it and risking exactly the divergence R1 exists to kill.
 * A caller who needs `blockedBy` calls `queryBoardState(idx)` to get an
 * exact `BoardState` back, then calls `blockedBy` on it directly -- the
 * round trip through this cache changes nothing `blockedBy` can observe,
 * because `deps` is stored and read back verbatim.
 *
 * **Every value bound, never interpolated.** `status`, `actor` and `ids`
 * are all attacker-influenceable strings sourced from ticket frontmatter
 * or the shared coordination ref; every one of them reaches SQLite through
 * a `?` placeholder. `limit`/`offset` are bound too, but additionally
 * validated as non-negative safe integers before that -- not for
 * injection safety (binding already provides that), but because an
 * unvalidated `-1`/`1.5`/`NaN` would have a confusing effect on a SQL
 * `LIMIT` clause rather than a validated one.
 *
 * **Fix round 1, S2 -- no raw `SQLiteError` escapes this module.**
 * `queryTickets`/`queryBoardState` both route their SQLite calls through
 * `guardAgainstCorruption`, which maps `SQLITE_CORRUPT`/`SQLITE_NOTADB`
 * (a page the open-time probe never reads, damaged after the fact) and a
 * malformed `dep_json` value (a `JSON.parse` `SyntaxError`) to
 * `IndexErrorCodes.CORRUPT` -- see that code's own doc comment for the
 * wedge this closes and the documented recovery (`rebuildIndex()` then
 * `reindex()`, both in `db.ts`/`reindex.ts`). Any other `bun:sqlite`
 * error (`SQLITE_IOERR`, `SQLITE_BUSY`, and the like) maps to
 * `IndexErrorCodes.QUERY_FAILED` instead, so "no raw `SQLiteError`
 * escapes" holds without exception, not only for the corruption cases.
 *
 * **Fix round 1, M5 -- `loadAliasMaps`/`loadDepsMap` read every alias/dep
 * row on every call regardless of `TicketQuery`, measured and left as-is.**
 * `queryTickets({ limit: 1 })` still costs roughly what `queryTickets({})`
 * costs, because both load the full alias/dep tables before filtering.
 * Measured directly on the existing 5,000-ticket perf fixture
 * (`reindex.perf.test.ts`'s `buildPerfState`, five trials each, this
 * machine): `{ limit: 1 }` 1.6-3.7ms, `{ status: "To Do" }` (1,000 rows)
 * 2.2-3.9ms, `{}` (5,000 rows) 5.7-7.7ms. The disproportion the brief
 * flagged is real -- `limit: 1` does not come close to `O(1)` -- but the
 * absolute cost is single-digit milliseconds at 5,000 tickets, roughly
 * three orders of magnitude under issue #37's 2-second budget (which in
 * any case covers `reindex`, not this path). Left unfixed: joining or
 * filtering the alias/dep loads by the selected ordinals would add real
 * complexity (both tables would need a `WHERE ticket_ordinal IN (...)`
 * keyed off the already-filtered `tickets` result, changing the query
 * shape from "two flat table scans" to "one dependent on the other's
 * output") for a saving this measurement does not show is needed at any
 * board size this project's issue #37 describes. Revisit if a future
 * measurement on a materially larger board shows otherwise -- this is a
 * measured judgment call, not a claim that the shape is optimal.
 */
import type { Database } from "bun:sqlite";
import type { BoardState, DuplicateTicketId, LeaseState, OrphanedTicketEvents, TicketState } from "../state/index";
import { CanKanError } from "../errors";
import type { ActorId, TicketId } from "../types";
import type { BoardIndex } from "./db";
import { isIndexCorruptionError } from "./db";
import { IndexErrorCodes } from "./errors";

/** Filter for `queryTickets`. All fields are ANDed together; an absent field applies no filter. */
export interface TicketQuery {
  /** One status, or any of several (`IN`). */
  readonly status?: string | readonly string[];
  /** LIVE claims only -- mirrors `state/queries.ts`'s `claimedBy` exactly: an expired lease is not a claim (CONCEPT.md §4). */
  readonly actor?: ActorId;
  readonly closed?: boolean;
  /** Exact match on `TicketState.id`, on-disk casing -- never normalized. */
  readonly ids?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

const TICKET_COLUMNS =
  "ordinal, id, path, status_from_frontmatter, status_from_events, status, closed, close_reason, display_id, " +
  "lease_actor, lease_event_id, lease_kind, lease_until_display, lease_first_seen_ms, lease_expires_at_ms, lease_expired";

interface TicketRow {
  readonly ordinal: number;
  readonly id: string;
  readonly path: string;
  readonly status_from_frontmatter: string;
  readonly status_from_events: string | null;
  readonly status: string;
  readonly closed: number;
  readonly close_reason: string | null;
  readonly display_id: string | null;
  readonly lease_actor: string | null;
  readonly lease_event_id: string | null;
  readonly lease_kind: string | null;
  readonly lease_until_display: string | null;
  readonly lease_first_seen_ms: number | null;
  readonly lease_expires_at_ms: number | null;
  readonly lease_expired: number | null;
}

interface AliasRow {
  readonly ticket_ordinal: number;
  readonly source: "merged" | "frontmatter" | "event";
  readonly alias: string;
}

interface DepRow {
  readonly ticket_ordinal: number;
  readonly dep_json: string;
}

interface OrphanedEventRow {
  readonly ticket_id: string;
  readonly event_count: number;
  readonly cause: string;
  readonly reason: string;
}

interface DuplicateTicketIdRow {
  readonly position: number;
  readonly ticket_id: string;
  readonly path: string;
}

/**
 * `cankan_meta.built_at_ms` is `NULL` iff `reindex()` has never run
 * against this file (a freshly created or just-rebuilt schema).
 * Controller addendum A1: querying before that point must not silently
 * report "empty board" -- it throws instead, so "reindex first" is
 * enforced rather than a caller convention.
 */
function assertBuilt(index: BoardIndex): void {
  const row = index.db.query("SELECT value FROM cankan_meta WHERE key = 'built_at_ms'").get() as {
    value: string;
  } | null;
  if (row === null) {
    throw new CanKanError(
      IndexErrorCodes.NOT_BUILT,
      "this index cache has not been reindexed yet -- call reindex() before querying it",
    );
  }
}

function isSqliteShapedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_");
}

/**
 * Runs `fn`, mapping a page-level-corruption-shaped failure (see
 * `isIndexCorruptionError` in `db.ts`) or a malformed `dep_json` value
 * (`JSON.parse` throwing `SyntaxError`) to `IndexErrorCodes.CORRUPT` --
 * fix round 1, S2. Any *other* `bun:sqlite` error (`SQLITE_IOERR`,
 * `SQLITE_READONLY`, `SQLITE_BUSY`, and the like -- a genuine I/O or
 * environment failure, not a bad-contents case) is mapped to
 * `IndexErrorCodes.QUERY_FAILED` instead, so the S2 fix's "no raw
 * `SQLiteError` may escape this module's public surface" holds for every
 * SQLite failure a query can hit, not only the corruption-shaped ones.
 *
 * A `CanKanError` `fn` itself throws (`INDEX_NOT_BUILT`,
 * `INDEX_INVALID_QUERY_LIMIT`/`OFFSET`) passes through completely
 * unchanged, and anything that is not `bun:sqlite`-shaped and not a
 * `SyntaxError` (a genuine programming-error `TypeError`, say) is
 * re-thrown as-is: this only maps the raw, untyped errors `bun:sqlite`
 * and `JSON.parse` throw, never re-wraps this module's own typed ones,
 * and never swallows a genuinely unexpected error by miscategorizing it.
 */
function guardAgainstCorruption<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CanKanError) {
      throw error;
    }
    if (error instanceof SyntaxError || isIndexCorruptionError(error)) {
      throw new CanKanError(
        IndexErrorCodes.CORRUPT,
        "the index cache is corrupt -- call rebuildIndex() then reindex() before querying again",
        { cause: error },
      );
    }
    if (isSqliteShapedError(error)) {
      throw new CanKanError(IndexErrorCodes.QUERY_FAILED, "the index cache query failed", { cause: error });
    }
    throw error;
  }
}

function validateNonNegativeInt(value: number | undefined, label: "limit" | "offset"): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanKanError(
      label === "limit" ? IndexErrorCodes.INVALID_QUERY_LIMIT : IndexErrorCodes.INVALID_QUERY_OFFSET,
      `${label} must be a non-negative safe integer, got ${value}`,
    );
  }
  return value;
}

interface AliasMaps {
  readonly merged: ReadonlyMap<number, readonly string[]>;
  readonly frontmatter: ReadonlyMap<number, readonly string[]>;
  readonly event: ReadonlyMap<number, readonly string[]>;
}

/** Loads every `ticket_aliases` row, grouped by `ticket_ordinal` and kept separate by `source` (never re-merged -- see this file's header comment). */
function loadAliasMaps(db: Database): AliasMaps {
  const rows = db
    .query("SELECT ticket_ordinal, source, alias FROM ticket_aliases ORDER BY ticket_ordinal, source, position")
    .all() as AliasRow[];
  const merged = new Map<number, string[]>();
  const frontmatter = new Map<number, string[]>();
  const event = new Map<number, string[]>();
  for (const row of rows) {
    const target = row.source === "frontmatter" ? frontmatter : row.source === "event" ? event : merged;
    const bucket = target.get(row.ticket_ordinal);
    if (bucket === undefined) {
      target.set(row.ticket_ordinal, [row.alias]);
    } else {
      bucket.push(row.alias);
    }
  }
  return { merged, frontmatter, event };
}

/** Loads every `ticket_deps` row, grouped by `ticket_ordinal`, JSON-parsed back into the raw `deps[]` entry shape. */
function loadDepsMap(db: Database): ReadonlyMap<number, readonly TicketState["deps"][number][]> {
  const rows = db
    .query("SELECT ticket_ordinal, dep_json FROM ticket_deps ORDER BY ticket_ordinal, position")
    .all() as DepRow[];
  const deps = new Map<number, TicketState["deps"][number][]>();
  for (const row of rows) {
    const parsed = JSON.parse(row.dep_json) as TicketState["deps"][number];
    const bucket = deps.get(row.ticket_ordinal);
    if (bucket === undefined) {
      deps.set(row.ticket_ordinal, [parsed]);
    } else {
      bucket.push(parsed);
    }
  }
  return deps;
}

/**
 * A `LeaseState` is either fully present or fully absent (never
 * half-populated): `lease_actor IS NULL` is the single signal that
 * `TicketState.lease === undefined`, matching how `reindex.ts` writes it.
 */
function rowToLease(row: TicketRow): LeaseState | undefined {
  if (row.lease_actor === null) {
    return undefined;
  }
  return {
    actor: row.lease_actor as ActorId,
    // `EventId` is not importable under R1 (it lives in `events/schema.ts`)
    // -- reached by indexed access off `LeaseState` instead (controller
    // addendum A6).
    eventId: row.lease_event_id as LeaseState["eventId"],
    kind: row.lease_kind as LeaseState["kind"],
    leaseUntilDisplay: row.lease_until_display as string,
    firstSeenMs: row.lease_first_seen_ms ?? undefined,
    expiresAtMs: row.lease_expires_at_ms ?? undefined,
    expired: row.lease_expired === 1,
  };
}

function rowToTicketState(row: TicketRow, aliasMaps: AliasMaps, depsMap: ReadonlyMap<number, readonly TicketState["deps"][number][]>): TicketState {
  return {
    id: row.id as TicketId,
    path: row.path,
    statusFromFrontmatter: row.status_from_frontmatter,
    statusFromEvents: row.status_from_events ?? undefined,
    status: row.status,
    closed: row.closed === 1,
    closeReason: row.close_reason ?? undefined,
    lease: rowToLease(row),
    displayId: row.display_id ?? undefined,
    aliases: aliasMaps.merged.get(row.ordinal) ?? [],
    frontmatterAliases: aliasMaps.frontmatter.get(row.ordinal) ?? [],
    eventAliases: aliasMaps.event.get(row.ordinal) ?? [],
    deps: depsMap.get(row.ordinal) ?? [],
  };
}

/**
 * Filtered read over the index cache, reconstructing each matching row as
 * a `TicketState` exact enough to be interchangeable with the fold's own.
 * Always `ORDER BY ordinal` (R3) -- the fold's own `BoardState.tickets`
 * order, preserved rather than recomputed.
 *
 * Throws `INDEX_NOT_BUILT` if `reindex()` has never run against `index`.
 * Throws `INDEX_CORRUPT` (fix round 1, S2) if a page holding the
 * requested rows was damaged after the open-time probe already passed --
 * see this file's header comment.
 */
export function queryTickets(index: BoardIndex, query: TicketQuery = {}): readonly TicketState[] {
  return guardAgainstCorruption(() => queryTicketsUnguarded(index, query));
}

function queryTicketsUnguarded(index: BoardIndex, query: TicketQuery): readonly TicketState[] {
  assertBuilt(index);
  const db = index.db;

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (query.status !== undefined) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length === 0) {
      return [];
    }
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  if (query.actor !== undefined) {
    // Mirrors `state/queries.ts`'s `claimedBy` precisely: an expired
    // lease is not a claim.
    clauses.push("lease_actor = ? AND lease_expired = 0");
    params.push(query.actor);
  }

  if (query.closed !== undefined) {
    clauses.push("closed = ?");
    params.push(query.closed ? 1 : 0);
  }

  if (query.ids !== undefined) {
    if (query.ids.length === 0) {
      return [];
    }
    clauses.push(`id IN (${query.ids.map(() => "?").join(", ")})`);
    params.push(...query.ids);
  }

  const limit = validateNonNegativeInt(query.limit, "limit");
  const offset = validateNonNegativeInt(query.offset, "offset");

  let sql = `SELECT ${TICKET_COLUMNS} FROM tickets`;
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }
  sql += " ORDER BY ordinal";
  if (limit !== undefined) {
    sql += " LIMIT ?";
    params.push(limit);
    if (offset !== undefined) {
      sql += " OFFSET ?";
      params.push(offset);
    }
  } else if (offset !== undefined) {
    // SQLite requires a LIMIT clause for OFFSET to apply; -1 means "no limit".
    sql += " LIMIT -1 OFFSET ?";
    params.push(offset);
  }

  const rows = db.query(sql).all(...params) as TicketRow[];
  if (rows.length === 0) {
    return [];
  }

  const aliasMaps = loadAliasMaps(db);
  const depsMap = loadDepsMap(db);
  return rows.map((row) => rowToTicketState(row, aliasMaps, depsMap));
}

function queryOrphanedEvents(db: Database): readonly OrphanedTicketEvents[] {
  const rows = db
    .query("SELECT ticket_id, event_count, cause, reason FROM orphaned_events ORDER BY position")
    .all() as OrphanedEventRow[];
  return rows.map((row) => ({
    ticketId: row.ticket_id as OrphanedTicketEvents["ticketId"],
    eventCount: row.event_count,
    cause: row.cause as OrphanedTicketEvents["cause"],
    reason: row.reason,
  }));
}

function queryDuplicateTicketIds(db: Database): readonly DuplicateTicketId[] {
  const rows = db
    .query("SELECT position, ticket_id, path FROM duplicate_ticket_ids ORDER BY position, path_position")
    .all() as DuplicateTicketIdRow[];
  const grouped = new Map<number, { ticketId: string; paths: string[] }>();
  for (const row of rows) {
    const entry = grouped.get(row.position);
    if (entry === undefined) {
      grouped.set(row.position, { ticketId: row.ticket_id, paths: [row.path] });
    } else {
      entry.paths.push(row.path);
    }
  }
  // `Map` preserves insertion order, and rows arrived ordered by
  // `position` ascending (the original `BoardState.duplicateTicketIds`
  // array index, preserved verbatim by `reindex.ts` the same way
  // `ordinal` preserves `tickets`' order -- R3's approach, applied here
  // too) -- so this already matches the fold's own order without
  // resorting.
  return Array.from(grouped.values()).map((entry) => ({
    ticketId: entry.ticketId as DuplicateTicketId["ticketId"],
    paths: entry.paths,
  }));
}

/**
 * Reconstructs the full `BoardState` `reindex()` was last called with --
 * all three arrays. Throws `INDEX_NOT_BUILT` if `reindex()` has never run
 * against `index`; throws `INDEX_CORRUPT` (fix round 1, S2) for
 * after-the-probe page corruption -- see this file's header comment.
 *
 * `assertBuilt` is not called explicitly here (code-review Minor M3,
 * fix round 1) -- `queryTicketsUnguarded` below calls it first, and
 * object-literal properties evaluate left to right, so `tickets` (which
 * calls it) always runs before `orphanedEvents`/`duplicateTicketIds`.
 */
export function queryBoardState(index: BoardIndex): BoardState {
  return guardAgainstCorruption(() => ({
    tickets: queryTicketsUnguarded(index, {}),
    orphanedEvents: queryOrphanedEvents(index.db),
    duplicateTicketIds: queryDuplicateTicketIds(index.db),
  }));
}
