import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { loadBoardConfig } from "../../src/board/index";
import { buildBoardRef } from "../../src/board/ref";
import { claim, expireStale, release } from "../../src/claims/index";
import { read } from "../../src/events/index";
import { createGitAdapter } from "../../src/git/index";
import { dispatchHooks } from "../../src/hooks/dispatch";
import * as core from "../../src/index";
import { openTicketStore } from "../../src/store/ticketStore";
import type { ActorId, TicketId } from "../../src/types";
import { hermeticEnv, writeGlobalConfigFile } from "../config/testHelpers";

const NOW = Date.parse("2026-09-15T10:00:00Z");

test("all six core events fire hooks once after their source event", async () => {
  await withEnv(undefined, async () => {
    const repo: TempRepo = await makeTempRepo();
    try {
      const board = await buildBoardRef({
        kind: "repo",
        name: "hooks",
        root: repo.dir,
        env: hermeticEnv(),
      });
      const [hookTicketPath] = await writeFixtureTickets(board.ticketsDir, [
        {
          id: "ck-hooks",
          title: "Hook ticket",
          status: "To Do",
          body: "Hook test",
        },
      ]);
      const output = join(repo.dir, "hooks.txt");
      const config = [
        "claims:",
        "  lease: 2h",
        "hooks:",
        `  claim: >-\n    printf 'claim\\n' >> '${output}'`,
        `  release: >-\n    printf 'release\\n' >> '${output}'`,
        `  expire: >-\n    printf 'expire\\n' >> '${output}'`,
        `  create: >-\n    printf 'create\\n' >> '${output}'`,
        `  move: >-\n    printf 'move\\n' >> '${output}'`,
        `  close: >-\n    printf 'close\\n' >> '${output}'; printf 'close-failed'; exit 7`,
        "",
      ].join("\n");
      await writeGlobalConfigFile(
        process.env.XDG_CONFIG_HOME as string,
        config,
      );

      const adapter = await createGitAdapter(board.root);
      const store = await openTicketStore({
        board,
        gitDirs: [await adapter.gitCommonDir()],
      });
      await expect(
        dispatchHooks(
          {
            adapter,
            ref: board.coordinationRef,
            config: await loadBoardConfig(board),
            board,
            store,
            now: NOW,
          },
          "claim",
          "ck-missing" as TicketId,
          "alice" as ActorId,
        ),
      ).rejects.toThrow(/no ticket found/);

      await expect(
        core.ticket.move({
          ticket: "ck-hooks",
          to: "Broken",
          actor: "alice" as ActorId,
          board: { ...board, coordinationRef: "invalid ref" },
          now: NOW,
        }),
      ).rejects.toThrow();
      expect(await readFile(hookTicketPath as string, "utf8")).toContain(
        "status: To Do",
      );
      await expect(
        core.ticket.create({
          board: { ...board, coordinationRef: "invalid ref" },
          ticket: "ck-failed-create" as TicketId,
          title: "Failed create",
          actor: "alice" as ActorId,
          now: NOW,
        }),
      ).rejects.toThrow();
      await expect(
        readFile(
          join(board.ticketsDir, "ck-failed-create - failed-create.md"),
          "utf8",
        ),
      ).rejects.toThrow();
      await expect(
        core.ticket.create({
          board: { ...board, coordinationRef: "invalid ref" },
          ticket: "ck-hooks" as TicketId,
          title: "Overwritten title",
          status: "Broken",
          actor: "alice" as ActorId,
          now: NOW,
        }),
      ).rejects.toThrow();
      expect(await readFile(hookTicketPath as string, "utf8")).toContain(
        "title: Hook ticket",
      );
      expect(await readFile(hookTicketPath as string, "utf8")).toContain(
        "status: To Do",
      );

      await claim({
        board,
        ticket: "ck-hooks",
        actor: "alice" as ActorId,
        now: NOW,
      });
      await release({
        board,
        ticket: "ck-hooks",
        actor: "alice" as ActorId,
        now: NOW + 1,
      });
      await claim({
        board,
        ticket: "ck-hooks",
        actor: "alice" as ActorId,
        now: NOW + 2,
      });
      await expireStale({
        board,
        actor: "sweeper" as ActorId,
        now: NOW + 2 * 60 * 60 * 1000 + 3,
      });
      await core.ticket.create({
        board,
        ticket: "ck-created" as TicketId,
        title: "Created ticket",
        actor: "alice" as ActorId,
        now: NOW + 4,
      });
      await core.ticket.move({
        board,
        ticket: "ck-created",
        to: "In Progress",
        actor: "alice" as ActorId,
        now: NOW + 5,
      });
      await core.ticket.close({
        board,
        ticket: "ck-created",
        actor: "alice" as ActorId,
        reason: "Finished",
        now: NOW + 6,
      });

      expect((await readFile(output, "utf8")).trim().split("\n")).toEqual([
        "claim",
        "release",
        "claim",
        "expire",
        "create",
        "move",
        "close",
      ]);

      const records = await read(adapter, board.coordinationRef, {
        now: NOW + 2 * 60 * 60 * 1000 + 3,
      });
      expect(
        records.filter((record) => record.event.event === "hook"),
      ).toHaveLength(7);
      expect(records.map((record) => record.event.event)).toEqual([
        "claim",
        "hook",
        "release",
        "hook",
        "claim",
        "hook",
        "expire",
        "hook",
        "create",
        "hook",
        "move",
        "hook",
        "close",
        "hook",
      ]);
      const failedCloseHook = records.find(
        (record) =>
          record.event.event === "hook" &&
          record.event.ticket === "ck-created" &&
          record.event.output.includes("close"),
      );
      expect(failedCloseHook).toBeDefined();
    } finally {
      await repo.cleanup();
    }
  });
});
