import { expect, test } from "bun:test";
import { read } from "../../src/events/index";
import { createGitAdapter } from "../../src/git/index";
import { reopen } from "../../src/ticket/index";
import { buildBoardRef } from "../../src/board/ref";
import { makeTempRepo } from "../../../test-utils/src/tempRepo";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import type { ActorId, TicketId } from "../../src/types";

test("reopen appends a reopen event for an existing ticket", async () => {
  const repo = await makeTempRepo();
  try {
    const board = await buildBoardRef({
      kind: "repo",
      name: "operations",
      root: repo.dir,
      env: process.env,
    });
    await writeFixtureTickets(board.ticketsDir, [
      { id: "ck-reopen", title: "Reopen", status: "Done", body: "" },
    ]);
    const result = await reopen({
      board,
      ticket: "ck-reopen",
      actor: "alice" as ActorId,
      now: Date.parse("2026-09-15T10:00:00Z"),
    });

    const adapter = await createGitAdapter(board.root);
    const events = await read(adapter, board.coordinationRef, {
      now: Date.parse("2026-09-15T10:00:00Z"),
    });
    expect(result.ticket).toBe("ck-reopen" as TicketId);
    expect(events.at(-1)?.event.event).toBe("reopen");
  } finally {
    await repo.cleanup();
  }
});
