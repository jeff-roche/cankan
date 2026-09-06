import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { isCanKanError } from "../../src/errors";
import { INDEX_SCHEMA_VERSION, indexPathFor, openIndex, rebuildIndex } from "../../src/index/db";
import { IndexErrorCodes } from "../../src/index/errors";
import { reindex } from "../../src/index/reindex";
// `@jeff-roche/cankan-test-utils` is not a declared dependency of
// `packages/core/package.json` (only `packages/cli` depends on it) --
// see `git.test.ts`'s own comment for why this is a relative import to
// the source file rather than the package specifier.
import { withEnv } from "../../../test-utils/src/withEnv";
import { sentinelState } from "./testHelpers";

/** Every test in this file touches an `$XDG_CACHE_HOME`/`$HOME` path -- global constraint 10 requires `withEnv()` around every one of them. R2 also means: no `makeTempRepo()` here -- an opaque, hand-picked `boardKey` string is the correct fixture, never a path built from a git repo. */

const BOARD_KEY = "opaque-board-key-fixture";

/** Opens, reindexes with `sentinelState()`, and closes -- leaves a real, healthy index file on disk for a degradation test to then corrupt. Returns the file's path. */
function buildRealIndexFile(boardKey: string): string {
  const index = openIndex({ boardKey });
  reindex({ index, state: sentinelState() });
  const path = index.path;
  index.close();
  return path;
}

/** Counts rows in `tickets` directly against a raw handle -- bypasses `queryTickets` (which would throw `INDEX_NOT_BUILT` right after a fresh rebuild) so a degradation test can prove the sentinel row is actually gone, not merely that nothing threw. */
function countTicketRows(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) as c FROM tickets").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe("indexPathFor", () => {
  test("throws INDEX_INVALID_BOARD_KEY for an empty boardKey", () => {
    expect(() => indexPathFor("", { HOME: "/home/u" })).toThrow();
    try {
      indexPathFor("", { HOME: "/home/u" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(isCanKanError(error)).toBe(true);
      expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.INVALID_BOARD_KEY);
    }
  });

  test("is <cacheHome>/cankan/<sha256hex(boardKey)>.db, deterministic for the same boardKey", async () => {
    await withEnv(undefined, () => {
      const path1 = indexPathFor(BOARD_KEY, process.env);
      const path2 = indexPathFor(BOARD_KEY, process.env);
      expect(path1).toBe(path2);
      expect(path1.endsWith(".db")).toBe(true);
      expect(path1).toContain(`cankan${sep}`);
      // sha256("opaque-board-key-fixture") — a fixed, independently
      // computable digest, not just "some 64-hex-char string".
      const expectedHash = createHash("sha256").update(BOARD_KEY, "utf8").digest("hex");
      expect(path1.endsWith(`${expectedHash}.db`)).toBe(true);
    });
  });

  test("two different boardKeys hash to two different paths", async () => {
    await withEnv(undefined, () => {
      const pathA = indexPathFor("board-a", process.env);
      const pathB = indexPathFor("board-b", process.env);
      expect(pathA).not.toBe(pathB);
    });
  });

  test("a relative $XDG_CACHE_HOME is ignored, not used cwd-relative -- falls back to $HOME/.cache", async () => {
    await withEnv({ XDG_CACHE_HOME: "relative/cache/dir" }, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      expect(path.startsWith(join(process.env.HOME ?? "", ".cache", "cankan"))).toBe(true);
    });
  });

  test("throws INDEX_CACHE_DIR_UNAVAILABLE when neither $XDG_CACHE_HOME nor $HOME yields an absolute path", () => {
    try {
      indexPathFor(BOARD_KEY, { HOME: "", XDG_CACHE_HOME: "" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(isCanKanError(error)).toBe(true);
      expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CACHE_DIR_UNAVAILABLE);
    }
  });
});

describe("openIndex -- missing file", () => {
  test("a fresh cache home with nothing on disk rebuilds with reason 'missing'", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("missing");
        expect(index.boardKey).toBe(BOARD_KEY);
        // A working, freshly-built schema -- not just "did not throw".
        const metaRow = index.db.query("SELECT value FROM cankan_meta WHERE key = 'board_key'").get() as {
          value: string;
        };
        expect(metaRow.value).toBe(BOARD_KEY);
        const versionRow = index.db.query("PRAGMA user_version").get() as { user_version: number };
        expect(versionRow.user_version).toBe(INDEX_SCHEMA_VERSION);
      } finally {
        index.close();
      }
    });
  });

  test("mkdir's the cache directory with mode 0o700", async () => {
    await withEnv(undefined, () => {
      const index = openIndex({ boardKey: BOARD_KEY });
      index.close();
      const cacheDir = join(index.path, "..");
      const st = statSync(cacheDir);
      expect(st.mode & 0o777).toBe(0o700);
    });
  });
});

describe("openIndex -- fix round 1, S1: the cache DIRECTORY's ownership/exclusivity, not just the file inside it", () => {
  test("a pre-existing 0o777 cankan directory is tightened to 0o700, not left as-is (e7.ts: mkdir never chmods an existing directory)", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      const cacheDir = join(path, "..");
      mkdirSync(cacheDir, { recursive: true });
      chmodSync(cacheDir, 0o777);
      expect(statSync(cacheDir).mode & 0o777).toBe(0o777); // fixture sanity

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        // Never throws for this -- a lax pre-existing directory this
        // process owns is fixed in place, not refused.
        expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
      } finally {
        index.close();
      }
    });
  });

  test("a cankan directory that is a symlink to an attacker's directory is refused, never followed (e2.ts E5: mkdir(recursive) alone stats through the symlink and no-ops)", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      const cacheDir = join(path, "..");
      mkdirSync(join(cacheDir, ".."), { recursive: true });
      const evilDir = mkdtempSync(join(tmpdir(), "cankan-evil-"));
      symlinkSync(evilDir, cacheDir);

      try {
        openIndex({ boardKey: BOARD_KEY });
        throw new Error("expected a throw");
      } catch (error) {
        expect(isCanKanError(error)).toBe(true);
        expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CACHE_PATH_UNAVAILABLE);
      }
      // Nothing landed inside the attacker's directory.
      expect(existsSync(join(evilDir, `${createHash("sha256").update(BOARD_KEY, "utf8").digest("hex")}.db`))).toBe(
        false,
      );
    });
  });
});

describe("openIndex -- a healthy, already-built file reopens without rebuilding", () => {
  test("rebuilt is false and the reindexed contents survive the reopen", async () => {
    await withEnv(undefined, () => {
      const first = openIndex({ boardKey: BOARD_KEY });
      reindex({ index: first, state: sentinelState() });
      first.close();

      const second = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(second.rebuilt).toBe(false);
        expect(second.discardReason).toBeUndefined();
        expect(countTicketRows(second.path)).toBe(1);
      } finally {
        second.close();
      }
    });
  });
});

describe("openIndex -- a directory sitting at the index path is refused loudly", () => {
  test("throws INDEX_CACHE_PATH_IS_DIRECTORY rather than deleting the directory", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      mkdirSync(join(path, ".."), { recursive: true });
      mkdirSync(path);
      writeFileSync(join(path, "do-not-delete-me.txt"), "victim content");

      try {
        openIndex({ boardKey: BOARD_KEY });
        throw new Error("expected a throw");
      } catch (error) {
        expect(isCanKanError(error)).toBe(true);
        expect(isCanKanError(error) && error.code).toBe(IndexErrorCodes.CACHE_PATH_IS_DIRECTORY);
      }
      // The directory (and the file inside it) must still be there.
      expect(readFileSync(join(path, "do-not-delete-me.txt"), "utf8")).toBe("victim content");
    });
  });
});

describe("openIndex -- degradation, each case builds a real db then corrupts it", () => {
  test("garbage bytes at the db path rebuild (reason: corrupt), and R5's -wal/-shm sidecars are removed with it", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "not a sqlite file at all, just some bytes\0\0\0garbage");
      // R5: this module never sets WAL itself, but must still clean up a
      // sidecar an older or differently-configured build left behind --
      // simulate that by planting the two files by hand.
      writeFileSync(`${path}-wal`, "stale wal sidecar");
      writeFileSync(`${path}-shm`, "stale shm sidecar");

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("corrupt");
        expect(countTicketRows(path)).toBe(0);
        expect(existsSync(`${path}-wal`)).toBe(false);
        expect(existsSync(`${path}-shm`)).toBe(false);
      } finally {
        index.close();
      }
    });
  });

  test("truncated to exactly 0 bytes rebuilds (F5 -- PRAGMA user_version/integrity_check both call this healthy; only the schema-version check catches it)", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      expect(countTicketRows(path)).toBe(1); // sentinel present before corruption
      truncateSync(path, 0);

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        // Controller addendum A3: do not pin an exact reason here --
        // 4b (schema-version-mismatch) is what actually fires for a
        // zero-byte file, not 4c ("corrupt"), and that ordering is an
        // implementation detail this test should not overspecify.
        expect(index.rebuilt).toBe(true);
        expect(countTicketRows(path)).toBe(0); // sentinel is gone, not merely "no throw"
      } finally {
        index.close();
      }
    });
  });

  test.each([100, 2048])("truncated mid-file to %d bytes rebuilds (F4/F5, verified: this size throws at PRAGMA user_version)", async (size) => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      expect(countTicketRows(path)).toBe(1);
      truncateSync(path, size);

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(countTicketRows(path)).toBe(0);
      } finally {
        index.close();
      }
    });
  });

  test("an older schema version (PRAGMA user_version = 0) rebuilds with reason 'schema-version-mismatch'", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      expect(countTicketRows(path)).toBe(1);
      const raw = new Database(path);
      raw.exec("PRAGMA user_version = 0");
      raw.close();

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("schema-version-mismatch");
        expect(countTicketRows(path)).toBe(0);
      } finally {
        index.close();
      }
    });
  });

  test("a newer schema version (PRAGMA user_version = INDEX_SCHEMA_VERSION + 1) also rebuilds -- not a deny-list keyed on one bad value", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      expect(countTicketRows(path)).toBe(1);
      const raw = new Database(path);
      raw.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION + 1}`);
      raw.close();

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("schema-version-mismatch");
        expect(countTicketRows(path)).toBe(0);
      } finally {
        index.close();
      }
    });
  });

  test("a board-key mismatch rebuilds with reason 'board-key-mismatch'", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      expect(countTicketRows(path)).toBe(1);
      const raw = new Database(path);
      raw.query("UPDATE cankan_meta SET value = ?1 WHERE key = 'board_key'").run("a-different-board-entirely");
      raw.close();

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("board-key-mismatch");
        expect(countTicketRows(path)).toBe(0);
      } finally {
        index.close();
      }
    });
  });

  /**
   * Fix round 1, code-review Minor (this comment): the assertion below is
   * NOT vacuous -- deleting the `lstat` guard this test exercises does
   * fail the `discardReason` assertion. But its *load-bearing security*
   * assertion, that the victim file's contents are unchanged, passes with
   * or without that guard: what actually protects the victim here is
   * probe-then-discard plus the fact that `rmSync` on the db path removes
   * the symlink itself, never the target it points at. A future reader
   * should not conclude from a passing victim-contents assertion alone
   * that the `lstat` guard is what is being tested for security -- it
   * isn't, on its own. What the guard uniquely buys is closing the
   * *write-through* window (the re-plant race this file's `openIndex`
   * doc comment and `db.ts`'s own comment above the `create: true` calls
   * both describe): without it, `initializeSchema` would write straight
   * through a symlink SQLite opened read-write, not merely fail to
   * unlink one.
   */
  test("a symlink at the db path is unlinked, never followed, and the victim file is untouched (the security case)", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      mkdirSync(join(path, ".."), { recursive: true });
      const victimPath = join(path, "..", "victim-elsewhere-in-the-temp-dir.txt");
      writeFileSync(victimPath, "the attacker must not be able to make SQLite truncate this");
      symlinkSync(victimPath, path);

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("not-a-regular-file");
        // The victim file, not the (now-unlinked) symlink, still holds
        // its original content -- SQLite never opened it read-write.
        expect(readFileSync(victimPath, "utf8")).toBe("the attacker must not be able to make SQLite truncate this");
        expect(countTicketRows(path)).toBe(0);
      } finally {
        index.close();
      }
    });
  });

  test("a regular file that bun:sqlite cannot open (mode 0o000) rebuilds with reason 'unreadable' -- unlinked via the owned parent directory, not left as a raw throw", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "irrelevant content -- the mode is what matters here");
      chmodSync(path, 0o000);

      try {
        const index = openIndex({ boardKey: BOARD_KEY });
        try {
          expect(index.rebuilt).toBe(true);
          expect(index.discardReason).toBe("unreadable");
          expect(countTicketRows(path)).toBe(0);
        } finally {
          index.close();
        }
      } finally {
        chmodSync(path, 0o700); // so withEnv's cleanup can remove the temp dir
      }
    });
  });
});

describe("rebuildIndex -- fix round 2 items 2/3", () => {
  test("a DIRECTORY at <db>-wal, planted only after the handle is already open, makes the sidecar sweep throw ERR_FS_EISDIR raw, which rebuildIndex must map to a typed CanKanError, never let escape (item 2)", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      const index = openIndex({ boardKey: BOARD_KEY }); // healthy reopen -- the sidecar path is still clean here
      // Planted only now, after `openIndex` has already succeeded: doing
      // this *before* `openIndex` hits a different (also real, also fixed
      // this round -- see `openIndex`'s own step-5 comment) failure inside
      // `openIndex` itself, since a directory at `<db>-wal` makes SQLite
      // refuse to open the otherwise-healthy main file at all
      // (`SQLITE_CANTOPEN`). This test isolates `rebuildIndex`'s own sweep
      // specifically, on an already-open, already-healthy handle.
      mkdirSync(`${path}-wal`);

      try {
        let thrown: unknown;
        try {
          rebuildIndex(index);
          throw new Error("expected rebuildIndex to throw");
        } catch (error) {
          thrown = error;
        }
        // The load-bearing assertion: a typed CanKanError, not a raw
        // Node ErrnoException (`code === "ERR_FS_EISDIR"`) escaping this
        // module's declared surface -- exactly the contract `openIndex`'s
        // own doc comment states ("a mkdir/lstat/unlink failure ...
        // INDEX_CACHE_PATH_UNAVAILABLE") but which was unenforced for this
        // call site.
        expect(isCanKanError(thrown)).toBe(true);
        expect(isCanKanError(thrown) && thrown.code).toBe(IndexErrorCodes.CACHE_PATH_UNAVAILABLE);
      } finally {
        // `rebuildIndex` already closed `index.db` before it threw --
        // nothing left to close on the original handle.
        rmSync(`${path}-wal`, { recursive: true, force: true });
      }
    });
  });

  test("rebuildIndex restores the cache directory's ownership/mode before rebuilding, mirroring openIndex's own open sequence (item 3)", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      const cacheDir = join(path, "..");
      const index = openIndex({ boardKey: BOARD_KEY }); // healthy reopen -- cacheDir is 0o700 at this point
      // Simulates the passage of time item 3's own rationale is about:
      // `rebuildIndex` can run seconds after the handle it is passed was
      // originally opened, so the directory state at that original
      // `openIndex` call proves nothing about the directory's state now.
      chmodSync(cacheDir, 0o777);
      expect(statSync(cacheDir).mode & 0o777).toBe(0o777); // fixture sanity

      const rebuilt = rebuildIndex(index);
      try {
        expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
        expect(rebuilt.rebuilt).toBe(true);
      } finally {
        rebuilt.close();
      }
    });
  });
});

describe("openIndex -- fix round 2 (unbriefed, found while testing item 2, same defect class): own discard-and-rebuild sidecar sweep", () => {
  test("a DIRECTORY at <db>-wal makes SQLite refuse to open the otherwise-healthy main file (SQLITE_CANTOPEN), which probe() maps to 'corrupt' -- openIndex's own sidecar sweep at that point must throw a typed CanKanError, never a raw ERR_FS_EISDIR", async () => {
    await withEnv(undefined, () => {
      const path = buildRealIndexFile(BOARD_KEY);
      mkdirSync(`${path}-wal`);

      try {
        // The directory obstruction is not something openIndex can
        // rebuild past on its own -- it cannot remove the directory any
        // more than `rebuildIndex` could (item 2). What changed is the
        // *shape* of the failure: before this fix, this call threw a raw
        // Node ErrnoException (`ERR_FS_EISDIR`) straight out of
        // `openIndex`, unwrapped since this module's very first commit.
        let thrown: unknown;
        try {
          openIndex({ boardKey: BOARD_KEY });
          throw new Error("expected openIndex to throw");
        } catch (error) {
          thrown = error;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect(isCanKanError(thrown) && thrown.code).toBe(IndexErrorCodes.CACHE_PATH_UNAVAILABLE);
      } finally {
        rmSync(`${path}-wal`, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Item 1 (fix round 2): the post-`mkdir` re-`lstat` in `ensurePrivateCacheDir`
 * (`db.ts`, immediately after the `mkdirSync` call) is now wrapped in the
 * same `CACHE_PATH_UNAVAILABLE` try/catch as the pre-`mkdir` `lstat` above
 * it. **No test exercises the failure path directly.** The two synchronous,
 * back-to-back `fs` calls (`mkdirSync` then `lstatSync`) leave no callback
 * boundary in this single-threaded process for a test to interleave a
 * directory removal or a permission change in between -- reaching the
 * `catch` requires either a concurrent process racing the two syscalls (the
 * same class of window this file's own doc comments already disclose as
 * "untested -- isolating a single-syscall race window from outside this
 * function isn't practical") or mocking `node:fs` itself, which would
 * verify the mock rather than the real `lstatSync` failure. Per the fix
 * round 2 brief's own instruction, this is stated explicitly rather than
 * shipped as a test that cannot fail: the wrap is exercised by code
 * inspection and by the identical, already-tested pattern one line above it
 * (the pre-`mkdir` `lstat`'s own `ENOENT`/other-error branches), not by a
 * dedicated test of its own.
 */
