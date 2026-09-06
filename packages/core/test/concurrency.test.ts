import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { makeTempRepo, type TempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";
import { writeFixtureTickets } from "../../test-utils/src/fixtureTickets";
import { buildBoardRef } from "../src/board/ref";
import { hermeticEnv } from "./config/testHelpers";

const repos: TempRepo[] = [];

afterEach(async () => {
  while (repos.length > 0) {
    await repos.pop()?.cleanup();
  }
});

/**
 * This is intentionally a child-process test. In-process promises share too
 * much scheduling and state to prove that the coordination ref remains the
 * sole arbiter when independent workers all choose the same queue head.
 */
test("concurrent queue claimers each get one distinct ticket across worktrees", async () => {
  await withEnv(undefined, async () => {
    const repo = await makeTempRepo({ worktrees: 1 });
    repos.push(repo);
    const secondary = repo.worktreeDirs[0];
    if (!secondary) throw new Error("expected a secondary worktree");

    const board = await buildBoardRef({ kind: "repo", name: "primary", root: repo.dir, env: hermeticEnv() });
    const board2 = await buildBoardRef({ kind: "repo", name: "secondary", root: secondary, env: hermeticEnv() });
    await mkdir(board.ticketsDir, { recursive: true });
    await mkdir(board2.ticketsDir, { recursive: true });

    const tickets = Array.from({ length: 8 }, (_, index) => ({
      id: `ck-concurrency-${String(index + 1).padStart(2, "0")}`,
      title: `Concurrency ${index + 1}`,
      status: "To Do",
      body: "Concurrency test ticket.",
    }));
    const excludedTicket = {
      // Sorts ahead of every eligible ticket so a queue-filter regression is
      // observable: without filtering, one worker claims this ticket first.
      id: "ck-concurrency-00-excluded",
      title: "Excluded concurrency ticket",
      status: "To Do",
      body: "This ticket must not be selected by the queue.",
    };
    const allTickets = [...tickets, excludedTicket];
    await writeFixtureTickets(board.ticketsDir, allTickets);
    await writeFixtureTickets(board2.ticketsDir, allTickets);

    const sourceRoot = join(import.meta.dir, "..", "src");
    const worker = `
      const { claim } = await import(${JSON.stringify(join(sourceRoot, "claims/index.ts"))});
      const { resolveQueue } = await import(${JSON.stringify(join(sourceRoot, "order/index.ts"))});
      const { isCanKanError } = await import(${JSON.stringify(join(sourceRoot, "errors.ts"))});
      const root = process.env.CANKAN_TEST_BOARD_ROOT;
      const ticketsDir = process.env.CANKAN_TEST_TICKETS_DIR;
      const ref = process.env.CANKAN_TEST_REF;
      const actor = process.env.CANKAN_TEST_ACTOR;
      const ids = JSON.parse(process.env.CANKAN_TEST_IDS);
      const queue = resolveQueue({ shared: { filter: { labels: ["concurrency"] }, order: ["id:asc"] } }, "shared");
      if (!queue) throw new Error("expected shared queue");
      async function claimNext() {
        const candidates = ids
          .filter((candidate) => queue.matches(candidate))
          .sort(queue.compare);
        for (const candidate of candidates) {
          const ticket = candidate.id;
          try {
            const result = await claim({ board: { kind: "repo", name: "worker", root, ticketsDir, coordinationRef: ref }, ticket, actor, now: Date.now() });
            return result;
          } catch (error) {
            if (!isCanKanError(error) || error.code !== "CLAIM_REJECTED" || error.details?.reason !== "already-held") throw error;
          }
        }
        throw new Error("queue exhausted before this worker could claim a ticket");
      }
      const result = await claimNext();
      console.log(JSON.stringify({ ok: true, ticket: result.ticket, actor }));
    `;

    const workers = tickets.map((_, index) => {
      const root = index % 2 === 0 ? board.root : board2.root;
      const ticketsDir = index % 2 === 0 ? board.ticketsDir : board2.ticketsDir;
      return Bun.spawn(["bun", "--eval", worker], {
        cwd: root,
        env: {
          ...process.env,
          CANKAN_TEST_BOARD_ROOT: root,
          CANKAN_TEST_TICKETS_DIR: ticketsDir,
          CANKAN_TEST_REF: board.coordinationRef,
          CANKAN_TEST_ACTOR: `concurrency-worker-${index}`,
          CANKAN_TEST_IDS: JSON.stringify(allTickets.map((ticket) => ({
            id: ticket.id,
            labels: ticket.id === excludedTicket.id ? ["other"] : ["concurrency"],
          }))),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    });

    const outputs = await Promise.all(
      workers.map(async (process) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
        return JSON.parse(stdout.trim()) as { ok: boolean; ticket: string };
      }),
    );
    expect(outputs.every((result) => result.ok)).toBe(true);
    expect(new Set(outputs.map((result) => result.ticket)).size).toBe(tickets.length);
    expect(outputs.some((result) => result.ticket === excludedTicket.id)).toBe(false);
  });
}, 30_000);
