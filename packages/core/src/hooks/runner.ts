/**
 * `hooks/runner.ts` -- M2.16 (task brief, PLAN.md M2.16, CONCEPT.md §8
 * ~line 207): resolves the hooks configured for one event across all three
 * config layers and runs every one of them, spawning `$TICKET $ACTOR $FROM
 * $TO $TITLE` into the environment, with a timeout that kills the whole
 * process group (not just the direct child), output captured and handed to
 * an injected sink.
 *
 * **Depends on M2.3 only** (`../config/index`) -- this file does not import
 * `../events/`, `../git/`, or `../store/`. Obligation 4's event log is M2.7,
 * built concurrently in a sibling worktree and outside this task's
 * dependency list; the inversion is the `HookSink` type below, which
 * `runHooks` calls but never constructs. M2.17 (round 6) supplies the
 * event-log-backed adapter.
 *
 * **Trust (issue #86, deliberate and owner-decided -- see the task brief
 * §3):** repo-layer hooks are shell commands that ship inside a
 * repo-controlled, checked-in config file, and this module runs them
 * unconditionally, on every layer, with no trust gate. That is not an
 * oversight -- PLAN.md M2.16 and the project owner require exactly this
 * until #86 lands a gate. The seam for that gate is `spawnHook` below, the
 * single chokepoint every hook passes through before a process is spawned;
 * see its doc comment.
 */

import type { Subprocess } from "bun";
import type { ConfigResult, LoadedLayer } from "../config/index";
import { CanKanError, ErrorCodes } from "../errors";
import { HooksErrorCodes } from "./errors";

// ---------------------------------------------------------------------------
// Events (CONCEPT.md §8) and layers (Controller Ruling 3).
// ---------------------------------------------------------------------------

/** The six events CONCEPT.md §8 names, verbatim and in that order. */
export const HOOK_EVENTS = ["claim", "release", "expire", "move", "close", "create"] as const;

/** One of the six events a hook can fire on. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The order hooks run in when more than one layer configures the same
 * event: **repo, then repo-local, then global** -- descending config
 * precedence, matching every other ordering in the config module
 * (Controller Ruling 3, binding). Declared explicitly and iterated by name
 * rather than relied on as `ConfigResult.layers`'s own incidental array
 * order (`FILE_LAYER_ORDER` in `config/resolve.ts` is `repo-local, repo,
 * global` -- a different order, for a different purpose, than this one).
 *
 * This also happens to be the exact order `config/resolve.ts`'s own
 * `loadConfig` now reports a multi-layer load failure in (fixed alongside
 * issue #88: a `Promise.all` there used to rethrow whichever layer's
 * rejection settled first, non-deterministically; it now settles all three
 * and rethrows in this same repo -> repo-local -> global precedence). Not a
 * coincidence to preserve by hand -- both orderings independently express
 * "most specific layer first" -- but worth naming so it doesn't read as
 * arbitrary next to that fix.
 */
export const HOOK_LAYER_ORDER = ["repo", "repo-local", "global"] as const satisfies readonly LoadedLayer["layer"][];

/** One of the three file layers a hook command can come from. */
export type HookLayer = (typeof HOOK_LAYER_ORDER)[number];

/** Default hook timeout (Controller Ruling 4, binding): a runner option, not a config key. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Grace period between the group SIGTERM and the escalation SIGKILL
 * (task brief §6, "escalate properly ... document the grace period").
 * 200ms: long enough that a well-behaved hook exits cleanly on SIGTERM
 * before escalation ever fires (the common case), short enough that a
 * hook which ignores SIGTERM entirely (task report probe 3) is still
 * killed promptly.
 */
const KILL_GRACE_PERIOD_MS = 200;

/**
 * Poll interval for `waitForGroupEmpty` (fix round 1, finding 1): how often
 * to re-check `isGroupAlive` while waiting for a process group to empty.
 * Small enough not to meaningfully inflate a hook's observed duration,
 * large enough not to busy-loop.
 */
const GROUP_POLL_INTERVAL_MS = 20;

/**
 * Backstop bound on how long to keep polling for a process group to empty
 * *after* the escalation `SIGKILL` (fix round 1, finding 1). `SIGKILL` is
 * unblockable, so this is not an expected wait in practice -- it exists so
 * a pathological environment (an uninterruptible-sleep process, or a
 * platform that recycles the group id unusually early) can never make this
 * module hang indefinitely; see the task brief's own "reaping lags the
 * signal by a tick, poll briefly" note, applied at a longer, one-time-only
 * horizon here.
 */
const GROUP_EMPTY_HARD_BOUND_MS = 2_000;

/** Each captured stream (stdout, stderr) is capped at 64 KiB (task brief §7). */
const OUTPUT_CAP_BYTES = 65_536;

const TRUNCATION_MARKER = "\n[cankan: output truncated at 65536 bytes]";

/**
 * Cap on each of the five CanKan env values (fix round 1, finding 2 /
 * Controller Ruling 13). Well under Linux's `MAX_ARG_STRLEN` (128 KiB per
 * `argv`/`environ` string) with headroom to spare, and far more than any
 * of these five values needs in practice -- this exists purely as a
 * defensive ceiling against a pathologically large attacker-influenced
 * value (`$TITLE` above all), not as a realistic limit any legitimate
 * value should ever approach.
 */
const ENV_VALUE_MAX_BYTES = 4096;

// ---------------------------------------------------------------------------
// Resolving hooks from all three layers (obligation 1).
// ---------------------------------------------------------------------------

/** One hook command found in one layer, with its provenance. */
export interface ResolvedHook {
  layer: HookLayer;
  /** Absolute path of the config file this command came from. */
  file: string;
  /** The resolved shell command, exactly as written in config. */
  command: string;
}

/**
 * Narrows `data.hooks?.[event]` to a `string` defensively.
 * `LoadedLayer.data` is typed `Readonly<Record<string, unknown>>`; the
 * value has already passed the layer's `hooksSchema = z.record(z.string(),
 * z.string())` (`config/schema.ts:221`), so a present value is a string --
 * this still narrows rather than casting blindly, per the task brief.
 */
function readHookCommand(data: Readonly<Record<string, unknown>>, event: HookEvent): string | undefined {
  const hooks = data.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    return undefined;
  }
  const value = (hooks as Record<string, unknown>)[event];
  return typeof value === "string" ? value : undefined;
}

/**
 * Every hook configured for `event`, across all three layers, in
 * `HOOK_LAYER_ORDER`. **Hooks accumulate rather than override** -- this is
 * deliberately unlike the rest of config resolution: a repo hook and a
 * user's own personal (global) hook both fire, so a fully-populated event
 * yields up to three entries here, not one winner.
 *
 * This reads `ConfigResult.layers` directly (Controller Ruling 2, binding),
 * never `ConfigResult.value.hooks` and never `ConfigResult.resolved(...)`:
 * `config/keys.ts:63` classifies `hooks.*` as `policy`, so the resolved
 * channel would hand back the repo layer's command *alone* (or, absent a
 * repo hook, whichever single layer wins by policy precedence) -- exactly
 * the opposite of what this task requires. Reading `layers` is also what
 * preserves provenance (`layer`, `file`) all the way to the spawn
 * chokepoint -- see `spawnHook` below.
 */
export function resolveHooksForEvent(cfg: ConfigResult, event: HookEvent): readonly ResolvedHook[] {
  const resolved: ResolvedHook[] = [];
  for (const layerName of HOOK_LAYER_ORDER) {
    const loaded = cfg.layers.find((l) => l.layer === layerName);
    if (!loaded) {
      continue;
    }
    const command = readHookCommand(loaded.data, event);
    if (command !== undefined) {
      resolved.push({ layer: layerName, file: loaded.file, command });
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The sink (obligation 4, Controller Ruling 1 -- inversion, no M2.7 import).
// ---------------------------------------------------------------------------

/**
 * One hook's outcome. Returned from `runHooks` (one entry per hook that
 * ran) and, with the four run-level fields below added, the shape handed to
 * the sink as `HookEventRecord`.
 *
 * Deliberately **not** a superset of CONCEPT.md's event-record shape (no
 * `id`, no `ts`): M2.7 owns ULID minting and the `ts` format (task brief
 * §7) -- a value invented here is one M2.17 would have to strip back out.
 */
export interface HookOutcome {
  layer: HookLayer;
  file: string;
  command: string;
  /** `null` when the hook was killed at timeout or never started. */
  exitCode: number | null;
  /** The signal that ended the process, if any (e.g. after a timeout kill). */
  signal: string | null;
  /**
   * `true` together with `exitCode: 0` and `signal: null` is a reachable
   * combination (fix round 2, finding 6): the hook's own direct child can
   * exit cleanly while a backgrounded grandchild it never detached lingers
   * past `timeoutMs` (see `runGroupToCompletion`'s doc comment) -- the
   * group, not the exit code, is what timed out. Do not read `timedOut` as
   * implied by, or implying, a non-zero `exitCode`.
   */
  timedOut: boolean;
  /** Present only for a hook that failed in a way `HooksErrorCodes` names. */
  errorCode?: string;
  durationMs: number;
  /** Captured stdout, capped at 64 KiB with `TRUNCATION_MARKER` appended when cut. */
  stdout: string;
  stdoutTruncated: boolean;
  /** Captured stderr, capped at 64 KiB with `TRUNCATION_MARKER` appended when cut. */
  stderr: string;
  stderrTruncated: boolean;
}

/**
 * The record handed to the sink -- `HookOutcome` plus the four facts that
 * are the same for every hook run by one `runHooks` call (the triggering
 * event and the four ticket-context env values), so the sink alone can
 * reconstruct CONCEPT.md's event-record shape (~line 477) without needing
 * anything else from the caller.
 */
export interface HookEventRecord extends HookOutcome {
  event: HookEvent;
  ticket: string;
  actor: string;
  from: string;
  to: string;
}

/**
 * Receives one call per hook that actually ran (never one per event).
 * Awaited by `runHooks`. Optional: an omitted sink means results are still
 * returned from `runHooks`, nothing is emitted anywhere.
 *
 * **A throwing sink propagates out of `runHooks`, aborting any hooks still
 * queued for this event.** That is deliberate (Controller Ruling on
 * obligation 4): a sink failure is the caller's own infrastructure
 * breaking, not a hook failing -- see `HooksErrorCodes` / Ruling 5 for why
 * *those* failures are captured instead of thrown.
 */
export type HookSink = (record: HookEventRecord) => void | Promise<void>;

// ---------------------------------------------------------------------------
// The spawn chokepoint (obligation 2 + issue #86's seam).
// ---------------------------------------------------------------------------

/**
 * Everything `spawnHook` needs to run one hook. Carries provenance
 * (`layer`, `file`) alongside the resolved `command` itself -- this is the
 * task's single most important structural requirement (task brief §3.2):
 * a reviewer confirms provenance survives to the spawn chokepoint by
 * reading this one interface, not by tracing data flow across functions.
 */
export interface HookSpawnRequest {
  /** Which config layer this command came from. #86 will need this to
   *  decide whether a repo-controlled command may run at all. */
  layer: HookLayer;
  /** Absolute path of the config file this command came from. #86 will
   *  need this to name the file a gate refuses. */
  file: string;
  /** The resolved shell command, exactly as written in config. Never built
   *  by concatenating a ticket value -- see `runHooks`'s env-only rule. */
  command: string;
  /** Explicit cwd for the spawned process -- the caller's repo root, never
   *  `process.cwd()`. Also the board identity #86's gate will need. */
  cwd: string;
  /** Merged environment (the five CanKan vars already applied). */
  env: Readonly<Record<string, string | undefined>>;
  /** Milliseconds before the hook (and its whole process group) is killed. */
  timeoutMs: number;
}

type HookExecutionResult = Omit<HookOutcome, "layer" | "file" | "command">;

type HookSubprocess = Subprocess<"ignore", "pipe", "pipe">;

/**
 * Sends `signal` to the whole process group led by `pid` (POSIX `kill(2)`
 * with a negative pid). Never throws: `pid` is only ever a group leader
 * here (see `spawnHook`'s `detached: true`), so the one expected failure is
 * `ESRCH` -- the group has already exited, which a bare `SIGTERM` with no
 * trap can already achieve before the grace-period `SIGKILL` below even
 * runs (verified empirically, task report probe 2). Any other failure is
 * equally not this hook's fault to escalate: Ruling 5 requires that a
 * failure here must not become an uncaught exception aborting every other
 * hook still queued to run.
 *
 * **Fix round 1, finding note on pid reuse (recorded, not fixed here;
 * corrected in fix round 2, finding 5):** once every member of the
 * original group has exited, the OS is free to reuse that numeric id for
 * an unrelated process's pid (which, if *that* process happens to also be
 * its own group leader, would make it an unrelated victim of a stray
 * signal here). This is a pre-existing, accepted risk class.
 *
 * The *call count* is unchanged by fix round 1 -- verified both
 * structurally and empirically (`runGroupToCompletion` sends at most one
 * `SIGTERM` and at most one `SIGKILL`, each inside a block that executes
 * once) -- but the *decision window* is not: the old timer could only ever
 * fire while the leader was still alive (`killAfterTimeout` cleared it the
 * instant the leader exited), whereas this function can now be reached up
 * to `timeoutMs` after the leader's pid became reusable, gated on
 * `isGroupAlive`'s `kill(-pgid, 0)` poll, which has no way to distinguish
 * the original group from a coincidentally-reused pgid. That wider window
 * needs pid wraparound within seconds *and* the recycled pid landing on
 * another group leader to matter -- low likelihood, and inherent to
 * killing a group correctly after its leader is gone, which is exactly
 * what fix round 1 was required to do. Accepted, not fixed here.
 */
function killGroupSafely(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // See doc comment above -- deliberately swallowed.
  }
}

/**
 * `true` iff at least one process still belongs to the group led by `pid`
 * (POSIX `kill(pgid, 0)`: sends no signal, just checks). Deliberately
 * **not** the same question as "has `proc` (the direct child / group
 * leader) exited" -- a process group persists under POSIX as long as any
 * member remains, independent of whether the original leader specifically
 * is still alive (verified empirically for this runtime -- task report's
 * fix-round-1 probe: `isGroupAlive` stayed `true` for ~2s after the direct
 * child had already exited with code 0, while a backgrounded, non-detached
 * grandchild was still running). This is what makes it safe to use even
 * after the leader is gone, without assuming anything Linux-specific about
 * `kill(-pgid)` continuing to "work" post-leader-exit (fix round 1 finding
 * 1's portability constraint) -- it is the POSIX process-group model
 * itself, not an implementation quirk of one kernel.
 */
function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Like `sleep`, but exposes a `cancel()` that clears the underlying timer.
 * Used only for `runGroupToCompletion`'s single deadline race (fix round 2,
 * finding 4) -- `sleep`'s ordinary uses (`waitForGroupEmpty`'s poll
 * interval) are always awaited to completion one at a time, so they never
 * outlive the function that started them; a `Promise.race` timer can, if
 * the *other* side of the race wins, and a plain `setTimeout` handle keeps
 * the event loop alive until it actually fires regardless of who's still
 * listening. Deliberately not a change to `sleep` itself: `waitForGroupEmpty`
 * must keep using real, un-unref'd timers to stay scheduled while polling.
 */
function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Polls (every `GROUP_POLL_INTERVAL_MS`) until `isGroupAlive(pid)` is
 * `false`, or `boundMs` elapses -- whichever first. Returns whether the
 * group was actually confirmed empty. There is no OS/JS primitive to
 * *await* an arbitrary, untracked grandchild's exit (we only ever hold a
 * handle to the direct child), so this is deliberately poll-based rather
 * than event-driven; `GROUP_POLL_INTERVAL_MS` trades a small worst-case
 * detection delay for not depending on anything more elaborate.
 */
async function waitForGroupEmpty(pid: number, boundMs: number): Promise<boolean> {
  const deadline = performance.now() + boundMs;
  while (isGroupAlive(pid)) {
    if (performance.now() >= deadline) {
      return false;
    }
    await sleep(GROUP_POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * Runs `proc`'s **whole process group** to completion within `timeoutMs`,
 * escalating a group kill if it is not naturally empty in time. Resolves
 * once `proc` has actually exited (so the caller can safely read
 * `proc.exitCode`/`signalCode` afterward) and returns whether a timeout
 * was declared.
 *
 * **Fix round 1, finding 1.** The previous version declared "done" the
 * instant the *direct child* (`proc`) exited, and cleared the
 * already-armed SIGKILL escalation timer at that same instant. Two bugs
 * followed from that one design error, both reproduced with real pids in
 * the fix-round-1 findings: (a) a hook whose direct child honours SIGTERM
 * but whose backgrounded grandchild traps it never got the SIGKILL
 * escalation, because the direct child's own death (from the SIGTERM)
 * disarmed it first; (b) a hook whose direct child exits promptly while a
 * backgrounded, non-detached grandchild keeps running (CONCEPT.md §8's own
 * "dispatcher spawns agents" shape, done without properly detaching the
 * spawned process into its own session) was never bounded by `timeoutMs`
 * at all -- `spawnHook` would go on to block on that grandchild's inherited
 * stdout/stderr pipe for its entire natural lifetime, or leak it entirely
 * if its stdio was redirected away from the pipe.
 *
 * The fix: "done" means the **group** has no members left (`!isGroupAlive`),
 * not merely that the direct child has exited -- checked with `kill(-pgid,
 * 0)`, which stays meaningful for as long as *any* member remains,
 * regardless of the original leader's fate (see `isGroupAlive`'s doc
 * comment; this is what avoids assuming Linux-only behaviour about
 * `kill(-pgid)` post-leader-exit). The escalation (`SIGTERM` -> grace ->
 * `SIGKILL`) is sent exactly once each, never repeated -- see
 * `killGroupSafely`'s note on the pid-reuse window this widens (in timing,
 * not in call count) as an accepted cost of killing a group correctly.
 */
async function runGroupToCompletion(proc: HookSubprocess, timeoutMs: number): Promise<boolean> {
  const pid = proc.pid;
  const deadline = performance.now() + timeoutMs;

  // Fast path: an event-driven wait for the direct child specifically,
  // bounded by the deadline -- avoids polling at all for the overwhelmingly
  // common case (a hook with no backgrounded descendant). Whether or not
  // this settles via `proc.exited` or the deadline, the group might still
  // have members afterward (a lingering grandchild) -- that is checked
  // next, not assumed away by the direct child having exited.
  //
  // Fix round 2, finding 4: the deadline timer is explicitly cancelled the
  // moment the race settles, regardless of which side won. Left uncleared,
  // a `proc.exited` win (the overwhelmingly common, fully successful case)
  // still left this timer pending for the rest of `timeoutMs`, keeping the
  // event loop -- and so the whole CLI process -- alive that whole time
  // after the hook had already finished (measured: a default-timeout hook
  // returning in ~3ms kept the process alive for +30002ms).
  let deadlineHitBeforeExit = false;
  const deadlineSleep = cancellableSleep(Math.max(0, deadline - performance.now()));
  await Promise.race([
    proc.exited,
    deadlineSleep.promise.then(() => {
      deadlineHitBeforeExit = true;
    }),
  ]);
  deadlineSleep.cancel();

  let timedOut = deadlineHitBeforeExit;
  if (!deadlineHitBeforeExit) {
    const remaining = Math.max(0, deadline - performance.now());
    const emptyInTime = await waitForGroupEmpty(pid, remaining);
    timedOut = !emptyInTime;
  }

  if (timedOut) {
    killGroupSafely(pid, "SIGTERM");
    const emptyAfterTerm = await waitForGroupEmpty(pid, KILL_GRACE_PERIOD_MS);
    if (!emptyAfterTerm) {
      killGroupSafely(pid, "SIGKILL");
      // `SIGKILL` is unblockable, so this bound is a backstop against
      // reaping lag (and, in principle, a pathological environment) rather
      // than an expected wait -- never hang past it regardless.
      await waitForGroupEmpty(pid, GROUP_EMPTY_HARD_BOUND_MS);
    }
  }

  // `proc.exited` may still be pending if the direct child itself was one
  // of the processes just killed (or if it exited exactly as the deadline
  // hit) -- await it unconditionally so `exitCode`/`signalCode` are safe
  // to read the moment this function returns.
  await proc.exited;

  return timedOut;
}

function concatUint8Arrays(parts: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Reads `stream` to completion, retaining at most `capBytes` bytes
 * (task brief §7's 64 KiB cap) and appending `TRUNCATION_MARKER` when more
 * arrived. Keeps draining past the cap rather than stopping there: the cap
 * bounds *retained* bytes, not *consumed* bytes -- stopping early would
 * leave the pipe full and the writer (a hook, or a grandchild that
 * inherited the fd) blocked on a write that never drains, which would
 * itself masquerade as a hang.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) {
    return { text: "", truncated: false };
  }
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      if (keptBytes >= capBytes) {
        truncated = true;
        continue;
      }
      const room = capBytes - keptBytes;
      if (value.length > room) {
        kept.push(value.subarray(0, room));
        keptBytes += room;
        truncated = true;
      } else {
        kept.push(value);
        keptBytes += value.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concatUint8Arrays(kept, keptBytes));
  return { text: truncated ? `${text}${TRUNCATION_MARKER}` : text, truncated };
}

/**
 * The single chokepoint between "a hook is configured" and "a process is
 * spawned" (task brief §3, obligation 1). Every hook, from every layer,
 * passes through here -- this is the only `Bun.spawn` call in this module.
 *
 * **Issue #86 (deliberate, owner-decided gap -- do not fill it in here):**
 * there is no trust check in this function. Repo-layer hooks are
 * attacker-controlled shell commands (`git clone <hostile-repo> && cankan
 * close ck-1` runs whatever `.cankan/config.yml` says), and this function
 * runs `request.command` regardless of `request.layer`. PLAN.md M2.16 and
 * the project owner require exactly that until #86 lands a gate. A future
 * gate belongs at the top of this function, before the `Bun.spawn` call
 * below -- it will need `request.layer` (repo-controlled vs. the user's
 * own config), the board identity (`request.cwd`), and `request.command`,
 * all three of which this function's parameter type already carries. Do
 * not add a gate, flag, prompt, or partial trust model here or anywhere
 * else in this file.
 *
 * **`request.env` is used exactly as given -- this function does not call
 * `sanitizeEnvValue`.** That NUL-stripping/length-capping defense (fix
 * round 2, finding 6) lives at `runHooks`'s boundary, since `runHooks` is
 * where attacker-influenced ticket content (`$TITLE` above all) enters.
 * `spawnHook` is exported for direct, low-level use (white-box tests, and
 * any future caller that bypasses `runHooks`); such a caller is
 * responsible for sanitizing its own `env` first.
 */
export async function spawnHook(request: HookSpawnRequest): Promise<HookExecutionResult> {
  const startedAt = performance.now();

  let proc: HookSubprocess;
  try {
    proc = Bun.spawn<"ignore", "pipe", "pipe">({
      // Array form only -- never a concatenated shell string, and no
      // ticket value is ever interpolated into it (task brief §5).
      cmd: ["/bin/sh", "-c", request.command],
      cwd: request.cwd,
      env: request.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Process-group leader (task brief §6, obligation 3): `detached:
      // true` calls POSIX `setsid()` on the child, making its pgid equal
      // to its own pid. Verified empirically (task report probe 1) --
      // without this, the child inherits *this* process's group, and the
      // negative-pid kill below would signal `bun test`'s own group
      // instead of the hook's (task report probe 4).
      //
      // `setsid()` is stronger than a bare `setpgid()`: the child also
      // leaves this process's *session*, not just its process group (fix
      // round 1, finding 3). Concretely, an interactive `SIGINT`
      // (Ctrl-C on `cankan close`) delivered to the terminal's foreground
      // process group will NOT reach a hanging hook's group -- only this
      // module's own `timeoutMs` bounds it, and that JS timer dies with
      // the CLI process itself if the CLI exits early for any other
      // reason. Accepted (Controller Ruling 9): `setsid()` via
      // `detached: true` is the only portable route to group-leader status
      // Bun 1.4.0 exposes (Ruling 7 already rules out shelling out to the
      // external `setsid` binary, absent on macOS). Signal forwarding for
      // an interactive session is M3's CLI-signal-boundary concern, outside
      // this task's `Creates` list.
      detached: true,
    });
  } catch {
    // `Bun.spawn()` itself threw before any process started -- e.g. a NUL
    // byte in `request.command` or in an env value (verified empirically,
    // task report's NUL-byte probe: Bun 1.4.0 rejects both synchronously).
    // Ruling 5: captured as a typed outcome, never thrown.
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: HooksErrorCodes.HOOK_SPAWN_FAILED,
      durationMs: Math.round(performance.now() - startedAt),
      stdout: "",
      stdoutTruncated: false,
      stderr: "",
      stderrTruncated: false,
    };
  }

  // Start draining both streams *before* waiting on exit/timeout: a hook
  // that fills one pipe while this function is still waiting on the other
  // would otherwise deadlock on backpressure and never reach the timeout.
  const stdoutPromise = readCapped(proc.stdout, OUTPUT_CAP_BYTES);
  const stderrPromise = readCapped(proc.stderr, OUTPUT_CAP_BYTES);

  const timedOut = await runGroupToCompletion(proc, request.timeoutMs);
  const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);

  const exitCode = proc.exitCode;
  const signal = proc.signalCode as string | null;

  return {
    exitCode,
    signal,
    timedOut,
    // POSIX.1-2017 §2.8.2: 127 is the shell's own "command not found" exit
    // status -- see `HooksErrorCodes.HOOK_COMMAND_NOT_FOUND`'s doc comment
    // for the one documented ambiguity this carries.
    ...(exitCode === 127 ? { errorCode: HooksErrorCodes.HOOK_COMMAND_NOT_FOUND } : {}),
    durationMs: Math.round(performance.now() - startedAt),
    stdout: stdoutResult.text,
    stdoutTruncated: stdoutResult.truncated,
    stderr: stderrResult.text,
    stderrTruncated: stderrResult.truncated,
  };
}

// ---------------------------------------------------------------------------
// The public entry point.
// ---------------------------------------------------------------------------

export interface RunHooksOptions {
  /** Already-loaded config to accumulate hooks from. Load it with M2.3's
   *  `loadConfig` first. */
  cfg: ConfigResult;
  /** One of the six events CONCEPT.md §8 names. */
  event: HookEvent;
  /** Explicit cwd for every spawned hook -- never `process.cwd()`. */
  repoRoot: string;
  /** The five env values a hook receives. Each defaults to `""` when
   *  omitted -- `FROM`/`TO`/etc. must always be *present* in the child's
   *  environment (task brief §5), even for an event with no natural
   *  from/to (`create`), so a hook running under `set -u` never dies on an
   *  absent var. */
  ticket?: string;
  actor?: string;
  from?: string;
  to?: string;
  title?: string;
  /** Base environment merged under the five CanKan vars, which always win.
   *  Defaults to `process.env`. Never replaces the whole environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Called once per hook that ran. See `HookSink`'s doc comment. */
  sink?: HookSink;
  /** Milliseconds before a hook (and its process group) is killed.
   *  Defaults to `DEFAULT_HOOK_TIMEOUT_MS` (Controller Ruling 4). */
  timeoutMs?: number;
}

/**
 * Sanitizes one of the five CanKan env values before it is merged into the
 * environment (fix round 1, finding 2 / Controller Ruling 13).
 *
 * Two independent defenses, both defending `runHooks`'s own boundary
 * (never `packages/core/src/ticket/schema.ts` -- that is M2.2's module and
 * has no maximum length or NUL rejection of its own on `title`):
 *
 * - **Strips every NUL byte.** Verified empirically (task report's
 *   NUL-byte probe): Bun 1.4.0 rejects *any* env value containing one,
 *   synchronously and unrecoverably (`Bun.spawn` throws before spawning
 *   anything). Before this fix, a ticket title containing a single NUL
 *   byte suppressed **every hook configured for that event, across all
 *   three layers** -- including the user's own trusted `global` hook, via
 *   the exact same `HOOK_SPAWN_FAILED` outcome as a genuine environment
 *   failure, indistinguishable from it in the result. Stripping the NUL
 *   here means the hook still runs; availability of the user's own hook
 *   matters more than an untruncated attacker-influenced value reaching
 *   it.
 * - **Caps the byte length at `ENV_VALUE_MAX_BYTES`.** A pathologically
 *   large value (probed at 300 KB and 2 MB) hits the same
 *   `Bun.spawn`-fails-before-anything-starts failure mode, for the same
 *   reason -- same fix, same rationale.
 *
 * A truncated `$TITLE` is strictly better than a hook that never fires at
 * all. Cutting at an arbitrary byte boundary inside a multi-byte UTF-8
 * sequence is fine here -- `TextDecoder`'s default (non-fatal) mode
 * replaces a broken tail sequence with U+FFFD rather than throwing.
 */
function sanitizeEnvValue(value: string): string {
  const withoutNuls = value.replaceAll("\0", "");
  const bytes = new TextEncoder().encode(withoutNuls);
  if (bytes.length <= ENV_VALUE_MAX_BYTES) {
    return withoutNuls;
  }
  return new TextDecoder().decode(bytes.subarray(0, ENV_VALUE_MAX_BYTES));
}

/**
 * Resolves and runs every hook configured for `event`, across all three
 * config layers, sequentially in `HOOK_LAYER_ORDER`. See
 * `resolveHooksForEvent` for why all matching layers run rather than one
 * winning by precedence.
 *
 * No hook configured for `event` is a no-op: an empty array, no sink calls,
 * nothing spawned.
 *
 * A hook's own failure (non-zero exit, killed at timeout, or unspawnable)
 * never aborts the others and is never thrown -- it is captured in that
 * hook's `HookOutcome` (Controller Ruling 5). This function itself throws
 * only for a programmer error: `event` outside the six named in
 * `HOOK_EVENTS`.
 */
export async function runHooks(options: RunHooksOptions): Promise<HookOutcome[]> {
  if (!(HOOK_EVENTS as readonly string[]).includes(options.event)) {
    throw new CanKanError(
      ErrorCodes.USAGE,
      `runHooks: "${String(options.event)}" is not one of the six hook events`,
      { details: { event: String(options.event) } },
    );
  }

  const resolved = resolveHooksForEvent(options.cfg, options.event);
  if (resolved.length === 0) {
    return [];
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  // Sanitized (fix round 1, finding 2) before ever reaching env or the sink
  // record -- see `sanitizeEnvValue`'s doc comment. Ticket content
  // ($TITLE above all) is attacker-influenced; a caller-supplied value here
  // is not otherwise trusted.
  const ticket = sanitizeEnvValue(options.ticket ?? "");
  const actor = sanitizeEnvValue(options.actor ?? "");
  const from = sanitizeEnvValue(options.from ?? "");
  const to = sanitizeEnvValue(options.to ?? "");
  const title = sanitizeEnvValue(options.title ?? "");

  // Merged, never replaced (task brief §5) -- the five CanKan vars win over
  // whatever the base environment already set for those names.
  const env: Record<string, string | undefined> = {
    ...(options.env ?? process.env),
    TICKET: ticket,
    ACTOR: actor,
    FROM: from,
    TO: to,
    TITLE: title,
  };

  const outcomes: HookOutcome[] = [];
  for (const hook of resolved) {
    const execution = await spawnHook({
      layer: hook.layer,
      file: hook.file,
      command: hook.command,
      cwd: options.repoRoot,
      env,
      timeoutMs,
    });

    const outcome: HookOutcome = {
      layer: hook.layer,
      file: hook.file,
      command: hook.command,
      ...execution,
    };
    outcomes.push(outcome);

    if (options.sink) {
      const record: HookEventRecord = {
        event: options.event,
        ticket,
        actor,
        from,
        to,
        ...outcome,
      };
      // Awaited; a throw here propagates out of `runHooks` (infra failure,
      // not a hook failure -- see `HookSink`'s doc comment).
      await options.sink(record);
    }
  }

  return outcomes;
}
