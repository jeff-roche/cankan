import { afterEach, describe, expect, test } from "bun:test";
import { monotonicFactory } from "ulid";
import { isCanKanError } from "../../src/errors";
import { createGitAdapter, type GitAdapter } from "../../src/git/index";
import { append, type EventCandidate, read } from "../../src/events/log";
import { EventErrorCodes } from "../../src/events/errors";
import {
  diagnose,
  recover,
  recoverCore,
  type RecoveryHooks,
  safeLinePreview,
} from "../../src/events/recovery";
// See `git.test.ts`'s own comment: `@jeff-roche/cankan-test-utils` is not a
// declared dependency of `packages/core/package.json`, so a relative import
// to the source file is used instead of the package specifier.
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";

const COORD_REF = "refs/cankan/coordination";
const NOW = Date.parse("2026-09-15T10:00:00Z");

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

/** Raw plumbing for test setup and verification only — never the adapter under test. Mirrors `log.test.ts`'s own helper. */
function rawGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Seeds one commit carrying exactly `files` onto an empty ref (`parent: null`) — real content, via a real commit, never a mocked reader. */
async function seedRef(adapter: GitAdapter, files: { path: string; content: string }[]): Promise<void> {
  const outcome = await adapter.commitTreeToRef(COORD_REF, { parent: null, message: "seed", files });
  if (outcome.outcome !== "applied") throw new Error("setup failed");
}

const mintId = monotonicFactory();
function ulid(): string {
  return mintId(NOW);
}

/** A well-formed, schema-valid `release` line — real JSON, real ULID. */
function validLine(ticket: string, id = ulid()): string {
  return JSON.stringify({ ts: "2026-09-04T10:12:00Z", id, actor: "alice", ticket, event: "release" });
}

/** A well-formed, schema-valid `claim` line. */
function validClaimLine(ticket: string, id = ulid()): string {
  return JSON.stringify({
    ts: "2026-09-04T10:12:00Z",
    id,
    actor: "alice",
    ticket,
    event: "claim",
    lease_until: "2026-09-04T12:12:00Z",
  });
}

/** A minimal, valid `claim` candidate for `append()` — mirrors `log.test.ts`'s own helper. */
function claimCandidate(ticket: string): EventCandidate {
  return {
    event: "claim",
    ts: "2026-09-04T10:12:00Z",
    actor: "claude-code:alice/wt-auth",
    ticket,
    lease_until: "2026-09-04T12:12:00Z",
  } as unknown as EventCandidate;
}

/** A minimal, valid `release` candidate for `append()`. */
function releaseCandidate(ticket: string): EventCandidate {
  return { event: "release", ts: "2026-09-04T10:12:00Z", actor: "alice", ticket } as unknown as EventCandidate;
}

// ============================================================================
// Test 1 — poison the ref, confirm read() aborts (ADR's "reasoned, not
// tested" claim, turned into a test)
// ============================================================================

describe("a single poisoned line renders the board unreadable", () => {
  test("read() aborts on one schema-invalid line among otherwise-healthy content", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const good = validLine("ck-1");
    const bad = "not json at all";
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${good}\n${bad}\n` }]);

    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_INVALID);
  });
});

// ============================================================================
// Test 2 — diagnose() identifies the offending line while read() is aborting
// ============================================================================

describe("diagnose — identifies the offending line", () => {
  test("reports ref, commit, month, line, and reason for a single bad line", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const good = validLine("ck-1");
    const bad = "not json at all";
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${good}\n${bad}\n` }]);
    const head = await adapter.readRef(COORD_REF);

    // The board is still in the aborting state — this is not a "fix read()
    // first" precondition.
    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_INVALID);

    const report = await diagnose(adapter, COORD_REF, { now: NOW });
    expect(report.ref).toBe(COORD_REF);
    expect(report.commit).toBe(head as string | null);
    expect(report.failures).toHaveLength(1);
    const failure = report.failures[0];
    expect(failure?.month).toBe("2026-09");
    expect(failure?.line).toBe(1);
    expect(failure?.reason).toBe("invalid-json");
  });
});

// ============================================================================
// Test 3 — multiple poisoned lines across two different month files, one run
// ============================================================================

describe("diagnose — multiple poisoned lines across two month files", () => {
  test("a single diagnose() call reports every failure in both months", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [
      { path: "events/2026-08.jsonl", content: `${validLine("ck-aug")}\nbad-in-august\n` },
      { path: "events/2026-09.jsonl", content: `${validLine("ck-sep")}\nbad-in-september\n` },
    ]);

    const report = await diagnose(adapter, COORD_REF, { now: NOW, trailingMonths: 2 });
    expect(report.failures).toHaveLength(2);
    const byMonth = new Map(report.failures.map((f) => [f.month, f]));
    expect(byMonth.get("2026-08")?.line).toBe(1);
    expect(byMonth.get("2026-09")?.line).toBe(1);
    expect([...report.monthsScanned].sort()).toEqual(["2026-08", "2026-09"]);
  });
});

// ============================================================================
// Test 4 — recovery returns the board to a readable state
// Test 5 — valid events in the poisoned month survive
// ============================================================================

describe("recover — returns the board to a readable state", () => {
  test("read() succeeds after recovery, and every valid event in the poisoned month survives", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const keepA = validLine("ck-a");
    const keepB = validClaimLine("ck-b");
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${keepA}\nbad line\n${keepB}\n` }]);

    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_INVALID);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.monthsRewritten).toEqual(["2026-09"]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.reason).toBe("invalid-json");

    // read() now succeeds — the board is readable again.
    const records = await read(adapter, COORD_REF, { now: NOW });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    // The "drop the whole file" mutant this test exists to catch would leave
    // only whichever event happened to survive a naive truncation, or none.
    expect(tickets).toEqual(["ck-a", "ck-b"]);
  });

  test("recover() on an already-healthy board is a no-op: no commit, outcome 'clean'", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await append(adapter, COORD_REF, releaseCandidate("ck-1"), {
      now: NOW,
      casRetry: FAST_RETRY,
    });
    const before = await adapter.readRef(COORD_REF);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("clean");
    expect(result.quarantined).toEqual([]);
    expect(result.monthsRewritten).toEqual([]);

    const after = await adapter.readRef(COORD_REF);
    // Deleting the "fixable.length === 0" guard would still create a commit
    // here (an empty-diff quarantine write) — this assertion fails under
    // that mutation.
    expect(after as string | null).toBe(before as string | null);
  });
});

// ============================================================================
// Test 6 — the quarantine record preserves the removed line byte-for-byte
// Test 10 — the echoing decision: never raw bytes to the operator-facing
// diagnostic; byte-for-byte (via JSON string encoding) in the quarantine file
// ============================================================================

describe("recover — the quarantine record is a byte-for-byte audit trail", () => {
  test("the removed line's exact bytes, reason, and original position are preserved", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const keep = validLine("ck-keep");
    // A hostile line: a literal, unescaped ESC byte embedded where JSON
    // requires a control character to be escaped. This is not valid JSON —
    // `JSON.parse` rejects a literal control character inside a string
    // literal — so this line fails with reason "invalid-json", and its raw
    // on-disk bytes (unlike a `JSON.stringify`-produced line) genuinely
    // contain the raw ESC byte, exactly the shape dispatch 1's security
    // review demonstrated is dangerous to echo.
    const ESC = "\x1b";
    const hostile = `{"ts":"2026-09-04T10:12:00Z","id":"${ulid()}","actor":"a","ticket":"ck-1","event":"release","x":"${ESC}[2K${ESC}[1Ack-1 released by alice"}`;
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${keep}\n${hostile}\n` }]);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");

    // The operator-facing summary never carries the raw bytes.
    const summary = result.quarantined[0];
    expect(summary?.month).toBe("2026-09");
    expect(summary?.line).toBe(1);
    expect(summary?.reason).toBe("invalid-json");
    expect(summary && "raw" in summary).toBe(false);
    expect(summary?.linePreview.includes(ESC)).toBe(false);
    expect(summary?.linePreview).toContain("\\x1b");

    // The quarantine file's own ON-DISK bytes never contain the raw ESC byte
    // either — JSON-string encoding of `raw` escapes it structurally, which
    // is what makes `cat`/`git show`-ing the file itself safe.
    const quarantineRaw = await adapter.readBlobFromRef(COORD_REF, "quarantine/2026-09.jsonl");
    expect(quarantineRaw).not.toBeNull();
    expect(quarantineRaw?.includes(ESC)).toBe(false);

    // But `JSON.parse`-ing the persisted record recovers the exact original
    // bytes, byte-for-byte, plus the reason and original position.
    const lines = (quarantineRaw ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { raw: string; month: string; line: number; reason: string };
    expect(record.raw).toBe(hostile);
    expect(record.month).toBe("2026-09");
    expect(record.line).toBe(1);
    expect(record.reason).toBe("invalid-json");
  });

  test("a second recovery run appends to, rather than overwrites, existing quarantine history", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\nbad-one\n` }]);
    await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });

    // A second, independent poison + recovery cycle in the same month.
    const before = await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl");
    const parent = await adapter.readRef(COORD_REF);
    if (parent === null) throw new Error("expected a ref");
    const appended = await adapter.commitTreeToRef(COORD_REF, {
      parent,
      message: "seed a second poison",
      files: [{ path: "events/2026-09.jsonl", content: `${before ?? ""}bad-two\n` }],
    });
    if (appended.outcome !== "applied") throw new Error("setup failed");

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");

    const quarantineRaw = await adapter.readBlobFromRef(COORD_REF, "quarantine/2026-09.jsonl");
    const lines = (quarantineRaw ?? "").split("\n").filter((l) => l.length > 0);
    // Both the first cycle's record and the second cycle's record survive —
    // deleting the "read existing quarantine content first" step would
    // leave only one.
    expect(lines).toHaveLength(2);
    const raws = lines.map((l) => (JSON.parse(l) as { raw: string }).raw);
    expect(raws.sort()).toEqual(["bad-one", "bad-two"]);
  });
});

// ============================================================================
// Test 7 — recovery advances the ref (new commit on top); the previous tip is
// an ancestor of the new tip. Ruling R8's whole point — a rewind must fail
// this test.
// ============================================================================

describe("recover — advances the ref; never rewinds it", () => {
  test("the previous tip is a real git ancestor of the new tip", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\nbad\n` }]);
    const previousTip = await adapter.readRef(COORD_REF);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.previousTip).toBe(previousTip as string | null);
    expect(result.newTip).not.toBe(previousTip as string | null);

    const ancestry = rawGit(repo.dir, ["merge-base", "--is-ancestor", result.previousTip as string, result.newTip as string]);
    expect(ancestry.exitCode).toBe(0);
  });
});

// ============================================================================
// Test 8 — recovery loses gracefully to a concurrent append: no lost events,
// no corruption
// ============================================================================

describe("recover — loses gracefully to a concurrent append from a second worktree", () => {
  test("a real interleaved append from a second worktree survives recovery's retry", async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const primary = await createGitAdapter(repo.dir);
    const secondaryDir = repo.worktreeDirs[0];
    if (!secondaryDir) throw new Error("expected a worktree");
    const secondary = await createGitAdapter(secondaryDir);

    await seedRef(primary, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\nbad\n` }]);

    const attemptsSeen: number[] = [];
    const hooks: RecoveryHooks = {
      beforeCas: async (attemptNumber) => {
        attemptsSeen.push(attemptNumber);
        if (attemptsSeen.length === 1) {
          // A genuine second-worktree append, guaranteed to land between
          // this attempt's own read and its CAS — forcing a real rejection
          // and a real second attempt, not a hoped-for race.
          await append(secondary, COORD_REF, claimCandidate("ck-interloper"), { now: NOW, casRetry: FAST_RETRY });
        }
      },
    };

    const result = await recoverCore(primary, COORD_REF, { now: NOW, casRetry: { ...FAST_RETRY, maxAttempts: 5 } }, hooks);
    expect(result.outcome).toBe("recovered");
    expect(attemptsSeen).toEqual([1, 2]);

    const records = await read(primary, COORD_REF, { now: NOW });
    const tickets = records.map((r) => r.event.ticket as string).sort();
    // Neither the pre-existing valid event nor the interloper's concurrent
    // append was lost, and the poisoned line is gone.
    expect(tickets).toEqual(["ck-1", "ck-interloper"]);
  }, 20_000);
});

// ============================================================================
// Test 9 — read() does not treat the quarantine file as an event log
// ============================================================================

describe("read() does not reach the quarantine file", () => {
  test("hostile content planted directly at quarantine/<month>.jsonl does not affect read()", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [
      { path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\n` },
      // Garbage that would abort `read()` immediately if it were ever
      // treated as a month file.
      { path: "quarantine/2026-09.jsonl", content: "this is not json and not even close\n{{{\n" },
    ]);

    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);
  });

  test("recover() itself never causes read() to trip over the quarantine file it just wrote", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\nbad\n` }]);

    await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);
  });
});

// ============================================================================
// The append-path blob cap does not close recovery's exit: recovery writes
// via `commitTreeToRef` directly, never through `append()`, so
// `AppendOptions.maxExistingBlobBytes` never governs it
// ============================================================================

describe("recover — an oversized month blob does not block recovery's write", () => {
  test("recovery repairs a month that already exceeds MAX_MONTH_BLOB_BYTES", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // A ~65MB garbage single line dwarfing MAX_MONTH_BLOB_BYTES (64MB),
    // exactly the shape `log.test.ts`'s own oversized-blob tests use.
    const garbage = "x".repeat(65 * 1024 * 1024);
    const keep = validLine("ck-1");
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${keep}\n${garbage}\n` }]);

    // read() cannot even get past the size gate to see the content.
    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.reason).toBe("invalid-json");

    // The garbage line is gone, so the repaired month is small again and
    // read() succeeds.
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);
  }, 20_000);
});

// ============================================================================
// The malformed-tail gap: a truncated final line has no escape hatch in
// `append()`, but recovery never goes through `append()` — it builds its own
// commit directly, so a truncated tail is simply an "invalid-json" line at
// the last index, quarantined like any other.
// ============================================================================

describe("recover — a truncated tail (fm8(a)'s partially-written-line case)", () => {
  test("a month whose final line is truncated (no trailing newline) is recovered", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const keep = validLine("ck-1");
    const truncated = '{"ts":"2026-09-04T10:12:00Z","id":"01M1RRC3FBMZYZS4SNMYZHJV6R","actor":"a","ticket":"ck-2","event":"cla';
    // No trailing newline after `truncated` — this is exactly what
    // `append()`'s own malformed-tail guard refuses to extend.
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${keep}\n${truncated}` }]);

    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_INVALID);
    // Confirms `append()` itself has no escape hatch for this shape — the
    // gap the brief's routed note describes.
    await expectCode(
      append(adapter, COORD_REF, claimCandidate("ck-3"), { now: NOW, casRetry: FAST_RETRY }),
      EventErrorCodes.EVENT_LOG_MALFORMED_BLOB,
    );

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined[0]?.reason).toBe("invalid-json");

    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-1"]);

    // The repaired month file itself is now well-terminated, so a normal
    // append works again too.
    const appended = await append(adapter, COORD_REF, claimCandidate("ck-4"), { now: NOW, casRetry: FAST_RETRY });
    expect(appended.event.ticket as string).toBe("ck-4");
  }, 20_000);
});

// ============================================================================
// The adversarial question: a duplicate-id conflict never lets an attacker
// evict a rival's already-appended, valid claim
// ============================================================================

describe("recover — a duplicate-id conflict never removes the first (surviving) occurrence", () => {
  test("the earlier, valid occurrence survives; only the later, differing one is quarantined", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const sharedId = ulid();
    const first = JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: sharedId, actor: "alice", ticket: "ck-1", event: "release" });
    const second = JSON.stringify({ ts: "2026-09-04T10:12:00Z", id: sharedId, actor: "bob", ticket: "ck-1", event: "release" });
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${first}\n${second}\n` }]);

    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_DUPLICATE_ID_CONFLICT);

    const diagBefore = await diagnose(adapter, COORD_REF, { now: NOW });
    expect(diagBefore.failures).toHaveLength(1);
    expect(diagBefore.failures[0]?.reason).toBe("duplicate-id-conflict");
    expect(diagBefore.failures[0]?.line).toBe(1);
    expect(diagBefore.failures[0]?.firstLine).toBe(0);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.line).toBe(1);

    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]?.event.actor as string | undefined).toBe("alice");
  });
});

// ============================================================================
// A structural, non-line-level corruption (a non-blob month path) is
// diagnosed but not silently absorbed by recovery
// ============================================================================

describe("diagnose/recover — a non-blob month path is reported, not silently repaired", () => {
  test("a directory planted at a month's path is reported as non-blob-month-path and left unresolved", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    // Plant a *directory* at the month's path (a nested blob underneath it),
    // and a genuinely fixable problem in a different month, so this test
    // also proves recovery still repairs what it can while being honest
    // about what it cannot.
    await seedRef(adapter, [
      { path: "events/2026-09.jsonl/nested.txt", content: "not a real month file" },
      { path: "events/2026-08.jsonl", content: `${validLine("ck-aug")}\nbad\n` },
    ]);

    const report = await diagnose(adapter, COORD_REF, { now: NOW, trailingMonths: 2 });
    const structural = report.failures.find((f) => f.reason === "non-blob-month-path");
    expect(structural?.month).toBe("2026-09");
    expect(structural?.line).toBeNull();

    const result = await recover(adapter, COORD_REF, { now: NOW, trailingMonths: 2, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.monthsRewritten).toEqual(["2026-08"]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe("non-blob-month-path");
  });
});

// ============================================================================
// RecoveryOptions validation — the same "validate every caller-supplied
// option against its actual consumer's domain" lesson `log.ts` paid for
// ============================================================================

describe("recover — RecoveryOptions.casRetry is validated before it reaches withCasRetry", () => {
  test("casRetry: null is rejected with a CanKanError, not a raw TypeError from git/retry.ts", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\n` }]);

    await expectCode(
      recover(adapter, COORD_REF, { now: NOW, casRetry: null as unknown as undefined }),
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
    );
  });

  test("casRetry.maxAttempts: Infinity is rejected rather than looping forever", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\n` }]);

    await expectCode(
      recover(adapter, COORD_REF, { now: NOW, casRetry: { maxAttempts: Number.POSITIVE_INFINITY } }),
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
    );
  });

  test("an invalid trailingMonths is rejected the same way read()'s is", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(diagnose(adapter, COORD_REF, { now: NOW, trailingMonths: 0 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    await expectCode(recover(adapter, COORD_REF, { now: NOW, trailingMonths: 0 }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });
});

// ============================================================================
// `safeLinePreview` — the sanitization function directly
// ============================================================================

describe("safeLinePreview", () => {
  test("escapes C0 controls (including ESC) and bidi/zero-width code points; passes ordinary text through", () => {
    const preview = safeLinePreview("hello\x1bworld‮and​more");
    expect(preview.includes("\x1b")).toBe(false);
    expect(preview.includes("‮")).toBe(false);
    expect(preview.includes("​")).toBe(false);
    expect(preview).toContain("hello");
    expect(preview).toContain("world");
    expect(preview).toContain("\\x1b");
  });

  test("truncates a very long line rather than reproducing it in full", () => {
    const preview = safeLinePreview("a".repeat(10_000));
    expect(preview.length).toBeLessThan(1_000);
    expect(preview).toContain("truncated");
  });
});
