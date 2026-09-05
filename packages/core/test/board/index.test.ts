import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import * as board from "../../src/board/index";
import { isCanKanError } from "../../src/errors";
import { hermeticEnv, writeRepoConfigFile } from "../config/testHelpers";

describe("board/index.ts -- the public surface, wired end to end", () => {
  test("resolveBoard, register, findRegisteredBoard, listRegisteredBoards, resolveAllBoards and loadBoardConfig all resolve through the re-exported surface", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", "coordination:\n  ref: refs/cankan/from-index\n");
        await board.register("via-index", repo.dir, env);

        expect(board.isValidBoardName("via-index")).toBe(true);
        const found = await board.findRegisteredBoard("via-index", env);
        expect(found?.name).toBe("via-index");

        const resolved = await board.resolveBoard({
          cwd: repo.dir,
          flag: { kind: "name", name: "via-index" },
          env,
        });
        expect(resolved.coordinationRef).toBe("refs/cankan/from-index");

        const cfg = await board.loadBoardConfig(resolved, { env });
        expect(cfg.value.coordination.ref).toBe("refs/cankan/from-index");

        const listing = await board.listRegisteredBoards(env);
        expect(listing.boards.map((b) => b.name)).toContain("via-index");

        const all = await board.resolveAllBoards({ env });
        expect(all.boards.map((b) => b.name)).toContain("via-index");

        expect(typeof board.BoardErrorCodes.BOARD_NOT_REGISTERED).toBe("string");
        expect(board.resolvePersonalBoardPath(env)).toBeDefined();
        expect(board.resolveRegistryPath(env)).toBeDefined();
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("ensurePersonalBoard is reachable from the public surface, and buildBoardRef is deliberately not exported", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const result = await board.ensurePersonalBoard({ env });
      expect(result.board.kind).toBe("personal");
      expect("buildBoardRef" in board).toBe(false);
      expect("resolveDataHome" in board).toBe(false);
    });
  });
});

describe("loadBoardConfig -- the M2.3 wire (B3)", () => {
  test("two boards holding different config each get their own values, resolved by --board <name> from a cwd inside neither, with attribution naming that board's file", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repoA = await makeTempRepo();
      const repoB = await makeTempRepo();
      const outsider = await makeTempRepo();
      try {
        await writeRepoConfigFile(
          repoA.dir,
          "config.yml",
          "coordination:\n  ref: refs/cankan/team-a\nid_prefix: team-a\n",
        );
        await writeRepoConfigFile(
          repoB.dir,
          "config.yml",
          "coordination:\n  ref: refs/cankan/team-b\nid_prefix: team-b\n",
        );
        await board.register("team-a", repoA.dir, env);
        await board.register("team-b", repoB.dir, env);

        const boardA = await board.resolveBoard({
          cwd: outsider.dir,
          flag: { kind: "name", name: "team-a" },
          env,
        });
        const boardB = await board.resolveBoard({
          cwd: outsider.dir,
          flag: { kind: "name", name: "team-b" },
          env,
        });

        const cfgA = await board.loadBoardConfig(boardA, { env });
        const cfgB = await board.loadBoardConfig(boardB, { env });

        expect(cfgA.value.coordination.ref).toBe("refs/cankan/team-a");
        expect(cfgB.value.coordination.ref).toBe("refs/cankan/team-b");
        expect(cfgA.value.id_prefix).toBe("team-a");
        expect(cfgB.value.id_prefix).toBe("team-b");

        // Attribution reads `entry.path` (authoritative), never `entry.key`
        // (a lossy display join) -- controller addendum 3.
        const entryA = cfgA.resolved(["coordination", "ref"]);
        const entryB = cfgB.resolved(["coordination", "ref"]);
        expect(entryA?.path).toEqual(["coordination", "ref"]);
        expect(entryB?.path).toEqual(["coordination", "ref"]);
        expect(entryA?.file).toBe(join(await realpath(repoA.dir), ".cankan", "config.yml"));
        expect(entryB?.file).toBe(join(await realpath(repoB.dir), ".cankan", "config.yml"));
        expect(entryA?.file).not.toBe(entryB?.file);
      } finally {
        await repoA.cleanup();
        await repoB.cleanup();
        await outsider.cleanup();
      }
    });
  });

  test("loadBoardConfig against the personal board reads a different file than the cwd's own repo", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", "id_prefix: repo-value\n");
        const personal = await board.ensurePersonalBoard({ env });

        const repoBoard = await board.resolveBoard({ cwd: repo.dir, flag: { kind: "repo" }, env });
        const cfgRepo = await board.loadBoardConfig(repoBoard, { env });
        const cfgPersonal = await board.loadBoardConfig(personal.board, { env });

        expect(cfgRepo.value.id_prefix).toBe("repo-value");
        expect(cfgPersonal.value.id_prefix).toBeUndefined();
        expect(cfgRepo.resolved(["id_prefix"])?.file).toBe(join(await realpath(repo.dir), ".cankan", "config.yml"));
        expect(cfgPersonal.resolved(["id_prefix"])).toBeUndefined();
      } finally {
        await repo.cleanup();
      }
    });
  });
});

describe("board/index.ts -- reserved names surface through the same public functions", () => {
  test("register() and findRegisteredBoard() both reject 'all' the same way, reachable through the index", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const repo = await makeTempRepo();
      try {
        let thrown: unknown;
        try {
          await board.register("all", repo.dir, env);
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
      } finally {
        await repo.cleanup();
      }
    });
  });
});
