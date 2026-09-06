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
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
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

/** Removes the index file and any rollback-journal-mode sidecars it may have left (R5: this module never sets WAL itself, but an older or differently-configured build might have). */
function removeIndexFileAndSidecars(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
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
 * 1. `mkdir` the cache directory recursively, mode `0o700`.
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

  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new CanKanError(IndexErrorCodes.CACHE_PATH_UNAVAILABLE, "could not create the index cache directory", {
      cause,
    });
  }

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

  // `create: true` is safe even when `preflightReason === "missing"` was
  // just determined by `lstatSync` throwing `ENOENT`: nothing raced to
  // create a *directory* there between the two calls except another
  // cooperating `openIndex()` writing the same file, which this module
  // does not defend against (single-process, single-board cache; the
  // same non-goal every other module's cache-style store in this
  // codebase carries).
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
  removeIndexFileAndSidecars(path);
  const rebuiltDb = new Database(path, { create: true });
  initializeSchema(rebuiltDb, options.boardKey);

  return {
    db: rebuiltDb,
    path,
    boardKey: options.boardKey,
    rebuilt: true,
    discardReason,
    close: () => rebuiltDb.close(),
  };
}
