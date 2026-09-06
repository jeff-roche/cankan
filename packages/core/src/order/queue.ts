import { comparatorFor, parseOrder, type OrderTerm, type OrderableTicket } from "./keys";
export interface QueueFilter { readonly labels?: readonly string[]; readonly priority?: readonly string[]; readonly backer?: readonly string[]; }
export interface QueueDefinition { readonly filter?: QueueFilter; readonly order?: readonly string[]; readonly actors?: readonly string[]; }
export interface QueueTicket extends OrderableTicket { readonly labels?: readonly string[]; readonly backer?: string; }
export interface ResolvedQueue { readonly name: string; readonly filter: QueueFilter; readonly order: readonly OrderTerm[]; readonly matches: (ticket: QueueTicket) => boolean; readonly compare: (a: QueueTicket, b: QueueTicket) => number; }

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "i").test(value);
}
function filterMatches(filter: QueueFilter, ticket: QueueTicket): boolean {
  if (filter.labels && !filter.labels.every((label) => ticket.labels?.includes(label))) return false;
  if (filter.priority && !filter.priority.includes(ticket.priority ?? "")) return false;
  if (filter.backer && !filter.backer.includes(ticket.backer ?? "")) return false;
  return true;
}

/** Resolve an explicit queue, or the most-specific actor-pattern queue. */
export function resolveQueue(queues: Readonly<Record<string, QueueDefinition>> | undefined, name: string | undefined, actor?: string, seed?: string): ResolvedQueue | undefined {
  if (!queues) return undefined;
  let selectedName = name;
  if (!selectedName && actor) {
    const candidates = Object.entries(queues).filter(([, queue]) => queue.actors?.some((pattern) => globMatches(pattern, actor))).sort(([a, qa], [b, qb]) => {
      const wildcards = (queue: QueueDefinition) => (queue.actors ?? []).reduce((n, p) => n + (p.match(/[?*]/g)?.length ?? 0), 0);
      return wildcards(qa) - wildcards(qb) || a.localeCompare(b);
    });
    selectedName = candidates[0]?.[0];
  }
  if (!selectedName) return undefined;
  const definition = queues[selectedName];
  if (!definition) throw new Error(`unknown queue: ${selectedName}`);
  const order = (definition.order ?? ["rank:asc", "priority:desc", "id:asc"]).flatMap((term) => parseOrder(term));
  const filter = definition.filter ?? {};
  return { name: selectedName, filter, order, matches: (ticket) => filterMatches(filter, ticket), compare: comparatorFor(order, seed) };
}

