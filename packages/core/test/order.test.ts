import { describe, expect, test } from "bun:test";
import { compareTickets, normalizeRanks, parseOrder, rankBetween, resolveQueue } from "../src/order/index";

const ticket = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra }) as { id: string; [key: string]: unknown };

describe("ordering", () => {
  test("parses order terms and compares numeric-aware ids", () => {
    const order = parseOrder("id:asc");
    const items = [ticket("ck-10"), ticket("ck-2"), ticket("ck-1")];
    expect(items.sort((a, b) => compareTickets(a, b, order)).map((item) => item.id)).toEqual(["ck-1", "ck-2", "ck-10"]);
  });

  test("every comparator has a deterministic id tie-break and seeded random order", () => {
    const order = parseOrder("random:asc");
    const a = ticket("ck-a"); const b = ticket("ck-b");
    expect(Math.sign(compareTickets(a, b, order, "seed"))).toBe(-Math.sign(compareTickets(b, a, order, "seed")));
    expect(compareTickets(a, a, order, "seed")).toBe(0);
  });

  test("supports documented backer, milestone, age, and label keys", () => {
    const order = parseOrder("label:backend,backer:asc,milestone:asc,age:asc");
    const first = ticket("ck-1", { labels: ["backend"], backer: "github", milestone: "M1", created_date: "2026-01-01" });
    const second = ticket("ck-2", { labels: [], backer: "jira", milestone: "M2", created_date: "2025-01-01" });
    expect(compareTickets(first, second, order)).toBeLessThan(0);
  });

  test("rejects malformed order terms with extra separators", () => {
    expect(() => parseOrder("id:asc:desc")).toThrow();
    expect(() => parseOrder("label:backend:asc:extra")).toThrow();
  });
});

describe("ranks", () => {
  test("places ranks before, after, and between existing values", () => {
    expect(rankBetween()).toBe(1000);
    expect(rankBetween(1000)).toBe(2000);
    expect(rankBetween(undefined, 1000)).toBe(0);
    expect(rankBetween(1000, 2000)).toBe(1500);
    expect(normalizeRanks([{ ordinal: 99 }, { ordinal: 1 }]).map((item) => item.ordinal)).toEqual([1000, 2000]);
  });
});

describe("queues", () => {
  test("selects the most specific actor-pattern queue and applies its filter", () => {
    const queue = resolveQueue({
      chores: { actors: ["codex:*"] },
      urgent: { actors: ["codex:alice"], filter: { priority: ["high"] }, order: ["priority:desc", "id:asc"] },
    }, undefined, "codex:alice");
    expect(queue?.name).toBe("urgent");
    expect(queue?.matches(ticket("ck-1", { priority: "high" }))).toBe(true);
    expect(queue?.matches(ticket("ck-2", { priority: "low" }))).toBe(false);
  });
});
