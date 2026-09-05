import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { loadConfig } from "../../src/config/index";
import {
  resolveGlobalConfigPath,
  resolveRepoConfigPath,
  resolveRepoLocalConfigPath,
} from "../../src/config/layers";
import { isCanKanError } from "../../src/errors";
import { hermeticEnv, makeTempRepoRoot, writeGlobalConfigFile, writeRepoConfigFile } from "./testHelpers";

describe("layer path resolution (R11)", () => {
  test("global config path uses XDG_CONFIG_HOME when set", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "/x/config", HOME: "/x/home" })).toBe(
      "/x/config/cankan/config.yml",
    );
  });

  test("global config path falls back to $HOME/.config when XDG_CONFIG_HOME is absent", () => {
    expect(resolveGlobalConfigPath({ HOME: "/x/home" })).toBe("/x/home/.config/cankan/config.yml");
  });

  test("global config path falls back to $HOME/.config when XDG_CONFIG_HOME is empty", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "", HOME: "/x/home" })).toBe(
      "/x/home/.config/cankan/config.yml",
    );
  });

  test("repo config path", () => {
    expect(resolveRepoConfigPath("/board")).toBe("/board/.cankan/config.yml");
  });

  test("repo-local config path", () => {
    expect(resolveRepoLocalConfigPath("/board")).toBe("/board/.cankan/local.yml");
  });
});

describe("the XDG fallback branch (R11's testability note)", () => {
  test("XDG_CONFIG_HOME unset falls back to $HOME/.config/cankan/config.yml", async () => {
    await withEnv(undefined, async () => {
      // Deliberately build an `env` object with HOME but with NO
      // XDG_CONFIG_HOME key at all -- not `XDG_CONFIG_HOME: undefined`,
      // and never by mutating process.env.XDG_CONFIG_HOME (which coerces
      // to the literal string "undefined" and would pass for the wrong
      // reason).
      const home = process.env.HOME as string;
      await writeGlobalConfigFile(join(home, ".config"), "editor: nano\n");

      const explicitEnv: Record<string, string | undefined> = { HOME: home };
      expect("XDG_CONFIG_HOME" in explicitEnv).toBe(false);

      const result = await loadConfig({ env: explicitEnv });
      expect(result.resolved("editor")?.value).toBe("nano");
      expect(result.resolved("editor")?.file).toBe(join(home, ".config", "cankan", "config.yml"));
    });
  });
});

describe("missing-layer tolerance (R12)", () => {
  test("no files at all resolves to pure defaults with layer: default", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv() });
      expect(result.layers).toEqual([]);
      expect(result.resolved("tickets_dir")).toEqual({
        key: "tickets_dir",
        value: "backlog/tasks",
        layer: "default",
      });
      expect(result.value.tickets_dir).toBe("backlog/tasks");
      expect(result.value.columns).toEqual(["To Do", "In Progress", "In Review", "Done"]);
    });
  });

  test("a global file with no repo (repoRoot omitted) works", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      await writeGlobalConfigFile(join(home, ".config"), "editor: emacs\n");
      const result = await loadConfig({ env: hermeticEnv() });
      expect(result.resolved("editor")?.value).toBe("emacs");
      expect(result.resolved("editor")?.layer).toBe("global");
      expect(result.layers.map((l) => l.layer)).toEqual(["global"]);
    });
  });

  test("repoRoot given but .cankan/ does not exist is not an error", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.layers).toEqual([]);
        expect(result.value.claims.lease).toBe("2h");
      } finally {
        await cleanup();
      }
    });
  });
});

describe("malformed-layer error quality (R13)", () => {
  test("names the file and the offending key for a schema failure", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const path = await writeRepoConfigFile(root, "config.yml", "claims:\n  lease: not-a-duration\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        const err = thrown as InstanceType<typeof Error> & { message: string };
        expect(err.message).toContain(path);
        expect(err.message).toContain("claims.lease");
      } finally {
        await cleanup();
      }
    });
  });

  test("names the file for an unreadable-but-present-shaped failure (unrecognized key)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const path = await writeRepoConfigFile(root, "config.yml", "totally_unknown_field: 1\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        const err = thrown as Error;
        expect(err.message).toContain(path);
        expect(err.message).toContain("totally_unknown_field");
      } finally {
        await cleanup();
      }
    });
  });
});

describe("out-of-namespace coordination.ref is rejected at load time (R14)", () => {
  test("in the repo layer, naming the file", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const path = await writeRepoConfigFile(root, "config.yml", "coordination:\n  ref: refs/heads/main\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(path);
      } finally {
        await cleanup();
      }
    });
  });

  test("in the repo-local layer, naming the file", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const path = await writeRepoConfigFile(root, "local.yml", "coordination:\n  ref: not-namespaced\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(path);
      } finally {
        await cleanup();
      }
    });
  });

  test("in the global layer, naming the file", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const path = await writeGlobalConfigFile(join(home, ".config"), "coordination:\n  ref: refs/heads/main\n");
      let thrown: unknown;
      try {
        await loadConfig({ env: hermeticEnv() });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain(path);
    });
  });
});
