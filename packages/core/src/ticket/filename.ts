import { CanKanError } from "../errors";
import type { TicketId } from "../types";
import { TicketErrorCodes } from "./errors";

/**
 * `<id> - <slug>.md` filename construction and parsing.
 *
 * Scope note (ADR 0002, `docs/decisions/0002-ids-and-backlog-compat.md`,
 * around line 545): only step (d) of that ADR's four-step containment list
 * is this module's. Step (d) is "the constructed basename contains no path
 * separator and is neither a single dot nor a double dot" — `assertSafeId`
 * / `assertSafeFilename` below. Steps (a) through (c) — realpath-and-compare
 * a board root against `tickets_dir`, re-check once `tickets_dir` exists
 * (symlink defense), and reject `tickets_dir` resolving inside a git
 * directory — all require a `boardRoot`/`tickets_dir` this module is never
 * handed: it builds and parses a bare filename string, it never joins one
 * onto a directory or touches the filesystem. The ADR names M2.2 as the
 * owner of the whole containment list by number, but steps (a)-(c) belong
 * to **the ticket store (M2.5 `store/`)**: step (b) ("re-check once
 * `tickets_dir` exists") is inherently write-time, and M2.5 is the module
 * that performs the write. (An earlier version of this comment named
 * "M2.4 or M2.5" — two candidate owners joined by "or" is zero owners; the
 * ADR's own text at ~line 526-529 still names M2.2, and that correction is
 * the controller's to carry into the ADR/PLAN.md, not this module's — see
 * Global Constraints 5 and 6.) Do not implement (a)-(c) here: importing
 * `config/`/`board/` from this module would also violate PLAN.md rule 2 (a
 * task may only import from its own `Depends on` list).
 */

const ASCII_DEL = 127;
const ASCII_MAX_CONTROL = 31;

/** Punctuation that is illegal or awkward in a filename on at least one of Linux/macOS/Windows. Deliberately listed one by one, no character-class range, so this stays trivial to audit. */
const UNSAFE_PUNCTUATION = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/** Unicode bidirectional-formatting and zero-width code points: LRE/RLE/PDF/LRO/RLO, directional isolates, zero-width space/joiners/non-joiner, and the BOM. None of these are ASCII control characters, but a filename containing one renders misleadingly (or invisibly) in a terminal or file browser. All are single UTF-16 code units (BMP), so a plain `charCodeAt` comparison is exact — no surrogate-pair handling needed for this set. */
const BIDI_OR_ZERO_WIDTH_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
]);

function isAsciiControlOrDel(code: number): boolean {
  return code <= ASCII_MAX_CONTROL || code === ASCII_DEL;
}

/** ASCII control character (including NUL/DEL) or filesystem-unsafe punctuation. */
function isControlOrUnsafePunctuation(ch: string): boolean {
  return isAsciiControlOrDel(ch.charCodeAt(0)) || UNSAFE_PUNCTUATION.has(ch);
}

/** A Unicode bidirectional-formatting or zero-width code point (see `BIDI_OR_ZERO_WIDTH_CODE_POINTS`). */
function isBidiOrZeroWidth(ch: string): boolean {
  return BIDI_OR_ZERO_WIDTH_CODE_POINTS.has(ch.charCodeAt(0));
}

/** The full set of characters `stripUnsafeFilenameChars` removes from a title, and one of the sets `unsafeIdReason` rejects an id for containing. */
function isUnsafeFilenameChar(ch: string): boolean {
  return isControlOrUnsafePunctuation(ch) || isBidiOrZeroWidth(ch);
}

function containsControlOrUnsafePunctuation(s: string): boolean {
  for (const ch of s) {
    if (isControlOrUnsafePunctuation(ch)) return true;
  }
  return false;
}

function containsBidiOrZeroWidth(s: string): boolean {
  for (const ch of s) {
    if (isBidiOrZeroWidth(ch)) return true;
  }
  return false;
}

/** Strips every character `isUnsafeFilenameChar` flags — control characters, unsafe punctuation, *and* bidirectional/zero-width formatting characters, so a title-derived slug and an id are held to the same character set. */
function stripUnsafeFilenameChars(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isUnsafeFilenameChar(ch)) out += ch;
  }
  return out;
}

/**
 * Truncates `s` to at most `maxBytes` UTF-8 bytes, without ever splitting a
 * surrogate pair (astral character) in two. Iterates by Unicode code point
 * (`for...of`, not `.slice`, which indexes by UTF-16 code unit and can
 * split a pair) and stops before the code point that would push the byte
 * count over the limit.
 */
function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

// Both caps are UTF-8 **byte** budgets, not character counts: a title or id
// containing CJK, emoji, or other multi-byte characters can be short in
// characters and long in bytes, and it is bytes that `NAME_MAX` (255 on
// ext4/APFS) actually limits. 100 + 3 (" - ") + 100 + 3 (".md") = 206 bytes
// at both caps' maximum, comfortably under 255 with room for a
// multi-byte-heavy id too.
const MAX_SLUG_BYTES = 100;
const MAX_ID_BYTES = 100;

/**
 * Turns a ticket title into a stable, filesystem-safe slug: the same title
 * always yields the same slug, and the result never contains a path
 * separator or other character that breaks on macOS or Linux (CI runs
 * both).
 *
 * `maxBytes` bounds the result's **UTF-8 byte length**, not its character
 * count (`Buffer.byteLength`, truncating on a code-point boundary so a
 * surrogate pair is never split) — a title-derived slug of CJK characters
 * or emoji is otherwise short in `.length` and long in the bytes that
 * actually hit a filesystem's `NAME_MAX`.
 *
 * This is CanKan's **own** slug rule, not a reimplementation of
 * Backlog.md's. ADR 0002 probe 3's own slug is case-preserving
 * (`New-task-after-hash-id-present`) — CanKan's slugger also preserves
 * casing and simply replaces runs of whitespace with a single hyphen, but
 * `buildTicketFilename`/`parseTicketFilename` are not required to be
 * inverses of a filename Backlog.md produced; only of one CanKan minted
 * itself.
 */
export function slugifyTitle(title: string, maxBytes = MAX_SLUG_BYTES): string {
  const stripped = stripUnsafeFilenameChars(title);
  const hyphenated = stripped.trim().replace(/\s+/g, "-");
  const collapsed = hyphenated.replace(/-{2,}/g, "-");
  const trimmedHyphens = collapsed.replace(/^-+|-+$/g, "");
  const withoutLeadingDots = trimmedHyphens.replace(/^\.+/, "");
  const capped = truncateToUtf8Bytes(withoutLeadingDots, maxBytes);
  return capped.length > 0 ? capped : "untitled";
}

const PATH_SEPARATOR_RE = /[/\\]/;

/**
 * The structural rule every basename — the id segment, the fully
 * constructed filename, and (parity with the write path, ADR 0002's
 * concern about ids arriving from a file Backlog.md wrote) a filename
 * *read* off disk — must satisfy. Returns the failed rule's description,
 * or `undefined` if `basename` is safe. Never includes `basename` itself in
 * the returned string — the caller decides whether/how to report it.
 */
function unsafeStructuralReason(basename: string): string | undefined {
  if (basename.length === 0) return "is empty";
  if (PATH_SEPARATOR_RE.test(basename)) return "contains a path separator";
  if (basename.includes("\0")) return "contains a NUL byte";
  if (basename === ".") return "is a single dot";
  if (basename === "..") return "is a double dot";
  // A literal git-metadata directory name: not a traversal by itself, but a
  // downstream cache/ref-key or directory join that treats this id as a
  // path component could collide with an actual git directory. Compared
  // case-insensitively: macOS (a stated CI target) defaults to a
  // case-insensitive filesystem, where `.GIT`/`.gIt` collide with `.git`
  // just as surely as an exact-case match would.
  if (basename.toLowerCase() === ".git") return "is the git-metadata directory name";
  return undefined;
}

/**
 * The extra rules that apply to the **id segment** specifically (not to a
 * full filename, whose length is already bounded by `MAX_ID_BYTES` +
 * `MAX_SLUG_BYTES` separately): no whitespace (an id with whitespace is
 * exactly the shape `parseTicketFilename`'s `<id> - <slug>.md` split cannot
 * recover correctly — see the `FILENAME_RE` comment), a byte-length cap (an
 * id this long is never legitimate), and a scrub against control
 * characters, other filesystem-unsafe punctuation, and Unicode
 * bidirectional/zero-width formatting characters — `slugifyTitle` already
 * strips this same set from a title; an id never went through that
 * sanitizer.
 */
function unsafeIdReason(id: string): string | undefined {
  const structural = unsafeStructuralReason(id);
  if (structural) return structural;
  // Must be checked before anything that assumes a whitespace-free id.
  // `FILENAME_RE` below splits a filename into id/slug on the first
  // " - " it finds, on the assumption (documented, but previously
  // unenforced) that an id never contains whitespace. An id containing a
  // space either fails to round-trip (`"ck 1"` builds a filename
  // `parseTicketFilename` cannot match at all) or, worse, round-trips to a
  // *different* id (`"a - b"` builds `"a - b - hello.md"`, which parses
  // back as id `"a"` — silently conflating two tickets).
  if (/\s/.test(id)) return "contains whitespace";
  if (Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) return `is longer than ${MAX_ID_BYTES} bytes`;
  if (containsControlOrUnsafePunctuation(id)) return "contains a control character or other unsafe character";
  if (containsBidiOrZeroWidth(id)) return "contains a bidirectional-formatting or zero-width character";
  if (id.trim().length === 0) return "is whitespace-only";
  return undefined;
}

function assertSafeId(id: string): void {
  const reason = unsafeIdReason(id);
  if (reason) {
    // Report which rule failed, never the id itself: `details` is
    // published by default (`src/errors.ts`) — to `--json` output and to
    // the terminal's uncaught-error printer regardless — and the value
    // that failed this check is, by definition, one CanKan chose not to
    // trust.
    throw new CanKanError(TicketErrorCodes.UNSAFE_FILENAME, `Ticket id ${reason}`, {
      details: { subject: "id", reason },
    });
  }
}

function assertSafeFilename(filename: string): void {
  const reason = unsafeStructuralReason(filename);
  if (reason) {
    throw new CanKanError(TicketErrorCodes.UNSAFE_FILENAME, `Ticket filename ${reason}`, {
      details: { subject: "filename", reason },
    });
  }
}

/**
 * Builds the `<id> - <slug>.md` filename (CONCEPT.md "Ticket file",
 * `backlog/tasks/<id> - <slug>.md`).
 *
 * ADR 0002's Consequences section requires the title segment to be
 * sanitized *before* it ever reaches a filesystem path — `slugifyTitle`
 * does that — and the id segment and the constructed basename to both be
 * asserted safe as defense-in-depth, in case a caller passes a hostile
 * `id` (this module never mints one; `ticket/id.ts` always produces a safe
 * `ck-<hash>`, but `cankan adopt`/`cankan import` mint ids from data this
 * module does not control). See the file comment for why containment
 * against a board's tickets directory (ADR 0002 steps (a)-(c)) is
 * deliberately not this function's job.
 *
 * Every id `buildTicketFilename` accepts is guaranteed to round-trip
 * through `parseTicketFilename` back to the same id — see `unsafeIdReason`'s
 * whitespace rule, which exists specifically to keep that property true.
 */
export function buildTicketFilename(id: TicketId | string, title: string): string {
  assertSafeId(id);
  const slug = slugifyTitle(title);
  const filename = `${id} - ${slug}.md`;
  assertSafeFilename(filename);
  return filename;
}

/** The id and slug recovered from a `<id> - <slug>.md` filename. */
export interface ParsedTicketFilename {
  /** Exactly as it appears in the filename — case as-is. Compare with `normalizeTicketIdForComparison`, never with `===`, since a filename's id casing may legitimately differ from the same ticket's in-file `id:` casing (ADR 0002 probe 3). */
  id: string;
  slug: string;
}

// IDs never contain whitespace (`<prefix>-<hash>`, and `unsafeIdReason`
// rejects any id that does on the write path), so the first run of
// non-whitespace characters is always the id; " - " is the separator; the
// rest up to the mandatory `.md` extension is the slug.
const FILENAME_RE = /^(?<id>\S+) - (?<slug>.+)\.md$/;

/**
 * Recovers the id and slug from a ticket filename. `filename` must be a
 * bare basename (no directory component) — pass `path.basename(f)` first if
 * you have a full path. Returns `null` if `filename` is not shaped like
 * `<id> - <slug>.md`, contains a path separator, or is otherwise not a
 * valid ticket filename — never throws on untrusted input.
 *
 * The recovered id is run through the same `unsafeIdReason` predicate
 * `buildTicketFilename` applies on the write path (returning `null` instead
 * of throwing): ADR 0002 probe 3 shows ids arriving from files Backlog.md
 * itself wrote, and a caller that joins this id onto a directory, or uses
 * it as a cache/ref-key component, deserves the same protection regardless
 * of whether the filename was CanKan-built or found on disk.
 *
 * Case-insensitive on the id portion is the *caller's* job: this function
 * returns the id exactly as written in the filename (ADR 0002 decision
 * point 5 — a filename's id casing may legitimately disagree with the same
 * ticket's in-file `id:` casing). Compare the result with
 * `normalizeTicketIdForComparison`, not `===`.
 */
export function parseTicketFilename(filename: string): ParsedTicketFilename | null {
  if (unsafeStructuralReason(filename) !== undefined) {
    return null;
  }
  const match = FILENAME_RE.exec(filename);
  if (!match?.groups) {
    return null;
  }
  if (unsafeIdReason(match.groups.id) !== undefined) {
    return null;
  }
  return { id: match.groups.id, slug: match.groups.slug };
}
