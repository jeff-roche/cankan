import { describe, expect, test } from "bun:test";
import {
  blockers,
  buildGraph,
  type CycleCheckResult,
  type DependencyGraphNode,
  normalizeDependencyId,
  resolveTier1,
  wouldCreateCycle,
} from "../../src/deps/graph";
import type { TicketId } from "../../src/types";

/** `wouldCreateCycle` returns a `CycleCheckResult` (Ruling R27), never a bare boolean — this is the one place every test in this file reads `.refused`. */
function refused(result: CycleCheckResult): boolean {
  return result.refused;
}

function node(
  id: string,
  overrides: Partial<Omit<DependencyGraphNode, "id">> = {},
): DependencyGraphNode {
  return {
    id: id as TicketId,
    closed: overrides.closed ?? false,
    deps: overrides.deps ?? [],
    ...(overrides.dependencies !== undefined ? { dependencies: overrides.dependencies } : {}),
  };
}

describe("normalizeDependencyId", () => {
  test("is exactly id.toLowerCase() — must never diverge from state/'s normalizeTicketIdForComparison (Ruling R5)", () => {
    expect(normalizeDependencyId("CK-A1B2C3")).toBe("ck-a1b2c3");
    expect(normalizeDependencyId("TASK-9")).toBe("task-9");
  });
});

describe("resolveTier1", () => {
  test("resolves only by exact own-id match, never a look-alike", () => {
    const byKey = new Map([["ck-1", { id: "ck-1" as TicketId }]]);
    expect(resolveTier1("CK-1", byKey)?.id).toBe("ck-1" as TicketId);
    expect(resolveTier1("ck-2", byKey)).toBeUndefined();
  });

  test("a <repo>:<id> cross-board ref (CONCEPT.md §6c) is always a leaf, never resolved", () => {
    const byKey = new Map([["api:ck-1", { id: "api:ck-1" as TicketId }]]);
    expect(resolveTier1("api:ck-1", byKey)).toBeUndefined();
  });
});

describe("buildGraph — Ruling R1's worked example (one ticket, both forms)", () => {
  test("typed and flat naming the SAME target collapse to one edge", () => {
    const target = node("ck-2b1e44");
    const source = node("ck-1", {
      deps: [{ type: "blocks", id: "ck-2b1e44" }],
      dependencies: ["ck-2b1e44"],
    });
    const graph = buildGraph([source, target]);

    const fromSource = graph.edges.filter((e) => e.from === source.id);
    expect(fromSource).toHaveLength(1);
    expect(fromSource[0]?.type).toBe("blocks");
    expect(fromSource[0]?.to).toBe(target.id);
  });

  test("typed and flat naming DIFFERENT targets produce both edges", () => {
    const a = node("ck-a");
    const b = node("ck-b");
    const source = node("ck-1", {
      deps: [{ type: "blocks", id: "ck-a" }],
      dependencies: ["ck-b"],
    });
    const graph = buildGraph([source, a, b]);

    const fromSource = graph.edges.filter((e) => e.from === source.id);
    expect(fromSource).toHaveLength(2);
    expect((fromSource.map((e) => e.to) as string[]).sort()).toEqual(["ck-a", "ck-b"]);
  });

  test("a blocks edge and a parent-child edge between the same pair are two distinct edges, not a dedup collision", () => {
    const target = node("ck-2");
    const source = node("ck-1", {
      deps: [
        { type: "blocks", id: "ck-2" },
        { type: "parent-child", id: "ck-2" },
      ],
    });
    const graph = buildGraph([source, target]);

    const fromSource = graph.edges.filter((e) => e.from === source.id);
    expect(fromSource).toHaveLength(2);
    expect(fromSource.map((e) => e.type).sort()).toEqual(["blocks", "parent-child"]);
  });

  test("a flat-only dependency with no cankan: block at all still becomes a blocks edge (the post-`backlog task edit` shape)", () => {
    const target = node("ck-2", { closed: false });
    const source = node("ck-1", { dependencies: ["ck-2"] }); // no `deps` at all
    const graph = buildGraph([source, target]);

    expect(graph.edges).toEqual([{ from: source.id, type: "blocks", rawId: "ck-2", to: target.id }]);
  });

  test("a flat dependency naming an id that matches no ticket is an unresolved edge, not dropped", () => {
    const source = node("ck-1", { dependencies: ["ck-does-not-exist"] });
    const graph = buildGraph([source]);

    expect(graph.edges).toEqual([{ from: source.id, type: "blocks", rawId: "ck-does-not-exist", to: undefined }]);
  });
});

describe("blockers", () => {
  test("reports a flat-sourced outstanding blocker on an open target", () => {
    const open = node("ck-2", { closed: false });
    const source = node("ck-1", { dependencies: ["ck-2"] });
    const graph = buildGraph([source, open]);

    const result = blockers(graph, source.id);
    expect(result).toHaveLength(1);
    expect(result[0]?.rawId).toBe("ck-2");
  });

  test("reports a typed-sourced outstanding blocker on an open target", () => {
    const open = node("ck-2", { closed: false });
    const source = node("ck-1", { deps: [{ type: "blocks", id: "ck-2" }] });
    const graph = buildGraph([source, open]);

    expect(blockers(graph, source.id)).toHaveLength(1);
  });

  test("excludes a blocker whose target is closed", () => {
    const closed = node("ck-2", { closed: true });
    const source = node("ck-1", { deps: [{ type: "blocks", id: "ck-2" }] });
    const graph = buildGraph([source, closed]);

    expect(blockers(graph, source.id)).toEqual([]);
  });

  test("excludes non-blocks edges (related/parent-child/discovered-from never gate)", () => {
    const other = node("ck-2", { closed: false });
    const source = node("ck-1", {
      deps: [
        { type: "related", id: "ck-2" },
        { type: "parent-child", id: "ck-2" },
        { type: "discovered-from", id: "ck-2" },
      ],
    });
    const graph = buildGraph([source, other]);

    expect(blockers(graph, source.id)).toEqual([]);
  });

  test("an unresolvable id is reported as outstanding, never dropped (fail closed)", () => {
    const source = node("ck-1", { deps: [{ type: "blocks", id: "ck-nope" }] });
    const graph = buildGraph([source]);

    const result = blockers(graph, source.id);
    expect(result).toHaveLength(1);
    expect(result[0]?.to).toBeUndefined();
  });
});

describe("wouldCreateCycle — Ruling R4", () => {
  test("refuses a blocks cycle: a already blocks b, proposing b blocks a", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    const result = wouldCreateCycle(graph, b.id, "blocks", a.id);
    expect(result).toEqual({ refused: true, reason: "cycle" });
  });

  test("refuses a parent-child cycle, checked separately from blocks", () => {
    const a = node("ck-a", { deps: [{ type: "parent-child", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    expect(wouldCreateCycle(graph, b.id, "parent-child", a.id)).toEqual({ refused: true, reason: "cycle" });
  });

  test("a blocks edge and a parent-child edge between the same pair are NOT a cycle for either type", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    // Proposing the reverse as parent-child does not see the existing blocks edge.
    expect(refused(wouldCreateCycle(graph, b.id, "parent-child", a.id))).toBe(false);
  });

  test("a longer blocks chain (a->b->c) refuses closing c->a", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b", { deps: [{ type: "blocks", id: "ck-c" }] });
    const c = node("ck-c");
    const graph = buildGraph([a, b, c]);

    expect(wouldCreateCycle(graph, c.id, "blocks", a.id)).toEqual({ refused: true, reason: "cycle" });
  });

  test("a proposed edge that does not close any loop is not refused", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b");
    const c = node("ck-c");
    const graph = buildGraph([a, b, c]);

    expect(refused(wouldCreateCycle(graph, a.id, "blocks", c.id))).toBe(false);
  });

  test("a self-loop is always a cycle", () => {
    const a = node("ck-a");
    const graph = buildGraph([a]);

    expect(wouldCreateCycle(graph, a.id, "blocks", a.id)).toEqual({ refused: true, reason: "cycle" });
  });

  test("related and discovered-from are NEVER refused for cycling, even when they would close a loop", () => {
    const a = node("ck-a", { deps: [{ type: "related", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    expect(wouldCreateCycle(graph, b.id, "related", a.id)).toEqual({ refused: false });
    expect(wouldCreateCycle(graph, b.id, "discovered-from", a.id)).toEqual({ refused: false });
    // Even a self-loop is fine for these two types.
    expect(wouldCreateCycle(graph, a.id, "related", a.id)).toEqual({ refused: false });
  });

  test("an unresolvable target is a leaf — never the far end of a cycle this graph can see", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] }); // ck-b has no node at all
    const graph = buildGraph([a]);

    expect(refused(wouldCreateCycle(graph, "ck-b" as TicketId, "blocks", a.id))).toBe(false);
  });

  test("a cross-board <repo>:<id> target is a leaf, never the far end of a cycle", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "api:ck-a" }] });
    const graph = buildGraph([a]);

    expect(refused(wouldCreateCycle(graph, "api:ck-a" as TicketId, "blocks", a.id))).toBe(false);
  });
});

describe("Ruling R27 (fix round 2) — wouldCreateCycle returns a discriminated result, never a bare boolean", () => {
  test("related/discovered-from short-circuit BEFORE the ambiguous-endpoint check, returning refused:false even when an endpoint IS a collided id", () => {
    const a: DependencyGraphNode = { id: "a" as TicketId, closed: false, deps: [] };
    const aUpper: DependencyGraphNode = { id: "A" as TicketId, closed: false, deps: [] };
    const c: DependencyGraphNode = { id: "c" as TicketId, closed: false, deps: [] };
    const graph = buildGraph([a, aUpper, c]);

    expect(graph.collidedIds).toEqual(["a"]);
    expect(wouldCreateCycle(graph, "a" as TicketId, "related", c.id)).toEqual({ refused: false });
    expect(wouldCreateCycle(graph, "a" as TicketId, "discovered-from", c.id)).toEqual({ refused: false });
  });
});

describe("Ruling R26 (fix round 2) — an ambiguous id INTERIOR to the walk severs it, and must refuse, not just at the two proposed endpoints", () => {
  // Mirrors fixcheck.ts's own "interior collider" case, and regress-interior.ts's
  // proof that fix round 1's endpoint-only guard let this cycle-creating add
  // through: a chain a->b->c (all "blocks"), with a SECOND ticket "B" colliding
  // with "b"'s id under normalizeDependencyId. Neither proposed endpoint ("c"
  // or "a") is itself ambiguous — the collision is entirely interior.
  function chainWithInteriorCollider(type: "blocks" | "parent-child") {
    const a: DependencyGraphNode = { id: "a" as TicketId, closed: false, deps: [{ type, id: "b" }] };
    const b: DependencyGraphNode = { id: "b" as TicketId, closed: false, deps: [{ type, id: "c" }] };
    const collider: DependencyGraphNode = { id: "B" as TicketId, closed: false, deps: [] };
    const c: DependencyGraphNode = { id: "c" as TicketId, closed: false, deps: [] };
    return { a, b, collider, c, graph: buildGraph([a, b, collider, c]) };
  }

  test("blocks: proposing c->a (which would close a->b->c->a) is refused even though neither c nor a is itself ambiguous", () => {
    const { graph, a, c } = chainWithInteriorCollider("blocks");

    expect(graph.collidedIds).toEqual(["b"]);
    const result = wouldCreateCycle(graph, c.id, "blocks", a.id);
    expect(result).toEqual({ refused: true, reason: "ambiguous-interior", id: "b" });
    // `id` names the COLLIDED id ("b"), not the node whose edge was severed
    // by it — it must match an entry in collidedIds so a caller can point
    // the user at the right board id to disambiguate.
    expect(result.refused && result.reason === "ambiguous-interior" && graph.collidedIds.includes(result.id)).toBe(
      true,
    );
  });

  test("parent-child: the same interior collision refuses a parent-child add too, checked separately from blocks", () => {
    const { graph, a, c } = chainWithInteriorCollider("parent-child");

    expect(refused(wouldCreateCycle(graph, c.id, "parent-child", a.id))).toBe(true);
  });

  test("REGRESSION GUARD: without the collider, the identical chain still refuses closing c->a (proves the collider, not some other change, is what's exercised above)", () => {
    const { a, b, c } = chainWithInteriorCollider("blocks");
    const graph = buildGraph([a, b, c]); // no "B" collider this time

    expect(graph.collidedIds).toEqual([]);
    expect(wouldCreateCycle(graph, c.id, "blocks", a.id)).toEqual({ refused: true, reason: "cycle" });
  });

  test("a longer chain (a->b->c->d), collider on the THIRD node, still refuses closing d->a", () => {
    const a: DependencyGraphNode = { id: "a" as TicketId, closed: false, deps: [{ type: "blocks", id: "b" }] };
    const b: DependencyGraphNode = { id: "b" as TicketId, closed: false, deps: [{ type: "blocks", id: "c" }] };
    const c: DependencyGraphNode = { id: "c" as TicketId, closed: false, deps: [{ type: "blocks", id: "d" }] };
    const collider: DependencyGraphNode = { id: "C" as TicketId, closed: false, deps: [] };
    const d: DependencyGraphNode = { id: "d" as TicketId, closed: false, deps: [] };
    const graph = buildGraph([a, b, c, collider, d]);

    expect(graph.collidedIds).toEqual(["c"]);
    expect(wouldCreateCycle(graph, d.id, "blocks", a.id)).toEqual({
      refused: true,
      reason: "ambiguous-interior",
      id: "c",
    });
  });

  test("the three genuine-leaf cases still do NOT refuse (fixcheck.ts's must-not-refuse set) — the walk-time fix does not over-refuse unrelated leaves", () => {
    // UNKNOWN target id.
    const unknown = { graph: buildGraph([node("a", { deps: [{ type: "blocks", id: "nope" }] }), node("c")]) };
    expect(refused(wouldCreateCycle(unknown.graph, "c" as TicketId, "blocks", "a" as TicketId))).toBe(false);

    // Cross-board target.
    const crossBoard = { graph: buildGraph([node("a", { deps: [{ type: "blocks", id: "api:ck-9" }] }), node("c")]) };
    expect(refused(wouldCreateCycle(crossBoard.graph, "c" as TicketId, "blocks", "a" as TicketId))).toBe(false);

    // Empty-string dep.
    const empty = { graph: buildGraph([node("a", { deps: [{ type: "blocks", id: "" }] }), node("c")]) };
    expect(refused(wouldCreateCycle(empty.graph, "c" as TicketId, "blocks", "a" as TicketId))).toBe(false);
  });

  test("a collider on a branch the walk never reaches is NOT, by itself, refused (unrelated-branch case — the walk-time form does not over-refuse)", () => {
    const a: DependencyGraphNode = { id: "a" as TicketId, closed: false, deps: [] };
    const c: DependencyGraphNode = { id: "c" as TicketId, closed: false, deps: [{ type: "blocks", id: "q" }] };
    const q: DependencyGraphNode = { id: "q" as TicketId, closed: false, deps: [] };
    const collider: DependencyGraphNode = { id: "Q" as TicketId, closed: false, deps: [] };
    const graph = buildGraph([a, c, q, collider]);

    expect(graph.collidedIds).toEqual(["q"]);
    // Proposed edge is c->a; the walk starts at "a", which has NO out-edges at
    // all — it never reaches "c"'s branch (where the "q"/"Q" collision lives).
    expect(refused(wouldCreateCycle(graph, c.id, "blocks", a.id))).toBe(false);
  });
});

describe("Ruling R22(b) (fix round 2) — wouldCreateCycle terminates when the graph ALREADY contains a cycle, for an unrelated proposed edge", () => {
  test("a pre-existing a->b->c->a cycle does not hang the walk, and an edge unrelated to it is not refused", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b", { deps: [{ type: "blocks", id: "ck-c" }] });
    const c = node("ck-c", { deps: [{ type: "blocks", id: "ck-a" }] }); // closes the pre-existing cycle
    const d = node("ck-d"); // wholly unrelated to the cycle above
    const graph = buildGraph([a, b, c, d]);

    // The walk from "ck-a" traverses the existing cycle (a->b->c->a) and must
    // terminate via its own visited-set rather than looping forever; "ck-d"
    // is never reachable from inside that cycle, so this is correctly unrefused.
    const result = wouldCreateCycle(graph, d.id, "blocks", a.id);
    expect(result).toEqual({ refused: false });
  });
});

describe("Ruling R10 (fix round 1) — indexById/buildGraph fail closed on an id collision, in BOTH directions", () => {
  // Mirrors `attack4.ts` §K: two DISTINCT input nodes ("ck-1" open, "CK-1"
  // closed) whose ids collide under normalizeDependencyId.
  function collidingNodes(order: "open-first" | "closed-first"): DependencyGraphNode[] {
    const open: DependencyGraphNode = { id: "ck-1" as TicketId, closed: false, deps: [] };
    const closed: DependencyGraphNode = { id: "CK-1" as TicketId, closed: true, deps: [] };
    const v: DependencyGraphNode = {
      id: "v" as TicketId,
      closed: false,
      deps: [{ type: "blocks", id: "ck-1" }],
    };
    return order === "open-first" ? [open, closed, v] : [closed, open, v];
  }

  test("buildGraph reports the collided normalized id on collidedIds, and never resolves it as a target", () => {
    const graph = buildGraph(collidingNodes("open-first"));

    expect(graph.collidedIds).toEqual(["ck-1"]);
    const edge = graph.edges.find((e) => e.from === ("v" as TicketId));
    expect(edge?.to).toBeUndefined();
  });

  test("blockers() fails CLOSED on the collision — the blocker is reported outstanding, not silently satisfied", () => {
    const graph = buildGraph(collidingNodes("open-first"));

    const result = blockers(graph, "v" as TicketId);
    expect(result).toHaveLength(1);
    expect(result[0]?.to).toBeUndefined();
  });

  test("the verdict does NOT change when the input node array is reversed (array order must never decide an outcome)", () => {
    const forward = blockers(buildGraph(collidingNodes("open-first")), "v" as TicketId);
    const reversed = blockers(buildGraph(collidingNodes("closed-first")), "v" as TicketId);

    expect(forward).toEqual(reversed);
    expect(forward).toHaveLength(1); // still outstanding either way — not [] for either array order
  });

  test("wouldCreateCycle REFUSES when the proposed edge's target is an ambiguous id — never treated as a leaf", () => {
    // "b" blocks "a"; proposing "b" blocks the ambiguous "a"/"A" endpoint
    // must refuse rather than say "no cycle, proceed" just because this
    // graph cannot tell which of the two colliding tickets is meant.
    const a: DependencyGraphNode = { id: "a" as TicketId, closed: false, deps: [] };
    const aUpper: DependencyGraphNode = { id: "A" as TicketId, closed: false, deps: [] };
    const b: DependencyGraphNode = { id: "b" as TicketId, closed: false, deps: [{ type: "blocks", id: "a" }] };
    const graph = buildGraph([a, aUpper, b]);

    expect(graph.collidedIds).toEqual(["a"]);
    expect(wouldCreateCycle(graph, b.id, "blocks", a.id)).toEqual({
      refused: true,
      reason: "ambiguous-endpoint",
      id: "a",
    });
  });

  test("wouldCreateCycle REFUSES when the proposed edge's SOURCE is an ambiguous id too", () => {
    const a: DependencyGraphNode = { id: "a" as TicketId, closed: false, deps: [] };
    const aUpper: DependencyGraphNode = { id: "A" as TicketId, closed: false, deps: [] };
    const c: DependencyGraphNode = { id: "c" as TicketId, closed: false, deps: [] };
    const graph = buildGraph([a, aUpper, c]);

    expect(wouldCreateCycle(graph, "a" as TicketId, "blocks", c.id)).toEqual({
      refused: true,
      reason: "ambiguous-endpoint",
      id: "a",
    });
  });
});

describe("Ruling R13 (fix round 1) — edgeDedupeKey has no delimiter to collide on", () => {
  test("two structurally different (type, id) pairs that would collide under a naive `type + colon + id` template stay two distinct edges", () => {
    // attack2.ts §H: {type:"blocks:x", id:"y"} and {type:"blocks", id:"x:y"}
    // both templated to "blocks:x:y" pre-fix, silently dropping the second edge.
    const source = node("a", {
      deps: [
        { type: "blocks:x", id: "y" },
        { type: "blocks", id: "x:y" },
      ],
    });
    const graph = buildGraph([source]);

    expect(graph.edges).toHaveLength(2);
    // Only the real "blocks"-typed edge (id "x:y", cross-board, unresolved)
    // gates readiness — "blocks:x" is a different type and never gates.
    expect(blockers(graph, source.id)).toHaveLength(1);
  });
});
