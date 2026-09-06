/**
 * Freshness tracking for the SQLite index cache (M2.15).
 *
 * The index is derived from two independent inputs: ticket files and the
 * coordination ref.  A per-file signature catches edits made outside the
 * store API (including overwrites that leave the directory mtime unchanged),
 * while the ref tip catches event-log appends.  The marker is
 * intentionally opaque to `reindex()` and is stored in `cankan_meta`.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import type { BoardIndex } from "./db";
import type { ReindexResult } from "./reindex";
import { reindex } from "./reindex";
import { queryBoardState, queryTickets, type QueryBoardStateOptions, type TicketQuery } from "./query";
type BoardState = ReturnType<typeof queryBoardState>;
type TicketState = ReturnType<typeof queryTickets>[number];

export interface IndexValidityInputs {
  /** Directory containing the board's ticket files. */
  readonly ticketsDir: string;
  /** Current coordination-ref tip; `null` means the ref does not exist yet. */
  readonly readRef: () => Promise<string | null>;
}

/** A stable, serializable marker for the two inputs that feed a fold. */
export interface IndexValidity {
  readonly ticketsMtimeMs: number;
  readonly ticketsSignature: string;
  readonly refSha: string | null;
}

/** Computes the marker used by `reindex()` and subsequent freshness checks. */
export async function computeIndexValidity(inputs: IndexValidityInputs): Promise<IndexValidity> {
  let ticketsMtimeMs = 0;
  const entries: string[] = [];
  try {
    const names = await readdir(inputs.ticketsDir, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isFile()) continue;
      const path = `${inputs.ticketsDir}/${entry.name}`;
      const info = await stat(path);
      ticketsMtimeMs = Math.max(ticketsMtimeMs, info.mtimeMs);
      const bytes = await readFile(path);
      entries.push(`${entry.name}\0${info.size}\0${info.mtimeMs}\0${createHash("sha256").update(bytes).digest("hex")}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  entries.sort();
  const ticketsSignature = createHash("sha256").update(entries.join("\n"), "utf8").digest("hex");
  return { ticketsMtimeMs, ticketsSignature, refSha: await inputs.readRef() };
}

export function serializeIndexValidity(validity: IndexValidity): string {
  return JSON.stringify(validity);
}

export function readIndexValidity(index: BoardIndex): IndexValidity | undefined {
  const row = index.db.query("SELECT value FROM cankan_meta WHERE key = 'validity'").get() as {
    value: string | null;
  } | null;
  if (row?.value == null) return undefined;
  try {
    const parsed = JSON.parse(row.value) as Partial<IndexValidity>;
    if (typeof parsed.ticketsMtimeMs !== "number" || typeof parsed.ticketsSignature !== "string" || (typeof parsed.refSha !== "string" && parsed.refSha !== null)) return undefined;
    return { ticketsMtimeMs: parsed.ticketsMtimeMs, ticketsSignature: parsed.ticketsSignature, refSha: parsed.refSha };
  } catch {
    return undefined;
  }
}

export function isIndexStale(index: BoardIndex, current: IndexValidity): boolean {
  const indexed = readIndexValidity(index);
  const dirty = index.db.query("SELECT value FROM cankan_meta WHERE key = 'dirty'").get() as { value: string } | null;
  return dirty?.value === "1" || indexed === undefined || indexed.ticketsMtimeMs !== current.ticketsMtimeMs || indexed.ticketsSignature !== current.ticketsSignature || indexed.refSha !== current.refSha;
}

/** Explicitly dirties an index. Useful for callers that know a write occurred. */
export function invalidateIndex(index: BoardIndex): void {
  index.db.query("INSERT INTO cankan_meta (key, value) VALUES ('dirty', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
}

/** Creates the callback passed to store/event write options at a composition boundary. */
export function createIndexInvalidator(index: BoardIndex): () => void {
  return () => {
    try {
      invalidateIndex(index);
    } catch {
      // Cache notification must never turn a durable write into a retryable failure.
    }
  };
}

export interface EnsureIndexFreshOptions extends IndexValidityInputs {
  readonly index: BoardIndex;
  /** Fold the current ticket files and event log when the cache is stale. */
  readonly fold: () => BoardState | Promise<BoardState>;
  readonly now?: number;
}

/** Reindexes once when the current inputs differ from the cached marker. */
export async function ensureIndexFresh(options: EnsureIndexFreshOptions): Promise<ReindexResult | undefined> {
  const validity = await computeIndexValidity(options);
  if (!isIndexStale(options.index, validity)) return undefined;
  return reindex({ index: options.index, state: await options.fold(), now: options.now, validity: serializeIndexValidity(validity) });
}

export interface FreshTicketQueryOptions extends EnsureIndexFreshOptions {
  readonly query?: TicketQuery;
}

export interface FreshBoardQueryOptions extends EnsureIndexFreshOptions {
  readonly boardQuery?: QueryBoardStateOptions;
}

/** Refreshes if needed, then serves a ticket query from the cache. */
export async function queryTicketsFresh(options: FreshTicketQueryOptions): Promise<readonly TicketState[]> {
  await ensureIndexFresh(options);
  return queryTickets(options.index, options.query);
}

/** Refreshes if needed, then serves the complete folded board from the cache. */
export async function queryBoardStateFresh(options: FreshBoardQueryOptions): Promise<BoardState> {
  await ensureIndexFresh(options);
  return queryBoardState(options.index, options.boardQuery);
}
