import { CanKanError } from "../errors";
import type { TicketId } from "../types";
import { TicketErrorCodes } from "./errors";

/** Characters that must never survive into a filename: control characters
 * (including NUL), path separators on either Linux or macOS/Windows, and
 * the handful of characters that are simply illegal or awkward in a
 * filename on at least one of those filesystems. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control characters from filenames.
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

const MAX_SLUG_LENGTH = 100;

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
  const stripped = title.replace(UNSAFE_CHARS_RE, "");
  const hyphenated = stripped.trim().replace(/\s+/g, "-");
  const collapsed = hyphenated.replace(/-{2,}/g, "-");
  const trimmedHyphens = collapsed.replace(/^-+|-+$/g, "");
  const withoutLeadingDots = trimmedHyphens.replace(/^\.+/, "");
  const capped = withoutLeadingDots.slice(0, maxLength);
  return capped.length > 0 ? capped : "untitled";
}

const PATH_SEPARATOR_RE = /[/\\]/;

function assertSafeBasename(basename: string, unsafeValue: string): void {
  if (
    basename.length === 0 ||
    PATH_SEPARATOR_RE.test(basename) ||
    basename.includes("\0") ||
    basename === "." ||
    basename === ".."
  ) {
    throw new CanKanError(
      TicketErrorCodes.UNSAFE_FILENAME,
      "Ticket id or title cannot be turned into a safe filename",
      { details: { value: unsafeValue } },
    );
  }
}

/**
 * Builds the `<id> - <slug>.md` filename (CONCEPT.md "Ticket file",
 * `backlog/tasks/<id> - <slug>.md`).
 *
 * ADR 0002's Consequences section requires the title segment to be
 * sanitized *before* it ever reaches a filesystem path — `slugifyTitle`
 * does that — and the constructed basename to be asserted free of path
 * separators and not `.`/`..` as defense-in-depth, in case a caller passes
 * a hostile `id` (this module never mints one; `ticket/id.ts` always
 * produces a safe `ck-<hash>`). Containment against a board's tickets
 * directory (ADR 0002 steps (a)-(c): board-root/tickets-dir/`.git`
 * containment) is the filesystem-writer's responsibility — the store
 * (M2.5) or board resolver (M2.4) — since building a filename string here
 * has no board root to check against.
 */
export function buildTicketFilename(id: TicketId | string, title: string): string {
  assertSafeBasename(id, id);
  const slug = slugifyTitle(title);
  const filename = `${id} - ${slug}.md`;
  assertSafeBasename(filename, filename);
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
 * Case-insensitive on the id portion is the *caller's* job: this function
 * returns the id exactly as written in the filename (ADR 0002 decision
 * point 5 — a filename's id casing may legitimately disagree with the same
 * ticket's in-file `id:` casing). Compare the result with
 * `normalizeTicketIdForComparison`, not `===`.
 */
export function parseTicketFilename(filename: string): ParsedTicketFilename | null {
  if (PATH_SEPARATOR_RE.test(filename) || filename.includes("\0")) {
    return null;
  }
  const match = FILENAME_RE.exec(filename);
  if (!match?.groups) {
    return null;
  }
  return { id: match.groups.id, slug: match.groups.slug };
}
