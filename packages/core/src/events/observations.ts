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
import { CanKanError } from "../errors";
import type { GitAdapter } from "../git/index";
import { EventErrorCodes } from "./errors";
import { validateNowForDateFormatting } from "./log";
import { type EventId, isValidEventId } from "./schema";

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

/** `undefined` for anything that isn't a well-formed record — corrupt content is treated the same as "no record" (see `firstSeen`/`observe`'s doc comments). */
function parseStoredObservation(content: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "firstSeenAtMs" in parsed &&
      typeof (parsed as StoredObservation).firstSeenAtMs === "number" &&
      Number.isFinite((parsed as StoredObservation).firstSeenAtMs)
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
 *   (`finally`) — `link()` creates a *second* name for the same inode, so
 *   removing the temp name never removes the data now reachable at `path`
 *   when this call won.
 *
 * This closes the gap `writeFile(path, payload, { flag: "wx" })` alone left
 * once a *second* write needs to replace something already at `path` (the
 * self-heal step in `observe()`) — `wx` directly at the final `path` is
 * only ever a *create*, and this module has no analogous *replace*
 * primitive that stays symlink-safe without going through a temp file.
 */
async function tryPlaceAtomically(path: string, payload: string): Promise<boolean> {
  const tempPath = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    await writeFile(tempPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (cause) {
    throw storeUnavailableError("write temporary observation record", cause);
  }
  try {
    await link(tempPath, path);
    return true;
  } catch (linkError) {
    if (!isNodeError(linkError) || linkError.code !== "EEXIST") {
      throw storeUnavailableError("link observation record into place", linkError);
    }
    return false;
  } finally {
    // Best-effort cleanup: the temp name is unguessable, so a stray one
    // left behind by a crash between `writeFile` and `link` is inert, not
    // a security concern, and cleaning it up is not this call's
    // correctness requirement.
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

  const path = recordPath(boardKey, eventId);
  const dir = dirname(path);

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw storeUnavailableError("create state directory", cause);
  }

  // Fix round 1, High S1, sink 3: `mkdir(..., { recursive: true })`
  // silently tolerates `dir` already existing as a symlink-to-directory —
  // it never distinguishes "already a real directory" from "already
  // resolves to one." Confirmed via `lstat` (not the dereferencing `stat`)
  // before this function ever writes into `dir`.
  let dirStat: Stats;
  try {
    dirStat = await lstat(dir);
  } catch (cause) {
    throw storeUnavailableError("verify state directory", cause);
  }
  if (!dirStat.isDirectory()) {
    throw storeUnavailableError("state directory is not a plain directory", undefined);
  }

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

    const existingContent = await readPlainFile(path);
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
 */
export async function firstSeen(boardKey: string, eventId: EventId): Promise<number | null> {
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);

  const path = recordPath(boardKey, eventId);

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
 */
export async function discard(boardKey: string, eventId: EventId): Promise<void> {
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);

  const path = recordPath(boardKey, eventId);

  try {
    await rm(path, { force: true });
  } catch (cause) {
    throw storeUnavailableError("discard observation record", cause);
  }
}
