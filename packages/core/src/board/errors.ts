/**
 * `board/errors.ts` — this module's own error codes, declared inside
 * `board/` rather than appended to the shared `src/errors.ts` (Global
 * Constraint 4; mirrors `config/errors.ts`'s own rationale).
 */
export const BoardErrorCodes = {
  /**
   * A board name fails the opaque-identifier shape rule, or is one of the
   * reserved selectors `personal` / `repo` / `all` — see
   * `isValidBoardName` in `registry.ts`. Raised by `register()` and by the
   * name-lookup reads alike, so a reserved or malformed name is rejected
   * the same way on write and on read.
   */
  INVALID_BOARD_NAME: "INVALID_BOARD_NAME",
  /**
   * `register()`'s upsert-by-canonical-path rule: the requested name is
   * already bound, in the registry, to a *different* canonical path.
   */
  BOARD_NAME_TAKEN: "BOARD_NAME_TAKEN",
  /** `repos.yml` exists but failed to read, parse, or schema-validate. */
  REGISTRY_INVALID: "REGISTRY_INVALID",
  /**
   * Two `register()` calls contended for the registry's lockfile longer
   * than the bounded retry window allows.
   */
  REGISTRY_LOCK_TIMEOUT: "REGISTRY_LOCK_TIMEOUT",
  /** Neither `XDG_DATA_HOME` nor `HOME` resolved to an absolute path. */
  DATA_HOME_UNRESOLVABLE: "DATA_HOME_UNRESOLVABLE",
  /**
   * `findRegisteredBoard()` found the requested name in the registry, but
   * its directory no longer exists (or is no longer a directory) --
   * distinct from "not registered at all" (which resolves to
   * `undefined`), so a caller can tell a stale registration from a typo.
   */
  BOARD_DIRECTORY_MISSING: "BOARD_DIRECTORY_MISSING",
  /**
   * ADR 0002 (docs/decisions/0002-ids-and-backlog-compat.md, 542-630)
   * containment check (a)/(b): a board's effective `tickets_dir` escapes
   * the board root, resolves into `<root>/.git`, or is reached through a
   * symlinked intermediate path component.
   */
  TICKETS_DIR_ESCAPES_BOARD: "TICKETS_DIR_ESCAPES_BOARD",
  /**
   * `tickets_dir` is a value the filesystem itself cannot represent (an
   * embedded NUL byte, a component long enough to trip `ENAMETOOLONG`,
   * ...). `tickets_dir` is deliberately unvalidated by `config/schema.ts`
   * -- ADR 0002 assigns this class of check to `board/ref.ts` -- so this
   * is where a raw platform error (a `TypeError`, or a bare `Error` with
   * `code: "ENAMETOOLONG"`) gets wrapped into something
   * `isCanKanError`/M3.10's exit-code map can see.
   */
  TICKETS_DIR_INVALID: "TICKETS_DIR_INVALID",
  /**
   * `register()` refused to register the personal board's own directory,
   * or a subdirectory of it (fix round 1, F1 -- containment, not just
   * exact-root equality), as a repo board -- doing so would let
   * `--board <name>` resolve a repo selector to (or into) the personal
   * board, defeating CONCEPT.md §6c's privacy default.
   */
  CANNOT_REGISTER_PERSONAL_BOARD: "CANNOT_REGISTER_PERSONAL_BOARD",
  /**
   * `register()` repeatedly lost the registry lock to another process
   * mid-write (its `assertStillHeld` check kept failing) and exhausted
   * `MAX_LOCK_LOST_RETRIES`. Distinct from `REGISTRY_LOCK_TIMEOUT`, which
   * is "never acquired the lock at all" -- this is "held it, then lost it,
   * repeatedly, before ever publishing a write."
   */
  REGISTRY_LOCK_LOST: "REGISTRY_LOCK_LOST",
  /**
   * `resolveBoard()`'s `cwd` does not exist (`fs.realpath` failed
   * `ENOENT`). Never falls through to the personal board for this --
   * CONCEPT.md §6c's privacy default means an unresolvable, explicitly
   * requested location must be a visible error, not a silent
   * reclassification into "the user's private board."
   */
  CWD_NOT_FOUND: "CWD_NOT_FOUND",
  /**
   * `resolveBoard()`'s `cwd` exists but `fs.realpath` still failed for
   * some other reason (a symlink cycle -- `ELOOP` -- or a permission
   * failure on an ancestor -- `EACCES`, say). Distinct from
   * `CWD_NOT_FOUND` (fix round 1, F4): without this, either raw platform
   * error reaches a caller untyped, `isCanKanError` false, invisible to
   * M3.10's exit-code map -- the same taxonomy hole already closed for
   * `TICKETS_DIR_INVALID` (`ref.ts`) and the internal `LockLostError`
   * (`registry.ts`).
   */
  CWD_UNRESOLVABLE: "CWD_UNRESOLVABLE",
  /**
   * `resolveBoard({ flag: { kind: "repo" } })` was called from a `cwd` that
   * is not inside an inited repo board -- including a `cwd` inside the
   * personal board's own tree, which the addendum-2 privacy fix excludes
   * from counting as "a repo" for this purpose too. An explicit `--board
   * repo` request must fail visibly rather than silently fall through to
   * the personal board (same reasoning CONCEPT.md §6c's privacy default
   * applies to the no-flag case).
   */
  NOT_INSIDE_REPO_BOARD: "NOT_INSIDE_REPO_BOARD",
  /**
   * `resolveBoard({ flag: { kind: "name", name } })` found no registry
   * entry for `name` at all. Distinct from `BOARD_DIRECTORY_MISSING`
   * (`registry.ts`), which is "registered, but its directory vanished" --
   * this is "never registered in the first place."
   */
  BOARD_NOT_REGISTERED: "BOARD_NOT_REGISTERED",
  /**
   * `resolveBoard({ flag: { kind: "name", name } })` found a registered
   * entry that reaches into the personal board -- either its root does, or
   * (fix round 1, F1) its `tickets_dir` does, which ADR 0002's own
   * containment check permits legitimately when the registered root is an
   * *ancestor* of the personal board and `tickets_dir` is steered to point
   * inside it. `register()`/`listRegisteredBoards()` refuse the root-level
   * shape at write/list time by containment (`CANNOT_REGISTER_PERSONAL_BOARD`,
   * `registry.ts`'s "is the personal board" skip -> this same code via
   * `findRegisteredBoard`), but neither of those checks can see a symlink
   * alias (only `buildBoardRef`'s canonicalization reveals it) or a
   * `tickets_dir`-based alias (only knowable after `buildBoardRef` builds
   * the ref) -- both caught in `resolve.ts` instead, after building.
   */
  REGISTERED_BOARD_IS_PERSONAL: "REGISTERED_BOARD_IS_PERSONAL",
} as const;
