/**
 * Ambient module declaration for `*.sql` text imports (F3, controller
 * fact, verified end to end).
 *
 * `db.ts` imports `schema.sql` as `import schema from "./schema.sql" with
 * { type: "text" };`. Bun 1.4.0 supports that import at runtime and under
 * `bun test` (F1) -- but `tsc` does not know what a `.sql` specifier
 * resolves to and rejects it on its own with `TS2307: Cannot find module
 * './schema.sql'` (F2). This ambient declaration is what makes `bun run
 * typecheck`, `bun test` and `bun run lint` all pass with that import
 * (F3) -- verified by running all three, not assumed from Bun's docs.
 */
declare module "*.sql" {
  const contents: string;
  export default contents;
}
