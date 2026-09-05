/**
 * This module's own error codes (M2.18 brief §1). Declared inside `actor/`,
 * never appended to the root `src/errors.ts` -- `packages/core/test/index.test.ts`
 * asserts the root export key set exactly, and a new flat root export would
 * fail it. Mirrors `config/errors.ts`'s pattern: a leaf file with no
 * imports of its own, re-exported flat from `actor/index.ts`.
 */
export const ActorErrorCodes = {
  /**
   * A raw string handed to `parseActor` (directly, or internally while
   * resolving one rung's config/flag/git value) does not satisfy the
   * grammar `[ tool ":" ] name [ "/" context ]` -- R-9. Also raised for a
   * `parent` value that parses but is not a bare name (R-10).
   */
  ACTOR_INVALID: "ACTOR_INVALID",
  /**
   * `resolveActor` walked every rung -- `--actor` flag, `CANKAN_ACTOR`,
   * `.cankan/local.yml`'s `actor`, global `identity.name`, `git user.name`
   * -- and none of them produced an identity. R-4: CONCEPT §3's append-only
   * event log makes a guessed default a permanent misattribution, so this
   * is always a typed error, never a silent fallback.
   */
  ACTOR_UNRESOLVED: "ACTOR_UNRESOLVED",
} as const;
