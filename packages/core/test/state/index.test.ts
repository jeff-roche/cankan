import { describe, expect, test } from "bun:test";
import * as core from "../../src/index";
import type {
  BlockingDependency,
  BoardState,
  DuplicateTicketId,
  FoldStateOptions,
  LeaseState,
  ObserveAndFoldOptions,
  OrphanedTicketEvents,
  OrphanedTicketEventsCause,
  TicketState,
} from "../../src/state/index";
import type { Equal, Expect } from "../typeLevel";

/**
 * Asserts the exact value-export surface of `state/index.ts`, reached
 * through the frozen root entry (`core.state`) the same way any consumer
 * would — the same pattern `test/ticket/index.test.ts` uses for
 * `core.ticket`. Type-only exports (`BoardState`, `FoldStateOptions`,
 * `LeaseState`, `ObserveAndFoldOptions`, `OrphanedTicketEvents`,
 * `OrphanedTicketEventsCause`, `DuplicateTicketId`, `TicketState`,
 * `BlockingDependency`) carry no runtime value and so are not — and cannot
 * be — asserted at runtime; they are exercised by every other test file in
 * `test/state/` that imports them, **and** pinned at compile time below
 * (checked by `bun run typecheck`, not `bun test` — see `test/typeLevel.ts`'s
 * own file comment).
 */

/**
 * Compile-time only. Importing every type-only export **from
 * `state/index.ts` itself** (never from `./fold`/`./queries` directly)
 * means removing one from that file's `export type { ... }` block fails
 * `bun run typecheck` immediately, instead of silently drifting out of sync
 * with the doc comment above and this file's own claim that every one of
 * these "is exercised by every other test file" (fix round 7, security/code
 * review: `OrphanedTicketEventsCause` was the type of a newly-public
 * `OrphanedTicketEvents.cause` field but was missing from `state/index.ts`'s
 * export list for a full review round — a consumer could observe the value
 * but not name the type without reaching into `fold.ts`, which that file's
 * own header disclaims as internal. Nothing runtime-checkable would have
 * caught that; this would).
 */
export type StateIndexPublicTypesAreAllExported = [
  BoardState,
  DuplicateTicketId,
  FoldStateOptions,
  LeaseState,
  ObserveAndFoldOptions,
  OrphanedTicketEvents,
  OrphanedTicketEventsCause,
  TicketState,
  BlockingDependency,
];

/** The exact shape that went missing in fix round 6 — pinned so it can't silently widen or narrow either. */
export type OrphanedTicketEventsCauseAssertion = Expect<
  Equal<OrphanedTicketEventsCause, "no-matching-ticket" | "duplicate-ticket-id">
>;
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
