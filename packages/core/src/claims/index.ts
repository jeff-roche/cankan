/**
 * `claims/index.ts` — the public surface of M2.10 slice 1: `claim()`, its
 * parameter/result types, this module's own error codes, and the duration
 * parser it depends on.
 *
 * **Deliberately not re-exported here**: `claimCore` (`claim.ts`) — the
 * test-only seam behind `claim` — and its `ClaimHooks` type. A test reaches
 * them via a relative import to the source file, the same pattern
 * `events/index.ts` documents for `appendCore`/`initRefCore`/`recoverCore`.
 *
 * `renew`, `release`, `expireStale`, and the observation-id discard sweep
 * are slice 2 — not built yet.
 */

export { claim } from "./claim";
export type { ClaimParams, ClaimResult } from "./claim";

export { ClaimErrorCodes } from "./errors";

export { parseDurationMs } from "./duration";
