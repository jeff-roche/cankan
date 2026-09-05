import { describe, expect, test } from "bun:test";
import {
  CanKanError,
  ErrorCodes,
  isCanKanError,
  type SerializedCanKanError,
} from "../src/errors";
import type { Equal, Expect, IsAssignable } from "./typeLevel";

type SeededCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ErrorTypeAssertions = [
  // A `CanKanError` is an `Error`, so it works with every `catch` and every
  // API that takes an `Error`.
  Expect<Equal<IsAssignable<CanKanError, Error>, true>>,
  // `code` stays an open `string`: six later lanes declare their own codes in
  // their own folders, and a closed union here would make each of them edit
  // this shared file.
  Expect<Equal<CanKanError["code"], string>>,
  Expect<Equal<IsAssignable<SeededCode, string>, true>>,
  Expect<Equal<IsAssignable<"A_LATER_LANES_CODE", CanKanError["code"]>, true>>,
  // `details` is an optional, open, caller-supplied bag.
  Expect<
    Equal<CanKanError["details"], Readonly<Record<string, unknown>> | undefined>
  >,
  // Exactly the six codes CONCEPT.md's exit-code map names, no more.
  Expect<
    Equal<
      keyof typeof ErrorCodes,
      | "GENERIC_ERROR"
      | "USAGE"
      | "CLAIM_REJECTED"
      | "SYNC_CONFLICT"
      | "POLICY_VIOLATION"
      | "BACKER_UNAVAILABLE"
    >
  >,
  // `toJSON` returns exactly the four documented fields — `cause` and `stack`
  // are excluded by construction, not by convention.
  Expect<Equal<ReturnType<CanKanError["toJSON"]>, SerializedCanKanError>>,
  Expect<
    Equal<keyof SerializedCanKanError, "name" | "code" | "message" | "details">
  >,
];

describe("ErrorCodes", () => {
  test("seeds exactly the six codes CONCEPT.md's exit-code map names", () => {
    expect(Object.keys(ErrorCodes).sort()).toEqual([
      "BACKER_UNAVAILABLE",
      "CLAIM_REJECTED",
      "GENERIC_ERROR",
      "POLICY_VIOLATION",
      "SYNC_CONFLICT",
      "USAGE",
    ]);
  });

  test("names every code after itself, with no digit anywhere in ErrorCodes", () => {
    for (const [key, value] of Object.entries(ErrorCodes)) {
      expect<string>(value).toBe(key);
    }
    expect(JSON.stringify(ErrorCodes)).not.toMatch(/[0-9]/);
  });
});

describe("CanKanError", () => {
  test("carries its code and message and is a real Error", () => {
    const error = new CanKanError(ErrorCodes.USAGE, "unknown flag --wat");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("USAGE");
    expect(error.message).toBe("unknown flag --wat");
    expect(error.name).toBe("CanKanError");
    expect(error.stack).toBeTypeOf("string");
  });

  test("accepts a code no module has declared yet", () => {
    // The open `code` type is the point: a later lane declares its own codes
    // in its own folder without editing this shared file.
    const error = new CanKanError("REF_INVALID", "bad coordination ref");

    expect(error.code).toBe("REF_INVALID");
  });

  test("preserves cause as the native ES2022 Error.cause", () => {
    const cause = new Error("ENOENT: no such file");
    const error = new CanKanError(
      ErrorCodes.GENERIC_ERROR,
      "could not read the board",
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  test("leaves cause undefined when none is given", () => {
    const error = new CanKanError(ErrorCodes.GENERIC_ERROR, "no cause here");

    expect(error.cause).toBeUndefined();
  });

  test("round-trips a structured details bag", () => {
    const details = { pinnedBy: "/srv/api/.cankan/config.yml", key: "wip" };
    const error = new CanKanError(
      ErrorCodes.POLICY_VIOLATION,
      "wip is pinned",
      { details },
    );

    expect(error.details).toEqual(details);
    expect(error.details?.pinnedBy).toBe("/srv/api/.cankan/config.yml");
  });

  test("leaves details undefined when none is given", () => {
    const error = new CanKanError(ErrorCodes.CLAIM_REJECTED, "already held");

    expect(error.details).toBeUndefined();
  });

  test("copies and freezes details, so mutating the caller's object cannot reach a thrown error", () => {
    const details: Record<string, unknown> = { key: "wip" };
    const error = new CanKanError(
      ErrorCodes.POLICY_VIOLATION,
      "wip is pinned",
      { details },
    );

    details.key = "mutated";
    details.token = "ghp_secret";

    expect(error.details).toEqual({ key: "wip" });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  test("takes its name from the constructor, so a subclass reports its own", () => {
    class ClaimRejectedError extends CanKanError {}

    expect(new CanKanError(ErrorCodes.USAGE, "bad flag").name).toBe(
      "CanKanError",
    );
    expect(new ClaimRejectedError(ErrorCodes.CLAIM_REJECTED, "held").name).toBe(
      "ClaimRejectedError",
    );
  });
});

describe("CanKanError.toJSON", () => {
  test("serializes exactly name, code, message and details", () => {
    const error = new CanKanError(
      ErrorCodes.POLICY_VIOLATION,
      "wip is pinned",
      {
        details: { pinnedBy: "/srv/api/.cankan/config.yml" },
      },
    );

    expect(error.toJSON()).toEqual({
      name: "CanKanError",
      code: "POLICY_VIOLATION",
      message: "wip is pinned",
      details: { pinnedBy: "/srv/api/.cankan/config.yml" },
    });
  });

  test("omits details entirely when there are none", () => {
    const error = new CanKanError(ErrorCodes.USAGE, "unknown flag --wat");

    expect(error.toJSON()).toEqual({
      name: "CanKanError",
      code: "USAGE",
      message: "unknown flag --wat",
    });
    expect("details" in error.toJSON()).toBe(false);
  });

  test("keeps message in JSON.stringify and keeps cause and stack out", () => {
    // Without toJSON, JSON.stringify drops `message` (non-enumerable on
    // Error) while still publishing `details` — the exact shape M3.10's
    // `--json` renderer would otherwise inherit.
    const error = new CanKanError(
      ErrorCodes.BACKER_UNAVAILABLE,
      "github rejected the token",
      {
        cause: new Error("401 Unauthorized: ghp_secret is expired"),
        details: { host: "api.github.com" },
      },
    );

    const serialized = JSON.parse(JSON.stringify(error)) as Record<
      string,
      unknown
    >;

    expect(serialized).toEqual({
      name: "CanKanError",
      code: "BACKER_UNAVAILABLE",
      message: "github rejected the token",
      details: { host: "api.github.com" },
    });
    expect(JSON.stringify(error)).not.toContain("ghp_secret");
    expect(JSON.stringify(error)).not.toContain("stack");
  });
});

describe("isCanKanError", () => {
  test("accepts a CanKanError and narrows it", () => {
    const thrown: unknown = new CanKanError(
      ErrorCodes.SYNC_CONFLICT,
      "diverged",
    );

    expect(isCanKanError(thrown)).toBe(true);
    if (!isCanKanError(thrown)) {
      throw new Error("guard should have narrowed the value");
    }
    // Reachable only through the narrowing, so this line is also a
    // compile-time assertion that the guard is a type predicate.
    expect(thrown.code).toBe("SYNC_CONFLICT");
  });

  test("rejects a plain Error, nullish values, and a lookalike object", () => {
    expect(isCanKanError(new Error("plain"))).toBe(false);
    expect(isCanKanError(new TypeError("also plain"))).toBe(false);
    expect(isCanKanError(null)).toBe(false);
    expect(isCanKanError(undefined)).toBe(false);
    expect(isCanKanError({ code: "USAGE", message: "lookalike" })).toBe(false);
    expect(isCanKanError("USAGE")).toBe(false);
  });

  test("rejects a prototype-only instance that never ran the constructor", () => {
    // `instanceof` alone accepts this, leaving `code` undefined — a caller
    // that narrowed with the guard would then index an exit-code map with
    // `undefined`.
    const uninitialized: unknown = Object.create(CanKanError.prototype);

    expect(uninitialized).toBeInstanceOf(CanKanError);
    expect(isCanKanError(uninitialized)).toBe(false);
  });

  test("accepts a subclass of CanKanError", () => {
    // Later lanes may subclass; the guard must not narrow them away.
    class ClaimRejectedError extends CanKanError {
      constructor(holder: string) {
        super(ErrorCodes.CLAIM_REJECTED, "already held", {
          details: { holder },
        });
      }
    }

    const error: unknown = new ClaimRejectedError("alice");

    expect(isCanKanError(error)).toBe(true);
  });
});
