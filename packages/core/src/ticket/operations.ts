import { loadBoardConfig } from "../board/index";
import { CanKanError, ErrorCodes } from "../errors";
import { append, type EventId } from "../events/index";
import { createGitAdapter, type GitAdapter } from "../git/index";
import { dispatchHooks } from "../hooks/dispatch";
import { StoreErrorCodes } from "../store/errors";
import { openTicketStore, type TicketStore } from "../store/ticketStore";
import type { ActorId, BoardRef, TicketId } from "../types";
import { parseTicketFile, setScalarField } from "./frontmatter";

interface TicketContext {
  readonly board: BoardRef;
  readonly now: number;
  readonly adapter: GitAdapter;
  readonly store: TicketStore;
  readonly ref: string;
  readonly config: Awaited<ReturnType<typeof loadBoardConfig>>;
}

async function resolveContext(
  board: BoardRef,
  now: number,
): Promise<TicketContext> {
  const adapter = await createGitAdapter(board.root);
  const store = await openTicketStore({
    board,
    gitDirs: [await adapter.gitCommonDir()],
  });
  return {
    board,
    now,
    adapter,
    store,
    ref: board.coordinationRef,
    config: await loadBoardConfig(board),
  };
}

async function requireTicket(store: TicketStore, ticket: string) {
  const stored = await store.get(ticket);
  if (!stored) {
    throw new CanKanError(
      StoreErrorCodes.TICKET_NOT_FOUND,
      `no ticket found matching "${ticket}"`,
    );
  }
  return stored;
}

export interface CreateParams {
  readonly board: BoardRef;
  readonly ticket: TicketId;
  readonly title: string;
  readonly status?: string;
  readonly body?: string;
  readonly actor: ActorId;
  readonly now?: number;
}

export interface TicketEventResult {
  readonly ticket: TicketId;
  readonly eventId: EventId;
}

export async function create(params: CreateParams): Promise<TicketEventResult> {
  const now = params.now ?? Date.now();
  const ctx = await resolveContext(params.board, now);
  const previous = await ctx.store.get(params.ticket);
  const raw = `---\nid: ${params.ticket}\ntitle: ${JSON.stringify(params.title)}\nstatus: ${JSON.stringify(params.status ?? "To Do")}\n---\n\n${params.body ?? ""}\n`;
  const stored = await ctx.store.write(parseTicketFile(raw));
  let appended: Awaited<ReturnType<typeof append>>;
  try {
    appended = await append(
      ctx.adapter,
      ctx.ref,
      {
        event: "create",
        ts: new Date(now).toISOString(),
        actor: params.actor,
        ticket: stored.id,
      },
      { now },
    );
  } catch (error) {
    try {
      if (previous) await ctx.store.write(previous.ticket);
      else await ctx.store.remove(stored.id);
    } catch (rollbackError) {
      throw new CanKanError(
        ErrorCodes.GENERIC_ERROR,
        "create failed and restoring the ticket file also failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  await dispatchHooks(ctx, "create", stored.id, params.actor);
  return { ticket: stored.id, eventId: appended.event.id };
}

export interface MoveParams {
  readonly board: BoardRef;
  readonly ticket: string;
  readonly to: string;
  readonly actor: ActorId;
  readonly now?: number;
}

export async function move(params: MoveParams): Promise<TicketEventResult> {
  const now = params.now ?? Date.now();
  const ctx = await resolveContext(params.board, now);
  const stored = await requireTicket(ctx.store, params.ticket);
  const from = stored.ticket.frontmatter.status;
  const updated = setScalarField(stored.ticket, "status", params.to);
  await ctx.store.write(updated);
  let appended: Awaited<ReturnType<typeof append>>;
  try {
    appended = await append(
      ctx.adapter,
      ctx.ref,
      {
        event: "move",
        ts: new Date(now).toISOString(),
        actor: params.actor,
        ticket: stored.id,
        from,
        to: params.to,
      },
      { now },
    );
  } catch (error) {
    try {
      await ctx.store.write(stored.ticket);
    } catch (rollbackError) {
      throw new CanKanError(
        ErrorCodes.GENERIC_ERROR,
        "move failed and restoring the ticket file also failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  await dispatchHooks(ctx, "move", stored.id, params.actor, {
    from,
    to: params.to,
  });
  return { ticket: stored.id, eventId: appended.event.id };
}

export interface CloseParams {
  readonly board: BoardRef;
  readonly ticket: string;
  readonly actor: ActorId;
  readonly reason?: string;
  readonly now?: number;
}

export async function close(params: CloseParams): Promise<TicketEventResult> {
  const now = params.now ?? Date.now();
  const ctx = await resolveContext(params.board, now);
  const stored = await requireTicket(ctx.store, params.ticket);
  const appended = await append(
    ctx.adapter,
    ctx.ref,
    {
      event: "close",
      ts: new Date(now).toISOString(),
      actor: params.actor,
      ticket: stored.id,
      ...(params.reason === undefined ? {} : { reason: params.reason }),
    },
    { now },
  );
  await dispatchHooks(ctx, "close", stored.id, params.actor);
  return { ticket: stored.id, eventId: appended.event.id };
}
