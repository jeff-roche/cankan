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

Publish scoped as `@cankan/cli` instead of unscoped `cankan`. The `bin`
field still names the installed command `cankan`; only the npm package
identity is scoped. `npx cankan`/`bunx cankan` (bare) will not work -
users run `npx @cankan/cli` or install with `npm i -g @cankan/cli` and
then run `cankan`.

PLAN.md's M0.5, M5.1, and M5.4 were updated to reference `@cankan/cli`
and the scoped invocation.

## Alternatives considered

- **Appeal to npm support:** npm does grant exceptions for legitimate
  distinct names, but the timeline is unpredictable and blocks nothing
  else in the meantime - not worth gating M0 on.
- **Rename the npm package (e.g. `cankan-cli`) while keeping it
  unscoped:** avoids the scope entirely, but doesn't restore bare
  `npx cankan` either (npx's zero-arg form requires an exact package-name
  match), so it buys nothing over scoping and adds a second name to track.
- **Publish under the personal scope `@jeff-roche/cankan`:** works today
  with no org needed, but ties the package identity to one person's
  account rather than a project-owned scope.

## Consequences

- The `@cankan` npm scope must be owned by an npm Organization named
  `cankan` (or a personal account literally named `cankan`) before the
  placeholder publish can succeed - creating that org is a manual step on
  npmjs.com.
- Docs, README, and `init`/`doctor` messaging (M5.3, M3.9) should say
  `npx @cankan/cli` / `npm i -g @cankan/cli`, never bare `cankan`, when
  telling users how to install.
