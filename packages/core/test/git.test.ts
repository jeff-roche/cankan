import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import util from "node:util";
import { isCanKanError } from "../src/errors";
import {
  createGitAdapter,
  GitErrorCodes,
  type GitAdapter,
  type ObjectSha,
  type RefSha,
  validateCoordinationRef,
  withCasRetry,
} from "../src/git/index";
// Fix-round-1 F1 (final review): `updateRefCASCore` is a module-internal
// export from `adapter.ts` (not re-exported from `index.ts` — see its own
// doc comment) so the two `--no-deref` tests below can drive the shipped
// function directly, rather than a hand-copied argv through `Bun.spawnSync`
// that no code in this module actually runs.
import { updateRefCASCore } from "../src/git/adapter";
import type { Equal, Expect, IsAssignable } from "./typeLevel";

/*
 * `@jeff-roche/cankan-test-utils` is not a declared dependency of
 * `packages/core/package.json` (only `packages/cli` depends on it), so bun
 * never symlinks it into `packages/core/node_modules` — confirmed by
 * inspecting every workspace package's `node_modules/@jeff-roche` during
 * this task. `packages/core/package.json` is frozen, so the fix is the same
 * one `test/index.test.ts` already applies to `packages/core` importing
 * itself: a relative import to the source file instead of the package
 * specifier.
 */
import { makeTempRepo, type TempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

const COORD_REF = "refs/cankan/coordination";
const STAGING_REF = "refs/cankan/coordination-remote";

/** Raw plumbing for test setup/assertions only — never the adapter under test. */
function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

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

describe("validateCoordinationRef", () => {
  test("accepts a legitimate coordination ref", async () => {
    await expect(validateCoordinationRef(COORD_REF)).resolves.toBe(COORD_REF);
  });

  test("rejects refs/heads/main — outside the refs/cankan/ namespace", async () => {
    await expectCode(validateCoordinationRef("refs/heads/main"), GitErrorCodes.GIT_REF_INVALID);
  });

  test("rejects HEAD — update-ref dereferences it", async () => {
    await expectCode(validateCoordinationRef("HEAD"), GitErrorCodes.GIT_REF_INVALID);
  });

  test("rejects refs/cankan/../heads/main — matches the regex but not check-ref-format", async () => {
    // This is also the regression guard for a real defect this task found:
    // `check-ref-format` fails with a bare non-zero exit and empty stderr —
    // a failure shape a transport whose error detection requires both exit
    // code *and* non-empty stderr (as `simple-git`'s did, pre-fix-round-1)
    // silently resolves through instead of throwing, which would have made
    // this exact ref pass validation. Fix-round-1 Ruling 11 removed that
    // transport entirely: `check-ref-format` now runs through this module's
    // one `Bun.spawn` chokepoint (`transport.ts`'s `runGitRaw`), which
    // exposes the exit code directly and cannot repeat this defect. The
    // test still guards the underlying defect class, not a specific
    // library's bug — if `check-ref-format`'s call site is ever routed
    // through anything that treats "non-zero exit, empty stderr" as
    // success, this is the test that catches it.
    await expectCode(
      validateCoordinationRef("refs/cankan/../heads/main"),
      GitErrorCodes.GIT_REF_INVALID,
    );
  });

  test("rejects a leading-dash ref", async () => {
    await expectCode(validateCoordinationRef("-weird"), GitErrorCodes.GIT_REF_INVALID);
  });

  test("rejects an empty ref", async () => {
    await expectCode(validateCoordinationRef(""), GitErrorCodes.GIT_REF_INVALID);
  });

  test("rejection happens before any git invocation", async () => {
    // If the adapter ran a git command before validating, this would fail
    // with a bootstrap/ENOENT-shaped error rather than GIT_REF_INVALID,
    // because `root` no longer exists.
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await rm(repo.dir, { recursive: true, force: true });

    await expectCode(adapter.readRef("refs/heads/main"), GitErrorCodes.GIT_REF_INVALID);
    await expectCode(
      adapter.updateRefCAS("refs/heads/main", "a".repeat(40) as ObjectSha, null),
      GitErrorCodes.GIT_REF_INVALID,
    );
    await expectCode(adapter.readBlobFromRef("refs/heads/main", "x"), GitErrorCodes.GIT_REF_INVALID);
    await expectCode(
      adapter.commitTreeToRef("refs/heads/main", { parent: null, message: "x", files: [] }),
      GitErrorCodes.GIT_REF_INVALID,
    );
    await expectCode(adapter.fetch("origin", "refs/heads/main"), GitErrorCodes.GIT_REF_INVALID);
    await expectCode(adapter.push("origin", "refs/heads/main"), GitErrorCodes.GIT_REF_INVALID);
    await expectCode(
      adapter.fetchReconciliation("origin", "refs/heads/main", COORD_REF),
      GitErrorCodes.GIT_REF_INVALID,
    );
  });
});

/**
 * Compile-time proof that inverting `updateRefCAS`'s two sha arguments
 * cannot type-check — checked by `bun run typecheck`, not `bun test` (which
 * strips types without checking them). See `types.ts`'s `ObjectSha` doc
 * comment for why `RefSha`/`ObjectSha` are distinct brands rather than one
 * `Sha`.
 */
type UpdateRefCASParams = Parameters<GitAdapter["updateRefCAS"]>;
export type CasInversionAssertions = [
  Expect<Equal<UpdateRefCASParams[1], ObjectSha>>,
  Expect<Equal<UpdateRefCASParams[2], RefSha | null>>,
  // The two brands do not cross: a value observed from a ref cannot stand in
  // for a value this module just minted, and vice versa.
  Expect<Equal<IsAssignable<RefSha, ObjectSha>, false>>,
  Expect<Equal<IsAssignable<ObjectSha, RefSha>, false>>,
];

describe("updateRefCAS — PLAN.md's floor and the inversion hazard", () => {
  test("two processes racing to CREATE a ref with the same (null) expected old value: exactly one succeeds", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const shaA = git(repo.dir, ["commit-tree", "-m", "a", git(repo.dir, ["write-tree"]).trim()]).trim() as ObjectSha;
    const shaB = git(repo.dir, ["commit-tree", "-m", "b", git(repo.dir, ["write-tree"]).trim()]).trim() as ObjectSha;

    const [resultA, resultB] = await Promise.all([
      adapter.updateRefCAS(COORD_REF, shaA, null),
      adapter.updateRefCAS(COORD_REF, shaB, null),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(["applied", "rejected"]);

    const loser = resultA.outcome === "rejected" ? resultA : resultB;
    if (loser.outcome !== "rejected") throw new Error("unreachable");
    // Observed for this task (git 2.55.0, 15 repeated races): the loser of a
    // race to *create* a not-yet-existing ref gets `reference already
    // exists`, not the ADR's literal `is at X but expected Y` form — both
    // are the ref's actual state disagreeing with the compare value.
    // Asserted on the exact observed wording (see the task report for the
    // full account) rather than logged.
    expect(loser.stderr).toContain("reference already exists");

    const finalRef: string | null = await adapter.readRef(COORD_REF);
    expect(finalRef).not.toBeNull();
    expect([shaA, shaB] as string[]).toContain(finalRef as string);
  });

  test("two processes racing on the same non-null expected old value: exactly one succeeds", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const base = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "init",
      files: [{ path: "events/2026-09.jsonl", content: "" }],
    });
    if (base.outcome !== "applied") throw new Error("setup failed");
    const oldSha = (await adapter.readRef(COORD_REF)) as RefSha;

    const shaA = git(repo.dir, ["commit-tree", "-p", oldSha, "-m", "a", git(repo.dir, ["write-tree"]).trim()]).trim() as ObjectSha;
    const shaB = git(repo.dir, ["commit-tree", "-p", oldSha, "-m", "b", git(repo.dir, ["write-tree"]).trim()]).trim() as ObjectSha;

    const [resultA, resultB] = await Promise.all([
      adapter.updateRefCAS(COORD_REF, shaA, oldSha),
      adapter.updateRefCAS(COORD_REF, shaB, oldSha),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(["applied", "rejected"]);

    const loser = resultA.outcome === "rejected" ? resultA : resultB;
    if (loser.outcome !== "rejected") throw new Error("unreachable");
    // The ADR's own stated form (0001:471-473), observed as-is here.
    expect(loser.stderr).toMatch(/cannot lock ref '[^']*': is at [0-9a-f]+ but expected [0-9a-f]+/);
  });

  test("works from a secondary worktree", async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const worktreeDir = repo.worktreeDirs[0];
    if (!worktreeDir) throw new Error("expected a worktree");
    const adapter = await createGitAdapter(worktreeDir);

    const applied = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "init from worktree",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });
    expect(applied.outcome).toBe("applied");

    // Visible from the *primary* worktree too — one shared ref store.
    const primaryAdapter = await createGitAdapter(repo.dir);
    const sha = await primaryAdapter.readRef(COORD_REF);
    expect(sha).not.toBeNull();
  });

  test("a stale (wrong) expected old value is rejected — proves the compare argument is load-bearing", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const first = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "first",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });
    if (first.outcome !== "applied") throw new Error("setup failed");
    const staleOld = null; // the ref now exists, so "null" (expects absent) is now wrong

    const nextSha = git(
      repo.dir,
      ["commit-tree", "-p", first.sha, "-m", "second", git(repo.dir, ["write-tree"]).trim()],
    ).trim() as ObjectSha;

    const result = await adapter.updateRefCAS(COORD_REF, nextSha, staleOld);
    expect(result.outcome).toBe("rejected");

    // And the ref must be genuinely unchanged — a CAS that silently
    // "succeeded" against the wrong compare value would defeat mutual
    // exclusion even if it happened to report "rejected" cosmetically.
    const current = await adapter.readRef(COORD_REF);
    expect(current).toBe(first.sha);
  });
});

describe("F2 — newSha/oldSha/parent must be a 40-hex object id", () => {
  test("updateRefCAS rejects a newSha that is not a sha", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(
      adapter.updateRefCAS(COORD_REF, "HEAD" as ObjectSha, null),
      GitErrorCodes.GIT_SHA_INVALID,
    );
  });

  test("updateRefCAS rejects an oldSha that is not a sha", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const validSha = "a".repeat(40) as unknown as ObjectSha;
    await expectCode(
      adapter.updateRefCAS(COORD_REF, validSha, "refs/heads/main" as unknown as RefSha),
      GitErrorCodes.GIT_SHA_INVALID,
    );
  });

  test("commitTreeToRef rejects a params.parent that is not a sha, before building anything off-tree", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const statusBefore = git(repo.dir, ["status", "--porcelain"]);

    await expectCode(
      adapter.commitTreeToRef(COORD_REF, {
        parent: "HEAD" as unknown as RefSha,
        message: "x",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      }),
      GitErrorCodes.GIT_SHA_INVALID,
    );

    // Rejected before `buildTree` ever ran — no stray temp index, no change
    // to the worktree.
    expect(git(repo.dir, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await adapter.readRef(COORD_REF)).toBeNull();
  });

  test("the reproduced lost-update sequence is now prevented at the type/runtime boundary", async () => {
    // Verified reproduction (fix-round-1 F2, before this fix): a caller
    // passes a non-sha revision expression as `newSha` (e.g. "HEAD"),
    // `updateRefCAS` applies it and hands back `{ sha: "HEAD" }`; a second
    // writer advances the ref normally; the first caller then passes "HEAD"
    // back as a *stale* `oldSha` — since "HEAD" is late-bound, the compare
    // silently matches the ref's *current* value instead of the value it had
    // when the caller last observed it, and the write is wrongly accepted,
    // discarding the second writer's commit. `assertShaShape` closes this by
    // rejecting the non-sha value at the very first call, before it is ever
    // returned to a caller as if it were a legitimate compare value.
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // The caller's first (malformed) call: never reaches git, never applies,
    // never hands back a bogus "sha".
    await expectCode(
      adapter.updateRefCAS(COORD_REF, "HEAD" as unknown as ObjectSha, null),
      GitErrorCodes.GIT_SHA_INVALID,
    );

    // A second, legitimate writer proceeds normally and is never at risk of
    // being silently overwritten by the first caller's (rejected) attempt.
    const secondWriter = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "second writer's commit",
      files: [{ path: "events/2026-09.jsonl", content: '{"claim":true}\n' }],
    });
    expect(secondWriter.outcome).toBe("applied");
    expect(await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl")).toBe('{"claim":true}\n');
  });
});

describe("commitTreeToRef — the no-parent case", () => {
  test("omits -p and compares against the 40-zero sha when parent is null", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const result = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "first commit on a not-yet-existing ref",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") throw new Error("unreachable");

    const parents = git(repo.dir, ["log", "--format=%P", "-1", result.sha]).trim();
    expect(parents).toBe("");

    const finalRef = await adapter.readRef(COORD_REF);
    expect(finalRef).toBe(result.sha);
  });
});

describe("commitTreeToRef leaves the worktree completely untouched", () => {
  test("git status --porcelain is empty and the index is unchanged, before and after", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const statusBefore = git(repo.dir, ["status", "--porcelain"]);
    const indexBefore = git(repo.dir, ["ls-files", "--stage"]);
    expect(statusBefore).toBe("");

    const result = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "off-tree",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });
    expect(result.outcome).toBe("applied");

    const statusAfter = git(repo.dir, ["status", "--porcelain"]);
    const indexAfter = git(repo.dir, ["ls-files", "--stage"]);
    expect(statusAfter).toBe("");
    expect(indexAfter).toBe(indexBefore);
    expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(git(repo.dir, ["rev-parse", "main"]));
  });
});

describe("failure mode 10 — coordination ref configured outside its namespace", () => {
  test("the adapter refuses rather than appending a commit to main", async () => {
    const repo = await tempRepo({ bareRemote: true });
    if (!repo.remoteDir) throw new Error("expected a bare remote");
    const adapter = await createGitAdapter(repo.dir);

    const mainTipBefore = git(repo.remoteDir, ["--git-dir", repo.remoteDir, "rev-parse", "main"]).trim();

    await expectCode(
      adapter.commitTreeToRef("refs/heads/main", {
        parent: null,
        message: "attempted hijack",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      }),
      GitErrorCodes.GIT_REF_INVALID,
    );
    await expectCode(
      adapter.updateRefCAS("refs/heads/main", "a".repeat(40) as ObjectSha, null),
      GitErrorCodes.GIT_REF_INVALID,
    );

    const mainTipAfter = git(repo.remoteDir, ["--git-dir", repo.remoteDir, "rev-parse", "main"]).trim();
    expect(mainTipAfter).toBe(mainTipBefore);

    // And the local working ref is unchanged too — nothing to push at all.
    const localMain = git(repo.dir, ["rev-parse", "main"]).trim();
    expect(localMain).toBe(mainTipBefore);
  });
});

describe("F1 — a coordination ref that is itself a symbolic ref", () => {
  test("validation rejects a pre-planted symref, and main is never moved", async () => {
    // ADR 0001 notes "HEAD works identically, since update-ref dereferences
    // it" but defends only lexically — a coordination ref whose *name*
    // passes both mandated checks can still be a symref pointing at
    // refs/heads/main. Verified reproduction (before this fix): with the
    // ref planted this way, readRef returned main's tip and commitTreeToRef
    // applied a commit that moved main, with the name-level guard fully in
    // force throughout.
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const mainTipBefore = git(repo.dir, ["rev-parse", "main"]).trim();

    git(repo.dir, ["symbolic-ref", COORD_REF, "refs/heads/main"]);

    await expectCode(adapter.readRef(COORD_REF), GitErrorCodes.GIT_REF_INVALID);
    await expectCode(
      adapter.commitTreeToRef(COORD_REF, {
        parent: null,
        message: "attempted hijack via symref",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      }),
      GitErrorCodes.GIT_REF_INVALID,
    );

    expect(git(repo.dir, ["rev-parse", "main"]).trim()).toBe(mainTipBefore);
  });

  test("--no-deref backstop: a stale compare against a symref-swapped ref is rejected, and main is never moved", async () => {
    // The validation test above proves the *easy* half; it never exercises
    // `--no-deref` at all, since validation throws before `update-ref` is
    // ever invoked. `ensureValidRef` unconditionally rejects a ref that is
    // *currently* a symref, so the only way production code can ever reach
    // `updateRefCASCore` with a symref `ref` is the TOCTOU gap between that
    // check and this write — a gap that cannot be constructed through the
    // public `GitAdapter` without racing two real processes. This test
    // drives `updateRefCASCore` directly (the module-internal export, not
    // re-exported from `index.ts`) to exercise exactly the code path that
    // gap would reach, without needing to win a race to prove it: the
    // backstop's soundness does not depend on timing, only on `--no-deref`
    // behaving as asserted below whenever this function is called against a
    // ref that happens to be a symref.
    const repo = await tempRepo();
    const mainTipAtSymrefTime = git(repo.dir, ["rev-parse", "main"]).trim();

    // Plant the ref as a symref to main, then advance main further — so a
    // sha captured *before* the symref swap (as `readRef`'s dereferencing
    // `rev-parse --verify` would have captured it) is now stale relative to
    // what the symref currently resolves to.
    git(repo.dir, ["symbolic-ref", COORD_REF, "refs/heads/main"]);
    git(repo.dir, ["commit", "--allow-empty", "-m", "main advances after the symref swap"]);
    const mainTipAfterAdvance = git(repo.dir, ["rev-parse", "main"]).trim();
    expect(mainTipAfterAdvance).not.toBe(mainTipAtSymrefTime);

    const newSha = git(
      repo.dir,
      ["commit-tree", "-p", mainTipAtSymrefTime, "-m", "hijack attempt", git(repo.dir, ["write-tree"]).trim()],
    ).trim() as ObjectSha;

    // The shipped function itself, not a hand-copied argv: this is what
    // makes `--no-deref` a regression-guarded property of `adapter.ts`
    // rather than a fact about git's own behavior in isolation.
    const result = await updateRefCASCore(repo.dir, COORD_REF, newSha, mainTipAtSymrefTime as RefSha);

    // Observed for this task: with a *stale* compare value (main has since
    // advanced), the write is rejected — `--no-deref` still compares against
    // the symref's current dereferenced target, so the CAS mechanism itself
    // keeps working across the swap. main is untouched either way; the test
    // below this one exercises the other half — a *matching* compare value
    // succeeds by converting the coordination ref back into a direct ref,
    // never by advancing whatever the symref pointed to.
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.stderr).toContain("cannot lock ref");
    }

    expect(git(repo.dir, ["rev-parse", "main"]).trim()).toBe(mainTipAfterAdvance);
  });

  test("--no-deref backstop: a matching compare converts the symref to a direct ref, without advancing main", async () => {
    // The prose aside in the test above ("a matching compare value would
    // instead succeed by converting the coordination ref back into a direct
    // ref") is the other half of the same mechanism and is just as
    // deterministic to set up — no race needed, since a matching compare
    // means the write happens on the first attempt. Same rationale as above
    // for calling `updateRefCASCore` directly rather than a hand-copied argv.
    const repo = await tempRepo();
    const mainTipAtSymrefTime = git(repo.dir, ["rev-parse", "main"]).trim();

    git(repo.dir, ["symbolic-ref", COORD_REF, "refs/heads/main"]);
    // main is deliberately NOT advanced here — the compare below is against
    // the symref's current (unchanged) dereferenced target, so it matches.

    const newSha = git(
      repo.dir,
      ["commit-tree", "-p", mainTipAtSymrefTime, "-m", "converts the symref", git(repo.dir, ["write-tree"]).trim()],
    ).trim() as ObjectSha;

    const result = await updateRefCASCore(repo.dir, COORD_REF, newSha, mainTipAtSymrefTime as RefSha);

    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.sha).toBe(newSha as unknown as RefSha);
    }

    // COORD_REF is no longer a symref — `--no-deref` wrote directly to its
    // own path, converting it to a normal ref pointing at newSha. Checked
    // with `LC_ALL=C` pinned, matching every other stderr-shaped assertion
    // in this module (git()'s own helper calls do not assert on stderr
    // text, so they were never subject to this).
    const symrefCheck = Bun.spawnSync(["git", "symbolic-ref", "-q", "--end-of-options", COORD_REF], {
      cwd: repo.dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    });
    expect(symrefCheck.exitCode).not.toBe(0);
    expect(git(repo.dir, ["rev-parse", "--verify", "--end-of-options", COORD_REF]).trim()).toBe(newSha);

    // main itself was never advanced — the write landed on COORD_REF's own
    // path, never dereferenced through to main.
    expect(git(repo.dir, ["rev-parse", "main"]).trim()).toBe(mainTipAtSymrefTime);
  });
});

describe("readBlobFromRef — the three-way ls-tree check", () => {
  async function setup() {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const applied = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "seed",
      files: [
        { path: "ev/2026-09.jsonl", content: '{"a":1}\n' },
        { path: "ev/sub/x.jsonl", content: '{"b":2}\n' },
        { path: "ev2/café.jsonl", content: "unicode content\n" },
      ],
    });
    if (applied.outcome !== "applied") throw new Error("setup failed");
    return { repo, adapter };
  }

  test("empty output: no entry at that path returns null", async () => {
    const { adapter } = await setup();
    const result = await adapter.readBlobFromRef(COORD_REF, "ev/does-not-exist.jsonl");
    expect(result).toBeNull();
  });

  test("exactly one 100644 entry with a byte-identical path: returns content", async () => {
    const { adapter } = await setup();
    const result = await adapter.readBlobFromRef(COORD_REF, "ev/2026-09.jsonl");
    expect(result).toBe('{"a":1}\n');
  });

  test("a non-ASCII path resolves correctly, proving -z makes the comparison mean what it says", async () => {
    const { adapter } = await setup();
    const result = await adapter.readBlobFromRef(COORD_REF, "ev2/café.jsonl");
    expect(result).toBe("unicode content\n");
  });

  test("hard error: the path resolves to a tree, not a blob", async () => {
    const { adapter } = await setup();
    // No trailing slash: `ls-tree -- ev` returns exactly one entry whose
    // path equals "ev", but whose mode is 040000 (a tree), not 100644.
    await expectCode(adapter.readBlobFromRef(COORD_REF, "ev"), GitErrorCodes.GIT_BLOB_AMBIGUOUS);
  });

  test("hard error: a trailing-slash path resolves to a multi-entry listing", async () => {
    const { adapter } = await setup();
    await expectCode(adapter.readBlobFromRef(COORD_REF, "ev/"), GitErrorCodes.GIT_BLOB_AMBIGUOUS);
  });

  test("hard error: a `..`-normalizing path resolves to a different path than requested", async () => {
    const { adapter } = await setup();
    await expectCode(
      adapter.readBlobFromRef(COORD_REF, "ev/sub/../2026-09.jsonl"),
      GitErrorCodes.GIT_BLOB_AMBIGUOUS,
    );
  });

  test("hard error: the ref itself does not exist", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(adapter.readBlobFromRef(COORD_REF, "ev/2026-09.jsonl"), GitErrorCodes.GIT_REF_NOT_FOUND);
  });
});

describe("--full-tree: reads from a subdirectory resolve the same blob as from the root", () => {
  test("matches the root-opened adapter's result", async () => {
    const repo = await tempRepo();
    const rootAdapter = await createGitAdapter(repo.dir);
    const applied = await rootAdapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "seed",
      files: [{ path: "ev/2026-09.jsonl", content: '{"a":1}\n' }],
    });
    expect(applied.outcome).toBe("applied");

    const subdir = join(repo.dir, "ev", "nested");
    await mkdir(subdir, { recursive: true });
    const subdirAdapter = await createGitAdapter(subdir);
    expect(subdirAdapter.root).toBe(rootAdapter.root);

    const fromRoot = await rootAdapter.readBlobFromRef(COORD_REF, "ev/2026-09.jsonl");
    const fromSubdir = await subdirAdapter.readBlobFromRef(COORD_REF, "ev/2026-09.jsonl");
    expect(fromSubdir).toBe(fromRoot);
    expect(fromSubdir).toBe('{"a":1}\n');
  });
});

describe("every operation exercised from a secondary worktree", () => {
  test("readRef, commitTreeToRef, updateRefCAS, readBlobFromRef, listWorktrees, gitCommonDir, fetch, fetchReconciliation, and push all work identically", async () => {
    const repo = await tempRepo({ worktrees: 1, bareRemote: true });
    const worktreeDir = repo.worktreeDirs[0];
    if (!worktreeDir) throw new Error("expected a worktree");
    const adapter = await createGitAdapter(worktreeDir);

    expect(await adapter.readRef(COORD_REF)).toBeNull();

    const applied = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "from a secondary worktree",
      files: [{ path: "events/2026-09.jsonl", content: '{"claim":true}\n' }],
    });
    expect(applied.outcome).toBe("applied");
    if (applied.outcome !== "applied") throw new Error("unreachable");

    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
    expect(await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl")).toBe('{"claim":true}\n');

    const worktrees = await adapter.listWorktrees();
    expect(worktrees.length).toBe(2);
    const paths = worktrees.map((w) => w.path).sort();
    expect(paths).toEqual([repo.dir, worktreeDir].sort());

    const commonDirFromWorktree = await adapter.gitCommonDir();
    const primaryAdapter = await createGitAdapter(repo.dir);
    const commonDirFromPrimary = await primaryAdapter.gitCommonDir();
    expect(commonDirFromWorktree).toBe(commonDirFromPrimary);

    // updateRefCAS called directly (not via commitTreeToRef), from the worktree.
    const nextSha = git(
      worktreeDir,
      ["commit-tree", "-p", applied.sha, "-m", "direct CAS from worktree", git(worktreeDir, ["write-tree"]).trim()],
    ).trim() as ObjectSha;
    const casResult = await adapter.updateRefCAS(COORD_REF, nextSha, applied.sha);
    expect(casResult.outcome).toBe("applied");

    // fetch / fetchReconciliation / push, all from the worktree.
    expect((await adapter.push("origin", COORD_REF)).outcome).toBe("ok");
    expect((await adapter.fetch("origin", COORD_REF)).outcome).toBe("ok");
    await adapter.fetchReconciliation("origin", COORD_REF, STAGING_REF);
    const staged: string | null = await adapter.readRef(STAGING_REF);
    expect(staged).toBe(nextSha as string);
  });
});

describe("gitCommonDir", () => {
  test("returns an absolute path, independent of the current directory it's resolved from", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const commonDir = await adapter.gitCommonDir();
    expect(commonDir.startsWith("/")).toBe(true);
    expect(commonDir).toBe(join(repo.dir, ".git"));
  });
});

describe("F5 — readRef distinguishes absent from present-but-unreadable", () => {
  test("hard error on a genuinely broken ref, never a silent null", async () => {
    // `git show-ref --exists`: exit 0 present, exit 2 absent, exit 1 lookup
    // failed. Before this fix, `rev-parse --verify --quiet` was
    // byte-identical (exit 1, empty stdout, empty stderr) for "absent" and
    // "present but unreadable" — this plants the second case directly (a
    // ref file whose content is not a valid sha) and asserts it is a typed
    // hard error, not the `null` a caller would otherwise read as "no
    // claims here."
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const gitDir = git(repo.dir, ["rev-parse", "--git-dir"]).trim();
    await mkdir(join(repo.dir, gitDir, "refs", "cankan"), { recursive: true });
    await Bun.write(join(repo.dir, gitDir, "refs", "cankan", "coordination"), "garbage-not-a-sha\n");

    await expectCode(adapter.readRef(COORD_REF), GitErrorCodes.GIT_COMMAND_FAILED);
  });

  test("a directory/file conflict on the ref's path reads as absent, and a write attempt still fails closed", async () => {
    // `show-ref --exists` reports this specific sub-case (a directory
    // sitting where the ref file would be) as exit 2, the same code as a
    // genuinely absent ref. `readRefCore`'s doc comment states the honest
    // reason plainly: `show-ref --exists` collapses the two cases by exit
    // code, this module adds no `lstat`-level check to tell them apart, and
    // what makes that acceptable is the fail-closed write below — a *write*
    // attempt against that same path still cannot silently succeed.
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const gitDir = git(repo.dir, ["rev-parse", "--git-dir"]).trim();
    const conflictDir = join(repo.dir, gitDir, "refs", "cankan", "coordination");
    await mkdir(join(conflictDir, "sub"), { recursive: true });
    await Bun.write(join(conflictDir, "sub", "leaf"), `${git(repo.dir, ["rev-parse", "HEAD"]).trim()}\n`);

    expect(await adapter.readRef(COORD_REF)).toBeNull();

    // Fails closed rather than silently double-claiming: the mandated
    // caller response to a null readRef (commitTreeToRef with parent: null)
    // still hard-errors, since git itself cannot create a loose ref file
    // where a directory already occupies that path.
    await expect(
      adapter.commitTreeToRef(COORD_REF, {
        parent: null,
        message: "would-be first claim",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      }),
    ).rejects.toThrow();
  });
});

describe("F4 — the transport no longer fails closed on ambient env vars simple-git used to inspect", () => {
  test("GIT_SSH_COMMAND and PREFIX in the ambient environment no longer break every git operation", async () => {
    // Fix-round-1 F4: `simple-git`'s unsafe-operations plugin inspected an
    // 18-key private table; the prior transport's strip list covered 7,
    // deliberately leaving load-bearing ones (this list) unstripped, which
    // meant a host that set any of them made *every* git operation in this
    // module fail before the command ran, regardless of relevance. Ruling
    // 11 removes the plugin (and therefore the strip list) entirely by
    // moving off `simple-git` — this test proves the previously-poisonous
    // variables are now inert.
    const previous = {
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      PREFIX: process.env.PREFIX,
    };
    process.env.GIT_SSH_COMMAND = "ssh -i /nonexistent/key";
    process.env.PREFIX = "/usr/local";
    try {
      const repo = await tempRepo();
      const adapter = await createGitAdapter(repo.dir);
      const result = await adapter.commitTreeToRef(COORD_REF, {
        parent: null,
        message: "seed with hostile-looking env vars present",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      });
      expect(result.outcome).toBe("applied");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("GIT_CONFIG_COUNT/KEY_0/VALUE_0 are merged into the child's env, not stripped, and are genuinely honored by git", async () => {
    // A stronger form of the test above: GIT_CONFIG_COUNT=0 (the old test's
    // value) is trivially inert to git regardless of whether it reaches the
    // child process, so it could not by itself prove the var was actually
    // merged rather than coincidentally harmless. This sets a config
    // override that a real host might use (CI identity injection) and
    // asserts it is *honored* — proof the merge in `runGitRaw`'s `env: {
    // ...process.env, LC_ALL: "C", ...options.env }` (R7) actually reaches
    // the child, since this module does no per-key allowlisting any more.
    const previous = {
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "CI Bot";
    try {
      const repo = await tempRepo();
      const adapter = await createGitAdapter(repo.dir);
      const result = await adapter.commitTreeToRef(COORD_REF, {
        parent: null,
        message: "seed with a config override injected via the environment",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      });
      expect(result.outcome).toBe("applied");
      if (result.outcome !== "applied") throw new Error("unreachable");
      const authorName = git(repo.dir, ["log", "-1", "--format=%an", result.sha]).trim();
      expect(authorName).toBe("CI Bot");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("ref absent after clone (failure mode 6)", () => {
  test("a fresh clone brings no refs/cankan/*, and a default fetch never creates one", async () => {
    const repo = await tempRepo({ bareRemote: true });
    if (!repo.remoteDir) throw new Error("expected a bare remote");
    const originAdapter = await createGitAdapter(repo.dir);
    const applied = await originAdapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "seed",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });
    expect(applied.outcome).toBe("applied");
    expect((await originAdapter.push("origin", COORD_REF)).outcome).toBe("ok");

    const cloneDir = await mkdtemp(join(tmpdir(), "cankan-clone-"));
    try {
      git(cloneDir, ["clone", repo.remoteDir, "clone"]);
      const cloneRepoDir = join(cloneDir, "clone");
      const cloneAdapter = await createGitAdapter(cloneRepoDir);

      expect(await cloneAdapter.readRef(COORD_REF)).toBeNull();

      // A default fetch/pull never creates or advances the coordination ref.
      git(cloneRepoDir, ["fetch", "origin"]);
      git(cloneRepoDir, ["pull", "origin", "main"]);
      expect(await cloneAdapter.readRef(COORD_REF)).toBeNull();
    } finally {
      await rm(cloneDir, { recursive: true, force: true });
    }
  });
});

describe("diverged reconciliation (failure mode 3/4, R9)", () => {
  test("a plain working-ref fetch is rejected while the staging-ref fetch succeeds; a push surfaces non-fast-forward as a typed outcome", async () => {
    const repo = await tempRepo({ bareRemote: true });
    if (!repo.remoteDir) throw new Error("expected a bare remote");
    const originAdapter = await createGitAdapter(repo.dir);

    const seeded = await originAdapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "seed",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });
    if (seeded.outcome !== "applied") throw new Error("setup failed");
    expect((await originAdapter.push("origin", COORD_REF)).outcome).toBe("ok");

    // R9: a second *clone*, never a second worktree — worktrees of one clone
    // share a single ref store and cannot diverge from each other.
    const otherRoot = await mkdtemp(join(tmpdir(), "cankan-clone2-"));
    let otherAdapter: GitAdapter;
    let otherDir: string;
    try {
      git(otherRoot, ["clone", repo.remoteDir, "other"]);
      otherDir = join(otherRoot, "other");
      // A fresh clone has no local identity configured; unlike `dir` (which
      // `makeTempRepo` configures), this environment's global identity (if
      // any) cannot be relied on — CI runners typically have none, and
      // `commit-tree` fails with "Author identity unknown" without it.
      git(otherDir, ["config", "user.name", "CanKan Test"]);
      git(otherDir, ["config", "user.email", "test@cankan.invalid"]);
      otherAdapter = await createGitAdapter(otherDir);
      expect((await otherAdapter.fetch("origin", COORD_REF)).outcome).toBe("ok");
      const baseline = (await otherAdapter.readRef(COORD_REF)) as RefSha;
      expect(baseline).toBe(seeded.sha);

      // Local (origin) advances and pushes.
      const localNext = await originAdapter.commitTreeToRef(COORD_REF, {
        parent: seeded.sha,
        message: "local advances",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n{}\n" }],
      });
      if (localNext.outcome !== "applied") throw new Error("setup failed");
      expect((await originAdapter.push("origin", COORD_REF)).outcome).toBe("ok");

      // "Other" clone also advances, independently, from the stale baseline.
      const otherNext = await otherAdapter.commitTreeToRef(COORD_REF, {
        parent: baseline,
        message: "other advances too",
        files: [{ path: "events/2026-10.jsonl", content: "{}\n" }],
      });
      if (otherNext.outcome !== "applied") throw new Error("setup failed");

      // Both sides have now advanced past the common base: the plain
      // working-ref fetch is rejected...
      expect((await otherAdapter.fetch("origin", COORD_REF)).outcome).toBe("rejected");

      // ...while the reconciliation fetch into a distinct staging ref
      // succeeds and reflects the remote's current tip.
      await otherAdapter.fetchReconciliation("origin", COORD_REF, STAGING_REF);
      expect(await otherAdapter.readRef(STAGING_REF)).toBe(localNext.sha);

      // And a push in this state surfaces the non-fast-forward rejection as
      // a typed outcome, not a generic thrown error.
      expect((await otherAdapter.push("origin", COORD_REF)).outcome).toBe("rejected");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("bootstrap hard error", () => {
  test("a non-repository directory produces a typed error, never a silent cwd fallback", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "cankan-non-repo-"));
    try {
      await expectCode(createGitAdapter(nonRepo), GitErrorCodes.GIT_BOOTSTRAP_FAILED);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });

  test("a bare repository (no working tree) produces a typed error", async () => {
    const repo = await tempRepo({ bareRemote: true });
    if (!repo.remoteDir) throw new Error("expected a bare remote");
    await expectCode(createGitAdapter(repo.remoteDir), GitErrorCodes.GIT_BOOTSTRAP_FAILED);
  });
});

describe("withCasRetry — contention exceeded", () => {
  test("surfaces a typed error at the cap, using the injectable maxAttempts and sleep", async () => {
    let calls = 0;
    const start = performance.now();

    await expectCode(
      withCasRetry<never>(
        async () => {
          calls += 1;
          return { done: false };
        },
        { maxAttempts: 5, sleep: async () => {} },
      ),
      GitErrorCodes.GIT_CAS_CONTENTION_EXCEEDED,
    );

    expect(calls).toBe(5);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("returns the callback's value once it reports done", async () => {
    let calls = 0;
    const result = await withCasRetry<string>(
      async () => {
        calls += 1;
        return calls < 3 ? { done: false } : { done: true, value: "settled" };
      },
      { sleep: async () => {} },
    );
    expect(result).toBe("settled");
    expect(calls).toBe(3);
  });
});

describe("credential leak (M2.1 security finding)", () => {
  test("a failing push against a token-bearing URL never leaks the token into message, details, JSON.stringify, or util.inspect", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const seeded = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "seed",
      files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
    });
    expect(seeded.outcome).toBe("applied");

    const token = "REDACT_ME";
    const hostileRemote = `https://u:${token}@invalid.invalid/x.git`;

    let thrown: unknown;
    try {
      await adapter.push(hostileRemote, COORD_REF);
      throw new Error("expected the push to fail");
    } catch (error) {
      thrown = error;
    }

    if (!isCanKanError(thrown)) throw new Error("expected a CanKanError");
    expect(thrown.code).toBe(GitErrorCodes.GIT_COMMAND_FAILED);
    expect(thrown.message).not.toContain(token);
    expect(JSON.stringify(thrown.details ?? {})).not.toContain(token);
    expect(JSON.stringify(thrown)).not.toContain(token);
    // The cause is attached (not dropped), it's simply never serialized —
    // `CanKanError.toJSON()` excludes `cause` by construction.
    expect(thrown.cause).toBeDefined();

    // Fix-round-1 F3: the M2.1 mitigation held for `toJSON`/`JSON.stringify`
    // but not for anything that *prints* the error — `console.error(err)`
    // and Bun/Node's uncaught-rejection printer both render via
    // `util.inspect`, which rendered `simple-git`'s `GitError.task.commands`
    // (raw argv, including the credential-bearing remote URL) in full even
    // though `message` and `details` were clean. Closed by construction now
    // that this module's transport never produces an error object with an
    // own-enumerable argv property in the first place (see `transport.ts`'s
    // `runGit` doc comment) — asserted directly here, at every depth,
    // including through the `cause` chain.
    expect(util.inspect(thrown, { depth: null })).not.toContain(token);
    if (thrown.cause !== undefined) {
      expect(util.inspect(thrown.cause, { depth: null })).not.toContain(token);
    }
  });
});

describe("temp-index hygiene", () => {
  test("the mkdtemp directory backing GIT_INDEX_FILE is removed after success", async () => {
    const repo = await tempRepo();
    const tmpRoot = await mkdtemp(join(tmpdir(), "cankan-tmproot-"));
    try {
      const adapter = await createGitAdapter(repo.dir, { tmpRoot });
      const result = await adapter.commitTreeToRef(COORD_REF, {
        parent: null,
        message: "seed",
        files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
      });
      expect(result.outcome).toBe("applied");
      expect(await readdir(tmpRoot)).toEqual([]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("the mkdtemp directory is removed even when the build fails", async () => {
    const repo = await tempRepo();
    const tmpRoot = await mkdtemp(join(tmpdir(), "cankan-tmproot-"));
    try {
      const adapter = await createGitAdapter(repo.dir, { tmpRoot });
      const bogusParent = "f".repeat(40) as RefSha; // does not exist in the repo

      await expect(
        adapter.commitTreeToRef(COORD_REF, {
          parent: bogusParent,
          message: "will fail",
          files: [{ path: "events/2026-09.jsonl", content: "{}\n" }],
        }),
      ).rejects.toThrow();

      expect(await readdir(tmpRoot)).toEqual([]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("withEnv discipline", () => {
  test("recorded rather than omitted: no test in this file needs withEnv", async () => {
    // This test does not prove the adapter is safe around $HOME/XDG paths in
    // some special way — it merely runs one ordinary operation inside
    // withEnv() without incident. The real reason no test here depends on
    // withEnv() is structural: M2.6 builds no lease-observation store (R4 —
    // that is M2.7's, under $XDG_STATE_HOME/cankan/), so this module never
    // reads or writes an XDG path or $HOME anywhere, and there is nothing
    // for withEnv() to guard against. Recorded so the absence reads as a
    // deliberate scope boundary rather than an oversight.
    await withEnv(undefined, async () => {
      const repo = await tempRepo();
      const adapter = await createGitAdapter(repo.dir);
      expect(await adapter.readRef(COORD_REF)).toBeNull();
    });
  });
});
