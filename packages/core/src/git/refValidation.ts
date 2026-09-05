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
import { runGitRaw } from "./transport";

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
 * without needing a `GitAdapter` instance. `os.tmpdir()` stands in for a
 * pinned root here for exactly that reason.
 *
 * **This only covers the ref's *name*.** A ref whose name passes both
 * checks can still be a **symbolic ref** pointing somewhere outside
 * `refs/cankan/` — ADR 0001 notes exactly this for `HEAD` ("works
 * identically, since `update-ref` dereferences it") but only defends
 * lexically, at the name level. `adapter.ts`'s `ensureValidRef` layers the
 * additional, repository-aware symref check on top of this one for every
 * operation this module actually performs against a real repository;
 * `validateCoordinationRef` alone is deliberately name-only (fix-round-1
 * F1) so it stays usable without a repository — e.g. by M2.3's config
 * loader, which has no `GitAdapter` and no pinned root to check a symref
 * against.
 *
 * Routed through this module's one `Bun.spawn` chokepoint (`transport.ts`'s
 * `runGitRaw`) like every other git invocation in this module (fix-round-1
 * Ruling 11). `check-ref-format` previously needed a separate direct spawn
 * because `simple-git`'s error detection silently swallowed this exact
 * command's failure (a non-zero exit with empty stderr); now that the
 * chokepoint itself exposes the exit code directly, `check-ref-format` is an
 * ordinary call like any other.
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
  const result = await runGitRaw(tmpdir(), ["check-ref-format", ref]);
  if (result.exitCode !== 0) {
    // `stderr` is expected to be empty here — `check-ref-format` reports a
    // rejection purely through its exit code (confirmed directly) —
    // included anyway in case a future git version starts reporting a
    // reason, rather than assuming it stays silent forever.
    rejectRef(ref, `git check-ref-format rejected it (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }

  return ref;
}
