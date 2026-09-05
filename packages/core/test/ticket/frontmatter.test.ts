import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { isCanKanError } from "../../src/errors";
import { TicketErrorCodes } from "../../src/ticket/errors";
import {
  parseTicketFile,
  serializeTicketFile,
  setCankanBlock,
  setScalarField,
} from "../../src/ticket/frontmatter";
import {
  CONCEPT_TICKET_EXAMPLE,
  PROBE2_AFTER_EDIT,
  PROBE2_BEFORE_EDIT,
  PROBE3_MISMATCH_TICKET,
  UNKNOWN_FIELD_TICKET,
} from "../fixtures/backlogFixtures";

/** Splits two multi-line strings and returns the 0-based indices where they differ, plus their line counts. Used to assert "exactly this one line changed" rather than a loose substring check. */
function diffLines(a: string, b: string): { changedLines: number[]; aLines: string[]; bLines: string[] } {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const changedLines: number[] = [];
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      changedLines.push(i);
    }
  }
  return { changedLines, aLines, bLines };
}

const ALL_FIXTURES = [
  ["CONCEPT_TICKET_EXAMPLE", CONCEPT_TICKET_EXAMPLE],
  ["PROBE2_BEFORE_EDIT", PROBE2_BEFORE_EDIT],
  ["PROBE2_AFTER_EDIT", PROBE2_AFTER_EDIT],
  ["PROBE3_MISMATCH_TICKET", PROBE3_MISMATCH_TICKET],
  ["UNKNOWN_FIELD_TICKET", UNKNOWN_FIELD_TICKET],
] as const;

describe("parse -> serialize -> parse round trip (byte identity)", () => {
  for (const [name, raw] of ALL_FIXTURES) {
    test(`${name} is byte-identical after one round trip`, () => {
      const parsed = parseTicketFile(raw);
      const serialized = serializeTicketFile(parsed);
      expect(serialized).toBe(raw);

      // A second round trip must be stable too.
      const reparsed = parseTicketFile(serialized);
      expect(serializeTicketFile(reparsed)).toBe(raw);
    });
  }

  test("a frontmatter block with no trailing newline before the closing delimiter round-trips (EOF edge case)", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---";
    const parsed = parseTicketFile(raw);
    expect(serializeTicketFile(parsed)).toBe(raw);
  });
});

describe("cankan: block is optional (ADR 0002 decision point 3 — disposable cache)", () => {
  test("a ticket with a full cankan: block parses cleanly", () => {
    const parsed = parseTicketFile(CONCEPT_TICKET_EXAMPLE);
    expect(parsed.frontmatter.cankan).toBeDefined();
    expect(parsed.frontmatter.cankan?.display_id).toBe("PROJ-45");
  });

  test("a ticket whose cankan: block Backlog.md just destroyed still parses cleanly, with cankan undefined", () => {
    const parsed = parseTicketFile(PROBE2_AFTER_EDIT);
    expect(parsed.frontmatter.cankan).toBeUndefined();
    expect(parsed.frontmatter.id as string).toBe("ck-a1b2c3");
    expect(parsed.frontmatter.status).toBe("In Progress");
  });
});

describe("setScalarField — the required probe-3 mutation test", () => {
  test("changes exactly the status: line; id casing, quoting, flow style, key order and body are untouched", () => {
    const parsed = parseTicketFile(PROBE3_MISMATCH_TICKET);
    const mutated = setScalarField(parsed, "status", "In Progress");
    const output = serializeTicketFile(mutated);

    expect(output).not.toBe(PROBE3_MISMATCH_TICKET);

    const { changedLines, aLines, bLines } = diffLines(PROBE3_MISMATCH_TICKET, output);
    expect(changedLines).toEqual([3]); // 0-indexed: line 0 is "---", line 3 is "status: To Do"
    expect(aLines[3]).toBe("status: To Do");
    expect(bLines[3]).toBe("status: In Progress");

    // id: CK-1 keeps its uppercase casing, unmutated.
    expect(output).toContain("id: CK-1");
    // The single-quoted date and flow-style empty sequences are untouched.
    expect(output).toContain("created_date: '2026-09-04 22:20'");
    expect(output).toContain("assignee: []");
    expect(output).toContain("labels: []");
    expect(output).toContain("dependencies: []");
    // Key order is untouched (only the status value changed in place).
    expect(bLines.map((l) => l.split(":")[0])).toEqual(aLines.map((l) => l.split(":")[0]));
  });

  test("mutating status leaves an unknown field (epic:) present, in place, in its original style", () => {
    const parsed = parseTicketFile(UNKNOWN_FIELD_TICKET);
    const mutated = setScalarField(parsed, "status", "Done");
    const output = serializeTicketFile(mutated);

    const { changedLines, aLines, bLines } = diffLines(UNKNOWN_FIELD_TICKET, output);
    expect(changedLines).toEqual([3]); // 0-indexed: line 0 is "---", line 3 is "status: To Do"
    expect(aLines[3]).toBe("status: To Do");
    expect(bLines[3]).toBe("status: Done");
    expect(output).toContain("epic: EPIC-42");
  });

  test("appends a new key when the field is not already present", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const mutated = setScalarField(parsed, "priority", "high");
    const output = serializeTicketFile(mutated);
    expect(output).toBe("---\nid: ck-1\ntitle: x\nstatus: To Do\npriority: high\n---\nbody\n");
  });

  test("preserves the EOF edge case (no trailing newline before the closing delimiter)", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---";
    const parsed = parseTicketFile(raw);
    const mutated = setScalarField(parsed, "status", "Done");
    expect(serializeTicketFile(mutated)).toBe("---\nid: ck-1\ntitle: x\nstatus: Done\n---");
  });
});

describe("setCankanBlock — the disposable-cache rebuild path", () => {
  test("removes an existing cankan: block, leaving everything else untouched", () => {
    const parsed = parseTicketFile(PROBE2_BEFORE_EDIT);
    const mutated = setCankanBlock(parsed, undefined);
    const output = serializeTicketFile(mutated);

    expect(output).not.toContain("cankan:");
    expect(output).not.toContain("origin: jira:PROJ-45");
    // Everything before the cankan: key is untouched, including the
    // trailing newline that used to separate it from cankan:.
    expect(output).toBe(
      "---\nid: ck-a1b2c3\ntitle: Some title\nstatus: To Do\nassignee: []\nlabels: []\ndependencies: []\ncreated_date: '2026-09-04 22:00'\nordinal: 1000\n---\n\n## Description\nHand-written probe ticket for M1.3 read-tolerance testing.\n\n## Acceptance Criteria\n- [ ] Returns 429 above 100 req/min per key\n- [ ] Documented in API reference\n",
    );
  });

  test("removing an absent cankan: block is a no-op", () => {
    const parsed = parseTicketFile(PROBE2_AFTER_EDIT);
    const mutated = setCankanBlock(parsed, undefined);
    expect(serializeTicketFile(mutated)).toBe(PROBE2_AFTER_EDIT);
  });

  test("replaces an existing cankan: block with a freshly-derived one", () => {
    const parsed = parseTicketFile(PROBE2_BEFORE_EDIT);
    const mutated = setCankanBlock(parsed, { display_id: "PROJ-99" });
    const output = serializeTicketFile(mutated);

    expect(output).toContain("cankan:\n  display_id: PROJ-99\n");
    expect(output).not.toContain("origin: jira:PROJ-45");
    // Everything before cankan: is untouched.
    expect(output.startsWith("---\nid: ck-a1b2c3\ntitle: Some title\nstatus: To Do\nassignee: []\nlabels: []\ndependencies: []\ncreated_date: '2026-09-04 22:00'\nordinal: 1000\n")).toBe(true);
    // The body is untouched.
    expect(output.endsWith("## Description\nHand-written probe ticket for M1.3 read-tolerance testing.\n\n## Acceptance Criteria\n- [ ] Returns 429 above 100 req/min per key\n- [ ] Documented in API reference\n")).toBe(true);
  });

  test("replaces with a full CONCEPT.md-shaped block (nested sync map, deps array, aliases array) and reparses to the same shape", () => {
    const parsed = parseTicketFile(PROBE2_BEFORE_EDIT);
    const fullBlock = {
      origin: "jira:PROJ-45",
      display_id: "PROJ-45",
      sync: {
        state: "ahead",
        base_hash: "3c9fabc",
        pulled_at: "2026-09-04T10:12:00Z",
        url: "https://acme.atlassian.net/browse/PROJ-45",
      },
      deps: [
        { type: "blocks", id: "ck-2b1e44" },
        { type: "discovered-from", id: "ck-91ab02" },
      ],
      aliases: ["TASK-12"],
    };
    const mutated = setCankanBlock(parsed, fullBlock);

    // The rebuild path must round-trip through reparsing: what comes back
    // out of `frontmatter.cankan` must deep-equal what was set, proving the
    // nested-map/seq indentation survived `stringify` + `indentBlock`.
    expect(mutated.frontmatter.cankan).toEqual(fullBlock);

    const output = serializeTicketFile(mutated);
    expect(
      output.startsWith(
        "---\nid: ck-a1b2c3\ntitle: Some title\nstatus: To Do\nassignee: []\nlabels: []\ndependencies: []\ncreated_date: '2026-09-04 22:00'\nordinal: 1000\n",
      ),
    ).toBe(true);
    expect(
      output.endsWith(
        "## Description\nHand-written probe ticket for M1.3 read-tolerance testing.\n\n## Acceptance Criteria\n- [ ] Returns 429 above 100 req/min per key\n- [ ] Documented in API reference\n",
      ),
    ).toBe(true);
  });

  test("adds a cankan: block to a ticket that has none, just before the closing delimiter", () => {
    const parsed = parseTicketFile(PROBE2_AFTER_EDIT);
    const mutated = setCankanBlock(parsed, { display_id: "PROJ-1" });
    const output = serializeTicketFile(mutated);
    expect(output).toBe(
      PROBE2_AFTER_EDIT.replace("ordinal: 1000\n---", "ordinal: 1000\ncankan:\n  display_id: PROJ-1\n---"),
    );
  });
});

describe("the gray-matter javascript engine (the base vulnerability, unmitigated)", () => {
  // Proves the vulnerability this module defends against is real: calling
  // gray-matter directly, with no mitigation, executes ticket content.
  // Cleanup always runs, mitigated or not.
  for (const tag of ["js", "javascript"]) {
    test(`---${tag} executes as code when matter() is called with no engine mitigation`, () => {
      // biome-ignore lint/suspicious/noExplicitAny: probing an untyped global for a test-only marker.
      const g = globalThis as any;
      g.__cankanEvalProbe = undefined;
      const hostile = `---${tag}\n(globalThis.__cankanEvalProbe = true, {})\n---\nbody\n`;
      try {
        matter(hostile);
        expect(g.__cankanEvalProbe).toBe(true);
      } finally {
        g.__cankanEvalProbe = undefined;
      }
    });
  }
});

describe("parseTicketFile blocks the javascript engine and never leaks a raw third-party error", () => {
  for (const tag of ["js", "javascript"]) {
    test(`---${tag} frontmatter does not execute, and surfaces as a CanKanError`, () => {
      // biome-ignore lint/suspicious/noExplicitAny: probing an untyped global for a test-only marker.
      const g = globalThis as any;
      g.__cankanEvalProbe = undefined;
      const hostile = `---${tag}\n(globalThis.__cankanEvalProbe = true, {})\n---\nbody\n`;
      try {
        let thrown: unknown;
        try {
          parseTicketFile(hostile);
        } catch (e) {
          thrown = e;
        }
        expect(g.__cankanEvalProbe).toBeUndefined();
        expect(thrown).toBeDefined();
        expect(isCanKanError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_REJECTED);
      } finally {
        g.__cankanEvalProbe = undefined;
      }
    });
  }

  test("a non-executing, unregistered language tag also surfaces as a CanKanError, not a raw gray-matter error", () => {
    const raw = "---toml\nid = 1\n---\nbody\n";
    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
  });
});

describe("frontmatter structural and YAML errors never echo source text", () => {
  test("missing opening delimiter is a CanKanError, not a crash", () => {
    let thrown: unknown;
    try {
      parseTicketFile("id: ck-1\ntitle: x\n");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_MALFORMED);
  });

  test("missing closing delimiter is a CanKanError, not a crash", () => {
    let thrown: unknown;
    try {
      parseTicketFile("---\nid: ck-1\ntitle: x\n");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_MALFORMED);
  });

  test("YAML rejected by gray-matter's own engine surfaces via the security gate, without leaking source text", () => {
    // Confirmed by execution: an unterminated flow sequence makes
    // gray-matter's js-yaml engine throw before `callMatter` even returns,
    // so this exercises the *gate's* wrapping, not `parseFrontmatterData`'s.
    const secret = "sk_live_should_not_leak_into_any_message";
    const raw = `---\nid: ck-1\ntitle: [${secret}\nstatus: To Do\n---\nbody\n`;
    let thrown: unknown;
    try {
      parseTicketFile(raw, "backlog/tasks/ck-1 - x.md");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    const error = thrown as { code: string; message: string; cause?: unknown };
    expect(error.code).toBe(TicketErrorCodes.FRONTMATTER_REJECTED);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("backlog/tasks/ck-1 - x.md");
    expect(error.cause).toBeDefined();
  });

  test("YAML gray-matter's own engine silently mis-parses is still caught by yaml's stricter parser, reporting path + line/col only", () => {
    // Confirmed by execution: gray-matter's js-yaml engine tolerates tab
    // indentation (silently misinterpreting the tab-indented line as a
    // top-level sibling key rather than nested under `cankan:`), so
    // `callMatter` does NOT throw for this fixture — this is exactly why
    // `yaml` package, not gray-matter's own parse, owns `data` and the
    // error surface: `yaml` correctly rejects tabs-as-indentation instead
    // of silently mis-structuring the document.
    const secret = "sk_live_should_not_leak_into_any_message";
    const raw = `---\nid: ck-1\ntitle: x\ncankan:\n\torigin: ${secret}\n---\nbody\n`;
    let thrown: unknown;
    try {
      parseTicketFile(raw, "backlog/tasks/ck-1 - x.md");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    const error = thrown as { code: string; message: string; cause?: unknown };
    expect(error.code).toBe(TicketErrorCodes.FRONTMATTER_MALFORMED);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("backlog/tasks/ck-1 - x.md");
    expect(error.message).toMatch(/line \d+, column \d+/);
    expect(error.cause).toBeDefined();
  });

  test("a schema validation failure (missing required fields) is a CanKanError, and zod's safe issue list is attached", () => {
    const raw = "---\nstatus: To Do\n---\nbody\n";
    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    const error = thrown as { code: string; details?: { issues?: unknown[] } };
    expect(error.code).toBe(TicketErrorCodes.FRONTMATTER_INVALID);
    expect(error.details?.issues).toBeDefined();
  });
});
