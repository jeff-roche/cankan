import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("returns canonical (symlink-resolved) paths, reproducing the macOS $TMPDIR-under-/var condition", async () => {
    // The macOS CI failure this test guards against: `$TMPDIR` there is
    // under `/var/folders/...`, and `/var` is itself a symlink to
    // `/private/var`. `os.tmpdir()` (and therefore `mkdtemp`) returns the
    // un-resolved `/var/...` form verbatim; every git invocation against
    // the resulting repo reports the resolved `/private/var/...` form
    // instead, so a fixture that hands back `mkdtemp`'s raw result
    // disagrees with git about its own repository's path. This host is
    // Linux, where `/tmp` is not itself a symlink, so the condition is
    // reproduced directly with a real symlink and `TMPDIR`, rather than
    // relying on the host's own directory structure to happen to exercise
    // it — confirmed this reproduces the bug: reverting the `realpath()`
    // call in `tempRepo.ts` makes this exact test fail on this exact host.
    const realBase = await mkdtemp(join(tmpdir(), "cankan-tmpdir-real-"));
    const linkedBase = join(await realpath(tmpdir()), "cankan-tmpdir-link");
    await symlink(realBase, linkedBase);

    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = linkedBase;
    try {
      const repo = await makeTempRepo();
      try {
        // `os.tmpdir()` under this override returns the symlink form
        // verbatim (confirmed: `TMPDIR=<link> bun -e 'console.log(require("os").tmpdir())'`
        // prints `<link>`, unresolved) — so if `makeTempRepo` returned
        // `mkdtemp`'s raw result, `repo.root` would start with
        // `linkedBase`, not `realBase`. It must not.
        expect(repo.root.startsWith(linkedBase)).toBe(false);
        expect(repo.root.startsWith(realBase)).toBe(true);
        expect(repo.root).toBe(await realpath(repo.root));
        expect(repo.dir).toBe(await realpath(repo.dir));

        // The actual invariant this fixes: git's own report of the
        // repository's root agrees with what the fixture handed back —
        // this is exactly the comparison `git.test.ts`'s
        // `gitCommonDir`/`listWorktrees` assertions make, reproduced here
        // at the fixture level.
        const gitToplevel = git(repo.dir, ["rev-parse", "--show-toplevel"]).trim();
        expect(gitToplevel).toBe(repo.dir);
      } finally {
        await repo.cleanup();
      }
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      await rm(linkedBase, { force: true });
      await rm(realBase, { recursive: true, force: true });
    }
  });
});
