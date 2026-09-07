import { createMain } from "citty";
import { buildContext, contextSummary, type GlobalArgs } from "./context";
import { defineCommand } from "./registry";

export const globalArgs = {
  json: { type: "boolean", description: "Emit machine-readable JSON" },
  plain: { type: "boolean", description: "Disable colors and decoration" },
  actor: { type: "string", description: "Actor identity" },
  cwd: { type: "string", description: "Working directory" },
  board: { type: "string", description: "Board selector" },
  yes: { type: "boolean", description: "Skip confirmations" },
  q: { type: "boolean", alias: "q", description: "Quiet output" },
  v: { type: "boolean", alias: "v", description: "Verbose output" },
} as const;

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
  subCommands: { noop: noopCommand },
  default: "noop",
});

export const main = createMain(rootCommand);

if (import.meta.main) await main();
