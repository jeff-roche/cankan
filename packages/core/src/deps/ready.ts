/**
 * `deps/ready.ts` — M2.11's readiness check: `isReady` returns a structured
 * verdict for one ticket ("open, unclaimed, no open blockers, not excluded
 * by label" — CONCEPT.md §4), and `readySet` sweeps a whole board.
 *
 * ## Binding constraint: this is advisory, never authoritative — surface it
 * to a human, do not auto-act on it
 *
 * `state/queries.ts::blockedBy` already documents the attack this section
 * restates in this module's own words, because everything `isReady` builds
 * on inherits it in full:
 *
 * **Two pushed events — one `close`, one `alias` — permanently neutralize
 * any `blocks` dependency on the board.** Push a `close` event naming any
 * real, closable ticket, then push an `alias {from: <the dep id>, to: <that
 * now-closed ticket>}`. The dependency's id now resolves (through
 * `blockedBy`'s alias-aware tiered index) to a closed ticket, so it reads
 * satisfied — for every ticket that names it. The attacker needs **push
 * access to the coordination ref alone and zero access to the repository
 * itself**. Because **no `reopen` event kind exists** (`state/fold.ts`'s own
 * Ruling R14 gap), `closed` can never be cleared back to `false` — the
 * effect is **permanent**.
 *
 * `state.blockedBy` — and therefore every `"blocked"` reason this function
 * ever reports — is **advisory, not authoritative**. A human reading "this
 * looks ready" and using their own judgment is exactly what this function is
 * for. **A machine that auto-claims, auto-merges, or auto-advances work on
 * the strength of an `isReady`/`readySet` verdict turns a coordination-ref
 * push into board-wide control** — an escalation path from "can push one
 * ref" to "can silently unblock anything." Nothing downstream of this module
 * (M2.10's `ready`/`claim --next` and anything built on top of them) may
 * auto-act on this result. Read the verdict; don't act on it unattended.
 *
 * **R1's flat-`dependencies` resolution is narrower than `blockedBy`'s, and
 * that narrowness is a partial mitigation, not a fix.** `deps/graph.ts`'s
 * `resolveTier1` deliberately never follows `eventAliases` (or any other
 * tier) — so a flat `dependencies` entry can never be redirected onto a
 * closed ticket by a hostile `alias` event the way a typed `cankan.deps`
 * entry can. But the typed half of this function's answer still goes
 * through `blockedBy` in full, so it is still exposed to exactly the attack
 * above. Only the flat-dependency half is narrower; the module as a whole is
 * not immune.
 *
 * ## Where flat `dependencies` and `labelsFor` come from (Ruling R6)
 *
 * `state/fold.ts`'s `TicketState` carries `deps`, `lease`, `status`,
 * `closed`, `aliases`, `displayId`, `path`, `id` — it does **not** carry
 * `labels` or Backlog.md's flat `dependencies`. Both live on
 * `TicketFrontmatter` in `ticket/`, which this module's `Depends on`
 * (`state/` alone, PLAN.md rule 2) does not permit importing. Following
 * `state/fold.ts`'s own contract 2 pattern (`leaseTtlMs` is always a caller
 * argument; the fold never reads config), `isReady`'s options carry
 * `excludedLabels`, `labelsFor` and `flatDependenciesFor` — all
 * caller-supplied, all defaulting to "nothing to report" when absent. This
 * module never calls `loadBoardConfig`; resolving `ready.exclude_labels`
 * (CONCEPT.md:334) from config and reading a ticket's frontmatter
 * `dependencies`/`labels` are the caller's job (the CLI, M2.9+).
 *
 * Label comparison is **case-sensitive, exact string match** — deliberately
 * simple: labels are free text a user chose, not a lookup key like a ticket
 * id, and CONCEPT.md's own worked config (`icebox`, `needs-design`) never
 * shows mixed casing. A caller that wants case-insensitive matching can
 * normalize both `excludedLabels` and `labelsFor`'s output before calling
 * in; this function does not invent a folding rule on its own.
 *
 * ## "Open" means `!closed`, never a status string (Ruling R7)
 *
 * `state/fold.ts` deliberately has no `columns` config, so no status string
 * means "done" — `TicketState.closed` is the only lifecycle signal
 * available, and the only one this module reads. `"Done"`, `"done"`,
 * `"Closed"` and every other status string are never special-cased.
 *
 * ## Both `blockedBy` error codes always escape, uncaught (Ruling R2)
 *
 * `state/queries.ts::blockedBy` throws `STATE_TICKET_ID_AMBIGUOUS` (the id
 * is duplicated on the board) and `STATE_TICKET_NOT_IN_BOARD_STATE` (the id
 * is genuinely absent) — opposite facts with opposite remedies. `isReady`
 * calls `blockedBy` first and lets both propagate: no
 * `try { blockedBy(...) } catch { return false }`, and no third `deps/`
 * error code wrapping either one. Collapsing "duplicated" into an ordinary
 * negative readiness answer would hide the fact that the caller's board data
 * is ambiguous behind a plain "not ready." Calling `blockedBy` unconditionally
 * first has a second benefit: by the time it returns without throwing,
 * `ticketId` is guaranteed to match **exactly one** entry in
 * `state.tickets` (contract 3 — an id absent from `state.tickets` may be
 * duplicated, never assume "missing"), so this function's own lookup right
 * after it is safe.
 */

import { blockedBy } from "../state/index";
import type { BoardState, TicketState } from "../state/index";
import type { ActorId, TicketId } from "../types";
import { indexById, normalizeDependencyId, resolveTier1 } from "./graph";

/**
 * One reason `isReady` considers a ticket not ready. A discriminated union
 * so a human-facing renderer (or a test) can branch on `kind` without
 * string-matching, and so every applicable reason is reportable in full —
 * `isReady` never stops at the first one it finds.
 */
export type ReadinessBlocker =
  | { readonly kind: "closed" }
  | { readonly kind: "claimed"; readonly actor: ActorId }
  | { readonly kind: "blocked"; readonly rawId: string; readonly resolvedTicket: TicketState | undefined }
  | { readonly kind: "excluded-label"; readonly label: string };

/**
 * `isReady`'s result. `reasons` is empty **iff** `ready` is `true` — a bare
 * `false` would be a poor thing to surface to a human asking "why isn't this
 * ready," and is mutation-fragile besides (a stub `return false` would pass
 * every negative test that only checks `.ready`).
 */
export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly reasons: readonly ReadinessBlocker[];
}

/** Caller-supplied inputs `isReady` needs but `TicketState` does not carry (Ruling R6). All default to "nothing to report." */
export interface IsReadyOptions {
  /** Labels that disqualify a ticket from readiness (CONCEPT.md:334's `ready.exclude_labels`, e.g. `[icebox, needs-design]`). Default `[]`. */
  readonly excludedLabels?: readonly string[];
  /** A ticket's labels, by id. Default: every ticket has no labels. */
  readonly labelsFor?: (ticketId: TicketId) => readonly string[];
  /** A ticket's Backlog.md flat frontmatter `dependencies` (Ruling R1), by id. Default: every ticket has none. */
  readonly flatDependenciesFor?: (ticketId: TicketId) => readonly string[];
}

const NO_LABELS: readonly string[] = [];
const NO_FLAT_DEPS: readonly string[] = [];

/** The de-duplication key for one outstanding blocker: the resolved target's normalized id when known, else the raw id's normalized form — same as `graph.ts`'s edge de-duplication, so a typed dep and a flat dep naming the same target (directly, or through `blockedBy`'s alias-aware resolution) collapse to one reason, not two (Ruling R1's worked example). */
function blockerDedupeKey(rawId: string, resolvedTicket: { readonly id: TicketId } | undefined): string {
  return resolvedTicket !== undefined ? normalizeDependencyId(resolvedTicket.id) : normalizeDependencyId(rawId);
}

/**
 * Is `ticketId` ready right now? "Open, unclaimed, no open blockers, not
 * excluded by label" (CONCEPT.md §4), with every applicable reason reported
 * — see `ReadinessVerdict`. Read this file's header before wiring this into
 * anything that acts automatically: the result is advisory.
 *
 * `state.blockedBy(state, ticketId)` is called first, unconditionally, and
 * never wrapped in `try`/`catch` (Ruling R2) — both its error codes escape
 * to this function's own caller with their `code` intact.
 */
export function isReady(state: BoardState, ticketId: TicketId, options: IsReadyOptions = {}): ReadinessVerdict {
  const excludedLabels = options.excludedLabels ?? NO_LABELS;
  const labelsFor = options.labelsFor;
  const flatDependenciesFor = options.flatDependenciesFor;

  // Ruling R2: let both STATE_TICKET_ID_AMBIGUOUS and
  // STATE_TICKET_NOT_IN_BOARD_STATE escape untouched. This also validates
  // (contract 3) that `ticketId` matches exactly one ticket before the
  // `.find` below runs.
  const typedBlockers = blockedBy(state, ticketId);

  const ticketsByKey = indexById(state.tickets);
  // Safe: `blockedBy` above did not throw, which it would have done for
  // both "absent" and "ambiguous" — so exactly one entry in `state.tickets`
  // matches `ticketId`'s normalized form, found the identical way
  // `blockedBy` itself resolves its own `ticketId` argument.
  const ticket = ticketsByKey.get(normalizeDependencyId(ticketId)) as TicketState;

  const reasons: ReadinessBlocker[] = [];

  if (ticket.closed) {
    reasons.push({ kind: "closed" });
  }

  // "Unclaimed" comes from the fold alone, never from frontmatter — a
  // never-observed or expired lease is not a claim (Ruling R7's sibling
  // rule, contracts section).
  if (ticket.lease !== undefined && !ticket.lease.expired) {
    reasons.push({ kind: "claimed", actor: ticket.lease.actor });
  }

  const reportedBlockerKeys = new Set<string>();
  for (const dep of typedBlockers) {
    reportedBlockerKeys.add(blockerDedupeKey(dep.rawId, dep.resolvedTicket));
    reasons.push({ kind: "blocked", rawId: dep.rawId, resolvedTicket: dep.resolvedTicket });
  }

  // Ruling R1: resolve Backlog.md's flat `dependencies` ourselves, tier 1
  // only, failing closed — `blockedBy` never sees these at all (Ruling R6:
  // `TicketState` does not carry them).
  for (const rawId of flatDependenciesFor?.(ticketId) ?? NO_FLAT_DEPS) {
    const resolvedTicket = resolveTier1(rawId, ticketsByKey);
    const key = blockerDedupeKey(rawId, resolvedTicket);
    if (reportedBlockerKeys.has(key)) {
      continue; // same target already reported via the typed half — one blocker, not two.
    }
    const satisfied = resolvedTicket?.closed === true;
    if (!satisfied) {
      reportedBlockerKeys.add(key);
      reasons.push({ kind: "blocked", rawId, resolvedTicket });
    }
  }

  const labels = labelsFor?.(ticketId) ?? NO_LABELS;
  for (const excludedLabel of excludedLabels) {
    if (labels.includes(excludedLabel)) {
      reasons.push({ kind: "excluded-label", label: excludedLabel });
    }
  }

  return { ready: reasons.length === 0, reasons };
}

/**
 * Sweeps every ticket in `state` through `isReady`, with the same `options`
 * applied to each. **This is the hot path Ruling R8 flags**: `blockedBy`
 * rebuilds its identifier index from scratch on every call (O(t) per call,
 * O(t²) across a whole-board sweep — measured ~252ms at 3000 tickets per the
 * brief), and this function calls it once per ticket. `deps/` cannot fix
 * that internally without either duplicating `buildIdentifierIndex` (Ruling
 * R1 forbids it) or building its own equivalent index (the same problem
 * under a different name) — see this module's own benchmark
 * (`test/deps/readySweepBenchmark.test.ts`) for the measured number and
 * `packages/core/src/deps/index.ts`'s header for the follow-up this implies
 * for `state/`.
 *
 * Returns a verdict per ticket, not just the ready ones — a caller wanting
 * "why isn't X ready" for a not-yet-ready ticket needs the same sweep this
 * function already did.
 */
export function readySet(state: BoardState, options: IsReadyOptions = {}): ReadonlyMap<TicketId, ReadinessVerdict> {
  const result = new Map<TicketId, ReadinessVerdict>();
  for (const ticket of state.tickets) {
    result.set(ticket.id, isReady(state, ticket.id, options));
  }
  return result;
}
