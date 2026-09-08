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
  /** The raw event records that produced `state`, from the same `events.read()` call. */
  readonly events: readonly core.events.EventRecord[];
}

/**
 * Mirrors `claims/claim.ts`'s own `computeTrailingMonths` formula so the CLI's
 * board snapshot folds from the same trailing window core claims folds from:
 * `clamp(max(2, ceil(leaseTtlMs / 30 days) + 1), 1, 120)`. Extracted to a
 * named helper rather than inlined because the two layers must not drift —
 * a lease taken out near a month boundary must still be visible after the
 * boundary rolls over (core claims' documented contract to `events.read`),
 * and `events.read`'s default of 2 is a floor, not a value tuned to a lease.
 */
function computeTrailingMonths(leaseTtlMs: number): number {
  const windowMonthMs = 30 * 24 * 60 * 60 * 1000;
  return Math.min(
    120,
    Math.max(1, Math.max(2, Math.ceil(leaseTtlMs / windowMonthMs) + 1)),
  );
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
      trailingMonths: computeTrailingMonths(leaseTtlMs),
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
    // `OrderableTicket.backer` drives `backer` sort/filter/queue terms. The
    // ticket schema has no top-level `backer` field — `cankan.origin` (the
    // backer type this ticket was synced from, e.g. "github") is the source
    // it descends from — so that frontmatter value is lifted in as `backer`
    // here. Only when the block records it; a native ticket has no origin
    // and thus no backer.
    ...(parsed?.cankan?.origin !== undefined
      ? { backer: parsed.cankan.origin }
      : {}),
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
  /** A duration string overriding the claim event's `lease_until` display field — the same `ClaimParams.lease` the direct `core.claims.claim` path accepts. */
  readonly lease?: string;
  /** The human an agent inherits from, written to the claim event's `parent` — the same `ClaimParams.parent` the direct `core.claims.claim` path accepts. */
  readonly parent?: string;
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
        ...(options.lease !== undefined ? { lease: options.lease } : {}),
        ...(options.parent !== undefined
          ? { parent: options.parent as core.ActorId }
          : {}),
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
    try {
      results.push(
        await core.claims.renew({
          board,
          ticket: ticket.id,
          actor: actor as core.ActorId,
        }),
      );
    } catch (error) {
      // A stale/forfeited claim (claimed or released out from underneath the
      // sweep's initial fold) surfaces per-ticket as a `CLAIM_REJECTED`
      // (`reason: not-held`/`not-holder`/`lease-expired`). That is a race, not
      // an operational failure — skip it and keep renewing the rest. Every
      // other error (an observation-store failure, a git failure) propagates.
      if (isLostClaimRace(error)) continue;
      throw error;
    }
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
    try {
      results.push(
        await core.claims.release({
          board,
          ticket: ticket.id,
          actor: actor as core.ActorId,
        }),
      );
    } catch (error) {
      // Same per-ticket race tolerance as `renewAll` — a `CLAIM_REJECTED`
      // outcome for one ticket must not abort the remaining releases.
      if (isLostClaimRace(error)) continue;
      throw error;
    }
  }
  return results;
}

/** A `CLAIM_REJECTED` outcome is a per-ticket race (claimed/released out from underneath an all-tickets sweep), never an operational failure — see `renewAll`/`releaseAll`. */
function isLostClaimRace(error: unknown): boolean {
  return (
    core.isCanKanError(error) && error.code === core.ErrorCodes.CLAIM_REJECTED
  );
}

// ============================================================================
// Explicit claim — `claim <id>` enforces `claims.require_ready` (fix: eager
// policy enforcement; the CAS in `core.claims.claim` alone never reads it).
// ============================================================================

/** Mirrors `claims/claim.ts`'s file-private `resolveTicket` (id/displayId only, ambiguity checked first) so `claim <id>` resolves the requested ticket against the same board state it will gate on, before handing it to `core.claims.claim`. Duplicated (not importable from `claims/`) with identical normalization and failure codes. */
function resolveTicketInState(
  state: core.state.BoardState,
  ticketQuery: string,
): core.state.TicketState {
  const key = core.ticket.normalizeTicketIdForComparison(ticketQuery);
  if (state.duplicateTicketIds.some((d) => d.ticketId === key)) {
    throw new core.CanKanError(
      core.claims.ClaimErrorCodes.TICKET_AMBIGUOUS,
      `ticket "${ticketQuery}" is ambiguous: more than one on-disk ticket file declares this id`,
      { details: { ticket: ticketQuery } },
    );
  }
  const matches = state.tickets.filter((t) => {
    if (core.ticket.normalizeTicketIdForComparison(t.id) === key) return true;
    return (
      t.displayId !== undefined &&
      core.ticket.normalizeTicketIdForComparison(t.displayId) === key
    );
  });
  if (matches.length > 1) {
    throw new core.CanKanError(
      core.claims.ClaimErrorCodes.TICKET_AMBIGUOUS,
      `ticket "${ticketQuery}" is ambiguous: more than one ticket matches this id or display id`,
      { details: { ticket: ticketQuery, matches: matches.length } },
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new core.CanKanError(
      core.claims.ClaimErrorCodes.TICKET_NOT_FOUND,
      `no ticket found matching "${ticketQuery}"`,
      { details: { ticket: ticketQuery } },
    );
  }
  return match;
}

export interface ClaimExplicitOptions {
  readonly force?: boolean;
  readonly lease?: string;
  readonly parent?: string;
  /** Normalized frontmatter `dependencies` overrides (used by tests). */
  readonly flatDependencies?: Readonly<Record<string, readonly string[]>>;
}

/**
 * `claim <id>`: enforce `config.value.claims.require_ready` before calling
 * `core.claims.claim`. When the policy is true (the default) and this is **not
 * a `--force` takeover**, a fresh snapshot's `core.deps.isReady` verdict gates
 * the claim — a non-ready ticket (claimed, closed, or carrying an open
 * blocker) is rejected with `core.ErrorCodes.CLAIM_REJECTED` /
 * `details.reason: "not-ready"`, *before* the CAS-based `claim` ever runs.
 *
 * `--force` skips the readiness gate (and the `require_ready: false` path
 * skips it too): a takeover exists precisely to displace a *live* claim, which
 * `isReady` always reports as the `"claimed"` blocker — gating a force over
 * `isReady` would make every takeover reject itself. Closure stays enforced
 * by `core.claims.claim`'s own `closed` check regardless.
 */
export async function claimExplicit(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: string,
  config: core.config.ConfigResult,
  ticketId: string,
  options: ClaimExplicitOptions = {},
): Promise<core.claims.ClaimResult> {
  const baseParams = {
    force: options.force,
    lease: options.lease,
    parent: options.parent as core.ActorId | undefined,
  };

  const requireReady =
    config.value.claims.require_ready && baseParams.force !== true;

  if (!requireReady) {
    return core.claims.claim({
      board,
      ticket: ticketId,
      actor: actor as core.ActorId,
      ...(baseParams.force ? { force: true } : {}),
      ...(baseParams.lease !== undefined ? { lease: baseParams.lease } : {}),
      ...(baseParams.parent !== undefined ? { parent: baseParams.parent } : {}),
    });
  }

  const snapshot = await snapshotBoard(coreHandle, board, config);
  const target = resolveTicketInState(snapshot.state, ticketId);
  const isReadyOptions = readinessOptions(
    config,
    snapshot.frontmatter,
    options.flatDependencies ?? {},
  );
  const verdict = core.deps.isReady(snapshot.state, target.id, isReadyOptions);
  if (!verdict.ready) {
    throw new core.CanKanError(
      core.ErrorCodes.CLAIM_REJECTED,
      `claim rejected (not-ready) for ticket "${target.id}"`,
      { details: { reason: "not-ready", ticket: target.id } },
    );
  }

  return core.claims.claim({
    board,
    ticket: target.id,
    actor: actor as core.ActorId,
    ...(baseParams.force ? { force: true } : {}),
    ...(baseParams.lease !== undefined ? { lease: baseParams.lease } : {}),
    ...(baseParams.parent !== undefined ? { parent: baseParams.parent } : {}),
  });
}

/**
 * Validates and parses the `--limit` flag: a finite, non-negative integer, or
 * undefined when absent. Anything else is caller misuse (`core.ErrorCodes.USAGE`) —
 * a fractional, negative, `NaN`, or `Infinity` limit would silently mis-slice
 * the ready listing. `Number.isInteger` already rejects every non-finite value.
 */
export function parseLimitOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      `--limit must be a finite non-negative integer, got "${raw}"`,
      { details: { limit: raw } },
    );
  }
  return value;
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
  readonly target?: string;
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
      const limit = parseLimitOption(parsed.limit);
      context.output.write(
        await coordReady(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {
            ...(limit !== undefined ? { limit } : {}),
            ...(parsed.label !== undefined ? { label: parsed.label } : {}),
            ...(parsed.milestone !== undefined
              ? { milestone: parsed.milestone }
              : {}),
            ...(parsed.backer !== undefined ? { backer: parsed.backer } : {}),
            ...(parsed.order !== undefined ? { order: parsed.order } : {}),
            ...(parsed.queue !== undefined ? { queue: parsed.queue } : {}),
          },
        ),
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
    label: { type: "string", description: "Restrict --next to a label" },
    milestone: {
      type: "string",
      description: "Restrict --next to a milestone",
    },
    backer: { type: "string", description: "Restrict --next to a backer" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      const parent =
        context.actor.parent === null ? undefined : context.actor.parent;
      if (parsed.next) {
        const result = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {
            ...(parsed.queue !== undefined ? { queue: parsed.queue } : {}),
            ...(parsed.order !== undefined ? { order: parsed.order } : {}),
            ...(parsed.lease !== undefined ? { lease: parsed.lease } : {}),
            ...(parsed.label !== undefined ? { label: parsed.label } : {}),
            ...(parsed.milestone !== undefined
              ? { milestone: parsed.milestone }
              : {}),
            ...(parsed.backer !== undefined ? { backer: parsed.backer } : {}),
            ...(parent !== undefined ? { parent } : {}),
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
        await claimExplicit(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          parsed.id,
          {
            ...(parsed.force ? { force: true } : {}),
            ...(parsed.lease !== undefined ? { lease: parsed.lease } : {}),
            ...(parent !== undefined ? { parent } : {}),
          },
        ),
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
    // Named `target`, never `actor`, so this positional does not shadow the
    // global `--actor` flag (which `GlobalArgs` already declares): a bare
    // second word on `cankan assign <id> <target>` must not collide with
    // "--actor" in citty's flag registration.
    target: { type: "positional", description: "Actor to assign" },
  },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      if (parsed.id === undefined || parsed.target === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          "assign requires an id and a target actor",
        );
      }
      const stored = await context.core.store.get(parsed.id);
      if (stored === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          `no ticket found matching "${parsed.id}"`,
        );
      }
      const [assignee] = resolveAssignActors([parsed.target]);
      const updated = core.ticket.setSequenceField(stored.ticket, "assignee", [
        assignee,
      ]);
      const written = await context.core.store.write(updated);
      context.output.write({ id: written.id, assignee: [assignee] });
    });
  },
});

export interface MineResult {
  readonly claims: readonly string[];
  readonly assignments: readonly string[];
}

/** `mine`: this actor's live claims plus any tickets whose frontmatter `assignee` names them. */
export async function mine(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  actor: string,
  config: core.config.ConfigResult,
): Promise<MineResult> {
  const { state, frontmatter } = await snapshotBoard(coreHandle, board, config);
  const claims = core.state.claimedBy(state).get(actor as core.ActorId) ?? [];
  const assignments: string[] = [];
  for (const parsedTicket of frontmatter.values()) {
    const assignees = parsedTicket.frontmatter.assignee ?? [];
    if (assignees.some((a) => a === actor)) {
      assignments.push(parsedTicket.frontmatter.id);
    }
  }
  return {
    claims: claims.map((t) => t.id).sort(),
    assignments: assignments.sort(),
  };
}

export const coordMineCommand = defineCommand({
  meta: { name: "mine", description: "My claims and assignments" },
  args: { ...globalArgs },
  async run({ args }) {
    const parsed = args as CoordArgs;
    await withCoordContext(parsed, async (context) => {
      context.output.write(
        await mine(
          context.core,
          context.board,
          context.actor.id,
          context.config,
        ),
      );
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
      if (parsed.active) {
        context.output.write(
          await activeActors(context.core, context.board, context.config),
        );
        return;
      }
      const byActor = core.state.claimedBy(state);
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

export interface ActiveActorGroup {
  readonly parent: string;
  readonly tickets: readonly string[];
}

/** `actors --active`: groups this snapshot's live claims by parent human, sorted by parent. */
export async function activeActors(
  coreHandle: CoreHandle,
  board: core.BoardRef,
  config: core.config.ConfigResult,
): Promise<readonly ActiveActorGroup[]> {
  const { state, events } = await snapshotBoard(coreHandle, board, config);
  return groupActiveByParent(core.state.claimedBy(state), events);
}

/**
 * Groups live claims by parent human, sorted by parent. A ticket's current
 * lease anchor event may carry an explicit `parent` (the human the claiming
 * agent inherited from — CONCEPT.md §5); when the anchor event is visible in
 * this snapshot's read window and records one, that value is authoritative.
 * When it is absent (a bare-human actor, an older lease whose anchor aged out
 * of the window, or an event with no `parent` field), fall back to deriving
 * the parent from the actor's own `tool:name` shape — `leaseParentOf`/
 * `parentFor` below.
 */
function groupActiveByParent(
  byActor: ReadonlyMap<core.ActorId, readonly core.state.TicketState[]>,
  events: readonly core.events.EventRecord[],
): readonly ActiveActorGroup[] {
  const byParent = new Map<string, string[]>();
  for (const [actor, tickets] of byActor) {
    const parent = leaseParentOf(tickets, events) ?? parentFor(actor);
    const bucket = byParent.get(parent) ?? [];
    bucket.push(...tickets.map((t) => t.id));
    byParent.set(parent, bucket);
  }
  return [...byParent.entries()]
    .map(([parent, tickets]) => ({ parent, tickets: tickets.sort() }))
    .sort((a, b) => a.parent.localeCompare(b.parent));
}

/** The current lease anchor event's recorded `parent`, if any of `tickets`' live leases has an anchor visible in `events` that carries one. Returns the first (and normally only) such parent — every ticket in one actor's `claimedBy` bucket shares that actor, and multi-ticket actors hold a single parent per CONCEPT.md §5. */
function leaseParentOf(
  tickets: readonly core.state.TicketState[],
  events: readonly core.events.EventRecord[],
): string | undefined {
  for (const ticket of tickets) {
    const anchorId = ticket.lease?.eventId;
    if (anchorId === undefined) continue;
    const record = events.find((r) => r.event.id === anchorId);
    if (record?.event.parent !== undefined) {
      return record.event.parent;
    }
  }
  return undefined;
}

/** Derives a parent-human grouping key: the `tool:name` segment when a tool is present, else the bare name. Fallback for when no event `parent` is available (see the `actors --active` handler). */
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
