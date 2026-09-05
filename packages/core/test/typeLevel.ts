/**
 * Shared helpers for the compile-time assertions in this directory.
 *
 * Those assertions are checked by `tsc --noEmit -p tsconfig.test.json`, not
 * by `bun test` — bun strips types without checking them, so a type error in
 * a test file only surfaces under `bun run typecheck`.
 */

/** True only if `X` and `Y` are the same type, invariantly. */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** Fails to compile unless `T` is exactly `true`. */
export type Expect<T extends true> = T;

/** Whether a value of type `From` may be assigned to a `To`. */
export type IsAssignable<From, To> = [From] extends [To] ? true : false;
