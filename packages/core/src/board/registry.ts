/**
 * `board/registry.ts` — `repos.yml` at `$XDG_DATA_HOME/cankan/repos.yml`
 * (CONCEPT.md §6c: "registry of repo boards for `--board all`" — path,
 * name, last seen). `register()` is what `init` (M3.2) calls;
 * `listRegisteredBoards()` and `findRegisteredBoard()` are the reads
 * `--board all` and `--board <name>` need (dispatch B's `resolve.ts`, this
 * round; M2.5/M2.8/M2.14 later). `cankan repo add|rm|list` (M3, a CLI
 * surface) is out of scope here.
 *
 * File shape (fixed by ruling, zod-validated):
 * ```yaml
 * version: 1
 * repos:
 *   - name: api
 *     path: /abs/canonical/path/to/api
 *     last_seen: 2026-09-05T08:00:00.000Z
 * ```
 * `path` is stored **canonical** — `realpath`'d at `register()` time.
 *
 * Robustness over features: a missing registry is normal (empty list, not
 * an error); a malformed one fails with a message naming the file; an
 * entry whose directory no longer exists is reported to the caller as
 * "skipped" rather than silently dropped from the *listing*, and is never
 * silently dropped from the *file* either (a `register()` upsert rewrites
 * every existing row, whether or not that row's directory currently
 * exists — a temporarily unmounted drive should not lose its registration
 * on the next unrelated `init`).
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { ConfigErrorCodes } from "../config/index";
// Deliberate deeper-than-contract import: `loadValidatedLayer` is exported
// from `config/layers.ts` but not re-exported through `config/index.ts`'s
// frozen public surface. Reused here (see `readRegistryRaw` below -- the
// *only* call site in this file) rather than re-deriving its YAML guards,
// most notably the alias/anchor self-reference cycle fix M2.3 shipped
// after a real repo-crashing bug: `config` is in M2.4's *Depends on* list,
// PLAN.md rule 2 is written at module granularity (not "one file per
// module"), and re-deriving the guard is exactly what the M2.4 brief
// asked this dispatch not to do. Funneled through exactly one function so
// a future change to `loadValidatedLayer`'s signature breaks in one place
// here, not scattered across this file.
import { loadValidatedLayer } from "../config/layers";
import { CanKanError, isCanKanError } from "../errors";
import { BoardErrorCodes } from "./errors";
import { resolvePersonalBoardPath } from "./personal";
import { resolveDataHome } from "./xdg";

// ---------------------------------------------------------------------------
// Board name shape: an opaque identifier, never a path fragment.
// ---------------------------------------------------------------------------

/**
 * `--board personal|repo|all` are selectors (CONCEPT.md §6c), not
 * registrable names -- a registered board named `personal` (in any
 * casing) would shadow the personal board.
 */
const RESERVED_BOARD_NAMES: ReadonlySet<string> = new Set(["personal", "repo", "all"]);

/** `C:`, `d:`, ... -- checked unconditionally, not via `process.platform`; mirrors `config/schema.ts`'s `isSafeRelativeFilePath` (~line 290-292). */
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

/**
 * A board name must be an opaque identifier: no leading/trailing
 * whitespace, no path separators (`/` or `\`), no `.` or `..`, no
 * absolute path, no NUL or control characters, not empty, no Windows
 * drive-letter prefix, and not one of the reserved selector names
 * (matched case-insensitively -- `Personal`, `PERSONAL`, and `"  personal
 * "` are all refused, not just the exact lowercase spelling). Checked
 * unconditionally rather than via `process.platform` -- PLAN.md ships a
 * `win-x64` build target, and a registry entry hand-authored (or
 * corrupted) on one platform must be judged the same way on every other.
 */
export function isValidBoardName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.trim() !== name) return false;
  if (RESERVED_BOARD_NAMES.has(name.toLowerCase())) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (DRIVE_LETTER_PREFIX.test(name)) return false;
  if (isAbsolute(name)) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function invalidNameError(name: string): CanKanError {
  return new CanKanError(BoardErrorCodes.INVALID_BOARD_NAME, `"${name}" is not a valid board name`, {
    details: { name },
  });
}

// ---------------------------------------------------------------------------
// File shape (zod) -- hardened per-field, not just at the API boundary: a
// hand-edited repos.yml with `name: personal` or a relative `path` must
// fail as "malformed, names the file", the same disposition as a syntax
// error, rather than silently reaching a caller as valid data.
// ---------------------------------------------------------------------------

const registryEntrySchema = z.strictObject({
  name: z.string().refine(isValidBoardName, { error: "not a valid board name" }),
  path: z.string().refine((p) => isAbsolute(p), { error: "must be an absolute path" }),
  last_seen: z.iso.datetime(),
});

const registryFileSchema = z.strictObject({
  version: z.literal(1),
  repos: z.array(registryEntrySchema),
});

type RawRegistryEntry = z.infer<typeof registryEntrySchema>;
type RawRegistryFile = z.infer<typeof registryFileSchema>;

const EMPTY_REGISTRY: RawRegistryFile = { version: 1, repos: [] };

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** `$XDG_DATA_HOME/cankan/repos.yml`. `undefined` iff no data home can be located at all (see `resolveDataHome`). */
export function resolveRegistryPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const dataHome = resolveDataHome(env);
  return dataHome ? join(dataHome, "cankan", "repos.yml") : undefined;
}

function requireRegistryPath(env: Readonly<Record<string, string | undefined>>): string {
  const registryPath = resolveRegistryPath(env);
  if (!registryPath) {
    throw new CanKanError(
      BoardErrorCodes.DATA_HOME_UNRESOLVABLE,
      "could not resolve a data directory ($XDG_DATA_HOME or $HOME) for the board registry",
    );
  }
  return registryPath;
}

async function ensureRegistryDir(registryPath: string): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
}

/**
 * The personal board's own canonical path, or `undefined` when it cannot
 * be resolved (no data home) or does not exist yet (nothing to collide
 * with -- `register()`'s `targetPath` is already realpath'd, so it can
 * never equal a path that does not exist). Used by both `register()` (F7:
 * refuse registering the personal board as a repo board) and
 * `listRegisteredBoards` (F7: skip a hand-edited entry that points at it).
 */
async function resolveCanonicalPersonalPath(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const raw = resolvePersonalBoardPath(env);
  if (!raw) return undefined;
  try {
    return await realpath(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reading (R16-style guard reuse -- see the note on `readRegistryRaw` below)
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function isEExist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/**
 * Reads and schema-validates `repos.yml`, or returns the empty registry
 * when the file does not exist (a missing registry is normal, never an
 * error).
 *
 * Reuses `config/layers.ts`'s `loadValidatedLayer` wholesale rather than
 * re-deriving its guards -- see the comment at this file's import of it,
 * above. That one call gets, for free: the "always our own message,
 * never the YAML parser's" syntax-error text (R16 -- the credential-leak
 * mitigation), the alias/anchor self-reference cycle guard added after
 * M2.3's own repo-crashing bug, and a `${absPath}: ...` validation-failure
 * message built from `zod` issue paths, never from `issue.message`. The
 * `"global"` first argument is a throwaway label -- `loadValidatedLayer`'s
 * `LoadedLayer.layer` field is discarded entirely below; `repos.yml` is
 * not a config layer, but the function's read/parse/validate machinery is
 * identical for any YAML file validated against a zod schema, and
 * "global" (a user's own file, not repo-controlled) is also the accurate
 * choice for `rejectSymlink: false` below.
 *
 * `loadValidatedLayer` throws with `ConfigErrorCodes.INVALID_CONFIG` on
 * failure; rewrapped here as `BoardErrorCodes.REGISTRY_INVALID` (same
 * message -- which already names the file -- same `cause`, same
 * `details`) so a caller sees a registry-domain code rather than a
 * config-domain one.
 */
async function readRegistryRaw(registryPath: string): Promise<RawRegistryFile> {
  let validated: Awaited<ReturnType<typeof loadValidatedLayer>>;
  try {
    validated = await loadValidatedLayer("global", registryPath, registryFileSchema, [], false);
  } catch (err) {
    if (isCanKanError(err) && err.code === ConfigErrorCodes.INVALID_CONFIG) {
      throw new CanKanError(BoardErrorCodes.REGISTRY_INVALID, err.message, {
        cause: err.cause,
        details: err.details,
      });
    }
    throw err;
  }
  if (!validated) {
    return EMPTY_REGISTRY;
  }
  return validated.layer.data as unknown as RawRegistryFile;
}

/** One entry in the registry, as returned to a reader. */
export interface RegistryEntry {
  readonly name: string;
  readonly path: string;
  readonly lastSeen: string;
}

/** An entry the registry file lists whose directory could not be read as a board this time. */
export interface SkippedRegistryEntry {
  readonly name: string;
  readonly path: string;
  readonly reason: string;
}

/** The result of listing the registry: valid entries, plus what was skipped and why. */
export interface RegistryListing {
  readonly boards: readonly RegistryEntry[];
  readonly skipped: readonly SkippedRegistryEntry[];
}

function toEntry(raw: RawRegistryEntry): RegistryEntry {
  return { name: raw.name, path: raw.path, lastSeen: raw.last_seen };
}

/**
 * Lists every board in the registry, split into `boards` (directory
 * confirmed present) and `skipped` (directory missing, not a directory,
 * or -- F7 -- the personal board's own path smuggled into a hand-edited
 * `repos.yml`) -- one bad entry never breaks the read for every other
 * one. `--board all` (dispatch B) consumes `boards`; `--board <name>` can
 * filter `boards` by name, or use `findRegisteredBoard` below directly.
 *
 * Returns an empty listing (never throws) when no registry file exists,
 * or when no data directory can even be located.
 */
export async function listRegisteredBoards(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RegistryListing> {
  const registryPath = resolveRegistryPath(env);
  if (!registryPath) {
    return { boards: [], skipped: [] };
  }
  const raw = await readRegistryRaw(registryPath);
  const personalPath = await resolveCanonicalPersonalPath(env);

  const boards: RegistryEntry[] = [];
  const skipped: SkippedRegistryEntry[] = [];
  for (const entry of raw.repos) {
    if (personalPath !== undefined && entry.path === personalPath) {
      skipped.push({ name: entry.name, path: entry.path, reason: "is the personal board" });
      continue;
    }
    try {
      const stats = await stat(entry.path);
      if (!stats.isDirectory()) {
        skipped.push({ name: entry.name, path: entry.path, reason: "registered path is not a directory" });
        continue;
      }
    } catch {
      skipped.push({ name: entry.name, path: entry.path, reason: "registered directory no longer exists" });
      continue;
    }
    boards.push(toEntry(entry));
  }
  return { boards, skipped };
}

/**
 * Looks up one registered board by name. Rejects a reserved or
 * shape-invalid `name` the same way `register()` does -- the brief's "name
 * lookups reject them" -- rather than simply returning `undefined` for it,
 * so a caller resolving `--board personal` (say) never mistakes "not
 * found" for "not a legal board name to look up."
 *
 * A name that *is* registered but whose directory `listRegisteredBoards`
 * had to skip (deleted, no longer a directory, or found to be the
 * personal board) is **not** treated the same as "never registered":
 * returning `undefined` for it would be exactly the silent-drop the
 * brief's robustness requirements forbid, on the one read path
 * `--board <name>` actually uses. Instead this throws a typed
 * `BOARD_DIRECTORY_MISSING` error naming the path and the reason, so a
 * caller can tell "api is registered but its directory vanished" apart
 * from "api was never registered."
 */
export async function findRegisteredBoard(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RegistryEntry | undefined> {
  if (!isValidBoardName(name)) {
    throw invalidNameError(name);
  }
  const { boards, skipped } = await listRegisteredBoards(env);
  const found = boards.find((board) => board.name === name);
  if (found) {
    return found;
  }
  const missing = skipped.find((entry) => entry.name === name);
  if (missing) {
    throw new CanKanError(
      BoardErrorCodes.BOARD_DIRECTORY_MISSING,
      `board "${name}" is registered at ${missing.path}, but ${missing.reason}`,
      { details: { name, path: missing.path, reason: missing.reason } },
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Writing: atomic (temp + rename), guarded by an identity-bearing,
// O_EXCL lockfile with bounded, stale-breaking retry around the whole
// read-modify-write.
// ---------------------------------------------------------------------------

// LOCK_TIMEOUT_MS is deliberately *less* than LOCK_STALE_MS: a `register()`
// call that starts while a lock is merely fresh (not yet stale) and whose
// holder then crashes will itself time out with REGISTRY_LOCK_TIMEOUT
// rather than wait out the full staleness window -- the *next* call
// breaks the (by-then) stale lock immediately, so the system recovers
// within one retry cycle rather than one call. Raising the timeout to
// `>= LOCK_STALE_MS` would make every call self-heal in a single attempt,
// at the cost of a live (non-crashed) contender blocking its caller
// longer before reporting anything back. Accepted trade-off, not
// re-litigated per call site.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const MAX_LOCK_LOST_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockToken(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

/** Thrown internally when a held lock is confirmed lost mid-write; `register()` retries the whole attempt on this, never surfaces it. */
class LockLostError extends Error {}

/**
 * Guards the read-modify-write in `register()` with an `O_EXCL` lockfile
 * beside the registry (`<registryPath>.lock`). Atomic temp+rename alone
 * only protects a single writer's own write from being torn -- it does
 * nothing to stop two concurrent `register()` calls (two `init`s racing,
 * a named real scenario) from both reading the same "before" state and
 * one silently clobbering the other's row on write. This lock serializes
 * the whole read-modify-write instead.
 *
 * The lockfile is **identity-bearing**: a random UUID token is written
 * into it at acquisition. This closes two independent ways two processes
 * could otherwise both believe they hold the lock (found in review):
 *
 * - **Stealing a fresh lock.** Breaking a lock naively by age (`stat`,
 *   then `unlink` if old) races: between the `stat` that judges staleness
 *   and the action that claims it, the original holder can finish and
 *   release, and a *third* process can acquire a brand-new lock at the
 *   same path -- the waiter then breaks that fresh lock by mistake. Fixed
 *   by `rename`-ing the file to a private name first (atomic, so only one
 *   racing waiter's rename can land the same target), then re-reading the
 *   token from the renamed copy and comparing it to the token observed
 *   before the rename: a mismatch means a fresh lock was stolen, not a
 *   stale one broken. In that case the stolen lock is put back with
 *   `link(private, lockPath)` -- **never `rename`** -- because `link`
 *   fails `EEXIST` if the path is occupied again by then, so restoring a
 *   mistakenly-stolen lock can never clobber whoever holds it *now*; a
 *   plain `rename` would silently overwrite them.
 * - **Unlinking someone else's lock.** A holder that overran the
 *   staleness window (and so had its lock broken by a waiter) must not
 *   then delete the *next* holder's lockfile in its own `finally`. Fixed
 *   by reading the token back immediately before unlinking and comparing
 *   it to the token this call wrote at acquisition -- only unlink if it
 *   still reads back as ours.
 *
 * A residual TOCTOU window remains between the staleness `stat`/token
 * read and the `rename` that claims it -- closing it fully would need an
 * atomic "compare-and-break" primitive the filesystem does not offer
 * here, the same class of accepted residual `config/layers.ts`'s own
 * `assertNotSymlink` documents. Worst case here is losing one registry
 * row after a stall longer than `LOCK_STALE_MS`, never corruption: `fn`
 * is handed `assertStillHeld` (below) to re-check identity immediately
 * before the registry `rename` that actually publishes its write, and
 * `register()` retries the whole read-modify-write (bounded by
 * `MAX_LOCK_LOST_RETRIES`) rather than publish a write made under a lock
 * it no longer holds.
 */
async function withRegistryLock<T>(
  registryPath: string,
  fn: (assertStillHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lockPath = `${registryPath}.lock`;
  const myToken = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(myToken);
      await handle.close();
      break;
    } catch (err) {
      if (!isEExist(err)) throw err;

      const observedToken = await readLockToken(lockPath);
      const stats = await stat(lockPath).catch(() => undefined);
      if (observedToken !== undefined && stats && Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
        } catch (renameErr) {
          if (!isEnoent(renameErr)) throw renameErr;
          continue; // already gone -- retry acquisition from scratch
        }

        const renamedToken = await readLockToken(stalePath);
        if (renamedToken !== observedToken) {
          // We renamed away a *fresh* lock a new holder created in the
          // gap between our stat/token-read and this rename -- give it
          // back without risking a clobber (see docstring).
          try {
            await link(stalePath, lockPath);
          } catch (linkErr) {
            if (!isEExist(linkErr)) throw linkErr;
            // Someone else already re-occupies `lockPath` -- fine, our
            // stolen copy is simply discarded below.
          }
          await unlink(stalePath).catch(() => {});
        } else {
          // Confirmed genuinely stale -- discard it and retry acquisition.
          await unlink(stalePath).catch(() => {});
        }

        if (Date.now() > deadline) {
          throw new CanKanError(
            BoardErrorCodes.REGISTRY_LOCK_TIMEOUT,
            `${registryPath}: timed out waiting for another process to finish updating the board registry`,
            { details: { file: registryPath } },
          );
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new CanKanError(
          BoardErrorCodes.REGISTRY_LOCK_TIMEOUT,
          `${registryPath}: timed out waiting for another process to finish updating the board registry`,
          { details: { file: registryPath } },
        );
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  const assertStillHeld = async (): Promise<void> => {
    const current = await readLockToken(lockPath);
    if (current !== myToken) {
      throw new LockLostError(`${registryPath}: lost the registry lock to another process mid-write`);
    }
  };

  try {
    return await fn(assertStillHeld);
  } finally {
    const current = await readLockToken(lockPath);
    if (current === myToken) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

async function writeRegistryAtomic(registryPath: string, data: RawRegistryFile): Promise<void> {
  const dir = dirname(registryPath);
  const tmpPath = join(dir, `.repos.yml.tmp-${randomUUID()}`);
  await writeFile(tmpPath, stringify(data), "utf8");
  await rename(tmpPath, registryPath);
}

/**
 * Registers (or re-registers) a board at `targetPath` under `name`,
 * called by `init` (M3.2). `targetPath` is canonicalized (`fs.realpath`)
 * before anything else -- the stored `path` is always the canonical form,
 * matching the canonicalization ruling every other board source follows.
 *
 * Upsert is **by canonical path**: re-registering an already-known path
 * updates its `name` and `last_seen` in place rather than adding a
 * duplicate row. A `name` already bound, in the registry, to a
 * *different* path is rejected (`BoardErrorCodes.BOARD_NAME_TAKEN`) --
 * otherwise two different repos could silently fight over one name.
 *
 * F7: refuses to register the personal board's own directory as a repo
 * board -- otherwise `--board <name>` could resolve a repo selector to
 * the personal board, defeating CONCEPT.md §6c's privacy default ("repo
 * boards never read the personal board unless `--board all`").
 *
 * Retries the whole read-modify-write, up to `MAX_LOCK_LOST_RETRIES`
 * times, if `withRegistryLock`'s `assertStillHeld` determines the lock
 * was lost mid-write (see that function's docstring) -- this is expected
 * to be exceedingly rare (it requires overrunning `LOCK_STALE_MS` while
 * still holding the lock) and self-resolves on retry rather than
 * surfacing a spurious failure to the caller.
 */
export async function register(
  name: string,
  targetPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RegistryEntry> {
  if (!isValidBoardName(name)) {
    throw invalidNameError(name);
  }
  const canonicalPath = await realpath(targetPath);
  const personalPath = await resolveCanonicalPersonalPath(env);
  if (personalPath !== undefined && canonicalPath === personalPath) {
    throw new CanKanError(
      BoardErrorCodes.CANNOT_REGISTER_PERSONAL_BOARD,
      `cannot register the personal board (${canonicalPath}) as a repo board`,
      { details: { path: canonicalPath } },
    );
  }
  const registryPath = requireRegistryPath(env);
  await ensureRegistryDir(registryPath);

  for (let attempt = 0; ; attempt++) {
    try {
      return await withRegistryLock(registryPath, async (assertStillHeld) => {
        const raw = await readRegistryRaw(registryPath);
        const repos = [...raw.repos];

        const conflicting = repos.find((entry) => entry.name === name && entry.path !== canonicalPath);
        if (conflicting) {
          throw new CanKanError(
            BoardErrorCodes.BOARD_NAME_TAKEN,
            `board name "${name}" is already registered to a different path (${conflicting.path})`,
            { details: { name, existingPath: conflicting.path, requestedPath: canonicalPath } },
          );
        }

        const entry: RawRegistryEntry = {
          name,
          path: canonicalPath,
          last_seen: new Date().toISOString(),
        };
        const existingIndex = repos.findIndex((e) => e.path === canonicalPath);
        if (existingIndex >= 0) {
          repos[existingIndex] = entry;
        } else {
          repos.push(entry);
        }

        // Re-check lock identity immediately before the write that
        // actually publishes -- see `withRegistryLock`'s docstring.
        await assertStillHeld();
        await writeRegistryAtomic(registryPath, { version: 1, repos });
        return toEntry(entry);
      });
    } catch (err) {
      if (err instanceof LockLostError && attempt < MAX_LOCK_LOST_RETRIES) {
        continue;
      }
      throw err;
    }
  }
}
