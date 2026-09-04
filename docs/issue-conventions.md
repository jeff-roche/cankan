# Issue conventions

How `PLAN.md` tasks become GitHub issues (`scripts/plan-to-issues.ts`,
run in MB.2/MB.3), chosen so the GitHub backer's default `status_map` /
`priority_map` and importer (M6.4) can read them back without translation.

## Title

`[M2.7] Event log` — the task ID in brackets, then the piece name (no
backticks, even if the plan's heading has them). The importer strips the
bracketed prefix into `cankan.display_id`'s companion field `task_id`.

## Milestones

One GitHub milestone per plan milestone: `M0`, `MB`, `M1` … `M6`. Each has
a tracking issue titled `[M2] Core` (bracketed milestone ID, then the
milestone's name) with a live task-list body linking every task issue in
that milestone. Maps to `parent-child` on import.

## Priority labels

`P0` `P1` `P2` `P3` → `critical` `high` `medium` `low` (the GitHub
backer's default `priority_map`).

- **P0** — on the critical path (`PLAN.md`'s "Critical path" section).
- **P1** — a `[wire]` task not already on the critical path.
- **P2** — everything else.
- **P3** — not auto-assigned; reserved for tasks deliberately deprioritized
  after the fact.

## Status labels

None at open. `in-progress` / `in-review` while active. Closed = Done.
Matches the default `status_map`.

## Type labels

- **piece** — creates a new piece of the system (the common case).
- **wire** — a `[wire]` integration task.
- **spike** — throwaway exploratory work (`M1.1`).
- **docs** — creates only documentation (every `Creates` path under
  `docs/`).

## Body template

```
## Creates
…

## Wires
…

## Done when
…

Depends on: #12, #15
Part of: #3
```

Any other bolded field in a task's `PLAN.md` block (for example M6.4/6.5's
"Required by…") becomes its own `## <Label>` section, in the order it
appears in the plan. `Depends on:` lines are the dependency
representation - the GitHub backer (M6.4) parses `Depends on:` /
`Blocked by:` lines and GitHub sub-issue links into `blocks` deps on
import, and writes them back on push in the same format. `Part of:` points
at the task's milestone tracking issue - maps to `parent-child`.

## Idempotency

`plan-to-issues.ts` matches existing issues by the `[Mx.y]` (or `[Mx]` for
a milestone tracking issue) prefix in the title, so re-running it updates
in place rather than duplicating. `--dry-run` performs only read calls
against the GitHub API and prints the diff without writing anything.
