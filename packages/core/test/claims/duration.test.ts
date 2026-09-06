import { describe, expect, test } from "bun:test";
import { isCanKanError } from "../../src/errors";
import { ClaimErrorCodes } from "../../src/claims/errors";
import { parseDurationMs } from "../../src/claims/duration";

function expectRejected(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    if (!isCanKanError(error)) {
      throw new Error(`expected a CanKanError, got ${String(error)}`);
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected a throw with code ${code}, but the call succeeded`);
}

describe("parseDurationMs", () => {
  test("parses every supported unit", () => {
    expect(parseDurationMs("1ms")).toBe(1);
    expect(parseDurationMs("5s")).toBe(5_000);
    expect(parseDurationMs("2m")).toBe(120_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("3d")).toBe(259_200_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
  });

  test("rejects a zero-length duration — a live lease can never have zero TTL", () => {
    expectRejected(() => parseDurationMs("0h"), ClaimErrorCodes.INVALID_LEASE_DURATION);
    expectRejected(() => parseDurationMs("0ms"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects a negative duration", () => {
    expectRejected(() => parseDurationMs("-1h"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects an absurdly large duration that would blow past the trailing-months window", () => {
    expectRejected(() => parseDurationMs("999999999w"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects the empty string", () => {
    expectRejected(() => parseDurationMs(""), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects embedded whitespace", () => {
    expectRejected(() => parseDurationMs("2 h"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects an uppercase unit — the pattern is lowercase only", () => {
    expectRejected(() => parseDurationMs("2H"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects an unrecognized unit", () => {
    expectRejected(() => parseDurationMs("2y"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects scientific notation — not a valid \\d+ match", () => {
    expectRejected(() => parseDurationMs("1e3s"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("rejects a decimal amount", () => {
    expectRejected(() => parseDurationMs("1.5h"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  // Each row is wrapped as a 1-tuple (never a bare value) so bun's
  // `test.each` spreads exactly one argument per case regardless of the
  // value's own shape — an un-wrapped `[]` row would otherwise spread to
  // zero arguments and bun would mistake this callback's one declared
  // parameter for an async `done` callback, hanging the test.
  test.each([[123], [null], [undefined], [{}], [[]], [true]])("rejects a non-string input: %p", (value) => {
    expectRejected(() => parseDurationMs(value as unknown as string), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });

  test("accepts a lease exactly at the boundary (119 30-day months) and rejects one day past it", () => {
    // 119 * 30 days = 3570 days — see duration.ts's own MAX_LEASE_MS comment
    // for why this exact bound is where claim.ts's trailingMonths clamp
    // resolves to exactly 120.
    expect(parseDurationMs("3570d")).toBe(119 * 30 * 24 * 60 * 60 * 1000);
    expectRejected(() => parseDurationMs("3571d"), ClaimErrorCodes.INVALID_LEASE_DURATION);
  });
});
