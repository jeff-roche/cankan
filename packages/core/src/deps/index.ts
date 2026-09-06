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
 * `related`/`discovered-from` — and additionally **refuses** whenever either
 * endpoint is one of `DependencyGraph.ambiguousIds` (fix round 1, Ruling
 * R10): two input nodes whose ids collided under `normalizeDependencyId`, so
 * this graph cannot tell which one the endpoint actually names.
 *
 * `normalizeDependencyId`, `resolveTier1` and `indexById` are exported
 * because a caller building `DependencyGraphNode`s or an
 * `IsReadyOptions.flatDependenciesFor` lookup may need the identical
 * resolution this module uses internally, rather than growing a second,
 * divergent copy (Ruling R5's discipline). `indexById` itself fails closed
 * on a same-id collision (Ruling R10) — see `graph.ts`'s own doc for
 * `IndexedById`.
 *
 * ---- readiness (`ready.ts`) ------------------------------------------------
 *
 * `isReady` — "open, unclaimed, no open blockers, not excluded by label"
 * (CONCEPT.md §4) — returns a `ReadinessVerdict`, not a bare boolean, with
 * every applicable `ReadinessBlocker` reason. Its `flatDependenciesFor`
 * option is **required** (fix round 1, Ruling R11) — there is no "assume no
 * flat deps" default, because that default was itself a fail-open defect
 * (see `ready.ts`'s header). `readySet` sweeps a whole `BoardState`,
 * returning a `ReadySetResult` (`{ verdicts, ambiguousIds }`, fix round 1,
 * Ruling R14) rather than a bare map, so a board carrying a duplicated
 * ticket id still surfaces that fact in the sweep instead of the id
 * silently vanishing from the listing. **Read `ready.ts`'s own file comment
 * before wiring either into anything that acts automatically: the result is
 * advisory, never authoritative** — a `blocks` dependency can be
 * permanently, silently neutralized by two events pushed with
 * coordination-ref access alone (no repo access), so nothing downstream may
 * auto-claim, auto-merge or auto-advance on the strength of this result.
 *
 * `DepsErrorCodes` (`./errors.ts`) — `EXCLUDED_LABELS_WITHOUT_LABELS_FOR`
 * (`isReady` was given a non-empty `excludedLabels` with no `labelsFor`
 * lookup to check it against) and
 * `BLOCKED_BY_SUBJECT_LOOKUP_INVARIANT_VIOLATED` (an internal defensive
 * check, unreachable today — see `ready.ts`'s header, Ruling R15).
 *
 * ---- deliberately withheld -------------------------------------------------
 *
 * - `graph.ts`'s `edgeDedupeKey` and `ready.ts`'s `blockerDedupeKey` are
 *   private de-duplication helpers, each local to their own file — not part
 *   of the public surface.
 * - `DependencyGraph.nodesByKey` (a field on the exported `DependencyGraph`
 *   type, not a separate export) is this module's own lookup structure for
 *   `blockers`/`wouldCreateCycle` — a caller has no need to build or read it
 *   directly and should treat `DependencyGraph` as opaque beyond `edges` and
 *   `ambiguousIds`.
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
  DependencyEdge,
  DependencyEdgeType,
  DependencyGraph,
  DependencyGraphNode,
  IndexedById,
  TypedDependencyInput,
} from "./graph";
export { blockers, buildGraph, indexById, normalizeDependencyId, resolveTier1, wouldCreateCycle } from "./graph";

export { DepsErrorCodes } from "./errors";

export type { IsReadyOptions, ReadinessBlocker, ReadinessVerdict, ReadySetResult } from "./ready";
export { isReady, readySet } from "./ready";
