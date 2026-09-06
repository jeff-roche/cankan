import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { closeSync, openSync, statSync, writeSync } from "node:fs";
import { openIndex, rebuildIndex } from "../../src/index/db";
import { IndexErrorCodes } from "../../src/index/errors";
import { queryBoardState, queryTickets } from "../../src/index/query";
import { reindex } from "../../src/index/reindex";
import { isCanKanError } from "../../src/errors";
import { byStatus, claimedBy, foldState } from "../../src/state/index";
import type { ActorId, TicketId } from "../../src/types";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildRichBoardState, makeLease, makeTicket, RICH_FIXTURE_NOW, sentinelState } from "./testHelpers";

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
        // Fix round 3: `expired` is computed at query time, not read back
        // from a stored boolean -- `RICH_FIXTURE_NOW` must be passed
        // explicitly so the recomputed value agrees with what the fixture
        // itself asserts (see that constant's own doc for why the
        // default `now` would not).
        const result = queryBoardState(index, { now: RICH_FIXTURE_NOW });
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
        // Fix round 3: see `RICH_FIXTURE_NOW`'s own doc.
        expect(queryTickets(index, { now: RICH_FIXTURE_NOW })).toEqual(state.tickets);
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
          // Fix round 3: see `RICH_FIXTURE_NOW`'s own doc.
          expect(queryTickets(index, { status, now: RICH_FIXTURE_NOW })).toEqual(tickets);
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
          // Fix round 3: see `RICH_FIXTURE_NOW`'s own doc -- the actor
          // filter itself is now query-time too, not just the returned
          // `expired` flag.
          expect(queryTickets(index, { actor, now: RICH_FIXTURE_NOW })).toEqual(tickets);
          iterations++;
        }
        expect(iterations).toBe(grouped.size);

        // The fixture's expired-lease ticket's actor must never appear as
        // a key at all, and a direct query for that actor must be empty
        // -- mirroring `claimedBy`, not merely "plausible" (brief section
        // 3, assertion 4).
        expect(grouped.has(ids.expiredLeaseActor)).toBe(false);
        expect(queryTickets(index, { actor: ids.expiredLeaseActor, now: RICH_FIXTURE_NOW })).toEqual([]);
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
  /**
   * Fix round 3: rewritten. The old version of this test gave both
   * tickets the SAME `expiresAtMs` (`makeLease()`'s shared default) and
   * relied entirely on a hand-set, mutually contradictory `expired`
   * literal to tell them apart -- exactly the frozen-boolean shape this
   * fix round closes. Against the fixed implementation that literal is
   * never read, so a fixture built that way could no longer distinguish
   * anything; it would either pass vacuously or fail for the wrong
   * reason. Rewritten so "live" and "expired" are genuinely different
   * facts about time (`expiresAtMs` on either side of one shared `now`),
   * and the fixture deliberately sets the OLD `expired` literal
   * backwards (`false` on the actually-past-expiry lease) to prove the
   * query never trusts it.
   */
  test("a live lease matches the actor filter; an otherwise-identical lease past its expiresAtMs does not, at the same query `now`", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const liveActor = "live-actor" as ActorId;
        const expiredActor = "expired-actor" as ActorId;
        const now = 1_000_000;
        const state = {
          tickets: [
            makeTicket("ck-live", {
              lease: makeLease({ actor: liveActor, firstSeenMs: now - 1_000, expiresAtMs: now + 1_000, expired: false }),
            }),
            makeTicket("ck-expired", {
              // `expired: false` here is deliberately WRONG -- see this
              // describe block's own comment. `expiresAtMs` is the only
              // fact that may decide the answer.
              lease: makeLease({ actor: expiredActor, firstSeenMs: now - 10_000, expiresAtMs: now - 1_000, expired: false }),
            }),
          ],
          orphanedEvents: [],
          duplicateTicketIds: [],
        };
        reindex({ index, state });

        expect(queryTickets(index, { actor: liveActor, now }).map((t) => String(t.id))).toEqual(["ck-live"]);
        expect(queryTickets(index, { actor: expiredActor, now })).toEqual([]);

        const all = queryTickets(index, { now });
        expect(all.find((t) => String(t.id) === "ck-live")?.lease?.expired).toBe(false);
        expect(all.find((t) => String(t.id) === "ck-expired")?.lease?.expired).toBe(true);
      } finally {
        index.close();
      }
    });
  });
});

/**
 * Fix round 3 -- the defect this whole round closes, and its mutation
 * proof. `query.ts` used to answer a LIVENESS question (is this lease
 * still held) from a value frozen into the cache at `reindex()` time. A
 * lease's expiry is a pure function of the clock, not a fact about the
 * board: it can flip from live to expired with NO event and NO change to
 * any ticket file, so a value cached at reindex time is stale the moment
 * the clock passes it, and -- unlike every other staleness this cache can
 * have -- there is nothing for an invalidation strategy to detect,
 * because the underlying data never changed. See `TicketQuery.now`'s own
 * doc for the fuller argument; these tests are the empirical proof, not
 * just an assertion of the argument.
 *
 * Modeled directly on the repro this fix round started from
 * (`scratchpad/sec/stale.ts`): reindex captured while a lease is live,
 * then queried after the SAME clock has moved past `expiresAtMs`, with
 * the board never touched in between. Every assertion below compares the
 * query's answer to a FRESH `foldState()` call at that same later `now`
 * -- not to a hand-asserted boolean -- so this proves agreement with the
 * fold, not merely "some plausible-looking flag flipped".
 */
describe("fix round 3 -- lease liveness is computed at query time, never frozen at reindex time", () => {
  type StoredTicketLike = Parameters<typeof foldState>[0][number];
  type EventRecordLike = Parameters<typeof foldState>[1][number];
  type EventLike = EventRecordLike["event"];

  function claimFixture(ticketId: string, actor: string, eventId: string) {
    const claimEvent: EventLike = {
      event: "claim",
      ts: "2026-01-01T00:00:00Z",
      id: eventId as EventLike["id"],
      actor: actor as ActorId,
      ticket: ticketId as TicketId,
      lease_until: "2026-01-01T02:00:00Z",
    };
    const ticket: StoredTicketLike = {
      id: ticketId as TicketId,
      path: `/fake/board/tickets/${ticketId}.md`,
      ticket: {
        frontmatter: { id: ticketId as TicketId, title: "T", status: "Doing" },
        source: { raw: `---\nid: ${ticketId}\n---\n`, path: `/fake/board/tickets/${ticketId}.md` },
      },
    };
    const records: EventRecordLike[] = [{ event: claimEvent, month: "2026-01", line: 0, position: 0 }];
    return { ticket, records, eventId: claimEvent.id };
  }

  test("reindexed while live, queried later past expiry with the board byte-identical -- the query agrees with a FRESH fold at that same later `now`, not with the reindex-time snapshot", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const leaseTtlMs = 60_000;
        const firstSeenMs = 1_000_000;
        const expiresAtMs = firstSeenMs + leaseTtlMs; // 1,060,000
        const actor = "alice" as ActorId;
        const { ticket, records, eventId } = claimFixture("ck-1", actor, "01AAAAAAAAAAAAAAAAAAAAAAAA");
        const firstSeen = new Map([[eventId, firstSeenMs]]);

        const liveNow = firstSeenMs + 10_000; // well inside the lease
        const liveFold = foldState([ticket], records, { now: liveNow, leaseTtlMs, firstSeen });
        expect(liveFold.tickets[0]?.lease?.expired).toBe(false); // sanity: genuinely live at reindex time

        reindex({ index, state: liveFold });

        // The board never changes between here and the query below --
        // only the clock moves, well past `expiresAtMs`.
        const afterExpiryNow = expiresAtMs + 120_000;
        const freshFold = foldState([ticket], records, { now: afterExpiryNow, leaseTtlMs, firstSeen });
        expect(freshFold.tickets[0]?.lease?.expired).toBe(true); // sanity: genuinely expired by then

        const viaIndexTickets = queryTickets(index, { now: afterExpiryNow });
        expect(viaIndexTickets).toEqual(freshFold.tickets);

        const viaIndexBoard = queryBoardState(index, { now: afterExpiryNow });
        expect(viaIndexBoard).toEqual(freshFold);

        // And the actor filter itself caught up, not just the flag on an
        // unfiltered read -- a second actor asking "is this free?" must
        // get the true answer, not the reindex-time one.
        expect(queryTickets(index, { actor, now: afterExpiryNow })).toEqual([]);
        expect(queryTickets(index, { actor, now: liveNow })).toEqual(liveFold.tickets);
      } finally {
        index.close();
      }
    });
  });

  test("the expiry boundary instant itself: now === expiresAtMs is expired (mirrors foldState's `>=`, not `>`)", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const leaseTtlMs = 60_000;
        const firstSeenMs = 1_000_000;
        const expiresAtMs = firstSeenMs + leaseTtlMs;
        const { ticket, records, eventId } = claimFixture("ck-boundary", "boundary-actor", "01BBBBBBBBBBBBBBBBBBBBBBBB");
        const firstSeen = new Map([[eventId, firstSeenMs]]);

        const fold = foldState([ticket], records, { now: firstSeenMs, leaseTtlMs, firstSeen });
        expect(fold.tickets[0]?.lease?.expiresAtMs).toBe(expiresAtMs); // sanity
        reindex({ index, state: fold });

        const oneMsEarly = queryTickets(index, { now: expiresAtMs - 1 });
        const exactBoundary = queryTickets(index, { now: expiresAtMs });

        const foldOneMsEarly = foldState([ticket], records, { now: expiresAtMs - 1, leaseTtlMs, firstSeen });
        const foldAtBoundary = foldState([ticket], records, { now: expiresAtMs, leaseTtlMs, firstSeen });

        expect(foldOneMsEarly.tickets[0]?.lease?.expired).toBe(false); // sanity
        expect(foldAtBoundary.tickets[0]?.lease?.expired).toBe(true); // sanity

        expect(oneMsEarly).toEqual(foldOneMsEarly.tickets);
        expect(exactBoundary).toEqual(foldAtBoundary.tickets);
      } finally {
        index.close();
      }
    });
  });

  test("a never-observed lease (firstSeenMs/expiresAtMs undefined) is expired regardless of `now`, and never matches an actor filter -- LeaseState.expired's own 'expired-or-unknown' rule", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const actor = "ghost-actor" as ActorId;
        const state = {
          tickets: [
            makeTicket("ck-never-observed", {
              // `expired: false` here is deliberately WRONG and
              // deliberately inconsistent with `expiresAtMs: undefined`
              // (a real fold could never produce this combination -- see
              // `foldLease`) -- this is the mutation proof for this case
              // specifically: a fixture whose stored literal says "live"
              // must still come back `expired: true`, because that
              // literal is never read. Asserting `true` against a
              // fixture that ALSO says `true` would pass against the old
              // frozen-boolean code too, proving nothing (the #97
              // mistake this fix round exists not to repeat).
              lease: makeLease({ actor, firstSeenMs: undefined, expiresAtMs: undefined, expired: false }),
            }),
          ],
          orphanedEvents: [],
          duplicateTicketIds: [],
        };
        reindex({ index, state });

        for (const now of [0, 1, 1_000_000, Date.now(), Number.MAX_SAFE_INTEGER]) {
          const [result] = queryTickets(index, { now });
          expect(result?.lease?.expired).toBe(true);
          expect(queryTickets(index, { actor, now })).toEqual([]);
        }
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
