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
  coordActorsCommand,
  coordAssignCommand,
  coordClaimCommand,
  coordCommand,
  coordExpireCommand,
  coordMineCommand,
  coordReadyCommand,
  coordReleaseCommand,
  coordRenewCommand,
} from "./commands/coord";
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
    ready: coordReadyCommand,
    claim: coordClaimCommand,
    renew: coordRenewCommand,
    release: coordReleaseCommand,
    assign: coordAssignCommand,
    mine: coordMineCommand,
    actors: coordActorsCommand,
    expire: coordExpireCommand,
    coord: coordCommand,
  },
  default: "noop",
});

export const main = createMain(rootCommand);

if (import.meta.main) await main();
