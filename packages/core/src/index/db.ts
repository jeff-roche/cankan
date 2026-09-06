/**
 * `index/db.ts` -- M2.14, the SQLite index cache's open/probe/discard
 * lifecycle. `bun:sqlite` throughout; every function here is synchronous,
 * matching `bun:sqlite`'s own synchronous API.
 *
 * **R1 (controller ruling): this file's whole `Depends on` is `state/`
 * (M2.8) alone.** It never imports `store/`, `events/`, `git/`, `board/`,
 * `ticket/` or `config/` -- not even for a type. It never derives a board
 * key, never calls git, never realpaths, never resolves a repository path,
 * and never reads a ticket file or the event log. `boardKey` below is an
 * **opaque string the caller supplies** -- see `OpenIndexOptions.boardKey`'s
 * own doc for the single-sourcing rule this exists to protect (R2, the
 * D20 defence).
 *
 * ## The index is a cache, and `openIndex` treats it as one
 *
 * A corrupt, truncated, stale, or version-mismatched index file
 * **degrades to a rebuild** -- it never produces a wrong answer and never
 * makes the board unusable. `openIndex` only ever throws for a genuinely
 * unusable *environment* (no resolvable cache directory, a `mkdir`/`lstat`
 * failure, a directory sitting where the index file should be) -- never
 * because of the file's own contents. See `IndexDiscardReason` and the
 * open sequence below for the full state machine.
 *
 * ## F4/F5 -- why the probe has four separate steps, none of them "open"
 *
 * `new Database(<garbage bytes>)` does not throw at open time (F4) -- the
 * first query does. Worse, **a file truncated to exactly 0 bytes is a
 * valid empty SQLite database** (F5): `PRAGMA user_version` returns `0`
 * and `PRAGMA integrity_check` returns `"ok"` for it, same as a freshly
 * created file. Neither of those two checks tells a zero-byte file apart
 * from an intentionally-empty, correctly-versioned one. What does catch
 * it is `PRAGMA user_version` returning `0`, which then fails the
 * schema-version comparison against `INDEX_SCHEMA_VERSION` (a non-zero
 * constant) -- **step 4b below, not 4c** (controller addendum A3: the
 * original brief text named 4c as the zero-byte catch; that was wrong,
 * corrected here after re-deriving it from F5 directly). Step 4c is real
 * defense in depth for a *different* case: a file that reports the right
 * `user_version` but has no `cankan_meta` table at all (a rebuild that
 * crashed between `PRAGMA user_version = N` and seeding `cankan_meta`,
 * say).
 *
 * ## Fix round 1, S1 -- the cache DIRECTORY itself is now checked, not just the file inside it
 *
 * The open sequence below used to `mkdirSync(cacheDir, { recursive: true,
 * mode: 0o700 })` and nothing else. Two gaps in that, both verified
 * directly (security review, fix round 1): `mkdir` never chmods an
 * **existing** directory, so a `cankan` directory a vulnerable build left
 * at `0777` stayed `0777` forever; and `mkdirSync(recursive)` does not
 * `lstat` first, so a `cankan` **symlinked** to an attacker's directory
 * made the index land inside that directory, silently. `ensurePrivateCacheDir`
 * below closes both -- see its own doc comment, which mirrors
 * `events/observations.ts`'s `ensurePrivateDir`/`tightenDirPermissions`
 * (that module solved this exact problem under its own security review,
 * fix round 2's Ruling R37). Reimplemented locally, not imported --
 * R1 forbids importing `events/`, the same way `resolveCacheHome` below
 * reimplements `board/xdg.ts`'s XDG rule rather than importing `board/`.
 *
 * ## Fix round 1, S2 -- a page-level corruption the open-time probe cannot see
 *
 * The probe above only ever reads page 1 (`cankan_meta`, the schema
 * pragma). Corruption in a page holding `tickets`/`ticket_aliases`/
 * `ticket_deps` rows passes it cleanly, and used to be a **permanent,
 * unrecoverable wedge**: `openIndex` kept reporting `rebuilt: false`
 * forever, `queryTickets`/`queryBoardState` threw a raw, untyped
 * `SQLiteError`, and `reindex` -- the only remedy this module offered --
 * failed on the same corruption trying to fix it (verified directly,
 * security review, fix round 1: `e4.ts`/`e6.ts`). See `rebuildIndex`
 * below and `IndexErrorCodes.CORRUPT`'s own doc comment for the fix and
 * the documented recovery sequence.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type Stats,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
// F1/F2/F3: `bun run typecheck`/`bun test`/`bun run lint` all pass with
// this import only because of `./sql.d.ts`'s ambient `*.sql` declaration
// -- see that file's own comment.
import schema from "./schema.sql" with { type: "text" };
import { CanKanError } from "../errors";
import { IndexErrorCodes } from "./errors";

/**
 * Bumped whenever `schema.sql`'s shape changes in a way an old cache file
 * cannot be read under. A file whose `PRAGMA user_version` does not equal
 * this constant is discarded and rebuilt (`"schema-version-mismatch"`) --
 * in **either** direction: an older build's file (a lower value) and a
 * newer build's file (a higher value, e.g. read by a downgraded binary)
 * both degrade, never only one of them. `db.ts`'s probe compares with
 * `!==`, never against a list of known-bad values (M2.5's deny-list
 * lesson).
 */
export const INDEX_SCHEMA_VERSION = 1;

/** Options for `openIndex`. */
export interface OpenIndexOptions {
  /**
   * Opaque board key -- see the file comment's R2 note. **MUST be
   * single-sourced from `adapter.gitCommonDir()`** (already
   * symlink-resolved by `git/`, M2.6) -- the same shape M2.7's
   * `boardKeyFor` uses. `index/` cannot import `boardKeyFor` itself (R1),
   * so this doc comment carries the obligation instead: deriving a board
   * key any other way (building one from `$HOME`/`$TMPDIR`/a config path
   * yourself, say) is the D20 macOS path-asymmetry defect -- invisible on
   * Linux, real on macOS, and not this module's to reintroduce. The empty
   * string is rejected (`INDEX_INVALID_BOARD_KEY`) rather than silently
   * accepted, since it would collapse every board onto one cache file.
   *
   * This value is SHA-256'd to hex before it ever reaches the filesystem
   * (`indexPathFor`), so no caller-controlled text ever lands in a path
   * segment -- traversal is impossible by construction, not by
   * sanitising, and it is never compared against any other path (R2: the
   * only path this module ever constructs is the cache file's own path,
   * and it is only ever opened, never diffed against a `GitAdapter`
   * result or anything else).
   */
  readonly boardKey: string;
  /**
   * Defaults to `process.env`. Injectable so a test can be explicit about
   * exactly which XDG variables are in play, the same pattern
   * `config/layers.ts`'s `resolveGlobalConfigPath` and
   * `events/observations.ts`'s `resolveStateDir` use.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Why `openIndex` discarded whatever was on disk and rebuilt from an
 * empty schema. `rebuilt: false` means none of these applied and the
 * caller is holding a file whose contents can be trusted (subject to
 * `INDEX_NOT_BUILT` still applying if it was never reindexed at all --
 * this reason set is about the *file*, not about whether `reindex()` has
 * run since).
 */
export type IndexDiscardReason =
  | "missing"
  | "not-a-regular-file"
  | "unreadable"
  | "corrupt"
  | "schema-version-mismatch"
  | "board-key-mismatch";

/** A live handle onto one board's SQLite index cache. */
export interface BoardIndex {
  /** The `bun:sqlite` handle. Callers use this directly for `reindex()`/`queryTickets()`/`queryBoardState()`. */
  readonly db: Database;
  /** Absolute path to the index file on disk. Never compared against any other path (R2) -- informational only. */
  readonly path: string;
  /** Echoed back from `OpenIndexOptions.boardKey`. */
  readonly boardKey: string;
  /**
   * `false` -- the file on disk had usable, matching-board, current-schema
   * contents. `true` -- it was discarded and (re)created with an empty
   * schema; the caller **must** call `reindex()` before querying, or
   * `queryTickets`/`queryBoardState` will throw `INDEX_NOT_BUILT` rather
   * than silently answer "empty board" (controller addendum A1).
   */
  readonly rebuilt: boolean;
  /** Why it was rebuilt. `undefined` iff `rebuilt === false`. */
  readonly discardReason: IndexDiscardReason | undefined;
  /** Closes the underlying `bun:sqlite` handle. */
  close(): void;
}

/**
 * `$XDG_CACHE_HOME`, defaulting to `$HOME/.cache` when unset, empty, or
 * itself relative. **Reimplemented here rather than imported**, on
 * purpose: `board/xdg.ts`'s `resolveDataHome` establishes exactly this
 * rule for `$XDG_DATA_HOME` (as does `config/layers.ts`'s
 * `resolveGlobalConfigPath` for `$XDG_CONFIG_HOME`, and
 * `events/observations.ts`'s `resolveStateDir` for `$XDG_STATE_HOME`),
 * but R1 forbids `index/` from importing `board/` at all -- so the
 * four-line rule is duplicated locally rather than shared, the same way
 * `events/observations.ts` already duplicates it rather than reaching
 * into `board/`. A relative `XDG_CACHE_HOME` is ignored, never used
 * cwd-relative -- two invocations from different working directories
 * must resolve to the same cache file.
 */
function resolveCacheHome(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const xdgCacheHome = env.XDG_CACHE_HOME;
  const cacheHome =
    xdgCacheHome !== undefined && xdgCacheHome.length > 0 && isAbsolute(xdgCacheHome)
      ? xdgCacheHome
      : join(env.HOME ?? "", ".cache");
  return isAbsolute(cacheHome) ? cacheHome : undefined;
}

/**
 * The absolute path `openIndex` will open for a given `boardKey`:
 * `<cacheHome>/cankan/<sha256hex(boardKey)>.db`. Exported so a caller (or
 * a test) can locate the file without duplicating the hashing/XDG rule,
 * and so `openIndex` itself has one place to get it from.
 */
export function indexPathFor(
  boardKey: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (boardKey.length === 0) {
    throw new CanKanError(
      IndexErrorCodes.INVALID_BOARD_KEY,
      "boardKey must not be the empty string -- an empty key would collapse every board onto one cache file",
    );
  }
  const cacheHome = resolveCacheHome(env);
  if (cacheHome === undefined) {
    throw new CanKanError(
      IndexErrorCodes.CACHE_DIR_UNAVAILABLE,
      "could not resolve a cache directory: neither $XDG_CACHE_HOME nor $HOME yielded an absolute path",
    );
  }
  const hash = createHash("sha256").update(boardKey, "utf8").digest("hex");
  return join(cacheHome, "cankan", `${hash}.db`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Removes the index file and every sidecar a build of this module could
 * have left behind: `-wal`/`-shm` are **WAL-mode** sidecars (fix round 1,
 * code-review Minor M1 -- the previous comment here called them
 * "rollback-journal-mode sidecars," which is backwards: rollback journal
 * mode, the mode this module actually uses per R5, produces `-journal`,
 * not `-wal`/`-shm`; this module never sets `PRAGMA journal_mode = WAL`
 * itself, but an older or differently-configured build might have).
 * `-journal` is added here too (fix round 1, S4/code-review M2) purely to
 * match R5's stated intent that no build, old or new, can leave a stale
 * sidecar behind -- **not** because a planted `-journal` is exploitable.
 * The security reviewer tried four ways to make a symlinked `-journal`
 * write through to a victim file (a real `reindex` write transaction,
 * against both an empty and a 690-byte victim, with a healthy index and a
 * live handle) and every one was refused with `SQLITE_CANTOPEN`: SQLite
 * opens the rollback journal exclusive-create, so it neither follows nor
 * reuses an existing path at `<db>-journal`. That is a SQLite property,
 * not something this module enforces -- recorded here so the negative
 * result is not re-litigated.
 */
function removeIndexFileAndSidecars(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-journal`, { force: true });
}

/**
 * `chmod(dir, 0o700)` by path would resolve `dir`'s own path and, if a
 * symlink now sits there, follow it -- moving the *target's* mode, not a
 * directory this module actually owns. Mirrors
 * `events/observations.ts`'s `tightenDirPermissions` (fix round 3 there,
 * Minor 3), reimplemented as the synchronous `node:fs` equivalent since
 * R1 forbids importing `events/`: `open(dir, O_DIRECTORY | O_NOFOLLOW)`
 * refuses a symlink outright (`ENOTDIR` -- `O_DIRECTORY` requires the
 * target to already be a directory, and `O_NOFOLLOW` refuses to resolve
 * one to find out), and once open, the descriptor names a specific inode
 * with no further path left to re-resolve -- so `ensurePrivateCacheDir`'s
 * own `lstat` and this `fchmod` provably name the same thing.
 */
function tightenCacheDirPermissions(dir: string): void {
  const fd = openSync(dir, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/**
 * Confirms `dir` (the `<cacheHome>/cankan` directory) is a genuine
 * directory -- never a symlink, even a symlink-to-directory, since
 * `lstat` reports the entry itself and never follows it -- owned by the
 * current user, with no group/other access bits, creating it (mode
 * `0o700`) if nothing is there yet. Fix round 1, S1 (Important),
 * mirroring `events/observations.ts`'s `ensurePrivateDir` (fix round 2
 * there, Ruling R37, findings H1/M1) -- reimplemented locally rather than
 * imported (R1) with this file's header comment carrying the duplication
 * rationale.
 *
 * **Two gaps this closes, both verified directly against the previous
 * `mkdirSync(cacheDir, { recursive: true, mode: 0o700 })`-only sequence:**
 * `mkdir` never chmods an *existing* directory, so a `cankan` directory a
 * vulnerable build (or a local attacker) left at `0o777` stayed `0o777`
 * forever -- closed below by the post-`mkdir` ownership+mode check,
 * which runs whether this call just created the directory or found it
 * already there. `mkdirSync(recursive)` does not `lstat` first and
 * resolves through a symlink when checking what already exists, so a
 * `cankan` **symlinked** to an attacker's directory made the index land
 * inside that directory with no error -- closed below by `lstat`ing
 * *before* ever calling `mkdir`, and refusing outright (never following,
 * never silently redirecting) when something that is not a plain
 * directory is already there.
 *
 * Scoped to the `cankan` directory only, **never `$XDG_CACHE_HOME`
 * itself** -- matching `ensurePrivateDir`'s own stated remit. Fix round 2:
 * the previous wording here claimed this module "does not create
 * `$XDG_CACHE_HOME`," which is false -- `mkdirSync(dir, { recursive: true,
 * mode: 0o700 })` above creates `$XDG_CACHE_HOME` as a side effect of one
 * recursive syscall whenever it is absent, the same way
 * `events/observations.ts`'s `ensurePrivateDir` creates its own
 * XDG-conventional parents (that file's own comment on its `mkdir` call).
 * What is actually true, mirroring that comment's honesty: the
 * parent is created, but it is not separately `lstat`ed, owned-checked, or
 * mode-tightened by this function -- only the `cankan` directory itself is.
 * That is not a scope violation; it is the same harmless side effect
 * `observations.ts` already accepts, since applying `mode: 0o700` to a
 * parent as part of the one recursive `mkdir` call is no worse than not
 * creating it at all, and this function has no separate remit over
 * whatever else already lives under `$XDG_CACHE_HOME`.
 *
 * **One TOCTOU window is disclosed, not claimed closed, mirroring
 * `ensurePrivateDir`'s own honesty about its analogous window**: between
 * the pre-`mkdir` `lstat` finding nothing and `mkdirSync` actually
 * running, a same-user attacker could in principle plant a symlink there
 * first. Re-checked with a second `lstat` immediately after `mkdirSync`
 * (below) rather than assumed safe, so this window is caught, not merely
 * narrowed -- but the check-then-act gap between the two calls is real
 * and untested (isolating a single-syscall race from outside this
 * function is not practical), the same disclosure `ensurePrivateDir`
 * makes about its own `mkdir`.
 *
 * **Ruling R41 disclosure, carried forward verbatim from
 * `observations.ts`: on a runtime with no `process.getuid` (Windows),
 * this whole check does not run, and the property it enforces is
 * UNMITIGATED, not merely relaxed.** There is no POSIX uid/mode model to
 * check against there, so both halves of this function -- the ownership
 * check and the mode-tightening `chmod` that exists only to enforce the
 * same ownership property -- fall away together. A world-writable cache
 * directory with a planted file is not caught on such a runtime. Windows
 * is not in this project's supported-platform list today (no
 * `engines`/`os` field, no CI job for it) -- this is not a defect to fix
 * now, but whoever adds Windows support inherits this obligation, not the
 * false assumption that "no uid to check" merely means "less strict".
 */
function ensurePrivateCacheDir(dir: string): void {
  let existing: Stats | undefined;
  try {
    existing = lstatSync(dir);
  } catch (cause) {
    if (!(isErrnoException(cause) && cause.code === "ENOENT")) {
      throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not inspect the index cache directory", {
        cause,
      });
    }
  }
  if (existing !== undefined && !existing.isDirectory()) {
    // A symlink (to a directory or to anything else), a plain file, a
    // FIFO -- `lstat` never resolves it, so this is what actually catches
    // the symlinked-`cankan`-directory attack (`mkdirSync(recursive)`
    // alone does not: it stats through the symlink and no-ops).
    throw new CanKanError(
      IndexErrorCodes.CACHE_PATH_UNAVAILABLE,
      "the index cache directory's path is occupied by something other than a plain directory",
    );
  }
  try {
    // Safe to call unconditionally now: either nothing is there
    // (`existing === undefined`) or `existing` is already a genuine
    // directory, so `recursive: true` is a no-op rather than a path this
    // function has not already validated.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not create the index cache directory", {
      cause,
    });
  }
  let stat: Stats;
  try {
    stat = lstatSync(dir);
  } catch (cause) {
    // Fix round 2: this re-check `lstat` was unwrapped -- reachable if the
    // directory is removed, or the parent loses `x`, in the window between
    // the `mkdirSync` above and this line, letting a raw `ENOENT`/`EACCES`
    // `ErrnoException` escape `openIndex` untyped. Wrapped the same as the
    // pre-`mkdir` `lstat` above, for the same reason: every other syscall
    // in this file routes into a `CanKanError`.
    throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not inspect the index cache directory", {
      cause,
    });
  }
  if (!stat.isDirectory()) {
    // A genuine TOCTOU window (disclosed, not claimed closed elsewhere in
    // this function's doc comment): between the pre-`mkdir` `lstat`
    // above finding nothing and this line, a same-user attacker could in
    // principle have replaced the path with a symlink that `mkdirSync`'s
    // own EEXIST handling (which `stat`s, not `lstat`s, an already-
    // existing entry to decide whether "already a directory" applies)
    // could silently accept. Re-checked with `lstat` here, never assumed
    // from the pre-`mkdir` check alone.
    throw new CanKanError(
      IndexErrorCodes.CACHE_PATH_UNAVAILABLE,
      "the index cache directory's path is occupied by something other than a plain directory",
    );
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    // Ruling R41 (see this function's doc comment): unmitigated here, not
    // merely skipped.
    return;
  }
  if (stat.uid !== uid) {
    throw new CanKanError(
      IndexErrorCodes.CACHE_PATH_UNAVAILABLE,
      "the index cache directory is not owned by the current user",
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    try {
      tightenCacheDirPermissions(dir);
    } catch (cause) {
      throw new CanKanError(
        IndexErrorCodes.CACHE_PATH_UNAVAILABLE,
        "could not restrict the index cache directory's permissions",
        { cause },
      );
    }
  }
}

/**
 * The F4/F5 probe (see this file's header comment for the four-step
 * rationale). Returns the `IndexDiscardReason` to rebuild for, or
 * `undefined` if the file's contents check out for this `boardKey`.
 */
function probe(db: Database, boardKey: string): IndexDiscardReason | undefined {
  let userVersion: number;
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    userVersion = row?.user_version ?? 0;
  } catch {
    // F4: garbage bytes -- the first query against the handle is where
    // "file is not a database" actually throws, never `new Database(...)`.
    return "corrupt";
  }
  if (userVersion !== INDEX_SCHEMA_VERSION) {
    // F5: a zero-byte file reports `user_version` 0 here, which is
    // (barring a coincidental `INDEX_SCHEMA_VERSION` of 0, which this
    // module never sets) always unequal to the real schema version. This
    // is the step that actually catches F5, not step (c) below
    // (controller addendum A3). Checked with `!==`, never a list of
    // known-bad values (M2.5's deny-list lesson) -- catches an *older*
    // build's file and a *newer* build's file alike.
    return "schema-version-mismatch";
  }
  let metaRow: { value: string } | null;
  try {
    metaRow = db.query("SELECT value FROM cankan_meta WHERE key = 'board_key'").get() as { value: string } | null;
  } catch {
    // Defense in depth for a file that reports the right `user_version`
    // but has no `cankan_meta` table at all -- e.g. a rebuild that was
    // interrupted between `PRAGMA user_version = N` and seeding this
    // table.
    return "corrupt";
  }
  if (metaRow === null) {
    return "corrupt";
  }
  if (metaRow.value !== boardKey) {
    // A stale file from a different board, or a SHA-256 collision on the
    // hashed path -- either way this file must never answer for a board
    // it was not built from.
    return "board-key-mismatch";
  }
  return undefined;
}

/** Runs the DDL, sets the schema-version pragma, and seeds `cankan_meta`'s `schema_version`/`board_key` rows against a fresh (or just-discarded-and-recreated) handle. */
function initializeSchema(db: Database, boardKey: string): void {
  db.exec(schema);
  // `INDEX_SCHEMA_VERSION` is this module's own compile-time constant,
  // never caller input -- safe to inline into the pragma text (`bun:sqlite`
  // does not support a bound parameter in `PRAGMA ... = ?` position).
  db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
  const upsertMeta = db.prepare(
    "INSERT INTO cankan_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  upsertMeta.run("schema_version", String(INDEX_SCHEMA_VERSION));
  upsertMeta.run("board_key", boardKey);
}

/**
 * Opens (creating if necessary) the SQLite index cache for `options.boardKey`.
 *
 * **Never throws because of the file's own contents** -- see this file's
 * header comment. It may only throw for a genuinely unusable environment:
 * no resolvable cache directory (`INDEX_CACHE_DIR_UNAVAILABLE`), a
 * `mkdir`/`lstat`/`unlink` failure that is not "does not exist"
 * (`INDEX_CACHE_PATH_UNAVAILABLE`), a directory sitting at the index
 * file's own path (`INDEX_CACHE_PATH_IS_DIRECTORY` -- refused loudly
 * rather than recursively deleted), or an empty `boardKey`
 * (`INDEX_INVALID_BOARD_KEY`).
 *
 * The open sequence (F4/F5-aware):
 * 1. `ensurePrivateCacheDir` the cache directory (fix round 1, S1): create
 *    it (mode `0o700`) if absent, refuse outright if something that is
 *    not a plain directory is already there (never following a symlink),
 *    and otherwise confirm/tighten its ownership and mode -- see that
 *    function's own doc comment.
 * 2. `lstat` (never `stat` -- never follow) the index file's path.
 *    - Nothing there (`ENOENT`): proceed to create fresh, discard reason
 *      `"missing"`.
 *    - A directory: thrown loudly (`INDEX_CACHE_PATH_IS_DIRECTORY`),
 *      never recursively deleted.
 *    - Anything else that is not a regular file (a symlink, FIFO, or
 *      socket -- the local-attacker case: a symlink planted at this
 *      predictable, SHA-256'd path, opened in read-write `create` mode,
 *      would let SQLite truncate and overwrite a file the caller does not
 *      own): unlinked (removing the link/special file itself, never
 *      following it), discard reason `"not-a-regular-file"`.
 *    - A regular file: proceed to probe it.
 * 3. `new Database(path, { create: true })`.
 * 4. If step 2 already decided a discard reason, skip straight to
 *    rebuilding. Otherwise run `probe()` (F4/F5's four-step check) against
 *    the opened handle.
 * 5. If a discard reason applies: close the handle, remove the file and
 *    its `-wal`/`-shm` sidecars (R5), reopen with `create: true`, run the
 *    DDL, set the schema-version pragma, seed `cankan_meta`. Return
 *    `rebuilt: true` with the reason.
 * 6. Otherwise return `rebuilt: false`.
 */
export function openIndex(options: OpenIndexOptions): BoardIndex {
  const env = options.env ?? process.env;
  const path = indexPathFor(options.boardKey, env);
  const cacheDir = dirname(path);

  ensurePrivateCacheDir(cacheDir);

  let preflightReason: IndexDiscardReason | undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) {
      if (st.isDirectory()) {
        throw new CanKanError(
          IndexErrorCodes.CACHE_PATH_IS_DIRECTORY,
          "a directory exists at the index cache's path -- refusing to delete it",
        );
      }
      // A symlink, FIFO, or socket -- unlink the entry itself (never
      // follow it) and rebuild through it.
      unlinkSync(path);
      preflightReason = "not-a-regular-file";
    }
  } catch (cause) {
    if (cause instanceof CanKanError) {
      throw cause;
    }
    if (isErrnoException(cause) && cause.code === "ENOENT") {
      preflightReason = "missing";
    } else {
      throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not inspect the index cache's path", {
        cause,
      });
    }
  }

  // **Necessary-but-insufficient, not "safe" (fix round 1, code-review
  // Minor: this comment previously undersold the risk by only
  // considering a cooperating second `openIndex()`).** This function has
  // three unlink-then-recreate windows -- this one (`lstatSync`
  // throwing `ENOENT`, or the `unlinkSync` calls a few lines above and
  // below this one), each followed eventually by a fresh
  // `new Database(path, { create: true })`. Between an `unlink` and the
  // next open, a local attacker who can write this directory can
  // re-plant a symlink, and `bun:sqlite` exposes no `O_NOFOLLOW`/
  // `O_EXCL` open flag to refuse it -- `create: true`'s `O_CREAT`
  // without `O_EXCL` follows whatever is there. Demonstrated directly
  // (security review, `e2.ts` case E3b): an empty victim file became a
  // 60 KB cankan database, and a foreign SQLite file kept its own table
  // but had all five `cankan_*` tables grafted onto it and its
  // `user_version` forced from 42 to 1. **This window is closed at the
  // root by `ensurePrivateCacheDir` above, not by narrowing the race
  // here**: only a process that already owns the exclusive-mode
  // (`0o700`, this-user-only) `cankan` directory can write into it at
  // all, so there is no other local user left who could win a race
  // against these few lines in the first place.
  let db: Database;
  try {
    db = new Database(path, { create: true });
  } catch (cause) {
    if (preflightReason !== undefined) {
      // Already committed to discarding (missing/not-a-regular-file) and
      // even a fresh `create: true` open failed -- a genuine environment
      // problem (e.g. the cache directory itself became unwritable
      // between the `mkdir` above and here), not a degrade case.
      throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not create the index cache file", {
        cause,
      });
    }
    // The file passed the "is it a regular file" check above but
    // `bun:sqlite` still could not open it -- e.g. its own permission
    // bits deny us read/write, whatever `lstat` reported. Recoverable
    // exactly like any other bad-file case: this process owns the
    // `0o700` cache *directory*, so it can unlink the offending file
    // regardless of the file's own permissions (Unix deletion is gated
    // by the containing directory's write bit, not the file's), and
    // rebuild through it -- `"unreadable"`, never a hard failure.
    try {
      unlinkSync(path);
    } catch (unlinkCause) {
      throw new CanKanError(
        IndexErrorCodes.CACHE_PATH_UNAVAILABLE,
        "the index cache file could not be opened or removed",
        { cause: unlinkCause },
      );
    }
    preflightReason = "unreadable";
    db = new Database(path, { create: true });
  }

  const discardReason = preflightReason ?? probe(db, options.boardKey);

  if (discardReason === undefined) {
    return { db, path, boardKey: options.boardKey, rebuilt: false, discardReason: undefined, close: () => db.close() };
  }

  db.close();
  let rebuiltDb: Database;
  try {
    // Fix round 2 (unbriefed -- found while testing item 2, same defect
    // class): this discard-and-rebuild step's own `removeIndexFileAndSidecars`
    // call was unwrapped since the very first commit (`f910f6b`), not only
    // since fix round 1 -- verified against `git show f910f6b`. Reachable
    // without any attacker at all: a plain directory landing at `<path>-wal`
    // (a confused prior run, say) makes SQLite refuse to open the otherwise
    // healthy main file at all (`SQLITE_CANTOPEN`), `probe()`'s catch-all
    // maps that to `"corrupt"`, and this step then tried to sweep a sidecar
    // that is a directory -- throwing a raw `ERR_FS_EISDIR` straight out of
    // `openIndex`, in direct violation of this function's own doc comment
    // ("a mkdir/lstat/unlink failure ... INDEX_CACHE_PATH_UNAVAILABLE").
    // Wrapped with the same shape `rebuildIndex` uses (rm + reopen + schema
    // in one try) for parity between this module's two discard-and-rebuild
    // call sites, not just the rm call alone.
    removeIndexFileAndSidecars(path);
    rebuiltDb = new Database(path, { create: true });
    initializeSchema(rebuiltDb, options.boardKey);
  } catch (cause) {
    throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not discard and rebuild the index cache file", {
      cause,
    });
  }

  return {
    db: rebuiltDb,
    path,
    boardKey: options.boardKey,
    rebuilt: true,
    discardReason,
    close: () => rebuiltDb.close(),
  };
}

/**
 * True for an error shaped like SQLite reporting on-disk corruption that
 * `openIndex`'s open-time probe could not have caught -- the probe only
 * ever reads page 1 (this file's header comment), so damage confined to
 * a page holding `tickets`/`ticket_aliases`/`ticket_deps` rows surfaces
 * later, on whatever query or write first touches it. Checked by
 * `bun:sqlite`'s own `.code` first (confirmed directly:
 * `SQLITE_CORRUPT` for a torn page, `SQLITE_NOTADB` for a file that is
 * not a database at all), and the "malformed"/"not a database" message
 * text as a fallback for a `bun:sqlite` version that does not attach a
 * `.code`.
 *
 * **Exported (not re-exported from `index.ts`) so `query.ts` and
 * `reindex.ts` -- the two call sites that can hit this after the probe
 * has already passed -- map it to the same `IndexErrorCodes.CORRUPT`
 * rather than two independently-drifting checks.** `query.ts` additionally
 * treats a `SyntaxError` (a malformed `dep_json` value failing
 * `JSON.parse`) the same way -- that is this module's own write having
 * been corrupted, not a programming error, even though it is not a
 * `bun:sqlite` error at all.
 */
export function isIndexCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }
  return /database disk image is malformed|file is not a database/i.test(error.message);
}

/**
 * The recovery primitive for `IndexErrorCodes.CORRUPT` (fix round 1, S2)
 * -- closes `index`'s handle, removes the index file and its sidecars
 * (R5), reopens a brand-new file at the same path, and runs the DDL
 * against it. Returns a fresh, empty, **`rebuilt: true` /
 * `discardReason: "corrupt"`** `BoardIndex` the caller must `reindex()`
 * before querying (`INDEX_NOT_BUILT` otherwise, same as any other freshly
 * rebuilt index).
 *
 * **Lives in `db.ts`, not `query.ts` or `reindex.ts`, because recovery
 * has to route back through the file-level owner.** `reindex.ts` holds
 * only a `Database` handle inside `BoardIndex` -- it cannot discard and
 * recreate the file underneath itself, and self-healing by silently
 * rebuilding *inside* a query would return an empty result for a board
 * that may hold thousands of tickets, a wrong answer, not merely a stale
 * one (the exact failure mode `openIndex`'s own "index is a cache" rule
 * exists to rule out). Recovery is therefore explicit, not automatic:
 *
 * ```
 * try {
 *   return queryTickets(index, query);
 * } catch (error) {
 *   if (isCanKanError(error) && error.code === IndexErrorCodes.CORRUPT) {
 *     index = rebuildIndex(index);
 *     reindex({ index, state });   // caller's own already-folded state
 *     return queryTickets(index, query);
 *   }
 *   throw error;
 * }
 * ```
 *
 * Keeping the rebuild explicit (rather than hiding it inside a query or a
 * probe-time `PRAGMA quick_check`, both considered and rejected during
 * fix round 1) also matters for M2.15 (#38): that lane needs to know the
 * index was discarded because whatever invalidation state it had stored
 * went with it, which an implicit, invisible rebuild would hide.
 */
export function rebuildIndex(index: BoardIndex): BoardIndex {
  // Fix round 2, ruling: `openIndex` already verified this directory when
  // it produced the handle `index` was opened from, and the only window
  // left is the one this file's `new Database(...)` comment already
  // concedes (an unlink-then-recreate gap) -- just held open longer here,
  // since `rebuildIndex` can run seconds after that original check. Calling
  // `ensurePrivateCacheDir` again restores exact parity with `openIndex`'s
  // own open sequence and trades a subtle argument about window duration
  // for one extra `lstat` -- the right cost for a recovery path that may
  // run long after the original check, not a correctness fix for a bug
  // that was otherwise reachable.
  ensurePrivateCacheDir(dirname(index.path));
  try {
    index.db.close();
  } catch {
    // Already closed, or close itself failed -- either way there is
    // nothing more this function can do with the old handle, and
    // `removeIndexFileAndSidecars` below does not need it open.
  }
  let db: Database;
  try {
    // Fix round 2: `removeIndexFileAndSidecars` used to sit outside this
    // try. `rmSync(force: true)` swallows `ENOENT` but still throws for a
    // **directory** at `<db>-wal`/`-shm`/`-journal` (`ERR_FS_EISDIR`) and
    // for `EACCES` -- which used to escape `rebuildIndex` raw, breaking
    // `openIndex`'s own declared contract (this file's doc comment above,
    // "a `mkdir`/`lstat`/`unlink` failure ... `INDEX_CACHE_PATH_UNAVAILABLE`").
    // `openIndex`'s own discard-and-rebuild step (this file's doc comment,
    // step 5) had the identical gap since the very first commit, not only
    // this call site -- both are now wrapped the same way, see that step's
    // own comment for the case that surfaced it.
    removeIndexFileAndSidecars(index.path);
    db = new Database(index.path, { create: true });
    initializeSchema(db, index.boardKey);
  } catch (cause) {
    throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not rebuild the index cache file", {
      cause,
    });
  }
  return {
    db,
    path: index.path,
    boardKey: index.boardKey,
    rebuilt: true,
    discardReason: "corrupt",
    close: () => db.close(),
  };
}
