import { createMain } from "citty";
import {
  buildContext,
  contextSummary,
  globalArgs,
  type GlobalArgs,
} from "./context";
import { configCommand } from "./commands/config";
import { initCommand } from "./commands/init";
import {
  archiveCommand,
  closeCommand,
  commentCommand,
  createCommand,
  depCommand,
  editCommand,
  listCommand,
  moveCommand,
  noteCommand,
  rankCommand,
  reopenCommand,
  searchCommand,
  showCommand,
} from "./commands/ticket";
import { defineCommand } from "./registry";

export { globalArgs } from "./context";

export const noopCommand = defineCommand({
  meta: { name: "noop", description: "Print the resolved CanKan context" },
  args: globalArgs,
  async run({ args }) {
    const context = await buildContext(args as GlobalArgs);
    try {
      context.output.write(contextSummary(context));
    } finally {
      context.core.dispose();
    }
  },
});

export const rootCommand = defineCommand({
  meta: { name: "cankan", description: "Coordinate work across boards" },
  args: globalArgs,
  subCommands: {
    config: configCommand,
    init: initCommand,
    noop: noopCommand,
    create: createCommand,
    show: showCommand,
    list: listCommand,
    edit: editCommand,
    move: moveCommand,
    close: closeCommand,
    reopen: reopenCommand,
    note: noteCommand,
    comment: commentCommand,
    dep: depCommand,
    archive: archiveCommand,
    search: searchCommand,
    rank: rankCommand,
  },
  default: "noop",
});

export const main = createMain(rootCommand);

if (import.meta.main) await main();
