import { afterEach, describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { createGitAdapter, GitErrorCodes, type ObjectSha } from "../../src/git/index";
import { EventErrorCodes } from "../../src/events/errors";
import { initRef, initRefCore, type InitRefHooks } from "../../src/events/ref";
import { append, type EventCandidate, read } from "../../src/events/log";
// See `git.test.ts`'s own comment on why this is a relative import.
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";

const COORD_REF = "refs/cankan/coordination";
const NOW = Date.parse("2026-09-15T10:00:00Z");

const repos: TempRepo[] = [];
async function tempRepo(options: Parameters<typeof makeTempRepo>[0] = {}): Promise<TempRepo> {
  const repo = await makeTempRepo(options);
  repos.push(repo);
  return repo;
}

afterEach(async () => {
  while (repos.length > 0) {
    const repo = repos.pop();
    if (repo) await repo.cleanup();
  }
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!isCanKanError(error)) {
      throw new Error(`expected a CanKanError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but the promise resolved`);
}

/** Raw plumbing for test setup only — never the adapter under test. Mirrors `git.test.ts`'s own helper. */
function rawGit(cwd: string, args: string[], stdin?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

describe("initRef", () => {
  test("creates the ref, empty, when it does not exist yet", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    expect(await adapter.readRef(COORD_REF)).toBeNull();

    await initRef(adapter, COORD_REF, { now: NOW });

    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records).toEqual([]);

    // The placeholder month file exists and is a well-formed, zero-line
    // file — not merely "no file at all."
    const blob = await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl");
    expect(blob).toBe("");
  });

  test("is idempotent — a second call against an already-initialized ref is a no-op", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await initRef(adapter, COORD_REF, { now: NOW });
    const shaAfterFirst = await adapter.readRef(COORD_REF);

    await initRef(adapter, COORD_REF, { now: NOW });
    const shaAfterSecond = await adapter.readRef(COORD_REF);

    expect(shaAfterSecond).toBe(shaAfterFirst);
  });

  test("two processes calling initRef concurrently converge on one ref, not two", async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const secondaryDir = repo.worktreeDirs[0];
    if (!secondaryDir) throw new Error("expected a worktree");
    const primary = await createGitAdapter(repo.dir);
    const secondary = await createGitAdapter(secondaryDir);

    await Promise.all([initRef(primary, COORD_REF, { now: NOW }), initRef(secondary, COORD_REF, { now: NOW })]);

    const shaFromPrimary = await primary.readRef(COORD_REF);
    const shaFromSecondary = await secondary.readRef(COORD_REF);
    expect(shaFromPrimary).not.toBeNull();
    // Both worktrees share one `.git`, so both must agree on exactly one
    // winner — not two divergent commits.
    expect(shaFromPrimary).toBe(shaFromSecondary);
  });

  test("the seam: a rejected parent:null CAS re-reads and accepts the winner rather than throwing", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const other = await createGitAdapter(repo.dir);

    let hookCalled = false;
    const hooks: InitRefHooks = {
      beforeCas: async () => {
        hookCalled = true;
        // A real, independent initRef wins the race first — guaranteeing
        // this call's own `parent: null` attempt (already past its own
        // `readRef` check, which found the ref absent) is rejected.
        await initRef(other, COORD_REF, { now: NOW });
      },
    };

    await initRefCore(adapter, COORD_REF, { now: NOW }, hooks);

    expect(hookCalled).toBe(true);
    // Converged, not corrupted: the ref exists, and this function did not
    // throw despite losing its own CAS.
    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
    expect(await adapter.readRef(COORD_REF)).toBe(await other.readRef(COORD_REF));
  });
});

describe("append's implicit lazy init vs. initRef — they converge, not collide", () => {
  test("initRef followed by append on the same (now-initialized) ref works normally", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await initRef(adapter, COORD_REF, { now: NOW });

    const candidate = {
      event: "release",
      ts: "2026-09-15T09:00:00Z",
      actor: "alice",
      ticket: "ck-1",
    } as unknown as EventCandidate;
    const appended = await append(adapter, COORD_REF, candidate, { now: NOW });

    expect(appended.month).toBe("2026-09");
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records).toHaveLength(1);
  });
});

// ============================================================================
// Fix round 1, S3 — initRef must not report success on an unusable ref
// ============================================================================

describe("initRef — fix round 1, S3: refuses to report success on a ref that isn't a usable coordination ref", () => {
  test("a ref planted directly at a blob is rejected, not silently accepted", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Plant refs/cankan/coordination pointing straight at a blob object —
    // `updateRefCAS` accepts any 40-hex object id (it type-checks a `Sha`
    // shape, not an object *type*), so this is reachable through the
    // adapter's own public surface, the way a bug or a hostile push could
    // produce it.
    const blobSha = rawGit(repo.dir, ["hash-object", "-w", "--stdin"], "not a tree or a commit").trim() as ObjectSha;
    const planted = await adapter.updateRefCAS(COORD_REF, blobSha, null);
    if (planted.outcome !== "applied") throw new Error("setup failed");

    // Before the fix: this resolved successfully, and every later `append`
    // would fail forever with an opaque GIT_COMMAND_FAILED.
    await expectCode(initRef(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_REF_UNUSABLE);

    // And the ref itself is left exactly as planted — this is detection,
    // not an attempted repair.
    const refAfter = await adapter.readRef(COORD_REF);
    expect(refAfter as string | null).toBe(blobSha as string);
  });

  test("fix round 4, Low 1: EVENT_REF_UNUSABLE carries the real underlying git error as its cause", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const blobSha = rawGit(repo.dir, ["hash-object", "-w", "--stdin"], "not a tree or a commit").trim() as ObjectSha;
    const planted = await adapter.updateRefCAS(COORD_REF, blobSha, null);
    if (planted.outcome !== "applied") throw new Error("setup failed");

    try {
      await initRef(adapter, COORD_REF, { now: NOW });
      throw new Error("expected initRef() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_REF_UNUSABLE);
      // Before the fix: the round-3 refactor (assertRefIsUsable throwing
      // directly -> checkRefUsability returning a bare string) discarded
      // the caught error entirely, so `cause` was always `undefined` here
      // — a diagnosability regression against fm8, since the real
      // `GIT_COMMAND_FAILED` explaining *why* the ref is unusable was
      // silently dropped.
      expect(error.cause).toBeDefined();
      if (!isCanKanError(error.cause)) throw new Error("expected error.cause to be a CanKanError");
      expect(error.cause.code).toBe(GitErrorCodes.GIT_COMMAND_FAILED);
    }
  });

  test("fix round 5, Low E: the race-winner path also carries the real cause (untested by fix round 4's own test)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const other = await createGitAdapter(repo.dir);

    const hooks: InitRefHooks = {
      beforeCas: async () => {
        // A concurrent process wins the create-the-ref race with a ref
        // planted directly at a blob -- unusable, not merely "someone
        // else's valid ref." This drives `initRefCore`'s *other*
        // `checkRefUsability` call site (the one after losing the
        // `parent: null` race, `ref.ts`'s `winnerResult` branch) rather
        // than the `existing !== null` branch fix round 4's own Low 1
        // test already covers.
        const blobSha = rawGit(repo.dir, ["hash-object", "-w", "--stdin"], "not a tree or a commit").trim() as ObjectSha;
        const planted = await other.updateRefCAS(COORD_REF, blobSha, null);
        if (planted.outcome !== "applied") throw new Error("setup failed");
      },
    };

    try {
      await initRefCore(adapter, COORD_REF, { now: NOW }, hooks);
      throw new Error("expected initRefCore() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_REF_UNUSABLE);
      expect(error.cause).toBeDefined();
      if (!isCanKanError(error.cause)) throw new Error("expected error.cause to be a CanKanError");
      expect(error.cause.code).toBe(GitErrorCodes.GIT_COMMAND_FAILED);
    }
  });

  test("fix round 2, NEW-1: a peer-planted directory at the fixed probe path does not make a healthy ref look unusable", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // A peer with push access — this module's own trust model — plants a
    // directory (not a plain file) at the exact, predictable
    // `USABILITY_PROBE_PATH` `checkRefUsability` reads (the path is public
    // source, so it is exactly as predictable to an adversary as to this
    // test). The board is otherwise perfectly healthy: a real commit with a
    // real month file.
    const planted = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "peer-planted directory at the usability probe path",
      files: [
        { path: "events/2026-09.jsonl", content: "" },
        { path: "events/.cankan-ref-usability-probe/x", content: "hostile" },
      ],
    });
    if (planted.outcome !== "applied") throw new Error("setup failed");

    // Before this fix: `readBlobFromRef`'s own three-way check raised
    // `GIT_BLOB_AMBIGUOUS` for the directory collision (ls-tree resolved a
    // `040000` tree entry, not the expected `100644` blob), and
    // `assertRefIsUsable` (this function was later renamed `checkRefUsability`) mapped *any* thrown error to `EVENT_REF_UNUSABLE`
    // — reporting a fabricated hard failure on a board that is entirely
    // healthy. A fix for a fail-open that creates a peer-triggerable
    // fail-closed is strictly worse than the fail-open it replaced.
    await expect(initRef(adapter, COORD_REF, { now: NOW })).resolves.toBeUndefined();

    // And the ref really is healthy: append/read both still work normally
    // against it, proving `GIT_BLOB_AMBIGUOUS` here was never evidence of
    // an actually-broken ref.
    const candidate = {
      event: "release",
      ts: "2026-09-15T09:00:00Z",
      actor: "alice",
      ticket: "ck-1",
    } as unknown as EventCandidate;
    const appended = await append(adapter, COORD_REF, candidate, { now: NOW });
    expect(appended.month).toBe("2026-09");
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records).toHaveLength(1);
  });

  test("known residual gap (Orchestrator Ruling R19): a ref planted at a raw tree is NOT caught by this fix", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // `git mktree` from empty input is the canonical way to produce the
    // (always-available, zero-entry) empty tree object id.
    const emptyTreeSha = rawGit(repo.dir, ["mktree"], "").trim();
    const planted = await adapter.updateRefCAS(COORD_REF, emptyTreeSha as ObjectSha, null);
    if (planted.outcome !== "applied") throw new Error("setup failed");

    // Documents the known gap: `initRefCore`'s usability probe cannot tell
    // a bare tree apart from a commit (both are tree-ish, so `ls-tree`
    // succeeds against either) without a new adapter primitive (an
    // object-type query) that R19 scopes out of this dispatch. This test
    // exists so the gap is tracked, not silently forgotten — if this ever
    // starts throwing, `ref.ts`'s doc comment on `checkRefUsability` should
    // be updated to say the gap is closed.
    await expect(initRef(adapter, COORD_REF, { now: NOW })).resolves.toBeUndefined();
  });
});

/** Replaces the coordination ref's entire tree with one containing a single entry at `cacheinfo` (`"<mode>,<sha>,<path>"`) — real plumbing, real commit, on top of whatever the ref currently points to. Mirrors `log.test.ts`'s identical helper. */
async function plantAtEventsPrefix(adapter: Awaited<ReturnType<typeof createGitAdapter>>, repoDir: string, cacheinfo: string): Promise<void> {
  rawGit(repoDir, ["read-tree", "--empty"]);
  rawGit(repoDir, ["update-index", "--add", "--cacheinfo", cacheinfo]);
  const treeSha = rawGit(repoDir, ["write-tree"]).trim();
  const parent = await adapter.readRef(COORD_REF);
  if (parent === null) throw new Error("expected an existing ref to plant onto");
  const commitSha = rawGit(repoDir, ["commit-tree", "-p", parent, "-m", "plant", treeSha]).trim();
  rawGit(repoDir, ["update-ref", COORD_REF, commitSha]);
}

describe("initRef — fix round 3 follow-up, Ruling R48: checkRefUsability closes the same blocked-`events`-prefix gap read()/diagnose()/recover() already closed", () => {
  test("a blob planted at the bare `events` path makes initRef() throw EVENT_REF_UNUSABLE (cause: EVENT_LOG_EVENTS_PREFIX_BLOCKED), not silently report usable", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await initRef(adapter, COORD_REF, { now: NOW });

    const blobSha = rawGit(repo.dir, ["hash-object", "-w", "--stdin"], "not a directory").trim();
    await plantAtEventsPrefix(adapter, repo.dir, `100644,${blobSha},events`);

    // Before this fix: initRef() against this exact board resolved
    // successfully (confirmed by direct probe) even though read() against
    // the identical ref already threw EVENT_LOG_EVENTS_PREFIX_BLOCKED —
    // checkRefUsability's own probe path is nested *under* `events`, so it
    // silently read as "not found" under the blocked prefix, the same as
    // a genuinely empty, healthy board.
    try {
      await initRef(adapter, COORD_REF, { now: NOW });
      throw new Error("expected initRef() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_REF_UNUSABLE);
      expect(isCanKanError(error.cause)).toBe(true);
      if (!isCanKanError(error.cause)) throw new Error("unreachable");
      expect(error.cause.code).toBe(EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED);
    }
  });

  test("a symlink planted at the bare `events` path also fails closed (mode 120000 shares GIT_BLOB_AMBIGUOUS with a healthy directory)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await initRef(adapter, COORD_REF, { now: NOW });

    const blobSha = rawGit(repo.dir, ["hash-object", "-w", "--stdin"], "/etc/passwd").trim();
    await plantAtEventsPrefix(adapter, repo.dir, `120000,${blobSha},events`);

    // Asserts `cause.code`, not just the outer `EVENT_REF_UNUSABLE`: under a
    // hypothetical regression in `isEventsPrefixBlocked`'s mode check, this
    // shape would still throw `EVENT_REF_UNUSABLE` via the *second*,
    // pre-existing probe's own generic-failure path — with a different
    // `cause` — and a bare `expectCode` on the outer code alone would not
    // notice. This is the property that distinguishes "closed by this
    // round's R48 probe" from "caught by accident."
    try {
      await initRef(adapter, COORD_REF, { now: NOW });
      throw new Error("expected initRef() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_REF_UNUSABLE);
      expect(isCanKanError(error.cause)).toBe(true);
      if (!isCanKanError(error.cause)) throw new Error("unreachable");
      expect(error.cause.code).toBe(EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED);
    }
  });

  test("a gitlink planted at the bare `events` path also fails closed (mode 160000 shares GIT_BLOB_AMBIGUOUS with a healthy directory)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await initRef(adapter, COORD_REF, { now: NOW });

    const fakeSubmoduleSha = "a".repeat(40);
    await plantAtEventsPrefix(adapter, repo.dir, `160000,${fakeSubmoduleSha},events`);

    // Same reasoning as the symlink test above: assert the specific `cause`,
    // not just the outer code.
    try {
      await initRef(adapter, COORD_REF, { now: NOW });
      throw new Error("expected initRef() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_REF_UNUSABLE);
      expect(isCanKanError(error.cause)).toBe(true);
      if (!isCanKanError(error.cause)) throw new Error("unreachable");
      expect(error.cause.code).toBe(EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED);
    }
  });

  test("control: a healthy events directory is unaffected — initRef() still reports usable (no false positive)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await initRef(adapter, COORD_REF, { now: NOW });

    await expect(initRef(adapter, COORD_REF, { now: NOW })).resolves.toBeUndefined();
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records).toEqual([]);
  });
});

// ============================================================================
// Fix round 1, S4/Ruling R20 — end-to-end fm10 coverage, exercised on initRef
// too. Fix round 2, Ruling R24: this is an end-to-end assertion, not a guard
// on ref.ts's own validateCoordinationRef call specifically — see log.test.ts's
// identical framing note above its own fm10 describe block for the full
// reasoning (the adapter's ensureValidRef re-checks the same thing on every
// git call regardless).
// ============================================================================

describe("initRef — the fm10 ref gate", () => {
  test("rejects refs/heads/main", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(initRef(adapter, "refs/heads/main", { now: NOW }), GitErrorCodes.GIT_REF_INVALID);
  });
});

// ============================================================================
// Fix round 3 sweep — initRef validated no `now` at all
// ============================================================================

describe("initRef — fix round 3 sweep: now validated against Date's representable range", () => {
  test("rejects now: NaN rather than committing a permanent events/NaN-NaN.jsonl", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Before the fix: `initRef` validated no `now` at all, and this
    // resolved successfully having committed a permanent
    // `events/NaN-NaN.jsonl` onto the board's coordination root — a file
    // `read()` can never see.
    await expectCode(initRef(adapter, COORD_REF, { now: Number.NaN }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    expect(await adapter.readRef(COORD_REF)).toBeNull();
  });

  test("rejects now one millisecond past Date's representable boundary", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const MAX_DATE_MS = 8_640_000_000_000_000;

    await expectCode(
      initRef(adapter, COORD_REF, { now: MAX_DATE_MS + 1 }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );
    expect(await adapter.readRef(COORD_REF)).toBeNull();
  });

  test("accepts now exactly at the boundary", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const MAX_DATE_MS = 8_640_000_000_000_000;

    await initRef(adapter, COORD_REF, { now: MAX_DATE_MS });
    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
  });
});

// ============================================================================
// Fix round 3, L2 — a ref that vanishes between readRef and the usability
// probe is a benign local race ("absent"), not a hard failure ("unusable")
// ============================================================================

describe("initRef — fix round 3, L2: a ref that vanishes between readRef and the usability probe is treated as absent", () => {
  test("proceeds to (re)create the ref rather than throwing EVENT_REF_UNUSABLE", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // A real, healthy, already-initialized ref.
    await initRef(adapter, COORD_REF, { now: NOW });
    expect(await adapter.readRef(COORD_REF)).not.toBeNull();

    const hooks: InitRefHooks = {
      beforeUsabilityCheck: async () => {
        // Simulate a concurrent *local* process racing this initRef call —
        // never a remote peer, who has no way to delete this clone's local
        // refs/cankan/*. A real `git update-ref -d`, not a mock.
        rawGit(repo.dir, ["update-ref", "-d", COORD_REF]);
      },
    };

    // Before the fix: `checkRefUsability`'s probe throws `GIT_REF_NOT_FOUND`
    // once the ref is gone, and the "any other error is unusable" branch
    // mapped that to a hard `EVENT_REF_UNUSABLE` — on a board whose only
    // problem was a benign local race, not a corrupted ref.
    await initRefCore(adapter, COORD_REF, { now: NOW }, hooks);

    // Converged: the ref was recreated, not left absent or thrown on.
    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
  });
});

// ============================================================================
// Fix round 3 (Ruling R31/R32, orchestrator security review): an explicit
// `null` options argument must not throw a raw TypeError
// ============================================================================

describe("initRef — fix round 3: an explicit null options argument is normalized, not a raw TypeError", () => {
  test("initRef(adapter, ref, null) behaves exactly like initRef(adapter, ref) — creates the ref, no raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Before the fix: `options.now` on a `null` options argument threw a
    // raw `TypeError` (a default parameter does not apply to an explicit
    // `null`).
    await initRef(adapter, COORD_REF, null);
    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
  });
});
