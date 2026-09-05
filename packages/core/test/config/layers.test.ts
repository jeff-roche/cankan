import { mkdir, symlink, writeFile } from "node:fs/promises";
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

describe("resolveGlobalConfigPath never returns a relative path (review round 2 finding 1)", () => {
  // Reproduced by security review: with HOME and XDG_CONFIG_HOME both
  // absent, the old implementation computed `join("", ".config")` ===
  // ".config" -- a cwd-relative path. In an environment with no HOME
  // (`env -i`, a distroless container, a systemd unit with no `User=`, or
  // an agent harness spawning this CLI with a scrubbed environment), a
  // repo-committed `.config/cankan/config.yml` would then load as the
  // "global" layer, reaching sections (`identity`, `credentials`,
  // `personal`) Task A deliberately fenced repo-controlled config out of.
  //
  // Deliberately NOT using `process.chdir` here (it's process-wide and
  // this suite shares a process with concurrently-running suites) --
  // testing the pure path resolver directly is enough to prove the fix,
  // and the "no global layer" integration test below proves it end to end
  // without touching the real working directory.
  test("yields undefined for {}", () => {
    expect(resolveGlobalConfigPath({})).toBeUndefined();
  });

  test("yields undefined for a relative HOME with no XDG_CONFIG_HOME", () => {
    expect(resolveGlobalConfigPath({ HOME: "rel" })).toBeUndefined();
  });

  test("ignores a relative XDG_CONFIG_HOME and falls back to $HOME/.config", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "rel", HOME: "/abs" })).toBe(
      "/abs/.config/cankan/config.yml",
    );
  });

  test("yields undefined when XDG_CONFIG_HOME is relative and HOME is also relative", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "rel", HOME: "also-rel" })).toBeUndefined();
  });

  test("loadConfig({ env: {} }) produces no global entry in layers", async () => {
    // Not wrapped in withEnv(): `env: {}` fully overrides HOME/XDG_* (both
    // undefined, regardless of this process's real environment), so
    // resolveGlobalConfigPath returns undefined and no file is ever read
    // -- this call touches zero real paths, hermetic by construction.
    const result = await loadConfig({ env: {} });
    expect(result.layers.some((l) => l.layer === "global")).toBe(false);
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
        path: ["tickets_dir"],
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

  test("with all three files present, `layers` is ordered repo-local, repo, global (review round 2 finding 10)", async () => {
    // `FILE_LAYER_ORDER` in resolve.ts is a hand-maintained array; this
    // pins the order it's expected to produce so a future edit that
    // silently reorders it fails a test rather than only being noticed by
    // a downstream consumer of `ConfigResult.layers`.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;
        const globalPath = await writeGlobalConfigFile(join(home, ".config"), "editor: vim\n");
        const repoPath = await writeRepoConfigFile(root, "config.yml", "project: p\n");
        const localPath = await writeRepoConfigFile(root, "local.yml", "actor: alice\n");

        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.layers.map((l) => l.layer)).toEqual(["repo-local", "repo", "global"]);
        expect(result.layers.map((l) => l.file)).toEqual([localPath, repoPath, globalPath]);
      } finally {
        await cleanup();
      }
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
        // Kept at 20 chars or fewer so review round 2's tighter S2
        // truncation cap (findings 2/3, MAX_ISSUE_KEY_DISPLAY_LEN = 20)
        // doesn't clip this benign field name -- the point of this test is
        // "the key is named", not "truncation didn't fire".
        const path = await writeRepoConfigFile(root, "config.yml", "unknown_field_xy: 1\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        const err = thrown as Error;
        expect(err.message).toContain(path);
        expect(err.message).toContain("unknown_field_xy");
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

// ---------------------------------------------------------------------------
// A committed symlink at a repo-controlled config path turns loadConfig
// into a read oracle (review round 2, fix round 2, finding 12).
// ---------------------------------------------------------------------------

describe("a symlinked repo-controlled config file is a load error; a symlinked global one still loads (review round 2 finding 12)", () => {
  test("a symlinked .cankan/config.yml is rejected, naming the file, without following the link", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      const outside = await makeTempRepoRoot(); // an unrelated dir, standing in for "any file the user can read"
      try {
        // The target is outside the repo entirely and shaped like a real
        // secret file (top-level keys that would otherwise leak via S2's
        // truncated-but-still-present unrecognized_keys message).
        const target = join(outside.root, "outside-target.yml");
        await writeFile(target, "github.com:\n  oauth_token: leaked-token-value\n");
        const linkPath = join(root, ".cankan", "config.yml");
        await mkdir(join(root, ".cankan"), { recursive: true });
        await symlink(target, linkPath);

        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(linkPath);
        // The point of the fix: the target's contents never reach the
        // error at all -- not even truncated -- because the file is never
        // read.
        expect((thrown as Error).message).not.toContain("github.com");
        expect((thrown as Error).message).not.toContain("leaked-token-value");
      } finally {
        await cleanup();
        await outside.cleanup();
      }
    });
  });

  test("a symlinked .cankan/local.yml is rejected, naming the file", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      const outside = await makeTempRepoRoot();
      try {
        const target = join(outside.root, "outside-target-local.yml");
        await writeFile(target, "editor: vim\n");
        const linkPath = join(root, ".cankan", "local.yml");
        await mkdir(join(root, ".cankan"), { recursive: true });
        await symlink(target, linkPath);

        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(linkPath);
      } finally {
        await cleanup();
        await outside.cleanup();
      }
    });
  });

  test("a symlinked global config.yml still loads normally -- the user's own file is not fenced", async () => {
    // Deliberate asymmetry: symlinking your own dotfiles (e.g. from a
    // dotfiles repo) into ~/.config/cankan/config.yml is a normal
    // workflow, and the global layer is not attacker-supplyable the way
    // the repo layers are.
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const target = join(home, "real-config.yml");
      await writeFile(target, "editor: vim\n");
      const linkPath = join(home, ".config", "cankan", "config.yml");
      await mkdir(join(home, ".config", "cankan"), { recursive: true });
      await symlink(target, linkPath);

      const result = await loadConfig({ env: hermeticEnv() });
      expect(result.resolved("editor")?.value).toBe("vim");
      expect(result.resolved("editor")?.file).toBe(linkPath);
    });
  });
});
