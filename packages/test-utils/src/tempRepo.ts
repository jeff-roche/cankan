import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepoOptions {
  /** Number of additional worktrees to create, each on its own branch. */
  worktrees?: number;
  /** Create a bare repo and wire it up as `origin`. */
  bareRemote?: boolean;
}

export interface TempRepo {
  /** Root of the temp directory holding everything this fixture created. */
  root: string;
  /** The main working copy, checked out on `main`. */
  dir: string;
  /** One directory per requested worktree, on branches `wt/1`, `wt/2`, ... */
  worktreeDirs: string[];
  /** Path to the bare remote, if `bareRemote` was requested. */
  remoteDir?: string;
  /** Removes the entire temp directory tree. */
  cleanup: () => Promise<void>;
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${stderr}`);
  }
}

export async function makeTempRepo(
  options: TempRepoOptions = {},
): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "cankan-test-"));
  const dir = join(root, "main");

  git(root, ["init", "-b", "main", dir]);
  git(dir, ["config", "user.name", "CanKan Test"]);
  git(dir, ["config", "user.email", "test@cankan.invalid"]);
  git(dir, ["commit", "--allow-empty", "-m", "initial commit"]);

  let remoteDir: string | undefined;
  if (options.bareRemote) {
    remoteDir = join(root, "remote.git");
    git(root, ["init", "--bare", remoteDir]);
    git(dir, ["remote", "add", "origin", remoteDir]);
    git(dir, ["push", "-u", "origin", "main"]);
  }

  const worktreeDirs: string[] = [];
  const count = options.worktrees ?? 0;
  for (let i = 1; i <= count; i++) {
    const wtDir = join(root, `worktree-${i}`);
    git(dir, ["worktree", "add", "-b", `wt/${i}`, wtDir, "main"]);
    worktreeDirs.push(wtDir);
  }

  return {
    root,
    dir,
    worktreeDirs,
    remoteDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
