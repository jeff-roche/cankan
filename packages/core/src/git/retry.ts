/**
 * The generic bounded-retry mechanism behind CAS contention (ADR
 * 0001:616-629, "Retry/backoff policy on CAS contention").
 *
 * **Scope, per the phase's R2 ruling: mechanism only.** This module owns
 * distinguishing a genuine CAS rejection from a hard failure
 * (`updateRefCAS`'s return type does that) and this bounded, backed-off
 * retry loop around a caller-supplied callback. It does **not** implement
 * "re-read the ref and re-check the claim state before retrying the write" —
 * that half needs the event schema (M2.7's `events/schema.ts`), which this
 * module may not import (PLAN.md rule 2: a task may only import from its
 * declared dependencies). The callback passed to `withCasRetry` is where
 * that re-check belongs; this driver only counts attempts and sleeps
 * between them.
 */

import { CanKanError } from "../errors";
import { GitErrorCodes } from "./errors";

/** One attempt's result: either a final value, or "try again." */
export type CasAttemptResult<T> =
  | { readonly done: true; readonly value: T }
  | { readonly done: false };

export interface CasRetryOptions {
  /**
   * Attempt cap before surfacing `GIT_CAS_CONTENTION_EXCEEDED`. Defaults to
   * 50 (ADR 0001:622-629: "reasoned, not measured" — the spike's 3-worker
   * races never needed more than 2). Injectable so a contention-exceeded
   * test runs in milliseconds rather than exhausting 50 real backoff waits.
   */
  readonly maxAttempts?: number;
  /** Backoff before the next attempt, given the attempt number just made. */
  readonly backoffMs?: (attemptNumber: number) => number;
  /** Injectable so tests need not wait out a real backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 50;

function defaultBackoffMs(attemptNumber: number): number {
  const capped = Math.min(1000, 10 * 2 ** attemptNumber);
  // Full jitter: uniform in [0, capped), so concurrent losers don't retry in
  // lockstep.
  return Math.floor(Math.random() * capped);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `attempt` up to `maxAttempts` times, sleeping a jittered backoff
 * between attempts, until it reports `done: true`. Throws
 * `GIT_CAS_CONTENTION_EXCEEDED` if the cap is reached without success.
 *
 * `attempt` receives the 1-based attempt number and does the real work: run
 * (or re-run) the CAS, and — per the ADR's mandated policy, which lives in
 * the caller because it needs the event schema — re-read the ref and
 * re-check whatever state makes retrying the write meaningful before
 * reporting `{ done: false }`.
 */
export async function withCasRetry<T>(
  attempt: (attemptNumber: number) => Promise<CasAttemptResult<T>>,
  options: CasRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const sleep = options.sleep ?? defaultSleep;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    const result = await attempt(attemptNumber);
    if (result.done) {
      return result.value;
    }
    if (attemptNumber < maxAttempts) {
      await sleep(backoffMs(attemptNumber));
    }
  }

  throw new CanKanError(
    GitErrorCodes.GIT_CAS_CONTENTION_EXCEEDED,
    `CAS contention exceeded after ${maxAttempts} attempts`,
    { details: { maxAttempts } },
  );
}
