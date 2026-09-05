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
 * where the board root actually lives — the board resolver (M2.4 `board/`)
 * or the ticket store (M2.5 `store/`), whichever first resolves
 * `tickets_dir` and performs the write. Do not implement (a)-(c) here:
 * importing `config/`/`board/` from this module would also violate PLAN.md
 * rule 2 (a task may only import from its own `Depends on` list).
 */

const ASCII_DEL = 127;
const ASCII_MAX_CONTROL = 31;

/** Punctuation that is illegal or awkward in a filename on at least one of Linux/macOS/Windows. Deliberately listed one by one, no character-class range, so this stays trivial to audit. */
const UNSAFE_PUNCTUATION = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/** Unicode bidirectional-formatting and zero-width code points: LRE/RLE/PDF/LRO/RLO, directional isolates, zero-width space/joiners/non-joiner, and the BOM. None of these are ASCII control characters, but a filename containing one renders misleadingly (or invisibly) in a terminal or file browser. */
const BIDI_OR_ZERO_WIDTH_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff,
]);

function isAsciiControlOrDel(code: number): boolean {
  return code <= ASCII_MAX_CONTROL || code === ASCII_DEL;
}

/** True if `ch` (a single UTF-16 code unit) must never survive into a filename: an ASCII control character (including NUL), or one of the punctuation characters in `UNSAFE_PUNCTUATION`. */
function isUnsafeFilenameChar(ch: string): boolean {
  return isAsciiControlOrDel(ch.charCodeAt(0)) || UNSAFE_PUNCTUATION.has(ch);
}

function containsUnsafeFilenameChar(s: string): boolean {
  for (const ch of s) {
    if (isUnsafeFilenameChar(ch)) return true;
  }
  return false;
}

function containsBidiOrZeroWidth(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (BIDI_OR_ZERO_WIDTH_CODE_POINTS.has(s.charCodeAt(i))) return true;
  }
  return false;
}

function stripUnsafeFilenameChars(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isUnsafeFilenameChar(ch)) out += ch;
  }
  return out;
}

const MAX_SLUG_LENGTH = 100;
// No ADR gives an exact number for id length; this keeps `<id> - <slug>.md`
// well under ext4/APFS's 255-byte NAME_MAX even with both this cap and
// MAX_SLUG_LENGTH maxed out (100 + 3 + 100 + 3 = 206), with room to spare —
// an id this long is never legitimate (`ticket/id.ts` mints a `ck-` prefix
// plus 6 hex characters), so it is rejected outright rather than truncated:
// truncating an id would silently corrupt its identity.
const MAX_ID_LENGTH = 100;

/**
 * Turns a ticket title into a stable, filesystem-safe slug: the same title
 * always yields the same slug, and the result never contains a path
 * separator or other character that breaks on macOS or Linux (CI runs
 * both).
 *
 * This is CanKan's **own** slug rule, not a reimplementation of
 * Backlog.md's. ADR 0002 probe 3's own slug is case-preserving
 * (`New-task-after-hash-id-present`) — CanKan's slugger also preserves
 * casing and simply replaces runs of whitespace with a single hyphen, but
 * `buildTicketFilename`/`parseTicketFilename` are not required to be
 * inverses of a filename Backlog.md produced; only of one CanKan minted
 * itself.
 */
export function slugifyTitle(title: string, maxLength = MAX_SLUG_LENGTH): string {
  const stripped = stripUnsafeFilenameChars(title);
  const hyphenated = stripped.trim().replace(/\s+/g, "-");
  const collapsed = hyphenated.replace(/-{2,}/g, "-");
  const trimmedHyphens = collapsed.replace(/^-+|-+$/g, "");
  const withoutLeadingDots = trimmedHyphens.replace(/^\.+/, "");
  const capped = withoutLeadingDots.slice(0, maxLength);
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
  // path component could collide with an actual git directory.
  if (basename === ".git") return "is the git-metadata directory name";
  return undefined;
}

/**
 * The extra rules that apply to the **id segment** specifically (not to a
 * full filename, whose length is already bounded by `MAX_ID_LENGTH` +
 * `MAX_SLUG_LENGTH` separately): a length cap (an id this long is never
 * legitimate), and a scrub against control characters, other
 * filesystem-unsafe punctuation, and Unicode bidirectional/zero-width
 * formatting characters — `slugifyTitle` already strips the first class
 * from a title; an id never went through that sanitizer.
 */
function unsafeIdReason(id: string): string | undefined {
  const structural = unsafeStructuralReason(id);
  if (structural) return structural;
  if (id.length > MAX_ID_LENGTH) return `is longer than ${MAX_ID_LENGTH} characters`;
  if (containsUnsafeFilenameChar(id)) return "contains a control character or other unsafe character";
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

// IDs never contain whitespace (`<prefix>-<hash>`), so the first run of
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
