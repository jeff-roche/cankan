import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { ulid } from "ulid";
import { afterEach, describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { EventErrorCodes } from "../../src/events/errors";
import {
  boardKeyFor,
  discard,
  firstSeen,
  observe,
  recordPath,
  resolveStateDir,
} from "../../src/events/observations";
import type { EventId } from "../../src/events/schema";
import { createGitAdapter } from "../../src/git/index";
// See `log.test.ts`'s own comment: `@jeff-roche/cankan-test-utils` is not a
// declared dependency of `packages/core/package.json`, so a relative import
// to the source file is used instead of the package specifier.
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";

const repos: TempRepo[] = [];
async function tempRepo(options: Parameters<typeof makeTempRepo>[0] = {}): Promise<TempRepo> {
  const repo = await makeTempRepo(options);
  repos.push(repo);
  return repo;
}

afterEach(async () => {
  while (repos.length > 0) {
    const repo = repos.pop();
    if (repo) await repo.cleanup();
  }
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!isCanKanError(error)) {
      throw new Error(`expected a CanKanError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but the promise resolved`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Every path assertion under this module resolves the sha256 form itself, so this is just a shape check — 64 lowercase hex characters, no separator, no `..`. */
const HEX64 = /^[0-9a-f]{64}$/;

/** Recursively lists every file under `root` (absolute paths). */
async function listFilesRecursive(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("resolveStateDir (obligation 4 — $XDG_STATE_HOME, unset/empty/set)", () => {
  test("uses XDG_STATE_HOME verbatim when set", () => {
    expect(resolveStateDir({ XDG_STATE_HOME: "/x/state", HOME: "/x/home" })).toBe(join("/x/state", "cankan"));
  });

  test("falls back to $HOME/.local/state/cankan when XDG_STATE_HOME is absent", () => {
    // Deliberately no `XDG_STATE_HOME` key at all -- not `XDG_STATE_HOME:
    // undefined` -- the same testability note `layers.test.ts` documents:
    // `process.env.X = undefined` coerces to the literal string
    // "undefined" and would exercise the wrong branch if this function
    // read `process.env` directly instead of an injected `env` object.
    const env: Record<string, string | undefined> = { HOME: "/x/home" };
    expect("XDG_STATE_HOME" in env).toBe(false);
    expect(resolveStateDir(env)).toBe(join("/x/home", ".local", "state", "cankan"));
  });

  test("falls back to $HOME/.local/state/cankan when XDG_STATE_HOME is the empty string (the anticipated implementer mistake)", () => {
    expect(resolveStateDir({ XDG_STATE_HOME: "", HOME: "/x/home" })).toBe(
      join("/x/home", ".local", "state", "cankan"),
    );
  });

  // Mirrors `layers.test.ts`'s "resolveGlobalConfigPath never returns a
  // relative path" suite: a relative `XDG_STATE_HOME` must be ignored (the
  // XDG spec's own rule), not composed into a `process.cwd()`-relative
  // store location that would vary by invocation.
  test("ignores a relative XDG_STATE_HOME and falls back to $HOME/.local/state", () => {
    expect(resolveStateDir({ XDG_STATE_HOME: "rel", HOME: "/abs" })).toBe(
      join("/abs", ".local", "state", "cankan"),
    );
  });

  test("throws EVENT_OBSERVATION_STORE_UNAVAILABLE when XDG_STATE_HOME is relative and HOME is also relative -- never resolves to a cwd-relative path", () => {
    expect(() => resolveStateDir({ XDG_STATE_HOME: "rel", HOME: "also-rel" })).toThrow();
    try {
      resolveStateDir({ XDG_STATE_HOME: "rel", HOME: "also-rel" });
      throw new Error("expected resolveStateDir to throw");
    } catch (error) {
      if (!isCanKanError(error)) throw new Error(`expected a CanKanError, got ${String(error)}`);
      expect(error.code).toBe(EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE);
    }
  });

  test("a relative HOME with no XDG_STATE_HOME also throws, without ever consulting the real machine's home directory", () => {
    // Hermetic: if this fell through to the real `os.homedir()`, it would
    // very likely resolve to *some* absolute path on this machine and
    // silently pass for the wrong reason -- it must not.
    try {
      resolveStateDir({ HOME: "also-rel" });
      throw new Error("expected resolveStateDir to throw");
    } catch (error) {
      if (!isCanKanError(error)) throw new Error(`expected a CanKanError, got ${String(error)}`);
      expect(error.code).toBe(EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE);
    }
  });
});

describe("$XDG_STATE_HOME end to end, inside withEnv() (required test 2)", () => {
  test("set: observe()/firstSeen() land under the configured directory", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const customStateHome = join(home, "custom-state");
      await withEnv({ HOME: home, XDG_STATE_HOME: customStateHome }, async () => {
        const eventId = ulid() as EventId;
        const recorded = await observe("board-a", eventId, { now: 1000 });
        expect(recorded).toBe(1000);
        expect(await firstSeen("board-a", eventId)).toBe(1000);

        const files = await listFilesRecursive(join(customStateHome, "cankan", "observations"));
        expect(files.length).toBe(1);
      });
    });
  });

  test("unset: falls back to ~/.local/state/cankan, with $HOME redirected by withEnv()", async () => {
    await withEnv(undefined, async () => {
      // withEnv() itself always sets XDG_STATE_HOME to a temp default --
      // deleting it here (never assigning `undefined`, per the note
      // above) is what actually exercises the "unset" branch, while $HOME
      // stays the withEnv()-redirected temp directory, never the real one.
      delete process.env.XDG_STATE_HOME;
      expect(process.env.XDG_STATE_HOME).toBeUndefined();
      const home = process.env.HOME as string;

      const eventId = ulid() as EventId;
      const recorded = await observe("board-b", eventId, { now: 2000 });
      expect(recorded).toBe(2000);

      const expectedDir = join(home, ".local", "state", "cankan", "observations");
      const files = await listFilesRecursive(expectedDir);
      expect(files.length).toBe(1);
    });
  });

  test("empty string: falls back to ~/.local/state/cankan, exactly like unset", async () => {
    await withEnv({ XDG_STATE_HOME: "" }, async () => {
      const home = process.env.HOME as string;
      expect(process.env.XDG_STATE_HOME).toBe("");

      const eventId = ulid() as EventId;
      const recorded = await observe("board-c", eventId, { now: 3000 });
      expect(recorded).toBe(3000);

      const expectedDir = join(home, ".local", "state", "cankan", "observations");
      const files = await listFilesRecursive(expectedDir);
      expect(files.length).toBe(1);
    });
  });
});

describe("hashed path components (required test 1, obligation 2)", () => {
  test("a hostile-shaped event id hashes to a safe path component, independent of the ULID guard", async () => {
    // `recordPath` is called here directly (not through `observe`) so this
    // test exercises the hashing guard alone -- the ULID-grammar guard
    // (which would reject these same strings before they ever reach
    // `recordPath` in real use) is covered separately, in "a non-ULID
    // event id is rejected before it is hashed" below. `recordPath` reads
    // `process.env` (constraint 9), so this still runs inside `withEnv()`
    // even though it performs no filesystem I/O of its own.
    await withEnv(undefined, async () => {
      for (const hostile of ["../../../../etc/passwd", "../../.gitconfig"]) {
        const path = recordPath("some-board", hostile as EventId);
        expect(path).not.toContain("..");
        const segments = path.split(sep);
        const eventSegment = segments[segments.length - 1] as string;
        const boardSegment = segments[segments.length - 2] as string;
        expect(eventSegment).toMatch(HEX64);
        expect(boardSegment).toMatch(HEX64);
        expect(eventSegment).toBe(sha256Hex(hostile));
      }
    });
  });

  test("a hostile board key hashes to a safe path component too, and only one file is ever created, inside the state directory", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const hostileBoardKey = "../../../../etc/passwd";
      const eventId = ulid() as EventId;

      await observe(hostileBoardKey, eventId, { now: 4242 });

      const expectedPath = recordPath(hostileBoardKey, eventId);
      expect(expectedPath).not.toContain("..");
      expect(dirname(dirname(expectedPath))).toBe(join(home, ".local", "state", "cankan", "observations"));

      // Nothing was created outside the state directory: every file that
      // exists anywhere under withEnv()'s redirected $HOME is the one
      // legitimate record, at the hashed path -- never at a path literally
      // containing "etc/passwd" or "../".
      const allFiles = await listFilesRecursive(home);
      expect(allFiles).toEqual([expectedPath]);
      expect(await firstSeen(hostileBoardKey, eventId)).toBe(4242);
    });
  });
});

describe("a non-ULID event id is rejected before it is hashed (required test 9, obligation 2's other half)", () => {
  test("observe() rejects a hostile-shaped event id with a typed error", async () => {
    await withEnv(undefined, async () => {
      await expectCode(
        observe("some-board", "../../../../etc/passwd" as EventId),
        EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID,
      );
    });
  });

  test("firstSeen() and discard() reject the same way", async () => {
    await withEnv(undefined, async () => {
      await expectCode(
        firstSeen("some-board", "../../.gitconfig" as EventId),
        EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID,
      );
      await expectCode(
        discard("some-board", "not-a-ulid-at-all" as EventId),
        EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID,
      );
    });
  });

  test("a real-but-lowercased ULID is also rejected (grammar is uppercase-only, per schema.ts)", async () => {
    await withEnv(undefined, async () => {
      const real = ulid();
      await expectCode(
        observe("some-board", real.toLowerCase() as EventId),
        EventErrorCodes.EVENT_OBSERVATION_INVALID_EVENT_ID,
      );
    });
  });
});

describe("input validation guards a caller mistake, not only a peer-supplied value", () => {
  test("observe()/firstSeen()/discard() reject an empty boardKey", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      await expectCode(observe("", eventId), EventErrorCodes.EVENT_OBSERVATION_INVALID_BOARD_KEY);
      await expectCode(firstSeen("", eventId), EventErrorCodes.EVENT_OBSERVATION_INVALID_BOARD_KEY);
      await expectCode(discard("", eventId), EventErrorCodes.EVENT_OBSERVATION_INVALID_BOARD_KEY);
    });
  });

  test("observe() rejects a non-finite `now` before it is ever stored -- an unguarded NaN would silently produce a record firstSeen() can never read back, re-observing forever", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      await expectCode(observe("board-now", eventId, { now: Number.NaN }), EventErrorCodes.EVENT_LOG_INVALID_WINDOW);
      // Nothing was written -- a subsequent call still sees "no record".
      expect(await firstSeen("board-now", eventId)).toBeNull();
    });
  });

  test("observe(boardKey, eventId, null) is treated as 'no options', not a raw TypeError (fix round 1, Important)", async () => {
    // A default parameter (`options: ObserveOptions = {}`) only substitutes
    // for `undefined`, not an explicit `null` -- the original signature let
    // `null` reach `options.now` and throw an unwrapped `TypeError`, which
    // `isCanKanError` cannot recognize and M3.10 cannot map to an exit
    // code. Fixed via `options ?? {}`, which treats `null` the same as
    // omitting the argument entirely.
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      const before = Date.now();
      const recorded = await observe("board-null-options", eventId, null);
      const after = Date.now();
      expect(recorded).toBeGreaterThanOrEqual(before);
      expect(recorded).toBeLessThanOrEqual(after);
      expect(await firstSeen("board-null-options", eventId)).toBe(recorded);
    });
  });
});

describe("discarded on release (required test 3)", () => {
  test("discard() removes a recorded observation; firstSeen() reports null afterward", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      await observe("board-d", eventId, { now: 5000 });
      expect(await firstSeen("board-d", eventId)).toBe(5000);

      await discard("board-d", eventId);
      expect(await firstSeen("board-d", eventId)).toBeNull();
    });
  });

  test("discard() is idempotent -- discarding an id with no record is not an error", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      await discard("board-e", eventId);
      await discard("board-e", eventId);
      expect(await firstSeen("board-e", eventId)).toBeNull();
    });
  });
});

describe("a corrupt on-disk record is self-healed, not fatal (documented in observe()'s doc comment)", () => {
  test("observe() overwrites unparseable content with a fresh observation instead of erroring", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      const path = recordPath("board-corrupt", eventId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "not json at all{{{", "utf8");

      const recorded = await observe("board-corrupt", eventId, { now: 11000 });
      expect(recorded).toBe(11000);
      expect(await firstSeen("board-corrupt", eventId)).toBe(11000);
    });
  });
});

describe("absent store tolerated (required test 4)", () => {
  test("firstSeen() reports null when the state directory does not exist at all yet", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      expect(await firstSeen("board-f", eventId)).toBeNull();
    });
  });

  test("observe() creates the state directory on first write and records now, unexpired", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const stateDir = join(home, ".local", "state", "cankan");
      expect(await listFilesRecursive(stateDir)).toEqual([]);

      const eventId = ulid() as EventId;
      const recorded = await observe("board-g", eventId, { now: 6000 });
      expect(recorded).toBe(6000);
      expect(await listFilesRecursive(stateDir)).toHaveLength(1);
    });
  });
});

describe("unwritable store is a typed hard error (required test 5)", () => {
  // Fix round 1 minor: a silent early `return` under root reports "pass"
  // having asserted nothing (root bypasses permission bits entirely, so
  // chmod does not restrict) -- `test.skipIf` makes a root run show
  // "skip" instead, the honest outcome.
  test.skipIf(process.getuid?.() === 0)(
    "observe() hard-errors when the board's hash directory cannot be written to",
    async () => {
      await withEnv(undefined, async () => {
        const eventId = ulid() as EventId;
        const path = recordPath("board-h", eventId);
        const boardHashDir = dirname(path);

        // Pre-create the board-hash directory (and its parents) so
        // `observe()`'s own `mkdir(..., { recursive: true })` is a no-op,
        // then strip write permission -- reproducing a read-only or full
        // state directory (ADR 1142-1148).
        await mkdir(boardHashDir, { recursive: true });
        await chmod(boardHashDir, 0o500);

        try {
          await expectCode(
            observe("board-h", eventId, { now: 7000 }),
            EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
          );
        } finally {
          // Restore write permission so withEnv()'s own cleanup (`rm`) can
          // remove the temp $HOME tree afterward.
          await chmod(boardHashDir, 0o700);
        }
      });
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "firstSeen() hard-errors on a record file it cannot read, distinct from 'no record'",
    async () => {
      await withEnv(undefined, async () => {
        const eventId = ulid() as EventId;
        await observe("board-i", eventId, { now: 8000 });
        const path = recordPath("board-i", eventId);

        await chmod(path, 0o000);
        try {
          await expectCode(firstSeen("board-i", eventId), EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE);
        } finally {
          await chmod(path, 0o600);
        }
      });
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "discard() hard-errors when it cannot remove the record (fix round 1 coverage gap)",
    async () => {
      await withEnv(undefined, async () => {
        const eventId = ulid() as EventId;
        await observe("board-discard-perm", eventId, { now: 12000 });
        const path = recordPath("board-discard-perm", eventId);
        const boardHashDir = dirname(path);

        // `rm`/`unlink` needs write permission on the *containing*
        // directory, not the file itself.
        await chmod(boardHashDir, 0o500);
        try {
          await expectCode(
            discard("board-discard-perm", eventId),
            EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
          );
        } finally {
          await chmod(boardHashDir, 0o700);
        }
      });
    },
  );

  test("firstSeen() hard-errors (not 'no record') when a path component that should be a directory is a plain file -- ENOTDIR is a broken store, not an absent one", async () => {
    // Probed directly (task-3-report.md): `readFile("<file>/<segment>")`
    // raises `ENOTDIR`, distinct from `ENOENT`. Reporting this as `null`
    // ("never observed") would fail open exactly where R7 says fail
    // closed -- and disagree with `observe()`, whose own
    // `mkdir(..., { recursive: true })` already hard-errors on this same
    // condition.
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const observationsDir = join(home, ".local", "state", "cankan", "observations");
      await mkdir(dirname(observationsDir), { recursive: true });
      await writeFile(observationsDir, "not a directory", "utf8");

      const eventId = ulid() as EventId;
      await expectCode(firstSeen("board-enotdir", eventId), EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE);
    });
  });

  test("state directories are created 0700, regardless of umask (fix round 1, High S1)", async () => {
    // Probed directly (task-3-report.md): with no explicit `mode`, a
    // freshly-created directory ends up `0777` under `umask 000` --
    // routine in containers and CI -- which lets any local user plant a
    // file or symlink inside it. `mode: 0o700` is unaffected by `umask`
    // (also probed directly), so this must hold regardless of the
    // running process's own umask.
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      await observe("board-mode", eventId, { now: 1 });

      const path = recordPath("board-mode", eventId);
      const boardHashDir = dirname(path);
      const observationsDir = dirname(boardHashDir);
      const cankanDir = dirname(observationsDir);

      for (const dir of [cankanDir, observationsDir, boardHashDir]) {
        const stat = await lstat(dir);
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });
  });
});

describe("Fix round 1, High S1 -- a planted symlink is refused, never followed or healed over", () => {
  test("observe() refuses to read through a symlinked record, and never touches the symlink's target", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      const path = recordPath("board-symlink-observe", eventId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });

      const victimPath = join(dirname(path), "victim.json");
      const victimContent = JSON.stringify({ firstSeenAtMs: 1 });
      await writeFile(victimPath, victimContent, "utf8");
      await symlink(victimPath, path);

      await expectCode(
        observe("board-symlink-observe", eventId, { now: 99999 }),
        EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
      );

      // The symlink itself is untouched (still a symlink, not replaced by
      // a "healed" plain file) and the victim's content is untouched --
      // `observe()` never read through it, and never wrote through it
      // either.
      const relstat = await lstat(path);
      expect(relstat.isSymbolicLink()).toBe(true);
      expect(await readFile(victimPath, "utf8")).toBe(victimContent);
    });
  });

  test("firstSeen() refuses the same way, rather than trusting the attacker's planted value", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      const path = recordPath("board-symlink-firstseen", eventId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });

      const victimPath = join(dirname(path), "victim2.json");
      // A far-in-the-past `firstSeenAtMs` -- if this were trusted, M2.10
      // would see the claim as ancient and take it over.
      await writeFile(victimPath, JSON.stringify({ firstSeenAtMs: 1 }), "utf8");
      await symlink(victimPath, path);

      await expectCode(
        firstSeen("board-symlink-firstseen", eventId),
        EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
      );
    });
  });

  test("observe() refuses when the board-hash directory itself is a symlink to another directory, and writes nothing into the attacker's target", async () => {
    await withEnv(undefined, async () => {
      const home = process.env.HOME as string;
      const eventId = ulid() as EventId;
      const path = recordPath("board-symlink-dir", eventId);
      const boardHashDir = dirname(path);
      const observationsDir = dirname(boardHashDir);
      await mkdir(observationsDir, { recursive: true, mode: 0o700 });

      const attackerTarget = join(home, "attacker-target-dir");
      await mkdir(attackerTarget, { recursive: true });
      await symlink(attackerTarget, boardHashDir);

      await expectCode(
        observe("board-symlink-dir", eventId, { now: 1 }),
        EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE,
      );

      expect(await listFilesRecursive(attackerTarget)).toEqual([]);
    });
  });

  test(
    "firstSeen() refuses a named pipe (FIFO) planted at the record path, rather than hanging while trying to read it",
    async () => {
      // `lstatPlainFileOrNull`'s `isFile()` check is otherwise redundant
      // with `readPlainFile`'s `O_NOFOLLOW` open for a *symlink* or a
      // *directory* planted at the record path -- both are independently
      // rejected by the open/read step alone (probed directly:
      // `O_NOFOLLOW` open on a directory succeeds, but the subsequent
      // `readFile` on it fails `EISDIR`). A FIFO is the case where it is
      // not redundant: opening a FIFO for reading **blocks** until a
      // writer opens it -- with no writer, that call never returns.
      // Without the `lstat`-based `isFile()` check running first (a
      // non-blocking call), this would hang rather than fail, a DoS
      // instead of a clean error. The explicit test timeout below is the
      // proof this stays a fast failure, not a hang, if the guard ever
      // regresses.
      await withEnv(undefined, async () => {
        const eventId = ulid() as EventId;
        const path = recordPath("board-fifo", eventId);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });

        const result = Bun.spawnSync(["mkfifo", path]);
        if (result.exitCode !== 0) {
          throw new Error(`mkfifo failed: ${result.stderr.toString()}`);
        }

        await expectCode(firstSeen("board-fifo", eventId), EventErrorCodes.EVENT_OBSERVATION_STORE_UNAVAILABLE);
      });
    },
    3000,
  );
});

describe("Fix round 1, Critical C1 -- observe() is idempotent under genuine concurrency, not only sequential repetition", () => {
  test("many concurrent observe() calls for the same key all agree with each other and with what's persisted", async () => {
    // The original "idempotence" test below calls `observe()` sequentially
    // (`await`, then `await`) -- it tests repetition, not concurrency, and
    // passed even though a genuine race could make two callers disagree
    // (fix round 1 found ~1% of trials under a real `Promise.all` race
    // disagreed, once even landing on a value neither caller returned).
    // This test launches every call at once and repeats across many
    // independent keys to clear that rate reliably.
    await withEnv(undefined, async () => {
      const TRIALS = 300;
      const CONCURRENCY = 6;
      for (let trial = 0; trial < TRIALS; trial++) {
        const boardKey = `board-race-${trial}`;
        const eventId = ulid() as EventId;
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) => observe(boardKey, eventId, { now: 1_000_000 + trial * 100 + i })),
        );

        const distinctValues = new Set(results);
        if (distinctValues.size !== 1) {
          throw new Error(
            `trial ${trial}: concurrent observe() calls disagreed: ${JSON.stringify(results)}`,
          );
        }

        const persisted = await firstSeen(boardKey, eventId);
        expect(persisted).toBe(results[0] as number);
      }
    });
  });
});

describe("one clone, one key (required test 6)", () => {
  test("two worktrees and a subdirectory of one all produce the same board key", async () => {
    const repo = await tempRepo({ worktrees: 1 });
    const [worktreeDir] = repo.worktreeDirs;
    if (!worktreeDir) throw new Error("expected one worktree");
    const subDir = join(worktreeDir, "a", "b");
    await mkdir(subDir, { recursive: true });

    const mainAdapter = await createGitAdapter(repo.dir);
    const worktreeAdapter = await createGitAdapter(worktreeDir);
    const subDirAdapter = await createGitAdapter(subDir);

    const mainKey = await boardKeyFor(mainAdapter);
    const worktreeKey = await boardKeyFor(worktreeAdapter);
    const subDirKey = await boardKeyFor(subDirAdapter);

    // The macOS path trap (constraints.md): `makeTempRepo`'s own `root` is
    // already `fs.realpath`'d at fixture construction (see
    // `tempRepo.ts`'s own comment), but the *board key itself* comes from
    // the adapter, not the fixture -- resolving it again here is what this
    // assertion is actually checking, not assuming.
    const expected = await realpath(join(repo.dir, ".git"));
    expect(mainKey).toBe(expected);
    expect(worktreeKey).toBe(expected);
    expect(subDirKey).toBe(expected);
  });
});

describe("idempotence (required test 7)", () => {
  test("a second observe() for the same key does not move the recorded time", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      const first = await observe("board-j", eventId, { now: 9000 });
      const second = await observe("board-j", eventId, { now: 9999 });
      expect(first).toBe(9000);
      expect(second).toBe(9000);
      expect(await firstSeen("board-j", eventId)).toBe(9000);
    });
  });
});

describe("persistence across invocations (required test 8)", () => {
  test("a fresh call sequence reads back what an earlier one wrote -- no in-memory state carried between calls", async () => {
    await withEnv(undefined, async () => {
      const eventId = ulid() as EventId;
      await observe("board-k", eventId, { now: 10000 });

      // This module exports plain functions, not a stateful instance --
      // there is nothing to "construct fresh" beyond calling `firstSeen`
      // again, which is exactly the point: it can only see the recorded
      // value by reading it back off disk, since no process-local cache
      // exists to short-circuit that read.
      expect(await firstSeen("board-k", eventId)).toBe(10000);
    });
  });
});

describe("boardKeyFor / resolveStateDir sanity", () => {
  test("boardKeyFor delegates to GitAdapter.gitCommonDir()", async () => {
    const repo = await tempRepo();
    const adapter = await createGitAdapter(repo.dir);
    expect(await boardKeyFor(adapter)).toBe(await adapter.gitCommonDir());
  });

  test("resolveStateDir with no HOME at all in env falls back to the real os.homedir() (documented, not exercised against the real machine elsewhere in this suite)", async () => {
    // No I/O and no real path is touched by `resolveStateDir` itself, but
    // `homedir()` reads live `process.env.HOME` (fix round 1 minor) --
    // wrapping in `withEnv()` costs nothing and keeps this test from ever
    // depending on whatever `$HOME` happens to be on the machine running
    // the suite.
    await withEnv(undefined, async () => {
      expect(resolveStateDir({})).toBe(join(homedir(), ".local", "state", "cankan"));
    });
  });
});
