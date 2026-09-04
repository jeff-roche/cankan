import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const XDG_VARS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;
type XdgVar = (typeof XDG_VARS)[number];
type EnvOverrides = Partial<Record<"HOME" | XdgVar, string>>;

/**
 * Runs `fn` with `HOME` and the XDG_* vars pointed at a fresh temp
 * directory, so tests never read or write the real home directory.
 * Any var present in `overrides` is used verbatim instead of the temp
 * default. Restores the previous environment (and removes any temp
 * directory it created) once `fn` settles, success or failure.
 */
export async function withEnv<T>(
  overrides: EnvOverrides | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "cankan-env-"));
  const defaults: Required<EnvOverrides> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  const next = { ...defaults, ...overrides };

  const previous: Partial<Record<keyof EnvOverrides, string | undefined>> = {};
  for (const key of Object.keys(next) as (keyof EnvOverrides)[]) {
    previous[key] = process.env[key];
    process.env[key] = next[key];
  }

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(next) as (keyof EnvOverrides)[]) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    await rm(home, { recursive: true, force: true });
  }
}
