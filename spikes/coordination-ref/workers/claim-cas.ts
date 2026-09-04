// Worker process for the CAS race scenario. Invoked as:
//   bun workers/claim-cas.ts <repoDir> <ticket> <actor> <startAtEpochMs>
// `startAtEpochMs` is a shared start time so racing workers line up instead
// of contending by accident of process-spawn ordering.
// Prints exactly one JSON line to stdout: either a ClaimAttemptResult, or
// `{ outcome: "error", error }` if something threw.
import { waitUntil } from "../barrier";
import { claimViaCAS } from "../coordination";

const [repoDir, ticket, actor, startAtRaw] = process.argv.slice(2);
if (!repoDir || !ticket || !actor || !startAtRaw) {
  console.error(
    "usage: claim-cas.ts <repoDir> <ticket> <actor> <startAtEpochMs>",
  );
  process.exit(2);
}

try {
  await waitUntil(Number(startAtRaw));
  const result = await claimViaCAS(repoDir, ticket, actor);
  console.log(JSON.stringify(result));
} catch (err) {
  console.log(JSON.stringify({ outcome: "error", error: String(err) }));
}
