// Worker for the stale-lock experiment: acquires the lockfile, announces it
// on stdout, then sleeps forever without releasing - the parent SIGKILLs
// this process to simulate a crash while the lock is held. Invoked as:
//   bun workers/hold-lock.ts <lockPath>
import { acquireLock } from "../lockfile";

const [lockPath] = process.argv.slice(2);
if (!lockPath) {
  console.error("usage: hold-lock.ts <lockPath>");
  process.exit(2);
}

const acquired = await acquireLock(lockPath, 5_000);
if (!acquired) {
  console.error("hold-lock.ts: failed to acquire lock");
  process.exit(1);
}
console.log("locked");
// Deliberately never releases - the parent kills this process to leave a stale lock.
await new Promise(() => {});
