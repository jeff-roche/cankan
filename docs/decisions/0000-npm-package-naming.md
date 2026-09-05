# 0000: npm package naming

## Status

Accepted (2026-09-04).

## Context

PLAN.md's M0.5/M5.1 called for reserving and publishing the unscoped npm
package `cankan`, so `npx cankan`/`bunx cankan` work with no scope.

`npm publish` for the unscoped name `cankan` was rejected:

```
403 Forbidden - PUT https://registry.npmjs.org/cankan - Package name too
similar to existing package canvas; try renaming your package to
'@jeff-roche/cankan' and publishing with 'npm publish --access=public'
instead
```

This is npm's automated name-similarity policy, not an availability or
permissions problem - `cankan` itself is unclaimed.

## Decision

Publish scoped under the personal npm scope as `@jeff-roche/cankan-cli`
instead of unscoped `cankan`. The `bin` field still names the installed
command `cankan`; only the npm package identity is scoped and
disambiguated with a `-cli` suffix. `npx cankan`/`bunx cankan` (bare) will
not work - users run `npx @jeff-roche/cankan-cli` or install with
`npm i -g @jeff-roche/cankan-cli` and then run `cankan`.

The workspace package at `packages/cli` (previously `@cankan/cli`) is
renamed to `@jeff-roche/cankan-cli` to match - npm publishes under
whatever name is literally in `package.json`, so the workspace name and
the published name must be identical. `packages/mcp`'s dependency on it
was updated to match. `packages/core`, `packages/mcp`, and
`packages/backers` keep the `@cankan/*` scope for now; only the CLI's
public npm identity changed.

**Update, 2026-09-04:** "for now" ended. The `@cankan` scope is not owned
on npm and never will be, so every workspace package was renamed to
`@jeff-roche/cankan-*` — `core`, `mcp`, `backers`, `test-utils`. This
closes the risk flagged in Consequences below: a published CLI can no
longer carry a dependency on an unownable scope. Nothing else about the
decision changed.

PLAN.md's M0.5, M5.1, and M5.4 were updated to reference
`@jeff-roche/cankan-cli` and the scoped invocation.

## Alternatives considered

- **Appeal to npm support:** npm does grant exceptions for legitimate
  distinct names, but the timeline is unpredictable and blocks nothing
  else in the meantime - not worth gating M0 on.
- **Create an npm Organization named `cankan`, publish as `@cankan/cli`:**
  keeps the package identity project-owned rather than tied to one
  person's account, but needs a manual org-creation step on npmjs.com
  before anything can be published. Superseded by this decision.
- **Rename the npm package (e.g. `cankan-cli`) while keeping it
  unscoped:** avoids the scope entirely, but doesn't restore bare
  `npx cankan` either (npx's zero-arg form requires an exact package-name
  match), so it buys nothing over scoping and adds a second name to track.

## Consequences

- Publishing needs only `npm login` as `jeff-roche` - no npm Organization
  to create first.
- ~~If `@cankan/core` (a runtime dependency of the CLI once M2 exists) is
  never published to any registry, `npm install @jeff-roche/cankan-cli`
  will fail to resolve it for anyone outside this workspace - M5.1 must
  either bundle `@cankan/core` into the published/compiled artifact (no
  separate registry fetch needed) or also publish it under an owned
  scope. Flagging now so M5.1 doesn't rediscover this from scratch.~~
  **Closed 2026-09-04** by renaming every package into `@jeff-roche/cankan-*`
  (see the update above). M5.1 still chooses whether to bundle the core or
  publish it separately, but both options are now available — the scope is
  owned either way, so the dependency is resolvable rather than broken.
- Docs, README, and `init`/`doctor` messaging (M5.3, M3.9) should say
  `npx @jeff-roche/cankan-cli` / `npm i -g @jeff-roche/cankan-cli`, never
  bare `cankan`, when telling users how to install.
- If the project later wants a project-owned (rather than personal)
  package identity, revisit the npm-Organization path above - nothing
  here forecloses it, it just isn't worth the extra step today.
