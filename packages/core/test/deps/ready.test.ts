import { describe, expect, test } from "bun:test";
import { DepsErrorCodes } from "../../src/deps/errors";
import { isReady, readySet } from "../../src/deps/ready";
import { isCanKanError } from "../../src/errors";
import { StateErrorCodes } from "../../src/state/errors";
import { foldState } from "../../src/state/fold";
import type { ActorId, TicketId } from "../../src/types";
import { fixtureEvent, makeStoredTicket } from "../state/testHelpers";

/** Every test in this file that doesn't care about flat deps passes this explicitly (Ruling R11: `flatDependenciesFor` is required, no silent "assume none"). */
const NO_FLAT_DEPS = { flatDependenciesFor: (): readonly string[] => [] };

describe("isReady", () => {
  test("ready when open, unclaimed, no blockers, no excluded labels", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    const verdict = isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS);
    expect(verdict).toEqual({ ready: true, reasons: [] });
  });

  test("not ready: closed — reason asserted, not just ready===false", () => {
    const ticket = makeStoredTicket("ck-1", "Done");
    const closeEvent = fixtureEvent(
      { event: "close", ticket: "ck-1" },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [closeEvent], {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    const verdict = isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS);
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContainEqual({ kind: "closed" });
  });

  test("not ready: claimed and unexpired — reason carries the holding actor", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2099-01-01T00:00:00Z",
      },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], {
      now: 100,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    const verdict = isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS);
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContainEqual({
      kind: "claimed",
      actor: "claude-code:alice/wt-a" as ActorId,
    });
  });

  test("not ready: an open (typed) blocker — reason carries rawId and the resolved ticket", () => {
    const blocker = makeStoredTicket("ck-2", "In Progress");
    const ticket = makeStoredTicket("ck-1", "To Do", {
      cankan: { deps: [{ type: "blocks", id: "ck-2" }] },
    });
    const state = foldState([ticket, blocker], [], {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    const verdict = isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS);
    expect(verdict.ready).toBe(false);
    const reason = verdict.reasons.find((r) => r.kind === "blocked");
    expect(reason).toBeDefined();
    expect(reason?.kind === "blocked" && reason.rawId).toBe("ck-2");
    expect(reason?.kind === "blocked" && reason.resolvedTicket?.id).toBe(
      "ck-2" as TicketId,
    );
  });

  test("not ready: carrying an excluded label — reason carries which label", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    const verdict = isReady(state, "ck-1" as TicketId, {
      ...NO_FLAT_DEPS,
      excludedLabels: ["icebox", "needs-design"],
      labelsFor: () => ["icebox"],
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContainEqual({
      kind: "excluded-label",
      label: "icebox",
    });
  });

  test("ready: the only blocker is itself closed — the blocking dep resolves as satisfied", () => {
    const blocker = makeStoredTicket("ck-2", "Done");
    const closeEvent = fixtureEvent(
      { event: "close", ticket: "ck-2" },
      "2026-01",
      0,
    );
    const ticket = makeStoredTicket("ck-1", "To Do", {
      cankan: { deps: [{ type: "blocks", id: "ck-2" }] },
    });
    const state = foldState([ticket, blocker], [closeEvent], {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    expect(isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS)).toEqual({
      ready: true,
      reasons: [],
    });
  });

  test("ready: claimed-but-EXPIRED is ready, not claimed", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2099-01-01T00:00:00Z",
      },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], {
      now: 1_000_000,
      leaseTtlMs: 100,
      firstSeen: new Map([[claim.event.id, 0]]), // expired long ago
    });

    expect(isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS)).toEqual({
      ready: true,
      reasons: [],
    });
  });

  test("ready: claimed but NEVER OBSERVED (no firstSeen entry) is also ready, not claimed", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2099-01-01T00:00:00Z",
      },
      "2026-01",
      0,
    );
    const state = foldState([ticket], [claim], {
      now: 0,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map(),
    });

    expect(isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS)).toEqual({
      ready: true,
      reasons: [],
    });
  });

  describe("Ruling R2 — both blockedBy error codes escape isReady, uncaught, separately", () => {
    test("STATE_TICKET_ID_AMBIGUOUS escapes for a duplicated id", () => {
      const lower = makeStoredTicket("ck-1", "To Do");
      const upper = makeStoredTicket("CK-1", "Done");
      const state = foldState([lower, upper], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      let threw = false;
      try {
        isReady(state, "ck-1" as TicketId, NO_FLAT_DEPS);
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(
          StateErrorCodes.TICKET_ID_AMBIGUOUS,
        );
      }
      expect(threw).toBe(true);
    });

    test("STATE_TICKET_NOT_IN_BOARD_STATE escapes for a genuinely absent id", () => {
      const state = foldState([], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      let threw = false;
      try {
        isReady(state, "ck-nope" as TicketId, NO_FLAT_DEPS);
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(
          StateErrorCodes.TICKET_NOT_IN_BOARD_STATE,
        );
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
      const state = foldState([ticket, blocker], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: (id) => (id === "ck-1" ? ["ck-2"] : []),
      });
      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(reason?.kind === "blocked" && reason.rawId).toBe("ck-2");
      expect(reason?.kind === "blocked" && reason.resolvedTicket?.id).toBe(
        "ck-2" as TicketId,
      );
    });

    test("a flat dep naming an id that matches no ticket is outstanding, not dropped", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-does-not-exist"],
      });
      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(reason?.kind === "blocked" && reason.rawId).toBe(
        "ck-does-not-exist",
      );
      expect(
        reason?.kind === "blocked" && reason.resolvedTicket,
      ).toBeUndefined();
    });

    test("a flat dep resolving to an already-closed ticket is satisfied — ready", () => {
      const blocker = makeStoredTicket("ck-2", "Done");
      const closeEvent = fixtureEvent(
        { event: "close", ticket: "ck-2" },
        "2026-01",
        0,
      );
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket, blocker], [closeEvent], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-2"],
      });
      expect(verdict).toEqual({ ready: true, reasons: [] });
    });

    test("a cross-board <repo>:<id> flat dep is unresolvable and therefore outstanding", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["api:ck-9"],
      });
      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(
        reason?.kind === "blocked" && reason.resolvedTicket,
      ).toBeUndefined();
    });

    test("CONCEPT.md's own worked example: typed `deps` and flat `dependencies` naming the SAME target collapse to ONE blocker reason", () => {
      const blocker = makeStoredTicket("ck-2b1e44", "In Progress");
      const ticket = makeStoredTicket("ck-1", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-2b1e44" }] },
      });
      const state = foldState([ticket, blocker], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-2b1e44"],
      });
      const blockedReasons = verdict.reasons.filter(
        (r) => r.kind === "blocked",
      );
      expect(blockedReasons).toHaveLength(1);
    });

    test("flat dep naming a DIFFERENT target than the typed dep produces two separate blocker reasons", () => {
      const typedBlocker = makeStoredTicket("ck-2", "In Progress");
      const flatBlocker = makeStoredTicket("ck-3", "In Progress");
      const ticket = makeStoredTicket("ck-1", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-2" }] },
      });
      const state = foldState([ticket, typedBlocker, flatBlocker], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-3"],
      });
      const blockedReasons = verdict.reasons.filter(
        (r) => r.kind === "blocked",
      );
      expect(
        blockedReasons
          .map((r) => (r.kind === "blocked" ? r.rawId : undefined))
          .sort(),
      ).toEqual(["ck-2", "ck-3"]);
    });
  });

  describe("Ruling R12 (fix round 1) — resolveTier1 must NEVER follow displayId/frontmatterAliases/eventAliases: the module's sole security invariant", () => {
    // Mirrors `attack1.ts` §A near-verbatim: close(ck-z), then
    // alias{from: ck-ghost, to: ck-z} — the exact composed attack
    // `state/queries.ts::blockedBy`'s own file comment discloses (push
    // access to the coordination ref alone, zero repo access. A later
    // `reopen` event restores the blocker.
    function boardWithNeutralizedGhost() {
      const z = makeStoredTicket("ck-z", "To Do");
      const closeZ = fixtureEvent(
        { event: "close", ticket: "ck-z" },
        "2026-01",
        0,
      );
      const aliasGhost = fixtureEvent(
        { event: "alias", ticket: "ck-z", from: "ck-ghost", to: "ck-z" },
        "2026-01",
        1,
      );
      return { z, closeZ, aliasGhost };
    }

    test("a FLAT dependency naming the alias'd-to-closed id is NOT satisfied — the flat path is tier-1 only and must not follow the alias", () => {
      const { z, closeZ, aliasGhost } = boardWithNeutralizedGhost();
      const v = makeStoredTicket("ck-v", "To Do"); // no cankan: block at all
      const state = foldState([v, z], [closeZ, aliasGhost], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-v" as TicketId, {
        flatDependenciesFor: () => ["ck-ghost"],
      });

      expect(verdict.ready).toBe(false);
      const reason = verdict.reasons.find((r) => r.kind === "blocked");
      expect(reason?.kind === "blocked" && reason.rawId).toBe("ck-ghost");
      // Must NOT have resolved through the alias — if this is ever defined,
      // resolveTier1 has been widened past tier 1 and this test must catch it.
      expect(
        reason?.kind === "blocked" && reason.resolvedTicket,
      ).toBeUndefined();
    });

    test("the SAME alias, reached through a TYPED cankan.deps entry, DOES read satisfied — blockedBy's pre-existing, disclosed exposure, pinned here (not a regression to fix)", () => {
      const { z, closeZ, aliasGhost } = boardWithNeutralizedGhost();
      const v = makeStoredTicket("ck-v", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-ghost" }] },
      });
      const state = foldState([v, z], [closeZ, aliasGhost], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-v" as TicketId, NO_FLAT_DEPS);

      // Asserting `ready: true` here pins the asymmetry `ready.ts`'s file
      // comment claims: the typed half goes through `blockedBy` in full and
      // is exposed to the alias attack; only the flat half (tested above) is
      // narrower.
      expect(verdict).toEqual({ ready: true, reasons: [] });
    });

    test("a reopen restores a blocker after a close event", () => {
      const blocker = makeStoredTicket("ck-z", "To Do");
      const dependent = makeStoredTicket("ck-v", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-z" }] },
      });
      const close = fixtureEvent(
        { event: "close", ticket: "ck-z" },
        "2026-01",
        0,
      );
      const reopen = fixtureEvent(
        { event: "reopen", ticket: "ck-z" },
        "2026-01",
        1,
      );
      const state = foldState([dependent, blocker], [close, reopen], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      expect(isReady(state, "ck-v" as TicketId, NO_FLAT_DEPS).ready).toBe(
        false,
      );
    });

    test("reopen recovers the composed close-plus-alias readiness attack", () => {
      const { z, closeZ, aliasGhost } = boardWithNeutralizedGhost();
      const dependent = makeStoredTicket("ck-v", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-ghost" }] },
      });
      const reopen = fixtureEvent(
        { event: "reopen", ticket: "ck-z" },
        "2026-01",
        2,
      );
      const attacked = foldState([dependent, z], [closeZ, aliasGhost], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });
      const recovered = foldState(
        [dependent, z],
        [closeZ, aliasGhost, reopen],
        { now: 0, leaseTtlMs: 1000, firstSeen: new Map() },
      );

      expect(isReady(attacked, "ck-v" as TicketId, NO_FLAT_DEPS).ready).toBe(
        true,
      );
      expect(isReady(recovered, "ck-v" as TicketId, NO_FLAT_DEPS).ready).toBe(
        false,
      );
    });
  });

  describe("Ruling R22(a) (fix round 2) — a TYPED dep resolved via blockedBy's alias tiering and a FLAT dep resolved directly, naming the SAME OPEN ticket, dedupe to ONE blocker", () => {
    // R12's own dedup test uses a CLOSED target and asserts satisfaction —
    // it cannot tell dedup-by-resolved-identity apart from dedup-by-raw-
    // string, because there is nothing left to report once satisfied. This
    // test uses an OPEN target so a blocker survives on both sides, and only
    // fails if the two sides were incorrectly deduped by their (different)
    // RAW ids rather than by the ticket each one actually resolves to.
    test("typed dep names an ALIAS that resolves to ck-open; flat dep names ck-open DIRECTLY — one blocked reason, not two", () => {
      const open = makeStoredTicket("ck-open", "To Do"); // open, unclaimed -- a real, outstanding blocker
      const aliasToOpen = fixtureEvent(
        { event: "alias", ticket: "ck-open", from: "ck-alias", to: "ck-open" },
        "2026-01",
        0,
      );
      const ticket = makeStoredTicket("ck-1", "To Do", {
        cankan: { deps: [{ type: "blocks", id: "ck-alias" }] },
      });
      const state = foldState([ticket, open], [aliasToOpen], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const verdict = isReady(state, "ck-1" as TicketId, {
        flatDependenciesFor: () => ["ck-open"],
      });

      expect(verdict.ready).toBe(false);
      const blockedReasons = verdict.reasons.filter(
        (r) => r.kind === "blocked",
      );
      expect(blockedReasons).toHaveLength(1);
      expect(
        blockedReasons[0]?.kind === "blocked" &&
          blockedReasons[0].resolvedTicket?.id,
      ).toBe("ck-open" as TicketId);
    });
  });

  describe("Ruling R28 (fix round 2) — isReady given no options (or options missing flatDependenciesFor) throws a coded error, not a bare TypeError", () => {
    test("no options argument at all -> throws DEPS_IS_READY_OPTIONS_REQUIRED, not a TypeError", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      // Cast past TypeScript's own required-parameter check -- this proves
      // the RUNTIME guard, which is what a JS caller (or an `as any` escape
      // hatch) actually hits.
      const isReadyUnsafe = isReady as unknown as (
        state: unknown,
        ticketId: unknown,
      ) => unknown;

      let threw = false;
      try {
        isReadyUnsafe(state, "ck-1" as TicketId);
      } catch (error) {
        threw = true;
        expect(error instanceof TypeError).toBe(false);
        expect(isCanKanError(error) && error.code).toBe(
          DepsErrorCodes.IS_READY_OPTIONS_REQUIRED,
        );
      }
      expect(threw).toBe(true);
    });

    test("options present but flatDependenciesFor is not a function -> throws the same coded error", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });
      const isReadyUnsafe = isReady as unknown as (
        state: unknown,
        ticketId: unknown,
        options: unknown,
      ) => unknown;

      let threw = false;
      try {
        isReadyUnsafe(state, "ck-1" as TicketId, { excludedLabels: [] });
      } catch (error) {
        threw = true;
        expect(error instanceof TypeError).toBe(false);
        expect(isCanKanError(error) && error.code).toBe(
          DepsErrorCodes.IS_READY_OPTIONS_REQUIRED,
        );
      }
      expect(threw).toBe(true);
    });
  });

  describe("Ruling R11 (fix round 1) — excludedLabels without labelsFor throws loudly instead of silently disabling every exclusion", () => {
    test("excludedLabels non-empty, labelsFor absent -> throws DEPS_EXCLUDED_LABELS_WITHOUT_LABELS_FOR", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      let threw = false;
      try {
        isReady(state, "ck-1" as TicketId, {
          ...NO_FLAT_DEPS,
          excludedLabels: ["icebox"],
        });
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(
          DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR,
        );
      }
      expect(threw).toBe(true);
    });

    test("excludedLabels EMPTY with labelsFor absent stays legal — no throw", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      expect(
        isReady(state, "ck-1" as TicketId, {
          ...NO_FLAT_DEPS,
          excludedLabels: [],
        }),
      ).toEqual({
        ready: true,
        reasons: [],
      });
    });
  });

  test("every applicable reason is reported together, not just the first", () => {
    const blocker = makeStoredTicket("ck-2", "In Progress");
    const ticket = makeStoredTicket("ck-1", "Done", {
      cankan: { deps: [{ type: "blocks", id: "ck-2" }] },
    });
    const closeEvent = fixtureEvent(
      { event: "close", ticket: "ck-1" },
      "2026-01",
      0,
    );
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-1",
        actor: "claude-code:alice/wt-a",
        lease_until: "2099-01-01T00:00:00Z",
      },
      "2026-01",
      1,
    );
    const state = foldState([ticket, blocker], [closeEvent, claim], {
      now: 0,
      leaseTtlMs: 1_000_000,
      firstSeen: new Map([[claim.event.id, 0]]),
    });

    const verdict = isReady(state, "ck-1" as TicketId, {
      ...NO_FLAT_DEPS,
      excludedLabels: ["icebox"],
      labelsFor: () => ["icebox"],
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.map((r) => r.kind).sort()).toEqual([
      "blocked",
      "claimed",
      "closed",
      "excluded-label",
    ]);
  });

  test("label comparison is case-sensitive (documented decision)", () => {
    const ticket = makeStoredTicket("ck-1", "To Do");
    const state = foldState([ticket], [], {
      now: 0,
      leaseTtlMs: 1000,
      firstSeen: new Map(),
    });

    const verdict = isReady(state, "ck-1" as TicketId, {
      ...NO_FLAT_DEPS,
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
    const closeEvent = fixtureEvent(
      { event: "close", ticket: "ck-closed" },
      "2026-01",
      0,
    );
    const blocker = makeStoredTicket("ck-blocker", "In Progress");
    const blocked = makeStoredTicket("ck-blocked", "To Do", {
      cankan: { deps: [{ type: "blocks", id: "ck-blocker" }] },
    });
    const claimedTicket = makeStoredTicket("ck-claimed", "In Progress");
    const claim = fixtureEvent(
      {
        event: "claim",
        ticket: "ck-claimed",
        actor: "claude-code:alice/wt-a",
        lease_until: "2099-01-01T00:00:00Z",
      },
      "2026-01",
      1,
    );

    const state = foldState(
      [ready, closedTicket, blocker, blocked, claimedTicket],
      [closeEvent, claim],
      {
        now: 0,
        leaseTtlMs: 1_000_000,
        firstSeen: new Map([[claim.event.id, 0]]),
      },
    );

    const sweep = readySet(state, NO_FLAT_DEPS);

    const golden: Record<
      string,
      { readonly ready: boolean; readonly reasonKinds: readonly string[] }
    > = {
      "ck-ready": { ready: true, reasonKinds: [] },
      "ck-closed": { ready: false, reasonKinds: ["closed"] },
      "ck-blocker": { ready: true, reasonKinds: [] },
      "ck-blocked": { ready: false, reasonKinds: ["blocked"] },
      "ck-claimed": { ready: false, reasonKinds: ["claimed"] },
    };

    expect(sweep.verdicts.size).toBe(5);
    for (const [id, expected] of Object.entries(golden)) {
      const verdict = sweep.verdicts.get(id as TicketId);
      expect(verdict?.ready).toBe(expected.ready);
      expect(
        (verdict?.reasons.map((r) => r.kind) as string[] | undefined)?.sort(),
      ).toEqual([...expected.reasonKinds].sort());
    }
    // No duplicated ids on this fixture board.
    expect(sweep.ambiguousIds).toEqual([]);
  });

  describe("Ruling R14 (fix round 1) — readySet surfaces duplicate ticket ids instead of silently omitting them", () => {
    test("a duplicated ticket id is absent from `verdicts` (it has no BoardState.tickets entry) but present in `ambiguousIds`", () => {
      const good = makeStoredTicket("ck-good", "To Do");
      const dupLower = makeStoredTicket("ck-dup", "To Do");
      const dupUpper = makeStoredTicket("CK-DUP", "Done");
      const state = foldState([good, dupLower, dupUpper], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      const sweep = readySet(state, NO_FLAT_DEPS);

      expect([...sweep.verdicts.keys()].map(String)).toEqual(["ck-good"]);
      expect(sweep.verdicts.has("ck-dup" as TicketId)).toBe(false);
      expect(sweep.ambiguousIds).toEqual(state.duplicateTicketIds);
      expect(sweep.ambiguousIds).toHaveLength(1);
      expect(String(sweep.ambiguousIds[0]?.ticketId)).toBe("ck-dup");
    });
  });

  describe("Ruling R23 (fix round 2) — readySet's options-misconfiguration guard fires even on an EMPTY board", () => {
    test("excludedLabels non-empty, labelsFor absent, on a board with ZERO tickets, still throws instead of silently returning an empty-but-valid-looking sweep", () => {
      const state = foldState([], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      let threw = false;
      try {
        readySet(state, { ...NO_FLAT_DEPS, excludedLabels: ["icebox"] });
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(
          DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR,
        );
      }
      // Pre-fix (round 1), this NEVER threw: state.tickets is empty, so
      // readySet's per-ticket loop body -- the only place the guard used to
      // live, inside isReady -- never ran even once, and readySet returned
      // `{ verdicts: Map(), ambiguousIds: [] }` as if nothing were wrong.
      expect(threw).toBe(true);
    });

    test("the SAME misconfiguration on a NON-empty board also throws (unaffected — this is not a special case for empty boards)", () => {
      const ticket = makeStoredTicket("ck-1", "To Do");
      const state = foldState([ticket], [], {
        now: 0,
        leaseTtlMs: 1000,
        firstSeen: new Map(),
      });

      let threw = false;
      try {
        readySet(state, { ...NO_FLAT_DEPS, excludedLabels: ["icebox"] });
      } catch (error) {
        threw = true;
        expect(isCanKanError(error) && error.code).toBe(
          DepsErrorCodes.EXCLUDED_LABELS_WITHOUT_LABELS_FOR,
        );
      }
      expect(threw).toBe(true);
    });
  });
});
