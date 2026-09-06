/**
 * `claims/claim.ts` — M2.10 slice 1: `claim()`, built on Slice 0's
 * `AppendOptions.expectedParent` (`events/log.ts`), the caller-owned CAS
 * primitive ADR 0001:696-699 mandates.
 *
 * ## Why `append` alone is not mutual exclusion
 *
 * `append` wraps its own CAS in `withCasRetry` internally, so a lost CAS is
 * invisible to a caller that doesn't ask for `expectedParent`: it just
 * re-reads and retries until the write lands. Two claimers that both read
 * "unclaimed" would both succeed. `expectedParent` fixes this by letting
 * **this module** hold the check: read the tip, decide against it, tell
 * `append` which tip the decision was made against. If the tip moved,
 * `append` throws `EVENT_APPEND_STALE_PARENT` and does **not** retry
 * internally — this module re-reads, re-decides, and either retries or
 * rejects. That is the mandated read → check → build → CAS →
 * on-rejection-re-read-and-re-check cycle, generalized to a full claim
 * decision instead of a single append.
 *
 * ## The rule that decides whether this module is correct
 *
 * `TicketState.lease.expired` (`state/`'s fold) is a **reader-local**
 * observation — `firstSeen` is this host's own clock, so two readers can
 * legitimately disagree about whether a lease has expired (ADR 0001 failure
 * mode 7). It is good for *display*, and for deciding whether it is worth
 * *attempting* a claim — it is **never** the arbiter of who holds a ticket.
 * **The CAS is the arbiter.** Every decision this module makes based on a
 * fold is re-validated by `append`'s `expectedParent` at commit time; a
 * decision that turns out to have been made against stale state is expected
 * to lose that CAS, and this module retries rather than trusting the read.
 *
 * ## `lease_until` is DISPLAY ONLY
 *
 * Expiry is always `firstSeen(eventId) + leaseTtlMs` (the fold's own
 * computation, driven by `leaseTtlMs` — this module's parsed
 * `config.claims.lease`) vs. `now`. Never `lease_until`, never `event.ts` —
 * both are written by whoever pushed the event, on a clock this reader does
 * not control. A caller's `--lease` override changes only the `lease_until`
 * *field written on the event* (what a human sees in `cankan show`); it
 * never changes when the lease this module's own fold considers expired.
 *
 * ## A ticket absent from `state.tickets` may be DUPLICATED, not missing
 *
 * `BoardState.duplicateTicketIds` exists for exactly this. `resolveTicket`
 * below checks it **before** treating a miss against `state.tickets` as
 * "does not exist" — conflating the two would let a colliding pair of
 * on-disk ticket files fail open into "unclaimed, safe to claim."
 *
 * ## Resolution is by `id`/`displayId` ONLY — never by alias
 *
 * `TicketState.aliases` is documented as a display-only merged view, and
 * `eventAliases` specifically as attacker-writable provenance: a pushed
 * `alias` event from a legitimate ticket id to an attacker-chosen one would
 * silently reroute a write onto a ticket of the attacker's choosing (ADR
 * 0001 names this redirect explicitly). CONCEPT.md's `cankan claim <id>`
 * worked example does not promise alias resolution either. Alias-resolved
 * writes are a follow-up once the alias trust model is settled — not built
 * here.
 *
 * ## `trailingMonths` is derived from the lease, not defaulted
 *
 * `read()`'s own documented contract to this module: pass `trailingMonths`
 * computed from the configured lease so a lease taken out near a month
 * boundary is still visible after it rolls over (`read()`'s default of 2 is
 * the ADR's stated floor, not a value tuned to any specific lease).
 * `computeTrailingMonths` below implements
 * `clamp(max(2, ceil(leaseTtlMs / 30 days) + 1), 1, 120)`. **A lease chain
 * renewed across a span wider than this window loses its oldest observation
 * ids from slice 2's discard walk** — a bounded, documented leak (the
 * window keeps growing as long as the chain keeps getting renewed inside
 * it; only a gap wider than the window itself would lose history), and
 * strictly better than a fold that never discards at all.
 *
 * ## `claims.require_ready` is NOT read here, and that is deliberate
 *
 * `claims.require_ready` (default `true`, `config/schema.ts`) is not read
 * and not enforced by this module, even though its sibling keys
 * `claims.lease` and `claims.max_per_actor` both are. Readiness can't be
 * evaluated without the dependency graph, which lives in `deps/` (M2.11,
 * issue #34) — this task's `Depends on` is #31 (state) and #26 (config), and
 * PLAN rule 2 permits importing only from a task's dependency list, so
 * `claims/` may not import `deps/`. (`deps/` merged into the tree while
 * this lane ran, which makes the prohibition easier to violate by accident,
 * not harder — the import must still not happen.) The key isn't even read
 * and discarded, because reading a policy key and then ignoring it is worse
 * than not reading it: it looks enforced to a reviewer or to a grep for the
 * key, while a not-ready ticket stays claimable regardless. Enforcement
 * belongs in M3.5 (issue #46), whose `Depends on` — #42, #33, #34, #35
 * (CLI shell, claims, deps, ordering) — makes it the first task where
 * claims, deps, and ordering are all legally available; M2.17 (#40) is not
 * the owner despite wiring claims to its neighbours, since its `Depends on`
 * (#39, #33, #28) has no #34. When readiness is enforced, it is advisory
 * input to deciding *which* ticket to attempt — never the arbiter of
 * whether a claim succeeds. The CAS on the coordination ref remains the
 * sole mutual-exclusion primitive, as above.
 *
 * ## `max_per_actor` is a quota, not a security control
 *
 * `claims.max_per_actor` reads like an enforced limit, but it is keyed on
 * `event.actor` — a free-text field, not an authenticated identity. Anyone
 * with push access to the coordination ref can append `claim` events naming
 * any victim actor on `max_per_actor` tickets of their own choosing, and
 * `claimedBy` (`state/`) has no way to tell those apart from the victim's own
 * claims: the victim's next genuine `claim()` call sees its own quota already
 * exhausted and is rejected `CLAIM_REJECTED`/`max-per-actor`, regardless of
 * whether the victim ever ran the command that named it. This self-heals
 * after one lease TTL — `claimedBy` counts only live leases, so an attacker
 * who stops re-pushing loses the lockout as those forged claims expire — but
 * an attacker willing to keep re-pushing keeps it up indefinitely. There is
 * no fix available inside this module: `actor` is not this module's identity
 * layer, and treating it as one here would be exactly the mistake this note
 * exists to prevent a reader from making. The point of this paragraph is
 * only that the code must not be read as a security control when it is a
 * quota on a forgeable identity.
 */

import { CanKanError, ErrorCodes, isCanKanError } from "../errors";
import type { BoardRef, ActorId, TicketId } from "../types";
import type { CasAttemptResult, CasRetryOptions, GitAdapter, RefSha } from "../git/index";
import { createGitAdapter, GitErrorCodes, withCasRetry } from "../git/index";
import type { AppendedEvent, EventCandidate, EventId, EventRecord } from "../events/index";
import { append, boardKeyFor, discard, observe, read } from "../events/index";
import { EventErrorCodes } from "../events/errors";
import type { BoardState, TicketState } from "../state/index";
import { claimedBy, observeAndFold } from "../state/index";
import type { TicketStore } from "../store/index";
import { normalizeTicketIdForComparison, openTicketStore } from "../store/index";
import { loadBoardConfig } from "../board/index";
import { parseDurationMs } from "./duration";
import { ClaimErrorCodes } from "./errors";

// ============================================================================
// The shared context — resolved once per `claim()` call, not per CAS attempt
// ============================================================================

/**
 * Everything a claim decision needs that does **not** change between CAS
 * attempts: the adapter, the board key, the ticket store, the coordination
 * ref, the parsed lease TTL, `max_per_actor`, and the lease-derived
 * `trailingMonths`. Resolved once, up front — re-resolving any of this per
 * attempt would be wasted I/O (config and the store handle don't change
 * mid-call) and would let `now`/`trailingMonths` drift across attempts of
 * what must read as one logical decision.
 */
interface ClaimContext {
  readonly board: BoardRef;
  readonly now: number;
  readonly adapter: GitAdapter;
  readonly boardKey: string;
  readonly store: TicketStore;
  readonly ref: string;
  readonly leaseTtlMs: number;
  readonly maxPerActor: number;
  readonly trailingMonths: number;
}

interface ResolveClaimContextParams {
  readonly board: BoardRef;
  readonly now: number;
  readonly trailingMonths?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MONTH_MS = 30 * DAY_MS;
const MAX_TRAILING_MONTHS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `clamp(max(2, ceil(leaseTtlMs / 30 days) + 1), 1, 120)` — see this file's own header for the "why." */
function computeTrailingMonths(leaseTtlMs: number): number {
  return clamp(Math.max(2, Math.ceil(leaseTtlMs / WINDOW_MONTH_MS) + 1), 1, MAX_TRAILING_MONTHS);
}

async function resolveClaimContext(params: ResolveClaimContextParams): Promise<ClaimContext> {
  const { board, now } = params;
  const adapter = await createGitAdapter(board.root);
  const boardKey = await boardKeyFor(adapter);
  // Contract 4: `gitDirs` must be non-empty for every board, with no
  // exemption — see `store/index.ts`'s `OpenTicketStoreOptions.gitDirs`.
  const gitDirs = [await adapter.gitCommonDir()];
  const store = await openTicketStore({ board, gitDirs });
  const config = await loadBoardConfig(board);
  const leaseTtlMs = parseDurationMs(config.value.claims.lease);
  const trailingMonths = params.trailingMonths ?? computeTrailingMonths(leaseTtlMs);
  return {
    board,
    now,
    adapter,
    boardKey,
    store,
    ref: board.coordinationRef,
    leaseTtlMs,
    maxPerActor: config.value.claims.max_per_actor,
    trailingMonths,
  };
}

// ============================================================================
// The snapshot — tip and folded state from ONE function, in the one safe order
// ============================================================================

/** One CAS attempt's read of the board: the ref tip a decision is made against, and the state folded from it. */
interface BoardSnapshot {
  readonly parentSha: RefSha | null;
  readonly state: BoardState;
  /**
   * The exact `read()` result `state` was folded from, in this same call —
   * slice 2's discard walk (`computeDiscardRun`, below) derives its id set
   * from this, never from a second `read()`. Re-reading here would be the
   * identical double-tip hazard this function's own doc comment (above)
   * documents for `readRef`: a second `read()` resolves the ref
   * independently and can observe a tip newer than the one this attempt's
   * `parentSha`/`state` were captured against. `expectedParent` already
   * guarantees nothing landed between this read and this attempt's append,
   * so this field, not a fresh read, is the complete picture of whatever
   * lease this attempt's append is about to end.
   */
  readonly events: readonly EventRecord[];
}

/**
 * Reads the coordination ref's current tip and the board state folded from
 * it, **together, in one function, in a fixed internal order that a caller
 * cannot observe or reorder**: `readRef` first, then `read`, then
 * `store.list`, then `observeAndFold`.
 *
 * **This ordering is load-bearing, confirmed by a working probe (a security
 * review of Slice 0), not merely a style preference.** `read()` resolves the
 * ref's tip itself, internally, once per month blob it fetches — and does
 * not return that tip to its caller. A `readRef` issued *after* `read()`
 * returns can therefore observe a tip that is strictly **newer** than the
 * events just folded: a competitor's write that landed in the gap between
 * `read()`'s internal resolution and this module's own `readRef` call is
 * invisible to `state`, yet `expectedParent` would still match that newer
 * tip on this attempt's append — the CAS reports success, and the
 * competitor's claim and this one both land. Captured **before** `read()`
 * instead, either `read()` saw the competitor (so `state` already reflects
 * it, and the decision below accounts for it) or it did not, in which case
 * this `parentSha` is provably stale by the time any append using it runs,
 * and `expectedParent` rejects that append outright. Both outcomes are
 * correct; only the reversed order produces a double claim.
 *
 * Returning `{ parentSha, state }` from one function, built inside it in
 * this fixed order, makes the wrong order structurally unreachable from
 * every call site in this module (and any later one) — there is no way for
 * a caller to obtain one without the other, or to obtain `parentSha` a
 * second time after `state` without calling this function again (which
 * re-establishes the correct order from scratch).
 */
async function snapshotBoard(ctx: ClaimContext): Promise<BoardSnapshot> {
  const parentSha = await ctx.adapter.readRef(ctx.ref);
  const events = await read(ctx.adapter, ctx.ref, { now: ctx.now, trailingMonths: ctx.trailingMonths });
  const { tickets } = await ctx.store.list();
  const state = await observeAndFold(ctx.boardKey, tickets, events, { now: ctx.now, leaseTtlMs: ctx.leaseTtlMs });
  return { parentSha, state, events };
}

// ============================================================================
// Ticket resolution — id/displayId only, ambiguity checked first
// ============================================================================

/**
 * The same terminal-hostile code points `events/schema.ts`'s
 * `refineActorIdShape`/`refineTicketIdShape` and `ticket/filename.ts`'s
 * `isUnsafeFilenameChar` already treat as unsafe: ASCII control characters
 * (including NUL/DEL) and the Unicode bidirectional-formatting/zero-width
 * set (LRE/RLE/PDF/LRO/RLO, directional isolates, zero-width
 * space/joiners/non-joiner, the BOM). Neither helper is exported from its
 * module (both are file-private), and this dispatch's file list does not
 * include either module, so the set is duplicated here rather than
 * imported — see `resolveTicket`'s doc comment on `sanitizeTicketQueryForEcho`
 * for why a set, not a rejection, is what this call site needs.
 */
const ECHO_UNSAFE_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
]);

function isAsciiControlOrDel(code: number): boolean {
  return code <= 31 || code === 127;
}

/** Matches `ticketSchema`'s `.max(200)` bound (`events/schema.ts`) — the shape a ticket id off the shared coordination ref is already held to. */
const ECHO_MAX_CHARS = 200;

/**
 * Fix round 4, finding 5 (ruling): `resolveTicket` echoes the caller's raw
 * `ticket` query into both the thrown message and `details` for
 * `CLAIM_TICKET_NOT_FOUND`/`CLAIM_TICKET_AMBIGUOUS` — a deliberate,
 * disclosed deviation from every sibling validator in `events/log.ts`
 * (`validateTicketFilter`, `validateSince`), which withhold the raw value
 * on principle. Withholding it here too would make "ticket not found"
 * unable to say *what* was not found — a genuinely worse error for this
 * module's primary user-facing failure. The ruling: keep the echo, bound
 * it, because "it is the user's own CLI argument" will not stay true
 * (`claim --next`, M2.12, selects the id from board state; `--board all`,
 * M6.10, addresses tickets as `<repo>:<id>` with the repo half from the
 * registry) and this string is destined for a terminal and for `--json`,
 * where this repo already treats terminal safety as real.
 *
 * Iterates by Unicode code point (`for...of`, not index/`.slice`, which
 * would risk splitting a surrogate pair), strips first, then truncates —
 * stripping only ever removes characters, so it cannot create a new
 * surrogate-pair split for the truncation step to worry about. The
 * *matching* logic (`normalizeTicketIdForComparison`, above) never sees
 * this sanitized value — only the echo does; a hostile control character
 * stripped for display must not change which ticket, if any, this
 * function resolves.
 */
function sanitizeTicketQueryForEcho(ticketQuery: string): string {
  let stripped = "";
  for (const ch of ticketQuery) {
    const code = ch.codePointAt(0) ?? 0;
    if (isAsciiControlOrDel(code) || ECHO_UNSAFE_CODE_POINTS.has(code)) continue;
    stripped += ch;
  }
  let truncated = "";
  let count = 0;
  for (const ch of stripped) {
    if (count >= ECHO_MAX_CHARS) break;
    truncated += ch;
    count += 1;
  }
  return truncated;
}

function resolveTicket(state: BoardState, ticketQuery: string): TicketState {
  const key = normalizeTicketIdForComparison(ticketQuery);
  const safeTicketQuery = sanitizeTicketQueryForEcho(ticketQuery);
  // Ruling D1: an id excluded from `state.tickets` because more than one
  // on-disk file declares it must never be read as "not found" — that
  // would fail OPEN on the exact mutual-exclusion primitive this module
  // exists to protect (a duplicate id claimed as though it were a normal,
  // single, unclaimed ticket).
  if (state.duplicateTicketIds.some((d) => d.ticketId === key)) {
    throw new CanKanError(
      ClaimErrorCodes.TICKET_AMBIGUOUS,
      `ticket "${safeTicketQuery}" is ambiguous: more than one on-disk ticket file declares this id`,
      { details: { ticket: safeTicketQuery } },
    );
  }
  // Ruling (this module): resolve by `id` and `displayId` ONLY — never by
  // alias. See this file's own header for why an alias-resolved write is
  // out of scope.
  //
  // Collect EVERY match, never take the first. `state.tickets` is already
  // guaranteed distinct-by-`id` (Ruling D1, checked above), but `displayId`
  // is a second, independent axis of collision that guarantee says nothing
  // about, and there are two distinct shapes it can take:
  //
  //   1. two tickets share the same `displayId` (both `id`s are fine on
  //      their own; the query matches both via `displayId`);
  //   2. one ticket's `displayId` collides with a DIFFERENT ticket's
  //      canonical `id` (the query matches ticket A by `id` and ticket B by
  //      `displayId`).
  //
  // A first-match `.find()` would silently return whichever of these came
  // first in `state.tickets` — a caller-invisible write-redirect onto a
  // ticket the query never uniquely named. `store.get()` (`store/`)
  // already refuses to guess in the equivalent case
  // (`STORE_AMBIGUOUS_TICKET_LOOKUP`); this is a mutual-exclusion primitive
  // deciding *which* ticket a claim/renew/release acts on, so it holds
  // itself to at least that standard, not less. Exactly one match proceeds;
  // more than one rejects as ambiguous; zero remains `TICKET_NOT_FOUND`.
  const matches = state.tickets.filter((t) => {
    if (normalizeTicketIdForComparison(t.id) === key) return true;
    return t.displayId !== undefined && normalizeTicketIdForComparison(t.displayId) === key;
  });
  if (matches.length > 1) {
    throw new CanKanError(
      ClaimErrorCodes.TICKET_AMBIGUOUS,
      `ticket "${safeTicketQuery}" is ambiguous: more than one ticket matches this id or display id`,
      { details: { ticket: safeTicketQuery, matches: matches.length } },
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new CanKanError(ClaimErrorCodes.TICKET_NOT_FOUND, `no ticket found matching "${safeTicketQuery}"`, {
      details: { ticket: safeTicketQuery },
    });
  }
  return match;
}

// ============================================================================
// `CLAIM_REJECTED` — the shared, seeded code, sub-cased by `details.reason`
// ============================================================================

type ClaimRejectionReason =
  | "already-held"
  | "already-held-by-you"
  | "max-per-actor"
  | "closed"
  | "not-held"
  | "not-holder"
  | "lease-expired";

/** Every "you asked to hold this ticket and you do not" outcome shares this one code (M3.10 maps it to exit 3) — see `claims/errors.ts`'s own header for the ruling. */
function claimRejected(reason: ClaimRejectionReason, ticket: TicketId, extra?: Readonly<Record<string, unknown>>): CanKanError {
  return new CanKanError(ErrorCodes.CLAIM_REJECTED, `claim rejected (${reason}) for ticket "${ticket}"`, {
    details: { reason, ticket, ...extra },
  });
}

function isStaleParentError(err: unknown): boolean {
  return isCanKanError(err) && err.code === EventErrorCodes.EVENT_APPEND_STALE_PARENT;
}

// ============================================================================
// The append-or-retry helper (fix round, finding B) — every append this
// module ever makes goes through this, never a hand-copied try/catch.
// ============================================================================

/**
 * Appends `candidate` with `parentSha` as `expectedParent`. Returns the
 * appended event on success, or `undefined` if the CAS was lost
 * (`EVENT_APPEND_STALE_PARENT`) — the caller's own attempt function must
 * translate that into `{ done: false }` so `withCasRetry` re-runs it from a
 * fresh `snapshotBoard`. Every other error propagates unchanged: a broad
 * catch that funnels an unrelated failure into a retry would silently repeat
 * whatever stale decision the caller made, which is a correctness defect,
 * not robustness (this file's own header, and the brief this module was
 * built from, are both explicit about this).
 *
 * **Extracted once, used at every append site in this module, old and
 * new** — `claim.ts:528-535` and `:549-556` (pre-slice-2) duplicated this
 * exact shape twice already; `renew`, `release`, and `expireStale` would
 * have made it five copies.
 */
async function appendOrRetry(
  ctx: ClaimContext,
  candidate: EventCandidate,
  parentSha: RefSha | null,
): Promise<AppendedEvent | undefined> {
  try {
    return await append(ctx.adapter, ctx.ref, candidate, { now: ctx.now, expectedParent: parentSha });
  } catch (err) {
    if (isStaleParentError(err)) {
      return undefined;
    }
    throw err;
  }
}

// ============================================================================
// The discard walk — deriving a terminated lease's full id set from the log
// this module already read, and cleaning up the observation store for it.
// ============================================================================

/** The three event kinds that start or extend a lease — mirrors `state/fold.ts`'s own (file-private) `LEASE_ANCHOR_KINDS`; duplicated here because that module withholds it (`state/index.ts`'s own doc comment: internal folding machinery, not a public export). */
const LEASE_ANCHOR_EVENT_KINDS: ReadonlySet<string> = new Set(["claim", "takeover", "renew"]);
/** Every event kind that can end a lease outright, alongside the three above — mirrors `state/fold.ts`'s (file-private) `LEASE_AFFECTING_KINDS` for the same reason. */
const LEASE_AFFECTING_EVENT_KINDS: ReadonlySet<string> = new Set([...LEASE_ANCHOR_EVENT_KINDS, "release", "close", "expire"]);

/**
 * `(month, line)` chain-position comparator — mirrors `state/fold.ts`'s own
 * (file-private) `compareChainPosition`, duplicated here for the same
 * withholding reason as the kind sets above. **Never `EventRecord.position`**
 * (that field's own doc comment: meaningful only within the single `read()`
 * call that produced it) and **never `ts`** (peer-supplied) — `(month,
 * line)` is the one coordinate `read()` documents as stable across calls.
 */
function compareChainPosition(a: EventRecord, b: EventRecord): number {
  if (a.month !== b.month) {
    return a.month < b.month ? -1 : 1;
  }
  return a.line - b.line;
}

/**
 * Every claim/takeover/renew event id that the lease on `ticketId` currently
 * ending has ever accumulated — the exact set `discard()` must be called for
 * once this module's own terminating append (`release`, `expire`, or
 * `takeover`) has landed.
 *
 * `events` is the pre-append `read()` result a `snapshotBoard()` call
 * already produced for this attempt — **never a fresh `read()`** (see
 * `BoardSnapshot.events`'s own doc comment for why). Filtered to this
 * ticket's own lease-affecting events, sorted by chain position
 * (`(month, line)` — the one coordinate stable across `read()` calls; never
 * `position`, never `ts`), then walked oldest to newest: a
 * `release`/`close`/`expire` resets the accumulator (whatever came before it
 * already belongs to a lease this reader's own log shows as already ended,
 * and slice 1's own "previous, already-terminated lease" test proves those
 * ids must be left alone), and every `claim`/`takeover`/`renew` appends its
 * id to the (possibly just-reset) run.
 *
 * **Collects every id in the run, not only the one `state/fold.ts`'s
 * `resolveLeaseAnchor` would treat as anchor.** `observeAndFold` calls
 * `observe()` on every `claim`/`takeover`/`renew` it reads for a known
 * ticket, whether or not the fold treats it as the anchor (a cross-actor
 * `renew` against a live anchor, for instance, mints no anchor but *was*
 * observed) — an id that was observed but excluded here would be exactly
 * the leak this slice exists to close.
 *
 * **Known, accepted limit** (documented at this file's own header, and
 * repeated here because it is this function's own boundary): only events
 * inside `events` — i.e. inside the caller's `trailingMonths` window — can
 * ever be found. A lease renewed across a wider span than that window loses
 * its oldest ids from this walk. Widening the window unboundedly to "fix"
 * this would reintroduce the O(months) sequential-subprocess cost `read()`'s
 * own doc comment measures directly (611 spawns at `trailingMonths: 120`);
 * this function does not attempt to.
 */
function computeDiscardRun(events: readonly EventRecord[], ticketId: TicketId): readonly EventId[] {
  const key = normalizeTicketIdForComparison(ticketId);
  const relevant = events.filter(
    (r) => LEASE_AFFECTING_EVENT_KINDS.has(r.event.event) && normalizeTicketIdForComparison(r.event.ticket) === key,
  );
  const sorted = [...relevant].sort(compareChainPosition);

  let run: EventId[] = [];
  for (const record of sorted) {
    const kind = record.event.event;
    if (kind === "release" || kind === "close" || kind === "expire") {
      run = [];
    } else if (LEASE_ANCHOR_EVENT_KINDS.has(kind)) {
      run.push(record.event.id);
    }
  }
  return run;
}

/**
 * Discards every id in `ids` — idempotent, over-discarding within a run is
 * safe (`discard`'s own doc comment), under-discarding is the defect this
 * slice exists to close. Called **only after** the terminating append has
 * already landed (never before — a failed append followed by a discard
 * would let a still-live lease look freshly-observed to the next reader and
 * be honored for another full TTL, fail-open in the wrong direction).
 *
 * If a `discard()` call fails (`EVENT_OBSERVATION_STORE_UNAVAILABLE` — an
 * unwritable or unreadable store, per ADR failure mode 7), the error is
 * re-thrown with `details.appended: true` added. The terminating append has
 * already landed by the time this ever runs — the lease is genuinely ended,
 * so there is no double-claim risk in this failure, but a caller that
 * retries the same operation after seeing this error would otherwise get a
 * confusing `not-held`/`not-holder` rejection on the retry (the lease it
 * thinks it still needs to end is already gone) and could misread that as
 * "my release was lost." `details.appended: true` lets a caller tell the
 * two situations apart.
 */
async function runDiscardWalk(ctx: ClaimContext, ids: readonly EventId[]): Promise<void> {
  for (const id of ids) {
    try {
      await discard(ctx.boardKey, id);
    } catch (err) {
      if (isCanKanError(err)) {
        throw new CanKanError(err.code, err.message, { cause: err, details: { ...err.details, appended: true } });
      }
      throw err;
    }
  }
}

// ============================================================================
// `casRetry` validation — `withCasRetry` validates none of its own options
// ============================================================================

/**
 * The reclaim path (an observed-expired lease) spends one attempt on the
 * `expire` and a second on the `claim` — so `maxAttempts` below this floor
 * would make a legitimate reclaim on an otherwise-idle repo fail with a
 * confusing `GIT_CAS_CONTENTION_EXCEEDED` instead of ever completing.
 */
const MIN_CAS_ATTEMPTS = 2;
/** Mirrors `events/log.ts`'s own `MAX_CAS_ATTEMPTS` bound — generous headroom for deliberate stress-testing, bounded against a hostile or mistaken value. */
const MAX_CAS_ATTEMPTS = 10_000;
/** Mirrors `events/log.ts`'s own `MAX_BACKOFF_MS` bound — see that constant's doc comment for the day-scale hazard an unbounded `backoffMs` return value can reach. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Validates `ClaimParams.casRetry` before this module's own `withCasRetry`
 * call can act on it — `withCasRetry` (`git/retry.ts`) validates none of its
 * own options, and this module (unlike `append`, which validates a caller's
 * `casRetry` before forwarding it) calls `withCasRetry` directly, so this is
 * the only place that check can happen.
 */
function validateCasRetry(casRetry: CasRetryOptions | undefined): CasRetryOptions | undefined {
  if (casRetry === undefined) {
    return undefined;
  }
  if (casRetry === null || typeof casRetry !== "object") {
    throw new CanKanError(ClaimErrorCodes.INVALID_OPTION, `casRetry must be an object, got ${casRetry === null ? "null" : typeof casRetry}`, {
      details: { type: casRetry === null ? "null" : typeof casRetry },
    });
  }
  const { maxAttempts, backoffMs, sleep } = casRetry;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < MIN_CAS_ATTEMPTS || maxAttempts > MAX_CAS_ATTEMPTS)) {
    throw new CanKanError(
      ClaimErrorCodes.INVALID_OPTION,
      `casRetry.maxAttempts must be an integer in [${MIN_CAS_ATTEMPTS}, ${MAX_CAS_ATTEMPTS}] — the reclaim path (expire, then claim) spends one attempt on each`,
      { details: { maxAttempts: typeof maxAttempts === "number" ? maxAttempts : null, min: MIN_CAS_ATTEMPTS, max: MAX_CAS_ATTEMPTS } },
    );
  }
  if (backoffMs !== undefined && typeof backoffMs !== "function") {
    throw new CanKanError(ClaimErrorCodes.INVALID_OPTION, `casRetry.backoffMs must be a function, got ${typeof backoffMs}`, {
      details: { type: typeof backoffMs },
    });
  }
  if (sleep !== undefined && typeof sleep !== "function") {
    throw new CanKanError(ClaimErrorCodes.INVALID_OPTION, `casRetry.sleep must be a function, got ${typeof sleep}`, {
      details: { type: typeof sleep },
    });
  }
  if (backoffMs === undefined) {
    return casRetry;
  }
  return {
    ...casRetry,
    backoffMs: (attemptNumber: number) => {
      const ms = backoffMs(attemptNumber);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_BACKOFF_MS) {
        throw new CanKanError(ClaimErrorCodes.INVALID_OPTION, `casRetry.backoffMs must return a finite number in [0, ${MAX_BACKOFF_MS}], got ${ms}`, {
          details: { backoffMs: ms, max: MAX_BACKOFF_MS },
        });
      }
      return ms;
    },
  };
}

// ============================================================================
// Public shape
// ============================================================================

export interface ClaimParams {
  readonly board: BoardRef;
  /** The id, display id, or alias as the user typed it — resolved by id/displayId only, never by alias (see this file's header). */
  readonly ticket: string;
  readonly actor: ActorId;
  /** The human an agent inherits from (CONCEPT.md §5) — optional, written verbatim to the appended event's `parent` field. */
  readonly parent?: ActorId;
  /** A duration string overriding the event's `lease_until` **display** field only. Never changes when this reader considers the lease expired — see this file's header. */
  readonly lease?: string;
  readonly force?: boolean;
  /** Injectable clock — every I/O this call performs (git, the ticket store, the observation store) is measured against this. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Overrides the lease-derived default (`computeTrailingMonths`). */
  readonly trailingMonths?: number;
  /** Validated by this module — `withCasRetry` validates none of its own options. */
  readonly casRetry?: CasRetryOptions;
}

export interface ClaimResult {
  readonly ticket: TicketId;
  readonly actor: ActorId;
  readonly eventId: EventId;
  readonly kind: "claim" | "takeover";
  /** The `lease_until` written on the appended event — display only. */
  readonly leaseUntil: string;
  /** How many CAS attempts this call made before succeeding — >1 means a race (or a reclaim's `expire` + `claim` pair) actually happened. */
  readonly attempts: number;
}

/**
 * Test-only injection point for `claimCore`'s internal retry loop — the
 * established house pattern (`appendCore`/`AppendHooks`,
 * `initRefCore`/`InitRefHooks`, `updateRefCASCore`). **Not part of the
 * public surface**: a test reaches `claimCore` via a relative import to this
 * file, never through `claims/index.ts`.
 */
export interface ClaimHooks {
  /** Invoked once per CAS attempt, after this attempt's decision and immediately before the append. A test uses this to force a genuine `EVENT_APPEND_STALE_PARENT` deterministically. */
  readonly beforeAppend?: (attemptNumber: number) => Promise<void>;
}

interface ClaimSuccess {
  readonly ticketId: TicketId;
  readonly eventId: EventId;
  readonly kind: "claim" | "takeover";
  readonly leaseUntil: string;
  readonly attempts: number;
}

/**
 * One CAS attempt: snapshot the board, decide, and (if the decision is to
 * proceed) append exactly one event. Every rejection **throws** (never
 * `{ done: false }`) — a throw propagates straight out of `withCasRetry`
 * with no retry, which is correct for a decision that re-reading cannot
 * change. Only a stale-parent append (this attempt's decision has already
 * been overtaken by a concurrent writer) reports `{ done: false }`, so the
 * next attempt re-snapshots and re-decides.
 */
async function claimAttempt(
  ctx: ClaimContext,
  params: ClaimParams,
  leaseMs: number,
  hooks: ClaimHooks,
  attemptNumber: number,
  forceState: { holder: ActorId | undefined },
): Promise<CasAttemptResult<ClaimSuccess>> {
  const { parentSha, state, events } = await snapshotBoard(ctx);
  const ticketState = resolveTicket(state, params.ticket);

  // Decide. Order is this module's own choice (the brief enumerates the
  // conditions, not a mandated sequence): `closed` first, since it is the
  // one terminal fact that makes every other check moot; the lease-based
  // rejections next, since they identify a specific conflicting actor;
  // `max_per_actor` last, since it is about the caller's own limit and is
  // orthogonal to this specific ticket's state.
  if (ticketState.closed) {
    throw claimRejected("closed", ticketState.id);
  }

  const lease = ticketState.lease;
  const liveLease = lease !== undefined && !lease.expired;
  let useForce = false;

  if (liveLease && lease !== undefined) {
    if (lease.actor === params.actor) {
      // Never silently upgrade a claim into a renew — `renew` (slice 2)
      // exists and is explicit; converting one into the other here would
      // hide a caller bug.
      throw claimRejected("already-held-by-you", ticketState.id);
    }
    if (!params.force) {
      throw claimRejected("already-held", ticketState.id, { holder: lease.actor });
    }
    // `--force` authorizes taking over exactly ONE holder — the one
    // observed when this call first decided to force — never a chain of
    // them. If a retry now sees a DIFFERENT holder than the one already
    // committed to, stop forcing and reject rather than chase a moving
    // target (two racing `--force` callers would otherwise ping-pong until
    // `maxAttempts` and both die with `GIT_CAS_CONTENTION_EXCEEDED`).
    if (forceState.holder !== undefined && lease.actor !== forceState.holder) {
      throw claimRejected("already-held", ticketState.id, { holder: lease.actor });
    }
    forceState.holder = lease.actor;
    useForce = true;
  }

  if (ctx.maxPerActor !== 0) {
    const heldCount = claimedBy(state).get(params.actor)?.length ?? 0;
    if (heldCount >= ctx.maxPerActor) {
      throw claimRejected("max-per-actor", ticketState.id, { limit: ctx.maxPerActor });
    }
  }

  await hooks.beforeAppend?.(attemptNumber);

  const nowIso = new Date(ctx.now).toISOString();
  const parentField = params.parent !== undefined ? { parent: params.parent } : {};

  if (lease?.expired) {
    // Observed expired, held by anyone. An honest reclaim is `expire` then
    // `claim` — never a bare `claim`, never a `takeover` (a takeover would
    // claim to have displaced a LIVE lease, which this is not). One append
    // per attempt: a competitor landing between this append and the next
    // fold is caught by that next fold, not papered over here.
    //
    // An `expire` (like a `takeover`, below) terminates a displaced lease
    // and so carries the same observation-id discard obligation that
    // lease's own anchor event has — `computeDiscardRun` derives the full
    // run from `events`, the pre-append read this attempt already made,
    // BEFORE the append (this attempt's decision, and therefore the run it
    // is built from, is only valid until the append either lands or is
    // rejected).
    const expireCandidate: EventCandidate = {
      event: "expire",
      ts: nowIso,
      actor: params.actor,
      ticket: ticketState.id,
      ...parentField,
    };
    const expireDisplacedRun = computeDiscardRun(events, ticketState.id);
    const expireAppended = await appendOrRetry(ctx, expireCandidate, parentSha);
    if (expireAppended === undefined) {
      return { done: false };
    }
    await runDiscardWalk(ctx, expireDisplacedRun);
    return { done: false };
  }

  const leaseUntilIso = new Date(ctx.now + leaseMs).toISOString();
  const kind: "claim" | "takeover" = useForce ? "takeover" : "claim";
  // A `takeover` also terminates the displaced lease and so carries the
  // same observation-id discard obligation as the `expire` branch above —
  // computed from the pre-append `events`, before the append; empty for a
  // plain `claim` against an unclaimed ticket (nothing to displace).
  const takeoverDisplacedRun = useForce ? computeDiscardRun(events, ticketState.id) : [];
  const candidate: EventCandidate = useForce
    ? { event: "takeover", ts: nowIso, actor: params.actor, ticket: ticketState.id, lease_until: leaseUntilIso, ...parentField }
    : { event: "claim", ts: nowIso, actor: params.actor, ticket: ticketState.id, lease_until: leaseUntilIso, ...parentField };

  const appended = await appendOrRetry(ctx, candidate, parentSha);
  if (appended === undefined) {
    return { done: false };
  }

  // ADR fm7: "an appender records its own append at the moment it appends."
  // `append` does not do this on this module's behalf, and nothing else
  // will — without this, this process's own lease would never expire for
  // this reader (`firstSeenMs` would stay `undefined` forever).
  await observe(ctx.boardKey, appended.event.id, { now: ctx.now });
  await runDiscardWalk(ctx, takeoverDisplacedRun);

  return {
    done: true,
    value: { ticketId: ticketState.id, eventId: appended.event.id, kind, leaseUntil: leaseUntilIso, attempts: attemptNumber },
  };
}

/** `claim()`'s implementation, plus the test-only `hooks` seam. `claim()` calls this with no hooks. */
export async function claimCore(params: ClaimParams, hooks: ClaimHooks): Promise<ClaimResult> {
  const now = params.now ?? Date.now();
  const casRetry = validateCasRetry(params.casRetry);
  // `params.lease` overrides only the event's display `lease_until` field —
  // parsed up front (before any git invocation) so a malformed override
  // fails fast rather than after a wasted snapshot.
  const leaseOverrideMs = params.lease !== undefined ? parseDurationMs(params.lease) : undefined;

  const ctx = await resolveClaimContext({ board: params.board, now, trailingMonths: params.trailingMonths });
  const leaseMs = leaseOverrideMs ?? ctx.leaseTtlMs;

  const forceState: { holder: ActorId | undefined } = { holder: undefined };

  const success = await withCasRetry<ClaimSuccess>(
    (attemptNumber) => claimAttempt(ctx, params, leaseMs, hooks, attemptNumber, forceState),
    casRetry,
  );

  return {
    ticket: success.ticketId,
    actor: params.actor,
    eventId: success.eventId,
    kind: success.kind,
    leaseUntil: success.leaseUntil,
    attempts: success.attempts,
  };
}

/**
 * Claims a ticket for `params.actor`. See this file's own header for the
 * mutual-exclusion design this implements, and `--force`'s semantics above
 * `claimAttempt`.
 */
export function claim(params: ClaimParams): Promise<ClaimResult> {
  return claimCore(params, {});
}

// ============================================================================
// `renew` — extends a live lease this actor already holds
// ============================================================================

export interface RenewParams {
  readonly board: BoardRef;
  /** The id, display id, or alias as the user typed it — resolved the same way `ClaimParams.ticket` is (see this file's header). */
  readonly ticket: string;
  readonly actor: ActorId;
  /** A duration string overriding the event's `lease_until` **display** field only — same semantics as `ClaimParams.lease` (see this file's header). */
  readonly lease?: string;
  /** Injectable clock — see `ClaimParams.now`. */
  readonly now?: number;
  /** Overrides the lease-derived default (`computeTrailingMonths`). */
  readonly trailingMonths?: number;
  /** Validated by this module — see `ClaimParams.casRetry`. */
  readonly casRetry?: CasRetryOptions;
}

export interface RenewResult {
  readonly ticket: TicketId;
  readonly actor: ActorId;
  readonly eventId: EventId;
  /** The `lease_until` written on the appended event — display only. */
  readonly leaseUntil: string;
  /** How many CAS attempts this call made before succeeding. */
  readonly attempts: number;
}

/** Test-only injection point for `renewCore`'s internal retry loop — same pattern as `ClaimHooks`. Not part of the public surface. */
export interface RenewHooks {
  readonly beforeAppend?: (attemptNumber: number) => Promise<void>;
}

interface RenewSuccess {
  readonly ticketId: TicketId;
  readonly eventId: EventId;
  readonly leaseUntil: string;
  readonly attempts: number;
}

/**
 * One CAS attempt for `renew`. The ticket must have a lease that is **live**
 * and anchored to **this** actor:
 *
 * - No lease at all → `not-held`.
 * - Lease held by a different actor → `not-holder` (distinct from
 *   `not-held` — a caller needs to tell the two apart).
 * - Lease observed **expired** → `lease-expired`, fail closed **even though
 *   this actor is the anchor**: a `renew` appended after expiry would
 *   re-anchor the lease by chain position for every reader that has not yet
 *   expired it, resurrecting a lease this holder no longer owns (this
 *   file's header, `TicketState.lease.expired`'s own doc comment). The
 *   caller's remedy is `claim` again, not a forced renew.
 *
 * `renew` does **not** discard anything — the lease continues, so its
 * earlier ids are still part of it, discarded only when the lease
 * terminates (`release`/`expireStale`/a competing `takeover`). Each `renew`
 * *adds* one id to that eventual set.
 */
async function renewAttempt(
  ctx: ClaimContext,
  params: RenewParams,
  leaseMs: number,
  hooks: RenewHooks,
  attemptNumber: number,
): Promise<CasAttemptResult<RenewSuccess>> {
  const { parentSha, state } = await snapshotBoard(ctx);
  const ticketState = resolveTicket(state, params.ticket);
  const lease = ticketState.lease;

  if (lease === undefined) {
    throw claimRejected("not-held", ticketState.id);
  }
  if (lease.actor !== params.actor) {
    throw claimRejected("not-holder", ticketState.id, { holder: lease.actor });
  }
  if (lease.expired) {
    throw claimRejected("lease-expired", ticketState.id);
  }

  await hooks.beforeAppend?.(attemptNumber);

  const nowIso = new Date(ctx.now).toISOString();
  const leaseUntilIso = new Date(ctx.now + leaseMs).toISOString();
  const candidate: EventCandidate = {
    event: "renew",
    ts: nowIso,
    actor: params.actor,
    ticket: ticketState.id,
    lease_until: leaseUntilIso,
  };

  const appended = await appendOrRetry(ctx, candidate, parentSha);
  if (appended === undefined) {
    return { done: false };
  }

  // Same ADR fm7 obligation `claimAttempt` observes: an appender records its
  // own append at the moment it appends, or this reader's own renewal would
  // never be seen as live by itself.
  await observe(ctx.boardKey, appended.event.id, { now: ctx.now });

  return {
    done: true,
    value: { ticketId: ticketState.id, eventId: appended.event.id, leaseUntil: leaseUntilIso, attempts: attemptNumber },
  };
}

/** `renew()`'s implementation, plus the test-only `hooks` seam. `renew()` calls this with no hooks. */
export async function renewCore(params: RenewParams, hooks: RenewHooks): Promise<RenewResult> {
  const now = params.now ?? Date.now();
  const casRetry = validateCasRetry(params.casRetry);
  const leaseOverrideMs = params.lease !== undefined ? parseDurationMs(params.lease) : undefined;

  const ctx = await resolveClaimContext({ board: params.board, now, trailingMonths: params.trailingMonths });
  const leaseMs = leaseOverrideMs ?? ctx.leaseTtlMs;

  const success = await withCasRetry<RenewSuccess>((attemptNumber) => renewAttempt(ctx, params, leaseMs, hooks, attemptNumber), casRetry);

  return {
    ticket: success.ticketId,
    actor: params.actor,
    eventId: success.eventId,
    leaseUntil: success.leaseUntil,
    attempts: success.attempts,
  };
}

/** Extends `params.actor`'s own live lease on a ticket. See `renewAttempt`'s doc comment for the three rejection cases. */
export function renew(params: RenewParams): Promise<RenewResult> {
  return renewCore(params, {});
}

// ============================================================================
// `release` — ends a live lease this actor already holds
// ============================================================================

export interface ReleaseParams {
  readonly board: BoardRef;
  /** The id, display id, or alias as the user typed it — resolved the same way `ClaimParams.ticket` is. */
  readonly ticket: string;
  readonly actor: ActorId;
  /** Injectable clock — see `ClaimParams.now`. */
  readonly now?: number;
  /** Overrides the lease-derived default (`computeTrailingMonths`). */
  readonly trailingMonths?: number;
  /** Validated by this module — see `ClaimParams.casRetry`. */
  readonly casRetry?: CasRetryOptions;
}

export interface ReleaseResult {
  readonly ticket: TicketId;
  readonly actor: ActorId;
  readonly eventId: EventId;
  /** How many CAS attempts this call made before succeeding. */
  readonly attempts: number;
}

/** Test-only injection point for `releaseCore`'s internal retry loop — same pattern as `ClaimHooks`. Not part of the public surface. */
export interface ReleaseHooks {
  readonly beforeAppend?: (attemptNumber: number) => Promise<void>;
}

interface ReleaseSuccess {
  readonly ticketId: TicketId;
  readonly eventId: EventId;
  readonly attempts: number;
}

/**
 * One CAS attempt for `release`. Same three rejections as `renew`
 * (`not-held`, `not-holder`, `lease-expired`) — releasing a lease this actor
 * no longer holds could destroy a successor's.
 *
 * **Why `expectedParent` matters here specifically**: `resolveLeaseAnchor`
 * (`state/fold.ts`) clears the anchor on **any** `release`, with **no actor
 * check**. Without `expectedParent`, an honest holder's `release` landing by
 * chain position *after* a competitor's `expire` + `claim` would destroy the
 * *new* holder's lease. With it, this attempt's `release` loses its CAS,
 * re-reads, sees this actor no longer holds the ticket, and rejects
 * (`not-holder` or `not-held`, whichever the fresh fold shows) instead of
 * ever landing.
 *
 * The schema forbids `lease_until` on a `release` event — the candidate
 * below carries no such field.
 */
async function releaseAttempt(
  ctx: ClaimContext,
  params: ReleaseParams,
  hooks: ReleaseHooks,
  attemptNumber: number,
): Promise<CasAttemptResult<ReleaseSuccess>> {
  const { parentSha, state, events } = await snapshotBoard(ctx);
  const ticketState = resolveTicket(state, params.ticket);
  const lease = ticketState.lease;

  if (lease === undefined) {
    throw claimRejected("not-held", ticketState.id);
  }
  if (lease.actor !== params.actor) {
    throw claimRejected("not-holder", ticketState.id, { holder: lease.actor });
  }
  if (lease.expired) {
    throw claimRejected("lease-expired", ticketState.id);
  }

  await hooks.beforeAppend?.(attemptNumber);

  const nowIso = new Date(ctx.now).toISOString();
  const candidate: EventCandidate = {
    event: "release",
    ts: nowIso,
    actor: params.actor,
    ticket: ticketState.id,
  };
  const run = computeDiscardRun(events, ticketState.id);

  const appended = await appendOrRetry(ctx, candidate, parentSha);
  if (appended === undefined) {
    return { done: false };
  }

  // Discard AFTER the terminating append succeeded, never before (this
  // file's header, and `runDiscardWalk`'s own doc comment).
  await runDiscardWalk(ctx, run);

  return { done: true, value: { ticketId: ticketState.id, eventId: appended.event.id, attempts: attemptNumber } };
}

/** `release()`'s implementation, plus the test-only `hooks` seam. `release()` calls this with no hooks. */
export async function releaseCore(params: ReleaseParams, hooks: ReleaseHooks): Promise<ReleaseResult> {
  const now = params.now ?? Date.now();
  const casRetry = validateCasRetry(params.casRetry);
  const ctx = await resolveClaimContext({ board: params.board, now, trailingMonths: params.trailingMonths });

  const success = await withCasRetry<ReleaseSuccess>((attemptNumber) => releaseAttempt(ctx, params, hooks, attemptNumber), casRetry);

  return { ticket: success.ticketId, actor: params.actor, eventId: success.eventId, attempts: success.attempts };
}

/** Ends `params.actor`'s own live lease on a ticket. See `releaseAttempt`'s doc comment for the three rejection cases and why the CAS matters here specifically. */
export function release(params: ReleaseParams): Promise<ReleaseResult> {
  return releaseCore(params, {});
}

// ============================================================================
// `expireStale` — sweeps every observed-expired lease on the board
// ============================================================================

export interface ExpireStaleParams {
  readonly board: BoardRef;
  /** The actor recorded on every `expire` event this sweep appends — the sweeping caller, never the original holder (ruling, slice 1; mirrors `claimAttempt`'s own reclaim path). */
  readonly actor: ActorId;
  /** Injectable clock — see `ClaimParams.now`. */
  readonly now?: number;
  /** Overrides the lease-derived default (`computeTrailingMonths`). */
  readonly trailingMonths?: number;
  /** Validated by this module — see `ClaimParams.casRetry`. Applied independently to each ticket's own CAS cycle. */
  readonly casRetry?: CasRetryOptions;
  /** Reports what would expire and appends nothing (CONCEPT.md L550: `cankan expire [--dry-run]`). A dry run discards nothing either. */
  readonly dryRun?: boolean;
}

/**
 * `"skipped"` covers both dispositions the brief's ruling keeps distinct
 * from a hard abort: this ticket was renewed underneath the sweep (a fresh
 * fold no longer shows its lease as expired), or this ticket's own CAS
 * cycle exhausted its attempts against unrelated contention
 * (`GIT_CAS_CONTENTION_EXCEEDED`) — `reason` tells the two apart. Neither
 * one aborts the sweep; only an observation-store failure does (a thrown
 * `EVENT_OBSERVATION_STORE_UNAVAILABLE`, which propagates out of
 * `expireStale` entirely rather than appearing in this list at all).
 */
export interface ExpireStaleTicketResult {
  readonly ticket: TicketId;
  readonly outcome: "expired" | "skipped";
  /** Present when `outcome` is `"expired"` and this was not a dry run. */
  readonly eventId?: EventId;
  /** Present when `outcome` is `"skipped"`. */
  readonly reason?: "renewed" | "cas-exhausted";
}

export interface ExpireStaleResult {
  readonly dryRun: boolean;
  readonly tickets: readonly ExpireStaleTicketResult[];
}

/** Test-only injection point for `expireStaleCore`'s internal per-ticket retry loops — same pattern as `ClaimHooks`, keyed additionally by which ticket's cycle is about to append. Not part of the public surface. */
export interface ExpireStaleHooks {
  readonly beforeAppend?: (ticket: TicketId, attemptNumber: number) => Promise<void>;
}

type ExpireAttemptValue = { readonly kind: "expired"; readonly eventId: EventId } | { readonly kind: "skipped" };

/**
 * One ticket's own CAS cycle: re-snapshot, confirm the lease is *still*
 * observed expired (a fresh fold may show it renewed, or ended some other
 * way, since the sweep's initial candidate-selection fold), and if so,
 * append `expire` and run the discard walk for the lease it just ended.
 *
 * `lease.expired` is a reader-local observation, never an arbiter (this
 * file's header) — it decides only whether this cycle *attempts* an
 * expire; the CAS decides whether it lands.
 */
async function expireStaleAttempt(
  ctx: ClaimContext,
  ticketId: TicketId,
  actor: ActorId,
  hooks: ExpireStaleHooks,
  attemptNumber: number,
): Promise<CasAttemptResult<ExpireAttemptValue>> {
  const key = normalizeTicketIdForComparison(ticketId);
  const { parentSha, state, events } = await snapshotBoard(ctx);
  const ticketState = state.tickets.find((t) => normalizeTicketIdForComparison(t.id) === key);
  const lease = ticketState?.lease;

  if (ticketState === undefined || lease === undefined || !lease.expired) {
    // No longer eligible: renewed, released/closed, or already expired by
    // someone else since the sweep's own candidate-selection fold. A
    // decision-level loss, not a store failure — skip this ticket, do not
    // abort the sweep.
    return { done: true, value: { kind: "skipped" } };
  }

  await hooks.beforeAppend?.(ticketId, attemptNumber);

  const nowIso = new Date(ctx.now).toISOString();
  const candidate: EventCandidate = {
    event: "expire",
    ts: nowIso,
    actor,
    ticket: ticketState.id,
  };
  const run = computeDiscardRun(events, ticketState.id);

  const appended = await appendOrRetry(ctx, candidate, parentSha);
  if (appended === undefined) {
    return { done: false };
  }

  // An observation-store failure here (`EVENT_OBSERVATION_STORE_UNAVAILABLE`)
  // is a throw, not a `{ done: false }` — it propagates straight out of
  // `withCasRetry`, out of this function, and out of the calling loop in
  // `expireStaleCore`, aborting the whole sweep (ADR failure mode 7: an
  // unwritable/unreadable store must not be shrugged off, or every
  // remaining ticket's records leak silently and no lease ever expires
  // again for this reader).
  await runDiscardWalk(ctx, run);

  return { done: true, value: { kind: "expired", eventId: appended.event.id } };
}

/**
 * Sweeps `ticketId`'s own CAS cycle to completion, translating the two
 * per-ticket-skip dispositions (renewed underneath the sweep, or this
 * ticket's own CAS cycle exhausting `GIT_CAS_CONTENTION_EXCEEDED` against
 * unrelated contention) into a result entry rather than letting either
 * abort the sweep. Any other error — most importantly
 * `EVENT_OBSERVATION_STORE_UNAVAILABLE` from the discard walk or an
 * `observe()` call — propagates unchanged, aborting the sweep.
 */
async function sweepOneTicket(
  ctx: ClaimContext,
  ticketId: TicketId,
  actor: ActorId,
  hooks: ExpireStaleHooks,
  casRetry: CasRetryOptions | undefined,
): Promise<ExpireStaleTicketResult> {
  try {
    const outcome = await withCasRetry<ExpireAttemptValue>(
      (attemptNumber) => expireStaleAttempt(ctx, ticketId, actor, hooks, attemptNumber),
      casRetry,
    );
    if (outcome.kind === "expired") {
      return { ticket: ticketId, outcome: "expired", eventId: outcome.eventId };
    }
    return { ticket: ticketId, outcome: "skipped", reason: "renewed" };
  } catch (err) {
    if (isCanKanError(err) && err.code === GitErrorCodes.GIT_CAS_CONTENTION_EXCEEDED) {
      // This ticket's own cycle lost the race repeatedly against unrelated
      // contention — a per-ticket skip (this file's header: "your CAS lost
      // the race" is explicitly grouped with "renewed underneath you" as a
      // decision-level loss), never a reason to abort tickets not yet
      // swept.
      return { ticket: ticketId, outcome: "skipped", reason: "cas-exhausted" };
    }
    throw err;
  }
}

/**
 * `expireStale()`'s implementation, plus the test-only `hooks` seam.
 * `expireStale()` calls this with no hooks.
 *
 * Folds the board **once** (`snapshotBoard`, this module's only tip reader)
 * to select every ticket whose lease is currently observed expired — that
 * one fold is the candidate list for the whole sweep; it is never re-run
 * mid-sweep. Each candidate then gets its own independent CAS cycle
 * (`sweepOneTicket`), so a competitor renewing or reclaiming one ticket
 * mid-sweep affects only that ticket's own outcome, never the others'.
 *
 * A dry run reports the same candidate list with no event appended and
 * nothing discarded — it does not even enter the per-ticket loop.
 */
export async function expireStaleCore(params: ExpireStaleParams, hooks: ExpireStaleHooks): Promise<ExpireStaleResult> {
  const now = params.now ?? Date.now();
  const casRetry = validateCasRetry(params.casRetry);
  const ctx = await resolveClaimContext({ board: params.board, now, trailingMonths: params.trailingMonths });
  const dryRun = params.dryRun ?? false;

  const { state } = await snapshotBoard(ctx);
  const candidates = state.tickets.filter((t) => t.lease?.expired);

  if (dryRun) {
    return {
      dryRun: true,
      tickets: candidates.map((t) => ({ ticket: t.id, outcome: "expired" as const })),
    };
  }

  const tickets: ExpireStaleTicketResult[] = [];
  for (const candidate of candidates) {
    tickets.push(await sweepOneTicket(ctx, candidate.id, params.actor, hooks, casRetry));
  }
  return { dryRun: false, tickets };
}

/** Sweeps the board, ending every lease this reader currently observes as expired. See `expireStaleAttempt`'s and `sweepOneTicket`'s doc comments for the failure-disposition ruling this implements. */
export function expireStale(params: ExpireStaleParams): Promise<ExpireStaleResult> {
  return expireStaleCore(params, {});
}
