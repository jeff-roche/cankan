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
 */

import { CanKanError, ErrorCodes, isCanKanError } from "../errors";
import type { BoardRef, ActorId, TicketId } from "../types";
import type { CasAttemptResult, CasRetryOptions, GitAdapter, RefSha } from "../git/index";
import { createGitAdapter, withCasRetry } from "../git/index";
import type { AppendedEvent, EventCandidate, EventId } from "../events/index";
import { append, boardKeyFor, observe, read } from "../events/index";
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
  return { parentSha, state };
}

// ============================================================================
// Ticket resolution — id/displayId only, ambiguity checked first
// ============================================================================

function resolveTicket(state: BoardState, ticketQuery: string): TicketState {
  const key = normalizeTicketIdForComparison(ticketQuery);
  // Ruling D1: an id excluded from `state.tickets` because more than one
  // on-disk file declares it must never be read as "not found" — that
  // would fail OPEN on the exact mutual-exclusion primitive this module
  // exists to protect (a duplicate id claimed as though it were a normal,
  // single, unclaimed ticket).
  if (state.duplicateTicketIds.some((d) => d.ticketId === key)) {
    throw new CanKanError(
      ClaimErrorCodes.TICKET_AMBIGUOUS,
      `ticket "${ticketQuery}" is ambiguous: more than one on-disk ticket file declares this id`,
      { details: { ticket: ticketQuery } },
    );
  }
  // Ruling (this module): resolve by `id` and `displayId` ONLY — never by
  // alias. See this file's own header for why an alias-resolved write is
  // out of scope.
  const match = state.tickets.find((t) => {
    if (normalizeTicketIdForComparison(t.id) === key) return true;
    return t.displayId !== undefined && normalizeTicketIdForComparison(t.displayId) === key;
  });
  if (match === undefined) {
    throw new CanKanError(ClaimErrorCodes.TICKET_NOT_FOUND, `no ticket found matching "${ticketQuery}"`, {
      details: { ticket: ticketQuery },
    });
  }
  return match;
}

// ============================================================================
// `CLAIM_REJECTED` — the shared, seeded code, sub-cased by `details.reason`
// ============================================================================

type ClaimRejectionReason = "already-held" | "already-held-by-you" | "max-per-actor" | "closed";

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
  const { parentSha, state } = await snapshotBoard(ctx);
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
    // TODO(slice 2): an `expire` (like a `takeover`) terminates a displaced
    // lease and so carries the same observation-id discard obligation that
    // lease's own anchor event has — `discard()` is not called here; the
    // discard sweep is slice 2's `expireStale` work.
    const expireCandidate: EventCandidate = {
      event: "expire",
      ts: nowIso,
      actor: params.actor,
      ticket: ticketState.id,
      ...parentField,
    };
    try {
      await append(ctx.adapter, ctx.ref, expireCandidate, { now: ctx.now, expectedParent: parentSha });
    } catch (err) {
      if (isStaleParentError(err)) {
        return { done: false };
      }
      throw err;
    }
    return { done: false };
  }

  const leaseUntilIso = new Date(ctx.now + leaseMs).toISOString();
  const kind: "claim" | "takeover" = useForce ? "takeover" : "claim";
  // TODO(slice 2): a `takeover` also terminates the displaced lease and so
  // carries the same observation-id discard obligation as the `expire`
  // branch above — not built here.
  const candidate: EventCandidate = useForce
    ? { event: "takeover", ts: nowIso, actor: params.actor, ticket: ticketState.id, lease_until: leaseUntilIso, ...parentField }
    : { event: "claim", ts: nowIso, actor: params.actor, ticket: ticketState.id, lease_until: leaseUntilIso, ...parentField };

  let appended: AppendedEvent;
  try {
    appended = await append(ctx.adapter, ctx.ref, candidate, { now: ctx.now, expectedParent: parentSha });
  } catch (err) {
    if (isStaleParentError(err)) {
      return { done: false };
    }
    throw err;
  }

  // ADR fm7: "an appender records its own append at the moment it appends."
  // `append` does not do this on this module's behalf, and nothing else
  // will — without this, this process's own lease would never expire for
  // this reader (`firstSeenMs` would stay `undefined` forever).
  await observe(ctx.boardKey, appended.event.id, { now: ctx.now });

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
