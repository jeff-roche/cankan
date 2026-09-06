/**
 * Error codes specific to the `store/` module (the ticket store, M2.5).
 *
 * These live here rather than in the shared `src/errors.ts` — that file is
 * frozen except for appended lines, and `packages/core/test/index.test.ts`
 * asserts the root export key set exactly, so a code that belongs to one
 * module's own domain stays in that module's folder (see `ticket/errors.ts`'s
 * and `board/errors.ts`'s file comments, and M2.1's `src/errors.ts` file
 * comment).
 *
 * **Prefixed `STORE_`** (Ruling R10): `TicketErrorCodes`, `EventErrorCodes`
 * and `GitErrorCodes` all prefix their string values with the module name;
 * `BoardErrorCodes` is the one outlier. This module follows the majority.
 *
 * Every `details` value attached to one of these codes is something the
 * store itself chose (a fixed reason string, never a path or file content)
 * — `../errors.ts`'s file comment establishes that `details` is published,
 * user-visible output, and `ticket/filename.ts`'s `assertSafeId` already
 * sets the precedent this module follows: report which rule failed, never
 * the value that failed it.
 */
export const StoreErrorCodes = {
  /**
   * `list()`, `get()`, `write()`, `remove()` and `archive()` all require
   * `board.ticketsDir` to already exist as a directory — Ruling R4: the
   * store never creates it (that belongs to `ensurePersonalBoard()` and to
   * M3.2's `init`). Raised when `stat(ticketsDir)` fails with `ENOENT`, or
   * succeeds but the path is not a directory (a file or other non-directory
   * entry sitting where the tickets directory should be gets the same
   * remediation). The message points the user at `cankan init`.
   */
  TICKETS_DIR_MISSING: "STORE_TICKETS_DIR_MISSING",
  /**
   * `stat(ticketsDir)` failed for a reason other than "does not exist" — a
   * symlink cycle (`ELOOP`) or a permission failure on an ancestor
   * (`EACCES`), say. Distinct from `TICKETS_DIR_MISSING` the same way
   * `board/errors.ts`'s `CWD_UNRESOLVABLE` is distinct from `CWD_NOT_FOUND`:
   * without this, a raw platform error would reach a caller untyped,
   * invisible to `isCanKanError`/M3.10's exit-code map.
   */
  TICKETS_DIR_UNAVAILABLE: "STORE_TICKETS_DIR_UNAVAILABLE",
  /**
   * The store's single choke point (`assertSafeTicketPath`, ADR 0002 step
   * (d) defence in depth — Ruling R8) rejected a filename before any I/O:
   * not a bare basename, contains `/` or `\`, is `.` or `..`, or the joined
   * path did not resolve directly inside the target directory. In practice
   * every path the store builds already came from `buildTicketFilename()`
   * (which enforces the same rule itself, raising `TicketErrorCodes
   * .UNSAFE_FILENAME` first) or from a `readdir()` entry (which structurally
   * cannot contain `/` on any platform this runs on) — so this code is the
   * second layer, not the first, and is expected to be reachable only by
   * calling `assertSafeTicketPath` directly, not through the public API.
   * Nothing is written when this fires.
   */
  UNSAFE_TICKET_PATH: "STORE_UNSAFE_TICKET_PATH",
  /**
   * A lookup resolved to more than one ticket. Two distinct raising sites
   * share this one code because they are the same underlying hazard —
   * "which ticket did the caller mean?" answered by more than one candidate
   * — encountered from two directions:
   * - `get()`: the requested id, `cankan.display_id`, or a `cankan.aliases`
   *   entry matches more than one on-disk ticket (two tickets claiming the
   *   same alias, say). Never resolved to an arbitrary winner.
   * - `write()`: more than one on-disk filename's id (per
   *   `parseTicketFilename`, compared with `normalizeTicketIdForComparison`)
   *   matches the id of the ticket being written — a pre-existing data
   *   integrity problem (two files sharing one id) that `write()` refuses to
   *   guess through by picking one to overwrite.
   */
  AMBIGUOUS_TICKET_LOOKUP: "STORE_AMBIGUOUS_TICKET_LOOKUP",
  /**
   * `remove()` or `archive()` was asked for a ticket id/display-id/alias
   * that `get()`'s own resolution found no match for. Distinct from `get()`
   * itself, which returns `undefined` on a miss rather than throwing — a
   * lookup is allowed to come back empty, but `remove`/`archive` have
   * nothing to act on once that happens, so they raise instead of silently
   * no-op-ing.
   */
  TICKET_NOT_FOUND: "STORE_TICKET_NOT_FOUND",
  /**
   * A filesystem operation `write()`, `remove()` or `archive()` performs
   * beyond the directory-existence check (`open`/`writeFile`/`fsync`/
   * `rename` for an atomic write; `unlink` for a removal; `mkdir`/`rename`
   * for an archive move) failed for a reason not already covered by a more
   * specific code — a name collision with a directory (`EISDIR`), a
   * permission error, a full disk, and similar. Wrapped rather than left to
   * escape as a raw platform error, the same discipline `board/errors.ts`'s
   * `PERSONAL_BOARD_UNAVAILABLE`/`REGISTRY_UNAVAILABLE` already apply to
   * every otherwise-unhandled filesystem call in their own module.
   */
  TICKET_IO_FAILED: "STORE_TICKET_IO_FAILED",
} as const;
