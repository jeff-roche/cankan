import * as core from "@jeff-roche/cankan-core";
import {
  buildContext,
  globalArgs,
  type Context,
  type GlobalArgs,
} from "../../context";
import { defineCommand } from "../../registry";
import {
  activeActors,
  assignTicket,
  claimExplicit,
  claimNext,
  coordReady,
  listActors,
  mine,
  parseLimitOption,
  releaseAll,
  renewAll,
  runExpireSweep,
} from "./logic";

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
  readonly target?: string;
  readonly dryRun?: boolean;
  readonly active?: string;
}

function coordArgs(args: unknown): CoordArgs {
  return args as CoordArgs;
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
    const parsed = coordArgs(args);
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
    const parsed = coordArgs(args);
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
            ...(parsed.label !== undefined ? { label: parsed.label } : {}),
            ...(parsed.milestone !== undefined
              ? { milestone: parsed.milestone }
              : {}),
            ...(parsed.backer !== undefined ? { backer: parsed.backer } : {}),
            ...(parsed.lease !== undefined ? { lease: parsed.lease } : {}),
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
    const parsed = coordArgs(args);
    await withCoordContext(parsed, async (context) => {
      if (parsed.id === undefined) {
        context.output.write(
          await renewAll(
            context.core,
            context.board,
            context.actor.id,
            context.config,
            parsed.lease !== undefined ? { lease: parsed.lease } : {},
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
    const parsed = coordArgs(args);
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
    target: { type: "positional", description: "Actor to assign" },
  },
  async run({ args }) {
    const parsed = coordArgs(args);
    await withCoordContext(parsed, async (context) => {
      if (parsed.id === undefined || parsed.target === undefined) {
        throw new core.CanKanError(
          core.ErrorCodes.USAGE,
          "assign requires an id and a target actor",
        );
      }
      context.output.write(
        await assignTicket(
          context.core,
          context.board,
          context.config,
          parsed.id,
          parsed.target,
        ),
      );
    });
  },
});

export const coordMineCommand = defineCommand({
  meta: { name: "mine", description: "My claims and assignments" },
  args: { ...globalArgs },
  async run({ args }) {
    const parsed = coordArgs(args);
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
      type: "string",
      description: "Show claims active within a duration, grouped by parent",
    },
  },
  async run({ args }) {
    const parsed = coordArgs(args);
    await withCoordContext(parsed, async (context) => {
      if (parsed.active !== undefined) {
        context.output.write(
          await activeActors(
            context.core,
            context.board,
            context.config,
            parsed.active,
          ),
        );
        return;
      }
      const result = await listActors(
        context.core,
        context.board,
        context.config,
      );
      context.output.write(result);
    });
  },
});

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
    const parsed = coordArgs(args);
    await withCoordContext(parsed, async (context) => {
      context.output.write(
        await runExpireSweep(context.board, context.actor.id, {
          ...(parsed.dryRun ? { dryRun: true } : {}),
        }),
      );
    });
  },
});
