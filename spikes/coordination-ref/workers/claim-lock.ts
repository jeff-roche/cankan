// Worker process for the file-lock race scenario. Invoked as:
//   bun workers/claim-lock.ts <repoDir> <ticket> <actor> <lockPath> <startAtEpochMs> [lockTimeoutMs]
// Prints exactly one JSON line to stdout: either a ClaimViaLockResult, or
// `{ outcome: "lock_timeout" | "error", error }` if acquiring the lock timed
// out or something else threw.
import { waitUntil } from "../barrier";
import { claimViaLock } from "../coordination";

const [repoDir, ticket, actor, lockPath, startAtRaw, lockTimeoutRaw] =
  process.argv.slice(2);
if (!repoDir || !ticket || !actor || !lockPath || !startAtRaw) {
  console.error(
    "usage: claim-lock.ts <repoDir> <ticket> <actor> <lockPath> <startAtEpochMs> [lockTimeoutMs]",
  );
  process.exit(2);
}
const lockTimeoutMs = lockTimeoutRaw ? Number(lockTimeoutRaw) : 10_000;

try {
  await waitUntil(Number(startAtRaw));
  const result = await claimViaLock(
    repoDir,
    ticket,
    actor,
    lockPath,
    undefined,
    lockTimeoutMs,
  );
  console.log(JSON.stringify(result));
} catch (err) {
  const outcome = String(err).includes("timed out waiting for lock")
    ? "lock_timeout"
    : "error";
  console.log(JSON.stringify({ outcome, error: String(err) }));
}
