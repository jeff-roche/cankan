import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as core from "@jeff-roche/cankan-core";
import {
  activeActors,
  claimExplicit,
  claimNext,
  coordReady,
  listActors,
  mine,
  parseLimitOption,
  renewAll,
} from "../src/commands/coord";
import { getCommandSpec } from "../src/registry";
import { buildContext } from "../src/context";
import { initRepo } from "../src/commands/init";
import { makeContext } from "./helpers";
import { setConfigValue } from "../src/commands/config";
import { writeFixtureTickets } from "../../test-utils/src/fixtureTickets";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

test("M3.5 explicit claim enforces require_ready (default blocks, false allows)", async () => {
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
        // Default policy (require_ready: true): ck-a has an open flat
        // dependency on the still-unclaimed ck-b, so it is not ready.
        try {
          await claimExplicit(
            context.core,
            context.board,
            context.actor.id,
            context.config,
            "ck-a",
            { flatDependencies: { "ck-a": ["ck-b"] } },
          );
          throw new Error("expected claimExplicit to reject");
        } catch (error) {
          expect(error).toBeInstanceOf(core.CanKanError);
          const claimed = error as core.CanKanError;
          expect(claimed.code).toBe(core.ErrorCodes.CLAIM_REJECTED);
          expect(claimed.details).toMatchObject({ reason: "not-ready" });
        }

        // Flip the policy off, re-read config, and the same ticket claims.
        // `claims.require_ready` is a policy key: `init` writes it into the
        // repo config with its default (true), and policy precedence is repo
        // > repo-local, so it must be flipped at the repo target.
        await setConfigValue({
          repoRoot: repo.dir,
          key: "claims.require_ready",
          rawValue: "false",
          target: "repo",
          env: process.env,
        });
        const relaxed = await buildContext({ cwd: repo.dir, json: true });
        try {
          const result = await claimExplicit(
            relaxed.core,
            relaxed.board,
            relaxed.actor.id,
            relaxed.config,
            "ck-a",
            { flatDependencies: { "ck-a": ["ck-b"] } },
          );
          expect(result.ticket).toBe("ck-a");
        } finally {
          relaxed.core.dispose();
        }
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 explicit claim --force takeover is not blocked by require_ready", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: "someone-else",
        });
        // `require_ready` default true would report ck-a as "claimed" — but a
        // force takeover must still displace the incumbent.
        const result = await claimExplicit(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          "ck-a",
          { force: true },
        );
        expect(result.kind).toBe("takeover");
        expect(result.ticket).toBe("ck-a");
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 claim --next honors label/milestone filters", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      // Give ck-a a label, ck-b a milestone, so a filter selects exactly one.
      const context = await makeContext(repo.dir);
      try {
        const storedA = await context.core.store.get("ck-a");
        const storedB = await context.core.store.get("ck-b");
        if (storedA === undefined || storedB === undefined) {
          throw new Error("fixture ticket missing");
        }
        await context.core.store.write(
          core.ticket.setSequenceField(storedA.ticket, "labels", ["urgent"]),
        );
        await context.core.store.write(
          core.ticket.setScalarField(storedB.ticket, "milestone", "m1"),
        );

        const labelClaim = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          { label: "urgent" },
        );
        expect(labelClaim?.ticket).toBe("ck-a");

        const milestoneClaim = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          { milestone: "m1" },
        );
        expect(milestoneClaim?.ticket).toBe("ck-b");
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 OrderableTicket.backer derives from cankan.origin and --backer filters", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFile(
        join(repo.dir, "backlog", "tasks", "ck-a - alpha.md"),
        "---\nid: ck-a\ntitle: Alpha\nstatus: To Do\ncankan:\n  origin: github\n---\n\nA\n",
        "utf8",
      );
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        const filtered = await coordReady(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          { backer: "github" },
        );
        expect(filtered.tickets.map((t) => t.id)).toEqual(["ck-a"]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 renewAll skips a claim lost to a competing takeover", async () => {
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
        // A competitor takes ck-a over — the actor's claim is lost.
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: "someone-else",
          force: true,
        });
        const renewed = await renewAll(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          { lease: "1h" },
        );
        // Only the still-held ticket is renewed; the lost one is skipped, and
        // the sweep did not abort.
        expect(renewed.map((r) => r.ticket)).toEqual(["ck-b"]);
        const remainingMs =
          new Date(renewed[0].leaseUntil).getTime() - Date.now();
        expect(remainingMs).toBeGreaterThan(30 * 60 * 1000);
        expect(remainingMs).toBeLessThan(90 * 60 * 1000);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 assign positional is named `target`, not `actor`", () => {
  const spec = getCommandSpec("assign");
  expect(spec).toBeDefined();
  if (spec === undefined) throw new Error("assign command not registered");
  expect(spec.args).toHaveProperty("id");
  expect(spec.args).toHaveProperty("target");
  expect(spec.args).not.toHaveProperty("actor");
});

test("M3.5 parseLimitOption validates a finite non-negative integer", () => {
  expect(parseLimitOption(undefined)).toBeUndefined();
  expect(parseLimitOption("0")).toBe(0);
  expect(parseLimitOption("5")).toBe(5);
  for (const bad of ["-1", "1.5", "abc", "Infinity", "NaN"]) {
    try {
      parseLimitOption(bad);
      throw new Error(`expected ${bad} to throw`);
    } catch (error) {
      expect(error).toBeInstanceOf(core.CanKanError);
      expect((error as core.CanKanError).code).toBe(core.ErrorCodes.USAGE);
    }
  }
});

test("M3.5 mine lists claims and assignments", async () => {
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
        const storedB = await context.core.store.get("ck-b");
        if (storedB === undefined) throw new Error("fixture ticket missing");
        await context.core.store.write(
          core.ticket.setSequenceField(storedB.ticket, "assignee", [
            context.actor.id,
          ]),
        );
        const result = await mine(
          context.core,
          context.board,
          context.actor.id,
          context.config,
        );
        expect(result.claims).toEqual(["ck-a"]);
        expect(result.assignments).toEqual(["ck-b"]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 actors lists current claims without an active filter", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
      ]);
      const context = await makeContext(repo.dir);
      try {
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: context.actor.id,
        });
        await expect(
          listActors(context.core, context.board, context.config),
        ).resolves.toEqual([{ actor: context.actor.id, tickets: ["ck-a"] }]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 claim --next forwards a lease override to the claim event", async () => {
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
        // Overridden lease (1h) vs the repo's default (2h). Both claims occur
        // within milliseconds, so comparing the two `leaseUntil` timestamps
        // cancels the clock skew and isolates the override's ~1h delta.
        const overridden = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          { lease: "1h" },
        );
        const baseline = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          {},
        );
        if (overridden === undefined || baseline === undefined) {
          throw new Error("expected both claim-next calls to succeed");
        }
        const deltaMs =
          new Date(baseline.leaseUntil).getTime() -
          new Date(overridden.leaseUntil).getTime();
        const hourMs = 60 * 60 * 1000;
        expect(Math.abs(deltaMs - hourMs)).toBeLessThan(hourMs / 2);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 actors --active groups by event parent, falling back to actor-derived parent", async () => {
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
        // ck-a: a tool actor whose claim event records an explicit parent.
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: "claude-code:carol/wt",
          parent: "alice",
        });
        // ck-b: a different tool actor with no recorded parent — the grouping
        // must fall back to the actor-derived `tool:name` parent.
        await core.claims.claim({
          board: context.board,
          ticket: "ck-b",
          actor: "codex:bob",
        });

        const groups = await activeActors(
          context.core,
          context.board,
          context.config,
        );
        expect(groups).toEqual([
          { parent: "alice", tickets: ["ck-a"] },
          { parent: "codex:bob", tickets: ["ck-b"] },
        ]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 claimNext honors a named queue's filter and order", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
        { id: "ck-b", title: "B", status: "To Do", body: "B" },
      ]);
      await initRepo({
        cwd: repo.dir,
        noWizard: true,
        noBackers: true,
        env: process.env,
      });
      await setConfigValue({
        repoRoot: repo.dir,
        key: "queues.focus",
        rawValue: "{filter: {labels: [urgent]}, order: [title:desc]}",
        target: "repo",
        env: process.env,
      });
      const context = await buildContext({ cwd: repo.dir, json: true });
      try {
        const first = await context.core.store.get("ck-a");
        const second = await context.core.store.get("ck-b");
        if (first === undefined || second === undefined) {
          throw new Error("fixture ticket missing");
        }
        await context.core.store.write(
          core.ticket.setSequenceField(first.ticket, "labels", ["urgent"]),
        );
        await context.core.store.write(
          core.ticket.setSequenceField(second.ticket, "labels", ["urgent"]),
        );

        const result = await claimNext(
          context.core,
          context.board,
          context.actor.id,
          context.config,
          { queue: "focus" },
        );
        expect(result?.ticket).toBe("ck-b");
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});

test("M3.5 actors active duration filters old live leases", async () => {
  const repo = await makeTempRepo();
  try {
    await withEnv(undefined, async () => {
      await mkdir(join(repo.dir, "backlog", "tasks"), { recursive: true });
      await writeFixtureTickets(join(repo.dir, "backlog", "tasks"), [
        { id: "ck-a", title: "A", status: "To Do", body: "A" },
      ]);
      await initRepo({
        cwd: repo.dir,
        noWizard: true,
        noBackers: true,
        env: process.env,
      });
      await setConfigValue({
        repoRoot: repo.dir,
        key: "claims.lease",
        rawValue: "4h",
        target: "repo",
        env: process.env,
      });
      const context = await buildContext({ cwd: repo.dir, json: true });
      try {
        const claimedAt = Date.now() - 2 * 60 * 60 * 1000;
        await core.claims.claim({
          board: context.board,
          ticket: "ck-a",
          actor: context.actor.id,
          now: claimedAt,
        });

        expect(
          await activeActors(context.core, context.board, context.config, "1h"),
        ).toEqual([]);
        expect(
          await activeActors(context.core, context.board, context.config, "3h"),
        ).toEqual([{ parent: context.actor.id, tickets: ["ck-a"] }]);
      } finally {
        context.core.dispose();
      }
    });
  } finally {
    await repo.cleanup();
  }
});
