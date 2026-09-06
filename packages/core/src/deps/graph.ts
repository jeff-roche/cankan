/**
 * `deps/graph.ts` — M2.11's dependency graph: typed `cankan.deps` edges plus
 * Backlog.md's flat `dependencies`, merged into one graph, cycle detection on
 * a *proposed* edge, and a `blockers(id)` query over that graph.
 *
 * ## Why flat `dependencies` is resolved here at all (Ruling R1)
 *
 * `state/queries.ts::blockedBy` reads `TicketState.deps` (the `cankan.deps`
 * block) only — nothing in `state/` ever looks at Backlog.md's flat
 * frontmatter `dependencies` field, because `TicketState` doesn't carry it
 * (see `ready.ts`'s file comment and Ruling R6 for the full reasoning).
 * ADR 0002 decision point 3: **`backlog task edit` deletes the entire
 * `cankan:` block on any edit**, regardless of which field changed. So for
 * any ticket a Backlog.md user has touched since it last had a `cankan.deps`
 * entry, the flat `dependencies` array is the *only* dependency data left —
 * treating it as absent would make that ticket look unblocked, which is the
 * wrong direction to fail. This module resolves it directly.
 *
 * ## Tier 1 only, and why (Ruling R1)
 *
 * A flat dependency id is resolved by **exact match against a ticket's own
 * `id`, case-insensitively** — never through `display_id`,
 * `frontmatterAliases` or `eventAliases`. `state/queries.ts`'s
 * `buildIdentifierIndex` is the tiered (id → displayId → frontmatterAliases →
 * eventAliases) resolver that does follow those, and it exists specifically
 * to defend against a hostile `alias` event silently overwriting a more
 * authoritative tier (Ruling I1, security review). Reimplementing that
 * tiering here — even faithfully — would be a second, subtly different copy
 * of a security-sensitive function; `id` is the one tier no attacker with
 * only coordination-ref push access can write, which is exactly why flat
 * deps are resolved through it alone. `resolveTier1` below is the one place
 * that resolution happens in this module; `ready.ts` calls the same function
 * for the same reason rather than growing its own copy.
 *
 * An id that matches no ticket's own `id` — including a `<repo>:<id>`
 * cross-board reference (CONCEPT.md §6c), which this single-board resolver
 * has no data to resolve — is reported as **unresolved**, not dropped. Every
 * caller in this module (`blockers` below, and `ready.ts`'s flat-dependency
 * check) treats "unresolved" as "still outstanding," the same fail-closed
 * direction `state/queries.ts::blockedBy` already takes for its own
 * unresolved ids.
 *
 * ## One edge, not two, for the same target (Ruling R1's worked example)
 *
 * CONCEPT.md's own worked ticket carries both forms naming the same target
 * (`dependencies: [ck-2b1e44]` and `deps: [{type: blocks, id: ck-2b1e44}]`).
 * A flat `dependencies` entry is semantically a `blocks` edge, so
 * `buildGraph` below de-duplicates per node by the **resolved** target when
 * one exists (falling back to the normalized raw id when neither form
 * resolves) — same-type edges naming the same target collapse to one,
 * different targets stay separate.
 *
 * ## Cycle detection is per-type, and only for `blocks`/`parent-child` (Ruling R4)
 *
 * CONCEPT.md:170 says "Cycle detection on `dep add`" without qualifying
 * which of the four types (`blocks`, `parent-child`, `related`,
 * `discovered-from`). Only two of the four express an ordering or
 * containment constraint a cycle can actually corrupt:
 *
 * - `related` is symmetric by nature — A related B and B related A is a
 *   normal, non-cyclic fact, not a defect.
 * - `discovered-from` is a provenance record ("I found this while working on
 *   that"), not an ordering constraint at all.
 * - `blocks` (must-finish-before) and `parent-child` (containment) are the
 *   only two where a cycle is actually incoherent.
 *
 * So `wouldCreateCycle` runs its walk **per type**, over `blocks` and
 * `parent-child` edges separately: a `blocks` edge and a `parent-child` edge
 * between the same pair of tickets is not a cycle, and proposing a `related`
 * or `discovered-from` edge is never refused for cycling, full stop — the
 * check short-circuits to `false` before doing any walk for those two types.
 *
 * The check is on the **proposed** edge only (`dep add` time). Cycles
 * already present in stored data are `state/fold.ts`'s problem, and its own
 * alias-graph walk already terminates safely on them (Ruling R14 there) —
 * this module does not add cycle handling to `state/`.
 *
 * A cross-board `<repo>:<id>` target can never be the far end of a cycle
 * this graph can see: `resolveTier1` always resolves it to `undefined` (a
 * leaf), and the walk below only ever follows a same-type edge whose `to` is
 * resolved.
 */

import type { TicketId } from "../types";

/** The four dependency types CONCEPT.md §6 names, matching beads' vocabulary. */
export type DependencyEdgeType = "blocks" | "parent-child" | "related" | "discovered-from";

/**
 * The two types that express an ordering/containment constraint a cycle can
 * corrupt (Ruling R4). `related` and `discovered-from` are deliberately
 * absent — see this file's own header.
 */
const ORDERING_EDGE_TYPES: ReadonlySet<string> = new Set<DependencyEdgeType>(["blocks", "parent-child"]);

/**
 * One `cankan.deps[]` entry's shape, structurally — matches
 * `state/fold.ts`'s `TicketState.deps` element type (which also carries
 * whatever extra fields zod's `.passthrough()` preserved) without importing
 * `ticket/schema.ts`'s `CankanBlock` (outside this module's `Depends on`).
 */
export interface TypedDependencyInput {
  readonly type: string;
  readonly id: string;
}

/**
 * One node's input to `buildGraph`. `TicketState` (from `state/index.ts`) is
 * structurally assignable here for the `id`/`closed`/`deps` fields — the
 * same "structural input type" pattern `state/fold.ts`'s own contract 2
 * (`leaseTtlMs` always a caller argument) established — but `dependencies`
 * (Backlog.md's flat frontmatter field) is never on `TicketState` (Ruling
 * R6: it lives on `TicketFrontmatter` in `ticket/`, which this module may
 * not import), so the caller supplies it, defaulting to none.
 */
export interface DependencyGraphNode {
  readonly id: TicketId;
  readonly closed: boolean;
  readonly deps: readonly TypedDependencyInput[];
  /** Backlog.md's flat `dependencies` (Ruling R1) — caller-supplied, `[]` when absent. */
  readonly dependencies?: readonly string[];
}

/**
 * One edge in the merged graph. `rawId` is exactly as declared (the typed
 * dep's `id`, or the flat `dependencies` entry) — never normalized, so a
 * caller can show the user what they actually typed, mirroring
 * `state/queries.ts`'s `BlockingDependency.rawId`. `to` is `undefined` when
 * `resolveTier1` could not resolve it (including a cross-board ref) — an
 * unresolved edge is still a real edge, reported rather than dropped.
 */
export interface DependencyEdge {
  readonly from: TicketId;
  readonly type: string;
  readonly rawId: string;
  readonly to: TicketId | undefined;
}

/**
 * The merged graph `buildGraph` produces. Deliberately opaque beyond
 * `edges` — `nodesByKey` is this file's own implementation detail (needed by
 * `blockers`/`wouldCreateCycle` to look up a target's `closed` status and to
 * walk existing edges), not something a caller should build against
 * directly.
 */
export interface DependencyGraph {
  readonly edges: readonly DependencyEdge[];
  readonly nodesByKey: ReadonlyMap<string, DependencyGraphNode>;
}

/**
 * Identical semantics to `store/index.ts`'s (re-exported from `ticket/id.ts`)
 * `normalizeTicketIdForComparison` — exactly `id.toLowerCase()` — declared
 * again here because this module's `Depends on` is `state/` (#31) alone
 * (PLAN.md rule 2): `normalizeTicketIdForComparison` lives in `ticket/id.ts`
 * and is re-exported by `store/index.ts`, but `state/index.ts` does not
 * re-export it, so it is unreachable from here without an out-of-bounds
 * import. **The two must never be allowed to diverge** — this is exactly
 * `id.toLowerCase()`, nothing more (no trimming, no unicode folding, no
 * prefix stripping): any divergence from `state/`'s own resolution is itself
 * the failure mode Ruling R5 exists to prevent, not a hardening opportunity.
 */
export function normalizeDependencyId(id: string): string {
  return id.toLowerCase();
}

/** Indexes `items` by `normalizeDependencyId(item.id)` — the one lookup structure both `buildGraph` and `ready.ts` build over a ticket list. */
export function indexById<T extends { readonly id: TicketId }>(items: readonly T[]): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(normalizeDependencyId(item.id), item);
  }
  return map;
}

/**
 * Resolves a raw dependency id — from either a typed `cankan.deps[].id` or a
 * flat `dependencies` entry — against `ticketsByKey`, **tier 1 only**: exact,
 * case-insensitive match on a ticket's own `id` (see this file's header for
 * why no other tier is followed here). A `<repo>:<id>` cross-board reference
 * (CONCEPT.md §6c, contains `:`) is a leaf this resolver cannot follow and
 * always resolves to `undefined`, exactly like an id matching no known
 * ticket — both are "unresolved," never distinguished, because both are
 * handled identically by every caller (fail closed, report as outstanding).
 *
 * The **one** tier-1 resolver in this module — `buildGraph`'s edge
 * resolution and `ready.ts`'s flat-dependency check both call this rather
 * than each growing its own copy, for the same reason `normalizeDependencyId`
 * above must not diverge from `state/`'s resolution (Ruling R5's discipline
 * applied to this function too).
 */
export function resolveTier1<T extends { readonly id: TicketId }>(
  rawId: string,
  ticketsByKey: ReadonlyMap<string, T>,
): T | undefined {
  if (rawId.includes(":")) {
    return undefined;
  }
  return ticketsByKey.get(normalizeDependencyId(rawId));
}

/** The de-duplication key for one node's outgoing edge of a given `type`: the resolved target's normalized id when resolvable, else the raw id's normalized form (Ruling R1's worked example — same target via either form is one edge). */
function edgeDedupeKey(type: string, rawId: string, to: TicketId | undefined): string {
  return `${type}:${to !== undefined ? normalizeDependencyId(to) : normalizeDependencyId(rawId)}`;
}

/**
 * Merges every node's typed `cankan.deps` entries and flat `dependencies`
 * into one graph. A flat `dependencies` entry always becomes a `"blocks"`
 * edge (Ruling R1). Both forms are resolved identically, tier 1 only, via
 * `resolveTier1` — this function does not treat typed deps any more
 * favorably than flat ones for resolution purposes; the difference in how
 * *readiness* treats them (typed deps additionally go through
 * `state/queries.ts::blockedBy`'s fuller, alias-aware resolution) is
 * `ready.ts`'s concern, not this graph's.
 */
export function buildGraph(nodes: readonly DependencyGraphNode[]): DependencyGraph {
  const nodesByKey = indexById(nodes);
  const edges: DependencyEdge[] = [];

  for (const node of nodes) {
    const seen = new Set<string>();

    const addEdge = (type: string, rawId: string): void => {
      const to = resolveTier1(rawId, nodesByKey)?.id;
      const key = edgeDedupeKey(type, rawId, to);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      edges.push({ from: node.id, type, rawId, to });
    };

    for (const dep of node.deps) {
      addEdge(dep.type, dep.id);
    }
    for (const flatId of node.dependencies ?? []) {
      addEdge("blocks", flatId);
    }
  }

  return { edges, nodesByKey };
}

/**
 * Every currently-outstanding `"blocks"`-type edge declared by `id`, per
 * this graph's own tier-1 resolution: an edge whose target is unresolved
 * (fails closed — see this file's header) or resolved-but-not-`closed`.
 * Ignores every other edge type — `blockers` is specifically the readiness
 * gate's dependency, mirroring `state/queries.ts::blockedBy`'s own
 * "`blocks` only" scope.
 *
 * **Narrower than `state/queries.ts::blockedBy` for a typed dep that only
 * resolves via `display_id` or an alias** — this graph never follows those
 * tiers (Ruling R1). `ready.ts`'s `isReady` accounts for this by calling
 * `blockedBy` directly for the typed half rather than relying on this
 * function for it; `blockers` here is a general graph query (useful for a
 * future `dep list`-style command), not the readiness gate itself.
 */
export function blockers(graph: DependencyGraph, id: TicketId): readonly DependencyEdge[] {
  const key = normalizeDependencyId(id);
  return graph.edges.filter((edge) => {
    if (edge.type !== "blocks" || normalizeDependencyId(edge.from) !== key) {
      return false;
    }
    if (edge.to === undefined) {
      return true;
    }
    const target = graph.nodesByKey.get(normalizeDependencyId(edge.to));
    return target === undefined || !target.closed;
  });
}

/**
 * Would adding a `type` edge from `from` to `to` close a cycle? Only
 * `"blocks"` and `"parent-child"` are ever checked (Ruling R4) — every other
 * type returns `false` immediately, never refused for cycling. A self-loop
 * (`from` and `to` naming the same ticket, tier 1) is trivially a cycle.
 * Otherwise: walk the existing same-type, resolved edges starting at `to`;
 * if that walk can already reach `from`, the proposed edge would close the
 * loop.
 */
export function wouldCreateCycle(
  graph: DependencyGraph,
  from: TicketId,
  type: DependencyEdgeType,
  to: TicketId,
): boolean {
  if (!ORDERING_EDGE_TYPES.has(type)) {
    return false;
  }

  const fromKey = normalizeDependencyId(from);
  const toKey = normalizeDependencyId(to);
  if (fromKey === toKey) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type !== type || edge.to === undefined) {
      continue;
    }
    const a = normalizeDependencyId(edge.from);
    const b = normalizeDependencyId(edge.to);
    const bucket = adjacency.get(a);
    if (bucket === undefined) {
      adjacency.set(a, [b]);
    } else {
      bucket.push(b);
    }
  }

  const visited = new Set<string>();
  const stack: string[] = [toKey];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === fromKey) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        stack.push(next);
      }
    }
  }
  return false;
}
