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
 * because a compile-time brand carries no runtime guarantee (see `Sha`'s
 * doc comment in `adapter.ts` for the same point applied to CAS values).
 *
 * Exported standalone (rather than only as an adapter method) because
 * `git check-ref-format` needs no repository and no pinned root — confirmed:
 * it runs identically from any directory, including one with no `.git` at
 * all — so a config loader (M2.3) can reuse this exact check at load time
 * without needing a `GitAdapter` instance.
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
  // directly, without `--end-of-options`. Direct verification for this task
  // found `check-ref-format` does not use `parse-options` the way most git
  // plumbing does: even `-- <refname>` is rejected as a usage error, so
  // `--end-of-options` is not merely unnecessary here, it is not accepted.
  const proc = Bun.spawn(["git", "check-ref-format", ref], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    rejectRef(ref, `git check-ref-format rejected it: ${stderr.trim()}`);
  }

  return ref;
}
