import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { isCanKanError } from "../../src/errors";
import { INDEX_SCHEMA_VERSION, indexPathFor, openIndex } from "../../src/index/db";
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
  test("garbage bytes at the db path rebuild (reason: corrupt)", async () => {
    await withEnv(undefined, () => {
      const path = indexPathFor(BOARD_KEY, process.env);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "not a sqlite file at all, just some bytes\0\0\0garbage");

      const index = openIndex({ boardKey: BOARD_KEY });
      try {
        expect(index.rebuilt).toBe(true);
        expect(index.discardReason).toBe("corrupt");
        expect(countTicketRows(path)).toBe(0);
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
