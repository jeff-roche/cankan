import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@jeff-roche/cankan-core";
import { detectBackers, initOptionsFromArgs, initRepo } from "../src/commands/init";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

test("M3.2 initializes a bare repo into a readable board and is idempotent", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      const first = await initRepo({ cwd: repo.dir, noWizard: true, noBackers: true, env: process.env });
      expect(first.board.root).toBe(repo.dir);
      expect(first.selectedBackers).toEqual([]);

      const configPath = join(repo.dir, ".cankan", "config.yml");
      const localPath = join(repo.dir, ".cankan", "local.yml");
      expect((await stat(join(repo.dir, "backlog", "tasks"))).isDirectory()).toBe(true);
      expect(await readFile(localPath, "utf8")).toBe("{}\n");
      const configBefore = await readFile(configPath, "utf8");
      expect((await stat(configPath)).mode & 0o777).toBe(0o644);

      const board = await core.board.resolveBoard({ cwd: repo.dir, env: process.env });
      const adapter = await core.git.createGitAdapter(repo.dir);
      expect(await adapter.readRef(board.coordinationRef)).not.toBeNull();
      const store = await core.store.openTicketStore({ board, gitDirs: [await adapter.gitCommonDir()] });
      expect(await store.list()).toEqual({ tickets: [], skipped: [] });
      expect(await readFile(join(repo.dir, ".gitignore"), "utf8")).toContain(".cankan/local.yml");

      const second = await initRepo({ cwd: repo.dir, noWizard: true, noBackers: true, env: process.env });
      expect(second.board.root).toBe(repo.dir);
      expect(await readFile(configPath, "utf8")).toBe(configBefore);

      const registry = await core.board.listRegisteredBoards(process.env);
      expect(registry.boards).toHaveLength(1);
      expect(registry.boards[0]?.path).toBe(repo.dir);
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.2 detects GitHub, beads, and Jira without selecting them when disabled", async () => {
  const repo = await makeTempRepo();
  try {
    await appendFile(join(repo.dir, ".git", "config"), '\n[remote "origin"]\n\turl = git@github.com:owner/project.git\n');
    await mkdir(join(repo.dir, ".beads"));
  } catch {
    await repo.cleanup();
    throw new Error("test setup failed");
  }
  try {
    await withEnv({ JIRA_SITE: "https://jira.example.test", JIRA_PROJECT: "KAN" }, async () => {
      const result = await initRepo({ cwd: repo.dir, noWizard: true, noBackers: true, env: process.env });
      expect(result.detectedBackers.map((backer) => backer.type)).toEqual(["beads", "github", "jira"]);
      expect(result.selectedBackers).toEqual([]);
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.2 accepts kebab-case negative flags from citty", () => {
  expect(initOptionsFromArgs({}, ["--no-wizard", "--no-backers"])).toEqual({
    noWizard: true,
    noBackers: true,
  });
  expect(initOptionsFromArgs({}, ["--backer", "github", "--backer", "jira"])).toMatchObject({
    backers: ["github", "jira"],
  });
});

test("M3.2 persists a valid prefix and explicitly selected backer", async () => {
  const repo = await makeTempRepo();
  try {
    await appendFile(join(repo.dir, ".git", "config"), '\n[remote "origin"]\n\turl = https://github.com/owner/project.git\n');
    await withEnv(undefined, async () => {
      const result = await initRepo({
        cwd: repo.dir,
        backers: ["github"],
        noWizard: true,
        prefix: "proj",
        env: process.env,
      });
      expect(result.selectedBackers).toEqual(["github"]);
      const config = await readFile(join(repo.dir, ".cankan", "config.yml"), "utf8");
      expect(config).toContain("id_prefix: proj");
      expect(config).toContain("repo: owner/project");
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.2 detects supported GitHub remote URL forms", async () => {
  const urls = [
    "https://github.com/owner/project.git",
    "ssh://git@github.com/owner/project.git",
    "git@github.com:owner/project.git",
  ];
  for (const url of urls) {
    const repo = await makeTempRepo();
    try {
      await appendFile(join(repo.dir, ".git", "config"), `\n[remote "origin"]\n\turl = ${url}\n`);
      const result = await detectBackers(repo.dir, {});
      expect(result.backers).toEqual([{ type: "github", repo: "owner/project" }]);
    } finally {
      await repo.cleanup();
    }
  }
});

test("M3.2 refuses a symlinked setup directory", async () => {
  const repo = await makeTempRepo();
  const outside = await mkdtemp(join(tmpdir(), "cankan-init-outside-"));
  try {
    await symlink(outside, join(repo.dir, ".cankan"));
    await withEnv(undefined, async () => {
      await expect(initRepo({ cwd: repo.dir, noWizard: true, noBackers: true, env: process.env })).rejects.toMatchObject({
        code: core.ErrorCodes.USAGE,
      });
    });
    expect(await stat(outside)).toBeTruthy();
  } finally {
    await repo.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("M3.2 rejects backslashes in ticket prefixes", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await expect(
        initRepo({ cwd: repo.dir, noWizard: true, noBackers: true, prefix: "ck\\evil", env: process.env }),
      ).rejects.toMatchObject({ code: core.ErrorCodes.USAGE });
    });
  } finally {
    await repo.cleanup();
  }
});
