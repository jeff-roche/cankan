/**
 * `claims/index.ts` — the public surface of M2.10: `claim`, `renew`,
 * `release`, `expireStale`, their parameter/result types, this module's own
 * error codes, and the duration parser they depend on.
 *
 * **Deliberately not re-exported here**: `claimCore`/`renewCore`/
 * `releaseCore`/`expireStaleCore` (`claim.ts`) — the test-only seams behind
 * `claim`/`renew`/`release`/`expireStale` — and their `ClaimHooks`/
 * `RenewHooks`/`ReleaseHooks`/`ExpireStaleHooks` types. A test reaches them
 * via a relative import to the source file, the same pattern
 * `events/index.ts` documents for `appendCore`/`initRefCore`/`recoverCore`.
 */

export { claim, expireStale, release, renew } from "./claim";
export type {
  ClaimParams,
  ClaimResult,
  ExpireStaleParams,
  ExpireStaleResult,
  ExpireStaleTicketResult,
  ReleaseParams,
  ReleaseResult,
  RenewParams,
  RenewResult,
} from "./claim";

export { ClaimErrorCodes } from "./errors";

export { parseDurationMs } from "./duration";
