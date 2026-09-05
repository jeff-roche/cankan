import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { isCanKanError } from "../../src/errors";
import { writeRepoConfigFile } from "../config/testHelpers";

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

  test("ticketsDir is realpath'd and contained under root by path-component semantics", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const board = await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        expect(board.ticketsDir).toBe(await realpath(join(await realpath(repo.dir), "backlog", "tasks")));
        const rel = relative(board.root, board.ticketsDir);
        expect(rel.startsWith("..")).toBe(false);
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
        expect(board.ticketsDir).toBe(await realpath(join(await realpath(repo.dir), "tickets", "open")));
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
        await expect(realpath(evilDir)).rejects.toThrow();
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
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("rejects a tickets_dir reached through a symlinked path component, and creates nothing outside the board", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      const outsideParent = await mkdtemp(join(tmpdir(), "cankan-ref-outside-"));
      try {
        const outsideTarget = join(outsideParent, "victim");
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: backlog/tasks\n");
        // `backlog` is a checked-in-style symlink pointing outside the board.
        await symlink(outsideTarget, join(repo.dir, "backlog"));

        let thrown: unknown;
        try {
          await buildBoardRef({ kind: "repo", name: "api", root: repo.dir });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("TICKETS_DIR_ESCAPES_BOARD");
        let outsideExists = true;
        try {
          await realpath(outsideTarget);
        } catch {
          outsideExists = false;
        }
        expect(outsideExists).toBe(false);
      } finally {
        await repo.cleanup();
        await rm(outsideParent, { recursive: true, force: true });
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
        expect(rel.startsWith("..")).toBe(true);
      } finally {
        await repo.cleanup();
      }
    });
  });
});
