import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isContained } from "../board/index";
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
 * passes through before any I/O.
 *
 * ## Step (b)'s write-time half, and step (c) — `assertTicketsDirContained` (1B, Ruling R9)
 *
 * ADR 0002 steps (a) and (b) are otherwise `board/ref.ts`'s job
 * (`buildBoardRef`, at *resolve* time, read-only). But `resolveBoard()`
 * canonicalizes and containment-checks `board.ticketsDir` once; between
 * then and a write, `ticketsDir` can have been replaced by a symlink
 * pointing outside the board, or a caller can hand this module a
 * hand-built `BoardRef` that never went through `buildBoardRef` at all.
 * `assertTicketsDirContained` is the single guard `write()`, `remove()`,
 * and `archive()` all funnel through (via `openTicketStore`'s returned
 * closures) before doing anything else, so the check exists in exactly one
 * place rather than three. It also owns step (c) — rejecting a
 * `ticketsDir` equal to or beneath any of the `gitDirs` this module was
 * opened with — reusing `board/ref.ts`'s exported `isContained` rather
 * than re-deriving a second copy (Ruling R5).
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
   *
   * Doc note (1B, deferred from 1A's review): a ticket whose frontmatter is
   * currently malformed is unreachable here — `get()` (and therefore
   * `remove()`) resolves through `list()`, which only sees successfully-
   * parsed tickets, while `write()` matches on-disk **filenames** instead.
   * This is correct per spec and intentional, just surprising to a future
   * reader: a malformed ticket can be overwritten by `write()` but not
   * deleted by `remove()`, until its frontmatter parses again.
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
   *
   * Doc note (1B, deferred from 1A's review): the same reachability gap
   * documented on `remove()` applies here — `archive()` resolves through
   * `get()`, so a ticket whose frontmatter is currently malformed cannot be
   * archived until it parses again, even though `write()` could still find
   * and overwrite it by filename.
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
   * becomes a silently-skipped security check" (Ruling R3). Each entry
   * must already be canonical (`fs.realpath`'d), not merely absolute — see
   * `assertValidGitDirs`.
   */
  readonly gitDirs: readonly string[];
}

/**
 * Opens a ticket store over `options.board`'s tickets directory. Never
 * touches the filesystem itself at open time beyond validating `gitDirs`
 * (1B tightened that validation to require each entry to already be
 * canonical, which needs `fs.realpath` — see `assertValidGitDirs`); every
 * method call does its own I/O, and none of them create `ticketsDir`
 * (Ruling R4).
 *
 * `write()`, `remove()`, and `archive()` — the write paths — all funnel
 * through `guardWrite()` (a closure over this call's `board`/`gitDirs`)
 * before doing anything else, so ADR 0002 step (b)'s write-time half and
 * step (c) are enforced from exactly one place (`assertTicketsDirContained`,
 * 1B Ruling R9) rather than three separate copies. `list()`/`get()` are
 * read-only and do not run it.
 */
export async function openTicketStore(options: OpenTicketStoreOptions): Promise<TicketStore> {
  await assertValidGitDirs(options.gitDirs);
  const { board, gitDirs } = options;
  const ticketsDir = board.ticketsDir;
  const guardWrite = (): Promise<void> => assertTicketsDirContained(ticketsDir, board.root, gitDirs);
  return {
    list: () => listTickets(ticketsDir),
    get: (lookup) => getTicket(ticketsDir, lookup),
    write: async (ticket) => {
      await guardWrite();
      return writeTicket(ticketsDir, ticket);
    },
    remove: async (lookup) => {
      await guardWrite();
      return removeTicket(ticketsDir, lookup);
    },
    archive: async (lookup) => {
      await guardWrite();
      return archiveTicket(ticketsDir, lookup);
    },
  };
}

/**
 * `gitDirs` is required, not optional, in `OpenTicketStoreOptions` — but
 * TypeScript's guarantee is compile-time only. A JS caller (or one that
 * skips type-checking) omitting it entirely would otherwise silently reach
 * 1B's containment check with `undefined`, defeating the whole point of
 * making the field required rather than defaulting it. Checked eagerly so
 * the failure is loud and immediate, not a mystery inside 1B's later logic.
 *
 * Each entry is further required to be **canonical** — `fs.realpath`'d,
 * not merely absolute (1B, work item 2b.1, tightened from "absolute" alone
 * in fix round 1 Minor 2). `OpenTicketStoreOptions.gitDirs`'s own doc
 * comment already promises canonical paths, and `assertTicketsDirContained`
 * (1B's step (c) check) compares each entry against the already-canonical
 * `board.ticketsDir` via `isContained` — an absolute-but-non-canonical
 * entry (a macOS `/var/folders/...` git directory that was never
 * realpath'd, say) would silently fail to match anything it should, which
 * is exactly the "security check that quietly does nothing" this guard
 * exists to prevent, one layer down. Verified by `fs.realpath`-ing each
 * entry and requiring the result to equal the entry itself; a path that
 * does not exist, or that resolves to something else, is rejected the same
 * way a relative or empty entry already was. This makes the function
 * asynchronous (fix round 1's version was synchronous).
 */
async function assertValidGitDirs(gitDirs: readonly string[]): Promise<void> {
  if (!Array.isArray(gitDirs)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      "gitDirs must be an array — pass [] to assert there is no git directory",
    );
  }
  for (const dir of gitDirs) {
    if (typeof dir !== "string" || dir.length === 0 || !isAbsolute(dir)) {
      throw new CanKanError(ErrorCodes.USAGE, "Every gitDirs entry must be a non-empty, absolute path");
    }
    let real: string;
    try {
      real = await realpath(dir);
    } catch (err) {
      throw new CanKanError(ErrorCodes.USAGE, "Every gitDirs entry must be an existing, canonical path", {
        cause: err,
      });
    }
    if (real !== dir) {
      throw new CanKanError(ErrorCodes.USAGE, "Every gitDirs entry must already be canonical (fs.realpath'd)");
    }
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

function unsafeTicketsDirError(reason: string): CanKanError {
  return new CanKanError(StoreErrorCodes.TICKETS_DIR_UNSAFE, `Tickets directory rejected: ${reason}`, {
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
 * ADR 0002 step (b)'s write-time half, and step (c) (1B, Ruling R9) — the
 * single guard `write()`, `remove()`, and `archive()` all funnel through
 * (see `openTicketStore`'s `guardWrite` closure) before touching the
 * filesystem, so the check lives in exactly one place instead of being
 * re-derived three times.
 *
 * `resolveBoard()`/`buildBoardRef` canonicalize and containment-check
 * `board.ticketsDir` once, at *resolve* time. Between then and this call,
 * `ticketsDir` can have been replaced by a symlink pointing outside the
 * board — string arithmetic alone cannot see that, which is exactly what
 * step (b)'s write-time half exists to catch — or this module can simply
 * have been handed a hand-built `BoardRef` that never went through
 * `buildBoardRef` at all, the defence-in-depth case this function backs up.
 *
 * `boardRoot` is trusted as already canonical (the `BoardRef` contract);
 * only `ticketsDir` is realpath'd again here, since it is the value that
 * can have changed since resolve time. `gitDirs` are required canonical by
 * `assertValidGitDirs`, so every `isContained` comparison below compares
 * canonical to canonical.
 *
 * **Stated honestly, not overclaimed: this narrows the TOCTOU window, it
 * does not close it.** The filesystem can still change between this
 * `realpath` call and the `rename`/`unlink`/`mkdir` call that runs after it
 * in the caller. What this closes is a `ticketsDir` that is *already*
 * unsafe at the moment this runs — the checked-in-symlink and hand-built-
 * `BoardRef` cases, neither of which requires winning a race at all.
 */
async function assertTicketsDirContained(
  ticketsDir: string,
  boardRoot: string,
  gitDirs: readonly string[],
): Promise<void> {
  let real: string;
  try {
    real = await realpath(ticketsDir);
  } catch (err) {
    if (isEnoent(err)) throw ticketsDirMissingError();
    throw ticketsDirUnavailableError(err);
  }
  if (!isContained(boardRoot, real)) {
    throw unsafeTicketsDirError("resolves outside the board root");
  }
  for (const gitDir of gitDirs) {
    if (isContained(gitDir, real)) {
      throw unsafeTicketsDirError("resolves inside a git directory");
    }
  }
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
 *
 * The rule set mirrors `ticket/filename.ts`'s `unsafeStructuralReason` (fix
 * round 1, Minor 1): this function is documented as this module's own
 * defence-in-depth backstop, and was found to be strictly *weaker* than the
 * check it backs up — a NUL byte and the empty string both passed every
 * branch here (the empty string only failed, incidentally, at the final
 * `dirname` check; a NUL byte failed nothing at all). Neither is reachable
 * through the public API today (a `readdir` entry cannot contain a NUL byte,
 * and `buildTicketFilename` already rejects one), but a backstop that is
 * weaker than the thing it backs up is not defence in depth.
 */
export function assertSafeTicketPath(dir: string, filename: string): string {
  if (filename.length === 0) {
    throw unsafeTicketPathError("is empty");
  }
  if (filename.includes("\0")) {
    throw unsafeTicketPathError("contains a NUL byte");
  }
  if (filename !== basename(filename)) {
    throw unsafeTicketPathError("is not a bare filename");
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw unsafeTicketPathError("contains a path separator");
  }
  if (filename === "." || filename === "..") {
    throw unsafeTicketPathError("is a single or double dot");
  }
  if (filename.toLowerCase() === ".git") {
    throw unsafeTicketPathError("is the git-metadata directory name");
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
 *
 * **Unbounded in entry count and total bytes (fix round 1, Minor 3 —
 * controller ruling: documented, not capped, in this slice).** This
 * function reads and parses every ticket-shaped entry in `ticketsDir` and
 * retains each one's full `source.raw`; `get()`, `remove()` and
 * `archive()` each call it in full just to resolve a single lookup. A
 * single file's size is bounded upstream (`ticket/frontmatter.ts`'s
 * `MAX_RAW_LENGTH`/`MAX_FRONTMATTER_LENGTH`), but nothing here bounds how
 * many ticket-shaped files exist or their aggregate size — both are
 * driven entirely by checked-in repository content. A cap is a behaviour
 * change (it could reject a legitimately large board) and choosing the
 * number is a product decision outside this task's scope — routed to a
 * follow-up rather than guessed at here.
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
  // function's enforcement point.) `ticket.source.path` reaches only this
  // `parseTicketFile` call's optional error-message argument — never a path
  // or write decision. **This is deliberately stronger than a mere
  // provenance check** (fix round 1: security review confirmed this design
  // is sound): it validates the *bytes*, so a hand-built
  // `{ frontmatter, source }` whose `source.raw` genuinely parses is
  // accepted and written correctly, even though it never actually passed
  // through `parseTicketFile` before reaching here — the brief's originally
  // assumed `requireSplit`-based provenance check would have rejected that
  // object regardless of whether its bytes were fine, which is a strictly
  // weaker guarantee than checking the bytes themselves.
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

/**
 * Creates (if needed) and validates the archive subdirectory — the one
 * directory this module creates (Ruling R4): it lives inside the
 * already-validated `ticketsDir`, so this opens no new containment question
 * the way creating `ticketsDir` itself would. **Except** it did open one
 * (fix round 1, Critical, found by security review): `mkdir(archiveDir,
 * { recursive: true })` silently succeeds when `archive` already exists as
 * a *symlink* to a directory — it stats, sees a directory, and returns —
 * after which the subsequent `rename()` resolves that symlink and lands
 * the ticket wherever it points, **outside** `ticketsDir` entirely.
 * Verified against a real store: a checked-in `.cankan/tickets/archive` ->
 * `/tmp/victim` symlink (git stores and checks out a symlink verbatim,
 * mode `120000`) let `archive()` move a ticket clean out of the repo,
 * silently overwriting anything already at the destination — the attacker
 * controls both the destination directory and the filename.
 * `assertSafeTicketPath` cannot catch this on its own: it is purely
 * lexical (string joins and a `dirname` compare) and never resolves a
 * single path component.
 *
 * Guarded two ways, both inside this one function so 1B extends a single
 * choke point rather than chasing call sites:
 * - `lstat` (not `stat`) before creating anything: `ENOENT` means "safe to
 *   create"; anything that already exists and is not a **real** directory
 *   (a symlink, a file, a FIFO, ...) is rejected outright, before anything
 *   is created or moved.
 * - After `mkdir`, `realpath(archiveDir)` must equal
 *   `join(ticketsDir, ARCHIVE_DIR_NAME)` **exactly** — exact equality,
 *   not containment, is correct here because `BoardRef.ticketsDir` is
 *   already canonical by contract (`board/ref.ts`), so the expected value
 *   is already in its final, symlink-resolved form.
 *
 * **Residual gap, stated honestly, not overclaimed:** there is a TOCTOU
 * window between this check and the `rename` call in `archiveTicket` — a
 * local process running as the same user that swaps a real directory for a
 * symlink inside that window can still win the race. Nothing here closes
 * that; what it closes is the checked-in-symlink attack, which requires no
 * race at all and is the one a hostile repository can actually mount.
 *
 * `mkdir(archiveDir)` below is called **without** `{ recursive: true }`
 * (1B, work item 2b.2 — a fix-round-1 review finding on this same
 * function): `recursive: true` was demonstrated to succeed silently
 * against a planted symlink in a narrower race than this — the exact
 * silent-success behaviour the original Critical exploited — while a plain
 * `mkdir` fails outright (`EEXIST`) if anything is already there. The
 * parent (`ticketsDir`) is already known to exist by the time this runs
 * (`assertTicketsDirContained`'s guard, and every caller's own
 * `assertTicketsDirUsable`/`getTicket` before it), so recursion buys
 * nothing here. This closes the `lstat`→`mkdir` race window one step
 * earlier, in the kernel, rather than relying solely on the `realpath`
 * check below to catch it after the fact — the residual window is the same
 * either way; this is defence in depth, not a distinct bug fix.
 */
async function ensureArchiveDir(ticketsDir: string): Promise<string> {
  const archiveDir = join(ticketsDir, ARCHIVE_DIR_NAME);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(archiveDir);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (existing !== undefined && !existing.isDirectory()) {
    throw unsafeTicketPathError("archive already exists and is not a real directory");
  }
  if (existing === undefined) {
    await mkdir(archiveDir);
  }
  const real = await realpath(archiveDir);
  if (real !== join(ticketsDir, ARCHIVE_DIR_NAME)) {
    throw unsafeTicketPathError("archive does not resolve to the expected directory");
  }
  return archiveDir;
}

async function archiveTicket(ticketsDir: string, lookup: string): Promise<StoredTicket> {
  const found = await getTicket(ticketsDir, lookup);
  if (found === undefined) throw ticketNotFoundError();

  const filename = basename(found.path);
  let destPath: string;
  try {
    const archiveDir = await ensureArchiveDir(ticketsDir);
    destPath = assertSafeTicketPath(archiveDir, filename);
    await rename(found.path, destPath);
  } catch (err) {
    rethrowAsIoFailure(err);
  }

  const moved = parseTicketFile(serializeTicketFile(found.ticket), destPath);
  return { id: moved.frontmatter.id, path: destPath, ticket: moved };
}
