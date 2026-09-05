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
    // starts throwing, `ref.ts`'s doc comment on `assertRefIsUsable` should
    // be updated to say the gap is closed.
    await expect(initRef(adapter, COORD_REF, { now: NOW })).resolves.toBeUndefined();
  });
});

// ============================================================================
// Fix round 1, S4/Ruling R20 — the fm10 ref gate, exercised on initRef too
// ============================================================================

describe("initRef — the fm10 ref gate", () => {
  test("rejects refs/heads/main", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(initRef(adapter, "refs/heads/main", { now: NOW }), GitErrorCodes.GIT_REF_INVALID);
  });
});
