/**
 * `board/personal.ts` — the personal board's XDG path
 * (`$XDG_DATA_HOME/cankan/personal/`, default
 * `$HOME/.local/share/cankan/personal/`, CONCEPT.md §6c / "Data
 * directories (XDG)") and its **lazy**, concurrency-safe creation.
 *
 * ## The `git init` boundary (a ruling, followed exactly)
 * `ensurePersonalBoard()` creates the board's directory skeleton and does
 * **not** run `git init`, for two independent reasons:
 *
 *   (a) `git/index.ts` (M2.6) is not in M2.4's *Depends on* list (M2.1,
 *       M2.3 only) -- PLAN.md rule 2 forbids importing outside it.
 *   (b) Even with a waiver it would not help: `GitAdapter` exposes
 *       `readRef/updateRefCAS/readBlobFromRef/commitTreeToRef/
 *       listWorktrees/fetch/push/gitCommonDir` and **no
 *       repository-creation operation at all**; `createGitAdapter(cwd)`
 *       requires an already-existing repo. Shelling out to git directly
 *       is forbidden -- M2.6 is the only module permitted to spawn git.
 *
 * The boundary is made **explicit in the return value** rather than left
 * ambiguous: `EnsurePersonalBoardResult.needsGitInit` is `true` whenever
 * `<board.root>/.git` is absent. A caller holding `git/index.ts` (M3.2's
 * `init`, most likely) must treat `needsGitInit: true` as "run `git init`
 * here before this board is safe to touch with any git operation" --
 * named and documented so that obligation cannot be missed.
 *
 * ## `tickets_dir` creation moved here (controller ruling, fix round 1)
 * `board/ref.ts`'s `buildBoardRef` is now **read-only**: it validates
 * `tickets_dir` containment (ADR 0002) but never creates it (a
 * deterministic bypass was found in the guard that used to gate its
 * `mkdir`, and the controller's fix removed the write instead of
 * narrowing the guard -- see `ref.ts`'s file header). Creation is now
 * this function's job for the personal board (M3.2's `init` owns it for
 * a repo board). `ensurePersonalBoard()` calls `buildBoardRef` once to
 * learn the containment-checked, intended `ticketsDir` path, creates it
 * (`mkdir(..., { recursive: true })` -- idempotent, safe under
 * concurrent callers), and calls `buildBoardRef` a **second** time so the
 * returned `BoardRef.ticketsDir` is the full `fs.realpath` of a directory
 * that now actually exists. That second call is what discharges ADR 0002
 * step (b) here (a fresh symlink check against something that now really
 * exists), since `ref.ts` no longer has anything to check-after-creating
 * on its own.
 */

import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CanKanError } from "../errors";
import type { BoardRef } from "../types";
import { BoardErrorCodes } from "./errors";
import { buildBoardRef, isContained, realpathExistingPrefix } from "./ref";
import { resolveDataHome } from "./xdg";

/**
 * `$XDG_DATA_HOME/cankan/personal/`. Reads `env` **at call time**, never
 * memoized at module load, and accepts the same optional `env` override
 * `loadConfig` does -- `withEnv()` (test-utils) mutates `process.env`
 * *after* import, so a module-load read would be both wrong in production
 * (the process's real environment can itself change) and unobservable in
 * tests. `undefined` iff no data home can be located at all (see
 * `resolveDataHome`).
 */
export function resolvePersonalBoardPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const dataHome = resolveDataHome(env);
  return dataHome ? join(dataHome, "cankan", "personal") : undefined;
}

/**
 * Canonicalizes `path` even when it (or some suffix of it) does not fully
 * exist yet, in three tiers, each a fallback for the last:
 *
 * 1. `realpath(path)` -- `path` exists; fully canonical.
 * 2. `realpathExistingPrefix(path)` (`ref.ts`'s own technique for a
 *    `tickets_dir` that doesn't fully exist yet) -- `path` (or some
 *    ancestor of it) does not exist yet, but everything that *does* exist
 *    along it is still resolved canonically and the missing suffix is
 *    re-appended verbatim. This is what keeps a comparison against this
 *    result correct when an ancestor sits behind a symlink (macOS:
 *    `$TMPDIR` under `/var/folders/...`, itself a symlink to
 *    `/private/var/folders/...`; FreeBSD ships `/home -> /usr/home` by
 *    default) and `path` has never been created: a raw, un-resolved
 *    result here would disagree with an already-`realpath`'d value it
 *    gets compared against on exactly the symlinked prefix, the same way
 *    comparing an unresolved `BoardRef.root` against a resolved one would.
 * 3. `path` itself, raw -- only if even that fails (an ancestor is
 *    unreadable, say). Returning something is still better than throwing:
 *    every caller of the personal-board helpers below treats `undefined`
 *    as "nothing to compare against, skip the check," and this function
 *    never returns that -- only its callers do, when there is genuinely no
 *    path to canonicalize at all (see `canonicalPersonalPath` below).
 *
 * Exported as a small, general building block rather than folded into a
 * single personal-board-specific function: **both sides of a personal-board
 * comparison must go through the same existence-tolerant canonicalization,
 * not just the personal-board side** (security review, fix round 6:
 * `registry.ts`'s `listRegisteredBoards` compared this function's
 * three-tier result against a registry entry's *raw, uncanonicalized*
 * stored path -- on a host where `$TMPDIR`/`$XDG_DATA_HOME` sits behind a
 * symlink, the two sides disagreed even for an *exact* match, silently
 * defeating the "is the personal board" check entirely, not merely missing
 * a symlink alias as documented). `isPersonalBoardPath` below is the
 * shared predicate that canonicalizes both sides with this one function,
 * so that asymmetry is structurally impossible rather than merely absent
 * at any one call site today.
 */
async function canonicalizeExistenceTolerant(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return await realpathExistingPrefix(path);
    } catch {
      return path;
    }
  }
}

/**
 * The personal board's own path, existence-tolerant canonicalized (see
 * `canonicalizeExistenceTolerant` above). `undefined` only when no data
 * home can be resolved at all.
 *
 * Shared by `resolve.ts` and `registry.ts`'s `listRegisteredBoards` -- a
 * second, independently-drifting copy of a security-relevant fallback
 * chain is exactly the risk this file's own `isContained`/
 * `realpathExistingPrefix` reuse already avoids one layer down (fix round
 * 5, H1: a first version of this had two byte-for-byte-identical copies,
 * one per file, that no test could catch diverging).
 *
 * **Not** used by `registry.ts`'s `register()`: that function's own
 * `targetPath` is already `realpath`'d before its comparison runs, so it
 * can never equal a personal path that does not exist, and this stronger
 * (and more expensive) fallback would buy it nothing. `register()` keeps
 * its own plain, two-tier `resolveCanonicalPersonalPath` (`realpath`, or
 * `undefined`) for that reason -- re-confirmed sound in fix round 6's own
 * security review, not merely left alone by inertia.
 */
export async function canonicalPersonalPath(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const raw = resolvePersonalBoardPath(env);
  if (!raw) return undefined;
  return canonicalizeExistenceTolerant(raw);
}

/**
 * Whether `candidate` -- any absolute path, not necessarily existing, and
 * not necessarily already canonical -- names the personal board itself, or
 * something inside it. Canonicalizes **both** `candidate` and the personal
 * board's own path with the identical existence-tolerant chain
 * (`canonicalizeExistenceTolerant`) before comparing, rather than
 * requiring every call site to canonicalize its own candidate correctly
 * (fix round 6, security review: `registry.ts`'s `listRegisteredBoards`
 * compared a canonical personal path against a *raw* registry entry path,
 * which silently failed to match even an exact alias whenever an ancestor
 * of the data home sits behind a symlink -- a category of bug this
 * predicate makes structurally impossible at every site that uses it,
 * rather than merely absent at the sites someone remembered to check by
 * hand).
 *
 * `false` when the personal board's own path cannot be resolved at all
 * (no data home) -- there is nothing to be "inside" in that case.
 */
export async function isPersonalBoardPath(
  candidate: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const personalPath = await canonicalPersonalPath(env);
  if (personalPath === undefined) return false;
  const canonicalCandidate = await canonicalizeExistenceTolerant(candidate);
  return isContained(personalPath, canonicalCandidate);
}

export interface EnsurePersonalBoardOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The result of `ensurePersonalBoard()`.
 *
 * - `created` is `true` only for the one call -- across any number of
 *   concurrently racing processes -- that actually created the board root
 *   directory. Every other concurrent (or later) call observes `false`
 *   while still receiving the same `board`.
 * - `needsGitInit` is `true` whenever `<board.root>/.git` is absent -- see
 *   the file header's "`git init` boundary" note. A caller that owns
 *   `git/index.ts` must check this and run `git init` there before
 *   performing any git operation against the board.
 */
export interface EnsurePersonalBoardResult {
  readonly board: BoardRef;
  readonly created: boolean;
  readonly needsGitInit: boolean;
}

function isEExist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Runs a filesystem operation, converting any failure into a typed
 * `PERSONAL_BOARD_UNAVAILABLE` (security review: an audit of this file
 * found every bare `await` on a filesystem call could surface a raw,
 * untyped platform error on the ordinary public API -- no hostile input
 * required, just an unwritable data home, a dangling symlink where the
 * personal board should be, or its root demoted to a regular file. Every
 * such call in this file is routed through here so the class is closed
 * once, not site by site.
 */
async function wrapFsFailure<T>(operation: () => Promise<T>, path: string): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    throw new CanKanError(
      BoardErrorCodes.PERSONAL_BOARD_UNAVAILABLE,
      `personal board directory operation failed at ${path}`,
      { cause: err, details: { path } },
    );
  }
}

/**
 * Creates the personal board's directory skeleton on first use (lazily)
 * and returns its `BoardRef`. Idempotent and safe under concurrent
 * callers: two processes calling this at the same time converge on the
 * one board rather than racing into a half-initialized directory.
 *
 * Concurrency-correct `created` detection: `mkdir(dirname(root), {
 * recursive: true })` runs first (idempotent -- any number of racing
 * callers may run it), then a **non-recursive** `mkdir(root)`, so exactly
 * one caller's promise resolves and every other racing caller's rejects
 * `EEXIST`. A single recursive `mkdir(root, { recursive: true })` cannot
 * make this distinction -- it reports success identically whether it made
 * the directory or found it already there.
 *
 * The board root is created `0700` (F6, security review), not the
 * platform mkdir default (`0755`): CONCEPT.md §6c documents the personal
 * board as private, cross-repo work, not something every local user
 * account should be able to read.
 *
 * Creates `<root>/.cankan/` (an empty directory is enough -- CONCEPT.md
 * §6c: "the personal board's `.cankan/config.yml` is a normal repo
 * config"), and creates `ticketsDir` itself -- see the file header's
 * "`tickets_dir` creation moved here" note; `buildBoardRef` no longer
 * does this.
 *
 * Deliberately does **not** write a starter `.cankan/config.yml`: the
 * effective config for a board with zero config files present is already
 * well-defined (`config/schema.ts`'s defaults -- `tickets_dir:
 * backlog/tasks`, `coordination.ref: refs/cankan/coordination`, ...), so
 * there is nothing this function must write to make the board usable.
 * Skipping the file also skips having to give it the `O_EXCL`-or-
 * temp+rename treatment the brief requires of anything actually written
 * into the board under concurrency.
 */
export async function ensurePersonalBoard(
  options: EnsurePersonalBoardOptions = {},
): Promise<EnsurePersonalBoardResult> {
  const env = options.env ?? process.env;
  const rawPath = resolvePersonalBoardPath(env);
  if (!rawPath) {
    throw new CanKanError(
      BoardErrorCodes.DATA_HOME_UNRESOLVABLE,
      "could not resolve a data directory ($XDG_DATA_HOME or $HOME) for the personal board",
    );
  }

  await wrapFsFailure(() => mkdir(dirname(rawPath), { recursive: true }), dirname(rawPath));

  let created = true;
  try {
    await mkdir(rawPath, { mode: 0o700 });
  } catch (err) {
    if (isEExist(err)) {
      created = false;
    } else {
      // A raw platform error here (`EACCES` on `dirname(rawPath)`, most
      // commonly) must not escape untyped -- the same discipline this
      // module already applies elsewhere (`TICKETS_DIR_INVALID`,
      // `CWD_UNRESOLVABLE`, the internal lock-loss exception in
      // `registry.ts`); an untyped error is invisible to
      // `isCanKanError`/M3.10's exit-code map.
      throw new CanKanError(
        BoardErrorCodes.PERSONAL_BOARD_UNAVAILABLE,
        `could not create the personal board directory: ${rawPath}`,
        { cause: err, details: { path: rawPath } },
      );
    }
  }

  // The personal board's `.cankan/` directory. `mkdir(recursive)` is
  // idempotent, so this is safe under concurrent callers regardless of
  // which one (if any) actually created `root` above. Also the site of a
  // sibling class of failure to the one just above: `rawPath` existing as
  // a dangling symlink (`ENOENT`), a regular file (`ENOTDIR`), or with
  // mode `000` (`EACCES`) all reach this `mkdir` rather than the one
  // above it.
  const cankanDir = join(rawPath, ".cankan");
  await wrapFsFailure(() => mkdir(cankanDir, { recursive: true }), cankanDir);

  // `buildBoardRef` is read-only (see file header): this first call only
  // learns the containment-checked, intended `ticketsDir` path -- it may
  // not exist on disk yet. Create it, then call again so the returned
  // `BoardRef.ticketsDir` is the full realpath of something that now
  // really exists (discharging ADR 0002 step (b) here).
  const probe = await buildBoardRef({ kind: "personal", name: "personal", root: rawPath, env });
  await wrapFsFailure(() => mkdir(probe.ticketsDir, { recursive: true }), probe.ticketsDir);
  const board = await buildBoardRef({ kind: "personal", name: "personal", root: rawPath, env });

  const gitPath = join(board.root, ".git");
  let needsGitInit: boolean;
  try {
    await lstat(gitPath);
    needsGitInit = false;
  } catch (err) {
    if (isEnoent(err)) {
      needsGitInit = true;
    } else {
      throw new CanKanError(
        BoardErrorCodes.PERSONAL_BOARD_UNAVAILABLE,
        `could not check for a .git directory in the personal board: ${gitPath}`,
        { cause: err, details: { path: gitPath } },
      );
    }
  }

  return { board, created, needsGitInit };
}
