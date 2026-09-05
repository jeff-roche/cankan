/**
 * `CanKanError` — the one error type every CanKan module throws.
 *
 * `code` is a plain `string`, deliberately left open. This file seeds only
 * the codes CONCEPT.md's exit-code map already names (CONCEPT.md "Exit
 * codes", ~line 575). Later modules relate to those codes in two ways, and
 * neither one edits this file:
 *
 * - They **raise** a seeded code in their own domain — the config module
 *   raises `POLICY_VIOLATION` when a `!policy` pin is overridden, the claims
 *   module raises `CLAIM_REJECTED` when a ticket is already held.
 * - They **may additionally define** codes of their own, for failures the
 *   exit-code map does not name — ref validation against
 *   `docs/decisions/0001-coordination-ref.md`, say. Those constants belong
 *   in the defining module's own folder (e.g. a future `git/errors.ts`).
 *
 * A closed union here would force every one of those modules to edit this
 * shared file, and they are built concurrently.
 *
 * This file does NOT build the code→exit-code mapping — that is M3.10's
 * `Creates`, and the numbers from CONCEPT.md's exit-code line are
 * deliberately not duplicated here so that mapping has one source of truth.
 */

/**
 * The exit-code-map failure codes seeded at M2.1. Any code a module defines
 * beyond these lives in that module's own folder, not here.
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
 * holder.
 *
 * **`details` is published by default — treat it as user-visible output, not
 * as a debugging scratchpad.** `toJSON` deliberately includes it in JSON
 * output, so it reaches `--json` consumers; and because it is an own
 * enumerable property (unlike `message`, `cause` and `stack`), the
 * terminal's uncaught-error printer emits it regardless. So put in it only
 * values that are safe to show the user who ran the command — a config file
 * path they already know, the actor name holding a claim, a config key.
 * Never credentials, tokens, environment values, a backer's HTTP response
 * body, or anything copied out of `cause` — and note that `cause` leaks from
 * more than its `message`: a `simple-git` `GitError` carries the raw argv in
 * `cause.task.commands`, including a credential-bearing remote URL that
 * git's own stderr redacts. Copying a whole command line into `details` is
 * the easy path and the wrong one.
 *
 * Keep it flat: JSON primitives, or arrays of them. The constructor's freeze
 * is shallow, so a nested object stays aliased to the caller's and stays
 * mutable — no nested objects, no class instances, no getters, no BigInt.
 */
export interface CanKanErrorOptions {
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}

/** The serialized form of a `CanKanError` — see `CanKanError.toJSON`. */
export interface SerializedCanKanError {
  name: string;
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

/**
 * The typed error every CanKan module throws.
 *
 * `code` is a plain `string`, not a closed union — see the file-level
 * comment. `cause` is the native ES2022 `Error.cause` (this repo's
 * `tsconfig.base.json` sets `"lib": ["ES2022"]`), passed through via
 * `super(message, { cause })`; there is no separate `cause` property here.
 *
 * **`message` is published too** — `toJSON` always emits it and the terminal
 * always prints it — so build it from fixed text plus values you chose, and
 * never by interpolating `cause.message`. A `yaml` `YAMLParseError` quotes
 * the offending source line verbatim with a caret under it, so a syntax
 * error next to `personal.remote` in global config puts a credential-bearing
 * URL straight into the message.
 *
 * `details` is copied and frozen on construction, so a caller that mutates
 * the object it passed in cannot change an already-thrown error. Read the
 * exposure warning on `CanKanErrorOptions` before putting anything in it.
 */
export class CanKanError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, options: CanKanErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    // `new.target.name` so a subclass reports its own name rather than
    // inheriting "CanKanError"; identical for direct construction.
    this.name = new.target.name;
    this.code = code;
    this.details = options.details
      ? Object.freeze({ ...options.details })
      : undefined;
  }

  /**
   * The serialized form, so `JSON.stringify` is deliberate rather than
   * whatever the enumerable properties happen to be.
   *
   * Without this, `JSON.stringify(error)` drops `message` (it is
   * non-enumerable on `Error`) while still publishing `details` — a shape
   * that is both wrong for M3.10's `--json` renderer and quietly leakier
   * than it looks. `cause` and `stack` are deliberately excluded: a cause
   * chain routinely carries filesystem and HTTP internals that no user
   * asked to see.
   */
  toJSON(): SerializedCanKanError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/**
 * Type guard distinguishing `CanKanError` from a plain `Error` (or anything
 * else). Implemented as an `instanceof` check: each consumer's
 * `node_modules/@jeff-roche/cankan-core` is a per-package symlink that bun
 * resolves to the single `packages/core` directory, so there is no
 * duplicated-module-instance hazard that would make `instanceof` unreliable
 * here. A `Symbol.for` brand fallback would add complexity with no
 * correctness benefit in this environment.
 *
 * The `code` check is not redundant: `Object.create(CanKanError.prototype)`
 * satisfies `instanceof` while leaving `code` undefined, and a caller that
 * has narrowed with this guard is entitled to a `code` that is really there.
 */
export function isCanKanError(e: unknown): e is CanKanError {
  return e instanceof CanKanError && typeof e.code === "string";
}
