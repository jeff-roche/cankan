/**
 * Shared ID and board-reference types used across every CanKan module.
 */

/**
 * A ticket identifier, e.g. `ck-a1b2c3` (docs/decisions/0002, "Decision",
 * ~line 390: the `ck-` prefix). Branded so a plain `string` cannot be passed
 * where a `TicketId` is expected, with NO runtime validation and no
 * constructor here: ADR 0002 states no explicit charset or length rule, only
 * two behavioural constraints that belong to the ID *generator*
 * (`ticket/id.ts`, M2.2) — it must not mint all-digit hash suffixes, and ID
 * handling must be case-insensitive on lookup while preserving on-disk
 * casing on write. A validator written here would invent spec the ADR
 * doesn't state, and a naive one would be actively wrong given
 * case-insensitive lookup.
 *
 * Until M2.2 lands, callers narrow with `as TicketId` at the boundary — this
 * is not an oversight; there is deliberately no constructor to call instead.
 */
export type TicketId = string & { readonly __brand: "TicketId" };

/**
 * An actor identifier (a person or agent acting on the board). Branded the
 * same way as `TicketId`, and for the same reason: no runtime validation or
 * constructor belongs in this shared-types file. Callers narrow with
 * `as ActorId` at the boundary.
 */
export type ActorId = string & { readonly __brand: "ActorId" };

/**
 * The two kinds of board (CONCEPT.md §6c). `--board all` resolves to a
 * *list* of `BoardRef`s aggregating the personal board and every registered
 * repo board — it is not a third kind, so `"all"` is deliberately absent
 * here. Likewise `--board repo` is a *selector* meaning "the current repo's
 * board," not a distinct kind.
 */
export type BoardKind = "repo" | "personal";

/**
 * A reference to one board — "a directory with a tickets folder and a
 * coordination ref" (CONCEPT.md §6c). Every downstream module locates a
 * board's root, tickets directory, and coordination ref from a `BoardRef`
 * alone; nothing here reads the filesystem or resolves an XDG path — that is
 * M2.4's `board/resolve.ts`.
 *
 * Both kinds carry all five fields honestly: the personal board at
 * `$XDG_DATA_HOME/cankan/personal/` is itself a git repo, so it gets the
 * same event log, claims, and coordination ref as a repo board
 * (CONCEPT.md §6c).
 */
export interface BoardRef {
  kind: BoardKind;
  /** Registry name used by `--board <name>` and `<repo>:<id>` refs, e.g. `api:ck-7f3a9c`. "personal" for the personal board. */
  name: string;
  /** Absolute path to the board root — the directory containing `.cankan/`. */
  root: string;
  /** Absolute path to the tickets directory. */
  ticketsDir: string;
  /** Fully-qualified coordination ref, e.g. `refs/cankan/coordination` (docs/decisions/0001-coordination-ref.md). */
  coordinationRef: string;
}
