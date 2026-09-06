/**
 * `state/index.ts` — the public surface of M2.8 (the board state fold).
 * Follows `board/index.ts`'s / `events/index.ts`'s doc-comment discipline:
 * re-export exactly what downstream lanes need, nothing else.
 *
 * ---- the fold itself ----------------------------------------------------
 *
 * `foldState` — PURE, no I/O — and `observeAndFold`, the thin async wrapper
 * that performs M2.7's contract 2 (`observe()` on every `claim`/`takeover`/
 * `renew`) and delegates to `foldState`. See `fold.ts`'s own file comment
 * for the full design: why there are two functions (Ruling R7), the
 * `(month, line)` tie-break (Ruling R12), the status precedence rule
 * (Ruling R6), and the `close`/`reopen` gap (Ruling R14).
 *
 * ---- queries over an already-folded `BoardState` -------------------------
 *
 * `byStatus`, `claimedBy`, `blockedBy` — read-only views over a
 * `BoardState` the fold already produced, never a second fold over raw
 * tickets/events (`state/queries.ts`'s own file comment).
 *
 * ---- this module's own error codes ---------------------------------------
 *
 * `StateErrorCodes` — currently just `INVALID_LEASE_TTL` (a caller-supplied
 * `leaseTtlMs` that is not a positive finite number) and
 * `TICKET_NOT_IN_BOARD_STATE` (`blockedBy` asked about an id its
 * `BoardState` does not contain).
 *
 * ---- deliberately withheld -------------------------------------------------
 *
 * - `LeaseAnchorKind` and every other internal type/function in `fold.ts`
 *   (`compareChainPosition`, `joinEventsToTickets`, `resolveLeaseAnchor`,
 *   `foldLease`, `foldStatusAndClose`, `resolveAllAliasTargets`,
 *   `resolveCycleAndTail`, `buildAliasEventIndex`, `mergeAliases`,
 *   `validateLeaseTtlMs`) and `queries.ts` (`buildIdentifierIndex`,
 *   `looksCrossBoard`) are internal folding/query machinery, not part of the
 *   public surface a caller should build on directly.
 * - `fold.ts`'s `resolveAliasTargetForTesting` **is** exported from that
 *   file directly (the same pattern `ticketStore.ts`'s
 *   `assertSafeTicketPath` uses for `store/ticketStore.test.ts` — a test
 *   reaches it via a relative import to the source file), but is not
 *   re-exported here: it is the pre-memoization reference walk
 *   `fold.test.ts` checks the real (memoized) alias resolution against, not
 *   something a caller has any use for.
 * - `discard()` — the observation-store's release-time cleanup — is **not**
 *   re-exported here, and is not even imported by `fold.ts`. That belongs
 *   with `expireStale()` in M2.10; this module only ever calls `observe()`.
 * - This module never re-exports anything from `ticket/` (M2.2) or `board/`
 *   (M2.4) directly — its `Depends on` is `store/` (M2.5) and `events/`
 *   (M2.7) only (PLAN.md rule 2). `TicketId`, `ActorId` come from `../types`
 *   and are already re-exported flat from the package root; this file does
 *   not re-export them again.
 */

export { StateErrorCodes } from "./errors";

export type {
  BoardState,
  FoldStateOptions,
  LeaseState,
  ObserveAndFoldOptions,
  OrphanedTicketEvents,
  TicketState,
} from "./fold";
export { foldState, observeAndFold } from "./fold";

export type { BlockingDependency } from "./queries";
export { blockedBy, byStatus, claimedBy } from "./queries";
