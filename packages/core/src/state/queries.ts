/**
 * `state/queries.ts` — read-only views over a `BoardState` the fold (M2.8's
 * own `foldState`/`observeAndFold`) already produced. Every function here
 * takes a `BoardState`, never raw `tickets`/`events` — these are queries
 * over an already-folded result, not a second fold (PLAN.md's M2.8 `Wires`
 * line reserves "combines ticket files and events" for `fold.ts` alone).
 */

import {
  normalizeTicketIdForComparison,
  type TicketIdLookupKey,
} from "../store/index";
import { CanKanError } from "../errors";
import type { ActorId, TicketId } from "../types";
import { StateErrorCodes } from "./errors";
import type { BoardState, TicketState } from "./fold";

/**
 * Groups every ticket by its **resolved** status (`TicketState.status` —
 * Ruling R6's precedence rule already applied by the fold), not by
 * `statusFromFrontmatter` or `statusFromEvents` individually.
 */
export function byStatus(
  state: BoardState,
): ReadonlyMap<string, readonly TicketState[]> {
  const grouped = new Map<string, TicketState[]>();
  for (const ticket of state.tickets) {
    const bucket = grouped.get(ticket.status);
    if (bucket === undefined) {
      grouped.set(ticket.status, [ticket]);
    } else {
      bucket.push(ticket);
    }
  }
  return grouped;
}

/**
 * Groups every ticket that currently has a **live** (non-expired) claim by
 * its holding actor. CONCEPT.md §4: "Expired claims return to Ready" — an
 * expired claim is not a claim, so a ticket whose `lease.expired` is `true`
 * (including the "never observed" case — see `LeaseState.expired`'s own
 * doc) is excluded here, exactly as it would be from `ready`'s "unclaimed"
 * check.
 */
export function claimedBy(
  state: BoardState,
): ReadonlyMap<ActorId, readonly TicketState[]> {
  const grouped = new Map<ActorId, TicketState[]>();
  for (const ticket of state.tickets) {
    if (ticket.lease === undefined || ticket.lease.expired) {
      continue;
    }
    const actor = ticket.lease.actor;
    const bucket = grouped.get(actor);
    if (bucket === undefined) {
      grouped.set(actor, [ticket]);
    } else {
      bucket.push(ticket);
    }
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// blockedBy
// ---------------------------------------------------------------------------

/** One `blocks`-type dependency that is still outstanding for the ticket `blockedBy` was asked about. */
export interface BlockingDependency {
  /** Exactly as written in the ticket's `cankan.deps[].id` — never normalized, so a caller can show the user what they actually typed. */
  readonly rawId: string;
  /**
   * The ticket this id resolved to, if any. `undefined` means this board's
   * fold could not resolve it — either it names no ticket, its own id,
   * `display_id`, or any known alias found in this checkout, it is a
   * cross-board `<repo>:<id>` reference (CONCEPT.md §6c) which a
   * single-board fold has no data to resolve, or two tickets' identifiers
   * collided at the same resolution tier (`buildIdentifierIndex`'s own
   * doc) and neither is treated as the resolution. **An unresolved id is
   * still reported as outstanding** (see `blockedBy`'s own doc) — silently
   * dropping it would make a blocked ticket look ready, the wrong direction
   * to fail.
   *
   * **Not a mutual-exclusion input.** This can resolve through
   * `TicketState.eventAliases` — a provenance any contributor with push
   * access to the coordination ref can write (see that field's own doc).
   * Two peers whose local ticket files differ (a display id renamed
   * locally, say) can legitimately compute a different `blockedBy` result
   * for the same ticket at the same moment. That is fine for *readiness* (a
   * UI hint, not a lock) but must never be read as agreement between peers
   * the way a claim is — the event log's claim/lease events, not this
   * query, arbitrate who holds a ticket regardless of what `blockedBy`
   * says about it.
   */
  readonly resolvedTicket: TicketState | undefined;
}

function looksCrossBoard(id: string): boolean {
  // CONCEPT.md §6c's cross-board ref shape is `<repo>:<id>` (e.g.
  // `api:ck-7f3a9c`). No ticket id this project mints (`ck-<hash>`) or
  // adopts (a Backlog.md `TASK-N`, a Jira `PROJ-45`) legitimately contains
  // `:` — CONCEPT.md's own worked examples never show one outside this
  // exact shape — so its presence is treated as "this names another
  // board's ticket, which this fold cannot see," not as a malformed local
  // id to resolve harder against.
  return id.includes(":");
}

/**
 * Builds the same kind of identifier index `store/ticketStore.ts`'s
 * `identifiersFor` builds (id + `display_id` + aliases) — extended with the
 * alias *events* `TicketState.eventAliases` already folds in, per that
 * file's own comment naming M2.8 as the place that gap gets closed. The
 * brief's own wording — "Ids in `deps` may be display ids or cross-board
 * refs" — names `display_id` explicitly, so a dep naming a Jira/GitHub
 * display id (CONCEPT.md's own `PROJ-45` worked example) resolves here too,
 * not only a ticket's own id or alias.
 *
 * **Tiered, not flat — Ruling I1 (security review).** A flat `index.set()`
 * over id + `display_id` + `frontmatterAliases` + `eventAliases` lets a
 * later entry silently overwrite an earlier one: a well-formed hostile
 * `alias {from: <victim's real id>, to: <any closed ticket>}` would
 * overwrite the victim's own id entry with the attacker's chosen target,
 * and `blockedBy` would then report the victim as satisfied without ever
 * touching it (verified directly, security review). This function instead
 * resolves one tier at a time, most-authoritative first — `id`, then
 * `displayId`, then `frontmatterAliases` (repo-controlled: only a local
 * write, typically `adopt`/`renumber`, can add one), then `eventAliases`
 * (pushable by anyone with push access to the coordination ref) — and a key
 * already claimed by an earlier tier is never touched again by a later one.
 * Within one tier, two different tickets claiming the same key is a
 * collision, not a coin flip: that key is left **unset** (never resolves to
 * either ticket) rather than picking one, so `blockedBy` reports it as
 * unresolved — the same fail-safe "still outstanding" direction as any
 * other unresolved id.
 */
function buildIdentifierIndex(
  tickets: readonly TicketState[],
): Map<TicketIdLookupKey, TicketState> {
  const CONFLICT = Symbol("conflict");
  const index = new Map<TicketIdLookupKey, TicketState | typeof CONFLICT>();

  function addTier(keysFor: (ticket: TicketState) => readonly string[]): void {
    const claimedThisTier = new Map<
      TicketIdLookupKey,
      TicketState | typeof CONFLICT
    >();
    for (const ticket of tickets) {
      for (const rawKey of keysFor(ticket)) {
        const key = normalizeTicketIdForComparison(rawKey);
        if (index.has(key)) {
          continue; // an earlier, more-authoritative tier already claimed this key
        }
        const existing = claimedThisTier.get(key);
        if (existing === undefined) {
          claimedThisTier.set(key, ticket);
        } else if (existing !== ticket) {
          claimedThisTier.set(key, CONFLICT); // two different tickets, same tier, same key
        }
      }
    }
    for (const [key, entry] of claimedThisTier) {
      index.set(key, entry);
    }
  }

  addTier((t) => [t.id]);
  addTier((t) => (t.displayId !== undefined ? [t.displayId] : []));
  addTier((t) => t.frontmatterAliases);
  addTier((t) => t.eventAliases);

  const resolved = new Map<TicketIdLookupKey, TicketState>();
  for (const [key, entry] of index) {
    if (entry !== CONFLICT) {
      resolved.set(key, entry);
    }
  }
  return resolved;
}

/**
 * Returns every `blocks`-type dependency of `ticketId` that is not
 * currently satisfied — i.e. what this ticket is blocked by, right now.
 * An empty result means the ticket has no outstanding `blocks` dependency
 * (CONCEPT.md:164's "ready = ... no open `blocks` deps" checks exactly
 * this). `cankanBlockSchema.deps` also carries `parent-child`, `related`
 * and `discovered-from` entries (CONCEPT.md §6) — only `blocks` gates
 * readiness, so the other three are ignored here.
 *
 * A dependency is "satisfied" only when it resolves to a known ticket
 * **and** that ticket's `closed` is `true` — this fold has no `columns`
 * config (deliberately, see `fold.ts`'s own comment) to know which column
 * means "done," and `closed` is the one lifecycle signal available without
 * one. An unresolved id (see `BlockingDependency.resolvedTicket`) is always
 * treated as still outstanding.
 *
 * **`closed` is event-only evidence, writable by anyone with push access to
 * the coordination ref.** A later `reopen` event can restore the blocker, so
 * a forged close is no longer permanent; this remains advisory readiness data,
 * not an authorization boundary.
 *
 * **Path A composes with the `eventAliases` tier (Ruling A6) into something
 * strictly larger than either alone — fix round 5, security review.** A6 on
 * its own needs an *already-closed* ticket to redirect a dep onto; Path A on
 * its own can only touch a dep whose id already resolves to a real ticket.
 * Together, one contributor with coordination-ref push and **zero repo
 * access** can neutralize *any* `blocks` dep, including one naming an id
 * that resolves to nothing at all: push a `close` event for one real,
 * already-closed-or-closable ticket, then push an
 * `alias {from: <the unresolvable dep id>, to: <that closed ticket>}` — the
 * dep now resolves and reads satisfied. Two events, no repo write, and —
 * because `closed` can be reversed by a later `reopen` event — recoverable,
 * although the attacker can still steer readiness until that recovery lands.
 * Each half was disclosed individually above and in
 * `BlockingDependency.resolvedTicket`'s own doc; stated here because the
 * union is what actually matters and neither half's own disclosure said so.
 *
 * **Binding forward constraint, not a caveat: no downstream consumer
 * (M2.10's `ready`/`claim --next` and anything built on them) may auto-act
 * on a `blockedBy` result.** It may only ever be *surfaced to a human* —
 * "here is what this fold currently believes is blocking you." The moment
 * something automatically claims or unblocks work on the strength of an
 * empty `blockedBy` result, the composition above stops being a readiness
 * display and becomes an exploit: two events, no repo access, arbitrary
 * `blocks` deps satisfied. This is Minor today only because no consumer
 * exists yet to violate it.
 *
 * **The companion constraint this one depends on (fix round 6) lives on
 * `BoardState.duplicateTicketIds`, not here, but belongs in the same
 * binding register: no downstream consumer may read a ticket's absence
 * from `BoardState.tickets` as "does not exist" or "is unclaimed" without
 * first checking `duplicateTicketIds` for that id.** `blockedBy` itself
 * already enforces this for its own lookup (see the `TICKET_ID_AMBIGUOUS`
 * check below) — this is the rule a *different* future consumer of
 * `BoardState.tickets` would also need to follow, and it is exactly as
 * binding as the one above.
 *
 * **Not a mutual-exclusion input** — see `BlockingDependency.resolvedTicket`'s
 * own doc: two peers can legitimately compute a different result here for
 * the same ticket, and neither result decides who holds a claim.
 *
 * Cycle safety: this only ever reads `ticketId`'s own `deps` array — a flat
 * list of other ids, not a graph this function walks — so a cycle
 * elsewhere in the dependency data cannot make this function loop. Cycle
 * detection across the whole graph is `dep add`'s job (CONCEPT.md §6), not
 * this query's.
 */
export function blockedBy(
  state: BoardState,
  ticketId: TicketId,
): readonly BlockingDependency[] {
  const key = normalizeTicketIdForComparison(ticketId);

  // Ruling D1 (fix round 6, security/code review): check
  // `duplicateTicketIds` BEFORE concluding "not present". Through the real
  // fold, a duplicated id lands on zero matches below (`foldState` excludes
  // it from `tickets` entirely) — without this check that would throw the
  // identical `TICKET_NOT_IN_BOARD_STATE` code and a near-identical message
  // as a genuinely absent ticket, even though the two are opposite facts
  // with opposite remedies. `TICKET_ID_AMBIGUOUS` lets a caller tell them
  // apart without string-matching the message.
  const duplicate = state.duplicateTicketIds.find((d) => d.ticketId === key);
  if (duplicate !== undefined) {
    throw new CanKanError(
      StateErrorCodes.TICKET_ID_AMBIGUOUS,
      `ticket ${ticketId} is ambiguous: claimed by ${duplicate.paths.length} ticket files in this checkout, not absent`,
      { details: { ticketId, paths: duplicate.paths } },
    );
  }

  // `.filter`, never `.find` (Ruling D1, fix round 5, security review):
  // `foldState` already excludes a duplicate-normalized-id ticket from
  // `state.tickets` entirely (see `partitionByDuplicateId`), so more than
  // one match here should be unreachable in practice — but `.find` would
  // silently pick whichever entry happens to come first in array order if
  // that invariant were ever violated (by a future fold change, or a
  // hand-built `BoardState`), and array order deciding an outcome is
  // exactly what this module must never do (the same invariant the
  // alias-cycle fix, Ruling R12, enforces on the event side). Failing
  // closed here costs three lines and closes that hole permanently rather
  // than trusting the invariant to hold forever upstream. Uses the same
  // `TICKET_ID_AMBIGUOUS` code as the `duplicateTicketIds` check above —
  // both are the identical fact (this id is ambiguous), reached by two
  // different routes.
  const matches = state.tickets.filter(
    (t) => normalizeTicketIdForComparison(t.id) === key,
  );
  if (matches.length === 0) {
    throw new CanKanError(
      StateErrorCodes.TICKET_NOT_IN_BOARD_STATE,
      `ticket ${ticketId} is not present in this BoardState`,
      { details: { ticketId } },
    );
  }
  if (matches.length > 1) {
    throw new CanKanError(
      StateErrorCodes.TICKET_ID_AMBIGUOUS,
      `ticket ${ticketId} matches more than one entry in this BoardState — refusing to pick one by array order`,
      { details: { ticketId, matchCount: matches.length } },
    );
  }
  const ticket = matches[0] as TicketState;

  const deps = ticket.deps;
  if (deps.length === 0) {
    return [];
  }

  const index = buildIdentifierIndex(state.tickets);
  const outstanding: BlockingDependency[] = [];
  for (const dep of deps) {
    if (dep.type !== "blocks") continue;
    const resolvedTicket = looksCrossBoard(dep.id)
      ? undefined
      : index.get(normalizeTicketIdForComparison(dep.id));
    const satisfied = resolvedTicket?.closed === true;
    if (!satisfied) {
      outstanding.push({ rawId: dep.id, resolvedTicket });
    }
  }
  return outstanding;
}
