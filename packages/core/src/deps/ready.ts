/**
 * `deps/ready.ts` — M2.11's readiness check: `isReady` returns a structured
 * verdict for one ticket ("open, unclaimed, no open blockers, not excluded
 * by label" — CONCEPT.md §4), and `readySet` sweeps a whole board.
 *
 * ## Readiness is advisory and attacker-influenceable
 *
 * `state/queries.ts::blockedBy` already documents the attack this section
 * restates in this module's own words, because everything `isReady` builds
 * on inherits it in full:
 *
 * **Two pushed events — one `close`, one `alias` — neutralize any `blocks`
 * dependency on the board, permanently until #105 lands.** Push a `close`
 * event naming any real, closable ticket, then push an `alias {from: <the
 * dep id>, to: <that now-closed ticket>}`. The dependency's id now resolves
 * (through `blockedBy`'s alias-aware tiered index) to a closed ticket, so it
 * reads satisfied — for every ticket that names it. The attacker needs
 * **push access to the coordination ref alone and zero access to the
 * repository itself**.
 *
 * **The controller has ruled on this (fix round 3): CONCEPT.md wins.
 * `claim --next` ships as specified, and the constraint that used to live
 * here — surface this to a human, never auto-act on it — drops from binding
 * to advisory.** The reasoning: this attacker already holds coordination-ref
 * push, and with it can already forge `claim`, `release`, `close` and
 * `alias` events outright — steal a ticket, release someone else's claim,
 * close things directly. Steering *which* ticket an agent auto-picks via a
 * forged readiness verdict is a **subset** of the disruption that attacker
 * already commands, and a claim made this way is **reversible** — release
 * and expiry undo it. Requiring a human in the loop on `--next` does not
 * meaningfully raise the bar against this attacker, while it breaks the
 * headline agent workflow CONCEPT.md:542 specifies. So:
 *
 * - `state.blockedBy` — and therefore every `"blocked"` reason this function
 *   ever reports — is **advisory and attacker-influenceable, not a security
 *   boundary.** Consumers **MAY** auto-act on an `isReady`/`readySet`
 *   verdict: `claim --next` does, by spec (CONCEPT.md:542), and
 *   `claims.require_ready` (CONCEPT.md:300) is a policy knob built on top of
 *   it. There is no prohibition on M2.10 auto-claiming.
 * - **The rule that replaces it: readiness must never be the sole gate on an
 *   action that is NOT reversible.** Frame this as a test a future consumer
 *   applies to itself, not as a list of blessed callers — before wiring an
 *   `isReady` verdict into anything that acts automatically, ask "is the
 *   action I am gating reversible?" Claiming qualifies precisely *because*
 *   release and expiry undo it. An action this module has no way to
 *   enumerate up front, with no undo, needs a stronger gate than readiness
 *   alone — whatever that turns out to be is a decision for that consumer,
 *   not for `deps/`.
 * - **The sharp edge is the permanence, not the auto-action — that is the
 *   part of M2.8's security review that actually matters.** There is no
 *   `reopen` event kind, so a forged `close` cannot be undone through the log
 *   — the effect is permanent **until #105 lands**. That is the root cause,
 *   and it lives in `events/` (M2.7), not in this module. #105: "No reopen
 *   event kind: a forged close permanently neutralizes every blocks
 *   dependency on the board."
 * - **Convergence:** #105 records that M2.8 had already flagged this same
 *   `close`/`reopen` gap as a known limitation in its own Ruling R14 —
 *   reached from the *correctness* side (folding safely around a missing
 *   reopen) — while M2.8's security review reached the identical gap
 *   independently from the *security* side (a forgeable, permanent `close`).
 *   Two independent reviews converging on the same gap from opposite
 *   directions means it is **structural**, not an oversight in either lane.
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
 * **This guard runs from ONE shared function, `assertIsReadyOptionsValid`,
 * called by BOTH `isReady` and `readySet` (fix round 2, Ruling R23) — not
 * duplicated per call site.** `readySet` calls it once, unconditionally,
 * before its per-ticket sweep even starts, rather than depending solely on
 * `isReady`'s own call of it. An **empty** `BoardState` (`state.tickets`
 * has zero entries) never runs `readySet`'s per-ticket loop body at all, so
 * if the guard lived only inside `isReady`, a `readySet` call against an
 * empty board, given `excludedLabels` but no `labelsFor`, would never call
 * `isReady` even once — the misconfiguration would pass
 * silently, returning `{ verdicts: Map(), ambiguousIds: [] }` as if nothing
 * were wrong, exactly the same failure class this guard exists to close
 * (verified directly, fix round 2). A single shared function also means the
 * two call sites cannot drift apart later — the lesson fix round 2 itself
 * exists to enforce: check every OTHER consumer of a value (or a check) you
 * change, not just the one you're looking at.
 *
 * **`isReady` given no `options` at all — or `options` without a
 * `flatDependenciesFor` FUNCTION — throws a coded error, not a bare
 * `TypeError` (fix round 2, Ruling R28).** TypeScript already makes both a
 * compile error at every in-repo call site, but a JS caller unguarded by the
 * type system previously hit `options.excludedLabels` on `undefined` a few
 * lines into this function's body — an uncoded crash with no `.code` to
 * branch on. `assertIsReadyOptionsValid` checks this first, before the
 * `excludedLabels`/`labelsFor` guard above, and throws
 * `DepsErrorCodes.IS_READY_OPTIONS_REQUIRED` naming exactly what's missing.
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

/**
 * Validates `options` before anything else looks at it — the ONE place both
 * `isReady` and `readySet` run this check (fix round 2, Ruling R23), so the
 * two call sites cannot drift apart. Throws `DepsErrorCodes
 * .IS_READY_OPTIONS_REQUIRED` (Ruling R28) when `options` itself is missing
 * or `flatDependenciesFor` isn't a function — a JS caller unguarded by
 * TypeScript's required-parameter check otherwise hits a bare `TypeError`
 * from `options.excludedLabels` a few lines later. Throws
 * `DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR` (Ruling R11's
 * companion guard) when `excludedLabels` is non-empty but `labelsFor` is
 * absent, since no ticket's labels could then ever be checked against it.
 *
 * `readySet` calls this ONCE, unconditionally, before its per-ticket sweep —
 * not only relying on `isReady`'s own call of it per ticket — because an
 * EMPTY board (`state.tickets` has zero entries) never runs that per-ticket
 * loop body at all, which previously let this exact misconfiguration pass a
 * `readySet` call silently (Ruling R23, see this file's header).
 */
function assertIsReadyOptionsValid(
  options: IsReadyOptions | null | undefined,
  caller: "isReady" | "readySet",
): asserts options is IsReadyOptions {
  // Ruling R28 (fix round 2): `options` is typed as required, but that's a
  // TypeScript-only guarantee -- a JS caller (or an `as any` escape hatch)
  // can still omit it, or pass something without a real
  // `flatDependenciesFor` function. Guard it explicitly rather than letting
  // `options.excludedLabels` a few lines below crash with a bare, uncoded
  // TypeError.
  if (options === undefined || options === null || typeof options.flatDependenciesFor !== "function") {
    throw new CanKanError(
      DepsErrorCodes.IS_READY_OPTIONS_REQUIRED,
      `${caller}: options.flatDependenciesFor is required and must be a function — there is no "assume no flat deps" default (Ruling R11); got ${
        options === undefined || options === null ? "no options at all" : "options without a flatDependenciesFor function"
      }`,
      { details: {} },
    );
  }

  // Ruling R11's companion guard (fix round 1): excludedLabels non-empty
  // with no labelsFor lookup is a silent misconfiguration that fails open —
  // no label could ever be compared against it, so no exclusion could ever
  // fire. Thrown as a coded, loud error rather than silently doing nothing.
  const excludedLabels = options.excludedLabels ?? NO_LABELS;
  if (excludedLabels.length > 0 && options.labelsFor === undefined) {
    throw new CanKanError(
      DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR,
      `${caller}: excludedLabels was non-empty (${JSON.stringify(excludedLabels)}) but no labelsFor lookup was supplied — no ticket's labels could ever be checked against it, silently disabling every exclusion`,
      { details: { excludedLabels } },
    );
  }
}

/** The de-duplication key for one outstanding blocker: the resolved target's normalized id when known, else the raw id's normalized form — same as `graph.ts`'s edge de-duplication, so a typed dep and a flat dep naming the same target (directly, or through `blockedBy`'s alias-aware resolution) collapse to one reason, not two (Ruling R1's worked example). Wrapped in a one-element `JSON.stringify` tuple (Ruling R13, fix round 1) for the same reason `graph.ts`'s `edgeDedupeKey` is: consistency with that function's discipline, even though this key currently has no second field to collide against. */
function blockerDedupeKey(rawId: string, resolvedTicket: { readonly id: TicketId } | undefined): string {
  return JSON.stringify([
    resolvedTicket !== undefined ? normalizeDependencyId(resolvedTicket.id) : normalizeDependencyId(rawId),
  ]);
}

/**
 * Is `ticketId` ready right now? "Open, unclaimed, no open blockers, not
 * excluded by label" (CONCEPT.md §4), with every applicable reason reported
 * — see `ReadinessVerdict`. Read this file's header for the reversibility
 * rule before wiring this into anything that acts automatically: the result
 * is advisory and attacker-influenceable, and the gate that matters is
 * whether the action being taken is reversible, not whether a human looked
 * at the verdict first.
 *
 * `state.blockedBy(state, ticketId)` is called before any lookup into
 * `state.tickets` (after only the caller-programming-error options guard,
 * fix round 1, Ruling R11) and never wrapped in `try`/`catch` (Ruling R2) —
 * both its error codes escape to this function's own caller with their
 * `code` intact.
 */
export function isReady(state: BoardState, ticketId: TicketId, options: IsReadyOptions): ReadinessVerdict {
  // Rulings R11, R23, R28 (fix rounds 1 and 2) — see assertIsReadyOptionsValid's own doc and this file's header.
  assertIsReadyOptionsValid(options, "isReady");

  const excludedLabels = options.excludedLabels ?? NO_LABELS;
  const labelsFor = options.labelsFor;
  const flatDependenciesFor = options.flatDependenciesFor;

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
 *
 * Validates `options` itself, ONCE, before the sweep below even starts
 * (fix round 2, Ruling R23) — not only via `isReady`'s own per-ticket call of
 * the same check. An **empty** `state.tickets` means the loop below never
 * runs at all, so a misconfigured `excludedLabels`/`labelsFor` pair (or a
 * missing `flatDependenciesFor`) would otherwise pass this function
 * silently, returning `{ verdicts: Map(), ambiguousIds: [] }` as if nothing
 * were wrong — the same "surface it, don't let it hide" purpose Ruling R14
 * already established for `ambiguousIds` itself, applied here to caller
 * misconfiguration instead of board data.
 */
export function readySet(state: BoardState, options: IsReadyOptions): ReadySetResult {
  assertIsReadyOptionsValid(options, "readySet");

  const verdicts = new Map<TicketId, ReadinessVerdict>();
  for (const ticket of state.tickets) {
    verdicts.set(ticket.id, isReady(state, ticket.id, options));
  }
  return { verdicts, ambiguousIds: state.duplicateTicketIds };
}
