import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { effectiveConfigSchema } from "../src/config/index";
import type { ConfigResult, LoadedLayer } from "../src/config/index";
import { HooksErrorCodes } from "../src/hooks/errors";
import { runHooks } from "../src/hooks/runner";
import {
  grantRepoExecutableTrust,
  hasRepoExecutableTrust,
  repoExecutableFingerprint,
} from "../src/trust/index";

function config(data: Readonly<Record<string, unknown>>): ConfigResult {
  const layer: LoadedLayer = {
    layer: "repo",
    file: "/board/.cankan/config.yml",
    data,
  };
  return {
    value: effectiveConfigSchema.parse({}),
    layers: [layer],
    resolved: () => undefined,
    entries: () => [],
  };
}

describe("repository executable-config trust", () => {
  test("is opt-in and is invalidated when any executable value changes", async () => {
    const state = await mkdtemp(join(tmpdir(), "cankan-trust-"));
    const root = await mkdtemp(join(tmpdir(), "cankan-trust-board-"));
    const env = { XDG_STATE_HOME: state };
    const original = config({
      hooks: { close: "./notify" },
      editor: "code --wait",
      agents: { default_tool: "codex" },
    });
    const changed = config({
      hooks: { close: "./changed" },
      editor: "code --wait",
      agents: { default_tool: "codex" },
    });
    try {
      expect(await hasRepoExecutableTrust(root, original, env)).toBeFalse();
      await grantRepoExecutableTrust(root, original, env);
      expect(await hasRepoExecutableTrust(root, original, env)).toBeTrue();
      expect(repoExecutableFingerprint(changed)).not.toBe(
        repoExecutableFingerprint(original),
      );
      expect(await hasRepoExecutableTrust(root, changed, env)).toBeFalse();
    } finally {
      await rm(state, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds approval to the real board path, not a symlink spelling", async () => {
    const state = await mkdtemp(join(tmpdir(), "cankan-trust-state-"));
    const root = await mkdtemp(join(tmpdir(), "cankan-trust-board-"));
    const link = `${root}-link`;
    const env = { XDG_STATE_HOME: state };
    const cfg = config({ hooks: { close: "true" } });
    try {
      await symlink(root, link);
      await grantRepoExecutableTrust(link, cfg, env);
      expect(await hasRepoExecutableTrust(root, cfg, env)).toBeTrue();
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("refuses a repo hook until explicitly trusted, while allowing a user-local hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "cankan-trust-hook-"));
    const state = await mkdtemp(join(tmpdir(), "cankan-trust-state-"));
    const output = join(root, "ran.txt");
    const repoConfig = config({
      hooks: { close: `printf repo >> '${output}'` },
    });
    const cfg: ConfigResult = {
      ...repoConfig,
      layers: [
        ...repoConfig.layers,
        {
          layer: "repo-local",
          file: join(root, ".cankan", "local.yml"),
          data: { hooks: { close: `printf local >> '${output}'` } },
        },
      ],
    };
    const env = { XDG_STATE_HOME: state, PATH: process.env.PATH };
    try {
      const before = await runHooks({
        cfg,
        event: "close",
        repoRoot: root,
        trustEnv: env,
        env,
      });
      expect(before.map((outcome) => outcome.errorCode)).toEqual([
        HooksErrorCodes.HOOK_REPO_UNTRUSTED,
        undefined,
      ]);
      expect(await readFile(output, "utf8")).toBe("local");
      await grantRepoExecutableTrust(root, cfg, env);
      const after = await runHooks({
        cfg,
        event: "close",
        repoRoot: root,
        trustEnv: env,
        env,
      });
      expect(after.map((outcome) => outcome.exitCode)).toEqual([0, 0]);
      expect(await readFile(output, "utf8")).toBe("localrepolocal");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});
