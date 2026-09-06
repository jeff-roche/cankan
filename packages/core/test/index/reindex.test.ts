import { describe, expect, test } from "bun:test";
import { openIndex } from "../../src/index/db";
import { reindex } from "../../src/index/reindex";
import { queryBoardState, queryTickets } from "../../src/index/query";
import { blockedBy, foldState } from "../../src/state/index";
import type { TicketState } from "../../src/state/index";
import type { ActorId, TicketId } from "../../src/types";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildRichBoardState, emptyState, makeTicket, sentinelState } from "./testHelpers";

const BOARD_KEY = "reindex-test-board";

describe("reindex", () => {
  test("returns counts matching the state it was given", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state } = buildRichBoardState();
        const result = reindex({ index, state });
        expect(result.ticketCount).toBe(state.tickets.length);
        expect(result.orphanedEventCount).toBe(state.orphanedEvents.length);
        expect(result.duplicateTicketIdCount).toBe(state.duplicateTicketIds.length);
        // The fixture itself must be non-trivial, or the counts above pass vacuously.
        expect(state.tickets.length).toBeGreaterThan(0);
        expect(state.orphanedEvents.length).toBeGreaterThan(0);
        expect(state.duplicateTicketIds.length).toBeGreaterThan(0);
      } finally {
        index.close();
      }
    });
  });

  test("a second reindex fully replaces the first -- no leftover rows from the previous state", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({ index, state: buildRichBoardState().state });
        const secondState = sentinelState("ck-only-this-one-survives");
        reindex({ index, state: secondState });

        const result = queryBoardState(index);
        expect(result.tickets.length).toBe(1);
        expect(result.tickets[0]?.id).toBe("ck-only-this-one-survives" as TicketId);
        expect(result.orphanedEvents).toEqual([]);
        expect(result.duplicateTicketIds).toEqual([]);
      } finally {
        index.close();
      }
    });
  });

  test("an empty BoardState reindexes to an empty (but built) cache", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({ index, state: emptyState() });
        expect(queryBoardState(index)).toEqual(emptyState());
        expect(queryTickets(index, {})).toEqual([]);
      } finally {
        index.close();
      }
    });
  });

  test("built_at_ms defaults to Date.now() and is overridable", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({ index, state: sentinelState(), now: 1_234_567 });
        const row = index.db.query("SELECT value FROM cankan_meta WHERE key = 'built_at_ms'").get() as {
          value: string;
        };
        expect(row.value).toBe("1234567");
      } finally {
        index.close();
      }
    });
  });

  test("validity is stored verbatim when passed, and NULL when omitted -- never interpreted (M2.15's slot)", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        reindex({ index, state: sentinelState(), validity: "some-opaque-marker" });
        const withValidity = index.db.query("SELECT value FROM cankan_meta WHERE key = 'validity'").get() as {
          value: string;
        };
        expect(withValidity.value).toBe("some-opaque-marker");

        reindex({ index, state: sentinelState() });
        const withoutValidity = index.db.query("SELECT value FROM cankan_meta WHERE key = 'validity'").get() as {
          value: string | null;
        };
        expect(withoutValidity.value).toBeNull();
      } finally {
        index.close();
      }
    });
  });
});

describe("reindex -- deps JSON round-trip", () => {
  test("an absent optional field round-trips under toEqual, not toStrictEqual (JSON.stringify drops undefined-valued keys)", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        // `note` is explicitly `undefined` here, not merely absent from
        // the object literal -- exercising exactly the gap the brief
        // flags: `JSON.stringify` drops an `undefined`-valued key
        // entirely, so the row that comes back out has no `note` key at
        // all, not a `note: undefined` key. Verified empirically (this
        // test), not assumed:
        //   JSON.parse(JSON.stringify({ type: "blocks", id: "x", note: undefined }))
        //   -> { type: "blocks", id: "x" }  (no `note` key)
        // `toEqual` treats those two shapes the same (it ignores
        // undefined-valued keys on both sides); `toStrictEqual` does not
        // and would fail this assertion. `toEqual` is the correct choice
        // here: the two shapes really are the same *value* under
        // `cankanDepSchema`'s `.passthrough()` (an optional/absent field
        // is not semantically different from one explicitly set to
        // `undefined`), so treating them as unequal would be
        // overspecifying what this cache promises to preserve.
        const depWithUndefinedKey = { type: "blocks", id: "ck-x", note: undefined } as TicketState["deps"][number];
        const ticket = makeTicket("ck-with-dep", { deps: [depWithUndefinedKey] });
        reindex({ index, state: { tickets: [ticket], orphanedEvents: [], duplicateTicketIds: [] } });

        const [result] = queryTickets(index, {});
        expect(result?.deps).toEqual([depWithUndefinedKey]);
        expect(result?.deps[0]).not.toHaveProperty("note");
      } finally {
        index.close();
      }
    });
  });

  test("a fractional-millisecond lease round-trips exactly (controller addendum A2 -- REAL columns, not INTEGER)", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state, ids } = buildRichBoardState();
        // Sanity: the fixture really does carry a fractional value, so
        // this test is not vacuously true.
        const fractionalTicket = state.tickets.find((t) => t.id === ids.fractionalLeaseTicket);
        expect(fractionalTicket?.lease?.firstSeenMs).toBe(1_700_000_000_123.5);
        expect(Number.isInteger(fractionalTicket?.lease?.firstSeenMs)).toBe(false);

        // Must not throw (a STRICT INTEGER column would reject this --
        // verified directly by the controller; this is the regression
        // test for that fact).
        reindex({ index, state });

        const results = queryTickets(index, { ids: [ids.fractionalLeaseTicket] });
        expect(results).toHaveLength(1);
        expect(results[0]?.lease?.firstSeenMs).toBe(1_700_000_000_123.5);
        expect(results[0]?.lease?.expiresAtMs).toBe(1_700_000_000_123.5 + 7_200_000);
      } finally {
        index.close();
      }
    });
  });
});

describe("reindex -- against a real foldState() call, not only hand-built BoardState literals", () => {
  test("a genuinely folded BoardState round-trips through reindex/query exactly", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        // Structural types derived from `foldState`'s own signature (R1:
        // `index/`'s tests do not import `store/`/`events/` either, even
        // though `foldState` itself needs their real types -- see
        // `testHelpers.ts`'s own comment).
        type StoredTicketLike = Parameters<typeof foldState>[0][number];
        type EventRecordLike = Parameters<typeof foldState>[1][number];
        type EventLike = EventRecordLike["event"];

        const claimEvent: EventLike = {
          event: "claim",
          ts: "2026-01-01T00:00:00Z",
          id: "01AAAAAAAAAAAAAAAAAAAAAAAA" as EventLike["id"],
          actor: "dana" as ActorId,
          ticket: "ck-folded" as TicketId,
          lease_until: "2026-01-01T02:00:00Z",
        };

        const storedTicket: StoredTicketLike = {
          id: "ck-folded" as TicketId,
          path: "/fake/board/tickets/ck-folded.md",
          ticket: {
            frontmatter: { id: "ck-folded" as TicketId, title: "Folded via the real fold", status: "To Do" },
            source: { raw: "---\nid: ck-folded\n---\n", path: "/fake/board/tickets/ck-folded.md" },
          },
        };

        const eventRecord: EventRecordLike = { event: claimEvent, month: "2026-01", line: 0, position: 0 };

        const folded = foldState([storedTicket], [eventRecord], {
          now: 0,
          leaseTtlMs: 7_200_000,
          firstSeen: new Map([[claimEvent.id, 0]]),
        });

        expect(folded.tickets).toHaveLength(1);
        expect(folded.tickets[0]?.lease?.actor).toBe("dana" as ActorId);
        expect(folded.tickets[0]?.lease?.expired).toBe(false);

        reindex({ index, state: folded });
        const roundTripped = queryBoardState(index);
        expect(roundTripped).toEqual(folded);
      } finally {
        index.close();
      }
    });
  });
});

describe("reindex -- R4: blockedBy is not reimplemented, but the deps round trip supports calling it (controller addendum A5)", () => {
  test("blockedBy(queryBoardState(idx), id) matches blockedBy(state, id) exactly, for a ticket with alias/display-id/unresolvable deps", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        const { state, ids } = buildRichBoardState();
        reindex({ index, state });

        const ticketsWithDeps = state.tickets.filter((t) => t.deps.length > 0);
        expect(ticketsWithDeps.length).toBeGreaterThan(0);

        const rebuilt = queryBoardState(index);
        let comparedCount = 0;
        for (const ticket of ticketsWithDeps) {
          const expected = blockedBy(state, ticket.id);
          const actual = blockedBy(rebuilt, ticket.id);
          expect(actual).toEqual(expected);
          comparedCount++;
        }
        expect(comparedCount).toBeGreaterThan(0);

        // And the specific shapes A5 asks for are really exercised, not
        // just "some deps happened to round-trip":
        const blocked = blockedBy(state, ids.blockedTicket);
        expect(blocked).toHaveLength(3);
        expect(blocked.find((b) => b.rawId === "TASK-1")?.resolvedTicket?.id).toBe(ids.aliasedTicket);
        expect(blocked.find((b) => b.rawId === "PROJ-99")?.resolvedTicket?.id).toBe(ids.displayIdTicket);
        expect(blocked.find((b) => b.rawId === "ck-does-not-exist-anywhere")?.resolvedTicket).toBeUndefined();
      } finally {
        index.close();
      }
    });
  });
});
