# CanKan repository instructions

## Verification

- Use Bun 1.4.x; CI installs dependencies with `bun install --frozen-lockfile`.
- Run checks in CI order: `bun run lint`, `bun run typecheck`, then `bun run test`.
- Run one focused test with `bun test packages/core/test/ticket/id.test.ts` (replace the path as needed); packages do not define their own test scripts.
- Build all workspace packages with `bun run build`; build output is generated under each package's `dist/` and is ignored.
- Use `bun run --filter @jeff-roche/cankan-core typecheck` or the equivalent workspace package name for a focused typecheck.

## Structure

- This is a Bun workspace under `packages/*`: `core` owns domain logic, `cli` depends on `core`, `mcp` depends on `cli`, `backers` depends on `core`, and `test-utils` provides shared test helpers.
- Package source entrypoints are each package's `src/index.ts`; tests live beside the package in `test/`, primarily under `packages/core/test`.
- GitHub Issues are the work-tracking source of truth from MB.3 onward; use the task IDs and dependencies defined by `PLAN.md` when locating work.
- `PLAN.md` is the ownership and dependency source of truth: do not consume an artifact from a task unless its creating task is listed in `Depends on`.

## Core boundaries

- `packages/core/src/index.ts` is a frozen, namespaced public export boundary. Add a module's public exports to that module's own `src/<module>/index.ts`, not by casually changing the root barrel.
- Internal core modules must import sibling modules directly (for example `../errors` or `../config/resolve`), never through `packages/core/src/index.ts`; importing the root barrel internally can create ESM cycles and temporal-dead-zone failures.
- Keep shared `CanKanError`, types, and module APIs aligned with the existing namespaced exports; avoid flattening module exports because names collide across folders.

## Style

- Biome is authoritative: two-space indentation, double-quoted JavaScript strings, recommended lint rules, and import organization.
- TypeScript is strict, uses ES2022 and bundler module resolution; preserve the package `tsconfig` boundaries when adding files.
