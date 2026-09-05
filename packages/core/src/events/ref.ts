/**
 * `events/ref.ts` — create the orphan coordination ref if it does not exist
 * yet, idempotently and race-safely (ADR 0001, fm6: "a fresh clone brings no
 * `refs/cankan/*`, and a default fetch never creates or advances one").
 *
 * **Relationship to `log.ts`'s `append`, stated explicitly because it is not
 * obvious from either file alone**: `append` performs its *own* lazy init
 * implicitly — when it finds `readRef` returning `null`, its own
 * `commitTreeToRef` call already uses `parent: null`, which both creates the
 * ref and writes the first event in one commit. `append` does **not** call
 * `initRef`, and `initRef` does not call `append`. `initRef` exists for a
 * caller that wants the ref to exist, empty, *before* any real event is
 * ready — `cankan init` (CONCEPT.md's CLI reference: "creates the
 * coordination ref"), or a test fixture that wants a readable-but-empty
 * board. Both functions converge on the same git-level guarantee
 * (`parent: null` is rejected once the ref exists — verified directly, see
 * task-2-report.md's probe) because both are built on the same primitive,
 * not because either calls the other.
 */

import { CanKanError, isCanKanError } from "../errors";
import type { GitAdapter } from "../git/index";
import { GitErrorCodes, validateCoordinationRef } from "../git/index";
import { EventErrorCodes } from "./errors";
import { monthKeyUtc } from "./log";

/**
 * A path used only to probe whether a ref's resolved target behaves like a
 * tree-ish object (fix round 1, S3) — see `assertRefIsUsable`. Not a real
 * month file name, so an *accidental* collision with a legitimate,
 * already-populated coordination ref is not a concern. **This does not mean
 * a hostile collision is impossible** (fix round 2, NEW-1) — this module's
 * own stated trust model is "whoever has push access," and a peer with push
 * access controls the *entire* tree, including whatever path is chosen
 * here. Choosing a different or less-guessable path would not close that;
 * see `assertRefIsUsable`'s doc comment for the actual fix (distinguishing
 * *which* failure a collision here produces, not hiding the collision
 * surface).
 */
const USABILITY_PROBE_PATH = "events/.cankan-ref-usability-probe";

/**
 * `readRef` returning non-null only proves *some* git object exists at
 * `ref` — not that it is a usable coordination ref (fix round 1, S3).
 * Verified directly (real `update-ref`/`commit-tree`, not assumed): a ref
 * planted straight at a **blob** makes `initRef` (before this fix) resolve
 * successfully, after which every later `append`'s `commit-tree -p <ref>`
 * fails forever with an opaque `GIT_COMMAND_FAILED` — and `initRef` could
 * never repair it, because it kept seeing "non-null" and returning.
 *
 * Probed here via the adapter's own `readBlobFromRef`, against
 * `USABILITY_PROBE_PATH`: `readBlobFromRef` resolves `ref` to a commit and
 * runs `ls-tree` against it, which requires its target to be tree-ish. A
 * blob target fails that call outright (`ls-tree` cannot list a blob) with
 * `GIT_COMMAND_FAILED` — the one failure this function converts into a
 * named, diagnosable `EVENT_REF_UNUSABLE`.
 *
 * **Fix round 2, NEW-1 — `GIT_BLOB_AMBIGUOUS` is not evidence of an
 * unusable ref; it is proof of the opposite, and the first version of this
 * function treated it as unusable anyway.** `readBlobFromRef` raises
 * `GIT_BLOB_AMBIGUOUS` only *after* `ls-tree` has already succeeded against
 * a genuinely tree-ish commit — it means the probe *path itself* resolved
 * to something unexpected (a directory, a symlink, a non-`100644` mode),
 * not that the ref's target isn't tree-ish. Confirmed directly to be
 * peer-triggerable, exactly matching this module's own trust model: a peer
 * with push access plants a tree (or any non-blob entry) at
 * `USABILITY_PROBE_PATH` — a path they can predict from this very source
 * file — and the *original* fix-round-1 version of this function reported
 * `EVENT_REF_UNUSABLE` on an otherwise completely healthy board, while
 * `append`/`read` against that same ref continued to work fine. A fix for
 * a fail-open that creates a peer-triggerable fail-closed is strictly
 * worse than the fail-open it replaced. `GIT_BLOB_AMBIGUOUS` is therefore
 * treated as "usable" (this function returns normally); only
 * `GIT_COMMAND_FAILED` — a genuine "not tree-ish at all" failure, the blob
 * case this function exists to catch — is treated as unusable. Any other
 * error is also treated as unusable (fail closed on the unexpected), since
 * only `GIT_BLOB_AMBIGUOUS` has a proven benign explanation.
 *
 * **Known residual gap, out of this fix's reach (Orchestrator Ruling
 * R19).** A ref planted at a raw **tree**, or at **any annotated tag**
 * (fix round 2 doc correction: not only one peeling to a tree — verified
 * directly that a tag pointing at a *commit* is unusable too, since
 * `append`'s later `commit-tree -p <ref>` requires `<ref>` to resolve
 * straight to a commit object, and a tag object never does, regardless of
 * what it tags), is *also* unusable — but is **not** caught here: `ls-tree`
 * operates identically on any tree-ish object (tree, commit, or a
 * tag peeled to either), so this probe cannot tell them apart with the
 * surface `GitAdapter` exposes today. Closing that fully would need an
 * object-type query (e.g. `git cat-file -t <sha>`) that does not exist on
 * `GitAdapter`. Adding one is M2.6's call, not this dispatch's: R19 scopes
 * this fix to `events/`, using only M2.6's existing public surface, and
 * explicitly defers the cleaner fix (the new adapter primitive) to a
 * follow-up recommendation rather than this dispatch editing `git/` to
 * expand its own blast radius. A write-based probe (e.g. attempting
 * `commitTreeToRef` with `parent: existing` to see whether `commit-tree -p`
 * accepts it) was considered and rejected: it would give `initRef` a side
 * effect — a redundant commit — on every call against an already-healthy
 * ref, which is worse than leaving this one case undetected until the
 * M2.6 addition lands.
 */
async function assertRefIsUsable(adapter: GitAdapter, validatedRef: string, resolvedSha: string): Promise<void> {
  try {
    await adapter.readBlobFromRef(validatedRef, USABILITY_PROBE_PATH);
  } catch (cause) {
    if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
      return;
    }
    throw new CanKanError(
      EventErrorCodes.EVENT_REF_UNUSABLE,
      `ref exists but does not resolve to a usable coordination ref: ${validatedRef}`,
      // Fix round 2, NEW-3 (the spirit of it, not the letter): ADR
      // 0001:1176-1178 asks for the offending object identified alongside
      // the ref. There is no *commit* to name here — the whole defect is
      // that `validatedRef` does not resolve to one — so `sha` (not
      // `commit`) is the object it actually resolved to instead, already
      // in the caller's hands from its own `readRef` call and safe to
      // publish for the same module-derived reason `log.ts`'s `commit`
      // fields are.
      { cause, details: { ref: validatedRef, sha: resolvedSha } },
    );
  }
}

export interface InitRefOptions {
  /**
   * The clock used to name the placeholder month file (`events/<yyyy-mm>.jsonl`,
   * content `""`) `commitTreeToRef` requires at least one file to write.
   * Defaults to `Date.now()`. Injectable for the same reason as `append`'s
   * `now` — a test can pin which month key gets created without waiting for
   * real time.
   */
  readonly now?: number;
}

/**
 * Test-only injection point for `initRefCore`'s single CAS attempt — the
 * same pattern as `log.ts`'s `AppendHooks`, and **not part of the public
 * surface**: `initRefCore` is not re-exported from `events/index.ts`, so no
 * normal caller (only a test importing it directly, the way `git.test.ts`
 * imports `updateRefCASCore`) can reach this hook. `initRef`, the public
 * function, calls `initRefCore` with no hooks.
 */
export interface InitRefHooks {
  /**
   * Invoked once, after `readRef` has confirmed the ref is absent and
   * immediately before the `parent: null` `commitTreeToRef` call. A test
   * uses this to create the ref from a second adapter first, so this call's
   * `parent: null` is guaranteed to be rejected — driving the "re-read and
   * accept the winner" branch deterministically rather than by racing two
   * real processes and hoping.
   */
  readonly beforeCas?: () => Promise<void>;
}

/**
 * Creates the coordination ref if it does not exist, idempotently and
 * race-safely: two processes calling this concurrently converge on one
 * ref, never corrupt it.
 *
 * **The algorithm** (verified against the real git adapter for this
 * dispatch, not assumed — see task-2-report.md's `parent: null` probe):
 * `readRef` → if non-`null`, the ref already exists, nothing to do. If
 * `null`, attempt `commitTreeToRef` with `parent: null` (M2.6's documented
 * meaning: "the ref must not exist yet") carrying a single placeholder
 * `events/<yyyy-mm>.jsonl` file with empty content (`CommitTreeParams.files`
 * requires at least one file; an empty blob is a well-formed, zero-line
 * month file per `log.ts`'s `splitJsonlLines`). If that CAS applies, this
 * call created the ref. If it is rejected, a concurrent caller won the race
 * — confirmed directly that the loser's rejection is `"reference already
 * exists"` and the winner's content is left completely unchanged — so this
 * function re-reads once and accepts whatever now exists; there is no
 * write left for the loser to retry, because the goal ("the ref exists") is
 * already satisfied by the winner.
 *
 * Only **one** CAS attempt is made, not a bounded retry loop: after a
 * rejection, the only outcome this function is trying to reach (some valid
 * ref exists) is already true, so there is nothing to rebuild and rebuild
 * onto. N-process contention beyond two racers is explicitly out of scope
 * for this phase (M2.13's job); two concurrent `initRef` calls converging
 * is this phase's bar, and a single re-read after one rejection already
 * clears it.
 */
export async function initRef(adapter: GitAdapter, ref: string, options: InitRefOptions = {}): Promise<void> {
  return initRefCore(adapter, ref, options, {});
}

/** See `InitRefHooks`'s doc comment: the module-internal export a test drives directly. `initRef` is the public surface; it calls this with no hooks. */
export async function initRefCore(
  adapter: GitAdapter,
  ref: string,
  options: InitRefOptions,
  hooks: InitRefHooks,
): Promise<void> {
  const validatedRef = await validateCoordinationRef(ref);

  const existing = await adapter.readRef(validatedRef);
  if (existing !== null) {
    // Fix round 1, S3: confirm the ref is usable before reporting success —
    // see `assertRefIsUsable`'s doc comment.
    await assertRefIsUsable(adapter, validatedRef, existing);
    return;
  }

  const now = options.now ?? Date.now();
  const path = `events/${monthKeyUtc(now)}.jsonl`;

  await hooks.beforeCas?.();

  const outcome = await adapter.commitTreeToRef(validatedRef, {
    parent: null,
    message: "initialize coordination ref",
    files: [{ path, content: "" }],
  });

  if (outcome.outcome === "applied") {
    return;
  }

  // Lost the race: a concurrent initializer's `parent: null` CAS applied
  // first. Re-read and accept the winner's ref — there is nothing to build
  // onto, because the only postcondition this function promises ("the ref
  // exists") is already true once *some* writer's `parent: null` commit has
  // applied.
  const winner = await adapter.readRef(validatedRef);
  if (winner === null) {
    // A CAS rejection here means "the ref already exists" (see the
    // `parent: null` probe in task-2-report.md) — a re-read finding nothing
    // immediately after would mean the ref was both created and removed
    // between this function's own rejected write and its own next read, a
    // sequence nothing in this design performs. Surfaced as a hard error
    // rather than silently looping on an assumption that no longer holds.
    throw new CanKanError(
      EventErrorCodes.EVENT_REF_INIT_RACE_UNRESOLVED,
      "commitTreeToRef reported the ref already exists, but a re-read still found it absent",
      { details: { ref: validatedRef } },
    );
  }

  // Fix round 1, S3: the winner might not be a usable coordination ref
  // either (see `assertRefIsUsable`) — confirm before reporting success
  // here too, symmetrically with the `existing !== null` branch above.
  await assertRefIsUsable(adapter, validatedRef, winner);
}
