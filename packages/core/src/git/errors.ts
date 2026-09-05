/**
 * Module-local error codes for `git/`, per `../errors.ts`'s file-level
 * comment: `CanKanError.code` is a plain, open `string`, and a code specific
 * to one module's domain is declared in that module's own folder rather than
 * in the shared `errors.ts`. None of the six seeded `ErrorCodes` fits any of
 * these — they are all specific to "a git invocation failed in a way this
 * adapter must distinguish," which is exactly this module's domain.
 *
 * Prefixed `GIT_` because thirteen module folders share one open code space
 * (`../errors.ts`) and a collision between two modules' unprefixed codes
 * would be silent — `code` is a plain string, not a namespaced union.
 */
export const GitErrorCodes = {
  /**
   * A ref failed validation against `^refs/cankan/[A-Za-z0-9._/-]+$` and/or
   * `git check-ref-format` (ADR 0001:336-390, R6), or is a symbolic ref
   * pointing outside `refs/cankan/` (fix-round-1 F1 — a ref's *name* passing
   * both checks does not mean the ref itself isn't a symlink to something
   * else). Raised before any git invocation reachable from the rejected
   * value.
   */
  GIT_REF_INVALID: "GIT_REF_INVALID",
  /**
   * A `newSha`, `oldSha`, or `parent` was not a 40-hex object id
   * (fix-round-1 F2). `git update-ref` accepts any revision expression, not
   * only an object id, so a caller passing e.g. `"HEAD"` or
   * `"refs/heads/main"` as a `Sha` would otherwise defeat the CAS at
   * runtime — the compile-time `RefSha`/`ObjectSha` brands alone do not stop
   * this, since a brand carries no runtime guarantee. Raised before the
   * value reaches argv.
   */
  GIT_SHA_INVALID: "GIT_SHA_INVALID",
  /**
   * The one-time `git rev-parse --show-toplevel` bootstrap failed: not a git
   * repository, or a bare repository with no working tree (ADR 0001:453-457).
   */
  GIT_BOOTSTRAP_FAILED: "GIT_BOOTSTRAP_FAILED",
  /**
   * `readBlobFromRef` was asked to resolve a ref that does not exist. The
   * ADR's failure mode 6 makes checking `readRef` first the caller's job; a
   * caller that skips that check gets a hard error here rather than this
   * function silently reusing the "no entry" `null` for a different failure
   * (the exact fail-open shape failure mode 8(b) exists to prevent).
   */
  GIT_REF_NOT_FOUND: "GIT_REF_NOT_FOUND",
  /**
   * `readBlobFromRef`'s `ls-tree` three-way check landed on "anything else":
   * more than one entry, a path that doesn't match byte-for-byte, or a mode
   * other than `100644` (ADR 0001:486-601). Aborts the caller's operation.
   */
  GIT_BLOB_AMBIGUOUS: "GIT_BLOB_AMBIGUOUS",
  /**
   * Any git invocation failed in a way that is not one of the typed outcomes
   * this module discriminates (CAS rejection, non-fast-forward push/fetch
   * rejection). `cause` is a plain `Error` built only from git's own stderr
   * text — never an object carrying argv — and is attached as `cause` only,
   * never copied into `message` or `details` (M2.1's credential finding,
   * closed by construction per fix-round-1 F3: this module's transport
   * never produces an error object with a `util.inspect`-visible argv
   * property in the first place).
   */
  GIT_COMMAND_FAILED: "GIT_COMMAND_FAILED",
  /**
   * The CAS retry driver (`withCasRetry`) exhausted its attempt budget
   * without the caller-supplied callback reporting success (ADR 0001:616-629).
   */
  GIT_CAS_CONTENTION_EXCEEDED: "GIT_CAS_CONTENTION_EXCEEDED",
} as const;
