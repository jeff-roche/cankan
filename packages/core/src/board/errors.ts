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
   * ADR 0002 (docs/decisions/0002-ids-and-backlog-compat.md, 542-630)
   * containment check (a)/(b): a board's effective `tickets_dir` escapes
   * the board root, resolves into `<root>/.git`, or is reached through a
   * symlinked intermediate path component.
   */
  TICKETS_DIR_ESCAPES_BOARD: "TICKETS_DIR_ESCAPES_BOARD",
} as const;
