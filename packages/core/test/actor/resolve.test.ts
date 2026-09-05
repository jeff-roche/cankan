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
import type { ConfigResult, ResolvedEntry } from "../../src/config/index";
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
// parseActor / formatActor -- the grammar (R-9, as amended by R-11).
//
// R-11 (fix round 1): the `name` segment may contain an internal `U+0020`
// space, unconditionally -- probing `tryParseActor` against
// `makeTempRepo()`'s real fixture (`"CanKan Test"`) proved R-9's original
// "no whitespace anywhere" made CONCEPT.md's own documented default
// (`actor` "defaults to git user.name", conventionally "Firstname
// Lastname") unrepresentable. `tool`/`context` still reject all whitespace;
// every non-U+0020 whitespace character and every Unicode control/format
// character is still rejected everywhere (log-injection / attribution-
// spoofing concerns -- see `resolve.ts`'s file comment above the grammar).
// ---------------------------------------------------------------------------

describe("parseActor — valid grammar, and the parse -> format -> parse round trip", () => {
  test.each([
    ["alice", { tool: null, name: "alice", context: null }],
    ["claude-code:alice/worktree-auth", { tool: "claude-code", name: "alice", context: "worktree-auth" }],
    ["codex:ci", { tool: "codex", name: "ci", context: null }],
    // R-11: a `name` segment may contain an internal space.
    ["CanKan Test", { tool: null, name: "CanKan Test", context: null }],
    ["Jeff Roche", { tool: null, name: "Jeff Roche", context: null }],
    [
      "claude-code:Jeff Roche/wt-auth",
      { tool: "claude-code", name: "Jeff Roche", context: "wt-auth" },
    ],
  ] satisfies [string, Actor][])("parseActor(%j)", (raw, expected) => {
    expect(parseActor(raw)).toEqual(expected);
  });

  test.each([
    "alice",
    "claude-code:alice/worktree-auth",
    "codex:ci",
    "CanKan Test",
    "Jeff Roche",
    "claude-code:Jeff Roche/wt-auth",
  ])("round trips through formatActor: %j", (raw) => {
    const once = parseActor(raw);
    const formatted = formatActor(once);
    expect(formatted as string).toBe(raw);
    expect(parseActor(formatted)).toEqual(once);
  });
});

describe("parseActor — malformed inputs, probed against the real parser (brief §5, extended by R-11)", () => {
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
    // R-11 additions -- every whitespace character other than a plain
    // space, and every Unicode control/format character, stays rejected;
    // `tool`/`context` reject a plain space too; leading/trailing
    // whitespace stays malformed per segment, not only on the whole value.
    ["a\rb", "name segment"],
    ["a\u00a0b", "name segment"], // NBSP
    ["a\u200db", "name segment"], // zero-width joiner (\p{Cf})
    ["a\u202eb", "name segment"], // right-to-left override (\p{Cf})
    ["claude code:alice", "tool segment"],
    ["claude-code:alice/wt auth", "context segment"],
    ["claude-code: alice", "name segment"], // leading space on `name` alone
    // R-15 additions (fix round 2) -- characters that are visually blank
    // or invisible but not `\p{Cc}`/`\p{Cf}`, each probed against the real
    // parser before being asserted here (see the implementer report):
    // Hangul/halfwidth-Hangul fillers, a variation selector, the combining
    // grapheme joiner, Khmer inherent vowels, BRAILLE PATTERN BLANK
    // (explicitly listed -- not itself Default_Ignorable), and a lone
    // (unpaired) UTF-16 surrogate.
    ["a️b", "name segment"], // VARIATION SELECTOR-16
    ["aㅤb", "name segment"], // HANGUL FILLER
    ["aᅟb", "name segment"], // HANGUL CHOSEONG FILLER
    ["aᅠb", "name segment"], // HANGUL JUNGSEONG FILLER
    ["a͏b", "name segment"], // COMBINING GRAPHEME JOINER
    ["a឴b", "name segment"], // KHMER VOWEL INHERENT AQ
    ["a឵b", "name segment"], // KHMER VOWEL INHERENT AA
    ["aﾠb", "name segment"], // HALFWIDTH HANGUL FILLER
    ["a⠀b", "name segment"], // BRAILLE PATTERN BLANK
    ["a\ud800b", "name segment"], // lone (unpaired) high surrogate
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

describe("parseActor — R-18: the whole-value length cap", () => {
  test("257 characters is rejected", () => {
    const raw = "a".repeat(257);
    try {
      parseActor(raw);
      throw new Error("expected parseActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_INVALID);
      expect(String(e.details?.reason)).toContain("must be at most 256 characters");
    }
  });

  test("256 characters is accepted (the boundary itself is valid)", () => {
    const raw = "a".repeat(256);
    expect(parseActor(raw)).toEqual({ tool: null, name: raw, context: null });
  });
});

describe("parseActor / formatActor — R-15: NFC normalization", () => {
  test("an NFD-spelled name parses, and format -> parse -> format is stable from the first parse onward", () => {
    // "e" + COMBINING ACUTE ACCENT (U+0301) -- NFD spelling of "é". Real
    // `git user.name` values can legitimately arrive this way (macOS
    // normalizes some inputs to NFD); rejecting it would hand such a user
    // an error they can't read or act on, so R-15 normalizes instead.
    const nfd = `alic${"é"}`;
    const nfc = "alicé"; // the composed form of the same text
    expect(nfd).not.toBe(nfc); // sanity: genuinely different byte sequences
    expect(nfd.normalize("NFC")).toBe(nfc);

    const parsedFromNfd = parseActor(nfd);
    expect(parsedFromNfd).toEqual({ tool: null, name: nfc, context: null });

    const formattedOnce = formatActor(parsedFromNfd);
    // NOT byte-identical to the raw NFD input -- normalization happened
    // before parsing, so the canonical (NFC) spelling is what comes back.
    expect(formattedOnce as string).not.toBe(nfd);
    expect(formattedOnce as string).toBe(nfc);

    // Stability is guaranteed from here on: parsing the already-normalized
    // output and formatting it again reproduces the same string.
    const parsedAgain = parseActor(formattedOnce);
    const formattedTwice = formatActor(parsedAgain);
    expect(formattedTwice as string).toBe(formattedOnce as string);
  });

  test("NFC- and NFD-spelled input for the same visible text parse to the same Actor and mint the same ActorId", () => {
    const nfc = parseActor("alicé");
    const nfd = parseActor(`alic${"é"}`);
    expect(nfd).toEqual(nfc);
    expect(formatActor(nfd) as string).toBe(formatActor(nfc) as string);
  });
});

describe("parseActor — R-11/R-18: any number of internal spaces is legal in `name`, not just one", () => {
  // R-18: NAME_SEGMENT_REASON used to say "a single internal space",
  // which was false -- these two both parse. Locking that in here so the
  // message and the behavior can't drift apart again unnoticed.
  test.each([
    ["a  b", { tool: null, name: "a  b", context: null }],
    ["a b c", { tool: null, name: "a b c", context: null }],
  ] satisfies [string, Actor][])("parseActor(%j)", (raw, expected) => {
    expect(parseActor(raw)).toEqual(expected);
  });
});

describe("formatActor — R-16: validates before minting an ActorId", () => {
  test("rejects a hand-built Actor whose name carries a newline (log-injection shape)", () => {
    const malicious: Actor = { tool: null, name: 'alice"}\n{"actor":"bob', context: null };
    try {
      formatActor(malicious);
      throw new Error("expected formatActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_INVALID);
    }
  });

  test("rejects a hand-built Actor whose name secretly contains \"/\" (only reachable by direct construction)", () => {
    // `parseActor` itself never produces a `name` containing "/" -- this
    // state is only reachable by building an `Actor` object directly.
    const malformed: Actor = { tool: null, name: "a/b", context: null };
    try {
      formatActor(malformed);
      throw new Error("expected formatActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_INVALID);
    }
  });

  test("rejects a hand-built Actor whose tool secretly contains \":\"", () => {
    const malformed: Actor = { tool: "a:b", name: "c", context: null };
    try {
      formatActor(malformed);
      throw new Error("expected formatActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_INVALID);
    }
  });

  test("still succeeds for an ordinary, validly-constructed Actor", () => {
    expect(formatActor({ tool: "codex", name: "ci", context: null }) as string).toBe("codex:ci");
  });
});

describe("parseActor — documented, not defects (file comment above the grammar section)", () => {
  test("case is preserved exactly -- 'Alice' and 'alice' are two different actors", () => {
    expect(parseActor("Alice")).toEqual({ tool: null, name: "Alice", context: null });
    expect(parseActor("Alice")).not.toEqual(parseActor("alice"));
    expect(formatActor(parseActor("Alice")) as string).not.toBe(
      formatActor(parseActor("alice")) as string,
    );
  });

  test("script-mixing homoglyphs are left alone -- Cyrillic and Latin 'a' parse as different, both-valid names", () => {
    const cyrillic = "аlice"; // Cyrillic а (U+0430) + "lice"
    const latin = "alice";
    expect(cyrillic).not.toBe(latin);
    expect(parseActor(cyrillic)).toEqual({ tool: null, name: cyrillic, context: null });
    expect(parseActor(cyrillic)).not.toEqual(parseActor(latin));
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
        // R-11: an internal space alone is no longer malformed (a bare
        // human `name` may contain one) -- a tab is still rejected
        // everywhere, so it still exercises this rung's error naming.
        const stub = gitStub("alice\tbob");
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

  test("real git repo: makeTempRepo()'s default user.name ('CanKan Test') resolves successfully via the git rung (R-11)", async () => {
    // Fix round 1: this was originally a "FINDING" test asserting
    // ACTOR_INVALID -- R-9's original "no whitespace anywhere" made
    // CONCEPT.md's own documented default ("defaults to git user.name",
    // conventionally "Firstname Lastname") unrepresentable, proven by this
    // exact fixture. R-11 relaxed the `name` segment to allow an internal
    // space, so this real end-to-end path now succeeds.
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const config = await buildConfig({ root: repo.dir });
        const result = await resolveActor({ config, gitUserName: realGitUserNameThunk(repo.dir) });
        expect(result.source).toBe("git");
        expect(result.actor).toEqual({ tool: null, name: "CanKan Test", context: null });
        expect(result.id as string).toBe("CanKan Test");
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

  test("real git repo: parent-from-git also succeeds on the default 'CanKan Test' user.name (R-11)", async () => {
    // Fix round 1: this was originally a "FINDING" test asserting
    // ACTOR_INVALID for the exact reason the actor-rung finding gave --
    // R-11's fix for `name` applies equally to a bare-name `parent`
    // (`requireBareName` reuses the same grammar), so this real repo's
    // default `user.name` now resolves as `parent` too, with no override
    // needed to make the seam succeed.
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        const config = await buildConfig({ root: repo.dir, localActor: "codex:ci" });
        const result = await resolveActor({ config, gitUserName: realGitUserNameThunk(repo.dir) });
        expect(result.parent as string | null).toBe("CanKan Test");
        expect(result.parentSource).toBe("git");
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

// ---------------------------------------------------------------------------
// R-17 (fix round 2): the layer guard mirrored onto `parent` and
// `identity.name`. Every other `describe` in this file builds its
// `ConfigResult` from a real `loadConfig()` call, deliberately -- this is
// the one exception, and it has to be: M2.3's real schema always closes
// this path (that's the whole point of R-17 being "defence in depth,
// nothing reachable today"), so a hand-built `ConfigResult` stub, clearly
// contrived to violate the invariant, is the only way to exercise the
// guard code itself rather than merely trust it.
// ---------------------------------------------------------------------------

/** A minimal `ConfigResult` stub whose `resolved()` reports whatever layer
 *  the test wants, regardless of what `loadConfig` could ever really
 *  produce -- used only to prove the R-17 guards throw, not to model real
 *  config behavior. */
function fakeConfigResult(
  value: Record<string, unknown>,
  layers: Readonly<Record<string, string>>,
): ConfigResult {
  return {
    value: value as ConfigResult["value"],
    layers: [],
    resolved: (key: string | readonly string[]): ResolvedEntry | undefined => {
      const k = Array.isArray(key) ? (key as readonly string[]).join(".") : (key as string);
      const layer = layers[k];
      if (layer === undefined) {
        return undefined;
      }
      const path = Array.isArray(key) ? (key as readonly string[]) : [key as string];
      return {
        path,
        key: k,
        value: undefined,
        layer: layer as ResolvedEntry["layer"],
      };
    },
    entries: () => [],
  };
}

describe("resolveActor — R-17: the layer guard also covers `parent` and `identity.name`", () => {
  test("actor resolved from an impossible layer ('repo') -> ACTOR_UNRESOLVED naming 'actor'", async () => {
    const config = fakeConfigResult({ actor: "alice" }, { actor: "repo" });
    try {
      await resolveActor({ config });
      throw new Error("expected resolveActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_UNRESOLVED);
      expect(e.details?.field).toBe("actor");
      expect(e.details?.layer).toBe("repo");
    }
  });

  test("parent resolved from an impossible layer ('global') -> ACTOR_UNRESOLVED naming 'parent'", async () => {
    const config = fakeConfigResult({ parent: "alice" }, { parent: "global" });
    try {
      await resolveActor({ config, flag: "codex:ci" });
      throw new Error("expected resolveActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_UNRESOLVED);
      expect(e.details?.field).toBe("parent");
      expect(e.details?.layer).toBe("global");
    }
  });

  test("identity.name resolved from an impossible layer ('repo-local'), used as actor -> ACTOR_UNRESOLVED naming 'identity.name'", async () => {
    const config = fakeConfigResult(
      { identity: { name: "alice" } },
      { "identity.name": "repo-local" },
    );
    try {
      await resolveActor({ config });
      throw new Error("expected resolveActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_UNRESOLVED);
      expect(e.details?.field).toBe("identity.name");
      expect(e.details?.layer).toBe("repo-local");
    }
  });

  test("identity.name resolved from an impossible layer ('repo'), used as parent -> ACTOR_UNRESOLVED naming 'identity.name'", async () => {
    const config = fakeConfigResult({ identity: { name: "alice" } }, { "identity.name": "repo" });
    try {
      await resolveActor({ config, flag: "codex:ci" });
      throw new Error("expected resolveActor to throw");
    } catch (e) {
      if (!isCanKanError(e)) {
        throw e;
      }
      expect(e.code).toBe(ActorErrorCodes.ACTOR_UNRESOLVED);
      expect(e.details?.field).toBe("identity.name");
      expect(e.details?.layer).toBe("repo");
    }
  });
});

// ---------------------------------------------------------------------------
// R-18 (fix round 2, bundled small items).
// ---------------------------------------------------------------------------

describe("resolveActor — R-18: gitUserName() misbehavior and memoization", () => {
  test("a thunk that resolves undefined is treated as null, not a raw TypeError", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const config = await buildConfig({ root });
        const badThunk = async () => undefined as unknown as string | null;
        try {
          await resolveActor({ config, gitUserName: badThunk });
          throw new Error("expected resolveActor to throw");
        } catch (e) {
          if (!isCanKanError(e)) {
            throw e;
          }
          expect(e.code).toBe(ActorErrorCodes.ACTOR_UNRESOLVED);
        }
      } finally {
        await cleanup();
      }
    });
  });

  test("a tool-shaped git user.name is fetched once, even though both the actor rung and the parent rung need it", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        // No --actor, no CANKAN_ACTOR, no local `actor:`, no global
        // identity.name -- the actor rung falls through to git. The
        // returned value is tool-shaped ("team:alice"), so the parent
        // rung *also* falls through to git (parent then rejects it as
        // not-a-bare-name -- that's expected and irrelevant here; what
        // this test proves is the underlying thunk still runs only once).
        const config = await buildConfig({ root });
        const stub = gitStub("team:alice");
        try {
          await resolveActor({ config, gitUserName: stub.fn });
          throw new Error("expected resolveActor to throw");
        } catch (e) {
          if (!isCanKanError(e)) {
            throw e;
          }
          expect(e.code).toBe(ActorErrorCodes.ACTOR_INVALID);
          expect(e.details?.field).toBe("parent");
        }
        expect(stub.state.callCount).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });
});
