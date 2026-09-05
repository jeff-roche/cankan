/**
 * `board/ref.ts` — `buildBoardRef`, the single place a `BoardRef` (M2.1,
 * `../types.ts`) is constructed from a directory. Every board — the one
 * found by walking up from `cwd` (dispatch B's `resolve.ts`), a registry
 * entry (`registry.ts`), or the personal board (`personal.ts`) — is meant
 * to go through this function, so the canonicalization and containment
 * rules below apply uniformly regardless of source.
 *
 * ## The canonicalization ruling (binding)
 * `BoardRef.root` and `BoardRef.ticketsDir` are always the `fs.realpath`
 * of the underlying directory, or of the underlying directory's deepest
 * *existing* ancestor with the remaining, not-yet-existing components
 * re-appended (see `realpathExistingPrefix` below) — never a
 * string-constructed or caller-supplied path — for every `kind` and every
 * source. M2.6's `GitAdapter` returns symlink-resolved paths for
 * everything it touches; comparing an unresolved `root` against one of
 * those fails silently on macOS (`$TMPDIR` sits under `/var/folders/...`,
 * itself a symlink to `/private/var/...`) and passes trivially on Linux.
 *
 * ## Board resolution is read-only (controller ruling, fix round 1)
 * **`buildBoardRef` never creates `tickets_dir`, and never creates or
 * touches anything else on disk.** An earlier version of this function
 * created `tickets_dir` with `mkdir(..., { recursive: true })` when it
 * did not already exist, gated behind a defense-in-depth
 * `assertNoSymlinkComponent` guard. That guard had a deterministic bypass
 * (F1: it early-returned on a *string-prefix* test, `rel.startsWith("..")`,
 * for exactly the class of path the ADR names as the wrong
 * implementation — a directory literally named `..evil` is genuinely
 * contained by *component*, so `isContained` correctly says "contained,"
 * but the guard's prefix test treated it as "not really contained" and
 * skipped the walk entirely, letting `mkdir(recursive)` follow a
 * committed symlink there before anything could look). Demonstrated live
 * against both an outside-root escape and a `.git` write.
 *
 * The controller ruling removes the write instead of narrowing it:
 * PLAN.md M3.2 already assigns "writes ... tickets dir" to `init`, so
 * creation was never this function's job in the first place, and the
 * `mkdir` call was the *only* reason the bypass had any blast radius —
 * without it, nothing this function does can ever materialize a
 * directory anywhere. `assertNoSymlinkComponent` is deleted entirely,
 * not kept alongside the fix.
 *
 * Creation now belongs to whichever caller actually needs `tickets_dir`
 * to exist: `personal.ts`'s `ensurePersonalBoard()` creates it and calls
 * `buildBoardRef` a second time afterward (so the returned `ticketsDir`
 * is a full realpath of something that now really exists — this is how
 * ADR 0002 step (b) stays discharged even though this function no longer
 * creates anything itself); M3.2's `init` owns the repo-board case (not
 * built in this dispatch).
 *
 * ## `tickets_dir` containment (ADR 0002, docs/decisions/0002-ids-and-backlog-compat.md, 542-630)
 * Implements the ADR's staged check, steps (a) and (b), both read-only:
 *
 *   (a) string-arithmetic containment of `path.resolve(root, tickets_dir)`
 *       inside `root`, and outside `<root>/.git` (`checkContainment`,
 *       called on the raw resolved string).
 *   (b) `realpathExistingPrefix` resolves whatever part of that path
 *       already exists on disk (walking upward to the deepest existing
 *       ancestor, `fs.realpath`-ing *that*, then re-appending the
 *       remaining components verbatim — they cannot be symlinks if they
 *       do not exist), and `checkContainment` runs again against the
 *       result. This is what catches a `tickets_dir` reached through an
 *       *existing* symlink — anywhere along the path, not only at the
 *       final component — which (a)'s string arithmetic cannot see.
 *
 * "Lies beneath" is a path-*component* relationship (`path.relative`),
 * never a string prefix: `resolved.startsWith(boardRoot)` is the ADR's
 * named wrong implementation, defeated by `tickets_dir: ../repo-evil/x`
 * against a root of `/home/u/repo` (`/home/u/repo-evil/x` passes a naive
 * prefix test) — and, per F1 above, so is `rel.startsWith("..")` against
 * a component literally named `..evil`. `isContained` compares by
 * component (`rel.split(sep)[0] !== ".."`) everywhere in this file; there
 * is no string-prefix test left anywhere in this module.
 *
 * The `.git` exclusion (`firstSegmentIsGitDir`) compares the first path
 * component under `root` against `.git` **case-insensitively, with
 * trailing dots/spaces stripped**, unconditionally rather than via
 * `process.platform` (mirrors `config/schema.ts`'s `DRIVE_LETTER_PREFIX`
 * precedent): NTFS silently strips a component's trailing dots/spaces (so
 * `tickets_dir: .git./hooks` is `.git/hooks` on an actual Windows machine
 * even though it is a distinct string here), and macOS's default
 * filesystem is case-insensitive (so `.GIT` is `.git` there). PLAN.md
 * ships a `win-x64` build target, so a checked-in `tickets_dir` must be
 * judged the same way regardless of which platform later reads the repo.
 *
 * A containment failure throws a typed `CanKanError`
 * (`BoardErrorCodes.TICKETS_DIR_ESCAPES_BOARD`) and writes nothing — this
 * function performs no filesystem writes at all, so that is automatic
 * rather than something each call site has to preserve.
 *
 * `tickets_dir` is deliberately unvalidated by `config/schema.ts` (ADR
 * 0002 assigns this check here), so a value the filesystem itself cannot
 * represent — an embedded NUL byte, or a component long enough to trip
 * `ENAMETOOLONG` — reaches `fs.lstat`/`fs.realpath` as a raw platform
 * error (`TypeError`/`ERR_INVALID_ARG_VALUE` for NUL, a bare `Error` with
 * `code: "ENAMETOOLONG"` for the latter), neither of which is a
 * `CanKanError` and both of which would otherwise be invisible to
 * `isCanKanError`/M3.10's exit-code map. Every filesystem call touching
 * the resolved `tickets_dir` is wrapped and rethrown as
 * `BoardErrorCodes.TICKETS_DIR_INVALID` when it is not already a
 * `CanKanError`.
 *
 * **Gap, reported rather than improvised:** full step (c) — excluding a
 * *linked worktree's* real git directory via `git rev-parse --git-dir` /
 * `--git-common-dir` — needs git-dir discovery that only `git/index.ts`
 * (M2.6) can do, and M2.6 is not in M2.4's *Depends on* list; even with a
 * waiver, M2.6's `GitAdapter` exposes only `gitCommonDir()`, no `--git-dir`
 * equivalent. What ships instead is the reachable slice: rejecting a
 * `tickets_dir` resolving to or beneath `<root>/.git` (by name, in both
 * (a) and (b)) — which is exactly right for a main worktree and is also
 * *not wrong* for a linked worktree, since a linked worktree's real
 * git-common-dir lives outside the board root entirely and is therefore
 * already excluded by "must lie beneath root." What's missing is narrower
 * than it sounds: a `.git` *file* (not directory) inside a linked
 * worktree's root that redirects elsewhere via `gitdir:` is not specially
 * detected here, but ADR (a)/(b) already forbids `tickets_dir` from
 * resolving to anything named `.git` under `root` regardless of what that
 * entry is, so this gap has no known unblocked exploit — it is reported as
 * incomplete coverage of the ADR's literal text, not as a live escape.
 * Step (d) (ticket *filename* validation) belongs to M2.5.
 */

import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { loadConfig } from "../config/index";
import { CanKanError, isCanKanError } from "../errors";
import type { BoardKind, BoardRef } from "../types";
import { BoardErrorCodes } from "./errors";

export interface BuildBoardRefOptions {
  readonly kind: BoardKind;
  readonly name: string;
  /** Board root. Need not already be canonical — this function realpaths it. */
  readonly root: string;
  /** Passed through to `loadConfig`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * `path.relative`-based containment: is `resolved` equal to, or beneath,
 * `base`? Never a string prefix (see file header, F1).
 *
 * Exported (dispatch B, `resolve.ts`/`registry.ts` fix round 1, finding
 * F1): the personal-board privacy checks in both of those files need the
 * exact same "equal to or beneath" test this file already uses for ADR
 * 0002's `tickets_dir` containment -- reusing it here rather than
 * re-deriving a second copy that could drift from this one (or reopen the
 * same string-prefix mistake F1 already fixed once in this file).
 */
export function isContained(base: string, resolved: string): boolean {
  const rel = relative(base, resolved);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

const TRAILING_DOTS_OR_SPACES = /[. ]+$/;

/**
 * Whether `segment` names the git directory under win32/macOS-equivalent
 * semantics, not just byte-for-byte POSIX comparison (see file header).
 * Checked unconditionally, never via `process.platform`.
 */
function isGitDirSegment(segment: string): boolean {
  return segment.replace(TRAILING_DOTS_OR_SPACES, "").toLowerCase() === ".git";
}

/** Is the first path component of `target` relative to `root` a `.git`-shaped name? */
function firstSegmentIsGitDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel)) return false;
  const first = rel.split(sep)[0];
  return first !== undefined && first !== ".." && isGitDirSegment(first);
}

function escapesBoardError(kind: string, root: string, configValue: string, resolved: string): CanKanError {
  return new CanKanError(
    BoardErrorCodes.TICKETS_DIR_ESCAPES_BOARD,
    `tickets_dir "${configValue}" ${kind} (board root: ${root})`,
    { details: { root, ticketsDir: configValue, resolved } },
  );
}

function invalidTicketsDirError(root: string, configValue: string, cause: unknown): CanKanError {
  return new CanKanError(
    BoardErrorCodes.TICKETS_DIR_INVALID,
    `tickets_dir "${configValue}" is not usable on this filesystem (board root: ${root})`,
    { cause, details: { root, ticketsDir: configValue } },
  );
}

/** Throws `TICKETS_DIR_ESCAPES_BOARD` unless `resolved` lies beneath `root` and outside `<root>/.git`. */
function checkContainment(root: string, resolved: string, configValue: string): void {
  if (!isContained(root, resolved)) {
    throw escapesBoardError("resolves outside the board root", root, configValue, resolved);
  }
  if (firstSegmentIsGitDir(root, resolved)) {
    throw escapesBoardError("resolves inside the board's .git directory", root, configValue, resolved);
  }
}

/**
 * Finds the deepest already-existing ancestor of `target` (walking
 * upward, `lstat`-ing each candidate purely to test existence), realpaths
 * *just that existing prefix* (resolving any symlink within it, however
 * deep), and re-appends the remaining, not-yet-existing components
 * verbatim — a path component that does not exist cannot be a symlink.
 * Never creates anything. See the file header's "Board resolution is
 * read-only" note for why this replaces the old create-then-realpath
 * approach.
 *
 * Exported (`resolve.ts`'s `canonicalPersonalPath`): comparing a candidate
 * board's already-`realpath`'d `root`/`ticketsDir` against a *raw*
 * personal-board path is the same category error a symlinked-ancestor
 * `$XDG_DATA_HOME` reopens for a personal board that has not been created
 * yet (raw and canonical forms disagree exactly there) — this function is
 * the correct canonicalization for "the personal board's path, whether or
 * not it exists," reused rather than re-derived for the same reason
 * `isContained` is shared between this file, `resolve.ts`, and
 * `registry.ts`.
 */
export async function realpathExistingPrefix(target: string): Promise<string> {
  const suffix: string[] = [];
  let current = target;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code !== "ENOENT") {
        throw err;
      }
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that
        // exists -- cannot happen once `root` itself is guaranteed to
        // exist (the caller only reaches this after `realpath(root)`
        // succeeded), but stop rather than loop forever if it somehow did.
        break;
      }
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  const real = await realpath(current);
  return suffix.length > 0 ? join(real, ...suffix) : real;
}

export async function buildBoardRef(options: BuildBoardRefOptions): Promise<BoardRef> {
  const root = await realpath(options.root);
  const cfg = await loadConfig({ repoRoot: root, env: options.env });
  const ticketsDirConfigValue = cfg.value.tickets_dir;
  const coordinationRef = cfg.value.coordination.ref;

  let ticketsDir: string;
  try {
    // Step (a) -- string arithmetic, no filesystem writes anywhere in
    // this function.
    const target = resolvePath(root, ticketsDirConfigValue);
    checkContainment(root, target, ticketsDirConfigValue);

    // Step (b) -- realpath whatever part of `target` already exists,
    // catching a symlink anywhere along that existing part.
    ticketsDir = await realpathExistingPrefix(target);
    checkContainment(root, ticketsDir, ticketsDirConfigValue);
  } catch (err) {
    if (isCanKanError(err)) throw err;
    throw invalidTicketsDirError(root, ticketsDirConfigValue, err);
  }

  return {
    kind: options.kind,
    name: options.name,
    root,
    ticketsDir,
    coordinationRef,
  };
}
