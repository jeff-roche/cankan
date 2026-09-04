#!/usr/bin/env bun
// M1.1 coordination-ref spike. Runs the six survivability scenarios from
// `.superpowers/sdd/m1-phase/task-1-brief.md` against real temp repos and
// real OS processes, and writes `RESULTS.md` next to this file.
//
// Usage: bun spikes/coordination-ref/run.ts
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { platform, release, type as osType } from "node:os";
import { join } from "node:path";
import { makeTempRepo } from "../../packages/test-utils/src/index";
import {
  COORD_REF,
  type ClaimEvent,
  claimViaCAS,
  eventFilePath,
  findClaim,
  initCoordinationRef,
  readEventsAt,
} from "./coordination";
import { git, gitOrThrow, readRef } from "./git-plumbing";
import { type EnvInfo, renderResults, type ScenarioRecord } from "./report";

interface WorkerSuccess {
  outcome: "claimed" | "already_claimed";
  attempts: number;
  event: ClaimEvent;
  finalRef: string;
  casFailures: string[];
  lockWaitMs?: number;
}
interface WorkerFailure {
  outcome: "error" | "lock_timeout";
  error: string;
}
type WorkerResult = WorkerSuccess | WorkerFailure;

function isSuccess(r: WorkerResult): r is WorkerSuccess {
  return r.outcome === "claimed" || r.outcome === "already_claimed";
}

async function timeIt<T>(
  fn: () => Promise<T> | T,
): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Spawns a worker script as a real OS process and collects its output. */
function spawnWorker(
  scriptRelPath: string,
  args: string[],
): { done: Promise<{ stdout: string; stderr: string; exitCode: number }> } {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, scriptRelPath), ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const done = (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();
  return { done };
}

function parseWorkerResult(stdout: string): WorkerResult {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  const last = lines.at(-1);
  if (!last) throw new Error(`worker produced no stdout output`);
  return JSON.parse(last) as WorkerResult;
}

/** Spawns three CAS-claim workers, all targeting `startAt`, and returns their parsed results. */
async function raceOnceCAS(
  repoDir: string,
  ticket: string,
): Promise<WorkerResult[]> {
  const startAt = Date.now() + 250;
  const runs = [1, 2, 3].map((n) =>
    spawnWorker("workers/claim-cas.ts", [
      repoDir,
      ticket,
      `spike:cas-${n}`,
      String(startAt),
    ]),
  );
  const finished = await Promise.all(runs.map((r) => r.done));
  return finished.map((f) => parseWorkerResult(f.stdout));
}

/** Spawns three lock-claim workers, all targeting `startAt`, sharing `lockPath`. */
async function raceOnceLock(
  repoDir: string,
  ticket: string,
  lockPath: string,
): Promise<WorkerResult[]> {
  const startAt = Date.now() + 250;
  const runs = [1, 2, 3].map((n) =>
    spawnWorker("workers/claim-lock.ts", [
      repoDir,
      ticket,
      `spike:lock-${n}`,
      lockPath,
      String(startAt),
    ]),
  );
  const finished = await Promise.all(runs.map((r) => r.done));
  return finished.map((f) => parseWorkerResult(f.stdout));
}

/**
 * Asserts the semantic success criterion for one race: exactly one `claimed`,
 * exactly two `already_claimed`, and the event log holds exactly one claim
 * event for `ticket`, matching the winner's event id.
 */
function checkRaceOutcome(
  results: WorkerResult[],
  events: ClaimEvent[],
  ticket: string,
  label: string,
  notes: string[],
): boolean {
  const errored = results.filter((r) => !isSuccess(r));
  if (errored.length > 0) {
    notes.push(`${label}: worker(s) errored: ${JSON.stringify(errored)}`);
    return false;
  }
  const successes = results.filter(isSuccess);
  const claimed = successes.filter((r) => r.outcome === "claimed");
  const already = successes.filter((r) => r.outcome === "already_claimed");
  let ok = true;
  if (claimed.length !== 1 || already.length !== 2) {
    notes.push(
      `${label}: expected exactly 1 claimed / 2 already_claimed, got ${claimed.length} claimed / ${already.length} already_claimed`,
    );
    ok = false;
  }
  const ticketClaims = events.filter(
    (e) => e.type === "claim" && e.ticket === ticket,
  );
  if (ticketClaims.length !== 1) {
    notes.push(
      `${label}: expected exactly 1 claim event in the log for ${ticket}, found ${ticketClaims.length}`,
    );
    ok = false;
  } else if (claimed[0] && ticketClaims[0]?.id !== claimed[0].event.id) {
    notes.push(
      `${label}: winner's reported event id doesn't match the event log's claim id`,
    );
    ok = false;
  }
  return ok;
}

async function scenario1(): Promise<ScenarioRecord> {
  const commands: string[] = [];
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  let passed = true;
  const repo = await makeTempRepo();
  try {
    commands.push(
      "git commit-tree <empty-tree-sha> -m 'cankan: init coordination ref'",
      `git update-ref ${COORD_REF} <commit> 0000000000000000000000000000000000000000`,
    );
    const { ms: initMs } = await timeIt(() => initCoordinationRef(repo.dir));
    timingsMs["init ref"] = initMs;

    const n = 5;
    commands.push(
      `(x${n}) git hash-object -w --stdin | git read-tree <old> && git update-index --add --cacheinfo ... && git write-tree | git commit-tree <tree> -p <old> -m ... | git update-ref ${COORD_REF} <new> <old>`,
    );
    const { ms: appendMs } = await timeIt(async () => {
      for (let i = 1; i <= n; i++) {
        await claimViaCAS(
          repo.dir,
          `ck-seed-${String(i).padStart(3, "0")}`,
          "spike:seed",
        );
      }
    });
    timingsMs[`append ${n} events`] = appendMs;

    const finalSha = readRef(repo.dir, COORD_REF);
    const monthFile = eventFilePath();
    commands.push(`git cat-file -p ${finalSha}:${monthFile}`);
    const events = readEventsAt(repo.dir, finalSha, monthFile);
    if (events.length !== n) {
      passed = false;
      notes.push(`expected ${n} events, found ${events.length}`);
    } else {
      notes.push(
        `read back all ${n} events in append order: ${events.map((e) => e.ticket).join(", ")}`,
      );
    }
  } catch (err) {
    passed = false;
    notes.push(`threw: ${String(err)}`);
  } finally {
    await repo.cleanup();
  }
  return {
    title: "Create the orphan ref, append N events, read them back",
    commands,
    passed,
    timingsMs,
    notes,
  };
}

async function scenario2(): Promise<ScenarioRecord> {
  const commands = [
    "CAS: git hash-object -w --stdin; git read-tree <old> / update-index --add --cacheinfo / write-tree (private temp index); git commit-tree <tree> -p <old> -m 'claim <ticket> by <actor>'; git update-ref refs/cankan/coordination <new> <old>",
    "file lock: open(lockPath, O_EXCL) to acquire; same off-tree build as above; git update-ref refs/cankan/coordination <new>  (no CAS - the lock is the only serialization); unlink(lockPath) to release",
  ];
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  let passed = true;
  const iterations = 10;

  // --- git update-ref CAS ---
  const casRepo = await makeTempRepo();
  const casIterMs: number[] = [];
  let casContentionCount = 0;
  let casMaxAttempts = 0;
  let casExampleFailure = "";
  try {
    initCoordinationRef(casRepo.dir);
    for (let i = 0; i < iterations; i++) {
      const ticket = `ck-race-cas-${i}`;
      const { ms, value: results } = await timeIt(() =>
        raceOnceCAS(casRepo.dir, ticket),
      );
      casIterMs.push(ms);
      const finalSha = readRef(casRepo.dir, COORD_REF);
      const events = readEventsAt(casRepo.dir, finalSha, eventFilePath());
      if (
        !checkRaceOutcome(results, events, ticket, `CAS iteration ${i}`, notes)
      )
        passed = false;
      const attempts = results.filter(isSuccess).map((r) => r.attempts);
      const maxAttempt = attempts.length > 0 ? Math.max(...attempts) : 1;
      casMaxAttempts = Math.max(casMaxAttempts, maxAttempt);
      if (maxAttempt > 1) casContentionCount++;
      for (const r of results) {
        if (isSuccess(r) && r.casFailures.length > 0 && !casExampleFailure) {
          casExampleFailure = r.casFailures[0] as string;
        }
      }
    }
  } catch (err) {
    passed = false;
    notes.push(`CAS race threw: ${String(err)}`);
  } finally {
    await casRepo.cleanup();
  }
  timingsMs["CAS: race wall clock, avg over 10 runs"] = avg(casIterMs);
  timingsMs["CAS: race wall clock, max over 10 runs"] = Math.max(...casIterMs);
  notes.push(
    `CAS: ${casContentionCount}/${iterations} races had a losing worker observe a CAS rejection (attempts>1); max attempts by any single worker: ${casMaxAttempts}`,
  );
  notes.push(
    casExampleFailure
      ? `CAS: example rejection stderr: ${casExampleFailure}`
      : "CAS: no CAS rejection was observed in this run even with a start barrier - each worker's read-build-write cycle apparently completed inside the ~1ms scheduling gap between spawns at this iteration count; see README for how to force more contention (larger N, or an artificial delay between read and write) if this needs to be demonstrated definitively",
  );

  // --- local O_EXCL file lock ---
  const lockRepo = await makeTempRepo();
  // Under .git/ rather than a worktree dir: shared across worktrees since .git is shared,
  // unlike a lock file placed inside a worktree's own directory.
  const lockPath = join(lockRepo.dir, ".git", "cankan-coordination.lock");
  const lockIterMs: number[] = [];
  let lockContentionWaitMax = 0;
  try {
    initCoordinationRef(lockRepo.dir);
    for (let i = 0; i < iterations; i++) {
      const ticket = `ck-race-lock-${i}`;
      const { ms, value: results } = await timeIt(() =>
        raceOnceLock(lockRepo.dir, ticket, lockPath),
      );
      lockIterMs.push(ms);
      const finalSha = readRef(lockRepo.dir, COORD_REF);
      const events = readEventsAt(lockRepo.dir, finalSha, eventFilePath());
      if (
        !checkRaceOutcome(results, events, ticket, `lock iteration ${i}`, notes)
      )
        passed = false;
      for (const r of results) {
        if (isSuccess(r) && r.lockWaitMs !== undefined) {
          lockContentionWaitMax = Math.max(lockContentionWaitMax, r.lockWaitMs);
        }
      }
    }
  } catch (err) {
    passed = false;
    notes.push(`file-lock race threw: ${String(err)}`);
  } finally {
    await lockRepo.cleanup();
  }
  timingsMs["file lock: race wall clock, avg over 10 runs"] = avg(lockIterMs);
  timingsMs["file lock: race wall clock, max over 10 runs"] = Math.max(
    ...lockIterMs,
  );
  timingsMs["file lock: longest single lock-wait observed"] =
    lockContentionWaitMax;
  notes.push(
    `file lock: max lock-acquire wait observed by a losing worker: ${lockContentionWaitMax.toFixed(1)} ms (10ms retry polling, 10s timeout)`,
  );

  // --- stale-lock experiment: kill a process while it holds the lock ---
  const staleRepo = await makeTempRepo();
  const staleLockPath = join(staleRepo.dir, ".git", "cankan-coordination.lock");
  try {
    initCoordinationRef(staleRepo.dir);
    const holder = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "workers/hold-lock.ts"),
        staleLockPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = holder.stdout.getReader();
    const decoder = new TextDecoder();
    let announced = "";
    const acquireStart = performance.now();
    while (!announced.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) break;
      announced += decoder.decode(value);
    }
    timingsMs["stale-lock: time for holder to acquire and announce"] =
      performance.now() - acquireStart;
    reader.releaseLock();
    holder.kill("SIGKILL");
    await holder.exited;
    const leftBehind = existsSync(staleLockPath);
    notes.push(
      `stale-lock: lockfile ${leftBehind ? "was left behind" : "was NOT left behind"} after SIGKILLing the holder - this spike's lockfile has no PID-liveness or lease-based staleness check`,
    );

    const { ms: attemptMs, value: after } = await timeIt(() =>
      spawnWorker("workers/claim-lock.ts", [
        staleRepo.dir,
        "ck-stale-lock-test",
        "spike:after-crash",
        staleLockPath,
        String(Date.now()),
        "1200",
      ]).done.then((r) => parseWorkerResult(r.stdout)),
    );
    timingsMs[
      "stale-lock: claimant's wait against the stale lock (1.2s timeout configured)"
    ] = attemptMs;
    notes.push(
      `stale-lock: claimant against the stale lock reported: ${JSON.stringify(after)}`,
    );
    if (after.outcome !== "lock_timeout") {
      notes.push(
        "stale-lock: NOTE - claimant did not time out as expected; a stale lock left by a killed holder may not always block a later claimant the way this note implies (investigate before relying on this)",
      );
    }
    await rm(staleLockPath, { force: true });
  } catch (err) {
    notes.push(`stale-lock experiment threw: ${String(err)}`);
  } finally {
    await staleRepo.cleanup();
  }

  return {
    title:
      "Three concurrent processes race to claim the same ticket - CAS vs file lock",
    commands,
    passed,
    timingsMs,
    notes,
  };
}

async function scenario3(): Promise<ScenarioRecord> {
  const commands: string[] = [];
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  let passed = true;
  const repo = await makeTempRepo();
  try {
    initCoordinationRef(repo.dir);
    await claimViaCAS(repo.dir, "ck-rebase-test", "spike:seed");
    const beforeSha = readRef(repo.dir, COORD_REF);

    commands.push("git checkout -b feature");
    gitOrThrow(repo.dir, ["checkout", "-b", "feature"]);
    await Bun.write(join(repo.dir, "feature.txt"), "feature change\n");
    commands.push("git add feature.txt && git commit -m 'feature work'");
    gitOrThrow(repo.dir, ["add", "feature.txt"]);
    gitOrThrow(repo.dir, ["commit", "-m", "feature work"]);

    commands.push("git checkout main");
    gitOrThrow(repo.dir, ["checkout", "main"]);
    await Bun.write(join(repo.dir, "main.txt"), "main change\n");
    commands.push("git add main.txt && git commit -m 'main moves on'");
    gitOrThrow(repo.dir, ["add", "main.txt"]);
    gitOrThrow(repo.dir, ["commit", "-m", "main moves on"]);

    commands.push("git checkout feature && git rebase main");
    gitOrThrow(repo.dir, ["checkout", "feature"]);
    const { ms: rebaseMs } = await timeIt(() =>
      gitOrThrow(repo.dir, ["rebase", "main"]),
    );
    timingsMs["git rebase main"] = rebaseMs;

    commands.push(`git rev-parse ${COORD_REF}`);
    const afterSha = readRef(repo.dir, COORD_REF);
    if (afterSha !== beforeSha) {
      passed = false;
      notes.push(
        `coordination ref sha changed across rebase: ${beforeSha} -> ${afterSha}`,
      );
    } else {
      notes.push(`coordination ref sha unchanged across rebase (${afterSha})`);
    }
    const events = readEventsAt(repo.dir, afterSha, eventFilePath());
    if (!findClaim(events, "ck-rebase-test")) {
      passed = false;
      notes.push("claim event no longer readable after rebase");
    } else {
      notes.push("claim event still readable after rebase");
    }
  } catch (err) {
    passed = false;
    notes.push(`threw: ${String(err)}`);
  } finally {
    await repo.cleanup();
  }
  return {
    title:
      "git rebase a feature branch onto main - refs/cankan/* untouched and readable",
    commands,
    passed,
    timingsMs,
    notes,
  };
}

async function scenario4(): Promise<ScenarioRecord> {
  const commands: string[] = [];
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  let passed = true;
  const repo = await makeTempRepo();
  try {
    initCoordinationRef(repo.dir);
    await claimViaCAS(repo.dir, "ck-merge-test", "spike:seed");
    const beforeSha = readRef(repo.dir, COORD_REF);

    commands.push("git checkout -b feature");
    gitOrThrow(repo.dir, ["checkout", "-b", "feature"]);
    await Bun.write(join(repo.dir, "feature.txt"), "feature change\n");
    commands.push("git add feature.txt && git commit -m 'feature work'");
    gitOrThrow(repo.dir, ["add", "feature.txt"]);
    gitOrThrow(repo.dir, ["commit", "-m", "feature work"]);

    commands.push("git checkout main");
    gitOrThrow(repo.dir, ["checkout", "main"]);
    await Bun.write(join(repo.dir, "main.txt"), "main change\n");
    commands.push("git add main.txt && git commit -m 'main moves on'");
    gitOrThrow(repo.dir, ["add", "main.txt"]);
    gitOrThrow(repo.dir, ["commit", "-m", "main moves on"]);

    commands.push("git merge feature --no-edit");
    const { ms: mergeMs } = await timeIt(() =>
      gitOrThrow(repo.dir, ["merge", "feature", "--no-edit"]),
    );
    timingsMs["git merge feature"] = mergeMs;

    commands.push(`git rev-parse ${COORD_REF}`);
    const afterSha = readRef(repo.dir, COORD_REF);
    if (afterSha !== beforeSha) {
      passed = false;
      notes.push(
        `coordination ref sha changed across merge: ${beforeSha} -> ${afterSha}`,
      );
    } else {
      notes.push(`coordination ref sha unchanged across merge (${afterSha})`);
    }
    const events = readEventsAt(repo.dir, afterSha, eventFilePath());
    if (!findClaim(events, "ck-merge-test")) {
      passed = false;
      notes.push("claim event no longer readable after merge");
    } else {
      notes.push("claim event still readable after merge");
    }
  } catch (err) {
    passed = false;
    notes.push(`threw: ${String(err)}`);
  } finally {
    await repo.cleanup();
  }
  return {
    title:
      "Merge a feature branch into main - refs/cankan/* untouched and readable",
    commands,
    passed,
    timingsMs,
    notes,
  };
}

async function scenario5(): Promise<ScenarioRecord> {
  const commands: string[] = [];
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  let passed = true;
  const repo = await makeTempRepo({ bareRemote: true });
  const remoteDir = repo.remoteDir;
  if (!remoteDir)
    throw new Error(
      "expected makeTempRepo({bareRemote:true}) to set remoteDir",
    );
  const cloneDir = join(repo.root, "clone");
  const explicitRefspec = `${COORD_REF}:${COORD_REF}`;
  try {
    initCoordinationRef(repo.dir);
    await claimViaCAS(repo.dir, "ck-push-test", "spike:seed");
    const localSha = readRef(repo.dir, COORD_REF);

    commands.push(
      "git push origin main   # default refspec, no cankan ref named",
    );
    const { ms: pushMs } = await timeIt(() =>
      gitOrThrow(repo.dir, ["push", "origin", "main"]),
    );
    timingsMs["git push origin main (default)"] = pushMs;
    const remoteShaAfterDefaultPush = readRef(remoteDir, COORD_REF);
    if (remoteShaAfterDefaultPush !== null) {
      passed = false;
      notes.push(
        "SURPRISE: a default `git push origin main` moved refs/cankan/coordination on the remote - expected it not to",
      );
    } else {
      notes.push(
        "confirmed: a default `git push origin main` does NOT move refs/cankan/coordination on the remote",
      );
    }

    commands.push(`git push origin ${explicitRefspec}`);
    const { ms: explicitPushMs } = await timeIt(() =>
      gitOrThrow(repo.dir, ["push", "origin", explicitRefspec]),
    );
    timingsMs[`git push origin ${explicitRefspec}`] = explicitPushMs;
    const remoteSha = readRef(remoteDir, COORD_REF);
    if (remoteSha !== localSha) {
      passed = false;
      notes.push(
        `push with the explicit refspec did not land the expected sha on the remote (local=${localSha}, remote=${remoteSha})`,
      );
    } else {
      notes.push(
        `push with the explicit refspec '${explicitRefspec}' moved the remote ref to ${remoteSha}`,
      );
    }

    commands.push(`git clone ${remoteDir} <clone-dir>`);
    gitOrThrow(repo.root, ["clone", remoteDir, cloneDir]);
    const clonedSha = readRef(cloneDir, COORD_REF);
    if (clonedSha !== null) {
      passed = false;
      notes.push(
        "SURPRISE: a plain `git clone` brought refs/cankan/coordination along - expected it not to",
      );
    } else {
      notes.push(
        "confirmed: a plain `git clone` does NOT bring refs/cankan/coordination along",
      );
    }

    commands.push(`git fetch origin ${explicitRefspec}`);
    const { ms: fetchMs } = await timeIt(() =>
      gitOrThrow(cloneDir, ["fetch", "origin", explicitRefspec]),
    );
    timingsMs[`git fetch origin ${explicitRefspec}`] = fetchMs;
    const fetchedSha = readRef(cloneDir, COORD_REF);
    if (fetchedSha !== remoteSha) {
      passed = false;
      notes.push(
        `fetch with the explicit refspec did not bring the expected sha (remote=${remoteSha}, fetched=${fetchedSha})`,
      );
    } else {
      notes.push(
        `fetch with the explicit refspec '${explicitRefspec}' correctly created refs/cankan/coordination in the clone at ${fetchedSha}`,
      );
    }
    // A default fetch, run again after the remote has moved on, still must not
    // touch a coordination ref that already exists locally - the explicit
    // refspec is required every time, not just to create it the first time.
    await claimViaCAS(repo.dir, "ck-push-test-2", "spike:seed-2");
    commands.push(
      `git push origin ${explicitRefspec}   # advance origin again`,
    );
    gitOrThrow(repo.dir, ["push", "origin", explicitRefspec]);
    const remoteSha2 = readRef(remoteDir, COORD_REF);

    commands.push(
      "git fetch origin   # default fetch, no refspec; ref already exists locally in the clone",
    );
    const { ms: defaultFetchMs } = await timeIt(() =>
      gitOrThrow(cloneDir, ["fetch", "origin"]),
    );
    timingsMs["git fetch origin (default, ref already exists locally)"] =
      defaultFetchMs;
    const cloneShaAfterDefaultFetch = readRef(cloneDir, COORD_REF);
    if (cloneShaAfterDefaultFetch !== fetchedSha) {
      passed = false;
      notes.push(
        `SURPRISE: a default 'git fetch origin' advanced the clone's refs/cankan/coordination from ${fetchedSha} to ${cloneShaAfterDefaultFetch} - expected it to stay put`,
      );
    } else {
      notes.push(
        `confirmed: a default 'git fetch origin' does NOT advance an already-existing local refs/cankan/coordination, even though the remote had moved on to ${remoteSha2} - the explicit refspec is required on every fetch, not just the first one`,
      );
    }

    // Cross-machine conflict: the clone appends its own claim off the stale
    // ref it still has locally (it never re-fetched with the explicit
    // refspec), then tries to push - a real two-machine race, not just two
    // processes on one machine.
    commands.push(
      "(the clone appends its own claim off its stale local ref, independent of the remote's new tip)",
    );
    await claimViaCAS(
      cloneDir,
      "ck-crossmachine-conflict",
      "spike:clone-actor",
    );
    commands.push(
      `git push origin ${explicitRefspec}   # from the clone - expected to be rejected as non-fast-forward`,
    );
    const conflictPush = git(cloneDir, ["push", "origin", explicitRefspec]);
    if (conflictPush.exitCode === 0) {
      passed = false;
      notes.push(
        "SURPRISE: a non-fast-forward push of refs/cankan/coordination from the clone succeeded - expected git to reject it",
      );
    } else {
      const rejectedLine =
        conflictPush.stderr.split("\n").find((l) => l.includes("[rejected]")) ??
        conflictPush.stderr.trim().split("\n")[0];
      notes.push(
        `confirmed: git rejects a non-fast-forward push of the coordination ref by default, no force needed to protect it; exact stderr: ${rejectedLine}`,
      );
    }

    notes.push(
      `required refspec for both push and fetch: ${explicitRefspec}, every time (default push/fetch never touch it, even once it exists locally). Cross-machine writes are caught by git's own non-fast-forward push protection, matching CONCEPT.md's "optimistic push, retry on rejection" - M2.6's push path must catch that rejection and re-fetch/re-apply rather than force-pushing.`,
    );
  } catch (err) {
    passed = false;
    notes.push(`threw: ${String(err)}`);
  } finally {
    await repo.cleanup();
  }
  return {
    title: "Push and fetch the coordination ref through a bare remote",
    commands,
    passed,
    timingsMs,
    notes,
  };
}

async function scenario6(): Promise<ScenarioRecord> {
  const commands: string[] = [];
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  let passed = true;
  const repo = await makeTempRepo({ worktrees: 1 });
  const worktreeDir = repo.worktreeDirs[0];
  try {
    if (!worktreeDir)
      throw new Error(
        "expected makeTempRepo({worktrees:1}) to create a worktree",
      );
    initCoordinationRef(repo.dir);

    commands.push(
      "(claim ck-worktree-test from the secondary worktree directory)",
    );
    const { ms: claimMs } = await timeIt(() =>
      claimViaCAS(worktreeDir, "ck-worktree-test", "spike:from-worktree"),
    );
    timingsMs["claim from secondary worktree"] = claimMs;

    commands.push(
      `git rev-parse ${COORD_REF}   # read from the primary worktree, no fetch/pull`,
    );
    const { ms: readMs, value: eventsFromPrimary } = await timeIt(() => {
      const sha = readRef(repo.dir, COORD_REF);
      return readEventsAt(repo.dir, sha, eventFilePath());
    });
    timingsMs["read from primary worktree (no fetch)"] = readMs;
    if (!findClaim(eventsFromPrimary, "ck-worktree-test")) {
      passed = false;
      notes.push(
        "primary worktree did NOT see the claim made from the secondary worktree without a fetch/pull",
      );
    } else {
      notes.push(
        "primary worktree saw the claim made from the secondary worktree immediately, with no fetch/pull - confirms the shared-.git premise",
      );
    }
  } catch (err) {
    passed = false;
    notes.push(`threw: ${String(err)}`);
  } finally {
    await repo.cleanup();
  }
  return {
    title:
      "Claim from a secondary worktree - primary worktree sees it immediately",
    commands,
    passed,
    timingsMs,
    notes,
  };
}

async function main(): Promise<void> {
  const scenarios: ScenarioRecord[] = [];
  scenarios.push(await scenario1());
  scenarios.push(await scenario2());
  scenarios.push(await scenario3());
  scenarios.push(await scenario4());
  scenarios.push(await scenario5());
  scenarios.push(await scenario6());

  const env: EnvInfo = {
    gitVersion: gitOrThrow(process.cwd(), ["--version"]),
    bunVersion: Bun.version,
    os: `${osType()} ${release()} (${platform()}/${process.arch})`,
    date: new Date().toISOString(),
  };

  const resultsPath = join(import.meta.dir, "RESULTS.md");
  await writeFile(resultsPath, renderResults(env, scenarios), "utf8");

  const allPassed = scenarios.every((s) => s.passed);
  console.log(`\nWrote ${resultsPath}`);
  console.log(
    allPassed
      ? "All scenarios passed."
      : "At least one scenario FAILED - see RESULTS.md.",
  );
  process.exit(allPassed ? 0 : 1);
}

await main();
