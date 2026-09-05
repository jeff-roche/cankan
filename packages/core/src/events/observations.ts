/**
 * `events/observations.ts` — the lease-observation store (ADR
 * `docs/decisions/0001-coordination-ref.md`, failure mode 7, lines
 * 1014-1163).
 *
 * **Why this exists.** Lease expiry cannot trust any timestamp reachable
 * from the coordination ref: the event's own `ts`, and equally the CAS
 * commit's committer/author dates, are all written by whoever appended the
 * event, and a peer with push access can set any of them arbitrarily. So
 * each reader records, against its **own host clock**, the moment it first
 * saw a lease-bearing event id — a `claim` or `renew` — and later expiry is
 * measured against that reader-local record, never against anything a peer
 * supplied.
 *
 * **This module is a standalone API, not a hook `events/log.ts`'s `read()`
 * calls implicitly — Ruling R6 (orchestrator, binding).** `expireStale()` is
 * M2.10's; this module only provides the observation store it reads and
 * writes. **M2.10's obligation, stated plainly because nothing enforces it
 * from outside:** on every path that reads a `claim`/`renew` event off the
 * ref, M2.10 must call {@link observe} for that event id — the *first* time
 * `observe` is called for a given `(boardKey, eventId)` pair is the only
 * one that matters (see below), so calling it redundantly is harmless, and
 * a call that never happens is a lease that never expires, silently, with
 * nothing here to detect it. Symmetrically, on every `release` event M2.10
 * folds, it must call {@link discard} for every claim/renew event id it
 * ever observed for that ticket's ended lease — see {@link discard}'s doc
 * comment for why "every", not just the most recent one.
 *
 * **Idempotence.** {@link observe} is first-write-wins: a second call for
 * the same `(boardKey, eventId)` pair never moves the recorded time. This
 * is the other half of the R6 mitigation above — an extra, redundant call
 * is always safe, so the only way M2.10 can get this wrong is by *skipping*
 * a call, which is easier to review for than "called it, but at the wrong
 * time."
 *
 * ## Keys, and why neither is used raw as a path component
 *
 * The store is keyed by **board** and by **event id**, persisting across
 * invocations (a per-process record would re-observe every event on every
 * command, and no lease would ever expire). **Neither key is a filesystem
 * path component in raw form; the path component is a hash of the key**
 * (ADR 1050-1091) — both halves load-bearing, independently:
 *
 * - The **event id** is read back off the coordination ref, so it is a
 *   peer-supplied string, not something this process minted. An id of
 *   `../../../../home/victim/.gitconfig` reaching an unguarded
 *   `join(stateDir, boardKey, eventId)` intact would let any collaborator
 *   who reads the ref write a file at the composed path, outside the state
 *   directory, as their own user — for one push by one peer with push
 *   access. Hashing the id removes the question rather than answering it
 *   twice: a hash of any input is a single path component with no
 *   separator and no `..`.
 * - The **board key** (see below) is a realpath'd *absolute* path.
 *   Composing an absolute path with `path.resolve` rather than
 *   `path.join` discards the state directory entirely — confirmed directly
 *   (see task-3-report.md's probe): `path.resolve("/state/cankan",
 *   "/home/u/repo/.git")` returns `/home/u/repo/.git`, siting the store
 *   inside the repository's own git directory. Hashing the board key closes
 *   this the same way: the hash is never absolute, so there is no
 *   `path.resolve` absorption hazard to get right or wrong at any call site.
 *
 * **Independently of hashing, the ULID grammar binds on read, not only on
 * minting** (ADR 1082-1091): every `eventId` this module is given is
 * checked against {@link isValidEventId} *before* it is hashed. Validating
 * the grammar and hashing are both required; neither alone closes the
 * other's half — a non-ULID string would still hash to a safe path
 * component, but accepting it here would let a schema-invalid id slip past
 * the fail-closed disposition every other event-log boundary enforces, and
 * conversely, skipping the hash and keying only on a grammar-checked ULID
 * would still leave the *board* key (never ULID-shaped) unguarded.
 *
 * ## The board key is the common git dir
 *
 * Every worktree of one clone shares one coordination ref, so they must
 * share one observation record or two worktrees compute different
 * expiries for the same claim (ADR 1093-1112). {@link boardKeyFor} derives
 * the key via `GitAdapter.gitCommonDir()` — **this module never shells out
 * to git itself; M2.6 is the only module permitted to.** `gitCommonDir()`
 * is documented (`git/types.ts`) to already return a `--path-format=absolute
 * --git-common-dir` result that is canonical (symlink-resolved) by
 * construction, so no separate `fs.realpath` call is added here — adding
 * one would be redundant, not more correct. Verified directly, in this
 * worktree, that a main worktree root, a subdirectory of it, and a linked
 * worktree of the same clone all resolve to the same value (task-3-report.md).
 *
 * ## Where the store lives
 *
 * `$XDG_STATE_HOME/cankan/observations/` (CONCEPT.md:270's reservation),
 * defaulting to `~/.local/state/cankan/observations/` when the variable is
 * unset **or empty** — the empty-string case is not optional to handle:
 * reading it empty and stopping would hard-error where the documented
 * default would have worked (ADR 1054-1060).
 *
 * ## Discarded on release
 *
 * A `release` event ends a lease outright, and every observation record
 * that lease ever accumulated **must** be discarded — not "may" (ADR
 * 1044-1049). The store is otherwise unbounded: it grows by one record
 * per lease-bearing event id ever observed, and a peer with push access
 * (via repeated `renew`, each minting a fresh event id) drives that
 * growth directly. `discard` removes one `(boardKey, eventId)` record;
 * because a single lease's lifetime can span a `claim` and any number of
 * `renew` events — each a *distinct* event id, each independently
 * observed the first time a reader saw it — bounding growth requires
 * M2.10 to call `discard` once per such id it ever observed for that
 * ticket, not only for the lease's final (most recent) event id.
 *
 * ## Failure disposition — Ruling R7 (orchestrator, binding)
 *
 * - **A missing record** (the ordinary case the first time an event id is
 *   seen) is not an error: {@link observe} records now and returns it;
 *   {@link firstSeen} returns `null`. Treating an unobserved claim as
 *   unexpired over-honors the lease, which is the fail-closed direction
 *   for a mutual-exclusion primitive (ADR 1116-1119).
 * - **An absent store** (no state directory yet) is likewise graceful:
 *   {@link observe} creates it and proceeds; {@link firstSeen} reports "no
 *   record" rather than erroring.
 * - **An unwritable or unreadable store is a typed hard error**
 *   (`EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE`) — not a
 *   warning, not a silent skip (ADR 1120-1123). Proceeding without
 *   recording would silently re-observe the same event on the next
 *   invocation, so no lease would ever expire — a failure invisible from
 *   the outside, which this module refuses to shrug off. A direct
 *   consequence, accepted deliberately (ADR 1142-1148): a reader with a
 *   read-only or full state directory hard-errors, and the board stops
 *   answering for that reader until the directory is writable again.
 *
 * ## What this store does not promise (ADR 1125-1140)
 *
 * - A clone that first sees an already-old claim starts its clock late and
 *   honors that claim for up to one full lease counted from its own first
 *   sight, not from when the claim was actually made. A clone with an
 *   ephemeral state directory (CI, a throwaway container) does this for
 *   every lease it sees. Both cost **liveness** — a ticket stays
 *   unclaimable somewhat longer than strictly necessary — and neither
 *   costs **mutual exclusion**.
 * - Mutual exclusion does not depend on any clock agreement between
 *   readers: taking over an expired claim appends a *new* event, so the
 *   ref's CAS plus the mandated re-read-and-re-check on rejection
 *   serializes concurrent takeovers exactly as it serializes concurrent
 *   first claims. Clock disagreement between two readers changes only
 *   *when* each is willing to attempt a takeover, never whether two
 *   takeovers can both succeed. This module deliberately builds no
 *   cross-process locking or fsync ceremony beyond that — it does not go
 *   looking for a stronger guarantee from clock agreement than the design
 *   needs from it.
 * - `actor` is not an authenticated identity (see `events/schema.ts`), so
 *   a forged `release` frees a ticket with no clock consulted at all. This
 *   module does not — and must not — build release authorization on
 *   `actor` (ADR 1154-1163); `discard` trusts its caller (M2.10) to have
 *   already decided a `release` is being honored, the same way every other
 *   consumer of `actor` must.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CanKanError, isCanKanError } from "../errors";
import type { GitAdapter } from "../git/index";
import { EventErrorCodes } from "./errors";
import { validateNowForDateFormatting } from "./log";
import { type EventId, isValidEventId } from "./schema";

/**
 * Mirrors `log.ts`'s own `MAX_DATE_MS` (not exported, and not imported here
 * — `log.ts` is frozen and out of this dispatch's authority to edit; this
 * is the same literal, `Date`'s own representable-range bound). Used only
 * to bound a *read-back* `firstSeenAtMs` (fix round 2) — the write side
 * already bounds `now` to this same range via `validateNowForDateFormatting`
 * before it is ever stored, so a value outside it on read is never one this
 * module wrote itself.
 */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * `sha256`, hex-encoded: collision resistance well beyond anything this
 * module's threat model needs (a hostile board key or event id, not a
 * cryptographic adversary hunting for a second preimage), built into
 * `node:crypto`, and therefore adds no dependency (constraint 5).
 */
function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * `$XDG_STATE_HOME/cankan`, defaulting to `~/.local/state/cankan` when the
 * variable is unset **or empty** (ADR 1054-1060 — the empty-string case is
 * named explicitly as the anticipated implementer mistake).
 *
 * **A relative `XDG_STATE_HOME` is ignored, the same way `config/layers.ts`'s
 * `resolveGlobalConfigPath` ignores a relative `XDG_CONFIG_HOME`** (that
 * file's own R11 comment, itself a security-review finding): the XDG Base
 * Directory spec says a relative value "should" be treated as if unset, and
 * accepting one here would let the store's location vary with whatever
 * directory a command happens to be run from — the exact
 * per-invocation instability obligation 3's git-common-dir key exists to
 * prevent, just arriving through an environment variable instead of a
 * worktree path. `HOME` gets no such filtering — an explicitly-relative
 * `HOME` is used as given, which composes into a relative `stateDir`, which
 * the guard below then catches. If, after both fallbacks, the resulting
 * `stateDir` still isn't absolute (a `HOME` that is itself relative, real or
 * synthetic, with no usable `XDG_STATE_HOME` to override it), this throws
 * `EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE` rather than resolve
 * to a `process.cwd()`-relative path no two invocations would agree on.
 *
 * **Reads from an injected `env`, never from `process.env` directly** —
 * the same reason `config/layers.ts`'s `resolveGlobalConfigPath` does:
 * assigning `process.env.X = undefined` coerces to the literal string
 * `"undefined"` rather than actually unsetting the key, so a test built
 * that way would silently exercise the wrong branch. Exported
 * (module-internal — not re-exported from `events/index.ts`) so a test can
 * drive the unset/empty/relative/set branches directly and hermetically,
 * the same pattern `layers.test.ts` uses; the real entry points below call
 * this with `process.env`, and a separate `withEnv()`-wrapped integration
 * test proves that wiring end to end. `homedir()` is only ever consulted
 * when `env.HOME` is absent or empty — never merely relative — so a
 * synthetic `env` that supplies its own (even malformed) `HOME` never
 * silently falls through to the real machine's home directory.
 */
export function resolveStateDir(env: Readonly<Record<string, string | undefined>>): string {
  const xdgStateHome = env.XDG_STATE_HOME;
  const envHome = env.HOME;
  const home = envHome !== undefined && envHome.length > 0 ? envHome : homedir();
  const base =
    xdgStateHome !== undefined && xdgStateHome.length > 0 && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(home, ".local", "state");
  const stateDir = join(base, "cankan");
  if (!isAbsolute(stateDir)) {
    throw new CanKanError(
      EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
      "lease-observation store location could not be resolved to an absolute path",
      { details: { operation: "resolve state directory" } },
    );
  }
  return stateDir;
}

/**
 * A caller-supplied `boardKey` is never peer-controlled (it comes from this
 * process's own `git rev-parse` via {@link boardKeyFor}, not from anything
 * read off a coordination ref), so this guard exists only to catch a
 * programming mistake before it silently keys an empty-string bucket —
 * not the security boundary; hashing is (see the module doc comment).
 */
function assertValidBoardKey(boardKey: string): void {
  if (typeof boardKey !== "string" || boardKey.length === 0) {
    throw new CanKanError(EventErrorCodes.EVENT_OBSERVATION_INVALID_BOARD_KEY, "boardKey must be a non-empty string", {
      details: { receivedType: typeof boardKey },
    });
  }
}

/**
 * The security-critical half of obligation 2: an `eventId` reaches this
 * module having been read straight off the coordination ref by a caller
 * (M2.10), so it is peer-supplied. Checked against the ULID grammar
 * *before* it is ever hashed or used to build a path — an id that fails
 * this check never reaches {@link hashKey} at all.
 */
function assertValidEventId(eventId: string): asserts eventId is EventId {
  if (typeof eventId !== "string" || !isValidEventId(eventId)) {
    throw new CanKanError(
      EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID,
      "eventId must be a 26-character uppercase Crockford base32 ULID",
      { details: { receivedType: typeof eventId } },
    );
  }
}

/**
 * Exported (module-internal — not re-exported from `events/index.ts`) so a
 * test can compute the exact on-disk path a given `(boardKey, eventId)`
 * pair hashes to, and — critically — so a test can call this directly with
 * a hostile-shaped `eventId` string (cast `as EventId` at the call site,
 * the same idiom `log.test.ts` uses for every branded-id type) to prove
 * the *hashing* guard alone makes the result safe, independent of the
 * ULID-grammar guard every real entry point below applies first. Every
 * real caller in this file (`observe`/`firstSeen`/`discard`) always calls
 * this only after `assertValidEventId` has already run.
 */
export function recordPath(boardKey: string, eventId: EventId): string {
  return join(resolveStateDir(process.env), "observations", hashKey(boardKey), hashKey(eventId));
}

/**
 * Ruling R7: an unwritable or unreadable store is a typed hard error, never
 * a warning or a silent skip. `details` never carries a filesystem path —
 * `resolveStateDir()`'s result is derived from `$XDG_STATE_HOME`/`$HOME`,
 * values this module does not control and must not publish (`../errors.ts`'s
 * `details` discipline) — only the operation that failed, which is safe
 * because it is a fixed string this module itself chose.
 */
function storeUnavailableError(operation: string, cause: unknown): CanKanError {
  return new CanKanError(
    EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
    `lease-observation store is unwritable or unreadable (${operation})`,
    { cause, details: { operation } },
  );
}

interface StoredObservation {
  readonly firstSeenAtMs: number;
}

/**
 * `undefined` for anything that isn't a well-formed record — corrupt
 * content is treated the same as "no record" (see `firstSeen`/`observe`'s
 * doc comments).
 *
 * **Bounded to `[0, MAX_DATE_MS]` — fix round 2, read-side hygiene;
 * tightened from `[-MAX_DATE_MS, MAX_DATE_MS]` in fix round 3, Minor 6.**
 * `observe()`'s own write side stores only `Date.now()` or a caller-injected
 * test value (see `ObserveOptions.now`'s doc comment) — a reader-local
 * wall-clock observation is never negative, so `[0, MAX_DATE_MS]` is the
 * tighter, still-honest mirror of what this module ever legitimately
 * writes, in exactly the direction that matters: a negative
 * `firstSeenAtMs` reads as *maximally* ancient to any expiry arithmetic
 * that subtracts it from "now." `Number.isFinite` alone rejects
 * `NaN`/`Infinity` but not an in-range-for-`isFinite`, absurd-for-a-Date
 * value (e.g. `Number.MAX_SAFE_INTEGER`, which exceeds `MAX_DATE_MS`).
 * Mirroring the write side's own bound removes that degree of freedom from
 * whatever reads this value next, without this module needing to reason
 * about which specific downstream computation an out-of-range value might
 * corrupt. **This is hygiene, not the security control**: any value in
 * `[0, now]` still lets a planted record report an earlier-than-true
 * first-observation time — the defense against that is the ownership
 * chain (`ensurePrivateDir`), not this bound.
 */
function parseStoredObservation(content: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "firstSeenAtMs" in parsed &&
      typeof (parsed as StoredObservation).firstSeenAtMs === "number" &&
      Number.isFinite((parsed as StoredObservation).firstSeenAtMs) &&
      (parsed as StoredObservation).firstSeenAtMs >= 0 &&
      (parsed as StoredObservation).firstSeenAtMs <= MAX_DATE_MS
    ) {
      return (parsed as StoredObservation).firstSeenAtMs;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Derives the store's board key from a `GitAdapter` — the repository's common git directory, per obligation 3. See the module doc comment for why this, and not the current worktree's own path, is the key every worktree of one clone must share. */
export async function boardKeyFor(adapter: GitAdapter): Promise<string> {
  return adapter.gitCommonDir();
}

/**
 * Bounds the retry loop in `observe()` (fix round 1, C1/S1) — a
 * pathologically persistent contention or corruption cycle hard-errors
 * rather than looping forever. Five is generous headroom over the number of
 * genuinely concurrent local callers this store is ever expected to see;
 * per obligation 7, this module does not go further and add backoff/sleep
 * ceremony around it.
 */
const MAX_OBSERVE_ATTEMPTS = 5;

/**
 * `link()` failed for a reason other than "something is already there"
 * (`EEXIST`) — fix round 2, L3 (Ruling R38). `EPERM`/`ENOTSUP` (exFAT/FAT,
 * some FUSE and network mounts don't support hard links at all) and
 * `EXDEV` (confirmed directly reachable — cross-device, which can occur
 * even for two names inside what looks like one directory, on some overlay
 * or bind-mount setups) all mean this store's placement mechanism cannot
 * work on this filesystem at all, not that this one call failed. Named
 * explicitly, with the remedy, rather than folded into the generic
 * unwritable-store message: a silent `EACCES`-shaped failure here would
 * read as "permissions," when the actual fix is "this filesystem," which a
 * permissions fix cannot touch.
 *
 * **Deliberately not a fallback to a non-atomic write.** Falling back to
 * `writeFile(path, payload, { flag: "wx" })` on these filesystems would
 * reintroduce fix round 1's Critical C1 race (a torn read misclassified as
 * corrupt and overwritten) on exactly the filesystems that hit this branch
 * — trading a loud, actionable failure for a silent double-claim. Ruling
 * R38 is explicit that this must diagnose, not degrade.
 */
// Exported (module-internal — not re-exported from `events/index.ts`) so a
// test can verify this error-shape mapping directly. Reproducing the real
// `link()` failure end to end needs a filesystem without hard-link support
// (exFAT/FAT) or a genuine cross-device setup mounted — both need root in
// this environment (Ruling R38's own note); this is the part of the fix
// that can be verified without one.
export function hardLinkUnsupportedError(cause: NodeJS.ErrnoException): CanKanError {
  return new CanKanError(
    EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
    "the lease-observation store's filesystem does not support hard links, which this store requires to place records atomically -- set $XDG_STATE_HOME to a filesystem that does",
    { cause, details: { operation: "link observation record into place" } },
  );
}

export const HARD_LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

/**
 * Attempts to atomically place `payload` at `path` **without ever
 * dereferencing a pre-existing entry at `path`, and without overwriting
 * one** — fix round 1, Critical C1 / High S1. Returns `true` if this call
 * won (`path` now holds `payload`, freshly written by this call), `false`
 * if something already occupies `path` (first-write-wins: a `false` result
 * is not a failure — it means a prior writer, or an attacker-planted
 * entry, already got there first, and the caller must inspect it via
 * `lstat`/`O_NOFOLLOW` before touching it, never via a plain `readFile`).
 *
 * **Mechanism, each half load-bearing, confirmed directly (task-3-report.md
 * fix-round-1 probes):**
 * - The payload is written to a freshly-named, co-located temp file via
 *   `writeFile(..., { flag: "wx" })` — `O_CREAT|O_EXCL` refuses an existing
 *   directory entry at that name, **including a symlink, without following
 *   it** (confirmed: writing through a pre-planted symlink with `wx` fails
 *   `EEXIST` and leaves the symlink's target untouched). The name is
 *   16 random bytes of hex, making a pre-planted collision at the temp name
 *   itself infeasible to arrange in advance.
 * - `link()` (a hard link, not a copy) is then attempted from the temp file
 *   to `path`. `link()` has the identical `EEXIST`-without-dereferencing
 *   behavior as `wx` above (confirmed by the same probe) — so a pre-planted
 *   symlink *at `path`* is refused the same way a real prior record is:
 *   this call learns only "something is there," never what.
 * - The temp file is always unlinked afterward regardless of outcome
 *   (`finally`, wrapping *both* steps — fix round 2, L1) — `link()` creates
 *   a *second* name for the same inode, so removing the temp name never
 *   removes the data now reachable at `path` when this call won. **The
 *   `finally` covers the `writeFile` step too**, not only `link`: an
 *   earlier version cleaned up only around the `link()` attempt, leaking
 *   the temp file whenever `writeFile`'s own `write()` half failed after
 *   its `open()` half (via `O_CREAT|O_EXCL`) had already created the
 *   entry — confirmed directly under `ulimit -f` (`EFBIG`): the temp name
 *   was left behind, non-empty, with no code path that would ever sweep it
 *   (`discard()` only ever removes the hashed record name, never a stray
 *   `.tmp-*` sibling).
 *
 * This closes the gap `writeFile(path, payload, { flag: "wx" })` alone left
 * once a *second* write needs to replace something already at `path` (the
 * self-heal step in `observe()`) — `wx` directly at the final `path` is
 * only ever a *create*, and this module has no analogous *replace*
 * primitive that stays symlink-safe without going through a temp file.
 */
// Exported (module-internal — not re-exported from `events/index.ts`, the
// same pattern as `recordPath`) so a test can reproduce the fix round 2 L1
// leak scenario directly: calling this with a large `payload` inside a
// process whose `ulimit -f` is tightened lets a test trigger a genuine
// `write()`-half failure (`EFBIG`) after the `open()` half (`O_CREAT|O_EXCL`)
// has already created the temp file, without needing the full `observe()`
// payload (a small fixed-size JSON object) to happen to exceed any
// reasonable resource limit on its own.
export async function tryPlaceAtomically(path: string, payload: string): Promise<boolean> {
  const tempPath = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    try {
      await writeFile(tempPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (cause) {
      throw storeUnavailableError("write temporary observation record", cause);
    }

    try {
      await link(tempPath, path);
      return true;
    } catch (linkError) {
      if (isNodeError(linkError) && linkError.code === "EEXIST") {
        return false;
      }
      if (isNodeError(linkError) && linkError.code !== undefined && HARD_LINK_UNSUPPORTED_CODES.has(linkError.code)) {
        throw hardLinkUnsupportedError(linkError);
      }
      throw storeUnavailableError("link observation record into place", linkError);
    }
  } finally {
    // Best-effort cleanup, covering every exit path above (fix round 2,
    // L1): `rm` on a name that was never created at all (the `writeFile`
    // failed before `open()` ever succeeded) is a harmless no-op via
    // `force: true`.
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * `lstat`s `path` and confirms it is a plain file **without ever
 * dereferencing a symlink** (fix round 1, High S1, sink 1) — `lstat`
 * reports on the directory entry itself, unlike `stat`, which would follow
 * a symlink and report on whatever it points to. Returns the `lstat`
 * result on success; returns `null` for `ENOENT` (the entry vanished
 * between a failed `link()` and this call — a concurrent `discard()`, most
 * likely) so the caller can retry; throws a typed hard error for anything
 * else, including a successful `lstat` that reports something other than a
 * plain file (a planted symlink, a directory, a FIFO).
 */
async function lstatPlainFileOrNull(path: string): Promise<Stats | null> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw storeUnavailableError("stat observation record", error);
  }
  if (!stat.isFile()) {
    // Never read through it, never "heal" over it (sink 1 and sink 2 of
    // fix round 1's High S1): a legitimate record is always a plain file
    // this module itself created. Anything else is either an attacker's
    // plant or a genuinely broken store, and both fail closed here.
    throw storeUnavailableError("observation record is not a plain file", undefined);
  }
  return stat;
}

/**
 * Reads `path` via `open(..., O_NOFOLLOW)`, never a plain `readFile` (fix
 * round 1, High S1, sink 1) — `readFile` follows a symlink at `path`,
 * letting an attacker who pre-planted one control the value read back
 * (e.g. `{"firstSeenAtMs":1}`, making every future expiry check see the
 * claim as ancient). `O_NOFOLLOW` makes the `open` itself fail with
 * `ELOOP` if `path` is a symlink, atomically — no separate check-then-open
 * race window. Callers of this function have already confirmed via
 * `lstatPlainFileOrNull` that `path` is a plain file, so this is
 * belt-and-suspenders against a symlink swapped in between that `lstat`
 * and this `open`, not the primary guard.
 */
async function readPlainFile(path: string): Promise<string> {
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw storeUnavailableError("read observation record", error);
  }
}

/**
 * `ensurePrivateDir`'s outcome when `create: false` and `dir` does not
 * exist — the ordinary "nothing recorded here yet" case, distinct from
 * every other outcome, which either succeeds silently or throws.
 */
const DIR_ABSENT = Symbol("absent");

/**
 * Confirms `dir` is a plain directory, owned by the current user, with no
 * group/other access — **fix round 2, Ruling R37 (High H1 / Medium M1)**.
 * Creates it (`mode: 0o700`) when `create` is `true` and it does not exist
 * yet; with `create: false`, an absent `dir` returns {@link DIR_ABSENT}
 * rather than creating anything (this is what lets `firstSeen()` keep
 * reporting "no record" gracefully for a store that was never written to,
 * per Ruling R7, while still verifying whatever *does* exist).
 *
 * **Why this checks ownership and permission bits, not merely "is it a
 * directory" — the M1 finding.** Fix round 1's directory check
 * (`lstat(dir).isDirectory()`) closed a *symlinked* `dir`, but a `dir` that
 * is a **genuine directory the attacker owns**, containing a plain file at
 * the correctly-hashed record name, satisfies every shape check fix round
 * 1 added: `mkdir(recursive)` no-ops (it already exists), `isDirectory()`
 * is `true`, the record inside it is a plain file, `O_NOFOLLOW` opens it
 * without incident. No amount of shape-checking closes this — the missing
 * property is *ownership*, checked here via `stat.uid`, and *exclusivity*,
 * checked via `(stat.mode & 0o077) === 0` (no group or other access bit
 * set at all; the owner's own bits are not constrained further). A
 * directory this module previously created under a permissive `umask` (fix
 * round 1's own gap, per the orchestrator: "`mkdir` never chmods an
 * existing directory, so a store created by the vulnerable build under
 * umask 000 stays 777 forever") is tightened in place via `chmod` rather
 * than trusted or rejected outright — the failure mode this guards against
 * is *another user* writing into a directory this user owns, which a
 * same-user `chmod` fully remedies; a directory this user does not own at
 * all cannot be remedied and hard-errors instead.
 *
 * Applied to every path component this module itself owns and creates —
 * the `cankan` directory, `cankan/observations`, and each board's hashed
 * subdirectory — in both `observe()` and `firstSeen()`. **Not applied
 * inside `$XDG_STATE_HOME` itself**, which this module does not create and
 * shares with whatever else the XDG spec's `$XDG_STATE_HOME` reservation
 * covers — enforcing ownership there is outside this module's remit.
 *
 * **On a runtime with no `process.getuid` (Windows), this check is
 * unmitigated, not merely "skipped" — fix round 3, Ruling R41.** Node/Bun
 * expose no POSIX uid or mode model there, so *both* halves of this
 * function's own security property fall away together: the ownership
 * check never runs (nothing to compare against), and the mode-tightening
 * `chmod` never runs either, since it exists only to enforce the same
 * ownership property this check can no longer establish. A world-writable
 * store with a planted record is not caught on such a runtime — recorded
 * here explicitly (per Ruling R41: Windows is not in this project's
 * supported-platform list today — no `engines`/`os` field, no CI job for
 * it — so this is not a defect to fix now, but whoever adds Windows
 * support must inherit this obligation, not the false assumption that
 * "no uid to check" merely means "less strict").
 *
 * **A failed tightening `chmod` is fatal only on the write path — fix
 * round 3, Ruling R40.** `create: true` (`observe()`) still hard-errors if
 * the `chmod` fails: obligation R7's whole reason for existing is that a
 * swallowed *write* failure silently re-observes the same event forever,
 * so no lease ever expires. `create: false` (`firstSeen()`) does not: nothing
 * about a read depends on this directory's mode bits being tightened
 * *right now* — the record underneath may still be perfectly readable — so
 * failing the read because the tightening attempt (a courtesy, not this
 * call's actual job) hit a read-only mount would be a self-inflicted
 * outage R7 was never written to require. The **ownership** check above
 * this one is unconditionally fatal on both paths regardless — that is the
 * actual security property, and this ruling does not touch it.
 */
async function ensurePrivateDir(dir: string, options: { create: boolean }): Promise<typeof DIR_ABSENT | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let stat: Stats;
    try {
      stat = await lstat(dir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (!options.create) {
          return DIR_ABSENT;
        }
        try {
          // `recursive: true` so the first-ever call (creating the
          // `cankan` directory) also creates whatever XDG-conventional
          // parents don't exist yet (e.g. `~/.local/state`) -- those
          // parents are outside this module's ownership remit (see this
          // function's doc comment) and are not separately verified, but
          // recursive `mkdir` applying the same `mode` to them as a side
          // effect of one syscall is harmless, not a scope violation.
          //
          // **`mode: 0o700` here is narrower than it looks, disclosed
          // honestly**: the ownership+mode check just below (`uid`/`0o077`)
          // already tightens *any* directory this call reaches back to
          // `0o700` regardless of what `mkdir` created it as (confirmed
          // directly: deleting this `mode` option alone, with that check
          // left in place, does not change the mode `observe()` leaves
          // behind — the tightening step already fixes it up on the very
          // same call). What this option alone still buys, which the
          // fixed-mode `mkdir` versus a separate tightening step do not, is
          // *atomicity*: without it, a freshly-created directory exists
          // briefly at its unmasked default before the tightening step
          // below runs, a narrow window a local attacker racing this exact
          // call could in principle use. Untested (isolating a
          // single-syscall race window from outside this function isn't
          // practical), kept as defense in depth, not claimed as
          // independently guarded by a test the way the tightening step is.
          await mkdir(dir, { recursive: true, mode: 0o700 });
        } catch (mkdirError) {
          if (isNodeError(mkdirError) && mkdirError.code === "EEXIST") {
            continue; // a concurrent creator won -- re-lstat and validate it.
          }
          throw storeUnavailableError("create state directory", mkdirError);
        }
        continue; // just created -- re-lstat to validate it below.
      }
      throw storeUnavailableError("stat state directory", error);
    }

    if (!stat.isDirectory()) {
      // Never a symlink, even a symlink-to-directory (fix round 1, sink 3)
      // -- `lstat` reports the entry itself, so a symlink here reports
      // `isDirectory() === false` regardless of its target.
      throw storeUnavailableError("state directory is not a plain directory", undefined);
    }

    const uid = process.getuid?.();
    if (uid !== undefined) {
      if (stat.uid !== uid) {
        // Unconditionally fatal on both paths (Ruling R40) -- this is the
        // actual security property.
        throw storeUnavailableError("state directory is not owned by the current user", undefined);
      }
      if ((stat.mode & 0o077) !== 0) {
        try {
          await tightenDirPermissions(dir);
        } catch (cause) {
          if (options.create) {
            throw storeUnavailableError("restrict state directory permissions", cause);
          }
          // Ruling R40: on the read path, a failed tightening attempt
          // (e.g. a read-only mount) is not this call's failure to report
          // -- proceed and let the caller's own read of the record decide
          // whether *that* succeeds.
        }
      }
    }
    return undefined;
  }
  throw storeUnavailableError("state directory contention exceeded retry bound", undefined);
}

/**
 * `chmod(dir, 0o700)` — fix round 2's original mechanism — resolves `dir`
 * by path and follows a symlink at that path, exactly like every other
 * plain path-based `fs` call this module has already had to route around
 * (`readFile`, `writeFile`). Confirmed directly: `chmod` on a symlinked
 * *directory* target moves the mode of the symlink's target, not the
 * symlink itself, for both a file and a directory target. A local attacker
 * who can win the narrow window between this function's own `lstat` (which
 * confirmed a real, owned directory) and this call swapping in a symlink
 * could redirect the tightening onto an arbitrary path the current user
 * owns — fix round 3, Minor 3.
 *
 * **Fix: `open(dir, O_DIRECTORY | O_NOFOLLOW)`, then `chmod` the resulting
 * handle (`fchmod`).** The open refuses a symlink outright (confirmed:
 * `ENOTDIR`, since `O_DIRECTORY` requires the target to already be a
 * directory and `O_NOFOLLOW` refuses to resolve through a symlink to find
 * out), and once open, the handle names a specific inode — there is no
 * further path to re-resolve, so the check (`ensurePrivateDir`'s own
 * `lstat`) and the change now name provably the same thing.
 */
// Exported (module-internal — not re-exported from `events/index.ts`) so a
// test can race this exact function against a concurrent attacker
// swapping `dir` for a symlink, and confirm the race the old
// `chmod(dir, 0o700)` mechanism lost is now unwinnable by construction.
export async function tightenDirPermissions(dir: string): Promise<void> {
  const handle = await open(dir, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

export interface ObserveOptions {
  /**
   * The clock this call records against, if this is the first observation
   * of `(boardKey, eventId)`. Defaults to `Date.now()`. Injectable for
   * deterministic tests, the same pattern as `log.ts`'s `AppendOptions.now`
   * and `ref.ts`'s `InitRefOptions.now`. Validated via `log.ts`'s
   * `validateNowForDateFormatting` — this value is only ever stored and
   * later read back as a plain epoch-ms number, never fed to a ULID
   * factory, so it needs that (wider) bound, not `append`'s tighter one.
   */
  readonly now?: number;
}

/**
 * Records that `eventId` was first observed, for `boardKey`, at the current
 * (or injected) local time — **first write wins**. A second call for the
 * same `(boardKey, eventId)` pair never moves the recorded time; it simply
 * returns the time already on record. Returns the epoch-ms value now on
 * record, whether this call wrote it or a previous one did. `options` may
 * be omitted, `undefined`, or `null` — all three mean "use the defaults."
 *
 * `eventId` is validated against the ULID grammar before it is hashed
 * (obligation 2) — an invalid id throws
 * `EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID` before any
 * filesystem access. A missing state directory is created, `{ mode: 0o700
 * }` (Ruling R7 graceful case, and fix round 1 High S1: without an explicit
 * mode, a permissive `umask` — 0, routine in containers and CI, confirmed
 * directly to leave a freshly-created directory `0777` — would let any
 * local user plant a symlink inside it; `0o700` is unaffected by `umask`
 * regardless of its value, also confirmed directly). An unwritable
 * directory throws `EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE`.
 *
 * **Idempotence and symlink-safety are both provided by `tryPlaceAtomically`,
 * never by a plain `writeFile`/`readFile` pair.** The payload is placed at
 * `path` via an atomic `link()` from a freshly-written, co-located temp
 * file — see that function's own doc comment for the full mechanism and
 * why `link()` rather than `writeFile` is what makes a losing concurrent
 * caller see either nothing at `path` or its complete final content, never
 * a torn intermediate write. A losing caller never touches whatever is
 * already at `path` without first confirming, via `lstatPlainFileOrNull`,
 * that it is a plain file this module itself could have written, and
 * reads it only through `readPlainFile`'s `O_NOFOLLOW` open — never a
 * plain `readFile`, which would follow a symlink an attacker planted there
 * and let it control the value this call trusts as the lease's
 * first-observation time. (Fix round 1, Critical C1 / High S1: an earlier
 * version used `writeFile(path, payload, { flag: "wx" })` for the sequence
 * this replaces; a genuinely concurrent loser could read the winner's
 * write mid-flight, torn, misclassify it as corrupt, and overwrite the
 * winner's value — reproduced directly, ~1% of trials under a real
 * `Promise.all` race, see task-3-report.md.)
 *
 * A record whose content fails to parse (truncated by a crash mid-write —
 * still possible, since `tryPlaceAtomically`'s own temp-file write is not
 * itself `fsync`ed, which is deliberate: obligation 7 forbids fsync
 * ceremony this store's guarantees don't need) is self-healed: the corrupt
 * entry is removed (`unlink` never dereferences a symlink, so this is safe
 * even though `lstatPlainFileOrNull` has already ruled out a symlink being
 * present) and this function loops back to place a fresh record. This is a
 * strictly safer failure than the alternative (a store stuck forever, or
 * a hard error on ordinary local corruption) and only ever costs liveness.
 *
 * **Every directory level this module owns is ownership-and-permission
 * checked, not merely shape-checked — fix round 2, Ruling R37.** See
 * {@link ensurePrivateDir}'s own doc comment for the full reasoning (a
 * *genuine* directory a different user owns defeats every shape check fix
 * round 1 added, and closing it needs an ownership/mode check, not a
 * deeper symlink check).
 */
export async function observe(
  boardKey: string,
  eventId: EventId,
  options?: ObserveOptions | null,
): Promise<number> {
  const opts = options ?? {};
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);
  const now = opts.now ?? Date.now();
  validateNowForDateFormatting(now);
  // Fix round 3, Minor 6: `validateNowForDateFormatting` (log.ts, frozen,
  // shared with `append`/`initRef`'s own wider domain) accepts a negative
  // `now` — this module's own domain is narrower. A reader-local
  // wall-clock observation is never negative, so this extra,
  // module-specific check tightens `now` to `[0, MAX_DATE_MS]` before it
  // is ever stored, mirroring the same tightened bound
  // `parseStoredObservation` now enforces on read.
  if (now < 0) {
    throw new CanKanError(
      EventErrorCodes.EVENT_LOG_INVALID_WINDOW,
      `now must be non-negative -- a reader-local wall-clock observation is never negative, got ${now}`,
      { details: { now, minValue: 0 } },
    );
  }

  const path = recordPath(boardKey, eventId);
  const boardHashDir = dirname(path);
  const observationsDir = dirname(boardHashDir);
  const cankanDir = dirname(observationsDir);

  await ensurePrivateDir(cankanDir, { create: true });
  await ensurePrivateDir(observationsDir, { create: true });
  await ensurePrivateDir(boardHashDir, { create: true });

  const payload = JSON.stringify({ firstSeenAtMs: now } satisfies StoredObservation);

  for (let attempt = 0; attempt < MAX_OBSERVE_ATTEMPTS; attempt++) {
    if (await tryPlaceAtomically(path, payload)) {
      return now;
    }

    const existingStat = await lstatPlainFileOrNull(path);
    if (existingStat === null) {
      // The occupant vanished between the failed `link()` and this
      // `lstat` (a concurrent `discard()`, most likely) — try again.
      continue;
    }

    let existingContent: string;
    try {
      existingContent = await readPlainFile(path);
    } catch (error) {
      // Fix round 2, L2: the occupant can *also* vanish in the narrower
      // window between the `lstat` above and this `open` (the identical
      // concurrent-`discard()` race, one syscall later) — `readPlainFile`
      // wraps every failure into a `CanKanError`, so the original `ENOENT`
      // survives only as `error.cause`. Retrying here is the same
      // response as the `lstat`-level race above; a real (not raced)
      // read failure is anything whose `cause` isn't `ENOENT`, and that
      // still propagates as a hard error, unchanged.
      if (isCanKanError(error) && isNodeError(error.cause) && error.cause.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const existing = parseStoredObservation(existingContent);
    if (existing !== undefined) {
      return existing;
    }

    // Unparseable content in a plain file (see doc comment) — remove the
    // corrupt entry and loop back to place a fresh one.
    try {
      await rm(path, { force: true });
    } catch (cause) {
      throw storeUnavailableError("remove corrupt observation record", cause);
    }
  }

  throw storeUnavailableError("observation record contention exceeded retry bound", undefined);
}

/**
 * Returns the epoch-ms time `eventId` was first observed for `boardKey`, or
 * `null` if there is no record — either because the state directory does
 * not exist yet, or because no `observe()` call has ever recorded this
 * exact `(boardKey, eventId)` pair (Ruling R7: both are the graceful "not
 * yet observed" case, never an error). A record whose content fails to
 * parse is likewise reported as `null`, not an error — see `observe()`'s
 * doc comment for why a corrupt record is treated as absent rather than
 * fatal.
 *
 * `eventId` is validated against the ULID grammar before it is hashed
 * (obligation 2), the same as `observe()`. An unwritable-or-unreadable
 * store (permissions, not absence) throws
 * `EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE` — including,
 * **not** gracefully, a path component that exists as a plain file where a
 * directory is expected (`ENOTDIR`, distinct from the graceful `ENOENT`):
 * confirmed directly that a read through such a path raises `ENOTDIR`, and
 * `observe()`'s own `mkdir(..., { recursive: true })` already hard-errors
 * on that same condition, so `firstSeen` must agree rather than fail open
 * where `observe` fails closed.
 *
 * **Never a plain `readFile` — fix round 1, High S1, sink 1.** Uses
 * `lstatPlainFileOrNull` (confirms a plain file without dereferencing a
 * symlink) then `readPlainFile` (`O_NOFOLLOW`), the same pair `observe()`
 * uses for its own "read what's already there" path — a plain `readFile`
 * would follow a symlink an attacker planted at this hashed path and let
 * it control the value this call returns, which M2.10 trusts as the
 * lease's first-observation time.
 *
 * **Every existing directory level is ownership-and-permission checked,
 * the same as `observe()` — fix round 2, Ruling R37 (High H1).** Fix
 * round 1 applied its directory check only inside `observe()`, at only the
 * leaf `<boardhash>` level — this function had no directory check at all,
 * so a symlinked `observations/` (not just a symlinked `<boardhash>`)
 * reached `lstatPlainFileOrNull`/`readPlainFile` by resolving *through*
 * the symlink before either guard ever ran, since neither guard inspects
 * any path component but the leaf. Unlike `observe()`, this function never
 * creates a missing directory (`ensurePrivateDir(..., { create: false })`)
 * — an absent directory at any level is still the ordinary "no record"
 * case (Ruling R7), not an error.
 */
export async function firstSeen(boardKey: string, eventId: EventId): Promise<number | null> {
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);

  const path = recordPath(boardKey, eventId);
  const boardHashDir = dirname(path);
  const observationsDir = dirname(boardHashDir);
  const cankanDir = dirname(observationsDir);

  if ((await ensurePrivateDir(cankanDir, { create: false })) === DIR_ABSENT) {
    return null;
  }
  if ((await ensurePrivateDir(observationsDir, { create: false })) === DIR_ABSENT) {
    return null;
  }
  if ((await ensurePrivateDir(boardHashDir, { create: false })) === DIR_ABSENT) {
    return null;
  }

  const stat = await lstatPlainFileOrNull(path);
  if (stat === null) {
    return null;
  }

  const content = await readPlainFile(path);
  const parsed = parseStoredObservation(content);
  return parsed ?? null;
}

/**
 * Removes the observation record for `(boardKey, eventId)`, if any.
 * Idempotent: discarding an id with no record (already discarded, or never
 * observed) is not an error.
 *
 * **Called once per claim/renew event id a lease ever accumulated, not
 * only its most recent one** — see the module doc comment's "Discarded on
 * release" section for why a single lease's lifetime (a `claim` plus any
 * number of `renew`s, each a distinct event id) needs every one of those
 * ids discarded to actually bound the store's growth.
 *
 * `eventId` is validated against the ULID grammar before it is hashed
 * (obligation 2), the same as `observe()`/`firstSeen()`. An
 * unwritable-or-unreadable store throws
 * `EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE` — deletion is a
 * write for this purpose, subject to the same Ruling R7 disposition.
 *
 * **Every existing directory level is ownership-and-permission checked,
 * the same as `observe()`/`firstSeen()` — fix round 3, Minor 4.** Ruling
 * R37 scoped the original ownership/mode check to `observe()`/`firstSeen()`
 * only, which left `discard()` acting through a poisoned path: with
 * `observations/` or `<boardhash>` symlinked (or genuinely owned by
 * another user), `observe()`/`firstSeen()` would hard-error but `discard()`
 * would `rm` straight through the attacker's directory and report success
 * — a weak arbitrary-unlink primitive, and an inconsistent disposition
 * across the three functions for the identical poisoned-path condition.
 * `{ create: false }`, the same as `firstSeen()`: `discard()` never
 * creates a directory that isn't already there, and an absent directory at
 * any level means there is nothing to discard (idempotent, not an error).
 */
export async function discard(boardKey: string, eventId: EventId): Promise<void> {
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);

  const path = recordPath(boardKey, eventId);
  const boardHashDir = dirname(path);
  const observationsDir = dirname(boardHashDir);
  const cankanDir = dirname(observationsDir);

  if ((await ensurePrivateDir(cankanDir, { create: false })) === DIR_ABSENT) {
    return;
  }
  if ((await ensurePrivateDir(observationsDir, { create: false })) === DIR_ABSENT) {
    return;
  }
  if ((await ensurePrivateDir(boardHashDir, { create: false })) === DIR_ABSENT) {
    return;
  }

  try {
    await rm(path, { force: true });
  } catch (cause) {
    throw storeUnavailableError("discard observation record", cause);
  }
}
