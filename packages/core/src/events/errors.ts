/**
 * Module-local error codes for `events/`, per `../errors.ts`'s file-level
 * comment: `CanKanError.code` is a plain, open `string`, and a code specific
 * to one module's domain is declared in that module's own folder rather than
 * in the shared `errors.ts` — mirroring `git/errors.ts`.
 *
 * Prefixed `EVENT_` for the same collision-avoidance reason `git/errors.ts`
 * documents for its own `GIT_` prefix.
 *
 * **Every `details` value attached to one of these codes is, by
 * construction, something CanKan itself chose** — a ref name, a month file
 * path, a zero-based line index, an already-schema-validated event id (whose
 * ULID grammar admits no escape sequence) — **never the raw bytes of a
 * rejected line.** That is obligation E, routed here from dispatch 1's
 * security review: `../errors.ts:44-52` already establishes that `details`
 * is published by default, and `ticket/filename.ts`'s `assertSafeId` already
 * sets the precedent this module follows — report which rule failed, never
 * the value that failed it. A terminal escape sequence embedded in a
 * rejected line must never reach a user's terminal by way of this module's
 * own error reporting; the raw bytes are dispatch 4's audit record to
 * preserve and render safely, not this module's to echo.
 */
export const EventErrorCodes = {
  /**
   * `append()`'s own `parseEvent(JSON.stringify(candidate))` check (Ruling
   * R11) failed — the constructed candidate, once minted with an id and
   * serialized to the exact bytes that would be committed, does not satisfy
   * `events/schema.ts`. Raised before any git invocation.
   */
  EVENT_APPEND_REJECTED: "EVENT_APPEND_REJECTED",
  /**
   * `append()`'s own read-check step found the current month file did not
   * end with a trailing newline (ADR 0001:696-699's "check" step,
   * generalized). Appending onto an un-terminated tail would fuse this
   * module's own new line onto a peer's truncated one, corrupting both —
   * fail-closed rather than heal-or-corrupt silently.
   */
  EVENT_LOG_MALFORMED_BLOB: "EVENT_LOG_MALFORMED_BLOB",
  /**
   * `read()` found a line whose byte length exceeds `MAX_LINE_BYTES`
   * (obligation A) — rejected *before* `parseEvent` (and therefore before
   * `JSON.parse`) ever sees it, so the allocation obligation A warns about
   * never happens.
   */
  EVENT_LOG_LINE_TOO_LARGE: "EVENT_LOG_LINE_TOO_LARGE",
  /**
   * `read()` found a month blob whose total byte length exceeds
   * `MAX_MONTH_BLOB_BYTES`. Unlike the line-level cap above, this check runs
   * *after* `readBlobFromRef` has already returned the whole string —
   * `GitAdapter` gives no way to size-check before materializing it — so
   * this is a sanity/resource bound on already-allocated content, not a
   * pre-allocation DoS guard the way the line cap is. See `log.ts`'s doc
   * comment on `MAX_MONTH_BLOB_BYTES` for the full reasoning.
   */
  EVENT_LOG_BLOB_TOO_LARGE: "EVENT_LOG_BLOB_TOO_LARGE",
  /**
   * `read()` found a line that is not valid JSON, or is valid JSON that
   * fails `events/schema.ts` (ADR 0001:716-723, fm8, fm11). Fail-closed: the
   * whole read aborts rather than skipping the offending line, per ADR
   * 0001:828-838. `details` carries the ref, month file, and zero-based line
   * index so dispatch 4's recovery path can locate the offending line
   * without re-deriving it — never the line's own content (obligation E).
   */
  EVENT_LOG_LINE_INVALID: "EVENT_LOG_LINE_INVALID",
  /**
   * `read()` found two lines sharing one event id whose raw bytes differ
   * (ADR 0001:738-742). A byte-identical duplicate is silently folded into
   * one event; a duplicate whose bytes differ is a sign of a hostile or
   * buggy peer and aborts the read rather than silently picking a survivor.
   */
  EVENT_LOG_DUPLICATE_ID_CONFLICT: "EVENT_LOG_DUPLICATE_ID_CONFLICT",
  /**
   * `initRef()`'s single re-read after a lost `parent: null` race still
   * found the ref absent. Not part of the two-process contention this phase
   * targets (a rejection there means "someone else's write already
   * applied," and a re-read finding nothing would mean that write vanished
   * again between the rejection and the re-read) — surfaced as a hard error
   * rather than silently looping.
   */
  EVENT_REF_INIT_RACE_UNRESOLVED: "EVENT_REF_INIT_RACE_UNRESOLVED",
  /**
   * `initRef()` found the ref already pointing at *something* (`readRef`
   * returned non-null), but that something does not behave like a usable
   * coordination ref (fix round 1, S3) — e.g. a ref planted directly at a
   * blob, which fails the tree-ish check every later `append`/`read`
   * ultimately depends on. Raised instead of `initRef` silently reporting
   * success. **Known residual gap** (Orchestrator Ruling R19): a ref
   * planted at a raw tree or an annotated tag peeling to one is *also*
   * unusable but is not detected by this code — see `ref.ts`'s
   * `assertRefIsUsable` doc comment for why, and for the M2.6 addition
   * (an object-type query) that would close it.
   */
  EVENT_REF_UNUSABLE: "EVENT_REF_UNUSABLE",
} as const;
