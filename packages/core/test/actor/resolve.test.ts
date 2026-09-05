import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import {
  ActorErrorCodes,
  type Actor,
  formatActor,
  parseActor,
  type ResolvedActor,
  resolveActor,
} from "../../src/actor/index";
import type { ConfigResult } from "../../src/config/index";
import { loadConfig } from "../../src/config/index";
import { isCanKanError } from "../../src/errors";
import {
  hermeticEnv,
  makeTempRepoRoot,
  writeGlobalConfigFile,
  writeRepoConfigFile,
} from "../config/testHelpers";

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/**
 * Builds a real `ConfigResult` (via the actual `loadConfig`, never a hand
 * rolled fake) for one precedence-table row -- must run inside `withEnv()`,
 * same as `config/resolve.test.ts`. `JSON.stringify` embeds an arbitrary
 * string value as a YAML double-quoted scalar, so a value containing `:`,
 * `""`, or nothing special all round-trip through the file without a
 * bespoke YAML-escaping helper.
 */
async function buildConfig(opts: {
  root: string;
  localActor?: string;
  localParent?: string;
  globalIdentityName?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ConfigResult> {
  if (opts.localActor !== undefined || opts.localParent !== undefined) {
    const lines = [
      ...(opts.localActor !== undefined ? [`actor: ${JSON.stringify(opts.localActor)}`] : []),
      ...(opts.localParent !== undefined ? [`parent: ${JSON.stringify(opts.localParent)}`] : []),
    ];
    await writeRepoConfigFile(opts.root, "local.yml", `${lines.join("\n")}\n`);
  }
  if (opts.globalIdentityName !== undefined) {
    const home = process.env.HOME as string; // withEnv has pointed this at a temp dir
    await writeGlobalConfigFile(
      join(home, ".config"),
      `identity:\n  name: ${JSON.stringify(opts.globalIdentityName)}\n`,
    );
  }
  return loadConfig({ repoRoot: opts.root, env: hermeticEnv(opts.env) });
}

/** A `gitUserName` stub that records how many times it was called. */
function gitStub(value: string | null): {
  fn: () => Promise<string | null>;
  state: { callCount: number };
} {
  const state = { callCount: 0 };
  const fn = async () => {
    state.callCount++;
    return value;
  };
  return { fn, state };
}

/**
 * Spawns real git in test code, wired to a real temp repo, to prove R-2's
 * injected-thunk seam end-to-end rather than only against a stub. This is
 * fine and expected per the brief's test-hygiene section: R-2 constrains
 * `src/actor/` (no command execution there), not test code.
 * `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` keep this
 * hermetic against the developer's own `~/.gitconfig`.
 */
function realGitUserNameThunk(cwd: string): () => Promise<string | null> {
  return async () => {
    const result = Bun.spawnSync(["git", "config", "user.name"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const name = result.stdout.toString().trim();
    return name.length > 0 ? name : null;
  };
}

async function expectCanKanError(
  run: () => Promise<unknown>,
  code: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    await run();
  } catch (e) {
    if (!isCanKanError(e)) {
      throw e;
    }
    expect(e.code).toBe(code);
    return e.details as Record<string, unknown> | undefined;
  }
  throw new Error("expected a CanKanError to be thrown");
}

// ---------------------------------------------------------------------------
// parseActor / formatActor -- the grammar (R-9).
// ---------------------------------------------------------------------------

describe("parseActor — valid grammar, and the parse -> format -> parse round trip", () => {
  test.each([
    ["alice", { tool: null, name: "alice", context: null }],
    ["claude-code:alice/worktree-auth", { tool: "claude-code", name: "alice", context: "worktree-auth" }],
    ["codex:ci", { tool: "codex", name: "ci", context: null }],
  ] satisfies [string, Actor][])("parseActor(%j)", (raw, expected) => {
    expect(parseActor(raw)).toEqual(expected);
  });

  test.each([
    "alice",
    "claude-code:alice/worktree-auth",
    "codex:ci",
  ])("round trips through formatActor: %j", (raw) => {
    const once = parseActor(raw);
    const formatted = formatActor(once);
    expect(formatted as string).toBe(raw);
    expect(parseActor(formatted)).toEqual(once);
  });
});

describe("parseActor — malformed inputs, probed against the real parser (brief §5)", () => {
  // Each row was run through the actual parser first (see the implementer
  // report) rather than reasoned about; the expected-reason substring below
  // is what the parser actually reports, including the two rows where more
  // than one reading is plausible ("/x": empty name fires before "context
  // without tool" would; "/" : empty context fires before empty name would).
  test.each([
    ["", "must not be empty"],
    ["   ", "leading or trailing whitespace"],
    [":x", "tool segment"],
    ["x:", "name segment"],
    ["x/", "context segment"],
    ["/x", "name segment"],
    ["a:b:c", 'at most one ":"'],
    ["a/b/c", 'at most one "/"'],
    ["a::b", 'at most one ":"'],
    ["a:b/", "context segment"],
    ["a:/b", "name segment"],
    [" alice", "leading or trailing whitespace"],
    ["alice ", "leading or trailing whitespace"],
    [":", "tool segment"],
    ["/", "context segment"],
    ["a/b", "context requires a tool"],
    ["a\tb", "name segment"],
    ["a\nb", "name segment"],
    ["a\x01b", "name segment"],
  ])("parseActor(%j) throws ACTOR_INVALID: %s", (raw, reasonSubstring) => {
    expect(() => parseActor(raw)).toThrow();
    try {
      parseActor(raw);
      throw new Error("expected parseActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_INVALID);
      expect(String(e.details?.reason)).toContain(reasonSubstring);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveActor — the precedence chain.
// ---------------------------------------------------------------------------

describe("resolveActor — precedence chain, each rung and its interactions", () => {
  test("1. flag alone wins", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const result = await resolveActor({ config, flag: "alice" });
        expect(result.source).toBe("flag");
        expect(result.actor).toEqual({ tool: null, name: "alice", context: null });
        expect(result.id as string).toBe("alice");
      } finally {
        await cleanup();
      }
    });
  });

  test("2. CANKAN_ACTOR alone wins (no flag)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, env: { CANKAN_ACTOR: "bob" } });
        const result = await resolveActor({ config });
        expect(result.source).toBe("env");
        expect(result.actor.name).toBe("bob");
      } finally {
        await cleanup();
      }
    });
  });

  test("3. local config `actor:` alone wins (no flag, no env)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "carol" });
        const result = await resolveActor({ config });
        expect(result.source).toBe("local-config");
        expect(result.actor.name).toBe("carol");
      } finally {
        await cleanup();
      }
    });
  });

  test("4. global identity.name alone wins (no flag, no env, no local config)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, globalIdentityName: "dave" });
        const result = await resolveActor({ config });
        expect(result.source).toBe("global-identity");
        expect(result.actor.name).toBe("dave");
      } finally {
        await cleanup();
      }
    });
  });

  test("5. git user.name alone wins (no flag, no env, no local config, no global identity)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const stub = gitStub("eve");
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.source).toBe("git");
        expect(result.actor.name).toBe("eve");
        expect(stub.state.callCount).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  test("interaction: flag beats CANKAN_ACTOR", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, env: { CANKAN_ACTOR: "bob" } });
        const result = await resolveActor({ config, flag: "alice" });
        expect(result.source).toBe("flag");
        expect(result.actor.name).toBe("alice");
      } finally {
        await cleanup();
      }
    });
  });

  test("interaction: CANKAN_ACTOR beats local config `actor:`", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({
          root,
          localActor: "carol",
          env: { CANKAN_ACTOR: "bob" },
        });
        const result = await resolveActor({ config });
        expect(result.source).toBe("env");
        expect(result.actor.name).toBe("bob");
      } finally {
        await cleanup();
      }
    });
  });

  test("interaction: local config `actor:` beats global identity.name", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({
          root,
          localActor: "carol",
          globalIdentityName: "dave",
        });
        const result = await resolveActor({ config });
        expect(result.source).toBe("local-config");
        expect(result.actor.name).toBe("carol");
      } finally {
        await cleanup();
      }
    });
  });

  test("interaction: global identity.name beats git user.name, and the git thunk is never called", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, globalIdentityName: "dave" });
        const stub = gitStub("eve");
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.source).toBe("global-identity");
        expect(result.actor.name).toBe("dave");
        expect(stub.state.callCount).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  test("R-4: no identity anywhere (including no gitUserName thunk at all) -> ACTOR_UNRESOLVED", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const details = await expectCanKanError(
          () => resolveActor({ config }),
          ActorErrorCodes.ACTOR_UNRESOLVED,
        );
        expect(details).toBeUndefined();
      } finally {
        await cleanup();
      }
    });
  });

  test("R-4: no identity anywhere, with a gitUserName thunk that itself resolves null -> ACTOR_UNRESOLVED", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const stub = gitStub(null);
        await expectCanKanError(
          () => resolveActor({ config, gitUserName: stub.fn }),
          ActorErrorCodes.ACTOR_UNRESOLVED,
        );
        expect(stub.state.callCount).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  test("real end-to-end: no identity anywhere including a real git repo with no user.name configured", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        // Strip the fixture's own repo-level `user.name` ("CanKan Test") so
        // this genuinely has none, at any level git would consult.
        Bun.spawnSync(["git", "config", "--unset", "user.name"], { cwd: repo.dir });
        const config = await buildConfig({ root: repo.dir });
        await expectCanKanError(
          () => resolveActor({ config, gitUserName: realGitUserNameThunk(repo.dir) }),
          ActorErrorCodes.ACTOR_UNRESOLVED,
        );
      } finally {
        await repo.cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// resolveActor — R-5: a malformed value at a rung names that rung, and does
// not fall through to the next one.
// ---------------------------------------------------------------------------

describe("resolveActor — a malformed value at a rung is an error naming that rung (R-5)", () => {
  test("malformed flag ('x:') -> ACTOR_INVALID naming rung 'flag'", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const details = await expectCanKanError(
          () => resolveActor({ config, flag: "x:" }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("flag");
      } finally {
        await cleanup();
      }
    });
  });

  test("R-8: CANKAN_ACTOR='' is malformed, not absent, and beats a populated local config actor", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({
          root,
          localActor: "bob",
          env: { CANKAN_ACTOR: "" },
        });
        // Confirm the probed premise: env still wins the config-layer
        // precedence even though its value is empty.
        expect(config.value.actor).toBe("");
        expect(config.resolved(["actor"])?.layer).toBe("env");

        const details = await expectCanKanError(
          () => resolveActor({ config }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("env");
        // It must NOT have fallen through to the local config's "bob".
      } finally {
        await cleanup();
      }
    });
  });

  test("R-8: an empty --actor flag is malformed, not absent", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "bob" });
        const details = await expectCanKanError(
          () => resolveActor({ config, flag: "" }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("flag");
      } finally {
        await cleanup();
      }
    });
  });

  test("malformed local config `actor:` names rung 'local-config' and its file", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const localPath = await writeRepoConfigFile(root, "local.yml", 'actor: "x:"\n');
        const config = await loadConfig({ repoRoot: root, env: hermeticEnv() });
        const details = await expectCanKanError(
          () => resolveActor({ config }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("local-config");
        expect(details?.file).toBe(localPath);
      } finally {
        await cleanup();
      }
    });
  });

  test("malformed global identity.name names rung 'global-identity' and its file", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, globalIdentityName: "alice/wt" });
        const details = await expectCanKanError(
          () => resolveActor({ config }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("global-identity");
        expect(typeof details?.file).toBe("string");
      } finally {
        await cleanup();
      }
    });
  });

  test("malformed git user.name names rung 'git' (stub)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const stub = gitStub("alice bob"); // whitespace -- malformed per R-9
        const details = await expectCanKanError(
          () => resolveActor({ config, gitUserName: stub.fn }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("git");
      } finally {
        await cleanup();
      }
    });
  });

  test("FINDING — real git repo: makeTempRepo()'s default user.name ('CanKan Test') is malformed under R-9's grammar (embedded space)", async () => {
    // This is the probed surprise the brief's §3 asks for, not smoothed
    // over: R-9 bans whitespace in every segment, applied uniformly (R-5)
    // to every rung including 'git'. `makeTempRepo()` sets a real,
    // ordinary-looking `user.name` of "CanKan Test" -- exactly the shape
    // most real git installations use (a first + last name) -- and it
    // fails the actor grammar. See the implementer report for the two
    // readings this leaves open for the controller.
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const config = await buildConfig({ root: repo.dir });
        const details = await expectCanKanError(
          () => resolveActor({ config, gitUserName: realGitUserNameThunk(repo.dir) }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.rung).toBe("git");
        expect(String(details?.reason)).toContain("name segment");
      } finally {
        await repo.cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// resolveActor — parent derivation (R-10).
// ---------------------------------------------------------------------------

describe("resolveActor — parent derivation (R-10)", () => {
  test("a bare human actor always has parent: null, even when config sets `parent`", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "alice", localParent: "alice-boss" });
        const stub = gitStub("should-not-be-called");
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.actor.tool).toBeNull();
        expect(result.parent).toBeNull();
        expect(result.parentSource).toBeNull();
        expect(stub.state.callCount).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  test("tool actor: parent from config wins over identity.name and git", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({
          root,
          localActor: "claude-code:alice/wt-auth",
          localParent: "alice",
          globalIdentityName: "someone-else",
        });
        const stub = gitStub("should-not-be-called");
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.actor.tool).toBe("claude-code");
        expect(result.parent as string | null).toBe("alice");
        expect(result.parentSource).toBe("config");
        expect(stub.state.callCount).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  test("tool actor: parent from identity.name when config has no `parent`", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({
          root,
          localActor: "codex:ci",
          globalIdentityName: "alice",
        });
        const stub = gitStub("should-not-be-called");
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.parent as string | null).toBe("alice");
        expect(result.parentSource).toBe("global-identity");
        expect(stub.state.callCount).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });

  test("tool actor: parent from git when config has no `parent` and no identity.name (stub)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "codex:ci" });
        const stub = gitStub("alice");
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.parent as string | null).toBe("alice");
        expect(result.parentSource).toBe("git");
        expect(stub.state.callCount).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  test("real end-to-end: parent from a real git repo's user.name (set to a grammar-valid bare name)", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        Bun.spawnSync(["git", "config", "user.name", "alice"], { cwd: repo.dir });
        const config = await buildConfig({ root: repo.dir, localActor: "codex:ci" });
        const result = await resolveActor({ config, gitUserName: realGitUserNameThunk(repo.dir) });
        expect(result.parent as string | null).toBe("alice");
        expect(result.parentSource).toBe("git");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("FINDING — real git repo: parent-from-git also fails on the default 'CanKan Test' user.name", async () => {
    // Compounds the actor-rung finding above: with a real repo's default
    // git config, a tool actor whose parent falls through to `git` gets
    // ACTOR_INVALID, not a null parent -- even though R-10 explicitly says
    // an *absent* parent must not be an error.
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const config = await buildConfig({ root: repo.dir, localActor: "codex:ci" });
        const details = await expectCanKanError(
          () => resolveActor({ config, gitUserName: realGitUserNameThunk(repo.dir) }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.field).toBe("parent");
        expect(details?.source).toBe("git");
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("tool actor: no parent anywhere (git thunk resolves null) -> parent: null, not an error", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "codex:ci" });
        const stub = gitStub(null);
        const result = await resolveActor({ config, gitUserName: stub.fn });
        expect(result.actor.tool).toBe("codex");
        expect(result.parent).toBeNull();
        expect(result.parentSource).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  test("tool actor: no parent anywhere and no gitUserName thunk at all -> parent: null, not an error", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "codex:ci" });
        const result = await resolveActor({ config });
        expect(result.parent).toBeNull();
        expect(result.parentSource).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  test("malformed configured `parent` (tool-shaped) -> ACTOR_INVALID naming field 'parent', source 'config'", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({
          root,
          localActor: "codex:ci",
          localParent: "claude-code:alice",
        });
        const details = await expectCanKanError(
          () => resolveActor({ config }),
          ActorErrorCodes.ACTOR_INVALID,
        );
        expect(details?.field).toBe("parent");
        expect(details?.source).toBe("config");
      } finally {
        await cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// ResolvedActor.id — the branded canonical form (ActorId).
// ---------------------------------------------------------------------------

describe("ResolvedActor.id", () => {
  test("is formatActor(actor)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root, localActor: "claude-code:alice/wt-auth" });
        const result: ResolvedActor = await resolveActor({ config });
        expect(result.id).toBe(formatActor(result.actor));
        expect(result.id as string).toBe("claude-code:alice/wt-auth");
      } finally {
        await cleanup();
      }
    });
  });
});
