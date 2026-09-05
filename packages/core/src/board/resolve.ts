/**
 * `board/resolve.ts` -- decides which directory is the board.
 * `resolveBoard({ cwd, flag })` implements PLAN.md M2.4's precedence:
 * `--board` flag > inside an inited repo > personal. `resolveAllBoards()`
 * is `--board all`'s own function (see its doc comment for why it is not
 * an overload of `resolveBoard`).
 *
 * Every `BoardRef` this file returns is built by `./ref.ts`'s
 * `buildBoardRef` or by `./personal.ts`'s `ensurePersonalBoard` -- never
 * constructed as a literal here -- so the canonicalization ruling
 * (`root`/`ticketsDir` always `fs.realpath`'d) and the read-only-resolution
 * ruling apply uniformly regardless of which precedence branch a call
 * takes.
 *
 * ## Decision (not settled by the brief): a repo board's `name` is looked up in the registry first
 * `BoardRef.name`'s own doc comment (`../types.ts`) promises "registry
 * name used by `--board <name>` and `<repo>:<id>` refs" -- one name per
 * board. A repo found by walking up from `cwd` has no name of its own to
 * report, and `basename(root)` alone would give a *registered* repo two
 * different names depending on how it was reached (`--board api` vs. `cd
 * ~/code/api-service && cankan ...`), which would make `--board all`'s
 * `<repo>:<id>` refs disagree with a same-repo, no-flag session.
 * `registeredNameFor` looks the walked root up in `repos.yml` (a registry
 * read only -- never the personal board's contents, so this costs nothing
 * against the privacy default) and falls back to `basename(root)` only for
 * a genuinely unregistered repo, which is a real, expected state
 * (`repos.auto_register` is a default a user or a repo can turn off, not a
 * guarantee).
 *
 * ## `BoardFlag` -- a closed union that cannot represent `"all"`
 * `--board personal|repo|<name>` are `resolveBoard`'s three inputs;
 * `--board all` is not a fourth. Modeled as a discriminated union rather
 * than `"personal" | "repo" | string` (which collapses to `string` --
 * TypeScript absorbs literal members into a wider one already present in
 * the same union, so it would not exclude anything) precisely so that
 * `resolveBoard({ cwd, flag: { kind: "all" } })` is a **compile-time**
 * error, not a runtime one reached only when a real `--board all` value
 * slips through. M3.1's CLI argument parser must therefore `switch` on the
 * raw `--board` string *before* ever constructing a `BoardFlag`, routing
 * `"all"` to `resolveAllBoards()` -- a compile-time obligation the type
 * system enforces, per the brief's ruling, rather than a runtime `if
 * (flag === "all") throw` this module would otherwise need.
 *
 * ## The privacy default is structural (CONCEPT.md §6c)
 * "Repo boards never read the personal board unless `--board all` is
 * passed." No branch that returns a *repo* `BoardRef` here ever calls
 * `ensurePersonalBoard()` or reads anything under the personal board's
 * directory. The one exception -- comparing the *canonical path* of a
 * walked-up `.cankan/` root against the personal board's own canonical
 * path -- is required by the addendum-2 fix below and touches only path
 * strings, never the personal board's config or tickets; see
 * `walkForBoard`'s doc comment.
 *
 * ## Addendum 2 -- the personal board's own `.cankan/` cannot be mistaken for a repo
 * The personal board lives at `$XDG_DATA_HOME/cankan/personal/` and (once
 * `ensurePersonalBoard()` has run at least once) contains a `.cankan/`
 * directory of its own -- CONCEPT.md §6c: "the personal board ... is
 * itself a git repo," with a normal repo-shaped config layer. A `cwd`
 * anywhere inside that tree makes a naive upward walk find `.cankan/` and
 * report `kind: "repo"` with a basename-derived name -- the personal
 * board, silently reclassified as an ordinary repo board, reachable by an
 * ordinary `cd`. That inverts the privacy default above: a repo board is
 * never supposed to *be* the personal board.
 *
 * Fixed by comparing the walk's found root, canonical, against
 * `realpath(resolvePersonalBoardPath(env))`, also canonical -- comparing
 * raw paths would be wrong on any host where `$TMPDIR` (or `$HOME`) itself
 * sits behind a symlink, which is real on macOS and is exactly what this
 * whole module's canonicalization ruling exists to get right everywhere.
 * When they match, this module resolves the personal board (`kind:
 * "personal"`, name `"personal"`, and -- since resolving to the personal
 * board is *always* "first use" per the ruling below -- via
 * `ensurePersonalBoard()`) instead of a repo board.
 *
 * **Decision (not settled by the brief): the same substitution applies to
 * an explicit `--board repo` request**, not only the no-flag case. A `cwd`
 * inside the personal board's own tree is not "inside an inited repo" in
 * any sense CONCEPT.md's scope-resolution rule is describing, so `--board
 * repo` from there is treated exactly like `--board repo` from outside any
 * repo at all: a visible `NOT_INSIDE_REPO_BOARD` error, never a silent
 * substitution of one board for another under an explicit selector whose
 * whole point is to name a specific board and fail loudly if it cannot.
 *
 * ## Resolving to the personal board always calls `ensurePersonalBoard()`
 * "Lazy: create on first use" (PLAN.md), and every branch that would
 * return the personal board *is* the first use from that caller's
 * perspective -- there is no other place in this module (or this
 * dispatch) that creates it first. This is also what makes the returned
 * `root` a real, canonicalizable path per the ruling above: `realpath`
 * cannot succeed against a directory that was never created.
 */

import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CanKanError, isCanKanError } from "../errors";
import type { BoardRef } from "../types";
import { BoardErrorCodes } from "./errors";
import { ensurePersonalBoard, resolvePersonalBoardPath } from "./personal";
import { buildBoardRef, isContained } from "./ref";
import { findRegisteredBoard, listRegisteredBoards } from "./registry";

/**
 * The registry's own name for a canonical repo root, if it has one --
 * never the personal board's contents, just `repos.yml`'s own reads
 * (`listRegisteredBoards`), so this costs nothing in the privacy budget.
 * A repo board found by walking up from `cwd` (no `--board <name>` in
 * play) would otherwise get a *different* `name` than the same directory
 * gets through `--board <name>` -- `BoardRef.name`'s own doc comment
 * ("registry name used by `--board <name>` and `<repo>:<id>` refs")
 * promises one name per board, not one per resolution path. Falls back to
 * `undefined` (caller uses `basename(root)`) for a genuinely unregistered
 * repo, which is a legitimate state (`repos.auto_register` is a default,
 * not a guarantee).
 *
 * Compares by **canonical** path, not the stored string: `register()`
 * canonicalizes at write time, but F11 established a hand-edited
 * `repos.yml` entry's stored `path` can still be a symlink alias to the
 * same directory `root` already is. An exact-string comparison would miss
 * that case and reintroduce the very "two names for one board" problem
 * this function exists to close, one level over from where F11 first
 * found it. Every candidate has already passed `listRegisteredBoards`'s
 * own `stat` check, so `realpath` on it cannot fail with ENOENT here.
 *
 * **F3 (fix round 1):** catches only `REGISTRY_INVALID` from
 * `listRegisteredBoards` and falls back to `undefined` (caller uses
 * `basename(root)`) rather than letting it propagate. Before this fix,
 * decision 4 made *every* no-flag and `--board repo` resolution depend on
 * `repos.yml` parsing cleanly -- a single malformed byte in the user's
 * global registry broke `cd repo && cankan status`, a command that never
 * touched the registry before this dispatch. `--board all` is unaffected:
 * it calls `listRegisteredBoards` directly (not through this function) and
 * still throws on the same malformed file, so the loud path survives; only
 * a single-repo session's *display name* degrades to `basename(root)`.
 * Every other error from `listRegisteredBoards` (a data-home resolution
 * failure, an unexpected filesystem error) still propagates -- this is
 * narrowly about a malformed *file*, not "swallow anything registry-shaped."
 */
async function registeredNameFor(root: string, env: Env): Promise<string | undefined> {
  let boards: Awaited<ReturnType<typeof listRegisteredBoards>>["boards"];
  try {
    ({ boards } = await listRegisteredBoards(env));
  } catch (err) {
    if (isCanKanError(err) && err.code === BoardErrorCodes.REGISTRY_INVALID) {
      return undefined;
    }
    throw err;
  }
  for (const entry of boards) {
    const canonical = await realpath(entry.path).catch(() => undefined);
    if (canonical === root) {
      return entry.name;
    }
  }
  return undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * F1 (fix round 1, the phase's most serious finding): true when a
 * candidate repo board `ref` actually reaches into the personal board --
 * checked by **containment**, on **both** halves, never by equality on
 * `root` alone:
 *
 * - `isContained(personalPath, ref.root)` -- `ref.root` is the personal
 *   board's own directory, or a subdirectory of it (registering the
 *   personal board's tickets directory, say, or a nested `.cankan/`
 *   somewhere inside the personal tree that an ordinary `cd` can reach).
 * - `isContained(personalPath, ref.ticketsDir)` -- `ref.root` is instead
 *   an *ancestor* of the personal board (an umbrella directory containing
 *   both), with `tickets_dir` steered to point at the personal board's own
 *   tickets directory. ADR 0002's own containment check (`ref.ts`)
 *   permits this legitimately -- `ticketsDir` truly is beneath such a
 *   `root` -- so only a check against the personal board specifically,
 *   run *after* `buildBoardRef` has resolved `ticketsDir`, can catch it.
 *
 * Refusing a root that instead *contains* the personal board (the reverse
 * relationship) is not an option -- `$HOME` is a legitimate dotfiles-board
 * root that happens to be an ancestor of `$XDG_DATA_HOME/cankan/personal/`
 * on many systems. `ticketsDir` is the precise cut for that shape; `root`
 * alone cannot be.
 */
function aliasesPersonalBoard(ref: Pick<BoardRef, "root" | "ticketsDir">, personalPath: string): boolean {
  return isContained(personalPath, ref.root) || isContained(personalPath, ref.ticketsDir);
}

/**
 * What `resolveBoard` accepts for `--board`: the two selectors, or a
 * registry name -- never `"all"` (see this file's header). A registry
 * name's shape/reserved-word validation is `registry.ts`'s
 * `isValidBoardName` (reused via `findRegisteredBoard`, never re-derived
 * here) -- an invalid or reserved `name` surfaces as that module's
 * `INVALID_BOARD_NAME`, not a `BoardFlag`-level concern.
 */
export type BoardFlag =
  | { readonly kind: "personal" }
  | { readonly kind: "repo" }
  | { readonly kind: "name"; readonly name: string };

export interface ResolveBoardOptions {
  /** The directory to resolve a board from. Must exist -- see `CWD_NOT_FOUND` below. */
  readonly cwd: string;
  /** `--board personal|repo|<name>`. Omitted: inside an inited repo > personal. */
  readonly flag?: BoardFlag;
  /** Passed through to every path/config read this function makes; defaults to `process.env`. */
  readonly env?: Env;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * `fs.realpath(cwd)`, rethrown as a typed, path-naming error on `ENOENT`
 * (or on anything else -- F4, fix round 1: a symlink cycle, `ELOOP`, or an
 * unreadable ancestor, `EACCES`, must not reach a caller as a raw platform
 * error either, the same taxonomy discipline `TICKETS_DIR_INVALID` and the
 * internal `LockLostError` already apply elsewhere in this module).
 *
 * This `realpath` is **load-bearing**, not merely a nicety: `buildBoardRef`
 * independently realpaths `root` as its own first statement, so a bug here
 * would still produce a canonical `BoardRef.root` and hide behind that
 * safety net -- but `walkForBoard`'s personal-tree comparison and
 * `registeredNameFor`'s canonical-name lookup both compare *this*
 * function's return value directly, before `buildBoardRef` ever runs, and
 * neither has a safety net of its own. A `cwd` reached through a symlink
 * to the personal board's own root must classify as `kind: "personal"`,
 * not `"repo"` -- that only holds if this function actually canonicalizes.
 *
 * **Never falls through to personal on failure** -- ruling: an
 * unresolvable `cwd` must be a visible error, the same reasoning as the
 * privacy-default rulings elsewhere in this file.
 */
async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch (err) {
    if (isEnoent(err)) {
      throw new CanKanError(BoardErrorCodes.CWD_NOT_FOUND, `cwd does not exist: ${cwd}`, { details: { cwd } });
    }
    throw new CanKanError(BoardErrorCodes.CWD_UNRESOLVABLE, `cwd could not be resolved: ${cwd}`, {
      cause: err,
      details: { cwd },
    });
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The personal board's own canonical path, or `undefined` when it cannot
 * be resolved (no data home) or does not exist yet on disk. A local copy
 * of `registry.ts`'s private `resolveCanonicalPersonalPath` (not exported
 * from that file, and this module has no other reason to import it) --
 * same five lines, same reasoning: `resolvePersonalBoardPath` gives the
 * raw XDG-derived path, `realpath` is what makes it comparable to another
 * canonical path at all.
 */
async function canonicalPersonalPath(env: Env): Promise<string | undefined> {
  const raw = resolvePersonalBoardPath(env);
  if (!raw) return undefined;
  try {
    return await realpath(raw);
  } catch {
    return undefined;
  }
}

type WalkResult = { readonly kind: "repo"; readonly root: string } | { readonly kind: "personal-tree" };

/**
 * Walks upward from `startDir` (already canonical) looking for a `.cankan/`
 * directory, stopping at the filesystem root rather than looping
 * (`dirname("/") === "/"`). Returns `undefined` when no inited repo is
 * found at all.
 *
 * When one *is* found, its canonical root is compared against the personal
 * board's own canonical path (addendum 2, this file's header) -- a path
 * comparison only, never a read of the personal board's config or
 * tickets, so this does not violate the privacy default even though it
 * runs on every no-flag and `--board repo` resolution. **By containment,
 * not equality** (F1, fix round 1): a nested `.cankan/` somewhere *inside*
 * the personal tree (`mkdir -p <personal>/proj/.cankan`, then `cd` there)
 * is exactly as much "the personal board" as its own root is -- an
 * exact-`===` check only caught a `cwd` at the personal board's literal
 * root and let this shape through as an ordinary repo board, basename
 * name and all. A match reports `"personal-tree"` instead of `"repo"` so
 * both callers below can treat "inside the personal board's own
 * directory" as "not a repo," each according to its own precedence rule.
 *
 * This closes the *root* half of F1's alias check for every cwd-based
 * resolution. It does not (and cannot) see the *`tickets_dir`* half --
 * a `.cankan/` found here whose own config steers `tickets_dir` into the
 * personal board (this walk's `root` an *ancestor* of the personal board)
 * looks perfectly ordinary at this stage, since nothing about `current`
 * itself is contained in `personalPath`. `resolveBoard` re-checks that
 * half itself, after `buildBoardRef` has resolved `ticketsDir` -- see
 * `aliasesPersonalBoard`.
 */
async function walkForBoard(startDir: string, env: Env): Promise<WalkResult | undefined> {
  let current = startDir;
  for (;;) {
    if (await isDirectory(join(current, ".cankan"))) {
      const personalPath = await canonicalPersonalPath(env);
      if (personalPath !== undefined && isContained(personalPath, current)) {
        return { kind: "personal-tree" };
      }
      return { kind: "repo", root: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Resolves which directory is the board, precedence `--board` flag >
 * inside an inited repo > personal (PLAN.md M2.4). See this file's header
 * for the `BoardFlag` union, the privacy default, and the addendum-2
 * personal-tree fix that every branch below routes through.
 */
export async function resolveBoard(options: ResolveBoardOptions): Promise<BoardRef> {
  const env = options.env ?? process.env;
  const cwd = await canonicalCwd(options.cwd);
  const flag = options.flag;

  if (flag?.kind === "personal") {
    return (await ensurePersonalBoard({ env })).board;
  }

  if (flag?.kind === "name") {
    // Reuses registry.ts's own name validation and "registered but gone"
    // distinction (BOARD_DIRECTORY_MISSING) wholesale -- never re-derived
    // here (addendum 3).
    const entry = await findRegisteredBoard(flag.name, env);
    if (entry === undefined) {
      throw new CanKanError(BoardErrorCodes.BOARD_NOT_REGISTERED, `no board named "${flag.name}" is registered`, {
        details: { name: flag.name },
      });
    }
    const ref = await buildBoardRef({ kind: "repo", name: entry.name, root: entry.path, env });
    // `register()`/`listRegisteredBoards()` refuse a registry entry whose
    // *root* is contained in the personal board (registry.ts's F7, now
    // containment-based -- F1), but neither of those checks can see a
    // symlink alias to the personal board (only `buildBoardRef`'s
    // canonicalization reveals it) or a `tickets_dir`-based alias from a
    // registered *ancestor* of the personal board (only knowable once
    // `buildBoardRef` has resolved `ticketsDir`) -- both closed here,
    // after building, rather than left to leak an explicit repo selector
    // into the personal board.
    const personalPath = await canonicalPersonalPath(env);
    if (personalPath !== undefined && aliasesPersonalBoard(ref, personalPath)) {
      throw new CanKanError(
        BoardErrorCodes.REGISTERED_BOARD_IS_PERSONAL,
        `board "${flag.name}" resolves into the personal board; a registry entry cannot alias it -- use "--board personal" instead`,
        // F5: no path in details -- the path in question is the personal
        // board's own location, which this error must not publish.
        { details: { name: flag.name } },
      );
    }
    return ref;
  }

  const walked = await walkForBoard(cwd, env);

  if (flag?.kind === "repo") {
    if (walked?.kind !== "repo") {
      // Ruling (this file's header, not settled by the brief): a cwd
      // inside the personal board's own tree is treated the same as "no
      // repo found at all" for an explicit `--board repo` request -- never
      // a silent substitution of the personal board for a repo board.
      throw new CanKanError(
        BoardErrorCodes.NOT_INSIDE_REPO_BOARD,
        `"--board repo" requires an inited repo board; ${cwd} is not inside one`,
        { details: { cwd } },
      );
    }
    const name = (await registeredNameFor(walked.root, env)) ?? basename(walked.root);
    const ref = await buildBoardRef({ kind: "repo", name, root: walked.root, env });
    // F1: `walked.kind === "repo"` only ruled out the *root* half of the
    // alias check (walkForBoard's own containment test, above) -- this
    // repo's own `tickets_dir` can still be steered into the personal
    // board when `walked.root` is an ancestor of it. Same disposition as
    // "not inside a repo board at all": an explicit `--board repo` request
    // must fail loudly, never silently substitute the personal board.
    const personalPath = await canonicalPersonalPath(env);
    if (personalPath !== undefined && aliasesPersonalBoard(ref, personalPath)) {
      throw new CanKanError(
        BoardErrorCodes.NOT_INSIDE_REPO_BOARD,
        `"--board repo" requires an inited repo board; ${cwd} is not inside one`,
        { details: { cwd } },
      );
    }
    return ref;
  }

  // No flag: inside an inited repo > personal.
  if (walked?.kind === "repo") {
    const name = (await registeredNameFor(walked.root, env)) ?? basename(walked.root);
    const ref = await buildBoardRef({ kind: "repo", name, root: walked.root, env });
    // F1: same `tickets_dir`-ancestor shape as the `--board repo` branch
    // above, but for the no-flag path a disqualified "repo" simply isn't
    // usable as one -- precedence falls through to personal, the same
    // disposition `walkForBoard`'s own personal-tree classification
    // already gets for the root-level shape.
    const personalPath = await canonicalPersonalPath(env);
    if (personalPath !== undefined && aliasesPersonalBoard(ref, personalPath)) {
      return (await ensurePersonalBoard({ env })).board;
    }
    return ref;
  }
  return (await ensurePersonalBoard({ env })).board;
}

// ---------------------------------------------------------------------------
// `--board all`
// ---------------------------------------------------------------------------

/** One registry entry `resolveAllBoards` could not include, and why. */
export interface SkippedBoard {
  readonly name: string;
  readonly path: string;
  readonly reason: string;
}

/**
 * The result of `resolveAllBoards()`: every board it could resolve, plus
 * every registry entry it could not, with a reason -- never a bare
 * `BoardRef[]` (ruling: a registry entry pointing at a directory that no
 * longer exists, or whose `.cankan/config.yml` fails to load, must not
 * break the aggregate view for every other board, and silently dropping a
 * board from it is a correctness hazard the CLI must be able to warn
 * about).
 */
export interface AllBoardsResult {
  readonly boards: readonly BoardRef[];
  readonly skipped: readonly SkippedBoard[];
}

export interface ResolveAllBoardsOptions {
  readonly env?: Env;
}

function describeFailure(err: unknown): string {
  return isCanKanError(err) || err instanceof Error ? err.message : String(err);
}

/**
 * `--board all`: the personal board plus every *registered* repo board
 * (CONCEPT.md §6c). Its own function with its own return type, not an
 * overload of `resolveBoard` and not a third `BoardKind` -- `BoardKind` is
 * frozen at `"repo" | "personal"` (M2.1) precisely because `"all"` is not
 * a kind, and every caller of the singular `resolveBoard` would otherwise
 * have to handle a list-shaped result it can never actually receive.
 *
 * **Membership is literally "the personal board plus every registered
 * repo board."** The cwd's own repo is not included unless it is
 * registered -- `init` registers by default (`repos.auto_register`), so an
 * unregistered repo is a deliberate state this function must not paper
 * over. There is accordingly no `cwd` parameter here at all.
 *
 * The personal board is resolved via `ensurePersonalBoard()` and its
 * failure is **not** caught -- an unresolvable data home is a systemic
 * condition, not "one bad registry entry," so it propagates rather than
 * being folded into `skipped`.
 *
 * Each registered entry is built into a full `BoardRef` here (not just
 * read from the registry) because a *registered* entry can still fail at
 * `buildBoardRef` time -- ADR 0002's containment check
 * (`TICKETS_DIR_ESCAPES_BOARD`), an unrepresentable `tickets_dir`
 * (`TICKETS_DIR_INVALID`), or a broken `.cankan/config.yml`
 * (`INVALID_CONFIG`) -- none of which `listRegisteredBoards()` itself can
 * see (it only checks that the directory exists). One such failure is
 * reported in `skipped` with the underlying error's own message as the
 * reason; it never aborts the rest of the aggregation.
 *
 * **Every entry is checked against the personal board by containment
 * (`aliasesPersonalBoard`, F1) before the plain canonical-root dedupe
 * runs** -- a registered subdirectory of the personal board, a symlink
 * alias to it, or a registered ancestor with `tickets_dir` steered into it
 * would not collide with the personal board's own *exact* root the way a
 * plain `seenRoots` check alone would need. **Deduped by canonical root**
 * otherwise, seeded with the personal board's own root before any registry
 * entry is examined: two registry entries reaching one *other* directory
 * through different paths (a symlink alias between two ordinary repo
 * boards) are one board.
 */
export async function resolveAllBoards(options: ResolveAllBoardsOptions = {}): Promise<AllBoardsResult> {
  const env = options.env ?? process.env;

  const personal = await ensurePersonalBoard({ env });
  const boards: BoardRef[] = [personal.board];
  const skipped: SkippedBoard[] = [];
  const seenRoots = new Set<string>([personal.board.root]);

  const { boards: registered, skipped: registrySkips } = await listRegisteredBoards(env);
  for (const entry of registrySkips) {
    skipped.push({ name: entry.name, path: entry.path, reason: entry.reason });
  }

  for (const entry of registered) {
    let ref: BoardRef;
    try {
      ref = await buildBoardRef({ kind: "repo", name: entry.name, root: entry.path, env });
    } catch (err) {
      skipped.push({ name: entry.name, path: entry.path, reason: describeFailure(err) });
      continue;
    }
    // F1 (fix round 1): checked by containment on both `root` and
    // `ticketsDir` (`aliasesPersonalBoard`), not by `ref.root ===
    // personal.board.root` -- a registered *subdirectory* of the personal
    // board, a symlink alias to it, or a registered *ancestor* with
    // `tickets_dir` steered into it all reach the personal board without
    // `ref.root` ever equaling it exactly. Checked before the dedupe check
    // below, since none of those shapes would otherwise collide with
    // `seenRoots` (which is seeded only with the personal board's own
    // exact root).
    if (aliasesPersonalBoard(ref, personal.board.root)) {
      skipped.push({ name: entry.name, path: entry.path, reason: "is the personal board" });
      continue;
    }
    if (seenRoots.has(ref.root)) {
      skipped.push({
        name: entry.name,
        path: entry.path,
        reason: `duplicate of another board already at this canonical root (${ref.root})`,
      });
      continue;
    }
    seenRoots.add(ref.root);
    boards.push(ref);
  }

  return { boards, skipped };
}
