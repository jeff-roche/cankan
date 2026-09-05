import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { ensurePersonalBoard, resolvePersonalBoardPath } from "../../src/board/personal";
import { isCanKanError } from "../../src/errors";
import { hermeticEnv } from "../config/testHelpers";

describe("resolvePersonalBoardPath -- XDG resolution (mirrors config/layers.ts's XDG_CONFIG_HOME rule)", () => {
  test("uses XDG_DATA_HOME when it is set and absolute", () => {
    expect(resolvePersonalBoardPath({ XDG_DATA_HOME: "/x/data", HOME: "/x/home" })).toBe(
      "/x/data/cankan/personal",
    );
  });

  test("falls back to $HOME/.local/share when XDG_DATA_HOME is unset", () => {
    expect(resolvePersonalBoardPath({ HOME: "/x/home" })).toBe("/x/home/.local/share/cankan/personal");
  });

  test("falls back to $HOME/.local/share when XDG_DATA_HOME is empty", () => {
    expect(resolvePersonalBoardPath({ XDG_DATA_HOME: "", HOME: "/x/home" })).toBe(
      "/x/home/.local/share/cankan/personal",
    );
  });

  test("falls back to $HOME/.local/share when XDG_DATA_HOME is relative", () => {
    expect(resolvePersonalBoardPath({ XDG_DATA_HOME: "relative/data", HOME: "/x/home" })).toBe(
      "/x/home/.local/share/cankan/personal",
    );
  });

  test("returns undefined when neither HOME nor an absolute XDG_DATA_HOME is available", () => {
    expect(resolvePersonalBoardPath({})).toBeUndefined();
  });

  test("reads env at call time, not at module load: withEnv()'s post-import mutation is observed", async () => {
    await withEnv({ XDG_DATA_HOME: "/env-time/data" }, async () => {
      expect(resolvePersonalBoardPath()).toBe("/env-time/data/cankan/personal");
    });
  });
});

describe("ensurePersonalBoard -- lazy, idempotent creation", () => {
  test("creates the board on first call and reports created: true", async () => {
    await withEnv(undefined, async () => {
      const result = await ensurePersonalBoard({ env: hermeticEnv() });
      expect(result.created).toBe(true);
      expect(result.board.kind).toBe("personal");
      expect(result.board.name).toBe("personal");
      expect(result.board.root).toBe(await realpath(result.board.root));
    });
  });

  test("a second call is idempotent: same board, created: false", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const first = await ensurePersonalBoard({ env });
      const second = await ensurePersonalBoard({ env });
      expect(second.created).toBe(false);
      expect(second.board.root).toBe(first.board.root);
      expect(second.board.ticketsDir).toBe(first.board.ticketsDir);
    });
  });

  test("needsGitInit is true when <root>/.git is absent (this module never runs git init)", async () => {
    await withEnv(undefined, async () => {
      const result = await ensurePersonalBoard({ env: hermeticEnv() });
      expect(result.needsGitInit).toBe(true);
    });
  });

  test("effective config defaults apply with no starter .cankan/config.yml written", async () => {
    await withEnv(undefined, async () => {
      const result = await ensurePersonalBoard({ env: hermeticEnv() });
      expect(result.board.coordinationRef).toBe("refs/cankan/coordination");
      expect(result.board.ticketsDir).toBe(await realpath(join(result.board.root, "backlog", "tasks")));
    });
  });

  test("two concurrent ensurePersonalBoard() calls converge on one board, exactly one reporting created: true", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const [a, b] = await Promise.all([ensurePersonalBoard({ env }), ensurePersonalBoard({ env })]);
      expect(a.board.root).toBe(b.board.root);
      expect(a.board.ticketsDir).toBe(b.board.ticketsDir);
      const createdFlags = [a.created, b.created].sort();
      expect(createdFlags).toEqual([false, true]);
    });
  });

  test("F6: the board root is created 0700, not the platform mkdir default", async () => {
    await withEnv(undefined, async () => {
      const result = await ensurePersonalBoard({ env: hermeticEnv() });
      const stats = await stat(result.board.root);
      expect(stats.mode & 0o777).toBe(0o700);
    });
  });

  test("F10: <root>/.cankan/ is created as part of the skeleton", async () => {
    await withEnv(undefined, async () => {
      const result = await ensurePersonalBoard({ env: hermeticEnv() });
      const stats = await stat(join(result.board.root, ".cankan"));
      expect(stats.isDirectory()).toBe(true);
    });
  });

  test("ticketsDir actually exists on disk after ensurePersonalBoard (this function creates it; buildBoardRef itself no longer does)", async () => {
    await withEnv(undefined, async () => {
      const result = await ensurePersonalBoard({ env: hermeticEnv() });
      const stats = await stat(result.board.ticketsDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  // Dispatch B, fix round 3, F12 (security review): a raw platform error
  // creating the board root (EACCES on its parent, most commonly) used to
  // escape untyped -- invisible to isCanKanError/M3.10's exit-code map,
  // the same class of gap this module has now closed three other times
  // (TICKETS_DIR_INVALID, the internal lock-loss exception, CWD_UNRESOLVABLE).
  // Reproduced with a real, empirically-produced EACCES (chmod the parent
  // read-only) rather than asserted from reasoning alone.
  test("F12: a real EACCES creating the board root is wrapped as a typed PERSONAL_BOARD_UNAVAILABLE, never left raw", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const rawPath = resolvePersonalBoardPath(env);
      if (!rawPath) throw new Error("test setup: personal board path did not resolve");
      const parent = dirname(rawPath);
      await mkdir(parent, { recursive: true });
      await chmod(parent, 0o555); // read + execute, no write: mkdir(rawPath) inside it fails EACCES
      try {
        let thrown: unknown;
        try {
          await ensurePersonalBoard({ env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("PERSONAL_BOARD_UNAVAILABLE");
      } finally {
        // Restore write permission before withEnv()'s own cleanup removes
        // the temp home tree.
        await chmod(parent, 0o700);
      }
    });
  });

  // Security review (G1): the F12 fix above wrapped exactly the one `mkdir`
  // the finding cited. An audit of this file found three sibling bare
  // filesystem calls that could surface the identical class of raw,
  // untyped error on the ordinary public API -- no hostile input required.
  // Each test below reproduces a real, distinct underlying platform error
  // at a different one of those calls.

  test("G1: an unwritable $XDG_DATA_HOME is a typed error, not a raw EACCES, at the very first mkdir", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const dataHome = env.XDG_DATA_HOME;
      if (!dataHome) throw new Error("test setup: XDG_DATA_HOME not set by hermeticEnv()");
      await mkdir(dataHome, { recursive: true });
      await chmod(dataHome, 0o000);
      try {
        let thrown: unknown;
        try {
          await ensurePersonalBoard({ env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("PERSONAL_BOARD_UNAVAILABLE");
      } finally {
        await chmod(dataHome, 0o700);
      }
    });
  });

  test("G1: a dangling symlink where the personal board should be is a typed error, not a raw ENOENT", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const rawPath = resolvePersonalBoardPath(env);
      if (!rawPath) throw new Error("test setup: personal board path did not resolve");
      await mkdir(dirname(rawPath), { recursive: true });
      // mkdir(rawPath) sees an existing entry (the symlink itself) and
      // reports EEXIST regardless of what it points to; the very next
      // mkdir (`.cankan/` inside it) is what actually tries to traverse
      // the broken link and fails ENOENT.
      await symlink(join(dirname(rawPath), "nonexistent-target"), rawPath);

      let thrown: unknown;
      try {
        await ensurePersonalBoard({ env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("PERSONAL_BOARD_UNAVAILABLE");
    });
  });

  test("G1: a personal root pre-existing with mode 000 is a typed error, not a raw EACCES", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const rawPath = resolvePersonalBoardPath(env);
      if (!rawPath) throw new Error("test setup: personal board path did not resolve");
      await mkdir(dirname(rawPath), { recursive: true });
      await mkdir(rawPath, { mode: 0o000 });
      try {
        let thrown: unknown;
        try {
          await ensurePersonalBoard({ env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("PERSONAL_BOARD_UNAVAILABLE");
      } finally {
        await chmod(rawPath, 0o700);
      }
    });
  });

  test("G1: the personal board path already existing as a regular file is a typed error, not a raw ENOTDIR", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const rawPath = resolvePersonalBoardPath(env);
      if (!rawPath) throw new Error("test setup: personal board path did not resolve");
      await mkdir(dirname(rawPath), { recursive: true });
      await writeFile(rawPath, "not a directory");

      let thrown: unknown;
      try {
        await ensurePersonalBoard({ env });
      } catch (err) {
        thrown = err;
      }
      expect(isCanKanError(thrown)).toBe(true);
      expect((thrown as { code: string }).code).toBe("PERSONAL_BOARD_UNAVAILABLE");
    });
  });

  test("G1: re-creating a deleted ticketsDir through an unwritable intermediate directory is a typed error, not a raw EACCES", async () => {
    await withEnv(undefined, async () => {
      const env = hermeticEnv();
      const first = await ensurePersonalBoard({ env });
      // Remove only "tasks", leaving "backlog" (ticketsDir's own parent)
      // in place so this isolates the ticketsDir mkdir specifically --
      // root and .cankan/ stay untouched and fully accessible. Mode
      // `0o500` (read + execute, no write), not `0o000`: `lstat` only
      // needs execute/search permission to traverse into `backlog` and
      // determine "tasks" doesn't exist, which `buildBoardRef`'s own
      // probe call (inside ensurePersonalBoard, before this test's own
      // `mkdir` wrap ever runs) does successfully either way -- `0o000`
      // blocks that traversal too and surfaces `ref.ts`'s own (already
      // typed) `TICKETS_DIR_INVALID` instead, which doesn't discriminate
      // this specific wrap. `mkdir` itself additionally needs *write* on
      // the immediate parent, which `0o500` still denies -- that is what
      // this test isolates.
      await rm(first.board.ticketsDir, { recursive: true, force: true });
      const backlogDir = dirname(first.board.ticketsDir);
      await chmod(backlogDir, 0o500);
      try {
        let thrown: unknown;
        try {
          await ensurePersonalBoard({ env });
        } catch (err) {
          thrown = err;
        }
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe("PERSONAL_BOARD_UNAVAILABLE");
      } finally {
        await chmod(backlogDir, 0o700);
      }
    });
  });
});

describe("ensurePersonalBoard -- canonicalization ruling (mandatory macOS-shaped test)", () => {
  test("board.root is the realpath of a symlinked XDG_DATA_HOME, not the symlink itself", async () => {
    await withEnv(undefined, async () => {
      // `withEnv()`'s own temp data directory is the "temp data directory"
      // the brief asks for; a symlink to it is created at a sibling path
      // and XDG_DATA_HOME is pointed at the symlink, not the real thing.
      const realDataHome = process.env.XDG_DATA_HOME;
      if (!realDataHome) throw new Error("test setup: withEnv() did not set XDG_DATA_HOME");
      // `withEnv()` only creates `HOME` itself, not the XDG subdirectories
      // it computes from it -- create the real target before symlinking to it.
      await mkdir(realDataHome, { recursive: true });
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-personal-link-"));
      try {
        const symlinkedDataHome = join(linkParent, "data-link");
        await symlink(realDataHome, symlinkedDataHome);

        const env = { ...hermeticEnv(), XDG_DATA_HOME: symlinkedDataHome };
        const result = await ensurePersonalBoard({ env });

        expect(result.board.root).toBe(join(await realpath(symlinkedDataHome), "cankan", "personal"));
        expect(result.board.root.startsWith(symlinkedDataHome)).toBe(false);

        // Containment by path-component semantics (ADR 0002, 542-630), not
        // a string-prefix check: `path.relative` must be neither absolute
        // nor begin with a ".." segment.
        const rel = relative(result.board.root, result.board.ticketsDir);
        expect(isAbsolute(rel)).toBe(false);
        expect(rel.split(sep)[0]).not.toBe("..");
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});
