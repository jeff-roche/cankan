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
   * An `AppendOptions` field (or a value returned by one) was shaped
   * wrong. Raised before any git invocation, at seven sites:
   * - `maxExistingBlobBytes` (fix round 2, Low; fix round 4, Low 2):
   *   must be `>= 0` (`Number.POSITIVE_INFINITY` — the documented
   *   recovery-write bypass — is explicitly allowed). `typeof v !==
   *   "number"` is checked explicitly, not just `Number.isNaN`/`< 0`:
   *   `Number.isNaN` does not coerce, so a non-number value (a string, an
   *   object) is neither `NaN` nor `< 0` in JavaScript's own comparison
   *   semantics and previously passed both checks, silently disabling the
   *   cap.
   * - `ulidFactory` (fix round 5, Medium C): must be a function — a
   *   non-function value throws a raw, unwrapped `TypeError` the moment
   *   `append` calls it.
   * - `casRetry` itself (fix round 5, Low D): must not be `null` —
   *   `null?.foo` optional-chains safely to `undefined` everywhere this
   *   module checks a sub-field, so `null` previously slipped past every
   *   one of them and died *inside* `withCasRetry` (M2.6) instead.
   * - `casRetry.maxAttempts` (fix round 3 sweep, Ruling R27): must be a
   *   finite integer in `[1, MAX_CAS_ATTEMPTS]` (`log.ts`) —
   *   `withCasRetry`'s own loop bound does not validate this itself,
   *   confirmed directly (`Infinity` makes the loop unbounded; `NaN`
   *   makes it never run even once).
   * - `casRetry.backoffMs` itself (fix round 5, High B): must be a
   *   function, checked at option-validation time rather than only inside
   *   the wrapper described next — `backoffMs` is only ever called
   *   between a failed attempt and the next one, so an uncontended board
   *   never triggers a non-function value's `TypeError`, and the crash
   *   would otherwise arrive the first time two workers actually race.
   * - `casRetry.backoffMs`'s *return value* (fix round 4, Medium 2): must
   *   be a finite number in `[0, MAX_BACKOFF_MS]` — an in-range
   *   `setTimeout` delay is not clamped the way an out-of-range one is,
   *   confirmed directly that an otherwise-valid ~24.8-day delay is
   *   genuinely scheduled (and keeps the process alive) rather than
   *   firing immediately, defeating the same "bounded retry" obligation
   *   `maxAttempts` closes for attempt count, reachable instead through
   *   backoff duration.
   * - `casRetry.sleep` itself (fix round 5, Low D): must be a function —
   *   its behavior once confirmed to be one remains entirely the
   *   caller's own responsibility.
   */
  EVENT_APPEND_INVALID_OPTION: "EVENT_APPEND_INVALID_OPTION",
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
   * A single month blob's total byte length exceeds `MAX_MONTH_BLOB_BYTES`.
   * Raised in two places, sharing one code because they are the same bound
   * enforced at the two points that can observe it: `read()`, checking a
   * blob it just fetched via `readBlobFromRef` (necessarily *after* the
   * whole string is already materialized — `GitAdapter` gives no way to
   * size-check first, so this is a sanity/resource bound on already-
   * allocated content, not a pre-allocation DoS guard the way the line cap
   * is), and `append()` (fix round 1, S2), checking the *existing* blob
   * it is about to extend, before building the new commit — closing the gap
   * where a write could grow a month past what a read would ever accept.
   * See `log.ts`'s doc comment on `MAX_MONTH_BLOB_BYTES` for the full
   * reasoning.
   */
  EVENT_LOG_BLOB_TOO_LARGE: "EVENT_LOG_BLOB_TOO_LARGE",
  /**
   * `read()`'s aggregate cap (fix round 1, S2): the *sum* of every trailing
   * month's blob size in one `read()` call's window exceeds
   * `MAX_AGGREGATE_READ_BYTES`. The per-month cap above bounds one file;
   * without a separate aggregate bound, a caller passing a large
   * `trailingMonths` (M2.10's own documented contract on that parameter)
   * could still be asked to hold `trailingMonths × MAX_MONTH_BLOB_BYTES` in
   * memory at once — e.g. 1.5 GiB for a 24-month window at 64 MiB/month —
   * which is a resource bound the per-month cap alone does not express.
   */
  EVENT_LOG_AGGREGATE_TOO_LARGE: "EVENT_LOG_AGGREGATE_TOO_LARGE",
  /**
   * One of `read`'s window/cursor-shaping inputs was invalid — one of:
   * `read()`'s own `trailingMonths` was not a finite integer in the
   * accepted range (fix round 1, S1; **`append` has no `trailingMonths`
   * parameter** — an earlier version of this comment wrongly implied it
   * did, a fix-round-2 correction); `read`'s/`append`'s shared `now`
   * clock reading was outside the domain its actual consumer (date
   * formatting, or — `append` only — a ULID factory) can represent (fix
   * round 2, NEW-2; tightened in fix round 3, M1 — `Number.isFinite` alone
   * was not a tight enough bound); or `read`'s `since` was not a valid
   * ULID event id (fix round 4, Medium 1 — the fix-round-3 sweep's
   * invariant said "every *numeric* option," so this string option was
   * never checked).
   *
   * Degenerate `trailingMonths` values (`0`, a negative number, `NaN`)
   * previously produced an empty month-key list and made `read()` resolve
   * `[]` with no error — a fail-open in the one module whose whole
   * disposition is fail-closed. A pathologically large value (a hostile,
   * unbounded-digit config-derived lease producing `Infinity`, say)
   * previously drove a synchronous, unbounded loop. `now: NaN`/`Infinity`
   * has the identical fail-open effect in `read()` (a month-key window of
   * months that cannot exist) via a different, sibling parameter — not
   * peer-reachable, but reachable from an upstream `Date.parse` failure
   * with no attacker at all. An invalid `since` is the most consequential
   * of the three: `id > since` is a lexicographic string comparison that
   * JavaScript performs against *any* string without throwing, so a
   * malformed cursor (a lowercased-but-otherwise-real ULID, or a
   * degenerate value like `null`/`{}`/`0` coerced through) does not
   * surface as an empty-window edge case — it silently makes every real
   * event's `id` compare as "not greater than," so `read()` returns `[]`
   * on a board that has events. All three are rejected here, before
   * either failure mode can occur.
   *
   * **`since`'s own validator needed a second fix (fix round 5, Low F).**
   * `isValidEventId`'s `ULID_PATTERN.test(value)` coerces its argument via
   * `ToString` — confirmed directly that a `Symbol` throws a raw,
   * unwrapped `TypeError` ("Cannot convert a symbol to a string") and an
   * object with a throwing `toString` lets that object's own error escape
   * straight out of `read()`, neither as a `CanKanError`. A `typeof value
   * !== "string"` check before the pattern test, short-circuiting before
   * either coercion path runs, closes both.
   *
   * **`ticket` shares the same shape (fix round 4, corrected sweep) but a
   * different message**, since it fails at a different consumer
   * (`canonicalizeTicketId`'s `.toLowerCase()`, not a regex test) — see
   * `log.ts`'s `validateTicketFilter`.
   */
  EVENT_LOG_INVALID_WINDOW: "EVENT_LOG_INVALID_WINDOW",
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
   * `read()` found the top-level `events` path does not resolve to a usable
   * directory — a blob, symlink, or gitlink is planted there instead of the
   * tree every `events/<yyyy-mm>.jsonl` month file lives under (fix round 3,
   * Ruling R48, High — orchestrator security review). Without this check,
   * `readBlobFromRef(ref, "events/<month>.jsonl")` for *every* month in the
   * aggregation window returns `null` — "no file for this month" —
   * indistinguishable from a genuinely empty board, since `ls-tree` simply
   * finds no entry under a prefix that isn't a directory. `read()` would
   * silently return `[]`, every live claim vanishing from its result — ADR
   * failure mode 8(b) named literally: "a genuine read failure being
   * misread as 'not found' … a silently-granted double-claim." Confirmed by
   * direct probe that a blob, a symlink (mode `120000`), and a gitlink
   * (mode `160000`) all reproduce this fail-open identically. `details`
   * carries the ref, the already-resolved `commit`, the blocked path, and a
   * `remediation` naming the manual tree-rebuild steps (the same pattern
   * `EVENT_RECOVERY_QUARANTINE_BLOCKED` already establishes for the
   * analogous `quarantine/` prefix) — this module cannot safely replace the
   * entry itself, since doing so would discard whatever is nested under it
   * with no audit trail.
   */
  EVENT_LOG_EVENTS_PREFIX_BLOCKED: "EVENT_LOG_EVENTS_PREFIX_BLOCKED",
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
   * success. **Fix round 2, NEW-1**: a peer-triggerable `GIT_BLOB_AMBIGUOUS`
   * (a directory or non-blob entry planted at the probe path) is *not*
   * treated as unusable — see `ref.ts`'s `checkRefUsability` doc comment.
   * **Known residual gap** (Orchestrator Ruling R19): a ref planted at a
   * raw tree, or at *any* annotated tag (fix round 2 doc correction — not
   * only one peeling to a tree; a tag pointing straight at a commit is
   * unusable too, since `commit-tree -p` needs its argument to resolve
   * directly to a commit), is *also* unusable but is not detected by this
   * code — see `ref.ts`'s `checkRefUsability` doc comment for why, and for
   * the M2.6 addition (an object-type query) that would close it.
   */
  EVENT_REF_UNUSABLE: "EVENT_REF_UNUSABLE",
  /**
   * `observations.ts`'s `observe`/`firstSeen`/`discard` were given an
   * `eventId` that fails `events/schema.ts`'s `isValidEventId` ULID-grammar
   * check. Raised before the id is ever hashed into a path component
   * (obligation 2 of task-3-brief.md) — the ULID check and the hash are
   * independent guards, and this is the one that runs first.
   */
  EVENT_OBSERVATION_INVALID_EVENT_ID: "EVENT_OBSERVATION_INVALID_EVENT_ID",
  /**
   * `observations.ts` was given a `boardKey` that is not a non-empty
   * string. `boardKey` is never peer-supplied (it comes from this
   * process's own `git rev-parse` via `boardKeyFor`, not from anything
   * read off a coordination ref), so this guards a programming mistake,
   * not a security boundary — hashing the key is what closes the security
   * half, unconditionally, regardless of this check.
   */
  EVENT_OBSERVATION_INVALID_BOARD_KEY: "EVENT_OBSERVATION_INVALID_BOARD_KEY",
  /**
   * The lease-observation store's `$XDG_STATE_HOME/cankan/observations/`
   * directory (or a file within it) could not be created, written, read,
   * or removed for a reason other than plain absence — Ruling R7
   * (orchestrator, binding): an absent store or a missing record degrades
   * gracefully (create it and proceed / report "not yet observed"), but an
   * **unwritable or unreadable** store is a typed hard error, never a
   * warning or a silent skip. The ADR's stated reason (0001:1120-1123):
   * proceeding without recording would silently re-observe the same event
   * on the next invocation, so no lease would ever expire — a failure
   * invisible from the outside. `details.operation` names which operation
   * failed (`"create state directory"`, `"write observation record"`,
   * etc.) — never a filesystem path, per `../errors.ts`'s `details`
   * discipline: the path is built from `$XDG_STATE_HOME`/`$HOME`, values
   * this module does not control and must not publish.
   */
  EVENT_OBSERVATION_STORE_UNAVAILABLE: "EVENT_OBSERVATION_STORE_UNAVAILABLE",
  /**
   * `recovery.ts`'s `recover()` was given a `RecoveryOptions.casRetry` shaped
   * wrong — the same class of defect `EVENT_APPEND_INVALID_OPTION` closes
   * for `append()`, applied here because `recover()` forwards its own
   * `casRetry` to the same `withCasRetry` (M2.6), which does not validate it
   * itself. Raised before any git invocation, at the same four sites:
   * `casRetry` itself must not be `null`; `casRetry.maxAttempts` must be a
   * finite integer in `[1, MAX_CAS_ATTEMPTS]`; `casRetry.backoffMs` itself,
   * and every value it returns, must be a function / a finite number in
   * `[0, MAX_BACKOFF_MS]` respectively; `casRetry.sleep` must be a function.
   * `now`/`trailingMonths` validation failures reuse
   * `EVENT_LOG_INVALID_WINDOW` instead of a new code — `diagnose()`/
   * `recover()` apply the identical bound `read()` does to the identical
   * parameters, so the failure is the same class, just raised from a
   * different function.
   */
  EVENT_RECOVERY_INVALID_OPTION: "EVENT_RECOVERY_INVALID_OPTION",
  /**
   * `recovery.ts`'s `recover()` found something already occupying a
   * `quarantine/` path it needs to use as a directory — either the literal
   * top-level `quarantine` path, or one specific month's bare
   * `quarantine/<month>` path (fix round 2: checked at both levels, once
   * per attempt for the former and once per month touched for the latter —
   * see `assertQuarantineDirectoryUsable`). Git cannot represent a path as
   * both a non-tree entry and a directory prefix in one tree, so anything
   * planted at either exact path that isn't itself a tree — a blob, a
   * symlink, or a gitlink/submodule — blocks every write this run would
   * otherwise make under it (fix round 1, Critical 2 — orchestrator
   * security review, blob only; generalized to the per-month path in fix
   * round 2, NEW-1 remediation; generalized again in fix round 3 to the
   * full blob/symlink/gitlink mode check via the shared `isTreeEntryBlocked`
   * helper, closing a symlink/gitlink gap in fix round 1/2's own blob-only
   * probe — see Ruling R48). **Deliberately refuses to fall back to
   * rewriting the month file without its matching audit record** — writing
   * the fix without the quarantine record would silently delete the
   * offending line with no audit trail, which is the one thing this module
   * must never do. `details` names the exact blocked path; the message
   * states the remediation (rebuild the ref's tree to remove the
   * conflicting entry). **Fix round 2 (NEW-2): no longer also raised as a
   * speculative relabel of an unrelated `commitTreeToRef` failure** — a
   * real conflict is now always caught by one of the two proactive probes
   * above, before the commit is even attempted, so a `commitTreeToRef`
   * failure that still occurs is never this code; it propagates as
   * `GIT_COMMAND_FAILED` with its genuine cause intact.
   */
  EVENT_RECOVERY_QUARANTINE_BLOCKED: "EVENT_RECOVERY_QUARANTINE_BLOCKED",
  /**
   * `recovery.ts`'s `recover()` found that the quarantine audit content it
   * actually built for this call exceeds its own absolute resource ceiling.
   * **Fix round 2 (Ruling R45): this is now a last-resort safety net, not
   * the primary defense.** Fix round 1's version of this check compared the
   * full built string against a fixed bound *after* constructing it, and —
   * because it was checked against one ever-growing, append-only
   * `quarantine/<month>.jsonl` file — could become a **permanent,
   * unrecoverable wedge**: a single adversarial line's `JSON.stringify`-
   * escaped form alone could exceed the bound (measured: up to 6.3x
   * expansion), and/or prior calls' already-committed history could push
   * every future call over it once accumulated size alone approached the
   * ceiling (reproduced: three successive real pushes recovered twice,
   * then permanently failed on the third). Both root causes are now closed
   * upstream, before this code is ever reached in practice: each call
   * writes its own new quarantine file per month (never reads or grows an
   * earlier call's), a single line's raw content embedded in one record is
   * capped (truncated, disclosed via `rawTruncated`) rather than embedded
   * in full, and the run-wide byte budget is estimated and enforced
   * *during diagnosis* (converging over more than one `recover()` pass via
   * the existing `"diagnostic-truncated"` reason) rather than discovered
   * only after the string is already built. This code firing at all would
   * indicate a mismatch between this module's own size-estimation
   * constants and reality, not a permanently unrecoverable ref — see this
   * error's own message for the operator-facing remediation.
   */
  EVENT_RECOVERY_QUARANTINE_TOO_LARGE: "EVENT_RECOVERY_QUARANTINE_TOO_LARGE",
} as const;
