import { describe, expect, test } from "bun:test";
import * as core from "../../src/index";

/**
 * Asserts the exact value-export surface of `store/index.ts`, reached
 * through the frozen root entry (`core.store`) the same way any consumer
 * would -- the `test/ticket/index.test.ts` precedent applied to M2.5. Type-
 * only exports (`OpenTicketStoreOptions`, `TicketStore`, `StoredTicket`,
 * `ListTicketsResult`, `SkippedTicket`, `TicketIdLookupKey`) carry no runtime
 * value and so cannot be asserted here.
 */
describe("core.store — the M2.5 public surface", () => {
  test("exposes exactly the documented value exports", () => {
    const expected = ["openTicketStore", "StoreErrorCodes", "normalizeTicketIdForComparison"].sort();
    expect(Object.keys(core.store).sort()).toEqual(expected);
  });

  test("every value export is a function, except the one data constant", () => {
    for (const [name, value] of Object.entries(core.store)) {
      if (name === "StoreErrorCodes") {
        expect(value, name).toBeTypeOf("object");
      } else {
        expect(value, name).toBeTypeOf("function");
      }
    }
  });
});
