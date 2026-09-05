import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { ensurePersonalBoard, resolvePersonalBoardPath } from "../../src/board/personal";
import { buildBoardRef } from "../../src/board/ref";
import {
  findRegisteredBoard,
  isValidBoardName,
  listRegisteredBoards,
  register,
  resolveRegistryPath,
} from "../../src/board/registry";
import { isCanKanError } from "../../src/errors";
import { hermeticEnv, writeFileEnsuringDir } from "../config/testHelpers";

async function makeBoardDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cankan-registry-board-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `JSON.stringify` of a thrown `CanKanError`'s `details`, for asserting
 * what does or doesn't appear there specifically (fix round 2, F7) --
 * `details`, not `message`, is the channel `toJSON`/`--json` output
 * actually publishes, so a message-only assertion does not discriminate a
 * fix that scrubs the message but leaves `details.path` intact.
 */
function detailsAsString(thrown: unknown): string {
  const details = (thrown as { details?: unknown }).details;
  return JSON.stringify(details ?? {});
}

/**
 * Creates a FIFO (named pipe) at `path` via the real `mkfifo(1)` -- Node
 * has no `fs.mkfifo`. Used only by the lock-race tests below: a FIFO's
 * `open()`/read/write calls are real blocking rendezvous points, which is
 * what makes it possible to deterministically pause `withRegistryLock`'s
 * internal reads at an exact line, from outside the process, without
 * mocking anything.
 */
function mkfifo(path: string): void {
  const result = Bun.spawnSync(["mkfifo", path]);
  if (result.exitCode !== 0) {
    throw new Error(`mkfifo ${path} failed: ${result.stderr.toString()}`);
  }
}

/**
 * Opens `path` for writing in a **subprocess**, writes `content`, and
 * (optionally) holds the write end open for `holdMs` before closing.
 * Deliberately a subprocess, not an in-process `fs.open`/`fs.write`:
 * opening a FIFO for writing blocks until a reader connects, and doing
 * that directly in this process's own JS stalls Bun's event loop outright
 * (verified) -- reads are fine in-process (they use the thread pool
 * properly), only the write side needs to live in a separate OS process.
 * EOF (and so the paired reader's `readFile` resolving) only happens once
 * this process's fd closes -- a `write()` does not signal EOF by itself,
 * which is what makes `holdMs` useful as a window for the caller to do
 * something (e.g. back-date the file's mtime) before the paired read can
 * complete.
 */
function spawnFifoWriter(path: string, content: string, holdMs = 0) {
  const script =
    holdMs > 0
      ? `exec 3>'${path}'; printf '%s' '${content}' >&3; sleep ${holdMs / 1000}; exec 3>&-`
      : `exec 3>'${path}'; printf '%s' '${content}' >&3; exec 3>&-`;
  return Bun.spawn(["bash", "-c", script]);
}

async function waitForPath(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await lstat(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to appear`);
      await sleep(10);
    }
  }
}

async function waitForGlobMatch(dir: string, prefix: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const match = entries.find((entry) => entry.startsWith(prefix));
    if (match) return join(dir, match);
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a file starting with "${prefix}" in ${dir}`);
    }
    await sleep(10);
  }
}

describe("registry -- missing file", () => {
  test("a missing repos.yml is an empty list, never an error", async () => {
    await withEnv(undefined, async () => {
      const listing = await listRegisteredBoards(hermeticEnv());
      expect(listing.boards).toEqual([]);
      expect(listing.skipped).toEqual([]);
    });
  });
});

describe("registry -- malformed file", () => {
  test("a YAML syntax error fails with a message naming the file", async () => {
    await withEnv(undefined, async () => {
      const registryPath = resolveRegistryPath(hermeticEnv());
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(registryPath, "version: 1\nrepos: [\n");

      let thrown: unknown;
      try {
        await listRegisteredBoards(hermeticEnv());
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      const err = thrown as Error & { code: string };
      expect(err.code).toBe("REGISTRY_INVALID");
      expect(err.message).toContain(registryPath);
    });
  });

  test("a schema validation failure (bad shape) fails with a message naming the file", async () => {
    await withEnv(undefined, async () => {
      const registryPath = resolveRegistryPath(hermeticEnv());
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(registryPath, "version: 1\nrepos:\n  - name: api\n    path: relative/not/absolute\n    last_seen: 2026-09-05T08:00:00.000Z\n");

      let thrown: unknown;
      try {
        await listRegisteredBoards(hermeticEnv());
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      const err = thrown as Error & { code: string };
      expect(err.code).toBe("REGISTRY_INVALID");
      expect(err.message).toContain(registryPath);
    });
  });

  test("a hand-edited entry named 'personal' is rejected as malformed, not silently accepted", async () => {
    await withEnv(undefined, async () => {
      const registryPath = resolveRegistryPath(hermeticEnv());
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(
        registryPath,
        "version: 1\nrepos:\n  - name: personal\n    path: /tmp/whatever\n    last_seen: 2026-09-05T08:00:00.000Z\n",
      );

      let thrown: unknown;
      try {
        await listRegisteredBoards(hermeticEnv());
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("REGISTRY_INVALID");
    });
  });
});

describe("registry -- entry whose directory no longer exists", () => {
  test("a deleted-directory entry is skipped, not dropped, and does not break the other entries' read", async () => {
    await withEnv(undefined, async () => {
      const gone = await makeBoardDir();
      const alive = await makeBoardDir();
      try {
        await register("gone", gone.dir, hermeticEnv());
        await register("alive", alive.dir, hermeticEnv());
        await gone.cleanup();

        const listing = await listRegisteredBoards(hermeticEnv());
        expect(listing.boards.map((b) => b.name)).toEqual(["alive"]);
        expect(listing.skipped).toHaveLength(1);
        expect(listing.skipped[0]?.name).toBe("gone");
        expect(listing.skipped[0]?.reason).toContain("no longer exists");
      } finally {
        await alive.cleanup();
      }
    });
  });
});

describe("registry -- atomic writes", () => {
  test("register() writes via temp file + rename in the registry's own directory, never in place", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        await register("api", board.dir, hermeticEnv());
        const registryPath = resolveRegistryPath(hermeticEnv());
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        const text = await readFile(registryPath, "utf8");
        expect(text).toContain("api");
        expect(text).toContain(await realpath(board.dir));
      } finally {
        await board.cleanup();
      }
    });
  });
});

describe("registry -- concurrent register()", () => {
  test("two concurrent register() calls with different names both survive", async () => {
    await withEnv(undefined, async () => {
      const boardA = await makeBoardDir();
      const boardB = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await Promise.all([register("api", boardA.dir, env), register("web", boardB.dir, env)]);

        const listing = await listRegisteredBoards(env);
        const names = listing.boards.map((b) => b.name).sort();
        expect(names).toEqual(["api", "web"]);
      } finally {
        await boardA.cleanup();
        await boardB.cleanup();
      }
    });
  });
});

describe("registry -- stale lock breaking", () => {
  test("a lockfile older than the staleness window is broken, not waited out", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        const env = hermeticEnv();
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await mkdir(join(registryPath, ".."), { recursive: true });

        const lockPath = `${registryPath}.lock`;
        await writeFile(lockPath, "");
        // Back-date the lock well past the staleness window (10s) but
        // within register()'s own bounded-retry timeout (5s) -- without
        // the stale-break, register() would time out with
        // REGISTRY_LOCK_TIMEOUT instead of succeeding quickly.
        const staleTime = new Date(Date.now() - 30_000);
        await utimes(lockPath, staleTime, staleTime);

        const entry = await register("api", board.dir, env);
        expect(entry.name).toBe("api");

        const listing = await listRegisteredBoards(env);
        expect(listing.boards.map((b) => b.name)).toEqual(["api"]);
      } finally {
        await board.cleanup();
      }
    });
  });

  // Security review (G4): the old break condition required
  // `readLockToken` to succeed *before* a lockfile could even be
  // considered stale. A lockfile this process cannot read the token of
  // -- unreadable, or a directory -- could therefore never be judged
  // stale no matter how old it was, and `register()` would wedge forever
  // (never recovering without a manual `rm`). `withRegistryLock` always
  // creates its own lockfile via `open(path, "wx")` + `writeFile` at
  // default mode, so anything shaped like this was never created by
  // cankan and is broken unconditionally once aged -- see the fix.
  test("G4: an unreadable stale lockfile is broken, not permanently wedged", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        const env = hermeticEnv();
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await mkdir(join(registryPath, ".."), { recursive: true });

        const lockPath = `${registryPath}.lock`;
        await writeFile(lockPath, "");
        await chmod(lockPath, 0o000);
        const staleTime = new Date(Date.now() - 30_000);
        await utimes(lockPath, staleTime, staleTime);

        try {
          const entry = await register("api", board.dir, env);
          expect(entry.name).toBe("api");
        } finally {
          // In case the fix somehow left the original (now-unreadable)
          // file behind, restore permissions before withEnv()'s own
          // cleanup tries to remove the temp home tree.
          await chmod(lockPath, 0o700).catch(() => {});
        }
      } finally {
        await board.cleanup();
      }
    });
  });

  test("G4: a directory-shaped stale lockfile is broken, not permanently wedged", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        const env = hermeticEnv();
        const registryPath = resolveRegistryPath(env);
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await mkdir(join(registryPath, ".."), { recursive: true });

        const lockPath = `${registryPath}.lock`;
        await mkdir(lockPath, { recursive: true });
        const staleTime = new Date(Date.now() - 30_000);
        await utimes(lockPath, staleTime, staleTime);

        const entry = await register("api", board.dir, env);
        expect(entry.name).toBe("api");

        // A directory-shaped foreign object can't be `unlink`ed -- confirm
        // the fix's `rm(recursive)` actually cleaned up the renamed-away
        // copy rather than leaking a `.stale-*` directory behind.
        const registryDirEntries = await readdir(dirname(registryPath));
        expect(registryDirEntries.some((name) => name.includes(".stale-"))).toBe(false);
      } finally {
        await board.cleanup();
      }
    });
  });
});

describe("registry -- N3: a stale lock stolen mid-break is restored, preserving identity", () => {
  test("a fresh lock stolen by a naive stale-break is put back (preserving its FIFO identity) and leaves no orphaned .stale-* file", async () => {
    // Note: this test alone does not discriminate `link` from `rename` --
    // with no third actor contending for `lockPath` at the restoration
    // instant, either primitive would produce the same observable result
    // (a FIFO back at `lockPath`, no leftovers). It proves restoration
    // *happens* and preserves the original file's identity. The next
    // test ("never clobbers a third actor's lock") is what actually
    // proves `link` over `rename` -- see its own comment for why.
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });

      const lockPath = `${registryPath}.lock`;
      const lockDir = dirname(lockPath);
      const lockBasename = basename(lockPath);
      mkfifo(lockPath);
      const initiallyStale = new Date(Date.now() - 30_000);
      await utimes(lockPath, initiallyStale, initiallyStale);

      const board = await makeBoardDir();
      try {
        // `register()`'s own EEXIST-on-open path is what reads `lockPath`
        // -- a FIFO makes that read (and the read of whatever it gets
        // renamed to) a real, externally-controllable rendezvous point
        // instead of something this test would otherwise have to guess
        // the timing of.
        const registerPromise = register("fifo-race", board.dir, env);
        registerPromise.catch(() => {});

        // ---- Round 1: feed OLD-TOKEN; back-date mtime while the writer
        // still holds the FIFO open (a write bumps mtime, a close does
        // not -- verified) so `stat` still judges it stale once the
        // paired read completes. ----
        const w1 = spawnFifoWriter(lockPath, "OLD-TOKEN", 300);
        await sleep(100);
        await utimes(lockPath, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
        await w1.exited;

        const stalePath1 = await waitForGlobMatch(lockDir, `${lockBasename}.stale-`);

        // ---- Feed a *different* token via the renamed path: from
        // `withRegistryLock`'s point of view this is indistinguishable
        // from "a new holder acquired the lock in the gap between our
        // staleness check and our rename." ----
        const w2 = spawnFifoWriter(stalePath1, "FRESH-TOKEN");
        await w2.exited;

        // The mismatch must restore `lockPath`, and the restored file
        // must still be the original FIFO (not a new regular file some
        // other code path invented).
        await waitForPath(lockPath);
        await sleep(50); // let the restore's own unlink(stalePath) settle
        const restored = await lstat(lockPath);
        expect(restored.isFIFO()).toBe(true);
        const leftoversAfterRestore = (await readdir(lockDir)).filter((f) =>
          f.startsWith(`${lockBasename}.stale-`),
        );
        expect(leftoversAfterRestore).toEqual([]);

        // ---- Round 2: same trick, but with a *matching* token both
        // times, so this pass is genuinely stale (no mismatch) and gets
        // discarded for good via unlink -- freeing `lockPath` for a real
        // acquisition, so the test (and `register()`) terminate cleanly
        // instead of racing this FIFO forever. ----
        const w3 = spawnFifoWriter(lockPath, "MATCH-TOKEN", 300);
        await sleep(100);
        await utimes(lockPath, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
        await w3.exited;

        const stalePath2 = await waitForGlobMatch(lockDir, `${lockBasename}.stale-`);
        const w4 = spawnFifoWriter(stalePath2, "MATCH-TOKEN");
        await w4.exited;

        const entry = await registerPromise;
        expect((entry as { name: string }).name).toBe("fifo-race");

        const finalContents = await readdir(lockDir);
        expect(finalContents.some((f) => f.includes(".stale-"))).toBe(false);
        expect(finalContents.some((f) => f === lockBasename)).toBe(false);
      } finally {
        await board.cleanup();
        await unlink(lockPath).catch(() => {});
      }
    });
  }, 15000);

  test("restoring a stolen lock never clobbers a fourth process's legitimate, freshly-acquired lock (this is what actually proves link over rename)", async () => {
    // This is the test that discriminates `link(stalePath, lockPath)`
    // from `rename(stalePath, lockPath)`. The previous test has no third
    // party occupying `lockPath` at the moment of restoration, so
    // `rename` -- which unconditionally overwrites its destination --
    // would pass it identically to `link` -- which fails `EEXIST` if the
    // destination is occupied. Verified directly: swapping `link` for
    // `rename` in `withRegistryLock` made this test fail (the fourth
    // process's lock was destroyed and replaced by the restored FIFO)
    // while leaving the previous test green -- see the fix report for
    // the exact before/after.
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });

      const lockPath = `${registryPath}.lock`;
      const lockDir = dirname(lockPath);
      const lockBasename = basename(lockPath);
      mkfifo(lockPath);
      const initiallyStale = new Date(Date.now() - 30_000);
      await utimes(lockPath, initiallyStale, initiallyStale);

      const board = await makeBoardDir();
      try {
        const registerPromise = register("fifo-race-4th", board.dir, env);
        registerPromise.catch(() => {});

        // Round 1, identical setup to the previous test: get `lockPath`
        // (the FIFO) renamed away to `stalePath` by feeding an
        // old/stale token.
        const w1 = spawnFifoWriter(lockPath, "OLD-TOKEN", 300);
        await sleep(100);
        await utimes(lockPath, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
        await w1.exited;

        const stalePath = await waitForGlobMatch(lockDir, `${lockBasename}.stale-`);

        // `lockPath` is free now (the FIFO was renamed away). Occupy it
        // with a plain regular file -- standing in for a fourth process
        // that legitimately acquired the lock in the gap between the
        // staleness check and the rename. `withRegistryLock`'s pending
        // read of `stalePath` (below) is what makes this timing safe:
        // nothing else touches `lockPath` until that read resolves and
        // the mismatch-restore logic runs.
        await writeFile(lockPath, "FOURTH-PROCESS-TOKEN");

        // Feed a token that mismatches "OLD-TOKEN" so the restore branch
        // fires and attempts to give the (still-FIFO) stale copy back.
        const w2 = spawnFifoWriter(stalePath, "FRESH-TOKEN");
        await w2.exited;

        // Give the mismatch-restore logic a moment to run: `link` must
        // fail `EEXIST` against our occupant, be swallowed, and fall
        // through to `unlink(stalePath)`.
        await sleep(150);

        const survivor = await lstat(lockPath);
        expect(survivor.isFIFO()).toBe(false);
        expect(await readFile(lockPath, "utf8")).toBe("FOURTH-PROCESS-TOKEN");
        const leftovers = (await readdir(lockDir)).filter((f) => f.startsWith(`${lockBasename}.stale-`));
        expect(leftovers).toEqual([]);

        // Clean up the stand-in "fourth process" lock (simulating it
        // releasing normally) so `register()`'s still-in-flight attempt
        // can acquire for real and this test terminates deterministically.
        await unlink(lockPath).catch(() => {});
        const entry = await registerPromise;
        expect((entry as { name: string }).name).toBe("fifo-race-4th");
      } finally {
        await board.cleanup();
        await unlink(lockPath).catch(() => {});
      }
    });
  }, 15000);
});

describe("registry -- N1: LockLostError never escapes register() untyped", () => {
  test("repeatedly losing the lock mid-write, past MAX_LOCK_LOST_RETRIES, surfaces a typed REGISTRY_LOCK_LOST error", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      const lockPath = `${registryPath}.lock`;
      await mkdir(dirname(registryPath), { recursive: true });

      // `registryPath` itself (the actual repos.yml file `readRegistryRaw`
      // reads inside the locked section) is the FIFO here -- it gives
      // this test a rendezvous point *after* the lock has already been
      // acquired but *before* `assertStillHeld()` runs, which is exactly
      // the window `assertStillHeld` exists to guard. `MAX_LOCK_LOST_
      // RETRIES` is 3 (register.ts), so 4 total acquisitions (attempts
      // 0-3) are needed to exhaust it.
      mkfifo(registryPath);

      const board = await makeBoardDir();
      try {
        const registerPromise = register("n1-race", board.dir, env);

        for (let attempt = 0; attempt <= 3; attempt++) {
          await waitForPath(lockPath);
          // Simulate "another process broke/took this lock while we were
          // busy": remove it out from under the in-flight register()
          // call. This both makes the upcoming assertStillHeld() see no
          // lock at all (a mismatch) and frees `lockPath` for the retry's
          // own fresh acquisition.
          await unlink(lockPath).catch(() => {});
          const w = spawnFifoWriter(registryPath, "version: 1\nrepos: []\n");
          await w.exited;
        }

        let thrown: unknown;
        try {
          await registerPromise;
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("REGISTRY_LOCK_LOST");
        expect((thrown as Error).message).toContain(registryPath);
      } finally {
        await board.cleanup();
        await unlink(lockPath).catch(() => {});
      }
    });
  }, 15000);
});

describe("registry -- upsert semantics", () => {
  test("re-registering the same canonical path updates the existing row rather than duplicating it", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await register("api", board.dir, env);
        await register("api-renamed", board.dir, env);

        const listing = await listRegisteredBoards(env);
        expect(listing.boards).toHaveLength(1);
        expect(listing.boards[0]?.name).toBe("api-renamed");
        expect(listing.boards[0]?.path).toBe(await realpath(board.dir));
      } finally {
        await board.cleanup();
      }
    });
  });

  test("a name already bound to a different path is a naming conflict, not a silent overwrite", async () => {
    await withEnv(undefined, async () => {
      const boardA = await makeBoardDir();
      const boardB = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await register("api", boardA.dir, env);

        let thrown: unknown;
        try {
          await register("api", boardB.dir, env);
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("BOARD_NAME_TAKEN");

        const listing = await listRegisteredBoards(env);
        expect(listing.boards).toHaveLength(1);
        expect(listing.boards[0]?.path).toBe(await realpath(boardA.dir));
      } finally {
        await boardA.cleanup();
        await boardB.cleanup();
      }
    });
  });
});

describe("registry -- reserved and shape-invalid board names", () => {
  const reserved = ["personal", "repo", "all"];
  for (const name of reserved) {
    test(`register() refuses the reserved name "${name}"`, async () => {
      await withEnv(undefined, async () => {
        const board = await makeBoardDir();
        try {
          let thrown: unknown;
          try {
            await register(name, board.dir, hermeticEnv());
          } catch (err) {
            thrown = err;
          }
          expect(isCanKanError(thrown)).toBe(true);
          expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
        } finally {
          await board.cleanup();
        }
      });
    });

    test(`findRegisteredBoard() refuses the reserved name "${name}"`, async () => {
      await withEnv(undefined, async () => {
        let thrown: unknown;
        try {
          await findRegisteredBoard(name, hermeticEnv());
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
      });
    });
  }

  const invalidShapes: Array<[string, string]> = [
    ["contains a slash", "foo/bar"],
    ["contains a backslash", "foo\\bar"],
    ["is exactly '.'", "."],
    ["is exactly '..'", ".."],
    ["is an absolute path", "/etc/passwd"],
    ["is empty", ""],
    ["has a NUL byte", "foo\0bar"],
    ["has a control character", "foo\tbar"],
    ["has a drive-letter prefix", "C:evil"],
  ];
  for (const [label, name] of invalidShapes) {
    test(`isValidBoardName rejects a name that ${label}`, () => {
      expect(isValidBoardName(name)).toBe(false);
    });
  }

  test("register() refuses a shape-invalid name", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      try {
        let thrown: unknown;
        try {
          await register("../evil", board.dir, hermeticEnv());
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
      } finally {
        await board.cleanup();
      }
    });
  });

  test("a plain valid name is accepted", () => {
    expect(isValidBoardName("api")).toBe(true);
    expect(isValidBoardName("my-repo_2")).toBe(true);
  });
});

describe("registry -- findRegisteredBoard", () => {
  test("finds the right entry among several", async () => {
    await withEnv(undefined, async () => {
      const boardA = await makeBoardDir();
      const boardB = await makeBoardDir();
      try {
        const env = hermeticEnv();
        await register("api", boardA.dir, env);
        await register("web", boardB.dir, env);

        const found = await findRegisteredBoard("web", env);
        expect(found?.path).toBe(await realpath(boardB.dir));
        expect(await findRegisteredBoard("missing", env)).toBeUndefined();
      } finally {
        await boardA.cleanup();
        await boardB.cleanup();
      }
    });
  });

  test("a registered name whose directory vanished is a typed error, never silently 'not found'", async () => {
    await withEnv(undefined, async () => {
      const gone = await makeBoardDir();
      const env = hermeticEnv();
      await register("gone", gone.dir, env);
      await gone.cleanup();

      let thrown: unknown;
      let result: unknown;
      try {
        result = await findRegisteredBoard("gone", env);
      } catch (err) {
        thrown = err;
      }
      expect(result).toBeUndefined();
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("BOARD_DIRECTORY_MISSING");
      expect((thrown as Error).message).toContain("gone");
    });
  });
});

describe("registry -- canonicalization (register() always stores a canonical path)", () => {
  test("registering a symlinked path stores its realpath, not the symlink", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-registry-link-"));
      try {
        const linkPath = join(linkParent, "board-link");
        await symlink(board.dir, linkPath);

        const entry = await register("api", linkPath, hermeticEnv());
        expect(entry.path).toBe(await realpath(board.dir));

        const built = await buildBoardRef({ kind: "repo", name: "api", root: linkPath });
        expect(built.root).toBe(await realpath(board.dir));
      } finally {
        await board.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});

describe("registry -- F11: a hand-edited entry whose stored path is itself a symlink", () => {
  test("listRegisteredBoards returns the stored path verbatim -- canonicalization is register()'s job on write, not a read-time guarantee", async () => {
    await withEnv(undefined, async () => {
      const board = await makeBoardDir();
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-registry-link-"));
      try {
        const linkPath = join(linkParent, "board-link");
        await symlink(board.dir, linkPath);

        const registryPath = resolveRegistryPath(hermeticEnv());
        if (!registryPath) throw new Error("test setup: registry path did not resolve");
        await mkdir(join(registryPath, ".."), { recursive: true });
        await writeFile(
          registryPath,
          `version: 1\nrepos:\n  - name: api\n    path: ${linkPath}\n    last_seen: 2026-09-05T08:00:00.000Z\n`,
        );

        // `stat` (used by listRegisteredBoards to confirm the directory is
        // present) follows the symlink, so this entry is included -- but
        // its `.path` is exactly what was on disk, unresolved.
        const listing = await listRegisteredBoards(hermeticEnv());
        expect(listing.boards).toHaveLength(1);
        expect(listing.boards[0]?.path).toBe(linkPath);
        expect(listing.boards[0]?.path).not.toBe(await realpath(board.dir));

        // buildBoardRef is what actually canonicalizes it, downstream.
        const built = await buildBoardRef({ kind: "repo", name: "api", root: listing.boards[0]?.path ?? "" });
        expect(built.root).toBe(await realpath(board.dir));
      } finally {
        await board.cleanup();
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});

describe("registry -- F7: the personal board can never be registered as a repo board", () => {
  test("register() refuses the personal board's own directory", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });

      let thrown: unknown;
      try {
        await register("mine", personal.board.root, env);
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("CANNOT_REGISTER_PERSONAL_BOARD");
      // F5/F7 (fix round 2): `details`, not just `message`, must not
      // publish the personal board's path.
      expect(detailsAsString(thrown)).not.toContain(personal.board.root);

      const listing = await listRegisteredBoards(env);
      expect(listing.boards).toHaveLength(0);
    });
  });

  test("listRegisteredBoards skips a hand-edited entry pointing at the personal board", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });

      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(
        registryPath,
        `version: 1\nrepos:\n  - name: sneaky\n    path: ${personal.board.root}\n    last_seen: 2026-09-05T08:00:00.000Z\n`,
      );

      const listing = await listRegisteredBoards(env);
      expect(listing.boards).toHaveLength(0);
      expect(listing.skipped).toHaveLength(1);
      expect(listing.skipped[0]?.reason).toBe("is the personal board");
    });
  });

  // Fix round 1, F1 (security review): the two tests above only caught an
  // *exact* match against the personal board's root. `register()` itself
  // would happily register a *subdirectory* of it (its own tickets
  // directory, say), and `listRegisteredBoards` would list a hand-edited
  // entry naming one as an ordinary board -- both now fixed to compare by
  // containment (`isContained`, reused from `ref.ts`), not equality.
  //
  // Mutation-verified (see task-B-report.md, "Fix round 1"): reverting
  // either check back to `===` makes the corresponding test below fail;
  // restored before committing.
  test("F1: register() refuses a subdirectory of the personal board too, not only its exact root", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const subdir = join(personal.board.root, "backlog"); // exists: ensurePersonalBoard creates backlog/tasks

      let thrown: unknown;
      try {
        await register("leak", subdir, env);
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("CANNOT_REGISTER_PERSONAL_BOARD");
      expect(detailsAsString(thrown)).not.toContain(personal.board.root);
      expect(detailsAsString(thrown)).not.toContain(subdir);

      const listing = await listRegisteredBoards(env);
      expect(listing.boards).toHaveLength(0);
    });
  });

  test("F1: listRegisteredBoards skips a hand-edited entry naming a subdirectory of the personal board, not only its exact root", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });
      const subdir = join(personal.board.root, "backlog");

      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(
        registryPath,
        `version: 1\nrepos:\n  - name: leak\n    path: ${subdir}\n    last_seen: 2026-09-05T08:00:00.000Z\n`,
      );

      // The discriminating assertion: a caller that reads the registry
      // directly (never building a `BoardRef` at all -- a future `cankan
      // repo list`, say) must see this entry flagged right here. Nothing
      // downstream of `listRegisteredBoards` would otherwise catch it for
      // such a caller.
      const listing = await listRegisteredBoards(env);
      expect(listing.boards).toHaveLength(0);
      expect(listing.skipped).toHaveLength(1);
      expect(listing.skipped[0]?.reason).toBe("is the personal board");
    });
  });

  test("F5: findRegisteredBoard throws REGISTERED_BOARD_IS_PERSONAL (not BOARD_DIRECTORY_MISSING) for a skip reason of 'is the personal board', without publishing the path", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const personal = await ensurePersonalBoard({ env });

      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await mkdir(join(registryPath, ".."), { recursive: true });
      await writeFile(
        registryPath,
        `version: 1\nrepos:\n  - name: sneaky\n    path: ${personal.board.root}\n    last_seen: 2026-09-05T08:00:00.000Z\n`,
      );

      let thrown: unknown;
      try {
        await findRegisteredBoard("sneaky", env);
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
      expect((thrown as Error).message).not.toContain(personal.board.root);
      expect(detailsAsString(thrown)).not.toContain(personal.board.root);
    });
  });

  // Security review (G3): the check above only worked once the personal
  // board actually existed on disk (`resolveCanonicalPersonalPath`
  // returns `undefined` when `realpath` fails, and the "is the personal
  // board" skip is gated on it not being `undefined`). With the personal
  // board never created, a hand-edited entry naming its exact future path
  // used to fall through to the ordinary `stat`-based "directory no
  // longer exists" skip instead -- publishing the personal board's own
  // path as `BOARD_DIRECTORY_MISSING`, exactly the outcome the check
  // above exists to prevent. Fixed by giving `listRegisteredBoards` the
  // same three-tier canonicalization `resolve.ts`'s `canonicalPersonalPath`
  // uses (`resolveCanonicalOrExistingPersonalPath`).
  test("G3: a hand-edited entry naming the personal board's own (not-yet-created) path is still skipped as 'is the personal board'", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      // Deliberately no ensurePersonalBoard() call.
      const personalPath = resolvePersonalBoardPath(env);
      if (!personalPath) throw new Error("test setup: personal board path did not resolve");

      const registryPath = resolveRegistryPath(env);
      if (!registryPath) throw new Error("test setup: registry path did not resolve");
      await writeFileEnsuringDir(
        registryPath,
        `version: 1\nrepos:\n  - name: sneaky\n    path: ${personalPath}\n    last_seen: 2026-01-01T00:00:00.000Z\n`,
      );

      const listing = await listRegisteredBoards(env);
      expect(listing.boards).toHaveLength(0);
      expect(listing.skipped).toHaveLength(1);
      expect(listing.skipped[0]?.reason).toBe("is the personal board");

      let thrown: unknown;
      try {
        await findRegisteredBoard("sneaky", env);
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("REGISTERED_BOARD_IS_PERSONAL");
    });
  });
});

describe("registry -- F8: reserved-name matching folds case and rejects padding whitespace", () => {
  const disguisedReserved: Array<[string, string]> = [
    ["different case", "Personal"],
    ["all caps", "PERSONAL"],
    ["leading/trailing whitespace around a reserved name", "  personal  "],
  ];

  for (const [label, name] of disguisedReserved) {
    test(`isValidBoardName rejects "${name}" (${label})`, () => {
      expect(isValidBoardName(name)).toBe(false);
    });

    test(`register() refuses "${name}" (${label})`, async () => {
      await withEnv(undefined, async () => {
        const board = await makeBoardDir();
        try {
          let thrown: unknown;
          try {
            await register(name, board.dir, hermeticEnv());
          } catch (err) {
            thrown = err;
          }
          expect(isCanKanError(thrown)).toBe(true);
          expect((thrown as { code: string }).code).toBe("INVALID_BOARD_NAME");
        } finally {
          await board.cleanup();
        }
      });
    });
  }

  test("plain leading/trailing whitespace on an otherwise-fine name is rejected outright", () => {
    expect(isValidBoardName("  api")).toBe(false);
    expect(isValidBoardName("api  ")).toBe(false);
    expect(isValidBoardName(" api ")).toBe(false);
  });
});
