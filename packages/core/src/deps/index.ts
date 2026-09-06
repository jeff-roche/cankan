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
 * `normalizeDependencyId` and `resolveTier1` are exported because a caller
 * building `DependencyGraphNode`s or an `IsReadyOptions.flatDependenciesFor`
 * lookup may need the identical resolution this module uses internally,
 * rather than growing a second, divergent copy (Ruling R5's discipline).
 *
 * ---- readiness (`ready.ts`) ------------------------------------------------
 *
 * `isReady` — "open, unclaimed, no open blockers, not excluded by label"
 * (CONCEPT.md §4) — returns a `ReadinessVerdict`, not a bare boolean, with
 * every applicable `ReadinessBlocker` reason. `readySet` sweeps a whole
 * `BoardState`. **Read `ready.ts`'s own file comment before wiring either
 * into anything that acts automatically: the result is advisory, never
 * authoritative** — a `blocks` dependency can be permanently, silently
 * neutralized by two events pushed with coordination-ref access alone (no
 * repo access), so nothing downstream may auto-claim, auto-merge or
 * auto-advance on the strength of this result.
 *
 * ---- deliberately withheld -------------------------------------------------
 *
 * - `graph.ts`'s `edgeDedupeKey` and `ready.ts`'s `blockerDedupeKey` are
 *   private de-duplication helpers, each local to their own file — not part
 *   of the public surface.
 * - `DependencyGraph.nodesByKey` (a field on the exported `DependencyGraph`
 *   type, not a separate export) is this module's own lookup structure for
 *   `blockers`/`wouldCreateCycle`; a caller has no need to build or read it
 *   directly and should treat `DependencyGraph` as opaque beyond `edges`.
 * - This module never re-exports anything from `ticket/`, `store/`,
 *   `events/` or `git/` — its `Depends on` is `state/` (M2.8) alone
 *   (PLAN.md rule 2). `TicketId`/`ActorId` come from `../types` and are
 *   already re-exported flat from the package root; this file does not
 *   re-export them again.
 * - **Follow-up flagged for `state/`, not fixed here (Ruling R8):**
 *   `readySet`'s whole-board sweep calls `state.blockedBy` once per ticket,
 *   and `blockedBy` rebuilds its identifier index from scratch on every
 *   call — O(t²) across a sweep (measured directly, see
 *   `test/deps/readySweepBenchmark.test.ts`). Fixing this inside `deps/`
 *   would mean either reimplementing `buildIdentifierIndex` (Ruling R1
 *   forbids exactly this) or building an equivalent index of its own (the
 *   same problem under a different name) — the real fix is a batched
 *   `state/` query (e.g. `blockedByAll`) amortizing the index build across
 *   the whole sweep, which is `state/`'s to add, not this module's.
 */

export type {
  DependencyEdge,
  DependencyEdgeType,
  DependencyGraph,
  DependencyGraphNode,
  TypedDependencyInput,
} from "./graph";
export { blockers, buildGraph, indexById, normalizeDependencyId, resolveTier1, wouldCreateCycle } from "./graph";

export type { IsReadyOptions, ReadinessBlocker, ReadinessVerdict } from "./ready";
export { isReady, readySet } from "./ready";
