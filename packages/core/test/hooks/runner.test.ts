import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { effectiveConfigSchema, loadConfig } from "../../src/config/index";
import type { ConfigResult, LoadedLayer } from "../../src/config/index";
import { isCanKanError } from "../../src/errors";
import { HooksErrorCodes } from "../../src/hooks/errors";
import { grantRepoExecutableTrust } from "../../src/trust/index";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  HOOK_LAYER_ORDER,
  type HookEvent,
  type HookEventRecord,
  runHooks,
  spawnHook,
} from "../../src/hooks/runner";
import {
  isPidAlive,
  makeTempRepoRoot,
  pollUntil,
  testConfigEnv,
  writeGlobalConfigFile,
  writeRepoConfigFile,
} from "./testHelpers";

/**
 * Constructs a `ConfigResult` by hand, real `EffectiveConfig` defaults for
 * `.value` (so nothing here is `any`/cast) and the given `layers` -- exactly
 * the surface `runner.ts` reads (`.layers`, per Controller Ruling 2).
 * `.resolved`/`.entries` are never called by `runner.ts` and are stubbed
 * accordingly. Used for tests that are about hook *execution*, not about
 * `loadConfig` itself -- the accumulate/order/provenance tests below load a
 * real `ConfigResult` from real YAML files instead, exercising the actual
 * M2.3 integration.
 */
function fakeConfigResult(layers: readonly LoadedLayer[]): ConfigResult {
  return {
    value: effectiveConfigSchema.parse({}),
    layers,
    resolved: () => undefined,
    entries: () => [],
  };
}

function fakeLayer(
  layer: LoadedLayer["layer"],
  file: string,
  hooks: Record<string, string>,
): LoadedLayer {
  // Most runner tests exercise process management rather than the repo trust
  // boundary. Model their commands as caller-owned local settings; dedicated
  // tests below cover the checked-in repo layer separately.
  return {
    layer: layer === "repo" ? "repo-local" : layer,
    file,
    data: { hooks },
  };
}

/** Any pid a test wants killed in `afterEach` even if the test itself fails. */
const leakedPids: number[] = [];

/**
 * Timeout for the tests whose hook must WRITE A FILE (a pid, a pgid) and only
 * then hang, where the assertions read that file back afterwards (#93).
 *
 * Those tests have two independent time requirements pulling in opposite
 * directions, and conflating them is what made one of them flaky:
 *
 *  - the timeout must be LONGER than the hook's setup -- forking `ps`,
 *    writing files, backgrounding a job -- or the kill lands before the file
 *    exists and the test fails with `ENOENT` from its own `readFile`, which
 *    looks like a process-group defect and is not one;
 *  - the timeout must be SHORTER than the hook's hang, so `timedOut` is true
 *    and the group-kill path under test actually runs.
 *
 * Every hook using this sleeps 30s or more, so the second bound has enormous
 * slack and the first is the only one worth tuning. One second is ~6x the
 * observed setup cost on a contended CI runner while remaining ~30x inside
 * the hang, so both hold comfortably.
 *
 * This is a SETUP window, not an assertion threshold. Nothing about what
 * these tests prove depends on its value.
 */
const HANG_SETUP_TIMEOUT_MS = 1_000;

afterEach(() => {
  for (const pid of leakedPids.splice(0)) {
    // Both forms: `-pid` in case it is (or was) a process-group leader,
    // plain `pid` as a backstop. ESRCH (already gone) is expected and fine.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

describe("resolving hooks across layers", () => {
  test("no hook configured for an event is a no-op: empty result, no sink calls, nothing spawned", async () => {
    const cfg = fakeConfigResult([
      fakeLayer("repo", "/fake/.cankan/config.yml", { close: "true" }),
    ]);
    let sinkCalls = 0;
    const outcomes = await runHooks({
      cfg,
      event: "claim",
      repoRoot: "/fake",
      sink: () => {
        sinkCalls += 1;
      },
    });
    expect(outcomes).toEqual([]);
    expect(sinkCalls).toBe(0);
  });

  test("all six HOOK_EVENTS resolve and fire, and only the one requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-events-"));
    try {
      const outFile = join(dir, "fired.txt");
      const hooks: Record<string, string> = {};
      for (const event of HOOK_EVENTS) {
        hooks[event] = `printf '${event}\\n' >> '${outFile}'`;
      }
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), hooks),
      ]);

      for (const event of HOOK_EVENTS) {
        const outcomes = await runHooks({ cfg, event, repoRoot: dir });
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.exitCode).toBe(0);
      }

      const content = await readFile(outFile, "utf8");
      expect(content.split("\n").filter(Boolean)).toEqual([...HOOK_EVENTS]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unknown event throws (programmer error), not captured in a result", async () => {
    const cfg = fakeConfigResult([]);
    let caught: unknown;
    try {
      await runHooks({
        cfg,
        event: "not-a-real-event" as HookEvent,
        repoRoot: "/fake",
      });
    } catch (err) {
      caught = err;
    }
    expect(isCanKanError(caught)).toBe(true);
  });

  test("hooks accumulate across repo + repo-local + global (test 4) and run in HOOK_LAYER_ORDER, with correct provenance in both the result and the sink record (test 10)", async () => {
    await withEnv(undefined, async () => {
      const { root, cleanup } = await makeTempRepoRoot();
      try {
        const sharedFile = join(root, "order.txt");
        await writeRepoConfigFile(
          root,
          "config.yml",
          `hooks:\n  move: "printf 'repo\\n' >> '${sharedFile}'"\n`,
        );
        await writeRepoConfigFile(
          root,
          "local.yml",
          `hooks:\n  move: "printf 'repo-local\\n' >> '${sharedFile}'"\n`,
        );
        const xdgConfigHome = process.env.XDG_CONFIG_HOME as string;
        await writeGlobalConfigFile(
          xdgConfigHome,
          `hooks:\n  move: "printf 'global\\n' >> '${sharedFile}'"\n`,
        );

        const cfg = await loadConfig({ repoRoot: root, env: testConfigEnv() });
        await grantRepoExecutableTrust(root, cfg, testConfigEnv());
        // Deliberately NOT asserting `cfg.layers`'s own order here --
        // `config/resolve.ts`'s `FILE_LAYER_ORDER` is `["repo-local",
        // "repo", "global"]`, different from `HOOK_LAYER_ORDER`. That
        // mismatch is exactly why `resolveHooksForEvent` must not depend
        // on `cfg.layers`'s incidental order (Controller Ruling 3).
        expect(new Set(cfg.layers.map((l) => l.layer))).toEqual(
          new Set(["repo", "repo-local", "global"]),
        );

        const records: HookEventRecord[] = [];
        const outcomes = await runHooks({
          cfg,
          event: "move",
          repoRoot: root,
          ticket: "ck-xyz",
          actor: "bob",
          from: "A",
          to: "B",
          sink: (record) => {
            records.push(record);
          },
        });

        // Count is 3: this is the assertion that separates accumulate from
        // override (the resolved/policy channel would have given 1).
        expect(outcomes).toHaveLength(3);
        expect(outcomes.map((o) => o.layer)).toEqual([...HOOK_LAYER_ORDER]);
        for (const outcome of outcomes) {
          expect(outcome.exitCode).toBe(0);
        }

        // Provenance: each outcome's `file` matches the *same* ConfigResult's
        // own record for that layer -- comparing against `cfg.layers`
        // (produced by the same `loadConfig` call, in the same process)
        // rather than reconstructing a path string avoids the macOS
        // `/private/var` symlink hazard entirely.
        for (const layerName of HOOK_LAYER_ORDER) {
          const outcome = outcomes.find((o) => o.layer === layerName);
          const loaded = cfg.layers.find((l) => l.layer === layerName);
          expect(outcome?.file).toBe(loaded?.file);
        }

        // Order: each hook appended to the shared file in HOOK_LAYER_ORDER,
        // proving they ran sequentially in that order, not concurrently or
        // in the array's incidental order.
        const orderContent = await readFile(sharedFile, "utf8");
        expect(orderContent.split("\n").filter(Boolean)).toEqual([
          "repo",
          "repo-local",
          "global",
        ]);

        // The sink record carries the same provenance, plus the event
        // context, one call per hook that ran (not one per event).
        expect(records).toHaveLength(3);
        expect(records.map((r) => r.layer)).toEqual([...HOOK_LAYER_ORDER]);
        for (const record of records) {
          expect(record.event).toBe("move");
          expect(record.ticket).toBe("ck-xyz");
          expect(record.actor).toBe("bob");
          expect(record.from).toBe("A");
          expect(record.to).toBe("B");
        }
      } finally {
        await cleanup();
      }
    });
  });
});

describe("PLAN.md's two 'Done when' tests", () => {
  test("1. a hook that writes its env to a file is invoked with correct $TICKET $ACTOR $FROM $TO $TITLE values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-env-"));
    try {
      const outFile = join(dir, "env.txt");
      const command = `printf '%s\\n' "$TICKET" "$ACTOR" "$FROM" "$TO" "$TITLE" > '${outFile}'`;
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          claim: command,
        }),
      ]);

      const outcomes = await runHooks({
        cfg,
        event: "claim",
        repoRoot: dir,
        ticket: "ck-abc123",
        actor: "alice",
        from: "Backlog",
        to: "In Progress",
        title: "Fix the thing",
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.exitCode).toBe(0);
      const content = await readFile(outFile, "utf8");
      expect(content.split("\n")).toEqual([
        "ck-abc123",
        "alice",
        "Backlog",
        "In Progress",
        "Fix the thing",
        "",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("FROM and TO (and every unspecified value) default to the empty string, never absent, for an event like create with no natural from/to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-defaults-"));
    try {
      const outFile = join(dir, "env.txt");
      // `set -u`: dies on an unset var, so this only passes if TICKET,
      // ACTOR, FROM, TO, TITLE are all *present* (possibly empty).
      const command = `set -u; printf '[%s][%s][%s][%s][%s]' "$TICKET" "$ACTOR" "$FROM" "$TO" "$TITLE" > '${outFile}'`;
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          create: command,
        }),
      ]);

      const outcomes = await runHooks({
        cfg,
        event: "create",
        repoRoot: dir,
        ticket: "ck-1",
      });

      expect(outcomes[0]?.exitCode).toBe(0);
      const content = await readFile(outFile, "utf8");
      expect(content).toBe("[ck-1][][][][]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("2. a hanging hook is killed at timeout", async () => {
    const startedAt = Date.now();
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "sleep 30",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
    // Well under `sleep 30`'s 30s -- proves it was killed, not that it ran
    // to completion.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("RunHooksOptions.timeoutMs actually reaches the spawned hook end-to-end through runHooks", async () => {
    const cfg = fakeConfigResult([
      fakeLayer("repo", "/fake/.cankan/config.yml", { expire: "sleep 30" }),
    ]);
    const startedAt = Date.now();
    const outcomes = await runHooks({
      cfg,
      event: "expire",
      repoRoot: process.cwd(),
      timeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.timedOut).toBe(true);
    // Well under `sleep 30`'s 30s, and under DEFAULT_HOOK_TIMEOUT_MS too --
    // proves `timeoutMs: 100` actually propagated from `RunHooksOptions`
    // through to the spawned hook, not just `spawnHook`'s own default.
    expect(elapsedMs).toBeLessThan(DEFAULT_HOOK_TIMEOUT_MS);
  });
});

describe("obligation 3: the timeout kills the whole process group, including grandchildren", () => {
  test("5. a hanging hook's grandchild dies too, and the direct child really is its own process-group leader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-grandchild-"));
    const pgidFile = join(dir, "pgid");
    const pidFile = join(dir, "pid");
    const gcFile = join(dir, "gcpid");
    try {
      // The hook records its own pid/pgid and its grandchild's pid *before*
      // hanging, so the test can assert on them after `spawnHook` has
      // already killed everything and returned.
      const command = [
        `ps -o pgid= -p $$ > '${pgidFile}'`,
        `echo $$ > '${pidFile}'`,
        "sleep 30 &",
        `echo $! > '${gcFile}'`,
        "wait",
      ].join("\n");

      const result = await spawnHook({
        layer: "repo",
        file: "/fake/.cankan/config.yml",
        command,
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        // #93: this was 150ms and flaked on CI. The failure was never in the
        // process-group kill this test exists to prove -- it was
        // `ENOENT: ... open '/tmp/cankan-hooks-grandchild-XXXXXX/gcpid'`
        // from the test's OWN readFile below. The hook has until the timeout
        // to fork/exec `ps`, write three files and background a `sleep`; on a
        // loaded runner it had not reached `echo $! > gcFile` before the kill
        // landed, so the file the assertions read did not exist yet.
        //
        // This widens the SETUP window, and weakens no assertion: the hook
        // hangs on `sleep 30`, which outlasts any timeout we would pick, so
        // `timedOut` is still true, the group is still killed the same way,
        // and pgid/pid/grandchild are still asserted exactly as before. The
        // 150 was an arbitrary tight value with no semantic content -- the
        // only thing it needs to be is comfortably longer than the setup and
        // far shorter than 30s.
        timeoutMs: HANG_SETUP_TIMEOUT_MS,
      });

      expect(result.timedOut).toBe(true);

      const [pgidRaw, pidRaw, gcRaw] = await Promise.all([
        readFile(pgidFile, "utf8"),
        readFile(pidFile, "utf8"),
        readFile(gcFile, "utf8"),
      ]);
      const pgid = Number(pgidRaw.trim());
      const pid = Number(pidRaw.trim());
      const grandchildPid = Number(gcRaw.trim());
      leakedPids.push(pid, grandchildPid);

      // The direct child really is its own process-group leader --
      // otherwise the negative-pid kill inside `spawnHook` would have
      // signalled *this test runner's* process group instead of the
      // hook's (see the task report's probe 4 for what that looks like).
      expect(Number.isFinite(pgid)).toBe(true);
      expect(pgid).toBe(pid);

      // Reaping lags the kill signal by a tick (task brief §6) -- poll
      // rather than checking once.
      const dead = await pollUntil(() => !isPidAlive(grandchildPid), 2_000, 20);
      expect(dead).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SIGTERM alone can already end the whole group before the grace-period SIGKILL runs (no error from the second kill)", async () => {
    // A hook with no trap dies on the first SIGTERM -- this exercises the
    // "already gone by the time SIGKILL runs" path in `killGroupSafely`
    // without ever needing a signal-trapping fixture.
    const result = await spawnHook({
      layer: "global",
      file: "/fake/global/config.yml",
      command: "sleep 30",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 80,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  // --- Fix round 1, finding 1: the three required regression cases -------
  //
  // Root cause: the previous `killAfterTimeout` declared "done" (and
  // disarmed the escalation SIGKILL) the instant the *direct child*
  // exited, not when the whole process group was empty. All three cases
  // below were confirmed to REDDEN against the pre-fix implementation
  // (git stash of this file's `runGroupToCompletion` back to the old
  // `killAfterTimeout`) before being restored -- see the task report's
  // "Fix round 1" section for the exact commands and failing output.

  test("finding 1, case 1: leader honours SIGTERM but a group member traps it -- the escalation SIGKILL still reaches the member", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-f1-trap-"));
    const gcFile = join(dir, "gcpid");
    try {
      // The direct child (`sh`, via `wait`) has no trap and dies on the
      // first SIGTERM. The grandchild traps and ignores it, so only the
      // escalation SIGKILL can end it. Its stdio is redirected away from
      // the pipe so this test isolates finding 1's case (a) from case (b)/(c).
      const command = [
        "( trap '' TERM; sleep 300 ) >/dev/null 2>&1 &",
        `echo $! > '${gcFile}'`,
        "wait",
      ].join("\n");

      const result = await spawnHook({
        layer: "repo",
        file: "/fake/.cankan/config.yml",
        command,
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        // Same setup race as case 5 above (#93), pre-emptively: this hook
        // also backgrounds a job, writes `$!` to a file, and hangs on
        // `wait`, and the test below reads that file. It has not been
        // observed failing, but it is the identical shape on a tighter
        // window, so it gets the same treatment rather than waiting for it
        // to flake. The grandchild sleeps 300s, so `timedOut` and every
        // assertion are unaffected.
        timeoutMs: HANG_SETUP_TIMEOUT_MS,
      });

      expect(result.timedOut).toBe(true);

      const grandchildPid = Number((await readFile(gcFile, "utf8")).trim());
      leakedPids.push(grandchildPid);

      // Before the fix: the direct child's own exit (from the SIGTERM it
      // does NOT trap) cleared the pending SIGKILL escalation before it
      // could fire, so the trapping grandchild was never touched and
      // stayed alive indefinitely.
      const dead = await pollUntil(() => !isPidAlive(grandchildPid), 2_000, 20);
      expect(dead).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finding 1, case 2: leader exits promptly while a backgrounded grandchild holds the pipes -- runHooks returns within the timeout, not the grandchild's lifetime", async () => {
    const cfg = fakeConfigResult([
      fakeLayer("repo", "/fake/.cankan/config.yml", {
        expire: "sleep 2 & exit 0",
      }),
    ]);
    const startedAt = Date.now();
    const outcomes = await runHooks({
      cfg,
      event: "expire",
      repoRoot: process.cwd(),
      timeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;

    // Before the fix: the direct child's prompt `exit 0` satisfied
    // `killAfterTimeout` immediately, and the subsequent unbounded
    // `Promise.all([stdoutPromise, stderrPromise])` then blocked on the
    // backgrounded `sleep 2`'s inherited (non-redirected) stdout pipe for
    // its full 2-second lifetime, reporting `timedOut: false`.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  test("finding 1, case 3: leader exits promptly, grandchild redirects its own stdio and survives -- the group is not leaked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-f1-leak-"));
    const gcFile = join(dir, "gcpid");
    try {
      // Stdio redirected away from the pipe -- the OLD code's stream-drain
      // step alone could never have detected this grandchild, since the
      // pipe closes as soon as the direct child exits regardless of it.
      const command = [
        "sleep 5 >/dev/null 2>&1 &",
        `echo $! > '${gcFile}'`,
        "exit 0",
      ].join("\n");

      const startedAt = Date.now();
      const result = await spawnHook({
        layer: "repo",
        file: "/fake/.cankan/config.yml",
        command,
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 100,
      });
      const elapsedMs = Date.now() - startedAt;

      const grandchildPid = Number((await readFile(gcFile, "utf8")).trim());
      leakedPids.push(grandchildPid);

      // Before the fix: this returned in ~2ms with `timedOut: false`,
      // having never looked at the process group at all -- the
      // grandchild ran unmanaged for its full natural lifetime.
      expect(result.timedOut).toBe(true);
      expect(elapsedMs).toBeLessThan(2_000);
      const dead = await pollUntil(() => !isPidAlive(grandchildPid), 2_000, 20);
      expect(dead).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("obligation 2: the five env vars, argv shape, and captured streams", () => {
  test("6. a non-zero exit is captured in the result, not thrown", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "exit 3",
      cwd: process.cwd(),
      env: {},
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBeUndefined();
  });

  test("7. both stdout and stderr are captured", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "echo out-line; echo err-line 1>&2",
      cwd: process.cwd(),
      env: {},
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    expect(result.stdout).toBe("out-line\n");
    expect(result.stderr).toBe("err-line\n");
  });

  test("8. a hook command that does not exist fails cleanly with the typed error code in the result", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "/no/such/cankan-test-binary-xyz --flag",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    // /bin/sh -c reports "command not found" via exit 127 (POSIX.1-2017
    // §2.8.2) -- see HooksErrorCodes.HOOK_COMMAND_NOT_FOUND's doc comment.
    expect(result.exitCode).toBe(127);
    expect(result.errorCode).toBe(HooksErrorCodes.HOOK_COMMAND_NOT_FOUND);
    expect(result.timedOut).toBe(false);
  });

  test("argv is array form -- a ticket value containing shell metacharacters never reaches argv, only env", async () => {
    // If TITLE were ever concatenated into the shell command instead of
    // passed through env, this value would run `rm` (or break the command
    // entirely). Assert instead that it arrives inert, as plain env text.
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-injection-"));
    try {
      const outFile = join(dir, "title.txt");
      const result = await spawnHook({
        layer: "repo",
        file: "/fake/.cankan/config.yml",
        command: `printf '%s' "$TITLE" > '${outFile}'`,
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          TITLE: "$(rm -rf /tmp/should-not-run); `echo pwned`; ; rm -rf .",
        },
        timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
      });
      expect(result.exitCode).toBe(0);
      const content = await readFile(outFile, "utf8");
      expect(content).toBe(
        "$(rm -rf /tmp/should-not-run); `echo pwned`; ; rm -rf .",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("11. output beyond the 64 KiB cap is truncated, with the marker and the truncation flag set", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      // ~70000 bytes of 'a', well over the 65536-byte cap.
      command: "head -c 70000 /dev/zero | tr '\\0' 'a'",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain("truncated");
    expect(result.stdout.length).toBeLessThan(70_000);
    expect(result.stdout.length).toBeGreaterThan(65_536);
  });

  test("output at or under the cap is not marked truncated", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "printf 'hello'",
      cwd: process.cwd(),
      env: {},
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    expect(result.stdout).toBe("hello");
    expect(result.stdoutTruncated).toBe(false);
  });
});

describe("12. NUL-byte probe (task brief §5) -- Bun 1.4.0 rejects both cases synchronously", () => {
  test("a NUL byte in an env value (e.g. attacker-influenced $TITLE) fails cleanly as HOOK_SPAWN_FAILED, not thrown", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "true",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", TITLE: "abc\0def" },
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    expect(result.errorCode).toBe(HooksErrorCodes.HOOK_SPAWN_FAILED);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("a NUL byte in the resolved command string fails cleanly as HOOK_SPAWN_FAILED, not thrown", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "echo hi\0; echo should-not-run",
      cwd: process.cwd(),
      env: {},
      timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    });
    expect(result.errorCode).toBe(HooksErrorCodes.HOOK_SPAWN_FAILED);
    expect(result.exitCode).toBeNull();
  });

  test("runHooks strips a NUL byte from $TITLE at the env-merge boundary (fix round 1, finding 2) -- the hook still runs, not HOOK_SPAWN_FAILED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-nul-title-"));
    try {
      const outFile = join(dir, "title.txt");
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          close: `printf '%s' "$TITLE" > '${outFile}'`,
        }),
      ]);
      const outcomes = await runHooks({
        cfg,
        event: "close",
        repoRoot: dir,
        title: "bad\0title",
      });
      // Before the fix, a NUL byte anywhere in $TITLE made `Bun.spawn`
      // throw before anything started, suppressing this hook (and every
      // other layer's hook for the same event) with HOOK_SPAWN_FAILED --
      // the user's own hook penalized for hostile ticket content it never
      // asked to see. Now it runs, with the NUL simply stripped.
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.errorCode).toBeUndefined();
      expect(outcomes[0]?.exitCode).toBe(0);
      expect(await readFile(outFile, "utf8")).toBe("badtitle");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runHooks caps an oversized $TITLE at ENV_VALUE_MAX_BYTES (fix round 1, finding 2) rather than failing the hook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-huge-title-"));
    try {
      const outFile = join(dir, "title-len.txt");
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          close: `printf '%s' "$TITLE" | wc -c > '${outFile}'`,
        }),
      ]);
      // 2 MB, well past any single-string exec limit and the module's own
      // 4096-byte cap -- probed (task report / findings file) to make
      // Bun.spawn fail outright before this fix.
      const hugeTitle = "x".repeat(2 * 1024 * 1024);
      const outcomes = await runHooks({
        cfg,
        event: "close",
        repoRoot: dir,
        title: hugeTitle,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.errorCode).toBeUndefined();
      expect(outcomes[0]?.exitCode).toBe(0);
      const reportedLength = Number((await readFile(outFile, "utf8")).trim());
      expect(reportedLength).toBeLessThanOrEqual(4096);
      expect(reportedLength).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("environment: merged, never replaced, stdin ignored, cwd explicit", () => {
  test("runHooks merges RunHooksOptions.env with the five CanKan vars -- neither replaces the other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-merge-"));
    try {
      const outFile = join(dir, "out.txt");
      const command = `printf '%s|%s' "$UNRELATED_VAR" "$TICKET" > '${outFile}'`;
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          close: command,
        }),
      ]);

      const outcomes = await runHooks({
        cfg,
        event: "close",
        repoRoot: dir,
        ticket: "ck-merge",
        env: { PATH: process.env.PATH ?? "", UNRELATED_VAR: "still-here" },
      });

      // Both the caller's own base-environment var (`UNRELATED_VAR`) AND
      // the CanKan var (`TICKET`) are visible -- neither the merge nor the
      // five-vars-win rule silently dropped the other.
      expect(outcomes[0]?.exitCode).toBe(0);
      expect(await readFile(outFile, "utf8")).toBe("still-here|ck-merge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the five CanKan vars win over a same-named var already in the base environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-merge-win-"));
    try {
      const outFile = join(dir, "out.txt");
      const command = `printf '%s' "$TICKET" > '${outFile}'`;
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          close: command,
        }),
      ]);

      const outcomes = await runHooks({
        cfg,
        event: "close",
        repoRoot: dir,
        ticket: "ck-wins",
        // The base environment already sets TICKET to something else --
        // the CanKan value must win, not the base environment's.
        env: { PATH: process.env.PATH ?? "", TICKET: "should-be-overridden" },
      });

      expect(outcomes[0]?.exitCode).toBe(0);
      expect(await readFile(outFile, "utf8")).toBe("ck-wins");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cwd is the explicit repoRoot passed in, not process.cwd()", async () => {
    // Uses `makeTempRepoRoot()` (realpath'd), not a raw `mkdtemp`, because
    // this test compares against a *shell-reported* path (`pwd`'s own
    // `getcwd()`) rather than merely interpolating the path into a
    // command -- on macOS, an un-resolved `$TMPDIR` path
    // (`/var/folders/...`) and `sh`'s own physical-path answer
    // (`/private/var/folders/...`) would disagree even though they name
    // the same directory (task brief §9; the same hazard M2.6 hit twice).
    const { root: dir, cleanup } = await makeTempRepoRoot();
    try {
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          release: "pwd",
        }),
      ]);
      const outcomes = await runHooks({ cfg, event: "release", repoRoot: dir });
      expect(outcomes[0]?.exitCode).toBe(0);
      expect(outcomes[0]?.stdout.trim()).toBe(dir);
    } finally {
      await cleanup();
    }
  });

  test("stdin is ignored -- a hook that reads stdin sees immediate EOF, not the terminal", async () => {
    const result = await spawnHook({
      layer: "repo",
      file: "/fake/.cankan/config.yml",
      command: "cat; echo done",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 2_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("done\n");
  });
});

describe("the sink", () => {
  test("a throwing sink propagates out of runHooks, aborting any hooks still queued for this event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-sink-throw-"));
    try {
      const marker = join(dir, "second-ran.txt");
      const cfg = fakeConfigResult([
        fakeLayer("repo", join(dir, ".cankan", "config.yml"), {
          close: "true",
        }),
        fakeLayer("repo-local", join(dir, ".cankan", "local.yml"), {
          close: `touch '${marker}'`,
        }),
      ]);
      await expect(
        runHooks({
          cfg,
          event: "close",
          repoRoot: dir,
          sink: () => {
            throw new Error("sink infra failure");
          },
        }),
      ).rejects.toThrow("sink infra failure");
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an omitted sink is fine -- results are still returned, nothing is emitted anywhere", async () => {
    const cfg = fakeConfigResult([
      fakeLayer("repo", "/fake/.cankan/config.yml", { expire: "true" }),
    ]);
    const outcomes = await runHooks({
      cfg,
      event: "expire",
      repoRoot: process.cwd(),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.exitCode).toBe(0);
  });
});

describe("fix round 2, finding 4: the deadline timer must not keep the process alive after the hook finishes", () => {
  // No in-process test can observe this: `bun:test`'s runner does not wait
  // on pending timers before a test/suite completes (that's exactly why a
  // 400+-test suite full of 30s-default hooks finishes in under 2s), so an
  // uncleared timer is invisible from inside the process that leaked it.
  // This spawns a *real*, separate `bun` process that calls `runHooks`
  // once and falls off the end with no explicit `process.exit()` -- if
  // anything left a live timer behind, the child simply won't exit until
  // that timer fires.
  test("a fast hook does not keep a real child process alive for the rest of timeoutMs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cankan-hooks-timer-leak-"));
    try {
      // Absolute path computed at test time (not hardcoded) so this works
      // from any checkout -- `bun run` on the generated script below needs
      // a real filesystem path to import, not a package specifier.
      const runnerPath = join(
        import.meta.dir,
        "..",
        "..",
        "src",
        "hooks",
        "runner.ts",
      );
      const scriptPath = join(dir, "probe.ts");
      // Fix round 3 (Ruling 17): the invariant this test actually proves is
      // "the process exits well before timeoutMs" -- the margin just needs
      // to be wide enough that a cold `bun` process spawn on a small,
      // possibly-macOS CI runner can't make the passing side flake, and
      // that the broken side still fails clearly. The pass threshold is
      // derived from `LEAK_TEST_TIMEOUT_MS` (half of it) rather than a
      // second, unrelated magic number, so the relationship stays visible.
      const LEAK_TEST_TIMEOUT_MS = 2_000;
      // A fake ConfigResult inlined directly (not imported from this test
      // file) -- this script runs as its own separate `bun` process with
      // no access to this file's module scope. `runHooks` only ever reads
      // `.layers`, so `.value`/`.resolved`/`.entries` need no real shape
      // here (this file is transpiled and run, never type-checked, by
      // `bun run`).
      const script = `
import { runHooks } from ${JSON.stringify(runnerPath)};

const cfg = {
  value: {},
  layers: [{ layer: "repo", file: "/fake/.cankan/config.yml", data: { hooks: { close: "true" } } }],
  resolved: () => undefined,
  entries: () => [],
};

const startedAt = Date.now();
await runHooks({ cfg, event: "close", repoRoot: ${JSON.stringify(dir)}, timeoutMs: ${LEAK_TEST_TIMEOUT_MS} });
console.log("runHooks resolved at +" + (Date.now() - startedAt) + "ms");
`;
      await writeFile(scriptPath, script);

      const startedAt = Date.now();
      const proc = Bun.spawn({
        cmd: ["bun", "run", scriptPath],
        cwd: dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      const elapsedMs = Date.now() - startedAt;

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("runHooks resolved at +");
      // Before the fix: the process stayed alive for essentially the
      // whole `LEAK_TEST_TIMEOUT_MS` (the leaked deadline timer) even
      // though `runHooks` itself resolved in a few ms (findings file: a
      // default-30s-timeout hook returning in ~3ms kept the real process
      // alive for +30002ms). After the fix, the entire process -- bun
      // startup, the hook, and exit -- should complete well under it.
      // Half of `LEAK_TEST_TIMEOUT_MS`, not an unrelated constant: wide
      // enough to absorb a cold `bun` spawn on a small/macOS CI runner
      // without flaking the passing side, while a broken side still fails
      // unambiguously (it would land near the full `LEAK_TEST_TIMEOUT_MS`,
      // not just over the threshold).
      expect(elapsedMs).toBeLessThan(LEAK_TEST_TIMEOUT_MS / 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
