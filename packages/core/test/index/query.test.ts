import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { closeSync, openSync, statSync, writeSync } from "node:fs";
import { openIndex, rebuildIndex } from "../../src/index/db";
import { IndexErrorCodes } from "../../src/index/errors";
import { queryBoardState, queryTickets } from "../../src/index/query";
import { reindex } from "../../src/index/reindex";
import { isCanKanError } from "../../src/errors";
import { byStatus, claimedBy } from "../../src/state/index";
import type { ActorId, TicketId } from "../../src/types";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildRichBoardState, makeLease, makeTicket, sentinelState } from "./testHelpers";

const BOARD_KEY = "query-test-board";

describe("queryTickets/queryBoardState -- INDEX_NOT_BUILT (controller addendum A1)", () => {
  test("querying a freshly opened, never-reindexed index throws INDEX_NOT_BUILT rather than answering '[]'", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true); // fresh -- nothing has reindexed it yet
        try {
          queryTickets(index, {});
          throw new Error("expected queryTickets to throw");
        } catch (error) {
          expect(isCanKanError(error)).toBe(true);
          expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.NOT_BUILT);
        }
        try {
          queryBoardState(index);
          throw new Error("expected queryBoardState to throw");
        } catch (error) {
          expect(isCanKanError(error)).toBe(true);
          expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.NOT_BUILT);
        }
      } finally {
        index.close();
      }
    });
  });

  test("after reindex(), both functions work", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({ index, state: sentinelState() });
        expect(() => queryTickets(index, {})).not.toThrow();
        expect(() => queryBoardState(index)).not.toThrow();
      } finally {
        index.close();
      }
    });
  });
});

describe("exactness -- issue #37's 'Done when': queries match the fold's own answer over the same BoardState", () => {
  test("queryBoardState(idx) toEqual the source BoardState -- all three arrays, on a fixture rich enough that this cannot pass vacuously", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state } = buildRichBoardState();
        // Controller addendum A4: assert non-empty BEFORE the equality,
        // or a `[]`-shaped fixture would make this pass for the wrong
        // reason.
        expect(state.tickets.length).toBeGreaterThan(0);
        expect(state.orphanedEvents.length).toBeGreaterThan(0);
        expect(state.duplicateTicketIds.length).toBeGreaterThan(0);
        expect(state.duplicateTicketIds[0]?.paths.length).toBeGreaterThanOrEqual(2);
        expect(new Set(state.orphanedEvents.map((o) => o.cause)).size).toBe(2);

        reindex({ index, state });
        const result = queryBoardState(index);
        expect(result).toEqual(state);
      } finally {
        index.close();
      }
    });
  });

  test("queryTickets(idx, {}) toEqual state.tickets", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state } = buildRichBoardState();
        expect(state.tickets.length).toBeGreaterThan(0);
        reindex({ index, state });
        expect(queryTickets(index, {})).toEqual(state.tickets);
      } finally {
        index.close();
      }
    });
  });

  test("every byStatus(state) bucket matches queryTickets(idx, { status: key }) exactly", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state } = buildRichBoardState();
        reindex({ index, state });

        const grouped = byStatus(state);
        expect(grouped.size).toBeGreaterThan(0); // Lesson 1: a loop over an empty map asserts nothing.

        let iterations = 0;
        for (const [status, tickets] of grouped) {
          expect(queryTickets(index, { status })).toEqual(tickets);
          iterations++;
        }
        expect(iterations).toBe(grouped.size);
      } finally {
        index.close();
      }
    });
  });

  test("every claimedBy(state) bucket matches queryTickets(idx, { actor: key }) exactly, and an expired lease is excluded from every actor result", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state, ids } = buildRichBoardState();
        reindex({ index, state });

        const grouped = claimedBy(state);
        expect(grouped.size).toBeGreaterThan(0); // Lesson 1.

        let iterations = 0;
        for (const [actor, tickets] of grouped) {
          expect(queryTickets(index, { actor })).toEqual(tickets);
          iterations++;
        }
        expect(iterations).toBe(grouped.size);

        // The fixture's expired-lease ticket's actor must never appear as
        // a key at all, and a direct query for that actor must be empty
        // -- mirroring `claimedBy`, not merely "plausible" (brief section
        // 3, assertion 4).
        expect(grouped.has(ids.expiredLeaseActor)).toBe(false);
        expect(queryTickets(index, { actor: ids.expiredLeaseActor })).toEqual([]);
      } finally {
        index.close();
      }
    });
  });
});

describe("TicketQuery filters", () => {
  async function withReindexedRichFixture<T>(fn: (index: ReturnType<typeof openIndex>, ids: ReturnType<typeof buildRichBoardState>["ids"]) => T): Promise<T> {
    return withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      const { state, ids } = buildRichBoardState();
      reindex({ index, state });
      try {
        return fn(index, ids);
      } finally {
        index.close();
      }
    });
  }

  test("status accepts a single string or an array (IN)", async () => {
    await withReindexedRichFixture((index) => {
      const single = queryTickets(index, { status: "To Do" });
      const multi = queryTickets(index, { status: ["To Do", "Done"] });
      expect(single.every((t) => t.status === "To Do")).toBe(true);
      expect(single.length).toBeGreaterThan(0);
      expect(multi.length).toBeGreaterThanOrEqual(single.length);
      expect(multi.every((t) => t.status === "To Do" || t.status === "Done")).toBe(true);
    });
  });

  test("an empty status array returns no rows, not every row", async () => {
    await withReindexedRichFixture((index) => {
      expect(queryTickets(index, { status: [] })).toEqual([]);
    });
  });

  test("closed filters on the resolved closed flag", async () => {
    await withReindexedRichFixture((index) => {
      const closed = queryTickets(index, { closed: true });
      const open = queryTickets(index, { closed: false });
      expect(closed.length).toBeGreaterThan(0);
      expect(open.length).toBeGreaterThan(0);
      expect(closed.every((t) => t.closed)).toBe(true);
      expect(open.every((t) => !t.closed)).toBe(true);
    });
  });

  test("ids does an exact, on-disk-casing match", async () => {
    await withReindexedRichFixture((index, ids) => {
      const result = queryTickets(index, { ids: [ids.plain] });
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(ids.plain);
      expect(queryTickets(index, { ids: [] })).toEqual([]);
      expect(queryTickets(index, { ids: ["no-such-id-at-all" as TicketId] })).toEqual([]);
    });
  });

  test("limit/offset page through the ordinal-preserved order", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const state = {
          tickets: [makeTicket("ck-1"), makeTicket("ck-2"), makeTicket("ck-3"), makeTicket("ck-4")],
          orphanedEvents: [],
          duplicateTicketIds: [],
        };
        reindex({ index, state });

        expect(queryTickets(index, { limit: 2 }).map((t) => String(t.id))).toEqual(["ck-1", "ck-2"]);
        expect(queryTickets(index, { limit: 2, offset: 2 }).map((t) => String(t.id))).toEqual(["ck-3", "ck-4"]);
        expect(queryTickets(index, { offset: 3 }).map((t) => String(t.id))).toEqual(["ck-4"]);
        expect(queryTickets(index, { limit: 0 }).map((t) => String(t.id))).toEqual([]);
      } finally {
        index.close();
      }
    });
  });

  test("a negative or non-integer limit/offset throws rather than doing something surprising", async () => {
    await withReindexedRichFixture((index) => {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        try {
          queryTickets(index, { limit: bad });
          throw new Error(`expected limit=${bad} to throw`);
        } catch (error) {
          expect(isCanKanError(error)).toBe(true);
          expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.INVALID_QUERY_LIMIT);
        }
        try {
          queryTickets(index, { offset: bad });
          throw new Error(`expected offset=${bad} to throw`);
        } catch (error) {
          expect(isCanKanError(error)).toBe(true);
          expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.INVALID_QUERY_OFFSET);
        }
      }
    });
  });

  test("every value is bound, never interpolated -- a status containing SQL metacharacters is treated as ordinary data", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const hostileStatus = "x'; DROP TABLE tickets; --";
        const ticket = makeTicket("ck-hostile", { status: hostileStatus, statusFromFrontmatter: hostileStatus });
        reindex({ index, state: { tickets: [ticket], orphanedEvents: [], duplicateTicketIds: [] } });

        // If interpolation were happening, this query would either throw
        // (a syntax error) or the table would already be gone. Neither
        // happens -- the string is matched as ordinary data.
        expect(queryTickets(index, { status: hostileStatus })).toHaveLength(1);
        expect(queryTickets(index, {})).toHaveLength(1); // tickets table still exists
      } finally {
        index.close();
      }
    });
  });
});

describe("queryTickets -- actor mirrors claimedBy precisely", () => {
  test("lease_expired = 0 -- a live lease is returned, an expired one for the same-shaped query is not", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const liveActor = "live-actor" as ActorId;
        const expiredActor = "expired-actor" as ActorId;
        const state = {
          tickets: [
            makeTicket("ck-live", { lease: makeLease({ actor: liveActor, expired: false }) }),
            makeTicket("ck-expired", { lease: makeLease({ actor: expiredActor, expired: true }) }),
          ],
          orphanedEvents: [],
          duplicateTicketIds: [],
        };
        reindex({ index, state });

        expect(queryTickets(index, { actor: liveActor }).map((t) => String(t.id))).toEqual(["ck-live"]);
        expect(queryTickets(index, { actor: expiredActor })).toEqual([]);
      } finally {
        index.close();
      }
    });
  });
});

/**
 * Corrupts pages holding `tickets`/`ticket_aliases`/`ticket_deps` rows
 * while leaving page 1 (the schema pragma, `cankan_meta`) intact -- the
 * exact shape the security reviewer demonstrated (fix round 1, `e4.ts`/
 * `e6.ts`): `openIndex`'s own open-time probe only ever reads page 1, so
 * it reports `rebuilt: false` for a file damaged this way.
 */
function corruptTicketPages(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, "r+");
  const junk = Buffer.alloc(4096, 0x41);
  for (let offset = 4096 * 6; offset < Math.min(size, 4096 * 14); offset += 4096) {
    writeSync(fd, junk, 0, 4096, offset);
  }
  closeSync(fd);
}

describe("queryTickets/queryBoardState -- INDEX_CORRUPT (fix round 1, S2): corruption the open-time probe cannot see", () => {
  test("a torn page holding ticket rows throws a typed INDEX_CORRUPT, never a raw SQLiteError, and the documented recovery (rebuildIndex + reindex) restores a correct, working index", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      const path = index.path;
      reindex({
        index,
        state: { tickets: Array.from({ length: 800 }, (_, i) => makeTicket(`ck-wedge-${i}`)), orphanedEvents: [], duplicateTicketIds: [] },
      });
      index.close();

      corruptTicketPages(path);

      let reopened = openIndex({ boardKey: BOARD_KEY });
      // The whole point of S2: the open-time probe cannot see this
      // damage -- it only reads page 1.
      expect(reopened.rebuilt).toBe(false);

      try {
        queryTickets(reopened);
        throw new Error("expected queryTickets to throw");
      } catch (error) {
        expect(isCanKanError(error)).toBe(true);
        expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CORRUPT);
      }
      try {
        queryBoardState(reopened);
        throw new Error("expected queryBoardState to throw");
      } catch (error) {
        expect(isCanKanError(error)).toBe(true);
        expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CORRUPT);
      }

      // The documented recovery, exercised end to end -- not just that
      // the error shape changed, but that the board is usable again.
      reopened = rebuildIndex(reopened);
      expect(reopened.rebuilt).toBe(true);
      expect(reopened.discardReason).toBe("corrupt");
      reindex({ index: reopened, state: sentinelState("ck-recovered") });
      const rows = queryTickets(reopened);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("ck-recovered" as TicketId);
      reopened.close();
    });
  });

  test("a malformed dep_json value (a JSON.parse SyntaxError) throws INDEX_CORRUPT rather than escaping raw", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({
          index,
          state: { tickets: [makeTicket("ck-1", { deps: [{ type: "blocks", id: "ck-x" }] })], orphanedEvents: [], duplicateTicketIds: [] },
        });
        // Simulates bit rot confined to this one column -- the probe has
        // no way to see this either, since it never reads `ticket_deps`.
        index.db.exec("UPDATE ticket_deps SET dep_json = 'not json at all' WHERE ticket_ordinal = 0");

        try {
          queryTickets(index);
          throw new Error("expected a throw");
        } catch (error) {
          expect(isCanKanError(error)).toBe(true);
          expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CORRUPT);
        }
      } finally {
        index.close();
      }
    });
  });
});

describe("queryTickets/queryBoardState -- INDEX_QUERY_FAILED: a non-corruption SQLite error also never escapes raw", () => {
  test("a genuine SQLITE_BUSY (a real exclusive lock held by another connection, not a synthetic error) maps to INDEX_QUERY_FAILED, not CORRUPT and not a raw SQLiteError", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({ index, state: sentinelState() });

        // A second, real connection to the same file holding an
        // EXCLUSIVE write lock -- `guardAgainstCorruption`'s fallback
        // branch (fix round 1, S2 follow-through) exists for exactly
        // this shape: a `bun:sqlite` failure that is neither
        // corruption nor this module's own typed error.
        const locker = new Database(index.path);
        locker.exec("BEGIN EXCLUSIVE");
        locker.exec("INSERT INTO cankan_meta (key, value) VALUES ('locker-row', 'x')");
        try {
          queryTickets(index);
          throw new Error("expected queryTickets to throw while the db is locked");
        } catch (error) {
          expect(isCanKanError(error)).toBe(true);
          expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.QUERY_FAILED);
          expect(isCanKanError(error) && error.code).not.toBe(IndexErrorCodes.CORRUPT);
        } finally {
          locker.exec("COMMIT");
          locker.close();
        }

        // And the index is perfectly usable again once the lock clears --
        // this was never actually corrupt.
        expect(queryTickets(index)).toHaveLength(1);
      } finally {
        index.close();
      }
    });
  });
});
