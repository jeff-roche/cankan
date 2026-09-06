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
 * **Precise scope of that claim (fix round 5): `foldState` reads neither
 * ticket files nor the event log — it does not, however, mean this whole
 * file never touches the filesystem.** `observeAndFold`, below, *writes*
 * observation records under `$XDG_STATE_HOME` (via `events/observations.ts`'s
 * `observe()`) — that is not a violation of the rule above (it reads
 * neither a ticket file nor the event log to do it), but "reads neither
 * input; writes observation records" is the accurate phrasing, not "never
 * touches the filesystem."
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
 * **...but only when the event's `ticket` joins to a known `StoredTicket`
 * (Ruling I3, security review).** An orphaned event (Ruling R15) is routed
 * straight to `BoardState.orphanedEvents` and `foldState` never reads its
 * `firstSeen` at all, so observing one would write a record under
 * `$XDG_STATE_HOME` that nothing ever reads back and — because `discard()`
 * is keyed per ticket lease (M2.10's) — nothing can ever reclaim either. A
 * peer can push an unbounded number of `claim`s naming nonexistent tickets;
 * skipping the observe call for those is what keeps the observation store
 * bounded by real tickets rather than by whatever a peer chooses to push.
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
 * - The live lease is anchored on the **most recent** `claim`/`takeover`;
 *   a `renew` extends it when it is either the very **first** lease-affecting
 *   event visible in this call's `events` (its own `claim`/`takeover` may
 *   simply have aged out of the caller's read window — see
 *   `resolveLeaseAnchor`'s own doc, Ruling L8, security review, for why
 *   over-honoring here is the safe direction) or when it names the **same
 *   actor as the current anchor** (Ruling M2). A `renew` following a
 *   *visible* `release`/`close`/`expire` mints nothing (Ruling M1's real
 *   content), and a cross-actor `renew` against a *visible* anchor neither
 *   extends nor reassigns it (Ruling M2) — see `resolveLeaseAnchor`'s own
 *   doc for the full state machine. A qualifying `renew` genuinely extends
 *   the lease: its own `firstSeen`, not the original claim's, is what `now`
 *   is compared against.
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
 * **unambiguous** `StoredTicket` is counted into `BoardState.orphanedEvents`
 * instead of being folded onto anything.
 *
 * **`orphanedEvents` now carries two distinct causes, not one (Ruling D1,
 * fix round 6, security/code review) — say which, don't just say
 * "missing."** An event can land there because no file matches its ticket
 * id at all, **or** because more than one file does (see Ruling D1 below):
 * those are opposite failures with opposite remedies ("create the ticket"
 * vs. "delete/rename one of the colliding files"), and collapsing them into
 * one "no ticket file... matches this event's ticket id" message pointed an
 * operator investigating a duplicate-id incident at the wrong cause.
 * `OrphanedTicketEvents.cause` distinguishes them; `reason` is a
 * human-readable string for whichever one applies.
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
 * populating each ticket's `eventAliases` list, which `TicketState.aliases`
 * merges with the frontmatter's own `frontmatterAliases` for display, and
 * which `state/queries.ts`'s `blockedBy` uses (kept **separate** from
 * `frontmatterAliases` there — Ruling I1, security review, below) to
 * resolve a `deps[].id` that names an old, pre-adopt id — mirroring
 * `store/ticketStore.ts`'s own `identifiersFor` (id + `display_id` +
 * frontmatter aliases), extended with the alias *events* that module's own
 * file comment says are M2.8's to fold. A malformed alias chain (a cycle,
 * or a self-loop that should have been rejected at the schema boundary but
 * somehow reached this module anyway) cannot infinite-loop the walk — see
 * `resolveAllAliasTargets` below. An `alias` event's own envelope `ticket`
 * field has no specified convention (nothing in CONCEPT.md or
 * `events/schema.ts` says what it should be set to) and is treated exactly
 * like every other event kind for orphan-counting purposes — it is not
 * otherwise used.
 *
 * **Nothing derived from the alias graph is a mutual-exclusion input.**
 * `eventAliases` is writable by any contributor with push access to the
 * coordination ref (the same trust boundary every other event-log-derived
 * field in this module already assumes — `events/schema.ts`'s `actor` note
 * applies equally here). Two peers whose local ticket files differ can
 * legitimately compute a different `aliases`/`blockedBy` result for the
 * same ticket. That is acceptable for a display convenience or a readiness
 * hint; it must never be read as agreement between peers the way a claim
 * is — only the event log's own claim/lease events arbitrate who holds a
 * ticket, regardless of what the alias graph says about anything.
 *
 * **Ruling I1 (security review) — alias resolution that gates a decision
 * must be tiered, never a flat overwrite.** `state/queries.ts`'s
 * `buildIdentifierIndex` is the one place an alias resolution actually
 * decides something (`blockedBy`'s satisfied/outstanding verdict). A flat
 * `id + displayId + frontmatterAliases + eventAliases` map, built by
 * unconditional `Map.set()` calls, lets a later entry silently overwrite an
 * earlier one — verified directly: a well-formed hostile
 * `alias {from: <victim's real id>, to: <any closed ticket>}` overwrote the
 * victim's own id entry with the attacker's chosen target, so `blockedBy`
 * reported the victim's dependents as satisfied without the victim ever
 * being closed. `buildIdentifierIndex` instead resolves one tier at a time,
 * most-authoritative first (`id`, then `displayId`, then
 * `frontmatterAliases`, then `eventAliases`), and a key already claimed by
 * an earlier tier is never touched by a later one; a same-tier collision
 * between two different tickets resolves to neither, reported as
 * unresolved rather than picked arbitrarily — see that function's own doc.
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
   * Every identifier this ticket is also known by, merged from
   * `frontmatterAliases` and `eventAliases` below (deduplicated by
   * `normalizeTicketIdForComparison`, preferring the frontmatter-cased form
   * when both name the same id) — a display-only convenience for
   * `show`/`board` ("also known as ..."). **Not for resolving a dependency
   * or any other decision** — see `frontmatterAliases`'/`eventAliases`'
   * own docs for why the two provenances must stay distinguishable
   * wherever a decision (not just a display) is at stake, and see this
   * file's own header for why nothing derived from the alias graph is a
   * mutual-exclusion input.
   */
  readonly aliases: readonly string[];
  /**
   * The frontmatter's own `cankan.aliases` (as written, on-disk casing) —
   * repo-controlled: only whoever can write this ticket's file (typically
   * `adopt`/`renumber`, run locally) can add one. Kept separate from
   * `eventAliases` (Ruling I1, security review) precisely so a caller
   * resolving a dependency can weight the two differently — a hostile
   * `alias` event pushed to the shared coordination ref must not be
   * indistinguishable from a locally-written fact when one of them gates a
   * readiness decision. See `state/queries.ts`'s `buildIdentifierIndex`.
   */
  readonly frontmatterAliases: readonly string[];
  /**
   * Ids that resolve to this ticket via the `alias` event graph
   * (`fold.ts`'s alias-graph section) — already lowercased
   * (`events/schema.ts` canonicalizes `alias.from`/`.to`).
   * **Event-derived, therefore writable by anyone with push access to the
   * coordination ref** (Ruling I1, security review): a well-formed
   * `alias {from: <victim>, to: <any ticket>}` is indistinguishable, at
   * this field alone, from a legitimate adopt/renumber redirect. Kept
   * separate from `frontmatterAliases` so a caller resolving a dependency
   * (`state/queries.ts`'s `blockedBy`) can refuse to let this provenance
   * silently override a more-authoritative one.
   */
  readonly eventAliases: readonly string[];
  /**
   * The ticket's own `cankan.deps` entries, verbatim (`[]` when the block or
   * the field is absent) — passed through, not resolved. `state/queries.ts`'s
   * `blockedBy` is where a `deps[].id` gets resolved against this board's
   * known ids/`display_id`s/aliases; this fold does not resolve dependency
   * ids itself, only surfaces the raw list so a query can.
   */
  readonly deps: ReadonlyArray<NonNullable<CankanBlock["deps"]>[number]>;
}

/**
 * Which of the two opposite reasons an id's events could not be folded
 * (Ruling D1, fix round 6): `"no-matching-ticket"` — no `StoredTicket` at
 * all declares this id (Ruling R15's original case); or
 * `"duplicate-ticket-id"` — more than one `StoredTicket` declares it, so
 * there is no safe file to pick (see `DuplicateTicketId`). The remedy is
 * opposite for each: create the missing ticket, vs. delete or rename one of
 * the colliding files.
 */
export type OrphanedTicketEventsCause = "no-matching-ticket" | "duplicate-ticket-id";

/** One ticket id that had events pointing at it but no single `StoredTicket` they could be folded onto (Ruling R15, extended by Ruling D1). */
export interface OrphanedTicketEvents {
  /**
   * The comparison-key form of the id. On-disk casing is never available:
   * for `"no-matching-ticket"` there is no file to have any; for
   * `"duplicate-ticket-id"` more than one file exists but they may disagree
   * on casing, so there is no single answer to prefer (see
   * `DuplicateTicketId.paths` for the actual files).
   */
  readonly ticketId: TicketIdLookupKey;
  /** How many events (of any kind) referenced this id. */
  readonly eventCount: number;
  /** Which of the two causes applies — check this, not `reason`, for anything other than display. */
  readonly cause: OrphanedTicketEventsCause;
  /** Human-readable string describing whichever `cause` applies — for display, not for a caller to branch on. */
  readonly reason: string;
}

/**
 * Two or more `StoredTicket`s whose ids collide under
 * `normalizeTicketIdForComparison` (Ruling D1, fix round 5, security
 * review). **No casing trick, and no relationship to the filename, is
 * required to cause this (fix round 6 correction — an earlier version of
 * this comment implied one was)**: `store/ticketStore.ts`'s `list()` reads
 * a ticket's id from `ticket.frontmatter.id` alone and never compares it to
 * the filename it came from, so any two ticket-shaped files whose
 * frontmatter `id` fields normalize to the same value collide — including
 * two files with `id: ck-1` verbatim, identical casing, arbitrary
 * filenames. The `ck-1 - a.md` / `CK-1 - b.md` casing example is one way to
 * cause this, not the requirement. `store/ticketStore.ts`'s
 * `get()`/`write()`/`remove()`/`archive()` all guard this (`STORE_
 * AMBIGUOUS_TICKET_LOOKUP`), but `list()` — this fold's natural input —
 * deliberately does not: nothing at the store/state seam previously stopped
 * two such files from reaching `foldState` together. See `foldState`'s own
 * comment for what this fold does about it.
 */
export interface DuplicateTicketId {
  /** The comparison-key form shared by every colliding file's `id`. */
  readonly ticketId: TicketIdLookupKey;
  /** Absolute paths of every `StoredTicket` sharing this normalized id, sorted for deterministic output. */
  readonly paths: readonly string[];
}

/** The result of folding a board's tickets and events together. */
export interface BoardState {
  /**
   * Every ticket that had an unambiguous `StoredTicket`, folded with its
   * events — sorted by `normalizeTicketIdForComparison(id)` ascending for
   * deterministic output. A ticket whose normalized id collides with
   * another `StoredTicket`'s is **excluded** here (Ruling D1) — see
   * `duplicateTicketIds`.
   */
  readonly tickets: readonly TicketState[];
  /**
   * Every ticket id whose events could not be folded onto a single
   * `StoredTicket` — sorted the same way as `tickets`. Two distinct causes,
   * distinguished by each entry's own `cause` field (Ruling D1, fix round 6):
   * no file declares the id at all, or more than one file does (cross-check
   * against `duplicateTicketIds` for the second case).
   */
  readonly orphanedEvents: readonly OrphanedTicketEvents[];
  /**
   * Every normalized ticket id claimed by more than one `StoredTicket`
   * (Ruling D1, fix round 5, security review) — sorted by `ticketId`
   * ascending. Every event whose `ticket` names one of these ids is
   * reported in `orphanedEvents` instead of being folded (there is no safe
   * way to pick which of the colliding files it belongs to), the same
   * "report what cannot be resolved, never guess" discipline Ruling R15
   * already applies to an event naming no file at all — those
   * `orphanedEvents` entries carry `cause: "duplicate-ticket-id"` and their
   * `ticketId` is a key into this array.
   *
   * **Binding forward constraint, alongside `blockedBy`'s own (see
   * `queries.ts`): no downstream consumer may read a ticket's absence from
   * `tickets` above as "this id does not exist" or "this id is unclaimed"
   * without first checking whether that id appears here.** An id excluded
   * from `tickets` because it is ambiguous is not the same fact as an id
   * that was never created, and a consumer that conflates the two (e.g. by
   * treating "not in `tickets`" as "safe to claim") reopens exactly the
   * fail-open-on-readiness hazard this field exists to close.
   */
  readonly duplicateTicketIds: readonly DuplicateTicketId[];
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
 *
 * **`tickets` here is always the caller's already-deduplicated set (Ruling
 * D1) — `foldState` passes `partitionByDuplicateId(...).unique`, never the
 * raw input.** So `orphaned` conflates two causes this function itself
 * cannot tell apart: an id no `StoredTicket` declares at all, and an id
 * more than one `StoredTicket` declared (excluded from "known" upstream,
 * for exactly the reason it is ambiguous). `foldState` is what
 * distinguishes the two, by cross-referencing `orphaned`'s keys against
 * `duplicateTicketIds` when it builds the final `OrphanedTicketEvents` list
 * — see that function and `OrphanedTicketEventsCause`'s own doc.
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

type LeaseAnchorEvent = Extract<Event, { event: LeaseAnchorKind }>;

/**
 * Walks a ticket's lease-affecting events in chain order, tracking the
 * current anchor (the `claim`/`takeover`/`renew` a live lease would be
 * anchored on, or `undefined` if there is none right now):
 *
 * - `release`/`close`/`expire` end whatever lease is active — anchor
 *   becomes `undefined`, regardless of what it was.
 * - `claim`/`takeover` unconditionally become the new anchor, live or not
 *   (M3, security review: deliberately **not** gated on whether an
 *   existing anchor is still unexpired — `firstSeen` is reader-local, so a
 *   "keep the incumbent if unexpired" rule would make two readers disagree
 *   about the holder, which ADR 0001:801-825 forbids. Whether an honest
 *   reclaim should even reach this fold as a plain `claim` at all is
 *   M2.10's write-protocol question, not this fold's to answer by
 *   inventing a read-side rule).
 * - `renew` extends the current anchor when its actor matches the current
 *   one (Ruling M2, security review: a `renew` from a *different* actor
 *   than the incumbent's would silently reassign the lease to whoever last
 *   pushed a `renew` — `actor` is not an authenticated identity, so this is
 *   not a security boundary, but it costs nothing to refuse it; the renew
 *   is simply not folded in, leaving the prior anchor exactly as it was),
 *   **or when it is the very first lease-affecting event in `leaseAffecting`
 *   at all** (Ruling L8, security review — see below for why this is a
 *   correction of an earlier, over-tightened M1, not new content). A
 *   `renew` that is neither (no anchor yet, and not the first event this
 *   walk has seen at all) mints nothing — that is M1's real, retained
 *   content: a lease a *visible* `release`/`close`/`expire` has already
 *   ended does not come back from a bare `renew`.
 *
 * **Ruling L8 — the original M1 ("a renew with no unended incumbent mints
 * nothing," unconditionally) broke honest actors.** `leaseAffecting` is
 * whatever slice of the log `events` happens to cover — in practice
 * `read()`'s window, `trailingMonths` (default 2). A ticket claimed, then
 * renewed on a schedule for long enough, eventually has its *original*
 * `claim` age out of that window while the `renew`s remain visible. Under
 * the original M1, every reader — including the actor who actually holds
 * the ticket — would then see `leaseAffecting` start with a `renew` and no
 * preceding anchor, fold `lease: undefined`, and let a second actor claim
 * the same ticket: two workers on one ticket, no attacker required,
 * reproduced directly against this fix. The fold cannot tell "no claim ever
 * happened" apart from "the claim aged out of my caller's window" — it only
 * ever sees `leaseAffecting`, never the full history — so treating a
 * `renew` at the very start of that slice as anchoring is the only
 * available fail-safe direction for a *mutual-exclusion* primitive: it
 * over-honors a lease that might already be long gone (a stall — the
 * ticket looks held a little longer than strictly necessary) rather than
 * under-honoring one that is very much still held (a double-claim). This
 * mirrors the fold's other window-truncation gaps (documented above: the
 * alias graph loses aliases older than the read window) with one difference
 * worth naming explicitly: those are display/readiness concerns, and this
 * is the mutual-exclusion primitive itself, which is exactly why the safe
 * default here is "assume held," not "assume free."
 *
 * A concrete trace worth keeping in mind: `events` = `[claim(alice),
 * release]` (both now outside the window) followed by `renew(alice)`
 * (inside the window). This function sees only the `renew`, folds it as a
 * fresh anchor, and reports the ticket as held by alice — even though the
 * `release` genuinely ended that lease. This is a **stall** (alice's own
 * client will keep renewing a lease nobody contests, and the ticket simply
 * never frees up until she stops), not a race: no second actor can be
 * admitted to hold the same ticket at the same time by this path, because
 * `release` was real and in the past — there is nothing left to double
 * with. Accepted as the cost of not under-honoring the case that matters.
 *
 * The near-zero security content the original M1 was trying to add is
 * covered elsewhere already: a bare `renew(mallory)` with no incumbent at
 * all gives Mallory nothing a bare `claim(mallory)` doesn't already give
 * her, since M3 (above) makes `claim`/`takeover` anchor unconditionally
 * regardless of any existing incumbent.
 *
 * **L8 also has a cross-reader property, not just a within-reader one
 * (fix round 4, security review) — worth naming since M3's own paragraph a
 * few lines up invokes cross-reader disagreement as a reason to *reject* a
 * rule, and leaving this unmentioned here would read as though L8 has no
 * such property.** With the identical log `[claim(alice), renew(mallory),
 * renew(alice)]`, a reader whose window includes all three sees the anchor
 * as `renew(alice)` (same-actor extension, M2), while a reader whose window
 * has truncated `claim(alice)` out sees only `[renew(mallory),
 * renew(alice)]` and anchors on `renew(mallory)` first (L8's first-event
 * rule), then `renew(alice)` fails M2's same-actor check against *that*
 * anchor and is dropped — so the narrow-window reader reports **mallory**
 * where the wide-window reader reports **alice**. Bounded, not open-ended:
 * mallory pushing a plain `claim` gets her the ticket in *every* window
 * deterministically already (M3), so this path never grants her anything
 * beyond what a `claim` already would — the renew path is strictly weaker,
 * never stronger. The benign case (no `renew(mallory)` in the log at all)
 * agrees across every window, and the disagreement window self-heals the
 * moment any reader observes a real `claim` event, at which point every
 * reader converges again. `actor` being unauthenticated (this file's own
 * closing note) is what makes tolerating this bounded disagreement
 * acceptable rather than a mutual-exclusion violation in its own right.
 */
function resolveLeaseAnchor(leaseAffecting: readonly EventRecord[]): LeaseAnchorEvent | undefined {
  let anchor: LeaseAnchorEvent | undefined;

  for (let i = 0; i < leaseAffecting.length; i++) {
    const event = (leaseAffecting[i] as EventRecord).event;
    if (event.event === "release" || event.event === "close" || event.event === "expire") {
      anchor = undefined;
    } else if (event.event === "claim" || event.event === "takeover") {
      anchor = event;
    } else if (event.event === "renew") {
      if (i === 0 || (anchor !== undefined && anchor.actor === event.actor)) {
        anchor = event;
      }
    }
  }

  return anchor;
}

function foldLease(
  bucket: readonly EventRecord[],
  firstSeenMap: ReadonlyMap<EventId, number>,
  now: number,
  leaseTtlMs: number,
): LeaseState | undefined {
  const leaseAffecting = sortedByChainPosition(bucket.filter((r) => LEASE_AFFECTING_KINDS.has(r.event.event)));
  const anchor = resolveLeaseAnchor(leaseAffecting);
  if (anchor === undefined) {
    return undefined;
  }

  const firstSeenMs = firstSeenMap.get(anchor.id);
  const expiresAtMs = firstSeenMs === undefined ? undefined : firstSeenMs + leaseTtlMs;
  const expired = expiresAtMs === undefined ? true : now >= expiresAtMs;

  return {
    actor: anchor.actor,
    eventId: anchor.id,
    kind: anchor.event,
    leaseUntilDisplay: anchor.lease_until,
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
 * Resolves every node in `edges` (the `from -> to` redirect graph, out-degree
 * at most 1 per node) to its final target, in one amortized-linear pass —
 * **not** one from-scratch walk per node (I2, security review: the original
 * per-call walk was O(N) per node and called once per node, making the whole
 * build O(N²); measured directly at N=16,000, ~4.7s for `foldState` alone,
 * from a blob any contributor can push to).
 *
 * **The semantics being reproduced, node by node, are the ones a fresh,
 * from-scratch walk per node would give** (the pre-I2-fix `resolveAliasTarget`,
 * preserved unmodified below as a private reference implementation the
 * memoized version is tested against): walk forward from `start`, stop the
 * moment the next step would revisit a node already seen **on this walk**,
 * and return the last node reached before that. On an acyclic chain that
 * ends at a true sink (a node with no outgoing edge), every node on the
 * chain resolves to that sink — the ordinary, unsurprising case. On a
 * *cycle*, this per-node walk has a real consequence: starting from a
 * different node on the same cycle can give a different answer (each node
 * resolves to *its own predecessor* on the cycle, since that is the last
 * new node its own walk reaches before it would revisit itself) — see
 * `resolveCycleAndTail`'s own doc for the worked derivation.
 *
 * **The bug this replaced (Critical, fix round 3, security review):** an
 * earlier version of this function cached whatever node a walk happened to
 * stop at — including a stop caused by *hitting a cycle*, not a validated
 * sink — and let a *later* walk short-circuit onto that cached value as if
 * it were stable. For a 2-node cycle `a <-> b`, that made the result depend
 * on which node's `resolve()` call happened to run first, which in turn
 * depended on event order: `[a→b, b→a]` gave `eventAliases: []` for a real
 * ticket `a` (silently dropping a genuine alias); `[b→a, a→b]` gave
 * `eventAliases: ["b", "a"]` for the same ticket (fabricating `a` as its own
 * alias). Order must never decide an outcome in this module (Ruling R12) —
 * confirmed fixed below: both orderings now produce the identical map (see
 * `fold.test.ts`'s "order-independence" test, which asserts exactly that).
 *
 * **How the fix achieves O(N) without that shortcut:** a functional graph
 * (out-degree ≤ 1) decomposes into disjoint "rho" components — zero or more
 * tail nodes feeding into exactly one cycle. This function walks each
 * component once: forward-walking with an explicit position-in-this-walk
 * map (`positionInPath`) to detect a cycle *within the current walk*
 * (`current` revisiting a node still on the current path — necessarily a
 * closed cycle, never a false positive, since every node here has ≤ 1
 * outgoing edge); once found, `resolveCycleAndTail` computes the exact
 * per-node answer for the whole cycle plus every tail node feeding into it,
 * in one pass over just that component. A walk that instead lands on an
 * *already-resolved* node (from an earlier, unrelated component, or a
 * shared sink) adopts that cached value immediately — safe, because
 * `resolved` only ever holds values this function has already fully
 * validated (a true sink, or a settled cycle/tail answer), never a
 * mid-walk stopping point. Every node is added to `resolved` exactly once,
 * so total work across every top-level call is O(N).
 *
 * Self-loops (which `aliasEventSchema` rejects at the boundary, but this
 * function does not assume never reaches it) are the degenerate one-node
 * cycle case and fall out of the same logic unchanged: a node resolves to
 * itself.
 *
 * **Exported for tests only** (fix round 5, Important 2, security review),
 * the same pattern as `resolveAliasTargetForTesting` below: `fold.test.ts`
 * calls this directly with an `edges` argument wrapped to count `.get()`
 * invocations, to assert the call count grows linearly in the input size —
 * a deterministic, CI-load-immune replacement for the wall-clock ratio
 * assertion an earlier fix round used (which flaked once under load). Not
 * re-exported from `state/index.ts`; `buildAliasEventIndex` below is the
 * only production caller.
 */
export function resolveAllAliasTargets(edges: ReadonlyMap<string, string>): Map<string, string> {
  const resolved = new Map<string, string>();

  function resolveFrom(start: string): void {
    if (resolved.has(start)) {
      return;
    }

    const path: string[] = [];
    const positionInPath = new Map<string, number>();
    let current = start;

    for (;;) {
      const already = resolved.get(current);
      if (already !== undefined) {
        for (const node of path) {
          resolved.set(node, already);
        }
        return;
      }

      const positionIfOnThisWalk = positionInPath.get(current);
      if (positionIfOnThisWalk !== undefined) {
        resolveCycleAndTail(resolved, path, positionIfOnThisWalk);
        return;
      }

      const next = edges.get(current);
      if (next === undefined) {
        // `current` has no outgoing edge — a genuine sink. Every node on
        // the path (and `current` itself, for any future walk that lands
        // on it directly) resolves to it.
        for (const node of path) {
          resolved.set(node, current);
        }
        resolved.set(current, current);
        return;
      }

      positionInPath.set(current, path.length);
      path.push(current);
      current = next;
    }
  }

  for (const from of edges.keys()) {
    resolveFrom(from);
  }
  return resolved;
}

/**
 * Settles the exact per-node answer for one rho component's cycle, and for
 * every tail node that walked into it, given `path` (the current walk, in
 * order) and `cycleStart` (the index in `path` where the cycle begins —
 * `path[cycleStart]` is the cycle's entry node, already revisited by
 * `path[path.length - 1]`'s own outgoing edge).
 *
 * **Cycle members** (`path[cycleStart..]`): per the from-scratch-walk
 * semantics this function reproduces, a node `x` on a pure cycle resolves
 * to its own predecessor *within that cycle* — the walk starting at `x`
 * traverses the whole cycle and stops the instant it would revisit `x`
 * itself, returning the last new node reached, which is exactly the cycle
 * member whose own edge points to `x`. Verified by hand for the 2-node case
 * (`a→b→a`: `a` resolves to `b`, `b` resolves to `a` — each node's own
 * "one step before closing the loop back to itself") and the 3-node case
 * (`a→b→c→a`: `a`→`c`, `b`→`a`, `c`→`b`), both matching the reference
 * `resolveAliasTarget` implementation exactly (see `fold.test.ts`).
 *
 * **Tail members** (`path[0..cycleStart-1]`, if any): a node that walks
 * into the cycle at entry `path[cycleStart]` traverses the tail (all new
 * nodes, since a functional graph's tail is a simple path with no repeats)
 * and then goes all the way around the cycle back to the entry node — which
 * *was* already visited (the moment it stepped onto the tail's end) — so
 * every tail node resolves to the same fixed value: the cycle's own
 * predecessor of the entry node. This holds regardless of which tail node a
 * walk started from, which is what makes memoizing it across every tail
 * node in one shot correct.
 */
function resolveCycleAndTail(resolved: Map<string, string>, path: readonly string[], cycleStart: number): void {
  const cycle = path.slice(cycleStart);
  const tail = path.slice(0, cycleStart);

  for (let i = 0; i < cycle.length; i++) {
    const member = cycle[i] as string;
    const predecessor = cycle[(i - 1 + cycle.length) % cycle.length] as string;
    resolved.set(member, predecessor);
  }

  const entryPredecessor = cycle[cycle.length - 1] as string;
  for (const node of tail) {
    resolved.set(node, entryPredecessor);
  }
}

/**
 * The pre-I2-fix reference implementation, preserved for tests only: one
 * from-scratch walk per call, defining the exact semantics
 * `resolveAllAliasTargets` above must reproduce for every individual node.
 * Never called from production code — `buildAliasEventIndex` uses the
 * memoized version exclusively; this exists so `fold.test.ts` can assert
 * the two agree, node by node, rather than trusting the memoized version's
 * self-description.
 */
export function resolveAliasTargetForTesting(edges: ReadonlyMap<string, string>, start: string): string {
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

  const resolvedTargets = resolveAllAliasTargets(edges);

  // Iterate `edges.keys()` — the actual alias identities — rather than
  // `resolvedTargets`'s own key set: `resolveAllAliasTargets` also caches a
  // sink node's resolution to itself internally (a real optimization, not a
  // bug), and a sink is never itself a `from` alias unless it independently
  // appears as one in `edges`. Trusting `resolvedTargets`'s full key set
  // here would risk treating that internal bookkeeping as a real alias.
  const result = new Map<TicketIdLookupKey, string[]>();
  for (const from of edges.keys()) {
    const target = resolvedTargets.get(from);
    if (target === undefined) {
      continue; // unreachable in practice — every `edges` key is resolved by resolveAllAliasTargets — but never trust an internal invariant silently.
    }
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

/**
 * Splits `tickets` into those with a unique normalized id and every
 * duplicate group (Ruling D1). `store/ticketStore.ts`'s `list()` — this
 * fold's natural input — deliberately does not dedupe by normalized id
 * (only `get()`/`write()`/`remove()`/`archive()` guard `STORE_
 * AMBIGUOUS_TICKET_LOOKUP`), so `foldState` cannot assume `tickets` arrives
 * pre-deduplicated. A colliding id is excluded from `unique` entirely — not
 * "picked, arbitrarily, by array order" — because array order is exactly
 * the thing this fold must never let decide an outcome (the same invariant
 * the alias-cycle fix, Ruling R12, already enforces on the event side).
 */
function partitionByDuplicateId(tickets: readonly StoredTicket[]): {
  readonly unique: readonly StoredTicket[];
  readonly duplicates: readonly DuplicateTicketId[];
} {
  const groups = new Map<TicketIdLookupKey, StoredTicket[]>();
  for (const ticket of tickets) {
    const key = normalizeTicketIdForComparison(ticket.id);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [ticket]);
    } else {
      group.push(ticket);
    }
  }

  const unique: StoredTicket[] = [];
  const duplicates: DuplicateTicketId[] = [];
  for (const [ticketId, group] of groups) {
    if (group.length === 1) {
      unique.push(group[0] as StoredTicket);
    } else {
      duplicates.push({ ticketId, paths: group.map((t) => t.path).sort() });
    }
  }
  duplicates.sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));

  return { unique, duplicates };
}

export function foldState(
  tickets: readonly StoredTicket[],
  events: readonly EventRecord[],
  options: FoldStateOptions,
): BoardState {
  validateLeaseTtlMs(options.leaseTtlMs);
  const { now, leaseTtlMs, firstSeen } = options;

  const { unique: uniqueTickets, duplicates: duplicateTicketIds } = partitionByDuplicateId(tickets);

  const { byTicket, orphaned } = joinEventsToTickets(uniqueTickets, events);
  const knownIds = new Set<TicketIdLookupKey>(uniqueTickets.map((t) => normalizeTicketIdForComparison(t.id)));
  const aliasEventIndex = buildAliasEventIndex(events, knownIds);

  const ticketStates: TicketState[] = uniqueTickets.map((stored) => {
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
      frontmatterAliases,
      eventAliases,
      deps: stored.ticket.frontmatter.cankan?.deps ?? [],
    };
  });

  ticketStates.sort((a, b) => {
    const ak = normalizeTicketIdForComparison(a.id);
    const bk = normalizeTicketIdForComparison(b.id);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  // Ruling D1 (fix round 6): distinguish "no file at all" from "more than
  // one file" for every orphaned id — collapsing both into one "missing"
  // message pointed an operator investigating a duplicate-id incident at
  // the wrong cause (see `OrphanedTicketEventsCause`'s own doc).
  const duplicateIdCounts = new Map<TicketIdLookupKey, number>(
    duplicateTicketIds.map((d) => [d.ticketId, d.paths.length]),
  );
  const orphanedEvents: OrphanedTicketEvents[] = [...orphaned.entries()]
    .map(([ticketId, eventCount]) => {
      const duplicateFileCount = duplicateIdCounts.get(ticketId);
      if (duplicateFileCount !== undefined) {
        return {
          ticketId,
          eventCount,
          cause: "duplicate-ticket-id" as const,
          reason: `this ticket id is claimed by ${duplicateFileCount} ticket files in this checkout — ambiguous, not missing (see BoardState.duplicateTicketIds)`,
        };
      }
      return {
        ticketId,
        eventCount,
        cause: "no-matching-ticket" as const,
        reason: "no ticket file in this checkout matches this event's ticket id",
      };
    })
    .sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));

  return { tickets: ticketStates, orphanedEvents, duplicateTicketIds };
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

  // I3 (security review): only observe an anchor id when its event's
  // `ticket` actually joins to a known `StoredTicket`. `foldState` routes
  // every orphaned event (Ruling R15) straight into `orphanedEvents` and
  // never reads its `firstSeen` at all — there is no `TicketState` for an
  // orphaned event to attach a `lease` to in the first place, so skipping
  // the observe call here is not an expiry decision at all (contrast the
  // header's "a missing `firstSeen` resolves to `expired: true`" rule,
  // which is about an event that DOES have a matching ticket). Observing
  // one anyway would write a record under `$XDG_STATE_HOME` that nothing
  // will ever read back — and nothing can ever reclaim it either:
  // `discard()` is keyed per ticket lease (M2.10's), and an id belonging
  // to no ticket has no lease to key it by. A peer can push an unbounded
  // number of `claim`s naming nonexistent tickets; skipping the observe
  // call here is what keeps that from growing the observation store
  // without bound. If the ticket file later appears while this same event
  // id is still inside the caller's read window, that later call's
  // `observe()` records the CURRENT time as `firstSeen` for an event that
  // may in truth be much older — a liveness cost (the claim can look
  // fresher, and so valid for longer, than a fully historical clock would
  // say), not a mutual-exclusion one, and orthogonal to the header's
  // missing-`firstSeen`-resolves-to-expired rule above.
  //
  // Ruling D1 (fix round 5, security review): the same reasoning excludes a
  // duplicate-normalized-id ticket's events too — `foldState` (below) will
  // route them into `orphanedEvents` (there is no safe file to attach a
  // lease to), so observing them here would be the identical unreclaimable
  // write I3 already exists to prevent, just reached via a colliding id
  // instead of a missing one.
  const knownIds = new Set<TicketIdLookupKey>(partitionByDuplicateId(tickets).unique.map((t) => normalizeTicketIdForComparison(t.id)));
  const idsToObserve = new Set<EventId>();
  for (const record of events) {
    if (!LEASE_ANCHOR_KINDS.has(record.event.event)) {
      continue;
    }
    const key = normalizeTicketIdForComparison(record.event.ticket);
    if (knownIds.has(key)) {
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
