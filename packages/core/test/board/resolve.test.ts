import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { isCanKanError } from "../../src/errors";
import { ensurePersonalBoard, resolvePersonalBoardPath } from "../../src/board/personal";
import { listRegisteredBoards, register, resolveRegistryPath } from "../../src/board/registry";
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

/**
 * `JSON.stringify` of a thrown `CanKanError`'s `details`, for asserting
 * what does or doesn't appear there specifically -- `details`, not
 * `message`, is the channel `toJSON`/`--json` output actually publishes
 * (fix round 2, F7), so a message-only `.not.toContain(...)` assertion
 * does not discriminate a fix that scrubs the message but leaves
 * `details.path` (or similar) intact.
 */
function detailsAsString(thrown: unknown): string {
  const details = (thrown as { details?: unknown }).details;
  return JSON.stringify(details ?? {});
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

describe("fix round 1 -- F1: personal-board guards are containment, not equality (three reproduced shapes)", () => {
  test("F1(a): register() refuses a subdirectory of the personal board, not only its exact root", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const subdir = join(personal.board.root, "backlog"); // exists: ensurePersonalBoard creates backlog/tasks
      let thrown: unknown;
      try {
        await register("leak", subdir, env);
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("CANNOT_REGISTER_PERSONAL_BOARD");

      const listing = await listRegisteredBoards(env);
      expect(listing.boards).toHaveLength(0);
    });
  });

  test("F1(a), reachability: a hand-edited entry registering a subdirectory of the personal board surfaces REGISTERED_BOARD_IS_PERSONAL through --board <name>, not BOARD_DIRECTORY_MISSING", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const subdir = join(personal.board.root, "backlog");
      const outsider = await makeTempRepo();
      try {
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await writeFileEnsuringDir(
          registryPath,
          `version: 1\nrepos:\n  - name: leak\n    path: ${subdir}\n    last_seen: 2026-01-01T00:00:00.000Z\n`,
        );

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "leak" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
        // This scenario is caught by registry.ts's own root-containment
        // check (a subdirectory, not an ancestor+steered-ticketsDir), so
        // it is `findRegisteredBoard`'s throw that actually fires here,
        // not `resolve.ts`'s post-build one -- confirmed by mutation: this
        // assertion does not discriminate `resolve.ts`'s own throw (see
        // the F1(b) test below, and task-B-report.md, for the one that
        // does). Still worth asserting on this path too, since either
        // throw site reaching a caller with the path attached would be a
        // defect.
        expect((thrown as Error).message).not.toContain(personal.board.root);
        expect(detailsAsString(thrown)).not.toContain(personal.board.root);
      } finally {
        await outsider.cleanup();
      }
    });
  });

  test("F1(b): a registered ancestor of the personal board with tickets_dir steered into it is refused, not returned as an ordinary repo -- the literal §6c violation", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const umbrella = dirname(personal.board.root); // <xdg_data_home>/cankan, an ancestor of personal
      const outsider = await makeTempRepo();
      try {
        // tickets_dir steered to be *exactly* the personal board's own
        // tickets directory. ADR 0002's own containment check passes
        // honestly here -- it really is beneath `umbrella`.
        await writeRepoConfigFile(umbrella, "config.yml", "tickets_dir: personal/backlog/tasks\n");
        // register() only sees the ROOT half (registry.ts) -- an ancestor
        // is not "contained in" the personal board, so this succeeds.
        // That is the point: only resolution time, after buildBoardRef
        // resolves ticketsDir, can catch this shape.
        await register("umbrella", umbrella, env);

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "umbrella" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
        // F5/F7 (fix round 2): this scenario -- unlike the F1(a)
        // reachability test above -- is the one that genuinely reaches
        // `resolve.ts`'s *own* `REGISTERED_BOARD_IS_PERSONAL` throw
        // (registry.ts's cheaper root-containment check cannot see a
        // registered *ancestor*, so `findRegisteredBoard` returns this
        // entry normally and never throws itself). Confirmed by mutation:
        // restoring `path: ref.root` to this throw's `details` makes this
        // exact assertion fail; the F1(a) test above does not, because it
        // never reaches this call site at all. See task-B-report.md.
        expect(detailsAsString(thrown)).not.toContain(personal.board.root);
        expect(detailsAsString(thrown)).not.toContain(umbrella);
      } finally {
        await outsider.cleanup();
      }
    });
  });

  test("F1(b) via --board all: the same steered-ancestor shape is skipped as 'is the personal board', not listed as a repo board", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const umbrella = dirname(personal.board.root);
      await writeRepoConfigFile(umbrella, "config.yml", "tickets_dir: personal/backlog/tasks\n");
      await register("umbrella", umbrella, env);

      const result = await resolveAllBoards({ env });
      expect(result.boards.map((b) => b.name)).not.toContain("umbrella");
      const skip = result.skipped.find((s) => s.name === "umbrella");
      expect(skip?.reason).toBe("is the personal board");
    });
  });

  test("F1(b), a further ancestor: a registered $XDG_DATA_HOME itself, several segments above the personal board, with a matching multi-segment tickets_dir, is still caught -- only the ticketsDir half of the rule can", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      await ensurePersonalBoard({ env }); // materializes $XDG_DATA_HOME/cankan/personal, and $XDG_DATA_HOME itself along the way
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      const outsider = await makeTempRepo();
      try {
        // Several segments above `personal.board.root`
        // ($XDG_DATA_HOME/cankan/personal) -- `isContained(personalPath,
        // ref.root)` is false here by a wide margin (root is an ancestor,
        // not a descendant); only the ticketsDir half can catch this.
        await writeRepoConfigFile(dataHome, "config.yml", "tickets_dir: cankan/personal/backlog/tasks\n");
        await register("data-home", dataHome, env);

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "data-home" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");

        const all = await resolveAllBoards({ env });
        expect(all.boards.map((b) => b.name)).not.toContain("data-home");
        expect(all.skipped.find((s) => s.name === "data-home")?.reason).toBe("is the personal board");
      } finally {
        await outsider.cleanup();
      }
    });
  });

  // Mutation note (see task-B-report.md, fix round 1 and its round-2
  // correction): this test verifies the *observable outcome*, not one
  // specific line. Reverting walkForBoard's own `isContained` back to
  // `===` alone does NOT fail this test -- the post-build
  // `aliasesPersonalBoard` check independently catches the same shape
  // after `buildBoardRef` runs, so the two checks are redundant for this
  // particular shape today. Specifically the *`ticketsDir`* half of that
  // check is what does the work here, not the `root` half: `buildBoardRef`
  // itself enforces `isContained(root, ticketsDir)` (ADR 0002,
  // `ref.ts`'s `checkContainment`) for every ref that ever reaches this
  // point, so `isContained(personalPath, root)` being true always implies
  // `isContained(personalPath, ticketsDir)` is true too -- the root half
  // is kept as defense-in-depth, not because it is the one actually
  // discriminating here. Reverting `aliasesPersonalBoard` itself (tested
  // above in F1(b)) is what actually discriminates the outcome this test
  // protects.
  test("F1(c): a nested .cankan/ inside the personal board's own tree is never treated as an ordinary repo, no-flag or --board repo", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const nestedRepo = join(personal.board.root, "proj");
      await mkdir(join(nestedRepo, ".cankan"), { recursive: true });

      const noFlag = await resolveBoard({ cwd: nestedRepo, env });
      expect(noFlag.kind).toBe("personal");
      expect(noFlag.name).not.toBe("proj");

      let thrown: unknown;
      try {
        await resolveBoard({ cwd: nestedRepo, flag: { kind: "repo" }, env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("NOT_INSIDE_REPO_BOARD");
    });
  });

  test("F1(c) reachable via repos.yml auto_register: a repo nested in the personal tree, once registered, is caught by shape (a) too", async () => {
    // The dispatch note's own connective tissue: "cankan init" under
    // repos.auto_register would register a nested repo like F1(c)'s,
    // which then reduces to F1(a) (a registered subdirectory of the
    // personal board). Exercised directly against register(), since
    // `init` itself is a later lane's module.
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const nestedRepo = join(personal.board.root, "proj");
      await mkdir(join(nestedRepo, ".cankan"), { recursive: true });

      let thrown: unknown;
      try {
        await register("proj", nestedRepo, env);
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("CANNOT_REGISTER_PERSONAL_BOARD");
    });
  });
});

describe("fix round 1 -- F2: canonicalCwd's realpath is load-bearing for comparisons buildBoardRef's own safety net never reaches", () => {
  // Mutation note (see task-B-report.md, fix round 1): de-fanging
  // `canonicalCwd` (existence check only, no `realpath`) and rerunning
  // this file showed only the *second* test below fails. This one keeps
  // passing even de-fanged: `walkForBoard`'s own comparison then
  // misclassifies the symlinked personal-tree cwd as an ordinary "repo",
  // but `buildBoardRef` still realpaths that "repo"'s root as its own
  // first statement, and the F1 post-build `aliasesPersonalBoard` check
  // (added earlier in this same fix round) catches the now-canonical
  // result anyway before it can be returned. So this specific guarantee
  // ends up double-protected by F1's own fix, not solely by this one --
  // asserting it is still correct and worth keeping, just not, on its
  // own, proof that `canonicalCwd`'s `realpath` is doing anything here.
  test("a cwd reached through a symlink to the personal board's own root still resolves to personal", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-f2-personal-"));
      try {
        const linkPath = join(linkParent, "personal-link");
        await symlink(personal.board.root, linkPath);
        const board = await resolveBoard({ cwd: linkPath, env });
        expect(board.kind).toBe("personal");
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  // This is the test that actually discriminates: `registeredNameFor` runs
  // *before* `buildBoardRef`, comparing the raw walked root against each
  // registry entry's own canonical path -- there is no downstream safety
  // net for this comparison specifically. De-fanging `canonicalCwd` makes
  // this fail (`board.name` comes back `"totally-different-name"`, the
  // symlink's own basename, instead of `"api"`); restored afterward.
  test("a cwd reached through a symlink to a registered repo's root still gets the registry name, not a basename derived from the symlink", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-f2-repo-"));
      try {
        await register("api", repo.dir, env);
        const linkPath = join(linkParent, "totally-different-name");
        await symlink(repo.dir, linkPath);
        const board = await resolveBoard({ cwd: linkPath, env });
        expect(board.name).toBe("api");
        expect(board.root).toBe(await realpath(repo.dir));
      } finally {
        await repo.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});

describe("fix round 1 -- F3: registeredNameFor degrades gracefully on a malformed registry, but --board all still throws", () => {
  const MALFORMED_YAML = "version: 1\nrepos: [\n";

  test("a no-flag resolution still succeeds against a malformed repos.yml, falling back to basename", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await initedRepo();
      try {
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await writeFileEnsuringDir(registryPath, MALFORMED_YAML);

        const board = await resolveBoard({ cwd: repo.dir, env });
        expect(board.kind).toBe("repo");
        expect(board.name).toBe(basename(await realpath(repo.dir)));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("--board all still throws REGISTRY_INVALID on that same malformed file -- the loud path survives", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await writeFileEnsuringDir(registryPath, MALFORMED_YAML);

      let thrown: unknown;
      try {
        await resolveAllBoards({ env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("REGISTRY_INVALID");
    });
  });
});

describe("fix round 1 -- F4: canonicalCwd wraps a non-ENOENT realpath failure too", () => {
  test("a cwd that is a symlink cycle is a typed CWD_UNRESOLVABLE error, never a raw ELOOP", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-resolve-eloop-"));
      try {
        const a = join(linkParent, "a");
        const b = join(linkParent, "b");
        await symlink(b, a);
        await symlink(a, b);

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: a, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("CWD_UNRESOLVABLE");
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});

describe("fix round 2 -- F6: aliasesPersonalBoard's containment must be checked in both directions", () => {
  test("F6: a registered $XDG_DATA_HOME with tickets_dir steered to enclose the personal board is refused, not returned as an ordinary repo", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      await ensurePersonalBoard({ env });
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      const outsider = await makeTempRepo();
      try {
        // ticketsDir ends up $XDG_DATA_HOME/cankan, which contains
        // $XDG_DATA_HOME/cankan/personal/backlog/tasks (real tickets) and
        // $XDG_DATA_HOME/cankan/repos.yml -- the enclosing-direction shape
        // the root-direction exception (a registered ancestor is fine on
        // its own) does not by itself protect against.
        await writeRepoConfigFile(dataHome, "config.yml", "tickets_dir: cankan\n");
        await register("enc", dataHome, env);

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "enc" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");

        const all = await resolveAllBoards({ env });
        expect(all.boards.map((b) => b.name)).not.toContain("enc");
        expect(all.skipped.find((s) => s.name === "enc")?.reason).toBe("is the personal board");
      } finally {
        await outsider.cleanup();
      }
    });
  });

  test("F6: a registered $HOME with tickets_dir steered to enclose the personal board (via .local) is refused too", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      await ensurePersonalBoard({ env });
      const home = env.HOME;
      if (!home) throw new Error("test setup: HOME not set by hermeticEnv()");
      const outsider = await makeTempRepo();
      try {
        await writeRepoConfigFile(home, "config.yml", "tickets_dir: .local\n");
        await register("dot", home, env);

        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "dot" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
      } finally {
        await outsider.cleanup();
      }
    });
  });

  // The over-correction guard: F6's fix must not turn a legitimate
  // dotfiles-repo-at-$HOME workflow into a false positive. Default
  // tickets_dir (backlog/tasks) neither reaches into nor encloses the
  // personal board, so this must keep resolving normally at every entry
  // point that can reach it.
  test("F6: a legitimate $HOME dotfiles board (default tickets_dir) still resolves at all three entry points and stays in --board all", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      await ensurePersonalBoard({ env });
      const home = env.HOME;
      if (!home) throw new Error("test setup: HOME not set by hermeticEnv()");
      await mkdir(join(home, ".cankan"), { recursive: true }); // no config.yml -- default tickets_dir applies
      await register("dotfiles", home, env);

      const byName = await resolveBoard({ cwd: home, flag: { kind: "name", name: "dotfiles" }, env });
      expect(byName.kind).toBe("repo");
      expect(byName.name).toBe("dotfiles");

      const byRepoFlag = await resolveBoard({ cwd: home, flag: { kind: "repo" }, env });
      expect(byRepoFlag.name).toBe("dotfiles");

      const noFlag = await resolveBoard({ cwd: home, env });
      expect(noFlag.name).toBe("dotfiles");

      const all = await resolveAllBoards({ env });
      expect(all.boards.map((b) => b.name)).toContain("dotfiles");
    });
  });
});

describe("fix round 2 -- F7: the post-build alias check on the cwd-walk paths (--board repo, no-flag) has direct tests, not only via --board <name>", () => {
  test("F7: --board repo whose own repo root is an ancestor of the personal board, with tickets_dir steered into it, is refused -- not returned as an ordinary repo", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      await ensurePersonalBoard({ env });
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      await writeRepoConfigFile(dataHome, "config.yml", "tickets_dir: cankan/personal/backlog/tasks\n");

      let thrown: unknown;
      try {
        await resolveBoard({ cwd: dataHome, flag: { kind: "repo" }, env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("NOT_INSIDE_REPO_BOARD");
    });
  });

  test("F7: a no-flag resolution from that same ancestor repo falls through to personal, not an ordinary repo board", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      await ensurePersonalBoard({ env });
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      await writeRepoConfigFile(dataHome, "config.yml", "tickets_dir: cankan/personal/backlog/tasks\n");

      const board = await resolveBoard({ cwd: dataHome, env });
      expect(board.kind).toBe("personal");
    });
  });
});

describe("fix round 2 -- F8: canonicalPersonalPath's guard must not vanish just because the personal board hasn't been created yet", () => {
  test("F8: --board <name> against a steered-ancestor entry is refused even when the personal board has never been created", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      // Deliberately no ensurePersonalBoard() call -- that is the point of
      // this test. writeRepoConfigFile below creates XDG_DATA_HOME/.cankan
      // (a sibling of where "cankan/personal" would eventually live), so
      // it does not itself create the personal board.
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      await writeRepoConfigFile(dataHome, "config.yml", "tickets_dir: cankan/personal/backlog/tasks\n");
      await register("umbrella", dataHome, env);
      const outsider = await makeTempRepo();
      try {
        let thrown: unknown;
        try {
          await resolveBoard({ cwd: outsider.dir, flag: { kind: "name", name: "umbrella" }, env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
      } finally {
        await outsider.cleanup();
      }
    });
  });

  test("F8: a no-flag resolution from that same ancestor repo also falls through correctly when the personal board has never been created", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      await writeRepoConfigFile(dataHome, "config.yml", "tickets_dir: cankan/personal/backlog/tasks\n");

      // resolveBoard's own fall-through calls ensurePersonalBoard() as
      // part of resolving -- that is expected and fine; the point is that
      // the *ancestor repo* is refused rather than returned as-is.
      const board = await resolveBoard({ cwd: dataHome, env });
      expect(board.kind).toBe("personal");
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
