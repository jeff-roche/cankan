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
 * `excludedLabels`, `labelsFor` and `flatDependenciesFor`. This module never
 * calls `loadBoardConfig`; resolving `ready.exclude_labels` (CONCEPT.md:334)
 * from config and reading a ticket's frontmatter `dependencies`/`labels` are
 * the caller's job (the CLI, M2.9+).
 *
 * **`flatDependenciesFor` is REQUIRED (fix round 1, Ruling R11) — there is
 * no "nothing to report" default.** It used to default to "this ticket has
 * no flat deps," which is indistinguishable from "this ticket has no *open*
 * flat deps" — so the path of least resistance, `isReady(state, id)` with no
 * options, read a post-`backlog task edit` ticket (no `cankan:` block at
 * all, the exact shape Ruling R1 exists for) as unconditionally **ready**
 * (verified directly: `attack1.ts` §B, no-options gives
 * `{"ready":true,"reasons":[]}` for a ticket with a real, open flat
 * blocker). A default that can be silently wrong is worse than a required
 * argument — a caller that genuinely has no flat deps to check now writes
 * `flatDependenciesFor: () => []` consciously, on purpose, rather than by
 * omission.
 *
 * **`excludedLabels` non-empty with `labelsFor` absent throws (fix round 1,
 * Ruling R11's companion guard) — same failure class, same fix.** Without a
 * `labelsFor` lookup, no ticket's labels can ever be compared against
 * `excludedLabels`, so `"excluded-label"` can never fire — a silent
 * misconfiguration that also fails open. `excludedLabels` absent or empty
 * with `labelsFor` absent stays legal: there is nothing to exclude, so
 * nothing to silently miss. See `DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_
 * LABELS_FOR`.
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
 * calls `blockedBy` before consulting `state.tickets` at all and lets both
 * propagate: no `try { blockedBy(...) } catch { return false }`, and no
 * third `deps/` error code wrapping either one. Collapsing "duplicated" into
 * an ordinary negative readiness answer would hide the fact that the
 * caller's board data is ambiguous behind a plain "not ready." (The
 * `excludedLabels`/`labelsFor` misconfiguration guard below runs *before*
 * `blockedBy`, since it is a caller-programming-error check independent of
 * `ticketId`/board state — see Ruling R11's companion guard — but every
 * board-state-dependent check still goes through `blockedBy` first.) Calling
 * `blockedBy` before that lookup has a second benefit: by the time it
 * returns without throwing, `ticketId` is guaranteed to match **exactly
 * one** entry in `state.tickets` (contract 3 — an id absent from
 * `state.tickets` may be duplicated, never assume "missing"), so this
 * function's own lookup right after it should always find that same entry.
 *
 * **That "should always find it" is now an enforced check, not an unchecked
 * cast (fix round 1, Ruling R15).** `blockedBy` resolves its own subject by
 * an own-id `.filter` (`state/queries.ts:275`), not through
 * `buildIdentifierIndex` — verified directly, this is safe *today*. But the
 * coupling was previously only comment-documented, backed by
 * `ticketsByKey.get(...) as TicketState`: if `state/` ever widens
 * `blockedBy`'s own subject resolution (to `display_id`, say) without a
 * matching change here, that cast would silently keep compiling and this
 * function would degrade to an uncaught `TypeError` from `ticket.closed`
 * a few lines down, instead of a coded, diagnosable error. The lookup below
 * now throws `DepsErrorCodes.BLOCKED_BY_SUBJECT_LOOKUP_INVARIANT_VIOLATED`
 * naming exactly that broken assumption if it ever misses.
 */

import { CanKanError } from "../errors";
import { blockedBy } from "../state/index";
import type { BoardState, DuplicateTicketId, TicketState } from "../state/index";
import type { ActorId, TicketId } from "../types";
import { DepsErrorCodes } from "./errors";
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

/**
 * Caller-supplied inputs `isReady` needs but `TicketState` does not carry
 * (Ruling R6). `flatDependenciesFor` is **required** (fix round 1, Ruling
 * R11) — see this file's header for why a default here was itself the
 * defect. `excludedLabels`/`labelsFor` stay optional (both defaulting to "no
 * exclusions"), but `excludedLabels` non-empty with `labelsFor` absent
 * throws — see `DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR`.
 */
export interface IsReadyOptions {
  /** Labels that disqualify a ticket from readiness (CONCEPT.md:334's `ready.exclude_labels`, e.g. `[icebox, needs-design]`). Default `[]`. Non-empty here without `labelsFor` throws. */
  readonly excludedLabels?: readonly string[];
  /** A ticket's labels, by id. Default: every ticket has no labels. */
  readonly labelsFor?: (ticketId: TicketId) => readonly string[];
  /** A ticket's Backlog.md flat frontmatter `dependencies` (Ruling R1), by id. Required — a caller with genuinely no flat deps to check writes `() => []` on purpose (fix round 1, Ruling R11). */
  readonly flatDependenciesFor: (ticketId: TicketId) => readonly string[];
}

const NO_LABELS: readonly string[] = [];

/** The de-duplication key for one outstanding blocker: the resolved target's normalized id when known, else the raw id's normalized form — same as `graph.ts`'s edge de-duplication, so a typed dep and a flat dep naming the same target (directly, or through `blockedBy`'s alias-aware resolution) collapse to one reason, not two (Ruling R1's worked example). Wrapped in a one-element `JSON.stringify` tuple (Ruling R13, fix round 1) for the same reason `graph.ts`'s `edgeDedupeKey` is: consistency with that function's discipline, even though this key currently has no second field to collide against. */
function blockerDedupeKey(rawId: string, resolvedTicket: { readonly id: TicketId } | undefined): string {
  return JSON.stringify([
    resolvedTicket !== undefined ? normalizeDependencyId(resolvedTicket.id) : normalizeDependencyId(rawId),
  ]);
}

/**
 * Is `ticketId` ready right now? "Open, unclaimed, no open blockers, not
 * excluded by label" (CONCEPT.md §4), with every applicable reason reported
 * — see `ReadinessVerdict`. Read this file's header before wiring this into
 * anything that acts automatically: the result is advisory.
 *
 * `state.blockedBy(state, ticketId)` is called before any lookup into
 * `state.tickets` (after only the caller-programming-error options guard,
 * fix round 1, Ruling R11) and never wrapped in `try`/`catch` (Ruling R2) —
 * both its error codes escape to this function's own caller with their
 * `code` intact.
 */
export function isReady(state: BoardState, ticketId: TicketId, options: IsReadyOptions): ReadinessVerdict {
  const excludedLabels = options.excludedLabels ?? NO_LABELS;
  const labelsFor = options.labelsFor;
  const flatDependenciesFor = options.flatDependenciesFor;

  // Ruling R11's companion guard (fix round 1): excludedLabels non-empty
  // with no labelsFor lookup is a silent misconfiguration that fails open —
  // no label could ever be compared against it, so no exclusion could ever
  // fire. Thrown as a coded, loud error rather than silently doing nothing.
  if (excludedLabels.length > 0 && labelsFor === undefined) {
    throw new CanKanError(
      DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR,
      `isReady: excludedLabels was non-empty (${JSON.stringify(excludedLabels)}) but no labelsFor lookup was supplied — no ticket's labels could ever be checked against it, silently disabling every exclusion`,
      { details: { excludedLabels } },
    );
  }

  // Ruling R2: let both STATE_TICKET_ID_AMBIGUOUS and
  // STATE_TICKET_NOT_IN_BOARD_STATE escape untouched. This also validates
  // (contract 3) that `ticketId` matches exactly one ticket before the
  // lookup below runs.
  const typedBlockers = blockedBy(state, ticketId);

  const { byKey: ticketsByKey } = indexById(state.tickets);
  const ticket = ticketsByKey.get(normalizeDependencyId(ticketId));
  if (ticket === undefined) {
    // Ruling R15 (fix round 1): `blockedBy` above did not throw, which by
    // contract 3 and Ruling R2 guarantees exactly one entry in
    // `state.tickets` matches `ticketId`'s normalized form, resolved the
    // identical way `blockedBy` resolves its own subject (see this file's
    // header). Unreachable today — verified directly against the real
    // `blockedBy` — but if `state/` ever widens that resolution without a
    // matching change here, this is the loud, coded failure instead of an
    // uncaught `TypeError` from `ticket.closed` a few lines down.
    throw new CanKanError(
      DepsErrorCodes.BLOCKED_BY_SUBJECT_LOOKUP_INVARIANT_VIOLATED,
      `isReady: blockedBy(state, ${JSON.stringify(ticketId)}) resolved without throwing, but no ticket in state.tickets matches its normalized id — the assumption that blockedBy's own subject resolution and this function's own resolution always agree (see this file's header) no longer holds`,
      { details: { ticketId } },
    );
  }

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
  // `TicketState` does not carry them). `flatDependenciesFor` is required
  // (Ruling R11, fix round 1) — no silent "assume none" default.
  for (const rawId of flatDependenciesFor(ticketId)) {
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
 * The result of a whole-board `readySet` sweep. Split into `verdicts` (kept
 * to exactly `ReadinessVerdict` per ticket — see `ReadinessVerdict`'s own
 * "clean" shape) and `ambiguousIds` (fix round 1, Ruling R14) rather than
 * inventing a third variant on `ReadinessBlocker` for "this id is
 * ambiguous, not a ticket at all."
 */
export interface ReadySetResult {
  /** One verdict per entry in `state.tickets` — never includes an ambiguous id, which by definition has no entry there. */
  readonly verdicts: ReadonlyMap<TicketId, ReadinessVerdict>;
  /**
   * Every id in `state.duplicateTicketIds`, passed through unchanged (fix
   * round 1, Ruling R14). A duplicated ticket has no entry in
   * `state.tickets` (Ruling D1, `state/fold.ts`), so it has no entry in
   * `verdicts` either — `isReady` still throws `STATE_TICKET_ID_AMBIGUOUS`
   * for it individually (Ruling R2), but a whole-board sweep silently
   * omitting it would fail this module's own "surface to a human" purpose:
   * "your board has an ambiguous id" is exactly the kind of thing a `cankan
   * ready` listing must not drop without a trace (`attack3.ts` §I, verified
   * — the id vanished from the sweep with no signal at all before this
   * fix).
   */
  readonly ambiguousIds: readonly DuplicateTicketId[];
}

/**
 * Sweeps every ticket in `state` through `isReady`, with the same `options`
 * applied to each, plus every ambiguous id `state` knows about (Ruling
 * R14). **`verdicts` is the hot path Ruling R8 flags**: `blockedBy` rebuilds
 * its identifier index from scratch on every call (O(t) per call, O(t²)
 * across a whole-board sweep), and this function calls it once per ticket
 * via `isReady`. `deps/` cannot fix that internally without either
 * duplicating `buildIdentifierIndex` (Ruling R1 forbids it) or building its
 * own equivalent index (the same problem under a different name) — measured
 * at **~1150 ms (range ~1140–1190 ms across repeated local runs) for a
 * 3000-ticket sweep** where every ticket carries both a typed `blocks` dep
 * and a flat `dependencies` entry (`test/deps/readySweepBenchmark.test.ts`,
 * wall-clock, `readySet` only — `foldState` excluded from the timed region).
 * This is larger than the brief's own inherited ~252 ms figure because that
 * number measured `blockedBy`'s O(t²) index-rebuild alone; this benchmark
 * additionally exercises `ready.ts`'s own tier-1 flat-dependency resolution
 * on every ticket (`resolveTier1` over `indexById(state.tickets)`, rebuilt
 * once per `isReady` call, not shared across the sweep) — a second
 * O(t)-per-call cost this module adds on top of `blockedBy`'s. See
 * `packages/core/src/deps/index.ts`'s header for the follow-up this implies
 * for `state/` (a batched `blockedByAll`).
 *
 * `verdicts` holds a verdict per ticket, not just the ready ones — a caller
 * wanting "why isn't X ready" for a not-yet-ready ticket needs the same
 * sweep this function already did.
 */
export function readySet(state: BoardState, options: IsReadyOptions): ReadySetResult {
  const verdicts = new Map<TicketId, ReadinessVerdict>();
  for (const ticket of state.tickets) {
    verdicts.set(ticket.id, isReady(state, ticket.id, options));
  }
  return { verdicts, ambiguousIds: state.duplicateTicketIds };
}
