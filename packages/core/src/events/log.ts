/**
 * `events/log.ts` — append and read the event log on the coordination ref
 * (ADR 0001:694-848, "M2.7 (`events/log.ts`) must implement").
 *
 * This file builds `append`/`read` only. It does **not** build:
 * - the lease-observation store or lease-expiry logic (fm7 — dispatch 3);
 * - the poisoned-ref recovery path (ADR 0001:828-848 — dispatch 4);
 * - the union/rebuild/CAS reconciliation flow (Ruling R5) — `read()` takes
 *   the ref name as a parameter specifically so a staging ref populated by
 *   M2.6's `fetchReconciliation` is readable by this same function, and
 *   `read()`'s dedupe-by-id-with-content-check plus its "never drop an
 *   event" guarantee are this dispatch's whole contribution to ADR
 *   0001:795-809. Nothing here unions two refs or CASes a rebuilt tree.
 * - `state/fold.ts`'s reconciliation tie-break (ADR 0001:802-809) — `read()`
 *   exposes each record's chain position so M2.8 can build it; this file
 *   does not choose a winner between two claims.
 */

import { monotonicFactory } from "ulid";
import { CanKanError } from "../errors";
import type { CasRetryOptions, GitAdapter } from "../git/index";
import { validateCoordinationRef, withCasRetry } from "../git/index";
import { EventErrorCodes } from "./errors";
import { canonicalizeTicketId, parseEvent } from "./schema";
import type { Event, EventId, EventValidationIssue } from "./schema";

// ============================================================================
// Month keys — the append-time clock decides the file, never a peer's `ts`
// ============================================================================

/**
 * `events/<yyyy-mm>.jsonl`'s month key, from an injectable clock reading —
 * never from an event's own `ts` (obligation D). `ts` is peer-supplied and
 * is never routing authority: the month file an event lands in is decided by
 * **this module's** clock at the moment `append` runs, full stop. If a
 * caller ever needs "the month of an existing event," the answer is the
 * month file it was read out of (`EventRecord.month`, below) — already
 * tracked per Ruling R3 — never a re-derivation from `event.ts`.
 *
 * Exported (module-internal — not re-exported from `events/index.ts`) so
 * `ref.ts` can compute the same key for its own placeholder file without a
 * second, potentially-diverging implementation.
 */
export function monthKeyUtc(nowMs: number): string {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Upper bound on `trailingMonths`/`ReadOptions.trailingMonths` (fix round 1,
 * S1). 120 (10 years) is generous headroom over any lease-derived value a
 * sane config could produce, while bounding the loop below against a
 * degenerate or hostile one: `config/schema.ts`'s lease-duration pattern
 * (`/^\d+(ms|s|m|h|d|w)$/`) admits an unbounded digit count, so a checked-in
 * `lease: <hundreds of digits>w` value can produce `Infinity` (or a
 * similarly absurd finite number) once converted to a month count —
 * confirmed by probe (see task-2-report.md's fix-round-1 addendum) that,
 * unguarded, this drove a synchronous, unbounded `Array.push` loop that
 * starved the event loop.
 */
const MAX_TRAILING_MONTHS = 120;

/**
 * Validates `trailingMonths` before it drives any loop (fix round 1, S1).
 * Must be a finite integer in `[1, MAX_TRAILING_MONTHS]` — `0`, a negative
 * number, `NaN`, and `Infinity` are all rejected by `Number.isInteger`
 * alone (which is `false` for all four), and the upper bound additionally
 * rejects a merely-huge-but-finite value that would otherwise still hang
 * the loop for an unreasonable time. Raised **before** any git invocation:
 * this is a parameter-shape check, not a git-state check.
 */
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
 * Validates the clock reading both `append` and `read` accept as `now`
 * (fix round 2, NEW-2). `options.now ?? Date.now()` was previously
 * unvalidated in `read` while its sibling parameter, `trailingMonths`, was
 * — on the very next line — the exact class of oversight fix round 1's own
 * house rule warns about ("check the siblings at the same call site").
 * `now: NaN` makes `monthKeyUtc` produce the literal string `"NaN-NaN"`, so
 * `read`'s month-key window becomes a list of months that cannot exist —
 * `read()` silently resolves `[]` on a board that has real events, S1's
 * exact fail-open shape, just reached through the sibling parameter rather
 * than `trailingMonths` itself. `now: Infinity`/`-Infinity` has the same
 * effect in `read`, and in `append` additionally mints a ULID whose seed
 * time can never be beaten by a later real-clock call, permanently
 * degrading the shared `injectedClockUlidFactory` lane (fix round 1, S6) —
 * see that constant's doc comment. Not peer-reachable (`now` is a
 * caller-supplied clock reading, never read from the log), but reachable
 * with no attacker at all from an upstream `Date.parse` that returned
 * `NaN`. Raised **before** any git invocation, alongside
 * `validateTrailingMonths`.
 */
function validateNow(now: number): void {
  if (!Number.isFinite(now)) {
    throw new CanKanError(EventErrorCodes.EVENT_LOG_INVALID_WINDOW, `now must be a finite number, got ${now}`, {
      details: { now },
    });
  }
}

/**
 * The `trailingMonths` trailing month keys ending at `monthKeyUtc(nowMs)`,
 * **oldest first** — the order `read()` walks in, so line indices and the
 * `position` counter both advance in append-only chain order (obligation D's
 * companion: a month's *name* is decided by the clock, but which months get
 * read, and in what order, must still walk oldest-to-newest to mean
 * anything as a chain position).
 *
 * `trailingMonths` must already be validated (`validateTrailingMonths`) by
 * the time this runs — this function does not re-check it, so it stays a
 * pure "compute the keys" helper with no error-raising responsibility of
 * its own.
 */
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

// ============================================================================
// Line splitting — `/\r?\n/` only (obligation C)
// ============================================================================

/**
 * Splits a month blob into its logical lines. **Splits only on `/\r?\n/`,
 * never anything Unicode-line-aware** (obligation C, routed from dispatch
 * 1's security review): `JSON.stringify` escapes `\n`/`\r`/ESC/NUL but
 * leaves U+2028 LINE SEPARATOR raw in its output — confirmed by probe (see
 * task-2-report.md). A Unicode-aware line split would desynchronize one
 * attacker-controlled line into two, silently corrupting every line index
 * this module reports (to a caller, or into a diagnosable error) from that
 * point in the file onward.
 *
 * Empty content is **zero** lines, not one empty-string line —
 * `"".split(/\r?\n/)` would otherwise yield `[""]`, a phantom blank line at
 * index 0 for a freshly-initialized (empty) month file. A single trailing
 * `\n`/`\r\n` — the normal case, since every line this module itself writes
 * ends in one — is dropped without comment. Any *other* blank entry (a
 * leading, embedded, or un-terminated-tail blank) is returned as an empty
 * string at its real index: this function does not skip or repair a
 * malformed line, it reports it at the right position for the caller (fm8)
 * to fail closed on.
 */
export function splitJsonlLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const parts = content.split(/\r?\n/);
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Counts `content`'s logical lines under the exact same rule
 * `splitJsonlLines` applies, **without allocating the array of substrings**
 * (fix round 1, S2). `append`'s retry loop only ever needs the *count* (to
 * report `AppendedEvent.line`), and building the whole split array purely to
 * read its `.length` is wasted allocation on every attempt, of content that
 * can be up to `MAX_MONTH_BLOB_BYTES` in size (measured to matter —
 * task-2-report.md's fix-round-1 addendum).
 *
 * Single forward scan counting `\n` occurrences (a `\r\n` pair still
 * contains exactly one `\n`, so this counts identically to `splitJsonlLines`
 * for either line ending) plus one more if `content` does not end in a
 * newline — mirroring `splitJsonlLines`'s "an un-terminated tail is one more
 * line" rule exactly, even though `appendCore`'s own malformed-tail check
 * (immediately before this is called) means that branch is unreachable from
 * `append` today; kept correct anyway so this stays a faithful, reusable
 * counterpart to `splitJsonlLines` rather than a shortcut valid only under
 * `append`'s specific preconditions.
 */
function countJsonlLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* "\n" */) {
      count += 1;
    }
  }
  if (!content.endsWith("\n")) {
    count += 1;
  }
  return count;
}

// ============================================================================
// Size bounds — obligation A, and fix round 1's S1/S2
// ============================================================================

/**
 * Obligation A: the byte cap applied to each line *before* `parseEvent` (and
 * therefore `JSON.parse`) ever sees it — confirmed by probe (dispatch 1's
 * report) that a `.max()` inside the schema cannot prevent the allocation,
 * since `JSON.parse` has already materialized the whole string by the time
 * zod runs. Derived, not guessed: `MAX_HOOK_OUTPUT_CHARS` (100,000,
 * `schema.ts`) is this schema's single largest free-text field, and
 * `JSON.stringify` can expand a character to a 6-byte `\uXXXX` escape in the
 * worst case (a lone surrogate or a control character), so the largest
 * legitimate `hook` event's `output` field alone can occupy up to 600,000
 * bytes of line content. 1 MiB (1,048,576 bytes) rounds that up with
 * headroom for the rest of the envelope and every other field, while still
 * bounding a single push far below "every peer that fetches the ref pays a
 * 500MB allocation on every read" (the attack obligation A names).
 */
const MAX_LINE_BYTES = 1_048_576;

/**
 * A month blob's own overall size bound. **Honesty about what this bound
 * can and cannot do, stated directly rather than implied**: by the time
 * `readBlobFromRef` returns, `git cat-file` has already materialized the
 * entire blob as one string — `GitAdapter` exposes no way to size-check
 * before that happens, so this check runs strictly *after* the allocation
 * obligation A is concerned with, unlike `MAX_LINE_BYTES` above (which runs
 * before `parseEvent`/`JSON.parse` touch a specific line). This is
 * therefore a resource **sanity** bound — it stops a single month file from
 * growing without limit and stops a `read()` call from continuing to
 * process a blob that is already absurd — not a pre-allocation DoS defense.
 * A true pre-allocation guard would need `readBlobFromRef`'s own `cat-file`
 * invocation to size-check before streaming the content back, which is
 * M2.6's surface, not this module's, and is flagged in the report rather
 * than worked around here.
 *
 * 64 MiB is deliberately generous: at `MAX_LINE_BYTES`'s cap, that is still
 * room for 64 fully-maximal lines, and for the realistic case of small
 * claim/renew/release events (well under a kilobyte each), tens of millions
 * of events in one month — far beyond anything a real board produces.
 * **A separate line-count bound was considered and rejected as redundant**:
 * the shortest possible valid JSONL line this schema can produce is well
 * over ten bytes (`{"ts":"...",...}`), so a byte bound already caps the
 * line count by construction; a second, independent counter would duplicate
 * the same protection without adding a case this bound misses.
 *
 * **Fix round 1, S2: also enforced by `append`, against the blob it is
 * about to extend, not only by `read`.** Before this fix, `read` refused a
 * month past this size while `append` had no bound at all — a write path
 * that helped an attacker grow exactly what the read path already refused,
 * silently. `AppendOptions.maxExistingBlobBytes` (default: this constant) is
 * the escape hatch a caller with a legitimate reason to write past this
 * bound (dispatch 4's poisoned-ref recovery/quarantine write) can use —
 * see that option's own doc comment.
 */
const MAX_MONTH_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * `read`'s aggregate cap across its whole `trailingMonths` window (fix
 * round 1, S2). The per-month cap above bounds one file; without this, a
 * caller passing a large `trailingMonths` (a legitimate use of the
 * documented M2.10 contract on that parameter — see `DEFAULT_TRAILING_MONTHS`'s
 * doc comment) could still be asked to hold `trailingMonths ×
 * MAX_MONTH_BLOB_BYTES` in memory at once: 24 months × 64 MiB = 1.5 GiB for
 * one `read()` call. 256 MiB is generous for any real board (the same
 * "tens of millions of small events" headroom `MAX_MONTH_BLOB_BYTES`'s own
 * comment describes, spread across up to `MAX_TRAILING_MONTHS` files
 * instead of one) while giving `read()` a resource ceiling independent of
 * how large a window a caller asks for.
 */
const MAX_AGGREGATE_READ_BYTES = 256 * 1024 * 1024;

/** Flattens `EventValidationIssue[]` into plain strings (fix round 1, S5) — see the call sites' comments for why. */
function renderIssues(issues: readonly EventValidationIssue[]): string[] {
  return issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path}: ${issue.message} (${issue.code})` : `${issue.message} (${issue.code})`,
  );
}

// ============================================================================
// `append(event)`
// ============================================================================

/**
 * A ULID factory shared across every `append` call that runs on the real,
 * un-injected clock (obligation: two events minted in the same millisecond
 * by this process still sort strictly increasing — confirmed by probe, see
 * task-2-report.md). **Module-level and stateful on purpose**: `ulid`'s
 * `monotonicFactory` return value tracks the last time/randomness it
 * produced internally, so a *fresh* factory per call would lose that state
 * and defeat same-millisecond monotonicity across separate `append` calls.
 *
 * **Fix round 1, S6 — this instance is used only when `options.now` is NOT
 * supplied.** The original bug: feeding a caller-injected `now` into this
 * *shared* factory permanently "pins" it — `ulid`'s monotonic factory does
 * not roll its internal clock backward for a smaller seed time than it has
 * already seen (confirmed by probe, task-2-report.md); it just keeps
 * incrementing randomness against the highest timestamp it was ever given.
 * So one caller injecting a `now` in the past (a replay tool, a CLI `--at`
 * flag, a test sharing this process with a real board) would silently stop
 * every *subsequent, real-clock* `append` call from tracking real time.
 *
 * **The first fix attempt (a fresh `monotonicFactory()` per call whenever
 * `now` is injected) was itself wrong, caught by this dispatch's own test
 * suite going red**: two separate `append` calls injecting the *same* `now`
 * (a completely ordinary pattern — any test or replay that holds a clock
 * fixed across a burst of appends) got two *independent* fresh factories,
 * each drawing its own random suffix with no ordering relationship to the
 * other — breaking the very "same millisecond, same process, still
 * monotonic" guarantee this factory exists for, this time across calls
 * instead of within one. The real fix needs two *persistent* lanes, not a
 * shared one and a disposable one: see `injectedClockUlidFactory` below.
 */
const defaultUlidFactory = monotonicFactory();

/**
 * The second lane (fix round 1, S6): a *separate*, equally persistent
 * `monotonicFactory()` instance used for every `append` call that supplies
 * its own `options.now` (and no explicit `ulidFactory`). Sharing this one
 * instance across every injected-clock call preserves monotonicity within a
 * sequence of such calls — exactly what a test or replay tool holding a
 * fixed or scripted clock needs — while keeping it **completely isolated**
 * from `defaultUlidFactory`, so an injected `now` (however far in the past)
 * can never pin or otherwise affect a real-clock `append`'s minted ids, and
 * vice versa. Two independent lanes, not "shared" and "disposable," is what
 * makes both halves of the original property hold at once: monotonic across
 * repeated calls sharing a clock, and never cross-contaminated between the
 * real-clock and injected-clock paths.
 */
const injectedClockUlidFactory = monotonicFactory();

/**
 * Every event kind, with `id` optional — the shape `append`'s caller
 * constructs. `id` is minted (a monotonic ULID) when omitted; every other
 * field is the caller's, unchanged. A plain `Omit<Event, "id">` does not
 * work here: `Event` is a discriminated union whose members carry different
 * kind-specific fields (`lease_until`, `reason`, ...), and `Omit`/`Pick`
 * key off `keyof Event`, which for a union is only the fields *every*
 * member shares — collapsing straight to the envelope and silently
 * dropping `lease_until`/`reason`/etc. entirely (confirmed directly: a
 * naive `Union extends unknown ? Omit<Union, K> : never` written with the
 * union type itself, rather than a generic type parameter, as the checked
 * type does **not** distribute — TypeScript's distributive-conditional-type
 * rule triggers only when the checked type is a bare generic type
 * parameter, so that expression collapses to one non-distributed
 * `Omit<Event, "id">`, and `tsc` then rejects a legitimate
 * kind-specific-field candidate object as carrying an "unknown property" —
 * see task-2-report.md's probe). `DistributiveOmit` below is a genuine
 * generic alias, so `T` is a naked type parameter and the conditional does
 * distribute, producing a real per-kind union.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> & { readonly id?: EventId } : never;
export type EventCandidate = DistributiveOmit<Event, "id">;

export interface AppendOptions {
  /**
   * The clock `append` uses for two things: which `events/<yyyy-mm>.jsonl`
   * file the event is written to (obligation D — never from the event's own
   * `ts`), and the upper bound `parseEvent` checks `ts` against. Defaults to
   * `Date.now()`. Injectable so a month-rollover test can write events
   * either side of a UTC boundary without waiting for real time to cross
   * it.
   *
   * **Fix round 1, S6**: supplying this also switches id-minting (when
   * `ulidFactory` is not separately given) to the separate
   * `injectedClockUlidFactory` lane instead of the real-clock
   * `defaultUlidFactory` — see both constants' doc comments for why two
   * persistent lanes, not a shared one and a disposable one, are what keep
   * this correct.
   */
  readonly now?: number;
  /**
   * The ULID factory used to mint `id` when the caller's candidate omits
   * it. Defaults to `defaultUlidFactory` (the real-clock lane) when `now` is
   * not supplied, or `injectedClockUlidFactory` (the injected-clock lane)
   * when it is (fix round 1, S6 — see both constants' doc comments).
   * Injectable so a test can control
   * minted ids deterministically (`ulid`'s `ULIDFactory` type is
   * `(seedTime?: number) => string`, and `monotonicFactory()`'s return
   * value accepts an explicit seed time — confirmed by probe, see
   * task-2-report.md).
   */
  readonly ulidFactory?: (seedTime?: number) => string;
  /** Passed through to `withCasRetry` unchanged — the retry policy is M2.6's, not reimplemented here. */
  readonly casRetry?: CasRetryOptions;
  /**
   * The cap on the *existing* month blob's size, checked before this call
   * extends it (fix round 1, S2). Defaults to `MAX_MONTH_BLOB_BYTES` — the
   * same bound `read()` enforces, so a normal `append` can never grow a
   * month past what a subsequent `read()` would accept.
   *
   * **This is a deliberate, public escape hatch, not a normal-use knob.**
   * A caller with a legitimate reason to write into an already-oversized
   * month — dispatch 4's poisoned-ref recovery/quarantine write, most
   * plausibly — can override this (e.g. to `Number.POSITIVE_INFINITY`) to
   * disable the check for that one call. Left reachable deliberately:
   * making this cap absolute would give a corrupted, oversized log no
   * write path back to a recoverable state, which is a worse outcome than
   * the DoS this cap defends against. Ordinary callers should never touch
   * this field.
   *
   * Validated (fix round 2, Low): must be `>= 0`. `NaN` would otherwise
   * silently disable the cap entirely (`existingBytes > NaN` is always
   * `false` in JavaScript), and a negative value would refuse even an
   * empty month. `Number.POSITIVE_INFINITY` — the bypass documented above
   * — is explicitly a valid value; only `NaN` and negative numbers are
   * rejected.
   */
  readonly maxExistingBlobBytes?: number;
}

/**
 * `append`'s result: the validated, canonicalized event plus where it
 * landed. No `position` field (contrast `read`'s `EventRecord`, below) —
 * `append` writes exactly one line to exactly one file; "a monotonic
 * sequence number across the aggregated window" only means something once a
 * window of multiple months has actually been walked, which is `read`'s
 * concern, not a single append's.
 */
export interface AppendedEvent {
  readonly event: Event;
  /** The `yyyy-mm` month file this event was written to. */
  readonly month: string;
  /** Zero-based line index within that month file. */
  readonly line: number;
}

/**
 * Test-only injection point for `appendCore`'s internal retry loop, and for
 * `ref.ts`'s `initRefCore` by the same mechanism. **Not part of the public
 * surface**: `appendCore` (unlike `append`) is not re-exported from
 * `events/index.ts`, exactly like `git/adapter.ts`'s `updateRefCASCore` is a
 * module-internal export that only `git.test.ts` imports directly (see that
 * file's own doc comment for the identical pattern). A normal caller only
 * ever sees `append`, whose implementation passes no hooks — there is no
 * option on `AppendOptions` (the type `append` actually accepts) through
 * which a hook could reach this loop from outside `log.ts`'s own module
 * scope or a test importing `appendCore` directly.
 */
export interface AppendHooks {
  /**
   * Invoked once per CAS attempt, after this attempt's read-and-check step
   * (fresh `readRef`/`readBlobFromRef`, fresh malformed-tail check) and
   * immediately before `commitTreeToRef`. A test uses this to force a
   * losing race deterministically: append a *different* event to the same
   * ref from inside the hook, so this attempt's `commitTreeToRef` is
   * guaranteed to see a stale parent and get rejected, driving a real
   * second attempt through the loop.
   */
  readonly beforeCas?: (attemptNumber: number) => Promise<void>;
}

/**
 * Appends one event to the coordination ref's event log.
 *
 * **The mandated cycle (ADR 0001:696-699), generalized from `claimViaCAS` to
 * the full event union**: read the ref and the current month's blob, check
 * the blob's own integrity (the size bound and trailing-newline invariant
 * below), build the new commit off-tree, `updateRefCAS`, and on rejection,
 * re-read and re-check — never blind-retry the same built commit.
 * `withCasRetry` (M2.6) owns the attempt bound and backoff; the callback
 * passed to it owns the re-read, which is why the read is written inside
 * that callback rather than hoisted above the `withCasRetry` call (see the
 * doc comment directly on the callback below, and test 4 in `log.test.ts`,
 * which fails if this is ever restructured to read once and reuse a stale
 * blob across attempts).
 *
 * **Does not check whether the event is otherwise valid to append** (e.g.
 * "is this ticket already claimed") — that business logic belongs to
 * whatever decided to call `append` in the first place (M2.8's fold, per
 * Ruling R5), not to this low-level primitive. This function's only "check"
 * is git-and-blob-level: does the ref's current state disagree with what a
 * built commit assumed, and is the blob it is about to extend intact and
 * within bounds.
 *
 * **Lazy ref initialization happens here, implicitly, not via a call to
 * `ref.ts`'s `initRef`.** When `readRef` returns `null` (fm6: a fresh clone,
 * or a board that has never been written to), this function's own
 * `parent: null` branch creates the ref *and* the first event in one commit
 * — there is no separate "create the ref" step to sequence beforehand. A
 * concurrent `initRef` call (or a second concurrent `append`) racing the
 * same `parent: null` moment loses exactly the way the `parent: null`
 * probe in task-2-report.md demonstrates (`"reference already exists"`,
 * content unchanged) and this function's own retry loop re-reads and
 * rebuilds onto the winner. `ref.ts`'s `initRef` exists for a caller (e.g.
 * `cankan init`) that wants the ref to exist, empty, *before* any real
 * event is ready to append — this function does not call it and does not
 * need to.
 */
export async function append(
  adapter: GitAdapter,
  ref: string,
  candidate: EventCandidate,
  options: AppendOptions = {},
): Promise<AppendedEvent> {
  return appendCore(adapter, ref, candidate, options, {});
}

/** See `AppendHooks`'s doc comment: the module-internal export a test drives directly. `append` is the public surface; it calls this with no hooks. */
export async function appendCore(
  adapter: GitAdapter,
  ref: string,
  candidate: EventCandidate,
  options: AppendOptions,
  hooks: AppendHooks,
): Promise<AppendedEvent> {
  // Fix round 2 (Low, consistent with read()'s own reordering): the fm10
  // ref gate runs before any parameter-shape check, so a call carrying both
  // a bad ref and a bad `now` reports the ref problem, not the clock one.
  const validatedRef = await validateCoordinationRef(ref);
  const now = options.now ?? Date.now();
  // Fix round 2, NEW-2: `now` must be finite — see `validateNow`'s doc
  // comment for why an unvalidated NaN/Infinity here is more than a read()
  // problem (it also poisons the injected-clock ULID lane below).
  validateNow(now);
  // Fix round 1, S6: an injected `now` uses the separate, equally
  // persistent `injectedClockUlidFactory` lane rather than the real-clock
  // `defaultUlidFactory` — see both constants' doc comments for why two
  // persistent lanes (not one shared, one disposable) are what preserve
  // monotonicity within an injected-clock sequence while still isolating it
  // from the real-clock path.
  const mint = options.ulidFactory ?? (options.now !== undefined ? injectedClockUlidFactory : defaultUlidFactory);
  const maxExistingBlobBytes = options.maxExistingBlobBytes ?? MAX_MONTH_BLOB_BYTES;
  // Fix round 2 (Low): `NaN` would otherwise silently disable the size cap
  // (`existingBytes > NaN` is always `false`), and a negative value would
  // refuse even an empty month — see `AppendOptions.maxExistingBlobBytes`'s
  // doc comment. `Number.POSITIVE_INFINITY` (the documented bypass) is
  // explicitly allowed.
  if (Number.isNaN(maxExistingBlobBytes) || maxExistingBlobBytes < 0) {
    throw new CanKanError(
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
      `maxExistingBlobBytes must be a non-negative number (or Infinity), got ${maxExistingBlobBytes}`,
      { details: { maxExistingBlobBytes } },
    );
  }

  // The id is minted once, before the retry loop — not per attempt. A retry
  // re-reads and re-checks git-level state, but it is still the same
  // logical append being retried; minting a fresh id on each attempt would
  // let one logical `append` call surface as several distinct events if an
  // earlier attempt's write is ever mistaken for having applied (it cannot,
  // per `CasOutcome`'s contract, but the id should not depend on that
  // contract holding).
  const id = (candidate.id ?? (mint(now) as EventId)) as EventId;
  const withId = { ...candidate, id };
  // Obligation A/Ruling R11: validate the *exact bytes* about to enter the
  // log — `parseEvent(JSON.stringify(...))`, not the constructed object
  // directly — so this function can never persist a byte sequence it did
  // not itself validate.
  const line = JSON.stringify(withId);
  const parsed = parseEvent(line, { now });
  if (!parsed.ok) {
    throw new CanKanError(EventErrorCodes.EVENT_APPEND_REJECTED, "event failed schema validation before append", {
      // Fix round 1, S5: flattened to strings — `errors.ts`'s flatness
      // policy ("JSON primitives, or arrays of them") applies to `details`,
      // and `EventValidationIssue[]` is an array of objects that would
      // otherwise stay aliased to zod's own (mutable) issue objects despite
      // this error's shallow freeze.
      details: { reason: parsed.error.reason, issues: renderIssues(parsed.error.issues) },
    });
  }
  const event = parsed.event;
  const month = monthKeyUtc(now);
  const path = monthPath(month);

  return withCasRetry<AppendedEvent>(async (attemptNumber) => {
    // **Every attempt re-reads. This is not hoistable out of the loop.** A
    // retry that rebuilt from the first attempt's `existing` blob would
    // silently drop whatever the winning writer appended in between —
    // exactly the defect PLAN.md's "appends from two worktrees interleave
    // without loss" floor test exists to catch (ADR 0001:696-699). See
    // `AppendHooks.beforeCas` above and `log.test.ts`'s CAS-retry test,
    // which forces a real second attempt and asserts both events survive.
    const parentSha = await adapter.readRef(validatedRef);
    let existing = "";
    if (parentSha !== null) {
      existing = (await adapter.readBlobFromRef(validatedRef, path)) ?? "";
    }

    // Fix round 1, S2: bound the blob this attempt is about to extend,
    // before doing anything else with it. Without this, `append` had no
    // size check at all while `read` refused anything past
    // `MAX_MONTH_BLOB_BYTES` — a write path that silently helped an
    // attacker grow exactly what the read path already declined. Checked
    // every attempt (not hoisted) for the same reason the read below is not
    // hoisted: `existing` is re-fetched fresh each time.
    const existingBytes = Buffer.byteLength(existing, "utf8");
    if (existingBytes > maxExistingBlobBytes) {
      // Fix round 2, NEW-3: `commit: parentSha` — ADR 0001:1176-1178 makes
      // naming the offending commit a property of *the error*, not of
      // which function raises it. Fix round 1's F1 added `commit: head` to
      // every `read()` throw site but missed both of `append`'s own
      // fm8-class errors (this one and the malformed-tail one below) —
      // safe to include: `parentSha` is necessarily non-null here (a
      // non-empty `existing`, which is required to reach this branch,
      // is only ever populated when `parentSha !== null`, a few lines
      // above), and it is module-derived (this function's own `readRef`
      // result), never peer-authored content.
      throw new CanKanError(EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE, `month file exceeds the maximum blob size, refusing to extend it: ${path}`, {
        details: { ref: validatedRef, commit: parentSha, month, path, bytes: existingBytes, maxBytes: maxExistingBlobBytes },
      });
    }

    // The "check" half of read-check-build, generalized: this attempt's
    // month blob must be intact before this function extends it. A month
    // file this module wrote always ends in `\n`; a non-empty blob that
    // does not is someone else's truncated write (fm8(a)'s partially-
    // written-line case, encountered before the line is even split out).
    // Appending onto it via plain concatenation would fuse this event onto
    // the truncated tail, corrupting both — fail closed instead.
    if (existing.length > 0 && !existing.endsWith("\n")) {
      // Fix round 2, NEW-3: `commit: parentSha` — see the identical note
      // on the size-cap throw immediately above.
      throw new CanKanError(
        EventErrorCodes.EVENT_LOG_MALFORMED_BLOB,
        `month file does not end with a newline, refusing to append onto a truncated tail: ${path}`,
        { details: { ref: validatedRef, commit: parentSha, month, path } },
      );
    }

    // Fix round 1, S2: count lines without allocating the split array —
    // `appendCore` only needs the count, and building the whole array
    // (`splitJsonlLines(existing).length`) allocated a full copy of
    // `existing`'s content as substrings on every attempt, up to
    // `maxExistingBlobBytes` in size.
    const priorLineCount = countJsonlLines(existing);
    const newContent = `${existing}${line}\n`;

    await hooks.beforeCas?.(attemptNumber);

    const outcome = await adapter.commitTreeToRef(validatedRef, {
      parent: parentSha,
      // Commit message carries only values this function itself validated —
      // `event.id` (ULID grammar, no escape-capable character) and
      // `event.event` (one of twelve fixed literals) — never a caller-
      // supplied free-text field.
      message: `event ${event.id} ${event.event}`,
      files: [{ path, content: newContent }],
    });

    if (outcome.outcome === "applied") {
      return { done: true, value: { event, month, line: priorLineCount } };
    }
    return { done: false };
  }, options.casRetry);
}

// ============================================================================
// `read({ since, ticket, actor })`
// ============================================================================

/**
 * `read`'s default aggregation window (Ruling R4): current month plus the
 * previous one. This is a **parameter**, not a config read — M2.3 (config)
 * is not in M2.7's `Depends on` list, so `claims.lease` (the value that
 * would otherwise decide how many trailing months matter) is unreachable
 * from here without violating PLAN.md rule 2. **Contract for M2.10** (which
 * does depend on M2.3): pass `trailingMonths` computed from the configured
 * lease — enough trailing months that a lease taken out near the end of a
 * month is still visible after the boundary (ADR 0001:765-773, fm9). This
 * default is the ADR's stated floor, not a value tuned to any specific
 * lease length. **Must be a finite integer in `[1, 120]` (fix round 1, S1)**
 * — see `validateTrailingMonths`.
 */
const DEFAULT_TRAILING_MONTHS = 2;

/**
 * One event as returned by `read` — the event itself plus its position in
 * the append-only chain (Ruling R3, the single API-shape decision M2.8
 * depends on most).
 *
 * **`(month, line)` is the stable chain coordinate — the one M2.8's
 * ADR-mandated tie-break (0001:802-809) must key on (fix round 1, Ruling
 * R16).** Ordered month-ascending then line-ascending, `(month, line)` is
 * identical for a given event across every `read()` call that includes its
 * month, regardless of `trailingMonths`/`now`.
 *
 * **`position` is a within-call ordinal convenience only — never a stable
 * identifier.** Its absolute value depends on how many months this
 * particular call aggregated: two peers running `read()` with different
 * `trailingMonths` (different lease configs, per the M2.10 contract above)
 * assign *different* `position` values to the *same* event, which is not
 * the determinism ADR 0001:811-826 requires of a reconciliation tie-break.
 * `position` must never be stored, compared across separate `read()` calls,
 * or treated as a cross-peer identifier — it exists only to let a caller
 * order the records this one call returned without re-deriving
 * `(month, line)` comparisons itself.
 *
 * **Chain position is deterministic, not trustworthy — read this before
 * building a tie-break on it.** `ts` is disqualified as ordering authority
 * because a ULID's timestamp prefix is peer-supplied (ADR 0001:723-725,
 * fm7) — true, but incomplete on its own: a peer with push access can
 * rewrite an *entire* month blob (there is nothing that pins history), so
 * file order — and therefore `(month, line)` — is peer-influenceable too,
 * not merely peer-observed. ADR 0001:811-826 admits chain position as
 * authority anyway **because it is deterministic** (two peers reconciling
 * the identical union of events compute the identical order), not because
 * it cannot be manipulated. A concrete, cheap manipulation: a peer that
 * replays an already-observed line **byte-identically** into an *earlier*
 * month moves that one event's reported `(month, line)`/`position` without
 * touching any other line at all, via this function's own
 * first-occurrence-wins dedupe fold (a byte-identical duplicate is folded
 * into whichever occurrence is encountered first in the oldest-to-newest
 * walk). M2.8's tie-break must be built with this in mind: "deterministic
 * across peers reconciling the same events" is the property chain position
 * provides, not "immune to a peer choosing where its own events land."
 */
export interface EventRecord {
  readonly event: Event;
  /** The `yyyy-mm` month file this event was read from. */
  readonly month: string;
  /** Zero-based line index within that month file. */
  readonly line: number;
  /**
   * A monotonic sequence number across the aggregated window (this
   * `read()` call's `trailingMonths`), assigned in append-only chain order:
   * months walked oldest to newest, lines within a month walked in file
   * order, incrementing once per *distinct* event id (a byte-identical
   * duplicate line is folded into the earlier record and does not consume
   * a new position). **Meaningful only for comparing records returned by
   * this same `read()` call** — see this interface's own doc comment for
   * the full "never store or compare across calls" rule.
   */
  readonly position: number;
}

export interface ReadOptions {
  /** Upper bound `parseEvent` checks each line's `ts` against. Defaults to `Date.now()`. Injectable for the same reason as `AppendOptions.now`. */
  readonly now?: number;
  /**
   * How many trailing months (current plus this many minus one before it)
   * to aggregate, oldest to newest. Defaults to `DEFAULT_TRAILING_MONTHS`
   * (2) — see that constant's doc comment for the M2.10 config contract.
   * Validated (fix round 1, S1): must be a finite integer in `[1, 120]`, or
   * `read()` throws `EVENT_LOG_INVALID_WINDOW` before doing anything else.
   */
  readonly trailingMonths?: number;
  /**
   * A ULID lower bound, **exclusive**: only events with `id > since` are
   * returned. Not a timestamp bound — `ts` is peer-supplied and must never
   * gate a read (obligation D's sibling rule). A caller polling
   * incrementally passes the highest `id` it has already seen; `since`
   * itself is not re-returned.
   */
  readonly since?: EventId;
  /** Matched case-insensitively: canonicalized the same way `append` canonicalizes `ticket` on write (ADR 0001:751-764), so `read({ ticket: "CK-1" })` finds an event appended as `ck-1`. */
  readonly ticket?: string;
  /** Matched by exact string equality. `actor` is never canonicalized (it is not a ticket-shaped id; see `schema.ts`'s `actorSchema` doc comment) and is not an authenticated identity either. */
  readonly actor?: string;
}

/**
 * Reads events from the coordination ref, aggregated across
 * `options.trailingMonths` months (Ruling R4, fm9) and validated line by
 * line (obligation A/B/C, ADR 0001:716-723, fm8, fm11).
 *
 * **Returned in ULID order** (PLAN.md's done-when) — `id` sorts
 * lexicographically in encounter order because every id is the same fixed
 * 26-character length. **Each record also carries its position in the
 * append-only chain** (Ruling R3): `month`, `line` (zero-based index within
 * that file), assigned as this function walks months oldest-to-newest and
 * lines in file order — the ordering *authority* per ADR 0001:723-725 and
 * fm7, since a ULID's timestamp prefix is itself peer-supplied. See
 * `EventRecord`'s own doc comment for what "authority" does and does not
 * mean here, and for why `(month, line)`, not `position`, is the stable
 * coordinate.
 *
 * **Fails closed** (ADR 0001:829-831): a schema-invalid line, an oversized
 * line, blob, or aggregate window, a degenerate `trailingMonths`, or a
 * duplicate event id with differing content throws rather than skipping —
 * the whole read aborts. **Never drops an event** otherwise (ADR
 * 0001:796-800): a byte-identical duplicate id is folded into one record,
 * but every other validated line survives into the result, filters
 * included — filtering (`ticket`/`actor`/`since`) is applied only after
 * every line in the aggregated window has been validated, so a malformed
 * line elsewhere in the window still aborts a `read({ ticket: "ck-1" })`
 * call even though that line would not have matched the filter. A board
 * that answers a narrow query by silently ignoring an unrelated corruption
 * is not actually fail-closed.
 *
 * An absent ref (fm6 — a fresh clone with no `refs/cankan/*` yet) returns
 * `[]`, not an error: this function does not fetch or lazily create
 * anything. Bringing the ref into existence is `append`'s (implicit) or
 * `ref.ts`'s `initRef`'s job; syncing it from a remote is the sync layer's.
 * An absent ref genuinely has no events yet, and `[]` says exactly that.
 */
export async function read(adapter: GitAdapter, ref: string, options: ReadOptions = {}): Promise<readonly EventRecord[]> {
  // Fix round 2 (Low): the fm10 ref gate runs *first* — before either
  // parameter-shape check below. Ordering is observable: a call carrying
  // both a bad ref and a bad window previously reported
  // `EVENT_LOG_INVALID_WINDOW` rather than `GIT_REF_INVALID`, which is the
  // wrong diagnosis to hand a caller who configured the ref wrong (fm10 is
  // the security-relevant gate; the window checks are hygiene).
  const validatedRef = await validateCoordinationRef(ref);
  const now = options.now ?? Date.now();
  const trailingMonths = options.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  // Fix round 1, S1 / fix round 2, NEW-2: validated before any further git
  // invocation and before the month-key loop — a degenerate `trailingMonths`
  // (0, negative, NaN) or a pathologically large one (a hostile
  // config-derived Infinity), and a non-finite `now` (NaN/Infinity, e.g.
  // from an upstream `Date.parse` failure), would otherwise reach unguarded.
  validateNow(now);
  validateTrailingMonths(trailingMonths);

  const head = await adapter.readRef(validatedRef);
  if (head === null) {
    return [];
  }

  const months = trailingMonthKeysOldestFirst(now, trailingMonths);

  // Keyed by event id, to the raw line text it was first seen as — the
  // dedup comparison basis (obligation B, decided below) — and the index
  // into `records` where its one surviving record lives.
  const seen = new Map<EventId, { readonly rawLine: string; readonly recordIndex: number }>();
  const records: EventRecord[] = [];
  let nextPosition = 0;
  // Fix round 1, S2: the sum of every trailing month's blob size in this
  // call's window — bounded independently of the per-month cap below (see
  // `MAX_AGGREGATE_READ_BYTES`'s doc comment).
  let aggregateBytes = 0;

  for (const month of months) {
    const path = monthPath(month);
    const raw = await adapter.readBlobFromRef(validatedRef, path);
    if (raw === null) {
      continue; // No file for this month (yet, or never) — not an error.
    }

    const rawBytes = Buffer.byteLength(raw, "utf8");
    if (rawBytes > MAX_MONTH_BLOB_BYTES) {
      throw new CanKanError(EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE, `month file exceeds the maximum blob size: ${path}`, {
        details: { ref: validatedRef, commit: head, month, path, bytes: rawBytes, maxBytes: MAX_MONTH_BLOB_BYTES },
      });
    }
    aggregateBytes += rawBytes;
    if (aggregateBytes > MAX_AGGREGATE_READ_BYTES) {
      throw new CanKanError(
        EventErrorCodes.EVENT_LOG_AGGREGATE_TOO_LARGE,
        `the aggregated read window exceeds the maximum total size across ${months.length} month(s)`,
        { details: { ref: validatedRef, commit: head, month, path, aggregateBytes, maxAggregateBytes: MAX_AGGREGATE_READ_BYTES } },
      );
    }

    const lines = splitJsonlLines(raw);
    for (let line = 0; line < lines.length; line++) {
      const rawLine = lines[line] ?? "";

      // Obligation A: the byte cap runs *before* `parseEvent` — and
      // therefore before `JSON.parse` — ever sees this line.
      const lineBytes = Buffer.byteLength(rawLine, "utf8");
      if (lineBytes > MAX_LINE_BYTES) {
        throw new CanKanError(EventErrorCodes.EVENT_LOG_LINE_TOO_LARGE, `event log line exceeds the maximum size: ${path}:${line}`, {
          details: { ref: validatedRef, commit: head, month, path, line, bytes: lineBytes, maxBytes: MAX_LINE_BYTES },
        });
      }

      const parsed = parseEvent(rawLine, { now });
      if (!parsed.ok) {
        throw new CanKanError(
          EventErrorCodes.EVENT_LOG_LINE_INVALID,
          `event log line failed validation (${parsed.error.reason}): ${path}:${line}`,
          {
            // Fix round 1, F1: `commit` (the already-resolved, module-derived
            // `head`) is fm8's third required coordinate — "the offending
            // ref/commit/file" — previously omitted. Fix round 1, S5: issues
            // flattened to strings, matching `append`'s own fix (see
            // `renderIssues`).
            details: {
              ref: validatedRef,
              commit: head,
              month,
              path,
              line,
              reason: parsed.error.reason,
              issues: renderIssues(parsed.error.issues),
            },
          },
        );
      }

      const event = parsed.event;
      const previous = seen.get(event.id);
      if (previous !== undefined) {
        // Obligation B, decided deliberately: duplicate-id "content" is
        // compared as **raw line bytes**, not the parsed canonical form.
        // `JSON.parse`'s last-wins duplicate-key resolution (confirmed by
        // probe, dispatch 1's report) means two lines can carry different
        // bytes yet parse to an identical `Event` — a legitimate writer
        // never produces that shape (this module always serializes with
        // `JSON.stringify`, which never emits a duplicate key), so any line
        // that does is itself the signal of a hostile or buggy peer, not
        // proof the two lines are "really" the same event. Byte comparison
        // routes that anomaly to the fail-closed path — and, downstream, to
        // dispatch 4's audit record, which is what actually needs to see
        // it — where a canonical-form comparison would absorb it silently
        // and no operator would ever learn a peer wrote non-`JSON.stringify`
        // output under a shared id. This also matches the ADR's own
        // characterization of the accepted case as "byte-identical," not
        // "semantically identical."
        if (previous.rawLine === rawLine) {
          continue; // The same event, appended twice — folded into the one record already recorded.
        }
        const first = records[previous.recordIndex];
        throw new CanKanError(EventErrorCodes.EVENT_LOG_DUPLICATE_ID_CONFLICT, `duplicate event id with differing content: ${event.id}`, {
          details: {
            ref: validatedRef,
            commit: head,
            id: event.id,
            firstMonth: first?.month,
            firstLine: first?.line,
            month,
            line,
          },
        });
      }

      seen.set(event.id, { rawLine, recordIndex: records.length });
      records.push({ event, month, line, position: nextPosition });
      nextPosition += 1;
    }
  }

  const since = options.since;
  const ticket = options.ticket === undefined ? undefined : canonicalizeTicketId(options.ticket);
  const actor = options.actor;

  const filtered = records.filter((record) => {
    if (since !== undefined && !(record.event.id > since)) {
      return false;
    }
    if (ticket !== undefined && record.event.ticket !== ticket) {
      return false;
    }
    if (actor !== undefined && record.event.actor !== actor) {
      return false;
    }
    return true;
  });

  return filtered.sort((a, b) => (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));
}
