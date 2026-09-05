import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { isCanKanError } from "../../src/errors";
import { ensurePersonalBoard, resolvePersonalBoardPath } from "../../src/board/personal";
import { register, resolveRegistryPath } from "../../src/board/registry";
import type { BoardFlag } from "../../src/board/resolve";
import { resolveAllBoards, resolveBoard } from "../../src/board/resolve";
import { hermeticEnv, makeTempRepoRoot, writeFileEnsuringDir, writeRepoConfigFile } from "../config/testHelpers";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `resolvePersonalBoardPath(env)`, asserting it actually resolved --
 * inside `withEnv()` with `hermeticEnv()` it always should, and a bare
 * `?? ""` fallback would make "the personal board was never created"
 * assertions pass vacuously (against `""`) if this ever silently returned
 * `undefined` instead.
 */
function requirePersonalBoardPath(env: Readonly<Record<string, string | undefined>>): string {
  const path = resolvePersonalBoardPath(env);
  if (!path) throw new Error("test setup: personal board path did not resolve");
  return path;
}

async function initedRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const repo = await makeTempRepo();
  await mkdir(join(repo.dir, ".cankan"), { recursive: true });
  return { dir: repo.dir, cleanup: repo.cleanup };
}

describe("resolveBoard -- precedence and boundary conditions (no flag)", () => {
  test("cwd at the repo root resolves to that repo's board", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      try {
        const board = await resolveBoard({ cwd: repo.dir, env: hermeticEnv() });
        expect(board.kind).toBe("repo");
        expect(board.root).toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("cwd deep inside a subdirectory of the repo resolves to the same repo board", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      try {
        const deep = join(repo.dir, "a", "b", "c");
        await mkdir(deep, { recursive: true });
        const board = await resolveBoard({ cwd: deep, env: hermeticEnv() });
        expect(board.kind).toBe("repo");
        expect(board.root).toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a repo with git but no .cankan/ falls through to personal, not treated as inited", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const env = hermeticEnv();
        const board = await resolveBoard({ cwd: repo.dir, env });
        expect(board.kind).toBe("personal");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("inside a secondary git worktree resolves to that worktree's own board root, not the main worktree's", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo({ worktrees: 1 });
      try {
        const wt = repo.worktreeDirs[0];
        if (!wt) throw new Error("test setup: no worktree created");
        await mkdir(join(wt, ".cankan"), { recursive: true });
        const board = await resolveBoard({ cwd: wt, env: hermeticEnv() });
        expect(board.kind).toBe("repo");
        expect(board.root).toBe(await realpath(wt));
        expect(board.root).not.toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("cwd at the filesystem root falls through to personal -- the upward walk terminates rather than looping", async () => {
    await withEnv(undefined, async () => {
      const board = await resolveBoard({ cwd: "/", env: hermeticEnv() });
      expect(board.kind).toBe("personal");
    });
  });

  test("a cwd that no longer exists is a typed error naming the path, never a silent fall-through to personal", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const ghost = join(tmpdir(), `cankan-resolve-ghost-${Date.now()}`);
      let thrown: unknown;
      try {
        await resolveBoard({ cwd: ghost, env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("CWD_NOT_FOUND");
      expect((thrown as Error).message).toContain(ghost);
      expect(await pathExists(requirePersonalBoardPath(env))).toBe(false);
    });
  });

  test("a cwd reached through a symlink resolves to the repo's realpath'd root, not the symlinked path (must pass on macOS too)", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-link-"));
      try {
        const linkPath = join(linkParent, "repo-link");
        await symlink(repo.dir, linkPath);
        const board = await resolveBoard({ cwd: linkPath, env: hermeticEnv() });
        expect(board.root).toBe(await realpath(repo.dir));
        expect(board.root).not.toBe(linkPath);
      } finally {
        await repo.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});

describe("resolveBoard -- flag semantics", () => {
  test("--board personal resolves to the personal board even from inside a repo", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      try {
        const board = await resolveBoard({ cwd: repo.dir, flag: { kind: "personal" }, env: hermeticEnv() });
        expect(board.kind).toBe("personal");
        expect(board.name).toBe("personal");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("--board repo resolves to the cwd's own repo board", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      try {
        const board = await resolveBoard({ cwd: repo.dir, flag: { kind: "repo" }, env: hermeticEnv() });
        expect(board.kind).toBe("repo");
        expect(board.root).toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("--board repo outside any inited repo is an error, never a fall-through to personal", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo(); // no .cankan/
      try {
        const env = hermeticEnv();
        let thrown: unknown;
        try {
          await resolveBoard({ cwd: repo.dir, flag: { kind: "repo" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("NOT_INSIDE_REPO_BOARD");
        expect(await pathExists(requirePersonalBoardPath(env))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("--board <name> resolves the registered board's own directory", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo();
      const outsider = await makeTempRepo();
      try {
        await register("api", repo.dir, env);
        const board = await resolveBoard({
          cwd: outsider.dir,
          flag: { kind: "name", name: "api" },
          env,
        });
        expect(board.kind).toBe("repo");
        expect(board.name).toBe("api");
        expect(board.root).toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
        await outsider.cleanup();
      }
    });
  });

  test("--board <name> for a name that was never registered is a typed BOARD_NOT_REGISTERED error", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const outsider = await makeTempRepo();
      try {
        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "nope" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("BOARD_NOT_REGISTERED");
      } finally {
        await outsider.cleanup();
      }
    });
  });

  test("--board <name> reuses registry.ts's own validation -- a reserved name surfaces registry's INVALID_BOARD_NAME, not re-derived here", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      // A raw string reaching this path (e.g. a CLI arg that slipped past
      // BoardFlag's own type) must still be rejected at runtime -- the
      // type-level exclusion of "all" is a compile-time aid for M3.1, not
      // the only guard.
      const flag = { kind: "name", name: "all" } as BoardFlag;
      let thrown: unknown;
      try {
        await resolveBoard({ cwd: "/", flag, env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
    });
  });

  test("--board <name> for a name registered but whose directory vanished propagates registry.ts's BOARD_DIRECTORY_MISSING, never silently 'not found'", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo();
      const outsider = await makeTempRepo();
      try {
        await register("gone", repo.dir, env);
        await repo.cleanup();

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "gone" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("BOARD_DIRECTORY_MISSING");
      } finally {
        await outsider.cleanup();
      }
    });
  });

  test("--board <name> whose registry entry reaches the personal board through a symlink alias is a typed error, never kind: 'repo'", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-personal-alias-"));
      const outsider = await makeTempRepo();
      try {
        const linkPath = join(linkParent, "personal-alias");
        await symlink(personal.board.root, linkPath);

        // A hand-edited repos.yml: register()'s own F7 check only catches
        // an *exact* stored-path match against the personal board, so a
        // symlink alias like this reaches listRegisteredBoards()'s `boards`
        // list undetected -- only buildBoardRef's canonicalization reveals
        // it, which is exactly what this test is for.
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await writeFileEnsuringDir(
          registryPath,
          `version: 1\nrepos:\n  - name: sneaky\n    path: ${linkPath}\n    last_seen: 2026-01-01T00:00:00.000Z\n`,
        );

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "sneaky" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
      } finally {
        await outsider.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  test("BoardFlag's closed union excludes 'all' -- enforced at compile time (see the typecheck gate)", () => {
    // @ts-expect-error -- "all" is not a member of BoardFlag; --board all is
    // resolveAllBoards()'s job (B1/B2 ruling), never resolveBoard()'s.
    const flag: BoardFlag = { kind: "all" };
    void flag;
  });
});

describe("resolveBoard -- addendum 2: the personal board's own tree is never mistaken for a repo", () => {
  test("a cwd inside the personal board's own directory resolves to the personal board, not a repo board named after its basename", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const nested = join(personal.board.root, "some", "nested", "dir");
      await mkdir(nested, { recursive: true });

      const board = await resolveBoard({ cwd: nested, env });
      expect(board.kind).toBe("personal");
      expect(board.name).toBe("personal");
      expect(board.root).toBe(personal.board.root);
    });
  });

  test("--board repo from inside the personal board's own tree is an error, not a silent substitution", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      let thrown: unknown;
      try {
        await resolveBoard({ cwd: personal.board.root, flag: { kind: "repo" }, env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("NOT_INSIDE_REPO_BOARD");
    });
  });
});

describe("resolveBoard -- BoardRef.name agrees between cwd resolution and --board <name>", () => {
  test("a registered repo's name comes from the registry, not the directory's basename, when resolved with no flag or --board repo", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo(); // makeTempRepo()'s dir is named "main", the registered name is "api"
      try {
        await register("api", repo.dir, env);

        const noFlag = await resolveBoard({ cwd: repo.dir, env });
        const repoFlag = await resolveBoard({ cwd: repo.dir, flag: { kind: "repo" }, env });
        const named = await resolveBoard({
          cwd: await realpath("/"),
          flag: { kind: "name", name: "api" },
          env,
        });

        expect(basename(repo.dir)).not.toBe("api"); // the premise: basename would have disagreed
        expect(noFlag.name).toBe("api");
        expect(repoFlag.name).toBe("api");
        expect(named.name).toBe("api");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("registeredNameFor compares canonically -- a hand-edited registry entry reaching the repo through a symlink alias still supplies the registered name", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-name-alias-"));
      try {
        const linkPath = join(linkParent, "repo-alias");
        await symlink(repo.dir, linkPath);

        // Deliberately not register() -- that canonicalizes at write time,
        // which would make this test pass even with a naive exact-string
        // comparison. A hand-edited repos.yml is how F11 first surfaced
        // this class of gap.
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await writeFileEnsuringDir(
          registryPath,
          `version: 1\nrepos:\n  - name: api\n    path: ${linkPath}\n    last_seen: 2026-01-01T00:00:00.000Z\n`,
        );

        const board = await resolveBoard({ cwd: repo.dir, env });
        expect(board.name).toBe("api");
        expect(board.root).toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  test("an unregistered repo still falls back to basename(root)", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      try {
        const board = await resolveBoard({ cwd: repo.dir, env: hermeticEnv() });
        expect(board.name).toBe(basename(await realpath(repo.dir)));
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("resolveBoard -- the privacy default is structural (CONCEPT.md §6c)", () => {
  test("resolving a repo board never creates the personal board as a side effect", async () => {
    await withEnv(undefined, async () => {
      const repo = await initedRepo();
      try {
        const env = hermeticEnv();
        const board = await resolveBoard({ cwd: repo.dir, env });
        expect(board.kind).toBe("repo");
        expect(await pathExists(requirePersonalBoardPath(env))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("resolveBoard -- --board <name> against a misconfigured repo names the most specific broken file deterministically (main's #88 fix)", () => {
  test("both .cankan/config.yml and .cankan/local.yml guards reject when .cankan is a symlinked directory -- the reported file never flips run to run", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await makeTempRepo(); // no .cankan/ of its own -- it will be a symlink
      const target = await makeTempRepoRoot(); // stands in for the symlink's target
      const outsider = await makeTempRepo();
      try {
        await writeFileEnsuringDir(join(target.root, "config.yml"), "id_prefix: x\n");
        await writeFileEnsuringDir(join(target.root, "local.yml"), "actor: someone\n");
        await symlink(target.root, join(repo.dir, ".cankan"));
        await register("broken", repo.dir, env);

        for (let i = 0; i < 5; i++) {
          let thrown: unknown;
          try {
            await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "broken" }, env });
          } catch (err) {
            thrown = err;
          }
          expect(isCanKanError(thrown)).toBe(true);
          expect((thrown as Error).message).toContain(join(await realpath(repo.dir), ".cankan", "config.yml"));
          expect((thrown as Error).message).not.toContain(join(".cankan", "local.yml"));
        }
      } finally {
        await repo.cleanup();
        await target.cleanup();
        await outsider.cleanup();
      }
    });
  });
});

describe("resolveAllBoards -- --board all", () => {
  test("is the personal board plus every registered repo board -- an unregistered repo is not included", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repoA = await initedRepo();
      const repoB = await makeTempRepo(); // left unregistered
      try {
        await register("a", repoA.dir, env);
        const result = await resolveAllBoards({ env });
        const kinds = result.boards.map((b) => b.kind).sort();
        expect(kinds).toEqual(["personal", "repo"]);
        const names = result.boards.map((b) => b.name);
        expect(names).toContain("personal");
        expect(names).toContain("a");
        expect(names).not.toContain(basename(repoB.dir));
        expect(result.skipped).toHaveLength(0);
      } finally {
        await repoA.cleanup();
        await repoB.cleanup();
      }
    });
  });

  test("a registered entry whose directory vanished is reported in skipped, not dropped, and does not break the others", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repoOk = await initedRepo();
      const repoGone = await initedRepo();
      try {
        await register("ok", repoOk.dir, env);
        await register("gone", repoGone.dir, env);
        await repoGone.cleanup();

        const result = await resolveAllBoards({ env });
        expect(result.boards.map((b) => b.name)).toContain("ok");
        expect(result.boards.map((b) => b.name)).not.toContain("gone");
        expect(
          result.skipped.some((s) => s.name === "gone" && s.reason.includes("no longer exists")),
        ).toBe(true);
      } finally {
        await repoOk.cleanup();
      }
    });
  });

  test("a registered entry whose tickets_dir escapes the board root is skipped with the underlying error's reason, not thrown", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repoGood = await initedRepo();
      const repoBad = await initedRepo();
      try {
        await writeRepoConfigFile(repoBad.dir, "config.yml", "tickets_dir: ../escape\n");
        await register("good", repoGood.dir, env);
        await register("bad", repoBad.dir, env);

        const result = await resolveAllBoards({ env });
        expect(result.boards.map((b) => b.name)).toContain("good");
        expect(result.boards.map((b) => b.name)).not.toContain("bad");
        const skip = result.skipped.find((s) => s.name === "bad");
        expect(skip).toBeDefined();
        expect(skip?.reason).toContain("resolves outside the board root");
      } finally {
        await repoGood.cleanup();
        await repoBad.cleanup();
      }
    });
  });

  test("two registry entries reaching one directory through a symlink alias are one board, not two", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-alldup-"));
      try {
        const linkPath = join(linkParent, "alias");
        await symlink(repo.dir, linkPath);

        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await writeFileEnsuringDir(
          registryPath,
          `version: 1\nrepos:\n  - name: real\n    path: ${repo.dir}\n    last_seen: 2026-01-01T00:00:00.000Z\n  - name: alias\n    path: ${linkPath}\n    last_seen: 2026-01-01T00:00:00.000Z\n`,
        );

        const result = await resolveAllBoards({ env });
        const repoBoards = result.boards.filter((b) => b.kind === "repo");
        expect(repoBoards).toHaveLength(1);
        expect(result.skipped.some((s) => s.name === "alias" && s.reason.includes("duplicate"))).toBe(true);
      } finally {
        await repo.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  test("a registry entry reaching the personal board through a symlink alias is skipped as 'is the personal board', not a generic duplicate", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-all-personal-alias-"));
      try {
        const linkPath = join(linkParent, "personal-alias");
        await symlink(personal.board.root, linkPath);

        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await writeFileEnsuringDir(
          registryPath,
          `version: 1\nrepos:\n  - name: sneaky\n    path: ${linkPath}\n    last_seen: 2026-01-01T00:00:00.000Z\n`,
        );

        const result = await resolveAllBoards({ env });
        expect(result.boards.filter((b) => b.kind === "repo")).toHaveLength(0);
        const skip = result.skipped.find((s) => s.name === "sneaky");
        expect(skip?.reason).toBe("is the personal board");
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  test("propagates an unresolvable personal board rather than swallowing it as 'skipped'", async () => {
    await withEnv(undefined, async () => {
      let thrown: unknown;
      try {
        await resolveAllBoards({ env: {} }); // no HOME, no XDG_DATA_HOME at all
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("DATA_HOME_UNRESOLVABLE");
    });
  });
});
