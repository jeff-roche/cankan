import * as core from "@jeff-roche/cankan-core";
import { parseDocument } from "yaml";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildContext,
  globalArgs,
  type Context,
  type GlobalArgs,
} from "../context";
import { defineCommand } from "../registry";

type TicketArgs = GlobalArgs & {
  readonly id?: string;
  readonly title?: string;
  readonly text?: string;
  readonly description?: string;
  readonly status?: string;
  readonly priority?: string;
  readonly milestone?: string;
  readonly label?: string;
  readonly labels?: string;
  readonly assign?: string;
  readonly parent?: string;
  readonly blocks?: string;
  readonly blockedBy?: string;
  readonly discoveredFrom?: string;
  readonly ac?: string;
  readonly order?: string;
  readonly query?: string;
  readonly before?: string;
  readonly after?: string;
  readonly top?: boolean;
  readonly bottom?: boolean;
  readonly normalize?: boolean;
  readonly reason?: string;
  readonly events?: boolean;
  readonly deps?: boolean;
  readonly ready?: boolean;
  readonly claimed?: boolean;
  readonly blocked?: boolean;
  readonly origin?: string;
  readonly queue?: string;
  readonly all?: boolean;
  readonly closedBefore?: string;
  readonly backer?: string;
  readonly type?: string;
  readonly other?: string;
  readonly mermaid?: boolean;
  readonly field?: string;
  readonly value?: string;
  readonly editor?: boolean;
};

const usage = (message: string): never => {
  throw new core.CanKanError(core.ErrorCodes.USAGE, message);
};

const DEPENDENCY_TYPES = [
  "blocks",
  "parent-child",
  "related",
  "discovered-from",
] as const;

async function withContext<T>(
  args: TicketArgs,
  action: (context: Context) => Promise<T>,
): Promise<T> {
  const context = await buildContext(args);
  try {
    return await action(context);
  } finally {
    context.core.dispose();
  }
}

async function getTicket(
  context: Context,
  id: string,
): Promise<core.store.StoredTicket> {
  const ticket = await context.core.store.get(id);
  if (ticket === undefined) {
    throw new core.CanKanError(
      core.store.StoreErrorCodes.TICKET_NOT_FOUND,
      `no ticket found matching "${id}"`,
    );
  }
  return ticket;
}

async function loadState(context: Context): Promise<{
  readonly state: core.state.BoardState;
  readonly events: readonly core.events.EventRecord[];
}> {
  const now = Date.now();
  const records = await core.events.read(
    context.core.adapter,
    context.board.coordinationRef,
    { now },
  );
  const listed = await context.core.store.list();
  const boardKey = await core.events.boardKeyFor(context.core.adapter);
  const state = await core.state.observeAndFold(
    boardKey,
    listed.tickets,
    records,
    {
      now,
      leaseTtlMs: core.claims.parseDurationMs(
        context.config.value.claims.lease,
      ),
    },
  );
  return { state, events: records };
}

function stateFor(
  state: core.state.BoardState,
  id: string,
): core.state.TicketState | undefined {
  return state.tickets.find(
    (ticket) =>
      core.store.normalizeTicketIdForComparison(ticket.id) ===
      core.store.normalizeTicketIdForComparison(id),
  );
}

function projection(
  ticket: core.store.StoredTicket,
  state?: core.state.TicketState,
): Record<string, unknown> {
  return {
    ...ticket.ticket.frontmatter,
    id: ticket.id,
    path: ticket.path,
    ...(state === undefined
      ? {}
      : {
          closed: state.closed,
          closeReason: state.closeReason,
          lease: state.lease,
          statusFromEvents: state.statusFromEvents,
          aliases: state.aliases,
        }),
  };
}

function csv(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

function replaceFrontmatter(
  ticket: core.ticket.ParsedTicket,
  mutate: (document: ReturnType<typeof parseDocument>) => void,
): core.ticket.ParsedTicket {
  const match = ticket.source.raw.match(
    /^---(\r?\n)([\s\S]*?)(\r?\n)---([\s\S]*)$/,
  );
  if (match === null)
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      "ticket frontmatter is not editable",
    );
  const document = parseDocument(match[2]);
  mutate(document);
  return core.ticket.parseTicketFile(
    `---${match[1]}${document.toString()}---${match[4]}`,
    ticket.source.path,
  );
}

function appendNote(
  ticket: core.ticket.ParsedTicket,
  actor: string,
  text: string,
  now: number,
): core.ticket.ParsedTicket {
  const marker = "## Notes";
  const entry = `- ${new Date(now).toISOString()} ${actor}: ${text}`;
  const raw = ticket.source.raw;
  const bodyStart = raw.indexOf("---", 3);
  if (bodyStart < 0) usage("ticket frontmatter is not editable");
  const bodyOffset = raw.indexOf("\n", bodyStart) + 1;
  const body = raw.slice(bodyOffset);
  const nextBody = body.includes(marker)
    ? `${body.trimEnd()}\n${entry}\n`
    : `${body.trimEnd()}\n\n${marker}\n${entry}\n`;
  return core.ticket.parseTicketFile(
    `${raw.slice(0, bodyOffset)}${nextBody}`,
    ticket.source.path,
  );
}

function replaceBody(
  ticket: core.ticket.ParsedTicket,
  body: string,
): core.ticket.ParsedTicket {
  const closing = ticket.source.raw.indexOf("---", 3);
  if (closing < 0) usage("ticket frontmatter is not editable");
  const bodyOffset = ticket.source.raw.indexOf("\n", closing) + 1;
  return core.ticket.parseTicketFile(
    `${ticket.source.raw.slice(0, bodyOffset)}${body}${body.endsWith("\n") ? "" : "\n"}`,
    ticket.source.path,
  );
}

async function writeEditedTicket(
  context: Context,
  ticket: core.store.StoredTicket,
  args: TicketArgs,
): Promise<core.store.StoredTicket> {
  let updated = ticket.ticket;
  if (args.description !== undefined)
    updated = replaceBody(updated, args.description);
  if (args.title !== undefined)
    updated = core.ticket.setScalarField(updated, "title", args.title);
  if (args.status !== undefined)
    updated = core.ticket.setScalarField(updated, "status", args.status);
  if (args.priority !== undefined)
    updated = core.ticket.setScalarField(updated, "priority", args.priority);
  if (args.milestone !== undefined)
    updated = core.ticket.setScalarField(updated, "milestone", args.milestone);
  if (args.field !== undefined) {
    if (args.value === undefined) usage("edit --field requires --value");
    updated = replaceFrontmatter(updated, (document) =>
      document.set(args.field as string, args.value),
    );
  }
  if (
    args.labels !== undefined ||
    args.label !== undefined ||
    args.assign !== undefined
  ) {
    updated = replaceFrontmatter(updated, (document) => {
      if (args.labels !== undefined) document.set("labels", csv(args.labels));
      if (args.label !== undefined) document.set("labels", csv(args.label));
      if (args.assign !== undefined) document.set("assignee", csv(args.assign));
    });
  }
  return context.core.store.write(updated);
}

export const createCommand = defineCommand({
  meta: { name: "create", description: "Create a ticket" },
  args: {
    ...globalArgs,
    title: { type: "positional", description: "Ticket title" },
    description: { type: "string", alias: "d" },
    status: { type: "string" },
    backer: { type: "string" },
    label: { type: "string" },
    assign: { type: "string" },
    priority: { type: "string" },
    milestone: { type: "string" },
    parent: { type: "string" },
    blocks: { type: "string" },
    blockedBy: { type: "string" },
    discoveredFrom: { type: "string" },
    ac: { type: "string" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.title) usage("create requires a title");
    if (parsed.backer !== undefined) usage("no backers configured");
    await withContext(parsed, async (context) => {
      const id = core.ticket.generateTicketId(
        context.config.value.id_prefix ?? "ck",
      );
      const dependencyInputs = [
        ...csv(parsed.parent).map((dependencyId) => ({
          type: "parent-child",
          id: dependencyId,
        })),
        ...csv(parsed.blockedBy).map((dependencyId) => ({
          type: "blocks",
          id: dependencyId,
        })),
        ...csv(parsed.discoveredFrom).map((dependencyId) => ({
          type: "discovered-from",
          id: dependencyId,
        })),
      ];
      const blockTargets = await Promise.all(
        csv(parsed.blocks).map((blockedId) => getTicket(context, blockedId)),
      );
      const graph = await graphFor(context, [
        { id, closed: false, deps: dependencyInputs },
      ]);
      for (const dependency of dependencyInputs) {
        const check = core.deps.wouldCreateCycle(
          graph,
          id,
          dependency.type as core.deps.DependencyEdgeType,
          dependency.id as core.TicketId,
        );
        if (check.refused)
          usage(
            check.reason === "cycle"
              ? "dependency would create a cycle"
              : `dependency endpoint is ambiguous: ${check.id}`,
          );
      }
      for (const target of blockTargets) {
        const check = core.deps.wouldCreateCycle(
          graph,
          target.id,
          "blocks",
          id,
        );
        if (check.refused)
          usage(
            check.reason === "cycle"
              ? "dependency would create a cycle"
              : `dependency endpoint is ambiguous: ${check.id}`,
          );
      }
      const result = await core.ticket.create({
        board: context.board,
        ticket: id,
        title: parsed.title as string,
        body: parsed.description,
        status: parsed.status,
        actor: context.actor.id,
      });
      const created = await getTicket(context, result.ticket);
      let edited = await writeEditedTicket(context, created, parsed);
      if (dependencyInputs.length > 0) {
        edited = await context.core.store.write(
          core.ticket.setCankanBlock(edited.ticket, {
            ...(edited.ticket.frontmatter.cankan ?? {}),
            deps: dependencyInputs,
          }),
        );
      }
      for (const target of blockTargets) {
        const targetDeps = [
          ...(target.ticket.frontmatter.cankan?.deps ?? []),
          { type: "blocks", id: result.ticket },
        ];
        await context.core.store.write(
          core.ticket.setCankanBlock(target.ticket, {
            ...(target.ticket.frontmatter.cankan ?? {}),
            deps: targetDeps,
          }),
        );
      }
      if (parsed.ac !== undefined) {
        edited = await context.core.store.write(
          appendNote(
            edited.ticket,
            context.actor.id,
            `Acceptance criteria: ${parsed.ac}`,
            Date.now(),
          ),
        );
      }
      context.output.write({
        ticket: projection(edited),
        eventId: result.eventId,
      });
    });
  },
});

export const showCommand = defineCommand({
  meta: { name: "show", description: "Show a ticket" },
  args: {
    ...globalArgs,
    id: { type: "positional", description: "Ticket id" },
    events: { type: "boolean" },
    deps: { type: "boolean" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id) usage("show requires an id");
    await withContext(parsed, async (context) => {
      const { state, events } = await loadState(context);
      const ticket = await getTicket(context, parsed.id as string);
      const current = stateFor(state, ticket.id);
      const result: Record<string, unknown> = projection(ticket, current);
      if (parsed.deps) result.dependencies = current?.deps ?? [];
      if (parsed.events) {
        const key = core.store.normalizeTicketIdForComparison(ticket.id);
        result.events = events.filter(
          (record) =>
            core.store.normalizeTicketIdForComparison(record.event.ticket) ===
            key,
        );
      }
      context.output.write(result);
    });
  },
});

export const listCommand = defineCommand({
  meta: { name: "list", description: "List tickets" },
  args: {
    ...globalArgs,
    status: { type: "string" },
    label: { type: "string" },
    actor: { type: "string" },
    origin: { type: "string" },
    ready: { type: "boolean" },
    claimed: { type: "boolean" },
    blocked: { type: "boolean" },
    milestone: { type: "string" },
    order: { type: "string" },
    queue: { type: "string" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    await withContext(parsed, async (context) => {
      const { state } = await loadState(context);
      const listed = await context.core.store.list();
      const flatDependencies = new Map(
        listed.tickets.map((ticket) => [
          core.store.normalizeTicketIdForComparison(ticket.id),
          ticket.ticket.frontmatter.dependencies ?? [],
        ]),
      );
      const rows = listed.tickets
        .map((ticket) => ({ ticket, current: stateFor(state, ticket.id) }))
        .filter(({ ticket, current }) => {
          const frontmatter = ticket.ticket.frontmatter;
          if (parsed.status !== undefined && current?.status !== parsed.status)
            return false;
          if (
            parsed.label !== undefined &&
            !frontmatter.labels?.includes(parsed.label)
          )
            return false;
          if (
            parsed.actor !== undefined &&
            current?.lease?.actor !== parsed.actor
          )
            return false;
          if (
            parsed.origin !== undefined &&
            frontmatter.cankan?.origin !== parsed.origin
          )
            return false;
          if (
            parsed.milestone !== undefined &&
            frontmatter.milestone !== parsed.milestone
          )
            return false;
          if (
            parsed.claimed === true &&
            (current?.lease === undefined || current.lease.expired)
          )
            return false;
          if (
            parsed.blocked === true &&
            (current === undefined ||
              core.state.blockedBy(state, ticket.id).length === 0)
          )
            return false;
          if (parsed.ready === true) {
            if (current === undefined) return false;
            const verdict = core.deps.isReady(state, ticket.id, {
              flatDependenciesFor: (id) =>
                flatDependencies.get(
                  core.store.normalizeTicketIdForComparison(id),
                ) ?? [],
            });
            if (!verdict.ready) return false;
          }
          return true;
        });
      if (parsed.order !== undefined) {
        const order = core.order.parseOrder(parsed.order);
        rows.sort((left, right) =>
          core.order.compareTickets(
            { ...left.ticket.ticket.frontmatter, id: left.ticket.id },
            { ...right.ticket.ticket.frontmatter, id: right.ticket.id },
            order,
          ),
        );
      }
      context.output.write(
        rows.map(({ ticket, current }) => projection(ticket, current)),
      );
    });
  },
});

export const editCommand = defineCommand({
  meta: { name: "edit", description: "Edit a ticket" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    title: { type: "string", alias: "t" },
    description: { type: "string", alias: "d" },
    status: { type: "string" },
    priority: { type: "string" },
    milestone: { type: "string" },
    labels: { type: "string" },
    assign: { type: "string" },
    field: { type: "string" },
    value: { type: "string" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id) usage("edit requires an id");
    await withContext(parsed, async (context) => {
      const ticket = await getTicket(context, parsed.id as string);
      const edited = await writeEditedTicket(context, ticket, parsed);
      context.output.write(projection(edited));
    });
  },
});

export const moveCommand = defineCommand({
  meta: { name: "move", description: "Move a ticket to a column" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    status: { type: "positional", description: "Destination column" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id || !parsed.status) usage("move requires an id and column");
    await withContext(parsed, async (context) =>
      context.output.write(
        await core.ticket.move({
          board: context.board,
          ticket: parsed.id as string,
          to: parsed.status as string,
          actor: context.actor.id,
        }),
      ),
    );
  },
});

export const closeCommand = defineCommand({
  meta: { name: "close", description: "Close a ticket" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    reason: { type: "string" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id) usage("close requires an id");
    await withContext(parsed, async (context) => {
      const ticket = await getTicket(context, parsed.id as string);
      const lastColumn = context.config.value.columns.at(-1) ?? "Done";
      const moved =
        ticket.ticket.frontmatter.status === lastColumn
          ? undefined
          : await core.ticket.move({
              board: context.board,
              ticket: ticket.id,
              to: lastColumn,
              actor: context.actor.id,
            });
      const closed = await core.ticket.close({
        board: context.board,
        ticket: ticket.id,
        actor: context.actor.id,
        reason: parsed.reason,
      });
      context.output.write({ ...closed, moved });
    });
  },
});

export const reopenCommand = defineCommand({
  meta: { name: "reopen", description: "Reopen a ticket" },
  args: { ...globalArgs, id: { type: "positional" } },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id) usage("reopen requires an id");
    await withContext(parsed, async (context) =>
      context.output.write(
        await core.ticket.reopen({
          board: context.board,
          ticket: parsed.id as string,
          actor: context.actor.id,
        }),
      ),
    );
  },
});

export const noteCommand = defineCommand({
  meta: { name: "note", description: "Append a note to a ticket" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    text: { type: "positional" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id || !parsed.text) usage("note requires an id and text");
    await withContext(parsed, async (context) => {
      const ticket = await getTicket(context, parsed.id as string);
      const updated = appendNote(
        ticket.ticket,
        context.actor.id,
        parsed.text as string,
        Date.now(),
      );
      const stored = await context.core.store.write(updated);
      context.output.write(projection(stored));
    });
  },
});

export const commentCommand = defineCommand({
  meta: { name: "comment", description: "Add a backer comment" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    text: { type: "positional" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id || !parsed.text) usage("comment requires an id and text");
    await withContext(parsed, async (context) => {
      const ticket = await getTicket(context, parsed.id as string);
      const now = Date.now();
      const appended = await core.events.append(
        context.core.adapter,
        context.board.coordinationRef,
        {
          event: "comment",
          ts: new Date(now).toISOString(),
          actor: context.actor.id,
          ticket: ticket.id,
          text: parsed.text as string,
        },
        { now },
      );
      context.output.write({ ticket: ticket.id, eventId: appended.event.id });
    });
  },
});

async function graphFor(
  context: Context,
  extra: readonly core.deps.DependencyGraphNode[] = [],
): Promise<core.deps.DependencyGraph> {
  const { state } = await loadState(context);
  const listed = await context.core.store.list();
  const byId = new Map(
    listed.tickets.map((ticket) => [
      core.store.normalizeTicketIdForComparison(ticket.id),
      ticket,
    ]),
  );
  return core.deps.buildGraph([
    ...state.tickets.map((ticket) => ({
      id: ticket.id,
      closed: ticket.closed,
      deps: ticket.deps,
      dependencies:
        byId.get(core.store.normalizeTicketIdForComparison(ticket.id))?.ticket
          .frontmatter.dependencies ?? [],
    })),
    ...extra,
  ]);
}

export const depCommand = defineCommand({
  meta: { name: "dep", description: "Manage ticket dependencies" },
  args: globalArgs,
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List dependencies" },
      args: { ...globalArgs, id: { type: "positional" } },
      async run({ args }) {
        const parsed = args as TicketArgs;
        if (!parsed.id) usage("dep list requires an id");
        await withContext(parsed, async (context) => {
          const ticket = await getTicket(context, parsed.id as string);
          context.output.write(ticket.ticket.frontmatter.cankan?.deps ?? []);
        });
      },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Add a dependency" },
      args: {
        ...globalArgs,
        id: { type: "positional" },
        type: { type: "positional" },
        other: { type: "positional" },
      },
      async run({ args }) {
        const parsed = args as TicketArgs;
        if (!parsed.id || !parsed.type || !parsed.other)
          usage("dep add requires id, type, and other");
        if (
          !(DEPENDENCY_TYPES as readonly string[]).includes(
            parsed.type as string,
          )
        )
          usage(`unknown dependency type "${parsed.type}"`);
        await withContext(parsed, async (context) => {
          const ticket = await getTicket(context, parsed.id as string);
          const deps = [
            ...(ticket.ticket.frontmatter.cankan?.deps ?? []),
            { type: parsed.type as string, id: parsed.other as string },
          ];
          const updated = core.ticket.setCankanBlock(ticket.ticket, {
            ...(ticket.ticket.frontmatter.cankan ?? {}),
            deps,
          });
          const graph = await graphFor(context);
          const result = core.deps.wouldCreateCycle(
            graph,
            ticket.id,
            parsed.type as core.deps.DependencyEdgeType,
            parsed.other as core.TicketId,
          );
          if (result.refused)
            usage(
              result.reason === "cycle"
                ? "dependency would create a cycle"
                : `dependency endpoint is ambiguous: ${result.id}`,
            );
          context.output.write(
            projection(await context.core.store.write(updated)),
          );
        });
      },
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a dependency" },
      args: {
        ...globalArgs,
        id: { type: "positional" },
        other: { type: "positional" },
      },
      async run({ args }) {
        const parsed = args as TicketArgs;
        if (!parsed.id || !parsed.other)
          usage("dep rm requires an id and other");
        await withContext(parsed, async (context) => {
          const ticket = await getTicket(context, parsed.id as string);
          const deps = (ticket.ticket.frontmatter.cankan?.deps ?? []).filter(
            (dep) =>
              core.store.normalizeTicketIdForComparison(dep.id) !==
              core.store.normalizeTicketIdForComparison(parsed.other as string),
          );
          const updated = core.ticket.setCankanBlock(ticket.ticket, {
            ...(ticket.ticket.frontmatter.cankan ?? {}),
            deps,
          });
          context.output.write(
            projection(await context.core.store.write(updated)),
          );
        });
      },
    }),
    graph: defineCommand({
      meta: { name: "graph", description: "Show the dependency graph" },
      args: { ...globalArgs, mermaid: { type: "boolean" } },
      async run({ args }) {
        const parsed = args as TicketArgs;
        await withContext(parsed, async (context) => {
          const graph = await graphFor(context);
          if (parsed.mermaid)
            context.output.write(
              `flowchart TD\n${graph.edges.map((edge) => `  ${edge.from} -->|${edge.type}| ${edge.to ?? edge.rawId}`).join("\n")}`,
            );
          else context.output.write(graph.edges);
        });
      },
    }),
  },
});

export const archiveCommand = defineCommand({
  meta: { name: "archive", description: "Archive tickets" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    closedBefore: {
      type: "string",
      description: "Archive closed tickets older than a duration",
    },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.id && !parsed.closedBefore)
      usage("archive requires an id or --closed-before");
    await withContext(parsed, async (context) => {
      if (parsed.id) {
        context.output.write(
          projection(await context.core.store.archive(parsed.id)),
        );
        return;
      }
      const { state } = await loadState(context);
      const listed = await context.core.store.list();
      const cutoff =
        Date.now() - core.claims.parseDurationMs(parsed.closedBefore as string);
      const archived: Record<string, unknown>[] = [];
      for (const ticket of listed.tickets) {
        const current = stateFor(state, ticket.id);
        const date = Date.parse(
          ticket.ticket.frontmatter.updated_date ??
            ticket.ticket.frontmatter.created_date ??
            "",
        );
        if (current?.closed && Number.isFinite(date) && date <= cutoff) {
          archived.push(
            projection(await context.core.store.archive(ticket.id), current),
          );
        }
      }
      context.output.write(archived);
    });
  },
});

export const searchCommand = defineCommand({
  meta: { name: "search", description: "Search ticket content" },
  args: {
    ...globalArgs,
    query: { type: "positional" },
    all: { type: "boolean" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    if (!parsed.query) usage("search requires a query");
    await withContext(parsed, async (context) => {
      const listed = await context.core.store.list();
      const tickets = [...listed.tickets];
      if (parsed.all) {
        try {
          const entries = await readdir(
            join(context.board.ticketsDir, "archive"),
            { withFileTypes: true },
          );
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
            const path = join(context.board.ticketsDir, "archive", entry.name);
            try {
              const ticket = core.ticket.parseTicketFile(
                await readFile(path, "utf8"),
                path,
              );
              tickets.push({ id: ticket.frontmatter.id, path, ticket });
            } catch {
              // Search skips malformed archived files, matching store.list().
            }
          }
        } catch {
          // No archive directory is equivalent to no archived tickets.
        }
      }
      const query = parsed.query?.toLowerCase() as string;
      context.output.write(
        tickets
          .filter((ticket) =>
            ticket.ticket.source.raw.toLowerCase().includes(query),
          )
          .map((ticket) => projection(ticket)),
      );
    });
  },
});

export const rankCommand = defineCommand({
  meta: { name: "rank", description: "Set ticket ordering" },
  args: {
    ...globalArgs,
    id: { type: "positional" },
    top: { type: "boolean" },
    bottom: { type: "boolean" },
    before: { type: "string" },
    after: { type: "string" },
    normalize: { type: "boolean" },
  },
  async run({ args }) {
    const parsed = args as TicketArgs;
    await withContext(parsed, async (context) => {
      const listed = await context.core.store.list();
      const ordered = [...listed.tickets].sort(
        (a, b) =>
          (a.ticket.frontmatter.ordinal ?? Number.MAX_SAFE_INTEGER) -
          (b.ticket.frontmatter.ordinal ?? Number.MAX_SAFE_INTEGER),
      );
      if (parsed.normalize) {
        for (const [index, ticket] of ordered.entries())
          await context.core.store.write(
            core.ticket.setScalarField(
              ticket.ticket,
              "ordinal",
              (index + 1) * core.order.DEFAULT_RANK_STEP,
            ),
          );
        context.output.write({ normalized: ordered.length });
        return;
      }
      if (!parsed.id) usage("rank requires an id or --normalize");
      const target = await getTicket(context, parsed.id as string);
      const others = ordered.filter((ticket) => ticket.id !== target.id);
      let ordinal: number | undefined;
      if (parsed.top)
        ordinal = core.order.rankBetween(
          undefined,
          others[0]?.ticket.frontmatter.ordinal,
        );
      else if (parsed.bottom)
        ordinal = core.order.rankBetween(
          others.at(-1)?.ticket.frontmatter.ordinal,
        );
      else if (parsed.before)
        ordinal = core.order.rankBetween(
          undefined,
          (await getTicket(context, parsed.before)).ticket.frontmatter.ordinal,
        );
      else if (parsed.after)
        ordinal = core.order.rankBetween(
          (await getTicket(context, parsed.after)).ticket.frontmatter.ordinal,
        );
      else usage("rank requires --top, --bottom, --before, or --after");
      if (ordinal === undefined) usage("rank could not compute an ordinal");
      const rank = ordinal as number;
      context.output.write(
        projection(
          await context.core.store.write(
            core.ticket.setScalarField(target.ticket, "ordinal", rank),
          ),
        ),
      );
    });
  },
});

export const ticketCommands = {
  createCommand,
  showCommand,
  listCommand,
  editCommand,
  moveCommand,
  closeCommand,
  reopenCommand,
  noteCommand,
  commentCommand,
  depCommand,
  archiveCommand,
  searchCommand,
  rankCommand,
};
