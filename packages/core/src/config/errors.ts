/**
 * This module's own error codes (contract §7). Declared inside `config/`,
 * never appended to the root `src/errors.ts` — `packages/core/test/index.test.ts`
 * asserts the root export key set exactly, and a new flat root export would
 * fail it.
 *
 * Kept in its own tiny file rather than written directly inside `index.ts`
 * (even though the brief's wording for `index.ts` reads "declared here"),
 * because both `layers.ts` and `resolve.ts` need to construct
 * `CanKanError`s using this code, and `index.ts` itself imports from both of
 * them to build the public surface. If the constant lived in `index.ts`,
 * `layers.ts`/`resolve.ts` importing it back from `./index` would create the
 * exact same same-folder temporal-dead-zone cycle the root `src/index.ts`
 * warns about for `../index` — just one level down. A leaf file with no
 * imports of its own avoids that entirely. `index.ts` still re-exports it
 * flat, so the public surface is identical either way.
 */
export const ConfigErrorCodes = {
  /**
   * A config layer failed to load for any reason this module itself
   * detects: the file exists but could not be read, a YAML syntax error
   * (R16 — message is always our own, never the library's), a schema
   * validation failure (R13 — including an out-of-namespace
   * `coordination.ref`, enforced in `schema.ts`'s regex, R14), a `!policy`
   * tag found outside `.cankan/config.yml` (R6), or a `CANKAN_*` override
   * whose value fails its target key's own schema (R9).
   */
  INVALID_CONFIG: "INVALID_CONFIG",
} as const;
