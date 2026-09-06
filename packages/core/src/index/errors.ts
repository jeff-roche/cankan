/**
 * Module-local error codes for `index/` (M2.14, the SQLite index cache),
 * per `../errors.ts`'s file-level comment: `CanKanError.code` is a plain,
 * open `string`, and a code specific to one module's domain is declared in
 * that module's own folder rather than in the shared `errors.ts` --
 * mirroring `state/errors.ts`, `store/errors.ts` and `events/errors.ts`.
 *
 * **Prefixed `INDEX_`**, following `state/`'s, `store/`'s and `events/`'s
 * own prefix convention.
 *
 * Every `details` value attached to one of these codes is something this
 * module itself chose -- never raw ticket/event content, and never a
 * filesystem path derived from `$HOME`/`$XDG_CACHE_HOME` (`../errors.ts`'s
 * `details` discipline: those values are not this module's to publish).
 *
 * **What is deliberately absent from this list**: `db.ts`'s whole
 * "index is a cache" design (`openIndex`'s doc comment) means a corrupt,
 * truncated, stale or version-mismatched *file* never raises any of these
 * -- it degrades to a rebuild (`IndexDiscardReason`), which is data, not
 * an error. Every code below fires only for a genuinely unusable
 * *environment*, an invalid caller argument, or a cache that was opened
 * but never reindexed.
 */
export const IndexErrorCodes = {
  /**
   * `OpenIndexOptions.boardKey` (or `indexPathFor`'s own `boardKey`
   * argument) was the empty string. R2: `boardKey` is an opaque,
   * caller-supplied string that MUST be single-sourced from
   * `adapter.gitCommonDir()`; an empty key would silently collapse every
   * board onto the same cache file -- the same emptiness-bypass shape
   * M2.5's `gitDirs: []` defect had, refused here up front rather than
   * risked.
   */
  INVALID_BOARD_KEY: "INDEX_INVALID_BOARD_KEY",
  /**
   * Neither `env.XDG_CACHE_HOME` (absolute) nor `env.HOME` (making
   * `$HOME/.cache` absolute) yielded a usable cache directory. Never
   * falls back to a `process.cwd()`-relative path -- two invocations from
   * different working directories would then disagree about where the
   * cache lives.
   */
  CACHE_DIR_UNAVAILABLE: "INDEX_CACHE_DIR_UNAVAILABLE",
  /**
   * `mkdir`, `lstat` or `unlink` on the cache directory or the index file
   * itself failed for a reason other than "does not exist" -- `EACCES`,
   * `EROFS`, a symlink cycle (`ELOOP`), and the like. A genuinely
   * unusable environment, not a bad file -- distinct from every
   * `IndexDiscardReason`, none of which this module can recover from by
   * rebuilding.
   */
  CACHE_PATH_UNAVAILABLE: "INDEX_CACHE_PATH_UNAVAILABLE",
  /**
   * Something is already sitting at the index file's path and it is a
   * **directory**. `db.ts`'s open sequence unlinks a non-regular-file
   * (symlink/FIFO/socket) it finds there and rebuilds through it, but a
   * directory is refused loudly instead -- recursively deleting a
   * directory a local attacker (or a confused prior run) planted at a
   * predictable, SHA-256'd cache path is not a risk this module takes on
   * the caller's behalf.
   */
  CACHE_PATH_IS_DIRECTORY: "INDEX_CACHE_PATH_IS_DIRECTORY",
  /**
   * `queryTickets`/`queryBoardState` was called on a `BoardIndex` whose
   * `cankan_meta` has no `built_at_ms` row -- i.e. the file was opened
   * (freshly created or just rebuilt) but `reindex()` has never run
   * against it. Structural enforcement (controller addendum A1): without
   * this check, a query against a brand-new empty schema would silently
   * report "empty board" for a board that may hold thousands of tickets
   * -- a wrong answer, not merely a stale one, and the one failure mode
   * `db.ts`'s "index is a cache" rule exists to rule out. The caller's
   * remedy is exactly what `BoardIndex.rebuilt` already told them:
   * `reindex()` before querying.
   */
  NOT_BUILT: "INDEX_NOT_BUILT",
  /**
   * `TicketQuery.limit` was not a non-negative safe integer. Every value
   * in a query reaches SQLite through a bound parameter (never string
   * interpolation) regardless, so this is not an injection defence --
   * it is refusing a caller argument (`-1`, `1.5`, `NaN`, `Infinity`)
   * whose effect on a SQL `LIMIT` clause would be surprising rather than
   * validated up front.
   */
  INVALID_QUERY_LIMIT: "INDEX_INVALID_QUERY_LIMIT",
  /** Same as `INVALID_QUERY_LIMIT`, for `TicketQuery.offset`. */
  INVALID_QUERY_OFFSET: "INDEX_INVALID_QUERY_OFFSET",
  /**
   * `reindex()`'s write transaction threw. Reindexing is derived-data
   * maintenance over a caller-supplied `BoardState`, not a read of
   * untrusted file contents -- a failure here (a `STRICT` type mismatch
   * the fold's own contract should have prevented, a disk-full write,
   * and the like) is a programming error or a genuine I/O failure, never
   * one of `IndexDiscardReason`'s "the file's contents are bad" cases, so
   * it is surfaced as a typed error rather than absorbed into a rebuild.
   */
  REINDEX_FAILED: "INDEX_REINDEX_FAILED",
} as const;
