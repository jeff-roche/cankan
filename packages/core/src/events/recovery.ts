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
 *   position — into a `quarantine/<month>.jsonl` audit file. **Ruling R8
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
 */

import { createHash } from "node:crypto";
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
 * The quarantine audit file's path — `quarantine/<yyyy-mm>.jsonl`, the
 * brief's own suggestion. **Deliberately a different top-level directory
 * than `events/`**, which is what makes requirement 9 ("`read()` does not
 * treat the quarantine file as an event log") true *structurally*, not by
 * convention: `read()`'s only file probe is `events/<month>.jsonl` for each
 * month in its aggregation window (`log.ts`'s `monthPath`) — a path under
 * `quarantine/` is never constructed by, and therefore never reachable from,
 * `read()`'s own code, regardless of what `trailingMonths` a caller passes.
 * See `recovery.test.ts` for the test that proves this by planting hostile
 * content at this exact path and confirming `read()` neither throws on it
 * nor is influenced by it.
 *
 * **Fix round 1, Critical 2: this same "different top-level directory" fact
 * is also what makes the `quarantine/` prefix a single point of failure.**
 * Git cannot represent one path as both a blob and a directory prefix in
 * the same tree, so a single blob planted at the literal path `quarantine`
 * (no month suffix) conflicts with *every* `quarantine/<month>.jsonl` write
 * this file could ever make, in one shot — see `assertQuarantineRootUsable`.
 */
function quarantinePath(month: string): string {
  return `quarantine/${month}.jsonl`;
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
 */
function validateCasRetryOption(casRetry: CasRetryOptions | undefined): void {
  if (casRetry === undefined) {
    return;
  }
  if (typeof casRetry !== "object" || casRetry === null) {
    throw new CanKanError(EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION, `casRetry must be an object, got ${typeof casRetry}`, {
      details: { type: typeof casRetry },
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
  | "diagnostic-truncated";

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
  /** Only for `"duplicate-id-conflict"` — the id both occurrences share, and where the *first* (surviving) occurrence was found. */
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
export async function diagnose(adapter: GitAdapter, ref: string, options: DiagnoseOptions = {}): Promise<DiagnosticReport> {
  const validatedRef = await validateCoordinationRef(ref);
  const now = options.now ?? Date.now();
  validateNowIsNumber(now);
  validateNowForDateFormatting(now);
  const trailingMonths = options.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
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
   * comparison, done before any hashing). Returns `false` when the cap on
   * *distinct* spans (`MAX_DIAGNOSTIC_FAILURES`) has been reached and a new
   * span could not be opened — the caller must then stop scanning.
   */
  function recordLineFailure(
    month: string,
    line: number,
    reason: DiagnosticFailureReason,
    rawLine: string,
    message: string,
    extra?: { issues?: readonly EventValidationIssue[]; eventId?: EventId; firstMonth?: string; firstLine?: number },
  ): boolean {
    if (pending !== null && pending.month === month && pending.reason === reason && pending.endLine === line - 1 && pending.rawLine === rawLine) {
      pending.endLine = line;
      return true;
    }
    flushPending();
    if (failures.length >= MAX_DIAGNOSTIC_FAILURES) {
      return false;
    }
    pending = {
      month,
      reason,
      rawLine,
      startLine: line,
      endLine: line,
      message,
      issues: extra?.issues,
      eventId: extra?.eventId,
      firstMonth: extra?.firstMonth,
      firstLine: extra?.firstLine,
      lineBytes: Buffer.byteLength(rawLine, "utf8"),
      lineSha256: lineDigest(rawLine),
      linePreview: safeLinePreview(rawLine),
      possiblyLossy: hasReplacementCharacter(rawLine),
    };
    return true;
  }

  function pushTruncatedMarker(month: string, line: number | null): void {
    failures.push({
      ref: validatedRef,
      commit: head,
      month,
      line: null,
      reason: "diagnostic-truncated",
      message:
        line === null
          ? `this diagnostic run's own resource bound was reached at month ${month}; scanning stopped here — re-run recovery (possibly more than once) to make further progress`
          : `this diagnostic run's own failure-count bound (${MAX_DIAGNOSTIC_FAILURES}) was reached at ${month}:${line}; scanning stopped here — re-run recovery (possibly more than once) to make further progress`,
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
      pushTruncatedMarker(month, null);
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
        const ok = recordLineFailure(
          month,
          line,
          "line-too-large",
          rawLine,
          `event log line exceeds read()'s own maximum line size (${MAX_LINE_BYTES} bytes)`,
        );
        if (!ok) {
          pushTruncatedMarker(month, line);
          break monthsLoop;
        }
        continue;
      }

      const parsed = parseEvent(rawLine, { now });
      if (!parsed.ok) {
        const ok = recordLineFailure(month, line, parsed.error.reason, rawLine, parsed.error.message, { issues: parsed.error.issues });
        if (!ok) {
          pushTruncatedMarker(month, line);
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
        const ok = recordLineFailure(month, line, "duplicate-id-conflict", rawLine, `duplicate event id with differing content: ${event.id}`, {
          eventId: event.id,
          firstMonth: previous.month,
          firstLine: previous.line,
        });
        if (!ok) {
          pushTruncatedMarker(month, line);
          break monthsLoop;
        }
        continue; // The first occurrence stays authoritative; only this later, differing one is flagged.
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
 */
const FIXABLE_REASONS: ReadonlySet<DiagnosticFailureReason> = new Set(["invalid-json", "schema-invalid", "duplicate-id-conflict", "line-too-large"]);

/**
 * One line removed from a month file by a `recover()` call, as written into
 * `quarantine/<month>.jsonl` — a JSONL file distinct from every
 * `events/<month>.jsonl` (see `quarantinePath`'s doc comment for why `read()`
 * cannot reach it). Records the removed line's content, its reason, and its
 * original position, so an operator can tell a corruption from an attack
 * and, if needed, recover a wrongly-quarantined event by hand.
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
  readonly raw: string;
}

/** A sanitized summary of one removed line/span, as returned in `RecoveryResult.quarantined` — the same safe-to-publish shape `DiagnosticFailure` uses, never the raw bytes (those live only in the persisted `QuarantineRecord`, and only there). */
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
 * Builds `quarantine/<month>.jsonl`'s new record for one removed line/span.
 * `raw` is `lines[failure.line]` — captured **before** the line is dropped
 * from the rebuilt month content, so this is the exact original text this
 * module received, not a re-derivation.
 */
function buildQuarantineRecord(quarantinedAt: string, failure: DiagnosticFailure, raw: string): QuarantineRecord {
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
    raw,
  };
  if (failure.issues !== undefined) record.issues = failure.issues;
  if (failure.eventId !== undefined) record.eventId = failure.eventId;
  if (failure.firstMonth !== undefined) record.firstMonth = failure.firstMonth;
  if (failure.firstLine !== undefined) record.firstLine = failure.firstLine;
  return record;
}

/** Projects a fixable `DiagnosticFailure` into `RecoveryResult.quarantined`'s sanitized shape — never `raw`. */
function toQuarantinedLineSummary(failure: DiagnosticFailure): QuarantinedLineSummary {
  return {
    // biome-ignore lint/style/noNonNullAssertion: same guarantee as `buildQuarantineRecord` above.
    line: failure.line!,
    endLine: failure.endLine ?? (failure.line as number),
    count: failure.count ?? 1,
    month: failure.month,
    reason: failure.reason,
    message: failure.message,
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
 * Fix round 1, Critical 2: probes the **literal top-level** `quarantine`
 * path once per recovery attempt, before any per-month work, and throws
 * `EVENT_RECOVERY_QUARANTINE_BLOCKED` if a blob is planted directly there.
 *
 * **Why this needs its own probe, separate from each month's own
 * `quarantine/<month>.jsonl` read.** Git cannot represent one path as both
 * a blob and a directory prefix in the same tree. A blob planted at the bare
 * path `quarantine` (no month suffix) does not make
 * `readBlobFromRef(ref, "quarantine/<month>.jsonl")` throw or return
 * non-null — `ls-tree` simply finds no entry under a prefix that isn't a
 * directory, so the read returns `null`, indistinguishable from "no
 * quarantine history yet." The conflict only surfaces later, when
 * `commitTreeToRef` tries to add an index entry for
 * `quarantine/<month>.jsonl` on top of an index that already has a
 * *blob* entry for `quarantine` itself, and `git write-tree` fails. Probing
 * the exact top-level path directly — confirmed by probe (three real git
 * states: absent, a genuine directory, a blob) — discriminates all three
 * up front, before this function does any other work: `null` (nothing
 * planted, fine), `GIT_BLOB_AMBIGUOUS` (a real directory — `ls-tree`
 * against an exact non-trailing-slash path returns the directory's own
 * tree entry, mode `040000`, which fails the `mode === "100644"` check the
 * same way `ref.ts`'s own usability probe's tree case does — fine, this is
 * the normal, healthy state once any quarantine file has ever been
 * written), or a non-null **string** (a blob really is planted there —
 * the one case that blocks every future recovery, named and thrown here).
 */
async function assertQuarantineRootUsable(adapter: GitAdapter, validatedRef: string): Promise<void> {
  let topLevel: string | null;
  try {
    topLevel = await adapter.readBlobFromRef(validatedRef, TOP_LEVEL_QUARANTINE_PATH);
  } catch (cause) {
    if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
      return; // A real directory — the normal, healthy state.
    }
    throw cause;
  }
  if (topLevel !== null) {
    throw new CanKanError(
      EventErrorCodes.EVENT_RECOVERY_QUARANTINE_BLOCKED,
      `the top-level "${TOP_LEVEL_QUARANTINE_PATH}" path resolves to a file, not a directory, so recovery cannot write any quarantine/<month>.jsonl audit record`,
      {
        details: {
          ref: validatedRef,
          path: TOP_LEVEL_QUARANTINE_PATH,
          remediation: `remove the blob planted at "${TOP_LEVEL_QUARANTINE_PATH}" (rebuild the ref's tree: git read-tree / git rm --cached ${TOP_LEVEL_QUARANTINE_PATH} / commit-tree / update-ref) before retrying recovery`,
        },
      },
    );
  }
}

/**
 * Fix round 1, Critical 2: wraps the per-month "does quarantine history
 * already exist" read. A **tree** planted at the exact
 * `quarantine/<month>.jsonl` path (distinct from a blob at the bare
 * top-level `quarantine` path, which `assertQuarantineRootUsable` catches)
 * makes this specific read throw `GIT_BLOB_AMBIGUOUS`, the same "`ls-tree`
 * against an exact path finds the directory's own non-`100644` entry"
 * shape `ref.ts`'s usability probe already establishes. Thrown as
 * `EVENT_RECOVERY_QUARANTINE_BLOCKED` rather than silently proceeding
 * without a quarantine write for this month — recovering the month file
 * without its matching audit record would be a silent deletion, which this
 * module must never do.
 */
async function readExistingQuarantineOrThrow(adapter: GitAdapter, validatedRef: string, month: string, qPath: string): Promise<string> {
  try {
    return (await adapter.readBlobFromRef(validatedRef, qPath)) ?? "";
  } catch (cause) {
    if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
      throw new CanKanError(
        EventErrorCodes.EVENT_RECOVERY_QUARANTINE_BLOCKED,
        `the quarantine audit path does not resolve to a usable blob, refusing to recover ${month} without a place to record the audit trail: ${qPath}`,
        {
          details: {
            ref: validatedRef,
            month,
            path: qPath,
            remediation: `inspect the tree (e.g. \`git ls-tree -r ${validatedRef} -- ${qPath}\`) and remove the offending entry before retrying recovery`,
          },
        },
      );
    }
    throw cause;
  }
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
 * attempt's own fresh read), and append one `QuarantineRecord` per removed
 * span to that month's `quarantine/<month>.jsonl`, preserving whatever
 * quarantine history already exists there. Every other file in the tree —
 * every other month, every other quarantine file — survives untouched via
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
 * An attacker with push access can already make the board unreadable with
 * one push (that is the vulnerability this file exists to remedy, not one it
 * introduces) and can push a line specifically shaped to *look* worth
 * quarantining. What they cannot do is use a recovery run to delete a
 * legitimate competing claim:
 *
 * - Recovery only ever removes a line that **independently, deterministically
 *   fails the identical check `read()` itself already applies** — schema
 *   validation, JSON well-formedness, an oversized byte length, or
 *   byte-differing content under an already-used id. A legitimate
 *   `claim`/`release`/any other event is, by definition, schema-valid,
 *   within `read()`'s size bounds, and under a freshly-minted id, so it is
 *   never a member of `FIXABLE_REASONS`'s domain — this function has no
 *   code path that removes such a line, for any reason.
 * - For the one reason that involves *two* lines
 *   (`duplicate-id-conflict`), the **first** occurrence in append-only chain
 *   order is always the one that survives — see `computeDiagnosticReport`'s
 *   dedupe. An attacker cannot use this to evict a rival's already-appended,
 *   valid claim by replaying a conflicting duplicate under the same id
 *   *after* it: their own later line is the one flagged and removed, not the
 *   rival's earlier one. (Forging a *collision* against an unused id well
 *   before the rival even claims it is not a duplicate-id scenario at all —
 *   it is two independent, both-valid events under different ids, and
 *   neither is touched.)
 * - Every removed line/span is preserved in `quarantine/<month>.jsonl`
 *   regardless of which of the above reasons applied — see
 *   `QuarantineRecord`'s doc comment for exactly what fidelity that
 *   preservation can and cannot promise (Ruling R44). Recovery is
 *   reversible by hand (an operator can inspect the quarantine record and
 *   re-append a wrongly-removed line) — it is never a silent, destructive
 *   deletion an attacker could exploit as one, and a blocked audit path
 *   (fix round 1, Critical 2) makes recovery refuse to proceed at all
 *   rather than silently drop the audit trail.
 *
 * The net effect: forcing an operator to run recovery costs the operator an
 * action, but it hands the attacker no capability beyond the one they already
 * had by pushing the poison line in the first place — they get their own
 * poison quarantined, on the record, and nothing else.
 */
export async function recover(adapter: GitAdapter, ref: string, options: RecoveryOptions = {}): Promise<RecoveryResult> {
  return recoverCore(adapter, ref, options, {});
}

/** See `RecoveryHooks`'s doc comment: the module-internal export a test drives directly. `recover` is the public surface; it calls this with no hooks. */
export async function recoverCore(
  adapter: GitAdapter,
  ref: string,
  options: RecoveryOptions,
  hooks: RecoveryHooks,
): Promise<RecoveryResult> {
  const validatedRef = await validateCoordinationRef(ref);
  const now = options.now ?? Date.now();
  validateNowIsNumber(now);
  validateNowForDateFormatting(now);
  const trailingMonths = options.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  validateTrailingMonths(trailingMonths);
  validateCasRetryOption(options.casRetry);
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

    // Fix round 1, Critical 2: confirm the audit path itself is usable
    // before doing any per-month work — a blocked top-level path would
    // otherwise be discovered only after every month's content had already
    // been read and rebuilt, for no purpose.
    await assertQuarantineRootUsable(adapter, validatedRef);

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
    // Fix round 1, Critical 1: bounds the audit blob this call is about to
    // write, across every month it touches — coalescing already keeps this
    // proportional to the number of *distinct* spans, not the number of
    // bytes/lines they represent, but this is a final, explicit belt before
    // anything is committed into the coordination ref (which every peer
    // then fetches and stores permanently).
    let totalQuarantineBytes = 0;

    for (const [month, monthFailures] of byMonth) {
      const path = monthPath(month);
      // Fresh read, off this attempt's own `parentSha` — never the blob
      // `computeDiagnosticReport` happened to see (it read the identical
      // state, since both calls target the same `parentSha`, but reading
      // again here keeps this loop's "the content this attempt writes back
      // is exactly the content this attempt just read" invariant explicit
      // rather than relying on that coincidence).
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

      const qPath = quarantinePath(month);
      const existingQuarantine = await readExistingQuarantineOrThrow(adapter, validatedRef, month, qPath);
      const orderedFailures = [...monthFailures].sort((a, b) => (a.line as number) - (b.line as number));
      let appended = "";
      for (const failure of orderedFailures) {
        const rawRemovedLine = lines[failure.line as number] ?? "";
        if (hasReplacementCharacter(rawRemovedLine)) {
          monthPossiblyLossy = true;
        }
        const record = buildQuarantineRecord(quarantinedAt, failure, rawRemovedLine);
        appended += `${JSON.stringify(record)}\n`;
        quarantined.push(toQuarantinedLineSummary(failure));
      }
      // Append-only: whatever quarantine history already exists for this
      // month survives, exactly as `append`'s own read-check-concatenate
      // pattern preserves a month file's prior content.
      const newQuarantineContent = existingQuarantine + appended;
      totalQuarantineBytes += Buffer.byteLength(newQuarantineContent, "utf8");
      files.push({ path: qPath, content: newQuarantineContent });

      if (monthPossiblyLossy) {
        monthsWithPossibleEncodingLoss.push(month);
      }
    }

    if (totalQuarantineBytes > MAX_DIAGNOSTIC_MONTH_BLOB_BYTES) {
      throw new CanKanError(
        EventErrorCodes.EVENT_RECOVERY_QUARANTINE_TOO_LARGE,
        `this recovery call's quarantine audit content (${totalQuarantineBytes} bytes) exceeds its own resource bound (${MAX_DIAGNOSTIC_MONTH_BLOB_BYTES} bytes); refusing to write it into the coordination ref`,
        { details: { ref: validatedRef, totalBytes: totalQuarantineBytes, maxBytes: MAX_DIAGNOSTIC_MONTH_BLOB_BYTES } },
      );
    }

    await hooks.beforeCas?.(attemptNumber);

    let outcome: CasOutcome;
    try {
      outcome = await adapter.commitTreeToRef(validatedRef, {
        parent: parentSha,
        message: `quarantine ${fixable.length} invalid event log line${fixable.length === 1 ? "" : "s"}`,
        files,
      });
    } catch (cause) {
      // Fix round 1, Critical 2 fallback: a tree conflict this function's
      // own probes did not catch in advance (e.g. a race between the probe
      // above and this call, or a shape this module has not enumerated)
      // still surfaces as a typed, named error rather than a bare
      // `GIT_COMMAND_FAILED` with no actionable guidance.
      if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_COMMAND_FAILED) {
        throw new CanKanError(
          EventErrorCodes.EVENT_RECOVERY_QUARANTINE_BLOCKED,
          "recovery's commit could not be built — this can happen when something is planted at one of the quarantine/<month>.jsonl paths (or the top-level quarantine path) this run needed to write, conflicting with it as a directory; inspect the tree (e.g. `git ls-tree <ref>`) and remove the offending entry, then retry",
          { cause, details: { ref: validatedRef, months: monthsRewritten } },
        );
      }
      throw cause;
    }

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
  }, withValidatedBackoff(options.casRetry));
}
