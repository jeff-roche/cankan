/**
 * Shared types for the git adapter (ADR 0001, "M2.6 (`git/adapter.ts`) must
 * implement", `docs/decisions/0001-coordination-ref.md:336-693`).
 */

/**
 * A 40-hex git object id. Forty-hex only, deliberately: nothing in this
 * project targets a SHA-256 (64-hex) repository, and an earlier version of
 * this comment claimed 64-hex support while `ZERO_SHA` (`adapter.ts`) was
 * hardcoded to 40 zeros — a regex admitting a width the zero sentinel cannot
 * express would be a latent defect, not a generalization, so the SHA-256
 * case is left unclaimed here rather than half-supported (fix-round-1 F2).
 *
 * Branded so a plain `string` is not accidentally accepted as a `Sha` — but
 * unlike `TicketId`/`ActorId` in `../types.ts`, this brand is **not**
 * runtime-validation-free: `assertShaShape` (`adapter.ts`) checks every
 * `newSha`/`oldSha`/`parent` against `^[0-9a-f]{40}$` before it reaches
 * argv. `git update-ref` accepts any revision expression, not only an
 * object id — a caller passing `"HEAD"` or `"refs/heads/main"` as a `Sha`
 * would otherwise compile cleanly and defeat the CAS at runtime (fix-round-1
 * F2: verified directly, including a reproduced lost update where a second
 * writer's commit was silently dropped after such a value was fed back as a
 * stale compare). The brand exists to support the two narrower brands below,
 * which carry a further, load-bearing distinction on top of the shared
 * runtime check.
 */
export type Sha = string & { readonly __brand: "Sha" };

/**
 * A `Sha` this module *observed* by reading a ref — `readRef`'s return value,
 * or the `parent` a caller passes into `commitTreeToRef`. Semantically: "the
 * value a ref currently points to, or once pointed to."
 */
export type RefSha = Sha & { readonly __shaOrigin: "ref" };

/**
 * A `Sha` this module *minted* by writing a new git object — the return
 * value of `commit-tree`. Semantically: "a value nothing points to yet."
 *
 * **Why two brands, not one `Sha`.** `updateRefCAS(ref, newSha, oldSha)`'s
 * argument order is a named correctness hazard (PLAN.md M2.6; ADR 0001:458):
 * the *third* argument is the compare value, and swapping the two positional
 * shas yields a CAS that always succeeds — the exact defect this whole
 * mechanism exists to prevent, and it would pass a test that only checks the
 * happy path. A single `Sha` type does not stop that swap: both positions
 * would accept it. `RefSha` and `ObjectSha` are structurally distinct
 * (different `__shaOrigin` values), so passing a `RefSha` where `newSha`
 * (typed `ObjectSha`) is expected, or vice versa, is a compile error — not a
 * runtime guess dressed up as a type. This does not require a caller to cast
 * at every call site: the natural CAS flow already produces the right shapes
 * in the right places without any cast — `const old = await readRef(ref)`
 * yields a `RefSha`, `commitTreeToRef`'s internal `commit-tree` step yields
 * an `ObjectSha`, and `updateRefCAS(ref, commitSha, old)` type-checks with
 * zero casts because the values were never anything else. Inverting the call
 * (`updateRefCAS(ref, old, commitSha)`) fails to type-check, which is what
 * "impossible to get wrong from the outside" means here: getting it wrong
 * requires deliberately fighting the type checker (e.g. `as unknown as
 * ObjectSha`), not merely writing the arguments in the wrong order.
 *
 * As with the runtime-validated brand above the compile-time boundary: this
 * is enforced by the type checker (`bun run typecheck`, not `bun test`,
 * which strips types), not by any runtime tag on the string itself — a
 * `RefSha` and an `ObjectSha` are both, at runtime, an indistinguishable
 * 40-hex string.
 */
export type ObjectSha = Sha & { readonly __shaOrigin: "object" };

/**
 * The outcome of a compare-and-swap ref update or an off-tree commit build.
 *
 * The successful branch's `sha` is typed `RefSha`, not `ObjectSha`, even
 * though the value passed in as `newSha` was an `ObjectSha`: once
 * `update-ref` has applied it, that value *is* what the ref now points to —
 * exactly `RefSha`'s meaning (see `RefSha`'s doc comment) — and a caller
 * chaining commits (using this result as the next call's `parent`, or as a
 * later `updateRefCAS`'s `oldSha`) needs it in that shape with no cast at
 * the call site. This is the one place the two brands are related on
 * purpose: the transition happens once, inside this module, after git has
 * actually confirmed the write — never as something a caller does to a
 * value it merely intends to write.
 */
export type CasOutcome =
  | { readonly outcome: "applied"; readonly sha: RefSha }
  | { readonly outcome: "rejected"; readonly stderr: string };

/** The outcome of a steady-state fetch or push of a ref. */
export type SyncOutcome = { readonly outcome: "ok" } | { readonly outcome: "rejected" };

/** One file to write into the tree `commitTreeToRef` builds. */
export interface CommitTreeFile {
  /**
   * Path within the tree, e.g. `events/2026-09.jsonl`. Passed to `git
   * update-index --add --cacheinfo <mode>,<object>,<path>` as part of a
   * single comma-joined option argument (ADR 0001:391-431's `--end-of-options`
   * rule is scoped to *positional* arguments precisely because it cannot
   * protect an option's own argument, and this is one); git's own
   * `verify_path` (invoked on the write side) is what rejects a path
   * escaping the tree, e.g. `../outside.txt` — confirmed directly for this
   * task. This module does not duplicate that check.
   */
  readonly path: string;
  /** File content, written verbatim via `git hash-object -w --stdin`. */
  readonly content: string;
}

/** Parameters for building one commit off-tree and CAS-ing a ref onto it. */
export interface CommitTreeParams {
  /**
   * The commit `newSha` will be parented on, and the CAS compare value.
   * `null` means "the ref must not exist yet" — the no-parent case: `-p` is
   * omitted from `commit-tree` entirely, and `updateRefCAS` compares against
   * the 40-zero sha internally.
   */
  readonly parent: RefSha | null;
  readonly message: string;
  /** At least one file. All other paths in `parent`'s tree are preserved. */
  readonly files: readonly CommitTreeFile[];
}

/**
 * One entry from `git worktree list --porcelain`.
 *
 * **`path` is canonical (symlink-resolved), guaranteed by this module —
 * ADR 0001:1097-1099's two-step recipe (`rev-parse ...`, then
 * `fs.realpath`).** Verified directly (CI's macOS failure, and a Linux
 * symlink probe reproducing the same condition — see `adapter.ts`'s
 * `parseWorktreeBlock` doc comment and the task report): git resolves a
 * worktree's path into its `.git/worktrees/<name>/gitdir` file at
 * `worktree add` time, before this module ever reads it back, so no
 * explicit `fs.realpath` call is needed here — adding one would be
 * redundant, not more correct. This module commits to the outcome (a
 * canonical path) regardless of mechanism, not to the specific call that
 * happens to produce it today.
 */
export interface WorktreeInfo {
  readonly path: string;
  readonly headSha: string | null;
  /** Full ref name (e.g. `refs/heads/main`), or `null` if detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
}

export interface GitAdapterOptions {
  /**
   * Base directory `commitTreeToRef` passes to `mkdtemp` when creating the
   * private index directory that backs `GIT_INDEX_FILE`. Defaults to
   * `os.tmpdir()`. Injectable so a test can assert the directory is gone
   * afterward without racing every other process's use of the real system
   * temp directory.
   */
  readonly tmpRoot?: string;
}

/**
 * The pinned-root git adapter. Every method runs with its working directory
 * fixed at the `root` resolved once at construction (ADR 0001:433-457) —
 * never the process's current directory, regardless of where the calling
 * process happens to be running from.
 */
export interface GitAdapter {
  /**
   * Absolute path to the repository's working-tree root, and canonical
   * (symlink-resolved) — `git rev-parse --show-toplevel` resolves symlinks
   * in the path it prints, verified directly (a symlinked `cwd` still
   * yields the resolved root; see the task report's symlink probe). This
   * module does not call `fs.realpath` on it separately; the guarantee is
   * git's, not an addition of this module's — but it is a guarantee, not an
   * incidental fact a caller must re-verify.
   */
  readonly root: string;

  /**
   * `git show-ref --exists` to discriminate "absent" from "present but
   * unreadable/broken" (fix-round-1 F5), then `git rev-parse --verify
   * --end-of-options <ref>` to resolve the sha. Returns `null` if `ref` does
   * not exist; throws a typed hard error if it exists but cannot be read.
   * `ref` is validated (name check, plus the symref check — fix-round-1 F1)
   * before any git invocation.
   */
  readRef(ref: string): Promise<RefSha | null>;

  /**
   * `git update-ref --no-deref --end-of-options <ref> <newSha> <oldSha ??
   * ZERO_SHA>`. The *third* argument is the compare value — see
   * `ObjectSha`'s doc comment for why the type checker, not documentation,
   * is what prevents inverting it, and `Sha`'s doc comment for the runtime
   * shape check that closes the gap a compile-time brand alone leaves open
   * (fix-round-1 F2). `--no-deref` (fix-round-1 F1) is a TOCTOU backstop: a
   * no-op for a normal ref, and the reason a ref that becomes a symbolic ref
   * between validation and this write still cannot move whatever it points
   * to. `oldSha: null` means "the ref must not exist yet."
   */
  updateRefCAS(ref: string, newSha: ObjectSha, oldSha: RefSha | null): Promise<CasOutcome>;

  /**
   * Resolves `ref` to a commit, then reads `path` at that commit via the
   * three-way `ls-tree`/`cat-file` check (ADR 0001:486-601). `null` means no
   * entry at that path. Any other disagreement between what was requested
   * and what was resolved — more than one entry, a path that doesn't match
   * byte-for-byte, a mode other than `100644` — is a thrown, typed hard
   * error, never a silent `null`. Throws (does not return `null`) if `ref`
   * itself does not exist — callers must check `readRef` first (failure
   * mode 6); this function does not lazily initialize anything.
   */
  readBlobFromRef(ref: string, path: string): Promise<string | null>;

  /**
   * Builds one commit entirely off-tree — blob(s) via `git hash-object -w
   * --stdin`, tree via a private temp index, commit via `git commit-tree` —
   * touching neither the real index nor the working tree, then CASes `ref`
   * onto it via `updateRefCAS`. Returns the same `CasOutcome` `updateRefCAS`
   * would.
   */
  commitTreeToRef(ref: string, params: CommitTreeParams): Promise<CasOutcome>;

  /**
   * `git worktree list --porcelain`, parsed. Every `WorktreeInfo.path` is
   * canonical — see that type's doc comment.
   */
  listWorktrees(): Promise<WorktreeInfo[]>;

  /**
   * Steady-state fetch: `git fetch --end-of-options <remote> <ref>:<ref>`.
   * `{ outcome: "rejected" }` on the non-fast-forward rejection (ADR
   * 0001:977-980); any other failure throws.
   */
  fetch(remote: string, ref: string): Promise<SyncOutcome>;

  /**
   * Reconciliation fetch into a distinct local ref:
   * `git fetch --end-of-options <remote> <ref>:<stagingRef>`. Never the
   * working ref's own refspec (ADR 0001:655-671) — both `ref` and
   * `stagingRef` are validated.
   */
  fetchReconciliation(remote: string, ref: string, stagingRef: string): Promise<void>;

  /**
   * Steady-state push: `git push --end-of-options <remote> <ref>:<ref>`.
   * `{ outcome: "rejected" }` on the non-fast-forward push rejection (ADR
   * 0001:647-654); any other failure throws.
   */
  push(remote: string, ref: string): Promise<SyncOutcome>;

  /**
   * `git rev-parse --path-format=absolute --git-common-dir`. Absolute by
   * construction — the bare `--git-common-dir` form is relative to the
   * current directory and varies with where it runs (ADR 0001:1097-1112),
   * which would make two worktrees of one clone compute two different keys
   * for whatever uses this.
   *
   * **Canonical (symlink-resolved), guaranteed — this module's contract,
   * not merely an observed fact about git.** ADR 0001:1097-1099 specifies
   * `rev-parse --path-format=absolute --git-common-dir` **then**
   * `fs.realpath` as one recipe; an earlier version of this doc comment
   * said the second half was "left to the caller," which would have made a
   * silently-forgotten `fs.realpath` call in a consumer (M2.7) produce
   * exactly the per-clone key divergence this section exists to prevent.
   * Verified directly (macOS CI: `rev-parse`'s own output was already the
   * `/private/var/...`-resolved form, never the `/var/...` symlink form the
   * test fixture wrongly expected; a Linux symlink probe reproducing the
   * same condition confirms it — see the task report) that `rev-parse`
   * itself resolves the symlink, so no separate `fs.realpath` call is
   * added here — adding one would be redundant, not more correct. The
   * commitment this module makes is the *outcome* (a canonical path), not
   * the specific mechanism that produces it.
   */
  gitCommonDir(): Promise<string>;
}
