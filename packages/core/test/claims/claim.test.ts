import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { claim, renew, type ClaimResult } from "../../src/claims/index";
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
  test("a competitor claiming the SAME ticket, from a SECOND worktree, on attempt 1 forces a real retry, then a named rejection", async () => {
    await withTwoWorktreeBoards(async ({ board, board2 }) => {
      const ticket = fixtureTicket("ck-race2", "Race two");
      await writeFixtureTickets(board.ticketsDir, [ticket]);
      await writeFixtureTickets(board2.ticketsDir, [ticket]);

      const beforeAppendAttempts: number[] = [];
      const retriesScheduled: number[] = [];
      const competitor = actorId("actor-competitor");
      const hooks: ClaimHooks = {
        beforeAppend: async (attemptNumber) => {
          beforeAppendAttempts.push(attemptNumber);
          if (beforeAppendAttempts.length === 1) {
            // A full, independent `claim()` call from the SECOND worktree,
            // for the SAME ticket, landed while this attempt's own decision
            // is still in flight -- guaranteed (not merely probable) to
            // move the ref's tip out from under this attempt's
            // `expectedParent`, the same way a genuine second worktree
            // would.
            await claim({ board: board2, ticket: "ck-race2", actor: competitor, now: NOW });
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

  test("mirror case: a competitor claiming a DIFFERENT ticket, from a SECOND worktree, still forces a retry, which then succeeds", async () => {
    await withTwoWorktreeBoards(async ({ board, board2 }) => {
      const tickets = [fixtureTicket("ck-mine3", "Mine three"), fixtureTicket("ck-other3", "Other three")];
      await writeFixtureTickets(board.ticketsDir, tickets);
      await writeFixtureTickets(board2.ticketsDir, tickets);

      const beforeAppendAttempts: number[] = [];
      const retriesScheduled: number[] = [];
      const hooks: ClaimHooks = {
        beforeAppend: async (attemptNumber) => {
          beforeAppendAttempts.push(attemptNumber);
          if (beforeAppendAttempts.length === 1) {
            await claim({ board: board2, ticket: "ck-other3", actor: actorId("actor-competitor3"), now: NOW });
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

test("the ping-pong guard, deterministically: a retry that observes a DIFFERENT holder than the one this call committed to forcing stops forcing and rejects", async () => {
  // The `Promise.allSettled` test above is a real race -- it *should*
  // interleave (git subprocess calls yield repeatedly), but that is an
  // estimate, not a measurement, and this project has been burned by
  // exactly that gap before (predicted ~490 subprocess spawns, measured
  // 611). This test isolates the ping-pong rule deterministically via the
  // `beforeAppend` hook, so it cannot pass by accident of timing.
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-force-pingpong", "Force ping-pong")]);
    const original = actorId("actor-original-pp");
    const interloperForcer = actorId("actor-interloper-forcer");
    const myself = actorId("actor-my-force");

    await claim({ board, ticket: "ck-force-pingpong", actor: original, now: NOW });

    const beforeAppendAttempts: number[] = [];
    const retriesScheduled: number[] = [];
    const hooks: ClaimHooks = {
      beforeAppend: async (attemptNumber) => {
        beforeAppendAttempts.push(attemptNumber);
        if (beforeAppendAttempts.length === 1) {
          // By the time this fires, `myself`'s attempt 1 has already
          // decided to force `original` and recorded it as the holder this
          // call committed to. A second, independent forced takeover lands
          // here -- `interloperForcer` over `original` -- before `myself`'s
          // own append runs, so `myself`'s next attempt observes a holder
          // that is neither `original` nor `myself`.
          await claim({ board, ticket: "ck-force-pingpong", actor: interloperForcer, now: NOW, force: true });
        }
      },
    };

    const rejection = await expectCode(
      claimCore(
        {
          board,
          ticket: "ck-force-pingpong",
          actor: myself,
          now: NOW,
          force: true,
          casRetry: {
            maxAttempts: 5,
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
    expect(rejection.details?.holder).toBe(interloperForcer);
    // The guard stops forcing on the very next attempt rather than chasing
    // the interloper -- never a confusing contention error.
    expect(rejection.code).not.toBe(GitErrorCodes.GIT_CAS_CONTENTION_EXCEEDED);
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

  // Fix round 4, finding 5 (ruling): `resolveTicket` echoes the raw `ticket`
  // query into both the thrown message and `details` — deliberately kept
  // (unlike every sibling validator in `events/log.ts`, which withholds the
  // raw value on principle), but bounded: control characters and Unicode
  // bidi/zero-width overrides are stripped before either destination ever
  // sees the value, the same standard `events/schema.ts`'s
  // `refineActorIdShape`/`refineTicketIdShape` and `ticket/filename.ts`'s
  // `isUnsafeFilenameChar` already hold ticket/actor ids to.
  test("a control character and a bidi override in the ticket query are neutralized in both the message and details -> CLAIM_TICKET_NOT_FOUND", async () => {
    await withTestBoard(async ({ board }) => {
      // `\x07` (BEL, an ASCII control character) and `\u202e` (RIGHT-TO-LEFT
      // OVERRIDE, a Unicode bidi-formatting code point — written as an
      // escape, not the literal glyph, so this file's own text stays
      // left-to-right) — neither ticket matches anything on this board, so
      // this reaches `CLAIM_TICKET_NOT_FOUND` regardless of sanitization.
      const hostileTicket = "ck-\x07nope\u202e";
      const error = await expectCode(
        claim({ board, ticket: hostileTicket, actor: actorId("actor-x8"), now: NOW }),
        ClaimErrorCodes.TICKET_NOT_FOUND,
      );
      expect(error.details?.ticket).toBe("ck-nope");
      expect(error.message).toContain("ck-nope");
      expect(error.message).not.toContain("\x07");
      expect(error.message).not.toContain("\u202e");
      expect(error.details?.ticket as string).not.toContain("\x07");
      expect(error.details?.ticket as string).not.toContain("\u202e");
    });
  });

  // Fix round 4, finding 5 (ruling), the other half of "bound it": the
  // echoed ticket is also truncated to `ticketSchema`'s `.max(200)` bound
  // (`events/schema.ts`) before it reaches either the message or `details`.
  test("an over-length ticket query is truncated to 200 characters in both the message and details -> CLAIM_TICKET_NOT_FOUND", async () => {
    await withTestBoard(async ({ board }) => {
      const overLongTicket = "x".repeat(300);
      const error = await expectCode(
        claim({ board, ticket: overLongTicket, actor: actorId("actor-x9"), now: NOW }),
        ClaimErrorCodes.TICKET_NOT_FOUND,
      );
      const echoedTicket = error.details?.ticket as string;
      expect(echoedTicket.length).toBe(200);
      expect(echoedTicket).toBe("x".repeat(200));
      expect(error.message).toContain("x".repeat(200));
      expect(error.message).not.toContain("x".repeat(201));
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

// ============================================================================
// Fix round finding A: `lease: "1h"`/`lease_until` display-only behaviour had
// ZERO test coverage — this is all-lane contract 1, the single most
// load-bearing untested behaviour in the module. The override must change
// the appended event's `lease_until` field and MUST NOT change this reader's
// own expiry computation.
// ============================================================================

test("finding A: claim's own --lease overrides only the appended event's lease_until display field, never this reader's own expiry computation", async () => {
  await withTestBoard(async ({ board }) => {
    await writeRepoConfigFile(board.root, "config.yml", "claims:\n  lease: 2h\n");
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-finding-a", "Finding A")]);
    const actor = actorId("actor-finding-a");

    const result = await claim({ board, ticket: "ck-finding-a", actor, now: NOW, lease: "1h" });
    const expectedOverrideLeaseUntil = new Date(NOW + parseDurationMs("1h")).toISOString();
    expect(result.leaseUntil).toBe(expectedOverrideLeaseUntil);

    const adapter = await createGitAdapter(board.root);
    const records = await read(adapter, board.coordinationRef, { now: NOW });
    const claimRecord = records.find((r) => r.event.id === result.eventId);
    if (claimRecord?.event.event !== "claim") throw new Error("expected a claim record");
    expect(claimRecord.event.lease_until).toBe(expectedOverrideLeaseUntil);

    // The board's configured lease is 2h, so this reader's own expiry is
    // `firstSeen(eventId) + 2h`, not `NOW + 1h`. At `NOW + 1h + 1` (past the
    // DISPLAYED override, well short of the real 2h expiry) the ticket must
    // still be reported live -- proven by a competing claim still being
    // rejected as `already-held`, never treated as an expired reclaim.
    const stillLiveAt = NOW + parseDurationMs("1h") + 1;
    const rejection = await expectCode(
      claim({ board, ticket: "ck-finding-a", actor: actorId("actor-finding-a-competitor"), now: stillLiveAt }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(rejection.details?.reason).toBe("already-held");
    expect(rejection.details?.holder).toBe(actor);
  });
});

// ============================================================================
// Fix round finding C: `ClaimParams.parent` is public surface but was never
// exercised by a test.
// ============================================================================

test("finding C: a claim carrying parent writes it onto the appended event", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-finding-c", "Finding C")]);
    const actor = actorId("actor-finding-c-agent");
    const parent = actorId("actor-finding-c-human");

    const result = await claim({ board, ticket: "ck-finding-c", actor, parent, now: NOW });

    const adapter = await createGitAdapter(board.root);
    const records = await read(adapter, board.coordinationRef, { now: NOW });
    const claimRecord = records.find((r) => r.event.id === result.eventId);
    expect(claimRecord?.event.parent).toBe(parent);
  });
});

// ============================================================================
// Fix round finding D: `INVALID_LEASE_DURATION` was only unit-tested via
// direct `parseDurationMs` calls -- the wiring between `claim()` and the
// parser was unverified.
// ============================================================================

describe("finding D: INVALID_LEASE_DURATION reached through claim(), not just parseDurationMs directly", () => {
  test("a malformed params.lease reaches CLAIM_INVALID_LEASE_DURATION through claim()", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-finding-d1", "Finding D1")]);
      await expectCode(
        claim({ board, ticket: "ck-finding-d1", actor: actorId("actor-finding-d1"), now: NOW, lease: "not-a-duration" }),
        ClaimErrorCodes.INVALID_LEASE_DURATION,
      );
      // Fails before any git invocation -- no event appended, ref untouched.
      const adapter = await createGitAdapter(board.root);
      expect(await adapter.readRef(board.coordinationRef)).toBeNull();
    });
  });

  test("a malformed claims.lease in a real .cankan/config.yml reaches CLAIM_INVALID_LEASE_DURATION through claim()", async () => {
    await withTestBoard(async ({ board }) => {
      // `"0h"` passes `config/schema.ts`'s shape-only `durationSchema`
      // regex (identical pattern to `parseDurationMs`'s own) but fails
      // `parseDurationMs`'s semantic "must resolve to a positive number of
      // milliseconds" check -- so this reaches `claim()` via a genuinely
      // valid config file, not a schema rejection.
      await writeRepoConfigFile(board.root, "config.yml", "claims:\n  lease: 0h\n");
      await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-finding-d2", "Finding D2")]);
      await expectCode(
        claim({ board, ticket: "ck-finding-d2", actor: actorId("actor-finding-d2"), now: NOW }),
        ClaimErrorCodes.INVALID_LEASE_DURATION,
      );
    });
  });
});

// ============================================================================
// Required test 3: the displaced lease's ids are discarded on --force/
// takeover, not just this file's earlier `--force` behavioral tests.
// ============================================================================

test("required test 3: --force/takeover discards every id the displaced lease had accumulated", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [fixtureTicket("ck-takeover-discard", "Takeover discard")]);
    const originalHolder = actorId("actor-takeover-discard-original");
    const forcer = actorId("actor-takeover-discard-forcer");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    const original = await claim({ board, ticket: "ck-takeover-discard", actor: originalHolder, now: NOW });
    const renewed = await renew({ board, ticket: "ck-takeover-discard", actor: originalHolder, now: NOW + 10 * 60_000 });

    for (const id of [original.eventId, renewed.eventId]) {
      expect(typeof (await firstSeen(boardKey, id))).toBe("number");
    }

    const takeover = await claim({ board, ticket: "ck-takeover-discard", actor: forcer, now: NOW + 20 * 60_000, force: true });
    expect(takeover.kind).toBe("takeover");

    for (const id of [original.eventId, renewed.eventId]) {
      expect(await firstSeen(boardKey, id)).toBeNull();
    }
    // The takeover's OWN new event id is observed, never discarded -- it is
    // the live anchor now, not part of the ended run.
    expect(await firstSeen(boardKey, takeover.eventId)).not.toBeNull();
  });
});
