# 0001: Coordination ref concurrency mechanism

## Status

Accepted (2026-09-04).

## Context

CONCEPT.md §3 ("Cross-branch: the coordination ref") makes CanKan's central
design bet: that claims and status events can live on a dedicated orphan
git ref, `refs/cankan/coordination`, rather than in-tree or on a server.
Because worktrees and branches share one `.git`, every worktree should see
every claim instantly with no server; cross-machine sharing should be an
explicit push/pull of that one ref. §4 ("Concurrency: atomic leased
claims") specifies `cankan claim <id>` as compare-and-swap and currently
says the local mechanism is "file lock + commit on the coordination ref."
This decision is the go/no-go on that whole design (PLAN.md M1.2), and, per
§4, chooses between two concrete local concurrency mechanisms: git's own
`git update-ref <ref> <new> <old>` compare-and-swap, or an OS-level file
lock serializing a non-atomic read-modify-write. It can't be retrofitted
after M2.6/M2.7 are built on top of it, so it must be a decision, not a
survey.

**What was tested.** M1.1's spike (`spikes/coordination-ref/`, commit
`136e1cd`) runs six scenarios against real temporary git repos and real
spawned OS processes: (1) create the ref, append N claim events, read them
back; (2) three concurrent processes race to claim the same ticket, once
via `git update-ref` CAS and once via an `O_EXCL` file lock, 10 iterations
each, plus a dedicated stale-lock experiment; (3) `git rebase`; (4) `git
merge`; (5) push/fetch through a bare remote, including a genuine
cross-machine non-fast-forward conflict; (6) claim from a secondary
worktree, read from the primary with no fetch. `spikes/coordination-ref/
RESULTS.md` is the spike's committed evidence artifact for one specific
run.

**Independent re-runs.** `bun spikes/coordination-ref/run.ts` was re-run
four times in this environment before this ADR was drafted. All six
scenarios passed in all four runs (24/24), reproducing the committed
`RESULTS.md`. Figures drawn from these four re-runs are cited separately
from the single run committed in `RESULTS.md`, because the spike's timings
are non-deterministic by its own README's admission and one committed run
should not be over-read as representative — see Evidence, "File lock
timing." These four-re-run figures are author-reported and recorded here
for transparency; they exist in no committed artifact, and `RESULTS.md`
remains the single reproducible baseline.

**Environment** (identical across the committed run and the four re-runs
performed for this ADR):

- `git version 2.55.0`
- `bun 1.4.0`
- OS: `Linux 7.2.2-1-cachyos (linux/x64)` (CachyOS, an Arch derivative)
- Testing was Linux-only. Git's plumbing commands (`update-ref`,
  `commit-tree`, `hash-object`, `read-tree`) are cross-platform, so the CAS
  mechanism itself is not expected to be OS-sensitive, but this has not
  been verified on macOS or Windows.

## Decision

**Mode: `shared-ref`.** Not `branch-scan` (the fallback CONCEPT.md
describes for "if Phase 0 fails or a user opts out"). All six scenarios
passed cleanly, including the two that stress the "no server, shared
`.git`" premise directly (worktree visibility, and rebase/merge leaving
the ref untouched). Nothing in the spike's results signals a need for the
lossy fallback; see Alternatives considered for why `branch-scan` was not
independently evaluated.

**Local CAS mechanism: `git update-ref` compare-and-swap.** Not a file
lock. Both mechanisms passed the same correctness checks under real
three-process contention, so correctness does not discriminate between
them. The decision rests on failure modes and structural complexity, where
CAS wins decisively — full evidence below.

## Evidence

### CAS correctness and contention breadth

`claimViaCAS` (`spikes/coordination-ref/coordination.ts:140`) reads the
ref, checks whether the ticket is already claimed, builds a commit
off-tree (via a private temp index, never touching the real index or
working tree), and attempts `git update-ref refs/cankan/coordination
<new> <old>`. On rejection it re-reads and re-checks rather than blindly
retrying the write, so a loser can only ever report `already_claimed`,
never append a second claim for the same ticket.

Across the four re-runs performed for this ADR (10 iterations each, 40
total), the race-outcome assertion — exactly one `claimed`, exactly two
`already_claimed`, and exactly one claim event in the log matching the
winner's id — held in **all 40 iterations**. Example captured CAS
rejection stderr (one of several, text is representative across all
runs):

```
fatal: update_ref failed for ref 'refs/cankan/coordination': cannot lock
ref 'refs/cankan/coordination': is at <sha> but expected <sha>
```

**Contention breadth is narrower than it first appears.** The spike's
`casContentionCount`/`casMaxAttempts` (`run.ts:255`) records whether *at
least one* losing worker observed a CAS rejection (`attempts > 1`) per
iteration; it does not record whether all three workers were mid-flight
simultaneously, only that at least two were. Across the four re-runs: 39/40
iterations had a losing worker observe a real rejection (one iteration in
the third run had none — both losers apparently read after the winner's
write had already landed). Max attempts by any single worker was **2** in
every iteration, every run — the spike never forced a scenario requiring a
third attempt. The semantic guarantee (one winner, two losers, one log
entry) does not depend on three-way overlap being observed — it follows
from `update-ref`'s own atomicity, checked once per pair that does
overlap — but the evidence supports **at-least-2-way contention,
reliably, not confirmed 3-way contention**: three workers racing
simultaneously was never directly confirmed.

### File lock timing: the committed figure is an outlier

The committed `RESULTS.md` reports a single "longest single lock-wait
observed" of 377.9ms — a figure the spike itself doesn't contextualize,
since `run.ts:316` records only the max, never min/avg. Four re-runs of
the same scenario, performed for this ADR, produced: **31.0ms, 291.8ms,
440.1ms, 442.6ms** — a roughly 14x spread on the same code, same machine,
same iteration count. This is scheduler noise on process wake-up during
the lock's 10ms poll loop, not a stable property of the mechanism; no
single number, from the committed run or from these re-runs, should be
read as "the" file-lock cost.

More importantly, **the decision does not rest on performance.** The
race-wall-clock figures in both the committed run and these re-runs (CAS
~260-290ms avg, file lock ~280-370ms avg) are dominated by the spike's own
250ms start barrier (`barrier.ts`, `raceOnceCAS`/`raceOnceLock` in
`run.ts:89`/`run.ts:108`) plus three `bun` process startups, not by
mechanism cost — they do not show CAS being faster than file lock, or
vice versa. The actual per-operation cost of either mechanism is better
read from scenario 1 (5 sequential CAS appends: 23.3-196.6ms across the
four re-runs, i.e. roughly single-digit-to-tens of ms per append once
warm) and scenario 6 (one CAS claim from a secondary worktree: 5.4-9.9ms
across the four re-runs). Both mechanisms are fast enough for interactive
CLI/MCP use; neither timing result is the reason CAS was chosen.

### Stale-lock failure mode: not covered by scenario 2's pass/fail verdict

Scenario 2's `**Result: PASS**` header covers only the race-outcome
assertions for the CAS and file-lock races; the stale-lock experiment that
follows it in the same scenario function (`run.ts:322-380`) is appended as
notes and does not affect that pass/fail verdict (`run.ts:370-377` only
*adds a note* if the claimant fails to time out as expected — it never
fails the scenario). Scenario 2's PASS is therefore not, on its own,
evidence about stale locks; the actual evidence is the note text and the
re-runs below:

- The committed run: lockfile left behind after SIGKILLing the holder;
  the subsequent claimant reported `lock_timeout` after its configured
  1.2s timeout.
- The four re-runs performed for this ADR: **the same outcome in all
  four** — lockfile left behind every time (`existsSync` true), and the
  claimant against the stale lock reported `lock_timeout` every time
  (waits observed: 1312.8ms, 1259.3ms, 1221.4ms, 1219.4ms — all correctly
  bounded near the configured 1.2s timeout, never hanging indefinitely
  because the spike's `acquireLock` polls to a deadline).

This is a real, reproducible failure mode of the file-lock mechanism: the
spike's lockfile (`lockfile.ts`) has no PID-liveness or lease-based
staleness detection, so a process killed while holding the lock
(`SIGKILL`, OOM, crash) leaves every subsequent claimant blocked to its
own timeout with no automatic recovery. `git update-ref` has no analogous
failure: a killed process simply leaves the ref at its last value; there
is no separate lock object to leak.

### File lock's worktree path problem (decision-relevant)

The spike places its lockfile at `join(repoDir, ".git",
"cankan-coordination.lock")` (`run.ts:283`), with a comment claiming this
is "shared across worktrees since `.git` is shared." That is true only for
the **main** worktree, where `.git` is a directory. Independent
verification for this ADR (outside the spike) confirms that in a
**linked** worktree, `.git` is a plain text file containing a pointer, not
a directory:

```
$ git -C <linked-worktree> rev-parse --git-dir
<main>/.git/worktrees/<name>
$ git -C <linked-worktree> rev-parse --git-common-dir
<main>/.git
```

A lock path built the spike's way (`join(worktreeDir, ".git", ...)`) from
a linked worktree would attempt to create a file inside what is actually a
plain text file, not a directory — it would need `git rev-parse
--git-common-dir` to find the genuinely shared location instead. **The
spike never exercises this**: scenario 2's lock race runs only against
`casRepo.dir`/`lockRepo.dir`, the main worktree in each temp repo, never
against a linked worktree directory. This is a real extra correctness
requirement the file-lock approach carries — get the shared path wrong and
worktree A's lock silently fails to serialize against worktree B's lock —
that the CAS approach does not have: git's own ref store is already
common-dir-aware, so `git update-ref` from any worktree contends
correctly with no extra path computation.

### Refspec requirement: steady-state push and fetch

Scenario 5, all four re-runs plus the committed run, consistently
confirmed:

- A default `git push origin main` does **not** move
  `refs/cankan/coordination` on the remote.
- A plain `git clone` does **not** bring `refs/cankan/coordination` along.
- A default `git fetch origin`, run again after the remote has moved on,
  does **not** advance an already-existing local
  `refs/cankan/coordination` — the explicit refspec is required on
  *every* fetch, not just the first one that creates the ref locally.
- The explicit refspec `refs/cankan/coordination:refs/cankan/coordination`
  correctly moves the ref on both push and fetch, when the local side is
  strictly behind (fetch) or strictly ahead (push).
- A non-fast-forward push of the coordination ref (constructed by having a
  clone append its own claim off a stale local ref, independent of a
  second claim already pushed from the original repo) is rejected by git
  by default, no force needed: `! [rejected] refs/cankan/coordination ->
  refs/cankan/coordination (fetch first)`.

**What was actually tested:** the "default push doesn't move it" check
(`run.ts:543`) tests `git push origin main`, not a bare `git push` with no
arguments. This doesn't change the conclusion — a repo's default push
refspec only ever covers `refs/heads/*`, whether or not a branch is named
explicitly.

This refspec — `refs/cankan/coordination:refs/cankan/coordination`,
applied to the *working* local ref — is correct only when one side is
strictly ahead of the other. It is not the refspec to use once both sides
have diverged; see the next section.

### Refspec for reconciliation fetches

The scenario 5 push rejection above shows that pushing the working ref
when the remote holds commits the local side lacks is rejected as
non-fast-forward. The mirror case — fetching the working ref when the
*local* side holds commits the remote lacks — was not exercised by the
spike itself (scenario 5 only tested a clean fast-forward fetch and the
push-side rejection). Direct git commands run for this ADR, outside the
spike script, confirm the mirror case behaves the same way: fetching the
plain, non-`+`-prefixed explicit refspec into the *same* local ref name
when both sides hold commits the other lacks is itself rejected as
non-fast-forward:

```
! [rejected]        refs/cankan/coordination -> refs/cankan/coordination  (non-fast-forward)
```

This is why reconciliation cannot use a plain fetch into the working ref.
The verified alternative is a fetch into a **distinct local ref name**:

```
git fetch origin refs/cankan/coordination:refs/cankan/coordination-remote
```

This was confirmed, by the same direct git commands, to succeed
unconditionally regardless of divergence — it is a plain creation or
fast-forward of a ref nothing else writes to, never a CAS or a merge
against the working `refs/cankan/coordination`. Re-running it after the
remote advances again also succeeds without a rejection, for the same
reason: nothing else ever moves the staging ref out from under it.

From the staging ref, the adapter reads both the local working ref and the
staging ref's event logs, unions them, rebuilds a single new commit on top
of the staging ref's tip, and CASes the local working ref onto that new
commit (see Consequences). The fetch-into-a-distinct-name step is
observed to work, by the commands above; the union/rebuild/CAS logic that
follows it is a reasoned design, not exercised by any test — a concrete
test obligation for M2.6/M2.7, not something this ADR can claim was
verified.

### Lease expiry — not exercised

CONCEPT.md §4 specifies claims succeed "only if unclaimed or expired."
The spike's `findClaim` (`coordination.ts:70`) returns the most recent
claim event for a ticket unconditionally — it has no concept of lease
expiry at all, so none of the six scenarios exercise the "expired claim
can be reclaimed" path. This is a gap between what CONCEPT.md specifies
and what the spike (correctly, since it's out of scope for a
concurrency-primitive spike) implements — flagged for M2.6/M2.7, not
resolved here.

## Alternatives considered

**`branch-scan` fallback mode:** not chosen, and not independently
spiked. CONCEPT.md itself frames this as a fallback "if Phase 0 fails or a
user opts out," documented as lossy. Since `shared-ref` passed all six
scenarios — including the two (worktree visibility, survival across
rebase/merge) that most directly test the "no server, shared `.git`"
premise it depends on — there is no result here that motivates falling
back, and no comparative data exists because `branch-scan` was never
built or measured. It should remain documented as a fallback for a future
concrete blocker (e.g., a git host that strips non-standard refs on
push), not implemented speculatively now.

**File lock (`O_EXCL`) as the local concurrency primitive:** measured,
rejected. Both mechanisms passed identical correctness checks under real
three-process contention (see Evidence), so this was not decided on
correctness. It was decided on:

1. **Stale-lock failure mode**, reproduced by `SIGKILL`ing a lock holder
   in all four re-runs performed for this ADR and in the committed run:
   the lockfile is left
   behind (no PID-liveness/lease check exists or is trivial to add
   correctly), and every subsequent claimant blocks to its own timeout
   with no automatic recovery. `git update-ref` has no equivalent
   liability — a killed process just leaves the ref at its last value.
2. **The worktree shared-path problem**, found by reasoning about the
   spike's own code plus independent verification (see Evidence): the
   spike's lock path (`<repoDir>/.git/cankan-coordination.lock`) is only
   correct from the main worktree; a linked worktree's `.git` is a file,
   not a directory, and the genuinely shared location requires `git
   rev-parse --git-common-dir`. The spike's lock race never ran from a
   linked worktree, so this gap was never caught by the spike itself —
   it is exactly the kind of bug that would silently break cross-worktree
   serialization in production. CAS needs no such path computation; git's
   ref store handles common-dir resolution itself.
3. **No performance advantage** in either direction — the observed
   variance in file-lock wait times (14x across four re-runs on identical
   code) makes it, if anything, less predictable than CAS's near-instant
   fail-and-retry, though this was not the deciding factor (see Evidence,
   "File lock timing").

A hybrid (file lock guarding a CAS write) was not considered — CAS alone
already provides atomicity with no external lock object, so adding a lock
on top would only reintroduce the stale-lock and worktree-path problems
for no additional correctness benefit.

## Consequences

### M2.6 (`git/adapter.ts`) must implement

- **`readRef(ref)`**: `git rev-parse --verify <ref>`, returning `null` if
  the ref doesn't exist (spike's `git-plumbing.ts:102`).
- **`updateRefCAS(ref, newSha, oldSha)`** — new value second, old value
  third; see "PLAN.md notation should be revised" below for why this
  order is stated explicitly. Implementation: `git update-ref <ref>
  <newSha> <oldSha ?? ZERO_SHA>` (the 40-zero sha for "ref must not exist
  yet") — the trailing old-value argument to `update-ref` *is* the entire
  CAS mechanism; no separate locking is needed around it. Return both
  success/failure and the exact stderr on failure (spike's
  `git-plumbing.ts:113`), since the retry policy below depends on being
  able to tell a CAS rejection apart from any other git failure. The
  spike's own `claimViaCAS` (`coordination.ts:171-183`) does not yet make
  this distinction — it retries on any non-zero `update-ref` exit, so a
  corrupted ref or a permissions failure would silently loop up to 50
  times today. M2.6 must match the returned stderr against the
  CAS-rejection signature (`cannot lock ref '...': is at X but expected
  Y`) before deciding to retry, and treat anything else as a hard failure
  — this discrimination is new work, not something the spike already
  does.
- **`commitTreeToRef`**: build a commit entirely off-tree — blob via
  `git hash-object -w --stdin`, tree via a private temp index
  (`GIT_INDEX_FILE` pointed at a fresh `mkdtemp()` directory per call, so
  concurrent callers never collide on one index file), commit via `git
  commit-tree <tree> -p <old> -m <msg>` — never touching the real index or
  working tree (spike's `git-plumbing.ts:64`, `coordination.ts:102`).
- **`readBlobFromRef(ref, path)`** (named in `PLAN.md`'s M2.6 line, not
  given its own spec by the spike directly): resolve `ref` to a commit,
  then read `<path>` at that commit — `git cat-file -p <commit>:<path>`,
  exactly the spike's `readFileAtCommit` (`git-plumbing.ts:129`). Return
  the blob's content as a string when it exists; return `null`, not
  throw, when the path doesn't exist at that commit — the spike's version
  keys this off `cat-file`'s exit code, treating any non-zero exit as
  "not found" (`git-plumbing.ts:134-135`) rather than distinguishing
  "file missing" from other errors, which is adequate for what this is
  used for here: reading a specific month's JSONL file (which may not
  exist yet — no claims that month is not an error) and reading it at a
  specific historical commit (rebuilding state at a point in time).
  Callers must treat `null` as "empty," not "failure."
- **Retry/backoff policy on CAS contention**: on rejection, **re-read the
  ref and re-check the claim state before retrying the write** — never
  blindly retry the same write. This is what the spike's `claimViaCAS`
  already does and it is empirically sufficient at 3-worker contention:
  39/40 iterations across the four re-runs performed for this ADR resolved
  within 2 attempts, and
  the spike's `maxAttempts = 50` was never approached. For contention
  levels the spike didn't test (more concurrent claimants, or the general
  case of concurrent *different-ticket* appends — see M2.7 below), add
  jittered backoff between attempts and a bounded max attempt count (50 is
  a reasonable starting point, matching the spike) that surfaces a typed
  "claim contention exceeded" error rather than retrying forever. This
  part of the policy is **reasoned, not measured** — the spike never
  forced contention beyond 3 same-ticket racers.
- **Required refspec for steady-state push and fetch, with no exception
  once the ref exists**: `refs/cankan/coordination:refs/cankan/
  coordination`, applied directly to the local working ref. Confirmed
  (see Evidence): default push/fetch/clone never touch this ref, not even
  to advance an already-existing local copy. Use this exact refspec
  string as an explicit argument on every push/fetch call — do **not**
  rely on a persistent `remote.origin.fetch` config entry as an
  alternative; that was not tested here, and a `+` (force) prefix on such
  a config entry would be actively dangerous given the reconciliation
  requirement below (it would let a fetch silently clobber unpushed local
  claims instead of failing safe). This refspec is only ever correct when
  one side is strictly ahead of the other — see the reconciliation
  refspec below for the diverged case.
- **Cross-machine push rejection handling**: on a non-fast-forward push
  rejection (confirmed exact stderr: `! [rejected]
  refs/cankan/coordination -> refs/cankan/coordination (fetch first)`),
  the push path must **fetch (into a staging ref, per the reconciliation
  refspec below) and reconcile, then retry the push — never force-push**.
  This matches CONCEPT.md §4's "optimistic push, retry on rejection,"
  which turns out to be exactly git's own non-fast-forward protection,
  free.
- **Fetch-side reconciliation when local and remote have both advanced**:
  fetch the remote ref into a **distinct local ref name** — `git fetch
  origin refs/cankan/coordination:refs/cankan/coordination-remote` —
  never the working ref directly, since a plain fetch of the working
  ref's own refspec is itself rejected as non-fast-forward once both
  sides have diverged (confirmed by direct testing; see Evidence,
  "Refspec for reconciliation fetches"). From the staging ref: read both
  the local and staged event logs; union the events (dedupe by event id —
  the log is append-only, so this is a set union, not a merge of mutable
  state); rebuild a single new commit chain on top of the staging ref's
  tip containing any locally-appended events it doesn't have; CAS the
  local working ref to that new commit; then push. The fetch-into-a-
  staging-ref step is observed to work; the union/rebuild/CAS logic after
  it is a reasoned design, **not exercised by any test**. **This is an
  explicit test obligation for M2.6/M2.7** — build the test before
  relying on the design.
- **Ref must never be assumed to exist**: a fresh clone brings no
  `refs/cankan/*` (confirmed). The adapter must check `readRef` and, if
  `null`, either initialize the ref (fresh repo/board) or fetch it
  explicitly (existing remote board) before any claim/read operation —
  never assume "the ref is just there" the way an ordinary branch would
  be after clone.
- **Lease expiry**: CONCEPT.md §4's "succeeds only if unclaimed or
  expired" is not implemented anywhere in the spike (its `findClaim`
  always honors the latest claim event, unconditionally). M2.6/M2.7 must
  add the expiry check themselves; do not treat the spike's claim-lookup
  logic as the full spec.
- **`listWorktrees`**: not covered by the concurrency decision itself, but
  needed for whatever M2.6 does with the worktree-path problem noted
  above if any lock-adjacent tooling is ever added; not otherwise
  constrained by this ADR since CAS needs no per-worktree path resolution.

### M2.7 (`events/log.ts`) must implement

- **`append(event)`**: generalize `claimViaCAS`'s pattern (read → check →
  build commit off-tree → `updateRefCAS` → on rejection, re-read and
  re-check rather than blind-retry) from "claim" events to the full event
  union.
- **Monthly JSONL layout** under the ref, unchanged from the spike:
  `events/<yyyy-mm>.jsonl`, one JSON object per line, appended in order.
  **The claim-lookup logic built on top of this layout must not be
  carried forward unchanged** — see "Cross-month claim blindness" in
  Known failure modes below: the spike's own claim check only ever reads
  the current month's file, which is a correctness gap, not a layout
  concern. `read({since, ticket, actor})` must aggregate across as many
  trailing months as the longest configurable lease can span, not just
  the current one.
- **ULID ids**, not the spike's `randomEventId()` (a UUID stand-in
  explicitly marked "not a real ULID... for a throwaway spike" in
  `git-plumbing.ts:138`) — do not carry that stand-in forward.
- **Test obligation beyond what the spike measured**: M2.7's own
  done-when criterion is "appends from two worktrees interleave without
  loss." The spike's scenario 2 only raced three workers claiming the
  *same* ticket — a loser there always resolves to `already_claimed` and
  appends nothing, so its CAS retry never had to actually merge two
  different appends. The real case M2.7 must test and the spike never
  measured is **two workers appending different events concurrently**
  (e.g., ck-A and ck-B claimed at the same instant from two worktrees):
  both must land in the log, neither dropped, via the same re-read-and-
  rebuild-on-rejection pattern — reasoned to work from the same CAS
  primitive, but not itself exercised by this spike.
- **Offline double-claim at reconciliation**: if the fetch-side
  reconciliation above unions two claim events for the *same* ticket
  from two machines that were both offline, `append`/`log.ts` must
  **preserve both events** (never silently drop one during reconciliation
  — the log is append-only) so that `state/fold.ts` (M2.8) can apply a
  deterministic tie-break (e.g., earliest timestamp wins) and the losing
  claimant can be told. This ADR does not design that tie-break — it only
  flags that the event log's reconciliation step must not be the place
  that silently resolves the conflict by dropping data.

### CONCEPT.md should be revised (not corrected here, per constraint)

- §4 ("Concurrency... Locally: file lock + commit on the coordination
  ref.") should be revised to say `git update-ref` compare-and-swap, not
  a file lock — this ADR replaces that line.
- §3's "Cross-machine sharing = push/pull that ref" should be revised to
  note that the explicit `refs/cankan/coordination:refs/cankan/
  coordination` refspec is required on every push and fetch, not implied
  by a plain `git push`/`git pull`/`git clone` — confirmed none of those
  touch it, even once the ref exists locally.
- The config example's `push_ref: true # push/pull the coordination ref
  with normal git remote ops` (`CONCEPT.md:293`) should be revised: normal
  remote operations never move the ref regardless of any config flag —
  there is no "normal git remote ops" mode that pushes/pulls it, only the
  explicit refspec above. The line should describe that requirement, not
  imply a config toggle changes git's default refspec behavior.
- "Append-only merges trivially" (`CONCEPT.md:160`) and "append-only
  events prevent conflicts" (`CONCEPT.md:229`) should be revised to
  distinguish two different senses of "conflict." The event log itself
  has no *semantic* merge conflicts, because it's append-only — two
  events never need reconciling against each other's content. But
  git-level non-fast-forward conflicts on the ref pointer itself do
  occur — confirmed directly, both on push (Evidence, "Refspec
  requirement") and on fetch (Evidence, "Refspec for reconciliation
  fetches") — whenever two sides have both advanced the ref
  independently. Append-only prevents content conflicts; it does not
  prevent the ref pointer from needing reconciliation.

### PLAN.md notation should be revised (not edited here, per constraint)

`PLAN.md`'s M2.6 line (`PLAN.md:243`) writes the git adapter's CAS
signature as `updateRefCAS(ref, expectedOld, new)` — old value second,
new value third. This ADR and the spike it is built on
(`git-plumbing.ts:113`) use the opposite order,
`updateRefCAS(ref, newSha, oldSha)` — new value second, old value third.
**The signature this ADR specifies for M2.6 to implement is
`updateRefCAS(ref, newSha, oldSha)`**, matching the spike (see
Consequences above). `PLAN.md:243`'s notation is the one that should be
revised to match — an implementer reading both documents together should
not have to guess which argument order is authoritative on a
compare-and-swap, where getting it backwards silently inverts the check.

## Known failure modes

Distinguishing observed (reproduced by the spike, or by direct
verification performed for this ADR) from reasoned (not exercised,
inferred from the mechanism):

1. **CAS rejection under real contention — observed.** A losing worker's
   `git update-ref` call fails with `cannot lock ref '...': is at <X> but
   expected <Y>`. User sees: nothing directly (this is internal to a
   single `claim` invocation). Code must: catch the exit code, re-read the
   ref, re-check whether the ticket is now claimed, and either report
   `already_claimed` or rebuild and retry the write — never blind-retry
   the same commit.
2. **Contention exceeding the retry bound — reasoned, not measured.** The
   spike's 3-worker races never exceeded 2 attempts; higher concurrency
   was not tested. User sees: a claim attempt that appears to hang or
   fails after many retries. Code must: bound attempts (with jittered
   backoff between them) and surface a typed error rather than retrying
   indefinitely.
3. **Cross-machine non-fast-forward push rejection — observed.** Exact
   stderr: `! [rejected] refs/cankan/coordination ->
   refs/cankan/coordination (fetch first)`. User sees: nothing if handled
   internally by the retry-fetch-reconcile path; a push-conflict message
   only if that path itself ultimately fails. Code must: fetch with the
   explicit refspec, reconcile (see Consequences), retry — never force.
4. **Divergent fetch reconciliation — partly observed, partly reasoned.**
   A plain fetch of the working ref's own refspec is rejected as
   non-fast-forward once local and remote have both advanced —
   **observed** directly (see Evidence, "Refspec for reconciliation
   fetches"). Two machines each appending events (possibly to different
   tickets, possibly the same one) while offline, then both syncing, hit
   exactly this on the next fetch. User sees: their sync/push either
   succeeds after a brief delay once the adapter fetches into a staging
   ref and reconciles (typical case), or, if both machines claimed the
   *same* ticket, one of them finds out their claim didn't hold once
   reconciliation runs. Code must: fetch into a staging ref (observed to
   work), union event logs by event id (append-only, never drop), rebuild
   and CAS the local ref, and — for the same-ticket case — let `state/
   fold.ts` (M2.8) apply a deterministic tie-break and notify the loser.
   The fetch-into-staging-ref step is observed; the union/rebuild/CAS
   logic and the tie-break itself are **reasoned, not tested** — not
   designed in this ADR, flagged for M2.7/M2.8.
5. **Stale file lock — observed, applies only if the file-lock
   alternative were ever used instead of the chosen CAS mechanism.**
   Included here because it is a concrete failure mode this ADR's
   decision specifically avoids: a process `SIGKILL`ed while holding the
   lock leaves it behind indefinitely (no PID-liveness/lease check),
   blocking every subsequent claimant to its timeout. Not a failure mode
   of the chosen design — `git update-ref` has no lock object to leak — but
   recorded so a future contributor doesn't reintroduce a file lock
   without knowing why it was rejected.
6. **Coordination ref absent after clone or ignored by default fetch —
   observed.** A fresh `git clone` brings no `refs/cankan/*`; a default
   `git fetch`/`git pull` never creates or advances one that already
   exists locally, even after the remote has moved on. User sees: a
   board that looks like it has no claims/events at all, or one that
   looks stale, purely because an ordinary git operation was trusted.
   Code must: never rely on ordinary clone/fetch/pull for coordination
   state; always use the explicit refspec, and lazily initialize the ref
   if `readRef` returns `null` where a board is expected to have one.
7. **Lease expiry not enforced — reasoned, not implemented anywhere
   yet.** CONCEPT.md §4 specifies expired claims return to Ready; neither
   the spike's `findClaim` nor anything else in this codebase implements
   that check today. User sees: a ticket that should be reclaimable after
   its lease expired still reports `already_claimed`. Code must: implement
   the expiry check as part of M2.6/M2.7's claim-lookup logic, not assume
   the spike's unconditional "latest claim wins" lookup is the full spec.
8. **Malformed JSONL entry in the event log — reasoned, not tested.** A
   corrupted or partially-written line in a monthly event file would
   throw on `JSON.parse` (spike's `coordination.ts:56`, unguarded). User
   sees: a hard crash reading board state instead of a clear error. Code
   should: skip-and-warn with file/line context, or fail with a
   diagnosable error identifying the offending ref/commit/file, rather
   than an unguarded parse exception.
9. **Cross-month claim blindness — reasoned, not implemented; this is a
   substantive gap, not an edge case.** `eventFilePath()` defaults to the
   current UTC month (`coordination.ts:26`), and both `claimViaCAS` and
   `findClaim` only ever read that single month's file
   (`coordination.ts:147`, `70`). A claim lookup is therefore blind to
   claims recorded in a previous month's file. Given CONCEPT.md §4's
   default 2h lease, a claim made shortly before a UTC month boundary is
   still well within its lease when a check made just after the boundary
   looks only at the new month's file — which has no entry for that
   ticket — so the ticket reads as unclaimed and can be claimed a second
   time. This is exactly the double-claim the coordination-ref design
   exists to prevent, reintroduced at a specific time boundary rather
   than by any concurrency failure. User sees: no error at all — a second
   `claim` on an already-claimed ticket silently appears to succeed, near
   a month rollover. Code must: aggregate claim lookups across month
   boundaries — at minimum the current and previous month's files, and
   more generally at least as many trailing months as the longest
   configurable lease can span — never assume the current month's file is
   a complete picture of active claims.
