/**
 * Module-local error codes for `state/` (M2.8, the board state fold), per
 * `../errors.ts`'s file-level comment: `CanKanError.code` is a plain, open
 * `string`, and a code specific to one module's domain is declared in that
 * module's own folder rather than in the shared `errors.ts` — mirroring
 * `store/errors.ts` and `events/errors.ts`.
 *
 * **Prefixed `STATE_`** (following `store/`'s and `events/`'s own prefix
 * convention, not `board/`'s outlier).
 *
 * Every `details` value attached to one of these codes is something this
 * module itself chose (a caller-supplied number, an already-branded ticket
 * id) — never raw event/ticket file content — the same "report which rule
 * failed" discipline `store/errors.ts` and `events/errors.ts` already
 * document.
 */
export const StateErrorCodes = {
  /**
   * `FoldStateOptions.leaseTtlMs` / `ObserveAndFoldOptions.leaseTtlMs` was
   * not a positive, finite number. Ruling R7 makes `leaseTtlMs` a caller
   * argument the fold never fetches from config itself — this is the fold's
   * own defence against a garbage value reaching it anyway (a `0` or
   * negative TTL would make every lease permanently expired-on-arrival, a
   * silent wrong answer rather than a loud one; `NaN`/`Infinity` propagate
   * unusably into every `expiresAtMs` computation).
   */
  INVALID_LEASE_TTL: "STATE_INVALID_LEASE_TTL",
  /**
   * A query in `state/queries.ts` (`blockedBy`) was asked about a
   * `TicketId` that is not present in the `BoardState` it was handed — a
   * caller passing a stale id, or an id from a different board's fold.
   * Distinct from `store/`'s `TICKET_NOT_FOUND`: that one is a lookup
   * against the filesystem; this one is a lookup against an in-memory fold
   * result the caller already has in hand, so a miss here is a caller
   * programming error, not an ordinary "not found" outcome to shrug off.
   */
  TICKET_NOT_IN_BOARD_STATE: "STATE_TICKET_NOT_IN_BOARD_STATE",
  /**
   * `blockedBy` was asked about a `TicketId` that is **ambiguous**, not
   * absent — either the id appears in `BoardState.duplicateTicketIds`
   * (Ruling D1: more than one `StoredTicket` declared it, so it was
   * excluded from `BoardState.tickets` entirely), or — defence in depth,
   * unreachable via the real fold but not via a hand-built `BoardState` —
   * more than one entry in `tickets` itself matches. Deliberately distinct
   * from `TICKET_NOT_IN_BOARD_STATE` (fix round 6, security/code review):
   * "missing" and "ambiguous" are opposite failures with opposite remedies,
   * and a caller catching one code should not have to string-match the
   * message to tell which actually happened.
   */
  TICKET_ID_AMBIGUOUS: "STATE_TICKET_ID_AMBIGUOUS",
} as const;
