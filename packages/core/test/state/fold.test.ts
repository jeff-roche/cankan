import { describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { firstSeen } from "../../src/events/index";
import type { EventId, EventRecord } from "../../src/events/index";
import { foldState, observeAndFold, resolveAliasTargetForTesting } from "../../src/state/fold";
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

  test("L8 (security review, corrects an over-tightened M1): a renew that is the first lease-affecting event visible in the window still anchors a live lease", () => {
    // This is the window-truncation case, not "no claim ever happened": the
    // fold only ever sees `events`, never the full history, so a renew with
    // nothing before it in this slice must not be assumed to have no
    // incumbent at all — its own claim may simply have aged out of the
    // caller's read window. Treating it as unanchored would let a second
    // actor claim a ticket someone is actively renewing (verified directly,
    // security review) — the wrong direction to fail for a mutex.
    const ticket = makeStoredTicket("ck-1", "To Do");
    const renew = fixtureEvent(
      { event: "renew", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [renew], {
      now: 0,
      leaseTtlMs: 10_000,
      firstSeen: new Map([[renew.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease?.eventId).toBe(renew.event.id);
    expect(state.tickets[0]?.lease?.kind).toBe("renew");
    expect(state.tickets[0]?.lease?.expired).toBe(false);
  });

  test("L8: an actively-renewed lease whose original claim has aged out of the read window still reads as held", () => {
    // The realistic scenario L8 exists for: `events` here represents a
    // caller's `read()` window that no longer includes the original claim
    // at all — only its later renews are visible. The lease must still read
    // as live, or an honest actor renewing on a schedule would eventually
    // lose their own claim to a second actor purely from window truncation.
    const ticket = makeStoredTicket("ck-1", "To Do");
    const renewInWindow = fixtureEvent(
      { event: "renew", ticket: "ck-1", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [renewInWindow], {
      now: 100,
      leaseTtlMs: 10_000,
      firstSeen: new Map([[renewInWindow.event.id, 0]]),
    });

    expect(state.tickets[0]?.lease?.actor as string | undefined).toBe("claude-code:alice/wt-a");
    expect(state.tickets[0]?.lease?.expired).toBe(false);
  });

  test("M1: a renew after the incumbent has already ended (release) also mints nothing", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(1) },
      "2026-01",
      0,
    );
    const release = fixtureEvent({ event: "release", ticket: "ck-1" }, "2026-01", 1);
    const dangling = fixtureEvent(
      { event: "renew", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z", id: fixedEventId(2) },
      "2026-01",
      2,
    );
    const state = foldState([ticket], [claim, release, dangling], {
      now: 0,
      leaseTtlMs: 10_000,
      firstSeen: new Map([
        [claim.event.id, 0],
        [dangling.event.id, 0],
      ]),
    });

    expect(state.tickets[0]?.lease).toBeUndefined();
  });

  test("M2 (security review): a renew from a different actor than the incumbent neither extends nor reassigns the lease", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2026-01-01T02:00:00Z",
        id: fixedEventId(1),
      },
      "2026-01",
      0,
    );
    const hostileRenew = fixtureEvent(
      {
        event: "renew",
        ticket: "ck-1",
        actor: "claude-code:mallory/wt-x",
        lease_until: "2026-01-01T04:00:00Z",
        id: fixedEventId(2),
      },
      "2026-01",
      1,
    );
    const state = foldState([ticket], [claim, hostileRenew], {
      now: 500,
      leaseTtlMs: 10_000,
      firstSeen: new Map([
        [claim.event.id, 0], // the incumbent's own firstSeen — this must still be what expiry is measured against
        [hostileRenew.event.id, 0],
      ]),
    });

    // The lease is still anchored on the original claim: same eventId, same
    // actor. The hostile renew from a different actor was not folded in at
    // all — it neither extended the lease nor reassigned it.
    expect(state.tickets[0]?.lease?.eventId).toBe(claim.event.id);
    expect(state.tickets[0]?.lease?.kind).toBe("claim");
    expect(state.tickets[0]?.lease?.actor as string | undefined).toBe("claude-code:alice/wt-a");
  });

  test("M2: a renew from the SAME actor still genuinely extends the lease (contrast case)", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2026-01-01T02:00:00Z",
        id: fixedEventId(1),
      },
      "2026-01",
      0,
    );
    const sameActorRenew = fixtureEvent(
      {
        event: "renew",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2026-01-01T04:00:00Z",
        id: fixedEventId(2),
      },
      "2026-01",
      1,
    );
    const state = foldState([ticket], [claim, sameActorRenew], {
      now: 500,
      leaseTtlMs: 10_000,
      firstSeen: new Map([
        [claim.event.id, 0],
        [sameActorRenew.event.id, 400],
      ]),
    });

    expect(state.tickets[0]?.lease?.eventId).toBe(sameActorRenew.event.id);
    expect(state.tickets[0]?.lease?.kind).toBe("renew");
  });

  test("M3 GUARANTEE (do not gate on expiry — security review, ADR 0001:801-825): a fresh claim overrides even a still-UNEXPIRED incumbent", () => {
    // This is the one test that would catch a future refactor of
    // `resolveLeaseAnchor` that tries to "helpfully" keep the incumbent
    // when it looks unexpired as of `now`. That rule is explicitly rejected
    // (see `resolveLeaseAnchor`'s own doc): `firstSeen` is reader-local, so
    // two peers reading the same events at different `now`s would disagree
    // about whether the incumbent still counted as unexpired, and therefore
    // about who holds the ticket — exactly the nondeterminism ADR
    // 0001:801-825 forbids. `claim`/`takeover` must anchor unconditionally.
    const ticket = makeStoredTicket("ck-1", "To Do");
    const aliceClaim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2099-01-01T00:00:00Z",
        id: fixedEventId(1),
      },
      "2026-01",
      0,
    );
    const bobClaim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:bob/wt-b",
        lease_until: "2099-01-01T00:00:00Z",
        id: fixedEventId(2),
      },
      "2026-01",
      1,
    );
    const state = foldState([ticket], [aliceClaim, bobClaim], {
      now: 100,
      leaseTtlMs: 10_000, // generous — alice's claim is still comfortably unexpired at `now`
      firstSeen: new Map([
        [aliceClaim.event.id, 0],
        [bobClaim.event.id, 50],
      ]),
    });

    expect(state.tickets[0]?.lease?.eventId).toBe(bobClaim.event.id);
    expect(state.tickets[0]?.lease?.actor as string | undefined).toBe("claude-code:bob/wt-b");
  });
});

describe("foldState — alias resolution does not blow up quadratically (I2, security review)", () => {
  /** Builds a pure alias chain `a0 -> a1 -> ... -> a(N-1) -> <finalId>` as fixture `EventRecord`s. */
  function buildAliasChainEvents(n: number, finalId: string): EventRecord[] {
    const events: EventRecord[] = [];
    for (let i = 0; i < n; i++) {
      const from = `a${i}`;
      const to = i === n - 1 ? finalId : `a${i + 1}`;
      events.push(fixtureEvent({ event: "alias", ticket: "ck-x", from, to, id: fixedEventId(i) }, "2026-01", i));
    }
    return events;
  }

  function timeFoldOverChain(n: number): number {
    const finalId = `ck-final-${n}`;
    const ticket = makeStoredTicket(finalId, "To Do");
    const events = buildAliasChainEvents(n, finalId);
    const start = performance.now();
    foldState([ticket], events, { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });
    return performance.now() - start;
  }

  test("resolving an alias chain is correct at N=6000", () => {
    const N = 6000;
    const finalId = `ck-final-${N}`;
    const ticket = makeStoredTicket(finalId, "To Do");
    const state = foldState([ticket], buildAliasChainEvents(N, finalId), {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    // Every one of a0..a(N-1) is a `from` key in this chain and all of them
    // resolve to the single known ticket at the end — `toHaveLength` plus
    // spot-checking both ends catches a dropped or fabricated entry
    // anywhere in the chain, not just at the one node `toContain("a0")`
    // alone would have checked (fix round 4, Minor 3).
    expect(state.tickets[0]?.aliases).toHaveLength(N);
    expect(state.tickets[0]?.aliases).toContain("a0");
    expect(state.tickets[0]?.aliases).toContain(`a${N - 1}`);
  });

  /** The middle value of three timing samples at `n` — damps a single JIT/GC outlier the way a lone measurement can't (fix round 4, Minor 2). */
  function medianTimeFoldOverChain(n: number): number {
    const samples = [timeFoldOverChain(n), timeFoldOverChain(n), timeFoldOverChain(n)].sort((a, b) => a - b);
    return samples[1] as number;
  }

  test("growing the chain 4x grows the wall-clock time roughly 4x, not ~16x (O(N), not O(N^2))", () => {
    // A wall-clock *absolute* bound is both a CI-flakiness risk on a loaded
    // shared runner and a weak oracle: extrapolating the review's own
    // pre-fix measurement (~4.7s at N=16,000) down to N=6000 gives
    // ~660ms — comfortably under almost any generous absolute bound even
    // for the REGRESSED quadratic implementation, so an absolute-bound
    // test at that N could not actually catch a reintroduced O(N^2)
    // (security review, fix round 3). A *relative*-growth assertion is the
    // correct oracle instead: quadratic growth means 4x the input gives
    // ~16x the time; linear growth gives ~4x. N is chosen large enough that
    // both measurements clear a few milliseconds, so JS timer granularity
    // and GC jitter don't dominate the ratio.
    //
    // **Median of 3 at each N (fix round 4, Minor 2)**, not a single
    // sample: a single-sample run of a different alias shape hit a 8.16x
    // ratio once against this same `< 8` threshold (security review) —
    // `main` is branch-protected on both CI legs, so a flaky assertion here
    // is expensive. A median damps exactly the kind of one-off JIT/GC
    // outlier that produced that spike.
    const N = 8000;
    const baseline = medianTimeFoldOverChain(N);
    const fourX = medianTimeFoldOverChain(N * 4);

    const ratio = fourX / Math.max(baseline, 0.01);
    expect(ratio).toBeLessThan(8); // linear predicts ~4; quadratic predicts ~16 — 8 is the midpoint, generous either way
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
    // to assert what happens if it somehow does. A self-loop is the
    // degenerate one-node cycle: `resolveAllAliasTargets` (`fold.ts`)
    // detects `ck-9` revisiting itself on the very first step and resolves
    // it to itself — which, since `ck-9` IS a real known ticket, means it
    // ends up listed as its own alias. Harmless, and — the actual point of
    // this test — does not hang.
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

  test("CRITICAL FIX (fix round 3, security review): a 2-node alias cycle resolves the SAME way regardless of event order", () => {
    // The regression this pins: an earlier memoized implementation cached
    // whatever node a walk happened to stop at -- including a stop caused
    // by hitting a cycle, not a validated sink -- so a *later* walk could
    // adopt that as if it were stable. For `a<->b` with `a` a real ticket,
    // that made the result depend on which alias event came first:
    //   events [a->b, b->a] -> eventAliases: []            (dropped "b")
    //   events [b->a, a->b] -> eventAliases: ["b", "a"]    (fabricated "a")
    // Order must never decide an outcome (Ruling R12) -- both orderings
    // below must now produce the identical result.
    const ticket = makeStoredTicket("a", "To Do");

    const forwardFirst = foldState(
      [ticket],
      [
        fixtureEvent({ event: "alias", ticket: "ck-x", from: "a", to: "b" }, "2026-01", 0),
        fixtureEvent({ event: "alias", ticket: "ck-x", from: "b", to: "a" }, "2026-01", 1),
      ],
      { now: 0, leaseTtlMs: 1000, firstSeen: new Map() },
    );
    const backwardFirst = foldState(
      [ticket],
      [
        fixtureEvent({ event: "alias", ticket: "ck-x", from: "b", to: "a" }, "2026-01", 0),
        fixtureEvent({ event: "alias", ticket: "ck-x", from: "a", to: "b" }, "2026-01", 1),
      ],
      { now: 0, leaseTtlMs: 1000, firstSeen: new Map() },
    );

    // Per-node reference walk (`resolveAliasTargetForTesting`): resolving
    // "a" gives "b" (not a known ticket under any other id — contributes
    // nothing); resolving "b" gives "a" (the known ticket "a" itself), so
    // "b" is listed as one of "a"'s aliases. Net: `a.eventAliases` is
    // `["b"]`, contributed by the `b -> a` edge alone.
    expect(forwardFirst.tickets[0]?.aliases).toEqual(["b"]);
    expect(backwardFirst.tickets[0]?.aliases).toEqual(forwardFirst.tickets[0]?.aliases);
  });

  test("a real ticket sitting IN a 3-node alias cycle: per-node semantics are pinned, not incidental", () => {
    // a -> b -> c -> a, with `c` a real known ticket. Unlike the chain
    // tests above, every node here has an outgoing edge (a true cycle, no
    // sink), so this exercises `resolveCycleAndTail`'s cycle-member branch
    // directly rather than its tail branch. Per-node reference values
    // (verified against `resolveAliasTargetForTesting`, the pre-fix
    // from-scratch walk, in the property test below): a->c, b->a, c->b.
    // Only `b` (which resolves to `a` — not `c`) and... walked precisely:
    // resolving "a" gives "c" (c IS known) -> "a" is an alias of "c".
    // Resolving "b" gives "a" (not known) -> contributes nothing.
    // Resolving "c" gives "b" (not known) -> contributes nothing.
    // So `c.eventAliases` is exactly `["a"]` — a single node, not all
    // three; a path-compression bug that collapsed the whole cycle to one
    // representative would instead produce all three.
    const ticket = makeStoredTicket("c", "To Do");
    const aToB = fixtureEvent({ event: "alias", ticket: "ck-x", from: "a", to: "b" }, "2026-01", 0);
    const bToC = fixtureEvent({ event: "alias", ticket: "ck-x", from: "b", to: "c" }, "2026-01", 1);
    const cToA = fixtureEvent({ event: "alias", ticket: "ck-x", from: "c", to: "a" }, "2026-01", 2);
    const state = foldState([ticket], [aToB, bToC, cToA], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(state.tickets[0]?.aliases).toEqual(["a"]);
  });

  test("property check: the memoized resolver agrees with the pre-fix from-scratch walk, node by node, across chain/cycle/tail/shared-sink shapes, in BOTH event orders", () => {
    // `knownTicketIds` is chosen explicitly per graph — deliberately NOT
    // derived from "every value ever used as a `to`", which would make
    // some `from` keys also count as known tickets and blur what's being
    // tested. Every node in `edges` (whether or not it's a known ticket) is
    // checked: a known-ticket target must list the node as an alias; every
    // OTHER known ticket must NOT.
    //
    // **Runs each shape's alias events in both the given order and reversed
    // (fix round 4, Minor 1).** Instrumented directly: in forward-only
    // order across these five shapes, `resolveAllAliasTargets`'s
    // already-resolved-node "adopt the cached value" branch — the one that
    // actually carries the Critical fix's safety claim, "`resolved` only
    // ever holds fully-validated answers" — was never once taken (0 hits).
    // A mutant that instead re-derives the answer from the *current* walk
    // (`resolved.set(node, current)` instead of `resolved.set(node,
    // already)`) passed every shape in forward order and was only killed by
    // running `tailIntoCycle` reversed. Running every shape both ways (plus
    // the shared-sink shape below, which forces two independent components
    // to land on the same cached target) is what actually exercises that
    // branch — verified by deliberately reintroducing the mutant locally,
    // confirming this test then fails, and reverting (see the task report).
    function agreesForEveryNode(pairs: ReadonlyArray<readonly [string, string]>, knownTicketIds: readonly string[]): void {
      const edges = new Map(pairs); // for the reference walk only — `.get()` doesn't care about insertion order
      const knownTickets = knownTicketIds.map((id) => makeStoredTicket(id, "To Do"));

      function checkInEventOrder(orderedPairs: ReadonlyArray<readonly [string, string]>): void {
        const events = orderedPairs.map(([from, to], i) =>
          fixtureEvent({ event: "alias", ticket: "ck-x", from, to }, "2026-01", i),
        );
        const state = foldState(knownTickets, events, { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });
        const aliasesByTicket = new Map(state.tickets.map((t) => [t.id as string, t.aliases]));

        for (const from of edges.keys()) {
          const expectedTarget = resolveAliasTargetForTesting(edges, from);
          for (const knownId of knownTicketIds) {
            const shouldBeListed = knownId === expectedTarget;
            const isListed = (aliasesByTicket.get(knownId) ?? []).includes(from);
            expect(isListed, `${from} -> ${expectedTarget} (checked against known ticket ${knownId})`).toBe(
              shouldBeListed,
            );
          }
        }
      }

      checkInEventOrder(pairs);
      checkInEventOrder([...pairs].reverse());
    }

    // Long acyclic chain ending at a real sink.
    agreesForEveryNode(
      [
        ["a0", "a1"],
        ["a1", "a2"],
        ["a2", "sink"],
      ],
      ["sink"],
    );
    // Pure 2-cycle and 3-cycle (the Critical fix's own shapes) — check
    // every node as a candidate known ticket, not just one.
    agreesForEveryNode(
      [
        ["a", "b"],
        ["b", "a"],
      ],
      ["a", "b"],
    );
    agreesForEveryNode(
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ],
      ["a", "b", "c"],
    );
    // A tail feeding into a cycle (rho shape).
    agreesForEveryNode(
      [
        ["x", "a"],
        ["a", "b"],
        ["b", "a"],
      ],
      ["a", "b"],
    );
    // Two independent components resolved in one call.
    agreesForEveryNode(
      [
        ["p", "q"],
        ["q", "sink1"],
        ["m", "n"],
        ["n", "m"],
      ],
      ["sink1", "m", "n"],
    );
    // A shared sink: two disjoint tails converging on the SAME already-
    // resolved node — the shape most directly designed to force the
    // adoption branch (a second component's walk lands on a sink an
    // earlier component already validated).
    agreesForEveryNode([["p", "s"], ["q", "s"]], ["s"]);
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

  test("a renew-only ticket (no claim/takeover anywhere in this window) anchors a live lease (L8: window truncation, not evidence of no claim) and is observed", async () => {
    await withEnv(undefined, async () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const renew = fixtureEvent(
        { event: "renew", ticket: "ck-1", lease_until: "2099-01-01T00:00:00Z" },
        "2026-01",
        0,
      );
      const boardKey = "test-board-key-3";
      const state = await observeAndFold(boardKey, [ticket], [renew], { now: 1000, leaseTtlMs: 10_000 });

      // L8 (security review, corrects an over-tightened M1): the fold only
      // ever sees this window — the renew's own claim may have simply aged
      // out of it. Anchoring on the renew is the fail-safe direction for a
      // mutex (over-honor a possibly-gone lease, never risk a double-claim).
      expect(state.tickets[0]?.lease?.eventId).toBe(renew.event.id);
      expect(state.tickets[0]?.lease?.expired).toBe(false);
      // It is observed too, independent of what `foldState` does with it —
      // M2.7's contract 2 is unconditional on kind.
      expect(await firstSeen(boardKey, renew.event.id)).toBe(1000);
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

  test("I3 (security review): an orphaned claim (no matching ticket file) is never observed", async () => {
    await withEnv(undefined, async () => {
      const claim = fixtureEvent(
        { event: "claim", ticket: "ck-ghost", lease_until: "2099-01-01T00:00:00Z" },
        "2026-01",
        0,
      );
      const boardKey = "test-board-key-6";

      const state = await observeAndFold(boardKey, [], [claim], { now: 1000, leaseTtlMs: 10_000 });

      expect(state.orphanedEvents).toHaveLength(1);
      // No observation record was ever written for this id — `foldState`
      // routes an orphaned event straight to `orphanedEvents` and never
      // reads its `firstSeen` at all, so a record here would be unbounded,
      // peer-writable, unreclaimable garbage under $XDG_STATE_HOME.
      expect(await firstSeen(boardKey, claim.event.id)).toBeNull();
    });
  });

  test("code review minor: observeAndFold does NOT observe release/close/expire ids (only the three anchor kinds)", async () => {
    await withEnv(undefined, async () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const release = fixtureEvent({ event: "release", ticket: "ck-1" }, "2026-01", 0);
      const boardKey = "test-board-key-7";

      const state = await observeAndFold(boardKey, [ticket], [release], { now: 1000, leaseTtlMs: 10_000 });

      expect(state.tickets[0]?.lease).toBeUndefined();
      // If `observeAndFold` over-observed (every lease-affecting kind,
      // rather than only the three anchor kinds), this would find a
      // record. This test would also have passed under the old,
      // under-tested membership — it specifically requires the precise set.
      expect(await firstSeen(boardKey, release.event.id)).toBeNull();
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
