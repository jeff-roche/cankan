/**
 * `state/queries.ts` — read-only views over a `BoardState` the fold (M2.8's
 * own `foldState`/`observeAndFold`) already produced. Every function here
 * takes a `BoardState`, never raw `tickets`/`events` — these are queries
 * over an already-folded result, not a second fold (PLAN.md's M2.8 `Wires`
 * line reserves "combines ticket files and events" for `fold.ts` alone).
 */

import { normalizeTicketIdForComparison, type TicketIdLookupKey } from "../store/index";
import { CanKanError } from "../errors";
import type { ActorId, TicketId } from "../types";
import { StateErrorCodes } from "./errors";
import type { BoardState, TicketState } from "./fold";

/**
 * Groups every ticket by its **resolved** status (`TicketState.status` —
 * Ruling R6's precedence rule already applied by the fold), not by
 * `statusFromFrontmatter` or `statusFromEvents` individually.
 */
export function byStatus(state: BoardState): ReadonlyMap<string, readonly TicketState[]> {
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
export function claimedBy(state: BoardState): ReadonlyMap<ActorId, readonly TicketState[]> {
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
   * `display_id`, or any known alias found in this checkout, or it is a
   * cross-board `<repo>:<id>` reference (CONCEPT.md §6c), which a
   * single-board fold has no data to resolve. **An unresolved id is still
   * reported as outstanding** (see `blockedBy`'s own doc) — silently
   * dropping it would make a blocked ticket look ready, the wrong direction
   * to fail.
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
 * alias *events* `TicketState.aliases` already folds in, per that file's
 * own comment naming M2.8 as the place that gap gets closed. The brief's
 * own wording — "Ids in `deps` may be display ids or cross-board refs" —
 * names `display_id` explicitly, so a dep naming a Jira/GitHub display id
 * (CONCEPT.md's own `PROJ-45` worked example) resolves here too, not only a
 * ticket's own id or alias.
 */
function buildIdentifierIndex(tickets: readonly TicketState[]): Map<TicketIdLookupKey, TicketState> {
  const index = new Map<TicketIdLookupKey, TicketState>();
  for (const ticket of tickets) {
    index.set(normalizeTicketIdForComparison(ticket.id), ticket);
    if (ticket.displayId !== undefined) {
      index.set(normalizeTicketIdForComparison(ticket.displayId), ticket);
    }
    for (const alias of ticket.aliases) {
      index.set(normalizeTicketIdForComparison(alias), ticket);
    }
  }
  return index;
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
 * Cycle safety: this only ever reads `ticketId`'s own `deps` array — a flat
 * list of other ids, not a graph this function walks — so a cycle
 * elsewhere in the dependency data cannot make this function loop. Cycle
 * detection across the whole graph is `dep add`'s job (CONCEPT.md §6), not
 * this query's.
 */
export function blockedBy(state: BoardState, ticketId: TicketId): readonly BlockingDependency[] {
  const key = normalizeTicketIdForComparison(ticketId);
  const ticket = state.tickets.find((t) => normalizeTicketIdForComparison(t.id) === key);
  if (ticket === undefined) {
    throw new CanKanError(
      StateErrorCodes.TICKET_NOT_IN_BOARD_STATE,
      `ticket ${ticketId} is not present in this BoardState`,
      { details: { ticketId } },
    );
  }

  const deps = ticket.deps;
  if (deps.length === 0) {
    return [];
  }

  const index = buildIdentifierIndex(state.tickets);
  const outstanding: BlockingDependency[] = [];
  for (const dep of deps) {
    if (dep.type !== "blocks") continue;
    const resolvedTicket = looksCrossBoard(dep.id) ? undefined : index.get(normalizeTicketIdForComparison(dep.id));
    const satisfied = resolvedTicket?.closed === true;
    if (!satisfied) {
      outstanding.push({ rawId: dep.id, resolvedTicket });
    }
  }
  return outstanding;
}
