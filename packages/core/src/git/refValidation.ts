/**
 * The mandatory ref check (ADR 0001:336-390, "M2.6 (`git/adapter.ts`) must
 * implement"). `.cankan/config.yml`'s `coordination.ref` is checked-in,
 * repo-level config that a hostile or merely misconfigured repo controls
 * (CONCEPT.md:290-292); pointing it at `refs/heads/main` or `HEAD` makes the
 * CAS + off-tree tree-build + mandated `<ref>:<ref>` push append a commit to
 * `main` on the remote, indistinguishable from a legitimate one once pushed
 * (confirmed on git 2.55 for this ADR). M2.3's config loader should reject
 * the same thing at load time, but M2.6 is the *last* point before git and is
 * reachable by callers that bypass that loader (tests, a future `--ref` flag,
 * a hand-edited board) — so M2.6's check is a "must" and may never assume
 * M2.3 already ran.
 *
 * **R6 — order is mandatory, not incidental.** The regex anchor runs first
 * because it is the only one of the two checks that guarantees the string
 * cannot begin with `-` before it reaches a git process; running
 * `check-ref-format` on an unfiltered value would itself be an
 * argument-injection surface. Neither check alone suffices:
 * `refs/cankan/../heads/main` matches the regex (`.` and `/` are both in its
 * character class) but `check-ref-format` rejects it; `refs/heads/main`
 * passes `check-ref-format` (it is a syntactically valid ref name) but the
 * regex anchor rejects it for being outside `refs/cankan/`.
 */
const COORDINATION_REF_PATTERN = /^refs\/cankan\/[A-Za-z0-9._/-]+$/;

import { tmpdir } from "node:os";
import { CanKanError } from "../errors";
import { GitErrorCodes } from "./errors";

function rejectRef(ref: string, reason: string): never {
  throw new CanKanError(GitErrorCodes.GIT_REF_INVALID, `invalid ref: ${reason}`, {
    details: { ref, reason },
  });
}

/**
 * Validates `ref` against both mandated checks and returns it unchanged if
 * it passes. Throws a typed `GIT_REF_INVALID` error otherwise. Every
 * ref-taking operation in this module calls this first, unconditionally —
 * a caller cannot opt out by claiming a value was validated elsewhere,
 * because a compile-time brand carries no runtime guarantee (see
 * `ObjectSha`'s doc comment in `types.ts` for the same point applied to CAS
 * values).
 *
 * Exported standalone (rather than only as an adapter method) because
 * `git check-ref-format` needs no repository and no pinned root — confirmed:
 * it runs identically from any directory, including one with no `.git` at
 * all — so a config loader (M2.3) can reuse this exact check at load time
 * without needing a `GitAdapter` instance.
 *
 * **A second, necessary exception to R1's "one chokepoint" framing — not a
 * style preference, a correctness requirement, confirmed directly for this
 * task.** `check-ref-format` prints *nothing* to stderr when it rejects a
 * ref; it only sets a non-zero exit code (confirmed: redirecting stdout and
 * stderr separately on a rejected ref, both are empty, exit code 1).
 * `simple-git`'s own `raw()` decides whether a task failed with `exitCode &&
 * stdErr.length` (confirmed by reading its installed
 * `error-detection.plugin` source for this task) — both must be truthy, so a
 * non-zero exit with empty stderr is **silently treated as success**,
 * `raw()` resolves instead of rejecting, and the specific abuse case the ADR
 * spends the most space on (`refs/cankan/../heads/main`, which passes the
 * regex above) would pass validation. This was caught by this task's own
 * test suite, not by inspection: routing this call through the same
 * `simple-git`-based chokepoint every other command in this module uses
 * made the `refs/cankan/../heads/main` rejection test fail. `hash-object`'s
 * exception exists because `simple-git` cannot reach a stdin channel;
 * this one exists because `simple-git`'s error detection cannot see this
 * command's failure at all. Exit code is checked directly, exactly as
 * `hashObjectStdin` does in `adapter.ts`.
 */
export async function validateCoordinationRef(ref: string): Promise<string> {
  if (ref.length === 0) {
    rejectRef(ref, "ref is empty");
  }
  if (!COORDINATION_REF_PATTERN.test(ref)) {
    rejectRef(ref, "ref does not match ^refs/cankan/[A-Za-z0-9._/-]+$");
  }

  // The regex above already guarantees `ref` cannot begin with `-` (it must
  // begin with the literal `refs/cankan/`), so `check-ref-format` is run
  // without `--end-of-options`. Direct verification for this task found
  // `check-ref-format` does not use `parse-options` the way most git
  // plumbing does: even `-- <refname>` is rejected as a usage error (exit
  // 129), so `--end-of-options` is not merely unnecessary here, it is not
  // accepted.
  const proc = Bun.spawn(["git", "check-ref-format", ref], {
    // `check-ref-format` doesn't consult the working directory at all, but
    // `cwd` is pinned to a directory this module doesn't otherwise touch
    // rather than left to inherit `process.cwd()` — this module's own stated
    // principle (never rely on the host process's current directory) holds
    // without a "except here, harmlessly" footnote.
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    // `stderr` is expected to be empty here (see this function's doc
    // comment) — included anyway in case a future git version starts
    // reporting a reason, rather than assuming it stays silent forever.
    rejectRef(ref, `git check-ref-format rejected it (exit ${exitCode}): ${stderr.trim()}`);
  }

  return ref;
}
