import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { isCanKanError } from "../../src/errors";
import { writeRepoConfigFile } from "../config/testHelpers";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("buildBoardRef -- canonicalization ruling", () => {
  test("root is realpath'd even when the source path is a symlink (must pass on macOS too)", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const linkParent = await mkdtemp(join(tmpdir(), "cankan-ref-link-"));
        const linkPath = join(linkParent, "repo-link");
        await symlink(repo.dir, linkPath);
        try {
          const board = await buildBoardRef({ kind: "repo", name: "api", root: linkPath });
          expect(board.root).toBe(await realpath(repo.dir));
          expect(board.root).not.toBe(linkPath);
        } finally {
          await rm(linkParent, { recursive: true, force: true });
        }
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("ticketsDir is contained under root by path-component semantics", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        // Ruling 1 (fix round 1): buildBoardRef never creates tickets_dir,
        // so it cannot be realpath'd end-to-end when it doesn't exist --
        // the expected value is root's own realpath with the (still
        // non-existent) suffix appended verbatim.
        expect(board.ticketsDir).toBe(join(await realpath(repo.dir), "backlog", "tasks"));
        const rel = relative(board.root, board.ticketsDir);
        expect(rel.split(sep)[0]).not.toBe("..");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("default tickets_dir and coordination.ref apply with no .cankan/config.yml present", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        expect(board.coordinationRef).toBe("refs/cankan/coordination");
        expect(dirname(board.ticketsDir).endsWith(join("backlog"))).toBe(true);
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("buildBoardRef -- read-only board resolution (controller ruling, fix round 1)", () => {
  test("never creates tickets_dir: it stays absent on disk, and ticketsDir is still returned canonically", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        expect(board.ticketsDir).toBe(join(await realpath(repo.dir), "backlog", "tasks"));
        expect(await pathExists(board.ticketsDir)).toBe(false);
        expect(await pathExists(join(await realpath(repo.dir), "backlog"))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a tickets_dir that already exists is realpath'd end-to-end as before", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const existingTicketsDir = join(repo.dir, "backlog", "tasks");
        await mkdir(existingTicketsDir, { recursive: true });
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        expect(board.ticketsDir).toBe(await realpath(existingTicketsDir));
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("buildBoardRef -- config-layer wiring (M2.4 -> M2.3)", () => {
  test("a non-default tickets_dir and coordination.ref flow through from the board's own .cankan/config.yml", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(
          repo.dir,
          "config.yml",
          "tickets_dir: tickets/open\ncoordination:\n  ref: refs/cankan/custom\n",
        );
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        expect(board.coordinationRef).toBe("refs/cankan/custom");
        expect(board.ticketsDir).toBe(join(await realpath(repo.dir), "tickets", "open"));
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("two different boards' own configs are read independently -- --board <name> must never see another board's policy", async () => {
    await withEnv(undefined, async () => {
      const repoA = await makeTempRepo();
      const repoB = await makeTempRepo();
      try {
        await writeRepoConfigFile(repoA.dir, "config.yml", "tickets_dir: a-tickets\n");
        await writeRepoConfigFile(repoB.dir, "config.yml", "tickets_dir: b-tickets\n");
        const boardA = await buildBoardRef({ kind: "repo", name: "a", root: repoA.dir });
        const boardB = await buildBoardRef({ kind: "repo", name: "b", root: repoB.dir });
        expect(boardA.ticketsDir.endsWith(join("a-tickets"))).toBe(true);
        expect(boardB.ticketsDir.endsWith(join("b-tickets"))).toBe(true);
      } finally {
        await repoA.cleanup();
        await repoB.cleanup();
      }
    });
  });
});

describe("buildBoardRef -- tickets_dir containment (ADR 0002, 542-630)", () => {
  test("rejects a tickets_dir that defeats a naive startsWith prefix check", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        // Board root is .../main; ../repo-evil/x string-prefixes as
        // ".../repo-evil/x", which a naive `startsWith(boardRoot)` check
        // would wrongly accept.
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: ../repo-evil/x\n");
        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
        // And nothing was created outside the board root.
        const evilDir = join(dirname(await realpath(repo.dir)), "repo-evil");
        expect(await pathExists(evilDir)).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("rejects a tickets_dir resolving inside <root>/.git", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: .git/cankan-evil\n");
        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
        expect(await pathExists(join(await realpath(repo.dir), ".git", "cankan-evil"))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("path.relative correctly distinguishes a sibling directory that merely shares a name prefix", async () => {
    await withEnv(undefined, async () => {
      // Root ".../main-extra" must not be treated as contained just
      // because it string-prefixes with ".../main".
      const repo = await makeTempRepo();
      try {
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        const siblingLikeName = `${board.root}-not-contained`;
        const rel = relative(board.root, siblingLikeName);
        expect(rel.split(sep)[0]).toBe("..");
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("buildBoardRef -- F1 regressions: a component named '..x' is genuinely contained, but must not let a symlink through", () => {
  test("mandatory repro 1: tickets_dir '..evil/tasks' with a committed symlink '..evil -> <writable dir>' throws and materializes nothing", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      const writableParent = await mkdtemp(join(tmpdir(), "cankan-ref-f1-writable-"));
      try {
        // `..evil` is a directory name that merely *starts with* `..` --
        // `path.relative(root, <root>/..evil/tasks)` is `..evil/tasks`,
        // whose first component is `..evil`, not `..`, so this is
        // genuinely contained by `isContained`'s component-wise check
        // (step (a) must pass, exactly as the ADR requires -- `..evil` is
        // not a parent-traversal). The exploit is entirely in what
        // `..evil` resolves to.
        await symlink(writableParent, join(repo.dir, "..evil"));
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: ..evil/tasks\n");

        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
        expect(await pathExists(join(writableParent, "tasks"))).toBe(false);
      } finally {
        await repo.cleanup();
        await rm(writableParent, { recursive: true, force: true });
      }
    });
  });

  test("mandatory repro 2: tickets_dir '..g/cankan-evil' with a committed symlink '..g -> .git' throws and materializes nothing inside .git", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await symlink(join(repo.dir, ".git"), join(repo.dir, "..g"));
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: ..g/cankan-evil\n");

        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
        expect(await pathExists(join(await realpath(repo.dir), ".git", "cankan-evil"))).toBe(false);
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("buildBoardRef -- F9: .git exclusion is platform-shape-aware, checked unconditionally", () => {
  test("rejects tickets_dir starting with '.GIT' (macOS case-insensitive-filesystem shape)", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: .GIT/cankan-evil\n");
        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("rejects tickets_dir starting with '.git.' (win32 trailing-dot-stripping shape)", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: .git./cankan-evil\n");
        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("buildBoardRef -- F5: a tickets_dir the filesystem itself cannot represent is a typed error", () => {
  test("a NUL byte in tickets_dir is wrapped as TICKETS_DIR_INVALID, not a raw TypeError", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", 'tickets_dir: "a\\0b"\n');
        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_INVALID");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("an excessively long tickets_dir component (ENAMETOOLONG) is wrapped as TICKETS_DIR_INVALID", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const longSegment = "x".repeat(5000);
        await writeRepoConfigFile(repo.dir, "config.yml", `tickets_dir: ${longSegment}\n`);
        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_INVALID");
      } finally {
        await repo.cleanup();
      }
    });
  });
});
