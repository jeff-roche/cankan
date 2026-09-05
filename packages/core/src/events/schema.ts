/**
 * events/schema.ts — the CanKan event union and its runtime validator.
 *
 * This is the schema half of M2.7 only. `events/log.ts` (append/read),
 * `events/ref.ts` (ref init), the lease-observation store, and the
 * poisoned-ref recovery path are later dispatches; nothing here builds or
 * stubs them.
 *
 * **Why this file exists at all — ADR 0001:716-723 ("Validated at the
 * boundary, not cast"), failure mode 11 (~line 1216).** The spike parsed
 * events with `JSON.parse(line) as ClaimEvent` — a compile-time cast, not a
 * runtime check, over a log anyone with push access to the coordination ref
 * can write to. A cast believes whatever shape the peer chose to send.
 * Every export below exists to replace that cast with a real check: `parseEvent`
 * is the boundary every event — read off the ref, or about to be appended to
 * it — must cross before anything downstream (a fold, a lease-expiry check,
 * a CLI render) is allowed to touch it as a typed value.
 *
 * **Ordering authority is the event's position in the append-only chain,
 * never `ts` (ADR 0001:723-725, obligation 6).** Nothing in this file sorts
 * by `ts`, and no downstream consumer should either — `ts` is bounded below
 * for hygiene only (see `PROJECT_EPOCH`'s comment), not because a bounded
 * value becomes trustworthy enough to order or expire anything by.
 */

import { z } from "zod";
import type { ActorId, TicketId } from "../types";

// ============================================================================
// Event ids — ULIDs, validated on read as well as on mint
// ============================================================================

/**
 * A CanKan event id. **Ruling R9 (orchestrator):** a bare 26-character
 * uppercase Crockford base32 ULID — no `evt-` prefix. ADR 0001:774-783
 * requires validating "the fixed length that encoding implies," which a
 * prefixed id does not have; CONCEPT.md's `"id":"evt-01J…"` is an
 * illustrative elision in a JSON example, not the literal wire format (and
 * its own `01J` fragment is itself a real ULID prefix, not part of a
 * `evt-`-tagged scheme).
 */
export type EventId = string & { readonly __brand: "EventId" };

/**
 * Crockford base32, excluding `I`, `L`, `O`, `U` (never used, to avoid
 * visual confusion with `1`, `1`, `0`, `V`). The first character is
 * restricted to `0`-`7`: a ULID's first 10 characters encode a 48-bit
 * millisecond timestamp, and the highest value that fits is `7ZZZZZZZZZ…`
 * (`ulid` package's own `MAX_ULID` constant, confirmed by probe below) — a
 * leading `8` or `9` (or a letter) names a timestamp beyond what a ULID can
 * represent.
 *
 * **Probe (obligation 2), run against `ulid@3.0.2` in this worktree —
 * `bun /tmp/.../ulid-regex-probe.ts` (see task-1-report.md for the full
 * transcript):** `ulid()`'s own `isValid` export uppercases its input
 * before checking the character set, so `isValid(realUlid.toLowerCase())`
 * returns `true` — it does **not** reject lowercase. It also does not
 * range-check the first character: `isValid("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")`
 * and `isValid("ZZZZZZZZZZZZZZZZZZZZZZZZZZ")` both return `true`, even
 * though both encode a timestamp past `MAX_ULID`. Neither of those is
 * acceptable for a peer-supplied id, so this module does **not** use
 * `ulid`'s `isValid` — it defines its own pattern, below, verified against
 * every case the brief named (real ULID, lowercased, 25/27-char, a char from
 * each excluded letter, both overflow shapes) before being wired into the
 * schema.
 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Structural ULID check — Crockford base32, uppercase only, exactly the
 * 26-character length the encoding implies, first character `0`-`7` so the
 * encoded timestamp cannot overflow. Exported standalone (not only wired
 * into `parseEvent`'s schema) so a caller — dispatch 4's recovery tooling,
 * or a test — can ask "is this specific string a valid event id" without
 * constructing a whole event.
 */
export function isValidEventId(value: string): value is EventId {
  return ULID_PATTERN.test(value);
}

// ============================================================================
// Ticket canonicalization — lowercase before use as a key
// ============================================================================

/**
 * Canonicalizes a ticket id for use as an event-log key — a bare
 * `.toLowerCase()`. ADR 0001:751-764: "A claim appended under `ck-1` and a
 * lookup for `CK-1` (or vice versa) would silently fail to match — the same
 * double-claim class as failure mode 9, via casing instead of a month
 * boundary. M2.7's `append`/`read` must canonicalize the `ticket` field
 * ... before using it as a key, on both write and read." Applied here to
 * every ticket-id-shaped field: the envelope's `ticket`, and `alias`'s
 * `from`/`to` (obligation 7 — a redirect gets the same rigor as a claim).
 *
 * **This mirrors `ticket/id.ts`'s `normalizeTicketIdForComparison` — same
 * operation, and that function's entire body is the same bare
 * `.toLowerCase()` (`ticket/id.ts:62-64`) — but is copied here, not
 * imported.** M2.2 (`ticket/`) is not in M2.7's `Depends on` list, and
 * PLAN.md rule 2 forbids importing from a module outside that list (Ruling
 * R2). Copying is verified safe specifically because there is no logic in
 * the mirrored function beyond that one call for the two copies to diverge
 * on.
 *
 * **What breaks if the two ever diverge:** if `ticket/id.ts`'s
 * canonicalization rule changes to something beyond a bare lowercase (a
 * different Unicode normalization, say) and this copy is not updated to
 * match, a ticket claimed under one canonical form via the ticket store and
 * referenced under another via the event log would silently fail to match
 * — reintroducing the exact double-claim class ADR 0001:751-764 exists to
 * prevent, this time via the two canonicalizers disagreeing rather than via
 * casing alone.
 */
export function canonicalizeTicketId(id: string): TicketId {
  return id.toLowerCase() as TicketId;
}

// ============================================================================
// Structural id-shape guard — fix round 1, finding M2 (security review)
// ============================================================================
//
// `ticket`, `alias.from`/`to`, `actor`, and `parent` (Ruling R14 moves the
// latter two here — no legitimate actor id contains a control character)
// previously had no structural check beyond "non-empty string." Confirmed
// accepted before this fix, as `ticket` and as an `alias.to`:
// `"../../../../home/victim/.gitconfig"`, `"/etc/passwd"`, `"[2Jck-1"`
// (raw ESC), `"   "` (whitespace-only). Those reach M2.8's board state and
// the CLI unguarded; a peer-pushed `alias.to` shaped like a traversal
// string or carrying a bidi override is exactly the redirect primitive ADR
// 0001:709-715 singles out for claim-level rigor (obligation 7).
//
// **Orchestrator Ruling R12, binding on how this is implemented.** Ruling
// R2 forbids *importing* from `ticket/` — it does not forbid the *check*.
// `ticket/filename.ts`'s `unsafeIdReason` already encodes this project's
// ticket-id structural policy (and is the sink M2.2/M2.5 already guard
// with it); the two functions below are **local, copied, strict subsets**
// of what it rejects, for the same "copied because of the dependency rule"
// reason as `canonicalizeTicketId` above.
//
// **Two functions, not one — a bug caught in this file's own review.** A
// first draft used a single guard for `ticket`/`alias` *and* `actor`/
// `parent`, including `unsafeIdReason`'s path-separator rule. That broke
// immediately against this schema's own fixture:
// `"claude-code:alice/wt-auth"` (CONCEPT.md's own worked example, and
// PLAN.md M2.18's `tool:name/context` actor grammar) legitimately contains
// `/` — actor ids are never used as filesystem path components the way
// ticket ids are, so the path-separator/dot rules that make sense for
// `ticket` are simply wrong for `actor`. Confirmed by running the test
// suite: every test using the envelope's default
// `actor: "claude-code:alice/wt-auth"` failed the moment the shared guard
// rejected `/`. Split into `unsafeTicketIdShapeReason` (full set, used by
// `ticket`/`alias.from`/`alias.to`, which do become path-adjacent keys) and
// `unsafeActorIdShapeReason` (control/bidi/NUL/whitespace/length only, used
// by `actor`/`parent`).
//
// **The invariant that keeps both copies safe: everything either function
// rejects, `unsafeIdReason` (`ticket/filename.ts`) also rejects.** Because
// these are copies, they can drift — and drift toward permissiveness is
// harmless (M2.2 still guards the filesystem sink on its own), while drift
// toward *strictness* is an outage: an id M2.2 would accept but this module
// rejects makes a legitimate event fail closed, and a fail-closed read
// takes the whole board down (not just one ticket). So each function
// rejects only what `unsafeIdReason` unambiguously also rejects.
//
// **One deliberate, disclosed narrowing versus `unsafeIdReason`, not an
// oversight:** `unsafeIdReason` rejects *any* embedded whitespace
// (`/\s/.test(id)`), not only whitespace-only strings. Both functions below
// reject only whitespace-only, which is strictly more permissive — an id
// like `"ck-1 .md"` (space, no control/bidi/path characters) is accepted
// here even though `ticket/filename.ts` would reject it. That keeps the
// subset invariant intact in the direction that matters (this module never
// rejects something the ticket store would accept) at the cost of not
// closing that one narrow, non-traversal, non-terminal-hostile shape here.
// Flagged in task-1-report.md rather than silently choosing either the
// stricter or the looser rule.
const BIDI_OR_ZERO_WIDTH_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
]);

/** Matches `ticket/filename.ts`'s `MAX_ID_BYTES` exactly — see the invariant comment above. */
const MAX_ID_SHAPE_BYTES = 100;

function isAsciiControlOrDel(code: number): boolean {
  return code <= 31 || code === 127;
}

/** The half of the guard shared by both id-shaped domains: NUL, control characters, bidi/zero-width, whitespace-only, and the byte-length cap. Never scans past the first hit. */
function controlBidiWhitespaceOrLengthReason(value: string): string | undefined {
  if (value.includes("\0")) return "contains a NUL byte";
  if (value.trim().length === 0) return "is whitespace-only";
  if (Buffer.byteLength(value, "utf8") > MAX_ID_SHAPE_BYTES) return `is longer than ${MAX_ID_SHAPE_BYTES} bytes`;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (isAsciiControlOrDel(code)) return "contains a control character";
    if (BIDI_OR_ZERO_WIDTH_CODE_POINTS.has(code)) return "contains a bidirectional-formatting or zero-width character";
  }
  return undefined;
}

/**
 * Full structural guard for `ticket`, `alias.from`, and `alias.to` — fields
 * this schema treats as filesystem-adjacent ticket ids (obligation 7). Adds
 * the path-separator and single/double-dot rules on top of the shared half
 * above, matching `unsafeIdReason`'s own rules for the same reasons: a
 * traversal-shaped ticket id reaching M2.8's board state or a future
 * filesystem-adjacent consumer is exactly what those rules exist to stop.
 * **Never includes `value` itself in the returned string** — the same
 * "report the rule, not the offending value" discipline
 * `ticket/filename.ts`'s `assertSafeId` documents and fix round 1's H1
 * finding required this module to actually follow.
 */
function unsafeTicketIdShapeReason(value: string): string | undefined {
  if (value.includes("/") || value.includes("\\")) return "contains a path separator";
  if (value === ".") return "is a single dot";
  if (value === "..") return "is a double dot";
  return controlBidiWhitespaceOrLengthReason(value);
}

/**
 * Narrower structural guard for `actor`/`parent` — these are never used as
 * filesystem path components the way `ticket` is, and `/` is a legitimate,
 * documented character in an actor id (`tool:name/context`, CONCEPT.md §5;
 * `claude-code:alice/wt-auth`, CONCEPT.md's own worked example). Only the
 * shared control/bidi/NUL/whitespace/length half applies — no
 * path-separator or dot rule.
 */
function unsafeActorIdShapeReason(value: string): string | undefined {
  return controlBidiWhitespaceOrLengthReason(value);
}

/** zod `.superRefine` step for `ticket`/`alias.from`/`alias.to`, with a fixed-category message (never the raw value — see H1). */
function refineTicketIdShape(value: string, ctx: z.RefinementCtx): void {
  const reason = unsafeTicketIdShapeReason(value);
  if (reason) {
    ctx.addIssue({ code: "custom", message: `id-shaped field ${reason}` });
  }
}

/** zod `.superRefine` step for `actor`/`parent`, with a fixed-category message (never the raw value — see H1). */
function refineActorIdShape(value: string, ctx: z.RefinementCtx): void {
  const reason = unsafeActorIdShapeReason(value);
  if (reason) {
    ctx.addIssue({ code: "custom", message: `id-shaped field ${reason}` });
  }
}

// ============================================================================
// `ts` — bounded as hygiene, never trusted, never an ordering or expiry input
// ============================================================================

/**
 * A fixed lower bound for `ts` (**Ruling R10**, orchestrator): no event this
 * project's schema will ever validate was written before this instant.
 * Deliberately **not** relative to `Date.now()`. ADR 0001:723-736 asks for a
 * "sane window" without specifying which kind; a `now - X` window would make
 * a valid, already-written log rot into a poisoned one purely by the passage
 * of time — every event older than the rolling window would start failing
 * the fail-closed read, taking a board down with no push from anyone. A
 * fixed epoch never does that: once an event is old enough to pass this
 * bound, it stays old enough forever.
 *
 * **No bound makes a peer-supplied clock trustworthy.** This bound (and the
 * `now + 24h` upper one, below) is schema hygiene — it keeps an absurd `ts`
 * out of anything that displays or sorts by it — not a security control. A
 * window wide enough to tolerate honest clock skew is wide enough for a
 * hostile writer to backdate or postdate a `ts` well inside it. `ts` is
 * therefore **never** an input to lease expiry (ADR 0001:730-736); expiry is
 * measured against a reader-local first-observation clock (failure mode 7),
 * a later dispatch's responsibility, not this file's.
 */
export const PROJECT_EPOCH = "2020-01-01T00:00:00Z";

const PROJECT_EPOCH_MS = Date.parse(PROJECT_EPOCH);

/** Upper `ts` bound: `now + 24h` (Ruling R10), tolerating honest clock skew. */
const TS_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Shape check for `ts` and `lease_until`: an ISO-8601 UTC instant in the
 * exact form `Date.prototype.toISOString()` produces (fractional seconds
 * optional, to tolerate a hand-built value with none). Every worked example
 * in CONCEPT.md's event log section (~line 477) is in this form.
 */
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * **Fix round 1, finding L4 / Ruling R13.** `Date.parse` does not return
 * `NaN` for a calendar-invalid-but-shape-valid instant — it silently rolls
 * the date forward. Confirmed directly, in this engine:
 *
 * ```
 * Date.parse("2026-02-30T00:00:00Z")            // → a valid number
 * new Date(Date.parse("2026-02-30T00:00:00Z"))   // → 2026-03-02T00:00:00.000Z
 * ```
 *
 * **This is not date hygiene, it is determinism across engines** (Ruling
 * R13): JSC (this runtime) rolls `2026-02-30` forward to March 2; V8
 * returns `NaN` for the same input. ADR 0001:811-826 requires that two
 * peers independently reconciling the same union of events compute the
 * same result — an engine-dependent parse of the same on-disk `ts` breaks
 * that property directly, and "Bun-only today" is a fact about current
 * deployment, not about the design this schema commits to. It also has a
 * second, concrete edge: with `2026-02-30` accepted, `ts.slice(0,7)` reads
 * `"2026-02"` while a `new Date(ts)`-derived month reads `"2026-03"` — a
 * cross-month write waiting for dispatch 2's monthly file layout.
 *
 * The fix is a round-trip: parse, then re-render, then compare the
 * date+time portion (`.slice(0, 19)`, ignoring fractional seconds and the
 * trailing `Z`) to the original. A calendar-invalid instant never survives
 * that round-trip unchanged.
 */
function isRealCalendarInstant(s: string): boolean {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
}

/**
 * Bounds-checks an already shape-valid, already-real-calendar-instant `ts`
 * against `[PROJECT_EPOCH, now + 24h]`. `now` is a parameter, not a call to
 * `Date.now()` inside this function — obligation 4 requires it injectable
 * so a caller (a later dispatch's UTC-month-rollover test, in particular)
 * can test the boundary without waiting for real time to cross it.
 *
 * By the time this runs, `event.ts` has already passed `tsSchema`'s own
 * `isRealCalendarInstant` refine, so `Date.parse` here is only doing bound
 * arithmetic on a value already confirmed to be a real instant — this
 * function does not re-check calendar validity itself (fix round 1
 * corrected an earlier version of this comment, on `leaseUntilSchema`, that
 * claimed this without it actually being true — see L4).
 */
function isTsWithinBounds(ts: string, nowMs: number): boolean {
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return false;
  return tsMs >= PROJECT_EPOCH_MS && tsMs <= nowMs + TS_FUTURE_SKEW_MS;
}

// ============================================================================
// The envelope — common to all twelve kinds
// ============================================================================

/**
 * `actor` is **not an authenticated identity** (ADR 0001:743-750). It is
 * whatever string the writer put in the event, bounded only by who has push
 * access to the coordination ref — nothing here binds it to a git identity,
 * a signed commit, or any other credential. `state/fold.ts` (M2.8) will be
 * tempted to surface `actor` as though it identifies who made a claim; it
 * does not, and M2.8's design must account for that rather than treating a
 * claim's `actor` field as trustworthy attribution.
 *
 * **Ruling R14 (fix round 1):** unlike the free-text fields below
 * (`comment.text`, `hook.output`, etc.), `actor` gets a structural
 * id-shape guard, not a "renderer must neutralize this" pass — no
 * legitimate actor id plausibly contains a control character or a bidi
 * override, and `actor` is displayed prominently enough (board views,
 * `cankan show`) that leaving it terminal-hostile is not a chance worth
 * taking. **This is `unsafeActorIdShapeReason`, not the ticket-id guard**:
 * a legitimate actor id routinely contains `/` (`claude-code:alice/wt-auth`,
 * CONCEPT.md's own worked example; `tool:name/context`, CONCEPT.md §5) —
 * unlike `ticket`, `actor` is never used as a filesystem path component, so
 * the path-separator/dot rules that apply to `ticket` would reject real
 * actor ids. `.max(200)` bounds the cheap zod-level check before the
 * byte-precise 100-byte cap in `unsafeActorIdShapeReason` runs (fix round
 * 1, finding M3).
 */
const actorSchema = z
  .string()
  .min(1)
  .max(200)
  .superRefine(refineActorIdShape)
  .transform((s) => s as ActorId);

/** Same non-identity caveat and structural guard as `actor` (Ruling R14) — CONCEPT.md §5: agents inherit a parent human. Optional: only carried when known. */
const parentSchema = z
  .string()
  .min(1)
  .max(200)
  .superRefine(refineActorIdShape)
  .transform((s) => s as ActorId)
  .optional();

const tsSchema = z
  .string()
  .regex(ISO_8601_UTC_PATTERN, "ts must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:mm:ss[.sss]Z)")
  .refine(isRealCalendarInstant, "ts must be a real calendar instant");

const eventIdSchema = z
  .string()
  .regex(ULID_PATTERN, "event id must be a 26-character uppercase Crockford base32 ULID")
  .transform((s) => s as EventId);

/**
 * `ticket` is canonicalized (lowercased) here, at the schema boundary, so
 * every downstream consumer receives an already-canonical key — obligation
 * 3. **Fix round 1, finding M2:** it also now carries the full structural
 * id-shape guard (`refineTicketIdShape` — see that block's doc comment for
 * the full invariant), applied before canonicalization so the checks
 * (path separator, control character, etc.) see the value exactly as
 * written. `TicketId` (`../types.ts`) itself still carries no runtime
 * validation — this check lives here, at the event-log boundary, because
 * this schema is the one thing standing between a hostile peer's `alias`
 * target and M2.8's board state (obligation 7). `.max(200)` is the cheap
 * zod-level pre-filter fix round 1's M3 finding asked for; the precise
 * 100-byte cap is inside `unsafeTicketIdShapeReason`.
 *
 * **Reused verbatim for `alias.from`/`alias.to`** (fix round 1 code
 * review minor) rather than re-derived, so the id-shape guard and
 * canonicalization can never drift apart between `ticket` and an
 * `alias`'s endpoints.
 */
const ticketSchema = z
  .string()
  .min(1)
  .max(200)
  .superRefine(refineTicketIdShape)
  .transform((s) => canonicalizeTicketId(s));

const envelopeShape = {
  ts: tsSchema,
  id: eventIdSchema,
  actor: actorSchema,
  parent: parentSchema,
  ticket: ticketSchema,
};

// ============================================================================
// Per-kind schemas
// ============================================================================
//
// Twelve kinds, decided by the orchestrator (Ruling R1), not open for this
// dispatch to renegotiate: create, claim, takeover, renew, release, expire,
// move, close, alias, hook, comment, external-write.
//
// Every object schema below is `.strict()` — obligation 8. An event
// carrying an unrecognized key is **rejected**, not silently stripped
// (zod's un-annotated default) and not silently accepted (`.passthrough()`).
// Justification (see task-1-report.md for the full argument): this log
// crosses a trust boundary — "whoever has push access," per the ADR, not a
// cooperative process — and the ADR's own stated trade for that boundary is
// fail-closed ("a board that refuses to answer is safer than one that
// grants a double-claim," ADR 0001:828-838). An unrecognized key is exactly
// the kind of thing a hostile or buggy peer would send to smuggle data past
// a validator that only checks the keys it expects, or to probe for a
// consumer downstream that is careless enough to read a key this schema
// never sanctioned. Forward compatibility for a genuinely new field is
// handled by shipping a new schema version, not by this version silently
// tolerating shapes it was never told about; there is only one schema
// version in this codebase today, so there is no compatibility cost yet to
// weigh against that.
//
// The discriminant (`event`) makes obligation 9 structural rather than a
// separate check: `z.discriminatedUnion` fails closed on any `event` value
// that does not match one of the twelve literals below (verified directly —
// see task-1-report.md's zod probe), consistent with the same fail-closed
// reasoning: a kind this version does not know is a kind whose shape this
// version cannot vouch for, and nothing downstream should be handed a value
// this schema could not validate.

const createEventSchema = z.object({ ...envelopeShape, event: z.literal("create") }).strict();

/**
 * `lease_until` is carried for display only (CONCEPT.md's worked example,
 * ~line 477) — it is **not** an input to lease-expiry logic. ADR 0001's
 * failure mode 7 places the expiry clock outside the log entirely (a
 * reader-local first-observation time, a later dispatch's responsibility);
 * trusting a peer-supplied `lease_until` for expiry would reopen exactly the
 * "far-future value defeats expiry" hole that clock design exists to close.
 * Shape-validated the same way as `ts` (an ISO-8601 UTC instant) but
 * deliberately **not** epoch/skew-bounded the way `ts` is: no source asks
 * for that bound, and a legitimately long-configured lease could otherwise
 * be rejected as "too far in the future" by a rule meant for `ts` alone.
 *
 * **Fix round 1, finding L4: this doc comment previously claimed "`ts`
 * never has this gap because `isTsWithinBounds` runs every `ts` through
 * `Date.parse` regardless" — that was false.** `Date.parse` alone does not
 * reject a calendar-invalid-but-shape-valid instant (`2026-13-45T00:00:00Z`
 * *and* `2026-02-30T00:00:00Z`, which silently rolls forward to March 2
 * rather than returning `NaN`); `isTsWithinBounds` never caught the
 * roll-forward case either. Both `ts` and `lease_until` now share the same
 * real fix: `isRealCalendarInstant` (see its own doc comment for the
 * round-trip check and why this is a determinism issue, not a hygiene one —
 * Ruling R13), applied to `ts` in `tsSchema` and to `lease_until` here.
 */
const leaseUntilSchema = z
  .string()
  .regex(ISO_8601_UTC_PATTERN, "lease_until must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:mm:ss[.sss]Z)")
  .refine(isRealCalendarInstant, "lease_until must be a real calendar instant");

const claimEventSchema = z
  .object({ ...envelopeShape, event: z.literal("claim"), lease_until: leaseUntilSchema })
  .strict();

/**
 * `--force` writes `takeover` instead of `claim` (PLAN.md:267, M2.10). A
 * takeover establishes a new lease exactly as a claim does — without
 * `lease_until` here, `state/fold.ts` (M2.8) would have no way to know when
 * the forced claim expires, silently defeating the feature `--force` exists
 * to provide.
 */
const takeoverEventSchema = z
  .object({ ...envelopeShape, event: z.literal("takeover"), lease_until: leaseUntilSchema })
  .strict();

const renewEventSchema = z
  .object({ ...envelopeShape, event: z.literal("renew"), lease_until: leaseUntilSchema })
  .strict();

const releaseEventSchema = z.object({ ...envelopeShape, event: z.literal("release") }).strict();

const expireEventSchema = z.object({ ...envelopeShape, event: z.literal("expire") }).strict();

// ============================================================================
// Length bounds on free-text fields — fix round 1, finding M3
// ============================================================================
//
// Confirmed before this fix: `comment.text` at 64MB parsed in 32ms and was
// accepted; `hook.output`, `close.reason`, `move.from`/`to` accepted the
// same. `.max()` here bounds **retention into board state** — it does not
// prevent the allocation, since `JSON.parse` has already materialized the
// full string before zod ever sees it. The actual DoS guard is a byte cap
// on the raw line *before* `parseEvent` is called, which is dispatch 2's
// obligation (`events/log.ts`'s `read()`), not rebuilt here. These bounds
// are retention/board-state hygiene: generous enough for any legitimate
// value, small enough that the append-only log can't be turned into
// unbounded storage through a single field.
const MAX_COLUMN_NAME_CHARS = 200; // move's from/to — a status/column name, same order as a ticket id
const MAX_CLOSE_REASON_CHARS = 1_000; // a one-line explanation, not a document — CONCEPT.md's `--reason "…"` is a CLI flag value
const MAX_HOOK_TITLE_CHARS = 500; // a ticket title, conventionally short
const MAX_HOOK_OUTPUT_CHARS = 100_000; // generous for captured hook stdout/stderr while still bounding retention into the append-only log
const MAX_COMMENT_TEXT_CHARS = 10_000; // generous for a human/agent-authored comment; anything longer belongs in the ticket body, not a log-level comment event

/**
 * `move`'s `from`/`to` are column/status names (CONCEPT.md's worked
 * example: `"from":"In Progress","to":"In Review"`) — plain, uncanonicalized
 * strings. **Deliberately not the same type as `alias`'s `from`/`to`**
 * (below), which are ticket ids: the brief calls this out explicitly, and
 * conflating the two would let a column name silently satisfy a ticket-id
 * shape check or vice versa.
 */
const moveEventSchema = z
  .object({
    ...envelopeShape,
    event: z.literal("move"),
    from: z.string().min(1).max(MAX_COLUMN_NAME_CHARS),
    to: z.string().min(1).max(MAX_COLUMN_NAME_CHARS),
  })
  .strict();

/**
 * `reason` sourced from CONCEPT.md's CLI reference: `cankan close <id>
 * [--reason "…"]` (~line 529). Optional because the flag itself is
 * optional.
 */
const closeEventSchema = z
  .object({ ...envelopeShape, event: z.literal("close"), reason: z.string().max(MAX_CLOSE_REASON_CHARS).optional() })
  .strict();

/**
 * `alias` gets the same rigor as `claim` (obligation 7, ADR 0001:709-715): a
 * pushed `alias` from a legitimate ticket id to an attacker-chosen one would
 * reroute `cankan show <id>` to the attacker's ticket. `from`/`to` are
 * therefore **the exact same `ticketSchema`** used for the envelope's
 * `ticket` (fix round 1 code review minor: reused, not re-derived, so the
 * id-shape guard and canonicalization can never drift apart) — not a
 * lighter-weight check for "just a redirect primitive." Source: CONCEPT.md's
 * worked example (`"from":"TASK-12", "to":"ck-7f3a9c"`) and ADR 0002
 * decision point 2 (`from: TASK-N, to: ck-<hash>`).
 *
 * **Fix round 1, finding L6:** `{from: "ck-1", to: "ck-1"}` (or
 * `{from: "CK-1", to: "ck-1"}`, a self-loop only *after* canonicalization)
 * previously parsed as a valid alias. A `superRefine` below rejects
 * `from === to` **after** both have gone through `ticketSchema`'s
 * canonicalizing transform — checking pre-canonicalization would miss the
 * `CK-1`/`ck-1` case. Multi-hop alias cycles (`a→b→c→a`) are a resolver
 * concern, not a single event's — flagged, not built here.
 */
const aliasEventSchema = z
  .object({
    ...envelopeShape,
    event: z.literal("alias"),
    from: ticketSchema,
    to: ticketSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.from === data.to) {
      ctx.addIssue({
        code: "custom",
        message: "alias.from and alias.to must not be the same ticket after canonicalization",
        path: ["to"],
      });
    }
  });

/**
 * `hook` fields are sourced directly from CONCEPT.md §8's named hook
 * environment (`$TICKET, $ACTOR, $FROM, $TO, $TITLE`, ~line 207) and
 * PLAN.md's M2.16 description ("capture output ... to the event log as hook
 * events"). `$TICKET`/`$ACTOR` are already the envelope's `ticket`/`actor` —
 * not duplicated here. `$FROM`/`$TO` are optional: CONCEPT.md's hookable
 * event list (`claim, release, expire, move, close, create`) includes kinds
 * that never set them (a `claim` hook has no "from column"), so they can
 * only be present when the triggering event supplied them (a `move` hook).
 * They are plain strings here, like `move`'s `from`/`to`, not ticket ids —
 * a hook never fires on `alias`. `title` is required: every hookable kind
 * fires on a real ticket, which always has a title. `output` is the
 * captured hook output PLAN.md names.
 *
 * **Deliberately not captured:** which of the six hookable kinds fired.
 * Neither source above names a field for it, and adding one would be the
 * exact kind of speculative field the brief warns against. Flagged in
 * task-1-report.md as a real gap for M2.16's dispatch to weigh — a hook
 * event's cause may be reconstructable from its position in the log next to
 * the event that fired it, but this schema does not build or assume that.
 */
const hookEventSchema = z
  .object({
    ...envelopeShape,
    event: z.literal("hook"),
    from: z.string().max(MAX_COLUMN_NAME_CHARS).optional(),
    to: z.string().max(MAX_COLUMN_NAME_CHARS).optional(),
    title: z.string().min(1).max(MAX_HOOK_TITLE_CHARS),
    output: z.string().max(MAX_HOOK_OUTPUT_CHARS),
  })
  .strict();

/** `text` sourced from CONCEPT.md's CLI reference: `cankan comment <id> <text>` (~line 532). */
const commentEventSchema = z
  .object({ ...envelopeShape, event: z.literal("comment"), text: z.string().min(1).max(MAX_COMMENT_TEXT_CHARS) })
  .strict();

/**
 * No kind-specific fields. ADR 0002 decision point 3 names `external-write`
 * only as an example of how a foreign (Backlog.md) write to a ticket file
 * might be recorded ("e.g. an `external-write` event, or a mismatch between
 * ... base_hash and the file's current content hash") — it does not specify
 * a payload beyond identifying which ticket was foreign-written, which the
 * envelope's `ticket` already carries. Left envelope-only rather than
 * guessing at a content-hash or diff field no source asks for.
 */
const externalWriteEventSchema = z.object({ ...envelopeShape, event: z.literal("external-write") }).strict();

// ============================================================================
// The union
// ============================================================================

const eventUnionSchema = z.discriminatedUnion("event", [
  createEventSchema,
  claimEventSchema,
  takeoverEventSchema,
  renewEventSchema,
  releaseEventSchema,
  expireEventSchema,
  moveEventSchema,
  closeEventSchema,
  aliasEventSchema,
  hookEventSchema,
  commentEventSchema,
  externalWriteEventSchema,
]);

/** The twelve event kinds, in the order they appear in the union above. */
export const EVENT_KINDS = [
  "create",
  "claim",
  "takeover",
  "renew",
  "release",
  "expire",
  "move",
  "close",
  "alias",
  "hook",
  "comment",
  "external-write",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type CreateEvent = z.infer<typeof createEventSchema>;
export type ClaimEvent = z.infer<typeof claimEventSchema>;
export type TakeoverEvent = z.infer<typeof takeoverEventSchema>;
export type RenewEvent = z.infer<typeof renewEventSchema>;
export type ReleaseEvent = z.infer<typeof releaseEventSchema>;
export type ExpireEvent = z.infer<typeof expireEventSchema>;
export type MoveEvent = z.infer<typeof moveEventSchema>;
export type CloseEvent = z.infer<typeof closeEventSchema>;
export type AliasEvent = z.infer<typeof aliasEventSchema>;
export type HookEvent = z.infer<typeof hookEventSchema>;
export type CommentEvent = z.infer<typeof commentEventSchema>;
export type ExternalWriteEvent = z.infer<typeof externalWriteEventSchema>;

/**
 * The event union. **Ordering authority is chain position, never `ts`**
 * (obligation 6) — nothing here, and nothing that should be built on top of
 * it, may sort by `ts`.
 */
export type Event = z.infer<typeof eventUnionSchema>;

// ============================================================================
// The validator
// ============================================================================

export interface ParseEventOptions {
  /**
   * The clock reading `ts`'s upper bound is measured against. Defaults to
   * `Date.now()`. Injectable per obligation 4, so a caller can test a UTC
   * month-rollover boundary (or any other `ts`-bound edge) without waiting
   * for real time to cross it.
   */
  readonly now?: number;
}

/** A single validation problem, projected from zod's own issue shape into a flat, serializable form (`errors.ts`'s "keep `details` flat" guidance applies equally to a value dispatch 4 will fold into an audit record). */
export interface EventValidationIssue {
  /** Dot-joined path into the event object; `""` for a whole-event problem (e.g. an unrecognized `event` kind). */
  readonly path: string;
  readonly message: string;
  /** zod's own issue code (e.g. `"invalid_type"`, `"unrecognized_keys"`) or one of this module's own (`"ts_out_of_bounds"`, `"invalid_json"`). */
  readonly code: string;
}

/**
 * A line that failed to become a valid `Event`. `reason` distinguishes "this
 * line was not even JSON" from "this JSON did not match the event schema" —
 * dispatch 4's recovery path and dispatch 2's `read()` both need to report
 * *why* a line failed, not just that it did (obligation 1).
 */
export interface EventValidationFailure {
  readonly reason: "invalid-json" | "schema-invalid";
  readonly message: string;
  readonly issues: readonly EventValidationIssue[];
}

export type ParseEventResult =
  | { readonly ok: true; readonly event: Event }
  | { readonly ok: false; readonly error: EventValidationFailure };

/**
 * Projects one zod issue into this module's own, safe-to-publish shape.
 *
 * **Fix round 1, finding H1 (security review).** The naive version of this
 * function (`issue.message` copied verbatim) republishes attacker-controlled
 * bytes: zod's `unrecognized_keys` issue embeds the raw offending key name
 * in its message, confirmed directly —
 *
 * ```
 * const evilKey = "\x1b[2K\x1b[1A\x1b[31mck-1 released by alice\x1b[0m";
 * A.safeParse({ x: "hi", [evilKey]: 1 }).error.issues[0].message
 * // → 'Unrecognized key: "␛[2K␛[1A␛[31mck-1 released by alice␛[0m"'
 * ```
 *
 * That string reaches a terminal (dispatch 2's `read()` must surface *why* a
 * line failed) and `--json` output (dispatch 4's quarantine audit record) —
 * exactly the "published by default" surfaces `../errors.ts:44-52` already
 * warns about, and exactly what `ticket/filename.ts`'s `assertSafeId`
 * already declines to do ("Report which rule failed, never the id itself").
 * A 200KB unrecognized key name also turns a few-line rejection into a
 * 200,000-character message — a size amplifier, not just a rendering one.
 *
 * Every other zod issue code used by this schema (`invalid_type`,
 * `invalid_union`, `too_small`, `too_big`, and this module's own
 * `.refine`/`.superRefine` messages) is author-written text, not a copy of
 * attacker input, so those pass through unchanged.
 */
function projectIssues(issues: z.ZodError["issues"]): EventValidationIssue[] {
  return issues.map((issue) => {
    if (issue.code === "unrecognized_keys") {
      const count = issue.keys.length;
      return {
        path: issue.path.map(String).join("."),
        message: `event carries ${count} unrecognized key${count === 1 ? "" : "s"}`,
        code: issue.code,
      };
    }
    return {
      path: issue.path.map(String).join("."),
      message: issue.message,
      code: issue.code,
    };
  });
}

/**
 * Validates one raw JSONL line against the event union — the sole
 * replacement for the spike's `JSON.parse(line) as ClaimEvent` cast
 * (obligation 1). Never throws: every failure mode (malformed JSON, wrong
 * field types, an unrecognized key, a non-ULID id, a `ts` outside its
 * bounds, an unrecognized `event` kind) comes back as a structured
 * `ParseEventResult`, never a thrown exception and never a silently-cast
 * value — so a caller (dispatch 2's `read()`, dispatch 4's recovery
 * tooling) can report *why* a specific line failed without having to
 * re-derive it.
 *
 * On success, the returned `event` has already had its ticket-id-shaped
 * fields canonicalized (lowercased) — obligation 3 — so nothing downstream
 * needs to canonicalize again before using `ticket` (or `alias`'s
 * `from`/`to`) as a key.
 */
export function parseEvent(line: string, options: ParseEventOptions = {}): ParseEventResult {
  const now = options.now ?? Date.now();

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // Fix round 1, finding H1: do NOT use the caught SyntaxError's own
    // `.message` — confirmed directly that JSC (Bun's engine) echoes the
    // offending token into it, truncated around 245 characters:
    // `JSON.parse("x".repeat(500) + " not json")` throws a message
    // containing ~200 raw "x" characters, and a hostile line can put
    // arbitrary bytes (including ANSI escapes) in that position instead.
    // This message reaches a terminal (dispatch 2's `read()`) and `--json`
    // output (dispatch 4's quarantine record) — the same "never publish an
    // untrusted value" rule `../errors.ts:44-52` and
    // `ticket/filename.ts`'s `assertSafeId` already follow. A fixed message
    // plus the line's own (already-known, not attacker-chosen) length is
    // reported instead; there is no portable byte-offset API across
    // `JSON.parse` implementations to report more precisely.
    return {
      ok: false,
      error: {
        reason: "invalid-json",
        message: `line is not valid JSON (${line.length} characters)`,
        issues: [{ path: "", message: "line is not valid JSON", code: "invalid_json" }],
      },
    };
  }

  const parsed = eventUnionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        reason: "schema-invalid",
        message: "event failed schema validation",
        issues: projectIssues(parsed.error.issues),
      },
    };
  }

  const event = parsed.data;
  if (!isTsWithinBounds(event.ts, now)) {
    // Interpolating `event.ts` here is safe, unlike H1's two fixed cases
    // above: by this point `event.ts` has already passed `tsSchema` — the
    // `ISO_8601_UTC_PATTERN` regex constrains every character to
    // `[0-9:.TZ-]`, and `isRealCalendarInstant` has confirmed it round-trips
    // to a real instant. There is no byte in that alphabet capable of an
    // ANSI escape, a control character, or a size-amplification payload, so
    // this is not a case of republishing an untrusted value the way the
    // `unrecognized_keys` message or a raw `JSON.parse` error message would.
    return {
      ok: false,
      error: {
        reason: "schema-invalid",
        message: `ts ${event.ts} is outside the allowed window [${PROJECT_EPOCH}, now+24h]`,
        issues: [{ path: "ts", message: "ts is outside the allowed window", code: "ts_out_of_bounds" }],
      },
    };
  }

  return { ok: true, event };
}
