import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { claim, type ClaimResult } from "../../src/claims/index";
import { claimCore, type ClaimHooks } from "../../src/claims/claim";
import { ClaimErrorCodes } from "../../src/claims/errors";
import { parseDurationMs } from "../../src/claims/duration";
import { hermeticEnv, writeRepoConfigFile } from "../config/testHelpers";
import { type CanKanError, ErrorCodes, isCanKanError } from "../../src/errors";
import { append, boardKeyFor, firstSeen, read, type EventCandidate } from "../../src/events/index";
import { createGitAdapter, GitErrorCodes } from "../../src/git/index";
import type { ActorId, BoardRef } from "../../src/types";

// ============================================================================
// House rig — mirrors `packages/core/test/store/ticketStore.test.ts`'s
// `withTestBoard`/`hermeticEnv` pattern and `events/ref.test.ts`'s
// `repos[]`/`tempRepo`/`expectCode` pattern.
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

/**
 * Asserts `promise` rejects with a `CanKanError` carrying exactly `code`,
 * and returns the error so a caller can inspect `.details` further. Never
 * asserts on `.message` — a message is not API.
 */
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

/**
 * Every test in this file must run inside `withEnv()` — `claim()` reaches
 * `$XDG_STATE_HOME` transitively via `observeAndFold` -> `observe()`, even
 * though nothing in `claims/` mentions XDG. `board.ticketsDir` is created
 * (even with zero tickets yet written) so `store.list()` never fails with
 * "tickets directory missing" for a test that claims against an empty
 * board.
 */
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

/**
 * Same as `withTestBoard`, but also builds a second `BoardRef` rooted at
 * `repo.worktreeDirs[0]` — the standard concurrency rig for this module.
 * **Worktrees share `.git` but not the working tree**: a ticket file
 * written only into `repo.dir` does not exist under the second worktree, so
 * every ticket a two-worktree test needs must be written into BOTH
 * `board.ticketsDir` and `board2.ticketsDir`.
 */
async function withTwoWorktreeBoards(
  fn: (ctx: { board: BoardRef; board2: BoardRef; repo: TempRepo }) => Promise<void>,
): Promise<void> {
  await withEnv(undefined, async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const secondaryDir = repo.worktreeDirs[0];
    if (secondaryDir === undefined) throw new Error("expected a worktree");
    const board = await buildBoardRef({ kind: "repo", name: "primary", root: repo.dir, env: hermeticEnv() });
    const board2 = await buildBoardRef({ kind: "repo", name: "secondary", root: secondaryDir, env: hermeticEnv() });
    await mkdir(board.ticketsDir, { recursive: true });
    await mkdir(board2.ticketsDir, { recursive: true });
    await fn({ board, board2, repo });
  });
}

/** Writes one minimal fixture ticket into `dir` (see `test-utils/src/fixtureTickets.ts`). */
function fixtureTicket(id: string, title: string): { id: string; title: string; status: string; body: string } {
  return { id, title, status: "To Do", body: `Body for ${title}.` };
}

/** A minimal, valid `close` candidate — cast at the boundary like every other branded-id caller (`TicketId`/`ActorId` carry no runtime constructor; see `types.ts`), mirroring `events/log.test.ts`'s own `claim()`/`release()` test helpers. */
function closeCandidate(ticket: string, actor: string): EventCandidate {
  return {
    event: "close",
    ts: new Date(NOW).toISOString(),
    actor,
    ticket,
  } as unknown as EventCandidate;
}

function actorId(id: string): ActorId {
  return id as ActorId;
}

// ============================================================================
// 1. Exactly one winner under a real two-worktree race
// ============================================================================

test("exactly one winner under a real two-worktree race", async () => {
  await withTwoWorktreeBoards(async ({ board, board2 }) => {
    const ticket = fixtureTicket("ck-race", "Race");
    await writeFixtureTickets(board.ticketsDir, [ticket]);
    await writeFixtureTickets(board2.ticketsDir, [ticket]);

    const actorA = actorId("actor-a");
    const actorB = actorId("actor-b");
    const results = await Promise.allSettled([
      claim({ board, ticket: "ck-race", actor: actorA, now: NOW }),
      claim({ board: board2, ticket: "ck-race", actor: actorB, now: NOW }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<ClaimResult> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // Both asserted as hard assertions -- never `if (rejected.length) ...`.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectionReason = rejected[0]?.reason;
    if (!isCanKanError(rejectionReason)) throw new Error("expected a CanKanError rejection");
    expect(rejectionReason.code).toBe(ErrorCodes.CLAIM_REJECTED);
    expect(rejectionReason.details?.reason).toBe("already-held");

    const winnerActor = fulfilled[0]?.value.actor;
    expect(winnerActor).toBeDefined();
    expect(rejectionReason.details?.holder).toBe(winnerActor);

    // A fresh fold shows the winner as holder: a third, uninvolved claim
    // attempt must reject naming the same winner.
    const thirdRejection = await expectCode(
      claim({ board, ticket: "ck-race", actor: actorId("actor-c"), now: NOW }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(thirdRejection.details?.holder).toBe(winnerActor);
  });
});

// ============================================================================
// 2. The loser retries and observes the winner's claim — deterministically
// ============================================================================

describe("claimCore — deterministic retry via the beforeAppend hook", () => {
  test("a competitor claiming the SAME ticket on attempt 1 forces a real retry, then a named rejection", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-race2", "Race two")]);

      const beforeAppendAttempts: number[] = [];
      const retriesScheduled: number[] = [];
      const competitor = actorId("actor-competitor");
      const hooks: ClaimHooks = {
        beforeAppend: async (attemptNumber) => {
          beforeAppendAttempts.push(attemptNumber);
          if (beforeAppendAttempts.length === 1) {
            // A full, independent `claim()` call for the SAME ticket,
            // landed while this attempt's own decision is still in flight
            // -- guaranteed (not merely probable) to move the ref's tip
            // out from under this attempt's `expectedParent`.
            await claim({ board, ticket: "ck-race2", actor: competitor, now: NOW });
          }
        },
      };

      const rejection = await expectCode(
        claimCore(
          {
            board,
            ticket: "ck-race2",
            actor: actorId("actor-mine"),
            now: NOW,
            casRetry: {
              maxAttempts: 5,
              // `backoffMs` fires between a `{ done: false }` attempt and
              // the next one -- proof the retry loop actually advanced,
              // independent of whether the *next* attempt reaches the
              // `beforeAppend` hook (it does not, in this sub-case: attempt
              // 2 rejects during `claimAttempt`'s decide step, before ever
              // reaching the append hook — that is the correct behavior,
              // not a bug in this test).
              backoffMs: (attemptNumber) => {
                retriesScheduled.push(attemptNumber);
                return 0;
              },
            },
          },
          hooks,
        ),
        ErrorCodes.CLAIM_REJECTED,
      );

      expect(retriesScheduled).toEqual([1]);
      expect(beforeAppendAttempts).toEqual([1]);
      expect(rejection.details?.reason).toBe("already-held");
      expect(rejection.details?.holder).toBe(competitor);
    });
  });

  test("mirror case: a competitor claiming a DIFFERENT ticket still forces a retry, which then succeeds", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-mine3", "Mine three"), fixtureTicket("ck-other3", "Other three")]);

      const beforeAppendAttempts: number[] = [];
      const retriesScheduled: number[] = [];
      const hooks: ClaimHooks = {
        beforeAppend: async (attemptNumber) => {
          beforeAppendAttempts.push(attemptNumber);
          if (beforeAppendAttempts.length === 1) {
            await claim({ board, ticket: "ck-other3", actor: actorId("actor-competitor3"), now: NOW });
          }
        },
      };

      const result = await claimCore(
        {
          board,
          ticket: "ck-mine3",
          actor: actorId("actor-mine3"),
          now: NOW,
          casRetry: {
            maxAttempts: 5,
            backoffMs: (attemptNumber) => {
              retriesScheduled.push(attemptNumber);
              return 0;
            },
          },
        },
        hooks,
      );

      expect(result.kind).toBe("claim");
      // Unlike the same-ticket case: this attempt's own decision (about
      // `ck-mine3`) is unaffected by the competitor's unrelated ticket, so
      // attempt 2 re-reads, still finds `ck-mine3` free, and reaches the
      // append hook a second time -- proving retry works, not just
      // rejection.
      expect(beforeAppendAttempts).toEqual([1, 2]);
      expect(retriesScheduled).toEqual([1]);
    });
  });
});

// ============================================================================
// 3. `--force` writes `takeover`, only against a live lease
// ============================================================================

test("--force writes takeover against a live lease, and a plain claim against an unclaimed ticket", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-force-live", "Live"), fixtureTicket("ck-force-free", "Free")]);
    const holder = actorId("actor-holder");
    const forcer = actorId("actor-forcer");

    await claim({ board, ticket: "ck-force-live", actor: holder, now: NOW });
    const takeover = await claim({ board, ticket: "ck-force-live", actor: forcer, now: NOW, force: true });
    expect(takeover.kind).toBe("takeover");

    const adapter = await createGitAdapter(board.root);
    const records = await read(adapter, board.coordinationRef, { now: NOW });
    const takeoverRecord = records.find((r) => r.event.id === takeover.eventId);
    expect(takeoverRecord?.event.event).toBe("takeover");

    // Ruling: `force` on an UNCLAIMED ticket degrades to the ordinary path.
    const plain = await claim({ board, ticket: "ck-force-free", actor: forcer, now: NOW, force: true });
    expect(plain.kind).toBe("claim");
    const plainRecord = (await read(adapter, board.coordinationRef, { now: NOW })).find((r) => r.event.id === plain.eventId);
    expect(plainRecord?.event.event).toBe("claim");
  });
});

test("two concurrent --force calls converge on exactly one holder, never GIT_CAS_CONTENTION_EXCEEDED", async () => {
  await withTwoWorktreeBoards(async ({ board, board2 }) => {
    const ticket = fixtureTicket("ck-force-race", "Force race");
    await writeFixtureTickets(board.ticketsDir, [ticket]);
    await writeFixtureTickets(board2.ticketsDir, [ticket]);

    const original = actorId("actor-original");
    await claim({ board, ticket: "ck-force-race", actor: original, now: NOW });

    const forcerX = actorId("actor-forcer-x");
    const forcerY = actorId("actor-forcer-y");
    const results = await Promise.allSettled([
      claim({ board, ticket: "ck-force-race", actor: forcerX, now: NOW, force: true }),
      claim({ board: board2, ticket: "ck-force-race", actor: forcerY, now: NOW, force: true }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<ClaimResult> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const reason = rejected[0]?.reason;
    if (!isCanKanError(reason)) throw new Error("expected a CanKanError rejection");
    expect(reason.code).toBe(ErrorCodes.CLAIM_REJECTED);
    expect(reason.code).not.toBe(GitErrorCodes.GIT_CAS_CONTENTION_EXCEEDED);
  });
});

// ============================================================================
// 4. `max_per_actor` at the boundary, and `0` meaning unlimited
// ============================================================================

test("max_per_actor rejects at the boundary", async () => {
  await withTestBoard(async ({ board }) => {
    await writeRepoConfigFile(board.root, "config.yml", "claims:\n  max_per_actor: 2\n");
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-cap-1", "Cap one"),
      fixtureTicket("ck-cap-2", "Cap two"),
      fixtureTicket("ck-cap-3", "Cap three"),
    ]);
    const actor = actorId("actor-capped");
    await claim({ board, ticket: "ck-cap-1", actor, now: NOW });
    await claim({ board, ticket: "ck-cap-2", actor, now: NOW });
    const rejection = await expectCode(claim({ board, ticket: "ck-cap-3", actor, now: NOW }), ErrorCodes.CLAIM_REJECTED);
    expect(rejection.details?.reason).toBe("max-per-actor");
    expect(rejection.details?.limit).toBe(2);
  });
});

test("max_per_actor: 0 means unlimited, not zero allowed", async () => {
  await withTestBoard(async ({ board }) => {
    await writeRepoConfigFile(board.root, "config.yml", "claims:\n  max_per_actor: 0\n");
    const ids = ["ck-unl-1", "ck-unl-2", "ck-unl-3", "ck-unl-4"];
    await writeFixtureTickets(
      board.ticketsDir,
      ids.map((id) => fixtureTicket(id, id)),
    );
    const actor = actorId("actor-unlimited");
    for (const id of ids) {
      const result = await claim({ board, ticket: id, actor, now: NOW });
      expect(result.kind).toBe("claim");
    }
  });
});

// ============================================================================
// 5. Reclaim of an expired lease — one `withEnv` block for both steps
// ============================================================================

test("reclaim of an expired lease appends expire then claim, and step 8's observe() is exercised", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-expire", "Expire")]);
    const actorA = actorId("actor-a5");
    const actorB = actorId("actor-b5");

    const claimedByA = await claim({ board, ticket: "ck-expire", actor: actorA, now: NOW });
    expect(claimedByA.kind).toBe("claim");

    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);
    // This is the test for step 8: it passes only if `claim()` called
    // `observe()` on A's event id after appending it. If this assertion
    // fails, the fix is NEVER to bump `now` further -- that would hide a
    // missing `observe()`, not exercise it.
    expect(await firstSeen(boardKey, claimedByA.eventId)).toBe(NOW);

    const leaseTtlMs = parseDurationMs("2h"); // the board's default `claims.lease`
    const laterNow = NOW + leaseTtlMs + 1;
    const claimedByB = await claim({ board, ticket: "ck-expire", actor: actorB, now: laterNow });
    expect(claimedByB.kind).toBe("claim");
    // The reclaim path spends one attempt on the `expire` and a second on
    // the `claim`.
    expect(claimedByB.attempts).toBe(2);

    const records = await read(adapter, board.coordinationRef, { now: laterNow });
    const expireRecord = records.find((r) => r.event.event === "expire" && r.event.ticket === "ck-expire");
    const bClaimRecord = records.find((r) => r.event.id === claimedByB.eventId);
    expect(expireRecord).toBeDefined();
    expect(bClaimRecord).toBeDefined();
    if (expireRecord === undefined || bClaimRecord === undefined) throw new Error("expected both records");
    const expireBeforeClaim =
      expireRecord.month < bClaimRecord.month || (expireRecord.month === bClaimRecord.month && expireRecord.line < bClaimRecord.line);
    expect(expireBeforeClaim).toBe(true);
    // The `expire` event's `actor` is whoever appends it -- the reclaiming
    // actor (B), never the original holder (A). This is the honest audit
    // trail ("B expired A's lease and took the ticket").
    expect(expireRecord.event.actor).toBe(actorB);

    // B's claim is the live anchor in a fresh fold.
    const thirdRejection = await expectCode(
      claim({ board, ticket: "ck-expire", actor: actorId("actor-c5"), now: laterNow }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(thirdRejection.details?.holder).toBe(actorB);
  });
});

// ============================================================================
// 6. A duplicated ticket id is rejected as ambiguous, never claimed
// ============================================================================

test("a duplicated ticket id is rejected as ambiguous, never claimed", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      { id: "ck-dup", title: "Version A", status: "To Do", body: "a" },
      { id: "ck-dup", title: "Version B", status: "To Do", body: "b" },
    ]);
    await expectCode(claim({ board, ticket: "ck-dup", actor: actorId("actor-dup"), now: NOW }), ClaimErrorCodes.TICKET_AMBIGUOUS);

    const adapter = await createGitAdapter(board.root);
    // No event was appended -- the coordination ref must still be entirely
    // uninitialized.
    expect(await adapter.readRef(board.coordinationRef)).toBeNull();
  });
});

// ============================================================================
// 7. Every rejection path — issue #33's Done-when
// ============================================================================

describe("claim — rejection paths", () => {
  test("unknown ticket -> CLAIM_TICKET_NOT_FOUND", async () => {
    await withTestBoard(async ({ board }) => {
      await expectCode(claim({ board, ticket: "ck-nope", actor: actorId("actor-x7"), now: NOW }), ClaimErrorCodes.TICKET_NOT_FOUND);
    });
  });

  test("already held by another actor -> CLAIM_REJECTED / already-held", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-held7", "Held")]);
      const holder = actorId("actor-holder7");
      await claim({ board, ticket: "ck-held7", actor: holder, now: NOW });
      const rejection = await expectCode(
        claim({ board, ticket: "ck-held7", actor: actorId("actor-other7"), now: NOW }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("already-held");
      expect(rejection.details?.holder).toBe(holder);
    });
  });

  test("already held by you -> CLAIM_REJECTED / already-held-by-you (never silently a renew)", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-self7", "Self")]);
      const actor = actorId("actor-self7");
      await claim({ board, ticket: "ck-self7", actor, now: NOW });
      const rejection = await expectCode(claim({ board, ticket: "ck-self7", actor, now: NOW }), ErrorCodes.CLAIM_REJECTED);
      expect(rejection.details?.reason).toBe("already-held-by-you");
    });
  });

  test("closed ticket -> CLAIM_REJECTED / closed", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-closed7", "Closed")]);
      // `TicketState.closed` is folded from a real `close` event, never
      // from frontmatter `status` -- append one directly.
      const adapter = await createGitAdapter(board.root);
      await append(adapter, board.coordinationRef, closeCandidate("ck-closed7", "actor-closer7"), { now: NOW });
      const rejection = await expectCode(
        claim({ board, ticket: "ck-closed7", actor: actorId("actor-x7b"), now: NOW }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("closed");
    });
  });

  test("malformed casRetry.maxAttempts below the reclaim floor -> CLAIM_INVALID_OPTION", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-badopt", "Bad option")]);
      await expectCode(
        claim({ board, ticket: "ck-badopt", actor: actorId("actor-badopt"), now: NOW, casRetry: { maxAttempts: 1 } }),
        ClaimErrorCodes.INVALID_OPTION,
      );
    });
  });
});
