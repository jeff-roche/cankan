import { expect, test } from "bun:test";
import { initRepo } from "../src/commands/init";
import { commandSpecs } from "../src/registry";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";
import "../src/main";

test("M3.4 registers every ticket command", () => {
  const names = new Set(commandSpecs().map((spec) => spec.name));
  expect(
    [...names].filter((name) =>
      [
        "create",
        "show",
        "list",
        "edit",
        "move",
        "close",
        "reopen",
        "note",
        "comment",
        "dep",
        "archive",
        "search",
        "rank",
      ].includes(name),
    ),
  ).toEqual(
    expect.arrayContaining([
      "create",
      "show",
      "list",
      "edit",
      "move",
      "close",
      "reopen",
      "note",
      "comment",
      "dep",
      "archive",
      "search",
      "rank",
    ]),
  );
});

async function runCli(repo: string, args: string[]): Promise<unknown> {
  const child = Bun.spawn(
    [
      "bun",
      `${globalThis.process.cwd()}/packages/cli/src/main.ts`,
      ...args,
      "--json",
    ],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${stderr}`);
  return JSON.parse(stdout);
}

async function runCliFailure(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(
    [
      "bun",
      `${globalThis.process.cwd()}/packages/cli/src/main.ts`,
      ...args,
      "--json",
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited).not.toBe(0);
  return `${stdout}\n${stderr}`;
}

test("M3.4 exercises every ticket command through JSON output", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await initRepo({
        cwd: repo.dir,
        noWizard: true,
        noBackers: true,
        env: process.env,
      });
      const first = (await runCli(repo.dir, ["create", "First"])) as {
        ticket: { id: string };
      };
      const second = (await runCli(repo.dir, ["create", "Second"])) as {
        ticket: { id: string };
      };
      const third = (await runCli(repo.dir, [
        "create",
        "Third",
        "--blocks",
        second.ticket.id,
      ])) as {
        ticket: { id: string };
      };
      const firstId = first.ticket.id;
      const secondId = second.ticket.id;

      expect(await runCli(repo.dir, ["show", firstId])).toMatchObject({
        id: firstId,
      });
      expect(await runCli(repo.dir, ["list"])).toBeArrayOfSize(3);
      expect(
        await runCli(repo.dir, ["edit", firstId, "--title", "Changed"]),
      ).toMatchObject({ title: "Changed" });
      expect(
        await runCli(repo.dir, ["move", firstId, "In Progress"]),
      ).toMatchObject({ ticket: firstId });
      expect(await runCli(repo.dir, ["note", firstId, "A note"])).toMatchObject(
        { id: firstId },
      );
      expect(
        await runCli(repo.dir, ["comment", firstId, "A comment"]),
      ).toMatchObject({ ticket: firstId });
      expect(
        await runCli(repo.dir, ["dep", "add", firstId, "blocks", secondId]),
      ).toMatchObject({ id: firstId });
      expect(await runCli(repo.dir, ["dep", "list", firstId])).toBeArrayOfSize(
        1,
      );
      expect(await runCli(repo.dir, ["dep", "graph"])).toBeArrayOfSize(2);
      expect(
        await runCli(repo.dir, ["show", secondId, "--deps"]),
      ).toMatchObject({
        dependencies: [{ id: third.ticket.id, type: "blocks" }],
      });
      expect(await runCli(repo.dir, ["search", "Changed"])).toBeArrayOfSize(1);
      expect(await runCli(repo.dir, ["rank", firstId, "--top"])).toMatchObject({
        id: firstId,
      });
      expect(await runCli(repo.dir, ["close", firstId])).toMatchObject({
        ticket: firstId,
      });
      expect(await runCli(repo.dir, ["reopen", firstId])).toMatchObject({
        ticket: firstId,
      });
      expect(await runCli(repo.dir, ["archive", secondId])).toMatchObject({
        id: secondId,
      });
    });
  } finally {
    await repo.cleanup();
  }
}, 30_000);

test("M3.4 rejects create --backer until backers are implemented", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await initRepo({
        cwd: repo.dir,
        noWizard: true,
        noBackers: true,
        env: process.env,
      });
      expect(
        await runCliFailure(repo.dir, [
          "create",
          "Backed",
          "--backer",
          "github",
        ]),
      ).toContain("no backers configured");
    });
  } finally {
    await repo.cleanup();
  }
});
