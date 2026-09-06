/**
 * `state/fold.ts` — M2.8, the board state fold.
 *
 * **PLAN.md's `Wires` line for M2.8: "this is the only module that combines
 * ticket files and events. Nothing else may read both."** Honoured in both
 * directions here: `foldState` takes `tickets` and `events` as *arguments*
 * and never calls `read()`, `append()`, `openTicketStore()`,
 * `loadBoardConfig()`, or touches the filesystem itself. A fold that fetched
 * its own inputs would quietly become the thing this rule forbids, and every
 * later module would gain a precedent to do the same.
 *
 * ## Two functions, not one (Ruling R7, orchestrator, binding)
 *
 * `foldState` is pure — no I/O, no store access, no event-log access — so
 * golden tests can hit it directly with hand-built fixtures and an injected
 * clock. But M2.7's contract 2 requires `observe()` on every `claim`,
 * `takeover` and `renew` a caller reads off the log, and `observe()` is
 * async and writes under `$XDG_STATE_HOME`. One function cannot be both the
 * pure fold the issue specifies and the thing that performs contract 2, so
 * `observeAndFold` is a thin async wrapper: it performs contract 2, builds
 * the `firstSeen` map `foldState` needs, and delegates.
 *
 * **`observeAndFold` observes `claim`, `takeover` *and* `renew` — all
 * three.** M2.7's contract text says "claim or renew"; that phrasing omits
 * `takeover` by accident (a `--force` claim, PLAN.md:267/M2.10) — all three
 * event kinds carry `lease_until` and all three start or extend a lease. A
 * `takeover` with no `firstSeen` entry would have undefined expiry, exactly
 * the failure mode 7 the observation store exists to prevent.
 *
 * ## Lease expiry — the reader's own clock, never the event's
 *
 * `docs/decisions/0001-coordination-ref.md:277-286` flags lease expiry as
 * "not exercised" by the spike: `findClaim` returned the most recent claim
 * event unconditionally, with no concept of expiry at all. This module is
 * the first to exercise that path, so its rule is stated plainly:
 *
 * - `ClaimEvent`/`TakeoverEvent`/`RenewEvent.lease_until` is **DISPLAY
 *   ONLY, never an expiry input** — it was written by whoever pushed the
 *   event, on a machine whose clock this reader does not control.
 * - Expiry is computed from the **reader's own first-observation time**:
 *   `firstSeen(eventId) + leaseTtlMs` vs `now` (CONCEPT.md §4:163, ADR 0001
 *   fm7).
 * - The live lease is anchored on the **most recent** `claim`/`takeover`/
 *   `renew` event for a ticket (by chain position — see below), so a
 *   `renew` genuinely extends the lease: its own `firstSeen`, not the
 *   original claim's, is what `now` is compared against.
 * - A missing `firstSeen` entry (an anchoring event this reader never
 *   observed via `observe()`) is **never** treated as "not expired" —
 *   that would let an unobserved event hold a lease forever, the wrong
 *   direction to fail for a mutual-exclusion primitive. It is surfaced as
 *   `firstSeenMs: undefined` alongside `expired: true` ("expired-or-unknown"),
 *   not silently collapsed — a caller that cares *why* (never observed, vs.
 *   observed and past its TTL) can tell the two apart.
 *
 * `leaseTtlMs` is a caller-supplied argument, never fetched: this module
 * does not import `board/` or call `loadBoardConfig`, so `claims.lease`
 * (M2.3's config) is unreachable from here without violating PLAN.md rule
 * 2. CONCEPT.md §4 gives a default of 2h; resolving that default from
 * config is the caller's job (M2.9+).
 *
 * `discard()` (the observation-store's release-time cleanup) is **not**
 * this module's — that belongs with `expireStale()` in M2.10. Observing is
 * this module's business; reclaiming observation-store space on
 * release/close/expire is a later dispatch's.
 *
 * ## Chain-position tie-break (M2.7's contract 1, Ruling R12)
 *
 * `events/log.ts`'s `read()` returns records **sorted lexicographically by
 * `id`**, not in append order — confirmed directly against that module's own
 * doc comment (`EventRecord`, `log.ts:1289-1314`). Array index is therefore
 * not append order, and `id`'s own sort value is peer-chosen (a crafted low
 * ULID sorts first regardless of when it was actually appended) — neither is
 * a safe ordering authority. Every ordering decision in this module — the
 * lease anchor, the status walk — sorts by `(month, line)` (`EventRecord`'s
 * own stable chain coordinate: month-ascending, then line-ascending),
 * **never** by `id` and **never** by `position` (`position`'s absolute value
 * is a within-one-`read()`-call ordinal that shifts with `trailingMonths`,
 * so two peers with different lease configs would disagree — breaking ADR
 * 0001's determinism requirement). `since` is never referenced by this
 * module either, for the same "must never gate a mutual-exclusion decision"
 * reason (M2.7's contract 3).
 *
 * ## Status precedence (Ruling R6, decided from CONCEPT.md, not taste)
 *
 * - CONCEPT.md:478 — "Board state is `fold(events)` over ticket files":
 *   ticket files are the base, events fold on top.
 * - CONCEPT.md:475 — claims live in the event log, never the ticket file.
 * - CONCEPT.md:46 — the `cankan:` frontmatter block is a disposable cache
 *   CanKan re-derives after an external (e.g. Backlog.md) write, never the
 *   only copy of anything.
 * - CONCEPT.md §4 (:163) — expiry is measured against the reader's own
 *   first-observation time, never the event's own timestamp.
 *
 * Ruled:
 * 1. **Claim, lease and actor come from the event log only.** The frontmatter
 *    `cankan:` block is never an input to claim/lease determination —
 *    confirmed by `ticket/schema.ts`'s `cankanBlockSchema`, which has no
 *    `claim` and no `actor` field at all. **Deliberate, disclosed deviation
 *    for `aliases` specifically:** `TicketState.aliases` is the event log's
 *    alias chain **plus** the frontmatter's own `cankan.aliases` cache, not
 *    the event log alone — see this file's "alias graph" section below for
 *    why (in short: `store/ticketStore.ts`'s `get()` already resolves
 *    frontmatter aliases, and `read()`'s default two-month window would
 *    otherwise make this fold's alias resolution strictly *weaker* than the
 *    store's for the same id). Flagged as a rule-1 deviation, not a silent
 *    reinterpretation — if a reviewer wants literal "event log only,"
 *    `foldState`'s call to `mergeAliases` is the one line to change.
 * 2. **Status:** the base is frontmatter `status`. Status-bearing events
 *    (`move` only — see Ruling R14 below) fold on top in `(month, line)`
 *    order. An `external-write` event **resets the base**: a `move` ordered
 *    before the most recent `external-write` no longer overrides the file.
 *    Net rule — the newest `move` at or after the most recent
 *    `external-write` wins; if there is none, frontmatter wins. This is
 *    what makes CONCEPT.md:46's "a Backlog.md user loses nothing" true when
 *    Backlog.md rewrites the file with no event. `MoveEvent.from`/`.to` are
 *    column names, not ticket ids, and are uncanonicalized.
 * 3. **The disagreement is exposed, not hidden**: `statusFromFrontmatter`
 *    and `statusFromEvents` sit alongside the resolved `status` so
 *    `show`/`board` can render "the file and the log disagree."
 *
 * **Ruling R14 — `close` produces no status string.** `MoveEvent.to` is a
 * column name and maps straight onto frontmatter `status`; `CloseEvent`
 * carries only `reason?` — no column, and deriving one would need the
 * board's `columns` config, which this fold deliberately does not receive
 * and must not fetch. A `close` event instead sets a separate `closed:
 * true` (plus `closeReason?`) and leaves `status` alone. `closed` is
 * **sticky**: once any `close` event is observed for a ticket, `closed`
 * stays `true` regardless of any later `move` — CONCEPT.md:529 says
 * `cankan close` "moves to last column," so a `move` landing *after* the
 * close in `(month, line)` order is that same close's own side effect, not
 * evidence of a reopen. **Gap, not fixed here:** CONCEPT.md:486/530 names a
 * `reopen` event kind and a `cankan reopen` command, but R1's twelve event
 * kinds (`events/schema.ts`) do not include `reopen` — there is currently no
 * event this fold could use to ever clear `closed` back to `false`. A
 * reopened ticket therefore still folds to `closed: true`, and
 * `queries.ts`'s `blockedBy` would treat it as satisfied when it may not be
 * — flagged for whichever dispatch adds a `reopen` event kind, not solved by
 * inventing one here.
 *
 * **Ruling R15 — events for tickets with no file are reported, never
 * dropped.** A `claim` on a ticket whose file was deleted, or which is not
 * in this checkout, has nothing to fold onto. Silently dropping it would
 * make `claimedBy` under-report and a held claim look free — the wrong
 * direction to fail. Following the house `SkippedBoard`/`SkippedTicket`
 * pattern, every event whose (normalized) `ticket` field matches no
 * `StoredTicket` is counted into `BoardState.orphanedEvents` instead of
 * being folded onto anything.
 *
 * **Event→ticket join is direct id only (Ruling R11).** `Event.ticket` is
 * joined against a `StoredTicket.id` via `normalizeTicketIdForComparison`
 * on both sides (re-exported from `store/index.ts` for exactly this reason
 * — this module's `Depends on` is #28/#30, not #25/`ticket/`, and must not
 * hand-roll a third `.toLowerCase()`). It is **not** routed through
 * `display_id` or through the alias graph below: a `claim`/`renew`/`move`/
 * `close` event's envelope `ticket` is expected to already carry the real,
 * adopted ticket id (the CLI resolves any display id or alias before
 * appending), and attributing those event kinds through a display id would
 * be a real hazard — display ids can be reused across adopts. **Known
 * consequence, not fixed here:** an event appended under a ticket's
 * *pre-adopt* id (before an `alias` event redirected it) reads as orphaned
 * rather than attributed to the renamed ticket. If a future dispatch needs
 * claims to survive a rename, that join needs to change; this fold does not
 * attempt it.
 *
 * The alias graph (`alias.from`/`.to`, both ticket-id-shaped and already
 * canonicalized by `events/schema.ts`) is used for exactly one thing here:
 * populating each ticket's `aliases` list (frontmatter `cankan.aliases`
 * union any alias-event chain that resolves to this ticket), which
 * `state/queries.ts`'s `blockedBy` then uses to resolve a `deps[].id` that
 * names an old, pre-adopt id — mirroring `store/ticketStore.ts`'s own
 * `identifiersFor` (id + `display_id` + frontmatter aliases), extended with
 * the alias *events* that module's own file comment says are M2.8's to
 * fold. A malformed alias chain (a cycle, or a self-loop that should have
 * been rejected at the schema boundary but somehow reached this module
 * anyway) cannot infinite-loop the walk — see `resolveAliasTarget` below.
 * An `alias` event's own envelope `ticket` field has no specified
 * convention (nothing in CONCEPT.md or `events/schema.ts` says what it
 * should be set to) and is treated exactly like every other event kind for
 * orphan-counting purposes — it is not otherwise used.
 *
 * ## What this module deliberately does not do
 *
 * - **No hot loop over `read()`.** `events/log.ts`'s `read()` costs
 *   O(months) sequential subprocess spawns (measured: 611 at
 *   `trailingMonths: 120`). This module's signature already forbids calling
 *   it at all — `tickets` and `events` arrive as arguments, read once by the
 *   caller.
 * - **No `columns` parameter.** Mapping a resolved `status`/`closed` pair
 *   onto a board's configured columns (which one is "done," which is
 *   "ready") is the caller's presentation concern, not this fold's.
 * - **`read()`'s aliasing caveat, documented not fixed:** `read()` defaults
 *   to `trailingMonths: 2`; `alias` events are written once at adopt time
 *   and are effectively permanent facts. A caller that folds over the
 *   default two-month window silently loses any alias adopted more than two
 *   months ago. Callers building `events` for this module from `read()`
 *   should pass a `trailingMonths` wide enough to cover every alias they
 *   need resolvable, or accept that older aliases will not resolve.
 * - **`actor` is not an authenticated identity** (`events/schema.ts`'s own
 *   note, naming this file directly). `LeaseState.actor` is exposed as
 *   attribution/display data only — nothing here reads it as an
 *   authorization decision, and no caller should either.
 */

import { type Event, type EventId, type EventRecord, observe } from "../events/index";
import {
  type CankanBlock,
  normalizeTicketIdForComparison,
  type StoredTicket,
  type TicketIdLookupKey,
} from "../store/index";
import { CanKanError } from "../errors";
import type { ActorId, TicketId } from "../types";
import { StateErrorCodes } from "./errors";

// ============================================================================
// Public shape
// ============================================================================

/** The three event kinds that start or extend a lease (Ruling R7). */
type LeaseAnchorKind = "claim" | "takeover" | "renew";

const LEASE_ANCHOR_KINDS: ReadonlySet<string> = new Set<LeaseAnchorKind>(["claim", "takeover", "renew"]);
/** Every event kind that can end a lease outright, alongside the three above — the full set a ticket's most recent member of decides whether a lease is currently live. */
const LEASE_AFFECTING_KINDS: ReadonlySet<string> = new Set([...LEASE_ANCHOR_KINDS, "release", "close", "expire"]);

/**
 * A ticket's current lease, folded from the most recent `claim`/`takeover`/
 * `renew` event for it (see this file's own comment for the anchoring
 * rule). `undefined` on `TicketState.lease` means there is currently no
 * live lease to report — either the ticket was never claimed, or the most
 * recent lease-affecting event for it was a `release`, `close`, or
 * `expire`.
 */
export interface LeaseState {
  /**
   * The actor named on the anchoring event. **Not an authenticated
   * identity** (`events/schema.ts`) — display/attribution only.
   */
  readonly actor: ActorId;
  /** The id of the anchoring `claim`/`takeover`/`renew` event. */
  readonly eventId: EventId;
  /** Which of the three anchoring kinds this lease is currently anchored on. */
  readonly kind: LeaseAnchorKind;
  /**
   * The anchoring event's own `lease_until` field, verbatim. **DISPLAY
   * ONLY — never used to compute `expired` or `expiresAtMs`.** It was
   * written by whoever pushed the event, on a machine whose clock this
   * reader does not control.
   */
  readonly leaseUntilDisplay: string;
  /**
   * The reader-local epoch-ms instant the anchoring event was first
   * observed (`firstSeen(eventId)`), or `undefined` if this reader has
   * never observed it. `undefined` here means `expired` below is `true`
   * for the "unknown" reason, not the "past its TTL" reason — see this
   * interface's own `expired` doc.
   */
  readonly firstSeenMs: number | undefined;
  /** `firstSeenMs + leaseTtlMs`, or `undefined` when `firstSeenMs` is `undefined`. */
  readonly expiresAtMs: number | undefined;
  /**
   * `true` when `now >= expiresAtMs`, **or** when `firstSeenMs` is
   * `undefined` (an anchoring event this reader never observed is treated
   * as expired-or-unknown, never as "not expired" — treating a missing
   * observation as live would let an unobserved event hold a lease
   * forever). Check `firstSeenMs` to tell the two reasons apart.
   */
  readonly expired: boolean;
}

/** The folded state of one ticket. */
export interface TicketState {
  /** On-disk casing preserved — the same value as `StoredTicket.id`. */
  readonly id: TicketId;
  /** Absolute path to the ticket's file, echoed from `StoredTicket.path`. */
  readonly path: string;
  /** The raw frontmatter `status` value, before any event folds onto it. */
  readonly statusFromFrontmatter: string;
  /**
   * The status implied by the newest `move` event at or after the most
   * recent `external-write` event for this ticket, or `undefined` if there
   * is none (Ruling R6 rule 2).
   */
  readonly statusFromEvents: string | undefined;
  /** `statusFromEvents ?? statusFromFrontmatter` — the resolved status a caller should display by default. */
  readonly status: string;
  /** `true` once any `close` event has been observed for this ticket — sticky (Ruling R14; see this file's own comment for the `reopen` gap). */
  readonly closed: boolean;
  /** The most recent `close` event's `reason`, if any close event carried one. */
  readonly closeReason: string | undefined;
  /** The ticket's current lease, or `undefined` if none is currently live. */
  readonly lease: LeaseState | undefined;
  /** The frontmatter `cankan.display_id`, verbatim, or `undefined` when absent. `state/queries.ts`'s `blockedBy` resolves a `deps[].id` naming a display id (CONCEPT.md's own `PROJ-45` worked example) against this. */
  readonly displayId: string | undefined;
  /**
   * Every identifier this ticket is also known by: frontmatter
   * `cankan.aliases` (as written, on-disk casing) unioned with any
   * `alias` event chain that resolves to this ticket (already lowercased —
   * `events/schema.ts` canonicalizes `alias.from`/`.to`). Deduplicated by
   * `normalizeTicketIdForComparison`, preferring the frontmatter-cased form
   * when both sources name the same id.
   */
  readonly aliases: readonly string[];
  /**
   * The ticket's own `cankan.deps` entries, verbatim (`[]` when the block or
   * the field is absent) — passed through, not resolved. `state/queries.ts`'s
   * `blockedBy` is where a `deps[].id` gets resolved against this board's
   * known ids/`display_id`s/aliases; this fold does not resolve dependency
   * ids itself, only surfaces the raw list so a query can.
   */
  readonly deps: ReadonlyArray<NonNullable<CankanBlock["deps"]>[number]>;
}

/** One ticket id that had events pointing at it but no matching `StoredTicket` (Ruling R15). */
export interface OrphanedTicketEvents {
  /** The comparison-key form of the missing ticket's id — never on-disk casing, since no file exists to have any. */
  readonly ticketId: TicketIdLookupKey;
  /** How many events (of any kind) referenced this id. */
  readonly eventCount: number;
  /** Fixed reason string — no ticket file in `tickets` matches this id. */
  readonly reason: string;
}

/** The result of folding a board's tickets and events together. */
export interface BoardState {
  /** Every ticket that had a `StoredTicket`, folded with its events — sorted by `normalizeTicketIdForComparison(id)` ascending for deterministic output. */
  readonly tickets: readonly TicketState[];
  /** Every ticket id that had events but no matching file — sorted the same way. */
  readonly orphanedEvents: readonly OrphanedTicketEvents[];
}

export interface FoldStateOptions {
  /** The clock every lease-expiry check is measured against. */
  readonly now: number;
  /** The configured lease length, in milliseconds — a caller argument, never fetched from config by this module (Ruling R7). */
  readonly leaseTtlMs: number;
  /**
   * Reader-local first-observation times, keyed by event id — the output of
   * `events/observations.ts`'s `firstSeen()`/`observe()` for every
   * `claim`/`takeover`/`renew` event id the caller has ever seen.
   * Injectable so golden tests can exercise expired-lease handling without
   * sleeping or touching the system clock (and without touching the real
   * observation store at all).
   */
  readonly firstSeen: ReadonlyMap<EventId, number>;
}

export interface ObserveAndFoldOptions {
  /** The clock `observe()` records against (if this is the first observation of an id) and lease expiry is measured against. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Same as `FoldStateOptions.leaseTtlMs` — a caller argument, never fetched. */
  readonly leaseTtlMs: number;
}

// ============================================================================
// Validation
// ============================================================================

function validateLeaseTtlMs(leaseTtlMs: number): void {
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new CanKanError(
      StateErrorCodes.INVALID_LEASE_TTL,
      `leaseTtlMs must be a positive, finite number of milliseconds, got ${leaseTtlMs}`,
      { details: { leaseTtlMs } },
    );
  }
}

// ============================================================================
// Chain-position ordering — (month, line), never `id`/`position` (R12)
// ============================================================================

/** `month` is a fixed-width `yyyy-mm` string (`events/log.ts`), so plain string comparison is chronological. */
function compareChainPosition(a: EventRecord, b: EventRecord): number {
  if (a.month !== b.month) {
    return a.month < b.month ? -1 : 1;
  }
  return a.line - b.line;
}

function sortedByChainPosition(records: readonly EventRecord[]): EventRecord[] {
  return [...records].sort(compareChainPosition);
}

// ============================================================================
// Event -> ticket join (Ruling R11) and orphan detection (Ruling R15)
// ============================================================================

interface JoinResult {
  readonly byTicket: Map<TicketIdLookupKey, EventRecord[]>;
  readonly orphaned: Map<TicketIdLookupKey, number>;
}

/**
 * Joins every event onto the `StoredTicket` whose `id` matches its
 * (already-lowercased) `ticket` field, via `normalizeTicketIdForComparison`
 * on both sides. An event whose `ticket` matches no known ticket is counted
 * in `orphaned` instead — never dropped (Ruling R15). Applied uniformly to
 * every event kind, `alias` included, even though `alias` events are folded
 * separately by `buildAliasEventIndex` below (see this file's own comment on
 * that event kind's envelope `ticket` field having no specified
 * convention).
 */
function joinEventsToTickets(
  tickets: readonly StoredTicket[],
  events: readonly EventRecord[],
): JoinResult {
  const knownIds = new Set<TicketIdLookupKey>(tickets.map((t) => normalizeTicketIdForComparison(t.id)));
  const byTicket = new Map<TicketIdLookupKey, EventRecord[]>();
  const orphaned = new Map<TicketIdLookupKey, number>();

  for (const record of events) {
    const key = normalizeTicketIdForComparison(record.event.ticket);
    if (knownIds.has(key)) {
      const bucket = byTicket.get(key);
      if (bucket === undefined) {
        byTicket.set(key, [record]);
      } else {
        bucket.push(record);
      }
    } else {
      orphaned.set(key, (orphaned.get(key) ?? 0) + 1);
    }
  }

  return { byTicket, orphaned };
}

// ============================================================================
// Lease folding
// ============================================================================

function isLeaseAnchorEvent(
  event: Event,
): event is Extract<Event, { event: LeaseAnchorKind }> {
  return LEASE_ANCHOR_KINDS.has(event.event);
}

function foldLease(
  bucket: readonly EventRecord[],
  firstSeenMap: ReadonlyMap<EventId, number>,
  now: number,
  leaseTtlMs: number,
): LeaseState | undefined {
  const leaseAffecting = sortedByChainPosition(bucket.filter((r) => LEASE_AFFECTING_KINDS.has(r.event.event)));
  if (leaseAffecting.length === 0) {
    return undefined;
  }
  const last = leaseAffecting[leaseAffecting.length - 1] as EventRecord;
  const event = last.event;
  if (!isLeaseAnchorEvent(event)) {
    // Most recent lease-affecting event was a release/close/expire — the
    // lease has ended, regardless of any earlier claim/takeover/renew.
    return undefined;
  }

  const firstSeenMs = firstSeenMap.get(event.id);
  const expiresAtMs = firstSeenMs === undefined ? undefined : firstSeenMs + leaseTtlMs;
  const expired = expiresAtMs === undefined ? true : now >= expiresAtMs;

  return {
    actor: event.actor,
    eventId: event.id,
    kind: event.event,
    leaseUntilDisplay: event.lease_until,
    firstSeenMs,
    expiresAtMs,
    expired,
  };
}

// ============================================================================
// Status folding (Ruling R6 rule 2, Ruling R14)
// ============================================================================

interface StatusFold {
  readonly statusFromEvents: string | undefined;
  readonly closed: boolean;
  readonly closeReason: string | undefined;
}

function foldStatusAndClose(bucket: readonly EventRecord[]): StatusFold {
  const statusEvents = sortedByChainPosition(
    bucket.filter((r) => r.event.event === "move" || r.event.event === "external-write"),
  );

  let statusFromEvents: string | undefined;
  for (const record of statusEvents) {
    if (record.event.event === "move") {
      statusFromEvents = record.event.to;
    } else if (record.event.event === "external-write") {
      // Ruling R6 rule 2: an external-write resets the base back to the
      // frontmatter — any move ordered before it (in chain position) no
      // longer overrides the file.
      statusFromEvents = undefined;
    }
  }

  const closeEvents = sortedByChainPosition(bucket.filter((r) => r.event.event === "close"));
  const closed = closeEvents.length > 0;
  const lastClose = closeEvents[closeEvents.length - 1];
  const closeReason = lastClose !== undefined && lastClose.event.event === "close" ? lastClose.event.reason : undefined;

  return { statusFromEvents, closed, closeReason };
}

// ============================================================================
// Alias folding — used only for `TicketState.aliases` (Ruling R11's
// "direct id only" join is unaffected by this)
// ============================================================================

/**
 * Follows the `from -> to` redirect graph from `start`, stopping the moment
 * it would revisit an already-visited node. This single guard handles both
 * a genuine cycle (`a -> b -> a`) and a self-loop (`a -> a`, which
 * `events/schema.ts`'s `aliasEventSchema` rejects at the boundary but this
 * function does not assume never reaches it): a self-loop's own target is
 * already in `visited` on the very first step, so the walk stops
 * immediately and returns `start` unchanged. Cycle detection beyond this is
 * explicitly not this module's job (CONCEPT.md §6: `dep add`'s), but a
 * malformed alias chain already in the data must not hang the fold.
 */
function resolveAliasTarget(edges: ReadonlyMap<string, string>, start: string): string {
  let current = start;
  const visited = new Set<string>([current]);
  for (;;) {
    const next = edges.get(current);
    if (next === undefined || visited.has(next)) {
      return current;
    }
    visited.add(next);
    current = next;
  }
}

/**
 * Builds, for every known ticket, the set of alias-event-derived ids that
 * resolve to it. Only `alias` events already present in `events` are
 * considered; `from`/`to` are used directly (both already
 * canonicalized/lowercased by `events/schema.ts`), never the envelope
 * `ticket` field. When more than one `alias` event shares the same `from`,
 * the one latest in chain position wins (the same "most recent wins"
 * pattern this file uses for the lease anchor and the status walk).
 */
function buildAliasEventIndex(
  events: readonly EventRecord[],
  knownIds: ReadonlySet<TicketIdLookupKey>,
): Map<TicketIdLookupKey, string[]> {
  const aliasEvents = sortedByChainPosition(events.filter((r) => r.event.event === "alias"));
  const edges = new Map<string, string>();
  for (const record of aliasEvents) {
    const event = record.event;
    if (event.event !== "alias") continue;
    edges.set(event.from, event.to);
  }

  const result = new Map<TicketIdLookupKey, string[]>();
  for (const from of edges.keys()) {
    const target = resolveAliasTarget(edges, from);
    const targetKey = normalizeTicketIdForComparison(target);
    if (knownIds.has(targetKey)) {
      const list = result.get(targetKey);
      if (list === undefined) {
        result.set(targetKey, [from]);
      } else {
        list.push(from);
      }
    }
  }
  return result;
}

function mergeAliases(frontmatterAliases: readonly string[], eventAliases: readonly string[]): string[] {
  const seen = new Set<TicketIdLookupKey>();
  const merged: string[] = [];
  for (const alias of [...frontmatterAliases, ...eventAliases]) {
    const key = normalizeTicketIdForComparison(alias);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(alias);
    }
  }
  return merged;
}

// ============================================================================
// foldState — PURE. No I/O, no store access, no event-log access.
// ============================================================================

export function foldState(
  tickets: readonly StoredTicket[],
  events: readonly EventRecord[],
  options: FoldStateOptions,
): BoardState {
  validateLeaseTtlMs(options.leaseTtlMs);
  const { now, leaseTtlMs, firstSeen } = options;

  const { byTicket, orphaned } = joinEventsToTickets(tickets, events);
  const knownIds = new Set<TicketIdLookupKey>(tickets.map((t) => normalizeTicketIdForComparison(t.id)));
  const aliasEventIndex = buildAliasEventIndex(events, knownIds);

  const ticketStates: TicketState[] = tickets.map((stored) => {
    const key = normalizeTicketIdForComparison(stored.id);
    const bucket = byTicket.get(key) ?? [];
    const lease = foldLease(bucket, firstSeen, now, leaseTtlMs);
    const { statusFromEvents, closed, closeReason } = foldStatusAndClose(bucket);
    const statusFromFrontmatter = stored.ticket.frontmatter.status;
    const frontmatterAliases = stored.ticket.frontmatter.cankan?.aliases ?? [];
    const eventAliases = aliasEventIndex.get(key) ?? [];

    return {
      id: stored.id,
      path: stored.path,
      statusFromFrontmatter,
      statusFromEvents,
      status: statusFromEvents ?? statusFromFrontmatter,
      closed,
      closeReason,
      lease,
      displayId: stored.ticket.frontmatter.cankan?.display_id,
      aliases: mergeAliases(frontmatterAliases, eventAliases),
      deps: stored.ticket.frontmatter.cankan?.deps ?? [],
    };
  });

  ticketStates.sort((a, b) => {
    const ak = normalizeTicketIdForComparison(a.id);
    const bk = normalizeTicketIdForComparison(b.id);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const orphanedEvents: OrphanedTicketEvents[] = [...orphaned.entries()]
    .map(([ticketId, eventCount]) => ({
      ticketId,
      eventCount,
      reason: "no ticket file in this checkout matches this event's ticket id",
    }))
    .sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));

  return { tickets: ticketStates, orphanedEvents };
}

// ============================================================================
// observeAndFold — the thin async wrapper (Ruling R7)
// ============================================================================

/**
 * Performs M2.7's contract 2 (`observe()` on every `claim`, `takeover` and
 * `renew` this call is folding) and delegates to the pure `foldState`.
 *
 * `boardKey` is `events/observations.ts`'s `boardKeyFor(adapter)` result —
 * this module does not compute it itself (it never touches a `GitAdapter`;
 * M2.6 is the only module permitted to shell out to git). Observed
 * sequentially rather than via `Promise.all`: `observe()` is idempotent
 * (first-write-wins) and cheap, and sequential calls keep this wrapper's
 * behaviour simple to reason about under the sibling-lane concurrent-test
 * constraint this task's brief calls out.
 */
export async function observeAndFold(
  boardKey: string,
  tickets: readonly StoredTicket[],
  events: readonly EventRecord[],
  options: ObserveAndFoldOptions,
): Promise<BoardState> {
  validateLeaseTtlMs(options.leaseTtlMs);
  const now = options.now ?? Date.now();

  const idsToObserve = new Set<EventId>();
  for (const record of events) {
    if (LEASE_ANCHOR_KINDS.has(record.event.event)) {
      idsToObserve.add(record.event.id);
    }
  }

  const firstSeenMap = new Map<EventId, number>();
  for (const eventId of idsToObserve) {
    const seenAt = await observe(boardKey, eventId, { now });
    firstSeenMap.set(eventId, seenAt);
  }

  return foldState(tickets, events, { now, leaseTtlMs: options.leaseTtlMs, firstSeen: firstSeenMap });
}
