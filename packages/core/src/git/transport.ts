/**
 * The single internal chokepoint every git invocation in this module goes
 * through: one `Bun.spawn` call site (`runGitRaw`), with a throwing
 * convenience wrapper (`runGit`) built on top of it for the call sites that
 * only need "did it succeed, and what did it print."
 *
 * **Fix-round-1 Ruling 11 — the transport moved off `simple-git`.** The
 * original implementation wrapped `simple-git` (per PLAN.md M2.6's "wrapping
 * `simple-git`"), but two independent reviews and this module's own
 * development found five measured reasons that library is the wrong
 * transport for a module where a command's exit code is load-bearing:
 *
 * 1. `simple-git`'s error detection is `isTaskError = !!(result.exitCode &&
 *    result.stdErr.length)` — it silently *resolves* for any command that
 *    exits non-zero with empty stderr. This forced two direct-spawn
 *    exceptions in the prior version of this module (`hash-object -w
 *    --stdin`, `check-ref-format`), and a third instance of the same defect
 *    was found on `rev-parse --verify --quiet` (which cannot distinguish
 *    "ref absent" from "ref present but unreadable/broken" — both resolve to
 *    the same empty string).
 * 2. It exposes **no exit code at all** on its `GitError` (only an
 *    own-enumerable `task`), forcing every discrimination this module makes
 *    to be a locale-sensitive stderr *string* match, with no exit code as a
 *    first-class signal to fall back on.
 * 3. Its `.env()` replaces rather than merges the environment and mutates
 *    the instance it's called on.
 * 4. Its unsafe-operations plugin gates on an 18-key private table; using it
 *    safely meant either mirroring that table (incompletely, as found) or
 *    disabling the guard outright.
 * 5. Its `GitError` carries raw argv in an own-enumerable `task.commands`,
 *    which `util.inspect` (and therefore `console.error` and Bun/Node's
 *    uncaught-rejection printer) renders in full — a credential embedded in
 *    a remote URL argument leaked through that path even though `toJSON()`
 *    and `JSON.stringify` were clean.
 *
 * `Bun.spawn` gives this module `{ exitCode, stdout, stderr }` directly, so
 * exit codes become the primary discriminator (per-command, since git's
 * exit-code conventions are not uniform — see each call site), with the
 * ADR's stderr-text signatures (CAS rejection, non-fast-forward push/fetch)
 * still matched where the ADR specifies them by message text rather than by
 * a distinct exit code. This removes both prior direct-spawn exceptions
 * (`hash-object` and `check-ref-format` are now ordinary calls through
 * `runGit`/`runGitRaw`) rather than adding a third — the module has exactly
 * one transport again.
 *
 * `simple-git` remains a dependency in `package.json` (frozen for this lane;
 * not edited here) but is no longer imported anywhere in
 * `packages/core/src/git/`.
 */

/** The raw result of one git invocation — never thrown, always returned. */
export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunGitOptions {
  /**
   * Extra environment variables layered on top of `process.env` (e.g.
   * `GIT_INDEX_FILE` for the off-tree tree-build). Merged, never replaces —
   * R7's mandate, restored to its original unqualified form now that
   * `simple-git`'s env-inspecting plugin is gone: `process.env` is spread
   * whole, with no exclusions.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Content to write to the child process's stdin, then close it. Only
   * `hash-object -w --stdin` uses this (ADR 0001:411-413: its content
   * arrives on stdin, and it takes no ref/path/commit argument at all).
   */
  readonly stdin?: string;
}

/**
 * The one `Bun.spawn` call site in this module. Array-form argv only. `cwd`
 * is always explicit (the ADR's cwd pin, ADR 0001:433-457, is unchanged and
 * still load-bearing — this transport does not introduce any dependency on
 * `process.cwd()`). Never throws: every invocation's exit code, stdout, and
 * stderr are all returned for the caller to interpret, since git's failure
 * conventions are not uniform across commands (some commands' exit codes
 * carry distinct meanings this module must discriminate — `show-ref
 * --exists`, `update-ref`'s CAS compare, `symbolic-ref -q` — and forcing a
 * single throw-on-nonzero policy here would erase exactly the signal this
 * ruling exists to expose).
 */
export async function runGitRaw(
  cwd: string,
  argv: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...argv], {
    cwd,
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // R7, restored: the real `process.env`, spread whole, plus `LC_ALL: "C"`
    // (git localizes stderr through gettext otherwise, and every stderr-text
    // discrimination this module makes depends on the C locale) and any
    // caller-supplied extra vars (e.g. `GIT_INDEX_FILE`).
    env: { ...process.env, LC_ALL: "C", ...options.env },
  });

  if (options.stdin !== undefined) {
    // `stdin: "pipe"` was requested above whenever `options.stdin` is
    // defined, so `proc.stdin` is a `FileSink` here — Bun's own type for
    // `Bun.spawn`'s return value types `stdin` as possibly `undefined`
    // because the two options are chosen dynamically above, not because it
    // can actually be missing in this branch.
    const stdin = proc.stdin as NonNullable<typeof proc.stdin>;
    stdin.write(options.stdin);
    await stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

/**
 * Throwing convenience wrapper over `runGitRaw`, for call sites that treat
 * any non-zero exit as failure and want the stdout text on success.
 *
 * **F3 — the thrown error is a plain `Error` built only from `stderr`, never
 * an object carrying argv.** This is what makes the credential-leak
 * mitigation hold *by construction*, not by a test-by-test discipline of
 * remembering not to copy `cause` into `message`/`details`: there is no
 * third-party error type in this module (like `simple-git`'s `GitError`)
 * with an own-enumerable property that `util.inspect` — and therefore
 * `console.error`, and Bun/Node's uncaught-rejection printer — would render
 * in full. A `cause` attached anywhere in this module is either this plain
 * `Error` or one this module constructs the same way; whatever text git put
 * in its own stderr is already the extent of what a `cause` can carry, and
 * git redacts credentials from its own stderr itself (confirmed directly:
 * `fatal: unable to access 'https://host/x.git/': ...` never includes
 * embedded userinfo, even when the argv that produced it did).
 */
export async function runGit(
  cwd: string,
  argv: readonly string[],
  options: RunGitOptions = {},
): Promise<string> {
  const result = await runGitRaw(cwd, argv, options);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(stderr.length > 0 ? stderr : `git ${argv[0]} exited ${result.exitCode}`);
  }
  return result.stdout;
}
