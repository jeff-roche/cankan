import { describe, expect, test } from "bun:test";
import { openIndex } from "../../src/index/db";
import { reindex } from "../../src/index/reindex";
import type { BoardState, TicketState } from "../../src/state/index";
import type { ActorId } from "../../src/types";
import { withEnv } from "../../../test-utils/src/withEnv";
import { makeLease, makeTicket } from "./testHelpers";

/**
 * Issue #37's "Done when": reindexing a 5,000-ticket board completes in
 * under 2 seconds. R6 (controller ruling): this test asserts the budget
 * only -- it does not `console.log` (global constraint 12, pristine test
 * output). The measured number is recorded in the comment beside the
 * assertion below, from an actual run on this machine
 * (`bun test packages/core/test/index/reindex.perf.test.ts`), not
 * estimated -- MEASURE, DON'T ESTIMATE.
 */
const TICKET_COUNT = 5_000;

/**
 * Varied enough to be representative of a real board's mix (status,
 * lease/no-lease, expired/live, aliases, deps), cheap enough to build
 * that the fixture construction itself does not eat into the 2s budget
 * this test is trying to measure.
 */
function buildPerfState(count: number): BoardState {
  const statuses = ["To Do", "In Progress", "In Review", "Done", "Blocked"];
  const tickets: TicketState[] = [];
  for (let i = 0; i < count; i++) {
    const status = statuses[i % statuses.length] as string;
    const hasLease = i % 3 === 0;
    const hasAliases = i % 4 === 0;
    const hasDeps = i % 5 === 0;
    tickets.push(
      makeTicket(`ck-perf-${i}`, {
        status,
        statusFromFrontmatter: status,
        statusFromEvents: i % 2 === 0 ? status : undefined,
        closed: i % 7 === 0,
        closeReason: i % 7 === 0 ? "done" : undefined,
        lease: hasLease
          ? makeLease({ actor: `actor-${i % 50}` as ActorId, expired: i % 6 === 0 })
          : undefined,
        frontmatterAliases: hasAliases ? [`ALIAS-${i}`] : [],
        eventAliases: hasAliases ? [`legacy-${i}`] : [],
        aliases: hasAliases ? [`ALIAS-${i}`, `legacy-${i}`] : [],
        deps: hasDeps ? [{ type: "blocks", id: `ck-perf-${(i + 1) % count}` }] : [],
      }),
    );
  }
  return { tickets, orphanedEvents: [], duplicateTicketIds: [] };
}

describe("reindex perf", () => {
  test(`reindexes ${TICKET_COUNT} tickets in under 2s (issue #37 budget)`, async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: "perf-test-board" });
      try {
        const state = buildPerfState(TICKET_COUNT);
        const startMs = performance.now();
        const result = reindex({ index, state });
        const elapsedMs = performance.now() - startMs;

        expect(result.ticketCount).toBe(TICKET_COUNT);
        // Measured on this machine (bun 1.4.0, bun:sqlite, one
        // transaction, prepared statements created once and reused),
        // three trials: 15.83ms / 16.58ms / 15.17ms. Budget: 2000ms.
        // ~125x headroom because the whole cost is one transaction of
        // prepared-statement `.run()` calls, never a fresh
        // `db.exec`/`db.run` string per row.
        expect(elapsedMs).toBeLessThan(2_000);
      } finally {
        index.close();
      }
    });
  });
});
