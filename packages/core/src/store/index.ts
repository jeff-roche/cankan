/**
 * `store/index.ts` — the public surface of M2.5 (the ticket store: CRUD over
 * one board's tickets directory). Follows `board/index.ts`'s /
 * `events/index.ts`'s doc-comment discipline: re-export exactly what
 * downstream lanes need, nothing else.
 *
 * ---- the store itself -------------------------------------------------
 *
 * `openTicketStore` and its options/result types, plus `StoredTicket` — the
 * concrete element type M2.8's `state/fold.ts` takes `tickets` as an array
 * of, so that lane cites this type rather than inventing its own.
 *
 * ---- re-exported for M2.8 (Ruling R11) ---------------------------------
 *
 * `normalizeTicketIdForComparison` and `TicketIdLookupKey` are re-exported
 * here even though they are `ticket/id.ts`'s own exports. M2.8's `Depends
 * on` is #28 (this module) and #30 (M2.7) — not #25 (`ticket/`) — so it
 * cannot import `ticket/` to get the normalizer itself, yet it must compare
 * an `Event.ticket` (already lowercased on the event side) against a
 * frontmatter `id` the same way this module's own `get()` does. Re-exporting
 * the one normalizer here means a third independent `.toLowerCase()` never
 * gets written.
 *
 * ---- deliberately withheld ---------------------------------------------
 *
 * - `assertSafeTicketPath` and `buildTempTicketFilename` (`ticketStore.ts`)
 *   are exported from that file for tests to reach directly by relative
 *   import — the same pattern `git.test.ts` uses to reach
 *   `git/adapter.ts`'s `updateRefCASCore` — but are not part of this public
 *   surface: a caller has no legitimate use for either one directly, only
 *   through `list()`/`get()`/`write()`/`remove()`/`archive()`.
 * - Every other internal helper in `ticketStore.ts` (the directory scan, the
 *   atomic-write plumbing, the id-index builder) is not exported at all.
 * - This module never reads the event log — see `ticketStore.ts`'s own file
 *   comment for why (PLAN.md's M2.8 `Wires` line: `state/fold.ts` is the
 *   *only* module that combines ticket files and events).
 */

export { StoreErrorCodes } from "./errors";
export type { ListTicketsResult, OpenTicketStoreOptions, SkippedTicket, StoredTicket, TicketStore } from "./ticketStore";
export { openTicketStore } from "./ticketStore";

export { normalizeTicketIdForComparison } from "../ticket/index";
export type { TicketIdLookupKey } from "../ticket/index";
