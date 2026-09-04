# CanKan implementation plan

Companion to `CONCEPT.md`. This document exists to answer one question for every piece of the system: **which task creates it, and which task connects it to its neighbors.** No task may assume something exists unless the ownership matrix names a task that creates it and that task is listed as a dependency.

## Conventions

Every task has:
- **Creates** — artifacts that do not exist before this task and exist after it (packages, modules, files, refs, CI jobs). Only one task may create a given artifact.
- **Wires** — connections between existing pieces that this task is responsible for making work end-to-end. Plumbing is a deliverable, not a side effect.
- **Depends on** — tasks whose *Creates* this task consumes. If it's not listed, you can't use it.
- **Done when** — an observable check, ideally a test or command.

Task IDs are `M<milestone>.<n>`. Integration tasks are marked **[wire]**. Their only job is connecting pieces; they create nothing except tests and glue.

**This plan becomes GitHub issues, and this repo becomes a CanKan user.** MB (bootstrap) converts every task below into a GitHub issue using conventions chosen so that CanKan's GitHub backer imports them without translation later. Dogfooding happens in two stages: native tickets mirrored from the issues as soon as the CLI works (MB.4), then the real GitHub backer replacing the mirror (MB.5). From MB.4 onward, all work on CanKan — human or agent — is claimed through CanKan.

---

## Ownership matrix

Every piece of the system and the single task that creates it. If a piece isn't here, it doesn't exist yet and needs a task.

| Piece | Created by | Wired to neighbors by |
|---|---|---|
| GitHub repo, branch protection, remote | M0.1 | — |
| Issue conventions doc (`docs/issue-conventions.md`) | MB.1 | MB.2 |
| Labels + milestones in GitHub | MB.1 | — |
| `scripts/plan-to-issues.ts` (PLAN.md → issues via `gh`) | MB.2 | **MB.3 [wire]** |
| Issues created, dependency links resolved | **MB.3 [wire]** | — |
| `scripts/issues-to-tickets.ts` (temporary mirror, deleted in MB.5) | MB.4 | **MB.4 [wire]** |
| This repo's `.cankan/` config, queues, agent instructions | MB.4 | — |
| Dogfood cutover to GitHub backer; mirror script removed | **MB.5 [wire]** | — |
| Monorepo skeleton (`packages/*`, workspaces, `tsconfig`) | M0.2 | — |
| Lint/format/typecheck config (biome, tsc) | M0.3 | M0.6 (CI) |
| Test harness + git fixture helper | M0.4 | M0.6 (CI) |
| Changesets + npm publish config | M0.5 | M0.6 (CI) |
| CI workflow (lint, typecheck, test, build, release) | M0.6 | — |
| Coordination-ref spike (throwaway) | M1.1 | — |
| Spike findings + go/no-go decision doc | M1.2 | — |
| Backlog.md ID-tolerance finding | M1.3 | — |
| Upstream issue on Backlog.md | M1.4 | — |
| `@cankan/core` package shell + public `index.ts` | M2.1 | M2.1 |
| Ticket schema (zod) + frontmatter parse/serialize | M2.2 | M2.5 (store) |
| Config schema + layer loader + policy resolution | M2.3 | M2.4 (board resolver), M3.1 (CLI context) |
| Board resolver (which directory is the board) + repo registry | M2.4 | M3.1 (CLI context) |
| Ticket store (read/write/list files on disk) | M2.5 | M2.8 (state fold) |
| Git adapter (`simple-git` wrapper: refs, worktrees, commit, orphan ref ops) | M2.6 | M2.7 (event log) |
| Event log (append, read, ULIDs, monthly files) on the coordination ref | M2.7 | M2.8 (state fold), M2.10 (claims) |
| Board state fold (tickets ⊕ events → `BoardState`) | M2.8 | **M2.9 [wire]** |
| Core smoke test: create ticket → event → fold → query | **M2.9 [wire]** | — |
| Claims: CAS, leases, renew, release, expire | M2.10 | M2.11 (ready) |
| Readiness + dependency graph + cycle detection | M2.11 | M2.12 (ordering) |
| Ordering: sort keys, `ordinal` rank, queue resolution | M2.12 | **M2.13 [wire]** |
| Concurrency test: N processes claim, exactly one wins | **M2.13 [wire]** | — |
| SQLite index + reindex | M2.14 | **M2.15 [wire]** |
| Index ↔ store/event-log invalidation | **M2.15 [wire]** | — |
| Hooks runner (`on <event>`) | M2.16 | **M2.17 [wire]** |
| Hooks fired from claims/move/close code paths | **M2.17 [wire]** | — |
| Actor identity resolution (config → git author → default) | M2.18 | M3.1 (CLI context) |
| `@cankan/cli` package shell, command registry, `--json/--plain` output layer | M3.1 | M3.1 |
| CLI context object (config + board + actor + core handle) | M3.1 | every M3 command |
| `init` command + detection | M3.2 | **M3.11 [wire]** |
| `config` commands | M3.3 | — |
| Ticket commands (`create show list edit move close reopen note dep archive search rank`) | M3.4 | — |
| Coordination commands (`ready claim renew release assign mine actors expire`) | M3.5 | — |
| `queue` commands | M3.6 | — |
| `board`, `events`, `render` | M3.7 | — |
| `prime` | M3.8 | — |
| `doctor` | M3.9 | — |
| Exit-code map + error formatting | M3.10 | M3.1 |
| CLI end-to-end test: `init` → `create` → `claim --next` → `close` in a temp repo | **M3.11 [wire]** | — |
| `@cankan/mcp` package shell + stdio server | M4.1 | M4.1 |
| Tool definitions generated from CLI command specs | **M4.2 [wire]** | — |
| MCP `--board` scoping + roots handling | M4.3 | — |
| MCP smoke test via SDK client | **M4.4 [wire]** | — |
| Agent instruction templates (`AGENTS.md`/`CLAUDE.md` sections) | M4.5 | **M4.6 [wire]** |
| `init` writes instructions + MCP config per agent tool | **M4.6 [wire]** | — |
| Personal board: lazy init at XDG path, `--board` flag, `cankan p` | M4.7 | **M4.8 [wire]** |
| Personal board reachable from every command; `move-to` | **M4.8 [wire]** | — |
| `BOARD.md` git hook + GitHub Action template | M4.9 | — |
| Backlog.md compatibility conformance test | **M4.10 [wire]** | — |
| Bin entry, `bunx`/`npx` shims, compiled binaries | M5.1 | M5.2 |
| Release pipeline (tag → npm + GitHub release assets) | M5.2 | — |
| README, CLI docs generated from command specs | M5.3 | — |
| Backer interface + mock backer + conformance suite | M6.1 | M6.1 |
| Sync engine (three-way merge, sync state, pull/push/status/resolve) | M6.2 | **M6.3 [wire]** |
| Sync engine driven by mock backer end-to-end | **M6.3 [wire]** | — |
| GitHub backer | M6.4 | **M6.6 [wire]** |
| Jira backer | M6.5 | **M6.6 [wire]** |
| Mixed-origin board acceptance test | **M6.6 [wire]** | — |
| beads backer | M6.7 | — |
| `import`, `adopt`, `sync` CLI + auto-push policy | M6.8 | **M6.9 [wire]** |
| Sync commands exercised against recorded HTTP fixtures | **M6.9 [wire]** | — |
| Cross-repo aggregation (`--board all`, `<repo>:<id>`) | M6.10 | **M6.11 [wire]** |
| Aggregation over 3 fixture repos + personal board | **M6.11 [wire]** | — |

---

## M0 — Repository and toolchain

### M0.1 Create the repository and remote
- **Creates:** GitHub repo `cankan` (private until M5), `main` branch, branch protection (PRs required, CI required), `LICENSE` (MIT), `.gitignore`, `CODEOWNERS`, issue templates.
- **Wires:** nothing.
- **Depends on:** —
- **Done when:** `git clone` works; pushing to `main` directly is rejected.

### M0.2 Monorepo skeleton
- **Creates:** root `package.json` with Bun workspaces; `packages/core`, `packages/cli`, `packages/mcp`, `packages/backers/` (empty index), `packages/test-utils`; root `tsconfig.base.json` and per-package `tsconfig.json` extending it; `bunfig.toml`; each package has a `package.json`, `src/index.ts` exporting nothing, and builds.
- **Wires:** package cross-references (`@cankan/cli` depends on `@cankan/core`, etc.) via workspace protocol.
- **Depends on:** M0.1
- **Done when:** `bun install && bun run --filter '*' build` succeeds with empty packages.

### M0.3 Lint, format, typecheck
- **Creates:** `biome.json`, `bun run lint`, `bun run format`, `bun run typecheck` (tsc `--noEmit` across workspaces), editorconfig.
- **Depends on:** M0.2
- **Done when:** all three scripts pass on the empty skeleton and fail on a deliberately bad file.

### M0.4 Test harness and git fixtures
- **Creates:** `packages/test-utils` with `makeTempRepo()` (real `git init`, configurable worktrees, optional bare remote), `makeFixtureTickets()`, and a `withEnv()` helper for XDG overrides so tests never touch the real home directory. Root `bun test` script.
- **Depends on:** M0.2
- **Done when:** a sample test creates a temp repo with two worktrees and a bare remote, pushes between them, and cleans up.

### M0.5 Versioning and publish config
- **Creates:** changesets config, `publishConfig` in each publishable package, `bun run release:version` and `release:publish` scripts, `@cankan` npm scope reserved via a placeholder `@cankan/cli@0.0.0` publish (the unscoped `cankan` name is blocked by npm's name-similarity policy - "too similar to canvas" - so distribution is scoped from here on; see M5.1).
- **Depends on:** M0.2
- **Done when:** `bun run release:version` produces a changelog from a sample changeset.

### M0.6 CI
- **Creates:** `.github/workflows/ci.yml` (lint, typecheck, test on ubuntu + macos; Bun pinned), `.github/workflows/release.yml` (stub that runs on tags, completed in M5.2).
- **Wires:** M0.3, M0.4, M0.5 into required checks on `main`.
- **Depends on:** M0.1, M0.3, M0.4, M0.5
- **Done when:** a PR with a failing test is blocked; a passing PR is mergeable.

---

## MB — Bootstrap: this plan into GitHub issues, this repo onto CanKan

MB.1–MB.3 run immediately after M0.1 (they only need the repo). MB.4 runs after M3.11. MB.5 runs after M6.6.

### MB.1 Issue conventions, labels, milestones
- **Creates:** `docs/issue-conventions.md` and the corresponding GitHub labels and milestones. The conventions are chosen to be exactly what the GitHub backer's default `status_map`/`priority_map` and importer expect, so MB.5 is a no-op translation:
  - **Title:** `[M2.7] Event log` — task ID in brackets, then the piece name. The importer strips the bracket into `cankan.display_id`'s companion field `task_id`.
  - **Milestone:** GitHub milestones `M0` … `M6`, one per plan milestone. Maps to the `milestone` field.
  - **Priority labels:** `P0 P1 P2 P3` → `critical high medium low` (the GitHub backer's default `priority_map`). Critical-path tasks get `P0`; wire tasks `P1`; everything else `P2`.
  - **Status labels:** none at open; `in-progress`, `in-review` while active; closed = Done. Matches the default `status_map`.
  - **Type labels:** `piece` or `wire`; `spike`; `docs`.
  - **Body template:**
    ```
    ## Creates
    …
    ## Wires
    …
    ## Done when
    …
    Depends on: #12, #15
    Part of: #3          (the milestone's tracking issue)
    ```
    `Depends on:` lines are the dependency representation. The GitHub backer (M6.4) is required to parse `Depends on:` / `Blocked by:` lines and GitHub sub-issue links into `blocks` deps on import, and to write them back on push. This requirement is recorded in M6.4 here so it can't be forgotten.
  - **Tracking issues:** one per milestone (`[M2] Core`), with a task list of its tasks; task issues use `Part of:` to point at it. Maps to `parent-child`.
- **Depends on:** M0.1
- **Done when:** labels and milestones exist; conventions doc merged.

### MB.2 `plan-to-issues` script
- **Creates:** `scripts/plan-to-issues.ts` (Bun, uses `gh api`): parses `PLAN.md` task headings and the four fields, creates or updates issues idempotently (keyed by `[Mx.y]` in the title), assigns milestone/labels, then makes a second pass to rewrite `Depends on:` task IDs into issue numbers and to link sub-issues where the API supports it. `--dry-run` prints the diff.
- **Depends on:** MB.1
- **Done when:** dry-run against this file produces one issue per task with correct labels, milestones, and resolved dependency numbers; re-running is a no-op.

### MB.3 [wire] Create the issues
- **Wires:** runs MB.2 for real; verifies every `Depends on:` resolved; opens the milestone tracking issues; pins `[M0] Repository and toolchain`.
- **Depends on:** MB.2
- **Done when:** issue count equals task count + milestone count; `gh issue list --label wire` shows every wire task; no unresolved `Depends on: M…` strings remain.

### MB.4 [wire] Dogfood stage A — native tickets mirrored from issues
Runs after M3.11 (CLI usable) and before any backer exists.
- **Creates:** `scripts/issues-to-tickets.ts` (explicitly temporary; deleted in MB.5): one-way, idempotent mirror from GitHub issues to Backlog.md-layout ticket files using the conventions above, setting `cankan.origin: github:<owner>/cankan#<n>` and `display_id: #<n>` by hand so MB.5's importer recognizes them as already-linked. Also this repo's own `.cankan/config.yml` (columns, `ready.order: [rank, priority:desc, id:asc]`, queues: `critical-path`, `wire`, `docs`), `AGENTS.md`/`CLAUDE.md` sections via `init --agent`, and a `CONTRIBUTING.md` rule: claim before you start.
- **Wires:** GitHub issues (source of truth for content) → ticket files (source of truth for claims) via the mirror run in a scheduled GitHub Action every 15 minutes and on `issues` events. Status flows back manually (close the issue) until MB.5.
- **Depends on:** M3.11, MB.3, M4.6
- **Done when:** `cankan ready --queue critical-path` in this repo lists the next unblocked plan task; a contributor (or agent) claims it, and the claim is visible from a second clone via the coordination ref.

### MB.5 [wire] Dogfood stage B — GitHub backer replaces the mirror
Runs after M6.6.
- **Wires:** `cankan backer add github --repo <owner>/cankan`; `cankan import github` recognizes the existing `origin`-tagged tickets and links them rather than duplicating; `sync.auto_push: transitions_only` pinned as `!policy` in this repo (moving a card updates the issue; content edits still push on command); mirror script and its Action deleted; `PLAN.md` gets a header stating it is a historical snapshot and the issues/board are canonical.
- **Depends on:** M6.6, M6.8, MB.4
- **Done when:** zero duplicate tickets after import; `cankan move <id> "In Review"` labels the issue within one run; `cankan sync --check` passes in CI; the mirror script is gone.

---

## M1 — Spike and upstream probe

### M1.1 Coordination-ref spike
- **Creates:** `spikes/coordination-ref/` (explicitly throwaway, not a workspace package): a script that creates an orphan ref, appends JSONL events, and has three worktrees race to claim the same ticket.
- **Depends on:** M0.4
- **Done when:** three concurrent processes → exactly one claim succeeds; the ref survives `git rebase` of a feature branch, a merge, and push/pull through a bare remote; timings recorded.

### M1.2 Spike findings and go/no-go
- **Creates:** `docs/decisions/0001-coordination-ref.md` (ADR): results, chosen mode (`shared-ref` or `branch-scan` fallback), locking approach for the local CAS (file lock vs `git update-ref` CAS), known failure modes.
- **Depends on:** M1.1
- **Done when:** ADR merged. M2.6/M2.7 cite it.

### M1.3 Backlog.md ID tolerance
- **Creates:** `docs/decisions/0002-ids-and-backlog-compat.md`: does real Backlog.md parse `ck-a1b2c3` IDs and our `cankan:` block? Decides whether `adopt backlog` must renumber.
- **Depends on:** M0.4 (fixture with Backlog.md installed)
- **Done when:** ADR merged with the actual `backlog` version tested.

### M1.4 Upstream issue
- **Creates:** an issue on MrLesk/Backlog.md proposing a leased `claim` command; link recorded in `docs/decisions/0002-…`.
- **Depends on:** —
- **Done when:** issue opened; response (or 2 weeks of silence) noted in the ADR.

---

## M2 — Core

All M2 tasks live in `packages/core`. **M2.1 owns the package's public surface**; other tasks add modules and register exports there, never elsewhere.

### M2.1 Core package shell
- **Creates:** `packages/core/src/index.ts` as the single public entry; `src/errors.ts` (typed `CanKanError` with `code`); `src/types.ts` for shared IDs (`TicketId`, `ActorId`, `BoardRef`); module folders `ticket/ config/ board/ store/ git/ events/ state/ claims/ deps/ order/ index/ hooks/ actor/` each with an empty `index.ts` re-exported from the root.
- **Wires:** the export map. Every later M2 task adds to it here.
- **Depends on:** M0.2
- **Done when:** `import * as core from "@cankan/core"` typechecks and exposes the folders.

### M2.2 Ticket schema and frontmatter
- **Creates:** `ticket/schema.ts` (zod schema matching Backlog.md fields + `cankan:` block), `ticket/frontmatter.ts` (parse/serialize via `gray-matter`, round-trip stable), `ticket/id.ts` (`ck-` hash generation), `ticket/filename.ts` (`<id> - <slug>.md`).
- **Depends on:** M2.1, M1.3
- **Done when:** parse→serialize→parse is byte-identical for fixture files, including ones written by real Backlog.md.

### M2.3 Config: schema, layers, policy
- **Creates:** `config/schema.ts` (zod for repo, local, global), `config/layers.ts` (locate and read the five layers, XDG resolution), `config/resolve.ts` (per-key policy vs preference, `!policy` tag, env overrides, `resolved()` with source attribution), `config/keys.ts` (the classification table from CONCEPT.md).
- **Depends on:** M2.1
- **Done when:** tests cover: preference overridden by local; policy not overridden by env; `!policy` pin raises `POLICY_VIOLATION` with the pinning file named.

### M2.4 Board resolver and repo registry
- **Creates:** `board/resolve.ts` (`resolveBoard({cwd, flag}) → BoardRef` with rules: `--board` flag > inside inited repo > personal), `board/registry.ts` (read/write `repos.yml`, `register()` called by init), `board/personal.ts` (XDG path, lazy `ensurePersonalBoard()`).
- **Wires:** config layers (M2.3) to the resolved board (a board's `.cankan/config.yml` is the "repo" layer for that board).
- **Depends on:** M2.1, M2.3
- **Done when:** tests: inside repo → repo board; outside → personal (created lazily under a temp XDG home); `--board all` → list of refs from registry + personal.

### M2.5 Ticket store
- **Creates:** `store/ticketStore.ts`: `list()`, `get(id|displayId|alias)`, `write()`, `remove()`, `archive()` over a board's tickets dir; alias resolution; atomic writes (temp + rename).
- **Depends on:** M2.2, M2.4
- **Done when:** CRUD tests on a temp board; concurrent writes to different tickets don't corrupt.

### M2.6 Git adapter
- **Creates:** `git/adapter.ts` wrapping `simple-git`: `readRef`, `updateRefCAS(ref, expectedOld, new)`, `readBlobFromRef`, `commitTreeToRef` (build a commit on an orphan ref without touching the worktree), `listWorktrees`, `fetch/push ref`. Implements the locking approach chosen in M1.2.
- **Depends on:** M2.1, M1.2
- **Done when:** two processes calling `updateRefCAS` with the same expected old value → exactly one succeeds; works from a secondary worktree.

### M2.7 Event log
- **Creates:** `events/schema.ts` (event union), `events/log.ts` (`append(event)`, `read({since, ticket, actor})`, monthly file layout under the coordination ref, ULID ids), `events/ref.ts` (initialize the ref; `mode: branch-scan` fallback reads `.cankan/events/` in-tree instead).
- **Wires:** git adapter (M2.6) to the JSONL format; append = read tree → add line → commit via CAS → retry on conflict.
- **Depends on:** M2.6
- **Done when:** appends from two worktrees interleave without loss; `read()` returns them in ULID order.

### M2.8 Board state fold
- **Creates:** `state/fold.ts`: `foldState(tickets, events) → BoardState` (per ticket: current claim, lease expiry, status per event log vs frontmatter with the precedence rule, alias map); `state/queries.ts` (`byStatus`, `claimedBy`, `blockedBy`).
- **Wires:** this is the **only** module that combines ticket files and events. Nothing else may read both.
- **Depends on:** M2.5, M2.7
- **Done when:** golden tests: given fixture tickets + fixture events, `BoardState` matches snapshots including expired-lease handling.

### M2.9 [wire] Core smoke test
- **Creates:** `packages/core/test/smoke.test.ts`.
- **Wires:** store → event log → fold → queries in one flow: create ticket file, append `create` event, fold, assert query results. Proves M2.2–M2.8 fit together; this is the first point at which "CanKan exists."
- **Depends on:** M2.8
- **Done when:** passes in CI on both OSes.

### M2.10 Claims
- **Creates:** `claims/claim.ts` (`claim(id, actor, lease)`: read state → reject if held & unexpired → append `claim` event via CAS → return; `--force` writes `takeover`), `renew`, `release`, `expireStale()`, `maxPerActor` enforcement from config.
- **Depends on:** M2.8, M2.3
- **Done when:** unit tests for every rejection path; error codes map to CLI exit 3.

### M2.11 Readiness and dependencies
- **Creates:** `deps/graph.ts` (typed edges from `cankan.deps` + Backlog.md flat `dependencies`, cycle detection, `blockers(id)`), `deps/ready.ts` (`isReady`: open, unclaimed, no open blockers, not excluded label).
- **Depends on:** M2.8
- **Done when:** cycle insertion rejected; ready set matches snapshot for a fixture graph.

### M2.12 Ordering and queues
- **Creates:** `order/keys.ts` (comparators for every sort key incl. numeric-aware `id`, `random` with seed), `order/rank.ts` (fractional `ordinal` ops, normalize), `order/queue.ts` (resolve a queue by name or actor pattern into filter+order; parse `--order` strings).
- **Depends on:** M2.11, M2.3
- **Done when:** property tests: any `--order` string produces a total order; queue by actor pattern picks the right queue.

### M2.13 [wire] Concurrency test
- **Creates:** `packages/core/test/concurrency.test.ts`.
- **Wires:** claims (M2.10) + ordering (M2.12) + event log under real process contention: spawn N `bun` subprocesses each calling `claimNext(queue)`; assert N distinct tickets claimed, no duplicates, across two worktrees.
- **Depends on:** M2.10, M2.12
- **Done when:** passes 20× in a row in CI.

### M2.14 SQLite index
- **Creates:** `index/db.ts` (`bun:sqlite` at `$XDG_CACHE_HOME/cankan/<board-hash>.db`), `index/schema.sql`, `index/reindex.ts` (full rebuild from store + event log), `index/query.ts` (fast `list` with filters used by `--board all`).
- **Depends on:** M2.8
- **Done when:** reindex of 5k fixture tickets < 2s; queries match fold results exactly.

### M2.15 [wire] Index invalidation
- **Creates:** `index/invalidate.ts` + tests.
- **Wires:** store writes and event-log appends mark the index dirty (mtime + ref SHA check on read); queries fall back to reindex when stale. Without this task the index silently lies.
- **Depends on:** M2.14, M2.5, M2.7
- **Done when:** write a ticket outside the API (simulate editor) → next query reflects it.

### M2.16 Hooks runner
- **Creates:** `hooks/runner.ts`: resolve hooks for an event from all config layers (repo + local + global, all run), spawn with `$TICKET $ACTOR $FROM $TO $TITLE` env, timeout, capture output to the event log as `hook` events.
- **Depends on:** M2.3
- **Done when:** a hook that writes its env to a file is invoked with correct values; a hanging hook is killed at timeout.

### M2.17 [wire] Hooks fired from core paths
- **Creates:** tests only.
- **Wires:** `claim`, `release`, `expire`, `move`, `close`, `create` in M2.10/M2.5 call the runner (M2.16) after their event append succeeds. Explicitly lists each call site.
- **Depends on:** M2.16, M2.10, M2.5
- **Done when:** each of the six events triggers its hook exactly once in an integration test.

### M2.18 Actor identity
- **Creates:** `actor/resolve.ts`: `--actor` flag > `CANKAN_ACTOR` > local config > global identity > git `user.name`; parses `tool:name/context`; derives `parent`.
- **Depends on:** M2.3, M2.6
- **Done when:** table-driven tests for each precedence rung.

---

## M3 — CLI

All M3 tasks live in `packages/cli`. **M3.1 owns the command registry and the context object**; commands register themselves and receive a `Context`, never construct core objects directly.

### M3.1 CLI shell, registry, context, output
- **Creates:** `src/main.ts` (citty root), `src/registry.ts` (`defineCommand` wrapper that records a machine-readable spec: name, args, flags, description — consumed later by M4.2 and M5.3), `src/context.ts` (`buildContext(argv) → {config, board, actor, core, output}` calling M2.3/M2.4/M2.18 and opening the store/log/index for the board), `src/output.ts` (`--json`, `--plain`, tables, colors), global flags.
- **Wires:** config → board → actor → core handle into one object. This is the plumbing every command assumes; it exists here and nowhere else.
- **Depends on:** M2.3, M2.4, M2.18, M2.9
- **Done when:** `cankan --help` lists global flags; a `noop` command prints the resolved context under `--json`.

### M3.2 `init`
- **Creates:** `commands/init.ts`: detection (Backlog.md dir, `.beads/`, GitHub remote, `JIRA_*`), wizard (`@clack/prompts`), `--no-wizard/--backer/--no-backers/--prefix`, writes `.cankan/config.yml`, `.cankan/local.yml`, `.gitignore` entry, tickets dir, initializes the coordination ref (M2.7), registers the repo (M2.4).
- **Depends on:** M3.1, M2.7, M2.4
- **Done when:** `init` in a bare temp repo yields a board that `list` can read; re-running is idempotent. (Agent instruction/MCP config writing is added by M4.6, not here.)

### M3.3 `config` commands
- **Creates:** `commands/config.ts`: `show [--resolved --source]`, `get`, `set [--global|--local|--repo]` with policy rejection (exit 5).
- **Depends on:** M3.1
- **Done when:** `set` of a pinned key exits 5 with the pinning file named.

### M3.4 Ticket commands
- **Creates:** `commands/ticket/*.ts`: `create show list edit move close reopen note comment dep archive search rank`.
- **Depends on:** M3.1, M2.5, M2.11, M2.12, M2.17
- **Done when:** each command has a test under `--json`; `create --backer` errors cleanly with "no backers configured" until M6.

### M3.5 Coordination commands
- **Creates:** `commands/coord/*.ts`: `ready claim claim --next renew release assign mine actors expire`.
- **Depends on:** M3.1, M2.10, M2.11, M2.12
- **Done when:** `claim` on a held ticket exits 3; `claim --next --queue` honors queue order.

### M3.6 `queue` commands
- **Creates:** `commands/queue.ts`: `list show add rm` writing repo config.
- **Depends on:** M3.1, M2.12
- **Done when:** `queue add` then `ready --queue` reflects it.

### M3.7 `board`, `events`, `render`
- **Creates:** `commands/board.ts` (terminal board, `--group-by`, `--order`, `--watch` via fs + ref polling), `commands/events.ts`, `commands/render.ts` (`BOARD.md` with header, tables, optional Mermaid).
- **Depends on:** M3.1, M2.8, M2.12
- **Done when:** snapshot tests for `board --plain` and `render` output.

### M3.8 `prime`
- **Creates:** `commands/prime.ts`: compact agent orientation (ready top-N per actor's queue, my claims, blocked-by-me, last events, workflow reminder text).
- **Depends on:** M3.5, M3.7
- **Done when:** output under 2k tokens for a 200-ticket fixture board.

### M3.9 `doctor`
- **Creates:** `commands/doctor.ts`: ref present, gitignore correct, no token-shaped strings in tracked files, stale leases, registry paths exist, `--fix`.
- **Depends on:** M3.1, M2.7, M2.10
- **Done when:** each check has a failing fixture it detects.

### M3.10 Exit codes and errors
- **Creates:** `src/exit.ts` mapping `CanKanError.code` → exit code table from CONCEPT.md; uniform error rendering (`--json` gives `{error:{code,message}}`).
- **Wires:** installed as the top-level error boundary in M3.1's `main.ts`.
- **Depends on:** M3.1
- **Done when:** every error code in core has a test asserting its exit code.

### M3.11 [wire] CLI end-to-end
- **Creates:** `packages/cli/test/e2e.test.ts`.
- **Wires:** runs the built binary: `init --no-wizard` → `create` ×3 with deps → `ready` → `claim --next` → `move` → `close` → `board --json` in a temp repo with a second worktree claiming concurrently. First proof the CLI is usable by an agent.
- **Depends on:** M3.2–M3.10
- **Done when:** passes in CI; also runs from the secondary worktree.

---

## M4 — MCP, agent setup, personal board, compatibility

### M4.1 MCP package shell
- **Creates:** `packages/mcp/src/server.ts` (stdio server via `@modelcontextprotocol/sdk`), `bin` wiring so `cankan mcp start` (added to CLI registry here) spawns it; server builds a `Context` via M3.1's `buildContext` from `--cwd`/`--board`.
- **Depends on:** M3.1
- **Done when:** server starts, answers `initialize`, exposes zero tools.

### M4.2 [wire] Tools from command specs
- **Creates:** `packages/mcp/src/tools.ts` + tests.
- **Wires:** reads the command spec registry (M3.1) and generates one MCP tool per allow-listed command with JSON schema derived from flags; invocation calls the command's handler with `--json` and returns its output. No hand-written tool list, so CLI and MCP can't drift.
- **Depends on:** M4.1, M3.4, M3.5, M3.7, M3.8
- **Done when:** adding a flag to a CLI command changes the MCP schema without touching the MCP package.

### M4.3 MCP board scoping
- **Creates:** `packages/mcp/src/scope.ts`: `--board` fixed scope, or follow client MCP roots to resolve the board per request (Backlog.md-style), with `personal`/`all` support.
- **Depends on:** M4.1, M2.4
- **Done when:** switching roots in a test client switches the board without restart.

### M4.4 [wire] MCP smoke test
- **Creates:** `packages/mcp/test/smoke.test.ts` using the SDK client.
- **Wires:** client → server → tool → CLI handler → core → back, for `prime`, `ready`, `claim_next`, `close`.
- **Depends on:** M4.2, M4.3
- **Done when:** passes in CI.

### M4.5 Agent instruction templates
- **Creates:** `packages/cli/src/agents/templates/{agents.md,claude.md}.hbs` (workflow section: prime → ready → claim → work → note → close, exit-code guidance), `agents/mcpConfigs.ts` (per-tool MCP config writers: claude-code, codex, opencode, cursor, gemini, kiro).
- **Depends on:** M3.1
- **Done when:** snapshot tests per tool; templates append without clobbering existing files.

### M4.6 [wire] `init` writes agent setup
- **Creates:** tests only.
- **Wires:** `init --agent <tool>` (and wizard step) calls M4.5 writers; when a Backlog.md instructions file exists, appends a CanKan section rather than replacing.
- **Depends on:** M3.2, M4.5
- **Done when:** e2e: `init --agent claude-code` produces `CLAUDE.md` section + `.mcp.json` entry that M4.4's client can use.

### M4.7 Personal board
- **Creates:** `commands/personal.ts` (`personal init`), `p` alias in M3.1's root, `commands/repo.ts` (`repo add rm list`), `commands/moveTo.ts`.
- **Depends on:** M2.4, M3.1
- **Done when:** `cankan p create` outside any repo creates the XDG board lazily and the ticket appears in `cankan p list`.

### M4.8 [wire] Personal board through every command
- **Creates:** `packages/cli/test/personal.test.ts`.
- **Wires:** asserts every registered command honors `--board personal` (iterates the spec registry, runs each read command against the personal board); `move-to` between a temp repo and personal preserves ID/history via alias events on both boards.
- **Depends on:** M4.7, M3.4–M3.8
- **Done when:** the iteration test passes for all commands; any new command is automatically covered.

### M4.9 `BOARD.md` automation
- **Creates:** `templates/hooks/post-commit` (runs `render`), `templates/github-action.yml`; `init --board-md` installs them.
- **Depends on:** M3.7, M3.2
- **Done when:** commit in fixture repo regenerates `BOARD.md`.

### M4.10 [wire] Backlog.md compatibility
- **Creates:** `packages/core/test/backlog-compat.test.ts` (skips if `backlog` binary absent; CI installs a pinned version).
- **Wires:** write tickets with CanKan → `backlog task list --json` sees them; edit with `backlog task edit` → CanKan reads the change; `ordinal` set by either is honored by the other.
- **Depends on:** M2.2, M2.5, M2.12, M1.3
- **Done when:** passes against the pinned Backlog.md version in CI.

---

## M5 — Release (Phase 1 ships here)

### M5.1 Binaries and shims
- **Creates:** `packages/cli/bin/cankan` entry, `bun build --compile` targets (linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64), publishes `@cankan/cli` (scoped - the unscoped `cankan` name is blocked by npm's name-similarity policy, see `docs/decisions/`) with a `bin` field (command name stays `cankan`) and platform-package fallback so `bunx @cankan/cli`/`npx @cankan/cli` work.
- **Depends on:** M3.11, M4.4
- **Done when:** `npx @cankan/cli --version` works from a clean machine in CI.

### M5.2 Release pipeline
- **Creates:** completes `release.yml`: changesets version PR → tag → build binaries → npm publish → GitHub release with assets → Homebrew tap formula bump (tap repo created here).
- **Wires:** M0.5 and M5.1 into the tag flow.
- **Depends on:** M5.1, M0.6
- **Done when:** a dry-run release produces artifacts for all targets.

### M5.3 Docs
- **Creates:** `README.md` (positioning from CONCEPT), `docs/cli.md` generated from the spec registry (M3.1) by a `bun run docs` script, `docs/config.md`, `docs/agents.md`.
- **Depends on:** M3.1, M4.5
- **Done when:** `bun run docs` is idempotent and CI fails if it's stale.

### M5.4 Repo goes public; Phase 1 release
- **Wires:** finally delivers M0.1's branch protection (blocked until now - GitHub's free plan only allows branch protection on public repos): required PR review, CI required, no force-push/deletion on `main`.
- **Depends on:** M5.1–M5.3, M4.10
- **Done when:** `@cankan/cli@0.1.0` on npm; branch protection active on `main`; announcement drafted.

---

## M6 — Backers, sync, cross-repo (Phase 2)

Sketched to the same standard so the interfaces are created by named tasks. Detailed sub-steps get their own tickets in CanKan once M5 ships.

### M6.1 Backer interface, mock backer, conformance suite
- **Creates:** `packages/backers/interface/` (`Backer` type: `import get create update transition link deps capabilities`), `packages/backers/mock/` (in-memory backer with injectable conflicts), `packages/backers/conformance/` (a test suite any backer package runs with `runConformance(backerFactory)`), `priority_map`/`status_map` types in config schema.
- **Depends on:** M2.3, M2.5

### M6.2 Sync engine
- **Creates:** `core/sync/` : sync-point recording in `cankan.sync`, three-way merge per field, `pull/push/status/resolve` primitives, auto-push policy evaluation, offline queue.
- **Depends on:** M6.1, M2.5, M2.7

### M6.3 [wire] Sync engine ⇄ mock backer
- **Wires:** full pull/push/conflict/resolve cycle against the mock; every branch of the merge logic exercised.
- **Depends on:** M6.2

### M6.4 GitHub backer / M6.5 Jira backer
- **Creates:** `packages/backers/github/` (octokit; reuses `gh auth token`), `packages/backers/jira/` (REST v3). Both run the conformance suite against recorded HTTP fixtures. Built in parallel by design.
- **Required by MB.1/MB.5 (GitHub):** parse `Depends on:` / `Blocked by:` body lines and sub-issue links into `blocks` deps, `Part of:` into `parent-child`, `[Mx.y]` title prefixes into `task_id`; write these back on push in the same format. Recognize tickets that already carry `origin: github:…` and link instead of duplicating.
- **Depends on:** M6.1

### M6.6 [wire] Mixed-origin board
- **Wires:** one board with native + GitHub + Jira tickets: `ready --order backer`, cross-backer dep with sync warning, `status` shows per-origin state.
- **Depends on:** M6.3, M6.4, M6.5

### M6.7 beads backer
- **Creates:** `packages/backers/beads/` over JSONL export / `bd --json`.
- **Depends on:** M6.1

### M6.8 Sync and backer CLI
- **Creates:** `commands/sync/*.ts`: `pull push sync status resolve import adopt`, `backer add rm list`, `auth`; `create --backer` becomes functional.
- **Depends on:** M6.2, M3.1

### M6.9 [wire] Sync CLI against fixtures
- **Wires:** e2e for `import github` → edit → `push` (confirms) → `pull` conflict → `resolve`; `sync --check` exit 4.
- **Depends on:** M6.8, M6.4, M6.5

### M6.10 Cross-repo aggregation
- **Creates:** `core/aggregate/`: `--board all` fan-out over registry using the index (M2.14), `<repo>:<id>` addressing, cross-board deps, write routing back to the owning board's ref.
- **Depends on:** M2.14, M2.4, M4.7

### M6.11 [wire] Aggregation e2e
- **Wires:** 3 fixture repos + personal board: `board --all`, `ready --all` honoring a cross-board dep, `claim` from the aggregated view lands on the right repo's ref.
- **Depends on:** M6.10

---

## Critical path

M0.1 → **MB.3** (issues exist; everything after this is tracked there) → M0.2 → M0.4 → M1.1 → M1.2 → M2.6 → M2.7 → M2.8 → **M2.9** → M2.10 → M2.12 → **M2.13** → M3.1 → M3.2/M3.4/M3.5 → **M3.11** → **MB.4** (this repo now runs on CanKan) → M4.1 → **M4.2** → **M4.4** → M5.1 → M5.2 → M5.4 → M6.1 → M6.2 → **M6.3** → M6.4 → **M6.6** → **MB.5**

Everything else can proceed in parallel off this spine. The four bolded wire tasks are the checkpoints where "does it actually work end-to-end" is answered; nothing downstream of a wire task starts until it's green.

## Rules that keep the matrix honest

1. A PR that adds a new piece must add a row to the ownership matrix in the same PR.
2. A task may only import from packages/modules created by tasks in its *Depends on* list. Reviewers check this.
3. If two tasks both seem to need to create the same thing, stop and add a task that creates it; both depend on the new one.
4. Every milestone ends with a wire task. If a milestone has no wire task, it isn't done.
5. From MB.3 on, this file is not edited to track progress; the issues are. From MB.4 on, nobody starts a task without `cankan claim`.
