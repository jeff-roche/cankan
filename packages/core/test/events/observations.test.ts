import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
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
  test("observe() hard-errors when the board's hash directory cannot be written to", async () => {
    if (process.getuid?.() === 0) {
      // root bypasses permission bits entirely -- chmod does not restrict.
      return;
    }
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
  });

  test("firstSeen() hard-errors on a record file it cannot read, distinct from 'no record'", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
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
  });

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

  test("resolveStateDir with no HOME at all in env falls back to the real os.homedir() (documented, not exercised against the real machine elsewhere in this suite)", () => {
    expect(resolveStateDir({})).toBe(join(homedir(), ".local", "state", "cankan"));
  });
});
