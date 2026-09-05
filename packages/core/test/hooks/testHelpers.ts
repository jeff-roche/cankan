import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway directory to use as `repoRoot`. `realpath`d for the same
 * reason `@jeff-roche/cankan-test-utils`'s `makeTempRepo` is (task brief
 * §9): on macOS, `$TMPDIR` sits under `/var/folders/...`, itself a symlink
 * to `/private/var/folders/...`, so an un-resolved path here would
 * disagree with anything that later canonicalizes it. Nothing in this
 * module canonicalizes paths itself, but resolving once here keeps every
 * comparison in these tests self-consistent regardless.
 */
export async function makeTempRepoRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cankan-hooks-repo-")));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Writes `content` to `repoRoot/.cankan/<name>`, creating the directory. */
export async function writeRepoConfigFile(
  repoRoot: string,
  name: "config.yml" | "local.yml",
  content: string,
): Promise<string> {
  const dir = join(repoRoot, ".cankan");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

/** Writes `content` to `$XDG_CONFIG_HOME/cankan/config.yml`. */
export async function writeGlobalConfigFile(xdgConfigHome: string, content: string): Promise<string> {
  const dir = join(xdgConfigHome, "cankan");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.yml");
  await writeFile(path, content);
  return path;
}

/**
 * An `env` for `loadConfig` carrying only `HOME`/`XDG_*` (read from
 * `withEnv`'s current `process.env`, so it still points at the temp home)
 * -- never the operator's real `CANKAN_*` vars, which these tests have no
 * reason to read. Call only from inside `withEnv()`.
 */
export function testConfigEnv(): Record<string, string | undefined> {
  const { HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME } = process.env;
  return { HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME };
}

/** `true` iff a process with `pid` currently exists (POSIX `kill(pid, 0)`). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `check` every `intervalMs` until it returns `true` or `timeoutMs` elapses. */
export async function pollUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}
