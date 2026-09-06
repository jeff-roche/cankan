/**
 * `index/index.ts` -- the public surface of M2.14 (the SQLite index
 * cache). Follows `state/index.ts`'s / `board/index.ts`'s doc-comment
 * discipline: re-export exactly what downstream lanes need, nothing else.
 *
 * The package root (`src/index.ts`, frozen, owned by M2.1) re-exports this
 * file as `export * as index from "./index/index"` -- note the explicit
 * `./index/index` specifier: from inside `src/index.ts`, the bare
 * specifier `"./index"` would resolve to that very file, not to this
 * folder, which is why the longer form exists.
 *
 * ---- open / probe / discard-and-rebuild -----------------------------------
 *
 * `openIndex`, `indexPathFor`, `INDEX_SCHEMA_VERSION` -- `db.ts`'s
 * lifecycle for one board's cache file at
 * `<cacheHome>/cankan/<sha256hex(boardKey)>.db`. `openIndex` never throws
 * because of the file's own contents (corrupt, truncated, stale, or
 * wrong-schema-version all degrade to a rebuild -- see `BoardIndex.rebuilt`
 * / `IndexDiscardReason`); it only throws for a genuinely unusable
 * environment. `boardKey` is an **opaque, caller-supplied string** -- see
 * `OpenIndexOptions.boardKey`'s own doc comment for the single-sourcing
 * rule (R2, the D20 defence) this module depends on its callers to honour,
 * since `index/` itself cannot import `git/`, `board/` or `events/` to
 * derive or validate it.
 *
 * `rebuildIndex` -- fix round 1, S2: the recovery primitive for
 * `IndexErrorCodes.CORRUPT`, the error `queryTickets`/`queryBoardState`/
 * `reindex` raise for page-level corruption `openIndex`'s own probe
 * cannot see (it only reads page 1). Closes the handle, discards the file
 * and its sidecars, and returns a fresh, empty `BoardIndex` the caller
 * must `reindex()` before querying again -- see `rebuildIndex`'s own doc
 * comment for the full recovery sequence and why this lives in `db.ts`
 * rather than `query.ts`/`reindex.ts` self-healing.
 *
 * ---- full rebuild from an already-folded `BoardState` ---------------------
 *
 * `reindex` -- **takes a `BoardState` the caller already folded** (via
 * `state/`'s `observeAndFold`), never a ticket file or the event log
 * itself (R1, controller ruling -- `PLAN.md:288`'s "store + event log"
 * text is wrong and this module does not follow it; see `reindex.ts`'s own
 * file comment for the full argument). This is also what makes every
 * query below exact rather than a second, independently-drifting reader
 * of the same tickets/events.
 *
 * ---- filtered reads that reconstruct the fold's own answer ---------------
 *
 * `queryTickets`, `queryBoardState` -- read-only views over whatever
 * `reindex` last wrote, reconstructing `TicketState`/`BoardState` values
 * exact enough to be interchangeable with `state/`'s own fold output (see
 * `query.ts`'s own comment). Both throw `IndexErrorCodes.NOT_BUILT` if
 * `reindex` has never run against the `BoardIndex` handed in -- an opened
 * cache that has not been reindexed yet must never silently answer "empty
 * board" for a board that may hold thousands of tickets.
 *
 * **`blockedBy` is not re-exported here and has no equivalent in this
 * module.** R4: reproducing its alias/display-id dependency resolution in
 * SQL would need `buildIdentifierIndex`, which `index/`'s `Depends on`
 * (M2.8's `state/` alone) does not include -- reimplementing it here would
 * be exactly the two-independent-readers divergence risk R1 exists to
 * kill. `TicketState.deps` is stored and read back verbatim instead
 * (`query.ts`'s own comment): a caller who needs `blockedBy` calls
 * `queryBoardState` to get an exact `BoardState`, then calls
 * `state/`'s own `blockedBy` on it directly.
 *
 * ---- this module's own error codes ----------------------------------------
 *
 * `IndexErrorCodes` -- see `errors.ts`'s file comment for the full list.
 * Every code fires only for a genuinely unusable environment, an invalid
 * caller argument, or a cache queried before it was ever reindexed --
 * never for a merely corrupt/stale/truncated file, which degrades to a
 * rebuild instead of raising anything.
 *
 * ---- deliberately withheld -------------------------------------------------
 *
 * - `schema.sql` and `sql.d.ts` are implementation details of `db.ts`
 *   alone -- nothing downstream needs the raw DDL text or the ambient
 *   `*.sql` module declaration.
 * - Every internal helper in `db.ts` (`resolveCacheHome`, `probe`,
 *   `initializeSchema`, `removeIndexFileAndSidecars`, `isErrnoException`,
 *   `ensurePrivateCacheDir`, `tightenCacheDirPermissions`), `query.ts`
 *   (`assertBuilt`, `guardAgainstCorruption`, `validateNonNegativeInt`,
 *   `loadAliasMaps`, `loadDepsMap`, `rowToTicketState`, `rowToLease`,
 *   `queryOrphanedEvents`, `queryDuplicateTicketIds`,
 *   `queryTicketsUnguarded`) and the prepared-statement SQL text constants
 *   in `reindex.ts` are cache-internal machinery, not part of the public
 *   surface a caller should build on. `db.ts`'s `isIndexCorruptionError`
 *   is exported from that file (so `query.ts`/`reindex.ts` can share it)
 *   but stays out of this barrel for the same reason -- it is plumbing
 *   the fix for S2 needed, not something a caller should branch on
 *   directly (a caller checks `CanKanError.code === IndexErrorCodes.CORRUPT`
 *   instead).
 * - This module never re-exports anything from `state/`, `../types`, or
 *   any other module it imports -- `BoardState`/`TicketState`/`ActorId`
 *   etc. are already available from those modules' own public surfaces
 *   (or flat off the package root); re-exporting them again here would
 *   just be a second name for the same thing.
 */

export type { BoardIndex, IndexDiscardReason, OpenIndexOptions } from "./db";
export { INDEX_SCHEMA_VERSION, indexPathFor, openIndex, rebuildIndex } from "./db";

export { IndexErrorCodes } from "./errors";

export type { ReindexOptions, ReindexResult } from "./reindex";
export { reindex } from "./reindex";

export type { QueryBoardStateOptions, TicketQuery } from "./query";
export { queryBoardState, queryTickets } from "./query";

export type { EnsureIndexFreshOptions, FreshBoardQueryOptions, FreshTicketQueryOptions, IndexValidity, IndexValidityInputs } from "./invalidate";
export {
  ensureIndexFresh,
  createIndexInvalidator,
  invalidateIndex,
  queryBoardStateFresh,
  queryTicketsFresh,
} from "./invalidate";
