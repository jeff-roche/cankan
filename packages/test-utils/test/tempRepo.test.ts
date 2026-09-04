import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../src/tempRepo";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed:\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

describe("makeTempRepo", () => {
  test("two worktrees push and pull through a bare remote, then cleans up", async () => {
    const repo = await makeTempRepo({ worktrees: 2, bareRemote: true });

    try {
      expect(repo.worktreeDirs).toHaveLength(2);
      expect(repo.remoteDir).toBeDefined();

      const [wt1, wt2] = repo.worktreeDirs;

      // Worktree 1 commits and pushes its branch to the bare remote.
      const filePath = join(wt1, "hello.txt");
      await writeFile(filePath, "from worktree 1\n", "utf8");
      git(wt1, ["add", "hello.txt"]);
      git(wt1, ["commit", "-m", "add hello.txt from wt1"]);
      git(wt1, ["push", "origin", "wt/1"]);

      // Worktree 2 fetches that branch through the shared bare remote.
      git(wt2, ["fetch", "origin", "wt/1"]);
      git(wt2, ["checkout", "-b", "wt1-merged", "origin/wt/1"]);

      const content = await readFile(join(wt2, "hello.txt"), "utf8");
      expect(content).toBe("from worktree 1\n");
    } finally {
      await repo.cleanup();
    }

    expect(existsSync(repo.root)).toBe(false);
  });
});
