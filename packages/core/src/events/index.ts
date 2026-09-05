/**
 * Public surface of the event log (M2.7 dispatches 1-3: schema, append/read,
 * ref init, the lease-observation store). The poisoned-ref recovery path
 * (dispatch 4) appends its own exports here later.
 *
 * **Deliberately not re-exported here**: `appendCore` (`log.ts`) and
 * `initRefCore` (`ref.ts`) — the test-only seams behind `append`/`initRef`.
 * A test reaches them via a relative import to the source file (the same
 * pattern `git.test.ts` uses for `updateRefCASCore`), never through this
 * module's public surface.
 */

export {
  canonicalizeTicketId,
  EVENT_KINDS,
  isValidEventId,
  parseEvent,
  PROJECT_EPOCH,
} from "./schema";
export type {
  AliasEvent,
  CloseEvent,
  ClaimEvent,
  CommentEvent,
  CreateEvent,
  Event,
  EventId,
  EventKind,
  EventValidationFailure,
  EventValidationIssue,
  ExpireEvent,
  ExternalWriteEvent,
  HookEvent,
  MoveEvent,
  ParseEventOptions,
  ParseEventResult,
  ReleaseEvent,
  RenewEvent,
  TakeoverEvent,
} from "./schema";

export { EventErrorCodes } from "./errors";

// `monthKeyUtc`, `splitJsonlLines`, and `validateNowForDateFormatting`
// (`log.ts`) are module-internal helpers shared between `log.ts` and
// `ref.ts` (and used directly by tests) — not part of the public surface.
// No downstream task's brief asks for any of them as a standalone utility
// (constraint 7).
export { append, read } from "./log";
export type { AppendedEvent, AppendOptions, EventCandidate, EventRecord, ReadOptions } from "./log";

export { initRef } from "./ref";
export type { InitRefOptions } from "./ref";

// The lease-observation store (M2.7 dispatch 3, ADR 0001 failure mode 7).
// **Standalone API, not wired into `read()` — Ruling R6.** M2.10 calls
// `observe()`/`discard()` itself, on its own read/fold paths; see
// `observations.ts`'s doc comment for exactly when.
export { boardKeyFor, discard, firstSeen, observe } from "./observations";
export type { ObserveOptions } from "./observations";
