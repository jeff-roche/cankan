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
   * `register()` refused to register the personal board's own directory
   * as a repo board -- doing so would let `--board <name>` resolve a repo
   * selector to the personal board, defeating CONCEPT.md §6c's privacy
   * default.
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
} as const;
