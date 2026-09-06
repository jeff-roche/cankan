import { describe, expect, test } from "bun:test";
import { readySet } from "../../src/deps/ready";
import { foldState } from "../../src/state/fold";
import type { TicketId } from "../../src/types";
import { makeStoredTicket } from "../state/testHelpers";

/**
 * Ruling R8 — measure `readySet`'s hot path, do not optimize it inside
 * `deps/`. `state/queries.ts::blockedBy` rebuilds its identifier index from
 * scratch on every call (O(t) per call), and `readySet` calls it once per
 * ticket (via `isReady`) — O(t²) across a whole-board sweep. This test
 * builds a 3000-ticket board where EVERY ticket carries both a typed
 * `blocks` dep (exercises `blockedBy`'s hot path) and a flat `dependencies`
 * entry (exercises `ready.ts`'s own tier-1 resolution, a second O(t)-per-call
 * cost layered on top), so the measured number reflects both, not just one.
 *
 * `foldState` runs once, OUTSIDE the timed region — only `readySet` itself
 * is measured. The ceiling asserted below is deliberately very loose (an
 * order of magnitude above the worst locally-measured run) so this never
 * flakes under CI load or the sibling lanes running `bun test` concurrently
 * on this same machine (brief's own explicit constraint) — it is a "did this
 * regress catastrophically" tripwire, not a performance gate.
 */
describe("R8 — readySet sweep, measured", () => {
  test("3000 tickets, each with a typed blocks dep and a flat dependency", () => {
    const TICKET_COUNT = 3000;
    const idFor = (i: number): string => `ck-${i.toString().padStart(5, "0")}`;

    const tickets = Array.from({ length: TICKET_COUNT }, (_, i) => {
      const blocksTarget = idFor((i + 1) % TICKET_COUNT);
      return makeStoredTicket(idFor(i), "To Do", {
        cankan: { deps: [{ type: "blocks", id: blocksTarget }] },
      });
    });

    const state = foldState(tickets, [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const flatDependenciesFor = (id: TicketId): readonly string[] => {
      const match = /ck-(\d+)/.exec(id);
      if (match === null) return [];
      const i = Number(match[1]);
      return [idFor((i + 2) % TICKET_COUNT)];
    };

    const startMs = performance.now();
    const sweep = readySet(state, { flatDependenciesFor });
    const elapsedMs = performance.now() - startMs;

    // R8's own sanctioned exception to "no stray logging" — the brief
    // requires the measured number to be visible, not silently asserted.
    console.log(`[R8 benchmark] readySet over ${TICKET_COUNT} tickets: ${elapsedMs.toFixed(1)}ms`);

    expect(sweep.size).toBe(TICKET_COUNT);
    // Every ticket has both an outstanding typed blocker and an outstanding
    // flat one naming a DIFFERENT target (i+1 vs i+2) — never ready.
    for (const verdict of sweep.values()) {
      expect(verdict.ready).toBe(false);
    }

    // Very loose ceiling (R8: measure, don't estimate — this is a tripwire,
    // not a performance target). See this file's own comment.
    expect(elapsedMs).toBeLessThan(15_000);
  });
});
