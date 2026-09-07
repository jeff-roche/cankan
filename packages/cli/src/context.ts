import * as core from "@jeff-roche/cankan-core";
import type { BoardRef } from "@jeff-roche/cankan-core";
import { createOutput, type Output, type OutputOptions } from "./output";

export interface GlobalArgs {
  readonly cwd?: string;
  readonly board?: string;
  readonly actor?: string;
  readonly json?: boolean;
  readonly plain?: boolean;
  readonly yes?: boolean;
  readonly q?: boolean;
  readonly v?: boolean;
}

export interface CoreHandle {
  readonly adapter: core.git.GitAdapter;
  readonly store: core.store.TicketStore;
  readonly index: core.index.BoardIndex;
  readonly dispose: () => void;
}

export interface Context {
  readonly config: core.config.ConfigResult;
  readonly board: BoardRef;
  readonly actor: core.actor.ResolvedActor;
  readonly core: CoreHandle;
  readonly output: Output;
  readonly yes: boolean;
}

function toBoardFlag(value: string | undefined): core.board.BoardFlag | undefined {
  if (value === undefined) return undefined;
  if (value === "all") throw new Error('"--board all" is not available for single-board commands');
  if (value === "personal" || value === "repo") return { kind: value };
  return { kind: "name", name: value };
}

export async function buildContext(argv: GlobalArgs, outputOptions: OutputOptions = {}): Promise<Context> {
  const board = await core.board.resolveBoard({ cwd: argv.cwd ?? process.cwd(), flag: toBoardFlag(argv.board) });
  const config = await core.board.loadBoardConfig(board);
  const adapter = await core.git.createGitAdapter(board.root);
  const boardKey = await core.events.boardKeyFor(adapter);
  const index = core.index.openIndex({ boardKey });
  const invalidator = core.index.createIndexInvalidator(index);
  const store = await core.store.openTicketStore({ board, gitDirs: [await adapter.gitCommonDir()], onWrite: invalidator });
  const actor = await core.actor.resolveActor({ config, flag: argv.actor, gitUserName: () => adapter.gitUserName() });
  return {
    config,
    board,
    actor,
    core: { adapter, store, index, dispose: () => index.close() },
    output: createOutput({ json: argv.json, plain: argv.plain, quiet: argv.q, verbose: argv.v, ...outputOptions }),
    yes: argv.yes ?? false,
  };
}

export function contextSummary(context: Context): Record<string, unknown> {
  return {
    board: { kind: context.board.kind, name: context.board.name, root: context.board.root },
    actor: { id: context.actor.id, source: context.actor.source, parent: context.actor.parent },
    output: { mode: context.output.mode, quiet: context.output.quiet, verbose: context.output.verbose },
  };
}
