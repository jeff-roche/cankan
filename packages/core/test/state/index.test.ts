import { describe, expect, test } from "bun:test";
import * as core from "../../src/index";

/**
 * Asserts the exact value-export surface of `state/index.ts`, reached
 * through the frozen root entry (`core.state`) the same way any consumer
 * would — the same pattern `test/ticket/index.test.ts` uses for
 * `core.ticket`. Type-only exports (`BoardState`, `FoldStateOptions`,
 * `LeaseState`, `ObserveAndFoldOptions`, `OrphanedTicketEvents`,
 * `OrphanedTicketEventsCause`, `DuplicateTicketId`, `TicketState`,
 * `BlockingDependency`) carry no runtime value and so are not — and cannot
 * be — asserted here; they are exercised by every other test file in
 * `test/state/` that imports them.
 */
describe("core.state — the M2.8 public surface", () => {
  test("exposes exactly the documented value exports", () => {
    const expected = ["StateErrorCodes", "foldState", "observeAndFold", "blockedBy", "byStatus", "claimedBy"].sort();
    expect(Object.keys(core.state).sort()).toEqual(expected);
  });

  test("every value export is a function, except the one data constant", () => {
    for (const [name, value] of Object.entries(core.state)) {
      if (name === "StateErrorCodes") {
        expect(value, name).toBeTypeOf("object");
      } else {
        expect(value, name).toBeTypeOf("function");
      }
    }
  });

  test("StateErrorCodes carries exactly the three documented codes, each STATE_-prefixed", () => {
    expect(core.state.StateErrorCodes).toEqual({
      INVALID_LEASE_TTL: "STATE_INVALID_LEASE_TTL",
      TICKET_NOT_IN_BOARD_STATE: "STATE_TICKET_NOT_IN_BOARD_STATE",
      TICKET_ID_AMBIGUOUS: "STATE_TICKET_ID_AMBIGUOUS",
    });
  });
});
