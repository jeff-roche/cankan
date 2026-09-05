import { describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { TicketErrorCodes } from "../../src/ticket/errors";
import {
  buildTicketFilename,
  parseTicketFilename,
  slugifyTitle,
} from "../../src/ticket/filename";
import { normalizeTicketIdForComparison } from "../../src/ticket/id";
import { PROBE3_MISMATCH_FILENAME, PROBE3_MISMATCH_TICKET } from "../fixtures/backlogFixtures";
import { parseTicketFile } from "../../src/ticket/frontmatter";

describe("slugifyTitle", () => {
  test("the same title always yields the same slug", () => {
    const title = "Rate-limit the webhook endpoint";
    expect(slugifyTitle(title)).toBe(slugifyTitle(title));
  });

  test("replaces whitespace runs with a single hyphen, preserving case", () => {
    expect(slugifyTitle("New   task   after   hash")).toBe("New-task-after-hash");
  });

  test("strips path separators and other filesystem-unsafe characters", () => {
    expect(slugifyTitle("a/b\\c:d*e?f\"g<h>i|j")).toBe("abcdefghij");
  });

  test("strips control characters, including NUL", () => {
    expect(slugifyTitle("a\0b\tc\nd")).toBe("abcd");
  });

  test("strips a leading dot so the slug can never look like a hidden/relative segment", () => {
    expect(slugifyTitle("..hidden")).toBe("hidden");
    expect(slugifyTitle("...")).toBe("untitled");
  });

  test("caps length", () => {
    const long = "x".repeat(500);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(100);
  });

  test("never contains a path separator, however hostile the title", () => {
    const hostile = "../../../etc/passwd";
    const slug = slugifyTitle(hostile);
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("\\");
  });

  test("an empty or fully-stripped title falls back to a safe placeholder", () => {
    expect(slugifyTitle("")).toBe("untitled");
    expect(slugifyTitle("///")).toBe("untitled");
  });
});

describe("buildTicketFilename", () => {
  test("builds `<id> - <slug>.md`", () => {
    expect(buildTicketFilename("ck-a1b2c3", "Rate-limit the webhook endpoint")).toBe(
      "ck-a1b2c3 - Rate-limit-the-webhook-endpoint.md",
    );
  });

  test("a hostile title cannot escape the tickets directory: the built filename has no path separator", () => {
    const filename = buildTicketFilename("ck-a1b2c3", "../../../etc/passwd");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("\\");
    expect(filename.endsWith(".md")).toBe(true);
  });

  test("throws a CanKanError if the id itself contains a path separator", () => {
    let thrown: unknown;
    try {
      buildTicketFilename("ck/../evil", "Some title");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.UNSAFE_FILENAME);
  });

  test("throws a CanKanError if the id is exactly '..'", () => {
    expect(() => buildTicketFilename("..", "Some title")).toThrow();
  });

  test("throws a CanKanError if the id is empty (M2.1's security finding: reject empty before any path.join)", () => {
    let thrown: unknown;
    try {
      buildTicketFilename("", "Some title");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.UNSAFE_FILENAME);
  });

  test("throws a CanKanError if the id is the git-metadata directory name", () => {
    expect(() => buildTicketFilename(".git", "Some title")).toThrow();
  });

  test("(round 1 fix-in, I-3/M-2) throws a CanKanError if the id is over the length cap", () => {
    const longId = "c".repeat(200);
    let thrown: unknown;
    try {
      buildTicketFilename(longId, "Some title");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.UNSAFE_FILENAME);
  });

  test("(round 1 fix-in, M-3) throws a CanKanError if the id contains a control character or unsafe punctuation", () => {
    expect(() => buildTicketFilename("ck\nevil", "Some title")).toThrow();
    expect(() => buildTicketFilename("\x1b[31mck-1", "Some title")).toThrow();
    expect(() => buildTicketFilename("ck:1", "Some title")).toThrow();
  });

  test("(round 1 fix-in, M-3) throws a CanKanError if the id contains a bidirectional-override or zero-width character", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, spelled by code point rather than
    // embedded literally, so the character is auditable in a diff.
    const rtlOverride = `${String.fromCodePoint(0x202e)}evil`;
    expect(() => buildTicketFilename(rtlOverride, "Some title")).toThrow();
  });

  test("(round 1 fix-in, M-3) throws a CanKanError if the id is whitespace-only", () => {
    expect(() => buildTicketFilename("   ", "Some title")).toThrow();
  });

  test("(round 1 fix-in, M-1) the error never republishes the raw unsafe value, only which rule failed", () => {
    const secret = "sk_live_should_not_leak";
    let thrown: unknown;
    try {
      buildTicketFilename(`ck\n${secret}`, "Some title");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    const error = thrown as { message: string; details?: Record<string, unknown> };
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details ?? {})).not.toContain(secret);
    expect(error.details?.subject).toBe("id");
    expect(typeof error.details?.reason).toBe("string");
  });
});

describe("parseTicketFilename", () => {
  test("recovers the id and slug from a well-formed filename", () => {
    const parsed = parseTicketFilename("ck-a1b2c3 - Rate-limit-the-webhook-endpoint.md");
    expect(parsed).toEqual({ id: "ck-a1b2c3", slug: "Rate-limit-the-webhook-endpoint" });
  });

  test("build then parse round-trips for a CanKan-minted filename", () => {
    const filename = buildTicketFilename("ck-a1b2c3", "Rate-limit the webhook endpoint");
    expect(parseTicketFilename(filename)).toEqual({
      id: "ck-a1b2c3",
      slug: "Rate-limit-the-webhook-endpoint",
    });
  });

  test("(round 1 fix, I-3) returns null when the recovered id is '.', '..', or the git-metadata directory name — the exact repro from the security review", () => {
    // Reproduced by the security reviewer before this fix:
    //   ".. - x.md"    -> {"id":"..","slug":"x"}
    //   ". - x.md"     -> {"id":".","slug":"x"}
    //   ".git - x.md"  -> {"id":".git","slug":"x"}
    // buildTicketFilename already rejects all three on the write path;
    // parseTicketFilename now runs the same predicate on the read path.
    expect(parseTicketFilename(".. - x.md")).toBeNull();
    expect(parseTicketFilename(". - x.md")).toBeNull();
    expect(parseTicketFilename(".git - x.md")).toBeNull();
    // The separator case the reviewer confirmed already worked, for contrast.
    expect(parseTicketFilename("../x - y.md")).toBeNull();
  });

  test("(round 1 fix-in, M-2/M-3) returns null when the recovered id is over the length cap, unsafe-charset, or bidi/zero-width", () => {
    expect(parseTicketFilename(`${"c".repeat(200)} - x.md`)).toBeNull();
    expect(parseTicketFilename("ck:1 - x.md")).toBeNull();
    const rtlOverride = `${String.fromCodePoint(0x202e)}evil`;
    expect(parseTicketFilename(`${rtlOverride} - x.md`)).toBeNull();
  });

  test("returns null for a string containing a path separator", () => {
    expect(parseTicketFilename("some/dir/ck-1 - x.md")).toBeNull();
    expect(parseTicketFilename("some\\dir\\ck-1 - x.md")).toBeNull();
  });

  test("returns null for a string not shaped like <id> - <slug>.md", () => {
    expect(parseTicketFilename("not-a-ticket-filename.txt")).toBeNull();
    expect(parseTicketFilename("ck-1.md")).toBeNull();
  });

  test("recovers the real Backlog.md probe-3 filename verbatim — NOT required to be the inverse of buildTicketFilename", () => {
    // ADR 0002 probe 3's slug (`New-task-after-hash-id-present`) is
    // Backlog.md's own slug rule, not CanKan's — `parseTicketFilename` must
    // still recover it correctly, but `buildTicketFilename(parsed.id, someTitle)`
    // is deliberately not asserted to reproduce this exact filename.
    const parsed = parseTicketFilename(PROBE3_MISMATCH_FILENAME);
    expect(parsed).toEqual({
      id: "ck-1",
      slug: "New-task-after-hash-id-present",
    });
  });

  test("the filename's id casing may legitimately disagree with the in-file id: casing, but they compare equal via normalizeTicketIdForComparison", () => {
    const fromFilename = parseTicketFilename(PROBE3_MISMATCH_FILENAME);
    const fromFrontmatter = parseTicketFile(PROBE3_MISMATCH_TICKET).frontmatter.id as string;

    expect(fromFilename?.id).toBe("ck-1");
    expect(fromFrontmatter).toBe("CK-1");
    expect(fromFilename?.id).not.toBe(fromFrontmatter);
    expect(normalizeTicketIdForComparison(fromFilename?.id ?? "")).toBe(
      normalizeTicketIdForComparison(fromFrontmatter),
    );
  });
});
