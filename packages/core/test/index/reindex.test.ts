import { describe, expect, test } from "bun:test";
import { closeSync, openSync, statSync, writeSync } from "node:fs";
import { openIndex, rebuildIndex } from "../../src/index/db";
import { IndexErrorCodes } from "../../src/index/errors";
import { reindex } from "../../src/index/reindex";
import { queryBoardState, queryTickets } from "../../src/index/query";
import { isCanKanError } from "../../src/errors";
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
  /**
   * Fix round 1, code-review Minor M4: the single-ticket-with-one-live-
   * claim fixture this test used to carry proved the round-trip only for
   * that one shape -- aliases, deps, orphaned events and duplicate ids
   * were exercised elsewhere in this file only against hand-built
   * `BoardState` literals, never against genuine `foldState` output.
   * Broadened here to carry all four, still via structural types derived
   * from `foldState`'s own signature (R1 -- see the original comment
   * this replaces).
   */
  test("a genuinely folded BoardState -- aliases, deps, an orphaned event and a duplicate id -- round-trips through reindex/query exactly", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
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
        // An event naming a ticket id no stored ticket declares --
        // `foldState`'s own orphaned-event case (Ruling R15), not
        // reproduced by this lane, only round-tripped through it.
        const ghostEvent: EventLike = {
          event: "claim",
          ts: "2026-01-01T00:00:00Z",
          id: "01BBBBBBBBBBBBBBBBBBBBBBBB" as EventLike["id"],
          actor: "dana" as ActorId,
          ticket: "ck-ghost" as TicketId,
          lease_until: "2099-01-01T00:00:00Z",
        };

        const foldedTicket: StoredTicketLike = {
          id: "ck-folded" as TicketId,
          path: "/fake/board/tickets/ck-folded.md",
          ticket: {
            frontmatter: {
              id: "ck-folded" as TicketId,
              title: "Folded via the real fold",
              status: "To Do",
              cankan: { aliases: ["TASK-1"] },
            },
            source: { raw: "---\nid: ck-folded\n---\n", path: "/fake/board/tickets/ck-folded.md" },
          },
        };

        const blockedTicket: StoredTicketLike = {
          id: "ck-blocked" as TicketId,
          path: "/fake/board/tickets/ck-blocked.md",
          ticket: {
            frontmatter: {
              id: "ck-blocked" as TicketId,
              title: "Depends on ck-folded via its alias",
              status: "To Do",
              cankan: { deps: [{ type: "blocks", id: "TASK-1" }] },
            },
            source: { raw: "---\nid: ck-blocked\n---\n", path: "/fake/board/tickets/ck-blocked.md" },
          },
        };

        // Two files declaring the same normalized id -- `foldState`'s own
        // duplicate-exclusion case (Ruling D1), again only round-tripped
        // here, not reproduced.
        const dupLower: StoredTicketLike = {
          id: "ck-dup" as TicketId,
          path: "/fake/board/tickets-a/ck-dup.md",
          ticket: {
            frontmatter: { id: "ck-dup" as TicketId, title: "Lower", status: "To Do" },
            source: { raw: "---\nid: ck-dup\n---\n", path: "/fake/board/tickets-a/ck-dup.md" },
          },
        };
        const dupUpper: StoredTicketLike = {
          id: "CK-DUP" as TicketId,
          path: "/fake/board/tickets-b/CK-DUP.md",
          ticket: {
            frontmatter: { id: "CK-DUP" as TicketId, title: "Upper", status: "Done" },
            source: { raw: "---\nid: CK-DUP\n---\n", path: "/fake/board/tickets-b/CK-DUP.md" },
          },
        };

        const eventRecords: EventRecordLike[] = [
          { event: claimEvent, month: "2026-01", line: 0, position: 0 },
          { event: ghostEvent, month: "2026-01", line: 1, position: 1 },
        ];

        const folded = foldState([foldedTicket, blockedTicket, dupLower, dupUpper], eventRecords, {
          now: 0,
          leaseTtlMs: 7_200_000,
          firstSeen: new Map([[claimEvent.id, 0]]),
        });

        // The fixture must genuinely exercise every shape this test
        // claims to, or the round-trip below would pass vacuously
        // (Lesson 1).
        expect(folded.tickets).toHaveLength(2); // the ck-dup pair is excluded
        expect(folded.tickets.find((t) => t.id === foldedTicket.id)?.lease?.actor).toBe("dana" as ActorId);
        expect(folded.tickets.find((t) => t.id === foldedTicket.id)?.lease?.expired).toBe(false);
        expect(folded.tickets.find((t) => t.id === foldedTicket.id)?.frontmatterAliases).toEqual(["TASK-1"]);
        expect(folded.tickets.find((t) => t.id === blockedTicket.id)?.deps).toEqual([{ type: "blocks", id: "TASK-1" }]);
        expect(folded.orphanedEvents.length).toBeGreaterThan(0);
        expect(folded.duplicateTicketIds).toHaveLength(1);

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

describe("reindex -- fix round 1, S2: corruption maps to INDEX_CORRUPT, not the generic INDEX_REINDEX_FAILED", () => {
  test("reindex() against a page-corrupted file throws INDEX_CORRUPT (not INDEX_REINDEX_FAILED), and rebuildIndex() + reindex() recovers it", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      const path = index.path;
      reindex({
        index,
        state: { tickets: Array.from({ length: 800 }, (_, i) => makeTicket(`ck-${i}`)), orphanedEvents: [], duplicateTicketIds: [] },
      });
      index.close();

      // Corrupt pages holding ticket rows, leaving page 1 intact -- the
      // open-time probe passes, so `reindex`'s own `DELETE FROM tickets`
      // is what first discovers the damage (security review, `e6.ts`:
      // before this fix, that `DELETE` failing was the wedge -- the only
      // remedy this module offered failed on the corruption it was
      // trying to fix).
      const size = statSync(path).size;
      const fd = openSync(path, "r+");
      const junk = Buffer.alloc(4096, 0x41);
      for (let offset = 4096 * 6; offset < Math.min(size, 4096 * 14); offset += 4096) {
        writeSync(fd, junk, 0, 4096, offset);
      }
      closeSync(fd);

      let reopened = openIndex({ boardKey: BOARD_KEY });
      expect(reopened.rebuilt).toBe(false); // the probe cannot see this damage

      try {
        reindex({ index: reopened, state: sentinelState() });
        throw new Error("expected reindex to throw");
      } catch (error) {
        expect(isCanKanError(error)).toBe(true);
        expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CORRUPT);
        expect(isCanKanError(error) && error.code).not.toBe(IndexErrorCodes.REINDEX_FAILED);
      }

      // The documented recovery: rebuildIndex(), then reindex() again --
      // exercised end to end.
      reopened = rebuildIndex(reopened);
      expect(reopened.rebuilt).toBe(true);
      expect(reopened.discardReason).toBe("corrupt");
      const result = reindex({ index: reopened, state: sentinelState("ck-recovered") });
      expect(result.ticketCount).toBe(1);
      const rows = queryTickets(reopened);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("ck-recovered" as TicketId);
      reopened.close();
    });
  });
});
