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
import { monthKeyUtc, validateNowForDateFormatting } from "./log";

/**
 * A path used only to probe whether a ref's resolved target behaves like a
 * tree-ish object (fix round 1, S3) — see `checkRefUsability`. Not a real
 * month file name, so an *accidental* collision with a legitimate,
 * already-populated coordination ref is not a concern. **This does not mean
 * a hostile collision is impossible** (fix round 2, NEW-1) — this module's
 * own stated trust model is "whoever has push access," and a peer with push
 * access controls the *entire* tree, including whatever path is chosen
 * here. Choosing a different or less-guessable path would not close that;
 * see `checkRefUsability`'s doc comment for the actual fix (distinguishing
 * *which* failure a collision here produces, not hiding the collision
 * surface).
 */
const USABILITY_PROBE_PATH = "events/.cankan-ref-usability-probe";

/**
 * The bare top-level path every `events/<yyyy-mm>.jsonl` month file (and
 * `USABILITY_PROBE_PATH` itself) lives under. Named separately from
 * `USABILITY_PROBE_PATH` because the two are probed for different reasons
 * — see `isEventsPrefixBlocked`'s doc comment.
 */
const EVENTS_PREFIX = "events";

/**
 * Fix round 3 follow-up (Ruling R48, orchestrator-directed — the reviewer
 * explicitly extended this dispatch's file grant to cover this function
 * after accepting the rest of fix round 3): `checkRefUsability`'s existing
 * probe reads `USABILITY_PROBE_PATH` (`events/.cankan-ref-usability-probe`),
 * a path *nested under* `events`, not `events` itself. When a blob,
 * symlink, or gitlink is planted at the bare `events` path instead of a
 * real directory, `ls-tree` finds no entry at all under a prefix that
 * isn't a directory — the nested probe path simply "doesn't exist," the
 * same as it would on a genuinely healthy, empty board — so the existing
 * probe alone cannot tell "healthy and empty" apart from "poisoned." This
 * is the exact mechanism Ruling R48 already closed for `read()`
 * (`log.ts`) and `diagnose()`/`recover()` (`recovery.ts`): confirmed by
 * direct probe that `initRef` reported `usable`/success for all three
 * shapes even though `read()` against the identical board already threw
 * `EVENT_LOG_EVENTS_PREFIX_BLOCKED`. Left open, this would have meant
 * `initRef()` reports a poisoned board healthy, after which every later
 * `append` fails forever with a real directory/file conflict — the same
 * class of permanent, silent wedge Ruling R48 exists to prevent, just one
 * function over.
 *
 * **Copied, not imported, from `log.ts`'s `isEventsPrefixBlocked`** — this
 * file's own established "different ownership boundary" convention (see
 * this file's header, and `recovery.ts`'s header, for the identical
 * precedent already set for `trailingMonthKeysOldestFirst`/`monthPath`/
 * etc.). A real blob at `events` makes `readBlobFromRef` return its
 * content directly (non-null, no throw) — blocked. A directory, a
 * symlink, or a gitlink at the exact path all make `readBlobFromRef`
 * throw `GIT_BLOB_AMBIGUOUS` (the adapter's own `mode === "100644"` check
 * does not distinguish *which* non-blob shape it found) — but only a
 * directory (`details.mode === "040000"`) is healthy; a symlink or
 * gitlink sharing that exact error code is fail-closed as blocked, never
 * positively confirmed healthy.
 */
async function isEventsPrefixBlocked(adapter: GitAdapter, validatedRef: string): Promise<boolean> {
  let existing: string | null;
  try {
    existing = await adapter.readBlobFromRef(validatedRef, EVENTS_PREFIX);
  } catch (cause) {
    if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
      const mode = cause.details?.mode;
      return !(typeof mode === "string" && mode === "040000");
    }
    throw cause;
  }
  return existing !== null; // A real blob (non-null content, no throw) is blocked.
}

/** `checkRefUsability`'s result — see that function's doc comment for what each value means and how `initRefCore` reacts to it. */
type RefUsability = "usable" | "absent" | "unusable";

/**
 * `checkRefUsability`'s full result: the outcome plus, for `"unusable"`,
 * the underlying error that produced it. **Fix round 4, Low 1**: the fix
 * round 3 refactor (`assertRefIsUsable` throwing directly →
 * `checkRefUsability` returning a bare `RefUsability` string) silently
 * dropped this — both `initRefCore` call sites passed `refUnusableError`
 * a hardcoded `undefined` for `cause`, so `EVENT_REF_UNUSABLE` stopped
 * carrying the real `GIT_COMMAND_FAILED` (or whatever else) that actually
 * explains *why* the ref is unusable, a diagnosability regression against
 * fm8's "identify the offending ref/commit/file" (and, transitively,
 * whatever underlying git failure produced that state) that fix round 2's
 * `EVENT_REF_UNUSABLE` originally provided. `cause` is `undefined` for
 * `"usable"`/`"absent"` (there is nothing to explain) and the real caught
 * error for `"unusable"`.
 */
interface RefUsabilityResult {
  readonly usability: RefUsability;
  readonly cause?: unknown;
}

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
 * `GIT_COMMAND_FAILED` — the one failure this function reports as
 * `"unusable"`.
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
 * reported as `"usable"`; only `GIT_COMMAND_FAILED` — a genuine "not
 * tree-ish at all" failure, the blob case this function exists to catch —
 * is reported as `"unusable"`.
 *
 * **Fix round 3, L2 — `GIT_REF_NOT_FOUND` is reported as `"absent"`, not
 * `"unusable"`.** `readBlobFromRef` throws this when the ref itself
 * doesn't exist at the moment the probe's own internal `readRef` resolves
 * it — a TOCTOU window between `initRefCore`'s own `readRef` (which found
 * the ref present) and this probe running a moment later, opened by a
 * *concurrent local process* deleting or resetting the ref in between (not
 * peer-triggerable: a remote peer's own ref state has no way to delete
 * this clone's local `refs/cankan/*`). `initRef`'s entire job is "make the
 * ref exist" — treating a ref that turns out to be absent as a hard
 * failure, when the very next thing this function would otherwise do is
 * create one, is the same fail-closed-on-a-benign-condition shape NEW-1
 * fixed in this function's *other* branch. `initRefCore` reacts to
 * `"absent"` by falling through to the same create-the-ref logic it uses
 * when its own `readRef` found nothing in the first place.
 *
 * Any other error is reported as `"unusable"` (fail closed on the
 * unexpected) — only `GIT_BLOB_AMBIGUOUS` and `GIT_REF_NOT_FOUND` have a
 * proven benign explanation.
 *
 * **Fix round 3 follow-up (Ruling R48):** before any of the above, this
 * function first probes the bare `events` prefix itself via
 * `isEventsPrefixBlocked` — see that function's doc comment for why the
 * probe below, on its own, cannot detect this shape. A blocked `events`
 * prefix is reported `"unusable"`, with `cause` carrying a
 * `EVENT_LOG_EVENTS_PREFIX_BLOCKED` error (the same code `log.ts`'s
 * `read()` raises for the identical condition) naming the blocked path and
 * a remediation.
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
async function checkRefUsability(adapter: GitAdapter, validatedRef: string, resolvedSha: string): Promise<RefUsabilityResult> {
  try {
    if (await isEventsPrefixBlocked(adapter, validatedRef)) {
      return {
        usability: "unusable",
        cause: new CanKanError(
          EventErrorCodes.EVENT_LOG_EVENTS_PREFIX_BLOCKED,
          `the top-level "${EVENTS_PREFIX}" path does not resolve to a usable directory (a file, symlink, or gitlink is planted there instead); refusing to report this ref usable`,
          {
            details: {
              ref: validatedRef,
              sha: resolvedSha,
              path: EVENTS_PREFIX,
              remediation: `inspect the tree (e.g. \`git ls-tree ${validatedRef}\`) and rebuild it (git read-tree / git rm --cached ${EVENTS_PREFIX} / commit-tree / update-ref) to remove the entry planted at "${EVENTS_PREFIX}"`,
            },
          },
        ),
      };
    }
  } catch (cause) {
    // `isEventsPrefixBlocked` only interprets `GIT_BLOB_AMBIGUOUS` itself
    // (mode-checked, per its own doc comment) and rethrows anything else
    // unexamined. Two genuinely benign shapes reach here as a result: the
    // ref vanishing between `initRefCore`'s own `readRef` and this probe
    // (`GIT_REF_NOT_FOUND` — fix round 3, L2's exact TOCTOU window,
    // reported `"absent"` immediately, matching the probe below's
    // identical handling of the same code), and `validatedRef` resolving
    // to something that isn't tree-ish *at all* — e.g. a ref planted
    // straight at a blob — which makes `ls-tree` fail identically
    // regardless of which path is probed (confirmed by direct probe:
    // `readBlobFromRef` against both `"events"` and `USABILITY_PROBE_PATH`
    // throws the identical `GIT_COMMAND_FAILED` when `validatedRef`
    // resolves to a blob — not merely inferred from the second probe's own
    // behavior). That second case is deliberately NOT reported here:
    // falling through lets the probe below run its own, identical
    // `readBlobFromRef` call and
    // reach the exact same failure on its own terms, so both probes
    // converge on one consistent `"unusable"` result (with the real cause
    // attached) rather than this one reporting a different, premature
    // verdict from a path collision that was never the actual defect.
    if (isCanKanError(cause) && cause.code === GitErrorCodes.GIT_REF_NOT_FOUND) {
      return { usability: "absent" };
    }
  }
  try {
    await adapter.readBlobFromRef(validatedRef, USABILITY_PROBE_PATH);
    return { usability: "usable" };
  } catch (cause) {
    if (isCanKanError(cause)) {
      if (cause.code === GitErrorCodes.GIT_BLOB_AMBIGUOUS) {
        return { usability: "usable" };
      }
      if (cause.code === GitErrorCodes.GIT_REF_NOT_FOUND) {
        return { usability: "absent" };
      }
    }
    return { usability: "unusable", cause };
  }
}

function refUnusableError(validatedRef: string, resolvedSha: string, cause: unknown): CanKanError {
  return new CanKanError(
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

export interface InitRefOptions {
  /**
   * The clock used to name the placeholder month file (`events/<yyyy-mm>.jsonl`,
   * content `""`) `commitTreeToRef` requires at least one file to write.
   * Defaults to `Date.now()`. Injectable for the same reason as `append`'s
   * `now` — a test can pin which month key gets created without waiting for
   * real time. Validated (fix round 3 sweep) via `log.ts`'s
   * `validateNowForDateFormatting` — `initRef` only ever feeds `now` to
   * `monthKeyUtc`, never a ULID factory, so it needs that (wider) bound,
   * not `append`'s tighter one. Previously **not validated at all**: an
   * unguarded `initRef({now: NaN})` committed a permanent
   * `events/NaN-NaN.jsonl` onto the board's coordination root, a file
   * `read()` can never see.
   */
  readonly now?: number;
}

/**
 * Test-only injection point for `initRefCore`'s single CAS attempt and its
 * usability check — the same pattern as `log.ts`'s `AppendHooks`, and
 * **not part of the public surface**: `initRefCore` is not re-exported
 * from `events/index.ts`, so no normal caller (only a test importing it
 * directly, the way `git.test.ts` imports `updateRefCASCore`) can reach
 * either hook. `initRef`, the public function, calls `initRefCore` with no
 * hooks.
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
  /**
   * Invoked once, after `readRef` has found the ref **present**, and
   * immediately before `checkRefUsability` probes it (fix round 3, L2). A
   * test uses this to delete the ref via a real `git update-ref -d`
   * between the two, reproducing the exact TOCTOU window
   * `checkRefUsability`'s `"absent"` branch exists to handle — a
   * concurrent local process racing `initRef`, not a peer.
   */
  readonly beforeUsabilityCheck?: () => Promise<void>;
}

/**
 * Creates the coordination ref if it does not exist, idempotently and
 * race-safely: two processes calling this concurrently converge on one
 * ref, never corrupt it.
 *
 * **The algorithm** (verified against the real git adapter for this
 * dispatch, not assumed — see task-2-report.md's `parent: null` probe):
 * `readRef` → if non-`null`, confirm the ref is usable (`checkRefUsability`)
 * and, if so, nothing to do. If `null` (or found present but then
 * confirmed `"absent"` by the usability check — fix round 3, L2), attempt
 * `commitTreeToRef` with `parent: null` (M2.6's documented meaning: "the
 * ref must not exist yet") carrying a single placeholder
 * `events/<yyyy-mm>.jsonl` file with empty content (`CommitTreeParams.files`
 * requires at least one file; an empty blob is a well-formed, zero-line
 * month file per `log.ts`'s `splitJsonlLines`). If that CAS applies, this
 * call created the ref. If it is rejected, a concurrent caller won the race
 * — confirmed directly that the loser's rejection is `"reference already
 * exists"` and the winner's content is left completely unchanged — so this
 * function re-reads once and accepts whatever now exists (after confirming
 * *that* ref is usable too); there is no write left for the loser to
 * retry, because the goal ("the ref exists, usably") is already satisfied
 * by the winner.
 *
 * Only **one** CAS attempt is made, not a bounded retry loop: after a
 * rejection, the only outcome this function is trying to reach (some valid
 * ref exists) is already true, so there is nothing to rebuild and rebuild
 * onto. N-process contention beyond two racers is explicitly out of scope
 * for this phase (M2.13's job); two concurrent `initRef` calls converging
 * is this phase's bar, and a single re-read after one rejection already
 * clears it.
 */
export async function initRef(adapter: GitAdapter, ref: string, options: InitRefOptions | null = {}): Promise<void> {
  // Fix round 3 (Ruling R31/R32, orchestrator security review): a default
  // parameter does not apply to an explicit `null` — confirmed by probe,
  // `initRef(adapter, ref, null)` previously threw a raw `TypeError` on
  // `options.now` rather than surfacing through this module's own
  // validated error path. Same pattern applied throughout `log.ts` and
  // `recovery.ts` (fix round 2/3).
  return initRefCore(adapter, ref, options ?? {}, {});
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
    await hooks.beforeUsabilityCheck?.();
    // Fix round 1, S3 / fix round 3, L2: confirm the ref is usable before
    // reporting success — see `checkRefUsability`'s doc comment for what
    // each outcome means.
    const { usability, cause } = await checkRefUsability(adapter, validatedRef, existing);
    if (usability === "usable") {
      return;
    }
    if (usability === "unusable") {
      // Fix round 4, Low 1: `cause` threads the real underlying error
      // (e.g. `GIT_COMMAND_FAILED`) back through — see
      // `RefUsabilityResult`'s doc comment.
      throw refUnusableError(validatedRef, existing, cause);
    }
    // usability === "absent": the ref existed a moment ago but is gone now
    // (a concurrent local deletion/reset) — fall straight through to the
    // same create-the-ref logic below used when `readRef` found nothing in
    // the first place, exactly as if this whole branch had never run.
  }

  const now = options.now ?? Date.now();
  // Fix round 3 sweep: `initRef` previously validated no `now` at all —
  // see `InitRefOptions.now`'s doc comment for the permanent
  // `events/NaN-NaN.jsonl` this let through.
  validateNowForDateFormatting(now);
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
  // exists, usably") is already true once *some* writer's `parent: null`
  // commit has applied.
  const winner = await adapter.readRef(validatedRef);
  if (winner === null) {
    // A CAS rejection here means "the ref already exists" (see the
    // `parent: null` probe in task-2-report.md) — a re-read finding nothing
    // immediately after would mean the ref was both created and removed
    // again between this function's own rejected write and its own next
    // read. This function's single-attempt design (documented above) does
    // not loop to chase that a second time; surfaced as a hard error
    // rather than silently looping on an assumption that no longer holds.
    throw new CanKanError(
      EventErrorCodes.EVENT_REF_INIT_RACE_UNRESOLVED,
      "commitTreeToRef reported the ref already exists, but a re-read still found it absent",
      { details: { ref: validatedRef } },
    );
  }

  // Fix round 1, S3: the winner might not be a usable coordination ref
  // either — confirm before reporting success here too, symmetrically with
  // the branch above. A winner that itself reports `"absent"` here (the
  // ref vanishing yet again, immediately after this function's own
  // re-read just found it) is treated the same as `winner === null` above
  // — the same single-attempt reasoning applies a second time rather than
  // this function growing a retry loop to chase an increasingly
  // pathological race.
  const winnerResult = await checkRefUsability(adapter, validatedRef, winner);
  if (winnerResult.usability === "unusable") {
    // Fix round 4, Low 1: see the identical note at the other call site above.
    throw refUnusableError(validatedRef, winner, winnerResult.cause);
  }
  if (winnerResult.usability === "absent") {
    throw new CanKanError(
      EventErrorCodes.EVENT_REF_INIT_RACE_UNRESOLVED,
      "the ref existed immediately after this function's own write, but vanished again before it could be confirmed usable",
      { details: { ref: validatedRef } },
    );
  }
}
