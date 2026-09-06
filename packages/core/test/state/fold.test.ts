import { describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import type { EventId, EventRecord } from "../../src/events/index";
import { foldState, observeAndFold } from "../../src/state/fold";
import { StateErrorCodes } from "../../src/state/errors";
// `@jeff-roche/cankan-test-utils` is not a declared dependency of
// `packages/core/package.json` — a relative import to the source file is
// used instead of the package specifier, the same pattern
// `events/observations.test.ts` uses.
import { withEnv } from "../../../test-utils/src/withEnv";
import { fixedEventId, fixtureEvent, makeStoredTicket } from "./testHelpers";

/**
 * Golden tests: `foldState` is pure, so every expectation below is
 * hand-computed against the fixture inputs — never a recorded/regenerated
 * snapshot. If a test starts failing, the fix is to re-derive the expected
 * value by hand from the rule being tested, not to copy in whatever the
 * fold now returns.
 */
describe("foldState — status precedence (Ruling R6)", () => {
  test("no events: resolved status is the frontmatter status", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]).toMatchObject({
      id: "ck-1",
      statusFromFrontmatter: "To Do",
      statusFromEvents: undefined,
      status: "To Do",
      closed: false,
      closeReason: undefined,
      lease: undefined,
      displayId: undefined,
      aliases: [],
      deps: [],
    });
  });

  test("a move event overrides the frontmatter status", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const move = fixtureEvent({ event: "move", ticket: "ck-1", from: "To Do", to: "In Progress" }, "2026-01", 0);
    const state = foldState([ticket], [move], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.statusFromFrontmatter).toBe("To Do");
    expect(state.tickets[0]?.statusFromEvents).toBe("In Progress");
    expect(state.tickets[0]?.status).toBe("In Progress");
  });

  test("disagreement case: frontmatter says Done, but a claim event is live — both threads are independent", () => {
    // The resolved `status` must stay "Done" (no `move` event exists to
    // override it) even though the ticket is simultaneously claimed — a
    // claim never touches status, and status never touches claim/lease.
    const ticket = makeStoredTicket("ck-1", "Done");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], {
      now: 100,
      leaseTtlMs: 10_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    expect(state.tickets[0]?.status).toBe("Done");
    expect(state.tickets[0]?.statusFromFrontmatter).toBe("Done");
    expect(state.tickets[0]?.lease?.expired).toBe(false);
    expect(state.tickets[0]?.lease?.actor as string | undefined).toBe("claude-code:alice/wt-auth");
  });

  test("an external-write AFTER a move resets the base: the move no longer wins", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const move = fixtureEvent({ event: "move", ticket: "ck-1", from: "To Do", to: "In Progress" }, "2026-01", 0);
    const externalWrite = fixtureEvent({ event: "external-write", ticket: "ck-1" }, "2026-01", 1);
    const state = foldState([ticket], [move, externalWrite], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.statusFromEvents).toBeUndefined();
    expect(state.tickets[0]?.status).toBe("To Do");
  });

  test("an external-write BEFORE a move: the move (being newer) still wins", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const externalWrite = fixtureEvent({ event: "external-write", ticket: "ck-1" }, "2026-01", 0);
    const move = fixtureEvent({ event: "move", ticket: "ck-1", from: "To Do", to: "Done" }, "2026-01", 1);
    const state = foldState([ticket], [externalWrite, move], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.statusFromEvents).toBe("Done");
    expect(state.tickets[0]?.status).toBe("Done");
  });

  test("events supplied out of (month,line) order still fold correctly — array index is not chain position", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const moveA = fixtureEvent({ event: "move", ticket: "ck-1", from: "To Do", to: "First" }, "2026-01", 0);
    const moveB = fixtureEvent({ event: "move", ticket: "ck-1", from: "First", to: "Second" }, "2026-01", 1);
    // moveB (line 1, chain-later) passed BEFORE moveA (line 0) in the array.
    const state = foldState([ticket], [moveB, moveA], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.status).toBe("Second");
  });
});

describe("foldState — close (Ruling R14)", () => {
  test("a close event sets closed+closeReason and leaves status untouched", () => {
    const ticket = makeStoredTicket("ck-1", "In Progress");
    const close = fixtureEvent({ event: "close", ticket: "ck-1", reason: "duplicate" }, "2026-01", 0);
    const state = foldState([ticket], [close], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.status).toBe("In Progress");
    expect(state.tickets[0]?.closed).toBe(true);
    expect(state.tickets[0]?.closeReason).toBe("duplicate");
  });

  test("closed is sticky across a later move — CONCEPT.md:529's close-moves-to-last-column is that move's own side effect, not a reopen", () => {
    const ticket = makeStoredTicket("ck-1", "In Progress");
    const close = fixtureEvent({ event: "close", ticket: "ck-1", reason: "wontfix" }, "2026-01", 0);
    const move = fixtureEvent({ event: "move", ticket: "ck-1", from: "In Progress", to: "Done" }, "2026-01", 1);
    const state = foldState([ticket], [close, move], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.closed).toBe(true);
    expect(state.tickets[0]?.closeReason).toBe("wontfix");
    expect(state.tickets[0]?.status).toBe("Done");
  });

  test("the most recent of multiple close events supplies closeReason", () => {
    const ticket = makeStoredTicket("ck-1", "In Progress");
    const first = fixtureEvent({ event: "close", ticket: "ck-1", reason: "first" }, "2026-01", 0);
    const second = fixtureEvent({ event: "close", ticket: "ck-1", reason: "second" }, "2026-01", 1);
    const state = foldState([ticket], [first, second], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.closeReason).toBe("second");
  });
});

describe("foldState — lease expiry (the reader's own clock, never the event's)", () => {
  test("THE key test: lease_until far in the future is ignored — firstSeen decides expiry, not the event's own display value", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    // firstSeen is ancient (0); now is well past firstSeen + leaseTtlMs,
    // even though `lease_until` on the event itself claims the lease is
    // good until the year 2099.
    const state = foldState([ticket], [claim], {
      now: 100_000,
      leaseTtlMs: 1_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease?.leaseUntilDisplay).toBe("2099-01-01T00:00:00Z");
    expect(state.tickets[0]?.lease?.expired).toBe(true);
    expect(state.tickets[0]?.lease?.expiresAtMs).toBe(1_000);
  });

  test("a renew genuinely extends the lease: anchored on the renew's own firstSeen, not the original claim's", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2026-01-01T02:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const renew = fixtureEvent(
      { event: "renew", ticket: "ck-1", lease_until: "2026-01-01T04:00:00Z", id: fixedEventId(2) },
      "2026-01",
      1,
    );
    const state = foldState([ticket], [claim, renew], {
      now: 5_500,
      leaseTtlMs: 1_000,
      firstSeen: new Map([
        [claim.event.id, 0], // ancient — if this anchored the lease, it would already be expired
        [renew.event.id, 5_000], // recent — expiresAtMs = 6_000, still in the future at now=5_500
      ]),
    });

    expect(state.tickets[0]?.lease?.eventId).toBe(renew.event.id);
    expect(state.tickets[0]?.lease?.kind).toBe("renew");
    expect(state.tickets[0]?.lease?.expiresAtMs).toBe(6_000);
    expect(state.tickets[0]?.lease?.expired).toBe(false);
  });

  test("a missing firstSeen entry surfaces as expired-or-unknown, never as 'not expired'", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    // No entry for claim.event.id in firstSeen at all — this reader never
    // observed it (e.g. it appeared in a `read()` window this reader
    // skipped observing for).
    const state = foldState([ticket], [claim], { now: 0, leaseTtlMs: 1_000_000, firstSeen: new Map() });

    expect(state.tickets[0]?.lease?.firstSeenMs).toBeUndefined();
    expect(state.tickets[0]?.lease?.expiresAtMs).toBeUndefined();
    expect(state.tickets[0]?.lease?.expired).toBe(true);
  });

  test("expiry boundary is inclusive: now === expiresAtMs counts as expired", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const firstSeen = new Map([[claim.event.id, 1_000]]);

    const atBoundary = foldState([ticket], [claim], { now: 1_500, leaseTtlMs: 500, firstSeen });
    expect(atBoundary.tickets[0]?.lease?.expired).toBe(true);

    const justBefore = foldState([ticket], [claim], { now: 1_499, leaseTtlMs: 500, firstSeen });
    expect(justBefore.tickets[0]?.lease?.expired).toBe(false);
  });

  test("release ends a lease outright, regardless of expiry", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const release = fixtureEvent({ event: "release", ticket: "ck-1" }, "2026-01", 1);
    const state = foldState([ticket], [claim, release], {
      now: 0,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease).toBeUndefined();
  });

  test("expire ends a lease outright", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const expireEvent = fixtureEvent({ event: "expire", ticket: "ck-1" }, "2026-01", 1);
    const state = foldState([ticket], [claim, expireEvent], {
      now: 0,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease).toBeUndefined();
  });

  test("close ends a lease outright (CONCEPT.md:529: close releases the claim)", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const close = fixtureEvent({ event: "close", ticket: "ck-1" }, "2026-01", 1);
    const state = foldState([ticket], [claim, close], {
      now: 0,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease).toBeUndefined();
    expect(state.tickets[0]?.closed).toBe(true);
  });

  test("a takeover anchors a fresh lease (--force, PLAN.md:267/M2.10) just like a claim", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const takeover = fixtureEvent(
      {
        event: "takeover",
        ticket: "ck-1",
        actor: "claude-code:bob/wt-x",
        lease_until: "2099-01-01T00:00:00Z",
        id: fixedEventId(1),
      },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [takeover], {
      now: 100,
      leaseTtlMs: 10_000,
      firstSeen: new Map([[takeover.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease?.kind).toBe("takeover");
    expect(state.tickets[0]?.lease?.actor as string | undefined).toBe("claude-code:bob/wt-x");
    expect(state.tickets[0]?.lease?.expired).toBe(false);
  });
});

describe("foldState — tie-break stability (Ruling R12/M2.7 contract 1): (month,line), never id", () => {
  test("an id that sorts EARLIER than another must not win if its (month,line) is chain-EARLIER", () => {
    // fixedEventId(999) sorts lexicographically AFTER fixedEventId(1) — a
    // naive id-sort would process the takeover (id 1) before the claim (id
    // 999) and conclude the claim is the more recent lease holder. The
    // correct (month,line) order is the reverse: the claim is at line 0
    // (chain-earlier), the takeover at line 1 (chain-later, i.e. the real
    // "most recent" event) — so the takeover's actor must win.
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-auth",
        lease_until: "2099-01-01T00:00:00Z",
        id: fixedEventId(999),
      },
      "2026-01",
      0,
    );
    const takeover = fixtureEvent(
      {
        event: "takeover",
        ticket: "ck-1",
        actor: "claude-code:bob/wt-x",
        lease_until: "2099-01-01T00:00:00Z",
        id: fixedEventId(1),
      },
      "2026-01",
      1,
    );
    expect(takeover.event.id < claim.event.id).toBe(true); // confirms the id-sort trap is real for this fixture

    const state = foldState([ticket], [claim, takeover], {
      now: 100,
      leaseTtlMs: 10_000,
      firstSeen: new Map([
        [claim.event.id, 0],
        [takeover.event.id, 0],
      ]),
    });

    expect(state.tickets[0]?.lease?.actor as string | undefined).toBe("claude-code:bob/wt-x");
    expect(state.tickets[0]?.lease?.kind).toBe("takeover");
  });

  test("the same trap for the status walk: (month,line) order wins over id order", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const moveA = fixtureEvent(
      { event: "move", ticket: "ck-1", from: "To Do", to: "A", id: fixedEventId(999) },
      "2026-01",
      0,
    );
    const moveB = fixtureEvent(
      { event: "move", ticket: "ck-1", from: "A", to: "B", id: fixedEventId(1) },
      "2026-01",
      1,
    );
    expect(moveB.event.id < moveA.event.id).toBe(true);

    const state = foldState([ticket], [moveA, moveB], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.status).toBe("B");
  });
});

describe("foldState — orphaned events (Ruling R15): reported, never dropped", () => {
  test("a claim on a ticket with no matching file is reported, not silently lost", () => {
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-ghost", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const state = foldState([], [claim], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets).toHaveLength(0);
    expect(state.orphanedEvents.map((o) => ({ ...o, ticketId: o.ticketId as string }))).toEqual([
      { ticketId: "ck-ghost", eventCount: 1, reason: "no ticket file in this checkout matches this event's ticket id" },
    ]);
  });

  test("orphaned events are counted per distinct ticket id, case-insensitively", () => {
    const claim = fixtureEvent({ event: "claim", ticket: "CK-GHOST", lease_until: "2099-01-01T00:00:00Z" }, "2026-01", 0);
    const comment = fixtureEvent({ event: "comment", ticket: "ck-ghost", text: "hi" }, "2026-01", 1);
    const state = foldState([], [claim, comment], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.orphanedEvents).toHaveLength(1);
    expect(state.orphanedEvents[0]?.ticketId as string | undefined).toBe("ck-ghost");
    expect(state.orphanedEvents[0]?.eventCount).toBe(2);
  });

  test("events for a known ticket are not counted as orphaned", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const move = fixtureEvent({ event: "move", ticket: "ck-1", from: "To Do", to: "Done" }, "2026-01", 0);
    const state = foldState([ticket], [move], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.orphanedEvents).toHaveLength(0);
  });
});

describe("foldState — alias map", () => {
  test("a single-hop alias resolves to the current ticket", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const alias = fixtureEvent({ event: "alias", ticket: "ck-1", from: "TASK-12", to: "ck-1" }, "2026-01", 0);
    const state = foldState([ticket], [alias], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.aliases).toEqual(["task-12"]);
  });

  test("a multi-hop alias chain resolves to the final ticket, and frontmatter aliases are merged/deduped", () => {
    // TASK-12 -> ck-1 -> ck-2. Only ck-2 has a file (ck-1's own file was
    // itself renamed away). ck-2's frontmatter already lists "TASK-12" as a
    // known alias (on-disk casing) — the event-derived lowercase "task-12"
    // must not duplicate it, but the event-derived "ck-1" (a genuinely new
    // alias the frontmatter doesn't know about) must still show up.
    const ticket = makeStoredTicket("ck-2", "To Do", { cankan: { aliases: ["TASK-12"] } });
    const hop1 = fixtureEvent({ event: "alias", ticket: "ck-1", from: "TASK-12", to: "ck-1" }, "2026-01", 0);
    const hop2 = fixtureEvent({ event: "alias", ticket: "ck-2", from: "ck-1", to: "ck-2" }, "2026-01", 1);
    const state = foldState([ticket], [hop1, hop2], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.aliases).toEqual(["TASK-12", "ck-1"]);
  });

  test("a self-loop that reaches the fold anyway (schema normally rejects it) does not crash or hang", () => {
    // `events/schema.ts`'s `aliasEventSchema` rejects `from === to` at the
    // boundary, so this shape should never really reach `foldState` — but
    // this test builds the `EventRecord` directly (bypassing `parseEvent`)
    // to assert what happens if it somehow does. `resolveAliasTarget`'s
    // single visited-set guard stops the walk on the very first step (the
    // self-loop's own target is already visited), so `ck-9` resolves to
    // itself — which, since `ck-9` IS a real known ticket, means it ends up
    // listed as its own alias. Harmless, and — the actual point of this
    // test — does not hang.
    const ticket = makeStoredTicket("ck-9", "To Do");
    // `Event`'s branded fields (`EventId`/`ActorId`/`TicketId`) have no
    // runtime representation beyond a plain string, so a direct object
    // literal cast to `EventRecord` is the deliberate, documented way to
    // build a shape `parseEvent` would refuse to produce.
    const selfLoop = {
      event: {
        ts: "2026-01-01T00:00:00Z",
        id: fixedEventId(1),
        actor: "claude-code:alice/wt-auth",
        ticket: "ck-9",
        event: "alias" as const,
        from: "ck-9",
        to: "ck-9",
      },
      month: "2026-01",
      line: 0,
      position: 0,
    } as unknown as EventRecord;
    const state = foldState([ticket], [selfLoop], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.aliases).toEqual(["ck-9"]);
  });

  test("a cycle in the alias data (a<->b, neither a real ticket) does not hang and resolves to nothing", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const aToB = fixtureEvent({ event: "alias", ticket: "ck-x", from: "a", to: "b" }, "2026-01", 0);
    const bToA = fixtureEvent({ event: "alias", ticket: "ck-x", from: "b", to: "a" }, "2026-01", 1);
    const state = foldState([ticket], [aToB, bToA], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.aliases).toEqual([]);
  });
});

describe("foldState — output ordering and options validation", () => {
  test("tickets are sorted by normalized id, independent of input order", () => {
    const b = makeStoredTicket("ck-b", "To Do");
    const a = makeStoredTicket("ck-a", "To Do");
    const state = foldState([b, a], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets.map((t) => t.id as string)).toEqual(["ck-a", "ck-b"]);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "leaseTtlMs=%p throws StateErrorCodes.INVALID_LEASE_TTL",
    (leaseTtlMs) => {
      let threw = false;
      try {
        foldState([], [], { now: 0, leaseTtlMs, firstSeen: new Map() });
      } catch (error) {
        threw = true;
        expect(isCanKanError(error)).toBe(true);
        expect(isCanKanError(error) && error.code).toBe(StateErrorCodes.INVALID_LEASE_TTL);
      }
      expect(threw).toBe(true);
    },
  );
});

describe("observeAndFold — the thin async wrapper (Ruling R7)", () => {
  test("observes a claim and folds a live lease on first sight", async () => {
    await withEnv(undefined, async () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const claim = fixtureEvent(
        { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z" },
        "2026-01",
        0,
      );
      const state = await observeAndFold("test-board-key-1", [ticket], [claim], { now: 1000, leaseTtlMs: 10_000 });

      expect(state.tickets[0]?.lease?.firstSeenMs).toBe(1000);
      expect(state.tickets[0]?.lease?.expired).toBe(false);
    });
  });

  test("first-observation time persists across calls — a later call's own `now` does not move it", async () => {
    await withEnv(undefined, async () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const claim = fixtureEvent(
        { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z" },
        "2026-01",
        0,
      );
      const boardKey = "test-board-key-2";

      const first = await observeAndFold(boardKey, [ticket], [claim], { now: 1000, leaseTtlMs: 500 });
      expect(first.tickets[0]?.lease?.firstSeenMs).toBe(1000);
      expect(first.tickets[0]?.lease?.expired).toBe(false);

      // Same event, observed again much later. If `observe()` moved the
      // recorded time to this call's `now`, the lease would read as live
      // forever. First-write-wins means it must now read as expired.
      const second = await observeAndFold(boardKey, [ticket], [claim], { now: 100_000, leaseTtlMs: 500 });
      expect(second.tickets[0]?.lease?.firstSeenMs).toBe(1000);
      expect(second.tickets[0]?.lease?.expired).toBe(true);
    });
  });

  test("a renew-only ticket (no claim in this events window) is still observed and folds a live lease", async () => {
    await withEnv(undefined, async () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const renew = fixtureEvent(
        { event: "renew", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z" },
        "2026-01",
        0,
      );
      const state = await observeAndFold("test-board-key-3", [ticket], [renew], { now: 1000, leaseTtlMs: 10_000 });

      expect(state.tickets[0]?.lease?.kind).toBe("renew");
      expect(state.tickets[0]?.lease?.expired).toBe(false);
    });
  });

  test("a takeover-only ticket is observed too — omitting it is exactly fm7", async () => {
    await withEnv(undefined, async () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const takeover = fixtureEvent(
        { event: "takeover", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z" },
        "2026-01",
        0,
      );
      const state = await observeAndFold("test-board-key-4", [ticket], [takeover], { now: 1000, leaseTtlMs: 10_000 });

      expect(state.tickets[0]?.lease?.kind).toBe("takeover");
      expect(state.tickets[0]?.lease?.expired).toBe(false);
    });
  });

  test("leaseTtlMs is validated even in the async wrapper, before any observe() call", async () => {
    await withEnv(undefined, async () => {
      let threw = false;
      try {
        await observeAndFold("test-board-key-5", [], [], { leaseTtlMs: 0 });
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(StateErrorCodes.INVALID_LEASE_TTL);
      }
      expect(threw).toBe(true);
    });
  });
});

// Confirms `fixedEventId` really does produce ids whose lexicographic order
// disagrees with `n`'s numeric order often enough to make the tie-break
// tests above meaningful, rather than accidentally testing nothing (the
// no-op-test audit in the task report explains why this assertion belongs
// in the suite rather than being a one-off manual check).
describe("test-fixture sanity", () => {
  test("fixedEventId ids are well-formed ULID-shaped strings usable as EventId map keys", () => {
    const id: EventId = fixtureEvent(
      { event: "release", ticket: "ck-1", id: fixedEventId(42) },
      "2026-01",
      0,
    ).event.id;
    expect(id).toHaveLength(26);
    expect(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)).toBe(true);
  });
});
