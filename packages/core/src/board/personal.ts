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

import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CanKanError } from "../errors";
import type { BoardRef } from "../types";
import { BoardErrorCodes } from "./errors";
import { buildBoardRef } from "./ref";
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

  await mkdir(dirname(rawPath), { recursive: true });

  let created = true;
  try {
    await mkdir(rawPath, { mode: 0o700 });
  } catch (err) {
    if (!isEExist(err)) throw err;
    created = false;
  }

  // F10: the personal board's `.cankan/` directory. `mkdir(recursive)` is
  // idempotent, so this is safe under concurrent callers regardless of
  // which one (if any) actually created `root` above.
  await mkdir(join(rawPath, ".cankan"), { recursive: true });

  // `buildBoardRef` is read-only (see file header): this first call only
  // learns the containment-checked, intended `ticketsDir` path -- it may
  // not exist on disk yet. Create it, then call again so the returned
  // `BoardRef.ticketsDir` is the full realpath of something that now
  // really exists (discharging ADR 0002 step (b) here).
  const probe = await buildBoardRef({ kind: "personal", name: "personal", root: rawPath, env });
  await mkdir(probe.ticketsDir, { recursive: true });
  const board = await buildBoardRef({ kind: "personal", name: "personal", root: rawPath, env });

  const needsGitInit = await lstat(join(board.root, ".git")).then(
    () => false,
    (err) => {
      if (isEnoent(err)) return true;
      throw err;
    },
  );

  return { board, created, needsGitInit };
}
