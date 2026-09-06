import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CanKanError, ErrorCodes, isCanKanError } from "../errors";
import {
  buildTicketFilename,
  keepOnDiskIdCasing,
  normalizeTicketIdForComparison,
  parseTicketFile,
  parseTicketFilename,
  serializeTicketFile,
  type ParsedTicket,
  type TicketIdLookupKey,
} from "../ticket/index";
import type { BoardRef, TicketId } from "../types";
import { StoreErrorCodes } from "./errors";

/**
 * `store/ticketStore.ts` — a ticket store over one board's tickets
 * directory (M2.5, PLAN.md task 1): `list()`, `get()`, `write()`, `remove()`,
 * `archive()`. Nothing else — other lanes build their own modules on top of
 * this one rather than this module growing speculative helpers for them.
 *
 * ## This module never reads the event log
 *
 * PLAN.md's M2.8 `Wires` line says state/fold.ts is the *only* module that
 * combines ticket files and events — nothing else may read both. This
 * module reads ticket files only. `get()`'s alias/display-id resolution in
 * particular works from frontmatter alone (`cankan.display_id`,
 * `cankan.aliases`); alias *events* are M2.8's to fold, and nothing in this
 * file imports `../events/index` or `../git/index` for that reason (a
 * shipped-code import of either would also violate PLAN.md rule 2 — #28's
 * `Depends on` list is #25 (`ticket/`) and #27 (`board/`) only).
 *
 * ## Step (d) — the single choke point (Ruling R8)
 *
 * ADR 0002 step (d) — filename validation — already shipped in M2.2
 * (`ticket/filename.ts`'s `assertSafeId`/`assertSafeFilename`, called from
 * `buildTicketFilename`). What this module owns is defence in depth at the
 * store boundary: every path this module opens is `join(ticketsDir,
 * filename)` (or the archive subdirectory) where `filename` came from
 * `buildTicketFilename()` or a `readdir()` entry — never a raw caller
 * string — and `assertSafeTicketPath` is the one function every such path
 * passes through before any I/O. Kept in one place so 1B can extend it
 * (step (c), the `gitDirs` containment check) without chasing call sites.
 */

// ---- the public shape --------------------------------------------------

/** One ticket found in a board's tickets directory. */
export interface StoredTicket {
  /** The ticket's id, on-disk casing preserved (`ticket.frontmatter.id`) — never lowercased. Compare with `normalizeTicketIdForComparison`, never `===`. */
  readonly id: TicketId;
  /** Absolute path to the ticket's file, inside `board.ticketsDir` (or its archive subdirectory, once `archive()` has moved it there). */
  readonly path: string;
  /** The full parsed ticket — frontmatter and byte-exact source — as returned by `ticket/frontmatter.ts`'s `parseTicketFile`. */
  readonly ticket: ParsedTicket;
}

/** One directory entry `list()` could not turn into a `StoredTicket`. */
export interface SkippedTicket {
  /** Absolute path of the skipped entry. */
  readonly path: string;
  /** Its bare filename. */
  readonly filename: string;
  /** Why it was skipped — `CanKanError.message` (or `Error.message`) for the failure `parseTicketFile` raised. Never raw file content: `ticket/errors.ts`'s own codes already keep source bytes out of their messages. */
  readonly reason: string;
}

/** `list()`'s result: every ticket it could parse, plus every entry it could not, with a reason — the `SkippedBoard` pattern (`board/resolve.ts`) applied to tickets. */
export interface ListTicketsResult {
  readonly tickets: readonly StoredTicket[];
  readonly skipped: readonly SkippedTicket[];
}

export interface TicketStore {
  /**
   * Every ticket in the board's tickets directory, plus a typed list of
   * what was skipped and why. One ticket with malformed frontmatter never
   * fails the whole listing, and is never dropped without trace.
   */
  list(): Promise<ListTicketsResult>;
  /**
   * Finds one ticket by id, display id, or alias (`cankan.display_id` /
   * `cankan.aliases` — frontmatter only, see the file comment). `undefined`
   * on no match. Throws `StoreErrorCodes.AMBIGUOUS_TICKET_LOOKUP` if more
   * than one on-disk ticket claims the same id/display-id/alias.
   *
   * The `cankan:` block is a disposable cache Backlog.md deletes on write
   * (ADR 0002:505-516, CONCEPT.md:46). Once a foreign edit has destroyed it,
   * a display-id or alias lookup for that ticket becomes a plain miss
   * (`undefined`) — never an error — while looking it up by its primary
   * `id` still works, since that field lives outside the `cankan:` block.
   * Rebuilding the destroyed block from the authoritative alias map is
   * M2.8's fold to do, not this function's.
   */
  get(lookup: string): Promise<StoredTicket | undefined>;
  /**
   * Writes `ticket` to disk, atomically (temp file in the same directory,
   * then `rename`). `ticket` is meant to have come from
   * `ticket/frontmatter.ts`'s `parseTicketFile` — every value this function
   * actually acts on (the id, the title, the bytes written) is re-derived
   * from `ticket.source.raw` via a fresh `parseTicketFile` call, never
   * trusted from `ticket.frontmatter` directly, so a hand-built object
   * whose `frontmatter` disagrees with its own `source.raw` cannot steer
   * this function into writing a file inconsistent with the bytes it
   * actually contains. If `source.raw` itself does not parse, this throws
   * one of `TicketErrorCodes`'s codes before any I/O.
   *
   * Upsert semantics, keyed on the id `source.raw` actually parses to: if an on-disk
   * filename's id (via `parseTicketFilename`, compared with
   * `normalizeTicketIdForComparison`) already matches, that exact file is
   * overwritten — the filename is never rebuilt from the (possibly changed)
   * title, so a title edit never renames the file. If no on-disk filename
   * matches, this is a create: the filename is built fresh via
   * `buildTicketFilename`. If more than one on-disk filename matches, throws
   * `StoreErrorCodes.AMBIGUOUS_TICKET_LOOKUP` rather than guessing.
   *
   * This match is against **filenames**, not against tickets `list()` could
   * successfully parse — a ticket whose frontmatter is currently malformed
   * still has a real, matchable filename, and an update must find it rather
   * than minting a second file beside it.
   *
   * Requires `board.ticketsDir` to already exist (Ruling R4) —
   * `StoreErrorCodes.TICKETS_DIR_MISSING` otherwise; this function never
   * creates it.
   */
  write(ticket: ParsedTicket): Promise<StoredTicket>;
  /**
   * Deletes the ticket resolved by `lookup` (same resolution as `get()`).
   * `StoreErrorCodes.TICKET_NOT_FOUND` if `get()` finds no match.
   */
  remove(lookup: string): Promise<void>;
  /**
   * Moves the ticket resolved by `lookup` (same resolution as `get()`) into
   * the tickets directory's `archive` subdirectory, creating that
   * subdirectory if needed — the one directory this module is allowed to
   * create (Ruling R4): it lives *inside* the already-validated
   * `ticketsDir`, so no new containment question is opened by creating it.
   * Returns the moved ticket, with `path` updated to its new location.
   * `StoreErrorCodes.TICKET_NOT_FOUND` if `get()` finds no match.
   *
   * If a file of the same name already sits in `archive/` — a ticket
   * removed from the store, re-created with the same id and title, then
   * archived a second time, say (archiving the *same* live ticket twice is
   * not reachable: once moved, `get()` can no longer find it in
   * `ticketsDir`, so a second `archive()` call for it raises
   * `TICKET_NOT_FOUND` before any rename) — the move overwrites the
   * existing archived file. The same last-writer-wins policy `write()`
   * applies to a same-path overwrite; this module does not build claim
   * semantics (that is the event log's job).
   */
  archive(lookup: string): Promise<StoredTicket>;
}

const ARCHIVE_DIR_NAME = "archive";

export interface OpenTicketStoreOptions {
  readonly board: BoardRef;
  /**
   * Absolute, canonical paths of the repository's git directories, for ADR
   * 0002 step (c). Required, with an explicit empty array as the escape
   * hatch for "no git directory" — the same shape `loadBoardConfig`/
   * `loadConfig` established for "a field a caller can simply forget
   * becomes a silently-skipped security check" (Ruling R3). Consumed by
   * slice 1B; in 1A this is validated and otherwise unused.
   */
  readonly gitDirs: readonly string[];
}

/**
 * Opens a ticket store over `options.board`'s tickets directory. Never
 * touches the filesystem itself — every method call does its own I/O, and
 * none of them create `ticketsDir` (Ruling R4).
 */
export async function openTicketStore(options: OpenTicketStoreOptions): Promise<TicketStore> {
  assertValidGitDirs(options.gitDirs);
  const ticketsDir = options.board.ticketsDir;
  return {
    list: () => listTickets(ticketsDir),
    get: (lookup) => getTicket(ticketsDir, lookup),
    write: (ticket) => writeTicket(ticketsDir, ticket),
    remove: (lookup) => removeTicket(ticketsDir, lookup),
    archive: (lookup) => archiveTicket(ticketsDir, lookup),
  };
}

/**
 * `gitDirs` is required, not optional, in `OpenTicketStoreOptions` — but
 * TypeScript's guarantee is compile-time only. A JS caller (or one that
 * skips type-checking) omitting it entirely would otherwise silently reach
 * 1B's containment check with `undefined`, defeating the whole point of
 * making the field required rather than defaulting it. Checked eagerly so
 * the failure is loud and immediate, not a mystery inside 1B's later logic.
 */
function assertValidGitDirs(gitDirs: readonly string[]): void {
  if (!Array.isArray(gitDirs)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      "gitDirs must be an array — pass [] to assert there is no git directory",
    );
  }
}

// ---- error builders (never echo a path or filename value — Ruling constraint) ----

function ticketsDirMissingError(): CanKanError {
  return new CanKanError(
    StoreErrorCodes.TICKETS_DIR_MISSING,
    "The board's tickets directory does not exist yet. Run `cankan init`.",
  );
}

function ticketsDirUnavailableError(cause: unknown): CanKanError {
  return new CanKanError(
    StoreErrorCodes.TICKETS_DIR_UNAVAILABLE,
    "The board's tickets directory could not be accessed.",
    { cause },
  );
}

function unsafeTicketPathError(reason: string): CanKanError {
  return new CanKanError(StoreErrorCodes.UNSAFE_TICKET_PATH, `Ticket path rejected: ${reason}`, {
    details: { reason },
  });
}

function ambiguousLookupError(reason: string): CanKanError {
  return new CanKanError(
    StoreErrorCodes.AMBIGUOUS_TICKET_LOOKUP,
    `Ticket lookup is ambiguous: ${reason}`,
    { details: { reason } },
  );
}

function ticketNotFoundError(): CanKanError {
  return new CanKanError(StoreErrorCodes.TICKET_NOT_FOUND, "No ticket matches the given id.");
}

function ticketIoFailedError(cause: unknown): CanKanError {
  return new CanKanError(
    StoreErrorCodes.TICKET_IO_FAILED,
    "A filesystem error occurred while writing, removing, or archiving a ticket.",
    { cause },
  );
}

/** Rethrows a `CanKanError` (e.g. `assertSafeTicketPath`'s own `UNSAFE_TICKET_PATH`) unchanged; wraps anything else — a raw platform error — as `StoreErrorCodes.TICKET_IO_FAILED`. */
function rethrowAsIoFailure(err: unknown): never {
  if (isCanKanError(err)) throw err;
  throw ticketIoFailedError(err);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Every method requires `ticketsDir` to already exist as a directory —
 * Ruling R4, this module never creates it. `ENOENT` maps to
 * `TICKETS_DIR_MISSING` (the `cankan init` remediation); any other `stat`
 * failure (a symlink cycle, a permission error) maps to
 * `TICKETS_DIR_UNAVAILABLE` rather than escaping as a raw platform error.
 */
async function assertTicketsDirUsable(ticketsDir: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(ticketsDir);
  } catch (err) {
    if (isEnoent(err)) throw ticketsDirMissingError();
    throw ticketsDirUnavailableError(err);
  }
  if (!info.isDirectory()) {
    throw ticketsDirMissingError();
  }
}

// ---- the step (d) choke point (Ruling R8) ------------------------------

/**
 * The single choke point every path this module opens passes through
 * before any I/O. `dir` is `ticketsDir` or its archive subdirectory;
 * `filename` must have come from `buildTicketFilename()` or a `readdir()`
 * entry — never a raw caller-supplied string. Exported (not via
 * `store/index.ts`) so a test can drive its four branches directly, the
 * same way `git.test.ts` reaches `updateRefCASCore` by relative import
 * rather than through the public surface — every hostile id this module's
 * own callers could plausibly construct is already rejected earlier, by
 * `ticket/filename.ts`'s `assertSafeId`/`assertSafeFilename`
 * (`buildTicketFilename`) or by `parseTicketFilename`'s own structural
 * check (`readdir` entries), so this function's own branches are otherwise
 * unreachable through the public API — which is exactly what "defence in
 * depth" means here.
 *
 * Throws `StoreErrorCodes.UNSAFE_TICKET_PATH` and returns nothing on
 * failure — the caller writes nothing.
 */
export function assertSafeTicketPath(dir: string, filename: string): string {
  if (filename !== basename(filename)) {
    throw unsafeTicketPathError("is not a bare filename");
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw unsafeTicketPathError("contains a path separator");
  }
  if (filename === "." || filename === "..") {
    throw unsafeTicketPathError("is a single or double dot");
  }
  const resolved = join(dir, filename);
  if (dirname(resolved) !== dir) {
    throw unsafeTicketPathError("does not resolve directly inside the target directory");
  }
  return resolved;
}

// ---- atomic writes ------------------------------------------------------

/**
 * A filename `parseTicketFilename()` is guaranteed to reject: it never
 * contains `" - "` (the ticket filename grammar's separator), so
 * `FILENAME_RE` (`ticket/filename.ts`) cannot match it regardless of
 * extension — verified directly in `ticketStore.test.ts`, not merely
 * asserted here. `list()` therefore never mistakes a stale temp file for a
 * ticket. Leading `.` keeps it out of a casual directory listing too,
 * though nothing here depends on that. `pid` plus 16 hex chars of random
 * suffix give enough entropy that two concurrent writers targeting
 * *different* tickets cannot collide on a temp name; `open(..., "wx")`
 * below still fails loudly in the astronomically unlikely case they do,
 * rather than one silently clobbering the other's in-flight write.
 */
export function buildTempTicketFilename(): string {
  return `.cankan-tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
}

/**
 * Writes `content` to `targetPath` atomically: a temp file in the same
 * directory as `targetPath` (so the final `rename` is same-filesystem, and
 * therefore atomic — a cross-device rename is not atomic and can fail
 * outright with `EXDEV`), `fsync`'d before the rename, then renamed into
 * place. The temp file is removed in a `finally` if the rename never
 * happens, so a thrown error never leaves a temp file behind in
 * `ticketsDir` for `list()` to have to ignore forever.
 *
 * **Crash guarantee, stated plainly:** `fsync` before `rename` means that
 * if `rename` is ever called, the temp file's bytes are already durable —
 * a crash between `fsync` and `rename` loses nothing but an as-yet-unnamed
 * temp file, never a half-written target. What this does **not** provide
 * is durability of the `rename` itself: this function does not additionally
 * `fsync` an open descriptor on the containing directory afterward, so on
 * some filesystems (notably ext4 with certain mount options) a power loss
 * immediately after `rename` returns can still lose the directory-entry
 * update, even though the file's own data already hit disk. A stale temp
 * file left behind by a crash (before `rename` ran) is always
 * distinguishable from a live ticket file: its name never matches
 * `parseTicketFilename()`'s grammar, so `list()` always ignores it — but
 * nothing here automatically removes it; that is a future cleanup pass's
 * job, not this one's.
 */
async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  const tempPath = join(dir, buildTempTicketFilename());
  let renamed = false;
  try {
    try {
      const handle = await open(tempPath, "wx");
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, targetPath);
      renamed = true;
    } catch (err) {
      rethrowAsIoFailure(err);
    }
  } finally {
    if (!renamed) {
      await rm(tempPath, { force: true });
    }
  }
}

// ---- list() ---------------------------------------------------------------

/**
 * `Dirent.isFile()` from `readdir(dir, { withFileTypes: true })` is
 * `lstat`-based — confirmed by execution, not assumed — so it is `false`
 * for a symlink even when the symlink's target is a regular file. Skipping
 * anything that is not a regular file therefore excludes both the
 * `archive` subdirectory (a directory) and a committed symlink named like a
 * ticket, which would otherwise be followed and its target parsed as
 * frontmatter — an arbitrary-file-read out of the tickets directory, driven
 * by checked-in repo content.
 */
async function listTickets(ticketsDir: string): Promise<ListTicketsResult> {
  await assertTicketsDirUsable(ticketsDir);
  const entries = await readdir(ticketsDir, { withFileTypes: true });
  const tickets: StoredTicket[] = [];
  const skipped: SkippedTicket[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    // Not ticket-shaped (our own temp files included) — silently ignored,
    // never reported as skipped: `parseTicketFilename` returning `null` is
    // "this was never a ticket file," a different question from "this was
    // a ticket file we failed to parse."
    if (parseTicketFilename(filename) === null) continue;

    const path = assertSafeTicketPath(ticketsDir, filename);
    try {
      const raw = await readFile(path, "utf8");
      const ticket = parseTicketFile(raw, path);
      tickets.push({ id: ticket.frontmatter.id, path, ticket });
    } catch (err) {
      // One bad file must not fail the whole listing, nor be dropped
      // without trace (the `SkippedBoard` pattern, `board/resolve.ts`).
      // `err.message` is safe to surface here the same way
      // `resolve.ts`'s `describeFailure` treats it: `ticket/errors.ts`'s
      // own codes already keep raw file content out of their messages.
      const reason = isCanKanError(err) || err instanceof Error ? err.message : String(err);
      skipped.push({ path, filename, reason });
    }
  }

  return { tickets, skipped };
}

// ---- get() ------------------------------------------------------------

/** Every normalized identifier `ticket` can be found by: its own id, plus (frontmatter-only — see the file comment) its `cankan.display_id` and each `cankan.aliases` entry. */
function identifiersFor(ticket: StoredTicket): Set<TicketIdLookupKey> {
  const ids = new Set<TicketIdLookupKey>();
  ids.add(normalizeTicketIdForComparison(ticket.id));
  const cankan = ticket.ticket.frontmatter.cankan;
  if (cankan?.display_id !== undefined) {
    ids.add(normalizeTicketIdForComparison(cankan.display_id));
  }
  for (const alias of cankan?.aliases ?? []) {
    ids.add(normalizeTicketIdForComparison(alias));
  }
  return ids;
}

async function getTicket(ticketsDir: string, lookup: string): Promise<StoredTicket | undefined> {
  const { tickets } = await listTickets(ticketsDir);
  const key = normalizeTicketIdForComparison(lookup);
  const matches = tickets.filter((ticket) => identifiersFor(ticket).has(key));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw ambiguousLookupError("more than one ticket matches the same id, display id, or alias");
  }
  return matches[0];
}

// ---- write() ------------------------------------------------------------

/**
 * Every on-disk filename in `ticketsDir` whose own id (per
 * `parseTicketFilename`, compared with `normalizeTicketIdForComparison`)
 * matches `id`. Matched against **filenames**, deliberately not against
 * tickets `listTickets` could successfully parse: a ticket whose
 * frontmatter is currently malformed still occupies a real filename, and
 * `write()` must find that filename to update it rather than minting a
 * second file beside it. This is also why `write()` never rebuilds a
 * filename to find a ticket (`buildTicketFilename(id, title)` and `stat`)
 * — a title can change without the file being renamed, and `test-utils`'
 * `writeFixtureTickets` slugifies differently (lowercasing) than
 * `slugifyTitle` (case-preserving), so a reconstructed filename can miss a
 * real fixture file entirely.
 */
async function findExistingPathsById(ticketsDir: string, id: string): Promise<string[]> {
  const entries = await readdir(ticketsDir, { withFileTypes: true });
  const key = normalizeTicketIdForComparison(id);
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseTicketFilename(entry.name);
    if (parsed === null) continue;
    if (normalizeTicketIdForComparison(parsed.id) === key) {
      matches.push(assertSafeTicketPath(ticketsDir, entry.name));
    }
  }
  return matches;
}

async function writeTicket(ticketsDir: string, ticket: ParsedTicket): Promise<StoredTicket> {
  await assertTicketsDirUsable(ticketsDir);

  // Re-derives `content`/`id`/`title` from `ticket.source.raw` via a fresh
  // `parseTicketFile` call, rather than trusting `ticket.frontmatter`
  // directly. This is the actual enforcement of "`write()` must take a
  // `ParsedTicket` that came from `parseTicketFile`": a hand-built object
  // literal whose `frontmatter` disagrees with its own `source.raw` (say,
  // `frontmatter.id: "ck-1"` paired with `source.raw` that actually reads
  // `id: ck-9`) cannot steer this function into targeting a file
  // inconsistent with the bytes actually written — only `source.raw`'s own
  // content ever decides the target path or what lands on disk. If
  // `source.raw` itself does not parse, this throws one of
  // `TicketErrorCodes`'s codes before any I/O, the same as calling
  // `parseTicketFile` directly would. (`serializeTicketFile`, by contrast,
  // returns `ticket.source.raw` completely unvalidated — confirmed by
  // reading `ticket/frontmatter.ts` directly — so it is not this
  // function's enforcement point.)
  const canonical = parseTicketFile(ticket.source.raw, ticket.source.path);
  const content = canonical.source.raw;
  const id = canonical.frontmatter.id;

  const matches = await findExistingPathsById(ticketsDir, id);

  let targetPath: string;
  if (matches.length === 1) {
    // Update: preserve the existing on-disk filename even if the title
    // changed since the file was created.
    targetPath = matches[0];
  } else if (matches.length === 0) {
    // Create: no existing file claims this id, so mint a fresh filename.
    const filename = buildTicketFilename(keepOnDiskIdCasing(id), canonical.frontmatter.title);
    targetPath = assertSafeTicketPath(ticketsDir, filename);
  } else {
    throw ambiguousLookupError("more than one on-disk filename already claims this ticket id");
  }

  await atomicWriteFile(targetPath, content);
  // Re-parsed (again) so the returned `ticket.source.path` reflects where
  // the ticket actually landed — the content itself is exactly what was
  // just written, so this re-parse cannot newly fail.
  const written = parseTicketFile(content, targetPath);
  return { id: written.frontmatter.id, path: targetPath, ticket: written };
}

// ---- remove() / archive() ------------------------------------------------

async function removeTicket(ticketsDir: string, lookup: string): Promise<void> {
  const found = await getTicket(ticketsDir, lookup);
  if (found === undefined) throw ticketNotFoundError();
  try {
    await unlink(found.path);
  } catch (err) {
    rethrowAsIoFailure(err);
  }
}

async function archiveTicket(ticketsDir: string, lookup: string): Promise<StoredTicket> {
  const found = await getTicket(ticketsDir, lookup);
  if (found === undefined) throw ticketNotFoundError();

  const archiveDir = join(ticketsDir, ARCHIVE_DIR_NAME);
  const filename = basename(found.path);
  let destPath: string;
  try {
    // The one directory this module creates (Ruling R4): it lives inside
    // the already-validated `ticketsDir`, so this opens no new containment
    // question the way creating `ticketsDir` itself would.
    await mkdir(archiveDir, { recursive: true });
    destPath = assertSafeTicketPath(archiveDir, filename);
    await rename(found.path, destPath);
  } catch (err) {
    rethrowAsIoFailure(err);
  }

  const moved = parseTicketFile(serializeTicketFile(found.ticket), destPath);
  return { id: moved.frontmatter.id, path: destPath, ticket: moved };
}
