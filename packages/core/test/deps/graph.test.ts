import { describe, expect, test } from "bun:test";
import {
  blockers,
  buildGraph,
  type DependencyGraphNode,
  normalizeDependencyId,
  resolveTier1,
  wouldCreateCycle,
} from "../../src/deps/graph";
import type { TicketId } from "../../src/types";

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

    expect(wouldCreateCycle(graph, b.id, "blocks", a.id)).toBe(true);
  });

  test("refuses a parent-child cycle, checked separately from blocks", () => {
    const a = node("ck-a", { deps: [{ type: "parent-child", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    expect(wouldCreateCycle(graph, b.id, "parent-child", a.id)).toBe(true);
  });

  test("a blocks edge and a parent-child edge between the same pair are NOT a cycle for either type", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    // Proposing the reverse as parent-child does not see the existing blocks edge.
    expect(wouldCreateCycle(graph, b.id, "parent-child", a.id)).toBe(false);
  });

  test("a longer blocks chain (a->b->c) refuses closing c->a", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b", { deps: [{ type: "blocks", id: "ck-c" }] });
    const c = node("ck-c");
    const graph = buildGraph([a, b, c]);

    expect(wouldCreateCycle(graph, c.id, "blocks", a.id)).toBe(true);
  });

  test("a proposed edge that does not close any loop is not refused", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] });
    const b = node("ck-b");
    const c = node("ck-c");
    const graph = buildGraph([a, b, c]);

    expect(wouldCreateCycle(graph, a.id, "blocks", c.id)).toBe(false);
  });

  test("a self-loop is always a cycle", () => {
    const a = node("ck-a");
    const graph = buildGraph([a]);

    expect(wouldCreateCycle(graph, a.id, "blocks", a.id)).toBe(true);
  });

  test("related and discovered-from are NEVER refused for cycling, even when they would close a loop", () => {
    const a = node("ck-a", { deps: [{ type: "related", id: "ck-b" }] });
    const b = node("ck-b");
    const graph = buildGraph([a, b]);

    expect(wouldCreateCycle(graph, b.id, "related", a.id)).toBe(false);
    expect(wouldCreateCycle(graph, b.id, "discovered-from", a.id)).toBe(false);
    // Even a self-loop is fine for these two types.
    expect(wouldCreateCycle(graph, a.id, "related", a.id)).toBe(false);
  });

  test("an unresolvable target is a leaf — never the far end of a cycle this graph can see", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "ck-b" }] }); // ck-b has no node at all
    const graph = buildGraph([a]);

    expect(wouldCreateCycle(graph, "ck-b" as TicketId, "blocks", a.id)).toBe(false);
  });

  test("a cross-board <repo>:<id> target is a leaf, never the far end of a cycle", () => {
    const a = node("ck-a", { deps: [{ type: "blocks", id: "api:ck-a" }] });
    const graph = buildGraph([a]);

    expect(wouldCreateCycle(graph, "api:ck-a" as TicketId, "blocks", a.id)).toBe(false);
  });
});
