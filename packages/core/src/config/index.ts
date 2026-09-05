/**
 * `config/index.ts` -- the frozen public surface of M2.3 (contract §1).
 * Re-exports exactly what the contract lists; nothing else is public.
 * M2.4 (board resolver), M2.16 (hooks runner), and M2.18 (actor identity)
 * freeze against this shape starting next round.
 *
 * Never import through `../index` (the package root) from inside this
 * folder -- that creates a cycle in which `CanKanError` reads as
 * `undefined` at module scope. `layers.ts` and `resolve.ts` import
 * `../errors`/`../types` directly instead.
 */

// ---- layer identity, attribution, the result, the entry point -------------
export type { ConfigLayer, LoadedLayer } from "./layers";
export type { ConfigResult, LoadConfigOptions, ResolvedEntry } from "./resolve";
export { loadConfig } from "./resolve";

// ---- schemas and their inferred types --------------------------------------
export type { EffectiveConfig, GlobalConfig, LocalConfig, RepoConfig } from "./schema";
export {
  effectiveConfigSchema,
  globalConfigSchema,
  localConfigSchema,
  repoConfigSchema,
} from "./schema";

// ---- the policy-vs-preference classification table -------------------------
export { classifyKey, KEY_CLASSIFICATION, UNCLASSIFIED_KEYS } from "./keys";

// ---- this module's own error codes (contract §7) ---------------------------
export { ConfigErrorCodes } from "./errors";
