import { afterEach, describe, expect, test } from "bun:test";
import { createGitAdapter } from "../../src/git/index";
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
