import { describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { StateErrorCodes } from "../../src/state/errors";
import { foldState } from "../../src/state/fold";
import { blockedBy, byStatus, claimedBy } from "../../src/state/queries";
import type { ActorId, TicketId } from "../../src/types";
import { fixtureEvent, makeStoredTicket } from "./testHelpers";

describe("byStatus", () => {
  test("groups tickets by their resolved status, not by frontmatter or event status alone", () => {
    const a = makeStoredTicket("ck-a", "To Do");
    const b = makeStoredTicket("ck-b", "To Do");
    // ck-b's resolved status is overridden by a move event to "Done" — it
    // must group under "Done", not under its frontmatter's "To Do".
    const moveB = fixtureEvent({ event: "move", ticket: "ck-b", from: "To Do", to: "Done" }, "2026-01", 0);
    const c = makeStoredTicket("ck-c", "Done");

    const state = foldState([a, b, c], [moveB], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });
    const grouped = byStatus(state);

    expect(grouped.get("To Do")?.map((t) => t.id as string)).toEqual(["ck-a"]);
    expect(
      grouped
        .get("Done")
        ?.map((t) => t.id as string)
        .sort(),
    ).toEqual(["ck-b", "ck-c"]);
  });

  test("an empty board groups nothing", () => {
    const state = foldState([], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });
    const grouped = byStatus(state);

    expect(grouped.size).toBe(0);
  });
});

describe("claimedBy", () => {
  test("excludes expired leases — CONCEPT.md §4: expired claims return to Ready", () => {
    const live = makeStoredTicket("ck-live", "To Do");
    const expired = makeStoredTicket("ck-expired", "To Do");
    const liveClaim = fixtureEvent(
      { event: "claim", ticket: "ck-live", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const expiredClaim = fixtureEvent(
      { event: "claim", ticket: "ck-expired", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      1,
    );

    const state = foldState([live, expired], [liveClaim, expiredClaim], {
      now: 100_000,
      leaseTtlMs: 1_000,
      firstSeen: new Map([
        [liveClaim.event.id, 99_500], // still within TTL at now=100_000
        [expiredClaim.event.id, 0], // ancient — expired
      ]),
    });

    const byActor = claimedBy(state);
    const aliceTickets = byActor.get("claude-code:alice/wt-a" as ActorId) ?? [];
    expect(aliceTickets.map((t) => t.id as string)).toEqual(["ck-live"]);
  });

  test("a never-observed claim (firstSeen unknown) is also excluded, not treated as live", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], { now: 0, leaseTtlMs: 1_000_000, firstSeen: new Map() });

    expect(claimedBy(state).size).toBe(0);
  });

  test("an unclaimed ticket contributes nothing", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(claimedBy(state).size).toBe(0);
  });
});

describe("blockedBy", () => {
  test("throws StateErrorCodes.TICKET_NOT_IN_BOARD_STATE for an id not in this BoardState", () => {
    const state = foldState([], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    let threw = false;
    try {
      blockedBy(state, "ck-nope" as TicketId);
    } catch (error) {
      threw = true;
      expect(isCanKanError(error) && error.code).toBe(StateErrorCodes.TICKET_NOT_IN_BOARD_STATE);
    }
    expect(threw).toBe(true);
  });

  test("no deps at all: not blocked", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(blockedBy(state, "ck-1" as TicketId)).toEqual([]);
  });

  test("only 'blocks'-type deps gate readiness — 'related'/'parent-child'/'discovered-from' are ignored", () => {
    const other = makeStoredTicket("ck-2", "To Do"); // not closed — would block if it were type "blocks"
    const ticket = makeStoredTicket("ck-1", "To Do", {
      cankan: {
        deps: [
          { type: "related", id: "ck-2" },
          { type: "parent-child", id: "ck-2" },
          { type: "discovered-from", id: "ck-2" },
        ],
      },
    });
    const state = foldState([ticket, other], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(blockedBy(state, "ck-1" as TicketId)).toEqual([]);
  });

  test("a 'blocks' dep on an open (not closed) ticket is still outstanding", () => {
    const blocker = makeStoredTicket("ck-2", "In Progress");
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "ck-2" }] } });
    const state = foldState([ticket, blocker], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const outstanding = blockedBy(state, "ck-1" as TicketId);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.rawId).toBe("ck-2");
    expect(outstanding[0]?.resolvedTicket?.id as string | undefined).toBe("ck-2");
  });

  test("a 'blocks' dep on a closed ticket is satisfied — not outstanding", () => {
    const blockerTicket = makeStoredTicket("ck-2", "Done");
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-2" }, "2026-01", 0);
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "ck-2" }] } });
    const state = foldState([ticket, blockerTicket], [closeEvent], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets.find((t) => t.id === "ck-2")?.closed).toBe(true);
    expect(blockedBy(state, "ck-1" as TicketId)).toEqual([]);
  });

  test("an unresolvable dep id is treated as still-blocking, never silently dropped", () => {
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "ck-does-not-exist" }] } });
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const outstanding = blockedBy(state, "ck-1" as TicketId);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.rawId).toBe("ck-does-not-exist");
    expect(outstanding[0]?.resolvedTicket).toBeUndefined();
  });

  test("a cross-board <repo>:<id> ref (CONCEPT.md §6c) cannot be resolved by a single-board fold and is treated as still-blocking", () => {
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "api:ck-7f3a9c" }] } });
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const outstanding = blockedBy(state, "ck-1" as TicketId);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.resolvedTicket).toBeUndefined();
  });

  test("a dep id resolves through a known alias (e.g. a pre-adopt id) to a closed ticket — satisfied", () => {
    const blocker = makeStoredTicket("ck-2", "Done");
    const aliasEvent = fixtureEvent({ event: "alias", ticket: "ck-2", from: "TASK-9", to: "ck-2" }, "2026-01", 0);
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-2" }, "2026-01", 1);
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "TASK-9" }] } });

    const state = foldState([ticket, blocker], [aliasEvent, closeEvent], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(blockedBy(state, "ck-1" as TicketId)).toEqual([]);
  });

  test("multiple 'blocks' deps: only the unsatisfied ones are returned", () => {
    const done = makeStoredTicket("ck-done", "Done");
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-done" }, "2026-01", 0);
    const open = makeStoredTicket("ck-open", "To Do");
    const ticket = makeStoredTicket("ck-1", "To Do", {
      cankan: {
        deps: [
          { type: "blocks", id: "ck-done" },
          { type: "blocks", id: "ck-open" },
        ],
      },
    });

    const state = foldState([ticket, done, open], [closeEvent], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const outstanding = blockedBy(state, "ck-1" as TicketId);
    expect(outstanding.map((d) => d.rawId)).toEqual(["ck-open"]);
  });
});
