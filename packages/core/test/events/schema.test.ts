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
const TS = "2026-09-04T10:12:00Z";
const LEASE_UNTIL = "2026-09-04T12:12:00Z";

function envelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
  reopen: envelope({ event: "reopen" }),
  alias: envelope({ event: "alias", from: "TASK-12", to: "ck-7f3a9c" }),
  hook: envelope({ event: "hook", title: "Add rate limiting", output: "ok\n" }),
  comment: envelope({
    event: "comment",
    text: "found existing limiter, reusing",
  }),
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

  test("EVENT_KINDS includes the reopen lifecycle event", () => {
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
      "reopen",
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
    expect(result.error.issues.some((i) => i.path === "lease_until")).toBe(
      true,
    );
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
      expect(parse(envelope({ event: "release", id: withExcluded })).ok).toBe(
        false,
      );
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
    expect(parse(envelope({ event: "release", id: overflowLetter })).ok).toBe(
      false,
    );
  });

  test("the maximum valid ULID (7ZZZ...) is accepted — the boundary is inclusive", () => {
    const maxUlid = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(isValidEventId(maxUlid)).toBe(true);
    expect(parse(envelope({ event: "release", id: maxUlid })).ok).toBe(true);
  });

  test("a non-ULID string is rejected", () => {
    expect(isValidEventId("evt-01J9ZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
    expect(parse(envelope({ event: "release", id: "not-a-ulid" })).ok).toBe(
      false,
    );
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
    expect(
      parse(envelope({ event: "release", ticket: { evil: true } })).ok,
    ).toBe(false);
  });

  test("an empty-string ticket fails", () => {
    expect(parse(envelope({ event: "release", ticket: "" })).ok).toBe(false);
  });
});

// ============================================================================
// Fix round 1, finding M2 — structural id-shape guard on `ticket`
// (traversal strings, control characters, bidi overrides, whitespace-only,
// oversized values previously accepted; probes proving each is now rejected)
// ============================================================================

describe("fix round 1 M2 — ticket structural id-shape guard", () => {
  test("a path-traversal-shaped ticket is rejected", () => {
    const result = parse(
      envelope({
        event: "release",
        ticket: "../../../../home/victim/.gitconfig",
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("an absolute-path-shaped ticket is rejected", () => {
    expect(
      parse(envelope({ event: "release", ticket: "/etc/passwd" })).ok,
    ).toBe(false);
  });

  test("a ticket containing a raw ANSI escape is rejected", () => {
    expect(
      parse(envelope({ event: "release", ticket: "\x1b[2Jck-1" })).ok,
    ).toBe(false);
  });

  test("a whitespace-only ticket is rejected", () => {
    expect(parse(envelope({ event: "release", ticket: "   " })).ok).toBe(false);
  });

  test("a ticket containing a NUL byte is rejected", () => {
    expect(parse(envelope({ event: "release", ticket: "ck-1\0evil" })).ok).toBe(
      false,
    );
  });

  test("a ticket containing a bidi override is rejected", () => {
    expect(parse(envelope({ event: "release", ticket: "ck-1‮" })).ok).toBe(
      false,
    );
  });

  test("a ticket exactly '.' or '..' is rejected", () => {
    expect(parse(envelope({ event: "release", ticket: "." })).ok).toBe(false);
    expect(parse(envelope({ event: "release", ticket: ".." })).ok).toBe(false);
  });

  test("a ticket over 100 UTF-8 bytes is rejected", () => {
    expect(
      parse(envelope({ event: "release", ticket: `ck-${"a".repeat(100)}` })).ok,
    ).toBe(false);
  });

  test("legitimate ticket ids still pass — no false-positive regression", () => {
    for (const ticket of [
      "ck-a1b2c3",
      "ck-7f3a9c",
      "TASK-12",
      "PROJ-45",
      "#123",
    ]) {
      expect(parse(envelope({ event: "release", ticket })).ok).toBe(true);
    }
  });

  test("documented, deliberate gap: embedded (non-whitespace-only) whitespace is still accepted, unlike ticket/filename.ts's stricter rule", () => {
    // See the doc comment above `unsafeTicketIdShapeReason`: this is a
    // disclosed narrowing, not an oversight — rejecting only whitespace-only
    // (not any embedded whitespace) keeps this module strictly more
    // permissive than `unsafeIdReason`, never stricter.
    expect(parse(envelope({ event: "release", ticket: "ck-1 .md" })).ok).toBe(
      true,
    );
  });
});

// ============================================================================
// Obligation 4 — ts is bounded, with an injectable `now`
// ============================================================================

describe("obligation 4 — ts bounded to [PROJECT_EPOCH, now + 24h]", () => {
  const FIXED_NOW = Date.parse("2026-09-04T12:00:00Z");

  test("a ts before PROJECT_EPOCH is rejected", () => {
    const result = parse(
      envelope({ event: "release", ts: "2019-12-31T23:59:59Z" }),
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.issues.some((i) => i.code === "ts_out_of_bounds")).toBe(
      true,
    );
  });

  test("a ts exactly at PROJECT_EPOCH is accepted — the lower boundary is inclusive", () => {
    const result = parse(
      envelope({ event: "release", ts: PROJECT_EPOCH }),
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
  });

  test("a ts more than 24h ahead of `now` is rejected", () => {
    const tooFarFuture = new Date(
      FIXED_NOW + 25 * 60 * 60 * 1000,
    ).toISOString();
    const result = parse(
      envelope({ event: "release", ts: tooFarFuture }),
      FIXED_NOW,
    );
    expect(result.ok).toBe(false);
  });

  test("a ts exactly 24h ahead of `now` is accepted — the upper boundary is inclusive", () => {
    const exactlySkew = new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString();
    const result = parse(
      envelope({ event: "release", ts: exactlySkew }),
      FIXED_NOW,
    );
    expect(result.ok).toBe(true);
  });

  test("`now` is injectable: the same ts is valid under one now and invalid under another (UTC month-rollover style)", () => {
    const ts = "2026-08-31T23:59:00Z";
    const nowBeforeRollover = Date.parse("2026-08-31T23:59:30Z");
    const nowFarAfterRollover = Date.parse("2026-10-15T00:00:00Z");
    expect(
      parse(envelope({ event: "release", ts }), nowBeforeRollover).ok,
    ).toBe(true);
    // Still within the fixed lower bound (well after PROJECT_EPOCH) but now
    // more than 24h behind a much-later `now` — irrelevant, since the ts is
    // in the *past* relative to now, which the lower bound (not now-relative)
    // never rejects. This demonstrates the fixed-epoch design doesn't rot: a
    // ts that was valid stays valid arbitrarily far into the future.
    expect(
      parse(envelope({ event: "release", ts }), nowFarAfterRollover).ok,
    ).toBe(true);
  });

  test("a non-ISO-8601 ts is rejected", () => {
    expect(parse(envelope({ event: "release", ts: "not-a-date" })).ok).toBe(
      false,
    );
    expect(
      parse(envelope({ event: "release", ts: "2026/09/04 10:12:00" })).ok,
    ).toBe(false);
  });

  test("a calendar-invalid lease_until (shaped right, not a real date) is rejected", () => {
    const result = parse(
      envelope({ event: "claim", lease_until: "2026-13-45T00:00:00Z" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.issues.some((i) => i.path === "lease_until")).toBe(
      true,
    );
  });

  test("defaults `now` to Date.now() when not supplied", () => {
    const nearNow = new Date(Date.now() - 1000).toISOString();
    expect(
      parseEvent(JSON.stringify(envelope({ event: "release", ts: nearNow })))
        .ok,
    ).toBe(true);
  });
});

// ============================================================================
// Fix round 1, finding L4 / Ruling R13 — Date.parse silently rolls a
// calendar-invalid instant forward (2026-02-30 → 2026-03-02) instead of
// returning NaN; both ts and lease_until must reject the round-trip case,
// not only the grosser 2026-13-45 shape.
// ============================================================================

describe("fix round 1 L4 — calendar round-trip check (2026-02-30 rolls forward, not NaN)", () => {
  test("Date.parse itself does not reject 2026-02-30 — the premise this fix addresses", () => {
    const ms = Date.parse("2026-02-30T00:00:00Z");
    expect(Number.isNaN(ms)).toBe(false);
    expect(new Date(ms).toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });

  test("a ts of 2026-02-30 (rolls forward to March 2) is rejected", () => {
    const result = parse(
      envelope({ event: "release", ts: "2026-02-30T00:00:00Z" }),
    );
    expect(result.ok).toBe(false);
  });

  test("a lease_until of 2026-02-30 (rolls forward to March 2) is rejected", () => {
    const result = parse(
      envelope({ event: "claim", lease_until: "2026-02-30T00:00:00Z" }),
    );
    expect(result.ok).toBe(false);
  });

  test("a real, non-rolling ts and lease_until still pass", () => {
    expect(
      parse(envelope({ event: "release", ts: "2026-09-04T10:12:00Z" })).ok,
    ).toBe(true);
    expect(
      parse(envelope({ event: "claim", lease_until: "2026-09-04T12:12:00Z" }))
        .ok,
    ).toBe(true);
  });
});

// ============================================================================
// Obligation 5 — actor is not an authenticated identity (doc obligation,
// demonstrated by absence of any identity-shaped constraint)
// ============================================================================

describe("obligation 5 — actor is an arbitrary string, not a checked identity", () => {
  test("any non-empty string is accepted as actor, with no git-identity or credential check", () => {
    for (const actor of [
      "alice",
      "claude-code:alice/wt-auth",
      "literally anything the pusher typed",
      "🤖",
    ]) {
      expect(parse(envelope({ event: "release", actor })).ok).toBe(true);
    }
  });

  test("an empty actor is still rejected (shape, not identity)", () => {
    expect(parse(envelope({ event: "release", actor: "" })).ok).toBe(false);
  });
});

// ============================================================================
// Fix round 1, finding M2 / Ruling R14 — structural guard on actor/parent.
// A NARROWER guard than ticket's: actor legitimately contains `/`.
// ============================================================================

describe("fix round 1 M2/R14 — actor/parent structural id-shape guard", () => {
  test("an actor containing '/' is still accepted — regression guard for a real bug caught in this file's own review", () => {
    // A first draft applied ticket's full guard (including the
    // path-separator rule) to actor too, which rejected this exact
    // envelope default and broke nearly every test in this file.
    expect(
      parse(envelope({ event: "release", actor: "claude-code:alice/wt-auth" }))
        .ok,
    ).toBe(true);
    expect(parse(envelope({ event: "release", actor: "codex:ci" })).ok).toBe(
      true,
    );
  });

  test("an actor containing a raw ANSI escape is rejected", () => {
    expect(
      parse(envelope({ event: "release", actor: "\x1b[31malice\x1b[0m" })).ok,
    ).toBe(false);
  });

  test("an actor containing a NUL byte is rejected", () => {
    expect(parse(envelope({ event: "release", actor: "alice\0evil" })).ok).toBe(
      false,
    );
  });

  test("a whitespace-only actor is rejected", () => {
    expect(parse(envelope({ event: "release", actor: "   " })).ok).toBe(false);
  });

  test("an actor containing a bidi override is rejected", () => {
    expect(parse(envelope({ event: "release", actor: "alice‮" })).ok).toBe(
      false,
    );
  });

  test("an actor over 200 characters is rejected", () => {
    expect(
      parse(envelope({ event: "release", actor: "a".repeat(201) })).ok,
    ).toBe(false);
  });

  test("parent gets the identical guard, including the '/' regression check", () => {
    expect(
      parse(envelope({ event: "release", parent: "alice/wt-auth" })).ok,
    ).toBe(true);
    expect(
      parse(envelope({ event: "release", parent: "\x1b[31malice\x1b[0m" })).ok,
    ).toBe(false);
  });
});

// ============================================================================
// Obligation 7 — alias gets the same rigor as claim/ticket
// ============================================================================

describe("obligation 7 — alias's from/to canonicalized and validated like ticket", () => {
  test("alias.from and alias.to are lowercased on read", () => {
    const result = parse(
      envelope({ event: "alias", from: "TASK-12", to: "CK-7F3A9C" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const event = result.event as AliasEvent;
    expect(event.from as string).toBe("task-12");
    expect(event.to as string).toBe("ck-7f3a9c");
  });

  test("a hostile (non-string) alias.to is rejected exactly as a hostile ticket would be", () => {
    expect(
      parse(envelope({ event: "alias", from: "TASK-12", to: { evil: true } }))
        .ok,
    ).toBe(false);
  });

  test("an empty alias.to is rejected", () => {
    expect(
      parse(envelope({ event: "alias", from: "TASK-12", to: "" })).ok,
    ).toBe(false);
  });

  test("move's from/to are NOT canonicalized — they are column names, a different domain than alias's ticket-id from/to", () => {
    const result = parse(
      envelope({ event: "move", from: "In Progress", to: "In Review" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const event = result.event as MoveEvent;
    expect(event.from).toBe("In Progress");
    expect(event.to).toBe("In Review");
  });

  test("type-level: MoveEvent's from/to is not the same type as AliasEvent's from/to", () => {
    type _assert = Expect<
      Equal<IsAssignable<MoveEvent["from"], AliasEvent["from"]>, false>
    >;
    const _typeOnly: _assert = true;
    void _typeOnly;
  });
});

// ============================================================================
// Fix round 1, finding M2 — alias.from/to get ticket's full structural
// guard (reused, not re-derived — see ticketSchema's doc comment).
// ============================================================================

describe("fix round 1 M2 — alias.from/to get ticket's structural id-shape guard", () => {
  test("a path-traversal-shaped alias.to is rejected — the exact redirect primitive obligation 7 singles out", () => {
    const result = parse(
      envelope({
        event: "alias",
        from: "TASK-12",
        to: "../../../../home/victim/.gitconfig",
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("an alias.to containing a raw ANSI escape is rejected", () => {
    expect(
      parse(envelope({ event: "alias", from: "TASK-12", to: "\x1b[2Jck-1" }))
        .ok,
    ).toBe(false);
  });

  test("an alias.from containing a bidi override is rejected", () => {
    expect(
      parse(envelope({ event: "alias", from: "task-12‮", to: "ck-1" })).ok,
    ).toBe(false);
  });
});

// ============================================================================
// Fix round 1, finding L6 — alias self-loop rejected, checked AFTER
// canonicalization (a same-ticket alias that only becomes a self-loop once
// casing is normalized must not slip through a pre-canonicalization check).
// ============================================================================

describe("fix round 1 L6 — alias self-loop rejected", () => {
  test("an exact self-loop is rejected", () => {
    const result = parse(
      envelope({ event: "alias", from: "ck-1", to: "ck-1" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(
      result.error.issues.some((i) => i.path === "to" && i.code === "custom"),
    ).toBe(true);
  });

  test("a self-loop that only appears after canonicalization is rejected", () => {
    // Pre-canonicalization these differ ("CK-1" vs "ck-1"); a naive check
    // run before the transform would miss this.
    const result = parse(
      envelope({ event: "alias", from: "CK-1", to: "ck-1" }),
    );
    expect(result.ok).toBe(false);
  });

  test("a genuine (non-self-loop) alias still parses", () => {
    const result = parse(
      envelope({ event: "alias", from: "TASK-12", to: "ck-7f3a9c" }),
    );
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Obligation 8 — unknown fields are rejected (fail-closed)
// ============================================================================

describe("obligation 8 — an event with an unrecognized key is rejected", () => {
  test("an unrecognized top-level key fails — deleting .strict() would let this through", () => {
    const result = parse(
      envelope({ event: "release", extra_field: "smuggled" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(
      result.error.issues.some((i) => i.code === "unrecognized_keys"),
    ).toBe(true);
  });

  test("__proto__ as a JSON key is rejected as an unrecognized key, and never touches the real prototype", () => {
    const line =
      '{"ts":"2026-09-04T10:12:00Z","id":"01M1RRC3FBMZYZS4SNMYZHJV6R","actor":"alice","ticket":"ck-1","event":"release","__proto__":{"polluted":true}}';
    const result = parseEvent(line);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("constructor as a JSON key is rejected as an unrecognized key", () => {
    const result = parse(
      envelope({ event: "release", constructor: { evil: true } }),
    );
    expect(result.ok).toBe(false);
  });

  test("an unrecognized key on a kind-specific field set is also rejected", () => {
    const result = parse(
      envelope({ event: "claim", lease_until: LEASE_UNTIL, sneaky: 1 }),
    );
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// Fix round 1, finding H1 — failure messages never echo attacker-controlled
// bytes back to a terminal or --json consumer.
// ============================================================================

describe("fix round 1 H1 — rejection messages do not republish untrusted bytes", () => {
  test("an unrecognized key containing an ANSI escape sequence does not appear in the failure message", () => {
    const evilKey = "\x1b[2K\x1b[1A\x1b[31mck-1 released by alice\x1b[0m";
    const result = parseEvent(
      JSON.stringify(envelope({ event: "release", [evilKey]: 1 })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const allText = JSON.stringify(result.error);
    expect(allText).not.toContain("\x1b");
    expect(allText).not.toContain("released by alice");
    expect(
      result.error.issues.some(
        (i) =>
          i.code === "unrecognized_keys" &&
          i.message === "event carries 1 unrecognized key",
      ),
    ).toBe(true);
  });

  test("a 200KB unrecognized key does not blow up the failure message size", () => {
    const hugeKey = "k".repeat(200_000);
    const result = parseEvent(
      JSON.stringify(envelope({ event: "release", [hugeKey]: 1 })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const issue = result.error.issues.find(
      (i) => i.code === "unrecognized_keys",
    );
    expect(issue).toBeDefined();
    expect((issue?.message.length ?? 0) < 100).toBe(true);
  });

  test("malformed JSON containing an ANSI escape sequence does not appear in the failure message", () => {
    const line = `{"ticket": "${"\x1b[2K\x1b[1A\x1b[31mck-1 released by alice\x1b[0m"}" not valid json`;
    const result = parseEvent(line);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const allText = JSON.stringify(result.error);
    expect(allText).not.toContain("\x1b");
    expect(allText).not.toContain("released by alice");
  });

  test("a huge malformed-JSON line does not get echoed into the failure message", () => {
    const line = `${"x".repeat(500_000)} not json`;
    const result = parseEvent(line);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message.length < 100).toBe(true);
    expect(result.error.message).not.toContain("xxxxx");
  });
});

// ============================================================================
// Fix round 1, finding L5 / Ruling R14 — free-text fields deliberately
// still accept control characters; this locks in that decision so a future
// change doesn't silently narrow it (or silently narrow `actor`'s tighter
// guard the other way).
// ============================================================================

describe("fix round 1 L5 — free-text fields remain terminal-hostile by design", () => {
  test("comment.text, close.reason, hook.output/title, and move.from/to all still accept a raw ANSI escape", () => {
    const esc = "\x1b[31mhi\x1b[0m";
    expect(parse(envelope({ event: "comment", text: esc })).ok).toBe(true);
    expect(parse(envelope({ event: "close", reason: esc })).ok).toBe(true);
    expect(parse(envelope({ event: "hook", title: esc, output: esc })).ok).toBe(
      true,
    );
    expect(
      parse(envelope({ event: "move", from: esc, to: "In Review" })).ok,
    ).toBe(true);
  });

  test("actor does NOT get this treatment — the one field moved into the stricter id-shape guard (Ruling R14)", () => {
    expect(
      parse(envelope({ event: "release", actor: "\x1b[31mhi\x1b[0m" })).ok,
    ).toBe(false);
  });
});

// ============================================================================
// Fix round 1, finding M3 — length bounds on free-text fields.
// ============================================================================

describe("fix round 1 M3 — free-text fields are bounded", () => {
  test("a 64MB comment.text is rejected — previously accepted in 32ms", () => {
    const huge = "a".repeat(64 * 1024 * 1024);
    const result = parse(envelope({ event: "comment", text: huge }));
    expect(result.ok).toBe(false);
  });

  test("a comment.text at the 10,000-character bound is accepted, one over is rejected", () => {
    expect(
      parse(envelope({ event: "comment", text: "a".repeat(10_000) })).ok,
    ).toBe(true);
    expect(
      parse(envelope({ event: "comment", text: "a".repeat(10_001) })).ok,
    ).toBe(false);
  });

  test("a 32MB close.reason is rejected", () => {
    const huge = "a".repeat(32 * 1024 * 1024);
    expect(parse(envelope({ event: "close", reason: huge })).ok).toBe(false);
  });

  test("a 32MB hook.output is rejected", () => {
    const huge = "a".repeat(32 * 1024 * 1024);
    expect(
      parse(envelope({ event: "hook", title: "x", output: huge })).ok,
    ).toBe(false);
  });

  test("hook.output at the 100,000-character bound is accepted, one over is rejected", () => {
    expect(
      parse(
        envelope({ event: "hook", title: "x", output: "a".repeat(100_000) }),
      ).ok,
    ).toBe(true);
    expect(
      parse(
        envelope({ event: "hook", title: "x", output: "a".repeat(100_001) }),
      ).ok,
    ).toBe(false);
  });

  test("an oversized move column name is rejected", () => {
    expect(
      parse(envelope({ event: "move", from: "a".repeat(201), to: "In Review" }))
        .ok,
    ).toBe(false);
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
// Fix round 3 (Ruling R31/R32, orchestrator security review): an explicit
// `null` options argument must not throw a raw TypeError
// ============================================================================

describe("parseEvent — fix round 3: an explicit null options argument is normalized, not a raw TypeError", () => {
  test("parseEvent(line, null) behaves exactly like parseEvent(line) — never throws", () => {
    const line = JSON.stringify(envelope({ event: "release" }));
    // Before the fix: a default parameter does not apply to an explicit
    // `null` — `options.now` on a `null` options argument threw a raw
    // `TypeError`, violating this function's own documented contract
    // ("never throws").
    const result = parseEvent(line, null);
    expect(result.ok).toBe(true);
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

  test("Event is the union of all thirteen kinds", () => {
    const kinds = new Set<Event["event"]>(EVENT_KINDS);
    expect(kinds.size).toBe(13);
  });
});
