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
import type { Event, EventId } from "./schema";

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
 * The `trailingMonths` trailing month keys ending at `monthKeyUtc(nowMs)`,
 * **oldest first** — the order `read()` walks in, so line indices and the
 * `position` counter both advance in append-only chain order (obligation D's
 * companion: a month's *name* is decided by the clock, but which months get
 * read, and in what order, must still walk oldest-to-newest to mean
 * anything as a chain position).
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

// ============================================================================
// `append(event)`
// ============================================================================

/**
 * A one-shot ULID factory shared across every `append` call that does not
 * inject its own (obligation: two events minted in the same millisecond by
 * this process must still sort strictly increasing — confirmed by probe,
 * see task-2-report.md). **Module-level and stateful on purpose**: `ulid`'s
 * `monotonicFactory` return value tracks the last time/randomness it
 * produced internally, so a *fresh* factory per call would lose that state
 * and defeat same-millisecond monotonicity across separate `append` calls
 * from this process. A caller that needs deterministic ids in a test
 * supplies its own factory via `AppendOptions.ulidFactory` instead of
 * relying on (or fighting) this shared instance.
 */
const defaultUlidFactory = monotonicFactory();

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
   */
  readonly now?: number;
  /**
   * The ULID factory used to mint `id` when the caller's candidate omits
   * it. Defaults to a shared, module-level `monotonicFactory()` instance
   * (see `defaultUlidFactory`'s doc comment for why module-level, not
   * per-call). Injectable so a test can control minted ids deterministically
   * (`ulid`'s `ULIDFactory` type is `(seedTime?: number) => string`, and
   * `monotonicFactory()`'s return value accepts an explicit seed time —
   * confirmed by probe, see task-2-report.md).
   */
  readonly ulidFactory?: (seedTime?: number) => string;
  /** Passed through to `withCasRetry` unchanged — the retry policy is M2.6's, not reimplemented here. */
  readonly casRetry?: CasRetryOptions;
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
 * the blob's own integrity (the trailing-newline invariant below), build the
 * new commit off-tree, `updateRefCAS`, and on rejection, re-read and
 * re-check — never blind-retry the same built commit. `withCasRetry` (M2.6)
 * owns the attempt bound and backoff; the callback passed to it owns the
 * re-read, which is why the read is written inside that callback rather
 * than hoisted above the `withCasRetry` call (see the doc comment directly
 * on the callback below, and test 4 in `log.test.ts`, which fails if this
 * is ever restructured to read once and reuse a stale blob across
 * attempts).
 *
 * **Does not check whether the event is otherwise valid to append** (e.g.
 * "is this ticket already claimed") — that business logic belongs to
 * whatever decided to call `append` in the first place (M2.8's fold, per
 * Ruling R5), not to this low-level primitive. This function's only "check"
 * is git-and-blob-level: does the ref's current state disagree with what a
 * built commit assumed, and is the blob it is about to extend intact.
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
  const now = options.now ?? Date.now();
  const mint = options.ulidFactory ?? defaultUlidFactory;
  const validatedRef = await validateCoordinationRef(ref);

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
      details: { reason: parsed.error.reason, issues: parsed.error.issues },
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

    // The "check" half of read-check-build, generalized: this attempt's
    // month blob must be intact before this function extends it. A month
    // file this module wrote always ends in `\n`; a non-empty blob that
    // does not is someone else's truncated write (fm8(a)'s partially-
    // written-line case, encountered before the line is even split out).
    // Appending onto it via plain concatenation would fuse this event onto
    // the truncated tail, corrupting both — fail closed instead.
    if (existing.length > 0 && !existing.endsWith("\n")) {
      throw new CanKanError(
        EventErrorCodes.EVENT_LOG_MALFORMED_BLOB,
        `month file does not end with a newline, refusing to append onto a truncated tail: ${path}`,
        { details: { ref: validatedRef, month, path } },
      );
    }

    const priorLineCount = splitJsonlLines(existing).length;
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
 * lease length.
 */
const DEFAULT_TRAILING_MONTHS = 2;

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
 */
const MAX_MONTH_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * One event as returned by `read` — the event itself plus its position in
 * the append-only chain (Ruling R3, the single API-shape decision M2.8
 * depends on most). **Chain position, not `ts`, is the ordering authority**
 * (ADR 0001:723-725, fm7): a ULID's timestamp prefix is itself
 * peer-supplied, so `read`'s sorted return order (by `id`, for PLAN.md's
 * named test and for display) is not the same thing as this record's
 * `month`/`line`/`position` — the latter three are what M2.8's ADR-mandated
 * reconciliation tie-break (0001:802-809) and fm7's "most recent by
 * position, never by `ts`" are meant to consume.
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
   * this same `read()` call** — not a stable identifier across two calls
   * with different `trailingMonths` or `now`, since a wider or narrower
   * window changes which position a given event gets assigned.
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
 * fm7, since a ULID's timestamp prefix is itself peer-supplied. **This
 * position is only meaningful for comparing records returned by this same
 * `read()` call** — it is not a stable identifier across two calls with
 * different `trailingMonths` or `now`, and callers (M2.8's tie-break) must
 * not treat it as one.
 *
 * **Fails closed** (ADR 0001:829-831): a schema-invalid line, an oversized
 * line or blob, or a duplicate event id with differing content throws
 * rather than skipping — the whole read aborts. **Never drops an event**
 * otherwise (ADR 0001:796-800): a byte-identical duplicate id is folded
 * into one record, but every other validated line survives into the
 * result, filters included — filtering (`ticket`/`actor`/`since`) is
 * applied only after every line in the aggregated window has been
 * validated, so a malformed line elsewhere in the window still aborts a
 * `read({ ticket: "ck-1" })` call even though that line would not have
 * matched the filter. A board that answers a narrow query by silently
 * ignoring an unrelated corruption is not actually fail-closed.
 *
 * An absent ref (fm6 — a fresh clone with no `refs/cankan/*` yet) returns
 * `[]`, not an error: this function does not fetch or lazily create
 * anything. Bringing the ref into existence is `append`'s (implicit) or
 * `ref.ts`'s `initRef`'s job; syncing it from a remote is the sync layer's.
 * An absent ref genuinely has no events yet, and `[]` says exactly that.
 */
export async function read(adapter: GitAdapter, ref: string, options: ReadOptions = {}): Promise<readonly EventRecord[]> {
  const now = options.now ?? Date.now();
  const trailingMonths = options.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  const validatedRef = await validateCoordinationRef(ref);

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

  for (const month of months) {
    const path = monthPath(month);
    const raw = await adapter.readBlobFromRef(validatedRef, path);
    if (raw === null) {
      continue; // No file for this month (yet, or never) — not an error.
    }

    if (Buffer.byteLength(raw, "utf8") > MAX_MONTH_BLOB_BYTES) {
      throw new CanKanError(EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE, `month file exceeds the maximum blob size: ${path}`, {
        details: { ref: validatedRef, month, path, maxBytes: MAX_MONTH_BLOB_BYTES },
      });
    }

    const lines = splitJsonlLines(raw);
    for (let line = 0; line < lines.length; line++) {
      const rawLine = lines[line] ?? "";

      // Obligation A: the byte cap runs *before* `parseEvent` — and
      // therefore before `JSON.parse` — ever sees this line.
      const lineBytes = Buffer.byteLength(rawLine, "utf8");
      if (lineBytes > MAX_LINE_BYTES) {
        throw new CanKanError(EventErrorCodes.EVENT_LOG_LINE_TOO_LARGE, `event log line exceeds the maximum size: ${path}:${line}`, {
          details: { ref: validatedRef, month, path, line, bytes: lineBytes, maxBytes: MAX_LINE_BYTES },
        });
      }

      const parsed = parseEvent(rawLine, { now });
      if (!parsed.ok) {
        throw new CanKanError(
          EventErrorCodes.EVENT_LOG_LINE_INVALID,
          `event log line failed validation (${parsed.error.reason}): ${path}:${line}`,
          { details: { ref: validatedRef, month, path, line, reason: parsed.error.reason, issues: parsed.error.issues } },
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
