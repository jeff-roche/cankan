import { afterEach, describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { createGitAdapter, type GitAdapter } from "../../src/git/index";
import { EventErrorCodes } from "../../src/events/errors";
import {
  append,
  appendCore,
  type AppendHooks,
  type EventCandidate,
  read,
} from "../../src/events/log";
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

  test("ticket matches case-insensitively, canonicalized the same way append canonicalizes on write", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, claim("ck-1"), { now: SEPT_15_MS, casRetry: FAST_RETRY });
    await append(adapter, COORD_REF, claim("ck-2"), { now: SEPT_15_MS, casRetry: FAST_RETRY });

    const records = await read(adapter, COORD_REF, { now: SEPT_15_MS, ticket: "CK-1" });
    expect(records).toHaveLength(1);
    expect(records[0]?.event.ticket as string | undefined).toBe("ck-1");
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
