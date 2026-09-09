import * as core from "@jeff-roche/cankan-core";
import type { CoreHandle } from "../../context";

interface Snapshot {
  readonly state: core.state.BoardState;
  readonly frontmatter: ReadonlyMap<string, core.ticket.ParsedTicket>;
  readonly events: readonly core.events.EventRecord[];
}

interface SnapshotOptions {
  readonly now?: number;
}

async function snapshotBoard(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  config: core.config.ConfigResult,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const now = options.now ?? Date.now();
  const leaseTtlMs = core.claims.parseDurationMs(config.value.claims.lease);
  const events = await core.events.read(
    coreHandle.adapter,
    board.coordinationRef,
    {
      now,
      trailingMonths: core.claims.computeTrailingMonths(leaseTtlMs),
    },
  );
  const { tickets } = await coreHandle.store.list();
  const boardKey = await core.events.boardKeyFor(coreHandle.adapter);
  const state = await core.state.observeAndFold(boardKey, tickets, events, {
    now,
    leaseTtlMs,
  });
  const frontmatter = new Map<string, core.ticket.ParsedTicket>();
  for (const stored of tickets) {
    frontmatter.set(
      core.ticket.normalizeTicketIdForComparison(stored.id),
      stored.ticket,
    );
  }
  return { state, frontmatter, events };
}

type FrontmatterMap = ReadonlyMap<string, core.ticket.ParsedTicket>;

function readinessOptions(
  config: core.config.ConfigResult,
  frontmatter: FrontmatterMap,
  overrides: Readonly<Record<string, readonly string[]>>,
): core.deps.IsReadyOptions {
  const excludedLabels = config.value.ready.exclude_labels ?? [];
  return {
    ...(excludedLabels.length > 0
      ? {
          excludedLabels,
          labelsFor: (id: string) =>
            frontmatter.get(core.ticket.normalizeTicketIdForComparison(id))
              ?.frontmatter.labels ?? [],
        }
      : {}),
    flatDependenciesFor: (id: string) =>
      overrides[core.ticket.normalizeTicketIdForComparison(id)] ??
      frontmatter.get(core.ticket.normalizeTicketIdForComparison(id))
        ?.frontmatter.dependencies ??
      [],
  };
}

interface FilterOverrides {
  readonly label?: string;
  readonly milestone?: string;
  readonly backer?: string;
}

interface ResolvedOrder {
  readonly compare: (
    a: core.order.OrderableTicket,
    b: core.order.OrderableTicket,
  ) => number;
  readonly matches: (ticket: core.order.OrderableTicket) => boolean;
}

function cliFilterMatches(
  options: FilterOverrides,
): (ticket: core.order.OrderableTicket) => boolean {
  return (ticket) =>
    (options.label === undefined ||
      (ticket.labels ?? []).includes(options.label)) &&
    (options.milestone === undefined ||
      ticket.milestone === options.milestone) &&
    (options.backer === undefined || ticket.backer === options.backer);
}

function resolveOrder(
  config: core.config.ConfigResult,
  options: {
    readonly queue?: string;
    readonly order?: string;
  } & FilterOverrides,
  actor: core.ActorId,
): ResolvedOrder {
  const queue = core.order.resolveQueue(
    config.value.queues,
    options.queue,
    options.order === undefined ? actor : undefined,
  );
  const extra = cliFilterMatches(options);
  if (queue !== undefined)
    return {
      compare: queue.compare,
      matches: (ticket) => queue.matches(ticket) && extra(ticket),
    };
  const terms = core.order.parseOrder(
    options.order ?? config.value.ready.order.join(","),
  );
  return { compare: core.order.comparatorFor(terms), matches: extra };
}

function orderableFor(
  ticket: core.state.TicketState,
  frontmatter: FrontmatterMap,
): core.order.OrderableTicket {
  const parsed = frontmatter.get(
    core.ticket.normalizeTicketIdForComparison(ticket.id),
  )?.frontmatter;
  return {
    id: ticket.id,
    title: parsed?.title ?? ticket.id,
    status: ticket.status,
    ...(parsed?.priority !== undefined ? { priority: parsed.priority } : {}),
    ...(parsed?.milestone !== undefined ? { milestone: parsed.milestone } : {}),
    ...(parsed?.labels !== undefined ? { labels: parsed.labels } : {}),
    ...(parsed?.ordinal !== undefined ? { ordinal: parsed.ordinal } : {}),
    ...(parsed?.due_date !== undefined ? { due_date: parsed.due_date } : {}),
    ...(parsed?.created_date !== undefined
      ? { created_date: parsed.created_date }
      : {}),
    ...(parsed?.updated_date !== undefined
      ? { updated_date: parsed.updated_date }
      : {}),
    ...(parsed?.cankan?.origin !== undefined
      ? { backer: parsed.cankan.origin }
      : {}),
  };
}

interface ReadyCandidate {
  readonly ticket: core.state.TicketState;
  readonly view: core.order.OrderableTicket;
  readonly verdict: core.deps.ReadinessVerdict;
}

function readyCandidates(
  snapshot: Snapshot,
  options: core.deps.IsReadyOptions,
  order: ResolvedOrder,
  requireReady: boolean,
): ReadyCandidate[] {
  const candidates: ReadyCandidate[] = [];
  for (const ticket of snapshot.state.tickets) {
    if (ticket.closed || (ticket.lease !== undefined && !ticket.lease.expired))
      continue;
    const view = orderableFor(ticket, snapshot.frontmatter);
    if (!order.matches(view)) continue;
    const verdict = requireReady
      ? core.deps.isReady(snapshot.state, ticket.id, options)
      : { ready: true, reasons: [] };
    if (verdict.ready) candidates.push({ ticket, view, verdict });
  }
  return candidates.sort((a, b) => order.compare(a.view, b.view));
}

export interface CoordListOptions extends FilterOverrides {
  readonly queue?: string;
  readonly order?: string;
  readonly limit?: number;
  readonly flatDependencies?: Readonly<Record<string, readonly string[]>>;
}

export interface ReadyTicket {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
  readonly milestone?: string;
  readonly labels: readonly string[];
  readonly reasons: readonly core.deps.ReadinessBlocker[];
}

export interface ReadyResult {
  readonly tickets: readonly ReadyTicket[];
}

export async function coordReady(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: core.ActorId,
  config: core.config.ConfigResult,
  options: CoordListOptions,
): Promise<ReadyResult> {
  await runExpireSweep(board, actor, {});
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const candidates = readyCandidates(
    snapshot,
    readinessOptions(
      config,
      snapshot.frontmatter,
      options.flatDependencies ?? {},
    ),
    resolveOrder(config, options, actor),
    true,
  );
  const limited =
    options.limit === undefined
      ? candidates
      : candidates.slice(0, options.limit);
  return {
    tickets: limited.map(({ ticket, view, verdict }) => ({
      id: ticket.id,
      title: view.title ?? ticket.id,
      status: ticket.status,
      ...(view.priority !== undefined ? { priority: view.priority } : {}),
      ...(view.milestone !== undefined ? { milestone: view.milestone } : {}),
      labels: view.labels ?? [],
      reasons: verdict.reasons,
    })),
  };
}

export async function runExpireSweep(
  board: core.BoardRef,
  actor: core.ActorId,
  options: { readonly dryRun?: boolean },
): Promise<core.claims.ExpireStaleResult> {
  return core.claims.expireStale({
    board,
    actor,
    ...(options.dryRun ? { dryRun: true } : {}),
  });
}

export interface ClaimNextOptions extends FilterOverrides {
  readonly queue?: string;
  readonly order?: string;
  readonly lease?: string;
  readonly parent?: core.ActorId;
  readonly flatDependencies?: Readonly<Record<string, readonly string[]>>;
}

interface ClaimCallOptions {
  readonly force?: boolean;
  readonly lease?: string;
  readonly parent?: core.ActorId;
}

function claimTicket(
  board: core.BoardRef,
  ticket: string,
  actor: core.ActorId,
  options: ClaimCallOptions,
): Promise<core.claims.ClaimResult> {
  return core.claims.claim({
    board,
    ticket,
    actor,
    ...(options.force ? { force: true } : {}),
    ...(options.lease !== undefined ? { lease: options.lease } : {}),
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
  });
}

export async function claimNext(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: core.ActorId,
  config: core.config.ConfigResult,
  options: ClaimNextOptions,
): Promise<core.claims.ClaimResult | undefined> {
  await runExpireSweep(board, actor, {});
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const candidates = readyCandidates(
    snapshot,
    readinessOptions(
      config,
      snapshot.frontmatter,
      options.flatDependencies ?? {},
    ),
    resolveOrder(config, options, actor),
    config.value.claims.require_ready,
  );
  for (const candidate of candidates) {
    try {
      return await claimTicket(board, candidate.ticket.id, actor, options);
    } catch (error) {
      if (
        error instanceof core.CanKanError &&
        (error.code === core.ErrorCodes.CLAIM_REJECTED ||
          error.code === core.claims.ClaimErrorCodes.TICKET_NOT_FOUND ||
          error.code === core.claims.ClaimErrorCodes.TICKET_AMBIGUOUS)
      )
        continue;
      throw error;
    }
  }
  return undefined;
}

function isLostClaimRace(error: unknown): boolean {
  return (
    core.isCanKanError(error) && error.code === core.ErrorCodes.CLAIM_REJECTED
  );
}

export async function renewAll(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: core.ActorId,
  config: core.config.ConfigResult,
  options: { readonly lease?: string } = {},
): Promise<readonly core.claims.RenewResult[]> {
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const mine = core.state.claimedBy(snapshot.state).get(actor) ?? [];
  const results: core.claims.RenewResult[] = [];
  for (const ticket of mine) {
    try {
      results.push(
        await core.claims.renew({
          board,
          ticket: ticket.id,
          actor,
          ...(options.lease !== undefined ? { lease: options.lease } : {}),
        }),
      );
    } catch (error) {
      if (!isLostClaimRace(error)) throw error;
    }
  }
  return results;
}

export async function releaseAll(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: core.ActorId,
  config: core.config.ConfigResult,
): Promise<readonly core.claims.ReleaseResult[]> {
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const mine = core.state.claimedBy(snapshot.state).get(actor) ?? [];
  const results: core.claims.ReleaseResult[] = [];
  for (const ticket of mine) {
    try {
      results.push(
        await core.claims.release({
          board,
          ticket: ticket.id,
          actor,
        }),
      );
    } catch (error) {
      if (!isLostClaimRace(error)) throw error;
    }
  }
  return results;
}

export interface ClaimExplicitOptions extends ClaimCallOptions {
  readonly flatDependencies?: Readonly<Record<string, readonly string[]>>;
}

export async function claimExplicit(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: core.ActorId,
  config: core.config.ConfigResult,
  ticketId: string,
  options: ClaimExplicitOptions = {},
): Promise<core.claims.ClaimResult> {
  if (!config.value.claims.require_ready || options.force === true)
    return claimTicket(board, ticketId, actor, options);
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const target = core.claims.resolveTicket(snapshot.state, ticketId);
  const verdict = core.deps.isReady(
    snapshot.state,
    target.id,
    readinessOptions(
      config,
      snapshot.frontmatter,
      options.flatDependencies ?? {},
    ),
  );
  if (!verdict.ready)
    throw new core.CanKanError(
      core.ErrorCodes.CLAIM_REJECTED,
      `claim rejected (not-ready) for ticket "${target.id}"`,
      { details: { reason: "not-ready", ticket: target.id } },
    );
  return claimTicket(board, target.id, actor, options);
}

export function parseLimitOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      `--limit must be a finite non-negative integer, got "${raw}"`,
      { details: { limit: raw } },
    );
  return value;
}

function resolveAssignActors(values: readonly string[]): string[] {
  return values.map((value) =>
    core.actor.formatActor(core.actor.parseActor(value)),
  );
}

export async function assignTicket(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  config: core.config.ConfigResult,
  ticketId: string,
  target: string,
): Promise<{ readonly id: string; readonly assignee: readonly string[] }> {
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const ticket = core.claims.resolveTicket(snapshot.state, ticketId);
  if (ticket.closed) {
    throw new core.CanKanError(
      core.ErrorCodes.CLAIM_REJECTED,
      `cannot assign closed ticket "${ticket.id}"`,
      { details: { reason: "closed", ticket: ticket.id } },
    );
  }
  const stored = await coreHandle.store.get(ticket.id);
  if (stored === undefined) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      `no ticket found matching "${ticketId}"`,
    );
  }
  const [assignee] = resolveAssignActors([target]);
  const current = stored.ticket.frontmatter.assignee ?? [];
  const assignees = current.includes(assignee)
    ? current
    : [...current, assignee];
  const updated = core.ticket.setSequenceField(
    stored.ticket,
    "assignee",
    assignees,
  );
  const written = await coreHandle.store.write(updated);
  return { id: written.id, assignee: assignees };
}

export interface MineResult {
  readonly claims: readonly string[];
  readonly assignments: readonly string[];
}

export async function mine(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: core.ActorId,
  config: core.config.ConfigResult,
): Promise<MineResult> {
  const { state, frontmatter } = await snapshotBoard(coreHandle, board, config);
  const claims = core.state.claimedBy(state).get(actor) ?? [];
  const assignments = [...frontmatter.values()]
    .filter((ticket) =>
      (ticket.frontmatter.assignee ?? []).some(
        (assignee) => assignee === actor,
      ),
    )
    .map((ticket) => ticket.frontmatter.id)
    .sort();
  return { claims: claims.map((ticket) => ticket.id).sort(), assignments };
}

export interface ActorGroup {
  readonly actor: string;
  readonly tickets: readonly string[];
}

export async function listActors(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  config: core.config.ConfigResult,
): Promise<readonly ActorGroup[]> {
  const { state } = await snapshotBoard(coreHandle, board, config);
  return [...core.state.claimedBy(state).entries()]
    .map(([actor, tickets]) => ({
      actor,
      tickets: tickets.map((ticket) => ticket.id).sort(),
    }))
    .sort((a, b) => a.actor.localeCompare(b.actor));
}

export interface ActiveActorGroup {
  readonly parent: string;
  readonly tickets: readonly string[];
}

export async function activeActors(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  config: core.config.ConfigResult,
  active?: string,
  now?: number,
): Promise<readonly ActiveActorGroup[]> {
  const observedAt = now ?? Date.now();
  const { state, events } = await snapshotBoard(coreHandle, board, config, {
    now: observedAt,
  });
  const byActor = core.state.claimedBy(state);
  if (active === undefined) return groupActiveByParent(byActor, events);
  const cutoff = observedAt - core.claims.parseDurationMs(active);
  const recent = new Map<core.ActorId, readonly core.state.TicketState[]>();
  for (const [actor, tickets] of byActor) {
    const current = tickets.filter(
      (ticket) =>
        ticket.lease?.firstSeenMs !== undefined &&
        ticket.lease.firstSeenMs >= cutoff,
    );
    if (current.length > 0) recent.set(actor, current);
  }
  return groupActiveByParent(recent, events);
}

function groupActiveByParent(
  byActor: ReadonlyMap<core.ActorId, readonly core.state.TicketState[]>,
  events: readonly core.events.EventRecord[],
): readonly ActiveActorGroup[] {
  const byParent = new Map<string, string[]>();
  const eventsById = new Map(events.map((record) => [record.event.id, record]));
  for (const [actor, tickets] of byActor) {
    const parent = leaseParentOf(tickets, eventsById) ?? parentFor(actor);
    const bucket = byParent.get(parent) ?? [];
    bucket.push(...tickets.map((ticket) => ticket.id));
    byParent.set(parent, bucket);
  }
  return [...byParent.entries()]
    .map(([parent, tickets]) => ({ parent, tickets: tickets.sort() }))
    .sort((a, b) => a.parent.localeCompare(b.parent));
}

function leaseParentOf(
  tickets: readonly core.state.TicketState[],
  events: ReadonlyMap<string, core.events.EventRecord>,
): string | undefined {
  for (const ticket of tickets) {
    const record =
      ticket.lease?.eventId === undefined
        ? undefined
        : events.get(ticket.lease.eventId);
    if (record?.event.parent !== undefined) return record.event.parent;
  }
  return undefined;
}

function parentFor(actor: string): string {
  const parsed = core.actor.parseActor(actor);
  return parsed.tool !== null ? `${parsed.tool}:${parsed.name}` : parsed.name;
}
