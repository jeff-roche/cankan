/**
 * This module's own error codes (mirroring `config/errors.ts`'s pattern
 * exactly). Declared inside `hooks/`, never appended to the root
 * `src/errors.ts` -- `packages/core/test/index.test.ts` asserts the root
 * export key set exactly, and a new flat root export would fail it.
 *
 * Both codes name a *non-thrown* outcome (task brief §8, Controller Ruling
 * 5): a failing hook never aborts the others and the runner never throws
 * for it, so these live on `HookOutcome.errorCode` / `HookEventRecord.errorCode`,
 * not in a `catch` block anywhere outside `runner.ts`'s own spawn chokepoint.
 */
export const HooksErrorCodes = {
  /**
   * `Bun.spawn()` itself threw before any process ever started -- the
   * process never ran, so there is no exit code and no signal to report.
   * Verified reachable in practice (task report): Bun 1.4.0 rejects a NUL
   * byte in the resolved command string, and a NUL byte in any env value
   * (including attacker-influenced `$TITLE`), synchronously with
   * `TypeError { code: "ERR_INVALID_ARG_VALUE" }`, before spawning
   * anything. An unreadable `cwd` or similar `posix_spawn` failure lands
   * here too.
   */
  HOOK_SPAWN_FAILED: "HOOK_SPAWN_FAILED",
  /**
   * `/bin/sh -c <command>` exited with status 127. POSIX.1-2017 §2.8.2
   * reserves 127 specifically for "a command could not be found" -- the
   * standard shell convention for "the named program does not exist / is
   * not on PATH." Documented limitation: a hook that deliberately calls
   * `exit 127` for an unrelated reason is indistinguishable from this and
   * will also carry this code. That is an accepted, narrow ambiguity in
   * the convention itself, not something this module can resolve --
   * `/bin/sh -c` never lets a genuine "could not spawn at all" failure
   * surface any other way for a *named command* (see `HOOK_SPAWN_FAILED`'s
   * comment for what does).
   */
  HOOK_COMMAND_NOT_FOUND: "HOOK_COMMAND_NOT_FOUND",
} as const;
