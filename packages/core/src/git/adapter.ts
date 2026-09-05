/**
 * The git adapter: the only module in this codebase permitted to shell out
 * to git (PLAN.md M2.6), and the enforcing security backstop for the whole
 * coordination-ref mechanism (ADR 0001,
 * `docs/decisions/0001-coordination-ref.md:336-693`, "M2.6 (`git/adapter.ts`)
 * must implement").
 *
 * See `types.ts` for the public shapes and `refValidation.ts` for the
 * name-level ref check (`validateCoordinationRef`) that `ensureValidRef`
 * below layers a repository-aware symref check on top of.
 *
 * Every invocation here goes through `transport.ts`'s `runGitRaw`/`runGit`
 * chokepoint (fix-round-1 Ruling 11 — the transport is `Bun.spawn`, not
 * `simple-git`; see `transport.ts`'s doc comment for the five measured
 * reasons). There are no direct-spawn exceptions left in this module:
 * `hash-object -w --stdin` and `check-ref-format` (`refValidation.ts`) are
 * both ordinary calls through the same chokepoint now that it exposes exit
 * codes directly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanKanError } from "../errors";
import { GitErrorCodes } from "./errors";
import { validateCoordinationRef } from "./refValidation";
import { runGit, runGitRaw } from "./transport";
import type {
  CasOutcome,
  CommitTreeParams,
  GitAdapter,
  GitAdapterOptions,
  ObjectSha,
  RefSha,
  Sha,
  SyncOutcome,
  WorktreeInfo,
} from "./types";

const ZERO_SHA = "0".repeat(40);

/** `^[0-9a-f]{40}$` — see `Sha`'s doc comment in `types.ts` (fix-round-1 F2). */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Runtime backstop for the `RefSha`/`ObjectSha` brands (fix-round-1 F2): a
 * brand is compile-time only, and `git update-ref` accepts any revision
 * expression, not only an object id. Verified directly: without this check,
 * `updateRefCAS(ref, "refs/heads/main", old)` applies and returns `{sha:
 * "refs/heads/main"}`; feeding a non-sha value like `"HEAD"` back as a later
 * `oldSha` makes the compare late-bound against whatever `HEAD` currently
 * resolves to rather than a fixed point-in-time value, and a reproduced
 * sequence (apply with `newSha: "HEAD"`, let another writer advance the ref,
 * then pass `"HEAD"` back as `oldSha`) silently accepted the stale write and
 * lost the other writer's commit — PLAN.md's "Done when" and ADR 0001's "the
 * trailing old-value argument *is* the entire CAS mechanism" both defeated
 * at once. Called on `newSha`, `oldSha` (when non-null), and `parent` (when
 * non-null) before any of them reach argv.
 */
function assertShaShape(value: string, paramName: string): void {
  if (!SHA_PATTERN.test(value)) {
    throw new CanKanError(GitErrorCodes.GIT_SHA_INVALID, `${paramName} is not a 40-hex object id: "${value}"`, {
      details: { paramName, value },
    });
  }
}

/**
 * Both mandated name-level ref checks (`validateCoordinationRef`) plus this
 * module's own additional guard: reject a ref that is *currently* a
 * symbolic ref, before any operation that could act on it (fix-round-1 F1).
 *
 * ADR 0001 notes "`HEAD` works identically, since `update-ref` dereferences
 * it" but defends only lexically, at the name level. A coordination ref
 * that is *itself* a symref to (say) `refs/heads/main` has a name that
 * passes both mandated checks — `refs/cankan/coordination` matches the
 * regex and `check-ref-format` — yet `update-ref`/`rev-parse --verify` both
 * dereference it by default, reintroducing the exact abuse those checks
 * exist to prevent. Verified directly: with the ref planted as a symref,
 * `readRef` returned `main`'s tip and `commitTreeToRef` applied a commit
 * that moved `main`, with the name-level guard fully in force throughout.
 *
 * `git symbolic-ref -q --end-of-options <ref>`: exit 0 with a target on
 * stdout means `ref` is a symref (reject); a non-zero exit with empty
 * output means it is not (proceed) — confirmed directly, including that the
 * marker must sit after `-q`, immediately before the single positional it
 * protects (placing it before `-q` makes `-q` itself the ref pattern
 * instead of a flag).
 */
async function ensureValidRef(root: string, ref: string): Promise<string> {
  const validated = await validateCoordinationRef(ref);
  const symref = await runGitRaw(root, ["symbolic-ref", "-q", "--end-of-options", validated]);
  if (symref.exitCode === 0) {
    throw new CanKanError(GitErrorCodes.GIT_REF_INVALID, `ref is a symbolic ref: ${validated}`, {
      details: { ref: validated, target: symref.stdout.trim() },
    });
  }
  return validated;
}

/**
 * The CAS-rejection signature. ADR 0001:471-473 states one form: `cannot
 * lock ref '...': is at X but expected Y`. Direct verification for this task
 * (git 2.55.0, 15 repeated two-process races) found one further branch of
 * `update_ref`'s compare check that is the same kind of thing — the ref's
 * actual state disagreeing with the caller's compare value — and not "some
 * other git failure": `cannot lock ref '...': reference already exists`, the
 * loser of a race to *create* a ref, i.e. both racers pass `oldSha: null`
 * (compared against the 40-zero sha) against a ref that does not exist yet.
 * This is not a corner case: it is exactly PLAN.md's "two processes calling
 * updateRefCAS with the same expected old value" floor test, run against a
 * board's very first claim.
 *
 * This is a gap in the ADR's stated signature, reported in the task report
 * rather than silently worked around: both forms are treated as CAS
 * rejections (a typed `outcome`, for the caller/retry-driver to react to),
 * and anything else matching `cannot lock ref` differently, or not matching
 * at all, is a hard failure.
 *
 * **Deliberately excluded: `cannot lock ref '...': unable to resolve
 * reference '...'`.** This is the message when a non-null `oldSha` was
 * given but the ref cannot be resolved — and probing that condition
 * directly for this task found it is not specific to "the ref was deleted
 * out from under a legitimate compare" (an operation this design doesn't
 * perform anywhere): the *identical* message, sometimes with a `: reference
 * broken` suffix and sometimes without, is also what a genuinely corrupted
 * ref file or a D/F conflict on the ref's path produces. Matching this form
 * as a retryable rejection would reintroduce exactly the failure the ADR
 * condemns for `claimViaCAS` (0001:469-475: "a corrupted ref or a
 * permissions failure would silently loop up to 50 times") — a retry driver
 * fed this outcome would spend its whole attempt budget against a ref that
 * will never resolve. It is left to fall through to the hard-failure branch.
 */
const CAS_REJECTION_PATTERN =
  /cannot lock ref '[^']*': (is at [0-9a-f]+ but expected [0-9a-f]+|reference already exists)/;

/**
 * Confirmed stderr for a push rejected as non-fast-forward (ADR 0001:647-649
 * gives `(fetch first)`). Direct verification for this task found a second,
 * equally common wording: `(non-fast-forward)` — observed when the pusher's
 * own remote-tracking ref is stale relative to the actual remote (rather
 * than the pusher having just fetched and *still* being behind, which is
 * what produces `fetch first`). Both are git's push machinery reporting the
 * same thing this module cares about — "this was not a fast-forward, and
 * nothing was pushed" — so both are treated as the same typed outcome.
 * Reported as a gap in the ADR's stated wording, per the task brief, rather
 * than matched narrowly and left to surface as a hard error the one time a
 * caller hits the other form.
 */
const PUSH_REJECTED_PATTERN = /! \[rejected\][^\n]*\((fetch first|non-fast-forward)\)/;

/** Confirmed stderr for a fetch of the working ref rejected once diverged (ADR 0001:655-662). */
const FETCH_REJECTED_PATTERN = /! \[rejected\][^\n]*\(non-fast-forward\)/;

/**
 * `git hash-object -w --stdin`. Not a direct-spawn exception any more
 * (fix-round-1 Ruling 11) — `runGit`'s `stdin` option gives this an ordinary
 * path through the one chokepoint. ADR 0001:411-413 exempts this command
 * from the `--end-of-options` rule on its own terms: its content arrives on
 * stdin, and the command takes no ref, path, or commit argument at all, so
 * there is no positional for the marker to protect.
 */
async function hashObjectStdin(root: string, content: string): Promise<ObjectSha> {
  const out = await runGit(root, ["hash-object", "-w", "--stdin"], { stdin: content });
  return out.trim() as ObjectSha;
}

/**
 * Builds a tree entirely off the real index: a private `GIT_INDEX_FILE`
 * under a fresh `mkdtemp()` directory per call, so concurrent callers never
 * collide on one index file (ADR 0001:476-485). Starts from `parent`'s tree
 * (so every other path in it is preserved) or an empty tree for the
 * no-parent case, applies each file via `hash-object` + `update-index
 * --add --cacheinfo`, and returns the resulting tree's sha.
 *
 * The index directory is removed in a `finally`, including on the failure
 * path — an `mkdtemp()` directory left behind on error is a leaked temp dir
 * (phase constraint 12).
 */
async function buildTree(
  root: string,
  tmpRoot: string,
  parent: RefSha | null,
  files: CommitTreeParams["files"],
): Promise<ObjectSha> {
  const indexDir = await mkdtemp(join(tmpRoot, "cankan-git-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(indexDir, "index") };

    if (parent === null) {
      await runGit(root, ["read-tree", "--empty"], { env });
    } else {
      // `parent` is a `RefSha` this module itself obtained from `readRef`
      // (or the caller's own prior read of it), shape-checked by
      // `commitTreeToRef` before this function is ever called — a 40-hex
      // sha, never a config- or log-derived string, so it cannot begin with
      // `-`. The marker is still included ahead of it as the mechanical,
      // costs-nothing hygiene the ADR calls for (0001:391-417) — confirmed
      // accepted by git 2.55.0's `read-tree`.
      await runGit(root, ["read-tree", "--end-of-options", parent], { env });
    }

    for (const file of files) {
      const blob = await hashObjectStdin(root, file.content);
      // `--cacheinfo <mode>,<object>,<path>` takes the whole triple as one
      // option argument (Gap noted in the task brief: the ADR gives no
      // template for this command). `--end-of-options` protects nothing
      // here — there is no separate positional in this invocation for it to
      // guard — but confirmed harmless (exit 0) on git 2.55.0, so it is kept
      // for uniformity with every other command in this module. The write
      // side's actual path-safety guard is git's own `verify_path`: directly
      // confirmed for this task that `--cacheinfo 100644,<sha>,../outside`
      // is rejected with `error: Invalid path`, and that a leading-dash path
      // component (`-weird.txt`) is accepted unharmed, since it is never
      // parsed as a flag — it is one comma-joined argument to `--cacheinfo`,
      // never a bare positional (ADR 0001:602-605).
      await runGit(
        root,
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`, "--end-of-options"],
        { env },
      );
    }

    // `write-tree` takes no ref/path/commit argument either; `--end-of-options`
    // is kept for the same uniformity reason and confirmed harmless.
    const tree = await runGit(root, ["write-tree", "--end-of-options"], { env });
    return tree.trim() as ObjectSha;
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/**
 * `git commit-tree`. **Argument order is load-bearing, not stylistic** (ADR
 * 0001:418-431): `--end-of-options` cannot protect an option's own argument,
 * so putting it before the tree would push the following `-p` into
 * positional position instead (confirmed: `git commit-tree --end-of-options
 * <tree> -p <old> -m <msg>` fails with `fatal: must give exactly one tree`
 * on git 2.55.0). The working form puts every option first and the marker
 * immediately before the single positional it protects: `-p <old> -m <msg>
 * --end-of-options <tree>`. `<old>` is deliberately left uncovered by the
 * marker — like `parent` in `buildTree`, it is a `RefSha` this module
 * obtained itself (and, since fix-round-1 F2, shape-checked by
 * `commitTreeToRef` before this function is called), never a config- or
 * log-derived string.
 */
async function commitTreeCommand(
  root: string,
  tree: ObjectSha,
  parent: RefSha | null,
  message: string,
): Promise<ObjectSha> {
  const argv =
    parent === null
      ? ["commit-tree", "-m", message, "--end-of-options", tree]
      : ["commit-tree", "-p", parent, "-m", message, "--end-of-options", tree];
  const out = await runGit(root, argv);
  return out.trim() as ObjectSha;
}

/**
 * `readRef`, assuming `ref` has already been validated.
 *
 * **Fix-round-1 F5 — "absent" and "present but unreadable/broken" are
 * discriminated by exit code, not conflated.** The prior implementation
 * used `rev-parse --verify --quiet`, which is byte-identical (exit 1, empty
 * stdout, empty stderr) for both a genuinely absent ref and a ref that
 * exists but cannot be read (a corrupted ref file, a directory/file
 * conflict on its path) — the same class of defect this task's
 * `check-ref-format` finding was, on the only other command in this module
 * that could exit non-zero with empty stderr. Verified this did not reach
 * the ADR's condemned outcome in practice (the mandated caller response,
 * `commitTreeToRef` with `parent: null`, still hard-errors on a broken ref
 * rather than silently double-claiming), but the recorded reasoning for the
 * old `--quiet` deviation was itself backwards: exit-128-for-both is
 * fail-**closed** (both throw), and `--quiet` is what turned both into a
 * silent `""` → `null`, i.e. fail-**open** — the opposite of what the old
 * comment claimed. Corrected here rather than left for another lane to copy.
 *
 * `git show-ref --exists --end-of-options <ref>` distinguishes cleanly,
 * confirmed directly: exit 0 present, exit 2 absent, exit 1 lookup failed
 * (both a corrupted-ref-file case and a directory/file conflict on the
 * ref's path were probed; the corrupted-file case produces exit 1, the D/F
 * conflict produces exit 2, indistinguishable from genuine absence by exit
 * code alone). This module does not add an `lstat`-level check to tell a
 * D/F conflict apart from real absence — the honest reason exit 2 is treated
 * as "absent" here is that `--exists` collapses the two, not that they are
 * conceptually the same outcome. What makes this acceptable is what happens
 * next, not this function: a caller that got `null` back and proceeds to
 * write (`commitTreeToRef` with `parent: null`) still hard-fails against
 * that same path rather than silently succeeding, because the write goes
 * through `update-ref`/`hash-object`, not through this read. `--exists`
 * requires git ≥ 2.43; confirmed present on both `ubuntu-latest` and
 * `macos-latest` GitHub-hosted runner images (2.55.0, matching local) at
 * the time of this fix.
 */
async function readRefCore(root: string, validatedRef: string): Promise<RefSha | null> {
  const existsResult = await runGitRaw(root, ["show-ref", "--exists", "--end-of-options", validatedRef]);
  if (existsResult.exitCode === 2) {
    return null;
  }
  if (existsResult.exitCode !== 0) {
    throw new CanKanError(
      GitErrorCodes.GIT_COMMAND_FAILED,
      `git show-ref --exists failed for ref ${validatedRef}`,
      {
        cause: new Error(existsResult.stderr.trim() || `exit ${existsResult.exitCode}`),
        details: { ref: validatedRef },
      },
    );
  }

  const revResult = await runGitRaw(root, ["rev-parse", "--verify", "--end-of-options", validatedRef]);
  if (revResult.exitCode !== 0) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, `git rev-parse failed for ref ${validatedRef}`, {
      cause: new Error(revResult.stderr.trim() || `exit ${revResult.exitCode}`),
      details: { ref: validatedRef },
    });
  }
  return revResult.stdout.trim() as RefSha;
}

/**
 * `updateRefCAS`, assuming `ref` has already been validated.
 *
 * Exported (module-internal only — deliberately **not** re-exported from
 * `index.ts`, whose surface `test/index.test.ts` asserts exactly and which
 * M2.7 already consumes) so `git.test.ts` can drive this function directly
 * against a `ref` planted as a symref, bypassing `ensureValidRef`'s own
 * symref rejection the way the *real* TOCTOU gap would: `ensureValidRef`
 * unconditionally rejects a ref that is currently a symref, so the only
 * way production code can ever reach this function with a symref `ref` is
 * the gap between that check and this call — a gap no caller-facing test
 * can construct without either raising a race or calling this function
 * directly. Calling it directly is what makes `--no-deref`
 * (fix-round-1 F1) a regression-guarded property of the shipped code,
 * rather than a fact about git's behavior for a hand-copied argv that
 * nothing in this module actually runs.
 */
export async function updateRefCASCore(
  root: string,
  validatedRef: string,
  newSha: ObjectSha,
  oldSha: RefSha | null,
): Promise<CasOutcome> {
  // Fix-round-1 F2: the compile-time brand alone does not stop a caller from
  // passing a non-sha revision expression (`"HEAD"`, `"refs/heads/main"`) at
  // runtime — see `assertShaShape`'s doc comment for the reproduced lost
  // update this closes.
  assertShaShape(newSha, "newSha");
  if (oldSha !== null) {
    assertShaShape(oldSha, "oldSha");
  }
  const compare: Sha = oldSha ?? (ZERO_SHA as Sha);

  // ADR 0001:458-475: "the trailing old-value argument to `update-ref` *is*
  // the entire CAS mechanism; no separate locking is needed around it."
  // `--no-deref` (fix-round-1 F1) is the TOCTOU backstop alongside
  // `ensureValidRef`'s symref check: confirmed a no-op for a normal ref (the
  // overwhelming case) in every respect tested — creation, update, and the
  // contention race all behave identically with or without it — and
  // confirmed that if the ref *did* become a symref between validation and
  // this write, `--no-deref` makes the compare check still evaluate against
  // the symref's current dereferenced target (so a stale compare is still
  // correctly rejected) while any write that *does* pass compare lands on
  // the named ref path directly, converting it back to a normal ref, rather
  // than dereferencing through to advance whatever it pointed to. `main`
  // was not moved in either outcome, tested directly.
  const result = await runGitRaw(root, [
    "update-ref",
    "--no-deref",
    "--end-of-options",
    validatedRef,
    newSha,
    compare,
  ]);

  if (result.exitCode === 0) {
    // The one sanctioned RefSha/ObjectSha transition (see `CasOutcome`'s doc
    // comment in `types.ts`): `update-ref` just confirmed the ref now points
    // to `newSha`, so it is now, in fact, a value "a ref currently points
    // to" — `RefSha`'s exact meaning. This is not a loophole in the
    // inversion barrier: it happens once, here, after the write succeeded,
    // never at a call site as a way to manufacture a `RefSha` to hand back
    // in as `newSha` on some other call.
    return { outcome: "applied", sha: newSha as unknown as RefSha };
  }

  if (CAS_REJECTION_PATTERN.test(result.stderr)) {
    return { outcome: "rejected", stderr: result.stderr.trim() };
  }

  throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, `git update-ref failed for ref ${validatedRef}`, {
    cause: new Error(result.stderr.trim() || `exit ${result.exitCode}`),
    details: { ref: validatedRef },
  });
}

async function readBlobFromRef(root: string, ref: string, path: string): Promise<string | null> {
  const validatedRef = await ensureValidRef(root, ref);
  const commit = await readRefCore(root, validatedRef);
  if (commit === null) {
    // ADR failure mode 6: a caller must check `readRef` (and initialize or
    // fetch the ref) before any read — this function does not do that for
    // them, and does not conflate "ref absent" with "path absent," which
    // would repeat the exact fail-open shape failure mode 8(b) exists to
    // prevent, one level up.
    throw new CanKanError(GitErrorCodes.GIT_REF_NOT_FOUND, `ref not found: ${validatedRef}`, {
      details: { ref: validatedRef },
    });
  }

  let raw: string;
  try {
    // `--full-tree` is not optional (ADR 0001:517-541): `ls-tree`'s pathspec
    // is interpreted relative to the process's current directory, while
    // `cat-file -p <commit>:<path>` is always relative to the tree root.
    // Without it, a read from any subdirectory silently sees no entry and
    // grants a claim on a held ticket. `-z` is what makes the byte-identical
    // path comparison below mean what it says (ADR 0001:575-601) — without
    // it, `ls-tree` C-quotes non-ASCII path bytes.
    raw = await runGit(root, ["ls-tree", "--full-tree", "-z", "--end-of-options", commit, "--", path]);
  } catch (cause) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git ls-tree failed", {
      cause,
      details: { ref: validatedRef, path },
    });
  }

  if (raw.length === 0) {
    return null;
  }

  const records = raw.split("\0").filter((r) => r.length > 0);
  if (records.length !== 1) {
    // More than one entry: a trailing-slash pathspec (`ev/`) matches every
    // entry under it, confirmed to include a `100644` line even when the
    // requested path itself is a directory (ADR 0001:549-556).
    throw new CanKanError(
      GitErrorCodes.GIT_BLOB_AMBIGUOUS,
      `ls-tree returned ${records.length} entries for path "${path}", expected exactly one`,
      { details: { ref: validatedRef, path, entryCount: records.length } },
    );
  }

  const match = /^([0-7]{6}) (\S+) ([0-9a-f]+)\t(.*)$/.exec(records[0] ?? "");
  if (!match) {
    throw new CanKanError(GitErrorCodes.GIT_BLOB_AMBIGUOUS, "ls-tree output did not match the expected format", {
      details: { ref: validatedRef, path },
    });
  }
  const [, mode, , , entryPath] = match;

  // The mode-and-path-equality check together, not either alone (ADR
  // 0001:543-574): a `100644` first line does not say *which* object was
  // resolved — `git ls-tree --full-tree $C -- ev/sub/../x.jsonl` silently
  // normalizes the `..` out of the pathspec and reports a *different* path
  // than the one requested, confirmed directly.
  if (mode !== "100644" || entryPath !== path) {
    throw new CanKanError(
      GitErrorCodes.GIT_BLOB_AMBIGUOUS,
      `path "${path}" resolved to an unexpected entry (mode ${mode}, resolved path "${entryPath}")`,
      { details: { ref: validatedRef, path, mode, resolvedPath: entryPath ?? "" } },
    );
  }

  try {
    return await runGit(root, ["cat-file", "-p", "--end-of-options", `${commit}:${path}`]);
  } catch (cause) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git cat-file failed", {
      cause,
      details: { ref: validatedRef, path },
    });
  }
}

async function commitTreeToRef(
  root: string,
  tmpRoot: string,
  ref: string,
  params: CommitTreeParams,
): Promise<CasOutcome> {
  const validatedRef = await ensureValidRef(root, ref);
  // Fix-round-1 F2: `parent` reaches `read-tree`'s and `commit-tree -p`'s
  // argv directly (see `buildTree`/`commitTreeCommand`) — shape-checked
  // here, before either is called, not left to `updateRefCASCore`'s own
  // check alone, which runs only after the tree and commit have already
  // been built off it.
  if (params.parent !== null) {
    assertShaShape(params.parent, "parent");
  }
  // Fix-round-1 F1: `ensureValidRef` above is a point-in-time check on
  // `validatedRef` itself; it says nothing about `validatedRef`'s state by
  // the time this function's one write (`updateRefCASCore`, at the end)
  // runs. That gap is harmless here: every step in between — `read-tree
  // --end-of-options <parent>`, `commit-tree -p <parent>` — takes `parent`,
  // an already-shape-checked 40-hex object id, never `validatedRef` itself.
  // `validatedRef` is not resolved again until `updateRefCASCore`'s
  // `update-ref`, which carries `--no-deref` for exactly this reason. There
  // is no ref-resolving step in this function's build phase for a
  // symref-swap to land on.

  let commit: ObjectSha;
  try {
    const tree = await buildTree(root, tmpRoot, params.parent, params.files);
    commit = await commitTreeCommand(root, tree, params.parent, params.message);
  } catch (cause) {
    // Every hard failure this module surfaces is a `CanKanError`, never a
    // bare `Error` a caller would have to know to unwrap.
    if (cause instanceof CanKanError) {
      throw cause;
    }
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "failed to build commit off-tree", {
      cause,
      details: { ref: validatedRef },
    });
  }
  return updateRefCASCore(root, validatedRef, commit, params.parent);
}

/**
 * `path` is git's own output from `worktree list --porcelain`, unmodified.
 * Canonical (symlink-resolved) by git itself, not by this module: git
 * resolves a worktree's path into its `.git/worktrees/<name>/gitdir` file
 * once, at `worktree add` time — verified directly by adding a worktree
 * through a symlinked target path and confirming both the `gitdir` file and
 * every later `worktree list` report the resolved path, never the symlink
 * (see the task report's symlink probe; this is the one of the three
 * path-emitting surfaces the ADR's canonicalization recipe doesn't
 * obviously cover, since these paths come from a stored file rather than a
 * fresh cwd-based resolution — checked rather than assumed for that
 * reason). No `fs.realpath` call is added here; it would be redundant.
 */
function parseWorktreeBlock(block: string): WorktreeInfo {
  let path = "";
  let headSha: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let bare = false;
  let locked = false;

  for (const line of block.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      headSha = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length);
    } else if (line === "detached") {
      detached = true;
    } else if (line === "bare") {
      bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      locked = true;
    }
  }

  return { path, headSha, branch, detached, bare, locked };
}

async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  let raw: string;
  try {
    raw = await runGit(root, ["worktree", "list", "--porcelain"]);
  } catch (cause) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git worktree list failed", { cause });
  }
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(parseWorktreeBlock);
}

async function fetch(root: string, remote: string, ref: string): Promise<SyncOutcome> {
  const validatedRef = await ensureValidRef(root, ref);
  const refspec = `${validatedRef}:${validatedRef}`;
  // Required refspec, with no exception once the ref exists (ADR
  // 0001:630-646): applied directly to the local working ref. Never
  // relying on a persistent `remote.origin.fetch` entry — confirmed
  // untested by the ADR and, with a `+` prefix, actively dangerous given
  // the reconciliation requirement below.
  const result = await runGitRaw(root, ["fetch", "--end-of-options", remote, refspec]);
  if (result.exitCode === 0) {
    return { outcome: "ok" };
  }
  if (FETCH_REJECTED_PATTERN.test(result.stderr)) {
    // ADR 0001:655-662: a plain fetch of the working ref's own refspec is
    // itself rejected as non-fast-forward once local and remote have both
    // advanced — confirmed directly. The caller's move here is
    // `fetchReconciliation`, into a staging ref, not a retry of this call.
    return { outcome: "rejected" };
  }
  throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git fetch failed", {
    // Fix-round-1 F3: this `cause` is a plain `Error` built only from git's
    // own (already credential-redacted) stderr — never an object carrying
    // argv — so nothing here leaks through `util.inspect`,
    // `console.error`, or an uncaught-rejection printer.
    cause: new Error(result.stderr.trim() || `exit ${result.exitCode}`),
    details: { ref: validatedRef },
  });
}

async function fetchReconciliation(
  root: string,
  remote: string,
  ref: string,
  stagingRef: string,
): Promise<void> {
  const validatedRef = await ensureValidRef(root, ref);
  const validatedStaging = await ensureValidRef(root, stagingRef);
  const refspec = `${validatedRef}:${validatedStaging}`;
  // ADR 0001:655-662: fetch the remote ref into a distinct local ref name,
  // never the working ref directly.
  const result = await runGitRaw(root, ["fetch", "--end-of-options", remote, refspec]);
  if (result.exitCode !== 0) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git fetch (reconciliation) failed", {
      cause: new Error(result.stderr.trim() || `exit ${result.exitCode}`),
      details: { ref: validatedRef, stagingRef: validatedStaging },
    });
  }
}

async function push(root: string, remote: string, ref: string): Promise<SyncOutcome> {
  const validatedRef = await ensureValidRef(root, ref);
  const refspec = `${validatedRef}:${validatedRef}`;
  const result = await runGitRaw(root, ["push", "--end-of-options", remote, refspec]);
  if (result.exitCode === 0) {
    return { outcome: "ok" };
  }
  if (PUSH_REJECTED_PATTERN.test(result.stderr)) {
    // ADR 0001:647-654: on a non-fast-forward push rejection, the caller
    // must fetch (into a staging ref) and reconcile, then retry — never
    // force-push. This module returns the typed outcome; the
    // fetch-reconcile-retry orchestration is M2.7's (R3).
    return { outcome: "rejected" };
  }
  // M2.1's credential finding, closed by construction (fix-round-1 F3):
  // `cause` here is a plain `Error` carrying only git's own stderr text —
  // git redacts embedded userinfo from its own error messages itself
  // (confirmed: `fatal: unable to access 'https://host/x.git/': ...` never
  // includes credentials even when the argv that produced it did) — never
  // an object with an own-enumerable argv property for `util.inspect`,
  // `console.error`, or an uncaught-rejection printer to render. Never
  // copied into `message` or `details` either way.
  throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git push failed", {
    cause: new Error(result.stderr.trim() || `exit ${result.exitCode}`),
    details: { ref: validatedRef },
  });
}

/**
 * Canonical (symlink-resolved) by construction — see `GitAdapter.gitCommonDir`'s
 * doc comment in `types.ts` for the guarantee and how it was verified. No
 * `fs.realpath` call is added here: `rev-parse` already resolves symlinks
 * in the path it prints (confirmed both by macOS CI, whose failure was the
 * *fixture's* expected value being unresolved, never git's own output, and
 * by a Linux symlink probe reproducing the same condition — see the task
 * report), so adding one would be redundant, not more correct.
 */
async function gitCommonDir(root: string): Promise<string> {
  try {
    const out = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return out.trim();
  } catch (cause) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git rev-parse --git-common-dir failed", { cause });
  }
}

/**
 * Resolves the board's repository root once, via `git rev-parse
 * --show-toplevel` run at `cwd` — confirmed: run from `<root>/ev/sub`, it
 * prints `<root>`. Every later invocation through the returned `GitAdapter`
 * uses that pinned root, regardless of the calling process's own current
 * directory (ADR 0001:433-457). This bootstrap call is the sole documented
 * exception to cwd pinning — by construction, since it's what establishes
 * the pin. `cwd` is a required parameter, never `process.cwd()`: this
 * module never changes or reads the host process's working directory, since
 * doing so would race every other concurrently-running test or command in
 * this process — the chokepoint's explicit `cwd` argument is what lets a
 * bootstrap "from a subdirectory" or "from a secondary worktree" be
 * expressed as a parameter instead.
 *
 * Throws a typed `GIT_BOOTSTRAP_FAILED` error if `cwd` is not inside a git
 * repository, or is inside a bare repository with no working tree —
 * confirmed distinct stderr for each (`fatal: not a git repository...` and
 * `fatal: this operation must be run in a work tree`, respectively) — and
 * never falls back to any other directory.
 *
 * `root` (and therefore `GitAdapter.root`) is canonical — see the
 * `GitAdapter.root` doc comment in `types.ts` — because `--show-toplevel`
 * itself resolves symlinks in `cwd`, verified directly (a symlinked `cwd`
 * still yields the resolved root; see the task report's symlink probe). No
 * `fs.realpath` call is added here for the same reason it isn't added in
 * `gitCommonDir`: it would be redundant.
 */
export async function createGitAdapter(cwd: string, options: GitAdapterOptions = {}): Promise<GitAdapter> {
  const tmpRoot = options.tmpRoot ?? tmpdir();

  let root: string;
  try {
    root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (cause) {
    throw new CanKanError(
      GitErrorCodes.GIT_BOOTSTRAP_FAILED,
      `could not resolve a git repository root from ${cwd}`,
      { cause, details: { cwd } },
    );
  }

  return {
    root,
    readRef: async (ref) => readRefCore(root, await ensureValidRef(root, ref)),
    updateRefCAS: async (ref, newSha, oldSha) =>
      updateRefCASCore(root, await ensureValidRef(root, ref), newSha, oldSha),
    readBlobFromRef: (ref, path) => readBlobFromRef(root, ref, path),
    commitTreeToRef: (ref, params) => commitTreeToRef(root, tmpRoot, ref, params),
    listWorktrees: () => listWorktrees(root),
    fetch: (remote, ref) => fetch(root, remote, ref),
    fetchReconciliation: (remote, ref, stagingRef) => fetchReconciliation(root, remote, ref, stagingRef),
    push: (remote, ref) => push(root, remote, ref),
    gitCommonDir: () => gitCommonDir(root),
  };
}
