import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import { withEnv } from "../../../test-utils/src/withEnv";
import { ensurePersonalBoard, resolvePersonalBoardPath } from "../../src/board/personal";
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
