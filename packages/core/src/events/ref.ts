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

import { CanKanError } from "../errors";
import type { GitAdapter } from "../git/index";
import { validateCoordinationRef } from "../git/index";
import { EventErrorCodes } from "./errors";
import { monthKeyUtc } from "./log";

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
}
