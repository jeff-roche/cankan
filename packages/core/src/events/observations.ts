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

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
 * record, whether this call wrote it or a previous one did.
 *
 * `eventId` is validated against the ULID grammar before it is hashed
 * (obligation 2) — an invalid id throws
 * `EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID` before any
 * filesystem access. A missing state directory is created (Ruling R7); an
 * unwritable one throws `EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE`.
 *
 * **Idempotence is implemented with an exclusive create (`wx`), not a
 * check-then-write** — a concurrent second `observe()` for the same key
 * (two processes, or two calls racing within one) loses the exclusive
 * create with `EEXIST` and reads back whatever the winner wrote, rather
 * than two writers each believing they went first. This is the minimum
 * needed for the idempotence guarantee obligation 1 asks for; per
 * obligation 7, this module does not go further and add fsync ceremony or
 * cross-process locking beyond it.
 *
 * A record whose on-disk content fails to parse (truncated by a crash
 * mid-write, since no fsync/rename ceremony guards against that per
 * obligation 7) is treated as if no record existed: this call overwrites
 * it with a fresh observation rather than perpetuating a value nothing can
 * ever read back. This is a strictly safer failure than the alternative
 * (a store that is stuck forever, or a store that hard-errors on ordinary
 * cache corruption) and only ever costs liveness, per the same reasoning
 * obligation 7 already applies to a clock starting late.
 */
export async function observe(boardKey: string, eventId: EventId, options: ObserveOptions = {}): Promise<number> {
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);
  const now = options.now ?? Date.now();
  validateNowForDateFormatting(now);

  const path = recordPath(boardKey, eventId);

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (cause) {
    throw storeUnavailableError("create state directory", cause);
  }

  const payload = JSON.stringify({ firstSeenAtMs: now } satisfies StoredObservation);

  try {
    await writeFile(path, payload, { encoding: "utf8", flag: "wx" });
    return now;
  } catch (writeError) {
    if (!isNodeError(writeError) || writeError.code !== "EEXIST") {
      throw storeUnavailableError("write observation record", writeError);
    }
    // Lost the exclusive-create race (or a previous invocation already
    // wrote this record): read back whatever is there now.
  }

  let existingContent: string;
  try {
    existingContent = await readFile(path, "utf8");
  } catch (readError) {
    throw storeUnavailableError("read existing observation record", readError);
  }

  const existing = parseStoredObservation(existingContent);
  if (existing !== undefined) {
    return existing;
  }

  // Corrupt content: self-heal by overwriting outright (see doc comment).
  try {
    await writeFile(path, payload, "utf8");
  } catch (cause) {
    throw storeUnavailableError("overwrite corrupt observation record", cause);
  }
  return now;
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
 * `EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE`.
 */
export async function firstSeen(boardKey: string, eventId: EventId): Promise<number | null> {
  assertValidBoardKey(boardKey);
  assertValidEventId(eventId);

  const path = recordPath(boardKey, eventId);

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      // No record, or no state directory at all yet — both graceful
      // (Ruling R7). **Not ENOTDIR**: that means a path component that
      // should be a directory (e.g. the board-hash directory, or
      // `observations/` itself) already exists as a plain file — a
      // genuinely broken store, not an absent one. Reporting that as
      // `null` would be the exact silent-re-observation failure R7 exists
      // to forbid (confirmed directly: `readFile` on `<file>/<segment>`
      // raises `ENOTDIR`, distinctly from `ENOENT` — see task-3-report.md's
      // probe), and `observe()`'s own `mkdir(..., { recursive: true })`
      // already hard-errors on that same condition, so `firstSeen` must
      // agree rather than fail open where `observe` fails closed.
      return null;
    }
    throw storeUnavailableError("read observation record", error);
  }

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
