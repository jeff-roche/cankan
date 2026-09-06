/**
 * `events/recovery.ts` — the poisoned-ref recovery path (ADR 0001:828-847,
 * dispatch 4's obligation; failure mode 8, ~line 1164).
 *
 * **Why this exists.** `read()` (`log.ts`) fails closed on the first invalid
 * line, a non-blob month path, or a duplicate event id whose content
 * differs — the correct trade for a mutual-exclusion primitive, but it means
 * one hostile or buggy push renders the whole board unreadable for every
 * peer that fetches it. Nothing in ADR 0001, ADR 0002, or PLAN.md names an
 * exit from that state; this file is that exit. Two halves:
 *
 * - {@link diagnose}: a **non-aborting** read that walks the same aggregated
 *   month window `read()` does and reports **every** failing line, so an
 *   operator can see which event(s) are offending without the board having
 *   to answer normally first (fm8's "a diagnosable error identifying the
 *   offending ref/commit/file").
 * - {@link recover}: rewrites each affected month file to drop exactly the
 *   lines {@link diagnose} found invalid, preserving every other line and
 *   in order, and records each removed line — with its reason and original
 *   position — into a `quarantine/<month>/<sortableId>.jsonl` audit file,
 *   one new file per `recover()` call (fix round 2, Ruling R45(b) — see
 *   `buildQuarantineFilePath`'s doc comment for why). **Ruling R8
 *   (orchestrator, binding): this is a new commit on top of the current
 *   tip, never a CAS rewind** — see {@link recover}'s own doc comment for
 *   why a rewind is rejected.
 *
 * **Neither function is wired into `append`/`read`.** Recovery is an
 * explicit operator action (a `cankan recover` command, not built here) —
 * a board that silently self-heals by discarding events a peer pushed is a
 * board an attacker could use to delete a claim by provoking automatic
 * "recovery." See {@link recover}'s doc comment for the adversarial analysis
 * of what an attacker *can* and *cannot* gain by forcing a real, manually
 * triggered recovery run.
 *
 * **Never modifies `schema.ts`, `ref.ts`, or `observations.ts`, and touches
 * `log.ts` only via three appended `export` keywords (Ruling R42, fix round
 * 1 — see `MAX_LINE_BYTES`/`MAX_MONTH_BLOB_BYTES`/`MAX_AGGREGATE_READ_BYTES`
 * there for exactly what changed and why).** A handful of small, pure
 * helpers below (`trailingMonthKeysOldestFirst`, `monthPath`,
 * `validateTrailingMonths`, `withValidatedBackoff`/the `casRetry` option
 * checks) are **copied from `log.ts`, not imported** — the same "copied
 * because of the ownership boundary" pattern `schema.ts`'s
 * `canonicalizeTicketId` already documents relative to `ticket/id.ts`.
 * `splitJsonlLines` and `validateNowForDateFormatting` *are* imported from
 * `log.ts` (already exported for exactly this kind of same-module reuse —
 * see `ref.ts`'s identical import), as are the three real size bounds named
 * above.
 *
 * ## Fix round 1 (orchestrator security + code review) — what changed
 *
 * Four Criticals, one High, two Mediums, and several Lows, all folded in
 * here rather than split across rounds (see the ledger / `task-4-report.md`
 * for the full defect-by-defect account):
 *
 * 1. **Unbounded per-line failure/quarantine objects (Critical 1).**
 *    Contiguous, byte-identical, same-reason line failures are now
 *    coalesced into one `DiagnosticFailure`/`QuarantineRecord` carrying
 *    `line`/`endLine`/`count`, computing the expensive per-line hash/preview
 *    only once per *distinct* span — not once per repeated line. A hard cap
 *    (`MAX_DIAGNOSTIC_FAILURES`) on the number of *distinct* spans bounds
 *    the case coalescing cannot help (many genuinely different bad lines),
 *    reported as a synthetic `"diagnostic-truncated"` failure rather than
 *    silently stopping.
 * 2. **A pre-planted path could disarm every future recovery (Critical 2).**
 *    Every `readBlobFromRef`/`commitTreeToRef` call this file makes into
 *    `quarantine/` is now guarded; a blocked audit path throws
 *    `EVENT_RECOVERY_QUARANTINE_BLOCKED` naming the path and remediation,
 *    rather than either crashing uninformatively or (worse) silently
 *    rewriting the month file without its matching audit record.
 * 3. **`diagnose()` did not model `read()`'s full failure surface (Critical
 *    3, Ruling R42).** `diagnose()` now reports `"line-too-large"` (fixable,
 *    at `read()`'s real `MAX_LINE_BYTES`) and `"blob-too-large"`/
 *    `"aggregate-too-large"` (unresolved, at `read()`'s real
 *    `MAX_MONTH_BLOB_BYTES`/`MAX_AGGREGATE_READ_BYTES`) — imported from
 *    `log.ts`, not re-copied, so the two can never drift apart.
 * 4. **`outcome: "clean"` could coexist with a non-empty `unresolved`
 *    (Critical 4).** `RecoveryResult.outcome` gained a third value,
 *    `"unrepairable"`, and is now derived from both `fixable.length` *and*
 *    `unresolved.length` — never `"clean"` when `read()` would still throw.
 * 5. **A non-blob month path had no exit and no remediation (High, Ruling
 *    R43).** Its `DiagnosticFailure` now carries a structured `remediation`
 *    field with concrete inspection guidance, and — via fix 4 above —
 *    `recover()` never reports `"clean"` while one is outstanding.
 * 6. **"Byte-for-byte" was an overclaim (Medium, Ruling R44).** The git
 *    adapter's transport decodes stdout as UTF-8 with `Response.text()`'s
 *    lossy (U+FFFD-substituting) default, confirmed by direct probe — so a
 *    line that was not valid UTF-8 on disk is already mangled by the time
 *    this module ever sees it, for both a quarantined line *and* any kept
 *    line sharing its month. This module cannot recover bytes it never
 *    received, so it no longer claims to: every `DiagnosticFailure`/
 *    `QuarantineRecord`/`QuarantinedLineSummary` carries `possiblyLossy`
 *    (heuristic: the string contains a U+FFFD), and `RecoveryResult` carries
 *    `monthsWithPossibleEncodingLoss` so an operator is told, not left to
 *    assume perfect fidelity. A raw-bytes read primitive is flagged in
 *    `task-4-report.md` as an M2.6 follow-up.
 * 7. **The aggregate-bound cascade (Medium).** The aggregate check now fires
 *    at most once per run, at `read()`'s real bound, and never interpolates
 *    a per-month size into what is a whole-window figure.
 * 8. **Lows**: `safeLinePreview` now also escapes U+2028/U+2029 and a lone
 *    surrogate; every error-message template literal that could interpolate
 *    an unvalidated value is now type-gated so a `Symbol` (or similar)
 *    cannot escape past `isCanKanError` as a raw `TypeError`; a non-object
 *    `casRetry` is rejected rather than silently treated as "no overrides";
 *    `options.now`'s own type is checked before it ever reaches `log.ts`'s
 *    `validateNowForDateFormatting` (closing this module's one reachable
 *    path to that function's own unguarded `${now}` interpolation, which
 *    lives in a frozen file this dispatch has no authority to edit —
 *    reported forward instead); `DiagnosticReport.commit` is documented as
 *    naming the head resolved before the blob reads, which can be stale
 *    under a concurrent append (harmless inside `recoverCore`, since the CAS
 *    itself is what actually serializes; a caveat for a human reading
 *    `diagnose()`'s own output directly).
 *
 * ## Fix round 2 (orchestrator security + code review) — what changed
 *
 * One new Critical (introduced by fix round 1's own remedy for the original
 * Critical 1), plus several Mediums and Lows — see `task-4-report.md`'s
 * fix-round-2 addendum for the full defect-by-defect account and RED/GREEN
 * evidence.
 *
 * 1. **Fix round 1's `EVENT_RECOVERY_QUARANTINE_TOO_LARGE` guard was itself
 *    a permanent-wedge defect (NEW-1, Critical; Ruling R45).** It compared
 *    the *combined* size of a single, ever-growing, append-only
 *    `quarantine/<month>.jsonl` blob against a fixed ceiling, after
 *    building the full string — so (a) a single adversarial line's
 *    `JSON.stringify`-escaped form alone could exceed the ceiling (measured:
 *    6.04x expansion for a run of `\x01` bytes), and (b) prior calls'
 *    already-committed, permanently-retained history counted against every
 *    *future* call's budget, so the guard would eventually and
 *    *permanently* refuse recovery once accumulated history alone
 *    approached the ceiling (reproduced: three successive real 20 MiB
 *    pushes recovered twice, growing one file to 120 MiB then 240 MiB, then
 *    permanently failed on the third, wedging a live claim unreachable).
 *    Closed with two changes, required together (neither alone suffices —
 *    see `quarantineDirPath`'s and `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`'s
 *    doc comments for why): each `recover()` call now writes its **own**
 *    new `quarantine/<month>/<sortableId>.jsonl` file, never reading or
 *    growing what an earlier call wrote (closes (b)); and a single removed
 *    line's raw content embedded in one `QuarantineRecord` is now capped at
 *    `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`, truncated (disclosed via
 *    `rawTruncated`) rather than embedded in full when larger (closes (a)).
 *    The run-wide byte budget that used to be checked *after* building the
 *    full string is now estimated and enforced **during diagnosis**
 *    (`MAX_QUARANTINE_RUN_BUDGET_BYTES`), converging over more than one
 *    `recover()` pass via the same `"diagnostic-truncated"` mechanism
 *    `MAX_DIAGNOSTIC_FAILURES` already established, rather than throwing
 *    post-hoc.
 * 2. **A misdiagnosed `GIT_COMMAND_FAILED` (NEW-2, Medium).** Fix round 1's
 *    fallback — relabeling *any* `commitTreeToRef` `GIT_COMMAND_FAILED` as
 *    `EVENT_RECOVERY_QUARANTINE_BLOCKED` — could misattribute an unrelated
 *    git-level failure (disk full, permissions, a read-only object store) as
 *    a blocked audit path. Removed: the two proactive
 *    `assertQuarantineDirectoryUsable` probes (top-level and, new in this
 *    round, per-month) now catch both known conflict shapes *before* the
 *    commit is attempted, so the commit itself no longer needs a
 *    speculative relabel — any `GIT_COMMAND_FAILED` that still occurs
 *    propagates with its real code and cause intact.
 * 3. **The options object's own type went unchecked (NEW-5/6, Low).**
 *    `diagnose(adapter, ref, null)`/`recover(adapter, ref, null)` threw a
 *    raw `TypeError` (a default parameter does not apply to an explicit
 *    `null`) rather than a `CanKanError` — both now normalize `null` to `{}`
 *    before use, the same pattern `observations.ts`'s `observe()` already
 *    documents. `casRetry: []` (an array, `typeof "object"` but not a valid
 *    options object) is now also rejected, not silently treated as "no
 *    overrides."
 * 4. **An inaccurate comment (NEW-9, Low).** The per-month rebuild read's
 *    comment overclaimed that it was "pinned" to this attempt's own
 *    `parentSha`; `readBlobFromRef` re-resolves the ref name on every call,
 *    it does not pin to a specific commit. Corrected to state what actually
 *    guarantees correctness: the CAS on `parent: parentSha` at commit time.
 *
 * ## Fix round 3 (orchestrator security + code review) — what changed
 *
 * One Critical and one High, both closed here — see `task-4-report.md`'s
 * fix-round-3 addendum for the full defect-by-defect account and RED/GREEN
 * evidence.
 *
 * 1. **A duplicate-id conflict could be "fixed" by evicting the victim
 *    (Critical; Ruling R47).** `FIXABLE_REASONS` used to include
 *    `"duplicate-id-conflict"`, so `recover()` would drop whichever
 *    occurrence's *month happened to sort first* and keep the other —
 *    survivorship by an attacker-controlled position, not by legitimacy
 *    (ADR 0001:811-826 forbids exactly this: no attacker-independent
 *    survivor key among mutually-distrusting peers). An attacker who wanted
 *    to evict a victim's genuine claim could forge the same event id, place
 *    the forgery in an *earlier* month than the victim's real line, and
 *    wait for (or provoke) a recovery run: `recover()` would remove the
 *    victim's later, legitimate line and keep the forgery — the exact
 *    failure fm8(b) warns about, "a silently-granted double-claim." Closed
 *    by removing `"duplicate-id-conflict"` from `FIXABLE_REASONS` entirely:
 *    a duplicate-id conflict is now *always* reported `unresolved`, with a
 *    `remediation` naming both occurrences (their months and line numbers)
 *    so an operator resolves it by hand; `recover()` never quarantines
 *    either occurrence and never rewrites either month file for this
 *    reason, regardless of which one sorts first.
 * 2. **A blocked `events` prefix made `diagnose()`/`recover()` fail open,
 *    not closed (High; Ruling R48).** `read()`'s own top-level `events`
 *    path was never probed the way `quarantine`'s was — a blob, symlink, or
 *    gitlink planted at the bare `events` path makes every month's
 *    `readBlobFromRef` resolve as "not found" (nothing exists under a
 *    non-tree prefix), so `diagnose()` reported a clean board with zero
 *    months scanned and `recover()` reported `"clean"`, while `read()`
 *    itself would throw. Closed by probing `events` the same way
 *    `assertQuarantineDirectoryUsable` already probed `quarantine`, via a
 *    new shared, mode-aware, non-throwing discriminator,
 *    `isTreeEntryBlocked` — blocked if the prefix resolves as a real blob,
 *    or as `GIT_BLOB_AMBIGUOUS` with a mode other than `040000` (a symlink
 *    or a gitlink/submodule); healthy if absent or `GIT_BLOB_AMBIGUOUS`
 *    with mode `040000`. `computeDiagnosticReport` now checks `events`
 *    first, before scanning any month, and reports a single
 *    `"events-prefix-blocked"` failure (unresolved, with remediation) if
 *    blocked, rather than an empty, falsely-clean report.
 *    `assertQuarantineDirectoryUsable` itself is now built on the same
 *    `isTreeEntryBlocked` helper — fix round 1/2's own quarantine probe was
 *    blob-only and shared the identical symlink/gitlink blind spot this
 *    round closes for `events`; both are fixed together, not just the one
 *    the reviewer named.
 */

import { createHash, randomBytes } from "node:crypto";
import { CanKanError, isCanKanError } from "../errors";
import type { CasOutcome, CasRetryOptions, GitAdapter } from "../git/index";
import { GitErrorCodes, validateCoordinationRef, withCasRetry } from "../git/index";
import { EventErrorCodes } from "./errors";
import { MAX_AGGREGATE_READ_BYTES, MAX_LINE_BYTES, MAX_MONTH_BLOB_BYTES, splitJsonlLines, validateNowForDateFormatting } from "./log";
import { parseEvent } from "./schema";
import type { EventId, EventValidationIssue } from "./schema";

// ============================================================================
// Small helpers copied from `log.ts` — see the file header for why they are
// copies, not imports, and the invariant that keeps a copy safe: everything
// here rejects strictly a subset of what `log.ts`'s own bound would, in the
// same "drift toward permissiveness is harmless, drift toward strictness is
// an outage" direction `schema.ts` already documents for its own copies.
// ============================================================================

/** Mirrors `log.ts`'s `MAX_TRAILING_MONTHS` exactly (same bound, same reasoning: bounds the backward month-probe loop below). */
const MAX_TRAILING_MONTHS = 120;

/**
 * `diagnose`/`recover`'s default aggregation window — mirrors `log.ts`'s
 * `DEFAULT_TRAILING_MONTHS`. A caller recovering a board whose corruption is
 * older than this should pass a wider `trailingMonths`, the same contract
 * `read()`'s own option already documents; there is no way to enumerate
 * *every* month a coordination ref has ever held (constraints.md point 4 —
 * `GitAdapter` exposes no tree enumeration), so any diagnostic tool is
 * necessarily bounded by how far back it is told to probe.
 */
const DEFAULT_TRAILING_MONTHS = 2;

function validateTrailingMonths(trailingMonths: number): void {
  if (!Number.isInteger(trailingMonths) || trailingMonths < 1 || trailingMonths > MAX_TRAILING_MONTHS) {
    throw new CanKanError(
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
      `trailingMonths must be an integer in [1, ${MAX_TRAILING_MONTHS}]`,
      { details: { trailingMonths, max: MAX_TRAILING_MONTHS } },
    );
  }
}

/**
 * Fix round 1, Low: `options.now`'s own type, checked before it ever reaches
 * `log.ts`'s `validateNowForDateFormatting` — that function's own
 * `${now}` interpolation (`log.ts`'s own file, not this one) is not
 * `typeof`-gated, so a `Symbol` (or any value whose `ToString` throws) would
 * otherwise escape past `isCanKanError` as a raw `TypeError` (the same
 * past-`isCanKanError`-shape class `log.ts` has already closed at every
 * *other* site it was found — see that file's own history). `log.ts` is
 * frozen to this dispatch beyond the three named exports (Ruling R42), so
 * that function's own interpolation cannot be fixed here; this closes the
 * one path *this module* has into it. Reported forward in
 * `task-4-report.md` as a cross-cutting follow-up rather than patched
 * silently out of scope.
 */
function validateNowIsNumber(now: unknown): void {
  if (typeof now !== "number") {
    throw new CanKanError(EventErrorCodes.EVENT_LOG_INVALID_WINDOW, `now must be a number, got ${typeof now}`, {
      details: { type: typeof now },
    });
  }
}

/** Identical algorithm to `log.ts`'s own `trailingMonthKeysOldestFirst` — oldest first, so failures/quarantine entries are discovered in append-only chain order. */
function trailingMonthKeysOldestFirst(nowMs: number, trailingMonths: number): string[] {
  const keys: string[] = [];
  const d = new Date(nowMs);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth(); // 0-based
  for (let i = 0; i < trailingMonths; i++) {
    keys.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return keys.reverse();
}

function monthPath(month: string): string {
  return `events/${month}.jsonl`;
}

/**
 * Fix round 3 (Ruling R48, orchestrator security review, High): the
 * top-level directory every `monthPath` lives under. `computeDiagnosticReport`
 * probes this exact path before trusting *any* per-month read — see that
 * function's own doc comment and {@link isTreeEntryBlocked} for why a
 * blocked `events` prefix is otherwise invisible to both `read()` and
 * `diagnose()`.
 */
const EVENTS_PREFIX = "events";

/**
 * The quarantine audit directory for one month — `quarantine/<yyyy-mm>/`.
 * **Deliberately a different top-level directory than `events/`**, which is
 * what makes requirement 9 ("`read()` does not treat the quarantine file as
 * an event log") true *structurally*, not by convention: `read()`'s only
 * file probe is `events/<month>.jsonl` for each month in its aggregation
 * window (`log.ts`'s `monthPath`) — a path under `quarantine/` is never
 * constructed by, and therefore never reachable from, `read()`'s own code,
 * regardless of what `trailingMonths` a caller passes. See
 * `recovery.test.ts` for the test that proves this by planting hostile
 * content at this exact path and confirming `read()` neither throws on it
 * nor is influenced by it.
 *
 * **Fix round 1, Critical 2: this same "different top-level directory" fact
 * is also what makes the `quarantine/` prefix a single point of failure.**
 * Git cannot represent one path as both a blob and a directory prefix in
 * the same tree, so a single blob planted at the literal path `quarantine`
 * (no month suffix) conflicts with *every* `quarantine/<month>/...` write
 * this file could ever make, in one shot — see `assertQuarantineDirectoryUsable`.
 * The same conflict class recurs one level down (a blob planted at the bare
 * `quarantine/<month>` path, no trailing file), which is why `recoverCore`
 * probes that exact path too, per month, before writing into it (fix round
 * 2, NEW-1 remediation — see `assertQuarantineDirectoryUsable`).
 *
 * **Fix round 2 (orchestrator security review, Ruling R45): one file per
 * recovery call, not one ever-growing file per month.** The original design
 * (fix round 1) appended every call's `QuarantineRecord`s onto a single
 * `quarantine/<month>.jsonl` blob, read back and concatenated on every
 * subsequent call. That is an unbounded accumulation: `EVENT_RECOVERY_
 * QUARANTINE_TOO_LARGE`'s own bound-check, comparing the *combined* content
 * against a fixed ceiling, would eventually and *permanently* refuse every
 * future call once prior calls' history alone approached that ceiling —
 * reproduced directly (three successive real 20 MiB pushes against a board
 * holding a live claim: recovery succeeded twice, growing the single file to
 * 120 MiB then 240 MiB, then permanently refused on the third, wedging the
 * live claim unreachable). Each call now writes its own new file —
 * `quarantine/<month>/<sortableId>.jsonl` (see `buildQuarantineFilePath`) —
 * so no call ever reads, grows, or is bounded by what an *earlier* call
 * wrote. This alone does not close the defect (a single call's own audit
 * content can still be made arbitrarily large by a single adversarial line —
 * see `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`'s doc comment for the other,
 * required half of R45).
 */
function quarantineDirPath(month: string): string {
  return `quarantine/${month}`;
}

/**
 * Fix round 2 (Ruling R45(b)): builds this call's own quarantine file path
 * for one month — `quarantine/<month>/<ISO-timestamp-with-safe-chars>-
 * <16 hex chars>.jsonl`. The random suffix (not just the timestamp) is
 * load-bearing, not decorative: two reasons.
 *
 * 1. **Uniqueness even when `quarantinedAt` collides.** `quarantinedAt` is
 *    computed once per `recoverCore` call from `options.now` (a test's own
 *    injected, fixed clock, or two real calls landing in the same
 *    millisecond) — without a random component, two calls in the same month
 *    at the same instant would target the identical path, and the second to
 *    land via CAS would *overwrite* the first's audit record rather than
 *    add a second one (`commitTreeToRef`'s overlay replaces whatever was at
 *    a given path, it does not append) — silently losing audit history,
 *    exactly the failure mode `quarantine/`'s whole existence is meant to
 *    prevent.
 * 2. **An unpredictable filename closes a pre-planting attack this file's
 *    old, deterministic `quarantine/<month>.jsonl` path was exposed to**: an
 *    adversary with push access could not previously predict *this* call's
 *    exact future audit path to pre-plant a conflicting tree at it (the
 *    remaining, still-real conflict shapes — a blob at the bare top-level
 *    `quarantine` path, or at the bare per-month `quarantine/<month>` path —
 *    are both still deterministic and still guarded by
 *    `assertQuarantineDirectoryUsable`, called at both levels).
 *
 * `randomBytes(8).toString("hex")` mirrors `observations.ts`'s own
 * temp-file-naming convention (same module family, same "collision
 * resistance far beyond this threat model's actual need" reasoning as
 * `lineDigest`'s `sha256` choice) — 64 bits of entropy, no new dependency
 * (`node:crypto`, constraint 5).
 */
function buildQuarantineFilePath(month: string, quarantinedAtIso: string): string {
  const safeTimestamp = quarantinedAtIso.replace(/[:.]/g, "-");
  const suffix = randomBytes(8).toString("hex");
  return `${quarantineDirPath(month)}/${safeTimestamp}-${suffix}.jsonl`;
}

const TOP_LEVEL_QUARANTINE_PATH = "quarantine";

/** Mirrors `log.ts`'s `MAX_CAS_ATTEMPTS`/`MAX_BACKOFF_MS` bounds and reasoning exactly — `withCasRetry` (M2.6) does not validate its own `casRetry` option, so `recover`, like `append`, validates what it forwards. */
const MAX_CAS_ATTEMPTS = 10_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Fix round 1, Low: renders a not-yet-fully-validated value for an error
 * *message* (as opposed to `details`, where the raw value is safe — an
 * object property is never coerced to a string, and `JSON.stringify`
 * silently *drops* a `Symbol`-valued property rather than throwing).
 * Template-literal interpolation (`${v}`) performs `ToString`, which throws
 * for a `Symbol` and for any object with a throwing `toString` — the exact
 * past-`isCanKanError` shape `log.ts` has already closed at several sites.
 * `String(v)` alone is not sufficient either: `String(Symbol())` is safe,
 * but `String({ toString() { throw new Error(); } })` still throws. Gating
 * on `typeof` first closes both: a `number` is rendered as itself; anything
 * else is rendered as its `typeof` tag (never the value, and never a call
 * that could itself throw).
 */
function safeRenderForMessage(value: unknown): string {
  return typeof value === "number" ? String(value) : typeof value;
}

/**
 * Mirrors `log.ts`'s `AppendOptions.casRetry` validation exactly (same
 * lesson: validate every caller-supplied option against the domain of every
 * consumer it reaches, not just its declared type) — `casRetry` itself,
 * `.maxAttempts`, `.backoffMs`, and `.sleep` are all checked before
 * `withCasRetry` (M2.6) ever sees them, so a malformed value surfaces as a
 * `CanKanError` here rather than a raw `TypeError` from inside M2.6.
 *
 * **Fix round 1, Low: rejects *any* non-object `casRetry`, not only
 * `null`.** A string/number/boolean is not `null`, so the pre-fix check let
 * it through; `casRetry?.maxAttempts` on a primitive then safely evaluates
 * to `undefined` (JS auto-boxes for property access rather than throwing),
 * so a bogus `casRetry: "oops"` was silently treated as "no overrides
 * supplied" instead of rejected — exactly the "reject a non-object rather
 * than silently defaulting" gap flagged in review.
 *
 * **Fix round 2, Low (NEW-6): also rejects an array.** `typeof [] ===
 * "object"` and `[] !== null`, so `casRetry: []` passed the round-1 check —
 * every property access on it (`.maxAttempts`, `.backoffMs`, `.sleep`) then
 * safely evaluated to `undefined`, silently treating an array the same as
 * "no overrides supplied" instead of rejecting it as the not-a-valid-
 * options-object it is.
 */
function validateCasRetryOption(casRetry: CasRetryOptions | undefined): void {
  if (casRetry === undefined) {
    return;
  }
  if (typeof casRetry !== "object" || casRetry === null || Array.isArray(casRetry)) {
    throw new CanKanError(EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION, `casRetry must be an object, got ${Array.isArray(casRetry) ? "array" : typeof casRetry}`, {
      details: { type: Array.isArray(casRetry) ? "array" : typeof casRetry },
    });
  }
  const maxAttempts = casRetry.maxAttempts;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CAS_ATTEMPTS)) {
    throw new CanKanError(
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
      `casRetry.maxAttempts must be an integer in [1, ${MAX_CAS_ATTEMPTS}], got ${safeRenderForMessage(maxAttempts)}`,
      { details: { maxAttempts, max: MAX_CAS_ATTEMPTS } },
    );
  }
  const backoffMs = casRetry.backoffMs;
  if (backoffMs !== undefined && typeof backoffMs !== "function") {
    throw new CanKanError(EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION, `casRetry.backoffMs must be a function, got ${typeof backoffMs}`, {
      details: { type: typeof backoffMs },
    });
  }
  const sleep = casRetry.sleep;
  if (sleep !== undefined && typeof sleep !== "function") {
    throw new CanKanError(EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION, `casRetry.sleep must be a function, got ${typeof sleep}`, {
      details: { type: typeof sleep },
    });
  }
}

/** Mirrors `log.ts`'s `withValidatedBackoff` exactly — validates every value `backoffMs` *returns*, on every call, not only its type up front. */
function withValidatedBackoff(casRetry: CasRetryOptions | undefined): CasRetryOptions | undefined {
  const userBackoffMs = casRetry?.backoffMs;
  if (userBackoffMs === undefined) {
    return casRetry;
  }
  return {
    ...casRetry,
    backoffMs: (attemptNumber: number) => {
      const ms = userBackoffMs(attemptNumber);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_BACKOFF_MS) {
        throw new CanKanError(
          EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
          `casRetry.backoffMs must return a finite number in [0, ${MAX_BACKOFF_MS}], got ${safeRenderForMessage(ms)}`,
          { details: { backoffMs: ms, max: MAX_BACKOFF_MS } },
        );
      }
      return ms;
    },
  };
}

// ============================================================================
// Diagnostic-only resource bounds — deliberately far more generous than
// `log.ts`'s real `MAX_MONTH_BLOB_BYTES`/`MAX_AGGREGATE_READ_BYTES`, which
// are imported (not copied) above and used directly wherever this file needs
// to report in `read()`'s own vocabulary (Ruling R42).
// ============================================================================

/**
 * The diagnostic reader's own per-month safety ceiling — 4x `log.ts`'s real
 * `MAX_MONTH_BLOB_BYTES` (64 MiB). This is **not** the bound `diagnose()`
 * reports `"blob-too-large"` against (that is `read()`'s own real bound,
 * imported above, per Ruling R42) — it is a separate, larger hard stop
 * against a blob so large this tool cannot safely materialize and split it
 * at all. A month between the two bounds is still fully scanned line by
 * line (it is well within this tool's own budget) and additionally flagged
 * as exceeding `read()`'s bound; a month past *this* bound is flagged and
 * skipped without attempting to split it.
 */
const MAX_DIAGNOSTIC_MONTH_BLOB_BYTES = 256 * 1024 * 1024;

/** The diagnostic reader's own aggregate safety ceiling — separate from, and larger than, `read()`'s real `MAX_AGGREGATE_READ_BYTES` (imported above) for the same reason as the per-month ceiling. Exceeding this stops the whole walk (reported as `"diagnostic-truncated"`); exceeding `read()`'s own bound only reports `"aggregate-too-large"` and keeps scanning. */
const MAX_DIAGNOSTIC_AGGREGATE_SAFETY_BYTES = 1024 * 1024 * 1024;

/**
 * Fix round 1, Critical 1: the hard cap on the number of *distinct*
 * (post-coalescing) failures one `diagnose()`/`recover()` call will report.
 * Coalescing (see `computeDiagnosticReport`'s `recordLineFailure`) already
 * collapses the dominant DoS shape — many contiguous, byte-identical bad
 * lines (confirmed by probe: 100,000 lines of pure `\n` collapsed a
 * 100,000-entry, 24 MB quarantine write down to one entry) — to O(1)
 * regardless of repeat count. This cap defends the residual case coalescing
 * cannot help: many *distinct* bad lines, each different enough not to
 * merge. 5,000 is generous for any real board's worth of genuinely distinct
 * corruption while bounding worst-case memory to a small multiple of that
 * count of small objects, not proportional to a hostile blob's line count.
 */
const MAX_DIAGNOSTIC_FAILURES = 5_000;

// The four constants below are `export`ed — like `recoverCore`/
// `RecoveryHooks` above — for `recovery.test.ts` alone (not re-exported from
// `events/index.ts`'s barrel, so not part of this module's public surface):
// solely so its algebraic-invariant test can check the real numbers directly
// rather than duplicating them and risking silent drift.

/**
 * Fix round 2 (Ruling R45(a), NEW-1/NEW-3): the hard ceiling on how much raw
 * line content one `QuarantineRecord` embeds. `buildQuarantineRecord`
 * truncates anything larger (see `truncateRawForQuarantine`), setting
 * `rawTruncated: true` so the sacrifice is disclosed, never silent.
 *
 * **Why this exists in addition to `MAX_QUARANTINE_RUN_BUDGET_BYTES` below,
 * not instead of it.** Fix round 1's `EVENT_RECOVERY_QUARANTINE_TOO_LARGE`
 * check ran *after* building the full audit string, and reproduced defect
 * NEW-1 shows a *single* fixable line — 45 MiB of mostly-C0-control-byte
 * garbage, itself under `read()`'s 64 MiB month cap but over its 1 MiB line
 * cap, so `"line-too-large"` and fixable — whose `JSON.stringify`-escaped
 * form alone (measured: 45 MiB → ~283 MB, a ~6.3x expansion; confirmed by
 * direct probe against a 4 KiB all-`\x01` line: 6.04x) already exceeds any
 * reasonable per-run budget. Truncating the diagnosis-time *budget
 * estimate* (below) to zero contribution beyond this cap would still leave
 * the *actual write* unbounded for that one record — so the raw content
 * itself, not just its counted contribution, must be capped before it is
 * ever embedded. 8 MiB is comfortably larger than any legitimate event
 * (`schema.ts` has no field anywhere near this size) while keeping one
 * record's worst-case embedded size small relative to the run budget: at
 * `QUARANTINE_ESCAPE_EXPANSION_FACTOR`×, one maximally-truncated record is
 * ≤ ~64 MiB, a small fraction of `MAX_QUARANTINE_RUN_BUDGET_BYTES` (256
 * MiB) — see that constant's own doc comment for the invariant this
 * relationship must hold, and `recovery.test.ts`'s dedicated test for both
 * the truncation itself and the algebraic invariant.
 */
export const MAX_QUARANTINE_RAW_BYTES_PER_RECORD = 8 * 1024 * 1024;

/**
 * Fix round 2: a conservative, deliberately-overestimating multiplier used
 * only to *budget* (never to precisely predict) how large one quarantine
 * record's serialized form will be, from its raw line's byte length alone.
 * Measured worst case (a real `JSON.stringify` of a record whose `raw` is
 * 4096 bytes of pure `\x01`, the shape NEW-1 exploited): 6.04x — every C0
 * control byte other than the handful with a 2-character named escape
 * (`\n`, `\r`, `\t`, `\b`, `\f`) becomes a 6-character `\uXXXX` escape, and
 * JSON string quoting/structure overhead is negligible at this scale. 8 is
 * used, not 6.04, for headroom without needing to re-derive this constant
 * every time V8/JSC's own `JSON.stringify` escaping table is inspected.
 */
export const QUARANTINE_ESCAPE_EXPANSION_FACTOR = 8;

/**
 * Fix round 2: a fixed per-record allowance for everything in a
 * `QuarantineRecord` *other* than `raw` — `quarantinedAt`, `month`, `line`,
 * `endLine`, `count`, `reason`, `message`, `possiblyLossy`, `rawTruncated`,
 * and, for a `"schema-invalid"` line, `issues` (`parseEvent`'s own
 * `EventValidationIssue[]`). Measured directly: a real `parseEvent` failure
 * against several maximally-wrong-shaped inputs produced at most one issue
 * (`schema.ts`'s discriminated union rejects on the first mismatch, it does
 * not accumulate one issue per union branch) and a full record (with
 * `issues`) of 570 bytes total against a near-empty `raw` — comfortably
 * under this constant even before subtracting `raw`'s own contribution.
 */
export const QUARANTINE_RECORD_OVERHEAD_BYTES = 4096;

/**
 * Fix round 2 (Ruling R45(a)): the run-wide budget `computeDiagnosticReport`
 * enforces on the *estimated* total serialized size of every quarantine
 * record this run could produce, checked and enforced **during diagnosis**
 * — not after `recoverCore` has already built the full audit string, which
 * is exactly the "throws after the string is built" shape the fix-round-2
 * review named as the defect in fix round 1's own remediation. Exceeding it
 * stops the walk and reports the existing `"diagnostic-truncated"` reason
 * (message names the budget, not the count, so an operator can tell the two
 * truncation causes apart) — the same "converges over more than one
 * `recover()` pass" contract `MAX_DIAGNOSTIC_FAILURES` already established,
 * reused rather than inventing a second truncation vocabulary.
 *
 * **Invariant this file's own test suite checks directly**:
 * `MAX_QUARANTINE_RAW_BYTES_PER_RECORD * QUARANTINE_ESCAPE_EXPANSION_FACTOR
 * + QUARANTINE_RECORD_OVERHEAD_BYTES` (one record's worst-case estimated
 * contribution, since `buildQuarantineRecord` never embeds more raw content
 * than that cap) must be comfortably below this budget — otherwise a single
 * record that alone pushes the running estimate over budget (allowed
 * through once, per `recordLineFailure`'s "budget checked *after* opening
 * this span" ordering, so at least one failure is always reported rather
 * than none) could still make one run's actual write disproportionately
 * large relative to its own stated budget. At the values above, one
 * maximally-truncated record contributes ≤ ~64 MiB against a 256 MiB
 * budget — four such records before the fifth is deferred to a following
 * pass.
 */
export const MAX_QUARANTINE_RUN_BUDGET_BYTES = 256 * 1024 * 1024;

// ============================================================================
// Safe rendering of attacker-controlled line content — the decision this
// dispatch's brief asks for explicitly, applied only at the one sink that
// needs it (the diagnostic report; the quarantine file's own answer is
// different — see `buildQuarantineRecord`'s doc comment below).
// ============================================================================

/**
 * Bidi/zero-width code points — the same set `schema.ts`'s
 * `refineActorIdShape`/`refineTicketIdShape` reject outright, copied here for
 * the same "different file, same ownership boundary" reason as the helpers
 * above. Escaped (not merely flagged) in a diagnostic preview because a
 * right-to-left override or zero-width joiner can make a rendered line read
 * differently than its actual bytes, independent of the ANSI-escape hazard
 * C0 controls create.
 */
const BIDI_OR_ZERO_WIDTH_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
]);

/**
 * Fix round 1, Low: U+2028/U+2029 and a lone surrogate are now also
 * hazardous. `splitJsonlLines` deliberately splits only on `/\r?\n/`
 * (obligation C) specifically because a Unicode-line-aware split would let
 * U+2028 desynchronize line indices for a *downstream* consumer — the same
 * hazard applies here one level up: a consumer that renders this preview
 * and then itself splits on Unicode line boundaries (a naive log viewer, a
 * terminal that treats U+2028 as a line break) would see a forged extra
 * line. A lone surrogate (the codepoint `for...of` yields when a high/low
 * surrogate has no pairing partner — `codePointAt(0)` on that single
 * iteration step lands in `0xD800-0xDFFF`) is escaped because it is not a
 * valid standalone Unicode scalar value and different renderers disagree on
 * how to display it.
 */
function isHazardousCodePoint(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) return true; // C0 controls + DEL, including ESC (0x1b) and CR (0x0d)
  if (code >= 0x80 && code <= 0x9f) return true; // C1 controls — some terminals interpret these as control sequences too
  if (code === 0x2028 || code === 0x2029) return true; // LINE/PARAGRAPH SEPARATOR
  if (code >= 0xd800 && code <= 0xdfff) return true; // lone surrogate
  return BIDI_OR_ZERO_WIDTH_CODE_POINTS.has(code);
}

function escapeCodePoint(code: number): string {
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
}

/** Upper bound on {@link safeLinePreview}'s output — enough for an operator to recognize a line's shape, bounded against the same size-amplification hazard `renderIssues` (`log.ts`) and `assertSafeId` (`ticket/filename.ts`) already guard against for other rendered values. */
const MAX_PREVIEW_CODE_POINTS = 200;

/**
 * **Decision (see task-4-report.md for the full justification): the
 * operator-facing diagnostic never echoes a rejected line verbatim.**
 * Dispatch 1's security review turned "is this safe" from a hypothetical
 * into a demonstrated defect — a key named with `ESC[2K ESC[1A` erases and
 * rewrites the line above it in a real terminal, and this diagnostic exists
 * specifically to be run against hostile content and displayed. Every
 * hazardous code point (C0/C1 controls, DEL, bidi/zero-width, U+2028/U+2029,
 * a lone surrogate) is replaced with a fixed-width escape sequence;
 * everything else, including any legitimate Unicode, passes through
 * unchanged. Bounded to `MAX_PREVIEW_CODE_POINTS` code points (not UTF-16
 * code units — iterating with `for...of` walks whole code points, matching
 * `schema.ts`'s own iteration style) so a multi-gigabyte hostile line costs
 * this function O(preview length), not O(line length), to render — the
 * string iterator is lazy, so `break`ing early genuinely avoids scanning
 * the rest (confirmed by probe: a 100,000-byte input renders in the same
 * sub-millisecond time as a 10-byte one).
 */
export function safeLinePreview(rawLine: string): string {
  let out = "";
  let count = 0;
  for (const ch of rawLine) {
    if (count >= MAX_PREVIEW_CODE_POINTS) {
      out += "…(truncated)";
      break;
    }
    const code = ch.codePointAt(0) ?? 0;
    out += isHazardousCodePoint(code) ? escapeCodePoint(code) : ch;
    count += 1;
  }
  return out;
}

/**
 * A stable, safe-to-publish (hex only) identifier for a rejected line — lets
 * an operator correlate a `DiagnosticFailure`'s sanitized preview with the
 * exact byte-for-byte record `recover()` writes into the quarantine file,
 * without either value needing to carry the raw bytes itself. `sha256` for
 * the same reason `observations.ts`'s `hashKey` uses it: collision
 * resistance far beyond this threat model's actual need, built into
 * `node:crypto`, no new dependency (constraint 5).
 */
function lineDigest(rawLine: string): string {
  return createHash("sha256").update(rawLine, "utf8").digest("hex");
}

/**
 * Fix round 1, Medium (Ruling R44): a heuristic, not a proof. U+FFFD
 * (REPLACEMENT CHARACTER) is what `git/transport.ts`'s `Response.text()`
 * substitutes for a byte sequence that was not valid UTF-8 — confirmed by
 * direct probe: writing raw bytes `0xFF 0xFE` into a real git blob and
 * reading it back through `GitAdapter.readBlobFromRef` yields two literal
 * U+FFFD characters in the returned string, and the original two bytes are
 * gone by the time this module (or any consumer of the adapter) ever sees
 * the content. A string containing U+FFFD is therefore treated as
 * "possibly" lossy, not "definitely" — a legitimate event could in
 * principle contain a genuine, intentional U+FFFD character, which this
 * heuristic cannot distinguish from adapter-induced mangling. Erring toward
 * over-flagging (a false positive costs the operator one extra "check this"
 * glance) is the only direction that is safe to err in here.
 */
function hasReplacementCharacter(value: string): boolean {
  return value.includes("�");
}

/**
 * Fix round 2 (Ruling R45(a)): truncates `raw` to at most `maxBytes` of
 * UTF-8, used only by `buildQuarantineRecord` when a single removed line's
 * content alone would make its quarantine record disproportionately large
 * (see `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`'s doc comment for why this is
 * required in addition to, not instead of, the run-wide budget).
 *
 * Re-encodes to a `Buffer` and cuts at the byte boundary rather than a code
 * *unit* boundary, since the goal is a precise byte-length cap (this is fed
 * straight into `QUARANTINE_ESCAPE_EXPANSION_FACTOR`'s own byte-based
 * budgeting) — a code-unit slice would under-count for multi-byte UTF-8
 * content and could leave the actual result larger than intended. A cut
 * landing mid-multibyte-sequence decodes back losslessly for everything
 * before the cut and produces a trailing U+FFFD (or drops the incomplete
 * tail) for the sequence straddling it — confirmed by direct probe (Bun
 * 1.4.0: `Buffer.from(s,"utf8").subarray(0,cut).toString("utf8")` never
 * throws for any cut point, including mid-4-byte-emoji). This is already a
 * lossy operation by construction (that is the whole point — bound the
 * size), so an extra U+FFFD at the truncation boundary is consistent with,
 * not worse than, `possiblyLossy`'s own disclosed imprecision.
 */
function truncateRawForQuarantine(raw: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) {
    return { value: raw, truncated: false };
  }
  return { value: Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}

// ============================================================================
// Half 1 — the diagnostic read
// ============================================================================

export type DiagnosticFailureReason =
  | "invalid-json"
  | "schema-invalid"
  | "duplicate-id-conflict"
  | "line-too-large"
  | "non-blob-month-path"
  | "blob-too-large"
  | "aggregate-too-large"
  | "diagnostic-truncated"
  | "events-prefix-blocked";

/**
 * One failing line (or, for the month-level reasons, one failing month)
 * found by {@link diagnose}. `ref`, `commit`, `month`, and `line` are fm8's
 * required "diagnosable error identifying the offending ref/commit/file"
 * coordinates — `line` is `null` for every month-level (or run-level)
 * reason, which has no single offending line to name.
 *
 * **Fix round 1, Critical 1: `endLine`/`count` represent a coalesced span**
 * of contiguous, byte-identical lines sharing this exact reason (and, for
 * `"duplicate-id-conflict"`, the same conflicting id) — `line`..`endLine`
 * inclusive, `count` of them, all byte-identical to the one line this entry
 * describes. This *is* the verbatim record for all `count` lines, since
 * they are byte-identical to each other by construction of the coalescing
 * check — not a summary that drops information a genuinely distinct line
 * would have needed. `endLine === line` and `count === 1` for an
 * uncoalesced, singleton failure.
 *
 * **Never carries the rejected line's raw bytes** — see `safeLinePreview`'s
 * doc comment for why. `lineBytes`/`lineSha256`/`linePreview` are populated
 * for every line-level reason and are always safe to print to a TTY,
 * `--json` output, or a CI log.
 *
 * **`possiblyLossy` (fix round 1, Medium, Ruling R44):** `true` when this
 * line's content contains a U+FFFD replacement character, meaning the
 * bytes this module received may already differ from what was actually on
 * disk (`git/transport.ts` decodes git's stdout as UTF-8 with a lossy,
 * substituting default — see `hasReplacementCharacter`'s doc comment).
 */
export interface DiagnosticFailure {
  readonly ref: string;
  readonly commit: string;
  readonly month: string;
  readonly line: number | null;
  readonly endLine?: number;
  readonly count?: number;
  readonly reason: DiagnosticFailureReason;
  readonly message: string;
  /** Structured remediation guidance for a reason this tool cannot repair by itself (currently only `"non-blob-month-path"`) — see `recover`'s doc comment, Ruling R43. */
  readonly remediation?: string;
  /** Only for `"invalid-json"`/`"schema-invalid"` — `parseEvent`'s own already-safe-to-publish issue list (see `schema.ts`'s `projectIssues`). */
  readonly issues?: readonly EventValidationIssue[];
  readonly lineBytes?: number;
  readonly lineSha256?: string;
  readonly linePreview?: string;
  readonly possiblyLossy?: boolean;
  /** Only for `"duplicate-id-conflict"` — the id both occurrences share, and where the *other* (earlier-encountered, in walk order — not "surviving": fix round 3, Ruling R47, neither occurrence is preferred or removed automatically) occurrence was found. */
  readonly eventId?: EventId;
  readonly firstMonth?: string;
  readonly firstLine?: number;
}

export interface DiagnosticReport {
  readonly ref: string;
  /** `null` only when the ref does not exist yet (fm6) — nothing to diagnose, mirroring `read()`'s own "absent ref returns `[]`" disposition. */
  readonly commit: string | null;
  readonly monthsScanned: readonly string[];
  readonly failures: readonly DiagnosticFailure[];
}

export interface DiagnoseOptions {
  readonly now?: number;
  readonly trailingMonths?: number;
}

/**
 * Walks the same aggregated month window `read()` does, but **never aborts**
 * and reports **every** failing line/month instead of throwing on the first
 * one. This is the tool an operator reaches for once `read()` is already
 * known to be failing — so, symmetrically with `read()`'s own fail-closed
 * design, this function must not itself fail closed on the first problem: a
 * non-blob month path is reported as a failure, not thrown past this
 * function's caller; an oversized blob is reported (and, past this
 * function's own resource ceiling, skipped, since its line boundaries
 * cannot be trusted past that budget) rather than crashing the whole run;
 * any other unexpected git-level error is the one thing still allowed to
 * propagate, since this function has no documented recovery for a git
 * failure outside the shapes ADR 0001:828-838 names.
 *
 * **Never throws on content, no matter how malformed, and never grows
 * without bound on it either (fix round 1, Critical 1).** `parseEvent`
 * already returns a structured failure for every content shape (obligation
 * 1 of task-1-brief.md); coalescing and `MAX_DIAGNOSTIC_FAILURES` bound how
 * much this function itself allocates in response. The only throws this
 * function can produce are `GIT_REF_INVALID` (a bad `ref` argument),
 * `EVENT_LOG_INVALID_WINDOW` (a bad `now`/`trailingMonths`), or an
 * unexpected git-level failure that is not one of the shapes handled above.
 *
 * **`commit` names the head this call resolved *before* reading any month's
 * blob** — under a concurrent append, a later month's content could reflect
 * a newer commit than the one reported. Harmless inside `recoverCore` (the
 * CAS against the *current* tip is what actually serializes recovery, not
 * this reported value); a caveat worth knowing if a human is reading
 * `diagnose()`'s own output directly rather than through `recover()`.
 */
export async function diagnose(adapter: GitAdapter, ref: string, options: DiagnoseOptions | null = {}): Promise<DiagnosticReport> {
  // Fix round 2, Low (NEW-5): a default parameter does not apply to an
  // explicit `null` (only to `undefined`) — without this, `diagnose(a, ref,
  // null)` threw a raw `TypeError` on `options.now` rather than surfacing
  // through this module's own validated error path.
  const opts = options ?? {};
  const validatedRef = await validateCoordinationRef(ref);
  const now = opts.now ?? Date.now();
  validateNowIsNumber(now);
  validateNowForDateFormatting(now);
  const trailingMonths = opts.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  validateTrailingMonths(trailingMonths);

  const head = await adapter.readRef(validatedRef);
  if (head === null) {
    return { ref: validatedRef, commit: null, monthsScanned: [], failures: [] };
  }

  return computeDiagnosticReport(adapter, validatedRef, head, now, trailingMonths);
}

/** One in-progress coalesced span of contiguous, byte-identical, same-reason line failures — see `DiagnosticFailure`'s own doc comment for what `line`/`endLine`/`count` mean once flushed. */
interface PendingSpan {
  readonly month: string;
  readonly reason: DiagnosticFailureReason;
  readonly rawLine: string;
  readonly startLine: number;
  endLine: number;
  readonly message: string;
  readonly remediation?: string;
  readonly issues?: readonly EventValidationIssue[];
  readonly eventId?: EventId;
  readonly firstMonth?: string;
  readonly firstLine?: number;
  readonly lineBytes: number;
  readonly lineSha256: string;
  readonly linePreview: string;
  readonly possiblyLossy: boolean;
}

/**
 * The shared walk behind both {@link diagnose} (which resolves `head` for
 * itself) and `recoverCore` (which passes the exact `head` it just read, so
 * a recovery attempt's diagnosis and its commit are built off the identical
 * git state — never a diagnosis from one read composed with a commit built
 * from a second, later one).
 */
async function computeDiagnosticReport(
  adapter: GitAdapter,
  validatedRef: string,
  head: string,
  now: number,
  trailingMonths: number,
): Promise<DiagnosticReport> {
  const months = trailingMonthKeysOldestFirst(now, trailingMonths);

  // Fix round 3 (Ruling R48, High, orchestrator security review): probe the
  // `events` prefix itself before trusting *any* per-month read below.
  // `read()`'s (and, before this fix, this function's own) per-month
  // `readBlobFromRef(ref, monthPath(month))` returns `null` — "no file for
  // this month" — indistinguishable from a genuinely empty board, when a
  // blob/symlink/gitlink is planted at the bare `events` path: `ls-tree`
  // simply finds no entry under a prefix that isn't a directory. Every
  // month silently reads as absent, `read()` returns `[]` (every live claim
  // vanishes from its result, fail-*open*, ADR fm8(b) named literally), and
  // this function previously reported zero failures — a diagnostic tool
  // whose whole job is to find what `read()` cannot see, silently agreeing
  // with the fail-open instead. One check, once per run, closes it: if
  // `events` is blocked, no per-month read below could ever be trusted
  // either, so this returns immediately with a single run-level failure
  // rather than scanning months that would all misreport as empty.
  // `month` is `DiagnosticFailure`'s one required-non-null coordinate with
  // no genuine single month to name here — the newest month in this run's
  // own window is used, nominally (there is nothing more specific to
  // report; the real coordinate is the `events` path itself, named in the
  // message and `remediation`).
  if (await isTreeEntryBlocked(adapter, validatedRef, EVENTS_PREFIX)) {
    const nominalMonth = months[months.length - 1] ?? "";
    return {
      ref: validatedRef,
      commit: head,
      monthsScanned: [],
      failures: [
        {
          ref: validatedRef,
          commit: head,
          month: nominalMonth,
          line: null,
          reason: "events-prefix-blocked",
          message: `the top-level "${EVENTS_PREFIX}" path does not resolve to a usable directory (a file, symlink, or gitlink is planted there instead); no event log month file underneath it can be read, and read() would otherwise silently treat the whole board as empty rather than fail closed`,
          remediation: `inspect the tree (e.g. \`git ls-tree ${validatedRef}\`) and rebuild it (git read-tree / git rm --cached ${EVENTS_PREFIX} / commit-tree / update-ref) to remove the entry planted at "${EVENTS_PREFIX}"`,
        },
      ],
    };
  }

  const failures: DiagnosticFailure[] = [];
  const monthsScanned: string[] = [];
  // Keyed by event id, to the raw line it was first validly seen as, and
  // where — the same first-occurrence-wins dedupe basis `read()` uses,
  // continued across the *whole* walk (not aborted on the first conflict)
  // so a later, unrelated conflict is still found in the same run.
  const seen = new Map<EventId, { readonly rawLine: string; readonly month: string; readonly line: number }>();
  let aggregateBytes = 0;
  let aggregateTooLargeReported = false;
  let pending: PendingSpan | null = null;
  // Fix round 2 (Ruling R45(a)): the running estimate of this run's total
  // quarantine-record serialized size, updated only when a *new* span opens
  // (never for a coalesced repeat of the same span — see
  // `recordLineFailure`) — see `MAX_QUARANTINE_RUN_BUDGET_BYTES`'s doc
  // comment for what this bounds and why it is checked here, during
  // diagnosis, rather than after `recoverCore` has already built the audit
  // string.
  let estimatedQuarantineBytes = 0;

  function flushPending(): void {
    if (pending === null) return;
    const span = pending;
    pending = null;
    const failure: DiagnosticFailure = {
      ref: validatedRef,
      commit: head,
      month: span.month,
      line: span.startLine,
      endLine: span.endLine,
      count: span.endLine - span.startLine + 1,
      reason: span.reason,
      message: span.message,
      lineBytes: span.lineBytes,
      lineSha256: span.lineSha256,
      linePreview: span.linePreview,
      possiblyLossy: span.possiblyLossy,
      ...(span.remediation !== undefined ? { remediation: span.remediation } : {}),
      ...(span.issues !== undefined ? { issues: span.issues } : {}),
      ...(span.eventId !== undefined ? { eventId: span.eventId } : {}),
      ...(span.firstMonth !== undefined ? { firstMonth: span.firstMonth } : {}),
      ...(span.firstLine !== undefined ? { firstLine: span.firstLine } : {}),
    };
    failures.push(failure);
  }

  /**
   * Records one line-level failure, coalescing it into the in-progress span
   * when it is contiguous with, and byte-identical to, the previous line's
   * failure of the same reason (fix round 1, Critical 1) — computing
   * `lineBytes`/`lineSha256`/`linePreview` only when a *new* span starts,
   * which is what actually bounds memory/CPU for a run of repeated
   * identical bad lines (the coalescing check itself is a cheap string
   * comparison, done before any hashing).
   *
   * Returns `"cap"` when the cap on *distinct* spans (`MAX_DIAGNOSTIC_
   * FAILURES`) has been reached and a new span could not be opened at all —
   * the caller must stop scanning, and nothing from this call was recorded.
   * Returns `"budget"` (fix round 2, Ruling R45(a)) when a new span *was*
   * opened (so this call's failure is always recorded — see
   * `MAX_QUARANTINE_RUN_BUDGET_BYTES`'s own doc comment for why the check
   * runs *after* opening it), but doing so pushed the running estimated
   * quarantine-record size over budget — the caller must stop scanning
   * *after* this one. Returns `"ok"` otherwise.
   */
  function recordLineFailure(
    month: string,
    line: number,
    reason: DiagnosticFailureReason,
    rawLine: string,
    message: string,
    extra?: { remediation?: string; issues?: readonly EventValidationIssue[]; eventId?: EventId; firstMonth?: string; firstLine?: number },
  ): "ok" | "cap" | "budget" {
    if (pending !== null && pending.month === month && pending.reason === reason && pending.endLine === line - 1 && pending.rawLine === rawLine) {
      pending.endLine = line;
      return "ok";
    }
    flushPending();
    if (failures.length >= MAX_DIAGNOSTIC_FAILURES) {
      return "cap";
    }
    const lineBytes = Buffer.byteLength(rawLine, "utf8");
    pending = {
      month,
      reason,
      rawLine,
      startLine: line,
      endLine: line,
      message,
      remediation: extra?.remediation,
      issues: extra?.issues,
      eventId: extra?.eventId,
      firstMonth: extra?.firstMonth,
      firstLine: extra?.firstLine,
      lineBytes,
      lineSha256: lineDigest(rawLine),
      linePreview: safeLinePreview(rawLine),
      possiblyLossy: hasReplacementCharacter(rawLine),
    };
    // Fix round 2 (Ruling R45(a)): budget on what this span will actually
    // cost to *embed* — capped at `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`,
    // since `buildQuarantineRecord` will truncate to that cap regardless of
    // how much larger `lineBytes` itself is.
    //
    // Fix round 3 (Ruling R47): a `"duplicate-id-conflict"` span is never
    // embedded in a quarantine record any more (removed from
    // `FIXABLE_REASONS` — see that constant's doc comment), so charging it
    // against this run's quarantine-write budget would only make an
    // unrelated fixable line further in the same run truncate sooner than
    // necessary, for a span that will never actually cost anything to
    // write. Only a reason `buildQuarantineRecord` can actually be called
    // for contributes.
    if (FIXABLE_REASONS.has(reason)) {
      const cappedForBudget = Math.min(lineBytes, MAX_QUARANTINE_RAW_BYTES_PER_RECORD);
      estimatedQuarantineBytes += cappedForBudget * QUARANTINE_ESCAPE_EXPANSION_FACTOR + QUARANTINE_RECORD_OVERHEAD_BYTES;
    }
    return estimatedQuarantineBytes > MAX_QUARANTINE_RUN_BUDGET_BYTES ? "budget" : "ok";
  }

  function pushTruncatedMarker(month: string, line: number | null, kind: "resource" | "count" | "budget"): void {
    const message =
      kind === "resource"
        ? `this diagnostic run's own resource bound was reached at month ${month}; scanning stopped here — re-run recovery (possibly more than once) to make further progress`
        : kind === "count"
          ? `this diagnostic run's own failure-count bound (${MAX_DIAGNOSTIC_FAILURES}) was reached at ${month}:${line}; scanning stopped here — re-run recovery (possibly more than once) to make further progress`
          : `this diagnostic run's own quarantine-audit-size budget (${MAX_QUARANTINE_RUN_BUDGET_BYTES} bytes, estimated) was reached at ${month}:${line}; scanning stopped here — re-run recovery (possibly more than once) to make further progress`;
    failures.push({
      ref: validatedRef,
      commit: head,
      month,
      line: null,
      reason: "diagnostic-truncated",
      message,
    });
  }

  monthsLoop: for (const month of months) {
    const path = monthPath(month);
    let raw: string | null;
    try {
      raw = await adapter.readBlobFromRef(validatedRef, path);
    } catch (cause) {
      // ADR 0001:828-838's second named failure shape: "a month path
      // resolving to a non-blob aborts" `read()` outright, since
      // `readBlobFromRef` throws rather than returning a value for this
      // case. Reported here, not rethrown, so the walk continues.
      if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
        flushPending();
        monthsScanned.push(month);
        failures.push({
          ref: validatedRef,
          commit: head,
          month,
          line: null,
          reason: "non-blob-month-path",
          message: `${path} does not resolve to a usable blob (a directory, symlink, or non-100644 entry is planted there). Recovery cannot repair this automatically without risking silent data loss, since replacing the entry would discard whatever is nested under it with no audit trail.`,
          // Fix round 1, High (Ruling R43): a structured field, not only
          // prose — a consumer (e.g. M3.9's `doctor`) renders fields, not
          // sentences.
          remediation: `inspect the tree (e.g. \`git ls-tree -r ${validatedRef} -- ${path}\`) and manually rebuild the ref's tree (git read-tree / git rm --cached / commit-tree / update-ref) to replace ${path} with a valid, empty JSONL blob`,
        });
        continue;
      }
      throw cause;
    }
    if (raw === null) {
      continue; // No file for this month (yet, or never) — not a failure.
    }
    monthsScanned.push(month);

    const rawBytes = Buffer.byteLength(raw, "utf8");

    // Fix round 1, Critical 1: this function's own "can I even safely
    // process this at all" ceiling — separate from, and larger than,
    // read()'s real per-month cap checked just below.
    if (rawBytes > MAX_DIAGNOSTIC_MONTH_BLOB_BYTES) {
      flushPending();
      failures.push({
        ref: validatedRef,
        commit: head,
        month,
        line: null,
        reason: "blob-too-large",
        message: `month file (${rawBytes} bytes) exceeds this diagnostic tool's own resource bound (${MAX_DIAGNOSTIC_MONTH_BLOB_BYTES} bytes) and cannot be safely scanned line by line`,
      });
      continue;
    }

    aggregateBytes += rawBytes;

    // Fix round 1, Critical 3 (Ruling R42): report in read()'s own
    // vocabulary, at read()'s own real bound (imported, not copied) — a
    // month between this bound and this file's own larger ceiling above is
    // still fully scanned for line-level issues (it is well within this
    // tool's own budget), but is also honestly flagged as something read()
    // will refuse regardless, per `recoverCore`'s own post-rebuild recheck.
    if (rawBytes > MAX_MONTH_BLOB_BYTES) {
      failures.push({
        ref: validatedRef,
        commit: head,
        month,
        line: null,
        reason: "blob-too-large",
        message: `month file (${rawBytes} bytes) exceeds read()'s own maximum blob size (${MAX_MONTH_BLOB_BYTES} bytes); read() will refuse this month regardless of any line-level issue found below, unless recovery shrinks it under that bound`,
      });
    }

    // Fix round 1, Critical 3 / Medium (aggregate-bound cascade): fires at
    // most once per run, and never interpolates a per-month size into what
    // is a whole-window figure.
    if (!aggregateTooLargeReported && aggregateBytes > MAX_AGGREGATE_READ_BYTES) {
      aggregateTooLargeReported = true;
      failures.push({
        ref: validatedRef,
        commit: head,
        month,
        line: null,
        reason: "aggregate-too-large",
        message: `the aggregated read window's total size (${aggregateBytes} bytes across ${monthsScanned.length} month(s) scanned so far) exceeds read()'s own maximum aggregate size (${MAX_AGGREGATE_READ_BYTES} bytes); read() will refuse this window regardless of any line-level issue found`,
      });
    }

    if (aggregateBytes > MAX_DIAGNOSTIC_AGGREGATE_SAFETY_BYTES) {
      flushPending();
      pushTruncatedMarker(month, null, "resource");
      break;
    }

    const lines = splitJsonlLines(raw);
    for (let line = 0; line < lines.length; line++) {
      const rawLine = lines[line] ?? "";

      // Fix round 1, Critical 3 (Ruling R42): the size gate runs *before*
      // `parseEvent` — matching obligation A's own ordering in `read()` —
      // at read()'s real `MAX_LINE_BYTES`, so a schema-perfect-once-parsed
      // but byte-oversized line (whitespace padding, or a duplicate-JSON-key
      // shape whose first value alone exceeds the cap) is caught here and
      // never reaches `JSON.parse` at all, exactly like `read()`.
      if (Buffer.byteLength(rawLine, "utf8") > MAX_LINE_BYTES) {
        const status = recordLineFailure(
          month,
          line,
          "line-too-large",
          rawLine,
          `event log line exceeds read()'s own maximum line size (${MAX_LINE_BYTES} bytes)`,
        );
        if (status !== "ok") {
          pushTruncatedMarker(month, line, status === "cap" ? "count" : "budget");
          break monthsLoop;
        }
        continue;
      }

      const parsed = parseEvent(rawLine, { now });
      if (!parsed.ok) {
        const status = recordLineFailure(month, line, parsed.error.reason, rawLine, parsed.error.message, { issues: parsed.error.issues });
        if (status !== "ok") {
          pushTruncatedMarker(month, line, status === "cap" ? "count" : "budget");
          break monthsLoop;
        }
        continue;
      }

      const event = parsed.event;
      const previous = seen.get(event.id);
      if (previous !== undefined) {
        // Obligation B, decided deliberately: duplicate-id "content" is
        // compared as raw line bytes — see `log.ts`'s own identical
        // reasoning.
        if (previous.rawLine === rawLine) {
          continue; // Byte-identical duplicate — folded, exactly as `read()` folds it.
        }
        // Fix round 3 (Ruling R47, Critical NEW-1): **never** automatically
        // remove either occurrence — see `FIXABLE_REASONS`'s doc comment
        // for why "the earlier one wins" is not a safe default this tool
        // can apply itself. `remediation` names both occurrences with
        // enough coordinates for an operator to inspect and remove the
        // forged one by hand.
        const status = recordLineFailure(month, line, "duplicate-id-conflict", rawLine, `duplicate event id with differing content: ${event.id}`, {
          remediation: `two occurrences of event id ${event.id} carry differing content — this tool cannot safely determine which is genuine, so recovery never removes either automatically. Both lines remain in the log: inspect them by hand (\`git show ${validatedRef}:${monthPath(previous.month)}\` — line ${previous.line} — and \`git show ${validatedRef}:${monthPath(month)}\` — line ${line}), determine which is the forgery, then manually rebuild the ref's tree (git read-tree / git rm --cached / commit-tree / update-ref) to remove it. read() will keep refusing with EVENT_LOG_DUPLICATE_ID_CONFLICT until one of the two lines is gone.`,
          eventId: event.id,
          firstMonth: previous.month,
          firstLine: previous.line,
        });
        if (status !== "ok") {
          pushTruncatedMarker(month, line, status === "cap" ? "count" : "budget");
          break monthsLoop;
        }
        continue; // Neither occurrence is touched by this walk — both remain, unresolved, for an operator to inspect (Ruling R47).
      }

      seen.set(event.id, { rawLine, month, line });
    }
  }

  flushPending();

  return { ref: validatedRef, commit: head, monthsScanned, failures };
}

// ============================================================================
// Half 2 — returning the ref to a readable state
// ============================================================================

/**
 * The {@link DiagnosticFailureReason}s recovery can repair by removing
 * exactly the offending line(s). `"non-blob-month-path"`,
 * `"blob-too-large"`, `"aggregate-too-large"`, and `"diagnostic-truncated"`
 * are month-level or run-level, structural findings with no single line to
 * remove — see `recover`'s doc comment for why they are reported back as
 * `unresolved` rather than repaired.
 *
 * **Fix round 1, Critical 3 (Ruling R42): `"line-too-large"` is fixable** —
 * a single oversized line is exactly as removable as a schema-invalid one.
 *
 * **Fix round 3, Ruling R47 (Critical, orchestrator security review):
 * `"duplicate-id-conflict"` is deliberately NOT in this set — it was fixable
 * through fix round 2, and that was itself the defect.** The pre-fix code
 * removed the *later* occurrence in **oldest-month-first walk order** and
 * kept the *earlier* one, reasoning (wrongly) that "earlier in the
 * append-only chain" meant "the honest original." It does not: which month
 * a line lands in is chosen by the peer that writes it, not by this module,
 * so an attacker forges a conflicting line into a month *before* the
 * victim's real one — well within the default `trailingMonths: 2` window —
 * and this walk finds the *forgery* first. Demonstrated end to end
 * (`recovery.test.ts`, Ruling R47's test): alice's real claim at
 * `2026-09:0`, mallory's differing `release` forged into `2026-08:0` under
 * the same id; against the pre-fix code, `recover()` reported
 * `outcome: "recovered"`, quarantined *alice's* claim, and kept mallory's
 * forgery — `ck-1` then read as released, and the very operator action
 * meant to restore readability manufactured the double-claim the whole
 * design exists to prevent. ADR 0001:738-742 requires a duplicate with
 * differing content be **rejected, not silently picked**; ADR 0001:811-826
 * establishes there is no attacker-independent key to pick a survivor by
 * among mutually-distrusting peers — so an automatic pick is not available,
 * and quarantining *both* occurrences would still be an automatic pick (of
 * "neither survives"), destroying a live claim without operator judgment
 * either way. **Declining to act is the only choice this tool can make
 * safely**: every `"duplicate-id-conflict"` failure is now always
 * `unresolved`, carrying a `remediation` naming both occurrences' exact
 * `(month, line)` coordinates so an operator — who can see both lines and
 * judge which is genuine, which this tool cannot — can remove the forged
 * one by hand. See `recover`'s own "What an attacker gains" section for
 * the corrected security argument.
 */
const FIXABLE_REASONS: ReadonlySet<DiagnosticFailureReason> = new Set(["invalid-json", "schema-invalid", "line-too-large"]);

/**
 * One line removed from a month file by a `recover()` call, as written into
 * this call's own `quarantine/<month>/<sortableId>.jsonl` file — a JSONL
 * file distinct from every `events/<month>.jsonl` (see
 * `quarantineDirPath`'s doc comment for why `read()` cannot reach it).
 * Records the removed line's content, its reason, and its original
 * position, so an operator can tell a corruption from an attack and, if
 * needed, recover a wrongly-quarantined event by hand.
 *
 * **`line`/`endLine`/`count` (fix round 1, Critical 1) represent a
 * coalesced span** of contiguous, byte-identical lines — see
 * `DiagnosticFailure`'s own doc comment; `raw` is that one shared line's
 * content, which *is* the verbatim record for all `count` of them.
 *
 * **On "byte-for-byte" — fix round 1, Medium, Ruling R44, replacing an
 * overclaim in the original version of this comment.** `raw` is preserved
 * exactly as this module received it: a JSON *string value* inside this
 * record, produced by this file's own `JSON.stringify` when the record is
 * serialized, never embedded literally into the file — lossless with
 * respect to what this module was handed (round-trips through `JSON.parse`
 * unchanged, including any control character, lone surrogate, or U+2028)
 * and inert as terminal output (JSON string encoding escapes every C0
 * control character, ESC included, by construction, so `cat`/`git show`-ing
 * the quarantine file cannot replay the terminal takeover dispatch 1's
 * security review demonstrated). **What this module was handed is not
 * always what was actually on disk**: confirmed by direct probe, writing
 * raw non-UTF-8 bytes into a real git blob and reading it back through
 * `GitAdapter.readBlobFromRef` yields U+FFFD in place of the original
 * bytes, which are gone before this module — or any consumer of the
 * adapter — ever sees them. `possiblyLossy` names this honestly rather than
 * silently claiming a fidelity this module cannot verify; see
 * `hasReplacementCharacter`'s doc comment for the heuristic's own limits,
 * and `task-4-report.md` for the M2.6 follow-up (a raw-bytes read
 * primitive) that would close this properly.
 *
 * **`rawTruncated` (fix round 2, Ruling R45(a)): `true` when `raw` is a
 * prefix of the original line, not the whole thing.** `buildQuarantineRecord`
 * caps embedded raw content at `MAX_QUARANTINE_RAW_BYTES_PER_RECORD` — see
 * that constant's doc comment for why a single adversarial line otherwise
 * makes this record's own serialized size unbounded, independent of
 * `MAX_QUARANTINE_RUN_BUDGET_BYTES`. The removed line's full original byte
 * length is still available via the matching `DiagnosticFailure`/
 * `QuarantinedLineSummary`'s `lineBytes`, and its identity via
 * `lineSha256` — both computed from the *untruncated* line — so an operator
 * can always tell a record is a prefix and by how much, even though the
 * full bytes are not repeated here.
 *
 * **`possiblyLossy` and `rawTruncated` name two different, independent loss
 * mechanisms — check both, not just one.** `possiblyLossy` is computed from
 * the *original*, untruncated line (adapter-induced loss only: U+FFFD from
 * the git transport's own lossy UTF-8 decoding, present before this module
 * ever sees the content — see `hasReplacementCharacter`'s doc comment).
 * `truncateRawForQuarantine`'s own byte cut can *separately* introduce a
 * trailing U+FFFD at the truncation boundary when it lands mid-multibyte-
 * sequence — a record can therefore have `rawTruncated: true` and
 * `possiblyLossy: false` while still containing a truncation-boundary
 * U+FFFD that `possiblyLossy` was never asked about. This is consistent
 * with, not worse than, `possiblyLossy`'s already-disclosed imprecision;
 * `rawTruncated` alone is the correct signal for "this record's `raw` may
 * end mid-character," independent of `possiblyLossy`.
 */
export interface QuarantineRecord {
  /** ISO-8601 UTC instant of the `recover()` call that removed this line — this module's own clock, per the same "never trust a peer-supplied clock" discipline as `ts`/`lease_until` (`schema.ts`). */
  readonly quarantinedAt: string;
  readonly month: string;
  readonly line: number;
  readonly endLine: number;
  readonly count: number;
  readonly reason: DiagnosticFailureReason;
  readonly message: string;
  readonly issues?: readonly EventValidationIssue[];
  readonly eventId?: EventId;
  readonly firstMonth?: string;
  readonly firstLine?: number;
  readonly possiblyLossy: boolean;
  readonly rawTruncated: boolean;
  readonly raw: string;
}

/** A sanitized summary of one removed line/span, as returned in `RecoveryResult.quarantined` — the same safe-to-publish shape `DiagnosticFailure` uses, never the raw bytes (those live only in the persisted `QuarantineRecord`, and only there). `path` names the exact `quarantine/<month>/<...>.jsonl` file this span's `QuarantineRecord` was written to (fix round 2: each `recover()` call writes its own new file per month — see `buildQuarantineFilePath`'s doc comment — so this is the only reliable way to locate a specific span's record; there is no enumerable index of every quarantine file ever written, by the same `GitAdapter`-exposes-no-tree-enumeration constraint `quarantineDirPath`'s own doc comment names). */
export interface QuarantinedLineSummary {
  readonly month: string;
  readonly line: number;
  readonly endLine: number;
  readonly count: number;
  readonly reason: DiagnosticFailureReason;
  readonly message: string;
  readonly lineBytes: number;
  readonly lineSha256: string;
  readonly linePreview: string;
  readonly possiblyLossy: boolean;
  readonly rawTruncated: boolean;
  readonly path: string;
}

export interface RecoveryResult {
  readonly ref: string;
  /**
   * **Fix round 1, Critical 4: derived from both `fixable` and `unresolved`,
   * never `fixable` alone.** `"clean"` only when nothing fixable *and*
   * nothing unresolved was found — a genuinely healthy board, no commit
   * made. `"recovered"` when at least one fixable line was removed this
   * call (a new commit was applied); `unresolved` may still be non-empty
   * afterward. `"unrepairable"` when nothing was fixable this call but
   * `unresolved` is non-empty — the board is still not fully readable and
   * this pass could not do anything about it (no commit made). A consumer
   * that branches on `outcome` without also checking `unresolved.length`
   * for the `"recovered"` case can still be misled about *full* recovery,
   * but can never be told `"clean"` while `read()` would still throw.
   */
  readonly outcome: "clean" | "recovered" | "unrepairable";
  /** The ref's tip immediately before this call. `null` only when the ref did not exist at all. */
  readonly previousTip: string | null;
  /** The ref's tip after this call — identical to `previousTip` for `"clean"`/`"unrepairable"`. */
  readonly newTip: string | null;
  readonly monthsRewritten: readonly string[];
  readonly quarantined: readonly QuarantinedLineSummary[];
  /** Failures `diagnose` found that this call could **not** repair (month-level/run-level, structural failures — see `FIXABLE_REASONS`'s doc comment) — reported honestly rather than silently dropped, so an operator knows the board may still be partially unreadable. */
  readonly unresolved: readonly DiagnosticFailure[];
  /** Fix round 1, Medium (Ruling R44): months this call rewrote where at least one line (kept **or** quarantined) contained a U+FFFD replacement character — see `QuarantineRecord`'s doc comment. Every other event in a listed month may have been silently altered by the git adapter's own lossy UTF-8 decoding before this module ever saw it, independent of whatever this call actually fixed. */
  readonly monthsWithPossibleEncodingLoss: readonly string[];
}

export interface RecoveryOptions {
  readonly now?: number;
  readonly trailingMonths?: number;
  readonly casRetry?: CasRetryOptions;
}

/**
 * Builds this call's quarantine file's new record for one removed
 * line/span. `raw` is `lines[failure.line]` — captured **before** the line
 * is dropped from the rebuilt month content, so this is the exact original
 * text this module received, not a re-derivation. **Fix round 2, Ruling
 * R45(a): truncates `raw` to `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`** when
 * the removed line itself is larger than that — see that constant's and
 * `QuarantineRecord.rawTruncated`'s doc comments for why and what is still
 * recoverable when it happens (`lineBytes`/`lineSha256`, computed from the
 * untruncated line, on the matching `DiagnosticFailure`/
 * `QuarantinedLineSummary`).
 */
function buildQuarantineRecord(quarantinedAt: string, failure: DiagnosticFailure, raw: string): QuarantineRecord {
  const { value: storedRaw, truncated } = truncateRawForQuarantine(raw, MAX_QUARANTINE_RAW_BYTES_PER_RECORD);
  const record: {
    quarantinedAt: string;
    month: string;
    line: number;
    endLine: number;
    count: number;
    reason: DiagnosticFailureReason;
    message: string;
    issues?: readonly EventValidationIssue[];
    eventId?: EventId;
    firstMonth?: string;
    firstLine?: number;
    possiblyLossy: boolean;
    rawTruncated: boolean;
    raw: string;
  } = {
    quarantinedAt,
    month: failure.month,
    // biome-ignore lint/style/noNonNullAssertion: `failure.line` is guaranteed non-null here — this is only ever called for a member of `FIXABLE_REASONS`, all of which are line-level (see `FIXABLE_REASONS`'s doc comment).
    line: failure.line!,
    endLine: failure.endLine ?? (failure.line as number),
    count: failure.count ?? 1,
    reason: failure.reason,
    message: failure.message,
    possiblyLossy: failure.possiblyLossy ?? hasReplacementCharacter(raw),
    rawTruncated: truncated,
    raw: storedRaw,
  };
  if (failure.issues !== undefined) record.issues = failure.issues;
  if (failure.eventId !== undefined) record.eventId = failure.eventId;
  if (failure.firstMonth !== undefined) record.firstMonth = failure.firstMonth;
  if (failure.firstLine !== undefined) record.firstLine = failure.firstLine;
  return record;
}

/** Projects a fixable `DiagnosticFailure` into `RecoveryResult.quarantined`'s sanitized shape — never `raw`. `path`/`rawTruncated` are threaded through from the actual write, since neither is knowable from the `DiagnosticFailure` alone. */
function toQuarantinedLineSummary(failure: DiagnosticFailure, path: string, rawTruncated: boolean): QuarantinedLineSummary {
  return {
    // biome-ignore lint/style/noNonNullAssertion: same guarantee as `buildQuarantineRecord` above.
    line: failure.line!,
    endLine: failure.endLine ?? (failure.line as number),
    count: failure.count ?? 1,
    month: failure.month,
    reason: failure.reason,
    message: failure.message,
    path,
    rawTruncated,
    lineBytes: failure.lineBytes ?? 0,
    lineSha256: failure.lineSha256 ?? "",
    linePreview: failure.linePreview ?? "",
    possiblyLossy: failure.possiblyLossy ?? false,
  };
}

/**
 * Test-only injection point for `recoverCore`'s retry loop — the same
 * pattern as `log.ts`'s `AppendHooks` and `ref.ts`'s `InitRefHooks`, and
 * **not part of the public surface** (`recoverCore` is not re-exported from
 * `events/index.ts`; a test imports it directly the way `log.test.ts`
 * imports `appendCore`).
 */
export interface RecoveryHooks {
  /** Invoked once per CAS attempt, after this attempt's fresh read-and-diagnose step and immediately before `commitTreeToRef`. A test uses this to interleave a real, concurrent `append()` from a second worktree, forcing this attempt's CAS to lose deterministically. */
  readonly beforeCas?: (attemptNumber: number) => Promise<void>;
}

/**
 * Fix round 1, Critical 2 (generalized in fix round 2): probes an exact
 * directory-shaped `quarantine/...` path — either the literal top-level
 * `quarantine` path, or one specific month's `quarantine/<month>` path —
 * before any write that needs it to actually be usable as a directory, and
 * throws `EVENT_RECOVERY_QUARANTINE_BLOCKED` if a blob is planted directly
 * at it instead.
 *
 * **Why this needs its own probe, separate from the actual per-call file
 * write.** Git cannot represent one path as both a blob and a directory
 * prefix in the same tree. A blob planted at a bare directory path (no
 * further suffix) does not make `readBlobFromRef(ref,
 * "<that path>/<anything>")` throw or return non-null — `ls-tree` simply
 * finds no entry under a prefix that isn't a directory, so the read returns
 * `null`, indistinguishable from "nothing written here yet." The conflict
 * only surfaces later, when `commitTreeToRef` tries to add an index entry
 * for a path *under* that prefix on top of an index that already has a
 * *blob* entry for the prefix itself, and `git write-tree` fails. Probing
 * the exact directory path directly — confirmed by probe (three real git
 * states: absent, a genuine directory, a blob) — discriminates all three up
 * front: `null` (nothing planted, fine), `GIT_BLOB_AMBIGUOUS` (a real
 * directory — `ls-tree` against an exact non-trailing-slash path returns
 * the directory's own tree entry, mode `040000`, which fails the
 * `mode === "100644"` check the same way `ref.ts`'s own usability probe's
 * tree case does — fine, this is the normal, healthy state once any file
 * has ever been written under it), or a non-null **string** (a blob really
 * is planted there — the one case that blocks every future write under
 * that prefix, named and thrown here).
 *
 * **Fix round 2: called at two levels, not one.** The bare top-level
 * `quarantine` path is checked once per attempt (as fix round 1 already
 * did); the bare `quarantine/<month>` path is now *also* checked, once per
 * month this attempt is about to write into, since per-call files
 * (`quarantine/<month>/<sortableId>.jsonl` — see `buildQuarantineFilePath`)
 * introduce this same D/F conflict one level deeper, at a path that *is*
 * still deterministic (unlike the per-call file's own randomized name) and
 * therefore still pre-plantable.
 *
 * **Fix round 3 (Ruling R48's mode-check, applied here too — orchestrator
 * security review): `GIT_BLOB_AMBIGUOUS` alone is not proof of a healthy
 * directory.** The version of this function through fix round 2 treated
 * *any* `GIT_BLOB_AMBIGUOUS` as "a real directory, fine" — true for a
 * directory (mode `040000`), but the identical error code is also what
 * `readBlobFromRef` raises for a **symlink** (`120000`) or a **gitlink**
 * (`160000`) planted at the exact path, since both fail the adapter's own
 * `mode === "100644"` check the same way a directory does. Confirmed by
 * direct probe (real `update-index --cacheinfo 120000,...`/`160000,...`):
 * both throw `GIT_BLOB_AMBIGUOUS` with `details.mode` set to `"120000"`/
 * `"160000"` respectively — this function now reads that field via
 * {@link isTreeEntryBlocked} and treats anything other than `"040000"` as
 * blocked, closing the same class of gap Ruling R48 found in `read()`'s own
 * `events`-prefix blind spot.
 */
async function assertQuarantineDirectoryUsable(adapter: GitAdapter, validatedRef: string, dirPath: string): Promise<void> {
  if (await isTreeEntryBlocked(adapter, validatedRef, dirPath)) {
    throw new CanKanError(
      EventErrorCodes.EVENT_RECOVERY_QUARANTINE_BLOCKED,
      `the "${dirPath}" path does not resolve to a usable directory (a file, symlink, or gitlink is planted there instead), so recovery cannot write any audit record under it`,
      {
        details: {
          ref: validatedRef,
          path: dirPath,
          remediation: `remove the entry planted at "${dirPath}" (rebuild the ref's tree: git read-tree / git rm --cached ${dirPath} / commit-tree / update-ref) before retrying recovery`,
        },
      },
    );
  }
}

/**
 * Fix round 3 (Ruling R48): the shared, non-throwing discriminator behind
 * both {@link assertQuarantineDirectoryUsable} and
 * {@link computeDiagnosticReport}'s own `events`-prefix probe — one
 * implementation, two call sites deciding differently what to do with the
 * answer (throw immediately vs. report and continue diagnosing).
 *
 * Returns `true` when `path` is **blocked** — a real blob (a non-null
 * string return, no throw), or a non-blob entry whose mode is not `040000`
 * (a symlink `120000` or a gitlink `160000`, confirmed by direct probe to
 * both throw `GIT_BLOB_AMBIGUOUS` with that mode in `details`, exactly like
 * a directory does — the adapter's own `mode === "100644"` check does not
 * distinguish *which* non-blob shape it found). Returns `false` when
 * `path` is safely usable as a directory prefix — absent (`null`, nothing
 * planted, fine — a future write under it is unconstrained), or a genuine
 * directory (`GIT_BLOB_AMBIGUOUS` with `details.mode === "040000"`). Any
 * *other* error (a real git-level failure unrelated to this path's shape)
 * still propagates — this function only ever resolves the "is this
 * specific path usable as a directory" question, nothing else.
 */
async function isTreeEntryBlocked(adapter: GitAdapter, validatedRef: string, path: string): Promise<boolean> {
  let existing: string | null;
  try {
    existing = await adapter.readBlobFromRef(validatedRef, path);
  } catch (cause) {
    if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
      const mode = cause.details?.mode;
      return !(typeof mode === "string" && mode === "040000");
    }
    throw cause;
  }
  return existing !== null;
}

/**
 * Returns a poisoned coordination ref to a readable state — ADR
 * 0001:828-847's recovery path.
 *
 * **This is a new commit on top of the current tip, never a CAS rewind to a
 * known-good ancestor (Ruling R8, orchestrator, binding).** ADR 0001:262-266
 * establishes the coordination ref is only ever advanced by CAS, never
 * force-pushed; a rewind would make every peer's next push non-fast-forward,
 * converting one operator's local recovery into a fleet-wide outage. See
 * `recovery.test.ts`'s ancestry test — it asserts the *previous* tip is an
 * ancestor of the *new* one, which a rewind implementation would fail.
 *
 * **The algorithm, generalized from `append`'s own mandated cycle (ADR
 * 0001:696-699) the same way `append` generalized `claimViaCAS`'s**: read the
 * ref, diagnose it fresh against that exact read, confirm the quarantine
 * path itself is usable (fix round 1, Critical 2), build the repaired
 * commit off-tree, `commitTreeToRef`, and on rejection, re-read and
 * re-diagnose from scratch — never blind-retry a stale diagnosis or a stale
 * tree (fm1's rule, restated for recovery). For each month with at least one
 * *fixable* failure ({@link FIXABLE_REASONS}): read its current blob, drop
 * exactly the offending line span(s) (by index, computed against this
 * attempt's own fresh read), and write one `QuarantineRecord` per removed
 * span into this call's own new `quarantine/<month>/<sortableId>.jsonl` file
 * (fix round 2, Ruling R45(b) — never read, appended to, or grown from an
 * earlier call's quarantine file; see `quarantineDirPath`'s doc comment for
 * why). Every other file in the tree — every other month, every earlier
 * call's quarantine file — survives untouched via
 * `commitTreeToRef`'s own overlay behavior (`git read-tree <parent>` into a
 * private index, verified directly at `git/adapter.ts:200-222`), so this
 * call never needs to (and never does) carry forward content it did not
 * itself change.
 *
 * **Valid events in an affected month always survive**: only the exact
 * line indices `diagnose` reported are dropped; every other line — whatever
 * order it was already in — is written back unchanged, in the same
 * relative order. A month with only *unresolved* (structural) failures is
 * never rewritten at all, and those failures are reported back in
 * `RecoveryResult.unresolved` rather than silently absorbed.
 *
 * **A no-op recovery makes no commit.** If `diagnose` finds nothing fixable
 * (`outcome: "clean"` or `"unrepairable"`), this function does not write an
 * empty quarantine commit — recovery is meant to repair a specific, real
 * corruption, not to be a routine no-op mutation of a healthy board's
 * history.
 *
 * **Never called by `append`/`read`, and never should be** — see this
 * module's own file-level doc comment. The one call site is deliberately
 * this function's own public export, invoked only by an explicit operator
 * action.
 *
 * **A `"non-blob-month-path"` failure is diagnosed but never automatically
 * repaired (Ruling R43, High).** Replacing a directory/symlink entry with a
 * blob would need `update-index --replace`/`git rm --cached -r` (M2.6
 * surface Ruling R19 puts out of bounds for this dispatch), and doing so
 * would discard whatever is nested under that path with no audit record to
 * preserve it — the one thing this module must never do. Left unresolved
 * and reported with a concrete `remediation` field naming the exact path
 * and the manual steps to rebuild the ref's tree; `outcome` never reports
 * `"clean"` while one is outstanding (see `RecoveryResult.outcome`'s doc
 * comment).
 *
 * ## What an attacker gains from provoking a recovery run
 *
 * **Corrected in fix round 3 (Ruling R47, orchestrator security review) —
 * the version of this section through fix round 2 made a claim that was
 * false, and the false claim was itself exploitable.** It said an attacker
 * "cannot evict a rival's already-appended, valid claim by replaying a
 * conflicting duplicate under the same id *after* it," with "after"
 * carrying the entire weight of the argument — resting on the unstated
 * assumption that recovery's oldest-*month*-first walk order tracks real
 * chronological order. It does not: a peer chooses which month file its own
 * line lands in, so an attacker forges the conflicting duplicate into an
 * *earlier* month (well within the default `trailingMonths: 2` window) and
 * this walk finds the forgery first, not the victim's real claim.
 * Demonstrated end to end, reproduced against the pre-fix code
 * (`recovery.test.ts`): alice's real claim at `2026-09:0`; mallory pushes a
 * differing `release` under the same id into `2026-08:0`; `recover()`
 * reported `outcome: "recovered"`, quarantined *alice's* line, kept
 * mallory's forgery — the operator's own recovery run manufactured the
 * double-claim this whole design exists to prevent, and the audit record
 * attributed it to ordinary corruption cleanup.
 *
 * An attacker with push access can already make the board unreadable with
 * one push (that is the vulnerability this file exists to remedy, not one it
 * introduces) and can push a line specifically shaped to *look* worth
 * quarantining. What they cannot do, as of this fix, is use a recovery run
 * to delete a legitimate competing claim:
 *
 * - Recovery only ever removes a line that **independently, deterministically
 *   fails the identical check `read()` itself already applies** — schema
 *   validation, JSON well-formedness, or an oversized byte length. A
 *   legitimate `claim`/`release`/any other event is, by definition,
 *   schema-valid and within `read()`'s size bounds, so it is never a member
 *   of `FIXABLE_REASONS`'s domain — this function has no code path that
 *   removes such a line, for any reason.
 * - `"duplicate-id-conflict"` — the one reason that involves *two* lines,
 *   and therefore the one an attacker could otherwise weaponize against a
 *   rival's line by construction — is **never in `FIXABLE_REASONS`
 *   (Ruling R47)**. Recovery does not remove, quarantine, or otherwise act
 *   on *either* occurrence of a duplicate-id conflict, regardless of month
 *   placement, walk order, or which one an attacker shapes to "look"
 *   forged. Both lines remain exactly where they were pushed, `read()`
 *   keeps refusing with `EVENT_LOG_DUPLICATE_ID_CONFLICT`, and the failure
 *   is reported `unresolved` with a `remediation` naming both occurrences'
 *   coordinates — an operator, who can actually see both lines and judge
 *   which is genuine, resolves it by hand. This is ADR 0001:738-742's own
 *   requirement ("rejected, not silently picked") and ADR 0001:811-826's
 *   own admission (no attacker-independent survivor key exists among
 *   mutually-distrusting peers) applied literally: since no automatic pick
 *   is available, and quarantining *both* occurrences would still be an
 *   automatic pick — of "neither survives" — declining to act at all is the
 *   only choice that cannot destroy a live claim.
 * - Every removed line/span (from the two *remaining* fixable reasons only)
 *   is preserved in this call's own `quarantine/<month>/<sortableId>.jsonl`
 *   file — see `QuarantineRecord`'s doc comment for exactly what fidelity
 *   that preservation can and cannot promise (Ruling R44). Recovery is
 *   reversible by hand (an operator can inspect the quarantine record and
 *   re-append a wrongly-removed line) — it is never a silent, destructive
 *   deletion an attacker could exploit as one, and a blocked audit path
 *   (fix round 1, Critical 2) makes recovery refuse to proceed at all
 *   rather than silently drop the audit trail.
 *
 * The net effect: forcing an operator to run recovery costs the operator an
 * action, but it hands the attacker no capability beyond the one they already
 * had by pushing the poison line in the first place — they get their own
 * poison quarantined (if it independently fails a real check) or left in
 * place pending manual review (if it is a duplicate-id forgery), and
 * nothing else.
 */
export async function recover(adapter: GitAdapter, ref: string, options: RecoveryOptions | null = {}): Promise<RecoveryResult> {
  return recoverCore(adapter, ref, options ?? {}, {});
}

/** See `RecoveryHooks`'s doc comment: the module-internal export a test drives directly. `recover` is the public surface; it calls this with no hooks. */
export async function recoverCore(
  adapter: GitAdapter,
  ref: string,
  options: RecoveryOptions,
  hooks: RecoveryHooks,
): Promise<RecoveryResult> {
  // Fix round 2, Low: `recover()` (the public surface) already normalizes
  // an explicit `null` before calling here, but this is still exported
  // (module-internal, test-only — see `RecoveryHooks`'s doc comment) and
  // TypeScript's `RecoveryOptions` param type is not itself enforced at
  // runtime — one line closes the same "explicit null bypasses a default
  // parameter" gap NEW-5 fixed at the public surface, for this surface too.
  const opts = options ?? {};
  const validatedRef = await validateCoordinationRef(ref);
  const now = opts.now ?? Date.now();
  validateNowIsNumber(now);
  validateNowForDateFormatting(now);
  const trailingMonths = opts.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  validateTrailingMonths(trailingMonths);
  validateCasRetryOption(opts.casRetry);
  const quarantinedAt = new Date(now).toISOString();

  return withCasRetry<RecoveryResult>(async (attemptNumber) => {
    // Every attempt re-reads and re-diagnoses from scratch — see this
    // function's own doc comment ("never blind-retry a stale diagnosis or a
    // stale tree") and `recovery.test.ts`'s concurrent-append test, which
    // fails if this is ever hoisted out of the loop.
    const parentSha = await adapter.readRef(validatedRef);
    if (parentSha === null) {
      // An absent ref has no events at all — nothing to recover, and
      // nothing for this function to create (that is `ref.ts`'s `initRef`'s
      // job, not this one's).
      return {
        done: true,
        value: {
          ref: validatedRef,
          outcome: "clean",
          previousTip: null,
          newTip: null,
          monthsRewritten: [],
          quarantined: [],
          unresolved: [],
          monthsWithPossibleEncodingLoss: [],
        },
      };
    }

    const report = await computeDiagnosticReport(adapter, validatedRef, parentSha, now, trailingMonths);
    const fixable = report.failures.filter((failure) => failure.line !== null && FIXABLE_REASONS.has(failure.reason));
    const unresolved: DiagnosticFailure[] = report.failures.filter((failure) => failure.line === null || !FIXABLE_REASONS.has(failure.reason));

    if (fixable.length === 0) {
      // Fix round 1, Critical 4: never "clean" while something is
      // unresolved — the board may still be unreadable even though this
      // call has nothing it can fix.
      return {
        done: true,
        value: {
          ref: validatedRef,
          outcome: unresolved.length > 0 ? "unrepairable" : "clean",
          previousTip: parentSha,
          newTip: parentSha,
          monthsRewritten: [],
          quarantined: [],
          unresolved,
          monthsWithPossibleEncodingLoss: [],
        },
      };
    }

    // Fix round 1, Critical 2: confirm the top-level audit path itself is
    // usable before doing any per-month work — a blocked top-level path
    // would otherwise be discovered only after every month's content had
    // already been read and rebuilt, for no purpose.
    await assertQuarantineDirectoryUsable(adapter, validatedRef, TOP_LEVEL_QUARANTINE_PATH);

    const byMonth = new Map<string, DiagnosticFailure[]>();
    for (const failure of fixable) {
      const list = byMonth.get(failure.month);
      if (list) {
        list.push(failure);
      } else {
        byMonth.set(failure.month, [failure]);
      }
    }

    const files: { path: string; content: string }[] = [];
    const quarantined: QuarantinedLineSummary[] = [];
    const monthsRewritten: string[] = [];
    const monthsWithPossibleEncodingLoss: string[] = [];
    // Fix round 2 (Ruling R45(a)): a final, explicit belt on the *actual*
    // built content, in addition to (never instead of) the diagnosis-time
    // budget enforced in `computeDiagnosticReport` — see
    // `MAX_QUARANTINE_RUN_BUDGET_BYTES`'s doc comment for the algebraic
    // invariant that keeps this from ever firing under normal operation
    // (`recovery.test.ts` checks the invariant directly). Unlike fix round
    // 1's version of this check, this can never *permanently* wedge
    // anything: each month's quarantine content is its own brand-new file
    // (never read, grown, or combined with an earlier call's history — see
    // `quarantineDirPath`'s doc comment), so a throw here means only "this
    // one call built more than expected," not "this ref can never be
    // recovered again."
    let totalQuarantineBytes = 0;

    for (const [month, monthFailures] of byMonth) {
      const path = monthPath(month);
      // Fix round 2 (NEW-9): this read is *not* pinned to a specific
      // commit — `readBlobFromRef` re-resolves `validatedRef` by name on
      // every call, exactly like `computeDiagnosticReport`'s own read a
      // moment ago. What actually guarantees "the content this attempt
      // writes back is exactly the content this attempt just read" is the
      // CAS below (`commitTreeToRef`'s `parent: parentSha`): if the ref
      // moved between that first read and this one — or between this one
      // and the commit — the commit is rejected outright and
      // `withCasRetry` re-runs this whole attempt function from a fresh
      // read, rather than this module ever trusting two reads to agree.
      const raw = (await adapter.readBlobFromRef(validatedRef, path)) ?? "";
      const lines = splitJsonlLines(raw);
      const badRanges = monthFailures
        .map((failure) => ({ start: failure.line as number, end: failure.endLine ?? (failure.line as number) }))
        .sort((a, b) => a.start - b.start);

      const keptLines: string[] = [];
      let monthPossiblyLossy = false;
      let rangeIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        while (rangeIndex < badRanges.length && (badRanges[rangeIndex]?.end ?? -1) < i) {
          rangeIndex += 1;
        }
        const current = badRanges[rangeIndex];
        const isBad = current !== undefined && i >= current.start && i <= current.end;
        const rawLine = lines[i] ?? "";
        if (hasReplacementCharacter(rawLine)) {
          monthPossiblyLossy = true;
        }
        if (!isBad) {
          keptLines.push(rawLine);
        }
      }
      // Matches `splitJsonlLines`'s own convention: zero kept lines is the
      // empty string (a well-formed, zero-line file), not a lone `"\n"`.
      const newMonthContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
      files.push({ path, content: newMonthContent });
      monthsRewritten.push(month);

      // Fix round 1, Critical 3 (advisor guidance): the "read() will still
      // refuse this month" verdict is recomputed on the *rebuilt* content,
      // not the pre-repair raw size — removing an oversized/garbage line
      // routinely shrinks a month well under the cap, and reporting
      // `unresolved` against the stale, pre-repair size would tell doctor
      // the board is still broken when `read()` would in fact succeed.
      const rebuiltStillTooLarge = Buffer.byteLength(newMonthContent, "utf8") > MAX_MONTH_BLOB_BYTES;
      for (let i = unresolved.length - 1; i >= 0; i--) {
        const entry = unresolved[i];
        if (entry?.month === month && entry.reason === "blob-too-large" && entry.line === null) {
          if (!rebuiltStillTooLarge) {
            unresolved.splice(i, 1);
          }
        }
      }

      // Fix round 2 (NEW-1 remediation, one level down from the top-level
      // probe above): a blob planted at the bare `quarantine/<month>` path
      // is a D/F conflict with the per-call file this month is about to
      // write, and — unlike the file's own randomized name — that bare
      // path is deterministic and therefore pre-plantable.
      await assertQuarantineDirectoryUsable(adapter, validatedRef, quarantineDirPath(month));
      const qPath = buildQuarantineFilePath(month, quarantinedAt);
      const orderedFailures = [...monthFailures].sort((a, b) => (a.line as number) - (b.line as number));
      let quarantineContent = "";
      for (const failure of orderedFailures) {
        const rawRemovedLine = lines[failure.line as number] ?? "";
        if (hasReplacementCharacter(rawRemovedLine)) {
          monthPossiblyLossy = true;
        }
        const record = buildQuarantineRecord(quarantinedAt, failure, rawRemovedLine);
        quarantineContent += `${JSON.stringify(record)}\n`;
        quarantined.push(toQuarantinedLineSummary(failure, qPath, record.rawTruncated));
      }
      // Fix round 2 (Ruling R45(b)): this call's own new file — never an
      // existing-content read, never appended to an earlier call's history.
      // See `quarantineDirPath`'s doc comment for why the old append-onto-
      // one-ever-growing-file design was itself the NEW-1 defect.
      totalQuarantineBytes += Buffer.byteLength(quarantineContent, "utf8");
      files.push({ path: qPath, content: quarantineContent });

      if (monthPossiblyLossy) {
        monthsWithPossibleEncodingLoss.push(month);
      }
    }

    // Fix round 2 (Ruling R45(a)): the true worst-case ceiling — the run
    // budget diagnosis-time truncation already enforces, plus the one
    // additional record's worth that `recordLineFailure` always allows
    // through even when it alone crosses that budget (see
    // `MAX_QUARANTINE_RUN_BUDGET_BYTES`'s doc comment). Estimated bytes,
    // not measured, so this uses the same conservative multiplier as the
    // diagnosis-time check, over the *actual* built content — provably
    // should never fire; kept as defense-in-depth rather than trusting the
    // estimate never to be wrong, per fix-round-2 review guidance.
    const absoluteQuarantineCeiling =
      MAX_QUARANTINE_RUN_BUDGET_BYTES + MAX_QUARANTINE_RAW_BYTES_PER_RECORD * QUARANTINE_ESCAPE_EXPANSION_FACTOR + QUARANTINE_RECORD_OVERHEAD_BYTES;
    if (totalQuarantineBytes > absoluteQuarantineCeiling) {
      throw new CanKanError(
        EventErrorCodes.EVENT_RECOVERY_QUARANTINE_TOO_LARGE,
        `this recovery call's quarantine audit content (${totalQuarantineBytes} bytes) exceeds its own resource bound (${absoluteQuarantineCeiling} bytes); refusing to write it into the coordination ref. This should not happen given this module's own diagnosis-time budgeting — if it does, it indicates a mismatch between this module's own size-estimation constants and reality (not a permanently unrecoverable ref: each call's quarantine content is its own new file, never combined with an earlier call's). Report this as a bug rather than retrying with different options — no documented option is known to avoid it`,
        { details: { ref: validatedRef, totalBytes: totalQuarantineBytes, maxBytes: absoluteQuarantineCeiling } },
      );
    }

    await hooks.beforeCas?.(attemptNumber);

    // Fix round 2 (NEW-2): no longer wraps `commitTreeToRef`'s own
    // `GIT_COMMAND_FAILED` as `EVENT_RECOVERY_QUARANTINE_BLOCKED`. Fix
    // round 1's version of this catch relabeled *any* commit failure this
    // way, which could misattribute an unrelated git-level failure (disk
    // full, permissions, a read-only object store) as a blocked audit path.
    // The two `assertQuarantineDirectoryUsable` probes above (top-level and
    // per-month) now catch both known D/F conflict shapes *before* this
    // commit is attempted, so a real conflict is already reported with a
    // named path and remediation well before this call — anything that
    // still fails here propagates with its genuine code and cause intact.
    const outcome: CasOutcome = await adapter.commitTreeToRef(validatedRef, {
      parent: parentSha,
      message: `quarantine ${fixable.length} invalid event log line${fixable.length === 1 ? "" : "s"}`,
      files,
    });

    if (outcome.outcome === "applied") {
      return {
        done: true,
        value: {
          ref: validatedRef,
          outcome: "recovered",
          previousTip: parentSha,
          newTip: outcome.sha,
          monthsRewritten,
          quarantined,
          unresolved,
          monthsWithPossibleEncodingLoss,
        },
      };
    }
    // Lost the race to a concurrent writer (another `recover()` call, or an
    // ordinary `append()`) — `withCasRetry` will call this attempt function
    // again, which re-reads and re-diagnoses from the new tip, exactly like
    // `append`'s own retry loop.
    return { done: false };
  }, withValidatedBackoff(opts.casRetry));
}
