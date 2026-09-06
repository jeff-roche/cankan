import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeTempRepo, type TempRepo } from "../../../test-utils/src/tempRepo";
import { withEnv } from "../../../test-utils/src/withEnv";
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

  test("assertSafeTicketPath rejects a path separator, a backslash, a single dot, and a double dot -- and nothing is written", () => {
    const dir = "/tmp/does-not-matter-for-this-assertion";
    for (const hostile of ["sub/dir.md", "sub\\dir.md", ".", ".."]) {
      let threw = false;
      try {
        assertSafeTicketPath(dir, hostile);
      } catch (err) {
        threw = true;
        expect(isCanKanError(err) && err.code).toBe(StoreErrorCodes.UNSAFE_TICKET_PATH);
      }
      expect(threw).toBe(true);
    }
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
});
