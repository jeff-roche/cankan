import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
import { BoardErrorCodes, resolveBoard } from "../../src/board/index";
import { buildBoardRef } from "../../src/board/ref";
import { ErrorCodes, isCanKanError } from "../../src/errors";
import { createGitAdapter } from "../../src/git/index";
import { StoreErrorCodes } from "../../src/store/errors";
import {
  assertSafeTicketPath,
  buildTempTicketFilename,
  openTicketStore,
  type StoredTicket,
  type TicketStore,
} from "../../src/store/ticketStore";
import { TicketErrorCodes, parseTicketFile, parseTicketFilename, setCankanBlock, type ParsedTicket } from "../../src/ticket/index";
import type { BoardRef } from "../../src/types";
import { hermeticEnv, writeRepoConfigFile } from "../config/testHelpers";

/**
 * Runs a raw `git` command for building a fixture `bun`'s own git plumbing
 * doesn't cover -- `git init --separate-git-dir`, specifically (R2's repro
 * below). Mirrors `test-utils/src/tempRepo.ts`'s own local `git()` helper
 * rather than importing it, since that one is deliberately not exported
 * (its caller always wants the higher-level `makeTempRepo` instead).
 */
function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr.toString()}`);
  }
}

// ---- test helpers ---------------------------------------------------------

/** Raw `<id> - <slug>.md`-shaped file content for a minimal ticket, optionally with a `cankan:` block spliced in verbatim. */
function rawTicket(id: string, title: string, options: { status?: string; cankan?: string } = {}): string {
  const status = options.status ?? "To Do";
  const cankan = options.cankan ? `${options.cankan}\n` : "";
  return `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n${cankan}---\n\nBody for ${title}.\n`;
}

function newTicket(id: string, title: string, options: { status?: string; cankan?: string } = {}): ParsedTicket {
  return parseTicketFile(rawTicket(id, title, options));
}

/**
 * A repo board whose tickets directory has already been created — `write`/
 * `archive` never create it themselves (Ruling R4), so every test that
 * exercises them has to. Wrapped in `withEnv` because `buildBoardRef` reads
 * config through `loadConfig`, which reads XDG paths even when this test
 * never sets any (Mandatory hygiene: never touch the real `~/.config`).
 */
async function withTestBoard(fn: (ctx: { board: BoardRef; repo: TempRepo }) => Promise<void>): Promise<void> {
  await withEnv(undefined, async () => {
    const repo = await makeTempRepo();
    try {
      const board = await buildBoardRef({ kind: "repo", name: "test-board", root: repo.dir });
      await mkdir(board.ticketsDir, { recursive: true });
      await fn({ board, repo });
    } finally {
      await repo.cleanup();
    }
  });
}

/** Same as `withTestBoard`, but deliberately does not create `ticketsDir` — for R4's missing-directory coverage. */
async function withUninitializedBoard(fn: (board: BoardRef) => Promise<void>): Promise<void> {
  await withEnv(undefined, async () => {
    const repo = await makeTempRepo();
    try {
      const board = await buildBoardRef({ kind: "repo", name: "test-board", root: repo.dir });
      await fn(board);
    } finally {
      await repo.cleanup();
    }
  });
}

/** Asserts `fn()` rejects with a `CanKanError` carrying exactly `code` — never asserts on `.message` (a message is not API). */
async function expectRejectsWithCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!isCanKanError(err)) throw err;
    expect(err.code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but the call resolved`);
}

async function openStore(board: BoardRef): Promise<TicketStore> {
  return openTicketStore({ board, gitDirs: [] });
}

/** Asserts nothing exists at `path` -- `stat` must fail with `ENOENT`, not merely "the call threw." */
async function assertDoesNotExist(path: string): Promise<void> {
  let threw = false;
  try {
    await stat(path);
  } catch (err) {
    threw = true;
    expect((err as { code?: unknown }).code).toBe("ENOENT");
  }
  expect(threw).toBe(true);
}

// ---- CRUD round trip -------------------------------------------------------

describe("ticketStore — CRUD round trip", () => {
  test("write -> get -> list -> archive -> remove", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const ticket = newTicket("ck-roundtrip1", "Round trip ticket");

      const written = await store.write(ticket);
      expect(written.id as string).toBe(ticket.frontmatter.id as string);

      const found = await store.get("ck-roundtrip1");
      expect(found?.path).toBe(written.path);

      const listed = await store.list();
      expect(listed.tickets.map((t) => t.id)).toContain(written.id);
      expect(listed.skipped).toEqual([]);

      const archived = await store.archive("ck-roundtrip1");
      expect(archived.path).toBe(join(board.ticketsDir, "archive", "ck-roundtrip1 - Round-trip-ticket.md"));
      // Archived tickets leave the top-level listing.
      const afterArchive = await store.list();
      expect(afterArchive.tickets.map((t) => t.id)).not.toContain(written.id);

      // `remove` resolves the same way `get` does -- but the ticket is now
      // in `archive/`, outside the top-level directory `get` scans, so it
      // is correctly reported as gone.
      await expectRejectsWithCode(() => store.remove("ck-roundtrip1"), StoreErrorCodes.TICKET_NOT_FOUND);

      // A fresh ticket, removed directly (no archive step), actually deletes the file.
      await store.write(newTicket("ck-roundtrip2", "Second ticket"));
      await store.remove("ck-roundtrip2");
      expect(await store.get("ck-roundtrip2")).toBeUndefined();
    });
  });
});

// ---- case-insensitive lookup and casing preservation -----------------------

describe("ticketStore — id casing", () => {
  test("lookup is case-insensitive, and on-disk casing is preserved across a write (byte-for-byte)", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const ticket = newTicket("CK-MixCase1", "Mixed Case Ticket");
      const written = await store.write(ticket);

      // Exact-case and lowercased lookups both find the same ticket.
      const byExact = await store.get("CK-MixCase1");
      const byLower = await store.get("ck-mixcase1");
      expect(byExact?.path).toBe(written.path);
      expect(byLower?.path).toBe(written.path);

      // The on-disk casing is exactly what was written -- never lowercased.
      expect(written.id as string).toBe("CK-MixCase1");
      expect(written.path.endsWith("CK-MixCase1 - Mixed-Case-Ticket.md")).toBe(true);

      const onDisk = await readFile(written.path, "utf8");
      expect(onDisk).toBe(rawTicket("CK-MixCase1", "Mixed Case Ticket"));
      expect(onDisk).toContain("id: CK-MixCase1");
    });
  });
});

// ---- display id / alias resolution -----------------------------------------

describe("ticketStore — display id and alias resolution", () => {
  test("get() resolves a ticket by its cankan.display_id and by a cankan.aliases entry", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const ticket = newTicket("ck-withalias1", "Has an alias", {
        cankan: "cankan:\n  display_id: DISP-9\n  aliases:\n    - OLD-1\n    - OLD-2",
      });
      await store.write(ticket);

      const byId = await store.get("ck-withalias1");
      const byDisplay = await store.get("DISP-9");
      const byAlias = await store.get("old-1");

      expect(byId?.id as string).toBe("ck-withalias1");
      expect(byDisplay?.id as string).toBe("ck-withalias1");
      expect(byAlias?.id as string).toBe("ck-withalias1");
    });
  });

  test("get() throws a typed ambiguous-lookup error when two tickets share the same alias", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      await store.write(newTicket("ck-shareda", "Ticket A", { cankan: "cankan:\n  aliases:\n    - SHARED-1" }));
      await store.write(newTicket("ck-sharedb", "Ticket B", { cankan: "cankan:\n  aliases:\n    - SHARED-1" }));

      await expectRejectsWithCode(() => store.get("SHARED-1"), StoreErrorCodes.AMBIGUOUS_TICKET_LOOKUP);
    });
  });

  test("once the disposable cankan: block is destroyed, a display-id/alias lookup is a miss, not an error -- the primary id still resolves", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const ticket = newTicket("ck-destroyed1", "Will lose its block", {
        cankan: "cankan:\n  display_id: DISP-DEAD",
      });
      await store.write(ticket);
      expect((await store.get("DISP-DEAD"))?.id as string).toBe("ck-destroyed1");

      // Simulate Backlog.md destroying the `cankan:` block on a foreign edit.
      const current = await store.get("ck-destroyed1");
      if (current === undefined) throw new Error("setup failure: ticket vanished");
      const withoutBlock = setCankanBlock(current.ticket, undefined);
      await store.write(withoutBlock);

      expect(await store.get("DISP-DEAD")).toBeUndefined();
      expect((await store.get("ck-destroyed1"))?.id as string).toBe("ck-destroyed1");
    });
  });
});

// ---- concurrent writes ------------------------------------------------------

describe("ticketStore — concurrent writes", () => {
  test("concurrent writes to different tickets do not corrupt each other", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const ids = Array.from({ length: 25 }, (_, i) => `ck-concurrent${String(i).padStart(3, "0")}`);

      await Promise.all(ids.map((id) => store.write(newTicket(id, `Concurrent ${id}`))));

      const results = await Promise.all(ids.map((id) => store.get(id)));
      expect(results.every((r): r is StoredTicket => r !== undefined)).toBe(true);
      for (const [i, id] of ids.entries()) {
        const found = results[i];
        expect(found?.id as string).toBe(id);
        expect(found?.ticket.frontmatter.title).toBe(`Concurrent ${id}`);
        const onDisk = await readFile(found?.path ?? "", "utf8");
        expect(onDisk).toContain(`title: Concurrent ${id}`);
      }

      // No temp file leaked behind on the success path: exactly one
      // directory entry per ticket, nothing else.
      const entries = await readdir(board.ticketsDir);
      expect(entries).toHaveLength(ids.length);
    });
  });
});

// ---- temp files never surface as tickets -----------------------------------

describe("ticketStore — atomic-write temp files", () => {
  test("a generated temp filename is genuinely rejected by parseTicketFilename", () => {
    const tempName = buildTempTicketFilename();
    expect(parseTicketFilename(tempName)).toBeNull();
  });

  test("a stale temp file left in the tickets dir is invisible to list()", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      await store.write(newTicket("ck-realone1", "A real ticket"));

      const staleTempPath = join(board.ticketsDir, buildTempTicketFilename());
      await writeFile(staleTempPath, "not a ticket, just a leftover temp file", "utf8");

      const { tickets, skipped } = await store.list();
      expect(tickets.map((t) => t.id as string)).toEqual(["ck-realone1"]);
      expect(skipped).toEqual([]);
    });
  });

  test("a failed rename during write() is wrapped as STORE_TICKET_IO_FAILED and leaves no temp file behind", async () => {
    await withTestBoard(async ({ board }) => {
      const title = "Directory In The Way";
      const ticket = newTicket("ck-dirblock1", title);
      // `buildTicketFilename` is deterministic from id + title -- pre-occupy
      // that exact name with a *directory* so `write()`'s create-path
      // `rename(tempFile, targetPath)` fails with EISDIR (confirmed by
      // direct execution before relying on it here) rather than succeeding.
      const targetName = "ck-dirblock1 - Directory-In-The-Way.md";
      await mkdir(join(board.ticketsDir, targetName));

      const store = await openStore(board);
      await expectRejectsWithCode(() => store.write(ticket), StoreErrorCodes.TICKET_IO_FAILED);

      const entries = await readdir(board.ticketsDir);
      expect(entries.some((name) => name.startsWith(".cankan-tmp."))).toBe(false);
    });
  });
});

// ---- symlinks are never followed -------------------------------------------

describe("ticketStore — symlinks in the tickets directory", () => {
  test("a symlink named like a valid ticket is not followed by list()", async () => {
    await withTestBoard(async ({ board, repo }) => {
      const store = await openStore(board);
      await store.write(newTicket("ck-realtwo1", "Another real ticket"));

      // A file *outside* the tickets directory that a naive implementation
      // would happily parse as frontmatter if it followed the symlink.
      const secretPath = join(repo.root, "secret.md");
      await writeFile(secretPath, "---\nid: ck-secret1\ntitle: Should never be read\nstatus: To Do\n---\n\nleaked\n", "utf8");
      const linkPath = join(board.ticketsDir, "ck-linked01 - looks-like-a-ticket.md");
      await symlink(secretPath, linkPath);

      const { tickets, skipped } = await store.list();
      expect(tickets.map((t) => t.id as string)).toEqual(["ck-realtwo1"]);
      expect(tickets.find((t) => t.path === linkPath)).toBeUndefined();
      expect(skipped.find((s) => s.path === linkPath)).toBeUndefined();

      const getResult = await store.get("ck-secret1");
      expect(getResult).toBeUndefined();
    });
  });

  test("a checked-in `archive` symlink to an outside directory cannot be used to move a ticket out of the repo (fix round 1, Critical)", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const written = await store.write(newTicket("ck-1", "Real"));

      const victimDir = await mkdtemp(join(tmpdir(), "cankan-store-victim-"));
      try {
        // The attack: `archive` is not a real directory, it is a symlink
        // pointing entirely outside `ticketsDir` -- exactly what a hostile
        // checked-in `git symlink` (mode 120000) would look like once
        // checked out.
        const archiveLink = join(board.ticketsDir, "archive");
        await symlink(victimDir, archiveLink);

        await expectRejectsWithCode(() => store.archive("ck-1"), StoreErrorCodes.UNSAFE_TICKET_PATH);

        // The ticket never moved.
        const stillThere = await store.get("ck-1");
        expect(stillThere?.path).toBe(written.path);
        const onDisk = await readFile(written.path, "utf8");
        expect(onDisk.length).toBeGreaterThan(0);

        // Nothing landed in the victim directory outside the repo.
        const victimEntries = await readdir(victimDir);
        expect(victimEntries).toEqual([]);
      } finally {
        await rm(victimDir, { recursive: true, force: true });
      }
    });
  });
});

// ---- step (d) defence in depth ----------------------------------------------

describe("ticketStore — step (d) defence in depth", () => {
  test("write() with a hostile id (/, \\, ., or ..) is rejected before any file is created (ticket/filename.ts's own choke point fires first)", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      for (const hostileId of ["evil/slash", "evil\\backslash", ".", ".."]) {
        const before = await readdir(board.ticketsDir);
        await expectRejectsWithCode(
          () => store.write(newTicket(hostileId, "Hostile id")),
          TicketErrorCodes.UNSAFE_FILENAME,
        );
        const after = await readdir(board.ticketsDir);
        expect(after).toEqual(before);
      }
    });
  });

  test("assertSafeTicketPath rejects a path separator, a backslash, a single dot, a double dot, the empty string, a NUL byte, and .git (case-insensitively) -- and nothing is written", () => {
    const dir = "/tmp/does-not-matter-for-this-assertion";
    const hostileNames = ["sub/dir.md", "sub\\dir.md", ".", "..", "", "ck-1\0.md", ".git", ".GIT"];
    for (const hostile of hostileNames) {
      let threw = false;
      try {
        assertSafeTicketPath(dir, hostile);
      } catch (err) {
        threw = true;
        expect(isCanKanError(err) && err.code).toBe(StoreErrorCodes.UNSAFE_TICKET_PATH);
      }
      expect(threw).toBe(true);
    }

    // "GIT" alone (no leading dot) is not the git-metadata name and is a
    // perfectly safe basename -- confirms the ".git" branch above is
    // matching the intended shape, not accidentally rejecting everything.
    expect(assertSafeTicketPath(dir, "GIT")).toBe(join(dir, "GIT"));
  });
});

// ---- write() trusts only ticket.source.raw, never a caller's frontmatter --

describe("ticketStore — write() re-derives from ticket.source.raw, never trusts ticket.frontmatter directly", () => {
  test("a hand-built ParsedTicket whose frontmatter disagrees with its own source.raw is written according to source.raw, not the fabricated frontmatter", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      const raw = rawTicket("ck-real0001", "Real Title");
      // `ticket/frontmatter.ts`'s own `serializeTicketFile` returns
      // `source.raw` completely unvalidated (confirmed by reading the
      // source directly) -- so `write()` cannot rely on it to reject this
      // kind of hand-built object. Instead `write()` re-parses
      // `source.raw` itself and never trusts this fabricated `frontmatter`
      // for anything.
      const handBuilt = {
        frontmatter: { id: "ck-fake0001", title: "Fake Title", status: "To Do" },
        source: { raw },
      } as ParsedTicket;

      const written = await store.write(handBuilt);

      expect(written.id as string).toBe("ck-real0001");
      expect(await store.get("ck-fake0001")).toBeUndefined();
      const onDisk = await readFile(written.path, "utf8");
      expect(onDisk).toBe(raw);
    });
  });

  test("write() rejects a ticket whose source.raw does not actually parse, before any I/O", async () => {
    await withTestBoard(async ({ board }) => {
      const before = await readdir(board.ticketsDir);
      const store = await openStore(board);
      const handBuilt = {
        frontmatter: { id: "ck-broken01", title: "Broken", status: "To Do" },
        source: { raw: "not frontmatter at all" },
      } as ParsedTicket;

      await expectRejectsWithCode(() => store.write(handBuilt), TicketErrorCodes.FRONTMATTER_MALFORMED);
      const after = await readdir(board.ticketsDir);
      expect(after).toEqual(before);
    });
  });
});

// ---- malformed frontmatter is reported, not silently dropped ---------------

describe("ticketStore — malformed frontmatter", () => {
  test("a malformed-frontmatter file does not break list(), and is reported as skipped with a reason", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openStore(board);
      await store.write(newTicket("ck-goodone1", "A well-formed ticket"));

      // Missing the required `id` field -- fails schema validation.
      const badPath = join(board.ticketsDir, "ck-badone01 - broken.md");
      await writeFile(badPath, "---\ntitle: Missing its id\nstatus: To Do\n---\n\nbroken\n", "utf8");

      const { tickets, skipped } = await store.list();
      expect(tickets.map((t) => t.id as string)).toEqual(["ck-goodone1"]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.path).toBe(badPath);
      expect(skipped[0]?.reason.length).toBeGreaterThan(0);
    });
  });
});

// ---- missing tickets directory (Ruling R4) ---------------------------------

describe("ticketStore — missing tickets directory (Ruling R4)", () => {
  test("list(), get(), write(), remove() and archive() all raise STORE_TICKETS_DIR_MISSING, and none of them create the directory", async () => {
    await withUninitializedBoard(async (board) => {
      const store = await openStore(board);

      await expectRejectsWithCode(() => store.list(), StoreErrorCodes.TICKETS_DIR_MISSING);
      await expectRejectsWithCode(() => store.get("ck-anything1"), StoreErrorCodes.TICKETS_DIR_MISSING);
      await expectRejectsWithCode(
        () => store.write(newTicket("ck-anything1", "Anything")),
        StoreErrorCodes.TICKETS_DIR_MISSING,
      );
      await expectRejectsWithCode(() => store.remove("ck-anything1"), StoreErrorCodes.TICKETS_DIR_MISSING);
      await expectRejectsWithCode(() => store.archive("ck-anything1"), StoreErrorCodes.TICKETS_DIR_MISSING);

      let exists = true;
      try {
        await readdir(board.ticketsDir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });
});

// ---- an unusable (not merely missing) tickets directory --------------------

describe("ticketStore — an unusable tickets directory", () => {
  test("a tickets directory that fails to stat for a reason other than ENOENT raises STORE_TICKETS_DIR_UNAVAILABLE", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cankan-store-unavailable-"));
    try {
      // A self-referential symlink: `stat` on it always fails with ELOOP,
      // never ENOENT -- confirmed by direct execution before relying on it
      // here (see the task report).
      const loopPath = join(scratch, "self-loop");
      await symlink(loopPath, loopPath);
      const board: BoardRef = {
        kind: "repo",
        name: "loop-board",
        root: scratch,
        ticketsDir: loopPath,
        coordinationRef: "refs/cankan/coordination",
      };
      const store = await openStore(board);
      await expectRejectsWithCode(() => store.list(), StoreErrorCodes.TICKETS_DIR_UNAVAILABLE);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

// ---- write() ambiguity on a pre-existing duplicate on-disk id --------------

describe("ticketStore — write() refuses to guess between duplicate on-disk ids", () => {
  test("two on-disk filenames whose ids collide under normalizeTicketIdForComparison make write() raise, not silently pick one", async () => {
    await withTestBoard(async ({ board }) => {
      await writeFile(join(board.ticketsDir, "ck-dupe0001 - a.md"), rawTicket("ck-dupe0001", "First"), "utf8");
      await writeFile(join(board.ticketsDir, "CK-DUPE0001 - b.md"), rawTicket("CK-DUPE0001", "Second"), "utf8");

      const store = await openStore(board);
      await expectRejectsWithCode(
        () => store.write(newTicket("ck-dupe0001", "Updated")),
        StoreErrorCodes.AMBIGUOUS_TICKET_LOOKUP,
      );
    });
  });
});

// ---- openTicketStore's required gitDirs (Ruling R3) ------------------------

describe("openTicketStore — gitDirs is required, with an explicit empty-array escape", () => {
  test("an empty array is accepted (asserting there is no git directory)", async () => {
    await withTestBoard(async ({ board }) => {
      const store = await openTicketStore({ board, gitDirs: [] });
      expect(await store.list()).toEqual({ tickets: [], skipped: [] });
    });
  });

  test("gitDirs built from a real GitAdapter's gitCommonDir() is accepted, and the store still works end to end", async () => {
    await withTestBoard(async ({ board }) => {
      const adapter = await createGitAdapter(board.root);
      const gitDirs = [await adapter.gitCommonDir()];
      expect(gitDirs[0]?.endsWith(".git")).toBe(true);

      const store = await openTicketStore({ board, gitDirs });
      await store.write(newTicket("ck-withgit1", "Written with real gitDirs"));
      expect((await store.get("ck-withgit1"))?.id as string).toBe("ck-withgit1");
    });
  });

  test("a caller that omits gitDirs entirely (a JS caller bypassing the type system) is rejected with USAGE, not a silent default", async () => {
    await withTestBoard(async ({ board }) => {
      await expectRejectsWithCode(
        () => openTicketStore({ board, gitDirs: undefined as unknown as readonly string[] }),
        ErrorCodes.USAGE,
      );
    });
  });

  test("a relative or empty-string gitDirs entry is rejected with USAGE (fix round 1, Minor 2) -- 1B's containment check must never silently no-op on a malformed entry", async () => {
    await withTestBoard(async ({ board }) => {
      await expectRejectsWithCode(
        () => openTicketStore({ board, gitDirs: ["relative/path/.git"] }),
        ErrorCodes.USAGE,
      );
      await expectRejectsWithCode(() => openTicketStore({ board, gitDirs: [""] }), ErrorCodes.USAGE);
    });
  });

  test("a non-string gitDirs entry (e.g. a number) is rejected with USAGE -- the runtime guard's own stated justification (1B, work item 3d)", async () => {
    await withTestBoard(async ({ board }) => {
      await expectRejectsWithCode(
        () => openTicketStore({ board, gitDirs: [42] as unknown as readonly string[] }),
        ErrorCodes.USAGE,
      );
    });
  });

  test("an absolute but non-canonical gitDirs entry is rejected with USAGE (1B, work item 2b.1) -- a security check that silently no-ops on macOS is the exact defect this tightening exists to prevent", async () => {
    await withTestBoard(async ({ board }) => {
      // A directory reached through a symlinked parent -- absolute, but not
      // what `fs.realpath` returns for it, modeling the macOS
      // `/var/folders/...` -> `/private/var/folders/...` case without
      // depending on the host actually being macOS.
      const real = await mkdtemp(join(tmpdir(), "cankan-store-gitdirs-real-"));
      const linkParent = await mkdtemp(join(tmpdir(), "cankan-store-gitdirs-link-"));
      try {
        const linkPath = join(linkParent, "git-dir-link");
        await symlink(real, linkPath);
        await expectRejectsWithCode(
          () => openTicketStore({ board, gitDirs: [linkPath] }),
          ErrorCodes.USAGE,
        );
      } finally {
        await rm(real, { recursive: true, force: true });
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });
});

// ---- ADR 0002 step (b) write-time re-check, and step (c) git-directory exclusion (1B, Ruling R9) ----
//
// Every test below hands `openTicketStore()` a hand-built, hostile
// `BoardRef` literal -- bypassing `buildBoardRef`/`resolveBoard`
// deliberately, per the task brief's "READ THIS BEFORE YOU WRITE A SINGLE
// TEST": `buildBoardRef` is the thing that realpaths `root`/`ticketsDir`,
// and a hand-built literal skips that. Every temp directory built into one
// of these literals is realpath'd first -- `mkdtemp(tmpdir())` is
// non-canonical on macOS (`/var` -> `/private/var`), and comparing a
// non-canonical hand-built value against this module's own (correctly
// canonical) internal `realpath` calls would pass on Linux and fail only
// on the macOS CI leg.
describe("ticketStore — ADR 0002 step (b) write-time re-check and step (c) git-directory exclusion (hand-built BoardRef, R9)", () => {
  test("a ticketsDir resolving outside root is refused, and nothing is created", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      const outside = await realpath(await mkdtemp(join(tmpdir(), "cankan-store-outside-")));
      try {
        const board: BoardRef = {
          kind: "repo",
          name: "hostile",
          root: repo.dir,
          ticketsDir: outside,
          coordinationRef: "refs/cankan/coordination",
        };
        const store = await openTicketStore({ board, gitDirs: [] });
        const targetPath = join(outside, "ck-escape1 - Escape.md");

        await expectRejectsWithCode(
          () => store.write(newTicket("ck-escape1", "Escape")),
          StoreErrorCodes.TICKETS_DIR_UNSAFE,
        );

        await assertDoesNotExist(targetPath);
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
        await repo.cleanup();
      }
    });
  });

  test("a ticketsDir inside <root>/.git is refused by the store's own gitDirs check, and nothing is created", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        // Pre-created, the way the exploit's own repro step pre-creates
        // its target -- write()/remove()/archive() never create
        // `ticketsDir` themselves (Ruling R4), so for this test to reach
        // 1B's guard rather than `TICKETS_DIR_MISSING`, the hostile
        // directory has to already exist.
        const hostileTicketsDir = join(repo.dir, ".git", "ticket-evil");
        await mkdir(hostileTicketsDir, { recursive: true });

        const adapter = await createGitAdapter(repo.dir);
        const gitDirs = [await adapter.gitCommonDir()];

        const board: BoardRef = {
          kind: "repo",
          name: "hostile",
          root: repo.dir,
          ticketsDir: hostileTicketsDir,
          coordinationRef: "refs/cankan/coordination",
        };
        const store = await openTicketStore({ board, gitDirs });
        const targetPath = join(hostileTicketsDir, "ck-escape2 - Escape.md");

        await expectRejectsWithCode(
          () => store.write(newTicket("ck-escape2", "Escape")),
          StoreErrorCodes.TICKETS_DIR_UNSAFE,
        );

        await assertDoesNotExist(targetPath);
        expect(await readdir(hostileTicketsDir)).toEqual([]);
      } finally {
        await repo.cleanup();
      }
    });
  });

  test("a ticketsDir inside the real git directory under a non-.git name is refused -- the git init --separate-git-dir repro (R2), the reason this slice exists", async () => {
    await withEnv(undefined, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "cankan-store-sepgit-")));
      try {
        // Built by actually running git, not assumed -- confirmed directly
        // (git 2.55.0, --path-format=absolute) before relying on it here:
        // a `--separate-git-dir` repo's `.git` is a *file* pointing at
        // `innergit`, whose first path segment under `root` is "innergit",
        // not ".git" -- board/ref.ts's by-name check cannot see this at
        // all, and its own file header (ref.ts:110-119) concluded (wrongly)
        // that this had "no known unblocked exploit."
        runGit(root, ["init", "--separate-git-dir=./innergit", "."]);
        runGit(root, ["config", "user.name", "CanKan Test"]);
        runGit(root, ["config", "user.email", "test@cankan.invalid"]);
        runGit(root, ["commit", "--allow-empty", "-m", "initial commit"]);

        const adapter = await createGitAdapter(root);
        const gitCommonDir = await adapter.gitCommonDir();
        expect(gitCommonDir).toBe(join(root, "innergit"));

        // "mkdir -p innergit/refs/cankan-evil" -- succeeds today, exactly
        // as the brief's own repro demonstrated.
        const hostileTicketsDir = join(root, "innergit", "refs", "cankan-evil");
        await mkdir(hostileTicketsDir, { recursive: true });

        const board: BoardRef = {
          kind: "repo",
          name: "hostile",
          root,
          ticketsDir: hostileTicketsDir,
          coordinationRef: "refs/cankan/coordination",
        };
        const store = await openTicketStore({ board, gitDirs: [gitCommonDir] });
        const targetPath = join(hostileTicketsDir, "ck-escape3 - Escape.md");

        await expectRejectsWithCode(
          () => store.write(newTicket("ck-escape3", "Escape")),
          StoreErrorCodes.TICKETS_DIR_UNSAFE,
        );

        await assertDoesNotExist(targetPath);
        expect(await readdir(hostileTicketsDir)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  test("a ticketsDir reached through a symlink created after the BoardRef was built is refused -- the real TOCTOU step (b)'s write-time half exists to catch -- for write(), remove(), and archive() alike", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      const outside = await realpath(await mkdtemp(join(tmpdir(), "cankan-store-toctou-")));
      try {
        const ticketsPath = join(repo.dir, "tickets");
        await mkdir(ticketsPath);
        const board: BoardRef = {
          kind: "repo",
          name: "hostile",
          root: repo.dir,
          ticketsDir: ticketsPath,
          coordinationRef: "refs/cankan/coordination",
        };
        // The BoardRef above was built against a real, contained
        // directory. Only *now* -- after it exists -- is that directory
        // replaced by a symlink pointing entirely outside root, modeling
        // the window between resolve time and a write that step (b)'s
        // write-time half exists to close.
        await rm(ticketsPath, { recursive: true });
        await symlink(outside, ticketsPath);

        const store = await openTicketStore({ board, gitDirs: [] });
        const targetPath = join(outside, "ck-escape4 - Escape.md");

        await expectRejectsWithCode(
          () => store.write(newTicket("ck-escape4", "Escape")),
          StoreErrorCodes.TICKETS_DIR_UNSAFE,
        );
        // Proves the shared guard covers all three write paths, not only
        // write() -- remove()/archive() have nothing to resolve (the
        // ticket was never written), but the guard must still fire first.
        await expectRejectsWithCode(() => store.remove("ck-escape4"), StoreErrorCodes.TICKETS_DIR_UNSAFE);
        await expectRejectsWithCode(() => store.archive("ck-escape4"), StoreErrorCodes.TICKETS_DIR_UNSAFE);

        await assertDoesNotExist(targetPath);
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
        await repo.cleanup();
      }
    });
  });
});

// ---- end-to-end sanity: this is M2.4's coverage, kept to exactly one case ----

describe("ticketStore — end-to-end sanity (M2.4's own coverage, not this module's -- kept to one case)", () => {
  test("end-to-end: resolveBoard() itself refuses a hostile checked-in tickets_dir before any BoardRef -- or ticket store -- ever exists", async () => {
    await withEnv(undefined, async () => {
      const repo = await makeTempRepo();
      try {
        await writeRepoConfigFile(repo.dir, "config.yml", "tickets_dir: ../outside\n");
        await expectRejectsWithCode(
          () => resolveBoard({ cwd: repo.dir, env: hermeticEnv() }),
          BoardErrorCodes.TICKETS_DIR_ESCAPES_BOARD,
        );
      } finally {
        await repo.cleanup();
      }
    });
  });
});

// ---- ensureArchiveDir's realpath-mismatch branch (1B, work item 2b.3) ------

describe("ticketStore — ensureArchiveDir's realpath-mismatch branch (fix round 1's existing test only covers the lstat branch)", () => {
  test("a deliberately non-canonical ticketsDir (reached through a symlink) drives the realpath-mismatch branch deterministically, and archive() refuses rather than moving the ticket", async () => {
    await withEnv(undefined, async () => {
      // Deliberately the one place the "always realpath your hand-built
      // ticketsDir" rule from the file header above is inverted: the
      // non-canonicality of `ticketsDir` is the whole point of this test,
      // driving `ensureArchiveDir`'s `realpath(archiveDir) !==
      // join(ticketsDir, "archive")` branch, which otherwise has zero
      // coverage in this suite (the existing symlink test only exercises
      // the earlier `lstat` branch).
      const base = await realpath(await mkdtemp(join(tmpdir(), "cankan-store-archivemismatch-")));
      try {
        const actualTickets = join(base, "actual-tickets");
        await mkdir(actualTickets);
        const ticketsLink = join(base, "tickets-link");
        await symlink(actualTickets, ticketsLink);

        const board: BoardRef = {
          kind: "repo",
          name: "mismatch",
          root: base,
          // Non-canonical on purpose: this is a symlink, not its resolved
          // target, so `join(ticketsDir, "archive")` (built from the
          // symlink) can never equal `realpath(archiveDir)` (fully
          // resolved) even though both name the same directory.
          ticketsDir: ticketsLink,
          coordinationRef: "refs/cankan/coordination",
        };
        const store = await openTicketStore({ board, gitDirs: [] });

        const written = await store.write(newTicket("ck-mismatch1", "Archive mismatch"));
        await expectRejectsWithCode(() => store.archive("ck-mismatch1"), StoreErrorCodes.UNSAFE_TICKET_PATH);

        // Refused before any *move*: the ticket is still exactly where it
        // was written, never renamed into `archive/`. `ensureArchiveDir`
        // does still `mkdir` the (harmless, correctly-located) archive
        // directory itself before its realpath comparison catches the
        // mismatch -- that mkdir is not the hazard this branch guards
        // against, the `rename` that never runs afterward is.
        const onDisk = await readFile(written.path, "utf8");
        expect(onDisk.length).toBeGreaterThan(0);
        expect(await readdir(actualTickets)).toContain("archive");
        expect(await readdir(join(actualTickets, "archive"))).toEqual([]);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });
});
