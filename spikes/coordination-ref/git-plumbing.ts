import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `git <args>` in `cwd`, optionally piping `input` to stdin. Never throws. */
export function git(
  cwd: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.input !== undefined ? Buffer.from(options.input) : undefined,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

/** Runs `git <args>`, throws with git's stderr if it fails, returns trimmed stdout. */
export function gitOrThrow(
  cwd: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): string {
  const result = git(cwd, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** git's well-known empty-tree sha - identical in every repo, never needs computing. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A ref that has never existed compares equal to this 40-zero sha for CAS purposes. */
export const ZERO_SHA = "0000000000000000000000000000000000000000";

/** Writes `content` as a git blob (in the repo's object store) and returns its sha. */
export function hashObject(cwd: string, content: string): string {
  return gitOrThrow(cwd, ["hash-object", "-w", "--stdin"], { input: content });
}

/**
 * Builds a new tree that is `baseTree` (or empty, when null) with `filePath` set
 * to `blobSha`, via a private temp index - never touches the repo's real index
 * or working tree. Each call uses its own temp index file, so this is safe to
 * call from multiple processes concurrently against the same repo.
 */
export async function writeTreeWithFile(
  cwd: string,
  baseTree: string | null,
  filePath: string,
  blobSha: string,
): Promise<string> {
  const indexDir = await mkdtemp(join(tmpdir(), "cankan-index-"));
  const indexFile = join(indexDir, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    if (baseTree) {
      gitOrThrow(cwd, ["read-tree", baseTree], { env });
    }
    gitOrThrow(
      cwd,
      ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${filePath}`],
      { env },
    );
    return gitOrThrow(cwd, ["write-tree"], { env });
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/** Builds a commit object for `tree` off-tree (no worktree involved). */
export function commitTree(
  cwd: string,
  tree: string,
  parent: string | null,
  message: string,
): string {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", message);
  return gitOrThrow(cwd, args);
}

/** The sha `ref` currently points at, or null if the ref doesn't exist. */
export function readRef(cwd: string, ref: string): string | null {
  const result = git(cwd, ["rev-parse", "--verify", ref]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Compare-and-swap: points `ref` at `newSha` only if it currently points at
 * `oldSha` (or, when `oldSha` is null, only if `ref` doesn't exist yet). This
 * is the whole CAS mechanism - the trailing old-value argument to
 * `update-ref` is what git checks atomically under its own ref lock.
 */
export function updateRefCAS(
  cwd: string,
  ref: string,
  newSha: string,
  oldSha: string | null,
): { ok: boolean; stderr: string } {
  const result = git(cwd, ["update-ref", ref, newSha, oldSha ?? ZERO_SHA]);
  return { ok: result.exitCode === 0, stderr: result.stderr.trim() };
}

/** Points `ref` at `newSha` unconditionally - no CAS check. Used by the file-lock path. */
export function updateRefForce(cwd: string, ref: string, newSha: string): void {
  gitOrThrow(cwd, ["update-ref", ref, newSha]);
}

/** Reads a file's content at a given commit, or null if it doesn't exist there. */
export function readFileAtCommit(
  cwd: string,
  commit: string,
  filePath: string,
): string | null {
  const result = git(cwd, ["cat-file", "-p", `${commit}:${filePath}`]);
  return result.exitCode === 0 ? result.stdout : null;
}

/** A short id for spike events. Not a real ULID (no new dependency for a throwaway spike). */
export function randomEventId(): string {
  return `evt-${randomUUID()}`;
}
