import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { loadConfig } from "../../src/config/index";
import { isCanKanError } from "../../src/errors";
import { hermeticEnv, makeTempRepoRoot, writeGlobalConfigFile, writeRepoConfigFile } from "./testHelpers";

describe("LoadConfigOptions.env defaults to process.env", () => {
  // Every other test in this suite passes an explicit, hermetic `env` (see
  // `hermeticEnv` in testHelpers.ts) so a stray `CANKAN_*` var in the
  // operator's own shell can't change a resolution result out from under an
  // assertion. This is the one deliberate exception, covering the default
  // itself -- `withEnv` still keeps HOME/XDG_CONFIG_HOME pointed at a temp
  // dir, so it only reads a real `~/.config/cankan/config.yml` if this
  // process somehow still has a stray CANKAN_EDITOR set, which is not
  // something this suite otherwise depends on.
  test("omitting `env` reads process.env, which withEnv has pointed at a temp HOME", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      await writeGlobalConfigFile(join(home, ".config"), "editor: vim\n");
      const result = await loadConfig({});
      expect(result.resolved("editor")?.value).toBe("vim");
    });
  });
});

// ---------------------------------------------------------------------------
// PLAN.md's three named tests -- the floor.
// ---------------------------------------------------------------------------

describe("PLAN.md's three floor tests", () => {
  test("1. a preference key overridden by local config", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "claims:\n  lease: 4h\n");
        await writeRepoConfigFile(root, "local.yml", "claims:\n  lease: 1h\n");
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.claims.lease).toBe("1h");
        expect(result.resolved("claims.lease")?.layer).toBe("repo-local");
      } finally {
        await cleanup();
      }
    });
  });

  test("2. a policy key NOT overridden by env", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "claims:\n  max_per_actor: 3\n");
        const result = await loadConfig({
          repoRoot: root,
          env: hermeticEnv({ CANKAN_CLAIMS__MAX_PER_ACTOR: "999" }),
        });
        expect(result.value.claims.max_per_actor).toBe(3);
        expect(result.resolved("claims.max_per_actor")?.layer).toBe("repo");
      } finally {
        await cleanup();
      }
    });
  });

  test("3. a !policy pin raises POLICY_VIOLATION with the pinning file named in details", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const repoPath = await writeRepoConfigFile(root, "config.yml", "sync: !policy\n  auto_push: all\n");
        await writeRepoConfigFile(root, "local.yml", "sync:\n  auto_push: off\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        const err = thrown as InstanceType<typeof Error> & {
          code: string;
          details?: Record<string, unknown>;
        };
        expect(err.code).toBe("POLICY_VIOLATION");
        expect(err.message).toContain(".cankan/config.yml");
        expect(err.details?.key).toBe("sync.auto_push");
        expect(err.details?.pinnedBy).toBe(repoPath);
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Full precedence table.
// ---------------------------------------------------------------------------

describe("full precedence table", () => {
  test("preference key: each of the five rungs wins in turn as higher rungs are removed", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;

        // All five layers set claims.lease.
        await writeGlobalConfigFile(join(home, ".config"), "claims:\n  lease: 5h\n");
        await writeRepoConfigFile(root, "config.yml", "claims:\n  lease: 4h\n");
        await writeRepoConfigFile(root, "local.yml", "claims:\n  lease: 3h\n");
        let result = await loadConfig({
          repoRoot: root,
          env: hermeticEnv({ CANKAN_CLAIMS__LEASE: "1h" }),
        });
        expect(result.value.claims.lease).toBe("1h");
        expect(result.resolved("claims.lease")?.layer).toBe("env");

        // Remove env -> repo-local wins.
        result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.claims.lease).toBe("3h");
        expect(result.resolved("claims.lease")?.layer).toBe("repo-local");

        // Remove repo-local -> repo wins.
        await writeRepoConfigFile(root, "local.yml", "\n");
        result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.claims.lease).toBe("4h");
        expect(result.resolved("claims.lease")?.layer).toBe("repo");

        // Remove repo -> global wins.
        await writeRepoConfigFile(root, "config.yml", "\n");
        result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.claims.lease).toBe("5h");
        expect(result.resolved("claims.lease")?.layer).toBe("global");

        // Remove global -> default wins.
        await writeGlobalConfigFile(join(home, ".config"), "\n");
        result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.claims.lease).toBe("2h");
        expect(result.resolved("claims.lease")?.layer).toBe("default");
      } finally {
        await cleanup();
      }
    });
  });

  test("policy key: four rungs, and env is demonstrably absent from the chain", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;

        await writeGlobalConfigFile(join(home, ".config"), "claims:\n  max_per_actor: 5\n");
        await writeRepoConfigFile(root, "config.yml", "claims:\n  max_per_actor: 4\n");
        await writeRepoConfigFile(root, "local.yml", "claims:\n  max_per_actor: 3\n");

        // env set too -- must be ignored throughout, never an error.
        const env = hermeticEnv({ CANKAN_CLAIMS__MAX_PER_ACTOR: "999" });

        let result = await loadConfig({ repoRoot: root, env });
        expect(result.value.claims.max_per_actor).toBe(4);
        expect(result.resolved("claims.max_per_actor")?.layer).toBe("repo");

        await writeRepoConfigFile(root, "config.yml", "\n");
        result = await loadConfig({ repoRoot: root, env });
        expect(result.value.claims.max_per_actor).toBe(3);
        expect(result.resolved("claims.max_per_actor")?.layer).toBe("repo-local");

        await writeRepoConfigFile(root, "local.yml", "\n");
        result = await loadConfig({ repoRoot: root, env });
        expect(result.value.claims.max_per_actor).toBe(5);
        expect(result.resolved("claims.max_per_actor")?.layer).toBe("global");

        await writeGlobalConfigFile(join(home, ".config"), "\n");
        result = await loadConfig({ repoRoot: root, env });
        expect(result.value.claims.max_per_actor).toBe(3); // built-in default
        expect(result.resolved("claims.max_per_actor")?.layer).toBe("default");
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Source attribution correctness for each rung.
// ---------------------------------------------------------------------------

describe("source attribution", () => {
  test("resolved(key).layer and .file for each rung; file absent for env/default; envVar set for env", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;
        const globalPath = await writeGlobalConfigFile(join(home, ".config"), "editor: vim\n");
        const repoPath = await writeRepoConfigFile(root, "config.yml", "project: repo-project\n");
        const localPath = await writeRepoConfigFile(root, "local.yml", "actor: alice\n");

        const result = await loadConfig({
          repoRoot: root,
          env: hermeticEnv({ CANKAN_PARENT: "ck-1" }),
        });

        const globalEntry = result.resolved("editor");
        expect(globalEntry).toEqual({ key: "editor", value: "vim", layer: "global", file: globalPath });

        const repoEntry = result.resolved("project");
        expect(repoEntry).toEqual({
          key: "project",
          value: "repo-project",
          layer: "repo",
          file: repoPath,
        });

        const localEntry = result.resolved("actor");
        expect(localEntry).toEqual({ key: "actor", value: "alice", layer: "repo-local", file: localPath });

        const envEntry = result.resolved("parent");
        expect(envEntry).toEqual({ key: "parent", value: "ck-1", layer: "env", envVar: "CANKAN_PARENT" });
        expect(envEntry?.file).toBeUndefined();

        const defaultEntry = result.resolved("tickets_dir");
        expect(defaultEntry).toEqual({ key: "tickets_dir", value: "backlog/tasks", layer: "default" });
        expect(defaultEntry?.file).toBeUndefined();
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// entries()
// ---------------------------------------------------------------------------

describe("resolved() for a key with no effective value anywhere", () => {
  test("returns undefined, and the key is absent from entries()", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv() });
      // `id_prefix` has no built-in default and nothing set it.
      expect(result.resolved("id_prefix")).toBeUndefined();
      expect(result.entries().some((e) => e.key === "id_prefix")).toBe(false);
      expect(result.value.id_prefix).toBeUndefined();
    });
  });
});

describe("entries()", () => {
  test("enumerates every effective key and is sorted", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv() });
      const entries = result.entries();
      expect(entries.length).toBeGreaterThan(0);
      const keys = entries.map((e) => e.key);
      const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(keys).toEqual(sorted);
      expect(keys).toContain("tickets_dir");
      expect(keys).toContain("claims.lease");
      // Every key claims.lease is present exactly once.
      expect(keys.filter((k) => k === "claims.lease")).toHaveLength(1);
    });
  });

  test("dynamic map entries (backers/queues/hooks) appear per-leaf", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(
          root,
          "config.yml",
          "backers:\n  github:\n    repo: owner/name\nhooks:\n  on_claim: echo hi\n",
        );
        const home = process.env.HOME as string;
        await writeGlobalConfigFile(join(home, ".config"), "backers:\n  jira-work:\n    type: jira\n    credential: jira-cred\n");

        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        const keys = result.entries().map((e) => e.key);
        expect(keys).toContain("backers.github.repo");
        expect(keys).toContain("hooks.on_claim");
        expect(keys).toContain("backers.jira-work.credential");
        expect(keys).toContain("backers.jira-work.type");
      } finally {
        await cleanup();
      }
    });
  });

  test("a present-but-empty map entry survives (does not silently vanish from `value`)", async () => {
    // `flattenLeaves` only records a dotted path where it finds an actual
    // leaf value; a genuinely empty map entry (`queues: { urgent: {} }` --
    // a legal, empty `queueEntrySchema`) has no leaves beneath it at all,
    // so a naive implementation records nothing for it and it disappears
    // from `value` entirely, even though `{}` is valid, present data.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "queues:\n  urgent: {}\n");
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.queues?.urgent).toEqual({});
      } finally {
        await cleanup();
      }
    });
  });

  test("an empty map entry in one layer does not clobber a more specific leaf from another layer, in either iteration order", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;
        // repo declares the backer entry (as `{}`, no fields yet); global
        // fills in a field on the *same* entry name. Neither file alone
        // determines final iteration order of the underlying Set, so the
        // merge must be order-independent.
        await writeRepoConfigFile(root, "config.yml", "backers:\n  github: {}\n");
        await writeGlobalConfigFile(
          join(home, ".config"),
          "backers:\n  github:\n    type: github\n    credential: cred1\n",
        );
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.backers?.github).toEqual({ type: "github", credential: "cred1" });
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// !policy on all three node kinds.
// ---------------------------------------------------------------------------

describe("!policy on scalar, sequence, and map nodes (R6)", () => {
  test("scalar", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "sync:\n  auto_push: !policy all\n");
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.sync.auto_push).toBe("all");
        expect(result.resolved("sync.auto_push")?.pinnedBy).toBeDefined();
      } finally {
        await cleanup();
      }
    });
  });

  test("sequence", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", 'ready:\n  order: !policy [rank, "priority:desc"]\n');
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.ready.order).toEqual(["rank", "priority:desc"]);
        expect(result.resolved("ready.order")?.pinnedBy).toBeDefined();
      } finally {
        await cleanup();
      }
    });
  });

  test("map", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "sync: !policy\n  auto_push: transitions_only\n  auto_pull: on_prime\n");
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.sync.auto_push).toBe("transitions_only");
        expect(result.value.sync.auto_pull).toBe("on_prime");
        expect(result.resolved("sync.auto_push")?.pinnedBy).toBeDefined();
        // The tag applies to the tagged node AND every leaf beneath it,
        // including one repo never actually set (falls through to the
        // built-in default, but is still marked pinned).
        expect(result.resolved("sync.conflict_policy")?.pinnedBy).toBeDefined();
        expect(result.resolved("sync.conflict_policy")?.layer).toBe("default");
      } finally {
        await cleanup();
      }
    });
  });

  test("registering the tag does not change the YAML schema version (S3): plain off stays a string", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "sync:\n  auto_push: !policy off\n");
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.sync.auto_push).toBe("off");
      } finally {
        await cleanup();
      }
    });
  });

  test("S3, the literal ask: an UNTAGGED sync.auto_push: off still parses as the string \"off\" once the !policy tag is registered", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        // No !policy anywhere in this file -- registering customTags for
        // the repo layer's parse (unconditionally, for every repo config
        // load) must not itself booleanize a plain, untagged `off`.
        await writeRepoConfigFile(root, "config.yml", "sync:\n  auto_push: off\n");
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.sync.auto_push).toBe("off");
        expect(typeof result.value.sync.auto_push).toBe("string");
      } finally {
        await cleanup();
      }
    });
  });
});

describe("!policy in local/global is a load error naming that file (R6, S4)", () => {
  test("in .cankan/local.yml", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const localPath = await writeRepoConfigFile(root, "local.yml", "editor: !policy vim\n");
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(localPath);
      } finally {
        await cleanup();
      }
    });
  });

  test("in the global config", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const globalPath = await writeGlobalConfigFile(join(home, ".config"), "editor: !policy vim\n");
      let thrown: unknown;
      try {
        await loadConfig({ env: hermeticEnv() });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain(globalPath);
    });
  });

  test("smuggled through a YAML alias in local.yml (S4)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const localPath = await writeRepoConfigFile(
          root,
          "local.yml",
          "agents:\n  default_tool: &pinned !policy custom-tool\neditor: *pinned\n",
        );
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as Error).message).toContain(localPath);
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Non-violations.
// ---------------------------------------------------------------------------

describe("non-violations that an implementation naturally gets wrong (R7)", () => {
  test("a global config setting a built-in policy key (no pin) is legal and silently overridden", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "project: p\n"); // no columns pin
        const home = process.env.HOME as string;
        await writeGlobalConfigFile(join(home, ".config"), 'columns: ["A", "B"]\n');

        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.columns).toEqual(["A", "B"]);
        expect(result.resolved("columns")?.layer).toBe("global");
      } finally {
        await cleanup();
      }
    });
  });

  test("env on a policy key is silently ignored: resolved value is the repo's, no error", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", 'columns: ["Repo A", "Repo B"]\n');
        const result = await loadConfig({
          repoRoot: root,
          env: hermeticEnv({ CANKAN_COLUMNS: '["Env A"]' }),
        });
        expect(result.value.columns).toEqual(["Repo A", "Repo B"]);
        expect(result.resolved("columns")?.layer).toBe("repo");
      } finally {
        await cleanup();
      }
    });
  });

  test("env on a !policy-pinned key is silently ignored, not an error", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "sync: !policy\n  auto_push: all\n");
        const result = await loadConfig({
          repoRoot: root,
          env: hermeticEnv({ CANKAN_SYNC__AUTO_PUSH: "off" }),
        });
        expect(result.value.sync.auto_push).toBe("all");
        expect(result.resolved("sync.auto_push")?.layer).toBe("repo");
      } finally {
        await cleanup();
      }
    });
  });

  test("S4: env cannot be used to make an attempted override appear satisfied when a real violation exists", async () => {
    // R7(b) (env silently ignored) and R7 (an actual local/global override
    // of a pinned key is eager and fatal) must not be the same code path in
    // a way that lets a stray env var short-circuit the violation check.
    // The env var here even matches the *repo's own pinned value* -- if the
    // implementation mistakenly treated "env agrees with the pin" as
    // satisfying the pin, this would pass with no error, which is wrong.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "sync: !policy\n  auto_push: all\n");
        await writeRepoConfigFile(root, "local.yml", "sync:\n  auto_push: off\n");
        let thrown: unknown;
        try {
          await loadConfig({
            repoRoot: root,
            env: hermeticEnv({ CANKAN_SYNC__AUTO_PUSH: "all" }),
          });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as InstanceType<typeof Error> & { code: string }).code).toBe(
          "POLICY_VIOLATION",
        );
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Env mapping and coercion (R8-R10).
// ---------------------------------------------------------------------------

describe("env mapping (R8)", () => {
  test("CANKAN_ACTOR -> actor (the fixed point)", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv({ CANKAN_ACTOR: "bob" }) });
      expect(result.value.actor).toBe("bob");
      expect(result.resolved("actor")).toEqual({
        key: "actor",
        value: "bob",
        layer: "env",
        envVar: "CANKAN_ACTOR",
      });
    });
  });

  test("CANKAN_CLAIMS__LEASE -> claims.lease", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv({ CANKAN_CLAIMS__LEASE: "9h" }) });
      expect(result.value.claims.lease).toBe("9h");
    });
  });

  test("a CANKAN_* var that maps to no schema key is ignored", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv({ CANKAN_NOT_A_REAL_KEY: "x" }) });
      expect(result.entries().some((e) => e.key.includes("not_a_real_key"))).toBe(false);
    });
  });

  test("CANKAN_GITHUB_TOKEN is ignored and never appears in entries()", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv({ CANKAN_GITHUB_TOKEN: "sekrit-token" }) });
      const entries = result.entries();
      expect(entries.some((e) => e.key.toLowerCase().includes("token"))).toBe(false);
      expect(entries.some((e) => JSON.stringify(e.value).includes("sekrit-token"))).toBe(false);
    });
  });
});

describe("S5 -- env may reach the global-only sections (a ruling, not a bug)", () => {
  test("CANKAN_PERSONAL__REMOTE sets what a repo file cannot", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        // A repo file cannot even parse `personal.*` (schema.ts scopes it
        // to global-only) -- proven separately by schema.test.ts. Env is
        // not subject to that per-file scoping.
        await writeRepoConfigFile(root, "config.yml", "project: p\n");
        const result = await loadConfig({
          repoRoot: root,
          env: hermeticEnv({ CANKAN_PERSONAL__REMOTE: "git@example.com:me/personal.git" }),
        });
        expect(result.value.personal?.remote).toBe("git@example.com:me/personal.git");
        expect(result.resolved("personal.remote")?.layer).toBe("env");
      } finally {
        await cleanup();
      }
    });
  });
});

describe("env coercion (R9)", () => {
  test("a numeric key set from a string coerces", async () => {
    // `version` is unclassified -> preference by default (R2), and numeric
    // -- unlike `claims.max_per_actor`, which is a *policy* key and so has
    // no env rung at all (R7(b), covered separately above).
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv({ CANKAN_VERSION: "7" }) });
      expect(result.value.version).toBe(7);
      expect(typeof result.value.version).toBe("number");
    });
  });

  test("an invalid value is a load error naming the variable and the key", async () => {
    await withEnv(undefined, async () => {
      let thrown: unknown;
      try {
        await loadConfig({ env: hermeticEnv({ CANKAN_CLAIMS__LEASE: "not-a-duration" }) });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      const message = (thrown as Error).message;
      expect(message).toContain("CANKAN_CLAIMS__LEASE");
      expect(message).toContain("claims.lease");
    });
  });
});

// ---------------------------------------------------------------------------
// S1 -- the prototype-pollution guard.
// ---------------------------------------------------------------------------

describe("the dotted-path rebuild rejects __proto__/constructor/prototype segments (S1)", () => {
  test("hooks.__proto__.pwned and a constructor variant leave Object.prototype untouched", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        // status_map's value type is z.unknown() -- opaque, so arbitrary
        // nested keys survive schema validation into layer data, exactly
        // the shape the merge step must defend on its own.
        await writeRepoConfigFile(
          root,
          "config.yml",
          [
            "backers:",
            "  github:",
            "    status_map:",
            "      todo:",
            "        label: Ready",
            "        __proto__:",
            "          pwned: true",
            "        constructor:",
            "          prototype:",
            "            polluted: true",
            "",
          ].join("\n"),
        );

        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });

        expect((Object.prototype as Record<string, unknown>).pwned).toBeUndefined();
        expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
        expect(({} as Record<string, unknown>).pwned).toBeUndefined();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();

        // The safe sibling key survives; the dangerous ones do not.
        const statusMap = result.value.backers?.github?.status_map as
          | Record<string, unknown>
          | undefined;
        expect(statusMap?.todo).toEqual({ label: "Ready" });
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// R16 -- the yaml credential-leak mitigation.
// ---------------------------------------------------------------------------

describe("the yaml credential-leak mitigation (R16, required)", () => {
  test("a YAML syntax error near personal.remote never leaks the token into message or details, but would have leaked without the mitigation", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const token = "git@github.com:alice/cankan-personal-SUPER-SECRET-TOKEN.git";
      // Unterminated double-quote directly on the line carrying the token,
      // so yaml's own (unsanitized) error message would quote this exact
      // line verbatim.
      const content = `personal:\n  remote: "${token}\n`;
      const path = await writeGlobalConfigFile(join(home, ".config"), content);

      let thrown: unknown;
      try {
        await loadConfig({ env: hermeticEnv() });
      } catch (err) {
        thrown = err;
      }

      expect(isCanKanError(thrown)).toBe(true);
      const err = thrown as InstanceType<typeof Error> & {
        details?: Record<string, unknown>;
        cause?: unknown;
      };

      expect(err.message).not.toContain(token);
      expect(JSON.stringify(err.details)).not.toContain(token);
      // Proves the fixture would genuinely have leaked without the
      // mitigation -- yaml's own error carries the raw source line.
      expect(String(err.cause)).toContain(token);
      expect(err.message).toContain(path);
    });
  });
});

describe("S2 -- unrecognized_keys must not put the full offending key in message/details", () => {
  test("a YAML indentation mistake that turns a credential-bearing value into a map key is truncated", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const longToken =
        "git@host:user:TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890@example.com/x.git";
      expect(longToken.length).toBeGreaterThan(40);
      const content = `personal:\n  ${longToken}: foo\n`;
      await writeGlobalConfigFile(join(home, ".config"), content);

      let thrown: unknown;
      try {
        await loadConfig({ env: hermeticEnv() });
      } catch (err) {
        thrown = err;
      }

      expect(isCanKanError(thrown)).toBe(true);
      const err = thrown as InstanceType<typeof Error> & { details?: Record<string, unknown> };
      expect(err.message).not.toContain(longToken);
      expect(JSON.stringify(err.details)).not.toContain(longToken);
      // A truncated prefix is still named, per R13's "names the offending key".
      expect(err.message).toContain(longToken.slice(0, 20));
    });
  });
});
