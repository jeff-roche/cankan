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
RESULTS.md` is Task 1's committed evidence artifact for one specific run.

**My own verification.** Per the controller ruling ("re-run the spike
yourself before writing anything"), I re-ran `bun spikes/coordination-ref/
run.ts` four times in this environment before writing this ADR. All six
scenarios passed in all four runs (24/24). Numbers below that come from my
own re-runs are cited as such, separately from the single run committed in
`RESULTS.md`, because the spike is explicitly non-deterministic in its
timings (its own README says so) and one committed run should not be
over-read as representative — see Evidence, "File lock timing."

**Environment** (identical across the committed run and my four re-runs):

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

Across my four re-runs (10 iterations each, 40 total), the race-outcome
assertion — exactly one `claimed`, exactly two `already_claimed`, and
exactly one claim event in the log matching the winner's id — held in
**all 40 iterations**. Example captured CAS rejection stderr (one of
several, text is representative across all runs):

```
fatal: update_ref failed for ref 'refs/cankan/coordination': cannot lock
ref 'refs/cankan/coordination': is at <sha> but expected <sha>
```

**Contention breadth — stated honestly.** The spike's
`casContentionCount`/`casMaxAttempts` (`run.ts:255`) records whether *at
least one* losing worker observed a CAS rejection (`attempts > 1`) per
iteration; it does not record whether all three workers were mid-flight
simultaneously, only that at least two were. Across my four re-runs: 39/40
iterations had a losing worker observe a real rejection (run 3 had one
iteration with none — both losers apparently read after the winner's write
had already landed). Max attempts by any single worker was **2** in every
iteration, every run — the spike never forced a scenario requiring a third
attempt. The semantic guarantee (one winner, two losers, one log entry)
does not depend on three-way overlap being observed — it follows from
`update-ref`'s own atomicity, checked once per pair that does overlap — but
this spike demonstrates **at-least-2-way contention, reliably, not
confirmed 3-way contention**. State it this way rather than implying all
three workers were shown to race simultaneously.

### File lock timing — use the re-run spread, not one number

The committed `RESULTS.md` (Task 1's run) reports a single "longest
single lock-wait observed" of 377.9ms. Task 1's code review flagged this
as a high outlier the spike itself doesn't contextualize (`run.ts:316`
records only the max, never min/avg). My four re-runs of the same
scenario produced: **31.0ms, 291.8ms, 440.1ms, 442.6ms** — a roughly
14x spread on the same code, same machine, same iteration count. This is
scheduler noise on process wake-up during the lock's 10ms poll loop, not a
stable property of the mechanism; no single number from either the
committed run or my re-runs should be read as "the" file-lock cost.

More importantly: **the decision does not rest on performance.** The
race-wall-clock figures in both the committed run and my re-runs (CAS
~260-290ms avg, file lock ~280-370ms avg) are dominated by the spike's own
250ms start barrier (`barrier.ts`, `raceOnceCAS`/`raceOnceLock` in
`run.ts:89`/`run.ts:108`) plus three `bun` process startups, not by
mechanism cost — they should not be read as "CAS is faster than file
lock" or vice versa. The actual per-operation cost of either mechanism is
better read from scenario 1 (5 sequential CAS appends: 23.3-196.6ms across
my four re-runs, i.e. roughly single-digit-to-tens of ms per append once
warm) and scenario 6 (one CAS claim from a secondary worktree: 5.4-9.9ms
across my four re-runs). Both mechanisms are fast enough for interactive
CLI/MCP use; neither timing result is the reason CAS was chosen.

### Stale-lock failure mode — cite the note, not scenario 2's PASS header

Scenario 2's `**Result: PASS**` header covers only the race-outcome
assertions for the CAS and file-lock races; the stale-lock experiment that
follows it in the same scenario function (`run.ts:322-380`) is appended as
notes and does not affect that pass/fail verdict (`run.ts:370-377` only
*adds a note* if the claimant fails to time out as expected — it never
fails the scenario). Do not cite "scenario 2: PASS" as evidence about
stale locks. The actual evidence:

- Task 1's committed run: lockfile left behind after SIGKILLing the
  holder; the subsequent claimant reported `lock_timeout` after its
  configured 1.2s timeout.
- My four re-runs: **the same outcome in all four** — lockfile left
  behind every time (`existsSync` true), and the claimant against the
  stale lock reported `lock_timeout` every time (waits observed:
  1312.8ms, 1259.3ms, 1221.4ms, 1219.4ms — all correctly bounded near the
  configured 1.2s timeout, never hanging indefinitely because the spike's
  `acquireLock` polls to a deadline).

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
the **main** worktree, where `.git` is a directory. I verified
independently (outside the spike) that in a **linked** worktree, `.git` is
a plain text file containing a pointer, not a directory:

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

### Refspec requirement (push/fetch)

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
  correctly moves the ref on both push and fetch.
- A non-fast-forward push of the coordination ref (constructed by having a
  clone append its own claim off a stale local ref, independent of a
  second claim already pushed from the original repo) is rejected by git
  by default, no force needed: `! [rejected] refs/cankan/coordination ->
  refs/cankan/coordination (fetch first)`.

**Scoped honestly:** the "default push doesn't move it" check
(`run.ts:543`) tests `git push origin main`, not a bare `git push` with no
arguments. This doesn't change the conclusion — a repo's default push
refspec only ever covers `refs/heads/*`, whether or not a branch is named
explicitly — but the ADR should say what was actually run rather than
imply a bare `git push` was tested.

**Not tested by the spike, reasoned here:** the fetch side of a genuine
two-machine divergence — both sides having appended different events
since the last common ancestor — was never exercised. The spike only
tested a clean fast-forward fetch (remote strictly ahead) and the push
rejection (local strictly behind, caught by git's own protection). What
happens when both a machine's local coordination ref *and* the remote have
advanced independently (e.g., two offline claims on different tickets) is
addressed as a reasoned design in Consequences, not measured — this is a
concrete test obligation for M2.6/M2.7, not something this ADR can claim
was verified.

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
   in all four of my re-runs plus the committed run: the lockfile is left
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
- **`updateRefCAS(ref, newSha, oldSha)`**: `git update-ref <ref> <newSha>
  <oldSha ?? ZERO_SHA>` (the 40-zero sha for "ref must not exist yet") —
  the trailing old-value argument to `update-ref` *is* the entire CAS
  mechanism; no separate locking is needed around it. Return both
  success/failure and the exact stderr on failure (spike's
  `git-plumbing.ts:113`), since the retry policy below depends on being
  able to tell a CAS rejection apart from any other git failure.
- **`commitTreeToRef`**: build a commit entirely off-tree — blob via
  `git hash-object -w --stdin`, tree via a private temp index
  (`GIT_INDEX_FILE` pointed at a fresh `mkdtemp()` directory per call, so
  concurrent callers never collide on one index file), commit via `git
  commit-tree <tree> -p <old> -m <msg>` — never touching the real index or
  working tree (spike's `git-plumbing.ts:64`, `coordination.ts:102`).
- **Retry/backoff policy on CAS contention**: on rejection, **re-read the
  ref and re-check the claim state before retrying the write** — never
  blindly retry the same write. This is what the spike's `claimViaCAS`
  already does and it is empirically sufficient at 3-worker contention:
  39/40 iterations across my four re-runs resolved within 2 attempts, and
  the spike's `maxAttempts = 50` was never approached. For contention
  levels the spike didn't test (more concurrent claimants, or the general
  case of concurrent *different-ticket* appends — see M2.7 below), add
  jittered backoff between attempts and a bounded max attempt count (50 is
  a reasonable starting point, matching the spike) that surfaces a typed
  "claim contention exceeded" error rather than retrying forever. This
  part of the policy is **reasoned, not measured** — the spike never
  forced contention beyond 3 same-ticket racers.
- **Required refspec, every push and every fetch, with no exception once
  the ref exists**: `refs/cankan/coordination:refs/cankan/coordination`.
  Confirmed (see Evidence): default push/fetch/clone never touch this ref,
  not even to advance an already-existing local copy. Use this exact
  refspec string as an explicit argument on every push/fetch call — do
  **not** rely on a persistent `remote.origin.fetch` config entry as an
  alternative; that was not tested here, and a `+` (force) prefix on such
  a config entry would be actively dangerous given the reconciliation
  requirement below (it would let a fetch silently clobber unpushed local
  claims instead of failing safe).
- **Cross-machine push rejection handling**: on a non-fast-forward push
  rejection (confirmed exact stderr: `! [rejected]
  refs/cankan/coordination -> refs/cankan/coordination (fetch first)`),
  the push path must **fetch (with the explicit refspec above) and
  reconcile, then retry the push — never force-push**. This matches
  CONCEPT.md §4's "optimistic push, retry on rejection," which turns out
  to be exactly git's own non-fast-forward protection, free.
- **Fetch-side reconciliation when local and remote have both advanced**
  (reasoned design, **not exercised by the spike** — the spike only
  tested a clean fast-forward fetch and the push-rejection case, never a
  fetch where both sides hold events the other doesn't have): fetch the
  remote ref into a staging ref or `FETCH_HEAD` rather than attempting a
  plain fast-forward move of the local ref; read both the local and fetched
  event logs; union the events (dedupe by event id — the log is
  append-only, so this is a set union, not a merge of mutable state);
  rebuild a single new commit chain on top of the remote tip containing
  any locally-appended events the remote doesn't have; CAS the local ref
  to that new commit; then push. **This is an explicit test obligation
  for M2.6/M2.7**, not something this ADR can claim was verified — build
  the test before relying on the design.
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

## Known failure modes

Distinguishing observed (reproduced by the spike or my re-runs) from
reasoned (not exercised, inferred from the mechanism):

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
4. **Divergent fetch reconciliation — reasoned, not tested by the
   spike.** Two machines each append events (possibly to different
   tickets, possibly the same one) while offline, then both try to
   sync. User sees: their sync/push either succeeds after a brief delay
   (typical case) or, if both machines claimed the *same* ticket, one of
   them finds out their claim didn't hold once reconciliation runs. Code
   must: union event logs by event id (append-only, never drop), rebuild
   and CAS the local ref, and (for the same-ticket case) let `state/
   fold.ts` (M2.8) apply a deterministic tie-break and notify the loser —
   not designed in this ADR, flagged for M2.8.
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
