import { buildContext, type Context } from "../src/context";
import { initRepo } from "../src/commands/init";

export async function makeContext(repoDir: string): Promise<Context> {
  await initRepo({
    cwd: repoDir,
    noWizard: true,
    noBackers: true,
    env: process.env,
  });
  return buildContext({ cwd: repoDir, json: true });
}
