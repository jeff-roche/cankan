import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Writes `content` to `repoRoot/.cankan/<name>` (`config.yml` or
 * `local.yml`), creating the `.cankan/` directory if needed.
 */
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
export async function writeGlobalConfigFile(
  xdgConfigHome: string,
  content: string,
): Promise<string> {
  const dir = join(xdgConfigHome, "cankan");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.yml");
  await writeFile(path, content);
  return path;
}

/** Writes `content` to an arbitrary absolute file path, creating parents. */
export async function writeFileEnsuringDir(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * A throwaway directory to use as `repoRoot`, independent of `withEnv`'s
 * temp `$HOME` (a repo board root is never under `$HOME` in real use).
 * Callers are responsible for calling `cleanup()`, typically in a `finally`.
 */
export async function makeTempRepoRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "cankan-config-repo-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * An `env` object for `loadConfig` that carries only `HOME`/`XDG_*` (from
 * `withEnv`'s current `process.env`, so it still points at the temp home)
 * plus whatever `extra` a test needs -- never the operator's *real*
 * environment. `{ ...process.env, CANKAN_ACTOR: "x" }`, used directly,
 * would leak whatever `CANKAN_*` vars the person or CI running this suite
 * happens to have exported (the same hazard `withEnv` exists to close for
 * `~/.config`), making a test pass or fail for a reason that has nothing to
 * do with this module. Call only from inside `withEnv()`.
 */
export function hermeticEnv(
  extra?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const { HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME } = process.env;
  return {
    HOME,
    XDG_CONFIG_HOME,
    XDG_DATA_HOME,
    XDG_CACHE_HOME,
    XDG_STATE_HOME,
    ...extra,
  };
}

/**
 * Runs `fn` with every `CANKAN_*` var removed from the real `process.env`
 * for the duration, restoring exactly what was there afterward -- the same
 * save/delete/restore pattern `withEnv` uses for `HOME`/`XDG_*`.
 *
 * This exists for the one deliberate test of `LoadConfigOptions.env`'s
 * `?? process.env` default (review round 2 finding 8): `withEnv()` only
 * ever redirects `HOME`/`XDG_*`, never `CANKAN_*`, so a bare
 * `loadConfig({})` inside `withEnv()` alone still inherits whatever
 * `CANKAN_*` vars the operator's shell or CI happens to have exported --
 * exactly the leakage `hermeticEnv()` exists to close everywhere else in
 * this suite, just reached through the *other* channel (`process.env`
 * itself, not an explicit `env` object).
 */
export async function withoutCankanEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CANKAN_")) {
      saved.set(key, process.env[key] as string);
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of saved.keys()) {
      delete process.env[key];
    }
    for (const [key, value] of saved) {
      process.env[key] = value;
    }
  }
}
