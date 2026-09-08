import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFixtureTickets } from "../../../test-utils/src/fixtureTickets";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { buildBoardRef } from "../../src/board/ref";
import { claim, release, renew } from "../../src/claims/index";
import { releaseCore, type ReleaseHooks } from "../../src/claims/claim";
import { ErrorCodes, type CanKanError, isCanKanError } from "../../src/errors";
import { parseDurationMs } from "../../src/claims/duration";
import { hermeticEnv } from "../config/testHelpers";
import {
  append,
  boardKeyFor,
  firstSeen,
  observe,
  read,
  type EventCandidate,
  type EventId,
} from "../../src/events/index";
import { createGitAdapter } from "../../src/git/index";
import type { ActorId, BoardRef } from "../../src/types";

// ============================================================================
// House rig — same pattern as `claim.test.ts`'s own header comment.
// ============================================================================

const NOW = Date.parse("2026-09-15T10:00:00Z");
const LEASE_TTL_MS = parseDurationMs("2h"); // the board's default `claims.lease`

const repos: TempRepo[] = [];
async function tempRepo(
  options: Parameters<typeof makeTempRepo>[0] = {},
): Promise<TempRepo> {
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

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<CanKanError> {
  try {
    await promise;
  } catch (error) {
    if (!isCanKanError(error)) {
      throw new Error(`expected a CanKanError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(
    `expected rejection with code ${code}, but the promise resolved`,
  );
}

async function withTestBoard(
  fn: (ctx: { board: BoardRef; repo: TempRepo }) => Promise<void>,
  repoOptions: Parameters<typeof makeTempRepo>[0] = {},
): Promise<void> {
  await withEnv(undefined, async () => {
    const repo = await tempRepo(repoOptions);
    const board = await buildBoardRef({
      kind: "repo",
      name: "test-board",
      root: repo.dir,
      env: hermeticEnv(),
    });
    await mkdir(board.ticketsDir, { recursive: true });
    await fn({ board, repo });
  });
}

/** Same as `withTestBoard`, but also builds a second `BoardRef` rooted at `repo.worktreeDirs[0]` — see `claim.test.ts`'s own doc comment for the sharing caveat. */
async function withTwoWorktreeBoards(
  fn: (ctx: {
    board: BoardRef;
    board2: BoardRef;
    repo: TempRepo;
  }) => Promise<void>,
): Promise<void> {
  await withEnv(undefined, async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const secondaryDir = repo.worktreeDirs[0];
    if (secondaryDir === undefined) throw new Error("expected a worktree");
    const board = await buildBoardRef({
      kind: "repo",
      name: "primary",
      root: repo.dir,
      env: hermeticEnv(),
    });
    const board2 = await buildBoardRef({
      kind: "repo",
      name: "secondary",
      root: secondaryDir,
      env: hermeticEnv(),
    });
    await mkdir(board.ticketsDir, { recursive: true });
    await mkdir(board2.ticketsDir, { recursive: true });
    await fn({ board, board2, repo });
  });
}

function fixtureTicket(
  id: string,
  title: string,
): { id: string; title: string; status: string; body: string } {
  return { id, title, status: "To Do", body: `Body for ${title}.` };
}

function actorId(id: string): ActorId {
  return id as ActorId;
}

/** A well-formed, schema-valid cross-actor `renew` candidate, appended directly (bypassing `renew()`) to plant an event this module never decided to write itself. */
function renewCandidate(
  ticket: string,
  actor: string,
  now: number,
): EventCandidate {
  return {
    event: "renew",
    ts: new Date(now).toISOString(),
    actor,
    ticket,
    lease_until: new Date(now + LEASE_TTL_MS).toISOString(),
  } as unknown as EventCandidate;
}

// ============================================================================
// Required test 1 (headline): every id a lease accumulated is discarded on
// release — not just the most recent one.
// ============================================================================

test("release discards every id the lease ever accumulated (claim + 3 renews), not just the most recent", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-rel-all", "All ids"),
    ]);
    const actor = actorId("actor-rel-all");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    const claimed = await claim({
      board,
      ticket: "ck-rel-all",
      actor,
      now: NOW,
    });
    const renew1 = await renew({
      board,
      ticket: "ck-rel-all",
      actor,
      now: NOW + 10 * 60_000,
    });
    const renew2 = await renew({
      board,
      ticket: "ck-rel-all",
      actor,
      now: NOW + 20 * 60_000,
    });
    const renew3 = await renew({
      board,
      ticket: "ck-rel-all",
      actor,
      now: NOW + 30 * 60_000,
    });

    const ids: EventId[] = [
      claimed.eventId,
      renew1.eventId,
      renew2.eventId,
      renew3.eventId,
    ];
    for (const id of ids) {
      expect(typeof (await firstSeen(boardKey, id))).toBe("number");
    }

    await release({
      board,
      ticket: "ck-rel-all",
      actor,
      now: NOW + 40 * 60_000,
    });

    for (const id of ids) {
      expect(await firstSeen(boardKey, id)).toBeNull();
    }
  });
}, 15_000);

// ============================================================================
// Required test 4: a non-anchoring renew's id is still discarded
// ============================================================================

test("a cross-actor renew that does not become the anchor is still discarded on release", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-rel-cross", "Cross actor"),
    ]);
    const holder = actorId("actor-rel-cross-holder");
    const interloper = actorId("actor-rel-cross-interloper");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    const claimed = await claim({
      board,
      ticket: "ck-rel-cross",
      actor: holder,
      now: NOW,
    });

    // Plant a cross-actor `renew` directly in the log — never anchoring
    // (Ruling M2, `state/fold.ts`): a `renew` against a live anchor held by
    // a DIFFERENT actor neither extends nor reassigns it.
    const plantedNow = NOW + 5 * 60_000;
    await append(
      adapter,
      board.coordinationRef,
      renewCandidate("ck-rel-cross", interloper, plantedNow),
      { now: plantedNow },
    );
    const events = await read(adapter, board.coordinationRef, {
      now: plantedNow,
    });
    const plantedRecord = events.find(
      (r) => r.event.event === "renew" && r.event.actor === interloper,
    );
    if (plantedRecord === undefined)
      throw new Error("expected the planted renew to be in the log");
    const plantedId = plantedRecord.event.id;

    // Confirm the fold did NOT treat the plant as the anchor: a competing
    // claim still names `holder`, never `interloper`.
    const rejection = await expectCode(
      claim({
        board,
        ticket: "ck-rel-cross",
        actor: actorId("actor-rel-cross-third"),
        now: plantedNow,
      }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(rejection.details?.holder).toBe(holder);

    // `firstSeen` for the planted id only ever returns a number once
    // *something* has folded it (`observeAndFold` is what calls
    // `observe()`) — the rejection-path `claim()` attempt just above did
    // exactly that internally, so this assertion is not testing "was it
    // ever observed" (trivially yes, or the interloper's renew could never
    // have joined the run at all) — it is testing that `release()`'s own
    // discard walk, described next, still reaches an id the fold never
    // treated as the anchor.
    await release({
      board,
      ticket: "ck-rel-cross",
      actor: holder,
      now: plantedNow + 60_000,
    });

    expect(await firstSeen(boardKey, claimed.eventId)).toBeNull();
    expect(await firstSeen(boardKey, plantedId)).toBeNull();
  });
});

// ============================================================================
// Required test 5: a previous, already-terminated lease's ids are not
// re-walked by a later, unrelated release.
// ============================================================================

test("a previous, already-terminated lease's ids are not re-walked by a later release", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-rel-boundary", "Boundary"),
    ]);
    const actor = actorId("actor-rel-boundary");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    // First run: claim, then release. Its id is discarded.
    const firstClaim = await claim({
      board,
      ticket: "ck-rel-boundary",
      actor,
      now: NOW,
    });
    await release({
      board,
      ticket: "ck-rel-boundary",
      actor,
      now: NOW + 10 * 60_000,
    });
    expect(await firstSeen(boardKey, firstClaim.eventId)).toBeNull();

    // Plant a FRESH record for the first run's id, by hand — simulating
    // "some other reader observed it again" (or this reader itself, via an
    // unrelated fold that happens to still have it in its read window; see
    // this file's header note in the plan for why `observeAndFold` re-
    // observes every claim/takeover/renew in-window regardless of run
    // boundary). This gives the test an oracle: over-discarding is
    // idempotent, so "assert the second release touched only the second
    // run" has none without a planted, observable value to check against.
    const plantedAt = NOW + 20 * 60_000;
    await observe(boardKey, firstClaim.eventId, { now: plantedAt });
    expect(await firstSeen(boardKey, firstClaim.eventId)).toBe(plantedAt);

    // Second run: claim again, then release again.
    const secondClaim = await claim({
      board,
      ticket: "ck-rel-boundary",
      actor,
      now: NOW + 30 * 60_000,
    });
    await release({
      board,
      ticket: "ck-rel-boundary",
      actor,
      now: NOW + 40 * 60_000,
    });

    // The first run's planted record survives; only the second run's id was
    // discarded.
    expect(await firstSeen(boardKey, firstClaim.eventId)).toBe(plantedAt);
    expect(await firstSeen(boardKey, secondClaim.eventId)).toBeNull();
  });
});

// ============================================================================
// Required test 6: release by a non-holder is rejected
// ============================================================================

describe("release — rejection paths", () => {
  test("no lease at all -> CLAIM_REJECTED / not-held, no event appended", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [
        fixtureTicket("ck-rel-noheld", "No lease"),
      ]);
      const rejection = await expectCode(
        release({
          board,
          ticket: "ck-rel-noheld",
          actor: actorId("actor-x"),
          now: NOW,
        }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("not-held");
      const adapter = await createGitAdapter(board.root);
      expect(await adapter.readRef(board.coordinationRef)).toBeNull();
    });
  });

  test("release by a non-holder -> CLAIM_REJECTED / not-holder (distinct from not-held), no event appended", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [
        fixtureTicket("ck-rel-nonholder", "Non-holder"),
      ]);
      const holder = actorId("actor-rel-holder");
      await claim({
        board,
        ticket: "ck-rel-nonholder",
        actor: holder,
        now: NOW,
      });

      const rejection = await expectCode(
        release({
          board,
          ticket: "ck-rel-nonholder",
          actor: actorId("actor-rel-notholder"),
          now: NOW,
        }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("not-holder");
      expect(rejection.details?.holder).toBe(holder);

      const adapter = await createGitAdapter(board.root);
      const records = await read(adapter, board.coordinationRef, { now: NOW });
      expect(records.filter((r) => r.event.event === "release").length).toBe(0);

      // A fresh fold still shows `holder` as the live anchor.
      const stillHeld = await expectCode(
        claim({
          board,
          ticket: "ck-rel-nonholder",
          actor: actorId("actor-rel-third"),
          now: NOW,
        }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(stillHeld.details?.holder).toBe(holder);
    });
  });

  test("release on an expired lease -> CLAIM_REJECTED / lease-expired, no event appended", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFixtureTickets(board.ticketsDir, [
        fixtureTicket("ck-rel-expired", "Expired"),
      ]);
      const actor = actorId("actor-rel-expired");
      await claim({ board, ticket: "ck-rel-expired", actor, now: NOW });

      const pastExpiry = NOW + LEASE_TTL_MS + 1;
      const rejection = await expectCode(
        release({ board, ticket: "ck-rel-expired", actor, now: pastExpiry }),
        ErrorCodes.CLAIM_REJECTED,
      );
      expect(rejection.details?.reason).toBe("lease-expired");

      const adapter = await createGitAdapter(board.root);
      const records = await read(adapter, board.coordinationRef, {
        now: pastExpiry,
      });
      expect(records.filter((r) => r.event.event === "release").length).toBe(0);
    });
  });
});

// ============================================================================
// Required test 8: the release-vs-competitor CAS race
// ============================================================================

test("the release-vs-competitor CAS race: A's release loses its CAS to B's expire+reclaim and rejects, never destroying B's lease", async () => {
  await withTwoWorktreeBoards(async ({ board, board2 }) => {
    const ticket = fixtureTicket("ck-rel-race", "Release race");
    await writeFixtureTickets(board.ticketsDir, [ticket]);
    await writeFixtureTickets(board2.ticketsDir, [ticket]);

    const actorA = actorId("actor-rel-race-a");
    const actorB = actorId("actor-rel-race-b");
    await claim({ board, ticket: "ck-rel-race", actor: actorA, now: NOW });

    // Two DIFFERENT `now` values are required (this file's own required-
    // tests brief, item 8): A's own fold must see its lease as still LIVE
    // (so `release` gets past the `lease-expired` check and reaches the
    // append where the hook fires), while B's reclaim must see the SAME
    // lease as EXPIRED (so B may expire and reclaim it). A single shared
    // `now` would make both folds compute the same `expiresAtMs`,
    // rejecting A with `lease-expired` on attempt 1 before the hook ever
    // runs.
    const aReleaseNow = NOW + LEASE_TTL_MS - 1;
    const bReclaimNow = NOW + LEASE_TTL_MS + 1;

    const beforeAppendAttempts: number[] = [];
    const hooks: ReleaseHooks = {
      beforeAppend: async (attemptNumber) => {
        beforeAppendAttempts.push(attemptNumber);
        if (beforeAppendAttempts.length === 1) {
          // A full, independent reclaim from the SECOND worktree, landing
          // while A's own release decision is still in flight.
          const reclaimed = await claim({
            board: board2,
            ticket: "ck-rel-race",
            actor: actorB,
            now: bReclaimNow,
          });
          // An uncontested reclaim spends one attempt on the `expire` and
          // one on the `claim` (`attempts` is >= 2 by design) — not a
          // signal that a race happened here specifically.
          expect(reclaimed.kind).toBe("claim");
        }
      },
    };

    const rejection = await expectCode(
      releaseCore(
        { board, ticket: "ck-rel-race", actor: actorA, now: aReleaseNow },
        hooks,
      ),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(beforeAppendAttempts).toEqual([1]);
    expect(rejection.details?.reason).toBe("not-holder");
    expect(rejection.details?.holder).toBe(actorB);

    // B's claim is still the live anchor afterwards.
    const stillHeldByB = await expectCode(
      claim({
        board,
        ticket: "ck-rel-race",
        actor: actorId("actor-rel-race-third"),
        now: bReclaimNow,
      }),
      ErrorCodes.CLAIM_REJECTED,
    );
    expect(stillHeldByB.details?.holder).toBe(actorB);
  });
});

// ============================================================================
// The test-only `beforeAppend` seam is exported, even if not exercised here
// ============================================================================

test("releaseCore accepts a hooks object with no-op default behavior (mirrors claimCore)", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-rel-hook", "Hook"),
    ]);
    const actor = actorId("actor-rel-hook");
    await claim({ board, ticket: "ck-rel-hook", actor, now: NOW });

    const attempts: number[] = [];
    const hooks: ReleaseHooks = {
      beforeAppend: async (attemptNumber) => {
        attempts.push(attemptNumber);
      },
    };
    const result = await releaseCore(
      { board, ticket: "ck-rel-hook", actor, now: NOW + 1000 },
      hooks,
    );
    expect(attempts).toEqual([1]);
    expect(result.attempts).toBe(1);
  });
});

// ============================================================================
// KNOWN GAP (documenting test, not a desired property): discard is not
// durable in steady state.
//
// `state/fold.ts`'s `observeAndFold` builds its `idsToObserve` set from
// EVERY claim/takeover/renew in the read window whose ticket joins a known
// `StoredTicket` (Rulings I3/D1 -- those rulings exist only to keep
// orphaned and duplicate-id events out). There is no run-boundary filter and
// no liveness filter: a lease-bearing event that belongs to an already-
// terminated run is re-observed exactly the same as one that belongs to the
// current live run. So the very next fold over the same window -- for ANY
// ticket, not even necessarily the one whose lease was just released --
// recreates an already-discarded record with a fresh `firstSeen`.
//
// `computeDiscardRun` (this module) always resets its accumulator at the
// last `release`/`close`/`expire` it sees, so a resurrected record now sits
// BEFORE that terminator in every future walk -- no discard call this
// module ever makes again can reach it. It becomes a permanent orphan.
//
// **This is not a mutual-exclusion defect**: `resolveLeaseAnchor`
// (`state/fold.ts`) clears the anchor on the `release`/`close`/`expire`
// regardless of `firstSeen`, so a resurrected record does not resurrect the
// LEASE -- nothing can be double-claimed because of this.
//
// **It does defeat the bound ADR 0001 failure mode 7 requires `discard()`
// to provide**: "the store is otherwise unbounded, growing by one record
// per lease-bearing event id, and a peer with push access drives that
// growth" -- through no fault of this module's own discard walk, which does
// exactly what the brief specifies. The fix belongs in
// `state/fold.ts`'s `observeAndFold`: it would need to observe only ids
// inside each ticket's CURRENTLY-OPEN run (the same reset-on-terminator walk
// `computeDiscardRun` already performs), not every lease-bearing event in
// the window unconditionally. `state/` is not this lane's folder --
// deliberately not attempted here; reported to the controller instead.
//
// This test PINS the current, known-defective behaviour as a canary. When
// `state/fold.ts` is fixed, this test's final assertion flips from
// `.not.toBeNull()` to what would then be `null`, and it FAILS LOUDLY --
// that failure is the point: it tells whoever lands the fix exactly what
// changed and why this assertion existed.
// ============================================================================

test("KNOWN GAP: a discarded observation is resurrected by the next fold (fix belongs to state/fold.ts, see report)", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-gap-released", "Released"),
      fixtureTicket("ck-gap-other", "Unrelated ticket"),
    ]);
    const actor = actorId("actor-gap-released");
    const adapter = await createGitAdapter(board.root);
    const boardKey = await boardKeyFor(adapter);

    const claimed = await claim({
      board,
      ticket: "ck-gap-released",
      actor,
      now: NOW,
    });
    await release({
      board,
      ticket: "ck-gap-released",
      actor,
      now: NOW + 60_000,
    });

    // The discard walk did its job: the id is gone immediately after
    // release, exactly as tests 1/4/5/6 above already prove.
    expect(await firstSeen(boardKey, claimed.eventId)).toBeNull();

    // ONE more fold over the same window -- for a completely UNRELATED
    // ticket, not even "ck-gap-released" itself -- is enough to bring it
    // back, because `observeAndFold` re-observes every lease-bearing event
    // in the window for every known ticket, unconditionally.
    await claim({
      board,
      ticket: "ck-gap-other",
      actor: actorId("actor-gap-other"),
      now: NOW + 120_000,
    });

    // THE DEFECT, PINNED: the discarded id is back, with a fresh
    // `firstSeen`, and is now permanently unreachable by any future discard
    // walk this module could ever run.
    expect(await firstSeen(boardKey, claimed.eventId)).not.toBeNull();
  });
});

// ============================================================================
// Security-review regression: the KNOWN GAP above documents in prose that a
// resurrected record does not extend a LIVE lease ("this is not a mutual-
// exclusion defect"). Nothing tested that claim. This is the discriminating
// oracle for it.
//
// Why an ordinary release-then-reclaim does NOT discriminate: resurrecting a
// record via a ticket claimed AFTER a plain release (as the KNOWN GAP test
// above does) brings back a record whose `firstSeen` is OLDER than the
// current anchor's -- the fold's expiry computation (`foldLease`) would
// compute the same expiry (the anchor's own `firstSeen` plus the TTL)
// whether or not the resurrected record fed expiry, because a smaller
// `firstSeen` can never push a max-of computation past what the anchor
// alone already gives it. Such a test would pass whether or not
// resurrection feeds expiry, which makes it worthless as an oracle for this
// property.
//
// A TAKEOVER changes that: the displaced actor's own record resurrects only
// once some LATER claim/takeover/renew is folded (same mechanism as the
// KNOWN GAP), and that resurrection can be arranged to land AFTER the new
// anchor's own `firstSeen` -- newer, not older. If any resurrected record
// fed expiry, `expiresAt` would be computed from the NEWER of the two
// firstSeens, pushing it past what the anchor alone would give, and a
// reclaim timed to land just past the anchor's own TTL (but still within
// what the newer, resurrected firstSeen would imply) would be wrongly
// rejected. This is the oracle that can actually tell the two apart.
// ============================================================================

test("a resurrected record NEWER than the current anchor does not extend the lease (discriminating oracle for the KNOWN GAP canary above)", async () => {
  await withTestBoard(async ({ board }) => {
    await writeFixtureTickets(board.ticketsDir, [
      fixtureTicket("ck-probe2", "Takeover then resurrection"),
      fixtureTicket("ck-probe2-other", "Unrelated ticket"),
    ]);
    const original = actorId("actor-probe2-original");
    const forcer = actorId("actor-probe2-forcer");
    const boardKey = await boardKeyFor(await createGitAdapter(board.root));

    const a1 = await claim({
      board,
      ticket: "ck-probe2",
      actor: original,
      now: NOW,
    });
    const b1 = await claim({
      board,
      ticket: "ck-probe2",
      actor: forcer,
      now: NOW + 5 * 60_000,
      force: true,
    });
    expect(b1.kind).toBe("takeover");

    // The takeover's own discard walk already removed the displaced claim.
    expect(await firstSeen(boardKey, a1.eventId)).toBeNull();

    // ONE fold over an unrelated ticket resurrects it -- at THIS fold's
    // `now`, which is LATER than the anchor's own `firstSeen` (NOW + 5m).
    await claim({
      board,
      ticket: "ck-probe2-other",
      actor: actorId("actor-probe2-other"),
      now: NOW + 6 * 60_000,
    });

    // Premise check: `a1` really did resurrect, and strictly NEWER than
    // `b1`'s own anchor `firstSeen` -- without both of these, the reclaim
    // assertion below proves nothing about resurrection feeding expiry.
    // (These two lines are expected to start failing alongside the KNOWN GAP
    // canary above if `state/fold.ts` is ever fixed to stop resurrecting
    // terminated-run records -- that is the point: this oracle goes honestly
    // vacuous rather than silently passing for the wrong reason.)
    const a1Resurrected = await firstSeen(boardKey, a1.eventId);
    const b1Anchored = await firstSeen(boardKey, b1.eventId);
    expect(a1Resurrected).not.toBeNull();
    expect(a1Resurrected as number).toBeGreaterThan(b1Anchored as number);

    // A reclaim timed to land just past the ANCHOR's own TTL (b1's
    // `firstSeen` + LEASE_TTL_MS + 1ms) must still succeed. If the
    // resurrected, newer record fed expiry, `expiresAt` would be
    // `(NOW + 6m) + LEASE_TTL_MS`, and this reclaim -- which lands before
    // that -- would be wrongly rejected as `already-held`.
    const reclaim = await claim({
      board,
      ticket: "ck-probe2",
      actor: actorId("actor-probe2-reclaimer"),
      now: NOW + 5 * 60_000 + LEASE_TTL_MS + 1,
    });
    expect(reclaim.kind).toBe("claim");
  });
});
