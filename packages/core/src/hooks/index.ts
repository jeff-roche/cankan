/**
 * `hooks/index.ts` -- the public surface of M2.16 (mirroring
 * `config/index.ts`'s pattern). Re-exports exactly what M2.17 (round 6,
 * the `[wire]` task) needs to call `runHooks` and adapt `HookSink` to an
 * event-log-backed sink; nothing else is public.
 *
 * Not re-exported: `spawnHook` and its `HookSpawnRequest`/`HookExecutionResult`
 * types (the internal spawn chokepoint -- issue #86's future gate lives
 * there, not on the public surface), and `resolveHooksForEvent`/
 * `ResolvedHook` (an internal step). All four stay importable from
 * `./runner` directly for white-box testing, the same way `config/resolve.ts`'s
 * internals are.
 */

// ---- events and layer order -------------------------------------------
export { HOOK_EVENTS, HOOK_LAYER_ORDER, DEFAULT_HOOK_TIMEOUT_MS } from "./runner";
export type { HookEvent, HookLayer } from "./runner";

// ---- the runner and its shapes ------------------------------------------
export { runHooks } from "./runner";
export type { RunHooksOptions, HookOutcome, HookEventRecord, HookSink } from "./runner";

// ---- this module's own error codes (task brief §8) ----------------------
export { HooksErrorCodes } from "./errors";
