import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as core from "@jeff-roche/cankan-core";
import {
  claimNext,
  coordReady,
  releaseAll,
  renewAll,
  resolveAssignActors,
  runExpireSweep,
} from "../src/commands/coord";
import { makeContext } from "./helpers";
import { writeFixtureTickets } from "../../test-utils/src/fixtureTickets";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

test("M3.5 assign is a formatting-preserving frontmatter hint, not a lease", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-alpha", title: "Alpha", status: "To Do", body: "A" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        const stored = await context.core.store.get("ck-alpha");
        if (stored === undefined) throw new Error("fixture ticket missing");
        const before = await context.core.adapter.readRef(
          context.board.coordinationRef,
        );
        await context.core.store.write(
          core.ticket.setSequenceField(
            stored.ticket,
            "assignee",
            resolveAssignActors(["alice"]),
          ),
        );
        const after = await context.core.adapter.readRef(
          context.board.coordinationRef,
        );
        // assign writes frontmatter only — it appends no event to the ref.
        expect(after).toBe(before);
        const rewritten = await context.core.store.get("ck-alpha");
        if (rewritten === undefined) throw new Error("ticket vanished");
        expect(rewritten.ticket.frontmatter.assignee).toEqual(["alice"]);
        const onDisk = await readFile(rewritten.path, "utf8");
        expect(onDisk).toContain("assignee: [alice]");
        expect(onDisk).toContain("id: ck-alpha");
        expect(onDisk).toContain("title: Alpha");
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 coordReady lists only unclaimed, unblocked tickets in ready.order", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        const result = await coordReady(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {},
        );
        expect(result.tickets.map((t) => t.id)).toEqual(["ck-a", "ck-b"]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 coordReady excludes a claimed ticket and a blocked ticket", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
        { id: "ck-c", title: "C", status: "To Do", body: "C" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: context.actor.id,
        });
        const result = await coordReady(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {
            flatDependencies: { "ck-c": ["ck-b"] },
          },
        );
        const ids = result.tickets.map((t) => t.id);
        expect(ids).not.toContain("ck-a"); // claimed
        expect(ids).not.toContain("ck-c"); // blocked by unclosed ck-b
        expect(ids).toContain("ck-b");
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 runExpireSweep --dry-run reports without mutating the ref", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-x", title: "X", status: "To Do", body: "X" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        const before = await context.core.adapter.readRef(
          context.board.coordinationRef,
        );
        const result = await runExpireSweep(context.board, context.actor.id, {
          dryRun: true,
        });
        const after = await context.core.adapter.readRef(
          context.board.coordinationRef,
        );
        expect(result.dryRun).toBe(true);
        expect(after).toBe(before);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 claimNext claims the top ready ticket under ready.order", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        const result = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {},
        );
        expect(result).toBeDefined();
        if (result === undefined) throw new Error("expected a claim");
        expect(result.ticket).toBe("ck-a");
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 claimNext with require_ready rejects a blocked ticket", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        await core.claims.claim({
          board: context.board,
          ticket: "ck-b",
          actor: "someone-else",
        });
        const result = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {
            flatDependencies: { "ck-a": ["ck-b"] },
          },
        );
        // ck-a is blocked (by claimed ck-b with require_ready true default);
        // nothing ready remains, so no claim.
        expect(result).toBeUndefined();
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 releaseAll and renewAll are no-ops with no current claims", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        const released = await releaseAll(
          context.core,
          context.board,
          context.actor.id,
          context.config,
        );
        expect(released).toEqual([]);
        const renewed = await renewAll(
          context.core,
          context.board,
          context.actor.id,
          context.config,
        );
        expect(renewed).toEqual([]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 releaseAll releases every claim the actor holds", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: context.actor.id,
        });
        await core.claims.claim({
          board: context.board,
          ticket: "ck-b",
          actor: context.actor.id,
        });
        const released = await releaseAll(
          context.core,
          context.board,
          context.actor.id,
          context.config,
        );
        expect(released.map((r) => r.ticket).sort()).toEqual(["ck-a", "ck-b"]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});
