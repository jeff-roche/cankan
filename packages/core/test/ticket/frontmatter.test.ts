import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { isCanKanError } from "../../src/errors";
import { TicketErrorCodes } from "../../src/ticket/errors";
import {
  parseTicketFile,
  serializeTicketFile,
  setCankanBlock,
  setScalarField,
  setSequenceField,
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

describe("round 2 fix-in: mutation against CONCEPT_TICKET_EXAMPLE, the fixture with padded/unpadded flow collections and inline comments (C-1)", () => {
  // CONCEPT_TICKET_EXAMPLE is in the no-change round-trip suite above, but
  // that only proves the no-change path returns `raw` untouched — it says
  // nothing about the mutation path. The security reviewer showed a naive
  // `doc.set(key, v); doc.toString()` "fix" passes every existing mutation
  // assertion (all against PROBE2/PROBE3/UNKNOWN_FIELD, none of which mix a
  // padded and an unpadded flow collection, or carry an inline comment) and
  // only fails against this exact fixture — repadding `[alice]` to
  // `[ alice ]` and dropping the `# manual rank...` comment. These two
  // tests are the ones that actually exercise that failure mode.

  test("setScalarField(status) changes exactly the status: line; the unpadded/padded flow collections and every inline comment are untouched", () => {
    const parsed = parseTicketFile(CONCEPT_TICKET_EXAMPLE);
    const mutated = setScalarField(parsed, "status", "Done");
    const output = serializeTicketFile(mutated);

    const { changedLines, aLines, bLines } = diffLines(CONCEPT_TICKET_EXAMPLE, output);
    expect(changedLines).toEqual([3]); // 0-indexed: line 3 is "status: In Progress"
    expect(aLines[3]).toBe("status: In Progress");
    expect(bLines[3]).toBe("status: Done");

    // Unpadded flow sequences/maps — a naive `doc.toString()` re-pads these.
    expect(output).toContain("assignee: [alice]");
    expect(output).toContain("labels: [backend]");
    expect(output).toContain("dependencies: [ck-2b1e44]");
    expect(output).toContain("aliases: [TASK-12]             # previous IDs, filled by adopt/renumber");
    // The padded flow map inside the sequence — a naive re-emit can also
    // *unpad* this to match whatever single padding option it chose.
    expect(output).toContain("- { type: blocks, id: ck-2b1e44 }");
    expect(output).toContain("- { type: discovered-from, id: ck-91ab02 }");
    // Every inline comment — a naive re-emit from a plain object drops
    // these entirely, since they were never part of the parsed data.
    expect(output).toContain("ordinal: 1250                    # manual rank; Backlog.md's own field");
    expect(output).toContain("origin: jira:PROJ-45           # omitted for native tickets");
    expect(output).toContain("state: ahead                 # clean | ahead | behind | diverged | conflict");
  });

  test("setCankanBlock replace changes only the cankan: block's own lines; everything before it (unpadded/padded flow collections, inline comments) and the body are untouched", () => {
    const parsed = parseTicketFile(CONCEPT_TICKET_EXAMPLE);
    const mutated = setCankanBlock(parsed, { display_id: "PROJ-99" });
    const output = serializeTicketFile(mutated);

    // Derived from the fixture itself, not retyped, so this cannot drift
    // from CONCEPT_TICKET_EXAMPLE's actual bytes.
    const prefixBeforeCankan = CONCEPT_TICKET_EXAMPLE.slice(
      0,
      CONCEPT_TICKET_EXAMPLE.indexOf("cankan:\n"),
    );
    const suffixFromClosingDelimiter = CONCEPT_TICKET_EXAMPLE.slice(
      CONCEPT_TICKET_EXAMPLE.indexOf("\n---\n\n## Description") + 1,
    );

    expect(output.startsWith(prefixBeforeCankan)).toBe(true);
    expect(output.endsWith(suffixFromClosingDelimiter)).toBe(true);
    expect(output).toContain("cankan:\n  display_id: PROJ-99\n");
    expect(output).not.toContain("origin: jira:PROJ-45");
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

describe("round 1 fix-in: YAML anchors/aliases are rejected outright (I-1, I-2)", () => {
  test("(I-1) an alias-expansion bomb surfaces as a CanKanError, not a raw ReferenceError", () => {
    // Reproduced by the security reviewer: doc.errors is empty for this
    // fixture (it is syntactically valid YAML), and yaml@2.9.0 only throws
    // its resource-exhaustion guard inside toJS(), which used to sit
    // outside every try/catch in this module.
    function buildAliasBomb(depth: number): string {
      let src = "a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n";
      for (let i = 1; i <= depth; i++) {
        src += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]\n`;
      }
      return src;
    }
    const raw = `---\nid: ck-1\ntitle: t\nstatus: todo\n${buildAliasBomb(3)}---\nbody\n`;

    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_MALFORMED);
  });

  test("(I-2) a cyclic anchor does not return a JSON.stringify-hostile frontmatter object", () => {
    // Reproduced by the security reviewer: `x: &a [*a]` used to return
    // normally from parseTicketFile with a self-referential `frontmatter.x`
    // that JSON.stringify cannot encode — a shared-board denial of service
    // via one committed ticket file.
    const raw = "---\nid: ck-1\ntitle: t\nstatus: todo\nx: &a [*a]\n---\nb\n";

    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_MALFORMED);
  });
});

describe("round 1 fix-in: setScalarField on an existing empty/null scalar field (I-4)", () => {
  test("succeeds and produces reparseable YAML, instead of splicing into a zero-width range with no separating space", () => {
    // Reproduced by the security reviewer: an unknown/passthrough field
    // left blank (`epic:` with nothing after it — a legitimate real-world
    // state) is a `null` scalar with a zero-width range positioned right
    // after the colon. Splicing the new value straight into that range
    // used to produce `epic:EPIC-9` (no space), which the reparse then
    // rejected as malformed YAML with the misleading FRONTMATTER_REJECTED
    // code.
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nepic:\n---\nbody\n";
    const parsed = parseTicketFile(raw);

    const mutated = setScalarField(parsed, "epic", "EPIC-9");
    const output = serializeTicketFile(mutated);

    expect(output).toBe("---\nid: ck-1\ntitle: x\nstatus: To Do\nepic: EPIC-9\n---\nbody\n");
    // The reparse inside setScalarField must have succeeded silently; this
    // is a second, independent confirmation via a fresh parse of the result.
    expect(parseTicketFile(output).frontmatter.status).toBe("To Do");
  });
});

describe("round 1 fix-in: mutation on a CRLF-authored ticket file uses the file's own newline convention (M-4)", () => {
  const CRLF_TICKET = "---\r\nid: ck-1\r\ntitle: x\r\nstatus: To Do\r\n---\r\nbody\r\n";

  test("round-trips byte-identically with no mutation", () => {
    const parsed = parseTicketFile(CRLF_TICKET);
    expect(serializeTicketFile(parsed)).toBe(CRLF_TICKET);
  });

  test("appending a new scalar field uses \\r\\n, not \\n", () => {
    const parsed = parseTicketFile(CRLF_TICKET);
    const mutated = setScalarField(parsed, "priority", "high");
    const output = serializeTicketFile(mutated);
    expect(output).toBe("---\r\nid: ck-1\r\ntitle: x\r\nstatus: To Do\r\npriority: high\r\n---\r\nbody\r\n");
    expect(output).not.toContain("high\n---"); // would indicate a bare LF was mixed in
  });

  test("inserting a cankan: block uses \\r\\n throughout", () => {
    const parsed = parseTicketFile(CRLF_TICKET);
    const mutated = setCankanBlock(parsed, { display_id: "PROJ-1" });
    const output = serializeTicketFile(mutated);
    expect(output).toBe(
      "---\r\nid: ck-1\r\ntitle: x\r\nstatus: To Do\r\ncankan:\r\n  display_id: PROJ-1\r\n---\r\nbody\r\n",
    );
  });
});

describe("round 1 fix-in: setScalarField guards (M-5, M-6)", () => {
  test("(M-5) rejects a key containing a newline, before it can inject a second frontmatter line", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    let thrown: unknown;
    try {
      setScalarField(parsed, "evil\nrole: admin", "x");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
  });

  test("(M-6) rejects setting a field that is currently a sequence, with a clear error rather than an indirect schema-validation failure", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nassignee: [alice]\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    let thrown: unknown;
    try {
      setScalarField(parsed, "assignee", "bob");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
  });
});

describe("round 2 fix-in: an oversized file or frontmatter segment throws a CanKanError instead of hanging (S-2)", () => {
  test("a frontmatter segment over the 64 KB cap is rejected immediately, without ever reaching parseDocument", () => {
    // Not the reviewer's 874 KB / 40 s repro itself — that would make this
    // suite slow on every run. The cap is checked (`frontmatterText.length`)
    // before `parseDocument` is ever called, so a fast, deterministic size
    // check is the actual behavior under test, not the parse time. Padding
    // with a single long value (not thousands of keys) keeps this
    // construction itself cheap.
    const oversizedValue = "x".repeat(70 * 1024);
    const raw = `---\nid: ck-1\ntitle: x\nstatus: To Do\npadding: ${oversizedValue}\n---\nbody\n`;

    const start = performance.now();
    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    const elapsedMs = performance.now() - start;

    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_TOO_LARGE);
    // Generous bound: proves this is a size check, not an attempted parse
    // of 70 KB (which the reviewer's own table puts at several seconds).
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("a frontmatter segment just under the cap still parses normally", () => {
    const value = "x".repeat(60 * 1024);
    const raw = `---\nid: ck-1\ntitle: x\nstatus: To Do\npadding: ${value}\n---\nbody\n`;
    const parsed = parseTicketFile(raw);
    expect(parsed.frontmatter.status).toBe("To Do");
  });

  test("a raw file over the generous whole-file cap is rejected immediately", () => {
    // Several-MB cap on `raw` as a whole (deliberately generous — a
    // ticket's prose body is legitimate long text this phase must
    // round-trip byte-identically, so this is not the cap that matters;
    // MAX_FRONTMATTER_LENGTH above is).
    const hugeBody = "x".repeat(9 * 1024 * 1024);
    const raw = `---\nid: ck-1\ntitle: x\nstatus: To Do\n---\n${hugeBody}`;

    const start = performance.now();
    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    const elapsedMs = performance.now() - start;

    expect(isCanKanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(TicketErrorCodes.FRONTMATTER_TOO_LARGE);
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("a long legitimate prose body, well under the raw cap, is not rejected", () => {
    const longBody = "Lorem ipsum dolor sit amet. ".repeat(20000); // ~580 KB of prose
    const raw = `---\nid: ck-1\ntitle: x\nstatus: To Do\n---\n${longBody}`;
    const parsed = parseTicketFile(raw);
    expect(serializeTicketFile(parsed)).toBe(raw);
  });
});

describe("round 2 fix-in: setScalarField never republishes a rejected key in message or details (S-7)", () => {
  test("the unsafe-key rejection reports only the rule, never the key itself", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const secret = "SECRET-ghp_AAAABBBBCCCC";
    let thrown: unknown;
    try {
      setScalarField(parsed, `k\n${secret}: v`, "x");
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    const error = thrown as { message: string; details?: Record<string, unknown> };
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details ?? {})).not.toContain(secret);
  });

  test("the non-scalar-field rejection reports only the rule, never the field name", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nassignee: [alice]\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    let thrown: unknown;
    try {
      setScalarField(parsed, "assignee", "bob");
    } catch (e) {
      thrown = e;
    }
    const error = thrown as { message: string; details?: Record<string, unknown> };
    expect(error.message).not.toContain("assignee");
    expect(JSON.stringify(error.details ?? {})).not.toContain("assignee");
  });
});

describe("round 2 fix-in: setScalarField no longer double-spaces an existing key with trailing whitespace (C-2)", () => {
  test("epic: (no trailing space) gets exactly one inserted space", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nepic:\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const output = serializeTicketFile(setScalarField(parsed, "epic", "EPIC-9"));
    expect(output).toBe("---\nid: ck-1\ntitle: x\nstatus: To Do\nepic: EPIC-9\n---\nbody\n");
  });

  test("epic: <trailing space> does not get a second space inserted", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nepic: \n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const output = serializeTicketFile(setScalarField(parsed, "epic", "EPIC-9"));
    expect(output).toBe("---\nid: ck-1\ntitle: x\nstatus: To Do\nepic: EPIC-9\n---\nbody\n");
  });

  test("epic: <trailing tab> does not get a second space inserted", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nepic:\t\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const output = serializeTicketFile(setScalarField(parsed, "epic", "EPIC-9"));
    expect(output).toBe("---\nid: ck-1\ntitle: x\nstatus: To Do\nepic:\tEPIC-9\n---\nbody\n");
  });
});

describe("round 2 fix-in: the alias-rejection message says 'alias', not 'anchor or alias' (D-1)", () => {
  test("a bare anchor with no alias reference parses cleanly", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nx: &a 1\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    expect(parsed.frontmatter.status).toBe("To Do");
  });

  test("an actual alias reference is rejected with a message naming an alias, not an anchor", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\nx: &a [1]\ny: *a\n---\nbody\n";
    let thrown: unknown;
    try {
      parseTicketFile(raw);
    } catch (e) {
      thrown = e;
    }
    expect(isCanKanError(thrown)).toBe(true);
    const error = thrown as { message: string };
    expect(error.message).toContain("alias");
    // Discriminates from the pre-fix wording ("...uses a YAML anchor or
    // alias, which is not supported"), which overstated what
    // `containsAlias` actually rejects — it only matches `*name` alias
    // references, never a bare `&name` anchor definition.
    expect(error.message).not.toContain("anchor");
  });
});

describe("setSequenceField (M3.5 assign)", () => {
  test("sets an absent sequence field to a flat flow list", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const output = serializeTicketFile(setSequenceField(parsed, "assignee", ["alice"]));
    expect(output).toBe("---\nid: ck-1\ntitle: x\nstatus: To Do\nassignee: [alice]\n---\nbody\n");
    expect(parseTicketFile(output).frontmatter.assignee).toEqual(["alice"]);
  });

  test("replaces an existing sequence field, preserving the rest of the file", () => {
    const parsed = parseTicketFile(CONCEPT_TICKET_EXAMPLE);
    const output = serializeTicketFile(setSequenceField(parsed, "assignee", ["bob", "claude-code:alice/wt-auth"]));
    expect(output).toContain("assignee: [bob, claude-code:alice/wt-auth]");
    expect(output).toContain("labels: [backend]");
    expect(output).toContain("dependencies: [ck-2b1e44]");
    expect(parseTicketFile(output).frontmatter.assignee).toEqual(["bob", "claude-code:alice/wt-auth"]);
  });

  test("rejects a non-sequence field", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    expect(() => setSequenceField(parsed, "title", ["a"])).toThrow(/not a sequence/);
  });

  test("quotes a value that is not a bare flow scalar", () => {
    const raw = "---\nid: ck-1\ntitle: x\nstatus: To Do\n---\nbody\n";
    const parsed = parseTicketFile(raw);
    const output = serializeTicketFile(setSequenceField(parsed, "assignee", ["alice bob"]));
    expect(parseTicketFile(output).frontmatter.assignee).toEqual(["alice bob"]);
  });
});
