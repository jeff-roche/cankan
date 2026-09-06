/**
 * Module-local error codes for `claims/` (M2.10), per `../errors.ts`'s
 * file-level comment: `CanKanError.code` is a plain, open `string`, and a
 * code specific to one module's domain is declared in that module's own
 * folder rather than in the shared `errors.ts` — mirroring `state/errors.ts`
 * (the cleanest exemplar) and `events/errors.ts`.
 *
 * **The code split is a ruling, not this module's own judgment call.**
 * `../errors.ts`'s **shared** `ErrorCodes.CLAIM_REJECTED` is used for every
 * "you asked to hold this ticket and you do not" outcome — that single code
 * is what M3.10 maps to CLI exit 3 (issue #33's Done-when), and every such
 * outcome shares `details: { reason, ticket, holder?, limit? }` (a flat
 * shape distinguishing the sub-cases by `reason`, never by a different
 * code). The `CLAIM_*` codes below are for everything else: input/operational
 * failures that are not a claim rejection at all — an unresolvable ticket
 * reference, a malformed duration string, a malformed option — and so must
 * not map to the same exit code a genuine rejection does.
 *
 * **Every `details` value attached to one of these codes is something this
 * module itself chose — never a peer-supplied value off the shared
 * coordination ref.** `ticket` mirrors back the user's own CLI argument
 * (their own local input, not attacker-controlled network content, so
 * echoing it is helpful rather than a leak); `holder` names an actor id per
 * the sanctioned exception `../errors.ts` documents for this exact case.
 * Nothing here ever echoes a raw config value or duration string that failed
 * a check — the same "report which rule failed, never the value that failed
 * it" discipline `events/errors.ts`'s window/ticket/since validators already
 * apply.
 */
export const ClaimErrorCodes = {
  /**
   * `claim()`'s ticket-resolution step (`resolveTicket`, `claim.ts`) found
   * no ticket in `BoardState.tickets` whose `id` or `displayId` matches the
   * caller's `ticket` argument under `normalizeTicketIdForComparison`.
   * **Never raised for an alias match** — this module resolves by `id` and
   * `displayId` only (see `claim.ts`'s own doc comment on why alias
   * resolution is out of scope for a write).
   */
  TICKET_NOT_FOUND: "CLAIM_TICKET_NOT_FOUND",
  /**
   * `claim()`'s ticket-resolution step found the caller's `ticket` argument
   * inside `BoardState.duplicateTicketIds` — more than one on-disk ticket
   * file declares this normalized id, so there is no single ticket safe to
   * claim. Checked **before** matching against `BoardState.tickets` (Ruling
   * D1: an id excluded from `tickets` because it is ambiguous must never be
   * read as "not found," which this module could otherwise silently
   * mis-resolve as a request to create/claim something that does not
   * exist).
   */
  TICKET_AMBIGUOUS: "CLAIM_TICKET_AMBIGUOUS",
  /**
   * `duration.ts`'s `parseDurationMs` was given a value that is not a
   * string matching `/^\d+(ms|s|m|h|d|w)$/`, or one that parses to a
   * non-positive, non-finite, or absurdly large number of milliseconds (one
   * that would push `claim.ts`'s lease-derived `trailingMonths` past the
   * `[1, 120]` month window `read()` accepts). Raised for both
   * `config.claims.lease` (the board's configured lease) and a caller's own
   * `--lease` override — either one reaches the same parser.
   */
  INVALID_LEASE_DURATION: "CLAIM_INVALID_LEASE_DURATION",
  /**
   * A `claim()` parameter (or one of its sub-fields) was shaped wrong,
   * discovered before any git invocation — currently: `ClaimParams.casRetry`
   * itself must not be `null`; its `maxAttempts`, if supplied, must be an
   * integer `>= 2` (the reclaim path — `expire` then `claim` — spends one
   * attempt each, so `maxAttempts: 1` would always fail an idle repo with a
   * confusing `GIT_CAS_CONTENTION_EXCEEDED` instead of ever completing a
   * legitimate reclaim) and at most the same upper bound `events/log.ts`
   * applies to its own `casRetry.maxAttempts`; its `backoffMs`/`sleep`, if
   * supplied, must be functions, and any value `backoffMs` returns must be a
   * finite, non-negative number within the same bound `events/log.ts`
   * enforces on its own `backoffMs` — `withCasRetry` (`git/retry.ts`)
   * validates none of this itself, and this module calls it directly
   * (unlike `append`, which validates a caller's `casRetry` before ever
   * forwarding it).
   */
  INVALID_OPTION: "CLAIM_INVALID_OPTION",
} as const;
