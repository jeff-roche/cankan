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
import { buildBoardRef } from "./ref";
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
 */
async function registeredNameFor(root: string, env: Env): Promise<string | undefined> {
  const { boards } = await listRegisteredBoards(env);
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
 * `fs.realpath(cwd)`, rethrown as a typed, path-naming error on `ENOENT`.
 * Doubles as the mandatory symlink-canonicalization step: a `cwd` reached
 * through a symlink resolves to the same canonical directory the rest of
 * this module (and `buildBoardRef`) compares against.
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
    throw err;
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
 * runs on every no-flag and `--board repo` resolution. A match reports
 * `"personal-tree"` instead of `"repo"` so both callers below can treat
 * "inside the personal board's own directory" as "not a repo," each
 * according to its own precedence rule.
 */
async function walkForBoard(startDir: string, env: Env): Promise<WalkResult | undefined> {
  let current = startDir;
  for (;;) {
    if (await isDirectory(join(current, ".cankan"))) {
      const personalPath = await canonicalPersonalPath(env);
      if (personalPath !== undefined && current === personalPath) {
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
    // `register()`/`listRegisteredBoards()` refuse an *exact* stored-path
    // match against the personal board (registry.ts's F7), but a
    // hand-edited `repos.yml` entry reaching the personal board through a
    // symlink alias passes that string check and only becomes visible once
    // `buildBoardRef` has canonicalized it -- the same class of gap
    // addendum 2 closes for the cwd walk, here for the `--board <name>`
    // path instead. Caught here rather than left to leak an explicit repo
    // selector into the personal board.
    const personalPath = await canonicalPersonalPath(env);
    if (personalPath !== undefined && ref.root === personalPath) {
      throw new CanKanError(
        BoardErrorCodes.REGISTERED_BOARD_IS_PERSONAL,
        `board "${flag.name}" resolves to the personal board (${ref.root}); a registry entry cannot alias it -- use "--board personal" instead`,
        { details: { name: flag.name, path: ref.root } },
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
    return buildBoardRef({ kind: "repo", name, root: walked.root, env });
  }

  // No flag: inside an inited repo > personal.
  if (walked?.kind === "repo") {
    const name = (await registeredNameFor(walked.root, env)) ?? basename(walked.root);
    return buildBoardRef({ kind: "repo", name, root: walked.root, env });
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
 * **Deduped by canonical root**, seeded with the personal board's own
 * root before any registry entry is examined: two registry entries
 * reaching one directory through different paths (a symlink alias) are one
 * board, and this also catches a hand-edited registry entry that reaches
 * the personal board's directory through a path `registry.ts`'s own
 * string-equality check did not recognize as such (`listRegisteredBoards`
 * only skips an *exact* stored-path match; a symlinked alias is caught
 * here instead, once `buildBoardRef` has canonicalized it).
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
    if (seenRoots.has(ref.root)) {
      // Distinguish "aliases the personal board" from "aliases another
      // repo board already in this result" -- same wording registry.ts's
      // own F7 skip uses, so the reason means the same thing wherever a
      // caller sees it.
      const reason =
        ref.root === personal.board.root
          ? "is the personal board"
          : `duplicate of another board already at this canonical root (${ref.root})`;
      skipped.push({ name: entry.name, path: entry.path, reason });
      continue;
    }
    seenRoots.add(ref.root);
    boards.push(ref);
  }

  return { boards, skipped };
}
