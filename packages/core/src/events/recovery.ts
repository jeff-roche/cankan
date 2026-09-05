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
 *   lines {@link diagnose} found invalid, preserving every other line
 *   byte-for-byte and in order, and records each removed line — verbatim,
 *   with its reason and original position — into a `quarantine/<month>.jsonl`
 *   audit file. **Ruling R8 (orchestrator, binding): this is a new commit on
 *   top of the current tip, never a CAS rewind** — see {@link recover}'s own
 *   doc comment for why a rewind is rejected.
 *
 * **Neither function is wired into `append`/`read`.** Recovery is an
 * explicit operator action (a `cankan recover` command, not built here) —
 * a board that silently self-heals by discarding events a peer pushed is a
 * board an attacker could use to delete a claim by provoking automatic
 * "recovery." See {@link recover}'s doc comment for the adversarial analysis
 * of what an attacker *can* and *cannot* gain by forcing a real, manually
 * triggered recovery run.
 *
 * **Never modifies `log.ts`, `schema.ts`, `ref.ts`, or `observations.ts`.**
 * Those files are reviewed and hardened by earlier dispatches in this phase
 * and are out of this file's authority to edit beyond the two sanctioned
 * touch points (this module's own exports in `events/index.ts`, and this
 * module's own error code in `events/errors.ts`). A handful of small, pure
 * helpers below (`trailingMonthKeysOldestFirst`, `monthPath`,
 * `validateTrailingMonths`, `withValidatedBackoff`/the `casRetry` option
 * checks) are therefore **copied from `log.ts`, not imported** — the same
 * "copied because of the ownership boundary" pattern `schema.ts`'s
 * `canonicalizeTicketId` already documents relative to `ticket/id.ts`. Only
 * `monthKeyUtc`... no: this file does not even need `monthKeyUtc` itself,
 * since `trailingMonthKeysOldestFirst`'s copy inlines the same UTC-calendar
 * arithmetic directly. `splitJsonlLines` and `validateNowForDateFormatting`
 * *are* imported from `log.ts` (they are already exported from it for
 * exactly this kind of same-module reuse — see `ref.ts`'s identical import),
 * so those two are not duplicated.
 */

import { createHash } from "node:crypto";
import { CanKanError, isCanKanError } from "../errors";
import type { CasRetryOptions, GitAdapter } from "../git/index";
import { GitErrorCodes, validateCoordinationRef, withCasRetry } from "../git/index";
import { EventErrorCodes } from "./errors";
import { splitJsonlLines, validateNowForDateFormatting } from "./log";
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
 */
function quarantinePath(month: string): string {
  return `quarantine/${month}.jsonl`;
}

/** Mirrors `log.ts`'s `MAX_CAS_ATTEMPTS`/`MAX_BACKOFF_MS` bounds and reasoning exactly — `withCasRetry` (M2.6) does not validate its own `casRetry` option, so `recover`, like `append`, validates what it forwards. */
const MAX_CAS_ATTEMPTS = 10_000;
const MAX_BACKOFF_MS = 60_000;

/** Mirrors `log.ts`'s `AppendOptions.casRetry` validation exactly (same lesson: validate every caller-supplied option against the domain of every consumer it reaches, not just its declared type) — `casRetry` itself, `.maxAttempts`, `.backoffMs`, and `.sleep` are all checked before `withCasRetry` (M2.6) ever sees them, so a malformed value surfaces as a `CanKanError` here rather than a raw `TypeError` from inside M2.6. */
function validateCasRetryOption(casRetry: CasRetryOptions | undefined): void {
  if ((casRetry as unknown) === null) {
    throw new CanKanError(EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION, "casRetry must be an object, got null");
  }
  const maxAttempts = casRetry?.maxAttempts;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CAS_ATTEMPTS)) {
    throw new CanKanError(
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
      `casRetry.maxAttempts must be an integer in [1, ${MAX_CAS_ATTEMPTS}], got ${maxAttempts}`,
      { details: { maxAttempts, max: MAX_CAS_ATTEMPTS } },
    );
  }
  const backoffMs = casRetry?.backoffMs;
  if (backoffMs !== undefined && typeof backoffMs !== "function") {
    throw new CanKanError(EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION, `casRetry.backoffMs must be a function, got ${typeof backoffMs}`, {
      details: { type: typeof backoffMs },
    });
  }
  const sleep = casRetry?.sleep;
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
          `casRetry.backoffMs must return a finite number in [0, ${MAX_BACKOFF_MS}], got ${ms}`,
          { details: { backoffMs: ms, max: MAX_BACKOFF_MS } },
        );
      }
      return ms;
    },
  };
}

// ============================================================================
// Diagnostic-only resource bounds — deliberately far more generous than
// `log.ts`'s `MAX_MONTH_BLOB_BYTES`/`MAX_AGGREGATE_READ_BYTES`
// ============================================================================

/**
 * The diagnostic reader's own per-month size bound — 4x `log.ts`'s
 * `MAX_MONTH_BLOB_BYTES` (64 MiB), not the same value. The whole point of
 * {@link diagnose} is to work on a board `read()` already refuses, including
 * the specific case dispatch 2's security review verified: a month grown
 * past the normal cap via `append`'s `maxExistingBlobBytes` bypass (routed
 * note to this dispatch: "after a legitimate recovery write into a 70 MiB
 * month, `read()` still throws `EVENT_LOG_BLOB_TOO_LARGE`"). Reusing
 * `read()`'s own cap here would reintroduce exactly the gap this file exists
 * to close. Still bounded, not `Infinity`: a diagnostic tool that materializes
 * an arbitrarily large blob into memory (which `readBlobFromRef` has already
 * done by the time this code runs — see that function's own doc comment,
 * there is no way to size-check first) needs *some* ceiling against a truly
 * pathological blob; 256 MiB is comfortably above the 70 MiB scenario this
 * dispatch was asked to verify while still bounding memory use.
 */
const MAX_DIAGNOSTIC_MONTH_BLOB_BYTES = 256 * 1024 * 1024;

/** The diagnostic reader's aggregate bound across its whole `trailingMonths` window — same "sum, not just per-file" reasoning as `log.ts`'s `MAX_AGGREGATE_READ_BYTES`, scaled up for the same reason as the per-month bound above. */
const MAX_DIAGNOSTIC_AGGREGATE_BYTES = 1024 * 1024 * 1024;

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

function isHazardousCodePoint(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) return true; // C0 controls + DEL, including ESC (0x1b) and CR (0x0d)
  if (code >= 0x80 && code <= 0x9f) return true; // C1 controls — some terminals interpret these as control sequences too
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
 * hazardous code point (C0/C1 controls, DEL, bidi/zero-width) is replaced
 * with a fixed-width escape sequence; everything else, including any
 * legitimate Unicode, passes through unchanged. Bounded to
 * `MAX_PREVIEW_CODE_POINTS` code points (not UTF-16 code units — iterating
 * with `for...of` walks whole code points, matching `schema.ts`'s own
 * iteration style) so a multi-gigabyte hostile line costs this function
 * O(preview length), not O(line length), to render.
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

// ============================================================================
// Half 1 — the diagnostic read
// ============================================================================

export type DiagnosticFailureReason =
  | "invalid-json"
  | "schema-invalid"
  | "duplicate-id-conflict"
  | "non-blob-month-path"
  | "blob-too-large";

/**
 * One failing line (or, for `"non-blob-month-path"`/`"blob-too-large"`, one
 * failing month) found by {@link diagnose}. `ref`, `commit`, `month`, and
 * `line` are fm8's required "diagnosable error identifying the offending
 * ref/commit/file" coordinates — `line` is `null` only for the two
 * month-level reasons, which have no single offending line to name.
 *
 * **Never carries the rejected line's raw bytes** — see `safeLinePreview`'s
 * doc comment for why. `lineBytes`/`lineSha256`/`linePreview` are populated
 * for every line-level reason and are always safe to print to a TTY,
 * `--json` output, or a CI log.
 */
export interface DiagnosticFailure {
  readonly ref: string;
  readonly commit: string;
  readonly month: string;
  readonly line: number | null;
  readonly reason: DiagnosticFailureReason;
  readonly message: string;
  /** Only for `"invalid-json"`/`"schema-invalid"` — `parseEvent`'s own already-safe-to-publish issue list (see `schema.ts`'s `projectIssues`). */
  readonly issues?: readonly EventValidationIssue[];
  readonly lineBytes?: number;
  readonly lineSha256?: string;
  readonly linePreview?: string;
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
 * function's caller; an oversized blob is reported (and skipped, since its
 * line boundaries cannot be trusted past this function's own resource bound)
 * rather than crashing the whole run; any other unexpected git-level error
 * is the one thing still allowed to propagate, since this function has no
 * documented recovery for a git failure outside the three shapes ADR
 * 0001:828-838 names.
 *
 * **Never throws on content, no matter how malformed** — `parseEvent`
 * already returns a structured failure for every content shape (obligation
 * 1 of task-1-brief.md), so the only throws this function can produce are
 * `GIT_REF_INVALID` (a bad `ref` argument), `EVENT_LOG_INVALID_WINDOW` (a bad
 * `now`/`trailingMonths`), or an unexpected git-level failure that is not
 * one of the two shapes handled above.
 */
export async function diagnose(adapter: GitAdapter, ref: string, options: DiagnoseOptions = {}): Promise<DiagnosticReport> {
  const validatedRef = await validateCoordinationRef(ref);
  const now = options.now ?? Date.now();
  validateNowForDateFormatting(now);
  const trailingMonths = options.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  validateTrailingMonths(trailingMonths);

  const head = await adapter.readRef(validatedRef);
  if (head === null) {
    return { ref: validatedRef, commit: null, monthsScanned: [], failures: [] };
  }

  return computeDiagnosticReport(adapter, validatedRef, head, now, trailingMonths);
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

  for (const month of months) {
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
        monthsScanned.push(month);
        failures.push({
          ref: validatedRef,
          commit: head,
          month,
          line: null,
          reason: "non-blob-month-path",
          message: "the month file path does not resolve to a usable blob (more than one tree entry, an unexpected path, or a non-100644 mode)",
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
    aggregateBytes += rawBytes;
    if (rawBytes > MAX_DIAGNOSTIC_MONTH_BLOB_BYTES || aggregateBytes > MAX_DIAGNOSTIC_AGGREGATE_BYTES) {
      // This function's own resource bound (see the constants' doc
      // comments) — not one of the ADR's three named failure shapes, but a
      // month this large cannot be safely split and walked line-by-line
      // within this tool's own budget, so it is reported and skipped rather
      // than attempted.
      failures.push({
        ref: validatedRef,
        commit: head,
        month,
        line: null,
        reason: "blob-too-large",
        message: `month file exceeds this diagnostic tool's own resource bound (${rawBytes} bytes)`,
      });
      continue;
    }

    const lines = splitJsonlLines(raw);
    for (let line = 0; line < lines.length; line++) {
      const rawLine = lines[line] ?? "";
      const parsed = parseEvent(rawLine, { now });
      if (!parsed.ok) {
        failures.push({
          ref: validatedRef,
          commit: head,
          month,
          line,
          reason: parsed.error.reason,
          message: parsed.error.message,
          issues: parsed.error.issues,
          lineBytes: Buffer.byteLength(rawLine, "utf8"),
          lineSha256: lineDigest(rawLine),
          linePreview: safeLinePreview(rawLine),
        });
        continue;
      }

      const event = parsed.event;
      const previous = seen.get(event.id);
      if (previous !== undefined) {
        if (previous.rawLine === rawLine) {
          continue; // Byte-identical duplicate — folded, exactly as `read()` folds it.
        }
        failures.push({
          ref: validatedRef,
          commit: head,
          month,
          line,
          reason: "duplicate-id-conflict",
          message: `duplicate event id with differing content: ${event.id}`,
          eventId: event.id,
          firstMonth: previous.month,
          firstLine: previous.line,
          lineBytes: Buffer.byteLength(rawLine, "utf8"),
          lineSha256: lineDigest(rawLine),
          linePreview: safeLinePreview(rawLine),
        });
        continue; // The first occurrence stays authoritative; only this later, differing one is flagged.
      }

      seen.set(event.id, { rawLine, month, line });
    }
  }

  return { ref: validatedRef, commit: head, monthsScanned, failures };
}

// ============================================================================
// Half 2 — returning the ref to a readable state
// ============================================================================

/** The three {@link DiagnosticFailureReason}s recovery can repair by removing exactly the offending line. `"non-blob-month-path"` and `"blob-too-large"` are month-level, structural failures with no single line to remove — see `recover`'s doc comment for why they are reported back as `unresolved` rather than repaired. */
const FIXABLE_REASONS: ReadonlySet<DiagnosticFailureReason> = new Set(["invalid-json", "schema-invalid", "duplicate-id-conflict"]);

/**
 * One line removed from a month file by a `recover()` call, as written into
 * `quarantine/<month>.jsonl` — a JSONL file distinct from every
 * `events/<month>.jsonl` (see `quarantinePath`'s doc comment for why `read()`
 * cannot reach it). **Preserves `raw` byte-for-byte** — the audit-record
 * obligation (ADR 0001:842-844's "quarantining the offending events behind
 * an audit record") requires an operator be able to tell a corruption from
 * an attack, and a wrongly-quarantined event be recoverable by hand.
 *
 * **How byte-for-byte preservation is achieved safely — the other half of
 * this dispatch's raw-bytes decision.** `raw` is a JSON *string value* inside
 * this record, produced by this file's own `JSON.stringify` when the record
 * is serialized — never embedded literally into the file. This is
 * simultaneously lossless (`JSON.parse` on the persisted line reproduces the
 * exact original string, including any control character, lone surrogate, or
 * U+2028) and inert as terminal output: JSON string encoding escapes every
 * C0 control character (including ESC, `\x1b`, to ``) by construction,
 * so `cat`/`git show`-ing the quarantine file cannot itself replay the same
 * terminal takeover dispatch 1's security review demonstrated. A tool that
 * wants the literal bytes back (to hand-recover a wrongly-quarantined event,
 * say) gets them by `JSON.parse`-ing this record and reading `.raw` — a
 * deliberate action, not a side effect of viewing the file.
 */
export interface QuarantineRecord {
  /** ISO-8601 UTC instant of the `recover()` call that removed this line — this module's own clock, per the same "never trust a peer-supplied clock" discipline as `ts`/`lease_until` (`schema.ts`). */
  readonly quarantinedAt: string;
  readonly month: string;
  readonly line: number;
  readonly reason: DiagnosticFailureReason;
  readonly message: string;
  readonly issues?: readonly EventValidationIssue[];
  readonly eventId?: EventId;
  readonly firstMonth?: string;
  readonly firstLine?: number;
  readonly raw: string;
}

/** A sanitized summary of one removed line, as returned in `RecoveryResult.quarantined` — the same safe-to-publish shape `DiagnosticFailure` uses, never the raw bytes (those live only in the persisted `QuarantineRecord`, and only there). */
export interface QuarantinedLineSummary {
  readonly month: string;
  readonly line: number;
  readonly reason: DiagnosticFailureReason;
  readonly message: string;
  readonly lineBytes: number;
  readonly lineSha256: string;
  readonly linePreview: string;
}

export interface RecoveryResult {
  readonly ref: string;
  /** `"clean"` when nothing fixable was found — no commit is made (see `recover`'s doc comment for why a no-op recovery must not still mutate history). `"recovered"` when a new commit was applied. */
  readonly outcome: "clean" | "recovered";
  /** The ref's tip immediately before this call. `null` only when the ref did not exist at all. */
  readonly previousTip: string | null;
  /** The ref's tip after this call — identical to `previousTip` for `"clean"`. */
  readonly newTip: string | null;
  readonly monthsRewritten: readonly string[];
  readonly quarantined: readonly QuarantinedLineSummary[];
  /** Failures `diagnose` found that this call could **not** repair (month-level, structural failures — see `FIXABLE_REASONS`'s doc comment) — reported honestly rather than silently dropped, so an operator knows the board may still be partially unreadable. */
  readonly unresolved: readonly DiagnosticFailure[];
}

export interface RecoveryOptions {
  readonly now?: number;
  readonly trailingMonths?: number;
  readonly casRetry?: CasRetryOptions;
}

/**
 * Builds `quarantine/<month>.jsonl`'s new record for one removed line. `raw`
 * is `lines[failure.line]` — captured **before** the line is dropped from
 * the rebuilt month content, so this is the exact original text, not a
 * re-derivation.
 */
function buildQuarantineRecord(quarantinedAt: string, failure: DiagnosticFailure, raw: string): QuarantineRecord {
  const record: {
    quarantinedAt: string;
    month: string;
    line: number;
    reason: DiagnosticFailureReason;
    message: string;
    issues?: readonly EventValidationIssue[];
    eventId?: EventId;
    firstMonth?: string;
    firstLine?: number;
    raw: string;
  } = {
    quarantinedAt,
    month: failure.month,
    // biome-ignore lint/style/noNonNullAssertion: `failure.line` is guaranteed non-null here — this is only ever called for a member of `FIXABLE_REASONS`, all three of which are line-level (see `FIXABLE_REASONS`'s doc comment).
    line: failure.line!,
    reason: failure.reason,
    message: failure.message,
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
    month: failure.month,
    reason: failure.reason,
    message: failure.message,
    lineBytes: failure.lineBytes ?? 0,
    lineSha256: failure.lineSha256 ?? "",
    linePreview: failure.linePreview ?? "",
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
 * ref, diagnose it fresh against that exact read, build the repaired
 * commit off-tree, `commitTreeToRef`, and on rejection, re-read and
 * re-diagnose from scratch — never blind-retry a stale diagnosis or a stale
 * tree (fm1's rule, restated for recovery). For each month with at least one
 * *fixable* failure ({@link FIXABLE_REASONS}): read its current blob, drop
 * exactly the offending lines (by index, computed against this attempt's own
 * fresh read), and append one `QuarantineRecord` per removed line to that
 * month's `quarantine/<month>.jsonl`, preserving whatever quarantine history
 * already exists there. Every other file in the tree — every other month,
 * every other quarantine file — survives untouched via `commitTreeToRef`'s
 * own overlay behavior (`git read-tree <parent>` into a private index,
 * verified directly at `git/adapter.ts:200-222`), so this call never needs
 * to (and never does) carry forward content it did not itself change.
 *
 * **Valid events in an affected month always survive**: only the exact
 * line indices `diagnose` reported are dropped; every other line — whatever
 * order it was already in — is written back unchanged, in the same
 * relative order. A month with only *unresolved* (structural) failures is
 * never rewritten at all, and those failures are reported back in
 * `RecoveryResult.unresolved` rather than silently absorbed.
 *
 * **A no-op recovery makes no commit.** If `diagnose` finds nothing fixable
 * (`outcome: "clean"`), this function does not write an empty quarantine
 * commit — recovery is meant to repair a specific, real corruption, not to
 * be a routine no-op mutation of a healthy board's history.
 *
 * **Never called by `append`/`read`, and never should be** — see this
 * module's own file-level doc comment. The one call site is deliberately
 * this function's own public export, invoked only by an explicit operator
 * action.
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
 *   validation, JSON well-formedness, or byte-differing content under an
 *   already-used id. A legitimate `claim`/`release`/any other event is, by
 *   definition, schema-valid under a freshly-minted id, so it is never a
 *   member of `FIXABLE_REASONS`'s domain — this function has no code path
 *   that removes a schema-valid, uniquely-id'd line for any reason.
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
 * - Every removed line is preserved byte-for-byte in `quarantine/<month>.jsonl`
 *   regardless of which of the two reasons above applied. Recovery is
 *   reversible by hand (an operator can inspect the quarantine record and
 *   re-append a wrongly-removed line) — it is never a silent, destructive
 *   deletion an attacker could exploit as one.
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
        value: { ref: validatedRef, outcome: "clean", previousTip: null, newTip: null, monthsRewritten: [], quarantined: [], unresolved: [] },
      };
    }

    const report = await computeDiagnosticReport(adapter, validatedRef, parentSha, now, trailingMonths);
    const fixable = report.failures.filter((failure) => failure.line !== null && FIXABLE_REASONS.has(failure.reason));
    const unresolved = report.failures.filter((failure) => failure.line === null || !FIXABLE_REASONS.has(failure.reason));

    if (fixable.length === 0) {
      return {
        done: true,
        value: { ref: validatedRef, outcome: "clean", previousTip: parentSha, newTip: parentSha, monthsRewritten: [], quarantined: [], unresolved },
      };
    }

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
      const badLineIndexes = new Map<number, DiagnosticFailure>();
      for (const failure of monthFailures) {
        // biome-ignore lint/style/noNonNullAssertion: every member of `monthFailures` came from `fixable`, which already filtered `line !== null`.
        badLineIndexes.set(failure.line!, failure);
      }

      const keptLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!badLineIndexes.has(i)) {
          keptLines.push(lines[i] ?? "");
        }
      }
      // Matches `splitJsonlLines`'s own convention: zero kept lines is the
      // empty string (a well-formed, zero-line file), not a lone `"\n"`.
      const newMonthContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
      files.push({ path, content: newMonthContent });
      monthsRewritten.push(month);

      const qPath = quarantinePath(month);
      const existingQuarantine = (await adapter.readBlobFromRef(validatedRef, qPath)) ?? "";
      const orderedFailures = [...monthFailures].sort((a, b) => (a.line as number) - (b.line as number));
      let appended = "";
      for (const failure of orderedFailures) {
        const rawRemovedLine = lines[failure.line as number] ?? "";
        const record = buildQuarantineRecord(quarantinedAt, failure, rawRemovedLine);
        appended += `${JSON.stringify(record)}\n`;
        quarantined.push(toQuarantinedLineSummary(failure));
      }
      // Append-only: whatever quarantine history already exists for this
      // month survives, exactly as `append`'s own read-check-concatenate
      // pattern preserves a month file's prior content.
      files.push({ path: qPath, content: existingQuarantine + appended });
    }

    await hooks.beforeCas?.(attemptNumber);

    const outcome = await adapter.commitTreeToRef(validatedRef, {
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
