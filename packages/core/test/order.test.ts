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
