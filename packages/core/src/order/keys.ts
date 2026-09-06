/** Deterministic ticket ordering primitives (M2.12). */
export type OrderDirection = "asc" | "desc";
export type SortKey = "id" | "title" | "status" | "priority" | "ordinal" | "rank" | "due" | "due_date" | "created" | "created_date" | "updated" | "updated_date" | "random";
export interface OrderTerm { readonly key: SortKey; readonly direction: OrderDirection; }
export interface OrderableTicket { readonly id: string; readonly title?: string; readonly status?: string; readonly priority?: string; readonly ordinal?: number; readonly due_date?: string; readonly created_date?: string; readonly updated_date?: string; }

const PRIORITY_RANK: Readonly<Record<string, number>> = { lowest: 0, low: 1, medium: 2, normal: 2, high: 3, highest: 4, critical: 5 };
const SORT_KEYS = new Set<SortKey>(["id", "title", "status", "priority", "ordinal", "rank", "due", "due_date", "created", "created_date", "updated", "updated_date", "random"]);

/** Parse `rank:asc,priority:desc,id:asc` (whitespace is ignored). */
export function parseOrder(value: string): readonly OrderTerm[] {
  if (typeof value !== "string" || value.trim() === "") throw new Error("order must contain at least one sort key");
  return value.split(",").map((part) => {
    const [rawKey, rawDirection = "asc"] = part.trim().split(":");
    const key = rawKey as SortKey;
    const direction = rawDirection as OrderDirection;
    if (!SORT_KEYS.has(key) || (direction !== "asc" && direction !== "desc")) throw new Error(`invalid order term: ${part.trim()}`);
    return { key, direction };
  });
}

function naturalCompare(left: string, right: string): number {
  const a = left.toLocaleLowerCase(); const b = right.toLocaleLowerCase();
  const chunks = /\d+|\D+/g; const ac = a.match(chunks) ?? []; const bc = b.match(chunks) ?? [];
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const x = ac[i]; const y = bc[i];
    if (x === undefined) return -1; if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) { const n = Number(x) - Number(y); if (n !== 0) return n; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

function seededHash(value: string, seed: string): number {
  let hash = 2166136261;
  for (const char of `${seed}\0${value}`) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function valueFor(ticket: OrderableTicket, key: SortKey): string | number | undefined {
  switch (key) {
    case "id": return ticket.id; case "title": return ticket.title ?? ""; case "status": return ticket.status ?? "";
    case "priority": return PRIORITY_RANK[ticket.priority?.toLowerCase() ?? ""] ?? -1;
    case "ordinal": case "rank": return ticket.ordinal;
    case "due": case "due_date": return ticket.due_date ?? "";
    case "created": case "created_date": return ticket.created_date ?? "";
    case "updated": case "updated_date": return ticket.updated_date ?? "";
    case "random": return undefined;
  }
}

/** Returns a total-order comparator; id is always the final deterministic tie-break. */
export function compareTickets(left: OrderableTicket, right: OrderableTicket, order: readonly OrderTerm[], seed = "cankan"): number {
  for (const term of order) {
    const a = term.key === "random" ? seededHash(left.id, seed) : valueFor(left, term.key);
    const b = term.key === "random" ? seededHash(right.id, seed) : valueFor(right, term.key);
    const result = typeof a === "number" && typeof b === "number" ? a - b : naturalCompare(String(a ?? ""), String(b ?? ""));
    if (result !== 0) return term.direction === "desc" ? -result : result;
  }
  return naturalCompare(left.id, right.id);
}

export function comparatorFor(order: readonly OrderTerm[], seed?: string): (a: OrderableTicket, b: OrderableTicket) => number {
  return (a, b) => compareTickets(a, b, order, seed);
}

