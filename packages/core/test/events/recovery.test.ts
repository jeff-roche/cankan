import { chmodSync, statSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { monotonicFactory } from "ulid";
import { isCanKanError } from "../../src/errors";
import { createGitAdapter, GitErrorCodes, type GitAdapter } from "../../src/git/index";
import { append, type EventCandidate, read } from "../../src/events/log";
import { EventErrorCodes } from "../../src/events/errors";
import {
  diagnose,
  MAX_QUARANTINE_RAW_BYTES_PER_RECORD,
  MAX_QUARANTINE_RUN_BUDGET_BYTES,
  QUARANTINE_ESCAPE_EXPANSION_FACTOR,
  QUARANTINE_RECORD_OVERHEAD_BYTES,
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

/** Same as `rawGit`, but feeds raw bytes on stdin — the only way to plant content that is not valid UTF-8 (a JS string cannot hold it; `GitAdapter`'s own `commitTreeToRef` only accepts string content). Fix round 1, Ruling R44's tests use this. */
function rawGitBytes(cwd: string, args: string[], stdin: Buffer): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Seeds `content` (raw bytes, possibly not valid UTF-8) at `path` via low-level git plumbing, bypassing `GitAdapter` entirely (it has no way to accept non-UTF-8 content) — a real commit, real objects, on a fresh `COORD_REF`. */
function seedRawBytes(repoDir: string, path: string, content: Buffer): void {
  const blobSha = rawGitBytes(repoDir, ["hash-object", "-w", "--stdin"], content).stdout.trim();
  const treeResult = rawGit(repoDir, ["read-tree", "--empty"]);
  if (treeResult.exitCode !== 0) throw new Error(`read-tree failed: ${treeResult.stderr}`);
  const updateResult = rawGit(repoDir, ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${path}`]);
  if (updateResult.exitCode !== 0) throw new Error(`update-index failed: ${updateResult.stderr}`);
  const treeSha = rawGit(repoDir, ["write-tree"]).stdout.trim();
  const commitSha = rawGit(repoDir, ["commit-tree", "-m", "seed raw bytes", treeSha]).stdout.trim();
  const refResult = rawGit(repoDir, ["update-ref", COORD_REF, commitSha]);
  if (refResult.exitCode !== 0) throw new Error(`update-ref failed: ${refResult.stderr}`);
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
    const qPath = summary?.path ?? "";
    expect(qPath).toMatch(/^quarantine\/2026-09\/.+\.jsonl$/);
    const quarantineRaw = await adapter.readBlobFromRef(COORD_REF, qPath);
    expect(quarantineRaw).not.toBeNull();
    expect(quarantineRaw?.includes(ESC)).toBe(false);

    // But `JSON.parse`-ing the persisted record recovers the exact original
    // bytes, byte-for-byte, plus the reason and original position.
    const lines = (quarantineRaw ?? "").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { raw: string; month: string; line: number; reason: string; rawTruncated: boolean };
    expect(record.raw).toBe(hostile);
    expect(record.month).toBe("2026-09");
    expect(record.line).toBe(1);
    expect(record.reason).toBe("invalid-json");
    expect(record.rawTruncated).toBe(false);

    // Fix round 1's invariant: an empty `unresolved` means read() succeeds.
    expect(result.unresolved).toEqual([]);
    await read(adapter, COORD_REF, { now: NOW });
  });

  // Fix round 2 (Ruling R45(b)): replaces the old "appends to, rather than
  // overwrites" test, whose whole premise (one ever-growing
  // `quarantine/<month>.jsonl` file) was itself the NEW-1 defect — see
  // `quarantineDirPath`'s doc comment. The regression this test now guards:
  // a second, independent recovery cycle must not lose the first cycle's
  // audit record, which per-call files achieve by writing a *distinct* new
  // file rather than by appending onto a shared one.
  test("a second, independent recovery cycle writes its own new quarantine file, never overwriting or losing the first", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\nbad-one\n` }]);
    const first = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(first.outcome).toBe("recovered");
    const firstPath = first.quarantined[0]?.path ?? "";

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

    const second = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(second.outcome).toBe("recovered");
    expect(second.unresolved).toEqual([]);
    // Fix round 1's invariant: an empty `unresolved` means read() succeeds.
    await read(adapter, COORD_REF, { now: NOW });

    const secondPath = second.quarantined[0]?.path ?? "";
    // Two distinct files, not one shared, ever-growing one.
    expect(secondPath).not.toBe(firstPath);

    const firstRaw = await adapter.readBlobFromRef(COORD_REF, firstPath);
    const secondRaw = await adapter.readBlobFromRef(COORD_REF, secondPath);
    expect(firstRaw).not.toBeNull();
    expect(secondRaw).not.toBeNull();
    const firstRecord = JSON.parse((firstRaw ?? "").split("\n")[0] ?? "{}") as { raw: string };
    const secondRecord = JSON.parse((secondRaw ?? "").split("\n")[0] ?? "{}") as { raw: string };
    // Both the first cycle's record and the second cycle's record survive,
    // each in its own file — deleting the "write a new file per call"
    // design (reverting to one shared, appended-to file) would fail this
    // assertion by making the two paths identical.
    expect([firstRecord.raw, secondRecord.raw].sort()).toEqual(["bad-one", "bad-two"]);
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

    // Fix round 1's invariant: an empty `unresolved` means read() succeeds.
    expect(result.unresolved).toEqual([]);
    await read(adapter, COORD_REF, { now: NOW });
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
    // Fix round 1 (Ruling R42): the size gate now runs before parseEvent,
    // exactly like read()'s own obligation-A ordering — so a line this
    // oversized is "line-too-large", not "invalid-json", regardless of
    // whether its content would otherwise have parsed.
    expect(result.quarantined[0]?.reason).toBe("line-too-large");
    // Fix round 1 (Critical 3/4): once the garbage is gone, the rebuilt
    // month is well under MAX_MONTH_BLOB_BYTES, so no unresolved
    // blob-too-large entry should linger for it.
    expect(result.unresolved).toEqual([]);

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
    expect(result.unresolved).toEqual([]);

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
    // Fix round 1, High (Ruling R43): a structured remediation field, not
    // only prose buried in `message` — an operator (or M3.9's `doctor`)
    // reads a field, not a sentence.
    expect(structural?.remediation).toContain("events/2026-09.jsonl");
    expect(structural?.remediation).toMatch(/git/);

    const result = await recover(adapter, COORD_REF, { now: NOW, trailingMonths: 2, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.monthsRewritten).toEqual(["2026-08"]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe("non-blob-month-path");
    // read() genuinely still refuses this board — the fixable 2026-08 poison
    // is gone, but 2026-09's structural corruption remains.
    await expectCode(read(adapter, COORD_REF, { now: NOW, trailingMonths: 2 }), GitErrorCodes.GIT_BLOB_AMBIGUOUS);
  });

  test("a board whose ONLY problem is unresolved reports 'unrepairable', never 'clean'", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl/nested.txt", content: "not a real month file" }]);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    // Fix round 1, Critical 4: nothing was fixable this call, but the board
    // is still unreadable — "clean" would be a lie.
    expect(result.outcome).toBe("unrepairable");
    expect(result.monthsRewritten).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe("non-blob-month-path");

    // No commit was made — a no-op recovery, even an unrepairable one, must
    // not mutate history.
    const after = await adapter.readRef(COORD_REF);
    expect((after as string | null)).toBe(result.newTip);
    expect(result.previousTip).toBe(result.newTip);

    await expectCode(read(adapter, COORD_REF, { now: NOW }), GitErrorCodes.GIT_BLOB_AMBIGUOUS);
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

  test("fix round 1, Low: also escapes U+2028/U+2029 and a lone surrogate", () => {
    const loneHighSurrogate = "\ud800"; // never paired with a low surrogate
    const preview = safeLinePreview(`a b c${loneHighSurrogate}d`);
    expect(preview.includes(" ")).toBe(false);
    expect(preview.includes(" ")).toBe(false);
    expect(preview.includes(loneHighSurrogate)).toBe(false);
    expect(preview).toContain("\\u{2028}");
    expect(preview).toContain("\\u{2029}");
    expect(preview).toContain("\\u{d800}");
  });
});

// ============================================================================
// Fix round 1 (orchestrator security + code review) — Critical 1: unbounded
// per-line failure/quarantine objects
// ============================================================================

describe("diagnose/recover — fix round 1, Critical 1: coalescing bounds a repeated-identical-line DoS", () => {
  test("100,000 identical invalid lines coalesce into one failure and a small quarantine record", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const NEWLINE_COUNT = 100_000;
    // Before the fix, this content produced one DiagnosticFailure and one
    // QuarantineRecord *per line* — 100,000 of each, and a ~24MB quarantine
    // blob (confirmed directly against the pre-fix code: see
    // task-4-report.md's fix-round-1 addendum). After coalescing, this is
    // one failure and one record, regardless of `NEWLINE_COUNT`.
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: "\n".repeat(NEWLINE_COUNT) }]);

    const report = await diagnose(adapter, COORD_REF, { now: NOW });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toBe("invalid-json");
    expect(report.failures[0]?.line).toBe(0);
    expect(report.failures[0]?.endLine).toBe(NEWLINE_COUNT - 1);
    expect(report.failures[0]?.count).toBe(NEWLINE_COUNT);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.count).toBe(NEWLINE_COUNT);

    const qPath = result.quarantined[0]?.path ?? "";
    const quarantineRaw = await adapter.readBlobFromRef(COORD_REF, qPath);
    // One coalesced record for a byte-identical (empty-string) span is a few
    // hundred bytes; the pre-fix code produced ~24MB for this same input —
    // this assertion fails under the "delete coalescing" mutation.
    expect(Buffer.byteLength(quarantineRaw ?? "", "utf8")).toBeLessThan(1024);

    expect(result.unresolved).toEqual([]);
    await read(adapter, COORD_REF, { now: NOW });
  }, 20_000);
});

describe("diagnose/recover — fix round 1, Critical 1: a failure-count cap bounds many DISTINCT bad lines", () => {
  test("exceeding MAX_DIAGNOSTIC_FAILURES truncates the walk (reported honestly), and a second pass finishes the job", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const DISTINCT_BAD_LINES = 5010; // > this module's MAX_DIAGNOSTIC_FAILURES (5000); coalescing cannot help since every line differs
    const lines: string[] = [];
    for (let i = 0; i < DISTINCT_BAD_LINES; i++) {
      lines.push(`not json ${i}`);
    }
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${lines.join("\n")}\n` }]);

    const report = await diagnose(adapter, COORD_REF, { now: NOW });
    const truncatedMarker = report.failures.filter((f) => f.reason === "diagnostic-truncated");
    expect(truncatedMarker).toHaveLength(1);
    expect(report.failures.filter((f) => f.reason !== "diagnostic-truncated")).toHaveLength(5000);

    const firstPass = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(firstPass.outcome).toBe("recovered");
    expect(firstPass.quarantined).toHaveLength(5000);
    expect(firstPass.unresolved.some((f) => f.reason === "diagnostic-truncated")).toBe(true);

    // One pass was not enough — the remaining 10 lines were never even
    // scanned (truncated before reaching them), so read() still refuses.
    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_INVALID);

    const secondPass = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(secondPass.outcome).toBe("recovered");
    expect(secondPass.quarantined).toHaveLength(10);
    expect(secondPass.unresolved).toEqual([]);

    await read(adapter, COORD_REF, { now: NOW });
  }, 30_000);
});

// ============================================================================
// Fix round 1 — Critical 2: a pre-planted path could disarm every future
// recovery
// ============================================================================

describe("recover — fix round 1/2, Critical 2 & NEW-1 case 3: a blocked quarantine path is a typed error, never a silent deletion", () => {
  // Fix round 2 (Ruling R45(b)): per-call files mean the *old*,
  // deterministic `quarantine/<month>.jsonl` path is no longer written to
  // at all — a blob there is now a harmless sibling of the
  // `quarantine/<month>/` directory, not a conflict. This test replaces
  // the old "a tree planted at the exact quarantine/<month>.jsonl path
  // throws" test, whose premise no longer applies, and instead proves the
  // point directly: recovery proceeds normally even with such a blob
  // present (the reproduced NEW-1 case 3 construction — a pre-planted
  // large blob at exactly this old-style path — is inert under the new
  // layout for the same reason).
  test("a blob at the old-style quarantine/<month>.jsonl path is inert — recovery proceeds normally", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [
      { path: "events/2026-09.jsonl", content: "bad line\n" },
      { path: "quarantine/2026-09.jsonl", content: "x".repeat(1024) },
    ]);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.unresolved).toEqual([]);
    await read(adapter, COORD_REF, { now: NOW });

    // The old-style blob survives untouched — recovery never reads or
    // writes it.
    const untouched = await adapter.readBlobFromRef(COORD_REF, "quarantine/2026-09.jsonl");
    expect(untouched).toBe("x".repeat(1024));
  });

  // Fix round 2 (NEW-1 remediation): the real remaining conflict shape one
  // level down from the top-level path — a blob planted at the *bare*
  // `quarantine/<month>` path (no file suffix) conflicts with this month's
  // per-call file, since git cannot represent one path as both a blob and
  // a directory prefix. Unlike the per-call file's own randomized name,
  // this bare path is deterministic and therefore pre-plantable.
  test("a blob planted at the bare quarantine/<month> path throws EVENT_RECOVERY_QUARANTINE_BLOCKED, with no partial write", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [
      { path: "events/2026-09.jsonl", content: "bad line\n" },
      { path: "quarantine/2026-09", content: "occupying the per-month quarantine directory path" },
    ]);
    const before = await adapter.readRef(COORD_REF);

    await expectCode(recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY }), EventErrorCodes.EVENT_RECOVERY_QUARANTINE_BLOCKED);

    // Refused loudly, before any write — never a silent rewrite of the
    // month file without its matching audit record.
    const after = await adapter.readRef(COORD_REF);
    expect(after as string | null).toBe(before as string | null);
  });

  test("a blob planted at the literal top-level quarantine path throws EVENT_RECOVERY_QUARANTINE_BLOCKED, with no partial write", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [
      { path: "events/2026-09.jsonl", content: "bad line\n" },
      { path: "quarantine", content: "x" },
    ]);
    const before = await adapter.readRef(COORD_REF);

    await expectCode(recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY }), EventErrorCodes.EVENT_RECOVERY_QUARANTINE_BLOCKED);

    const after = await adapter.readRef(COORD_REF);
    expect(after as string | null).toBe(before as string | null);
  });

  test("control: nothing planted at the quarantine path — recovery proceeds normally", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: "bad line\n" }]);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.unresolved).toEqual([]);
    await read(adapter, COORD_REF, { now: NOW });
  });
});

// ============================================================================
// Fix round 1 — Critical 3 (Ruling R42): diagnose() must model read()'s full
// failure surface, at read()'s own real bounds
// ============================================================================

describe("diagnose/recover — fix round 1, Critical 3: line-too-large is fixable, at read()'s real bound", () => {
  test("a >1MiB but schema-valid line is fixable, and read() succeeds after recovery", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const padding = " ".repeat(1_100_000);
    const keep = validLine("ck-keep");
    const oversizedButValid = `${padding}${validLine("ck-oversized")}`;
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${keep}\n${oversizedButValid}\n` }]);

    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_TOO_LARGE);

    const report = await diagnose(adapter, COORD_REF, { now: NOW });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toBe("line-too-large");

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined[0]?.reason).toBe("line-too-large");
    expect(result.unresolved).toEqual([]);

    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-keep"]);
  });
});

describe("diagnose/recover — fix round 1, Critical 3/4: a blob-too-large month of entirely valid content is 'unrepairable', never silently 'clean'", () => {
  test("a 65MiB month of entirely valid lines is reported unresolved, and read() still refuses it afterward", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const mint = monotonicFactory();
    const bigComment = "y".repeat(9_000);
    const buildLine = () =>
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", id: mint(NOW), actor: "alice", ticket: "ck-1", event: "comment", text: bigComment });
    const sample = `${buildLine()}\n`;
    const linesNeeded = Math.ceil((65 * 1024 * 1024) / Buffer.byteLength(sample, "utf8"));
    const lines: string[] = [];
    for (let i = 0; i < linesNeeded; i++) lines.push(buildLine());
    const content = `${lines.join("\n")}\n`;

    await seedRef(adapter, [{ path: "events/2026-01.jsonl", content }]);
    const readNow = Date.parse("2026-01-15T00:00:00Z");

    await expectCode(read(adapter, COORD_REF, { now: readNow, trailingMonths: 1 }), EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE);

    const report = await diagnose(adapter, COORD_REF, { now: readNow, trailingMonths: 1 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toBe("blob-too-large");

    const result = await recover(adapter, COORD_REF, { now: readNow, trailingMonths: 1, casRetry: FAST_RETRY });
    // Before the fix: nothing was fixable (every line is genuinely valid),
    // so this reported "clean" even though read() still throws. Now: the
    // unresolved blob-too-large finding makes this "unrepairable".
    expect(result.outcome).toBe("unrepairable");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe("blob-too-large");
    expect(result.monthsRewritten).toEqual([]);

    await expectCode(read(adapter, COORD_REF, { now: readNow, trailingMonths: 1 }), EventErrorCodes.EVENT_LOG_BLOB_TOO_LARGE);
  }, 30_000);
});

describe("diagnose/recover — fix round 1, Critical 3/Medium: aggregate-too-large fires once, in read()'s own vocabulary", () => {
  test("five ~55MB all-valid months exceed the real aggregate cap; reported once, and does not block being 'unrepairable' rather than 'clean'", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const REAL_ULID = "01M1RRC3FBMZYZS4SNMYZHJV6R";
    const bigOutput = "y".repeat(90_000);
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
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
    await seedRef(
      adapter,
      months.map((month) => ({ path: `events/${month}.jsonl`, content: monthContent })),
    );

    const now = Date.parse("2026-05-15T00:00:00Z");
    await expectCode(read(adapter, COORD_REF, { now, trailingMonths: 5 }), EventErrorCodes.EVENT_LOG_AGGREGATE_TOO_LARGE);

    const report = await diagnose(adapter, COORD_REF, { now, trailingMonths: 5 });
    const aggregateFailures = report.failures.filter((f) => f.reason === "aggregate-too-large");
    // Fires exactly once — the fix round 1 Medium ("aggregate-bound
    // cascade") this closes would otherwise report it again for every
    // subsequent month once the cumulative sum has crossed the bound.
    expect(aggregateFailures).toHaveLength(1);
    // And it names the whole window's own aggregate figure, not a
    // per-month size masquerading as one.
    expect(aggregateFailures[0]?.message).toContain("aggregated");

    const result = await recover(adapter, COORD_REF, { now, trailingMonths: 5, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("unrepairable");
    expect(result.unresolved.some((f) => f.reason === "aggregate-too-large")).toBe(true);
  }, 90_000);
});

// ============================================================================
// Fix round 1 — Medium (Ruling R44): "byte-for-byte" is honestly qualified
// ============================================================================

describe("recover — fix round 1, Ruling R44: possiblyLossy names lossy UTF-8 decoding honestly", () => {
  test("a line that was not valid UTF-8 on disk is flagged possiblyLossy end to end", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const keepLine = validLine("ck-keep");
    // Real invalid UTF-8 bytes (0xFF 0xFE are never valid UTF-8) — confirmed
    // directly (task-4-report.md's fix-round-1 addendum) that
    // `GitAdapter.readBlobFromRef` hands this module back two literal
    // U+FFFD characters in their place, not the original bytes.
    const invalidUtf8AndNewline = Buffer.from([0xff, 0xfe, 0x0a]);
    const combined = Buffer.concat([invalidUtf8AndNewline, Buffer.from(`${keepLine}\n`, "utf8")]);
    seedRawBytes(repo.dir, "events/2026-09.jsonl", combined);

    const report = await diagnose(adapter, COORD_REF, { now: NOW });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toBe("invalid-json");
    expect(report.failures[0]?.possiblyLossy).toBe(true);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined[0]?.possiblyLossy).toBe(true);
    expect(result.monthsWithPossibleEncodingLoss).toEqual(["2026-09"]);

    const qPath = result.quarantined[0]?.path ?? "";
    const quarantineRaw = await adapter.readBlobFromRef(COORD_REF, qPath);
    const record = JSON.parse((quarantineRaw ?? "").split("\n")[0] ?? "{}") as { possiblyLossy: boolean; raw: string };
    expect(record.possiblyLossy).toBe(true);
    // What this module received, preserved exactly (a real limitation, not
    // a silent one: this is U+FFFD, not the original two bytes, which were
    // already gone by the time `readBlobFromRef` returned).
    expect(record.raw.includes("�")).toBe(true);

    expect(result.unresolved).toEqual([]);
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-keep"]);
  });

  test("the sharper half: a KEPT, otherwise-valid event sharing a month with a real poison line is still flagged when it also contains lossy bytes", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const id = ulid();
    // A genuinely bad line (triggers the month's rewrite) — no lossy bytes
    // of its own.
    const badLine = Buffer.from("not json\n", "utf8");
    // A schema-valid `comment` event whose `text` field's raw bytes are not
    // valid UTF-8 — after the adapter's lossy decode, `text` becomes two
    // U+FFFD characters, which is a perfectly legal (if odd) string, so
    // this line still parses and validates as a normal, KEPT event. Recovery
    // never targets it — but it silently carries altered content, which is
    // exactly what `monthsWithPossibleEncodingLoss` exists to disclose.
    const prefix = Buffer.from(
      `{"ts":"2026-09-04T10:12:00Z","id":"${id}","actor":"a","ticket":"ck-1","event":"comment","text":"`,
      "utf8",
    );
    const invalidBytes = Buffer.from([0xff, 0xfe]);
    const suffix = Buffer.from('"}\n', "utf8");
    const keptLineBytes = Buffer.concat([prefix, invalidBytes, suffix]);
    seedRawBytes(repo.dir, "events/2026-09.jsonl", Buffer.concat([badLine, keptLineBytes]));

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    // Only the genuinely bad line was quarantined — the comment event was
    // valid and was kept, not flagged as a failure.
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.possiblyLossy).toBe(false);
    // But the month itself is still disclosed as possibly lossy, because of
    // the KEPT line, not the removed one — deleting the "check kept lines
    // too" half of the rebuild loop's lossy check would fail this
    // assertion.
    expect(result.monthsWithPossibleEncodingLoss).toEqual(["2026-09"]);

    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records).toHaveLength(1);
    const keptEvent = records[0]?.event as { text?: string } | undefined;
    expect(keptEvent?.text?.includes("�")).toBe(true);
  });
});

// ============================================================================
// Fix round 1 — Lows: Symbol-safe error messages, a non-object casRetry,
// options.now's own type
// ============================================================================

describe("recover — fix round 1, Low: every caller-supplied option is validated against its actual runtime type, not just its declared one", () => {
  test("a non-object casRetry is rejected, not silently treated as 'no overrides'", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: "bad\n" }]);

    await expectCode(
      recover(adapter, COORD_REF, { now: NOW, casRetry: "bogus" as unknown as never }),
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
    );
  });

  test("a Symbol-valued casRetry.maxAttempts surfaces as a CanKanError, not a raw TypeError from a Symbol-in-a-template-literal", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: "bad\n" }]);

    // Before the fix: `${maxAttempts}` inside the error message's own
    // template literal throws `TypeError: Cannot convert a Symbol value to
    // a string` while *constructing* the CanKanError meant to report the
    // problem — expectCode's own `isCanKanError` check catches this
    // regression (a raw TypeError is not a CanKanError).
    await expectCode(
      recover(adapter, COORD_REF, { now: NOW, casRetry: { maxAttempts: Symbol("x") as unknown as number } }),
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
    );
  });

  test("a Symbol returned by a caller's backoffMs, hit via a real forced retry, surfaces as a CanKanError", async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const primary = await createGitAdapter(repo.dir);
    const secondaryDir = repo.worktreeDirs[0];
    if (!secondaryDir) throw new Error("expected a worktree");
    const secondary = await createGitAdapter(secondaryDir);
    await seedRef(primary, [{ path: "events/2026-09.jsonl", content: "bad\n" }]);

    const hooks: RecoveryHooks = {
      beforeCas: async (attemptNumber) => {
        if (attemptNumber === 1) {
          await append(secondary, COORD_REF, claimCandidate("ck-interloper"), { now: NOW, casRetry: FAST_RETRY });
        }
      },
    };

    await expectCode(
      recoverCore(
        primary,
        COORD_REF,
        { now: NOW, casRetry: { maxAttempts: 3, backoffMs: () => Symbol("x") as unknown as number, sleep: async () => {} } },
        hooks,
      ),
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
    );
  }, 20_000);

  test("options.now as a Symbol is rejected by diagnose() and recover(), not forwarded into log.ts unguarded", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await expectCode(diagnose(adapter, COORD_REF, { now: Symbol("x") as unknown as number }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
    await expectCode(recover(adapter, COORD_REF, { now: Symbol("x") as unknown as number }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
  });

  // Fix round 2, Low (NEW-5): a default parameter does not apply to an
  // explicit `null` — only to `undefined`.
  test("an explicit null options argument is normalized, not a raw TypeError", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validLine("ck-1")}\n` }]);

    // Before the fix: `options.now` on a `null` options argument throws a
    // raw `TypeError: Cannot read properties of null`, not a `CanKanError`
    // — `diagnose`/`recover` would both reject with something
    // `isCanKanError` does not recognize. Passing `now: NOW` explicitly, via
    // a *second*, separate argument shape, is not possible here since the
    // whole point is exercising the `null`-as-the-whole-options-object
    // case — both calls fall back to `Date.now()`/`DEFAULT_TRAILING_MONTHS`
    // internally, which is fine: this test only asserts neither call
    // throws a raw, non-`CanKanError` exception.
    await diagnose(adapter, COORD_REF, null);
    await recover(adapter, COORD_REF, null);
  });

  // Fix round 2, Low (NEW-6): `typeof [] === "object"` and `[] !== null`,
  // so an array previously passed the non-object check silently.
  test("an array-valued casRetry is rejected, not silently treated as 'no overrides'", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: "bad\n" }]);

    await expectCode(
      recover(adapter, COORD_REF, { now: NOW, casRetry: [] as unknown as never }),
      EventErrorCodes.EVENT_RECOVERY_INVALID_OPTION,
    );
  });
});

// ============================================================================
// Fix round 2 (orchestrator security + code review, Ruling R45) — NEW-1: fix
// round 1's own `EVENT_RECOVERY_QUARANTINE_TOO_LARGE` guard was itself a
// permanent-wedge defect
// ============================================================================

describe("recovery — fix round 2, Ruling R45: quarantine-budget constants satisfy their own required invariant", () => {
  test("one maximally-truncated record's worst-case estimated contribution stays comfortably under the run budget", () => {
    // See `MAX_QUARANTINE_RUN_BUDGET_BYTES`'s doc comment: this is the
    // exact relationship that must hold for the final, defense-in-depth
    // safety-net check in `recoverCore` to be provably unreachable under
    // normal operation, and for `recordLineFailure`'s "always let the
    // triggering span through" policy to never itself dominate the budget.
    const worstCaseRecordContribution = MAX_QUARANTINE_RAW_BYTES_PER_RECORD * QUARANTINE_ESCAPE_EXPANSION_FACTOR + QUARANTINE_RECORD_OVERHEAD_BYTES;
    expect(worstCaseRecordContribution).toBeLessThan(MAX_QUARANTINE_RUN_BUDGET_BYTES);
    // Comfortably under, not just under — at least 2x headroom, so even a
    // single record that alone crosses the budget cannot make one run's
    // actual write disproportionately large relative to its stated budget.
    expect(worstCaseRecordContribution * 2).toBeLessThan(MAX_QUARANTINE_RUN_BUDGET_BYTES);
  });
});

describe("recover — fix round 2, Ruling R45(a): a single line's raw content is truncated before embedding, never embedded in full past MAX_QUARANTINE_RAW_BYTES_PER_RECORD", () => {
  test("a >8 MiB adversarial line is truncated in the quarantine record, disclosed via rawTruncated, and read() succeeds after recovery", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const keep = validLine("ck-keep");
    // 9 MiB of a single control byte — well over both read()'s 1 MiB line
    // cap (so this is "line-too-large", fixable per Ruling R42) and this
    // module's own `MAX_QUARANTINE_RAW_BYTES_PER_RECORD` (8 MiB). This is
    // the exact shape NEW-1 case 1 exploited (there, 45 MiB of `\x01`
    // bytes, whose JSON-escaped form alone — ~283 MB — exceeded fix round
    // 1's own bound and permanently wedged the ref); scaled down here for
    // test speed, since the mechanism under test does not depend on the
    // exact size.
    const poison = "\x01".repeat(9 * 1024 * 1024);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${keep}\n${poison}\n` }]);

    const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(result.outcome).toBe("recovered");
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.reason).toBe("line-too-large");
    expect(result.quarantined[0]?.rawTruncated).toBe(true);
    // The full original length is still disclosed, even though the raw
    // bytes themselves are not repeated in full.
    expect(result.quarantined[0]?.lineBytes).toBe(Buffer.byteLength(poison, "utf8"));

    const qPath = result.quarantined[0]?.path ?? "";
    const quarantineRaw = await adapter.readBlobFromRef(COORD_REF, qPath);
    const record = JSON.parse((quarantineRaw ?? "").split("\n")[0] ?? "{}") as { raw: string; rawTruncated: boolean };
    expect(record.rawTruncated).toBe(true);
    expect(record.raw.length).toBeLessThan(poison.length);
    // Bounded, not unbounded — the entire point of the truncation: the
    // record's own on-disk size stays a small, predictable multiple of
    // `MAX_QUARANTINE_RAW_BYTES_PER_RECORD`, never proportional to the
    // original line's own size (which, in NEW-1's real construction, was
    // 45 MiB and produced a ~283 MB record).
    expect(Buffer.byteLength(quarantineRaw ?? "", "utf8")).toBeLessThan(70 * 1024 * 1024);

    expect(result.unresolved).toEqual([]);
    const records = await read(adapter, COORD_REF, { now: NOW });
    expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-keep"]);
  }, 30_000);
});

describe("recover — fix round 2, Ruling R45(b): repeated recovery cycles never accumulate into a shared, ever-growing quarantine file", () => {
  test("three successive recovery cycles against a board holding a live claim each write an independent file, and none is wedged by the others' history", async () => {
    // This is the shape NEW-1 case 2 reproduced against fix round 1: three
    // successive real pushes recovered twice (growing one shared,
    // append-only quarantine file to 120 MiB then 240 MiB), then
    // permanently failed on the third, orphaning a live claim. Per-call
    // files (Ruling R45(b)) mean no call ever reads or grows what an
    // earlier call wrote, so this can no longer happen regardless of how
    // many cycles run.
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${validClaimLine("ck-live")}\nbad-1\n` }]);

    const paths: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
      expect(result.outcome).toBe("recovered");
      expect(result.unresolved).toEqual([]);
      const p = result.quarantined[0]?.path;
      if (p === undefined) throw new Error("expected a quarantine path");
      paths.push(p);

      // The live claim survives every cycle — recovery never touches it.
      const records = await read(adapter, COORD_REF, { now: NOW });
      expect(records.map((r) => r.event.ticket as string)).toEqual(["ck-live"]);

      if (cycle < 2) {
        // Seed a fresh, independent poison for the next cycle.
        const before = await adapter.readBlobFromRef(COORD_REF, "events/2026-09.jsonl");
        const parent = await adapter.readRef(COORD_REF);
        if (parent === null) throw new Error("expected a ref");
        const appended = await adapter.commitTreeToRef(COORD_REF, {
          parent,
          message: "seed the next poison",
          files: [{ path: "events/2026-09.jsonl", content: `${before ?? ""}bad-${cycle + 2}\n` }],
        });
        if (appended.outcome !== "applied") throw new Error("setup failed");
      }
    }

    // Every cycle wrote its own distinct file — never one shared,
    // ever-growing path.
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) {
      const raw = await adapter.readBlobFromRef(COORD_REF, p);
      expect(raw).not.toBeNull();
    }
  }, 20_000);
});

describe("diagnose/recover — fix round 2, Ruling R45(a): a quarantine-audit-size budget bounds many DISTINCT large lines, converging over more than one pass", () => {
  test("five distinct >8 MiB lines exceed the run budget after four; a second pass finishes the job", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    const LINE_BYTES = 8.5 * 1024 * 1024;
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Distinct single-byte content per line — never coalesces, and each
      // is well over both read()'s 1 MiB line cap and this module's own
      // 8 MiB per-record raw cap, so each contributes this module's own
      // worst-case per-record estimate to the run budget.
      lines.push(String.fromCharCode(65 + i).repeat(LINE_BYTES));
    }
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: `${lines.join("\n")}\n` }]);

    const report = await diagnose(adapter, COORD_REF, { now: NOW });
    const truncatedMarker = report.failures.filter((f) => f.reason === "diagnostic-truncated");
    expect(truncatedMarker).toHaveLength(1);
    // Distinguishes this truncation cause from the count-cap one (a
    // different message) — proves the budget check, not the unrelated
    // MAX_DIAGNOSTIC_FAILURES cap, is what stopped the walk here.
    expect(truncatedMarker[0]?.message).toContain("budget");
    const realFailures = report.failures.filter((f) => f.reason !== "diagnostic-truncated");
    expect(realFailures).toHaveLength(4);
    expect(realFailures.every((f) => f.reason === "line-too-large")).toBe(true);

    const firstPass = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(firstPass.outcome).toBe("recovered");
    expect(firstPass.quarantined).toHaveLength(4);
    expect(firstPass.quarantined.every((q) => q.rawTruncated)).toBe(true);
    expect(firstPass.unresolved.some((f) => f.reason === "diagnostic-truncated")).toBe(true);

    // One pass was not enough — the 5th line was never even scanned
    // (truncated before reaching it), so read() still refuses.
    await expectCode(read(adapter, COORD_REF, { now: NOW }), EventErrorCodes.EVENT_LOG_LINE_TOO_LARGE);

    const secondPass = await recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY });
    expect(secondPass.outcome).toBe("recovered");
    expect(secondPass.quarantined).toHaveLength(1);
    expect(secondPass.unresolved).toEqual([]);

    await read(adapter, COORD_REF, { now: NOW });
  }, 60_000);
});

// ============================================================================
// Fix round 2 — NEW-2: an unrelated git-level failure must never be
// misdiagnosed as a blocked quarantine path
// ============================================================================

describe("recover — fix round 2, NEW-2: an unrelated git-level failure is never misdiagnosed as a blocked quarantine path", () => {
  test("a read-only object store makes the commit fail with GIT_COMMAND_FAILED, not EVENT_RECOVERY_QUARANTINE_BLOCKED", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    await seedRef(adapter, [{ path: "events/2026-09.jsonl", content: "bad line\n" }]);

    // Before the fix: fix round 1's catch around `commitTreeToRef` relabeled
    // *any* `GIT_COMMAND_FAILED` there as `EVENT_RECOVERY_QUARANTINE_BLOCKED`
    // — including one with nothing to do with a blocked quarantine path,
    // like this one (confirmed directly: `git hash-object -w --stdin`
    // against a read-only `.git/objects` fails with "insufficient
    // permission for adding an object to repository database").
    const objectsDir = `${repo.dir}/.git/objects`;
    const originalMode = statSync(objectsDir).mode;
    chmodSync(objectsDir, 0o555);
    try {
      await expectCode(recover(adapter, COORD_REF, { now: NOW, casRetry: FAST_RETRY }), GitErrorCodes.GIT_COMMAND_FAILED);
    } finally {
      chmodSync(objectsDir, originalMode);
    }
  });
});
