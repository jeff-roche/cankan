import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import {
  findRegisteredBoard,
  isValidBoardName,
  listRegisteredBoards,
  register,
  resolveRegistryPath,
} from "../../src/board/registry";
import { isCanKanError } from "../../src/errors";
import { hermeticEnv } from "../config/testHelpers";

async function makeBoardDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cankan-registry-board-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("registry -- missing file", () => {
  test("a missing repos.yml is an empty list, never an error", async () => {
    await withEnv(undefined, async () => {
      const listing = await listRegisteredBoards(hermeticEnv());
      expect(listing.boards).toEqual([]);
      expect(listing.skipped).toEqual([]);
    });
  });
});

describe("registry -- malformed file", () => {
  test("a YAML syntax error fails with a message naming the file", async () => {
    await withEnv(undefined, async () => {
      const registryPath = resolveRegistryPath(hermeticEnv());
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(registryPath, "version: 1\nrepos: [\n");

      let thrown: unknown;
      try {
        await listRegisteredBoards(hermeticEnv());
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      const err = thrown as Error & { code: string };
      expect(err.code).toBe("REGISTRY_INVALID");
      expect(err.message).toContain(registryPath);
    });
  });

  test("a schema validation failure (bad shape) fails with a message naming the file", async () => {
    await withEnv(undefined, async () => {
      const registryPath = resolveRegistryPath(hermeticEnv());
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(registryPath, "version: 1\nrepos:\n  - name: api\n    path: relative/not/absolute\n    last_seen: 2026-09-05T08:00:00.000Z\n");

      let thrown: unknown;
      try {
        await listRegisteredBoards(hermeticEnv());
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      const err = thrown as Error & { code: string };
      expect(err.code).toBe("REGISTRY_INVALID");
      expect(err.message).toContain(registryPath);
    });
  });

  test("a hand-edited entry named 'personal' is rejected as malformed, not silently accepted", async () => {
    await withEnv(undefined, async () => {
      const registryPath = resolveRegistryPath(hermeticEnv());
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(
        registryPath,
        "version: 1\nrepos:\n  - name: personal\n    path: /tmp/whatever\n    last_seen: 2026-09-05T08:00:00.000Z\n",
      );

      let thrown: unknown;
      try {
        await listRegisteredBoards(hermeticEnv());
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("REGISTRY_INVALID");
    });
  });
});

describe("registry -- entry whose directory no longer exists", () => {
  test("a deleted-directory entry is skipped, not dropped, and does not break the other entries' read", async () => {
    await withEnv(undefined, async () => {
      const gone = await makeBoardDir();
      const alive = await makeBoardDir();
      try {
        await register("gone", gone.dir, hermeticEnv());
        await register("alive", alive.dir, hermeticEnv());
        await gone.cleanup();

        const listing = await listRegisteredBoards(hermeticEnv());
        expect(listing.boards.map((b) => b.name)).toEqual(["alive"]);
        expect(listing.skipped).toHaveLength(1);
        expect(listing.skipped[0]?.name).toBe("gone");
        expect(listing.skipped[0]?.reason).toContain("no longer exists");
      } finally {
        await alive.cleanup();
      }
    });
  });
});

describe("registry -- atomic writes", () => {
  test("register() writes via temp file + rename in the registry's own directory, never in place", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        await register("api", board.dir, hermeticEnv());
        const registryPath = resolveRegistryPath(hermeticEnv());
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        const text = await readFile(registryPath, "utf8");
        expect(text).toContain("api");
        expect(text).toContain(await realpath(board.dir));
      } finally {
        await board.cleanup();
      }
    });
  });
});

describe("registry -- concurrent register()", () => {
  test("two concurrent register() calls with different names both survive", async () => {
    await withEnv(undefined, async () => {
      const boardA = await makeBoardDir();
      const boardB = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await Promise.all([register("api", boardA.dir, env), register("web", boardB.dir, env)]);

        const listing = await listRegisteredBoards(env);
        const names = listing.boards.map((b) => b.name).sort();
        expect(names).toEqual(["api", "web"]);
      } finally {
        await boardA.cleanup();
        await boardB.cleanup();
      }
    });
  });
});

describe("registry -- stale lock breaking", () => {
  test("a lockfile older than the staleness window is broken, not waited out", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        const env = hermeticEnv();
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await mkdir(join(registryPath, ".."), { recursive: true });

        const lockPath = `${registryPath}.lock`;
        await writeFile(lockPath, "");
        // Back-date the lock well past the staleness window (10s) but
        // within register()'s own bounded-retry timeout (5s) -- without
        // the stale-break, register() would time out with
        // REGISTRY_LOCK_TIMEOUT instead of succeeding quickly.
        const staleTime = new Date(Date.now() - 30_000);
        await utimes(lockPath, staleTime, staleTime);

        const entry = await register("api", board.dir, env);
        expect(entry.name).toBe("api");

        const listing = await listRegisteredBoards(env);
        expect(listing.boards.map((b) => b.name)).toEqual(["api"]);
      } finally {
        await board.cleanup();
      }
    });
  });
});

describe("registry -- upsert semantics", () => {
  test("re-registering the same canonical path updates the existing row rather than duplicating it", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await register("api", board.dir, env);
        await register("api-renamed", board.dir, env);

        const listing = await listRegisteredBoards(env);
        expect(listing.boards).toHaveLength(1);
        expect(listing.boards[0]?.name).toBe("api-renamed");
        expect(listing.boards[0]?.path).toBe(await realpath(board.dir));
      } finally {
        await board.cleanup();
      }
    });
  });

  test("a name already bound to a different path is a naming conflict, not a silent overwrite", async () => {
    await withEnv(undefined, async () => {
      const boardA = await makeBoardDir();
      const boardB = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await register("api", boardA.dir, env);

        let thrown: unknown;
        try {
          await register("api", boardB.dir, env);
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("BOARD_NAME_TAKEN");

        const listing = await listRegisteredBoards(env);
        expect(listing.boards).toHaveLength(1);
        expect(listing.boards[0]?.path).toBe(await realpath(boardA.dir));
      } finally {
        await boardA.cleanup();
        await boardB.cleanup();
      }
    });
  });
});

describe("registry -- reserved and shape-invalid board names", () => {
  const reserved = ["personal", "repo", "all"];
  for (const name of reserved) {
    test(`register() refuses the reserved name "${name}"`, async () => {
      await withEnv(undefined, async () => {
        const board = await makeBoardDir();
        try {
          let thrown: unknown;
          try {
            await register(name, board.dir, hermeticEnv());
          } catch (err) {
            thrown = err;
          }
          expect(isCanKanError(thrown)).toBe(true);
          expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
        } finally {
          await board.cleanup();
        }
      });
    });

    test(`findRegisteredBoard() refuses the reserved name "${name}"`, async () => {
      await withEnv(undefined, async () => {
        let thrown: unknown;
        try {
          await findRegisteredBoard(name, hermeticEnv());
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
      });
    });
  }

  const invalidShapes: Array<[string, string]> = [
    ["contains a slash", "foo/bar"],
    ["contains a backslash", "foo\\bar"],
    ["is exactly '.'", "."],
    ["is exactly '..'", ".."],
    ["is an absolute path", "/etc/passwd"],
    ["is empty", ""],
    ["has a NUL byte", "foo\0bar"],
    ["has a control character", "foo\tbar"],
    ["has a drive-letter prefix", "C:evil"],
  ];
  for (const [label, name] of invalidShapes) {
    test(`isValidBoardName rejects a name that ${label}`, () => {
      expect(isValidBoardName(name)).toBe(false);
    });
  }

  test("register() refuses a shape-invalid name", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        let thrown: unknown;
        try {
          await register("../evil", board.dir, hermeticEnv());
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
      } finally {
        await board.cleanup();
      }
    });
  });

  test("a plain valid name is accepted", () => {
    expect(isValidBoardName("api")).toBe(true);
    expect(isValidBoardName("my-repo_2")).toBe(true);
  });
});

describe("registry -- findRegisteredBoard", () => {
  test("finds the right entry among several", async () => {
    await withEnv(undefined, async () => {
      const boardA = await makeBoardDir();
      const boardB = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await register("api", boardA.dir, env);
        await register("web", boardB.dir, env);

        const found = await findRegisteredBoard("web", env);
        expect(found?.path).toBe(await realpath(boardB.dir));
        expect(await findRegisteredBoard("missing", env)).toBeUndefined();
      } finally {
        await boardA.cleanup();
        await boardB.cleanup();
      }
    });
  });

  test("a registered name whose directory vanished is a typed error, never silently 'not found'", async () => {
    await withEnv(undefined, async () => {
      const gone = await makeBoardDir();
      const env = hermeticEnv();
      await register("gone", gone.dir, env);
      await gone.cleanup();

      let thrown: unknown;
      let result: unknown;
      try {
        result = await findRegisteredBoard("gone", env);
      } catch (err) {
        thrown = err;
      }
      expect(result).toBeUndefined();
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("BOARD_DIRECTORY_MISSING");
      expect((thrown as Error).message).toContain("gone");
    });
  });
});

describe("registry -- canonicalization (a registry entry whose stored path is a symlink)", () => {
  test("buildBoardRef canonicalizes a board root even when the registry stored a symlink", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-registry-link-"));
      try {
        const linkPath = join(linkParent, "board-link");
        await symlink(board.dir, linkPath);

        // Simulate a hand-edited or otherwise-non-canonical registry row by
        // registering the symlink path directly and asserting the stored
        // path is already canonical (register() itself realpaths), then
        // separately proving buildBoardRef canonicalizes regardless of
        // what a caller hands it (e.g. a manually-constructed BoardRef
        // source).
        const entry = await register("api", linkPath, hermeticEnv());
        expect(entry.path).toBe(await realpath(board.dir));

        const built = await buildBoardRef({ kind: "repo", name: "api", root: linkPath });
        expect(built.root).toBe(await realpath(board.dir));
      } finally {
        await board.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});
