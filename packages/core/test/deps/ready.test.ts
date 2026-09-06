import { describe, expect, test } from "bun:test";
import { isReady, readySet } from "../../src/deps/ready";
import { isCanKanError } from "../../src/errors";
import { StateErrorCodes } from "../../src/state/errors";
import { foldState } from "../../src/state/fold";
import type { ActorId, TicketId } from "../../src/types";
import { fixtureEvent, makeStoredTicket } from "../state/testHelpers";

describe("isReady", () => {
  test("ready when open, unclaimed, no blockers, no excluded labels", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const verdict = isReady(state, "ck-1" as TicketId);
    expect(verdict).toEqual({ ready: true, reasons: [] });
  });

  test("not ready: closed — reason asserted, not just ready===false", () => {
    const ticket = makeStoredTicket("ck-1", "Done");
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-1" }, "2026-01", 0);
    const state = foldState([ticket], [closeEvent], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const verdict = isReady(state, "ck-1" as TicketId);
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContainEqual({ kind: "closed" });
  });

  test("not ready: claimed and unexpired — reason carries the holding actor", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], {
      now: 100,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    const verdict = isReady(state, "ck-1" as TicketId);
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContainEqual({ kind: "claimed", actor: "claude-code:alice/wt-a" as ActorId });
  });

  test("not ready: an open (typed) blocker — reason carries rawId and the resolved ticket", () => {
    const blocker = makeStoredTicket("ck-2", "In Progress");
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "ck-2" }] } });
    const state = foldState([ticket, blocker], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const verdict = isReady(state, "ck-1" as TicketId);
    expect(verdict.ready).toBe(false);
    const reason = verdict.reasons.find((r) => r.kind === "blocked");
    expect(reason).toBeDefined();
    expect(reason?.kind === "blocked" && reason.rawId).toBe("ck-2");
    expect(reason?.kind === "blocked" && reason.resolvedTicket?.id).toBe("ck-2" as TicketId);
  });

  test("not ready: carrying an excluded label — reason carries which label", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const verdict = isReady(state, "ck-1" as TicketId, {
      excludedLabels: ["icebox", "needs-design"],
      labelsFor: () => ["icebox"],
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContainEqual({ kind: "excluded-label", label: "icebox" });
  });

  test("ready: the only blocker is itself closed — the blocking dep resolves as satisfied", () => {
    const blocker = makeStoredTicket("ck-2", "Done");
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-2" }, "2026-01", 0);
    const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "ck-2" }] } });
    const state = foldState([ticket, blocker], [closeEvent], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    expect(isReady(state, "ck-1" as TicketId)).toEqual({ ready: true, reasons: [] });
  });

  test("ready: claimed-but-EXPIRED is ready, not claimed", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], {
      now: 1_000_000,
      leaseTtlMs: 100,
      firstSeen: new Map([[claim.event.id, 0]]), // expired long ago
    });

    expect(isReady(state, "ck-1" as TicketId)).toEqual({ ready: true, reasons: [] });
  });

  test("ready: claimed but NEVER OBSERVED (no firstSeen entry) is also ready, not claimed", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], { now: 0, leaseTtlMs: 1_000_000, firstSeen: new Map() });

    expect(isReady(state, "ck-1" as TicketId)).toEqual({ ready: true, reasons: [] });
  });

  describe("Ruling R2 — both blockedBy error codes escape isReady, uncaught, separately", () => {
    test("STATE_TICKET_ID_AMBIGUOUS escapes for a duplicated id", () => {
      const lower = makeStoredTicket("ck-1", "To Do");
      const upper = makeStoredTicket("CK-1", "Done");
      const state = foldState([lower, upper], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      let threw = false;
      try {
        isReady(state, "ck-1" as TicketId);
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(StateErrorCodes.TICKET_ID_AMBIGUOUS);
      }
      expect(threw).toBe(true);
    });

    test("STATE_TICKET_NOT_IN_BOARD_STATE escapes for a genuinely absent id", () => {
      const state = foldState([], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      let threw = false;
      try {
        isReady(state, "ck-nope" as TicketId);
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(StateErrorCodes.TICKET_NOT_IN_BOARD_STATE);
      }
      expect(threw).toBe(true);
    });
  });

  describe("Ruling R1 — flat Backlog.md `dependencies`, tier 1 only, fail closed", () => {
    test("a flat-only blocker (no cankan: block at all — the post-`backlog task edit` shape) still blocks", () => {
      const blocker = makeStoredTicket("ck-2", "In Progress");
      // `ticket` carries ONLY a flat `dependencies` reference, supplied by the
      // caller via `flatDependenciesFor` — no `cankan.deps` at all.
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket, blocker], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: (id) => (id === "ck-1" ? ["ck-2"] : []),
      });
      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(reason?.kind === "blocked" && reason.rawId).toBe("ck-2");
      expect(reason?.kind === "blocked" && reason.resolvedTicket?.id).toBe("ck-2" as TicketId);
    });

    test("a flat dep naming an id that matches no ticket is outstanding, not dropped", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-does-not-exist"],
      });
      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(reason?.kind === "blocked" && reason.rawId).toBe("ck-does-not-exist");
      expect(reason?.kind === "blocked" && reason.resolvedTicket).toBeUndefined();
    });

    test("a flat dep resolving to an already-closed ticket is satisfied — ready", () => {
      const blocker = makeStoredTicket("ck-2", "Done");
      const closeEvent = fixtureEvent({ event: "close", ticket: "ck-2" }, "2026-01", 0);
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket, blocker], [closeEvent], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      const verdict = isReady(state, "ck-1" as TicketId, { flatDependenciesFor: () => ["ck-2"] });
      expect(verdict).toEqual({ ready: true, reasons: [] });
    });

    test("a cross-board <repo>:<id> flat dep is unresolvable and therefore outstanding", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      const verdict = isReady(state, "ck-1" as TicketId, { flatDependenciesFor: () => ["api:ck-9"] });
      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(reason?.kind === "blocked" && reason.resolvedTicket).toBeUndefined();
    });

    test("CONCEPT.md's own worked example: typed `deps` and flat `dependencies` naming the SAME target collapse to ONE blocker reason", () => {
      const blocker = makeStoredTicket("ck-2b1e44", "In Progress");
      const ticket = makeStoredTicket("ck-1", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-2b1e44" }] },
      });
      const state = foldState([ticket, blocker], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-2b1e44"],
      });
      const blockedReasons = verdict.reasons.filter((r) => r.kind === "blocked");
      expect(blockedReasons).toHaveLength(1);
    });

    test("flat dep naming a DIFFERENT target than the typed dep produces two separate blocker reasons", () => {
      const typedBlocker = makeStoredTicket("ck-2", "In Progress");
      const flatBlocker = makeStoredTicket("ck-3", "In Progress");
      const ticket = makeStoredTicket("ck-1", "To Do", { cankan: { deps: [{ type: "blocks", id: "ck-2" }] } });
      const state = foldState([ticket, typedBlocker, flatBlocker], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, { flatDependenciesFor: () => ["ck-3"] });
      const blockedReasons = verdict.reasons.filter((r) => r.kind === "blocked");
      expect(blockedReasons.map((r) => (r.kind === "blocked" ? r.rawId : undefined)).sort()).toEqual(["ck-2", "ck-3"]);
    });
  });

  test("every applicable reason is reported together, not just the first", () => {
    const blocker = makeStoredTicket("ck-2", "In Progress");
    const ticket = makeStoredTicket("ck-1", "Done", { cankan: { deps: [{ type: "blocks", id: "ck-2" }] } });
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-1" }, "2026-01", 0);
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-1", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      1,
    );
    const state = foldState([ticket, blocker], [closeEvent, claim], {
      now: 0,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    const verdict = isReady(state, "ck-1" as TicketId, {
      excludedLabels: ["icebox"],
      labelsFor: () => ["icebox"],
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.map((r) => r.kind).sort()).toEqual(["blocked", "claimed", "closed", "excluded-label"]);
  });

  test("label comparison is case-sensitive (documented decision)", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], { now: 0, leaseTtlMs: 1000, firstSeen: new Map() });

    const verdict = isReady(state, "ck-1" as TicketId, {
      excludedLabels: ["Icebox"],
      labelsFor: () => ["icebox"],
    });
    expect(verdict).toEqual({ ready: true, reasons: [] });
  });
});

describe("readySet", () => {
  test("sweeps a fixture board and matches an explicit golden verdict map", () => {
    const ready = makeStoredTicket("ck-ready", "To Do");
    const closedTicket = makeStoredTicket("ck-closed", "Done");
    const closeEvent = fixtureEvent({ event: "close", ticket: "ck-closed" }, "2026-01", 0);
    const blocker = makeStoredTicket("ck-blocker", "In Progress");
    const blocked = makeStoredTicket("ck-blocked", "To Do", {
      cankan: { deps: [{ type: "blocks", id: "ck-blocker" }] },
    });
    const claimedTicket = makeStoredTicket("ck-claimed", "In Progress");
    const claim = fixtureEvent(
      { event: "claim", ticket: "ck-claimed", actor: "claude-code:alice/wt-a", lease_until: "2099-01-01T00:00:00Z" },
      "2026-01",
      1,
    );

    const state = foldState(
      [ready, closedTicket, blocker, blocked, claimedTicket],
      [closeEvent, claim],
      { now: 0, leaseTtlMs: 1_000_000, firstSeen: new Map([[claim.event.id, 0]]) },
    );

    const sweep = readySet(state);

    const golden: Record<string, { readonly ready: boolean; readonly reasonKinds: readonly string[] }> = {
      "ck-ready": { ready: true, reasonKinds: [] },
      "ck-closed": { ready: false, reasonKinds: ["closed"] },
      "ck-blocker": { ready: true, reasonKinds: [] },
      "ck-blocked": { ready: false, reasonKinds: ["blocked"] },
      "ck-claimed": { ready: false, reasonKinds: ["claimed"] },
    };

    expect(sweep.size).toBe(5);
    for (const [id, expected] of Object.entries(golden)) {
      const verdict = sweep.get(id as TicketId);
      expect(verdict?.ready).toBe(expected.ready);
      expect((verdict?.reasons.map((r) => r.kind) as string[] | undefined)?.sort()).toEqual(
        [...expected.reasonKinds].sort(),
      );
    }
  });
});
