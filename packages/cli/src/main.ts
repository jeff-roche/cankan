import { createMain } from "citty";
import { buildContext, contextSummary, globalArgs, type GlobalArgs } from "./context";
import { initCommand } from "./commands/init";
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
  subCommands: { init: initCommand, noop: noopCommand },
  default: "noop",
});

export const main = createMain(rootCommand);

if (import.meta.main) await main();
