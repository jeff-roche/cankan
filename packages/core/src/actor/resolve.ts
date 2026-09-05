/**
 * M2.18 "Actor identity" (PLAN.md `Creates: actor/resolve.ts`) -- the
 * precedence chain `--actor flag > CANKAN_ACTOR > local config > global
 * identity > git user.name`, the `tool:name/context` grammar (R-9), and
 * `parent` derivation (R-10).
 *
 * **R-1**: this module never calls `loadConfig` and never reads
 * `process.env` itself. `resolveActor` takes an already-loaded
 * `ConfigResult`; M2.3's schema keeps `actor`/`parent` out of the repo and
 * global files (`config/schema.ts`'s file-level comment), so
 * `cfg.value.actor` is exactly the union of the `CANKAN_ACTOR` and
 * `.cankan/local.yml` rungs -- re-deriving that layering here would be a
 * second, divergent copy of M2.3's precedence.
 *
 * **R-2**: the `git user.name` rung is an injected lazy thunk
 * (`gitUserName?: () => Promise<string | null>`). This file contains no
 * `Bun.spawn`, no `child_process`, and no import of `../git/anything` --
 * the phase's security-review derivation records that `actor/` performs no
 * command execution.
 *
 * **R-3 (reported, not fixed)**: M2.6's `GitAdapter` has no config-reading
 * operation, and M3.1's `Depends on` list omits M2.6 -- so as of this task,
 * nothing in the dependency graph can legally *implement* `gitUserName`.
 * That is a gap between PLAN.md's ownership matrix ("config -> git author ->
 * default") and what M2.6/M3.1 actually wire up. Fixing either half is an
 * edit to another task's module or to PLAN.md, forbidden in this lane; the
 * thunk shape here is what M3.1 (or a later PLAN amendment) must satisfy.
 *
 * **Deliberately NOT normalized or restricted (documented, not defects):**
 * case is preserved exactly (`"Alice"` and `"alice"` are two different
 * actors) -- folding case would itself be a spoofing vector (an attacker
 * picks the casing that collides with a target) and would silently
 * reattribute a user's own history the moment they fix their local git
 * casing. Script-mixing homoglyphs (Cyrillic `а` vs Latin `a`) are also
 * left alone -- `а` is a legitimately different character in a legitimately
 * different name, and UTS #39-style confusable restrictions are out of
 * proportion for a local, single-tenant CLI's attribution key.
 *
 * **`source: "global-identity"` names the rung, not the layer**: a
 * `CANKAN_IDENTITY__NAME` env override still reports `"global-identity"`
 * (never `"env"`), because the *rung* being consulted is "the global
 * identity value, however it was set" -- unlike the `actor` rung, which
 * has its own dedicated `"env"` source precisely because `CANKAN_ACTOR` is
 * a distinct rung in PLAN.md's chain. Worth remembering when this reads,
 * to a user, as "your global config file" in a future `config show`.
 */

import type { ConfigResult, ResolvedEntry } from "../config/index";
import { CanKanError } from "../errors";
import type { ActorId } from "../types";
import { ActorErrorCodes } from "./errors";

// ---------------------------------------------------------------------------
// Public surface (brief §4).
// ---------------------------------------------------------------------------

/** Which rung of the precedence chain produced the resolved actor. */
export type ActorSource = "flag" | "env" | "local-config" | "global-identity" | "git";

/** Which of `parent`'s three sources (R-10) produced the resolved parent. */
export type ParentSource = "config" | "global-identity" | "git";

/** An actor identity, decomposed per R-9's grammar. */
export interface Actor {
  /** The tool segment (`claude-code` in `claude-code:alice/wt-auth`), or
   *  `null` for a bare human actor. */
  readonly tool: string | null;
  readonly name: string;
  /** The context segment (`wt-auth` in `claude-code:alice/wt-auth`), or
   *  `null` when absent. R-9: a context can only be present alongside a
   *  tool. */
  readonly context: string | null;
}

export interface ResolvedActor {
  readonly actor: Actor;
  /** `formatActor(actor)` -- the canonical string form, branded once here
   *  (M2.18 is the boundary `../types.ts`'s `ActorId` comment names: "no
   *  runtime validation ... callers narrow with `as ActorId` at the
   *  boundary"). Nothing downstream should need to cast a string to
   *  `ActorId` again. */
  readonly id: ActorId;
  /** Which rung won -- the precedence table asserts on this, not merely on
   *  the resolved string. */
  readonly source: ActorSource;
  /** R-10: `null` for a bare human actor, or when a tool actor has no
   *  parent anywhere (not an error -- CONCEPT §5's "optional parent"). */
  readonly parent: ActorId | null;
  /** Which of `parent`'s three sources won, or `null` alongside
   *  `parent: null`. */
  readonly parentSource: ParentSource | null;
}

export interface ResolveActorOptions {
  readonly config: ConfigResult;
  /** The `--actor` flag's raw value. R-8: `""` is present-and-malformed,
   *  not absent -- callers must pass `undefined`, never omit the field, to
   *  mean "no flag given". */
  readonly flag?: string;
  /** R-2: lazy, so a caller that already has `--actor` never pays for a
   *  git spawn. */
  readonly gitUserName?: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// The grammar (R-9, as amended by R-11): `actor := [ tool ":" ] name [ "/" context ]`.
//
// **R-11 supersedes R-9's whitespace clause only** -- everything else in R-9
// stands (this shape, non-empty segments, no `:`/`/` inside a segment,
// context-without-tool rejected). R-9's original "no whitespace in any
// segment" made CONCEPT.md's own documented default -- `actor` "defaults to
// git user.name", and a conventional `user.name` is "Firstname Lastname" --
// unrepresentable; probing `tryParseActor` against `makeTempRepo()`'s real
// fixture (`"CanKan Test"`) proved it. R-11's fix:
//
//   1. The `name` segment may contain internal `U+0020` spaces,
//      unconditionally (with or without a tool) -- a state-dependent rule
//      ("only when there is no tool") would make `"claude-code:Jeff Roche"`
//      illegal while `"Jeff Roche"` alone is legal, with no principle a
//      user editing `local.yml` could predict.
//   2. `tool` and `context` may not contain whitespace at all -- they are
//      machine identifiers, and also appear in queue glob patterns
//      (`actors: ["codex:*"]`).
//   3. Leading/trailing whitespace stays malformed everywhere -- on the
//      whole value and on every individual segment (`"claude-code: alice"`
//      and `" alice"` both remain errors).
//   4. Every whitespace character other than plain `U+0020` (tab, newline,
//      CR, VT, FF, NBSP, and the other Unicode space separators), and every
//      Unicode control (`\p{Cc}`) or format (`\p{Cf}`) character, stays
//      rejected everywhere. The actor is the attribution key in an
//      append-only JSONL log (CONCEPT §3): a newline inside an actor is a
//      log-injection vector against M2.7's format, and a `\p{Cf}` bidi
//      override or zero-width joiner yields a visually identical but
//      distinct actor string -- attribution spoofing in a record that is
//      never rewritten.
//
// **R-15 (fix round 2 -- R-11's own point 4 didn't close the hole it
// claimed to)**: probed against the real parser, `\p{Cc}`/`\p{Cf}` alone
// let through several characters that are visually blank or invisible but
// not classified as control/format -- Hangul/halfwidth-Hangul fillers,
// variation selectors, the combining grapheme joiner, Khmer inherent
// vowels, and lone (unpaired) UTF-16 surrogates -- plus two spellings of
// the same visible text (`"aliíce"` composed vs. decomposed) minting two
// distinct `ActorId`s for what a human reads as one name. Both are the
// same underlying problem: an append-only log where nothing is ever
// rewritten must not let two different byte sequences render identically.
// The fix, probed and confirmed against every character above before
// being asserted in tests:
//
//   - The forbidden set is now `\p{Cc} | \p{Cf} | \p{Cs} |
//     \p{Default_Ignorable_Code_Point}`, plus `U+2800` BRAILLE PATTERN
//     BLANK explicitly (it renders blank but is not `Default_Ignorable`,
//     confirmed by testing the property escape against it directly).
//   - The raw value is NFC-normalized *before* parsing, not rejected when
//     it isn't already NFC -- Unicode defines canonically-equivalent
//     sequences as the same text, so normalizing collapses two spellings
//     of one identity rather than inventing one. Rejecting instead would
//     hand a user whose real `git user.name` happens to be stored in NFD
//     (ordinary on macOS; "José" is not exotic) an error they have no way
//     to read or act on. One consequence: `formatActor(parseActor(x))` may
//     differ from `x` byte-for-byte for NFD input -- round-trip stability
//     is guaranteed from the *first* parse onward
//     (`parse -> format -> parse -> format` is fixed), not against the
//     original raw bytes.
//
// This is not merely cosmetic: `tool`/`context` feed queue glob patterns
// (`queues.*.actors`, e.g. `["codex:*"]`), so an invisible character
// smuggled into `codex` would display as `codex` but silently never match
// its own queue; and `claims.max_per_actor` gives each look-alike its own
// budget against a policy whose entire point is capping *one* actor.
//
// R-8 ("empty is malformed, not absent") still falls out for free: `""`
// and `"   "` still fail the empty/leading-trailing-whitespace checks
// below, unchanged by any of this.
// ---------------------------------------------------------------------------

/** The whole actor value's length cap (R-18) -- an attribution key with no
 *  bound would let an arbitrarily large string (a full file, say) become a
 *  permanent key in the append-only event log. 256 is generous for every
 *  real example CONCEPT.md shows, with room to spare for a long
 *  `tool:name/context`. */
const MAX_ACTOR_LENGTH = 256;

/**
 * Every character R-15 forbids everywhere: Unicode control (`\p{Cc}`),
 * format (`\p{Cf}` -- bidi overrides, zero-width joiners), surrogate
 * (`\p{Cs}` -- a lone, unpaired UTF-16 half), or default-ignorable
 * (`\p{Default_Ignorable_Code_Point}` -- Hangul/halfwidth-Hangul fillers,
 * variation selectors, the combining grapheme joiner, Khmer inherent
 * vowels), plus `U+2800` BRAILLE PATTERN BLANK explicitly (visually blank,
 * but not itself Default_Ignorable). Property-escape regexes, not a
 * literal control-character range, so biome's `noControlCharactersInRegex`
 * does not flag this.
 */
function isProblematicChar(ch: string): boolean {
  return /\p{Cc}|\p{Cf}|\p{Cs}|\p{Default_Ignorable_Code_Point}/u.test(ch) || ch === "\u2800";
}

/** Any whitespace character (JS's `\s`, which already covers NBSP and the
 *  other Unicode space separators) other than a plain ASCII space -- R-11
 *  point 4's "every whitespace character other than U+0020". */
function isNonSpaceWhitespace(ch: string): boolean {
  return ch !== " " && /\s/.test(ch);
}

/** Whether `ch` is forbidden inside a segment. `allowInternalSpace` is
 *  `true` only for the `name` segment (R-11 point 1); `tool`/`context`
 *  reject a plain space exactly like every other whitespace character
 *  (R-11 point 2). */
function isForbiddenSegmentChar(ch: string, allowInternalSpace: boolean): boolean {
  if (ch === ":" || ch === "/") {
    return true;
  }
  if (isProblematicChar(ch)) {
    return true;
  }
  if (isNonSpaceWhitespace(ch)) {
    return true;
  }
  return ch === " " && !allowInternalSpace;
}

function hasLeadingOrTrailingWhitespace(value: string): boolean {
  return /^\s/.test(value) || /\s$/.test(value);
}

/**
 * A segment is valid if it is non-empty, has no leading/trailing
 * whitespace of its own (R-11 point 3 -- checked per segment, not only on
 * the whole raw value, so `"claude-code: alice"`'s leading space on `name`
 * is still caught even though the whole string's own edges are clean), and
 * contains no forbidden character. `allowInternalSpace` defaults to
 * `false` for `tool`/`context`; only the `name` segment passes `true`.
 */
function isValidSegment(segment: string, allowInternalSpace = false): boolean {
  if (segment.length === 0) {
    return false;
  }
  if (hasLeadingOrTrailingWhitespace(segment)) {
    return false;
  }
  for (const ch of segment) {
    if (isForbiddenSegmentChar(ch, allowInternalSpace)) {
      return false;
    }
  }
  return true;
}

interface ParseFailure {
  readonly reason: string;
}

interface ParseSuccess {
  readonly actor: Actor;
}

/** The reason reported for an invalid `tool` or `context` segment (R-11
 *  point 2: no whitespace allowed at all). */
const MACHINE_SEGMENT_REASON =
  'must be non-empty, must not have leading or trailing whitespace, and must contain no ' +
  'whitespace, control/format/surrogate/default-ignorable characters, ":", or "/"';

/**
 * The reason reported for an invalid `name` segment. R-18 (fix round 2):
 * this used to say "a single internal space", which was false -- `"a  b"`
 * and `"a b c"` both parse (R-11 places no cap on *how many* plain spaces
 * `name` carries, only on which other characters are forbidden), so the
 * old wording told a user something untrue about the rule that rejected
 * their input.
 */
const NAME_SEGMENT_REASON =
  'must be non-empty, must not have leading or trailing whitespace, and must contain no ":", ' +
  '"/", control/format/surrogate/default-ignorable characters, or whitespace other than plain ' +
  "space characters (U+0020)";

/**
 * The grammar walk, returning a reason string on failure rather than
 * throwing -- shared by the public, throwing `parseActor` and by
 * `resolveActor`'s per-rung wrapping (which needs to attach *which rung*
 * failed, R-5, not just the parse failure itself).
 *
 * Checked in this order (probed against the brief §5 malformed-input
 * table, not merely reasoned about): NFC normalization (R-15 -- happens
 * before any other check, so every check below sees canonical text),
 * whole-string emptiness, the length cap (R-18), whole-string
 * leading/trailing whitespace, at most one `:`, at most one `/` within
 * what follows it, each present segment's own validity, and finally "a
 * context without a tool is rejected" (R-9's second bullet) -- which fires
 * only when the name segment itself is otherwise valid. For an input like
 * `"/x"`, the empty *name* segment is reported before "context without
 * tool" would be; both readings agree the input is invalid, and this
 * function reports whichever check the walk reaches first rather than
 * every possible reason.
 */
function tryParseActor(rawInput: string): ParseSuccess | ParseFailure {
  // R-15: normalize before anything else, so two canonically-equivalent
  // spellings of the same text (composed vs. decomposed) parse to the
  // same `Actor` and format back to the same `ActorId` -- never rejected
  // for merely being NFD, since a real `git user.name` can legitimately
  // arrive that way (macOS normalizes filenames/some inputs to NFD).
  const raw = rawInput.normalize("NFC");

  if (raw.length === 0) {
    return { reason: "actor value must not be empty" };
  }
  if (raw.length > MAX_ACTOR_LENGTH) {
    return { reason: `actor value must be at most ${MAX_ACTOR_LENGTH} characters` };
  }
  if (hasLeadingOrTrailingWhitespace(raw)) {
    return { reason: "actor value must not have leading or trailing whitespace" };
  }

  let tool: string | null = null;
  let rest = raw;
  const colonIndex = rest.indexOf(":");
  if (colonIndex !== -1) {
    tool = rest.slice(0, colonIndex);
    rest = rest.slice(colonIndex + 1);
    if (rest.includes(":")) {
      return { reason: 'actor value must contain at most one ":"' };
    }
    if (!isValidSegment(tool)) {
      return { reason: `tool segment ${MACHINE_SEGMENT_REASON}` };
    }
  }

  let name = rest;
  let context: string | null = null;
  const slashIndex = rest.indexOf("/");
  if (slashIndex !== -1) {
    name = rest.slice(0, slashIndex);
    context = rest.slice(slashIndex + 1);
    if (context.includes("/")) {
      return { reason: 'actor value must contain at most one "/"' };
    }
    if (!isValidSegment(context)) {
      return { reason: `context segment ${MACHINE_SEGMENT_REASON}` };
    }
  }

  // R-11 point 1: `name` is the one segment that may contain an internal
  // space, whether or not a tool is present.
  if (!isValidSegment(name, true)) {
    return { reason: `name segment ${NAME_SEGMENT_REASON}` };
  }

  if (tool === null && context !== null) {
    return { reason: 'a context requires a tool ("name/context" with no tool is rejected)' };
  }

  return { actor: { tool, name, context } };
}

/**
 * Parses a raw actor string per R-9's grammar (as amended by R-11/R-15).
 * Throws `CanKanError` (`ACTOR_INVALID`) on any malformed input -- never
 * trims, never guesses; see `tryParseActor`'s comment for the exact check
 * order. The input is NFC-normalized before parsing (R-15), so the
 * returned `Actor`'s segments are always canonical text, not necessarily
 * byte-identical to `raw`.
 *
 * The message and `details.reason` deliberately never echo `raw` itself:
 * this function is also used internally on a value that may have come
 * from `CANKAN_ACTOR` or a config file, and `errors.ts`'s `details`
 * comment treats environment-sourced values as unsafe to publish. A
 * caller that wants to show the user their own input already has it.
 */
export function parseActor(raw: string): Actor {
  const outcome = tryParseActor(raw);
  if ("reason" in outcome) {
    throw new CanKanError(ActorErrorCodes.ACTOR_INVALID, `invalid actor value: ${outcome.reason}`, {
      details: { reason: outcome.reason },
    });
  }
  return outcome.actor;
}

/** Concatenates `actor`'s segments with no validation -- `formatActor`'s
 *  only caller, kept separate so `formatActor` can re-run the *parsed*
 *  result back through this same function after validating (see below)
 *  without recursing into validation a second time. */
function joinActorSegments(actor: Actor): string {
  const tool = actor.tool !== null ? `${actor.tool}:` : "";
  const context = actor.context !== null ? `/${actor.context}` : "";
  return `${tool}${actor.name}${context}`;
}

/**
 * The inverse of `parseActor` -- `tool:name/context`, `tool:name`, or
 * `name`, whichever segments `actor` carries. Branded `ActorId` on the way
 * out (see `ResolvedActor.id`'s comment): this is the one place that mints
 * one from a decomposed `Actor`.
 *
 * **R-16 (fix round 2)**: `Actor` is a plain, caller-constructible
 * interface -- nothing stops a downstream module from building one by hand
 * (`{ tool: null, name: 'alice"}\\n{"actor":"bob', context: null }`) and
 * handing it to this, the one function trusted to mint an `ActorId`
 * without a cast. Concatenation alone would brand a newline straight into
 * the boundary type the rest of the codebase relies on never needing
 * revalidation, and from there into M2.7's append-only JSONL log. This
 * function closes that by joining the segments and then running the
 * result back through the *real* grammar (`tryParseActor`, the same
 * function `parseActor` uses) rather than a second, parallel validator --
 * a naive `"a/b"` name (illegal on its own, but only reachable by hand
 * construction, since `parseActor` never produces one) round-trips into
 * `context: "b"` with no tool and is correctly rejected as "a context
 * requires a tool", exactly as if a human had typed `"a/b"` at the flag.
 * The value returned is built from the *reparsed* segments, not the
 * original candidate string, so a caller-constructed `Actor` whose text
 * was not already NFC-normalized still mints a canonical `ActorId`.
 */
export function formatActor(actor: Actor): ActorId {
  const candidate = joinActorSegments(actor);
  const outcome = tryParseActor(candidate);
  if ("reason" in outcome) {
    throw new CanKanError(ActorErrorCodes.ACTOR_INVALID, `invalid actor value: ${outcome.reason}`, {
      details: { reason: outcome.reason },
    });
  }
  return joinActorSegments(outcome.actor) as ActorId;
}

// ---------------------------------------------------------------------------
// `resolveActor` (R-1 .. R-10).
// ---------------------------------------------------------------------------

interface RungDetails {
  readonly file?: string;
  readonly envVar?: string;
}

/**
 * `tryParseActor`, wrapped so a malformed value names *which rung* it came
 * from (R-5) -- a typo in `.cankan/local.yml` must not read as the same
 * generic failure as a malformed `--actor` flag. `extra` carries the
 * config file path / env var name M2.3 already attributes the value to,
 * when the rung is config-backed; never the raw value itself (see
 * `parseActor`'s comment).
 */
function requireParsedActor(raw: string, rung: ActorSource, extra: RungDetails = {}): Actor {
  const outcome = tryParseActor(raw);
  if ("reason" in outcome) {
    throw new CanKanError(
      ActorErrorCodes.ACTOR_INVALID,
      `invalid actor value at the "${rung}" rung: ${outcome.reason}`,
      { details: { rung, reason: outcome.reason, ...extra } },
    );
  }
  return outcome.actor;
}

/**
 * R-10's "must itself be a bare name (no `:`, no `/`)" check for a
 * candidate `parent` value, from whichever of the three sources produced
 * it. Reuses the same grammar (a bare name is exactly an `Actor` with no
 * tool and no context) rather than a second, narrower validator.
 */
function requireBareName(raw: string, source: ParentSource, extra: RungDetails = {}): ActorId {
  const outcome = tryParseActor(raw);
  if ("reason" in outcome) {
    throw new CanKanError(
      ActorErrorCodes.ACTOR_INVALID,
      `invalid parent value from "${source}": ${outcome.reason}`,
      { details: { field: "parent", source, reason: outcome.reason, ...extra } },
    );
  }
  if (outcome.actor.tool !== null || outcome.actor.context !== null) {
    const reason = "parent must be a bare name (no tool, no context)";
    throw new CanKanError(
      ActorErrorCodes.ACTOR_INVALID,
      `invalid parent value from "${source}": ${reason}`,
      { details: { field: "parent", source, reason, ...extra } },
    );
  }
  return outcome.actor.name as ActorId;
}

/** `config.resolved(path)`'s `file`/`envVar`, lifted into `RungDetails` --
 *  `undefined` fields omitted rather than present-and-`undefined`, since
 *  `CanKanError`'s `details` is published as-is. */
function rungDetailsFrom(entry: { file?: string; envVar?: string } | undefined): RungDetails {
  return {
    ...(entry?.file !== undefined ? { file: entry.file } : {}),
    ...(entry?.envVar !== undefined ? { envVar: entry.envVar } : {}),
  };
}

/** The layers `cfg.value.actor` and `cfg.value.parent` can legally resolve
 *  from -- both are kept out of `repoConfigSchema`/`globalConfigSchema`
 *  (`config/schema.ts`'s file-level comment), so only `CANKAN_*` (`"env"`)
 *  or `.cankan/local.yml` (`"repo-local"`) can ever produce one. */
const LOCAL_ONLY_LAYERS = ["env", "repo-local"];

/** The layers `cfg.value.identity?.name` can legally resolve from --
 *  `identity` lives only in `globalConfigSchema`/`effectiveConfigSchema`,
 *  reachable either from the global file (`"global"`) or a
 *  `CANKAN_IDENTITY__NAME` override (`"env"`, per `config/resolve.ts`'s S5
 *  comment on `effectiveConfigSchema` including global-only sections). */
const IDENTITY_LAYERS = ["env", "global"];

/**
 * R-17 (fix round 2, defence in depth): the same "M2.3's own schema
 * guarantee broke" guard R-1 already applied to `cfg.value.actor`, mirrored
 * onto `cfg.value.parent` and `cfg.value.identity?.name` -- all three were
 * excluded from the repo/global (or repo/repo-local) schemas for the same
 * stated security reason (`config/schema.ts`'s file-level comment), so
 * guarding only one of the three was the inconsistency, not a difference
 * in risk. Nothing reaches this path today (M2.3 closes it), but a typed
 * error here costs nothing and catches a future schema regression instead
 * of silently misattributing.
 */
function requireExpectedLayer(
  entry: ResolvedEntry | undefined,
  allowedLayers: readonly string[],
  field: string,
): asserts entry is ResolvedEntry {
  if (entry === undefined || !allowedLayers.includes(entry.layer)) {
    throw new CanKanError(
      ActorErrorCodes.ACTOR_UNRESOLVED,
      `${field} is set but resolved from an unexpected config layer ("${String(entry?.layer)}")`,
      { details: { field, layer: String(entry?.layer) } },
    );
  }
}

/**
 * R-18 (fix round 2): a thunk that returns `undefined` instead of `null`
 * (a caller bug, since the declared return type is `Promise<string |
 * null>`) must not crash `tryParseActor` with a raw `TypeError` from
 * `undefined.length` -- coerced to `null`, the same as "no git identity",
 * here at the one call site both rungs share.
 */
async function callGitUserName(
  gitUserName: (() => Promise<string | null>) | undefined,
): Promise<string | null> {
  if (!gitUserName) {
    return null;
  }
  const raw = await gitUserName();
  return raw ?? null;
}

/**
 * The precedence chain `--actor flag > CANKAN_ACTOR > local config > global
 * identity > git user.name` (PLAN.md M2.18), plus R-10's `parent`
 * derivation. See the file-level comment for R-1/R-2/R-3.
 */
export async function resolveActor(options: ResolveActorOptions): Promise<ResolvedActor> {
  const { config, flag, gitUserName } = options;

  // R-18 (fix round 2): memoized *within this one call* -- not a
  // persistent cache (the brief forbids one) -- so a tool-shaped git
  // `user.name` (e.g. `"team:alice"`) that wins both the actor rung and
  // the parent rung spawns git once, not twice. Still lazy: unset until
  // the first rung that actually needs it calls `getGitUserName()`.
  let gitUserNamePromise: Promise<string | null> | undefined;
  function getGitUserName(): Promise<string | null> {
    gitUserNamePromise ??= callGitUserName(gitUserName);
    return gitUserNamePromise;
  }

  let actor: Actor;
  let source: ActorSource;

  if (flag !== undefined) {
    // R-8: an empty (or whitespace-only) flag is present, not absent --
    // `requireParsedActor` rejects it as malformed, it never falls through.
    source = "flag";
    actor = requireParsedActor(flag, source);
  } else if (config.value.actor !== undefined) {
    const entry = config.resolved(["actor"]);
    requireExpectedLayer(entry, LOCAL_ONLY_LAYERS, "actor");
    source = entry.layer === "env" ? "env" : "local-config";
    actor = requireParsedActor(config.value.actor, source, rungDetailsFrom(entry));
  } else if (config.value.identity?.name !== undefined) {
    const entry = config.resolved(["identity", "name"]);
    requireExpectedLayer(entry, IDENTITY_LAYERS, "identity.name");
    source = "global-identity";
    actor = requireParsedActor(config.value.identity.name, source, rungDetailsFrom(entry));
  } else {
    const raw = await getGitUserName();
    if (raw === null) {
      // R-4: no default, ever -- a typed error naming every rung checked.
      throw new CanKanError(
        ActorErrorCodes.ACTOR_UNRESOLVED,
        "no actor identity resolved: no --actor flag, no CANKAN_ACTOR, no actor in " +
          ".cankan/local.yml, no identity.name in global config, and no git user.name",
      );
    }
    source = "git";
    actor = requireParsedActor(raw, source);
  }

  let parent: ActorId | null = null;
  let parentSource: ParentSource | null = null;

  // R-10: only a tool actor gets a parent; a bare human's parent is always
  // `null`, and this block is skipped entirely for one -- so a bare-human
  // actor resolved from the git rung never calls `gitUserName()` a second
  // time here (and even when it would, `getGitUserName()` is memoized).
  if (actor.tool !== null) {
    if (config.value.parent !== undefined) {
      const entry = config.resolved(["parent"]);
      requireExpectedLayer(entry, LOCAL_ONLY_LAYERS, "parent");
      parentSource = "config";
      parent = requireBareName(config.value.parent, parentSource, rungDetailsFrom(entry));
    } else if (config.value.identity?.name !== undefined) {
      const entry = config.resolved(["identity", "name"]);
      requireExpectedLayer(entry, IDENTITY_LAYERS, "identity.name");
      parentSource = "global-identity";
      parent = requireBareName(config.value.identity.name, parentSource, rungDetailsFrom(entry));
    } else {
      const raw = await getGitUserName();
      if (raw !== null) {
        parentSource = "git";
        parent = requireBareName(raw, parentSource);
      }
      // else: no parent anywhere -- not an error (R-10), `parent` stays `null`.
    }
  }

  return {
    actor,
    id: formatActor(actor),
    source,
    parent,
    parentSource,
  };
}
