import { randomBytes } from "node:crypto";
import type { TicketId } from "../types";

const HASH_LENGTH = 6;
const HEX_CHARS = "0123456789abcdef";
const ALL_DIGITS_RE = /^[0-9]+$/;

function randomHexSuffix(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += HEX_CHARS[bytes[i] % HEX_CHARS.length];
  }
  return out;
}

/**
 * Mints a new `ck-<hash>` ticket id (CONCEPT.md's `ck-7f3a9c` shape; ADR
 * 0002 "Decision" point 4).
 *
 * Retries until the hash suffix is **not** all digits. Probe 3 of ADR 0002
 * confirmed, by execution against real `backlog.md@1.51.0`, that Backlog.md's
 * sequential allocator scans `ck-*` filenames for a numeric suffix and mints
 * `max + 1` — and a numeric-*looking* hash (`ck-847213`) is absorbed into
 * that scan exactly like a real sequential id, producing a colliding
 * `ck-847214` on the very next `backlog task create`. Rejecting an
 * all-digit suffix here is the generator-side fix the ADR prefers over
 * existence-checking against Backlog.md-visible files, which would need the
 * ticket store — M2.5's, not this module's.
 */
export function generateTicketId(prefix = "ck"): TicketId {
  let suffix: string;
  do {
    suffix = randomHexSuffix(HASH_LENGTH);
  } while (ALL_DIGITS_RE.test(suffix));
  return `${prefix}-${suffix}` as TicketId;
}

/**
 * A ticket id canonicalized for **comparison/lookup only** — never write
 * this value to a file or filename. See `keepOnDiskIdCasing` for the
 * opposite, serialization-safe operation.
 */
export type TicketIdLookupKey = string & {
  readonly __brand: "TicketIdLookupKey";
};

/**
 * Canonicalizes an id for **comparison/lookup only** — lowercases it so
 * `ck-1` and `CK-1` are recognized as the same ticket. ADR 0002 "Decision"
 * point 5, confirmed by probe 3: Backlog.md writes an uppercase `id: CK-1`
 * into a file whose own filename keeps the lowercase, configured-prefix
 * casing (`ck-1 - ...md`) — lookups must treat those as the same ticket.
 *
 * The return type is branded `TicketIdLookupKey`, deliberately **not**
 * `TicketId`, and is not assignable to it without an explicit cast: a
 * `TicketIdLookupKey` must never reach a ticket file's `id:` field or a
 * filename. `ticketStore.get()` (M2.5) indexes and looks up by this value.
 * The counterpart for the write path is `keepOnDiskIdCasing` — use that one,
 * never this one, on a value headed back to disk.
 */
export function normalizeTicketIdForComparison(id: string): TicketIdLookupKey {
  return id.toLowerCase() as TicketIdLookupKey;
}

/**
 * Casts a raw id string — exactly as read from a ticket file's `id:` field
 * or recovered from a filename via `parseTicketFilename` — into a
 * `TicketId`, without changing so much as its casing. This is the
 * **serialization-safe** counterpart to `normalizeTicketIdForComparison`:
 * call this one on any path that will eventually write the id back to disk
 * (a ticket file's frontmatter, a filename), and never call
 * `normalizeTicketIdForComparison` on a value headed there. ADR 0002 probe 3
 * shows real Backlog.md output where the filename (`ck-1 - ...md`) and the
 * in-file `id: CK-1` legitimately disagree in casing — lowercasing either
 * one before a write would rewrite bytes nothing asked to change, and would
 * fail M2.2's byte-identical round-trip requirement on any file Backlog.md
 * has touched.
 */
export function keepOnDiskIdCasing(id: string): TicketId {
  return id as TicketId;
}
