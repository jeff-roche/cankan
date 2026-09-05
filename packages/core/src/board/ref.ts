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
 * of the underlying directory — never a string-constructed or
 * caller-supplied path — for every `kind` and every source. M2.6's
 * `GitAdapter` returns symlink-resolved paths for everything it touches;
 * comparing an unresolved `root` against one of those fails silently on
 * macOS (`$TMPDIR` sits under `/var/folders/...`, itself a symlink to
 * `/private/var/...`) and passes trivially on Linux. Both fields are
 * realpath'd before this function returns, precisely so M2.5/M2.8/M2.14
 * never have to re-derive this themselves.
 *
 * ## `tickets_dir` containment (ADR 0002, docs/decisions/0002-ids-and-backlog-compat.md, 542-630)
 * Implements the ADR's staged check, steps (a) and (b):
 *
 *   (a) string-arithmetic containment of `path.resolve(root, tickets_dir)`
 *       inside `root`, and outside `<root>/.git` — asserted *before*
 *       creating anything, so a checked-in `tickets_dir: ../../../victim`
 *       cannot `mkdir` its way outside the board (or into `.git`) before
 *       the check meant to stop it ever runs.
 *   (b) once the (now-created) directory exists, the same containment
 *       check re-run against its `fs.realpath` — this is what catches a
 *       `tickets_dir` that is itself a symlink, which (a)'s string
 *       arithmetic cannot see.
 *
 * "Lies beneath" is a path-*component* relationship (`path.relative`),
 * never a string prefix: `resolved.startsWith(boardRoot)` is the ADR's
 * named wrong implementation, defeated by `tickets_dir: ../repo-evil/x`
 * against a root of `/home/u/repo` (`/home/u/repo-evil/x` passes a naive
 * prefix test). `isContained` below compares by component instead.
 *
 * A containment failure throws a typed `CanKanError`
 * (`BoardErrorCodes.TICKETS_DIR_ESCAPES_BOARD`) and writes nothing — see
 * each call site below for exactly what has (and has not) been created by
 * the time it can fire.
 *
 * **Gap, reported rather than improvised:** full step (c) — excluding a
 * *linked worktree's* real git directory via `git rev-parse --git-dir` /
 * `--git-common-dir` — needs git-dir discovery that only `git/index.ts`
 * (M2.6) can do, and M2.6 is not in M2.4's *Depends on* list; even with a
 * waiver, M2.6's `GitAdapter` exposes only `gitCommonDir()`, no `--git-dir`
 * equivalent. What ships instead is the reachable slice: rejecting a
 * `tickets_dir` resolving to or beneath `<root>/.git` (string form in (a),
 * realpath'd form in (b)) — which is exactly right for a main worktree and
 * is also *not wrong* for a linked worktree, since a linked worktree's real
 * git-common-dir lives outside the board root entirely and is therefore
 * already excluded by "must lie beneath root." What's missing is narrower
 * than it sounds: a `.git` *file* (not directory) inside a linked
 * worktree's root that redirects elsewhere via `gitdir:` is not specially
 * detected here, but ADR (a)/(b) already forbids `tickets_dir` from
 * resolving to anything named `.git` under `root` regardless of what that
 * entry is, so this gap has no known unblocked exploit — it is reported as
 * incomplete coverage of the ADR's literal text, not as a live escape.
 * Step (d) (ticket *filename* validation) belongs to M2.5.
 *
 * **This function creates `tickets_dir` if it does not already exist**
 * (`mkdir(..., { recursive: true })`, run only *after* check (a) passes —
 * preserving the ADR's "before creating any directory" ordering). This is
 * a scope decision the M2.4 brief left open: git does not track empty
 * directories, so a freshly cloned repo board (or a brand-new personal
 * board) legitimately has a `.cankan/config.yml` naming a `tickets_dir`
 * that does not exist on disk yet — and the canonicalization ruling above
 * requires `ticketsDir` to be realpath'd, which is impossible for a path
 * that does not exist. Centralizing the `mkdir` here, gated by check (a),
 * also keeps every containment guard in exactly one place instead of
 * partially re-derived by every future caller that might need to
 * pre-create the directory.
 *
 * **Defense-in-depth beyond the ADR's literal two steps:** between check
 * (a) and the `mkdir` call, this function also refuses to walk through an
 * *already-existing* symlinked path component (see `assertNoSymlinkComponent`
 * below). Without it, a checked-in `tickets_dir: backlog/tasks` where
 * `backlog` is itself a committed symlink (git stores symlinks as
 * mode-120000 blobs) would have `mkdir(root/backlog/tasks, { recursive:
 * true })` silently follow that symlink and materialize `tasks` outside the
 * board *before* step (b)'s post-hoc `realpath` could ever detect it — (b)
 * only catches a symlink at the final component, not an intermediate one
 * introduced during the very `mkdir` this function performs. This check is
 * a mitigation, not an atomic guarantee (a TOCTOU window remains between
 * the `lstat` walk and the `mkdir`, same caveat `config/layers.ts`'s own
 * `assertNotSymlink` documents for the identical class of check).
 */

import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { loadConfig } from "../config/index";
import { CanKanError } from "../errors";
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

/** `path.relative`-based containment: is `resolved` equal to, or beneath, `base`? */
function isContained(base: string, resolved: string): boolean {
  const rel = relative(base, resolved);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

function escapesBoardError(kind: string, root: string, configValue: string, resolved: string): CanKanError {
  return new CanKanError(
    BoardErrorCodes.TICKETS_DIR_ESCAPES_BOARD,
    `tickets_dir "${configValue}" ${kind} (board root: ${root})`,
    { details: { root, ticketsDir: configValue, resolved } },
  );
}

/**
 * Walks from `root` down to `target`'s parent chain, `lstat`-ing every
 * path component that already exists, and refuses to proceed through one
 * that is a symlink. See the file header's "Defense-in-depth" note. Only
 * inspects components that already exist on disk — anything below the
 * first missing component does not exist yet, so `mkdir(recursive: true)`
 * creates plain new directories from there down, which is exactly what
 * this check needs to allow.
 */
async function assertNoSymlinkComponent(
  kindLabel: string,
  root: string,
  target: string,
  configValue: string,
): Promise<void> {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..")) {
    // Not actually beneath root -- the caller's containment check (a) will
    // have already thrown for this case; nothing further to walk here.
    return;
  }
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch {
      // This component (and everything below it) does not exist yet --
      // safe for `mkdir` to create plain directories from here down.
      return;
    }
    if (stats.isSymbolicLink()) {
      throw escapesBoardError(
        `${kindLabel} — "${current}" is a symlinked path component`,
        root,
        configValue,
        current,
      );
    }
  }
}

export async function buildBoardRef(options: BuildBoardRefOptions): Promise<BoardRef> {
  const root = await realpath(options.root);
  const cfg = await loadConfig({ repoRoot: root, env: options.env });
  const ticketsDirConfigValue = cfg.value.tickets_dir;
  const coordinationRef = cfg.value.coordination.ref;

  const gitDir = join(root, ".git");
  const resolvedTicketsDir = resolvePath(root, ticketsDirConfigValue);

  // Step (a) -- string arithmetic, before creating anything.
  if (!isContained(root, resolvedTicketsDir)) {
    throw escapesBoardError("resolves outside the board root", root, ticketsDirConfigValue, resolvedTicketsDir);
  }
  if (isContained(gitDir, resolvedTicketsDir)) {
    throw escapesBoardError(
      "resolves inside the board's .git directory",
      root,
      ticketsDirConfigValue,
      resolvedTicketsDir,
    );
  }

  // Defense-in-depth: no existing path component between `root` and the
  // tickets dir may be a symlink (see file header).
  await assertNoSymlinkComponent("resolves through a symlinked path component", root, resolvedTicketsDir, ticketsDirConfigValue);

  await mkdir(resolvedTicketsDir, { recursive: true });

  // Step (b) -- catches a tickets_dir that is itself a symlink.
  const ticketsDir = await realpath(resolvedTicketsDir);
  if (!isContained(root, ticketsDir)) {
    throw escapesBoardError("resolves outside the board root", root, ticketsDirConfigValue, ticketsDir);
  }
  const realGitDir = await realpath(gitDir).catch(() => undefined);
  if (realGitDir !== undefined && isContained(realGitDir, ticketsDir)) {
    throw escapesBoardError(
      "resolves inside the board's .git directory",
      root,
      ticketsDirConfigValue,
      ticketsDir,
    );
  }

  return {
    kind: options.kind,
    name: options.name,
    root,
    ticketsDir,
    coordinationRef,
  };
}
