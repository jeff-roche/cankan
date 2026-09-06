/**
 * M2.9 — the core smoke test (issue #32). Exercises the full stack this
 * dispatch covers, end to end, against a real temp git repo:
 *
 *   resolveBoard -> loadBoardConfig -> createGitAdapter -> openTicketStore
 *   -> initRef/append/read -> observeAndFold -> byStatus/claimedBy
 *
 * Deliberately uses `observeAndFold`, never the pure `foldState`:
 * `observeAndFold` is what actually performs M2.7's contract 2 (calling
 * `observe()` for every `claim`/`takeover`/`renew` read off the log) — the
 * wiring most likely to be wrong in real use, and the reason this test
 * exists at all.
 *
 * Every module here is reached through its own folder's public surface
 * (`board/index`, `git/index`, `store/index`, `events/index`,
 * `state/index`) — the same per-module import style `test/store/ticketStore.test.ts`
 * and `test/state/fold.test.ts` already use, not the frozen root barrel.
 *
 * **Integration finding F1 (see the report):** `loadBoardConfig`'s
 * `claims.lease` is a duration *string* (`"2h"`, `"15m"` —
 * `config/schema.ts:452`); `observeAndFold`'s `leaseTtlMs` is a number of
 * milliseconds. No shared string->ms converter exists anywhere in
 * `packages/core/src` or `packages/cli` (confirmed by grep for
 * `parseDuration|durationToMs|toMillis|msFrom`), so this test carries its
 * own tiny, local one rather than reaching into `src/` to add one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadBoardConfig, resolveBoard } from "../src/board/index";
import { append, boardKeyFor, firstSeen, initRef, read } from "../src/events/index";
import { createGitAdapter } from "../src/git/index";
import { byStatus, claimedBy, observeAndFold } from "../src/state/index";
import { openTicketStore } from "../src/store/index";
import type { ActorId, TicketId } from "../src/types";
import { hermeticEnv } from "./config/testHelpers";
import { makeTempRepo } from "../../test-utils/src/tempRepo";
import { withEnv } from "../../test-utils/src/withEnv";

/** `config/schema.ts`'s own `DURATION_PATTERN` (`/^\d+(ms|s|m|h|d|w)$/`) — see this file's F1 finding. */
const DURATION_MS_PER_UNIT: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function durationToMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(duration);
  if (match === null) {
    throw new Error(`smoke test: "${duration}" is not a duration string config/schema.ts would accept`);
  }
  const amount = match[1] as string;
  const unit = match[2] as string;
  return Number(amount) * DURATION_MS_PER_UNIT[unit];
}

/** `<id> - <slug>.md` — `ticket/filename.ts`'s `FILENAME_RE` shape, built here without importing `ticket/` (see the report). */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function ticketFilename(id: string, title: string): string {
  return `${id} - ${slugify(title)}.md`;
}

function ticketRaw(id: string, title: string, status: string): string {
  return `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n---\n\nBody for ${title}.\n`;
}

const TICKET_A = { id: "ck-smoke001", title: "Smoke ticket one", status: "To Do" };
const TICKET_B = { id: "ck-smoke002", title: "Smoke ticket two", status: "To Do" };
const TICKET_C = { id: "ck-smoke003", title: "Smoke ticket three", status: "To Do" };

test("M2.9 smoke: board resolution -> config -> ticket store -> event log -> fold -> queries", async () => {
  expect.hasAssertions();

  const repo = await makeTempRepo();
  try {
    // A non-default `claims.lease` (never "2h") — assertion 7: the TTL the
    // fold uses below must demonstrably come from this file, not a
    // hardcoded constant.
    await mkdir(join(repo.dir, ".cankan"), { recursive: true });
    await writeFile(join(repo.dir, ".cankan", "config.yml"), 'claims:\n  lease: "15m"\n', "utf8");

    await withEnv(undefined, async () => {
      // ---- board resolution + config -----------------------------------
      const board = await resolveBoard({ cwd: repo.dir, env: hermeticEnv() });
      // Assertion 1: the #97 failure mode for this file — an un-inited temp
      // repo silently falling through to the personal board.
      expect(board.kind).toBe("repo");
      expect(board.root).toBe(repo.dir);

      const configResult = await loadBoardConfig(board, { env: hermeticEnv() });
      expect(configResult.value.claims.lease).toBe("15m");
      const leaseTtlMs = durationToMs(configResult.value.claims.lease);
      expect(leaseTtlMs).toBe(15 * 60 * 1000);

      // ---- git adapter + ticket store -----------------------------------
      const adapter = await createGitAdapter(board.root);
      const gitCommonDir = await adapter.gitCommonDir();
      const gitDirs = [gitCommonDir]; // openTicketStore refuses an empty gitDirs (M2.5 security fix).

      const boardKey = await boardKeyFor(adapter);
      expect(boardKey).toBe(gitCommonDir); // boardKeyFor is documented to be exactly this.

      await mkdir(board.ticketsDir, { recursive: true }); // openTicketStore never creates it (Ruling R4).
      const store = await openTicketStore({ board, gitDirs });

      // Ticket files are written directly to disk here, not built by hand
      // as a `ParsedTicket` literal — see the report for why: `store/index.ts`
      // re-exports the `ParsedTicket` *type* but not `parseTicketFile`
      // itself, so the only way to obtain a genuine (non-hand-rolled)
      // `ParsedTicket` at this dependency level, without importing `ticket/`
      // directly, is to read one back via `list()`.
      for (const t of [TICKET_A, TICKET_B, TICKET_C]) {
        await writeFile(join(board.ticketsDir, ticketFilename(t.id, t.title)), ticketRaw(t.id, t.title, t.status), "utf8");
      }

      const listedBeforeWrite = await store.list();
      // Assertion 2: a ticket that fails to parse is silently dropped from
      // list() — without this check the fold below would pass with n-1
      // tickets and nobody would notice.
      expect(listedBeforeWrite.skipped).toEqual([]);
      // Assertion 3.
      expect(listedBeforeWrite.tickets).toHaveLength(3);
      expect(listedBeforeWrite.tickets.map((t): string => t.id).sort()).toEqual(
        [TICKET_A.id, TICKET_B.id, TICKET_C.id].sort(),
      );

      // Exercise store.write() with a genuine ParsedTicket obtained from
      // list() above: overwrite ticket B in place. This is a real exercise
      // of write()'s "update" branch (findExistingPathsById), not a no-op —
      // if write() ever minted a fresh file instead of finding the existing
      // one, the re-list below would report 4 tickets, not 3.
      const ticketBBeforeWrite = listedBeforeWrite.tickets.find((t) => t.id === TICKET_B.id);
      if (ticketBBeforeWrite === undefined) {
        throw new Error("smoke test setup failed: ticket B not found after the initial list()");
      }
      const writtenTicketB = await store.write(ticketBBeforeWrite.ticket);
      expect(writtenTicketB.id as string).toBe(TICKET_B.id);
      expect(writtenTicketB.path).toBe(ticketBBeforeWrite.path);

      const listed = await store.list();
      expect(listed.skipped).toEqual([]);
      expect(listed.tickets).toHaveLength(3);

      // ---- event log ------------------------------------------------------
      await initRef(adapter, board.coordinationRef);

      // One `now`, per the brief's time discipline — never independent
      // `Date.now()` calls, so a month rollover between them can't make
      // this test flaky.
      const T0 = Date.now();
      const nowIso = new Date(T0).toISOString();
      const claimActor = "agent:smoke-claimant" as ActorId;

      const createAppended = await append(
        adapter,
        board.coordinationRef,
        { ts: nowIso, actor: "agent:smoke" as ActorId, ticket: TICKET_A.id as TicketId, event: "create" },
        { now: T0 },
      );
      const moveAppended = await append(
        adapter,
        board.coordinationRef,
        {
          ts: nowIso,
          actor: "agent:smoke" as ActorId,
          ticket: TICKET_B.id as TicketId,
          event: "move",
          from: "To Do",
          to: "In Progress",
        },
        { now: T0 },
      );
      const claimAppended = await append(
        adapter,
        board.coordinationRef,
        {
          ts: nowIso,
          actor: claimActor,
          ticket: TICKET_C.id as TicketId,
          event: "claim",
          lease_until: new Date(T0 + leaseTtlMs).toISOString(),
        },
        { now: T0 },
      );

      const events = await read(adapter, board.coordinationRef, { now: T0, trailingMonths: 3 });
      // Assertion 4: proves the read window actually covered the appends
      // above (a narrow default `trailingMonths` would silently truncate).
      expect(events).toHaveLength(3);
      const readEventIds = events.map((e) => e.event.id);
      expect(readEventIds).toContain(createAppended.event.id);
      expect(readEventIds).toContain(moveAppended.event.id);
      expect(readEventIds).toContain(claimAppended.event.id);

      // ---- fold #1, at T0 — the fold that performs the observation --------
      const state1 = await observeAndFold(boardKey, listed.tickets, events, { now: T0, leaseTtlMs });
      // Assertion 5.
      expect(state1.tickets).toHaveLength(3);
      // Assertion 6: an orphaned event means a claim never joined its
      // ticket file — without this, the lease assertions below would just
      // be checking undefined === undefined.
      expect(state1.orphanedEvents).toEqual([]);
      expect(state1.duplicateTicketIds).toEqual([]);

      const ticketA1 = state1.tickets.find((t) => t.id === TICKET_A.id);
      const ticketB1 = state1.tickets.find((t) => t.id === TICKET_B.id);
      const ticketC1 = state1.tickets.find((t) => t.id === TICKET_C.id);
      if (ticketA1 === undefined || ticketB1 === undefined || ticketC1 === undefined) {
        throw new Error("smoke test: a fixture ticket is missing from the folded BoardState");
      }

      expect(ticketA1.status).toBe("To Do");
      expect(ticketA1.lease).toBeUndefined();
      // The "queries" half of issue #32: a move event's status wins over
      // the frontmatter status.
      expect(ticketB1.statusFromEvents).toBe("In Progress");
      expect(ticketB1.status).toBe("In Progress");
      expect(ticketB1.lease).toBeUndefined();
      expect(ticketC1.status).toBe("To Do");

      const lease1 = ticketC1.lease;
      if (lease1 === undefined) {
        throw new Error("smoke test: expected a live lease on ticket C after fold #1");
      }
      // Assertion 8 (two-sided TTL, part 1): the claim appears as a lease
      // with the right actor/kind/eventId, not expired at T0.
      expect(lease1.actor).toBe(claimActor);
      expect(lease1.kind).toBe("claim");
      expect(lease1.eventId).toBe(claimAppended.event.id);
      expect(lease1.expired).toBe(false);

      // Assertion 9: the only direct proof contract 2's observation path
      // actually ran.
      const seenAt = await firstSeen(boardKey, claimAppended.event.id);
      expect(seenAt).not.toBeNull();
      expect(lease1.firstSeenMs).toBeDefined();
      expect(seenAt).toBe(lease1.firstSeenMs ?? null);

      // Assertion 10 (byStatus half).
      const byStatus1 = byStatus(state1);
      expect((byStatus1.get("In Progress") ?? []).map((t): string => t.id)).toEqual([TICKET_B.id]);
      expect(
        (byStatus1.get("To Do") ?? []).map((t): string => t.id).sort(),
      ).toEqual([TICKET_A.id, TICKET_C.id].sort());

      // Assertion 10 (claimedBy half, at T0): the live lease's actor holds ticket C.
      expect((claimedBy(state1).get(claimActor) ?? []).map((t): string => t.id)).toEqual([TICKET_C.id]);

      // ---- fold #2, at T0 + ttl - 1: still live, firstSeenMs unmoved -------
      const state2 = await observeAndFold(boardKey, listed.tickets, events, { now: T0 + leaseTtlMs - 1, leaseTtlMs });
      const ticketC2 = state2.tickets.find((t) => t.id === TICKET_C.id);
      const lease2 = ticketC2?.lease;
      if (lease2 === undefined) {
        throw new Error("smoke test: expected a live lease on ticket C just inside the TTL");
      }
      expect(lease2.expired).toBe(false);
      // observe() is first-write-wins: a later fold's `now` never moves the
      // recorded firstSeenMs.
      expect(lease2.firstSeenMs).toBe(lease1.firstSeenMs);
      expect((claimedBy(state2).get(claimActor) ?? []).map((t): string => t.id)).toEqual([TICKET_C.id]);

      // ---- fold #3, at T0 + ttl + 1: expired, firstSeenMs still unmoved ----
      const state3 = await observeAndFold(boardKey, listed.tickets, events, { now: T0 + leaseTtlMs + 1, leaseTtlMs });
      const ticketC3 = state3.tickets.find((t) => t.id === TICKET_C.id);
      const lease3 = ticketC3?.lease;
      if (lease3 === undefined) {
        throw new Error("smoke test: expected a (now-expired) lease record on ticket C just outside the TTL");
      }
      // Assertion 8 (two-sided TTL, part 2).
      expect(lease3.expired).toBe(true);
      expect(lease3.firstSeenMs).toBe(lease1.firstSeenMs);
      // claimedBy excludes an expired lease.
      expect(claimedBy(state3).has(claimActor)).toBe(false);
    });
  } finally {
    await repo.cleanup();
  }
});
