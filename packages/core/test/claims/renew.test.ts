import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { claim, renew } from "../../src/claims/index";
import { renewCore, type RenewHooks } from "../../src/claims/claim";
import { ErrorCodes, type CanKanError, isCanKanError } from "../../src/errors";
import { parseDurationMs } from "../../src/claims/duration";
import { hermeticEnv, writeRepoConfigFile } from "../config/testHelpers";
import { read } from "../../src/events/index";
import { createGitAdapter } from "../../src/git/index";
import type { ActorId, BoardRef, TicketId } from "../../src/types";

// ============================================================================
// House rig — same pattern as `claim.test.ts`'s own header comment.
// ============================================================================

const NOW = Date.parse("2026-09-15T10:00:00Z");

const repos: TempRepo[] = [];
async function tempRepo(options: Parameters<typeof makeTempRepo>[0] = {}): Promise<TempRepo> {
  const repo = await makeTempRepo(options);
  repos.push(repo);
  return repo;
}

afterEach(async () => {
  while (repos.length > 0) {
    const repo = repos.pop();
    if (repo) await repo.cleanup();
  }
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<CanKanError> {
  try {
    await promise;
  } catch (error) {
    if (!isCanKanError(error)) {
      throw new Error(`expected a CanKanError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected rejection with code ${code}, but the promise resolved`);
}

async function withTestBoard(
  fn: (ctx: { board: BoardRef; repo: TempRepo }) => Promise<void>,
  repoOptions: Parameters<typeof makeTempRepo>[0] = {},
): Promise<void> {
  await withEnv(undefined, async () => {
    const repo = await tempRepo(repoOptions);
    const board = await buildBoardRef({ kind: "repo", name: "test-board", root: repo.dir, env: hermeticEnv() });
    await mkdir(board.ticketsDir, { recursive: true });
    await fn({ board, repo });
  });
}

function fixtureTicket(id: string, title: string): { id: string; title: string; status: string; body: string } {
  return { id, title, status: "To Do", body: `Body for ${title}.` };
}

function actorId(id: string): ActorId {
  return id as ActorId;
}

// ============================================================================
// Basic renew behavior
// ============================================================================

test("renew extends a live lease, appends a renew event with a fresh lease_until, and observe()s it", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-renew-1", "Renew one")]);
    const actor = actorId("actor-renew-1");
    await claim({ board, ticket: "ck-renew-1", actor, now: NOW });

    const laterNow = NOW + 10 * 60 * 1000;
    const result = await renew({ board, ticket: "ck-renew-1", actor, now: laterNow });
    expect(result.ticket).toBe("ck-renew-1" as TicketId);
    expect(result.actor).toBe(actor);

    const adapter = await createGitAdapter(board.root);
    const records = await read(adapter, board.coordinationRef, { now: laterNow });
    const renewRecord = records.find((r) => r.event.id === result.eventId);
    expect(renewRecord?.event.event).toBe("renew");
    if (renewRecord?.event.event !== "renew") throw new Error("expected a renew record");
    expect(renewRecord.event.lease_until).toBe(result.leaseUntil);
  });
});

// ============================================================================
// Rejections — `not-held`, `not-holder`, `lease-expired`
// ============================================================================

describe("renew — rejection paths", () => {
  test("no lease at all -> CLAIM_REJECTED / not-held, no event appended", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-renew-noheld", "No lease")]);
      const rejection = await expectCode(
        renew({ board, ticket: "ck-renew-noheld", actor: actorId("actor-x"), now: NOW }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("not-held");

      const adapter = await createGitAdapter(board.root);
      expect(await adapter.readRef(board.coordinationRef)).toBeNull();
    });
  });

  test("lease held by a different actor -> CLAIM_REJECTED / not-holder, no event appended", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-renew-other", "Other holder")]);
      const holder = actorId("actor-holder-r");
      await claim({ board, ticket: "ck-renew-other", actor: holder, now: NOW });

      const rejection = await expectCode(
        renew({ board, ticket: "ck-renew-other", actor: actorId("actor-not-holder-r"), now: NOW }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("not-holder");
      expect(rejection.details?.holder).toBe(holder);

      const adapter = await createGitAdapter(board.root);
      const records = await read(adapter, board.coordinationRef, { now: NOW });
      expect(records.filter((r) => r.event.event === "renew").length).toBe(0);
    });
  });

  // Required test 7: `renew` on an expired lease is rejected with
  // `lease-expired`, and no event appended — even though this actor IS the
  // anchor. Ruling (this file's header via `claim.ts`): a `renew` appended
  // after expiry would re-anchor the lease by chain position for every
  // reader that has not yet expired it, resurrecting a lease the holder no
  // longer owns.
  test("renew on an expired lease -> CLAIM_REJECTED / lease-expired, no event appended, even for the true anchor actor", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-renew-expired", "Expired")]);
      const actor = actorId("actor-expired-r");
      await claim({ board, ticket: "ck-renew-expired", actor, now: NOW });

      const leaseTtlMs = parseDurationMs("2h"); // the board's default `claims.lease`
      const pastExpiry = NOW + leaseTtlMs + 1;
      const rejection = await expectCode(
        renew({ board, ticket: "ck-renew-expired", actor, now: pastExpiry }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("lease-expired");

      const adapter = await createGitAdapter(board.root);
      const records = await read(adapter, board.coordinationRef, { now: pastExpiry });
      expect(records.filter((r) => r.event.event === "renew").length).toBe(0);
    });
  });
});

// ============================================================================
// Finding A's mirror: `renew`'s own `--lease` is display-only, same as claim's
// ============================================================================

test("renew's own --lease overrides only the appended event's lease_until display field, never this reader's own expiry computation", async () => {
  await withTestBoard(async ({ board }) => {
    await writeRepoConfigFile(board.root, "config.yml", "claims:\n  lease: 2h\n");
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-renew-override", "Override")]);
    const actor = actorId("actor-override-r");
    await claim({ board, ticket: "ck-renew-override", actor, now: NOW });

    const renewNow = NOW + 30 * 60 * 1000;
    const result = await renew({ board, ticket: "ck-renew-override", actor, now: renewNow, lease: "1h" });

    const expectedOverrideLeaseUntil = new Date(renewNow + parseDurationMs("1h")).toISOString();
    expect(result.leaseUntil).toBe(expectedOverrideLeaseUntil);

    const adapter = await createGitAdapter(board.root);
    const records = await read(adapter, board.coordinationRef, { now: renewNow });
    const renewRecord = records.find((r) => r.event.id === result.eventId);
    if (renewRecord?.event.event !== "renew") throw new Error("expected a renew record");
    expect(renewRecord.event.lease_until).toBe(expectedOverrideLeaseUntil);

    // Proof the override never touched real expiry: the board's configured
    // lease is 2h, so this reader's own expiry is
    // `firstSeen(renewEventId) + 2h`, not `renewNow + 1h`. At
    // `renewNow + 1h + 1` (past the DISPLAYED override, well short of the
    // real 2h expiry), the ticket must still be reported live -- proven by
    // a competing claim still being rejected as `already-held`.
    const stillLiveAt = renewNow + parseDurationMs("1h") + 1;
    const rejection = await expectCode(
      claim({ board, ticket: "ck-renew-override", actor: actorId("actor-competitor-r"), now: stillLiveAt }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(rejection.details?.reason).toBe("already-held");
    expect(rejection.details?.holder).toBe(actor);
  });
});

// ============================================================================
// The test-only `beforeAppend` seam is exported, even if not exercised here
// ============================================================================

test("renewCore accepts a hooks object (test-only seam, mirrors claimCore)", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-renew-hook", "Hook")]);
    const actor = actorId("actor-hook-r");
    await claim({ board, ticket: "ck-renew-hook", actor, now: NOW });

    const attempts: number[] = [];
    const hooks: RenewHooks = {
      beforeAppend: async (attemptNumber) => {
        attempts.push(attemptNumber);
      },
    };
    const result = await renewCore({ board, ticket: "ck-renew-hook", actor, now: NOW + 1000 }, hooks);
    expect(attempts).toEqual([1]);
    expect(result.attempts).toBe(1);
  });
});
