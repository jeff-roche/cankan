/**
 * `board/index.ts` -- the public surface of M2.4 (board resolver and repo
 * registry). Follows `config/index.ts`'s doc-comment discipline: re-export
 * exactly what downstream lanes (M2.5, M2.8, M2.14, M3.1, M3.2) need,
 * nothing else. Internals stay internal:
 *
 * - `board/ref.ts`'s `buildBoardRef` is **not** exported. Every `BoardRef`
 *   a caller can obtain from this module already went through it (via
 *   `resolveBoard`, `resolveAllBoards`, or `ensurePersonalBoard`) --
 *   exporting the builder directly would let a caller construct a
 *   `BoardRef` from an arbitrary directory, bypassing the
 *   canonicalization and ADR 0002 containment rulings that every other
 *   path here enforces.
 * - `board/xdg.ts`'s `resolveDataHome` is **not** exported -- it is a
 *   shared building block for `registry.ts` and `personal.ts`'s own
 *   XDG-rooted paths, not part of the public surface (see that file's own
 *   header).
 *
 * `BoardRef` and `BoardKind` themselves live in `../types.ts` (M2.1) and
 * are already re-exported flat from the package root -- this file does not
 * re-export them again.
 */

import type { ConfigResult } from "../config/index";
import { loadConfig } from "../config/index";
import type { BoardRef } from "../types";

// ---- resolution: which directory is the board -----------------------------
export type {
  AllBoardsResult,
  BoardFlag,
  ResolveAllBoardsOptions,
  ResolveBoardOptions,
  SkippedBoard,
} from "./resolve";
export { resolveAllBoards, resolveBoard } from "./resolve";

// ---- the personal board: XDG path + lazy creation --------------------------
export type { EnsurePersonalBoardOptions, EnsurePersonalBoardResult } from "./personal";
export { ensurePersonalBoard, resolvePersonalBoardPath } from "./personal";

// ---- the repo registry (repos.yml): register() + the reads --board <name>/all need ----
export type { RegistryEntry, RegistryListing, SkippedRegistryEntry } from "./registry";
export {
  findRegisteredBoard,
  isValidBoardName,
  listRegisteredBoards,
  register,
  resolveRegistryPath,
} from "./registry";

// ---- this module's own error codes -----------------------------------------
export { BoardErrorCodes } from "./errors";

// ---- shared path-safety primitive (1B, Ruling R5) ---------------------------
// `isContained` is `board/ref.ts`'s own containment test -- path-component
// semantics, never a string prefix (see that file's F1 finding). Exported
// here, not from `ref.ts` directly (which stays internal, see the file
// header above), so M2.5's `store/` can reuse it for ADR 0002 step (c)
// (excluding the repository's real git directory) instead of growing a
// second copy that could drift from this one or reopen F1's prefix bug.
export { isContained } from "./ref";

// ---- the M2.3 wire: config layers -> the resolved board --------------------

export interface LoadBoardConfigOptions {
  /** Passed through to `loadConfig`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * PLAN.md M2.4's `Wires`: "config layers (M2.3) to the resolved board (a
 * board's `.cankan/config.yml` is the 'repo' layer for that board)." Named
 * and public, deliberately, rather than left as "callers remember to pass
 * `board.root` as `repoRoot` themselves" -- a caller that instead passes
 * `cwd` here (or forgets `repoRoot` entirely) silently reads a *different*
 * board's policy, or none at all, and nothing about `loadConfig`'s own
 * signature stops that.
 *
 * `board.root` is already the canonicalized root every `BoardRef` in this
 * module carries (see the canonicalization ruling in `resolve.ts`/`ref.ts`),
 * so this is the config for *this* board specifically: the personal
 * board's own `.cankan/config.yml` for a personal `BoardRef`, the cwd's
 * repo's for one resolved with no flag or `--board repo`, and a
 * *different* repo's entirely for one resolved via `--board <name>` --
 * never the cwd's, regardless of where the caller happens to be running
 * from.
 */
export function loadBoardConfig(board: BoardRef, options: LoadBoardConfigOptions = {}): Promise<ConfigResult> {
  return loadConfig({ repoRoot: board.root, env: options.env });
}
