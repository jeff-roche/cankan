import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // `check-ref-format` fails with a bare non-zero exit and empty stderr,
    // and simple-git's error detection requires both exit code *and* stderr
    // to be non-empty to treat a task as failed. Routing this call through
    // the shared simple-git chokepoint (rather than the direct spawn in
    // `refValidation.ts`) makes this exact test fail — see that file's doc
    // comment. If this test ever goes green for the wrong reason, it will
    // be because someone "simplified" that call site back onto simple-git.
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
  test("readRef, commitTreeToRef, readBlobFromRef, listWorktrees, gitCommonDir all work identically", async () => {
    const repo = await tempRepo({ worktrees: 1 });
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
  test("a failing push against a token-bearing URL never leaks the token into message, details, or JSON.stringify", async () => {
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
