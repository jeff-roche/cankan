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
 *
 * ## Two different "unresolved," two different fail directions (Ruling R10, fix round 1)
 *
 * `indexById` below fails closed on a same-normalized-id collision between
 * two *distinct* input nodes (`ck-1` and `CK-1`, say) exactly the way
 * `state/queries.ts::buildIdentifierIndex` fails closed on a same-tier
 * collision: the colliding key is never set in `nodesByKey`, so
 * `resolveTier1` returns `undefined` for it, indistinguishable at that layer
 * from an id that names no ticket at all. `buildGraph` additionally reports
 * every such key on `DependencyGraph.collidedIds` (renamed from
 * `ambiguousIds` — fix round 2, Ruling R24 — because withholding
 * `IndexedById` from the public surface, see "deliberately withheld" below,
 * dropped a three-way name collision between this field,
 * `IndexedById.ambiguousKeys`, and `ReadySetResult.ambiguousIds` to two; this
 * is the one that still needed distinguishing, since it holds
 * `readonly string[]`, not `ReadySetResult.ambiguousIds`'s
 * `readonly DuplicateTicketId[]`), because the two facts below need
 * **opposite** handling, and a caller cannot tell them apart from
 * `resolveTier1`'s `undefined` alone:
 *
 * - **Unresolved-because-unknown** (no ticket declares this id): failing
 *   closed means treating it as **still outstanding** — `blockers()` reports
 *   it, `ready.ts` reports the ticket naming it as blocked. This is the
 *   right direction because "blocked" is safe to over-report to a human
 *   (Ruling R1's whole point).
 * - **Unresolved-because-ambiguous** (two tickets declare this id): treating
 *   it as "still outstanding" is *also* correct for `blockers()` — same
 *   fail-closed direction, nothing to change there. But `wouldCreateCycle`
 *   is not a read-only report; it gates whether `dep add` proceeds. If it
 *   treated an ambiguous endpoint as an ordinary unresolved leaf (the way
 *   `blockers()` does), it would return "no cycle, proceed" for a proposed
 *   edge that might close a real loop through whichever of the colliding
 *   tickets is the intended one. That is the *fail-open* direction this
 *   whole ruling exists to close, so `wouldCreateCycle` instead **refuses**
 *   whenever either endpoint of the proposed edge is one of `collidedIds` —
 *   it never falls through to treating an ambiguous *endpoint* as a leaf.
 *
 * `buildGraph` itself never throws on a collision — it records
 * `collidedIds` and still produces a usable graph for every other ticket,
 * mirroring `state/fold.ts`'s own partition-and-report pattern
 * (`BoardState.duplicateTicketIds`) rather than refusing the whole board
 * over one ambiguous id.
 *
 * ## R10's fix round 1 was incomplete: an ambiguous id INTERIOR to the walk
 * also needs refusing, not just at the two proposed endpoints (Ruling R26,
 * fix round 2)
 *
 * The endpoint-only check above is not enough. `wouldCreateCycle`'s walk
 * (below) follows same-type, *resolved* edges only — `indexById`'s collision
 * handling means an edge whose target collided (`to === undefined`, same as
 * an edge naming an unknown id) is invisible to that walk, exactly like a
 * genuine leaf. If the collision sits on a node *interior* to the chain
 * being walked — not one of the two ids `dep add` was actually called with —
 * fix round 1 missed it entirely: the walk simply stops at that node,
 * indistinguishable from "this branch dead-ends here, no cycle." That
 * silently **severs the walk mid-chain**, and a cycle-creating `dep add`
 * proceeds where it should have been refused — proven directly
 * (`regress-interior.ts`): a `blocks` chain `a→b→c`, with a second ticket
 * colliding with `b`'s id, and `wouldCreateCycle(c, "blocks", a)` (which
 * *would* close the loop `a→b→c→a`) flips from correctly refusing
 * pre-fix-round-1 to incorrectly proceeding post-fix-round-1, purely because
 * `indexById`'s `byKey.delete` on the collision made `b`'s edge target
 * `undefined` — indistinguishable from an edge to an unknown id, which the
 * walk always treated as a dead end.
 *
 * The fix is **walk-time**, not endpoint-only: while walking from `to`
 * looking for `from`, track every node with a same-type out-edge whose
 * target is unresolved **because it collided** (`to === undefined` *and*
 * `collidedIds.has(normalizeDependencyId(edge.rawId))` — collision, not mere
 * unknown-id, is what distinguishes "this edge's real destination is hidden
 * from us" from "this edge genuinely dead-ends here"). If the walk pops one
 * of those nodes, refuse — the edge beyond it could lead anywhere among the
 * colliding tickets, including back to `from`, and this graph has no way to
 * know which. This **deliberately over-refuses** when the ambiguous branch
 * could not actually have looped back to `from` (`fixcheck.ts`'s "collider
 * present but on an unrelated branch" case still does *not* refuse, because
 * the walk never reaches that branch at all — but a case where the walk
 * *does* reach a severed node is refused even if, with the collision
 * resolved one particular way, that branch wouldn't have closed the loop).
 * That is the fail-closed direction R10 mandates, not a defect to optimize
 * away: this graph cannot tell which of the colliding tickets the edge
 * actually names, so it cannot tell whether continuing past it is safe.
 *
 * A **naive alternative — "refuse if `collidedIds` is non-empty anywhere in
 * the graph, regardless of whether the walk ever reaches it"** — was
 * considered and rejected: it refuses the unrelated-branch case above too,
 * which is over-refusing for no safety benefit (an ambiguous id nowhere on
 * the path between `to` and `from` cannot possibly be the hidden link that
 * closes this particular loop). The walk-time form only pays that fail-closed
 * cost where the ambiguity could actually matter.
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
  /**
   * Normalized ids claimed by more than one distinct input node (Ruling
   * R10, fix round 1) — sorted for deterministic output, analogous to
   * `state/fold.ts`'s `BoardState.duplicateTicketIds`. Named `collidedIds`,
   * not `ambiguousIds` (fix round 2, Ruling R24) — see this file's header.
   * `resolveTier1` already resolves any of these to `undefined`
   * (indistinguishable from an unknown id at that layer, and `blockers()`
   * reports both the same way — still outstanding), but `wouldCreateCycle`
   * reads this field directly, both at the two proposed endpoints and at
   * every node its walk passes through (Ruling R26, fix round 2), to refuse
   * rather than treat an ambiguous id as a leaf anywhere it could hide the
   * walk's true path — see this file's header for why the two "unresolved"
   * facts need opposite handling there.
   */
  readonly collidedIds: readonly string[];
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

/** The result of `indexById` — see that function's own doc. */
export interface IndexedById<T> {
  readonly byKey: ReadonlyMap<string, T>;
  /** Normalized ids claimed by more than one distinct input item — never set on `byKey`. */
  readonly ambiguousKeys: ReadonlySet<string>;
}

/**
 * Indexes `items` by `normalizeDependencyId(item.id)` — the one lookup
 * structure both `buildGraph` and `ready.ts` build over a ticket list.
 *
 * **Fails closed on a same-key collision (Ruling R10, fix round 1).** Two
 * distinct items whose ids normalize to the same key (`ck-1` and `CK-1`,
 * say) are a conflict, not a coin flip: a plain last-write-wins `map.set`
 * in loop order would let array order silently decide which of the two
 * "wins" the key — reversing the input array would then reverse every
 * downstream verdict that depended on it, exactly the failure `attack4.ts`
 * (security review) demonstrated directly against the pre-fix version of
 * this function. Mirroring `state/queries.ts::buildIdentifierIndex`'s own
 * discipline: a collided key is **removed from `byKey`** (so `.get()`
 * returns `undefined` for it, same as an id naming no item at all) and is
 * instead recorded in `ambiguousKeys`, so a caller that needs to tell "no
 * item has this id" apart from "two items claim this id" — `buildGraph`'s
 * `wouldCreateCycle` does, see this file's header — can do so without
 * re-deriving the collision itself.
 *
 * `state/`'s own fold already excludes same-normalized-id tickets from
 * `BoardState.tickets` (`partitionByDuplicateId`) before `ready.ts` calls
 * this over `state.tickets`, so a collision there should be unreachable in
 * practice; this defends `buildGraph`'s own node list, which a caller may
 * build directly from parsed ticket files without going through the fold's
 * own dedup first (Ruling R6 — flat `dependencies`/labels are
 * caller-supplied, and so, transitively, can be the node list itself).
 */
export function indexById<T extends { readonly id: TicketId }>(items: readonly T[]): IndexedById<T> {
  const byKey = new Map<string, T>();
  const ambiguousKeys = new Set<string>();
  for (const item of items) {
    const key = normalizeDependencyId(item.id);
    if (ambiguousKeys.has(key)) {
      continue; // already known to collide -- stays unset, regardless of how many more share it
    }
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, item);
    } else if (existing !== item) {
      byKey.delete(key);
      ambiguousKeys.add(key);
    }
  }
  return { byKey, ambiguousKeys };
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

/**
 * The de-duplication key for one node's outgoing edge of a given `type`: the
 * resolved target's normalized id when resolvable, else the raw id's
 * normalized form (Ruling R1's worked example — same target via either form
 * is one edge).
 *
 * **`JSON.stringify` of a two-element tuple, not a `${type}:${target}`
 * template (Ruling R13, fix round 1).** `cankanDepSchema.type` is
 * `z.string()`, not an enum (`ticket/schema.ts:39-44`), so a delimiter-joined
 * template string is reachable through the real fold: `{type:"blocks:x",
 * id:"y"}` and `{type:"blocks", id:"x:y"}` both templated to `"blocks:x:y"`
 * and collided, silently dropping the second edge (`attack2.ts` §H,
 * verified). `JSON.stringify(["blocks:x", "y"])` and
 * `JSON.stringify(["blocks", "x:y"])` are two different strings — a JSON
 * array's own structural delimiters (quoting and escaping the two elements
 * separately) make two distinct pairs of strings produce distinct output,
 * which no single joining character can guarantee.
 */
function edgeDedupeKey(type: string, rawId: string, to: TicketId | undefined): string {
  return JSON.stringify([type, to !== undefined ? normalizeDependencyId(to) : normalizeDependencyId(rawId)]);
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
  const { byKey: nodesByKey, ambiguousKeys } = indexById(nodes);
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

  return { edges, nodesByKey, collidedIds: [...ambiguousKeys].sort() };
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
 *
 * **An edge whose target id is ambiguous (in `DependencyGraph.collidedIds`,
 * Ruling R10) is treated exactly like an edge whose target names no ticket
 * at all** — `edge.to` is `undefined` either way, and both fail closed here
 * as "still outstanding." That is deliberately the *same* handling for both
 * facts in this read-only query, even though `wouldCreateCycle` below must
 * treat them differently — see this file's header for why a report-only
 * query and a gate that decides whether an add proceeds need opposite care
 * for the same ambiguity.
 *
 * **`blockers(g, id)` where `id` itself names an AMBIGUOUS subject
 * over-reports, on purpose (Ruling R29, fix round 2, documented not fixed).**
 * `id` is matched by `normalizeDependencyId(edge.from) === normalizeDependencyId(id)`
 * — every edge whose *source* normalizes to `id`'s key, from *either*
 * colliding ticket, since `indexById`'s collision handling only ever removes
 * a colliding id from `nodesByKey` (the resolution-*target* side), never
 * filters `buildGraph`'s per-node edge emission (the resolution-*source*
 * side). So a caller asking "what blocks the ambiguous id `ck-1`" gets both
 * `ck-1`'s and `CK-1`'s outstanding blockers merged into one list, with no
 * way to tell which ticket contributed which edge. That is **fail-closed and
 * correct** — this function's whole contract is "never under-report a
 * blocker," and merging both colliders' edges can only ever add outstanding
 * blockers, never drop a real one — but it is surprising, and future work
 * must not "fix" it into filtering by one collider's edges only (that would
 * be fail-*open*: silently dropping whichever ticket's blockers got
 * filtered out, based on an arbitrary tie-break this graph has no basis for
 * making).
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
 * The result of `wouldCreateCycle` — never a bare boolean (Ruling R27, fix
 * round 2). The function refuses for two facts with **opposite remedies**:
 * a genuine cycle (the graph shape is wrong — pick a different edge) versus
 * an ambiguous id somewhere on the walk (the *board data* is wrong — go
 * disambiguate that id before retrying the same edge). Collapsing both into
 * one `true` — which fix round 1 did, permitted by that round's own ruling —
 * would make `dep add` report "cycle detected" when the truth is "that id is
 * ambiguous," the exact opposite-facts-opposite-remedies principle
 * `state/queries.ts`'s `STATE_TICKET_ID_AMBIGUOUS` /
 * `STATE_TICKET_NOT_IN_BOARD_STATE` split (M2.8) already established for
 * this codebase (see this module's own Ruling R2). Mirrors
 * `ReadinessVerdict`'s own discipline: a discriminated result is the primary
 * surface, not a boolean plus an out-of-band error.
 *
 * `id`, where present, is the **normalized** (`normalizeDependencyId`)
 * offending id a caller should tell the user to disambiguate —
 * `"ambiguous-endpoint"` names `from` or `to` itself when one of them
 * collided (prefers `from` if both did); `"ambiguous-interior"` names the
 * **collided target id** that a same-type out-edge somewhere on the walk
 * pointed at (Ruling R26) — NOT the node whose edge that was, which is not
 * itself ambiguous. Either way, `id` always matches an entry in
 * `DependencyGraph.collidedIds` exactly, so a caller can cross-reference
 * directly without re-normalizing or re-deriving which id is the actual
 * problem.
 */
export type CycleCheckResult =
  | { readonly refused: false }
  | { readonly refused: true; readonly reason: "cycle" }
  | { readonly refused: true; readonly reason: "ambiguous-endpoint"; readonly id: string }
  | { readonly refused: true; readonly reason: "ambiguous-interior"; readonly id: string };

/**
 * Would adding a `type` edge from `from` to `to` close a cycle? Only
 * `"blocks"` and `"parent-child"` are ever checked (Ruling R4) — every other
 * type is never refused for cycling, immediately. A self-loop (`from` and
 * `to` naming the same ticket, tier 1) is trivially a cycle. Otherwise: walk
 * the existing same-type, resolved edges starting at `to`; if that walk can
 * already reach `from`, the proposed edge would close the loop. See
 * `CycleCheckResult`'s own doc for why the result is a discriminated union,
 * not a boolean (Ruling R27, fix round 2).
 *
 * **Refuses at the two proposed ENDPOINTS** when either `from` or `to` is
 * one of `graph.collidedIds` (Ruling R10, fix round 1) — checked before the
 * self-loop/walk logic below. **Refuses INTERIOR to the walk too** (Ruling
 * R26, fix round 2): fix round 1 only checked the two endpoints
 * `wouldCreateCycle` was actually called with, but the walk below can pass
 * *through* a same-type edge whose target collided on some *other* node
 * along the chain — and that edge's `to` is `undefined` exactly like a leaf
 * edge to an unknown id, invisible to the walk either way. Treating a
 * collided interior node as an ordinary dead end let a real cycle through
 * undetected whenever the collision sat mid-chain rather than at an endpoint
 * (`regress-interior.ts`, fix round 2's own proof — fix round 1's endpoint-
 * only tests happened to put the collider at an endpoint every time, which
 * is why this went unnoticed).
 *
 * An ambiguous id is not an ordinary leaf in either position:
 * `blockers()` may safely treat "unresolved because ambiguous" the same as
 * "unresolved because unknown" (both fail closed to "still outstanding"
 * there), but this function decides whether an add *proceeds* — treating an
 * ambiguous id as a leaf anywhere on the walk would let a cycle-creating add
 * through simply because this graph could not tell which of the colliding
 * tickets that id actually names. See this file's header for the fuller
 * reasoning, including why the interior check is walk-time (only refusing
 * where the ambiguity is actually reachable) rather than "collidedIds
 * non-empty anywhere" (which would over-refuse unrelated adds).
 */
export function wouldCreateCycle(
  graph: DependencyGraph,
  from: TicketId,
  type: DependencyEdgeType,
  to: TicketId,
): CycleCheckResult {
  if (!ORDERING_EDGE_TYPES.has(type)) {
    return { refused: false };
  }

  const fromKey = normalizeDependencyId(from);
  const toKey = normalizeDependencyId(to);
  const collided = new Set(graph.collidedIds);

  if (collided.has(fromKey)) {
    return { refused: true, reason: "ambiguous-endpoint", id: fromKey };
  }
  if (collided.has(toKey)) {
    return { refused: true, reason: "ambiguous-endpoint", id: toKey };
  }

  if (fromKey === toKey) {
    return { refused: true, reason: "cycle" };
  }

  const adjacency = new Map<string, string[]>();
  // Nodes with a same-type out-edge that is SEVERED — unresolved because its
  // target collided, not because it names an unknown id (Ruling R26). Maps
  // the severed node's key to the COLLIDED id that severed it (not just a
  // presence flag) — that collided id is the offending id `CycleCheckResult`
  // reports, matching `graph.collidedIds`'s own normalized form exactly, so
  // a caller told "ambiguous-interior" learns which board id to disambiguate
  // rather than the unrelated node that happened to name it. The walk below
  // cannot know where a severed edge actually leads, so it must refuse
  // rather than treat the node as a dead end whenever it reaches one.
  const severed = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.type !== type) {
      continue;
    }
    const a = normalizeDependencyId(edge.from);
    if (edge.to === undefined) {
      const rawIdKey = normalizeDependencyId(edge.rawId);
      if (collided.has(rawIdKey) && !severed.has(a)) {
        severed.set(a, rawIdKey);
      }
      continue; // an ordinary unresolved (unknown-id) edge is a genuine leaf -- not added to adjacency, not severed.
    }
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
      return { refused: true, reason: "cycle" };
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const collidedTarget = severed.get(current);
    if (collidedTarget !== undefined) {
      return { refused: true, reason: "ambiguous-interior", id: collidedTarget };
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        stack.push(next);
      }
    }
  }
  return { refused: false };
}
