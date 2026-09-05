import { describe, expect, test } from "bun:test";
import { CanKanError, ErrorCodes, isCanKanError } from "../src/errors";
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

  test("records no exit-code numbers — M3.10 owns that mapping", () => {
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
