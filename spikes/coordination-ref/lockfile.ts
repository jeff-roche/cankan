import { closeSync, openSync, rmSync, writeSync } from "node:fs";

/**
 * Acquires an `O_EXCL` lockfile at `path`, retrying with a small fixed delay
 * until `timeoutMs` elapses. Writes the current pid into the file so a stale
 * lock (left behind by a killed process) can at least be diagnosed by hand -
 * this spike does not implement staleness detection or lease expiry.
 * Returns whether the lock was acquired.
 */
export async function acquireLock(
  path: string,
  timeoutMs: number,
  retryDelayMs = 10,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (performance.now() >= deadline) return false;
      await Bun.sleep(retryDelayMs);
    }
  }
}

/** Removes the lockfile at `path`, ignoring "already gone". */
export function releaseLock(path: string): void {
  rmSync(path, { force: true });
}
