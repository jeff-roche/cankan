import { describe, expect, test } from "bun:test";
import type { TicketId } from "../../src/types";
import {
  generateTicketId,
  keepOnDiskIdCasing,
  normalizeTicketIdForComparison,
  type TicketIdLookupKey,
} from "../../src/ticket/id";
import type { Equal, Expect, IsAssignable } from "../typeLevel";

const ID_SHAPE_RE = /^ck-[0-9a-f]{6}$/;
const ALL_DIGITS_SUFFIX_RE = /^[0-9]+$/;

describe("generateTicketId", () => {
  test("mints a ck-<6 lowercase hex chars> id", () => {
    const id = generateTicketId();
    expect(id as string).toMatch(ID_SHAPE_RE);
  });

  test("honors a custom prefix", () => {
    const id = generateTicketId("task");
    expect(id as string).toMatch(/^task-[0-9a-f]{6}$/);
  });

  test("never generates an all-digit hash suffix (ADR 0002 decision point 4) — property test over many iterations", () => {
    const ITERATIONS = 5000;
    for (let i = 0; i < ITERATIONS; i++) {
      const id = generateTicketId();
      const suffix = (id as string).slice("ck-".length);
      expect(ALL_DIGITS_SUFFIX_RE.test(suffix)).toBe(false);
    }
  });

  test("every generated id is unique enough not to collide across a large sample", () => {
    const SAMPLE = 2000;
    const seen = new Set<string>();
    for (let i = 0; i < SAMPLE; i++) {
      seen.add(generateTicketId() as string);
    }
    expect(seen.size).toBe(SAMPLE);
  });
});

describe("normalizeTicketIdForComparison vs keepOnDiskIdCasing — table test", () => {
  const cases: Array<[string, string]> = [
    ["ck-1", "CK-1"],
    ["CK-1", "ck-1"],
    ["Ck-A1b2C3", "ck-a1b2c3"],
    ["ck-a1b2c3", "ck-a1b2c3"],
  ];

  for (const [a, b] of cases) {
    test(`"${a}" and "${b}" compare equal, but keep their own casing on write`, () => {
      expect(normalizeTicketIdForComparison(a)).toBe(normalizeTicketIdForComparison(b));
      expect(keepOnDiskIdCasing(a) as string).toBe(a);
      expect(keepOnDiskIdCasing(b) as string).toBe(b);
    });
  }

  test("differently-cased ids are not equal as raw strings, only after normalization", () => {
    const lower: string = "ck-1";
    const upper: string = "CK-1";
    expect(lower === upper).toBe(false);
    expect(normalizeTicketIdForComparison(lower) === normalizeTicketIdForComparison(upper)).toBe(true);
  });
});

// Compile-time-only: `TicketIdLookupKey` (comparison) must never be
// interchangeable with `TicketId` (serialization) — this is what makes the
// two operations impossible to confuse by accident, per Ruling 3.
export type IdBrandAssertions = [
  Expect<Equal<IsAssignable<TicketIdLookupKey, TicketId>, false>>,
  Expect<Equal<IsAssignable<TicketId, TicketIdLookupKey>, false>>,
  Expect<Equal<IsAssignable<TicketIdLookupKey, string>, true>>,
  Expect<Equal<IsAssignable<TicketId, string>, true>>,
];
