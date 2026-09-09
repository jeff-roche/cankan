import matter from "gray-matter";
import {
  type ParsedNode,
  type Scalar,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
} from "yaml";
import type { Document } from "yaml";
import { CanKanError, ErrorCodes } from "../errors";
import { TicketErrorCodes } from "./errors";
import {
  type CankanBlock,
  type TicketFrontmatter,
  ticketFrontmatterSchema,
} from "./schema";

/**
 * Parsing and serializing ticket frontmatter — the bar is **byte-identical
 * round-tripping**, including files written by real Backlog.md, not schema
 * validity.
 *
 * ## The preservation design
 *
 * `matter.stringify(parsedObject)` is not used anywhere in this file. It
 * reserializes from a plain object, which loses key order, quoting style,
 * indentation, list style, and every key the schema does not name — the
 * phase brief says outright it will fail the fixtures, and an experiment
 * confirmed why the obvious alternative (`yaml`'s `Document.toString()`)
 * fails too: fed a document mixing `aliases: [TASK-12]` (no inner padding)
 * with `{ type: blocks, id: ck-2b1e44 }` (padded) — CONCEPT.md's own ticket
 * example — `parseDocument(x).toString()` re-emitted the first as
 * `[ TASK-12 ]`. A single document-wide flow-style option cannot reproduce
 * two different flow-collection paddings in the same document, so `yaml`'s
 * **emit** path is unusable as a general-purpose serializer here.
 *
 * The design instead keeps the raw text and edits it surgically:
 *
 * - **No-change path.** `serializeTicketFile(parseTicketFile(raw))` returns
 *   the original `raw` string, untouched — no YAML re-emission at all. A
 *   ticket nobody edited must not be rewritten.
 * - **Mutation path.** `setScalarField` and `setCankanBlock` locate the
 *   target top-level key's byte range in the raw frontmatter text (via
 *   `yaml`'s `parseDocument`, which retains source offsets on every node
 *   even though its *emitter* is not trustworthy) and splice only that
 *   range. Everything else — unknown keys, key order, quoting, indentation,
 *   list style, and the body — is never touched, let alone re-emitted.
 *
 * `yaml` is therefore used as a **parser and range locator**, never as an
 * emitter for anything but a single freshly-set scalar or block.
 *
 * ## The `gray-matter` security gate
 *
 * `gray-matter`'s `javascript` engine is a raw `eval()` with `require` in
 * scope; a ticket beginning `---js` (or `---javascript`) runs arbitrary code
 * as the user the moment `matter()` is called — confirmed by execution, not
 * by reading the option object. `matter()` resolves both tags to its single
 * `engines.javascript` slot (`js`/`javascript` are aliases of each other;
 * gray-matter ships no built-in engine for `coffee`/`coffeescript`/`cson`,
 * so those already throw "not registered" with no mitigation needed), so
 * `{ engines: { javascript: undefined } }` disables both at once — verified
 * by attempting execution of both tags with and without the option, and by
 * attempting the two plausible-looking non-fixes the phase brief warns
 * about (`{ language: "yaml" }`, and a *partial* `engines` map naming an
 * unrelated language): both leave the payload executing. `callMatter` below
 * is the single call site; every parse goes through it.
 *
 * ## A YAML syntax error's error code depends on which parser caught it
 *
 * A plain YAML syntax error inside frontmatter (e.g. an unterminated flow
 * sequence) is usually caught by gray-matter's own `js-yaml` engine
 * *inside* `callMatter`, before `yaml.parseDocument` in
 * `parseFrontmatterData` ever runs — so it surfaces as
 * `TicketErrorCodes.FRONTMATTER_REJECTED` (the security-gate code), not
 * `FRONTMATTER_MALFORMED` (whose own doc comment says "invalid YAML").
 * `FRONTMATTER_MALFORMED` is reachable too, but only for YAML that
 * gray-matter's more lenient `js-yaml` tolerates (or silently mis-parses —
 * see the tab-indentation test) while `yaml`'s stricter parser rejects.
 * Both paths avoid echoing source text into `message`/`details` either way
 * (Ruling 4), but a downstream consumer that branches on the exact code
 * (M3.10's exit-code mapping) should not assume "malformed YAML" always
 * means `FRONTMATTER_MALFORMED`.
 */

type GrayMatterEngines = NonNullable<
  NonNullable<Parameters<typeof matter>[1]>["engines"]
>;

// `undefined` is what actually disables the built-in engine — gray-matter's
// `defaults.js` does `Object.assign({}, builtins, opts.engines)`, so an own
// property named `javascript` with value `undefined` overwrites the
// built-in entry with `undefined`, and the engine lookup then throws
// "not registered" instead of eval-ing anything (confirmed by execution).
// gray-matter's own `.d.ts` does not model an `undefined` engine value, so
// this cast is narrowly scoped to match that actual runtime behavior, not
// to bypass the type system generally.
const MITIGATED_ENGINES = {
  javascript: undefined,
} as unknown as GrayMatterEngines;

/**
 * The one place `gray-matter`'s `matter()` is invoked, so the `javascript`
 * engine mitigation cannot be forgotten at a second call site. Its return
 * value is used for nothing but confirming that the frontmatter's language
 * tag is safe to have parsed — `data`/`content`/`matter` are all discarded;
 * `splitTicketFile` and `yaml.parseDocument` own the actual bytes and the
 * actual parsed data respectively (see the file comment on why: gray-matter
 * strips a newline after the closing delimiter, and its default YAML engine
 * is `js-yaml`, which resolves YAML-1.1 timestamps like `due_date:
 * 2026-09-12` into `Date` objects — `yaml`, used everywhere else in this
 * file, does not).
 *
 * `matter()` throws for two reasons: the language engine is rejected (the
 * intended effect of the mitigation), or the frontmatter's YAML is
 * malformed enough for `js-yaml` to throw while parsing it for `data` (it
 * does not throw for a missing/unterminated delimiter — that is silently
 * tolerated and caught by `splitTicketFile` instead). Both are wrapped here
 * so no raw third-party error/message (which, for the YAML case, quotes the
 * offending source line) ever escapes this module.
 */
function callMatter(raw: string, path: string | undefined): void {
  try {
    matter(raw, { engines: MITIGATED_ENGINES });
  } catch (cause) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_REJECTED,
      path
        ? `Ticket frontmatter at ${path} was rejected`
        : "Ticket frontmatter was rejected",
      { cause },
    );
  }
}

/** The three raw pieces of a ticket file, byte-exact, plus the delimiters that join them back into `raw`. Treat as opaque — recombine only via `serializeTicketFile`. */
interface TicketFileSplit {
  /** The opening delimiter line, e.g. `"---\n"`. */
  opening: string;
  /** The frontmatter's exact source text, including its own trailing newline. Never gray-matter's `content`/`matter` fields — see the file comment. */
  frontmatterText: string;
  /** The closing delimiter line, e.g. `"---\n"` (or `"---"` with no trailing newline, if the file ends there). */
  closeText: string;
  /** Everything after the closing delimiter, byte-exact — including whatever leading blank lines and trailing newline the file already has. */
  body: string;
}

const OPENING_DELIMITER_RE = /^---\r?\n/;
const CLOSING_DELIMITER_RE = /\r?\n---(?:\r?\n|$)/;

/**
 * Splits `raw` into its four byte-exact pieces. `opening + frontmatterText +
 * closeText + body === raw`, always — this is the invariant every
 * round-trip and mutation test checks against.
 *
 * This is a structural check, deliberately separate from (and run after)
 * `callMatter`: gray-matter itself does not throw on a missing or
 * unterminated delimiter (confirmed by execution — a missing closing `---`
 * silently swallows the rest of the file as frontmatter with no error), so
 * this function is the actual structural validator.
 */
function splitTicketFile(
  raw: string,
  path: string | undefined,
): TicketFileSplit {
  const openMatch = OPENING_DELIMITER_RE.exec(raw);
  if (!openMatch) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_MALFORMED,
      path
        ? `Ticket file at ${path} has no opening frontmatter delimiter`
        : "Ticket file has no opening frontmatter delimiter",
    );
  }
  const opening = openMatch[0];
  const rest = raw.slice(opening.length);
  const closeMatch = CLOSING_DELIMITER_RE.exec(rest);
  if (!closeMatch) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_MALFORMED,
      path
        ? `Ticket file at ${path} has no closing frontmatter delimiter`
        : "Ticket file has no closing frontmatter delimiter",
    );
  }
  // The newline immediately before "---" terminates the frontmatter's last
  // line, so it belongs in `frontmatterText`, not `closeText` — every line
  // in `frontmatterText` then carries its own trailing newline, including
  // the last, which keeps `yaml`'s node ranges (below) simple to splice.
  const leadingNewline = /^\r?\n/.exec(closeMatch[0]);
  const newline = leadingNewline ? leadingNewline[0] : "";
  const frontmatterText = rest.slice(0, closeMatch.index) + newline;
  const closeText = closeMatch[0].slice(newline.length);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);
  return { opening, frontmatterText, closeText, body };
}

/**
 * A parsed ticket: the zod-validated frontmatter view (for callers that
 * want typed access) alongside the byte-exact source pieces that let
 * `serializeTicketFile` reproduce `raw` exactly, or `setScalarField` /
 * `setCankanBlock` change one part of it without disturbing the rest.
 * `source` is intentionally opaque — read `frontmatter` for data, and go
 * through the exported functions for everything else.
 */
export interface ParsedTicket {
  readonly frontmatter: TicketFrontmatter;
  readonly source: {
    readonly raw: string;
    readonly path?: string;
  };
}

/** `ParsedTicket` plus the split pieces mutation functions need. Not exported — callers only ever see `ParsedTicket`. */
interface InternalParsedTicket extends ParsedTicket {
  readonly split: TicketFileSplit;
}

function formatYamlErrorMessage(
  path: string | undefined,
  linePos: { line: number; col: number } | undefined,
): string {
  const location = [
    path,
    linePos ? `line ${linePos.line}, column ${linePos.col}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  return location
    ? `Ticket frontmatter YAML is invalid (${location})`
    : "Ticket frontmatter YAML is invalid";
}

/**
 * True if `doc` contains a YAML **alias** reference (`*a`) anywhere.
 * Deliberately does not match a bare anchor definition (`&a`) with no
 * corresponding alias — an anchor nobody references expands to nothing, so
 * it carries none of the hazards below and rejecting it would be a
 * behaviour change with no matching risk. Backlog.md never emits an alias,
 * and this module rejects one outright rather than ever calling
 * `doc.toJS()` on it — see `parseFrontmatterData`'s comment for why.
 */
function containsAlias(doc: Document): boolean {
  let found = false;
  visit(doc, {
    Alias() {
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

// 64 KB — real Backlog.md frontmatter is ~1-2 KB, so this is ~30x headroom.
// This is the cap that matters: measured, `yaml@2.9.0`'s `parseDocument` on
// the frontmatter segment is at-least-quadratic in key count (94 KB / 8 000
// keys: 249 ms; 202 KB / 16 000: 785 ms; 426 KB / 32 000: 3 004 ms; 874 KB /
// 64 000: 47 644 ms) while `matter()`, `toJS()` and zod all stayed flat at
// every size tested — the quadratic cost is `parseDocument` on this segment
// specifically, so this is where the bound belongs. 64 KB keeps the worst
// case at roughly 150 ms by that table. Deliberately not a bound on `raw`
// as a whole (see `MAX_RAW_LENGTH`): a ticket's body is prose a human may
// legitimately have written at length, and this phase must round-trip it
// byte-identically, not reject it.
const MAX_FRONTMATTER_LENGTH = 64 * 1024;

function parseFrontmatterData(
  frontmatterText: string,
  path: string | undefined,
) {
  if (frontmatterText.length > MAX_FRONTMATTER_LENGTH) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_TOO_LARGE,
      path
        ? `Ticket frontmatter at ${path} exceeds ${MAX_FRONTMATTER_LENGTH} characters`
        : `Ticket frontmatter exceeds ${MAX_FRONTMATTER_LENGTH} characters`,
    );
  }
  const doc = parseDocument(frontmatterText);
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    // `YAMLParseError.message` quotes the offending source line verbatim
    // (ticket files can carry secrets) — report path + line/col only, and
    // pass the original error as `cause`, never into `message`/`details`.
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_MALFORMED,
      formatYamlErrorMessage(path, error.linePos?.[0]),
      { cause: error },
    );
  }

  // Aliases are rejected outright, before `toJS()` ever runs. Two
  // independent reasons, both confirmed by execution against yaml@2.9.0:
  // (1) `yaml` enforces its alias-expansion resource-exhaustion limit at
  // `toJS()` time, not `parseDocument()` time — `doc.errors` is empty for a
  // 175-byte file with a handful of nested anchor/alias pairs, and
  // `toJS()` throws a raw `ReferenceError` ("Excessive alias count
  // indicates a resource exhaustion attack") that is not a
  // `YAMLParseError` and is not caught by the check above. (2) A cyclic
  // alias (`x: &a [*a]`) does not throw at all — `toJS()` returns a
  // self-referential object that `JSON.stringify` cannot encode, breaking
  // every `--json` consumer that touches it later, far from where the
  // ticket was parsed. Backlog.md never emits an alias, so rejecting one
  // here costs nothing real. (A bare anchor with no alias is left alone —
  // see `containsAlias`'s comment.)
  if (containsAlias(doc)) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_MALFORMED,
      path
        ? `Ticket frontmatter at ${path} uses a YAML alias, which is not supported`
        : "Ticket frontmatter uses a YAML alias, which is not supported",
    );
  }

  // `toJS()` is a third-party throw site independent of the `doc.errors`
  // check above (see the alias comment) — wrapped defensively so a
  // future `yaml` release's new failure mode still surfaces as a
  // `CanKanError`, not a raw exception with `isCanKanError() === false`.
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (cause) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_MALFORMED,
      path
        ? `Ticket frontmatter at ${path} could not be converted from YAML`
        : "Ticket frontmatter could not be converted from YAML",
      { cause },
    );
  }
  return { doc, data };
}

function validateFrontmatter(
  data: unknown,
  path: string | undefined,
): TicketFrontmatter {
  const result = ticketFrontmatterSchema.safeParse(data);
  if (!result.success) {
    // zod never echoes input values in its issue messages, so these are
    // safe to surface (unlike the YAML/gray-matter errors above).
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_INVALID,
      path
        ? `Ticket frontmatter at ${path} failed validation`
        : "Ticket frontmatter failed validation",
      { cause: result.error, details: { issues } },
    );
  }
  return result.data;
}

// Several MB — generous, and deliberately not the cap that matters (see
// `MAX_FRONTMATTER_LENGTH`). Only stops a truly pathological file; a
// ticket's body is prose a human may legitimately have written at length,
// and this phase must round-trip it byte-identically, not refuse it.
const MAX_RAW_LENGTH = 8 * 1024 * 1024;

/**
 * Parses a ticket file's full raw text (frontmatter + body) into a
 * `ParsedTicket`. `path` is optional and used only to make error messages
 * locatable — never echoed with file content.
 *
 * Every call goes through the `gray-matter` security gate (`callMatter`)
 * first, structural delimiter splitting second, and `yaml` parsing third —
 * in that order, so a hostile `---js` payload is always evaluated against
 * the mitigation before anything else runs. Two further, independent
 * rejections happen inside that pipeline: an oversized file or frontmatter
 * segment (`TicketErrorCodes.FRONTMATTER_TOO_LARGE` — `yaml`'s parser is
 * at-least-quadratic in frontmatter key count), and any YAML **alias**
 * reference in the frontmatter, i.e. `*name` (`FRONTMATTER_MALFORMED` — a
 * policy constraint, not a parsing error: Backlog.md never emits one, so no
 * real file is affected, but an alias can otherwise trigger `yaml`'s own
 * resource-exhaustion guard or yield a cyclic, unserializable value). A
 * bare anchor definition (`&name`) with nothing referencing it is left
 * alone — it expands to nothing, so it carries none of those hazards.
 */
export function parseTicketFile(raw: string, path?: string): ParsedTicket {
  if (raw.length > MAX_RAW_LENGTH) {
    throw new CanKanError(
      TicketErrorCodes.FRONTMATTER_TOO_LARGE,
      path
        ? `Ticket file at ${path} exceeds ${MAX_RAW_LENGTH} characters`
        : `Ticket file exceeds ${MAX_RAW_LENGTH} characters`,
    );
  }
  callMatter(raw, path);
  const split = splitTicketFile(raw, path);
  const { data } = parseFrontmatterData(split.frontmatterText, path);
  const frontmatter = validateFrontmatter(data, path);
  const parsed: InternalParsedTicket = {
    frontmatter,
    source: { raw, path },
    split,
  };
  return parsed;
}

function isInternal(ticket: ParsedTicket): ticket is InternalParsedTicket {
  return Object.hasOwn(ticket, "split");
}

function requireSplit(ticket: ParsedTicket): TicketFileSplit {
  if (!isInternal(ticket)) {
    // Cannot happen for a `ParsedTicket` obtained from `parseTicketFile` —
    // guards against a hand-built object smuggled past the type system. A
    // caller error, not malformed frontmatter, so it raises the shared
    // `USAGE` code rather than a `ticket/`-local one.
    throw new CanKanError(
      ErrorCodes.USAGE,
      "Not a ticket parsed by parseTicketFile",
    );
  }
  return ticket.split;
}

/**
 * Serializes a `ParsedTicket` back to text. For a ticket obtained straight
 * from `parseTicketFile` with no `setScalarField`/`setCankanBlock` call in
 * between, this returns the exact original string — no YAML re-emission
 * happens at all, by construction. This is not a shortcut: a ticket nobody
 * edited must not be rewritten.
 */
export function serializeTicketFile(ticket: ParsedTicket): string {
  return ticket.source.raw;
}

function findTopLevelPair(frontmatterText: string) {
  const doc = parseDocument(frontmatterText);
  const map = doc.contents;
  if (!isMap(map)) {
    return { doc, map: undefined };
  }
  return { doc, map };
}

function scalarText(value: string | number | boolean): string {
  // `lineWidth: 0` disables line folding — a long plain scalar (e.g. a
  // title) must stay on one line, not be wrapped across several.
  return stringify(value, { lineWidth: 0 }).replace(/\r?\n$/, "");
}

// A bare YAML plain key may not contain a newline or a colon-space
// sequence — either would let a caller-supplied `key` inject a second
// frontmatter line via the "append new key" branch below. `key` is not
// attacker-controlled today (only this module's own callers choose it),
// but the security lens is on for this task and the guard is one check.
const UNSAFE_KEY_RE = /[\n\r]|: /;

/**
 * Sets one top-level scalar frontmatter field (e.g. `status`) via a
 * targeted splice of the field's value range in the raw frontmatter text.
 * Nothing else in the file changes: unknown keys, key order, quoting,
 * indentation, list style, the rest of the frontmatter, and the entire body
 * are untouched, byte for byte. If `key` is not already present, a new
 * `key: value` line is appended just before the closing delimiter, using
 * whatever newline convention the file's own opening delimiter uses (so a
 * CRLF-authored file does not get an LF line mixed into it).
 *
 * Deliberately scoped to a single scalar — this is not a general YAML
 * editor. Throws (the shared `USAGE` code) if the existing field is not a
 * scalar (e.g. `assignee: [alice]` is a sequence) — this would otherwise
 * fail only later, indirectly, when the reparse's schema validation
 * rejects the resulting shape.
 *
 * A ticket id passed as `value` must already carry whatever casing belongs
 * on disk (`ticket/id.ts`'s `keepOnDiskIdCasing`); never pass
 * `normalizeTicketIdForComparison`'s output here.
 */
export function setScalarField(
  ticket: ParsedTicket,
  key: string,
  value: string | number | boolean,
): ParsedTicket {
  if (UNSAFE_KEY_RE.test(key)) {
    // Never republish `key` itself: a field name is caller-supplied today,
    // but the brief has MCP supplying field names later, and this is
    // exactly the "report which rule failed, not the value" pattern
    // `filename.ts`'s `assertSafeId` already follows for the same reason.
    throw new CanKanError(
      ErrorCodes.USAGE,
      "Field name is not a valid single-line YAML key",
      {
        details: { reason: "not a valid single-line YAML key" },
      },
    );
  }

  const split = requireSplit(ticket);
  const { map } = findTopLevelPair(split.frontmatterText);
  const pair = map?.items.find(
    (item) => isScalar(item.key) && item.key.value === key,
  );

  if (pair?.value && !isScalar(pair.value)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      "Field is not a scalar; setScalarField only sets scalar fields",
      { details: { reason: "field is not a scalar" } },
    );
  }

  const newValueText = scalarText(value);
  const newline = detectNewline(split);

  let newFrontmatterText: string;
  if (pair?.value && isRangedNode(pair.value)) {
    const [start, end] = pair.value.range;
    // An existing key with no value (`epic:` — a zero-width, `null`
    // scalar) has `start === end`. Where exactly that zero-width point
    // sits depends on whether the source already had trailing whitespace
    // after the colon: `yaml`'s value range starts *past* any existing
    // whitespace (confirmed by execution: "epic:\n" ranges at the byte
    // right after the colon; "epic: \n" ranges one byte later, past the
    // space that is already there). So a leading space is only missing —
    // and only needs inserting — when the byte immediately before `start`
    // is the colon itself, not when it is already whitespace; inserting
    // unconditionally on `start === end` produces "epic:  EPIC-9" (two
    // spaces) for "epic: " and "epic:EPIC-9" (none) for "epic:" if the
    // check went the other way — this is the exact byte that has to be
    // read to get both cases right.
    const charBeforeValue = split.frontmatterText[start - 1];
    const needsLeadingSpace =
      start === end && charBeforeValue !== " " && charBeforeValue !== "\t";
    const replacement = needsLeadingSpace ? ` ${newValueText}` : newValueText;
    newFrontmatterText =
      split.frontmatterText.slice(0, start) +
      replacement +
      split.frontmatterText.slice(end);
  } else {
    newFrontmatterText = `${split.frontmatterText}${key}: ${newValueText}${newline}`;
  }

  return reparseWithFrontmatter(ticket, split, newFrontmatterText);
}

/**
 * Sets one top-level flow-sequence frontmatter field (e.g. `assignee`) to an
 * inline `[v1, v2]` list via the same targeted-splice machinery as
 * `setScalarField` — Backlog.md's own style for `assignee`/`labels`/
 * `dependencies` (CONCEPT.md's ticket example writes `assignee: [alice]` as
 * an unpadded flow sequence). Nothing outside the field's own value range
 * changes. Values that are not a bare YAML plain scalar are JSON-escaped so
 * the resulting sequence still parses as exactly those strings.
 *
 * Exists because `setScalarField` deliberately refuses a sequence-valued
 * field (the `assignee` field in `ticket/schema.ts` is `z.array(z.string())`)
 * — M3.5's `assign` command is the first writer of it and needs an array
 * result, not a quoted scalar.
 */
export function setSequenceField(
  ticket: ParsedTicket,
  key: string,
  values: readonly string[],
): ParsedTicket {
  if (UNSAFE_KEY_RE.test(key)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      "Field name is not a valid single-line YAML key",
      { details: { reason: "not a valid single-line YAML key" } },
    );
  }

  const split = requireSplit(ticket);
  const { map } = findTopLevelPair(split.frontmatterText);
  const pair = map?.items.find(
    (item) => isScalar(item.key) && item.key.value === key,
  );

  if (pair?.value && !isSeq(pair.value)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      "Field is not a sequence; setSequenceField only sets sequence fields",
      { details: { reason: "field is not a sequence" } },
    );
  }
  if (pair?.value && isSeq(pair.value) && !isRangedNode(pair.value)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      "Field sequence has no source range; refusing to append a duplicate field",
      { details: { reason: "field sequence has no source range" } },
    );
  }

  const flow = `[${values.map(flowScalarText).join(", ")}]`;
  const newline = detectNewline(split);

  let newFrontmatterText: string;
  if (pair?.value && isSeq(pair.value) && isRangedNode(pair.value)) {
    const [start, end] = pair.value.range;
    newFrontmatterText =
      split.frontmatterText.slice(0, start) +
      flow +
      split.frontmatterText.slice(end);
  } else {
    newFrontmatterText = `${split.frontmatterText}${key}: ${flow}${newline}`;
  }

  return reparseWithFrontmatter(ticket, split, newFrontmatterText);
}

/** A bare YAML flow scalar (letters, digits, `_`, `-`, `.`, `@`, `/`, `:` for actor `tool:name` forms) needs no quoting in a flow sequence. */
const FLOW_SCALAR_RE = /^[A-Za-z0-9_.:@/-]+$/;

/** Renders one list item as a YAML flow scalar, JSON-quoting when the bare form is unsafe. */
function flowScalarText(value: string): string {
  return FLOW_SCALAR_RE.test(value) ? value : JSON.stringify(value);
}

function indentBlock(text: string, newline: string): string {
  return text
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join(newline);
}

/**
 * The newline convention already used by this ticket file, derived from its
 * own opening delimiter line. Freshly-generated bytes (an appended
 * `key: value` line, an inserted/replaced `cankan:` block) use this instead
 * of hardcoding `"\n"`, so a CRLF-authored file does not end up with mixed
 * line endings after a mutation.
 */
function detectNewline(split: TicketFileSplit): string {
  return split.opening.endsWith("\r\n") ? "\r\n" : "\n";
}

/**
 * Replaces (or, passing `undefined`, removes) the disposable `cankan:`
 * block via a targeted splice — ADR 0002 decision point 3's "rebuild the
 * cache" path, for when CanKan detects that Backlog.md destroyed the block
 * on a foreign write and needs to re-derive it. Like `setScalarField`,
 * nothing outside the `cankan:` key's own line range changes.
 */
export function setCankanBlock(
  ticket: ParsedTicket,
  block: CankanBlock | undefined,
): ParsedTicket {
  const split = requireSplit(ticket);
  const { map } = findTopLevelPair(split.frontmatterText);
  const pair = map?.items.find(
    (item) => isScalar(item.key) && item.key.value === "cankan",
  );
  const newline = detectNewline(split);

  const replacementText =
    block === undefined
      ? ""
      : `cankan:${newline}${indentBlock(stringify(block, { lineWidth: 0 }), newline)}${newline}`;

  let newFrontmatterText: string;
  if (
    pair &&
    isRangedNode(pair.key) &&
    pair.value &&
    isRangedNode(pair.value)
  ) {
    const start = pair.key.range[0];
    // `range[2]` (valueEnd) rather than `range[1]` (end): it chains through
    // to the next sibling key's start (or end of the frontmatter text if
    // `cankan:` is last), so removing/replacing up to it leaves no stray
    // blank line behind — unlike `setScalarField`, which deliberately stops
    // at `range[1]` to leave the trailing newline untouched.
    const end = pair.value.range[2];
    newFrontmatterText =
      split.frontmatterText.slice(0, start) +
      replacementText +
      split.frontmatterText.slice(end);
  } else if (block === undefined) {
    // No `cankan:` block present and asked to remove it: nothing to do.
    newFrontmatterText = split.frontmatterText;
  } else {
    newFrontmatterText = `${split.frontmatterText}${replacementText}`;
  }

  return reparseWithFrontmatter(ticket, split, newFrontmatterText);
}

function isRangedNode(
  node: ParsedNode | Scalar,
): node is (ParsedNode | Scalar) & { range: [number, number, number] } {
  return Array.isArray((node as { range?: unknown }).range);
}

function reparseWithFrontmatter(
  ticket: ParsedTicket,
  split: TicketFileSplit,
  newFrontmatterText: string,
): ParsedTicket {
  const newRaw = `${split.opening}${newFrontmatterText}${split.closeText}${split.body}`;
  return parseTicketFile(newRaw, ticket.source.path);
}
