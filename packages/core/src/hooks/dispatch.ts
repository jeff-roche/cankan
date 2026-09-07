import type { ConfigResult } from "../config/index";
import { CanKanError } from "../errors";
import { append } from "../events/index";
import type { GitAdapter } from "../git/index";
import { StoreErrorCodes } from "../store/errors";
import type { TicketStore } from "../store/index";
import type { ActorId, BoardRef, TicketId } from "../types";
import { type HookEvent, type HookEventRecord, runHooks } from "./runner";

export interface HookDispatchContext {
  readonly adapter: GitAdapter;
  readonly ref: string;
  readonly config: ConfigResult;
  readonly board: BoardRef;
  readonly store: TicketStore;
  readonly now: number;
}

/** Runs hooks after their source event and records one hook event per outcome. */
export async function dispatchHooks(
  ctx: HookDispatchContext,
  event: HookEvent,
  ticket: TicketId,
  actor: ActorId,
  context: { readonly from?: string; readonly to?: string } = {},
): Promise<void> {
  const stored = await ctx.store.get(ticket);
  if (!stored) {
    throw new CanKanError(
      StoreErrorCodes.TICKET_NOT_FOUND,
      `no ticket found matching "${ticket}" while dispatching ${event} hooks`,
    );
  }
  await runHooks({
    cfg: ctx.config,
    event,
    repoRoot: ctx.board.root,
    ticket,
    actor,
    from: context.from,
    to: context.to,
    title: stored.ticket.frontmatter.title,
    sink: async (record: HookEventRecord) => {
      const output = [
        record.stdout,
        record.stderr,
        record.errorCode ?? "",
        record.timedOut ? "timed out" : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 100_000);
      await append(
        ctx.adapter,
        ctx.ref,
        {
          event: "hook",
          ts: new Date(ctx.now).toISOString(),
          actor,
          ticket,
          title: stored.ticket.frontmatter.title,
          ...(record.from ? { from: record.from } : {}),
          ...(record.to ? { to: record.to } : {}),
          output,
        },
        { now: ctx.now },
      );
    },
  });
}
