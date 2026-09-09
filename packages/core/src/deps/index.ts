/**
 * `deps/index.ts` — the public surface of M2.11 (typed + flat dependency
 * graph, cycle detection, and readiness). Follows `state/index.ts`'s /
 * `board/index.ts`'s doc-comment discipline: re-export exactly what
 * downstream lanes need, nothing else.
 *
 * ---- the merged dependency graph (`graph.ts`) ------------------------------
 *
 * `buildGraph` merges typed `cankan.deps` edges and Backlog.md's flat
 * `dependencies` into one `DependencyGraph`, resolving every raw id **tier 1
 * only** (a ticket's own `id`, case-insensitively) — see `graph.ts`'s own
 * file comment for why this module never follows `display_id` or an alias.
 * `blockers` queries that graph for a ticket's currently-outstanding
 * `"blocks"` edges. `wouldCreateCycle` checks a *proposed* edge for `dep
 * add`, per type, over `blocks`/`parent-child` only (Ruling R4) — never
 * `related`/`discovered-from`.
 *
 * **`wouldCreateCycle` returns a `CycleCheckResult`, never a bare boolean**
 * (fix round 2, Ruling R27) — `{ refused: false }`, or `{ refused: true,
 * reason: "cycle" }` / `"ambiguous-endpoint"` / `"ambiguous-interior"`
 * (the last two carrying the offending normalized `id`). A real cycle and an
 * ambiguous id are opposite facts with opposite remedies (fix the proposed
 * edge, versus disambiguate a board id first) — collapsing both into one
 * `true` would make a caller report "cycle detected" when the truth is "that
 * id is ambiguous," the same principle `state/`'s `STATE_TICKET_ID_AMBIGUOUS`
 * / `STATE_TICKET_NOT_IN_BOARD_STATE` split (M2.8) already established. It
 * refuses whenever `from` or `to` itself is one of `DependencyGraph
 * .collidedIds` (fix round 1, Ruling R10, `reason: "ambiguous-endpoint"`),
 * **and also whenever its walk passes through some other node whose
 * same-type out-edge collided** (fix round 2, Ruling R26, `reason:
 * "ambiguous-interior"`) — fix round 1 only guarded the two endpoints, which
 * left a collision *interior* to the chain being walked able to sever the
 * walk mid-chain and let a real cycle through undetected (`regress-
 * interior.ts` proves this against fix round 1's own shipped code). See
 * `graph.ts`'s file comment for the full reasoning and why the interior
 * check is walk-time, not "refuse if any collision exists anywhere."
 *
 * `normalizeDependencyId` is exported because a caller building
 * `DependencyGraphNode`s or an `IsReadyOptions.flatDependenciesFor` lookup
 * may need the identical normalization this module uses internally, rather
 * than growing a second, divergent copy (Ruling R5's discipline).
 * `indexById` and `resolveTier1` are **not** re-exported here — see
 * "deliberately withheld" below.
 *
 * ---- readiness (`ready.ts`) ------------------------------------------------
 *
 * `isReady` — "open, unclaimed, no open blockers, not excluded by label"
 * (CONCEPT.md §4) — returns a `ReadinessVerdict`, not a bare boolean, with
 * every applicable `ReadinessBlocker` reason. Its `flatDependenciesFor`
 * option is **required** (fix round 1, Ruling R11) — there is no "assume no
 * flat deps" default, because that default was itself a fail-open defect
 * (see `ready.ts`'s header). Both `isReady` and `readySet` validate
 * `options` up front — including a caller-programming-error guard on
 * `excludedLabels`/`labelsFor` — **before** doing anything with board state
 * (fix round 2, Rulings R23 and R28): `readySet` runs that validation once,
 * unconditionally, rather than relying on `isReady`'s own per-ticket call of
 * it, because an **empty** board's sweep never calls `isReady` at all (the
 * per-ticket loop body never runs), which let a misconfigured `readySet`
 * call on an empty board silently return `{ verdicts: Map(), ambiguousIds:
 * [] }` with no signal at all (Ruling R23). `isReady` given no `options`
 * argument at all — a bare-JS caller, unguarded by TypeScript — now throws
 * `DepsErrorCodes.IS_READY_OPTIONS_REQUIRED` instead of an uncoded
 * `TypeError` (Ruling R28), consistent with R11's and R15's discipline of
 * coded errors for caller misuse.
 *
 * `readySet` sweeps a whole `BoardState`, returning a `ReadySetResult`
 * (`{ verdicts, ambiguousIds }`, fix round 1, Ruling R14) rather than a bare
 * map, so a board carrying a duplicated ticket id still surfaces that fact
 * in the sweep instead of the id silently vanishing from the listing.
 * **Read `ready.ts`'s own file comment for the full reasoning (fix round
 * 3): this result is advisory and attacker-influenceable, not a security
 * boundary, and consumers MAY auto-act on it** — `claim --next` does, by
 * spec (CONCEPT.md:542). The rule that governs auto-acting: readiness must
 * never be the sole gate on an action that is not reversible; claiming
 * qualifies as reversible because release and expiry undo it. The sharp
 * edge is that a forged `close` can steer readiness until a later `reopen`
 * restores the blocker — see `ready.ts` for the full attack and the ruling.
 *
 * `DepsErrorCodes` (`./errors.ts`) — `EXCLUDED_LABELS_WITHOUT_LABELS_FOR`
 * (`isReady`/`readySet` was given a non-empty `excludedLabels` with no
 * `labelsFor` lookup to check it against), `IS_READY_OPTIONS_REQUIRED`
 * (fix round 2, Ruling R28 — `options`, or its required
 * `flatDependenciesFor`, was missing) and
 * `BLOCKED_BY_SUBJECT_LOOKUP_INVARIANT_VIOLATED` (an internal defensive
 * check, unreachable today — see `ready.ts`'s header, Ruling R15).
 *
 * ---- deliberately withheld -------------------------------------------------
 *
 * - `indexById`, `IndexedById` and `resolveTier1` (fix round 2, Ruling
 *   R21) — internal machinery, exported from `graph.ts` itself for tests
 *   (and any future in-package caller) to import by relative path, the
 *   pattern `state/fold.ts` already uses, but not re-exported from here.
 *   Neither `flatDependenciesFor` (returns raw id **strings**) nor
 *   `buildGraph` (takes `DependencyGraphNode[]`) touches `IndexedById`'s
 *   shape — the only thing that needed `resolveTier1`'s `ticketsByKey`
 *   parameter was `resolveTier1` itself, exported from here with no actual
 *   consumer outside this module. And fix round 1 made the export *worse*:
 *   `IndexedById.ambiguousKeys` is a fail-closed-**fragile** primitive — a
 *   caller must consult it correctly, every time, to stay fail-closed on any
 *   gate-like operation it builds — which is a liability a plain
 *   `ReadonlyMap` was not. `DependencyGraph.nodesByKey` — structurally the
 *   same kind of lookup, for the same reason — was already withheld one
 *   field away in this same file; this brings `indexById`/`resolveTier1` in
 *   line with that precedent instead of leaving them the odd one out.
 * - `graph.ts`'s `edgeDedupeKey` and `ready.ts`'s `blockerDedupeKey` are
 *   private de-duplication helpers, each local to their own file — not part
 *   of the public surface.
 * - `DependencyGraph.nodesByKey` (a field on the exported `DependencyGraph`
 *   type, not a separate export) is this module's own lookup structure for
 *   `blockers`/`wouldCreateCycle` — a caller has no need to build or read it
 *   directly and should treat `DependencyGraph` as opaque beyond `edges` and
 *   `collidedIds`.
 * - This module never re-exports anything from `ticket/`, `store/`,
 *   `events/` or `git/` — its `Depends on` is `state/` (M2.8) alone
 *   (PLAN.md rule 2). `TicketId`/`ActorId` come from `../types` and are
 *   already re-exported flat from the package root; this file does not
 *   re-export them again.
 * - **Follow-up flagged for `state/`, not fixed here (Ruling R8):**
 *   `readySet`'s whole-board sweep calls `state.blockedBy` once per ticket,
 *   and `blockedBy` rebuilds its identifier index from scratch on every
 *   call — O(t²) across a sweep (measured directly at ~1150 ms for 3000
 *   tickets, see `test/deps/readySweepBenchmark.test.ts` and `ready.ts`'s
 *   own `readySet` doc). Fixing this inside `deps/` would mean either
 *   reimplementing `buildIdentifierIndex` (Ruling R1 forbids exactly this)
 *   or building an equivalent index of its own (the same problem under a
 *   different name) — the real fix is a batched `state/` query (e.g.
 *   `blockedByAll`) amortizing the index build across the whole sweep,
 *   which is `state/`'s to add, not this module's.
 */

export type {
  CycleCheckResult,
  DependencyEdge,
  DependencyEdgeType,
  DependencyGraph,
  DependencyGraphNode,
  TypedDependencyInput,
} from "./graph";
export {
  blockers,
  buildGraph,
  normalizeDependencyId,
  wouldCreateCycle,
} from "./graph";

export { DepsErrorCodes } from "./errors";

export type {
  IsReadyOptions,
  ReadinessBlocker,
  ReadinessVerdict,
  ReadySetResult,
} from "./ready";
export { isReady, readySet } from "./ready";
