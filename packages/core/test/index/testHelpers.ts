import type { BoardState, DuplicateTicketId, LeaseState, OrphanedTicketEvents, TicketState } from "../../src/state/index";
import type { ActorId, TicketId } from "../../src/types";

/**
 * Structural fixture builders for `index/`'s tests. Deliberately do not
 * import `store/`, `events/`, `ticket/`, `git/`, `board/` or `config/` --
 * `index/`'s own `Depends on` is `state/` (M2.8) alone (R1), and its tests
 * hold to the same discipline so nothing here accidentally exercises a
 * shape only a forbidden module could have produced. `BoardState`,
 * `TicketState` and `LeaseState` are `state/index.ts`'s own public
 * types, so importing them directly (rather than deriving them by
 * indexed access) is fine -- the indexed-access trick is only needed for
 * fields *inside* those types whose own type name lives in a forbidden
 * module (`EventId`, the lease-anchor-kind union, `TicketIdLookupKey`,
 * the `CankanBlock` dep-entry shape) -- see `db.test.ts`/`reindex.test.ts`
 * for where that actually comes up.
 */

let idCounter = 0;

/** A `TicketState` with every field defaulted to its "absent" shape, so a test only names what it actually varies. */
export function makeTicket(id: string, overrides: Partial<TicketState> = {}): TicketState {
  return {
    id: id as TicketId,
    path: `/fake/board/tickets/${id}.md`,
    statusFromFrontmatter: "To Do",
    statusFromEvents: undefined,
    status: "To Do",
    closed: false,
    closeReason: undefined,
    lease: undefined,
    displayId: undefined,
    aliases: [],
    frontmatterAliases: [],
    eventAliases: [],
    deps: [],
    ...overrides,
  };
}

/** A `LeaseState`, defaulted to a live claim by `overrides.actor` (or a fresh generated actor). */
export function makeLease(overrides: Partial<LeaseState> = {}): LeaseState {
  const n = idCounter++;
  return {
    actor: `actor-${n}` as ActorId,
    eventId: `01LEASEEVENTID00000000${String(n).padStart(3, "0")}` as LeaseState["eventId"],
    kind: "claim",
    leaseUntilDisplay: "2026-01-01T00:00:00Z",
    firstSeenMs: 1_000,
    expiresAtMs: 1_000 + 7_200_000,
    expired: false,
    ...overrides,
  };
}

/**
 * Fix round 3: the clock every `queryTickets(index, { now })` /
 * `queryBoardState(index, { now })` call against a `makeLease()`-based
 * fixture must pass, so its query-time-computed `expired` matches the
 * `expired` the fixture literally asserts. `makeLease`'s own default
 * `expiresAtMs` (`1_000 + 7_200_000` = 7,201,000) is a tiny absolute epoch
 * timestamp -- any real `Date.now()` is billions of ms past it, so the
 * *default* `now` a query would use if none were passed would report
 * every "live" fixture lease as expired, which is not what these fixtures
 * are testing. `RICH_FIXTURE_NOW` sits well before that boundary (and
 * before the fractional-lease fixture's much later `expiresAtMs`, and
 * before `1_000 + 7_200_000` with room to spare), so every "live" lease
 * built with `makeLease()`'s defaults is genuinely live at this instant,
 * and every never-observed lease (`expiresAtMs: undefined`) is still
 * expired regardless of `now` -- see `LeaseState.expired`'s own doc.
 */
export const RICH_FIXTURE_NOW = 500_000;

/** A single-ticket `BoardState` -- used wherever a test just needs *a* real, reindexable board (the "sentinel" fixture the degradation tests seed before corrupting the file). */
export function sentinelState(id = "ck-sentinel"): BoardState {
  return { tickets: [makeTicket(id)], orphanedEvents: [], duplicateTicketIds: [] };
}

/** A `BoardState` with nothing in it -- distinct from "never reindexed" (`INDEX_NOT_BUILT`): this is a real, built, genuinely empty board. */
export function emptyState(): BoardState {
  return { tickets: [], orphanedEvents: [], duplicateTicketIds: [] };
}

/** Named ids/actors used by `buildRichBoardState`'s fixture, so a test can refer to "the ticket with a live lease" by name instead of by array index. */
export interface RichBoardStateIds {
  readonly plain: TicketId;
  readonly closedWithReason: TicketId;
  readonly liveLeaseTicket: TicketId;
  readonly expiredNeverObservedLeaseTicket: TicketId;
  readonly fractionalLeaseTicket: TicketId;
  readonly aliasedTicket: TicketId;
  readonly displayIdTicket: TicketId;
  readonly blockedTicket: TicketId;
  readonly liveLeaseActor: ActorId;
  readonly expiredLeaseActor: ActorId;
  readonly fractionalLeaseActor: ActorId;
  readonly duplicateId: string;
  readonly noMatchId: string;
}

/**
 * A `BoardState` deliberately rich enough that a `toEqual` round-trip
 * against it cannot pass vacuously (controller addendum A4 -- Lesson 1
 * applies to the round-trip test, not just the map loops). Exercises, in
 * one fixture:
 *
 * - both `orphanedEvents` causes,
 * - a `duplicateTicketIds` entry with more than one path,
 * - tickets with empty AND non-empty `aliases`/`frontmatterAliases`/
 *   `eventAliases`/`deps`,
 * - a ticket with a live lease, one with an expired-and-never-observed
 *   lease, and one with no lease at all,
 * - `statusFromEvents` both defined and undefined,
 * - `closeReason` both defined and undefined,
 * - `firstSeenMs`/`expiresAtMs` both defined and undefined,
 * - a fractional-millisecond lease (controller addendum A2 -- these
 *   columns are `REAL`, not `INTEGER`, specifically because this is
 *   reachable),
 * - three `deps` shapes on one ticket: one that resolves via
 *   `frontmatterAliases`, one via `displayId`, and one that resolves to
 *   nothing at all (controller addendum A5 -- validates the round trip
 *   against `state/`'s own `blockedBy`, without reimplementing it here).
 */
export function buildRichBoardState(): { state: BoardState; ids: RichBoardStateIds } {
  const ids: RichBoardStateIds = {
    plain: "ck-plain" as TicketId,
    closedWithReason: "ck-closed" as TicketId,
    liveLeaseTicket: "ck-live-lease" as TicketId,
    expiredNeverObservedLeaseTicket: "ck-expired-lease" as TicketId,
    fractionalLeaseTicket: "ck-fractional-lease" as TicketId,
    aliasedTicket: "ck-aliased" as TicketId,
    displayIdTicket: "ck-display-id" as TicketId,
    blockedTicket: "ck-blocked" as TicketId,
    liveLeaseActor: "alice" as ActorId,
    expiredLeaseActor: "bob" as ActorId,
    fractionalLeaseActor: "carol" as ActorId,
    duplicateId: "dup-ticket",
    noMatchId: "no-such-ticket",
  };

  const tickets: TicketState[] = [
    makeTicket(ids.plain),
    makeTicket(ids.closedWithReason, {
      closed: true,
      closeReason: "wontfix",
      statusFromEvents: "Done",
      status: "Done",
    }),
    makeTicket(ids.liveLeaseTicket, {
      lease: makeLease({ actor: ids.liveLeaseActor, kind: "claim", expired: false }),
    }),
    makeTicket(ids.expiredNeverObservedLeaseTicket, {
      lease: makeLease({
        actor: ids.expiredLeaseActor,
        kind: "renew",
        firstSeenMs: undefined,
        expiresAtMs: undefined,
        expired: true,
      }),
    }),
    makeTicket(ids.fractionalLeaseTicket, {
      lease: makeLease({
        actor: ids.fractionalLeaseActor,
        kind: "takeover",
        firstSeenMs: 1_700_000_000_123.5,
        expiresAtMs: 1_700_000_000_123.5 + 7_200_000,
        expired: false,
      }),
    }),
    makeTicket(ids.aliasedTicket, {
      frontmatterAliases: ["TASK-1"],
      eventAliases: ["legacy-1"],
      aliases: ["TASK-1", "legacy-1"],
    }),
    makeTicket(ids.displayIdTicket, { displayId: "PROJ-99" }),
    makeTicket(ids.blockedTicket, {
      deps: [
        { type: "blocks", id: "TASK-1" }, // resolves via aliasedTicket's frontmatterAliases
        { type: "blocks", id: "PROJ-99" }, // resolves via displayIdTicket's displayId
        { type: "blocks", id: "ck-does-not-exist-anywhere" }, // resolves to nothing
      ],
    }),
  ];

  const orphanedEvents: OrphanedTicketEvents[] = [
    {
      ticketId: ids.noMatchId as OrphanedTicketEvents["ticketId"],
      eventCount: 3,
      cause: "no-matching-ticket",
      reason: "no ticket file declares this id",
    },
    {
      ticketId: ids.duplicateId as OrphanedTicketEvents["ticketId"],
      eventCount: 2,
      cause: "duplicate-ticket-id",
      reason: "more than one ticket file declares this id",
    },
  ];

  const duplicateTicketIds: DuplicateTicketId[] = [
    {
      ticketId: ids.duplicateId as DuplicateTicketId["ticketId"],
      paths: [`/fake/board/tickets-a/${ids.duplicateId}.md`, `/fake/board/tickets-b/${ids.duplicateId}.md`],
    },
  ];

  return {
    state: { tickets, orphanedEvents, duplicateTicketIds },
    ids,
  };
}
