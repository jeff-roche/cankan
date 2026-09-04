import {
  EMPTY_TREE_SHA,
  commitTree,
  hashObject,
  randomEventId,
  readFileAtCommit,
  readRef,
  updateRefCAS,
  updateRefForce,
  writeTreeWithFile,
} from "./git-plumbing";
import { acquireLock, releaseLock } from "./lockfile";

export const COORD_REF = "refs/cankan/coordination";

/** Minimal stand-in for the schema `packages/core`'s events/schema.ts (M2.7) will define. */
export interface ClaimEvent {
  id: string;
  ts: string;
  type: "claim";
  ticket: string;
  actor: string;
}

/** Monthly JSONL file layout under the ref, per CONCEPT.md's event-log design. */
export function eventFilePath(date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `events/${yyyy}-${mm}.jsonl`;
}

/** Creates the orphan coordination ref with an empty event tree. Fails if it already exists. */
export function initCoordinationRef(
  cwd: string,
  ref: string = COORD_REF,
): string {
  const commit = commitTree(
    cwd,
    EMPTY_TREE_SHA,
    null,
    "cankan: init coordination ref",
  );
  const { ok, stderr } = updateRefCAS(cwd, ref, commit, null);
  if (!ok) {
    throw new Error(`initCoordinationRef failed: ${stderr}`);
  }
  return commit;
}

/** Parses one month's JSONL file content into events, tolerating a trailing newline. */
function parseEvents(raw: string | null): ClaimEvent[] {
  if (raw === null || raw.trim() === "") return [];
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaimEvent);
}

/** Reads every event in `monthFile` at `commit`, or `[]` if the ref/file doesn't exist yet. */
export function readEventsAt(
  cwd: string,
  commit: string | null,
  monthFile: string,
): ClaimEvent[] {
  if (commit === null) return [];
  return parseEvents(readFileAtCommit(cwd, commit, monthFile));
}

/** The event that claimed `ticket`, if any, scanning oldest-to-newest (last claim wins). */
export function findClaim(
  events: ClaimEvent[],
  ticket: string,
): ClaimEvent | undefined {
  return events.filter((e) => e.type === "claim" && e.ticket === ticket).at(-1);
}

export interface ClaimAttemptResult {
  outcome: "claimed" | "already_claimed";
  attempts: number;
  event: ClaimEvent;
  finalRef: string;
  /** stderr text from each CAS rejection this attempt hit before succeeding/giving up. */
  casFailures: string[];
}

/** Reads `monthFile` at `oldSha` (or nothing, if the ref doesn't exist yet). */
function readMonthFile(
  cwd: string,
  oldSha: string | null,
  monthFile: string,
): { raw: string | null; events: ClaimEvent[] } {
  const raw = oldSha ? readFileAtCommit(cwd, oldSha, monthFile) : null;
  return { raw, events: parseEvents(raw) };
}

/**
 * Builds (but does not point the ref at) a new commit appending a claim event
 * for `ticket` onto `monthFile`, off `oldSha`. Off-tree the whole way: blob,
 * tree (via a private temp index), then commit - the working tree is never
 * touched.
 */
async function buildClaimCommit(
  cwd: string,
  oldSha: string | null,
  raw: string | null,
  monthFile: string,
  ticket: string,
  actor: string,
): Promise<{ event: ClaimEvent; commit: string }> {
  const event: ClaimEvent = {
    id: randomEventId(),
    ts: new Date().toISOString(),
    type: "claim",
    ticket,
    actor,
  };
  const newContent = raw
    ? `${raw}${JSON.stringify(event)}\n`
    : `${JSON.stringify(event)}\n`;
  const blob = hashObject(cwd, newContent);
  // git read-tree accepts a commit-ish directly (resolves to its tree), so the
  // commit sha itself is a valid `baseTree` argument - no separate ^{tree} lookup.
  const newTree = await writeTreeWithFile(cwd, oldSha, monthFile, blob);
  const commit = commitTree(
    cwd,
    newTree,
    oldSha,
    `claim ${ticket} by ${actor}`,
  );
  return { event, commit };
}

/**
 * Claims `ticket` for `actor` via `git update-ref` CAS: read the ref, check whether
 * the ticket is already claimed, and if not, build a new commit appending a claim
 * event and attempt the CAS swap. On CAS failure (another process won the race),
 * re-reads the ref and re-checks rather than blindly retrying the write - so a
 * loser can only ever report "already_claimed", never append a second claim.
 */
export async function claimViaCAS(
  cwd: string,
  ticket: string,
  actor: string,
  ref: string = COORD_REF,
  maxAttempts = 50,
): Promise<ClaimAttemptResult> {
  const monthFile = eventFilePath();
  const casFailures: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const oldSha = readRef(cwd, ref);
    const { raw, events } = readMonthFile(cwd, oldSha, monthFile);
    const existing = findClaim(events, ticket);
    if (existing) {
      return {
        outcome: "already_claimed",
        attempts: attempt,
        event: existing,
        finalRef: oldSha ?? "",
        casFailures,
      };
    }

    const { event, commit } = await buildClaimCommit(
      cwd,
      oldSha,
      raw,
      monthFile,
      ticket,
      actor,
    );
    const { ok, stderr } = updateRefCAS(cwd, ref, commit, oldSha);
    if (ok) {
      return {
        outcome: "claimed",
        attempts: attempt,
        event,
        finalRef: commit,
        casFailures,
      };
    }
    // CAS lost the race - capture the exact failure text, then loop back to
    // re-read and re-check rather than blindly retrying the write.
    casFailures.push(stderr);
  }
  throw new Error(`claimViaCAS: exceeded ${maxAttempts} attempts on ${ticket}`);
}

export interface ClaimViaLockResult extends ClaimAttemptResult {
  lockWaitMs: number;
}

/**
 * Claims `ticket` for `actor` via a local `O_EXCL` lockfile serializing a
 * non-atomic read-modify-write on the ref (no git-level CAS at all - the last
 * `update-ref` call just wins). Used to compare against `claimViaCAS`.
 */
export async function claimViaLock(
  cwd: string,
  ticket: string,
  actor: string,
  lockPath: string,
  ref: string = COORD_REF,
  lockTimeoutMs = 10_000,
): Promise<ClaimViaLockResult> {
  const monthFile = eventFilePath();
  const lockStart = performance.now();
  const acquired = await acquireLock(lockPath, lockTimeoutMs);
  const lockWaitMs = performance.now() - lockStart;
  if (!acquired) {
    throw new Error(`claimViaLock: timed out waiting for lock at ${lockPath}`);
  }
  try {
    const oldSha = readRef(cwd, ref);
    const { raw, events } = readMonthFile(cwd, oldSha, monthFile);
    const existing = findClaim(events, ticket);
    if (existing) {
      return {
        outcome: "already_claimed",
        attempts: 1,
        event: existing,
        finalRef: oldSha ?? "",
        casFailures: [],
        lockWaitMs,
      };
    }

    const { event, commit } = await buildClaimCommit(
      cwd,
      oldSha,
      raw,
      monthFile,
      ticket,
      actor,
    );
    updateRefForce(cwd, ref, commit);
    return {
      outcome: "claimed",
      attempts: 1,
      event,
      finalRef: commit,
      casFailures: [],
      lockWaitMs,
    };
  } finally {
    releaseLock(lockPath);
  }
}
