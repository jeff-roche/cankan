/**
 * `@jeff-roche/cankan-core` — the single public entry point.
 *
 * FROZEN AFTER M2.1. Every later M2 task registers its public surface in its
 * own folder's `index.ts` (e.g. `src/config/index.ts`), never here. Because
 * each folder is re-exported as a whole namespace, this file needs no edit
 * when a folder's `index.ts` grows from `export {};` to a real surface —
 * that is what makes the remaining M2 rounds parallelizable across lanes.
 * Editing this file is a merge conflict with every other lane.
 *
 * Exports flow up to here; imports must never flow back through it. Inside a
 * module, import `../errors` and `../types` directly, and a sibling module by
 * its own path (`../config/resolve`) — never `../index`. Importing the root
 * from a module the root re-exports makes a cycle (`index → state → index`);
 * ESM permits it, but a class such as `CanKanError` referenced at module
 * scope is then still in its temporal dead zone and reads as `undefined`.
 *
 * The thirteen module folders are re-exported **namespaced** rather than
 * flat: thirteen flat `export *`s would collide the moment two folders
 * export the same name, which is already scheduled to happen (M2.3 creates
 * `config/resolve.ts`, M2.4 creates `board/resolve.ts`). Namespacing also
 * makes `import * as core from "@jeff-roche/cankan-core"` expose the folders
 * directly, which is this task's "Done when".
 *
 * `errors.ts` and `types.ts` are re-exported **flat**: `CanKanError`,
 * `BoardRef` and the ID types are the shared vocabulary every lane names
 * directly, and two files cannot collide with a namespace.
 *
 * Every folder re-export uses the explicit `./<folder>/index` form. That is
 * required, not stylistic: one of the folders is named `index/`, and from
 * inside this file the specifier `"./index"` would resolve to this file
 * itself rather than to `src/index/index.ts`. The explicit form keeps the
 * whole block uniform and `index/` unambiguous.
 */

export * as actor from "./actor/index";
export * as board from "./board/index";
export * as claims from "./claims/index";
export * as config from "./config/index";
export * as deps from "./deps/index";
export * from "./errors";
export * as events from "./events/index";
export * as git from "./git/index";
export * as hooks from "./hooks/index";
export * as index from "./index/index";
export * as order from "./order/index";
export * as state from "./state/index";
export * as store from "./store/index";
export * as ticket from "./ticket/index";
export * from "./types";
