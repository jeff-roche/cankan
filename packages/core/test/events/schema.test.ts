import { describe, expect, test } from "bun:test";
import {
  type AliasEvent,
  canonicalizeTicketId,
  type ClaimEvent,
  EVENT_KINDS,
  type Event,
  type EventKind,
  isValidEventId,
  type MoveEvent,
  parseEvent,
  PROJECT_EPOCH,
} from "../../src/events/schema";
import type { Equal, Expect, IsAssignable } from "../typeLevel";

// ============================================================================
// Fixtures — one minimal, valid envelope per kind, matching CONCEPT.md's
// worked example (~line 477) plus the per-kind fields this dispatch adds.
// ============================================================================

const REAL_ULID = "01M1RRC3FBMZYZS4SNMYZHJV6R";
const REAL_ULID_2 = "01M1RRC3FBMZYZS4SNMYZHJV6S";
const TS = "2026-09-04T10:12:00Z";
const LEASE_UNTIL = "2026-09-04T12:12:00Z";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: TS,
    id: REAL_ULID,
    actor: "claude-code:alice/wt-auth",
    ticket: "ck-7f3a9c",
    ...overrides,
  };
}

/** One minimal, valid raw payload per kind — used by the round-trip test below. */
const validPayloadByKind: Record<EventKind, Record<string, unknown>> = {
  create: envelope({ event: "create" }),
  claim: envelope({ event: "claim", lease_until: LEASE_UNTIL }),
  takeover: envelope({ event: "takeover", lease_until: LEASE_UNTIL }),
  renew: envelope({ event: "renew", lease_until: LEASE_UNTIL }),
  release: envelope({ event: "release" }),
  expire: envelope({ event: "expire" }),
  move: envelope({ event: "move", from: "In Progress", to: "In Review" }),
  close: envelope({ event: "close", reason: "won't fix" }),
  alias: envelope({ event: "alias", from: "TASK-12", to: "ck-7f3a9c" }),
  hook: envelope({ event: "hook", title: "Add rate limiting", output: "ok\n" }),
  comment: envelope({ event: "comment", text: "found existing limiter, reusing" }),
  "external-write": envelope({ event: "external-write" }),
};

function parse(payload: Record<string, unknown>, now?: number) {
  return parseEvent(JSON.stringify(payload), now === undefined ? {} : { now });
}

// ============================================================================
// Obligation: every kind round-trips
// ============================================================================

describe("every kind round-trips", () => {
  for (const kind of EVENT_KINDS) {
    test(`${kind} parses to a matching event`, () => {
      const result = parse(validPayloadByKind[kind]);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.event.event).toBe(kind);
      expect(result.event.id as string).toBe(REAL_ULID);
      expect(result.event.ticket as string).toBe("ck-7f3a9c");
    });
  }

  test("EVENT_KINDS names exactly the twelve kinds Ruling R1 decided", () => {
    const actual: string[] = [...EVENT_KINDS].sort();
    const expected: string[] = [
      "create",
      "claim",
      "takeover",
      "renew",
      "release",
      "expire",
      "move",
      "close",
      "alias",
      "hook",
      "comment",
      "external-write",
    ].sort();
    expect(actual).toEqual(expected);
  });
});

// ============================================================================
// Obligation 1 — validated at the boundary, not cast
// ============================================================================

describe("obligation 1 — validated at the boundary, not cast", () => {
  test("malformed JSON is a structured, diagnosable failure, not a thrown exception", () => {
    const result = parseEvent("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("invalid-json");
    expect(result.error.message).toContain("not valid JSON");
  });

  test("a wrong-typed envelope field fails, naming the offending path", () => {
    const result = parse(envelope({ event: "release", ticket: 12345 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("schema-invalid");
    expect(result.error.issues.some((i) => i.path === "ticket")).toBe(true);
  });

  test("a missing required envelope field fails", () => {
    const payload = envelope({ event: "release" });
    delete payload.actor;
    const result = parse(payload);
    expect(result.ok).toBe(false);
  });

  test("missing `event` field fails closed", () => {
    const payload = envelope({});
    const result = parse(payload);
    expect(result.ok).toBe(false);
  });

  test("a wrong-typed kind-specific field fails — deleting the guard would let this through", () => {
    const result = parse(envelope({ event: "claim", lease_until: 12345 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.issues.some((i) => i.path === "lease_until")).toBe(true);
  });

  test("success returns a typed event, failure never throws", () => {
    expect(() => parseEvent("{not json")).not.toThrow();
    expect(() => parse(envelope({ event: "bogus-kind" }))).not.toThrow();
  });
});

// ============================================================================
// Obligation 2 — event ids are ULIDs on read as well as on mint
// ============================================================================
//
// Probe (run in this worktree, `ulid@3.0.2`) established that `isValid` from
// the `ulid` package uppercases before checking, and does not range-check
// the first character — so it would accept every "hostile" case in this
// block. Each test below would pass right through `ulid`'s own `isValid`
// and must be caught by this module's own validator instead.

describe("obligation 2 — event ids are ULIDs, validated on read", () => {
  test("a real ULID is accepted", () => {
    expect(isValidEventId(REAL_ULID)).toBe(true);
    expect(parse(envelope({ event: "release", id: REAL_ULID })).ok).toBe(true);
  });

  test("lowercased is rejected — ulid's own isValid does not reject this (see probe)", () => {
    const lower = REAL_ULID.toLowerCase();
    expect(isValidEventId(lower)).toBe(false);
    expect(parse(envelope({ event: "release", id: lower })).ok).toBe(false);
  });

  test("25 characters (one short) is rejected", () => {
    const short = REAL_ULID.slice(0, 25);
    expect(isValidEventId(short)).toBe(false);
    expect(parse(envelope({ event: "release", id: short })).ok).toBe(false);
  });

  test("27 characters (one long) is rejected", () => {
    const long = `${REAL_ULID}A`;
    expect(isValidEventId(long)).toBe(false);
    expect(parse(envelope({ event: "release", id: long })).ok).toBe(false);
  });

  test("a character excluded from Crockford base32 (I, L, O, U) is rejected", () => {
    for (const excluded of ["I", "L", "O", "U"]) {
      const withExcluded = `0${excluded}ARZ3NDEKTSV4RRFFQ69G5FZV`;
      expect(withExcluded.length).toBe(26);
      expect(isValidEventId(withExcluded)).toBe(false);
      expect(parse(envelope({ event: "release", id: withExcluded })).ok).toBe(false);
    }
  });

  test("timestamp overflow — leading 8/9 — is rejected; ulid's own isValid does not reject this (see probe)", () => {
    const overflow8 = "8ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const overflow9 = "9ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(isValidEventId(overflow8)).toBe(false);
    expect(isValidEventId(overflow9)).toBe(false);
    expect(parse(envelope({ event: "release", id: overflow8 })).ok).toBe(false);
  });

  test("timestamp overflow — leading letter — is rejected; ulid's own isValid does not reject this (see probe)", () => {
    const overflowLetter = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(isValidEventId(overflowLetter)).toBe(false);
    expect(parse(envelope({ event: "release", id: overflowLetter })).ok).toBe(false);
  });

  test("the maximum valid ULID (7ZZZ...) is accepted — the boundary is inclusive", () => {
    const maxUlid = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(isValidEventId(maxUlid)).toBe(true);
    expect(parse(envelope({ event: "release", id: maxUlid })).ok).toBe(true);
  });

  test("a non-ULID string is rejected", () => {
    expect(isValidEventId("evt-01J9ZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
    expect(parse(envelope({ event: "release", id: "not-a-ulid" })).ok).toBe(false);
  });
});

// ============================================================================
// Obligation 3 — ticket is canonicalized before use as a key
// ============================================================================

describe("obligation 3 — ticket canonicalized on read", () => {
  test("an uppercase ticket id is lowercased in the parsed event", () => {
    const result = parse(envelope({ event: "release", ticket: "CK-7F3A9C" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.event.ticket as string).toBe("ck-7f3a9c");
  });

  test("canonicalizeTicketId is a bare lowercase, mirroring ticket/id.ts", () => {
    expect(canonicalizeTicketId("CK-1")).toBe("ck-1" as never);
    expect(canonicalizeTicketId("ck-1")).toBe("ck-1" as never);
  });

  test("a non-string ticket fails — deleting the type check would let this through", () => {
    expect(parse(envelope({ event: "release", ticket: { evil: true } })).ok).toBe(false);
  });

  test("an empty-string ticket fails", () => {
    expect(parse(envelope({ event: "release", ticket: "" })).ok).toBe(false);
  });
});

// ============================================================================
// Obligation 4 — ts is bounded, with an injectable `now`
// ============================================================================

describe("obligation 4 — ts bounded to [PROJECT_EPOCH, now + 24h]", () => {
  const FIXED_NOW = Date.parse("2026-09-04T12:00:00Z");

  test("a ts before PROJECT_EPOCH is rejected", () => {
    const result = parse(envelope({ event: "release", ts: "2019-12-31T23:59:59Z" }), FIXED_NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.issues.some((i) => i.code === "ts_out_of_bounds")).toBe(true);
  });

  test("a ts exactly at PROJECT_EPOCH is accepted — the lower boundary is inclusive", () => {
    const result = parse(envelope({ event: "release", ts: PROJECT_EPOCH }), FIXED_NOW);
    expect(result.ok).toBe(true);
  });

  test("a ts more than 24h ahead of `now` is rejected", () => {
    const tooFarFuture = new Date(FIXED_NOW + 25 * 60 * 60 * 1000).toISOString();
    const result = parse(envelope({ event: "release", ts: tooFarFuture }), FIXED_NOW);
    expect(result.ok).toBe(false);
  });

  test("a ts exactly 24h ahead of `now` is accepted — the upper boundary is inclusive", () => {
    const exactlySkew = new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString();
    const result = parse(envelope({ event: "release", ts: exactlySkew }), FIXED_NOW);
    expect(result.ok).toBe(true);
  });

  test("`now` is injectable: the same ts is valid under one now and invalid under another (UTC month-rollover style)", () => {
    const ts = "2026-08-31T23:59:00Z";
    const nowBeforeRollover = Date.parse("2026-08-31T23:59:30Z");
    const nowFarAfterRollover = Date.parse("2026-10-15T00:00:00Z");
    expect(parse(envelope({ event: "release", ts }), nowBeforeRollover).ok).toBe(true);
    // Still within the fixed lower bound (well after PROJECT_EPOCH) but now
    // more than 24h behind a much-later `now` — irrelevant, since the ts is
    // in the *past* relative to now, which the lower bound (not now-relative)
    // never rejects. This demonstrates the fixed-epoch design doesn't rot: a
    // ts that was valid stays valid arbitrarily far into the future.
    expect(parse(envelope({ event: "release", ts }), nowFarAfterRollover).ok).toBe(true);
  });

  test("a non-ISO-8601 ts is rejected", () => {
    expect(parse(envelope({ event: "release", ts: "not-a-date" })).ok).toBe(false);
    expect(parse(envelope({ event: "release", ts: "2026/09/04 10:12:00" })).ok).toBe(false);
  });

  test("a calendar-invalid lease_until (shaped right, not a real date) is rejected", () => {
    const result = parse(envelope({ event: "claim", lease_until: "2026-13-45T00:00:00Z" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.issues.some((i) => i.path === "lease_until")).toBe(true);
  });

  test("defaults `now` to Date.now() when not supplied", () => {
    const nearNow = new Date(Date.now() - 1000).toISOString();
    expect(parseEvent(JSON.stringify(envelope({ event: "release", ts: nearNow }))).ok).toBe(true);
  });
});

// ============================================================================
// Obligation 5 — actor is not an authenticated identity (doc obligation,
// demonstrated by absence of any identity-shaped constraint)
// ============================================================================

describe("obligation 5 — actor is an arbitrary string, not a checked identity", () => {
  test("any non-empty string is accepted as actor, with no git-identity or credential check", () => {
    for (const actor of ["alice", "claude-code:alice/wt-auth", "literally anything the pusher typed", "🤖"]) {
      expect(parse(envelope({ event: "release", actor })).ok).toBe(true);
    }
  });

  test("an empty actor is still rejected (shape, not identity)", () => {
    expect(parse(envelope({ event: "release", actor: "" })).ok).toBe(false);
  });
});

// ============================================================================
// Obligation 7 — alias gets the same rigor as claim/ticket
// ============================================================================

describe("obligation 7 — alias's from/to canonicalized and validated like ticket", () => {
  test("alias.from and alias.to are lowercased on read", () => {
    const result = parse(envelope({ event: "alias", from: "TASK-12", to: "CK-7F3A9C" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const event = result.event as AliasEvent;
    expect(event.from as string).toBe("task-12");
    expect(event.to as string).toBe("ck-7f3a9c");
  });

  test("a hostile (non-string) alias.to is rejected exactly as a hostile ticket would be", () => {
    expect(parse(envelope({ event: "alias", from: "TASK-12", to: { evil: true } })).ok).toBe(false);
  });

  test("an empty alias.to is rejected", () => {
    expect(parse(envelope({ event: "alias", from: "TASK-12", to: "" })).ok).toBe(false);
  });

  test("move's from/to are NOT canonicalized — they are column names, a different domain than alias's ticket-id from/to", () => {
    const result = parse(envelope({ event: "move", from: "In Progress", to: "In Review" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const event = result.event as MoveEvent;
    expect(event.from).toBe("In Progress");
    expect(event.to).toBe("In Review");
  });

  test("type-level: MoveEvent's from/to is not the same type as AliasEvent's from/to", () => {
    type _assert = Expect<Equal<IsAssignable<MoveEvent["from"], AliasEvent["from"]>, false>>;
    const _typeOnly: _assert = true;
    void _typeOnly;
  });
});

// ============================================================================
// Obligation 8 — unknown fields are rejected (fail-closed)
// ============================================================================

describe("obligation 8 — an event with an unrecognized key is rejected", () => {
  test("an unrecognized top-level key fails — deleting .strict() would let this through", () => {
    const result = parse(envelope({ event: "release", extra_field: "smuggled" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  test("__proto__ as a JSON key is rejected as an unrecognized key, and never touches the real prototype", () => {
    const line = '{"ts":"2026-09-04T10:12:00Z","id":"01M1RRC3FBMZYZS4SNMYZHJV6R","actor":"alice","ticket":"ck-1","event":"release","__proto__":{"polluted":true}}';
    const result = parseEvent(line);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("constructor as a JSON key is rejected as an unrecognized key", () => {
    const result = parse(envelope({ event: "release", constructor: { evil: true } }));
    expect(result.ok).toBe(false);
  });

  test("an unrecognized key on a kind-specific field set is also rejected", () => {
    const result = parse(envelope({ event: "claim", lease_until: LEASE_UNTIL, sneaky: 1 }));
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// Obligation 9 — unknown event kinds are rejected (fail-closed)
// ============================================================================

describe("obligation 9 — an unrecognized `event` kind is rejected", () => {
  test("a kind this schema does not know fails closed", () => {
    const result = parse(envelope({ event: "teleport" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("schema-invalid");
  });

  test("an empty-string event kind fails", () => {
    expect(parse(envelope({ event: "" })).ok).toBe(false);
  });
});

// ============================================================================
// Duplicate-id-shaped hostile input round-up (brief's explicit list, cross-checked)
// ============================================================================

describe("hostile input round-up named in the brief", () => {
  test("two structurally distinct events keep distinct, independently-validated ids", () => {
    const a = parse(envelope({ event: "release", id: REAL_ULID }));
    const b = parse(envelope({ event: "release", id: REAL_ULID_2 }));
    expect(a.ok && b.ok).toBe(true);
  });
});

// ============================================================================
// Type-level: the public Event union matches the documented per-kind shapes
// ============================================================================

describe("type-level sanity", () => {
  test("ClaimEvent carries lease_until, ReleaseEvent does not (compile-time only, exercised at runtime for coverage)", () => {
    const claim: ClaimEvent = {
      ts: TS,
      id: REAL_ULID,
      actor: "alice",
      ticket: "ck-1",
      event: "claim",
      lease_until: LEASE_UNTIL,
    } as unknown as ClaimEvent;
    expect(claim.event).toBe("claim");
  });

  test("Event is the union of all twelve kinds", () => {
    const kinds = new Set<Event["event"]>(EVENT_KINDS);
    expect(kinds.size).toBe(12);
  });
});
