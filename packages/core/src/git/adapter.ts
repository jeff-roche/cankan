/**
 * The git adapter: the only module in this codebase permitted to shell out
 * to git (PLAN.md M2.6), and the enforcing security backstop for the whole
 * coordination-ref mechanism (ADR 0001,
 * `docs/decisions/0001-coordination-ref.md:336-693`, "M2.6 (`git/adapter.ts`)
 * must implement").
 *
 * See `types.ts` for the public shapes and `refValidation.ts` for the
 * mandatory ref check every method below runs before touching git.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { CanKanError } from "../errors";
import { GitErrorCodes } from "./errors";
import { validateCoordinationRef } from "./refValidation";
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

/**
 * Gap found during verification, reported per the task brief. R7 rules that
 * every invocation spreads the real `process.env` (never a bare object) so
 * `PATH` and everything else a git child process needs survives. `simple-git`
 * ships a default plugin that scans the env object handed to it for a fixed,
 * short list of variable names (`EDITOR`, `GIT_SSH_COMMAND`, `GIT_PAGER`,
 * and similar) and throws before running *any* command if one is present —
 * regardless of whether the command about to run would ever consult it.
 *
 * Confirmed directly for this task: this repository's own dev shell exports
 * `GIT_EDITOR=true` (evidently to suppress interactive editors), and with it
 * present, spreading `process.env` per R7 made every invocation in this
 * module fail on first run, in its own development environment.
 *
 * None of these variables affects any command this module runs — every
 * invocation here is a fixed plumbing command with array-form argv this
 * module built itself; there is no editor, pager, external diff tool, or
 * custom SSH/proxy command anywhere in this module's command set. Rather
 * than reconfigure `simple-git`'s plugin, the fix is narrower: strip exactly
 * this fixed set of key names (case-insensitively) from the copy of
 * `process.env` this module spreads, so the ambient variable never reaches
 * `simple-git` at all. Everything else `process.env` carries — `PATH`,
 * `HOME`, and anything else a git child process needs, per R7's own
 * rationale — passes through unchanged. The list below is exactly the set
 * `@simple-git/argv-parser`'s vulnerability check inspects (confirmed by
 * reading its installed source for this task, `dist/index.mjs`, since it
 * ships no changelog entry documented against a version range) — it is not
 * open-ended, so widen it here if a future `simple-git` upgrade adds a
 * variable to that list and the same false positive resurfaces.
 */
const ENV_KEYS_SIMPLE_GIT_TREATS_AS_SENSITIVE = new Set([
  "editor",
  "git_askpass",
  "git_config_global",
  "git_config_system",
  "git_config_count",
  "git_config",
  "git_editor",
  "git_exec_path",
  "git_external_diff",
  "git_pager",
  "git_proxy_command",
  "git_template_dir",
  "git_sequence_editor",
  "git_ssh",
  "git_ssh_command",
  "pager",
  "prefix",
  "ssh_askpass",
]);

/**
 * `process.env`, minus the fixed set of names above. The base every
 * invocation's env is built from — see the constant's doc comment.
 */
function baseEnv(): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!ENV_KEYS_SIMPLE_GIT_TREATS_AS_SENSITIVE.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * The CAS-rejection signature. ADR 0001:471-473 states one form: `cannot
 * lock ref '...': is at X but expected Y`. Direct verification for this task
 * (git 2.55.0, 15 repeated two-process races) found two further branches of
 * `update_ref`'s compare check that are the same kind of thing — the ref's
 * actual state disagreeing with the caller's compare value — and not "some
 * other git failure":
 *
 * - `cannot lock ref '...': reference already exists` — the loser of a race
 *   to *create* a ref, i.e. both racers pass `oldSha: null` (compared
 *   against the 40-zero sha) against a ref that does not exist yet. This is
 *   not a corner case: it is exactly PLAN.md's "two processes calling
 *   updateRefCAS with the same expected old value" floor test, run against a
 *   board's very first claim.
 * - `cannot lock ref '...': unable to resolve reference '...'` — the caller
 *   expected the ref to exist at some sha (a non-null `oldSha`), but it does
 *   not exist at all.
 *
 * This is a gap in the ADR's stated signature, reported in the task report
 * rather than silently worked around: all three are treated as CAS
 * rejections (a typed `outcome`, for the caller/retry-driver to react to),
 * and anything else matching `cannot lock ref` differently, or not matching
 * at all, is a hard failure.
 */
const CAS_REJECTION_PATTERN =
  /cannot lock ref '[^']*': (is at [0-9a-f]+ but expected [0-9a-f]+|reference already exists|unable to resolve reference '[^']*')/;

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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The single internal chokepoint every git invocation in this module goes
 * through, with one documented exception (`hashObjectStdin`, below).
 *
 * **R1 — why a chokepoint, not `simpleGit().raw()` at each call site.** A
 * lone function is what makes "every invocation gets `LC_ALL=C` and a fresh
 * instance" a structural guarantee rather than a convention every call site
 * has to remember.
 *
 * **R7 — locale and instance freshness.** `simple-git` surfaces no exit
 * code (`GitError`'s own-enumerable keys are exactly `["task"]" — confirmed
 * for this task), so every discrimination this module makes (CAS rejection,
 * non-fast-forward push/fetch rejection, "ref does not exist") is a stderr
 * *string* match, and git localizes those strings through gettext unless the
 * locale is pinned. `LC_ALL: "C"` is spread on top of the *real*
 * `process.env`, never a bare `{ LC_ALL: "C" }` object, because replacing
 * the environment outright would drop `PATH` and everything else a git
 * child process needs. A **fresh** `simpleGit` instance is constructed on
 * every call because `.env()` mutates the instance it's called on and
 * *replaces* rather than merges the environment on the next call through
 * that same instance — reusing one instance risks a `GIT_INDEX_FILE` set for
 * one `commitTreeToRef` build leaking into an unrelated sibling command,
 * which would be a correctness bug in exactly the class this module exists
 * to prevent.
 */
async function runGit(
  root: string,
  argv: readonly string[],
  extraEnv?: Readonly<Record<string, string>>,
): Promise<string> {
  const git = simpleGit({ baseDir: root });
  git.env({ ...baseEnv(), LC_ALL: "C", ...extraEnv });
  return git.raw([...argv]);
}

/**
 * **R1's one documented direct-spawn exception.** `git hash-object -w
 * --stdin` needs a stdin channel to hand it the blob's content;
 * `simple-git` exposes none — confirmed for this task: `spawn.options`
 * carries no `stdio` or `input` field. ADR 0001:411-413 explicitly exempts
 * `hash-object` from the `--end-of-options` rule for the same reason from
 * the other direction: its content arrives on stdin, and the command takes
 * no ref, path, or commit argument at all, so there is no positional for the
 * marker to protect.
 */
async function hashObjectStdin(root: string, content: string): Promise<ObjectSha> {
  const proc = Bun.spawn(["git", "hash-object", "-w", "--stdin"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  proc.stdin.write(content);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git hash-object failed", {
      cause: new Error(stderr.trim()),
    });
  }
  return stdout.trim() as ObjectSha;
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
    const extraEnv = { GIT_INDEX_FILE: join(indexDir, "index") };

    if (parent === null) {
      await runGit(root, ["read-tree", "--empty"], extraEnv);
    } else {
      // `parent` is a `RefSha` this module itself obtained from `readRef`
      // (or the caller's own prior read of it) — a 40-hex sha, never a
      // config- or log-derived string, so it cannot begin with `-`. The
      // marker is still included ahead of it as the mechanical, costs-
      // nothing hygiene the ADR calls for (0001:391-417) — confirmed
      // accepted by git 2.55.0's `read-tree`.
      await runGit(root, ["read-tree", "--end-of-options", parent], extraEnv);
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
        extraEnv,
      );
    }

    // `write-tree` takes no ref/path/commit argument either; `--end-of-options`
    // is kept for the same uniformity reason and confirmed harmless.
    const tree = await runGit(root, ["write-tree", "--end-of-options"], extraEnv);
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
 * obtained itself, never a config- or log-derived string.
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

/** `readRef`, assuming `ref` has already been validated. */
async function readRefCore(root: string, validatedRef: string): Promise<RefSha | null> {
  let out: string;
  try {
    // R8 — `--quiet` is a deliberate deviation from the ADR's literal
    // template (0001:338), which omits it. Confirmed for this task: without
    // `--quiet`, `rev-parse --verify --end-of-options <missing-ref>` exits
    // 128 with `fatal: Needed a single revision` — indistinguishable by exit
    // code (which `simple-git` doesn't even surface) or by this message
    // alone from a genuine failure, which is exactly the fail-open confusion
    // the ADR condemns for `cat-file` in the `readBlobFromRef` bullet.
    // `--quiet` is an option, not a positional, so it does not sit where
    // `--end-of-options` would need to protect it, and does not weaken the
    // marker's coverage of `<ref>`. With `--quiet`, a missing ref resolves
    // to the empty string through `simple-git` instead of throwing —
    // confirmed directly.
    out = await runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", validatedRef]);
  } catch (cause) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, `git rev-parse failed for ref ${validatedRef}`, {
      cause,
      details: { ref: validatedRef },
    });
  }
  const trimmed = out.trim();
  return trimmed.length === 0 ? null : (trimmed as RefSha);
}

/** `updateRefCAS`, assuming `ref` has already been validated. */
async function updateRefCASCore(
  root: string,
  validatedRef: string,
  newSha: ObjectSha,
  oldSha: RefSha | null,
): Promise<CasOutcome> {
  const compare: Sha = oldSha ?? (ZERO_SHA as Sha);
  try {
    // ADR 0001:458-475: "the trailing old-value argument to `update-ref` *is*
    // the entire CAS mechanism; no separate locking is needed around it."
    await runGit(root, ["update-ref", "--end-of-options", validatedRef, newSha, compare]);
    // The one sanctioned RefSha/ObjectSha transition (see `CasOutcome`'s doc
    // comment in `types.ts`): `update-ref` just confirmed the ref now points
    // to `newSha`, so it is now, in fact, a value "a ref currently points
    // to" — `RefSha`'s exact meaning. This is not a loophole in the
    // inversion barrier: it happens once, here, after the write succeeded,
    // never at a call site as a way to manufacture a `RefSha` to hand back
    // in as `newSha` on some other call.
    return { outcome: "applied", sha: newSha as unknown as RefSha };
  } catch (cause) {
    const message = messageOf(cause);
    if (CAS_REJECTION_PATTERN.test(message)) {
      return { outcome: "rejected", stderr: message };
    }
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, `git update-ref failed for ref ${validatedRef}`, {
      cause,
      details: { ref: validatedRef },
    });
  }
}

async function readBlobFromRef(root: string, ref: string, path: string): Promise<string | null> {
  const validatedRef = await validateCoordinationRef(ref);
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
  const validatedRef = await validateCoordinationRef(ref);
  let commit: ObjectSha;
  try {
    const tree = await buildTree(root, tmpRoot, params.parent, params.files);
    commit = await commitTreeCommand(root, tree, params.parent, params.message);
  } catch (cause) {
    // `hashObjectStdin` already throws a typed `CanKanError`; anything else
    // here (a raw `GitError` from `read-tree`/`update-index`/`write-tree`/
    // `commit-tree`) is wrapped rather than left to propagate unwrapped —
    // every hard failure this module surfaces is a `CanKanError`, never a
    // bare `GitError` a caller would have to know to unwrap, and never a
    // path that copies `cause`'s argv into `message` or `details`.
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
  const validatedRef = await validateCoordinationRef(ref);
  const refspec = `${validatedRef}:${validatedRef}`;
  try {
    // Required refspec, with no exception once the ref exists (ADR
    // 0001:630-646): applied directly to the local working ref. Never
    // relying on a persistent `remote.origin.fetch` entry — confirmed
    // untested by the ADR and, with a `+` prefix, actively dangerous given
    // the reconciliation requirement below.
    await runGit(root, ["fetch", "--end-of-options", remote, refspec]);
    return { outcome: "ok" };
  } catch (cause) {
    const message = messageOf(cause);
    if (FETCH_REJECTED_PATTERN.test(message)) {
      // ADR 0001:655-662: a plain fetch of the working ref's own refspec is
      // itself rejected as non-fast-forward once local and remote have both
      // advanced — confirmed directly. The caller's move here is
      // `fetchReconciliation`, into a staging ref, not a retry of this call.
      return { outcome: "rejected" };
    }
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git fetch failed", {
      cause,
      details: { ref: validatedRef },
    });
  }
}

async function fetchReconciliation(
  root: string,
  remote: string,
  ref: string,
  stagingRef: string,
): Promise<void> {
  const validatedRef = await validateCoordinationRef(ref);
  const validatedStaging = await validateCoordinationRef(stagingRef);
  const refspec = `${validatedRef}:${validatedStaging}`;
  try {
    // ADR 0001:655-662: fetch the remote ref into a distinct local ref name,
    // never the working ref directly.
    await runGit(root, ["fetch", "--end-of-options", remote, refspec]);
  } catch (cause) {
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git fetch (reconciliation) failed", {
      cause,
      details: { ref: validatedRef, stagingRef: validatedStaging },
    });
  }
}

async function push(root: string, remote: string, ref: string): Promise<SyncOutcome> {
  const validatedRef = await validateCoordinationRef(ref);
  const refspec = `${validatedRef}:${validatedRef}`;
  try {
    await runGit(root, ["push", "--end-of-options", remote, refspec]);
    return { outcome: "ok" };
  } catch (cause) {
    const message = messageOf(cause);
    if (PUSH_REJECTED_PATTERN.test(message)) {
      // ADR 0001:647-654: on a non-fast-forward push rejection, the caller
      // must fetch (into a staging ref) and reconcile, then retry — never
      // force-push. This module returns the typed outcome; the
      // fetch-reconcile-retry orchestration is M2.7's (R3).
      return { outcome: "rejected" };
    }
    // M2.1's credential finding: `cause` (a `simple-git` `GitError`) can
    // carry a credential-bearing remote URL in its own-enumerable
    // `task.commands`, even though git's own stderr — this error's
    // `message`, were it copied — redacts credentials itself. `cause` is
    // attached here and nowhere else: never copied into `message` or
    // `details`. `CanKanError.toJSON()` (and therefore `JSON.stringify`)
    // does not serialize `cause` at all.
    throw new CanKanError(GitErrorCodes.GIT_COMMAND_FAILED, "git push failed", {
      cause,
      details: { ref: validatedRef },
    });
  }
}

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
 * this process — `simple-git`'s per-instance `baseDir` is what lets a
 * bootstrap "from a subdirectory" or "from a secondary worktree" be
 * expressed as a parameter instead.
 *
 * Throws a typed `GIT_BOOTSTRAP_FAILED` error if `cwd` is not inside a git
 * repository, or is inside a bare repository with no working tree —
 * confirmed distinct stderr for each (`fatal: not a git repository...` and
 * `fatal: this operation must be run in a work tree`, respectively) — and
 * never falls back to any other directory.
 */
export async function createGitAdapter(cwd: string, options: GitAdapterOptions = {}): Promise<GitAdapter> {
  const tmpRoot = options.tmpRoot ?? tmpdir();

  let root: string;
  try {
    const bootstrap = simpleGit({ baseDir: cwd });
    bootstrap.env({ ...baseEnv(), LC_ALL: "C" });
    root = (await bootstrap.raw(["rev-parse", "--show-toplevel"])).trim();
  } catch (cause) {
    throw new CanKanError(
      GitErrorCodes.GIT_BOOTSTRAP_FAILED,
      `could not resolve a git repository root from ${cwd}`,
      { cause, details: { cwd } },
    );
  }

  return {
    root,
    readRef: async (ref) => readRefCore(root, await validateCoordinationRef(ref)),
    updateRefCAS: async (ref, newSha, oldSha) =>
      updateRefCASCore(root, await validateCoordinationRef(ref), newSha, oldSha),
    readBlobFromRef: (ref, path) => readBlobFromRef(root, ref, path),
    commitTreeToRef: (ref, params) => commitTreeToRef(root, tmpRoot, ref, params),
    listWorktrees: () => listWorktrees(root),
    fetch: (remote, ref) => fetch(root, remote, ref),
    fetchReconciliation: (remote, ref, stagingRef) => fetchReconciliation(root, remote, ref, stagingRef),
    push: (remote, ref) => push(root, remote, ref),
    gitCommonDir: () => gitCommonDir(root),
  };
}
