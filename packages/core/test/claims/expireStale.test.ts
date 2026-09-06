import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { claim, expireStale, renew } from "../../src/claims/index";
import { expireStaleCore, type ExpireStaleHooks } from "../../src/claims/claim";
import { ErrorCodes, type CanKanError, isCanKanError } from "../../src/errors";
import { parseDurationMs } from "../../src/claims/duration";
import { hermeticEnv } from "../config/testHelpers";
import { boardKeyFor, firstSeen, read } from "../../src/events/index";
import { EventErrorCodes } from "../../src/events/errors";
import { recordPath } from "../../src/events/observations";
import { createGitAdapter } from "../../src/git/index";
import type { ActorId, BoardRef, TicketId } from "../../src/types";

// ============================================================================
// House rig — same pattern as `claim.test.ts`'s own header comment.
// ============================================================================

const NOW = Date.parse("2026-09-15T10:00:00Z");
const LEASE_TTL_MS = parseDurationMs("2h"); // the board's default `claims.lease`

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
// Basic behavior: a single expired ticket is swept, all its ids discarded
// ============================================================================

test("expireStale expires an observed-expired lease (claim + 2 renews), appending expire and discarding all accumulated ids", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-sweep-basic", "Basic sweep")]);
    const actor = actorId("actor-sweep-basic");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    const claimed = await claim({ board, ticket: "ck-sweep-basic", actor, now: NOW });
    const renewed1 = await renew({ board, ticket: "ck-sweep-basic", actor, now: NOW + 10 * 60_000 });
    const renewed2 = await renew({ board, ticket: "ck-sweep-basic", actor, now: NOW + 20 * 60_000 });

    const sweepNow = NOW + 20 * 60_000 + LEASE_TTL_MS + 1;
    const sweeper = actorId("actor-sweeper-basic");
    const result = await expireStale({ board, actor: sweeper, now: sweepNow });

    expect(result.dryRun).toBe(false);
    expect(result.tickets.length).toBe(1);
    expect(result.tickets[0]?.ticket).toBe("ck-sweep-basic" as TicketId);
    expect(result.tickets[0]?.outcome).toBe("expired");
    const eventId = result.tickets[0]?.eventId;
    expect(eventId).toBeDefined();

    const records = await read(adapter, board.coordinationRef, { now: sweepNow });
    const expireRecord = records.find((r) => r.event.id === eventId);
    expect(expireRecord?.event.event).toBe("expire");
    expect(expireRecord?.event.actor).toBe(sweeper);

    for (const id of [claimed.eventId, renewed1.eventId, renewed2.eventId]) {
      expect(await firstSeen(boardKey, id)).toBeNull();
    }
  });
});

// ============================================================================
// Required test 9: dry run appends/discards nothing; a real sweep expires
// exactly the expired ones and leaves live leases untouched.
// ============================================================================

test("dry run appends nothing and discards nothing; a real sweep then expires exactly the expired ones and leaves live leases untouched", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-sweep-expired", "Will expire"),
      fixtureTicket("ck-sweep-live", "Stays live"),
    ]);
    const expiredHolder = actorId("actor-sweep-expired-holder");
    const liveHolder = actorId("actor-sweep-live-holder");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    // "ck-sweep-expired" is claimed early and left alone (will be past TTL
    // by the time the sweep runs). "ck-sweep-live" is claimed close to the
    // sweep's own `now`, so it is still well within its TTL.
    const expiredClaim = await claim({ board, ticket: "ck-sweep-expired", actor: expiredHolder, now: NOW });
    const sweepNow = NOW + LEASE_TTL_MS + 1;
    await claim({ board, ticket: "ck-sweep-live", actor: liveHolder, now: sweepNow - 1000 });

    // Dry run first — exactly one candidate ("ck-sweep-expired"), the only
    // ticket whose lease is observed expired at `sweepNow`.
    const sweeper = actorId("actor-sweeper-dryrun");
    const dryRunResult = await expireStale({ board, actor: sweeper, now: sweepNow, dryRun: true });
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.tickets.length).toBe(1);
    expect(dryRunResult.tickets[0]?.ticket).toBe("ck-sweep-expired" as TicketId);
    expect(dryRunResult.tickets[0]?.outcome).toBe("expired");
    expect(dryRunResult.tickets[0]?.eventId).toBeUndefined();

    const afterDryRunRecords = await read(adapter, board.coordinationRef, { now: sweepNow });
    expect(afterDryRunRecords.filter((r) => r.event.event === "expire").length).toBe(0);
    // Discards nothing: the expired candidate's claim id is still on record.
    expect(await firstSeen(boardKey, expiredClaim.eventId)).not.toBeNull();

    // A real sweep expires exactly "ck-sweep-expired" and leaves
    // "ck-sweep-live" untouched.
    const realResult = await expireStale({ board, actor: sweeper, now: sweepNow });
    expect(realResult.dryRun).toBe(false);
    expect(realResult.tickets.length).toBe(1);
    expect(realResult.tickets[0]?.ticket).toBe("ck-sweep-expired" as TicketId);
    expect(realResult.tickets[0]?.outcome).toBe("expired");
    expect(realResult.tickets[0]?.eventId).toBeDefined();

    const afterRealRecords = await read(adapter, board.coordinationRef, { now: sweepNow });
    const expireRecords = afterRealRecords.filter((r) => r.event.event === "expire");
    expect(expireRecords.length).toBe(1);
    expect(expireRecords[0]?.event.ticket).toBe("ck-sweep-expired" as TicketId);

    // "ck-sweep-expired"'s accumulated id is discarded. **Checked BEFORE any
    // further fold over this same window** — `observeAndFold` re-observes
    // every claim/takeover/renew for every KNOWN ticket in the read window
    // on every fold, not only the ticket a caller is asking about (confirmed
    // directly: an earlier version of this test checked this AFTER the
    // "still live" `claim()` call below, and that call's own internal fold
    // over "ck-sweep-live" silently re-observed "ck-sweep-expired"'s already-
    // discarded id too, recreating a fresh record and failing this
    // assertion). A discard's effect is real but only durable until the
    // discarded id's own event next falls inside some other fold's read
    // window — this module cannot change that (`state/` is out of this
    // slice's scope), so this test pins the check at the one point where it
    // is meaningful.
    expect(await firstSeen(boardKey, expiredClaim.eventId)).toBeNull();

    // "ck-sweep-live" is untouched: a fresh fold still shows `liveHolder`.
    const stillLive = await expectCode(
      claim({ board, ticket: "ck-sweep-live", actor: actorId("actor-sweep-third"), now: sweepNow }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(stillLive.details?.reason).toBe("already-held");
    expect(stillLive.details?.holder).toBe(liveHolder);
  });
});

// ============================================================================
// Required test 10: a ticket renewed underneath the sweep is skipped, not
// aborting the sweep — the other ticket still gets swept.
// ============================================================================

test("a ticket renewed underneath the sweep is skipped, and the sweep still expires the other candidate", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-sweep-target", "Target"),
      fixtureTicket("ck-sweep-renewed", "Renewed underneath"),
    ]);
    const targetHolder = actorId("actor-sweep-target-holder");
    const renewedHolder = actorId("actor-sweep-renewed-holder");
    const adapter = await createGitAdapter(board.root);

    await claim({ board, ticket: "ck-sweep-target", actor: targetHolder, now: NOW });
    await claim({ board, ticket: "ck-sweep-renewed", actor: renewedHolder, now: NOW });

    // Two DIFFERENT `now` values, the same rig as the release-vs-competitor
    // CAS race: the sweep's own `now` must see BOTH leases as expired (so
    // both become candidates at the initial fold), while the renewer's own
    // `now` must be inside the original TTL (so its `renew` is valid — a
    // renew attempted at the sweep's own `now` would itself be rejected as
    // `lease-expired`, and the test would prove nothing).
    const sweepNow = NOW + LEASE_TTL_MS + 1;
    const renewNow = NOW + LEASE_TTL_MS - 1;

    const beforeAppendCalls: Array<{ ticket: TicketId; attemptNumber: number }> = [];
    const hooks: ExpireStaleHooks = {
      beforeAppend: async (ticket, attemptNumber) => {
        beforeAppendCalls.push({ ticket, attemptNumber });
        if (ticket === "ck-sweep-renewed" && attemptNumber === 1) {
          // A full, independent renew landing while this ticket's own
          // expire-attempt decision is still in flight -- guaranteed to
          // move the ref's tip out from under this attempt's
          // `expectedParent`.
          await renew({ board, ticket: "ck-sweep-renewed", actor: renewedHolder, now: renewNow });
        }
      },
    };

    const sweeper = actorId("actor-sweeper-skip");
    const result = await expireStaleCore({ board, actor: sweeper, now: sweepNow }, hooks);

    expect(result.dryRun).toBe(false);
    expect(result.tickets.length).toBe(2);

    const targetResult = result.tickets.find((t) => t.ticket === "ck-sweep-target");
    const renewedResult = result.tickets.find((t) => t.ticket === "ck-sweep-renewed");
    expect(targetResult?.outcome).toBe("expired");
    expect(targetResult?.eventId).toBeDefined();
    expect(renewedResult?.outcome).toBe("skipped");
    expect(renewedResult?.reason).toBe("renewed");

    const records = await read(adapter, board.coordinationRef, { now: sweepNow });
    const expireRecords = records.filter((r) => r.event.event === "expire");
    expect(expireRecords.length).toBe(1);
    expect(expireRecords[0]?.event.ticket).toBe("ck-sweep-target" as TicketId);

    // "ck-sweep-renewed" is still live, held by the same actor, anchored on
    // the renew the hook injected.
    const stillLive = await expectCode(
      claim({ board, ticket: "ck-sweep-renewed", actor: actorId("actor-sweep-third-r"), now: sweepNow }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(stillLive.details?.reason).toBe("already-held");
    expect(stillLive.details?.holder).toBe(renewedHolder);
  });
});

// ============================================================================
// The other disposition: an observation-store failure hard-aborts, and the
// terminating append has already landed by the time it is reported.
// ============================================================================

describe("expireStale — the observation-store failure disposition (distinct from a per-ticket skip)", () => {
  test("a discard failure hard-throws EVENT_OBSERVATION_STORE_UNAVAILABLE, tagged appended:true, with the expire already in the log", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-sweep-storefail", "Store failure")]);
      const actor = actorId("actor-sweep-storefail");
      const adapter = await createGitAdapter(board.root);
      const boardKey = await boardKeyFor(adapter);

      const claimed = await claim({ board, ticket: "ck-sweep-storefail", actor, now: NOW });
      const sweepNow = NOW + LEASE_TTL_MS + 1;

      // The observation store's boardHash directory already exists by the
      // time `beforeAppend` fires (created by `claim()`'s own `observe()`
      // call above, and re-touched by the sweep's own candidate-selection
      // fold) -- locking it down here, right before the append, blocks only
      // the DISCARD step that follows the append, not the fold that
      // preceded it.
      const dir = dirname(recordPath(boardKey, claimed.eventId));
      const hooks: ExpireStaleHooks = {
        beforeAppend: async () => {
          await chmod(dir, 0o500);
        },
      };

      try {
        const sweeper = actorId("actor-sweeper-storefail");
        const error = await expectCode(
          expireStaleCore({ board, actor: sweeper, now: sweepNow }, hooks),
          EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
        );
        expect(error.details?.appended).toBe(true);
      } finally {
        // Restore before `withEnv`'s own cleanup tries to remove the temp
        // `$XDG_STATE_HOME` tree -- a directory left read-only would make
        // that recursive removal fail too.
        await chmod(dir, 0o700);
      }

      // The terminator genuinely landed despite the cleanup failure -- an
      // `expire` event is in the log.
      const records = await read(adapter, board.coordinationRef, { now: sweepNow });
      const expireRecord = records.find((r) => r.event.event === "expire" && r.event.ticket === "ck-sweep-storefail");
      expect(expireRecord).toBeDefined();

      // ...but the discard never completed -- the record leaked, exactly
      // the failure ADR 0001 failure mode 7 requires this module to report
      // loudly rather than shrug off.
      expect(await firstSeen(boardKey, claimed.eventId)).not.toBeNull();
    });
  });
});

// ============================================================================
// The test-only `beforeAppend` seam is exported, even if not exercised here
// ============================================================================

test("expireStaleCore accepts a hooks object keyed by ticket (mirrors claimCore's shape)", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-sweep-hook", "Hook")]);
    const actor = actorId("actor-sweep-hook");
    await claim({ board, ticket: "ck-sweep-hook", actor, now: NOW });

    const calls: Array<{ ticket: TicketId; attemptNumber: number }> = [];
    const hooks: ExpireStaleHooks = {
      beforeAppend: async (ticket, attemptNumber) => {
        calls.push({ ticket, attemptNumber });
      },
    };
    const sweepNow = NOW + LEASE_TTL_MS + 1;
    const result = await expireStaleCore({ board, actor: actorId("actor-sweep-hook-sweeper"), now: sweepNow }, hooks);
    expect(calls).toEqual([{ ticket: "ck-sweep-hook" as TicketId, attemptNumber: 1 }]);
    expect(result.tickets[0]?.outcome).toBe("expired");
  });
});
