-- `index/schema.sql` — the SQLite cache's DDL (M2.14).
--
-- STRICT tables throughout (bun 1.4.0's bundled SQLite supports STRICT --
-- F6, verified). Every table is rebuilt wholesale by `reindex.ts`; nothing
-- here is hand-migrated in place.
--
-- `ordinal` (R3, controller ruling): `BoardState.tickets`' own array
-- position, stored verbatim at reindex time. Every query orders by this
-- column, never by `id` and never by re-deriving
-- `normalizeTicketIdForComparison` (which `index/` cannot even import,
-- R1) -- order survives as a preserved fact, not a reimplementation that
-- can drift from the fold.
--
-- `lease_first_seen_ms` / `lease_expires_at_ms` are declared `REAL`, not
-- `INTEGER` (controller addendum A2, verified directly): a STRICT
-- `INTEGER` column throws "cannot store REAL value in INTEGER column" the
-- moment a fractional millisecond value is inserted, and a fractional
-- value is genuinely reachable here -- `events/observations.ts` validates
-- a stored `firstSeenAtMs` only as finite and in-range, never as an
-- integer, and `leaseTtlMs` is validated only as positive and finite.
-- `REAL` (an IEEE double) represents every integer up to 2^53 exactly, so
-- no precision is lost for the ordinary case, and reindex must never throw
-- because a fractional millisecond reached it -- this cache degrading to
-- an error would make the board unusable, exactly what `db.ts`'s
-- "index is a cache" rule forbids.
CREATE TABLE cankan_meta (
  key TEXT PRIMARY KEY,
  value TEXT
) STRICT;
-- rows (all optional except the two seeded at open-time rebuild):
--   'schema_version' -- INDEX_SCHEMA_VERSION, as text. The authoritative
--                        check is `PRAGMA user_version`; this is an
--                        informational echo of the same fact.
--   'board_key'      -- the opaque boardKey this file was built for
--                        (R2) -- checked byte-for-byte against
--                        `OpenIndexOptions.boardKey` on every open.
--   'built_at_ms'    -- set by `reindex()` on every successful rebuild.
--                        `NULL` (the row absent) means "opened but never
--                        reindexed" -- `query.ts` checks this and throws
--                        `INDEX_NOT_BUILT` rather than silently answering
--                        "empty board" for a board that has never been
--                        indexed (controller addendum A1).
--   'validity'       -- M2.15's slot (#38, Round 5). Opaque, stored
--                        verbatim by `reindex()` when a caller passes one,
--                        `NULL` otherwise. Never interpreted here.

CREATE TABLE tickets (
  -- R3: `BoardState.tickets` array position, verbatim. `INTEGER PRIMARY
  -- KEY` is SQLite's rowid alias -- cheap to insert and to range-scan in
  -- order.
  ordinal INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  status_from_frontmatter TEXT NOT NULL,
  status_from_events TEXT,
  status TEXT NOT NULL,
  closed INTEGER NOT NULL,
  close_reason TEXT,
  display_id TEXT,
  lease_actor TEXT,
  lease_event_id TEXT,
  lease_kind TEXT,
  lease_until_display TEXT,
  lease_first_seen_ms REAL,
  lease_expires_at_ms REAL,
  -- A `LeaseState` is either fully present or fully absent (`query.ts`
  -- reconstructs it that way): `lease_actor IS NULL` iff every other
  -- `lease_*` column is `NULL` iff `TicketState.lease === undefined`.
  --
  -- Fix round 3 (schema version 2): renamed from `lease_expired`.
  -- Liveness is a function of the clock, not a fact about the board --
  -- a lease can expire with zero change to the board (no event, no file
  -- write), so a boolean frozen here at reindex time goes stale the
  -- instant the clock passes it, with nothing for M2.15's invalidation to
  -- detect. This column is now ONLY a debug-time snapshot of what
  -- `expired` happened to be at the moment of this reindex -- `query.ts`
  -- never selects it, never filters on it, and never uses it to answer
  -- "is this lease live". The authoritative answer is computed at query
  -- time from `lease_expires_at_ms` against the caller's `now`.
  lease_expired_at_reindex INTEGER
) STRICT;
CREATE INDEX tickets_status ON tickets(status);
-- Fix round 3: covers the query-time actor filter's shape
-- (`lease_actor = ? AND lease_expires_at_ms > ?`), not the retired
-- `lease_expired` boolean.
CREATE INDEX tickets_lease ON tickets(lease_actor, lease_expires_at_ms);
CREATE INDEX tickets_closed ON tickets(closed);
CREATE INDEX tickets_id ON tickets(id);

-- `source` is `'merged' | 'frontmatter' | 'event'` -- the three lists are
-- kept SEPARATE, never re-merged on read. `TicketState.aliases`,
-- `.frontmatterAliases` and `.eventAliases` are three distinct fields with
-- different trust levels (Ruling I1: `eventAliases` is attacker-writable)
-- and collapsing them would both break the round-trip and destroy
-- provenance.
CREATE TABLE ticket_aliases (
  ticket_ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (ticket_ordinal, source, position)
) STRICT;

-- `dep_json` is one `TicketState.deps[]` entry, JSON-round-tripped
-- verbatim (R4: `index/` does not resolve dependency ids -- that stays
-- `blockedBy`'s, which needs alias/display-id resolution this lane
-- cannot reimplement without the divergence risk R1 exists to kill).
CREATE TABLE ticket_deps (
  ticket_ordinal INTEGER NOT NULL,
  position INTEGER NOT NULL,
  dep_json TEXT NOT NULL,
  PRIMARY KEY (ticket_ordinal, position)
) STRICT;

CREATE TABLE orphaned_events (
  position INTEGER PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  cause TEXT NOT NULL,
  reason TEXT NOT NULL
) STRICT;

CREATE TABLE duplicate_ticket_ids (
  position INTEGER NOT NULL,
  path_position INTEGER NOT NULL,
  ticket_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (position, path_position)
) STRICT;
