import { afterEach, describe, expect, test } from "bun:test";
import { decodeTime, monotonicFactory } from "ulid";
import { isCanKanError } from "../../src/errors";
import { createGitAdapter, GitErrorCodes, type GitAdapter, type RefSha } from "../../src/git/index";
import { EventErrorCodes } from "../../src/events/errors";
import {
  append,
  appendCore,
  type AppendHooks,
  type EventCandidate,
  read,
} from "../../src/events/log";
import type { EventId } from "../../src/events/schema";
// See `git.test.ts`'s own comment: `@jeff-roche/cankan-test-utils` is not a
// declared dependency of `packages/core/package.json`, so a relative import
// to the source file is used instead of the package specifier.
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";

const COORD_REF = "refs/cankan/coordination";
const REAL_ULID = "01M1RRC3FBMZYZS4SNMYZHJV6R";

/** Fast, deterministic retry policy — real backoff would otherwise slow every test that forces a rejection. */
const FAST_RETRY = { backoffMs: () => 0, sleep: async () => {} };

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

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!isCanKanError(error)) {
      throw new Error(`expected a CanKanError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but the promise resolved`);
}

/** A minimal, valid `claim` candidate — cast at the boundary like every other branded-id caller (`TicketId`/`ActorId` carry no runtime constructor; see `types.ts`). */
function claim(ticket: string, overrides: Record<string, unknown> = {}): EventCandidate {
  return {
    event: "claim",
    ts: "2026-09-04T10:12:00Z",
    actor: "claude-code:alice/wt-auth",
    ticket,
    lease_until: "2026-09-04T12:12:00Z",
    ...overrides,
  } as unknown as EventCandidate;
}

/** A minimal, valid `release` candidate. */
function release(ticket: string, overrides: Record<string, unknown> = {}): EventCandidate {
  return {
    event: "release",
    ts: "2026-09-04T10:12:00Z",
    actor: "claude-code:alice/wt-auth",
    ticket,
    ...overrides,
  } as unknown as EventCandidate;
}

const SEPT_15_MS = Date.parse("2026-09-15T10:00:00Z");

// ============================================================================
// PLAN.md's floor test — real concurrency, two different tickets
// ============================================================================

describe("append — two worktrees interleave without loss", () => {
  test("two different events appended concurrently from two worktrees both survive", async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const primary = await createGitAdapter(repo.dir);
    const secondaryDir = repo.worktreeDirs[0];
    if (!secondaryDir) {
      // makeTempRepo({ worktrees: 1 }) below guarantees this.
      throw new Error("expected a worktree");
    }
    const secondary = await createGitAdapter(secondaryDir);

    // Seed the ref so both writers race against an existing (not
    // just-created) state — the interesting case ADR 0001:784-794 names is
    // two *different* appends colliding, not two racers both creating the
    // ref from nothing.
    await append(primary, COORD_REF, claim("ck-seed"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const [a, b] = await Promise.all([
      append(primary, COORD_REF, claim("ck-a"), { now: SEPT_15_MS, casRetry: FAST_RETRY }),
      append(secondary, COORD_REF, claim("ck-b"), { now: SEPT_15_MS, casRetry: FAST_RETRY }),
    ]);

    expect(a.event.ticket as string).toBe("ck-a");
    expect(b.event.ticket as string).toBe("ck-b");

    const records = await read(primary, COORD_REF, { now: SEPT_15_MS });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    expect(tickets).toEqual(["ck-a", "ck-b", "ck-seed"]);
  }, 20_000);
});

// ============================================================================
// read() — ULID order (PLAN.md's done-when)
// ============================================================================

describe("read — ULID order", () => {
  test("returns events sorted by id regardless of on-disk line order", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Two real ULIDs, written to the file in *reverse* ULID order — proves
    // the sort, rather than coincidentally matching append order, is what
    // produces the result.
    const higher = "01M1RRC3FBMZYZS4SNMYZHJV6S";
    const lower = "01M1RRC3FBMZYZS4SNMYZHJV6R";
    const lineHigher = JSON.stringify({ ...release("ck-1"), id: higher });
    const lineLower = JSON.stringify({ ...release("ck-2"), id: lower });
    const content = `${lineHigher}\n${lineLower}\n`;

    const applied = await adapter.commitTreeToRef(COORD_REF, {
      parent: null,
      message: "seed out of order",
      files: [{ path: "events/2026-09.jsonl", content }],
    });
    if (applied.outcome !== "applied") throw new Error("setup failed");

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records.map((r) => r.event.id as string)).toEqual([lower, higher]);
    // The higher id was on line 0 on disk — chain position (`line`) is
    // unaffected by the ULID sort applied to the returned order.
    expect(records.find((r) => r.event.id === higher)?.line).toBe(0);
    expect(records.find((r) => r.event.id === lower)?.line).toBe(1);
  });
});

// ============================================================================
// Month boundary (fm9) — direct, using the injectable clock
// ============================================================================

describe("read — month boundary aggregation (fm9)", () => {
  test("events written either side of a UTC month rollover are both visible from one read()", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const lastSecondOfAugust = Date.parse("2026-08-31T23:59:59Z");
    const firstSecondOfSeptember = Date.parse("2026-09-01T00:00:01Z");

    const augustAppend = await append(
      adapter,
      COORD_REF,
      claim("ck-aug", { ts: "2026-08-31T23:59:59Z", lease_until: "2026-09-01T01:59:59Z" }),
      { now: lastSecondOfAugust, casRetry: FAST_RETRY },
    );
    expect(augustAppend.month).toBe("2026-08");

    const septemberAppend = await append(
      adapter,
      COORD_REF,
      claim("ck-sep", { ts: "2026-09-01T00:00:01Z", lease_until: "2026-09-01T02:00:01Z" }),
      { now: firstSecondOfSeptember, casRetry: FAST_RETRY },
    );
    expect(septemberAppend.month).toBe("2026-09");

    // A reader whose own `now` is also just after the boundary, with the
    // default trailingMonths (2), must see both — this is exactly fm9's
    // "a claim made shortly before a UTC month boundary is still well
    // within its lease when a check made just after the boundary looks
    // only at the new month's file" gap.
    const records = await read(adapter, COORD_REF, { now: firstSecondOfSeptember });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    expect(tickets).toEqual(["ck-aug", "ck-sep"]);

    // And a reader that only aggregates 1 trailing month is blind to
    // August — the regression this default (2) exists to prevent.
    const narrow = await read(adapter, COORD_REF, { now: firstSecondOfSeptember, trailingMonths: 1 });
    expect(narrow.map((r) => r.event.ticket as string)).toEqual(["ck-sep"]);
  });
});

// ============================================================================
// CAS-conflict retry — the seam proves a genuine re-read, not a stale replay
// ============================================================================

describe("append — CAS retry re-reads rather than replaying a stale tree", () => {
  test("a forced rejection on attempt 1 causes attempt 2 to see the interleaved event", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Seed so the ref already exists — the losing-write case under test is
    // the same as the ADR's `claimViaCAS` pattern generalized: a rejection
    // on a non-null parent, not the create-the-ref race `ref.test.ts` covers.
    await append(adapter, COORD_REF, claim("ck-seed"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const attemptNumbersSeen: number[] = [];
    const hooks: AppendHooks = {
      beforeCas: async (attemptNumber) => {
        attemptNumbersSeen.push(attemptNumber);
        if (attemptNumbersSeen.length === 1) {
          // Interleave a *different* writer's append between this attempt's
          // read and its CAS — using the real, public `append` against the
          // same ref, so the interleaved event is validated and committed
          // exactly the way a genuine second worktree would do it.
          await append(adapter, COORD_REF, claim("ck-interloper"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
        }
      },
    };

    // A small `maxAttempts` — if the re-read were ever hoisted out of the
    // loop, every attempt would rebuild the exact same (now-stale) commit
    // and keep colliding until `GIT_CAS_CONTENTION_EXCEEDED`, which this
    // test would see as a thrown error instead of a resolved value.
    const result = await appendCore(
      adapter,
      COORD_REF,
      claim("ck-mine"),
      { now: SEPT_15_MS, casRetry: { ...FAST_RETRY, maxAttempts: 5 } },
      hooks,
    );

    expect(result.event.ticket as string).toBe("ck-mine");
    // Proves a *second* attempt genuinely happened — attempt 1 was rejected,
    // not silently accepted.
    expect(attemptNumbersSeen).toEqual([1, 2]);

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    // Neither the interloper nor this call's own event was lost.
    expect(tickets).toEqual(["ck-interloper", "ck-mine", "ck-seed"]);
  });
});

// ============================================================================
// Malformed / hostile lines — written through a real commit
// ============================================================================

async function seedMonthFile(adapter: GitAdapter, content: string): Promise<void> {
  const applied = await adapter.commitTreeToRef(COORD_REF, {
    parent: null,
    message: "seed hostile content",
    files: [{ path: "events/2026-09.jsonl", content }],
  });
  if (applied.outcome !== "applied") throw new Error("setup failed");
}

describe("read — malformed and hostile lines fail closed", () => {
  test("a truncated/partially-written line is rejected with a diagnosable error", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedMonthFile(adapter, '{"ts":"2026-09-04T10:12:00Z","id":"01M1RRC3FBMZYZS4SNMYZHJV6R","actor":"a","ticket":"ck-1","event":"cla');

    try {
      await read(adapter, COORD_REF, { now: SEPT_15_MS });
      throw new Error("expected read() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_LINE_INVALID);
      expect(error.details?.month).toBe("2026-09");
      expect(error.details?.line).toBe(0);
      expect(error.details?.reason).toBe("invalid-json");
    }
  });

  test("a valid-JSON line failing schema validation is rejected", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // `claim` without the required `lease_until`.
    await seedMonthFile(
      adapter,
      `${JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: REAL_ULID, actor: "a", ticket: "ck-1", event: "claim" })}\n`,
    );

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_LINE_INVALID);
  });

  test("a non-ULID event id is rejected", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedMonthFile(
      adapter,
      `${JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: "not-a-ulid", actor: "a", ticket: "ck-1", event: "release" })}\n`,
    );

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_LINE_INVALID);
  });

  test("a duplicate event id whose content differs is rejected", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const first = JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: REAL_ULID, actor: "alice", ticket: "ck-1", event: "release" });
    const second = JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: REAL_ULID, actor: "bob", ticket: "ck-1", event: "release" });
    await seedMonthFile(adapter, `${first}\n${second}\n`);

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_DUPLICATE_ID_CONFLICT);
  });

  test("a byte-identical duplicate event id is accepted as one event", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const line = JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: REAL_ULID, actor: "alice", ticket: "ck-1", event: "release" });
    await seedMonthFile(adapter, `${line}\n${line}\n`);

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records).toHaveLength(1);
    expect(records[0]?.event.id as string | undefined).toBe(REAL_ULID);
  });
});

// ============================================================================
// Obligation A — the byte cap runs before parseEvent (and JSON.parse)
// ============================================================================

describe("read — obligation A: per-line byte cap", () => {
  test("an over-long line is rejected before it is ever handed to parseEvent", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Deliberately not valid JSON. If the size guard ran *after* attempting
    // `JSON.parse`, this would surface as `EVENT_LOG_LINE_INVALID` with
    // reason "invalid-json" instead — getting `EVENT_LOG_LINE_TOO_LARGE`
    // specifically is what proves the size check short-circuited first.
    const huge = "x".repeat(2_000_000);
    await seedMonthFile(adapter, `${huge}\n`);

    try {
      await read(adapter, COORD_REF, { now: SEPT_15_MS });
      throw new Error("expected read() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_LINE_TOO_LARGE);
      expect(error.details?.bytes).toBe(2_000_000);
    }
  });
});

// ============================================================================
// Obligation B — duplicate-id "content" is raw line bytes, pinned three ways
// ============================================================================

describe("read — obligation B: duplicate-id content comparison is byte-level, not canonical", () => {
  test("byte-identical duplicate -> accepted as one event", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const line = JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: REAL_ULID, actor: "alice", ticket: "ck-1", event: "release" });
    await seedMonthFile(adapter, `${line}\n${line}\n`);

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records).toHaveLength(1);
  });

  test("duplicate JSON keys resolving to the SAME canonical value, but different raw bytes -> rejected", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Clean line: ticket resolves to "ck-999".
    const clean = `{"ts":"2026-09-04T10:12:00Z","id":"${REAL_ULID}","actor":"alice","ticket":"ck-999","event":"release"}`;
    // Hostile line: a duplicate "ticket" key — JSON.parse's last-wins
    // resolution (confirmed by probe, dispatch 1's report) makes this
    // canonicalize to the exact same `Event` as `clean` above (ticket:
    // "ck-999"), while its raw bytes plainly differ.
    const hostile = `{"ts":"2026-09-04T10:12:00Z","id":"${REAL_ULID}","actor":"alice","ticket":"ck-1","ticket":"ck-999","event":"release"}`;
    await seedMonthFile(adapter, `${clean}\n${hostile}\n`);

    // This is the test that pins the choice: a canonical-form comparison
    // would accept these as "the same event" (they parse identically); the
    // byte-comparison policy this module implements rejects them, fail
    // closed, because no legitimate writer (this module always serializes
    // via `JSON.stringify`) ever produces a duplicate JSON key.
    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_DUPLICATE_ID_CONFLICT);
  });

  test("different canonical values under the same id -> rejected", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const a = `{"ts":"2026-09-04T10:12:00Z","id":"${REAL_ULID}","actor":"alice","ticket":"ck-1","event":"release"}`;
    const b = `{"ts":"2026-09-04T10:12:00Z","id":"${REAL_ULID}","actor":"alice","ticket":"ck-2","event":"release"}`;
    await seedMonthFile(adapter, `${a}\n${b}\n`);

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_DUPLICATE_ID_CONFLICT);
  });
});

// ============================================================================
// Obligation C — U+2028 survives JSON.stringify; splitting must not desync
// ============================================================================

describe("read — obligation C: U+2028 does not desynchronize line indices", () => {
  test("a comment containing U+2028 round-trips as one line, and the next line still parses", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // A literal U+2028 LINE SEPARATOR -- confirmed (dispatch 1's probe, and
    // re-confirmed for this dispatch) that JSON.stringify leaves it raw,
    // unlike backslash-n / backslash-r / ESC / NUL, which it escapes.
    const textWithLineSeparator = `before${String.fromCharCode(0x2028)}after`;
    const commentCandidate = {
      event: "comment",
      ts: "2026-09-04T10:12:00Z",
      actor: "claude-code:alice/wt-auth",
      ticket: "ck-1",
      text: textWithLineSeparator,
    } as unknown as EventCandidate;

    await append(adapter, COORD_REF, commentCandidate, { now: SEPT_15_MS, casRetry: FAST_RETRY });
    await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records).toHaveLength(2);
    const commentRecord = records.find((r) => r.event.event === "comment");
    expect(commentRecord?.event.event).toBe("comment");
    if (commentRecord?.event.event === "comment") {
      // The U+2028 survives byte-for-byte — a Unicode-aware split would have
      // broken this field, or worse, desynchronized the following line.
      expect(commentRecord.event.text).toBe(textWithLineSeparator);
    }
    expect(commentRecord?.line).toBe(0);
    const claimRecord = records.find((r) => r.event.event === "claim");
    expect(claimRecord?.line).toBe(1);
  });
});

// ============================================================================
// Obligation D — the month file is decided by the clock, never by `ts`
// ============================================================================

describe("append — obligation D: month file decided by the clock, not the event's ts", () => {
  test("an event whose ts names a different month still lands in the clock's month", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const candidate = claim("ck-1", { ts: "2020-01-15T00:00:00Z" });
    const appended = await append(adapter, COORD_REF, candidate, { now: SEPT_15_MS, casRetry: FAST_RETRY });

    expect(appended.month).toBe("2026-09");
    const januaryBlob = await adapter.readBlobFromRef(COORD_REF, "events/2020-01.jsonl");
    expect(januaryBlob).toBeNull();
  });
});

// ============================================================================
// Obligation E — this module's own errors never echo attacker-controlled bytes
// ============================================================================

describe("read — obligation E: diagnosable errors never echo rejected line content", () => {
  test("a hostile line's raw bytes never reach the thrown error's message or details", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const hostileMarker = "\x1b[2K\x1b[1A__HOSTILE_MARKER__ck-1 released by alice__";
    // Schema-invalid (unrecognized key) so this exercises `EVENT_LOG_LINE_INVALID`.
    await seedMonthFile(
      adapter,
      `${JSON.stringify({
        ts: "2026-09-04T10:12:00Z",
        id: REAL_ULID,
        actor: "alice",
        ticket: "ck-1",
        event: "release",
        [hostileMarker]: 1,
      })}\n`,
    );

    try {
      await read(adapter, COORD_REF, { now: SEPT_15_MS });
      throw new Error("expected read() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_LINE_INVALID);
      const serialized = JSON.stringify(error.toJSON());
      expect(serialized).not.toContain(hostileMarker);
      expect(serialized).not.toContain("\x1b");
    }
  });
});

// ============================================================================
// since / ticket / actor filters
// ============================================================================

describe("read — filters", () => {
  test("since is an exclusive ULID lower bound, not a timestamp bound", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const first = await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const second = await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const sinceFirst = await read(adapter, COORD_REF, { now: SEPT_15_MS, since: first.event.id });
    expect(sinceFirst.map((r) => r.event.id)).toEqual([second.event.id]);

    const sinceSecond = await read(adapter, COORD_REF, { now: SEPT_15_MS, since: second.event.id });
    expect(sinceSecond).toEqual([]);
  });

  test("fix round 4, Medium 1: a malformed since is rejected rather than silently returning [] on a board with real events", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const appended = await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const realUlid = appended.event.id as string;

    // Before the fix: a lowercased-but-otherwise-real ULID passed `read`'s
    // `id > since` comparison against every real event as "not greater
    // than," so this resolved `[]` on a board holding a real event — the
    // mutual-exclusion guarantee's own failure shape (a caller polling
    // with this cursor would conclude ck-1 is unheld).
    await expectCode(
      read(adapter, COORD_REF, { now: SEPT_15_MS, since: realUlid.toLowerCase() as EventId }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );
  });

  test("fix round 4, Medium 1: degenerate since values (null/object/0 coerced through) are rejected", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    // Cast through `unknown` — these are runtime-only shapes a caller
    // bypassing TypeScript (or forwarding external input blindly) could
    // still pass; `ReadOptions.since` being typed `EventId` does not stop
    // them at runtime.
    for (const bad of [null, {}, 0] as const) {
      await expectCode(
        read(adapter, COORD_REF, { now: SEPT_15_MS, since: bad as unknown as EventId }),
        EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
      );
    }
  });

  test("fix round 4, Medium 1: valid-shaped since values (25/27 chars, I/L/O/U, empty string) are all rejected, and a real ULID is accepted", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const appended = await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const realUlid = appended.event.id as string;

    for (const bad of [realUlid.slice(0, 25), `${realUlid}X`, `${realUlid.slice(0, 25)}I`, ""]) {
      await expectCode(
        read(adapter, COORD_REF, { now: SEPT_15_MS, since: bad as unknown as EventId }),
        EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
      );
    }

    // And a genuinely valid ULID (this event's own id) is accepted and
    // correctly excludes it (exclusive lower bound).
    await expect(read(adapter, COORD_REF, { now: SEPT_15_MS, since: appended.event.id })).resolves.toEqual([]);
  });

  test("fix round 5, Low F: a Symbol or a hostile toString for since is rejected with a CanKanError, not a leaked native error", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    // Before the fix: `isValidEventId`'s `ULID_PATTERN.test(value)`
    // coerces its argument via `ToString` -- a `Symbol` throws a raw,
    // unwrapped `TypeError` ("Cannot convert a symbol to a string"), and
    // an object with a throwing `toString` lets that object's own error
    // escape straight out of `read()`. Neither is a `CanKanError`.
    try {
      await read(adapter, COORD_REF, { now: SEPT_15_MS, since: Symbol("x") as unknown as EventId });
      throw new Error("expected read() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    }

    const hostile = {
      toString(): string {
        throw new Error("hostile toString");
      },
    };
    try {
      await read(adapter, COORD_REF, { now: SEPT_15_MS, since: hostile as unknown as EventId });
      throw new Error("expected read() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    }
  });

  test("ticket matches case-insensitively, canonicalized the same way append canonicalizes on write", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS, ticket: "CK-1" });
    expect(records).toHaveLength(1);
    expect(records[0]?.event.ticket as string | undefined).toBe("ck-1");
  });

  test("fix round 4, corrected sweep: a non-string ticket filter is rejected with a CanKanError, not a raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    // Before the fix: `canonicalizeTicketId`'s entire body is a bare
    // `.toLowerCase()` call — a method that does not exist on `number` or
    // `null` — so this leaked an unwrapped, native `TypeError` straight out
    // of `read()`, not a `CanKanError`.
    for (const bad of [123, null] as const) {
      try {
        await read(adapter, COORD_REF, { now: SEPT_15_MS, ticket: bad as unknown as string });
        throw new Error("expected read() to reject");
      } catch (error) {
        if (!isCanKanError(error)) throw error;
        expect(error.code).toBe(EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
      }
    }
  });

  test("actor matches by exact string equality", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1", { actor: "alice" }), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    await append(adapter, COORD_REF, claim("ck-2", { actor: "bob" }), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS, actor: "alice" });
    expect(records).toHaveLength(1);
    expect(records[0]?.event.ticket as string | undefined).toBe("ck-1");
  });
});

// ============================================================================
// read() on an absent ref
// ============================================================================

describe("read — absent ref", () => {
  test("returns [] rather than throwing or fetching/creating anything", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records).toEqual([]);
    // And still absent afterward — `read` did not lazily create it.
    expect(await adapter.readRef(COORD_REF)).toBeNull();
  });
});

// ============================================================================
// append() — schema rejection, malformed-tail guard, lazy ref init
// ============================================================================

describe("append — validation and ref lifecycle", () => {
  test("a candidate that fails schema validation is rejected before any git invocation", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // `claim` without the required `lease_until`.
    const invalid = { event: "claim", ts: "2026-09-04T10:12:00Z", actor: "alice", ticket: "ck-1" } as unknown as EventCandidate;

    await expectCode(append(adapter, COORD_REF, invalid, { now: SEPT_15_MS }), EventErrorCodes.EVENT_APPEND_REJECTED);
    expect(await adapter.readRef(COORD_REF)).toBeNull();
  });

  test("refuses to append onto a month file that does not end with a newline", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const truncated = '{"ts":"2026-09-04T10:12:00Z","id":"01M1RRC3FBMZYZS4SNMYZHJV6R","actor":"a","ticket":"ck-1","event":"clai';
    await seedMonthFile(adapter, truncated);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY }),
      EventErrorCodes.EVENT_LOG_MALFORMED_BLOB,
    );

    // Nothing was corrupted or silently fused onto the truncated tail.
    const stillTruncated = await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl");
    expect(stillTruncated).toBe(truncated);
  });

  test("creates the ref and the first event in one commit when the ref does not exist yet (fm6)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    expect(await adapter.readRef(COORD_REF)).toBeNull();

    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    expect(await adapter.readRef(COORD_REF)).not.toBeNull();
    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records).toHaveLength(1);
  });
});

// ============================================================================
// Fix round 1, S1 — trailingMonths validation (degenerate and hostile values)
// ============================================================================

describe("read — fix round 1, S1: trailingMonths must be a bounded integer", () => {
  // Every degenerate/hostile-value test below seeds a **real** claim first.
  // The bug this fix closes is specifically that a degenerate value made
  // `read()` silently report "no events" *even though a real event exists*
  // (fm9's double-claim, arriving through a parameter) — a test against an
  // empty board would pass either way and prove nothing about that failure
  // mode. Seeding first is what makes each assertion meaningful.
  async function seededRepoAndAdapter(): Promise<{ adapter: GitAdapter }> {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    return { adapter };
  }

  test("rejects trailingMonths: 0 rather than silently hiding the real event in the log", async () => {
    const { adapter } = await seededRepoAndAdapter();
    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: 0 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("rejects a negative trailingMonths", async () => {
    const { adapter } = await seededRepoAndAdapter();
    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: -1 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("rejects NaN", async () => {
    const { adapter } = await seededRepoAndAdapter();
    await expectCode(
      read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: Number.NaN }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );
  });

  test("rejects Infinity without hanging (the hostile config-derived case)", async () => {
    const { adapter } = await seededRepoAndAdapter();
    const start = Date.now();
    await expectCode(
      read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: Number.POSITIVE_INFINITY }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );
    // Before the fix, this drove a synchronous, unbounded loop that starved
    // the event loop — a passing assertion alone would not distinguish
    // "rejected quickly" from "would have hung forever, but we got lucky."
    // Asserting a tight wall-clock bound is what actually proves the guard
    // ran instead of the loop. Seeding a real ref first (see
    // `seededRepoAndAdapter`) is required for this to actually exercise the
    // loop at all: on a *fresh, ref-absent* repo, `read()` short-circuits at
    // its `readRef` null-check before ever reaching `trailingMonths`-driven
    // code, so a test against an empty board would pass even with the guard
    // fully removed — confirmed directly (see task-2-report.md's addendum).
    expect(Date.now() - start).toBeLessThan(500);
  }, 5_000);

  test("rejects a merely-huge finite value that would otherwise hang", async () => {
    const { adapter } = await seededRepoAndAdapter();
    const start = Date.now();
    await expectCode(
      read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: 1_000_000_000 }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );
    expect(Date.now() - start).toBeLessThan(500);
  }, 5_000);

  test("a non-integer (fractional) trailingMonths is rejected", async () => {
    const { adapter } = await seededRepoAndAdapter();
    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: 1.5 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test(
    "the default (no trailingMonths given) and the maximum accepted value both still work",
    async () => {
      const { adapter } = await seededRepoAndAdapter();
      await expect(read(adapter, COORD_REF, { now: SEPT_15_MS })).resolves.toHaveLength(1);
      // R52 (orchestrator, macOS CI timeout): this call's cost is *inherent*,
      // not a bug -- measured directly (instrumented `Bun.spawn`, task
      // report) at `trailingMonths: 120`, `read()`'s own loop does exactly
      // one `readBlobFromRef` per month in the window (no re-read, no
      // chain re-walk, no work proportional to anything but the window
      // size); the actual git-process count is one layer down, in M2.6's
      // adapter (`git/adapter.ts`, frozen for this phase -- R19), which
      // re-validates the ref (`check-ref-format` + `symbolic-ref`) and
      // re-resolves it (`show-ref` + `rev-parse`) on every call rather than
      // once per `read()`: 5 sequential `git` spawns per absent month,
      // 6 per present one (the extra `cat-file`), plus 10 fixed spawns
      // up front (ref validation, `readRef`, the `events`-prefix probe) --
      // 16 spawns measured at `trailingMonths: 1`, 611 at `trailingMonths:
      // 120`, matching that model exactly (10 + 119*5 + 1*6 = 611).
      // Locally (Linux) those 611 spawns cost ~300ms end to end. The macOS
      // CI failure this fixes was a timeout, not a measured duration: bun's
      // default 5000ms test timeout fired and reported ~5010ms, which is
      // the kill time, not the true cost -- the real macOS duration for
      // this whole test body (tempRepo/createGitAdapter setup, one
      // `append`, the default-window `read`, and the 611-spawn
      // `trailingMonths: 120` `read`) is only known to be *at least* 5s.
      // Per-spawn cost on that runner would only need to run ~10-15ms
      // (vs. this machine's sub-millisecond) to land the 120-month read
      // alone in the several-second range, which is well within known
      // macOS CI process-spawn overhead. 15s is chosen for genuine headroom
      // over that "several seconds" expectation, not over the 5010ms kill
      // time specifically -- a genuine regression (an accidental re-read or
      // chain re-walk multiplying the spawn count) would push this well
      // past 15s, not just barely over it.
      await expect(read(adapter, COORD_REF, { now: SEPT_15_MS, trailingMonths: 120 })).resolves.toHaveLength(1);
    },
    15_000,
  );
});

// ============================================================================
// Fix round 2, NEW-2 — `now` is `trailingMonths`'s sibling, and was unguarded
// ============================================================================

describe("read/append — fix round 2, NEW-2: now must be a finite number", () => {
  test("read({ now: NaN }) rejects rather than silently hiding a real event", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    // Before the fix: this resolved `[]` — S1's exact fail-open shape,
    // reached through `now` instead of `trailingMonths`, since
    // `monthKeyUtc(NaN)` produces the literal string `"NaN-NaN"`.
    await expectCode(read(adapter, COORD_REF, { now: Number.NaN }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("read({ now: Infinity }) rejects", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    await expectCode(read(adapter, COORD_REF, { now: Number.POSITIVE_INFINITY }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("read({ now: -Infinity }) rejects", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    await expectCode(read(adapter, COORD_REF, { now: Number.NEGATIVE_INFINITY }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("append({ now: NaN }) rejects rather than minting against an undefined month", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(append(adapter, COORD_REF, claim("ck-1"), { now: Number.NaN }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("append({ now: Infinity }) rejects, and does not poison the injected-clock ULID lane for later calls", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { now: Number.POSITIVE_INFINITY }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );

    // A subsequent, legitimate injected-`now` append must still mint
    // normally — the rejected call must never have reached `mint(now)`.
    const appended = await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    expect(appended.event.ticket as string).toBe("ck-2");
  });
});

// ============================================================================
// Fix round 3, M1 — `Number.isFinite` was the wrong bound: probes at each
// consumer's actual boundary value (one inside, one outside)
// ============================================================================

const MAX_DATE_MS = 8_640_000_000_000_000; // Date's own representable range
const MAX_ULID_TIME_MS = 281_474_976_710_655; // ulid's own encodable maximum

describe("read — fix round 3, M1: now bounded against Date's representable range, not just isFinite", () => {
  test("accepts now exactly at Date's representable boundary", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // No event exists at this absurd future month — the point is only that
    // the boundary value itself does not trip validation.
    await expect(read(adapter, COORD_REF, { now: MAX_DATE_MS })).resolves.toEqual([]);
  });

  test("rejects now one millisecond past the boundary, even though it is finite, rather than silently hiding a real event", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    // Before the fix: `monthKeyUtc(MAX_DATE_MS + 1)` is already `"NaN-NaN"`,
    // and `Number.isFinite(MAX_DATE_MS + 1)` is `true` — fix round 2's
    // bound admitted this value and `read()` silently resolved `[]` on a
    // board holding a real event.
    expect(Number.isFinite(MAX_DATE_MS + 1)).toBe(true);
    await expectCode(read(adapter, COORD_REF, { now: MAX_DATE_MS + 1 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  test("rejects a now far below -Date's representable range", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(read(adapter, COORD_REF, { now: -MAX_DATE_MS - 1 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });
});

describe("append — fix round 3, M1: now bounded against ulid's encodable range", () => {
  test("accepts now exactly at ulid's encodable boundary", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // A fresh, dedicated factory — not the shared `injectedClockUlidFactory`
    // — because minting at the *absolute maximum* encodable time would
    // otherwise permanently pin the module-level shared factory to that
    // maximum for every later test in this file that also injects `now`
    // (the monotonic factory never rolls its watermark back down), which
    // would silently break e.g. the Ruling R23 test's exact-value
    // assertion below. This test's own point (the boundary value itself is
    // accepted) does not depend on which factory instance is used.
    const appended = await append(adapter, COORD_REF, claim("ck-1", { ts: "2026-01-01T00:00:00Z" }), {
      now: MAX_ULID_TIME_MS,
      ulidFactory: monotonicFactory(),
      casRetry: FAST_RETRY,
    });
    expect(appended.event.ticket as string).toBe("ck-1");
  });

  test("rejects now one millisecond past ulid's boundary with a CanKanError, not a raw ULIDError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    try {
      await append(adapter, COORD_REF, claim("ck-1"), { now: MAX_ULID_TIME_MS + 1, casRetry: FAST_RETRY });
      throw new Error("expected append() to reject");
    } catch (error) {
      // Before the fix: this was an unwrapped, third-party `ULIDError`
      // (`ENC_TIME_SIZE_EXCEED`) — not a `CanKanError`, so any
      // `isCanKanError`-based handler downstream would not recognize it.
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    }
  });

  test("rejects a negative now with a CanKanError, not a raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    try {
      await append(adapter, COORD_REF, claim("ck-1"), { now: -1, casRetry: FAST_RETRY });
      throw new Error("expected append() to reject");
    } catch (error) {
      // Before the fix: `ulid`'s own encoder throws a raw `TypeError`
      // ("undefined is not an object (evaluating 'str.length')") for a
      // negative seed time, confirmed by probe (task-2-report.md).
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    }
  });

  test("rejecting an out-of-range now does not permanently poison the injected-clock ULID lane", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { now: MAX_ULID_TIME_MS + 1, casRetry: FAST_RETRY }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );

    // Before the fix: `ulid`'s monotonic factory is permanently poisoned by
    // one out-of-range call — confirmed by probe that a *second*, ordinary
    // call against the same factory instance still throws, echoing the
    // original bad seed. This asserts the poisoning never happened because
    // `mint(now)` was never reached for the rejected call.
    const appended = await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    expect(appended.event.ticket as string).toBe("ck-2");
  });
});

// ============================================================================
// Fix round 3 sweep — AppendOptions.casRetry.maxAttempts was forwarded to
// withCasRetry (git/retry.ts) unvalidated (Ruling R27)
// ============================================================================

describe("append — fix round 3 sweep: casRetry.maxAttempts validated against withCasRetry's loop domain", () => {
  test("rejects Infinity, which would otherwise make the retry loop unbounded", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { casRetry: { maxAttempts: Number.POSITIVE_INFINITY } }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("rejects NaN, which would otherwise fail every attempt immediately on an uncontended repo", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Before the fix: `withCasRetry`'s loop condition is `1 <= NaN`, which
    // is always `false`, so the loop body — and therefore `attempt` itself
    // — never runs even once, and `append` fails with a misleading
    // `GIT_CAS_CONTENTION_EXCEEDED` on a completely uncontended repo.
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { casRetry: { maxAttempts: Number.NaN } }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("rejects 0 and a negative value", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { casRetry: { maxAttempts: 0 } }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
    await expectCode(
      append(adapter, COORD_REF, claim("ck-2"), { casRetry: { maxAttempts: -5 } }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("accepts a legitimate small maxAttempts", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const appended = await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: { maxAttempts: 3, backoffMs: () => 0 } });
    expect(appended.event.ticket as string).toBe("ck-1");
  });
});

// ============================================================================
// Fix round 5 — the corrected invariant applied to each option's own TYPE,
// not just its value: three function-typed AppendOptions fields reached a
// call site with no typeof check, each leaking a raw TypeError past
// isCanKanError.
// ============================================================================

describe("append — fix round 5, High B: casRetry.backoffMs's own type validated at option-validation time", () => {
  test("rejects a non-function backoffMs immediately, on a completely uncontended repo", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Before the fix: `backoffMs` is only ever *called* between a failed
    // attempt and the next one, so this exact non-function value would
    // have passed silently here (no contention, no call) and only crashed
    // with a raw TypeError the first time two workers actually raced --
    // this test asserts it is caught immediately instead, matching every
    // other option-shape check in this function.
    for (const bad of [123, "x", {}] as const) {
      try {
        await append(adapter, COORD_REF, claim("ck-1"), { casRetry: { backoffMs: bad as unknown as (n: number) => number } });
        throw new Error("expected append() to reject");
      } catch (error) {
        if (!isCanKanError(error)) throw error;
        expect(error.code).toBe(EventErrorCodes.EVENT_APPEND_INVALID_OPTION);
      }
    }
  });
});

describe("append — fix round 5, Medium C: ulidFactory's own type validated", () => {
  test("rejects a non-function ulidFactory with a CanKanError, not a raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    for (const bad of [123, "x", {}] as const) {
      try {
        await append(adapter, COORD_REF, claim("ck-1"), { ulidFactory: bad as unknown as (seedTime?: number) => string });
        throw new Error("expected append() to reject");
      } catch (error) {
        if (!isCanKanError(error)) throw error;
        expect(error.code).toBe(EventErrorCodes.EVENT_APPEND_INVALID_OPTION);
      }
    }
  });

  test("a ulidFactory returning garbage is still caught downstream by parseEvent, unchanged by this fix", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { ulidFactory: () => "not-a-ulid" }),
      EventErrorCodes.EVENT_APPEND_REJECTED,
    );
    await expectCode(
      append(adapter, COORD_REF, claim("ck-2"), { ulidFactory: () => 12345 as unknown as string }),
      EventErrorCodes.EVENT_APPEND_REJECTED,
    );
  });
});

describe("append — fix round 5, Low D: casRetry.sleep's own type, and casRetry: null", () => {
  test("rejects a non-function sleep", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    try {
      await append(adapter, COORD_REF, claim("ck-1"), {
        casRetry: { backoffMs: () => 0, sleep: 123 as unknown as (ms: number) => Promise<void> },
      });
      throw new Error("expected append() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_APPEND_INVALID_OPTION);
    }
  });

  test("rejects casRetry: null, which otherwise dies inside withCasRetry with a raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    try {
      await append(adapter, COORD_REF, claim("ck-1"), { casRetry: null as unknown as undefined });
      throw new Error("expected append() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_APPEND_INVALID_OPTION);
    }
  });
});

// ============================================================================
// Fix round 4, Medium 2 — casRetry.backoffMs's *return value* was forwarded
// to withCasRetry unvalidated
// ============================================================================

describe("append — fix round 4, Medium 2: casRetry.backoffMs's return value validated against setTimeout's actual domain", () => {
  /**
   * `backoffMs` is only ever called *between* a failed attempt and the
   * next one — so exercising its validation requires forcing at least one
   * real retry, using the same interleave seam the CAS-retry test uses.
   */
  async function forceOneRetryThenReturn(backoffMs: (attemptNumber: number) => number): Promise<unknown> {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-seed"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const hooks: AppendHooks = {
      beforeCas: async (attemptNumber) => {
        if (attemptNumber === 1) {
          // Guarantee this call's own first attempt is rejected, forcing
          // a real second attempt (and therefore a real `backoffMs` call)
          // through the loop.
          await append(adapter, COORD_REF, claim("ck-interloper"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
        }
      },
    };

    return appendCore(adapter, COORD_REF, claim("ck-mine"), { now: SEPT_15_MS, casRetry: { maxAttempts: 3, backoffMs } }, hooks);
  }

  test("rejects an in-range-but-day-scale return value (INT32_MAX) that setTimeout would not clamp", async () => {
    // Before the fix: `setTimeout(fn, 2_147_483_647)` is genuinely
    // scheduled for ~24.8 days (confirmed by probe, task-2-report.md's
    // fix-round-4 addendum) rather than firing immediately the way
    // `NaN`/`Infinity`/negative/over-32-bit values are clamped to do — so
    // this specific value is the one a bare `Number.isFinite` check would
    // have let straight through.
    await expectCode(forceOneRetryThenReturn(() => 2_147_483_647), EventErrorCodes.EVENT_APPEND_INVALID_OPTION);
  }, 10_000);

  test("rejects NaN and a negative return value", async () => {
    await expectCode(forceOneRetryThenReturn(() => Number.NaN), EventErrorCodes.EVENT_APPEND_INVALID_OPTION);
  }, 10_000);

  test("accepts a legitimate small return value and completes the retry normally", async () => {
    const result = (await forceOneRetryThenReturn(() => 5)) as { event: { ticket: string } };
    expect(result.event.ticket as string).toBe("ck-mine");
  }, 10_000);
});

// ============================================================================
// Fix round 2, Ruling R23 — S6's two-lane design was correct but unguarded:
// the suite stayed green even with the fix reverted to a single shared factory
// ============================================================================

describe("append — Ruling R23: an injected far-future now must not pin the real-clock ULID lane", () => {
  test("a real-clock append after a far-future injected-now append still mints near Date.now()", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Mint via the injected-clock lane, seeded decades in the future.
    const farFuture = Date.parse("2100-01-01T00:00:00Z");
    const futureAppended = await append(adapter, COORD_REF, claim("ck-future", { ts: "2026-09-04T10:12:00Z" }), {
      now: farFuture,
      casRetry: FAST_RETRY,
    });

    // Fix round 3, L3: the injected-clock append's OWN minted id must
    // reflect the *injected* `now`, not real time — this is the assertion
    // the original version of this test was missing. It specifically
    // catches `mint(now)` silently becoming `mint()` (dropping the seed
    // argument): under that mutation, every injected-clock id would be
    // seeded at real time while its event still lands in the *injected*
    // month, desynchronizing read()'s ULID ordering and the `since` bound
    // from `(month, line)` — and the assertion below (real-clock lands
    // near Date.now()) stays true under that exact mutation, since nothing
    // pins the real-clock lane either way. Mutation result confirming this
    // line is what catches it: see task-2-report.md's fix-round-3 addendum.
    expect(decodeTime(futureAppended.event.id as string)).toBe(farFuture);

    // A later, real-clock append (no `now` override) must mint an id whose
    // decoded timestamp reflects *real* time, not the far-future value the
    // previous call injected. Under the original bug (one shared factory
    // for both lanes), this id's timestamp would be clamped to on-or-after
    // `farFuture` instead — `ulid`'s monotonic factory never rolls its
    // internal clock backward for a smaller seed time than it has already
    // seen (fix round 1's own probe, task-2-report.md).
    const before = Date.now();
    const realAppended = await append(adapter, COORD_REF, claim("ck-real"), { casRetry: FAST_RETRY });
    const after = Date.now();

    const mintedTime = decodeTime(realAppended.event.id as string);
    // A generous window tolerates real test-execution latency; it is not
    // remotely wide enough to also tolerate landing in the year 2100.
    expect(mintedTime).toBeGreaterThanOrEqual(before - 2_000);
    expect(mintedTime).toBeLessThanOrEqual(after + 2_000);
  });
});

// ============================================================================
// Fix round 1, S2 — append's own blob-size bound, and read's aggregate cap
// ============================================================================

describe("append — fix round 1, S2: the existing-blob-size bound", () => {
  test("refuses to extend a month blob that already exceeds the size cap", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Deliberately not valid JSONL — the size check runs before any parsing
    // is attempted, so garbage content is sufficient and far cheaper to
    // construct than a genuinely valid 65MB log.
    const oversized = "x".repeat(65 * 1024 * 1024);
    await seedMonthFile(adapter, oversized);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY }),
      EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE,
    );

    // Confirmed unchanged — the write path did not silently grow what it
    // refused to extend.
    const stillOversized = await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl");
    expect(stillOversized).toBe(oversized);
  }, 20_000);

  test("maxExistingBlobBytes is a reachable escape hatch for a deliberate recovery write", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Well-formed (trailing newline) so the size bypass is what's actually
    // under test, not an unrelated malformed-tail rejection.
    const oversized = `${"x".repeat(65 * 1024 * 1024)}\n`;
    await seedMonthFile(adapter, oversized);

    // A caller (dispatch 4's quarantine/recovery path, per the brief) that
    // deliberately disables the guard can still write into the oversized
    // month — the cap is not absolute.
    const appended = await append(adapter, COORD_REF, claim("ck-recovery"), {
      now: SEPT_15_MS,
      casRetry: FAST_RETRY,
      maxExistingBlobBytes: Number.POSITIVE_INFINITY,
    });
    expect(appended.event.ticket as string).toBe("ck-recovery");
  }, 20_000);

  test("fix round 2 (Low): maxExistingBlobBytes: NaN is rejected rather than silently disabling the cap", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const oversized = `${"x".repeat(65 * 1024 * 1024)}\n`;
    await seedMonthFile(adapter, oversized);

    // Before the fix: `existingBytes > NaN` is always `false` in
    // JavaScript, so this silently applied the write onto an oversized
    // month exactly as if the cap did not exist.
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY, maxExistingBlobBytes: Number.NaN }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  }, 20_000);

  test("fix round 2 (Low): a negative maxExistingBlobBytes is rejected rather than refusing even an empty month", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY, maxExistingBlobBytes: -1 }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("fix round 4, Low 2: a non-number maxExistingBlobBytes is rejected, not silently accepted", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const oversized = `${"x".repeat(65 * 1024 * 1024)}\n`;
    await seedMonthFile(adapter, oversized);

    // Before the fix: `Number.isNaN` does not coerce, so neither "abc" nor
    // {} is `NaN`, and neither is `< 0` (JavaScript's own `ToNumber`
    // coercion for the comparison makes both `false`) — both passed the
    // pre-fix check and silently disabled the cap, applying the write onto
    // the oversized month exactly as if no cap existed.
    for (const bad of ["abc", {}] as const) {
      await expectCode(
        append(adapter, COORD_REF, claim("ck-1"), {
          now: SEPT_15_MS,
          casRetry: FAST_RETRY,
          maxExistingBlobBytes: bad as unknown as number,
        }),
        EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
      );
    }
  }, 20_000);
});

// ============================================================================
// Fix round 2, NEW-3 — append's own fm8-class errors were missing `commit`
// ============================================================================

describe("append — fix round 2, NEW-3: fm8-class errors carry the offending commit sha", () => {
  test("EVENT_LOG_BLOB_TOO_LARGE names the commit it read", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const oversized = "x".repeat(65 * 1024 * 1024);
    await seedMonthFile(adapter, oversized);
    const seededSha = await adapter.readRef(COORD_REF);

    try {
      await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
      throw new Error("expected append() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE);
      expect(error.details?.commit as string | undefined).toBe((seededSha as string | null) ?? undefined);
    }
  }, 20_000);

  test("EVENT_LOG_MALFORMED_BLOB names the commit it read", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const truncated = '{"ts":"2026-09-04T10:12:00Z","id":"01M1RRC3FBMZYZS4SNMYZHJV6R","actor":"a","ticket":"ck-1","event":"clai';
    await seedMonthFile(adapter, truncated);
    const seededSha = await adapter.readRef(COORD_REF);

    try {
      await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
      throw new Error("expected append() to reject");
    } catch (error) {
      if (!isCanKanError(error)) throw error;
      expect(error.code).toBe(EventErrorCodes.EVENT_LOG_MALFORMED_BLOB);
      expect(error.details?.commit as string | undefined).toBe((seededSha as string | null) ?? undefined);
    }
  });
});

describe("read — fix round 1, S2/S4: the per-month and aggregate size bounds", () => {
  test("a single oversized month blob is rejected (kills the 'delete MAX_MONTH_BLOB_BYTES' mutant)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const oversized = "x".repeat(65 * 1024 * 1024);
    await seedMonthFile(adapter, oversized);

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE);
  }, 20_000);

  test("the aggregate cap fires across a multi-month window even though no single month exceeds the per-month cap", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // A single, large, valid `hook` event line — reused byte-for-byte so
    // repeating it (within a month, and across months) is folded by the
    // duplicate-id dedupe rather than raising a duplicate-content error.
    const bigOutput = "y".repeat(90_000); // under MAX_HOOK_OUTPUT_CHARS and MAX_LINE_BYTES
    const oneLine = `${JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      id: REAL_ULID,
      actor: "alice",
      ticket: "ck-1",
      event: "hook",
      title: "t",
      output: bigOutput,
    })}\n`;
    const linesPerMonth = Math.ceil((55 * 1024 * 1024) / Buffer.byteLength(oneLine, "utf8"));
    const monthContent = oneLine.repeat(linesPerMonth);
    // Each month's blob (~55MB) stays under MAX_MONTH_BLOB_BYTES (64MB);
    // five of them (~275MB) exceed MAX_AGGREGATE_READ_BYTES (256MB).
    expect(Buffer.byteLength(monthContent, "utf8")).toBeLessThan(64 * 1024 * 1024);

    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
    let parent: Awaited<ReturnType<GitAdapter["readRef"]>> = null;
    for (const month of months) {
      const outcome = await adapter.commitTreeToRef(COORD_REF, {
        parent,
        message: `seed ${month}`,
        files: [{ path: `events/${month}.jsonl`, content: monthContent }],
      });
      if (outcome.outcome !== "applied") throw new Error(`setup failed for ${month}`);
      parent = outcome.sha;
    }

    const now = Date.parse("2026-05-15T00:00:00Z");
    await expectCode(read(adapter, COORD_REF, { now, trailingMonths: 5 }), EventErrorCodes.EVENT_LOG_AGGREGATE_TOO_LARGE);
  }, 60_000);
});

// ============================================================================
// Fix round 1, S4/Ruling R20 — end-to-end fm10 coverage at every entry point
//
// Fix round 2, Ruling R24 (framing correction): these are end-to-end
// assertions that `append`/`read` surface `GIT_REF_INVALID` for a bad ref —
// they are **not** guards on `log.ts`'s own `validateCoordinationRef(ref)`
// call specifically. `GitAdapter.readRef`/`commitTreeToRef`/`readBlobFromRef`
// each internally call `ensureValidRef` (`git/adapter.ts:90-99`), which
// re-runs the identical `validateCoordinationRef` check before touching git —
// so deleting `log.ts`'s own call is an *equivalent* mutant (the adapter's
// own gate still rejects the ref, the observable behavior these tests check
// is unchanged) rather than a coverage gap these tests close. The events-side
// call is defense-in-depth (fail fast without a git invocation, and stay
// correct if a future edit ever bypasses the adapter for some call), not the
// thing solely responsible for the security property. Stated plainly here
// because an earlier version of this comment (and the report) implied
// stronger coverage of `log.ts`'s own call than these tests actually provide.
// ============================================================================

/** Raw plumbing for test setup only — never the adapter under test. Mirrors `git.test.ts`'s own helper. */
function rawGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

describe("the fm10 ref gate — append/read/initRef all reject a ref outside refs/cankan/", () => {
  test("append rejects refs/heads/main", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(append(adapter, "refs/heads/main", claim("ck-1"), { now: SEPT_15_MS }), GitErrorCodes.GIT_REF_INVALID);
  });

  test("read rejects refs/heads/main", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(read(adapter, "refs/heads/main", { now: SEPT_15_MS }), GitErrorCodes.GIT_REF_INVALID);
  });

  test("append rejects a coordination ref that is itself a symbolic ref, and refs/heads/main is left unmoved", async () => {
    const repo = await tempRepo();
    const mainShaBefore = rawGit(repo.dir, ["rev-parse", "refs/heads/main"]).trim();
    rawGit(repo.dir, ["symbolic-ref", COORD_REF, "refs/heads/main"]);
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY }), GitErrorCodes.GIT_REF_INVALID);

    const mainShaAfter = rawGit(repo.dir, ["rev-parse", "refs/heads/main"]).trim();
    expect(mainShaAfter).toBe(mainShaBefore);
  });
});

// ============================================================================
// Fix round 3, Ruling R48 (High, orchestrator security review): a blocked
// `events` prefix must fail closed, not silently read as an empty board
// ============================================================================

/** Raw plumbing with stdin, for planting a blob whose content doesn't matter — only its mode and path. */
function rawGitStdin(cwd: string, args: string[], stdin: Buffer): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

/** Replaces the coordination ref's entire tree with one containing a single entry at `cacheinfo` (`"<mode>,<sha>,<path>"`) — real plumbing, real commit, on top of whatever the ref currently points to. */
async function plantAtEventsPrefix(adapter: GitAdapter, repoDir: string, cacheinfo: string): Promise<void> {
  rawGit(repoDir, ["read-tree", "--empty"]);
  rawGit(repoDir, ["update-index", "--add", "--cacheinfo", cacheinfo]);
  const treeSha = rawGit(repoDir, ["write-tree"]).trim();
  const parent = await adapter.readRef(COORD_REF);
  if (parent === null) throw new Error("expected an existing ref to plant onto");
  const commitSha = rawGit(repoDir, ["commit-tree", "-p", parent, "-m", "plant", treeSha]).trim();
  rawGit(repoDir, ["update-ref", COORD_REF, commitSha]);
}

describe("read — fix round 3, Ruling R48: a blocked events prefix fails closed, not open", () => {
  test("a blob planted at the bare `events` path makes read() throw, not silently return []", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const blobSha = rawGitStdin(repo.dir, ["hash-object", "-w", "--stdin"], Buffer.from("not a directory")).trim();
    await plantAtEventsPrefix(adapter, repo.dir, `100644,${blobSha},events`);

    // Before the fix: this silently returned `[]` — alice's real claim
    // vanished from the result with no error at all.
    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED);
  });

  test("a symlink planted at the bare `events` path also fails closed (mode 120000 shares GIT_BLOB_AMBIGUOUS with a healthy directory)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const blobSha = rawGitStdin(repo.dir, ["hash-object", "-w", "--stdin"], Buffer.from("/etc/passwd")).trim();
    await plantAtEventsPrefix(adapter, repo.dir, `120000,${blobSha},events`);

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED);
  });

  test("a gitlink planted at the bare `events` path also fails closed (mode 160000 shares GIT_BLOB_AMBIGUOUS with a healthy directory)", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const fakeSubmoduleSha = "a".repeat(40);
    await plantAtEventsPrefix(adapter, repo.dir, `160000,${fakeSubmoduleSha},events`);

    await expectCode(read(adapter, COORD_REF, { now: SEPT_15_MS }), EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED);
  });

  test("control: a healthy events directory is unaffected — read() succeeds normally", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);
  });
});

// ============================================================================
// Fix round 3 (Ruling R31/R32, orchestrator security review): an explicit
// `null` options argument must not throw a raw TypeError, and every
// caller-supplied option interpolated into an error message must be
// type-gated first
// ============================================================================

describe("append/read — fix round 3: an explicit null options argument is normalized, not a raw TypeError", () => {
  test("append(adapter, ref, candidate, null) behaves like append(adapter, ref, candidate) — no raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    // Before the fix: `options.now` on a `null` options argument threw a
    // raw `TypeError` (a default parameter does not apply to an explicit
    // `null`).
    const appended = await append(adapter, COORD_REF, claim("ck-1"), null);
    expect(appended.event.ticket as string).toBe("ck-1");
  });

  test("read(adapter, ref, null) behaves like read(adapter, ref) — no raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const records = await read(adapter, COORD_REF, null);
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);
  });
});

describe("append — fix round 3, Ruling R31/R32: every caller-supplied option interpolated into an error message is type-gated first", () => {
  test("a non-number now surfaces as a CanKanError, not a raw TypeError from a template literal", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Before the fix: `${now}` on an object with no prototype (no
    // `toString`/`valueOf`) threw a raw `TypeError` ("No default value")
    // while *constructing* the error meant to report the problem.
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { now: Object.create(null) as number }),
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
    );
  });

  test("a non-number casRetry.maxAttempts surfaces as a CanKanError, not a raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { casRetry: { maxAttempts: Object.create(null) as number } }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("a ulidFactory returning an unserializable value (BigInt) is rejected as EVENT_APPEND_REJECTED, not a raw TypeError from JSON.stringify", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Before the fix: `JSON.stringify` itself threw ("Do not know how to
    // serialize a BigInt") before `parseEvent` ever ran, escaping this
    // function's own `isCanKanError`-shaped error contract entirely.
    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { ulidFactory: () => 1n as unknown as string }),
      EventErrorCodes.EVENT_APPEND_REJECTED,
    );
  });
});

// ============================================================================
// M2.10 slice 0 — `AppendOptions.expectedParent`, the CAS seam every later
// slice depends on (see `log.ts`'s doc comment on the option itself for the
// full "why": `append`'s own CAS serializes concurrent writers against each
// other, not the *decision* each writer made before calling `append`).
// ============================================================================

describe("append — expectedParent (M2.10 slice 0)", () => {
  test("omitting expectedParent is unchanged: two sequential appends both land, the second sees the first", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const first = await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const second = await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    expect(first.event.ticket as string).toBe("ck-1");
    expect(second.event.ticket as string).toBe("ck-2");

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records.map((r) => r.event.ticket as string).sort()).toEqual(["ck-1", "ck-2"]);
  });

  test("a stale expectedParent is rejected, and nothing is written", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await append(adapter, COORD_REF, claim("ck-seed"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const staleTip = await adapter.readRef(COORD_REF);
    if (staleTip === null) {
      throw new Error("expected the seeded ref to already exist");
    }

    // A competing writer moves the tip out from under `staleTip`.
    await append(adapter, COORD_REF, claim("ck-competitor"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    await expectCode(
      append(adapter, COORD_REF, claim("ck-mine"), { now: SEPT_15_MS, casRetry: FAST_RETRY, expectedParent: staleTip }),
      EventErrorCodes.EVENT_APPEND_STALE_PARENT,
    );

    // The log holds exactly the competitor's event and the seed — not the
    // rejected `ck-mine` — proving the throw happened before any write.
    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    expect(tickets).toEqual(["ck-competitor", "ck-seed"]);
  });

  test("a CAS rejection with expectedParent set does not drive an internal retry — the caller owns it", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await append(adapter, COORD_REF, claim("ck-seed"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const correctTip = await adapter.readRef(COORD_REF);
    if (correctTip === null) {
      throw new Error("expected the seeded ref to already exist");
    }

    let attempts = 0;
    const hooks: AppendHooks = {
      beforeCas: async () => {
        attempts += 1;
        // Force this attempt's `commitTreeToRef` to lose the race by moving
        // the tip out from under it, between this attempt's read (which saw
        // `correctTip`, matching `expectedParent`) and its commit — the
        // identical interloper mechanism the "CAS retry re-reads" describe
        // block above uses, but here `expectedParent` is set, so this
        // exercises the *second* throw site (a rejected commit), not the
        // first (a mismatched read).
        await append(adapter, COORD_REF, claim("ck-interloper"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
      },
    };

    // A generous `maxAttempts` — if this rejection were ever reported as
    // `{ done: false }` instead of thrown, `withCasRetry` would drive a real
    // second attempt (and `beforeCas` would fire again) instead of
    // propagating the error on the first.
    await expectCode(
      appendCore(
        adapter,
        COORD_REF,
        claim("ck-mine"),
        { now: SEPT_15_MS, casRetry: { ...FAST_RETRY, maxAttempts: 50 }, expectedParent: correctTip },
        hooks,
      ),
      EventErrorCodes.EVENT_APPEND_STALE_PARENT,
    );

    // Exactly 1, not merely "at most 1": proves the commit-rejection path
    // was genuinely exercised (a silently-hoisted or skipped check would
    // leave this at 0, the no-op shape the test rules above warn against).
    expect(attempts).toBe(1);

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    expect(tickets).toEqual(["ck-interloper", "ck-seed"]);
  });

  test("a current expectedParent succeeds", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    const currentTip = await adapter.readRef(COORD_REF);
    if (currentTip === null) {
      throw new Error("expected the ref to already exist");
    }

    const appended = await append(adapter, COORD_REF, claim("ck-2"), {
      now: SEPT_15_MS,
      casRetry: FAST_RETRY,
      expectedParent: currentTip,
    });
    expect(appended.event.ticket as string).toBe("ck-2");

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records.map((r) => r.event.ticket as string).sort()).toEqual(["ck-1", "ck-2"]);
  });

  test("expectedParent: null succeeds on a fresh repo, where the ref does not exist yet", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    const tipBeforeAppend = await adapter.readRef(COORD_REF);
    expect(tipBeforeAppend).toBeNull();

    const appended = await append(adapter, COORD_REF, claim("ck-1"), {
      now: SEPT_15_MS,
      casRetry: FAST_RETRY,
      expectedParent: null,
    });
    expect(appended.event.ticket as string).toBe("ck-1");
  });

  test("expectedParent: null throws once the ref already exists", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    await expectCode(
      append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY, expectedParent: null }),
      EventErrorCodes.EVENT_APPEND_STALE_PARENT,
    );

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);
  });

  test("a number expectedParent surfaces EVENT_APPEND_INVALID_OPTION, not a raw comparison against garbage", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { expectedParent: 123 as unknown as RefSha }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("an object expectedParent surfaces EVENT_APPEND_INVALID_OPTION", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { expectedParent: {} as unknown as RefSha }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });

  test("a non-SHA string expectedParent surfaces EVENT_APPEND_INVALID_OPTION", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);

    await expectCode(
      append(adapter, COORD_REF, claim("ck-1"), { expectedParent: "not-a-sha" as unknown as RefSha }),
      EventErrorCodes.EVENT_APPEND_INVALID_OPTION,
    );
  });
});
