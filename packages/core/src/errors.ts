/**
 * `CanKanError` — the one error type every CanKan module throws.
 *
 * `code` is a plain `string`, deliberately left open. Six later lanes each
 * introduce their own failure codes (M2.3's `POLICY_VIOLATION`, M2.6's
 * ref-validation codes, M2.10's claim-rejection codes, and more): each module
 * declares its own code constants in its own folder, never here. This file
 * seeds only the codes CONCEPT.md's exit-code map already names (CONCEPT.md
 * "Exit codes", ~line 575).
 *
 * This file does NOT build the code→exit-code mapping — that is M3.10's
 * `Creates`, and the numbers from CONCEPT.md's exit-code line are
 * deliberately not duplicated here so that mapping has one source of truth.
 */

/**
 * The exit-code-map failure codes seeded at M2.1. Every other module's error
 * codes live in that module's own folder (e.g. a future `config/errors.ts`),
 * not here.
 */
export const ErrorCodes = {
  GENERIC_ERROR: "GENERIC_ERROR",
  USAGE: "USAGE",
  CLAIM_REJECTED: "CLAIM_REJECTED",
  SYNC_CONFLICT: "SYNC_CONFLICT",
  POLICY_VIOLATION: "POLICY_VIOLATION",
  BACKER_UNAVAILABLE: "BACKER_UNAVAILABLE",
} as const;

/**
 * Options for constructing a `CanKanError`.
 *
 * `details` is an open, caller-supplied structured bag — e.g. M2.3's
 * `POLICY_VIOLATION` names the pinning file, M2.10's rejection names the
 * holder. It is not pre-sanitised for display; callers that surface it in
 * CLI output are responsible for that.
 */
export interface CanKanErrorOptions {
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}

/**
 * The typed error every CanKan module throws.
 *
 * `code` is a plain `string`, not a closed union — see the file-level
 * comment. `cause` is the native ES2022 `Error.cause` (this repo's
 * `tsconfig.base.json` sets `"lib": ["ES2022"]`), passed through via
 * `super(message, { cause })`; there is no separate `cause` property here.
 */
export class CanKanError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, options: CanKanErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "CanKanError";
    this.code = code;
    this.details = options.details;
  }
}

/**
 * Type guard distinguishing `CanKanError` from a plain `Error` (or anything
 * else). Implemented as a plain `instanceof` check: this is a bun workspace
 * with a single resolution of `@jeff-roche/cankan-core` (bun resolves the
 * `node_modules/@jeff-roche/cankan-core` symlink to one real module), so
 * there is no duplicated-module-instance hazard that would make
 * `instanceof` unreliable here. A `Symbol.for` brand fallback would add
 * complexity with no correctness benefit in this environment.
 */
export function isCanKanError(e: unknown): e is CanKanError {
  return e instanceof CanKanError;
}
