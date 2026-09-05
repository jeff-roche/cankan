# CanKan concept

**One-liner:** CanKan is the coordination layer for fleets of coding agents. It adds the lock your repo-native task tracker doesn't have: atomic leased claims on a board every branch and worktree sees, uniform identity for humans and agents, and sync to the tracker your team already uses.

Repo-native markdown kanban with a CLI, MCP server, web UI, and agent config is fully occupied territory (Backlog.md, beads). CanKan does not compete there. It sits on top of those tools and owns three things nobody else does:

1. **Write-side coordination** — claims that *prevent* two agents taking the same ticket, not board views that report it afterward.
2. **Cross-branch / cross-worktree coherence** — one coordination ref, visible everywhere, without merge hell.
3. **Backers** — pluggable sync targets (GitHub Issues, Jira, beads, more) declared *per ticket* via an `origin` field, so one board can hold GitHub and Jira tickets side by side. Every backer a first-class citizen; nobody migrates; none is privileged.

**Positioning in one contrast:** Backlog.md is spec-driven and human-gated — three review checkpoints, one task per session, one PR per task, parallelism via good task splitting. CanKan is throughput-first — many agents pulling work concurrently, with the human reviewing the *board* rather than gating each task. Different tempos, complementary tools.

---

## Prior art and the build-vs-fork decision

### Backlog.md (fresh look)
Markdown-per-task, CLI + MCP + local web UI, milestones, dependencies, acceptance criteria and DoD defaults, board export, comments with authors, versioned JSON output. Agent setup auto-configures Claude Code, Codex, Gemini CLI, Kiro, and Cursor; `backlog instructions overview` orients agents at session start. Cross-branch is handled **read-side**: `checkActiveBranches` scans recently active branches so the board reflects other branches' task state. `onStatusChange` runs a shell command on transitions (their docs show it spawning `claude` on In Progress). Sequential `TASK-N` IDs. No claims, no lock, no actor identity beyond an assignee list, no external tracker sync. MIT, Bun/TS.

**What we borrow:** file format conventions; `onStatusChange` generalized into `cankan on <event> <cmd>` (the dispatch primitive for spinning up agents); branch scanning as our fallback coordination mode; their "review the spec before code exists" framing for ticket bodies.

### beads
Hash IDs (`bd-a1b2`), four dependency types (blocks, related, parent-child, discovered-from), `bd ready`, `bd prime` context injection, semantic compaction of closed issues, stealth/contributor modes, separate sync branch for protected repos, worktree support, optional agent mail for real-time coordination. Now Dolt-backed with cell-level merge.

**What we borrow:** ID scheme, dependency model + `ready` semantics, `prime`, compaction, the sync-branch pattern, stealth/contributor modes.

### vibe-kanban and the backers' own UIs
vibe-kanban is an orchestration UI; we're the data layer it lacks. GitHub Projects, Jira boards, and `backlog browser` are the human-facing boards each backer already ships — CanKan reuses whichever one the configured backer brings rather than building its own.

### Decision: init, detection, and later adoption

**Nothing is a prerequisite.** `cankan init` must produce a working board in a bare repo with no Backlog.md, beads, GitHub, or Jira configured. Those are options the user chooses, not dependencies.

**Detect, propose, never assume.** `init` inspects the repo and proposes backers to connect (multi-select, all optional):

| Signal | Proposal |
|---|---|
| `backlog/` or `.backlog/` or `backlog.config.yml` | Reuse the existing task directory as-is; existing tasks are already local, no import needed. `adopt` must still set `task_prefix: ck` and relabel any pre-existing `task-N` tickets into the `ck-` namespace with alias events — `task_prefix` is a single global value, so leaving them behind orphans them from `backlog browser` |
| `.beads/` | Connect beads backer; import issues with `origin: beads:…` |
| git remote on github.com | Offer GitHub Issues (not defaulted — many GitHub repos don't use Issues) |
| `JIRA_*` env vars | Offer Jira |
| none of the above | No backers; native only |

Detection only pre-selects the wizard. `cankan init --backer github --backer jira` skips it; `cankan init --no-backers` works even in a repo with Backlog.md and beads present. Remote backers get an auth step (`gh auth` reuse for GitHub; token + site URL for Jira) and a status-mapping preview before anything is written. Backers can be added any time with `cankan backer add <name>`.

**The local format is Backlog.md-compatible by construction.** Rather than inventing a new ticket format, tickets use Backlog.md's directory layout and frontmatter schema (`backlog/tasks/<ID> - <title>.md`, same field names, same AC checklist syntax), with CanKan-specific fields (`origin`, `claim`, `actor`, aliases, external metadata) namespaced under a `cankan:` key. Backlog.md ignores that key on read but **deletes it on write** — verified against `backlog.md@1.51.0` in `docs/decisions/0002-ids-and-backlog-compat.md` — so the `cankan:` block is a disposable cache that CanKan re-derives from the event log after an external write, never the only copy of anything. A user who starts with nothing and later runs `npm i -g backlog.md` gets a working `backlog browser` immediately, provided `cankan init` wrote `task_prefix: ck` into `backlog/config.yml`, which it must do on every init and not only when adopting an existing `backlog/`. A Backlog.md user who uninstalls it loses nothing.

**IDs: hash-based natively, relabelled on adoption.** Native tickets are `ck-a1b2c3` — collision-free across branches, worktrees, and machines with no coordination. Imported tickets keep their origin's ID as the display ID (`#123`, `PROJ-45`, `bd-x1y2`) while getting a `ck-` ID underneath, so two backers with overlapping numbering never collide. Phase 0 settled the Backlog.md question: its parser does **not** require numeric IDs and its allocator ignores non-numeric suffixes, so `ck-` IDs are never renumbered. What `cankan adopt backlog` must still do is relabel any pre-existing `task-N` tickets into the `ck-` namespace, writing alias events so old branch names and commit references still resolve — `task_prefix` is a single global value, so the two families cannot both be visible at once. Backlog.md's own `create` writes an uppercase `id: CK-1` under a lowercase filename, so `ck-1` and `CK-1` are the same ticket. Sequential IDs otherwise never exist in CanKan. See `docs/decisions/0002-ids-and-backlog-compat.md`.

**Adopting a backer later** (`cankan adopt <backer> [--filter …]`): push selected existing tickets up (creating issues) and set `origin` on each, or link to existing issues by title match with a confirmation prompt. Because origin is per ticket, adoption can be partial — send the backend tickets to Jira and leave the rest native. Reversible via the event log.

### Decision: do not fork Backlog.md
Forking buys the visible 70% (CLI, MCP, web, agent config) and none of the hard 30% (coordination ref, event log, claims, actors, backers). Their core — current-file-state-is-truth, sequential IDs, read-side reconciliation — is shaped against what we need, so we'd rewrite the center while carrying a periphery we don't want (web UI, five IDE integrations, install issues, 27 open issues). We'd also drift from upstream fixes and read as a clone.

Instead:
- Build a **small standalone core**: coordination ref, event log, claims, actors, backer interface. Greenfield either way.
- Make **Backlog.md one of the first backers** and tell users to keep using `backlog browser`. Don't rebuild their surface.
- **Cherry-pick modules** under MIT with attribution where they save real time (frontmatter parsing, MCP scaffolding).
- **Open an upstream issue first** proposing a leased `claim` command. If they'd merge it, the primitive may belong upstream and CanKan is the cross-tool/backer layer; if it's out of scope, we've confirmed the gap.

**Risk of the layer strategy:** Backlog.md ships claiming and absorbs the solo case. Hedge: backer breadth and the actor model are bets they're unlikely to make.

### Decision: one local storage layer, N sync backers, origin per ticket
Every ticket on a CanKan board is a local markdown file in the Backlog.md-compatible layout. A **backer** is not a storage mode; it is a sync target. Each ticket's frontmatter may carry a `cankan.origin` (`github:owner/repo#123`, `jira:PROJ-45`, `beads:bd-x1y2`) or none (native). The coordination ref, claims, `ready`, and `board` operate on local files and don't care where a ticket came from.

Consequences:
- **Mixed boards are the default, not a feature.** A monorepo can have frontend tickets from GitHub Issues and backend tickets from Jira on one board, with native tickets for glue work. `cankan import github owner/repo` and `cankan import jira PROJ` pull an entire project's issues onto the board; they compose.
- **Config lists all connected backers** with auth, plus `default_backer` for new tickets. `cankan create --backer jira` overrides per ticket. Nothing has to be pre-installed or pre-configured: `init` in a bare repo with zero backers is a complete, working setup.
- **Backlog.md is not a backer.** It's the file layout we already write. Installing it is optional and gives you its browser/TUI over the same files.
- **Cross-backer dependencies** (a GitHub ticket blocked by a Jira ticket) live in the local file and event log; `sync` warns they can't be represented upstream.
- **No backer is privileged.** The core never special-cases a backer by name. Every backer passes the same **conformance suite** (import, create, update, transition, link, deps, sync, conflict reconciliation) before it's called supported, and exposes `capabilities` so the core degrades gracefully (no sprints → no sprint grouping) without `if backer === "jira"`.
- The realistic user runs several: GitHub Issues on personal projects, Jira at work, both on one board when a side project graduates. CLI, agent instructions, and MCP surface are identical throughout.

---

## Users

Two personas, one layered product. The solo case is a strict subset of the team case.

**Persona A — Solo orchestrator.** One developer running 2–5 agents in parallel worktrees, often already on Backlog.md or beads. Pain: agents collide on the same task. Wants: zero-setup, terminal-first, no server. *Launch persona* — adopts on a Friday, gives feedback Monday.

**Persona B — Team with agents.** Several humans with their own agents, plus CI-driven agents. Already on an external tracker — Jira, GitHub Issues, or similar — and won't leave it. Pain: no visibility into what agents are doing across the team; agent work never lands in the real tracker. Wants: coordination on top of the existing tracker, humans and agents treated uniformly, board viewable in the tool they already open every day.

**Both personas also have a personal queue.** Work that isn't repo-shaped — meeting follow-ups, "can you look at X" requests, an assigned Jira ticket that spans services — needs the same capture, prioritization, and agent access as repo tickets, and needs to be viewable alongside them. The personal board (decision 6c) covers this without a separate tool.

What "both" commits us to: the shared coordination ref is non-negotiable; identity covers humans and agents uniformly; the Jira and GitHub Issues backers ship together in Phase 2, as peers; our own hosted UI stays out of scope until teams prove they need more than their tracker's board.

### User stories — solo orchestrator
- I run `cankan init` in an empty repo with nothing else installed and have a working board and MCP server in under a minute.
- I run `cankan init` in a repo that already uses Backlog.md; it detects it, proposes it, and my agents can claim tickets within one session — no migration, no server, `backlog browser` still works.
- Three months into a native-mode project I install Backlog.md, run `cankan adopt backlog`, and every existing ticket shows up in `backlog browser` with its ID unchanged.
- I describe a feature and an agent breaks it into tickets with dependencies, so I review the plan before any code exists.
- I spin up three worktrees with three agents; each `cankan claim`s a different ready ticket, never the same one.
- I `cankan rank` the five tickets I care about to the top and agents pick them up in that order; everything else falls back to priority-then-age.
- I run one agent on `--queue backend-urgent` (due date first) and another on `--queue chores` (oldest GitHub issue first) and they never fight over the same slice.
- When an agent crashes mid-task, its claim expires and the ticket returns to the pool.
- When an agent discovers a bug mid-task, it files a ticket linked `discovered-from` the current one and keeps going.
- I run `cankan board` in any worktree and see the same board, including claims from other worktrees.
- An agent starting fresh runs `cankan prime` and gets exactly what it needs: ready work, its claims, recent activity.
- `cankan on claim 'claude "Work on $TICKET"'` dispatches an agent automatically when a ticket is claimed by a dispatcher.
- Closed tickets get compacted so agent context windows aren't eaten by history.
- I push and `BOARD.md` updates so I can glance at status on my phone via GitHub.
- I switch from Claude Code to Codex mid-project and the board just works.

### User stories — personal board
- Someone stops by my desk with a request; I type `cankan p create "Review Sam's budget doc" --due fri --priority high` from any directory and it's on my board.
- After a meeting I capture six follow-ups on the personal board, then `move-to api` the two that turned out to be real engineering work; they keep their IDs and history.
- I get assigned a Jira ticket that touches three repos; I `cankan p import jira PROJ-88` and it sits on my personal board with its origin, while sub-tasks live in each repo and are linked from it.
- `cankan board --all` shows my personal queue and my open claims across every repo I've inited, grouped by due date.
- I run an assistant agent against `cankan mcp start --board personal` that drafts follow-up emails for tickets in `--queue followups` and marks them done when I confirm.
- My personal board syncs to a private git remote so my laptop and desktop agree.
- Nothing on my personal board ever appears in a repo's `BOARD.md` or gets pushed to a team backer unless I explicitly move or adopt it.

### User stories — team with agents
- I run `cankan init --backer jira`, paste a token and site URL, review the proposed status mapping, and our existing Jira project appears on the board with statuses, labels, and sprints intact — same flow for `--backer github`.
- Our monorepo tracks the frontend in GitHub Issues and the backend in Jira; both are on one CanKan board, and an agent can claim from either without knowing the difference.
- We prototyped with native tickets; when the project graduates to the team's Jira, `cankan adopt jira --label backend` creates the issues and links those tickets, leaving the rest native.
- When an agent closes a ticket, the Jira issue transitions (or the GitHub issue closes) and the PR is linked.
- I see "alice" has three agents on tickets 12, 15, 19 and "bob" has one on 22, without asking.
- I claim a ticket myself (as a human) with the same command my agents use.
- My agents' ticket edits live in my branch until merge, but their *claims* are visible team-wide immediately.
- A PM drags a card in the Jira board or GitHub Projects; the next `cankan sync` reflects it in the repo.
- I group the board by milestone/sprint and see what's blocked and by whom.
- I define queues in the checked-in config once, and every teammate's agents pull from the same prioritized slices without anyone re-explaining the rules in a prompt.
- I use GitHub Issues on my personal projects and Jira at work, and my agent instructions, MCP config, and muscle memory are identical in both.
- CI runs `cankan sync --check` and fails if repo and backer have diverged.
- As an OSS contributor, contributor mode keeps my planning tickets out of the upstream PR.

---

## Architecture decisions

### 1. Storage: local files always; backers sync into and out of them
Every ticket is a local markdown file in Backlog.md's layout and schema plus a namespaced `cankan:` block (`origin`, `external` metadata, aliases). Remote backers mirror into these files on `sync`/`import` and push from them on transition. Status lives in frontmatter, never in directory structure. CanKan's own state (`config.yml`, the SQLite index, backer auth references) lives in `.cankan/`; ticket files never do.

Frontmatter sketch:
```yaml
id: ck-7f3a9c
title: Rate-limit the webhook endpoint
status: In Progress
assignee: [alice]
labels: [backend]
milestone: v1.2
dependencies: [ck-2b1e44]
cankan:
  origin: jira:PROJ-45          # absent for native tickets
  display_id: PROJ-45
  external: { url: https://…, updated: 2026-09-04T10:12:00Z, hash: … }
  aliases: []                   # filled by adopt/renumber
```

### 2. IDs: hash-based, with display IDs from origins
Every ticket has a `ck-` hash ID; that's what the event log and coordination ref key on. Imported tickets additionally show their origin ID (`#123`, `PROJ-45`) and are addressable by either. An alias table handles renumbers (Backlog.md adoption) and re-imports. No sequential allocation anywhere in the core.

### 3. Cross-branch: the coordination ref
The load-bearing decision; comes first because it can't be retrofitted.

- **Definitions travel in the branch** (or live in the external tracker). PR diffs show spec changes.
- **Claims and status events live on a dedicated orphan ref** (`refs/cankan/coordination`). Worktrees share `.git`, so every worktree sees every claim instantly with no server. Cross-machine sharing means pushing and fetching that ref with an **explicit refspec** (`refs/cankan/coordination:refs/cankan/coordination`) on every call — a default `git push`, `git fetch` or `git clone` never touches it, and no config flag can change that. Protected-branch-safe (beads' pattern).
- The ref holds an **append-only JSONL event log**: `{ts, actor, ticket, event: claim|release|renew|move|comment, ...}`. Append-only means events never conflict *semantically* — no event has to be reconciled against another. It does not prevent git-level conflicts on the ref pointer itself: when local and remote have both advanced, the push is rejected non-fast-forward and the fetch has to land on a staging ref before the two sides are unioned and replayed. Board state = fold(events) over backer definitions.
- **Fallback mode** (if Phase 0 fails or a user opts out): Backlog.md-style read-side branch scanning plus claim files in-branch. Documented as lossy.

### 4. Concurrency: atomic leased claims
`cankan claim <id>` is compare-and-swap: succeeds only if unclaimed or expired. Records actor, timestamp, lease (default 2h, renewed on each MCP call / `cankan renew`). Expired claims return to Ready — expiry is measured against the reader's own first-observation time for the claim, never the timestamp in the event, which is written by whoever pushed it. `ready` = open, unclaimed, no open `blocks` deps. Locally: `git update-ref` compare-and-swap on the coordination ref (a file lock was measured and rejected; see `docs/decisions/0001-coordination-ref.md`). Across machines: optimistic push, retry on rejection. Real-time cross-machine channel deferred until asked for.

### 5. Identity: actors, human or agent, with optional parent
`alice`, `claude-code:alice/worktree-auth`, `codex:ci`. Agents inherit a parent human from config or git author. Board groups by actor or human. Identical commands for both.

### 6. Dependencies and readiness
beads' four types: `blocks`, `parent-child`, `related`, `discovered-from`. Cycle detection on `dep add`. Stored in the backer where it has a native concept (Backlog.md deps, beads deps, Jira issue links, GitHub sub-issues/task lists), otherwise in the event log. The mapping is part of each backer's conformance suite.

### 6b. Prioritization and queues: `ready` order is a policy, not a hard-coded sort
Which ticket an agent picks up next is a product decision the user makes, not one CanKan makes for them. Three mechanisms compose:

- **Sort keys.** `ready`, `claim --next`, `list`, and `board` accept `--order <key[:asc|desc]>,…`. Keys: `priority`, `created`, `updated`, `due`, `id` (display ID, numeric-aware so `PROJ-9` < `PROJ-10`), `backer`, `milestone`, `rank`, `label:<name>` (tickets with the label first), `age` (alias for `created:asc`), `random` (for spreading a fleet across a flat backlog). The default is configurable (`ready.order` in config); the built-in default is `rank, priority:desc, created:asc`.
- **Manual rank.** `cankan rank <id> --top | --bottom | --before <id> | --after <id>` sets an explicit order that beats every other key when present. Stored in the ticket's `ordinal` field (Backlog.md's own field for drag-and-drop order, so `backlog browser` reordering and `cankan rank` agree). Fractional ordinals avoid renumbering neighbors; `rank --normalize` compacts them.
- **Named queues.** A queue is a saved filter + order in config. `claim --next --queue backend-urgent` lets you hand different agents different slices of the backlog without them knowing the filter logic. Queues can be pinned to an actor pattern so `claim --next` with no `--queue` picks the right one automatically (`codex:*` agents only ever pull from `chores`).

Priority values are `critical | high | medium | low | none`, mapped per backer (Jira priority scheme, GitHub labels like `P0`–`P3`) in `status_map`'s sibling `priority_map`. `due` comes from the ticket's `due_date` field (Backlog.md-compatible) or the backer's due date on import.

`--order` and queues are also exposed through MCP, so an orchestrating agent can ask for "next ready in the `frontend` queue by due date" as a single call.

### 6c. Boards: repo boards, a personal board, and cross-repo views
A **board** is a directory with a tickets folder and a coordination ref. Repo boards live in repos. There is also exactly one **personal board** per user, in `$XDG_DATA_HOME/cankan/personal/` (default `~/.local/share/cankan/personal/`), which is itself a git repo so it gets the same event log, claims, history, and optional sync to a private remote (`personal.remote` in global config). It holds work that isn't tied to any one repo: follow-ups from meetings, things people ask for during the day, a Jira ticket you were assigned that spans three services.

- **Same engine, different root.** Every command works on the personal board unchanged; the only difference is which directory is the board. Backers come from global config, so a personal ticket can have a Jira or GitHub origin just like a repo ticket. Queues, rank, hooks, and `prime` all apply.
- **Scope resolution.** Inside a repo with `.cankan/`, commands default to that repo's board. Outside any repo, they default to the personal board. `--board personal|repo|all|<name>` overrides; `cankan p …` is shorthand for `--board personal`.
- **Cross-repo views.** `--board all` aggregates the personal board plus every registered repo board (`~/.local/share/cankan/repos.yml`, maintained automatically by `init` and manually by `cankan repo add|rm|list`). Aggregation is read-mostly: `board --all`, `list --all`, `ready --all`, `mine --all`, `prime --all`. Tickets are shown with a `repo` column and addressable as `<repo>:<id>` (`api:ck-7f3a9c`). Writes to a repo ticket from an aggregated view are routed to that repo's board and its coordination ref — claims stay per-repo, so team coordination isn't bypassed.
- **Moving between boards.** `cankan move-to <repo|personal> <id>` relocates a ticket, preserving its ID, origin, and history via an alias event on both sides. Typical flow: capture in a meeting on the personal board, `move-to api` once it's clear where it lands.
- **Linking without moving.** Personal tickets can hold typed deps to repo tickets using `<repo>:<id>`; `ready --all` respects them, so "follow up with Sam after ck-91ab02 ships" surfaces only once it's shipped.
- **Agents on the personal board.** `cankan mcp start --board personal` serves the personal board to a general-purpose assistant; `--board all` gives an orchestrator a view of everything you own. Actor identity comes from global config.
- **Privacy default.** Repo boards never read the personal board unless `--board all` is passed; `render` and `push` on a repo never include personal tickets.

### 7. Backers: sync adapters keyed by per-ticket origin; local is a fork, push is explicit
Interface: `import, get, create, update, transition, link, deps, capabilities`. `capabilities` lets the core degrade gracefully without special-casing any backer by name. Status mapping (`In Progress` ↔ Jira transition ↔ GitHub label/Project column) is declared per backer in config with sane defaults. Multiple backers coexist; there is no notion of "the" backer.

**The local file is a fork of the origin, not a mirror.** Every local edit — content, status, labels — stays local until pushed. Nothing leaves the repo without a command or an explicitly enabled auto-push policy.

- `cankan pull [backer|ticket]` fetches origin state and merges it into local files. Clean merges apply silently; conflicts (both sides changed the same field since the last sync point) are written as a reconciliation report and the ticket is marked `cankan.sync: conflict` until resolved with `cankan resolve <id> --ours|--theirs|--edit`.
- `cankan push [backer|ticket]` sends local changes upstream. Shows a diff and asks for confirmation unless `--yes`. Refuses to push a ticket in conflict state.
- `cankan sync` = pull then push (push still confirms).
- `cankan status` shows what's ahead/behind per ticket, like `git status`.
- The sync point is recorded per ticket (`cankan.external.hash` + timestamp) so three-way merges are possible: local, origin-then, origin-now.
- **Auto-push is a policy** (`sync.auto_push`), off by default. It can be enabled for all changes, or only for transitions (`transitions_only`, the "move the card and Jira follows" behavior), and scoped per backer. Repo policy overrides user preference here: a repo can forbid auto-push for everyone, or require it.
- Claims, leases, and actor events are never pushed to backers as-is. Backers only see the *mapped* result (assignee, status), and only on push.

### 8. Hooks: `cankan on <event> <cmd>`
Generalization of Backlog.md's `onStatusChange`. Events: `claim, release, expire, move, close, create`. Env: `$TICKET, $ACTOR, $FROM, $TO, $TITLE`. This is how a dispatcher spawns agents and how CI reacts to board changes.

### 8b. Configuration: three layers, policy beats preference
See "Configuration" below. Repo config (`.cankan/config.yml`) is checked in and holds policy and shared setup. Repo-local user config (`.cankan/local.yml`) is gitignored and holds per-checkout preferences and actor identity. Global user config (`~/.config/cankan/config.yml`) holds cross-repo defaults and credentials references. Keys are classified as **policy** (repo wins) or **preference** (user wins); a repo can pin any preference key with `!policy`.

### 9. Agent configuration: emit, don't integrate
`cankan init` writes an `AGENTS.md`/`CLAUDE.md` section (`prime → ready → claim → work → note → close`), an MCP entry, optional git hooks. When Backlog.md is the backer, we append to their instructions rather than replacing them. Agent-internal todo lists are scratchpads flushed into CanKan, never synced.

### 10. Context hygiene: `prime` and `compact`
`prime` emits a compact snapshot: ready work, my claims, blocked-by-me, last N events. `compact` summarizes tickets closed > N days.

---

## Answers to the open questions

**Viewable on GitHub?** Yes: `cankan render` writes `BOARD.md` (tables by column, optional Mermaid dependency graph); a hook or Action regenerates on push.

**Interactive on GitHub?** Not natively — github.com renders static markdown. The general answer: **every backer brings its own interactive board** (GitHub Projects, Jira's board, `backlog browser`) and `sync` pulls changes back. For native tickets with no upstream, a Pages deploy of the read-only board. We don't host an interactive UI.

**Multi-agent workflows?** Decisions 3–5 and 8: shared ref, leased CAS claims, actor identity, hooks for dispatch, `discovered-from`, `prime`.

**Cross-branch / worktree?** Decision 3. Definitions in-branch, coordination on a shared ref visible through shared `.git`. Hash IDs for native tickets; append-only events prevent semantic conflicts, though the ref pointer itself still needs reconciliation when both sides advance.

**Project management features?** Frontmatter strings (`milestone`, `release`, `phase`) plus `board --group-by`. Promote to objects only in Phase 4 if demand is real. Epics are parent-child tickets.

**Task assignment?** `assign` is a hint (push-based, humans); `claim` is the lock (pull-based, agents). A ticket can be assigned to `alice` and claimed by `claude-code:alice/wt-2`. *Which* ticket an agent claims next is governed by sort keys, manual rank, and named queues (decision 6b), so prioritization is config the user owns rather than a heuristic baked into the tool.

**Integrating with agent-native task systems?** Don't. Emit config, expose MCP, treat internal todos as scratch.

**Start from Backlog.md?** No — see build-vs-fork above. Use their file layout, don't use their code; open an upstream issue first.

**Multiple trackers on one board?** Yes, by design: origin is per ticket, backers are sync adapters, and the coordination layer doesn't know or care where a ticket came from.

---

## Configuration

### Layers and precedence

| Layer | Path | Checked in? | Purpose |
|---|---|---|---|
| Built-in defaults | — | — | Sane behavior with no config at all |
| Global user | `$XDG_CONFIG_HOME/cankan/config.yml` (default `~/.config/cankan/config.yml`) | No | Cross-repo preferences: identity, editor, default lease, agent tool, credential references, backers available to the personal board, personal board settings |
| Repo | `.cankan/config.yml` | **Yes** | Shared setup and team policy: backers, status mapping, columns, hooks, ID prefix, sync policy |
| Repo-local user | `.cankan/local.yml` | No (`init` adds it to `.gitignore`) | Per-checkout overrides: actor name for this worktree, backer selection for `create`, local hooks |
| Environment | `CANKAN_*` | — | CI and one-off overrides; highest precedence for preference keys, never for policy keys |

Resolution rule per key:
- **Preference keys** resolve `env > repo-local > repo > global > default`.
- **Policy keys** resolve `repo > repo-local > global > default`, and env cannot override them.
- A repo can promote any preference key to policy by tagging it `!policy` (a YAML tag). Users get a clear error if their local/global config tries to override a pinned key: `sync.auto_push is set as policy by .cankan/config.yml`.

`cankan config show --resolved` prints the effective config with the source layer of every key. `cankan config set <key> <value> [--global|--local|--repo]` writes to the chosen layer (default: repo-local for preference keys, repo for policy keys).

### Data directories (XDG)
| Path | Contents |
|---|---|
| `$XDG_CONFIG_HOME/cankan/config.yml` | Global user config |
| `$XDG_CONFIG_HOME/cankan/credentials.yml` | Secrets (0600) unless keychain/env |
| `$XDG_DATA_HOME/cankan/personal/` | The personal board: a git repo with `backlog/tasks/`, `.cankan/config.yml`, and its own coordination ref |
| `$XDG_DATA_HOME/cankan/repos.yml` | Registry of repo boards for `--board all` (path, name, last seen) |
| `$XDG_CACHE_HOME/cankan/` | SQLite indexes, backer response caches; safe to delete |
| `$XDG_STATE_HOME/cankan/` | Lease heartbeats, last-sync timestamps per board |

The personal board's `.cankan/config.yml` is a normal repo config, so it can carry its own columns, queues, and hooks; backers it references must be declared in global config (there's no team to share them with).

### Secrets
Never in any config file that could be committed. Credentials live in `$XDG_CONFIG_HOME/cankan/credentials.yml` (mode 0600), the OS keychain when available (`credentials.store: keychain`), or environment variables (`CANKAN_GITHUB_TOKEN`, `CANKAN_JIRA_TOKEN`). Config files reference credentials by name, never by value. The GitHub backer reuses `gh auth token` when present. `cankan doctor` fails if a token-shaped string appears in a checked-in file.

### `.cankan/config.yml` (repo, checked in)
```yaml
version: 1
project: cankan
id_prefix: ck                  # for native ticket IDs; adopt backlog may renumber
tickets_dir: backlog/tasks     # Backlog.md-compatible layout; change only if you know why

columns:                       # board columns; status values must map into these
  - To Do
  - In Progress
  - In Review
  - Done

coordination:
  ref: refs/cankan/coordination
  mode: shared-ref             # shared-ref | branch-scan (fallback)
  push_ref: true               # push/fetch the coordination ref alongside normal git remote ops
                               # (CanKan always supplies the explicit refspec itself; plain
                               #  git push/fetch/clone never move this ref)

claims:
  lease: 2h                    # default lease; agents renew on activity
  max_per_actor: 3             # 0 = unlimited
  require_ready: true          # can only claim tickets with no open blockers

sync:
  auto_push: off               # off | transitions_only | all   (policy: repo can pin)
  auto_pull: off               # off | on_prime | on_board | interval:15m
  conflict_policy: manual      # manual | ours | theirs

backers:
  github:
    repo: owner/name
    credential: github-personal          # name in credentials store
    status_map:                          # CanKan column -> backer representation
      "To Do":       { state: open }
      "In Progress": { state: open, label: in-progress }
      "In Review":   { state: open, label: in-review }
      "Done":        { state: closed }
    priority_map: { critical: P0, high: P1, medium: P2, low: P3 }   # labels
    project: 12                          # optional GitHub Projects number to mirror columns
  jira:
    site: https://acme.atlassian.net
    project: PROJ
    credential: jira-work
    status_map:
      "To Do":       { status: "To Do" }
      "In Progress": { status: "In Progress" }
      "In Review":   { status: "In Review" }
      "Done":        { status: "Done" }
    priority_map: { critical: Highest, high: High, medium: Medium, low: Low }
    sprint_field: customfield_10020

default_backer: none           # none | github | jira | beads — where `create` sends new tickets

ready:
  order: [rank, priority:desc, created:asc]   # default sort for ready/claim --next
  exclude_labels: [icebox, needs-design]      # never surface these as ready

queues:                        # named filter + order; `claim --next --queue <name>`
  backend-urgent:
    filter: { labels: [backend], priority: [critical, high] }
    order: [due:asc, priority:desc]
  frontend:
    filter: { labels: [frontend] }
    order: [rank, created:asc]
  chores:
    filter: { labels: [chore], backer: [github] }
    order: [id:asc]
    actors: ["codex:*"]        # actors matching this pattern default to this queue

hooks:                         # repo-shared; run with $TICKET $ACTOR $FROM $TO $TITLE
  on_close: ./scripts/notify.sh

agents:
  instructions_file: AGENTS.md # where init appends the workflow section
  mcp: true

definition_of_done:            # Backlog.md-compatible; applied to new tickets
  - Tests pass
  - Docs updated
```

### `.cankan/local.yml` (repo-local, gitignored)
```yaml
actor: claude-code:alice/wt-auth   # identity for this checkout; defaults to git user.name
parent: alice                      # human responsible for this actor
default_backer: jira               # overrides repo default for tickets I create here
sync:
  auto_pull: on_prime
hooks:
  on_claim: 'claude "Work on $TICKET: $TITLE" &'   # local dispatch, not shared
```

### `~/.config/cankan/config.yml` (global user)
```yaml
version: 1
identity:
  name: alice
  email: alice@example.com
editor: code --wait
claims:
  lease: 4h                  # my preference; repo policy may pin a different value
sync:
  auto_push: transitions_only   # my default; a repo can override by policy
credentials:
  store: keychain            # keychain | file | env
agents:
  default_tool: claude-code
output:
  color: auto
  json_pretty: false

backers:                       # available to the personal board and as defaults for repos
  jira-work:
    type: jira
    site: https://acme.atlassian.net
    credential: jira-work
  github-personal:
    type: github
    credential: github-personal

personal:
  path: ~/.local/share/cankan/personal   # override XDG default
  remote: git@github.com:alice/cankan-personal.git   # optional; auto push/pull of the whole board
  sync: on_command             # on_command | on_change | interval:10m
  default_backer: none
  columns: [Inbox, Today, Waiting, Done]
  queues:
    followups: { filter: { labels: [followup] }, order: [due:asc] }

repos:
  auto_register: true          # `cankan init` adds repos to repos.yml
  names:                       # optional friendly names for --board all output
    ~/code/api: api
    ~/code/web: web
```

### Policy vs preference (default classification)
| Policy (repo wins) | Preference (user wins) |
|---|---|
| `columns`, `id_prefix`, `tickets_dir` | `actor`, `parent`, `editor` |
| `coordination.*` | `output.*` |
| `claims.max_per_actor`, `claims.require_ready` | `claims.lease` (unless pinned) |
| `queues.*`, `ready.exclude_labels` | `ready.order` (unless pinned) |
| `backers.*.status_map`, `backers.*.repo/site/project` | `backers.*.credential` |
| `sync.conflict_policy` | `sync.auto_pull` |
| `hooks` in repo config | `hooks` in local/global config |
| `definition_of_done` | `default_backer` (unless pinned) |
| — | `sync.auto_push` (**preference by default, commonly pinned as policy**) |

---

## File formats

### Ticket file — `backlog/tasks/<id> - <slug>.md`
Backlog.md's schema, plus a `cankan:` block it ignores.
```yaml
---
id: ck-7f3a9c
title: Rate-limit the webhook endpoint
status: In Progress
assignee: [alice]
labels: [backend]
milestone: v1.2
priority: high
ordinal: 1250                    # manual rank; Backlog.md's own field
due_date: 2026-09-12
dependencies: [ck-2b1e44]
created_date: 2026-09-01 14:03
updated_date: 2026-09-04 10:12
cankan:
  origin: jira:PROJ-45           # omitted for native tickets
  display_id: PROJ-45
  sync:
    state: ahead                 # clean | ahead | behind | diverged | conflict
    base_hash: 3c9f…             # origin content hash at last sync point
    pulled_at: 2026-09-04T10:12:00Z
    url: https://acme.atlassian.net/browse/PROJ-45
  deps:                          # typed deps beyond Backlog.md's flat list
    - { type: blocks, id: ck-2b1e44 }
    - { type: discovered-from, id: ck-91ab02 }
  aliases: [TASK-12]             # previous IDs, filled by adopt/renumber
---

## Description
…

## Acceptance Criteria
- [ ] Returns 429 above 100 req/min per key
- [ ] Documented in API reference

## Implementation Plan
…

## Notes
- 2026-09-04 claude-code:alice/wt-auth: found existing limiter in middleware/, reusing.
```
Claims are **not** stored in the ticket file (they'd churn the file and pollute PR diffs); they live in the event log and are shown by `show`/`board`.

### Event log — coordination ref, `events/<yyyy-mm>.jsonl`
One JSON object per line, append-only, one file per month to keep individual files small. Board state is `fold(events)` over ticket files.
```json
{"ts":"2026-09-04T10:12:00Z","id":"evt-01J…","actor":"claude-code:alice/wt-auth","parent":"alice","ticket":"ck-7f3a9c","event":"claim","lease_until":"2026-09-04T12:12:00Z"}
{"ts":"2026-09-04T10:40:11Z","id":"evt-01J…","actor":"claude-code:alice/wt-auth","ticket":"ck-7f3a9c","event":"renew","lease_until":"2026-09-04T12:40:11Z"}
{"ts":"2026-09-04T11:02:30Z","id":"evt-01J…","actor":"claude-code:alice/wt-auth","ticket":"ck-7f3a9c","event":"move","from":"In Progress","to":"In Review"}
{"ts":"2026-09-04T11:02:31Z","id":"evt-01J…","actor":"claude-code:alice/wt-auth","ticket":"ck-7f3a9c","event":"release"}
{"ts":"2026-09-04T11:05:00Z","id":"evt-01J…","actor":"alice","ticket":"ck-7f3a9c","event":"alias","from":"TASK-12","to":"ck-7f3a9c"}
```
Event types: `create, claim, renew, release, expire, assign, move, close, reopen, comment, dep, alias, push, pull, conflict, resolve`. Event IDs are ULIDs so logs from different machines interleave deterministically.

### Credentials — `~/.config/cankan/credentials.yml` (0600) or keychain
```yaml
github-personal: { type: token, value: ghp_… }
jira-work: { type: basic, email: alice@acme.com, token: … }
```

### `BOARD.md` (generated by `render`)
Markdown tables per column with display IDs, titles, actors, and origin links; optional Mermaid dependency graph. Regenerated, never hand-edited; a header says so.

---

## CLI reference

Global flags on every command: `--json`, `--plain` (no color/boxes, for agents), `--actor <name>`, `--cwd <path>`, `--board personal|repo|all|<name>`, `--yes` (skip confirmations), `-q/-v`. `cankan p <cmd>` is shorthand for `cankan --board personal <cmd>`.

Scope default: repo board when inside an inited repo, personal board otherwise. Aggregating commands (`board`, `list`, `ready`, `mine`, `prime`, `events`, `search`) accept `--all` as shorthand for `--board all`.

### Setup
| Command | Arguments / flags | Notes |
|---|---|---|
| `cankan init` | `[--backer <name>…] [--no-backers] [--prefix ck] [--agent claude-code\|codex\|opencode\|…] [--no-wizard]` | Detects Backlog.md/beads/GitHub/Jira; writes repo config, `.gitignore` entry, agent instructions, MCP config; creates the coordination ref |
| `cankan backer add` | `<github\|jira\|beads> [--repo o/n] [--site url] [--project KEY] [--credential name]` | Adds a backer to repo config; prompts for auth; previews status map |
| `cankan backer remove` | `<name> [--keep-tickets]` | Removes backer; tickets with that origin become native unless `--keep-tickets` leaves origin metadata |
| `cankan backer list` | | Configured backers, auth status, last sync |
| `cankan config show` | `[--resolved] [--source]` | Effective config with layer attribution |
| `cankan config set` | `<key> <value> [--global\|--local\|--repo]` | Writes to a layer; rejects overriding pinned policy |
| `cankan config get` | `<key>` | |
| `cankan auth` | `<backer> [--token] [--from-gh]` | Stores credentials in the configured store |
| `cankan doctor` | `[--fix]` | Checks ref health, gitignore, leaked secrets, stale claims, backer connectivity |
| `cankan personal init` | `[--path p] [--remote url]` | Creates the personal board (also happens lazily on first `cankan p …`) |
| `cankan repo add` | `<path> [--name n]` / `rm <path\|name>` / `list` | Maintain the registry used by `--board all` |
| `cankan move-to` | `<repo\|personal> <id>` | Relocate a ticket between boards, preserving ID/origin/history |

### Tickets
| Command | Arguments / flags | Notes |
|---|---|---|
| `cankan create` | `<title> [-d desc] [--ac "…"]… [--label l]… [--milestone m] [--priority p] [--parent id] [--blocks id] [--blocked-by id] [--discovered-from id] [--backer name] [--assign actor]` | Native unless `--backer` or `default_backer` set; with a backer, creates locally as `ahead` (pushes only if `auto_push: all`) |
| `cankan show` | `<id\|display-id\|alias> [--events] [--deps]` | Content, claim, sync state, dependency tree |
| `cankan list` | `[-s status] [-l label] [--actor a] [--origin backer] [--ready] [--claimed] [--blocked] [--milestone m] [--order keys] [--queue name]` | |
| `cankan edit` | `<id> [-t title] [-d desc] [--ac add\|check\|uncheck n] [--label +l/-l] [--milestone m] [--priority p] [--assign actor] [-e]` | `-e` opens editor |
| `cankan move` | `<id> <column>` | Fires `on_move`; pushes if `auto_push: transitions_only\|all` |
| `cankan close` | `<id> [--reason "…"]` | Moves to last column; releases claim |
| `cankan reopen` | `<id>` | |
| `cankan note` | `<id> <text>` | Appends to `## Notes` with actor and timestamp |
| `cankan comment` | `<id> <text>` | Like `note` but pushable as a backer comment |
| `cankan dep` | `add <id> <type> <other>` / `rm <id> <other>` / `list <id>` / `graph [--mermaid]` | Types: blocks, parent-child, related, discovered-from; cycle detection |
| `cankan archive` | `<id>…` / `--closed-before 90d` | Moves to `backlog/archive/` (Backlog.md-compatible) |
| `cankan search` | `<query> [--all]` | Fuzzy over title/body |

### Coordination
| Command | Arguments / flags | Notes |
|---|---|---|
| `cankan ready` | `[--limit n] [--label l] [--milestone m] [--backer name] [--order keys] [--queue name]` | Open, unclaimed, unblocked; default order from config |
| `cankan claim` | `<id> [--lease 2h] [--force]` | CAS on the coordination ref; fails if claimed and unexpired; `--force` records a takeover event |
| `cankan claim --next` | `[--queue name] [--order keys] [--label l] [--milestone m] [--backer name]` | Atomically claim the top ready ticket under the given order/queue; falls back to the actor's default queue, then `ready.order` |
| `cankan rank` | `<id> --top\|--bottom\|--before <id>\|--after <id>` / `--normalize` | Manual ordering via `ordinal`; beats all other sort keys |
| `cankan queue` | `list` / `show <name>` / `add <name> --filter … --order …` / `rm <name>` | Manage named queues in repo config |
| `cankan renew` | `[<id>] [--lease 2h]` | Extends lease; no id = all my claims |
| `cankan release` | `[<id>] [--all]` | |
| `cankan assign` | `<id> <actor>` | Hint, not a lock |
| `cankan mine` | | My claims and assignments |
| `cankan actors` | `[--active 1h]` | Who is holding what; grouped by parent human |
| `cankan expire` | `[--dry-run]` | Releases expired leases (also runs implicitly on `ready`/`board`) |
| `cankan prime` | `[--full]` | Agent orientation: ready, mine, blocked-by-me, last events, workflow reminder |
| `cankan on` | `<event> <cmd> [--local\|--repo]` / `list` / `rm <event>` | Registers hooks in the chosen config layer |

### Sync
| Command | Arguments / flags | Notes |
|---|---|---|
| `cankan status` | `[--backer name]` | Ahead/behind/diverged/conflict per ticket, like `git status` |
| `cankan pull` | `[<backer>\|<id>] [--all]` | Fetch and three-way merge into local files |
| `cankan push` | `[<backer>\|<id>] [--all] [--dry-run]` | Shows diff, confirms, pushes; refuses conflicted tickets |
| `cankan sync` | `[<backer>] [--check]` | Pull then push; `--check` exits non-zero on divergence, no writes |
| `cankan resolve` | `<id> --ours\|--theirs\|--edit` | Clears conflict state |
| `cankan import` | `<backer> [<selector>] [--filter jql\|labels…] [--since date]` | Pulls a whole project/repo onto the board; idempotent |
| `cankan adopt` | `<backer> [--label l] [--milestone m] [--ids…] [--link-existing]` | Pushes native tickets up, sets origin; partial by design; `--link-existing` title-matches with confirmation |
| `cankan compact` | `[--closed-before 90d] [--dry-run]` | Summarizes old closed tickets |

### Views and serving
| Command | Arguments / flags | Notes |
|---|---|---|
| `cankan board` | `[--group-by column\|actor\|human\|milestone\|backer] [--order keys] [--watch]` | Terminal board; cards within a column follow `--order` |
| `cankan render` | `[-o BOARD.md] [--mermaid]` | Static markdown board |
| `cankan mcp` | `start [--cwd path] [--board personal\|all\|<name>]` | MCP stdio server; tools mirror this CLI; `--board all` serves an orchestrator view across repos |
| `cankan serve` | `[--port 6420]` | Phase 3 only |
| `cankan events` | `[--since 1d] [--ticket id] [--actor a] [--follow] [--all]` | Tail the event log |

### Exit codes
`0` ok · `1` generic error · `2` usage · `3` claim rejected (already held) · `4` sync conflict · `5` policy violation (e.g. attempted override of pinned key) · `6` backer auth/connectivity.

---

## Development plan

### Tech stack
- **TypeScript on Bun**; npm package (`bunx cankan` / `npx cankan`) plus `bun build --compile` binaries for Homebrew/curl.
- **Monorepo:** `packages/core` (event log, git ops, claims, actors, backer interface), `packages/cli`, `packages/mcp`, `packages/backers/{beads,github,jira}` (no native or Backlog.md adapter — those are just the local file layer).
- **CLI:** `citty`; every command has `--json` and `--plain`.
- **Schema:** `zod`; `gray-matter` for frontmatter.
- **Git:** shell out to system `git` through one subprocess chokepoint (`packages/core/src/git/transport.ts`). Not isomorphic-git — refs, worktrees, and hooks must match the user's git exactly. `simple-git` was the original choice and was dropped in M2.6: its error detection resolves any command that exits non-zero with empty stderr as a *success*, which silently swallowed `git check-ref-format`'s rejection and would have let ADR 0001's flagship abuse ref pass validation.
- **Index:** `bun:sqlite`, rebuildable cache over events + definitions; `cankan reindex`.
- **MCP:** `@modelcontextprotocol/sdk`, stdio, tools 1:1 with core.
- **Backers:** beads via its JSONL export / `bd --json`; `octokit` for GitHub; Jira REST v3 (Cloud first, Data Center via the same client). Each backer is its own package behind one interface; Backlog.md needs no adapter because its files are our files.
- **Web UI:** none in Phases 1–2. Each backer's own board covers it. Reassess in Phase 3.
- **Testing:** `bun test`; fixture repos with real git; concurrency tests spawn multiple processes claiming the same ticket; a shared **backer conformance suite** run against every adapter (recorded/replayed HTTP for GitHub and Jira, JSONL fixtures for beads).
- **CI/release:** GitHub Actions, changesets, npm + binaries.

### Phase 0 — Spike and upstream probe (1–2 weeks)
- Open the Backlog.md issue proposing leased `claim`.
- Throwaway: events on an orphan ref; three worktrees claim concurrently; survive rebase and merge. If it fails, adopt the fallback mode and document the trade-off.

### Phase 1 — Solo orchestrator MVP
Goal: someone already on a repo-native tracker stops having collisions in one session.
- Core: local file layer (Backlog.md-compatible layout + `cankan:` block), coordination ref, event log, leased claims, actors, backer interface + conformance suite with a mock backer.
- Zero backers required. Existing Backlog.md task directories are picked up as-is.
- CLI: setup, tickets, coordination, and views groups from the reference (no sync group yet beyond a mock backer); config layering with policy/preference resolution and `config show --resolved`.
- Prioritization: `--order` sort keys, `rank` via `ordinal`, `ready.order` default. Named queues land in Phase 2 alongside the backers they filter on.
- Personal board: same engine at an XDG data path; `--board personal`, `cankan p`, lazy init, optional private remote. Cheap because it's a root change, and it's the fastest way to dogfood daily.
- Backlog.md layout compatibility is a conformance test from the first release (write with CanKan, read with real Backlog.md, and vice versa); Phase 0 confirms whether their parser accepts `ck-` IDs or `adopt backlog` must renumber.
- MCP server. `init` emits agent instructions (appending to Backlog.md's when present) + MCP config for Claude Code, Codex, opencode.
- `BOARD.md` render + hook.

### Phase 2 — Team on-ramp
- **GitHub Issues and Jira together**, developed in parallel against the conformance suite so the interface isn't accidentally shaped by whichever came first; a mixed-origin board is a Phase 2 acceptance test. beads as a third backer.
- `import`, `pull`, `push`, `sync`, `sync --check`, `status`, `resolve`, `adopt`; `auto_push` policy; per-backer status mapping.
- `board --group-by actor|human|milestone`; `assign` vs `claim`; named queues with actor patterns; `priority_map` per backer.
- Cross-repo: repo registry, `--board all` aggregation, `<repo>:<id>` addressing and cross-board deps, `move-to`, `mcp start --board all`.
- Contributor/stealth modes; `compact`.
- Homebrew, compiled binaries.

### Phase 3 — Visibility and reach
- Additional backers by demand (Linear, GitLab Issues, Azure Boards). Pages export of the read-only board.
- Skills/hooks for Zed, VS Code, Cursor, Kiro, Gemini CLI.
- Decide on a web UI based on evidence.

### Phase 4 — Demand-gated
- First-class milestones/releases. Cross-repo boards. Real-time cross-machine channel.

### Risks
- **Coordination ref UX:** unfamiliar orphan branch, push failures on protected refs. Mitigate: naming, `doctor`, docs.
- **Backer drift:** the reconciliation report must be excellent or teams won't trust sync.
- **Accidental favoritism:** the first backer built tends to shape the interface. Mitigate by building GitHub and Jira side by side and by the `capabilities` contract.
- **Upstream velocity:** Backlog.md and beads ship weekly; contract tests against their real formats are mandatory.
- **Absorption:** Backlog.md adds claiming. Hedge with backer breadth and the actor model.
- **Scope creep toward "yet another tracker":** the layer strategy only works if we refuse to build what backers already have.
- **Cross-repo aggregation cost:** `--board all` over many repos means many git refs to read; keep it index-backed (`$XDG_CACHE_HOME`) with staleness shown, never block on fetching every remote.
- **Backlog.md schema drift:** our native format tracks their schema; a breaking change on their side breaks round-tripping. Mitigate with pinned-version conformance tests and the `cankan:` namespace for anything of ours.
- **Jira breadth:** Jira's workflow customization is unbounded; the status-mapping config has to be flexible without becoming its own product. Ship opinionated defaults and let teams override.
