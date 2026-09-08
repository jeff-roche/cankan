import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as core from "@jeff-roche/cankan-core";
import {
  formatConfigGet,
  formatConfigShow,
  setConfigValue,
} from "../src/commands/config";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

test("M3.3 formats effective config and resolved source metadata", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await setConfigValue({
        repoRoot: repo.dir,
        key: "claims.lease",
        rawValue: "45m",
        target: "local",
        env: process.env,
      });
      const config = await core.config.loadConfig({
        repoRoot: repo.dir,
        env: process.env,
      });

      expect(formatConfigShow(config, {})).toEqual(config.value);
      expect(formatConfigShow(config, { resolved: true })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "claims.lease",
            value: "45m",
            layer: "repo-local",
          }),
        ]),
      );
      expect(formatConfigGet(config, "claims.lease")).toEqual({
        key: "claims.lease",
        value: "45m",
        layer: "repo-local",
        file: join(repo.dir, ".cankan", "local.yml"),
      });
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.3 parses YAML values and chooses policy defaults", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await setConfigValue({
        repoRoot: repo.dir,
        key: "claims.max_per_actor",
        rawValue: "7",
        env: process.env,
      });
      await setConfigValue({
        repoRoot: repo.dir,
        key: "ready.order",
        rawValue: "[priority:desc, id:asc]",
        env: process.env,
      });

      expect(
        await readFile(join(repo.dir, ".cankan", "config.yml"), "utf8"),
      ).toContain("max_per_actor: 7");
      expect(
        await readFile(join(repo.dir, ".cankan", "local.yml"), "utf8"),
      ).toContain("order:");
      const config = await core.config.loadConfig({
        repoRoot: repo.dir,
        env: process.env,
      });
      expect(config.value.claims.max_per_actor).toBe(7);
      expect(config.value.ready.order).toEqual(["priority:desc", "id:asc"]);
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.3 rejects writes that override a pinned policy", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      const configPath = join(repo.dir, ".cankan", "config.yml");
      await mkdir(join(repo.dir, ".cankan"), { recursive: true });
      await writeFile(
        join(repo.dir, ".cankan", "config.yml"),
        "sync: !policy\n  auto_push: all\n",
      );
      const before = await readFile(configPath, "utf8");
      await expect(
        setConfigValue({
          repoRoot: repo.dir,
          key: "sync.auto_push",
          rawValue: "off",
          target: "local",
          env: process.env,
        }),
      ).rejects.toMatchObject({
        code: core.ErrorCodes.POLICY_VIOLATION,
        message: expect.stringContaining(configPath),
      });
      expect(await readFile(configPath, "utf8")).toBe(before);
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.3 rejects an invalid root-level policy tag", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, ".cankan"), { recursive: true });
      await writeFile(join(repo.dir, ".cankan", "config.yml"), "!policy\n");
      await expect(
        setConfigValue({
          repoRoot: repo.dir,
          key: "claims.lease",
          rawValue: "45m",
          target: "local",
          env: process.env,
        }),
      ).rejects.toMatchObject({
        code: core.config.ConfigErrorCodes.INVALID_CONFIG,
      });
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.3 preserves scalar policy values when updating the repo config", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, ".cankan"), { recursive: true });
      await writeFile(
        join(repo.dir, ".cankan", "config.yml"),
        "claims:\n  max_per_actor: !policy 5\n",
      );
      await setConfigValue({
        repoRoot: repo.dir,
        key: "claims.require_ready",
        rawValue: "false",
        target: "repo",
        env: process.env,
      });
      const config = await core.config.loadConfig({
        repoRoot: repo.dir,
        env: process.env,
      });
      expect(config.value.claims.max_per_actor).toBe(5);
      expect(config.value.claims.require_ready).toBe(false);
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.3 refuses symlinked repository config files", async () => {
  const repo = await makeTempRepo();
  const source = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, ".cankan"), { recursive: true });
      await mkdir(join(source.dir, ".cankan"), { recursive: true });
      const sourceConfig = join(source.dir, ".cankan", "config.yml");
      await writeFile(sourceConfig, "claims:\n  max_per_actor: 5\n");
      await symlink(sourceConfig, join(repo.dir, ".cankan", "config.yml"));
      await expect(
        setConfigValue({
          repoRoot: repo.dir,
          key: "claims.require_ready",
          rawValue: "false",
          target: "local",
          env: process.env,
        }),
      ).rejects.toMatchObject({
        code: core.config.ConfigErrorCodes.INVALID_CONFIG,
      });
    });
  } finally {
    await repo.cleanup();
    await source.cleanup();
  }
});
