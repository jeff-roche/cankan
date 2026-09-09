import { describe, expect, test } from "bun:test";
import * as core from "../../src/index";

/**
 * Asserts the exact value-export surface of `ticket/index.ts`, reached
 * through the frozen root entry (`core.ticket`) the same way any consumer
 * would. Type-only exports (`ParsedTicket`, `ParsedTicketFilename`,
 * `TicketIdLookupKey`, `CankanBlock`, `TicketFrontmatter`) carry no runtime
 * value and so are not — and cannot be — asserted here; they are exercised
 * by the `@ts-expect-error`/`Expect<Equal<...>>` type-level assertions in
 * `test/ticket/id.test.ts` and by every other ticket test file importing
 * them.
 */
describe("core.ticket — the M2.2 public surface", () => {
  test("exposes exactly the documented value exports", () => {
    const expected = [
      "buildTicketFilename",
      "parseTicketFilename",
      "slugifyTitle",
      "parseTicketFile",
      "serializeTicketFile",
      "setCankanBlock",
      "setScalarField",
      "setSequenceField",
      "create",
      "move",
      "close",
      "generateTicketId",
      "keepOnDiskIdCasing",
      "normalizeTicketIdForComparison",
      "ticketFrontmatterSchema",
      "TicketErrorCodes",
    ].sort();
    expect(Object.keys(core.ticket).sort()).toEqual(expected);
  });

  test("every value export is a function, except the two data constants", () => {
    const dataConstants = new Set([
      "ticketFrontmatterSchema",
      "TicketErrorCodes",
    ]);
    for (const [name, value] of Object.entries(core.ticket)) {
      if (dataConstants.has(name)) {
        expect(value, name).toBeTypeOf("object");
      } else {
        expect(value, name).toBeTypeOf("function");
      }
    }
  });
});
