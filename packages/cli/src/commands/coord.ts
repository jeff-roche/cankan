import * as core from "@jeff-roche/cankan-core";
import {
  buildContext,
  globalArgs,
  type Context,
  type CoreHandle,
  type GlobalArgs,
} from "../context";
import { defineCommand } from "../registry";

// ============================================================================
// Board snapshot — the CLI composes the snapshot: adapter/event read, ticket
// store list, then `core.state.observeAndFold`. The CLI is the first layer
// where claims/deps/order are all legal dependencies (PLAN.md M3.5), so
// readiness enforcement and queue resolution live here rather than in
// `core.claims` (whose own docs defer both to this task).
// ============================================================================

interface Snapshot {
  readonly state: core.state.BoardState;
  /** `normalized id -> parsed frontmatter`, from the same store.list() the fold consumed. */
  readonly frontmatter: ReadonlyMap<string, core.ticket.ParsedTicket>;
}

async function snapshotBoard(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  config: core.config.ConfigResult,
): Promise<Snapshot> {
  const now = Date.now();
  const leaseTtlMs = core.claims.parseDurationMs(config.value.claims.lease);
  const events = await core.events.read(
    coreHandle.adapter,
    board.coordinationRef,
    {
      now,
      trailingMonths: 2,
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
  return { state, frontmatter };
}

// ============================================================================
// Readiness inputs — flat frontmatter `dependencies`, frontmatter `labels`,
// and `config.value.ready.exclude_labels`, assembled by the CLI (deps/ and
// state/ cannot reach into `ticket/`; the CLI can).
// ============================================================================

function labelLookup(
  frontmatter: ReadonlyMap<string, core.ticket.ParsedTicket>,
): (ticketId: string) => readonly string[] {
  return (ticketId) => {
    const id = ticketId.toLowerCase();
    return frontmatter.get(id)?.frontmatter.labels ?? [];
  };
}

function flatDependencyLookup(
  frontmatter: ReadonlyMap<string, core.ticket.ParsedTicket>,
  overrides: Readonly<Record<string, readonly string[]>>,
): (ticketId: string) => readonly string[] {
  return (ticketId) => {
    const id = ticketId.toLowerCase();
    return overrides[id] ?? frontmatter.get(id)?.frontmatter.dependencies ?? [];
  };
}

function readinessOptions(
  config: core.config.ConfigResult,
  frontmatter: ReadonlyMap<string, core.ticket.ParsedTicket>,
  overrides: Readonly<Record<string, readonly string[]>>,
): core.deps.IsReadyOptions {
  const excludedLabels = config.value.ready.exclude_labels ?? [];
  return {
    ...(excludedLabels.length > 0 ? { excludedLabels } : {}),
    ...(excludedLabels.length > 0
      ? { labelsFor: labelLookup(frontmatter) }
      : {}),
    flatDependenciesFor: flatDependencyLookup(frontmatter, overrides),
  };
}

// ============================================================================
// Queue/order resolution — explicit `--queue`, then the actor-pattern queue,
// then `ready.order` (overridden by `--order`).
// ============================================================================

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
  /** Extra CLI-level filters layered on top of the queue's own filter. */
  readonly matches: (ticket: core.order.OrderableTicket) => boolean;
}

function resolveOrder(
  config: core.config.ConfigResult,
  options: {
    readonly queue?: string;
    readonly order?: string;
  } & FilterOverrides,
  actor: string,
): ResolvedOrder {
  const queue = core.order.resolveQueue(
    config.value.queues,
    options.queue,
    options.order === undefined ? actor : undefined,
  );

  if (queue !== undefined) {
    const cliFilter = cliFilterMatches(options);
    return {
      compare: queue.compare,
      matches: (ticket) => queue.matches(ticket) && cliFilter(ticket),
    };
  }

  const orderString = options.order ?? config.value.ready.order.join(",");
  const terms = core.order.parseOrder(orderString);
  const compare = core.order.comparatorFor(terms);
  const cliFilter = cliFilterMatches(options);
  return { compare, matches: cliFilter };
}

function cliFilterMatches(
  options: FilterOverrides,
): (ticket: core.order.OrderableTicket) => boolean {
  return (ticket) => {
    if (options.label !== undefined) {
      if (!(ticket.labels ?? []).includes(options.label)) return false;
    }
    if (
      options.milestone !== undefined &&
      ticket.milestone !== options.milestone
    ) {
      return false;
    }
    if (options.backer !== undefined && ticket.backer !== options.backer) {
      return false;
    }
    return true;
  };
}

// ============================================================================
// Ticket views — the shared listing behind `ready` and `claim --next`.
// ============================================================================

function orderableFor(
  ticket: core.state.TicketState,
  frontmatter: ReadonlyMap<string, core.ticket.ParsedTicket>,
): core.order.OrderableTicket {
  const parsed = frontmatter.get(ticket.id.toLowerCase())?.frontmatter;
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
  };
}

/** A ready candidate for `claim --next`, carrying enough to display and to re-claim. */
interface ReadyCandidate {
  readonly ticket: core.state.TicketState;
  readonly view: core.order.OrderableTicket;
  readonly verdict: core.deps.ReadinessVerdict;
}

/**
 * The ordered ready candidates: every open, unclaimed ticket (closure of the
 * fold, `closed` sticky + no live lease), filtered by queue/CLI filters,
 * sorted by the resolved order. When `requireReady` is true, readiness is
 * also required (via `core.deps.isReady` calling `core.state.blockedBy`);
 * when false, an open ticket is claimable regardless of blockers.
 */
function readyCandidates(
  snapshot: Snapshot,
  isReadyOptions: core.deps.IsReadyOptions,
  order: ResolvedOrder,
  requireReady: boolean,
): ReadyCandidate[] {
  const candidates: ReadyCandidate[] = [];
  for (const ticket of snapshot.state.tickets) {
    if (ticket.closed) continue;
    if (ticket.lease !== undefined && !ticket.lease.expired) continue;
    const view = orderableFor(ticket, snapshot.frontmatter);
    if (!order.matches(view)) continue;
    if (requireReady) {
      const verdict = core.deps.isReady(
        snapshot.state,
        ticket.id,
        isReadyOptions,
      );
      if (!verdict.ready) continue;
      candidates.push({ ticket, view, verdict });
    } else {
      candidates.push({
        ticket,
        view,
        verdict: { ready: true, reasons: [] },
      });
    }
  }
  candidates.sort((a, b) => order.compare(a.view, b.view));
  return candidates;
}

// ============================================================================
// Core flows — the command handlers run these against a built Context.
// ============================================================================

export interface CoordListOptions extends FilterOverrides {
  readonly queue?: string;
  readonly order?: string;
  readonly limit?: number;
  /** Normalized frontmatter `dependencies` overrides (used by tests). */
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

/** `ready`: lists open, unclaimed, unblocked tickets under the resolved order. */
export async function coordReady(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: string,
  config: core.config.ConfigResult,
  options: CoordListOptions,
): Promise<ReadyResult> {
  await runExpireSweep(board, actor, { dryRun: false });
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const isReadyOptions = readinessOptions(
    config,
    snapshot.frontmatter,
    options.flatDependencies ?? {},
  );
  const order = resolveOrder(config, options, "");
  const candidates = readyCandidates(snapshot, isReadyOptions, order, true);
  const limited =
    options.limit === undefined
      ? candidates
      : candidates.slice(0, options.limit);
  return {
    tickets: limited.map((candidate) => {
      const view = candidate.view;
      return {
        id: candidate.ticket.id,
        title: view.title ?? candidate.ticket.id,
        status: candidate.ticket.status,
        ...(view.priority !== undefined ? { priority: view.priority } : {}),
        ...(view.milestone !== undefined ? { milestone: view.milestone } : {}),
        labels: view.labels ?? [],
        reasons: candidate.verdict.reasons,
      };
    }),
  };
}

/** `expire`: sweeps expired leases; `--dry-run` reports without mutating. */
export async function runExpireSweep(
  board: core.BoardRef,
  actor: string,
  options: { readonly dryRun?: boolean },
): Promise<core.claims.ExpireStaleResult> {
  return core.claims.expireStale({
    board,
    actor: actor as core.ActorId,
    ...(options.dryRun ? { dryRun: true } : {}),
  });
}

export interface ClaimNextOptions extends FilterOverrides {
  readonly queue?: string;
  readonly order?: string;
  readonly flatDependencies?: Readonly<Record<string, readonly string[]>>;
}

/**
 * `claim --next`: from the ordered ready candidates, attempt each in turn,
 * skipping past a claim race/rejection and retrying later candidates while
 * preserving core error semantics (any non-rejection error propagates).
 */
export async function claimNext(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: string,
  config: core.config.ConfigResult,
  options: ClaimNextOptions,
): Promise<core.claims.ClaimResult | undefined> {
  await runExpireSweep(board, actor, {});
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const isReadyOptions = readinessOptions(
    config,
    snapshot.frontmatter,
    options.flatDependencies ?? {},
  );
  const order = resolveOrder(config, options, actor);
  const candidates = readyCandidates(
    snapshot,
    isReadyOptions,
    order,
    config.value.claims.require_ready,
  );

  for (const candidate of candidates) {
    try {
      return await core.claims.claim({
        board,
        ticket: candidate.ticket.id,
        actor: actor as core.ActorId,
      });
    } catch (error) {
      if (
        error instanceof core.CanKanError &&
        (error.code === core.ErrorCodes.CLAIM_REJECTED ||
          error.code === core.claims.ClaimErrorCodes.TICKET_NOT_FOUND ||
          error.code === core.claims.ClaimErrorCodes.TICKET_AMBIGUOUS)
      ) {
        continue; // a race lost against this candidate — try the next.
      }
      throw error;
    }
  }
  return undefined;
}

/** `renew` without an id: renews every live claim the actor holds. */
export async function renewAll(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: string,
  config: core.config.ConfigResult,
): Promise<readonly core.claims.RenewResult[]> {
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const mine =
    core.state.claimedBy(snapshot.state).get(actor as core.ActorId) ?? [];
  const results: core.claims.RenewResult[] = [];
  for (const ticket of mine) {
    results.push(
      await core.claims.renew({
        board,
        ticket: ticket.id,
        actor: actor as core.ActorId,
      }),
    );
  }
  return results;
}

/** `release --all`: releases every live claim the actor holds. */
export async function releaseAll(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: string,
  config: core.config.ConfigResult,
): Promise<readonly core.claims.ReleaseResult[]> {
  const snapshot = await snapshotBoard(coreHandle, board, config);
  const mine =
    core.state.claimedBy(snapshot.state).get(actor as core.ActorId) ?? [];
  const results: core.claims.ReleaseResult[] = [];
  for (const ticket of mine) {
    results.push(
      await core.claims.release({
        board,
        ticket: ticket.id,
        actor: actor as core.ActorId,
      }),
    );
  }
  return results;
}

// ============================================================================
// assign — a frontmatter assignee hint, not a lease.
// ============================================================================

/**
 * Validates and normalizes the actor strings an `assign` command receives.
 */
export function resolveAssignActors(values: readonly string[]): string[] {
  return values.map((value) =>
    core.actor.formatActor(core.actor.parseActor(value)),
  );
}

/** Serializes a ticket's `assignee` field to a flat flow list, preserving the rest of the file. */
export function serializeAssignees(
  ticket: core.ticket.ParsedTicket,
  assignees: readonly string[],
): string {
  return core.ticket.serializeTicketFile(
    core.ticket.setSequenceField(ticket, "assignee", assignees),
  );
}

// ============================================================================
// Command definitions and handlers.
// ============================================================================

interface CoordArgs extends GlobalArgs {
  readonly id?: string;
  readonly limit?: string;
  readonly label?: string;
  readonly milestone?: string;
  readonly backer?: string;
  readonly order?: string;
  readonly queue?: string;
  readonly next?: boolean;
  readonly force?: boolean;
  readonly lease?: string;
  readonly all?: boolean;
  readonly actor?: string;
  readonly dryRun?: boolean;
  readonly active?: boolean;
}

async function withCoordContext<T>(
  args: CoordArgs,
  action: (context: Context) => Promise<T>,
): Promise<T> {
  const context = await buildContext(args);
  try {
    return await action(context);
  } finally {
    context.core.dispose();
  }
}

export const coordReadyCommand = defineCommand({
  meta: {
    name: "ready",
    description: "List open, unclaimed, unblocked tickets",
  },
  args: {
    ...globalArgs,
    limit: { type: "string", description: "Maximum number of tickets" },
    label: { type: "string", description: "Filter by label" },
    milestone: { type: "string", description: "Filter by milestone" },
    backer: { type: "string", description: "Filter by backer" },
    order: { type: "string", description: "Sort keys" },
    queue: { type: "string", description: "Named queue" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      context.output.write(
        await coordReady(context.core, context.board, context.actor.id, context.config, {
          ...(parsed.limit !== undefined
            ? { limit: Number(parsed.limit) }
            : {}),
          ...(parsed.label !== undefined ? { label: parsed.label } : {}),
          ...(parsed.milestone !== undefined
            ? { milestone: parsed.milestone }
            : {}),
          ...(parsed.backer !== undefined ? { backer: parsed.backer } : {}),
          ...(parsed.order !== undefined ? { order: parsed.order } : {}),
          ...(parsed.queue !== undefined ? { queue: parsed.queue } : {}),
        }),
      );
    });
  },
});

export const coordClaimCommand = defineCommand({
  meta: {
    name: "claim",
    description:
      "Claim a ticket (CAS lease); --next claims the top ready ticket",
  },
  args: {
    ...globalArgs,
    id: { type: "positional", description: "Ticket id", required: false },
    next: { type: "boolean", description: "Claim the top ready ticket" },
    force: { type: "boolean", description: "Take over an existing claim" },
    lease: { type: "string", description: "Lease duration override" },
    queue: { type: "string", description: "Named queue" },
    order: { type: "string", description: "Sort keys" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      if (parsed.next) {
        const result = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {
            ...(parsed.queue !== undefined ? { queue: parsed.queue } : {}),
            ...(parsed.order !== undefined ? { order: parsed.order } : {}),
          },
        );
        context.output.write(result === undefined ? { claimed: null } : result);
        return;
      }
      if (parsed.id === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          "claim requires an id or --next",
        );
      }
      context.output.write(
        await core.claims.claim({
          board: context.board,
          ticket: parsed.id,
          actor: context.actor.id,
          ...(parsed.force ? { force: true } : {}),
          ...(parsed.lease !== undefined ? { lease: parsed.lease } : {}),
        }),
      );
    });
  },
});

export const coordRenewCommand = defineCommand({
  meta: {
    name: "renew",
    description: "Extend a lease; no id renews all your claims",
  },
  args: {
    ...globalArgs,
    id: { type: "positional", description: "Ticket id", required: false },
    lease: { type: "string", description: "Lease duration override" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      if (parsed.id === undefined) {
        context.output.write(
          await renewAll(
            context.core,
            context.board,
            context.actor.id,
            context.config,
          ),
        );
        return;
      }
      context.output.write(
        await core.claims.renew({
          board: context.board,
          ticket: parsed.id,
          actor: context.actor.id,
          ...(parsed.lease !== undefined ? { lease: parsed.lease } : {}),
        }),
      );
    });
  },
});

export const coordReleaseCommand = defineCommand({
  meta: {
    name: "release",
    description: "Release a claim; --all releases every claim you hold",
  },
  args: {
    ...globalArgs,
    id: { type: "positional", description: "Ticket id", required: false },
    all: { type: "boolean", description: "Release every claim you hold" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      if (parsed.all) {
        context.output.write(
          await releaseAll(
            context.core,
            context.board,
            context.actor.id,
            context.config,
          ),
        );
        return;
      }
      if (parsed.id === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          "release requires an id or --all",
        );
      }
      context.output.write(
        await core.claims.release({
          board: context.board,
          ticket: parsed.id,
          actor: context.actor.id,
        }),
      );
    });
  },
});

export const coordAssignCommand = defineCommand({
  meta: {
    name: "assign",
    description: "Set a frontmatter assignee hint (not a lease)",
  },
  args: {
    ...globalArgs,
    id: { type: "positional", description: "Ticket id" },
    actor: { type: "positional", description: "Actor to assign" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      if (parsed.id === undefined || parsed.actor === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          "assign requires an id and an actor",
        );
      }
      const stored = await context.core.store.get(parsed.id);
      if (stored === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          `no ticket found matching "${parsed.id}"`,
        );
      }
      const [assignee] = resolveAssignActors([parsed.actor]);
      const updated = core.ticket.setSequenceField(stored.ticket, "assignee", [
        assignee,
      ]);
      const written = await context.core.store.write(updated);
      context.output.write({ id: written.id, assignee: [assignee] });
    });
  },
});

export const coordMineCommand = defineCommand({
  meta: { name: "mine", description: "My claims and assignments" },
  args: { ...globalArgs },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      const { state, frontmatter } = await snapshotBoard(
        context.core,
        context.board,
        context.config,
      );
      const claims = core.state.claimedBy(state).get(context.actor.id) ?? [];
      const assignments: string[] = [];
      for (const parsedTicket of frontmatter.values()) {
        const assignees = parsedTicket.frontmatter.assignee ?? [];
        if (assignees.some((a) => a === context.actor.id)) {
          assignments.push(parsedTicket.frontmatter.id);
        }
      }
      context.output.write({
        claims: claims.map((t) => t.id).sort(),
        assignments: assignments.sort(),
      });
    });
  },
});

export const coordActorsCommand = defineCommand({
  meta: { name: "actors", description: "Who is holding what" },
  args: {
    ...globalArgs,
    active: {
      type: "boolean",
      description: "Group live claims by parent human",
    },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      const { state } = await snapshotBoard(
        context.core,
        context.board,
        context.config,
      );
      const byActor = core.state.claimedBy(state);
      if (parsed.active) {
        // Group by parent human: an actor's context/`parent` segment is its
        // event parent when present; bare names group under themselves.
        const byParent = new Map<string, string[]>();
        for (const [actor, tickets] of byActor) {
          const parent = parentFor(actor);
          const bucket = byParent.get(parent) ?? [];
          bucket.push(...tickets.map((t) => t.id));
          byParent.set(parent, bucket);
        }
        context.output.write(
          [...byParent.entries()]
            .map(([parent, tickets]) => ({ parent, tickets: tickets.sort() }))
            .sort((a, b) => a.parent.localeCompare(b.parent)),
        );
        return;
      }
      context.output.write(
        [...byActor.entries()]
          .map(([actor, tickets]) => ({
            actor,
            tickets: tickets.map((t) => t.id).sort(),
          }))
          .sort((a, b) => a.actor.localeCompare(b.actor)),
      );
    });
  },
});

/** Derives a parent-human grouping key: the `tool:name/context` name segment when present, else the raw actor. */
function parentFor(actor: string): string {
  const parsed = core.actor.parseActor(actor);
  return parsed.tool !== null ? `${parsed.tool}:${parsed.name}` : parsed.name;
}

export const coordExpireCommand = defineCommand({
  meta: { name: "expire", description: "Release expired leases" },
  args: {
    ...globalArgs,
    dryRun: {
      type: "boolean",
      description: "Report what would expire without mutating",
    },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      context.output.write(
        await runExpireSweep(context.board, context.actor.id, {
          ...(parsed.dryRun ? { dryRun: true } : {}),
        }),
      );
    });
  },
});

export const coordCommand = defineCommand({
  meta: { name: "coord", description: "Coordination commands" },
  args: globalArgs,
  subCommands: {
    ready: coordReadyCommand,
    claim: coordClaimCommand,
    renew: coordRenewCommand,
    release: coordReleaseCommand,
    assign: coordAssignCommand,
    mine: coordMineCommand,
    actors: coordActorsCommand,
    expire: coordExpireCommand,
  },
});
