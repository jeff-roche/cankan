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

This was confirmed, by the same direct git commands, to succeed on first
creating the staging ref, and again on a second fetch after the remote
had advanced further — both plain creations or fast-forwards of a ref
nothing else writes to, never a CAS or a merge against the working
`refs/cankan/coordination`. What this does not cover: a remote ref that
itself moves non-fast-forward relative to the staging ref (rewound or
force-updated). That isn't expected here, since the coordination ref is
only ever advanced by CAS and never force-pushed (see Consequences), but
it was not directly tested.

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

- **`readRef(ref)`**: `git rev-parse --verify --end-of-options <ref>`,
  returning `null` if the ref doesn't exist (spike's `git-plumbing.ts:102`
  did not use `--end-of-options`; see the argument-injection hygiene note
  below).
- **The `ref` argument must be validated before it reaches `readRef`,
  `updateRefCAS`, `readBlobFromRef`, `commitTreeToRef`, or either side of
  any push/fetch refspec (steady-state or reconciliation).** CONCEPT.md's
  config schema (`CONCEPT.md:290-292`) sources this value as
  `coordination.ref` in `.cankan/config.yml` — checked-in, repo-level
  config that a hostile or merely misconfigured repo controls, not
  something M2.6 can trust by construction. Direct verification for this
  ADR reproduced the abuse on git 2.55: pointing the configured ref at
  `refs/heads/main` makes `readRef` return `main`'s tip as `oldSha`, the
  off-tree tree-build preserve `main`'s tree as the base, `commitTree`
  parent onto it, and the mandated `<ref>:<ref>` refspec push deliver the
  result to the remote as an ordinary fast-forward — a commit silently
  appended to `main`, indistinguishable from a legitimate commit once
  pushed. `HEAD` works identically, since `update-ref` dereferences it.
  **M2.6 must reject any ref that does not match
  `^refs/cankan/[A-Za-z0-9._/-]+$` and also pass it through `git
  check-ref-format`, before it reaches any of the git invocations
  above.** Neither check is sufficient alone; each catches what the
  other admits, which is why both are mandated rather than one being
  belt-and-braces for the other. `check-ref-format` does not
  confine the ref to CanKan's namespace — confirmed: `refs/heads/main` is
  a syntactically valid ref name and passes it, so the prefix anchor is
  what keeps the value inside `refs/cankan/`. The regex does not confine
  it either: `.` and `/` are both members of its character class, so
  `refs/cankan/../heads/main` matches
  `^refs/cankan/[A-Za-z0-9._/-]+$` — confirmed — and is namespaced only
  lexically, not structurally. `check-ref-format` rejects that value (exit
  1 — confirmed), which is why it is mandated alongside the regex rather
  than dropped as redundant syntax-checking of an already-namespaced
  string. Recorded accurately rather than overstated: git's own ref-name
  validation independently refuses a `..` component at every point of use
  tested — `update-ref` (`fatal: ... refusing to update ref with bad name
  'refs/cankan/../heads/main'`), `rev-parse --verify` (exit 128), and
  refspec parsing (`fatal: invalid refspec ...`) — so mandating
  `check-ref-format` is defense in depth that converts those scattered
  fatals into one typed rejection at CanKan's own boundary, not the
  closing of a live hole. **The config layer that loads
  `.cankan/config.yml` (M2.3) is jointly responsible**: it should reject
  an out-of-namespace `coordination.ref` at load time, not leave M2.6 as
  the only backstop. The **must**/**should** asymmetry in that pair is
  deliberate, not loose wording. M2.6's validation is a **must** because
  M2.6 is the enforcing backstop: it is the last point before the value
  reaches git, and it is reached by every caller, including callers that
  obtain a ref without passing through M2.3's loader (tests, a future
  `--ref` flag, a board whose config was hand-edited). M2.3's is a
  **should** because it is a fail-early convenience — it improves which
  error the user sees and when — and a board whose loader was bypassed
  must still be safe. M2.6 may never assume validation already happened
  upstream.
- **Every git invocation that takes a ref, path, or commit derived from
  config or from the coordination ref's own content should pass
  `--end-of-options`** immediately before the first such **positional**
  argument, in addition to the ref validation above — `git rev-parse
  --verify --end-of-options <ref>`, `git update-ref --end-of-options
  <ref> <sha> <old>`, `git cat-file -p --end-of-options <commit>:<path>`
  and `git ls-tree --full-tree --end-of-options <commit> -- <path>` all
  verified working on git 2.55. Array-form argv (already used throughout
  the spike's `git-plumbing.ts`) stops shell-metacharacter injection but
  not argument injection: a value beginning with `-` could otherwise be
  parsed as a flag instead of the intended ref/path/commit. A
  leading-dash ref currently fails closed regardless (git rejects it as
  an invalid ref name before this would matter), so this is hygiene, not
  a live gap — but it is mechanical, costs nothing, and belongs in the
  spec now, before config-fed values are wired through it. Every command
  template in the bullets below carries the marker, the push and fetch
  templates included — `git fetch --end-of-options origin <refspec>` and
  `git push --end-of-options origin <refspec>` are both confirmed working
  on git 2.55, and a refspec is built from the same config-derived ref the
  validation bullet above governs. Templates are what an implementer
  copies, so the rule is not left standing in prose alone.

  **The rule is scoped to positionals because `--end-of-options` cannot
  protect an option's own argument.** `git commit-tree` passes the parent
  commit as `-p <old>`, and no placement of the marker guards `<old>`:
  putting it before the tree pushes the subsequent `-p` into positional
  position instead — confirmed on git 2.55, `git commit-tree
  --end-of-options <tree> -p <old> -m <msg>` fails with `fatal: must give
  exactly one tree`. The working form, and the one the `commitTreeToRef`
  bullet below specifies, puts the options first and the marker
  immediately before the single positional it can protect: `git
  commit-tree -p <old> -m <msg> --end-of-options <tree>` (confirmed
  working, same git version). `<old>` is deliberately left uncovered: it
  is a 40-hex sha that M2.6 obtained from its own `rev-parse` on an
  already-validated ref, never a config-derived or log-derived string, so
  it cannot begin with `-`.

- **Every git invocation in M2.6 must run with its working directory set
  to the board's repository root**, resolved once per board with `git
  rev-parse --show-toplevel` (confirmed: run from `<root>/ev/sub`, it
  prints `<root>`). Git's commands do not agree on what an argument is
  relative to, and `readBlobFromRef` below composes two that disagree:
  `git ls-tree`'s pathspec is interpreted relative to the process's
  current directory, while `git cat-file -p <commit>:<path>` is always
  interpreted relative to the tree root. A CLI is normally invoked from
  somewhere inside a repository rather than at its root, so an unpinned
  cwd makes the two halves of that guard read two different paths — see
  the `readBlobFromRef` bullet for the observed consequence, which is a
  granted claim on a held ticket. The spike does not exhibit this only
  because `git-plumbing.ts:13` takes `cwd` as a caller-supplied parameter
  and every spike caller happens to pass a test repo's root; M2.6 must
  pin the value rather than inherit whatever it was launched from.
  Pinning the cwd and passing `--full-tree` are both required and neither
  substitutes for the other: `--full-tree` fixes only the one command
  that has such a flag, and the pin is what makes every other
  path-taking or ref-taking invocation cwd-insensitive.

  `git rev-parse --show-toplevel` is itself resolved from the process's
  own current directory; that single bootstrap call is the one exception,
  and every later invocation uses its result. If it fails — not a git
  repository, or a bare repository with no working tree — that is a typed
  hard error. M2.6 must never fall back to the process's cwd.
- **`updateRefCAS(ref, newSha, oldSha)`** — new value second, old value
  third; see "PLAN.md notation should be revised" below for why this
  order is stated explicitly. Implementation: `git update-ref
  --end-of-options <ref> <newSha> <oldSha ?? ZERO_SHA>` (the 40-zero sha
  for "ref must not exist yet") — the trailing old-value argument to
  `update-ref` *is* the entire
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
  commit-tree -p <old> -m <msg> --end-of-options <tree>` — never touching
  the real index or working tree (spike's `git-plumbing.ts:64`,
  `coordination.ts:102`). The argument order in that last command is
  load-bearing, not stylistic: the marker must follow the options and
  precede the tree, for the reason given in the `--end-of-options` bullet
  above.
- **`readBlobFromRef(ref, path)`** (named in `PLAN.md`'s M2.6 line, not
  given its own spec by the spike directly): resolve `ref` to a commit,
  then read `<path>` at that commit. **Do not key this off `cat-file`'s
  exit code the way the spike's `readFileAtCommit` does**
  (`git-plumbing.ts:129`, `134-135`): `git cat-file -p <commit>:<path>`
  exits 128 both for a genuinely absent path and for every other kind of
  failure — confirmed directly, indistinguishable by exit code alone.
  Treating any non-zero exit as "not found" turns a real read failure
  (e.g., a blobless partial clone that can't lazy-fetch that month's blob
  while offline) into "no claims this month" — silently granting a claim
  on a held ticket, the exact mutual-exclusion guarantee this whole
  design exists to provide, failing open. Worse: if `<path>` names a tree
  (mode `040000`) or a symlink (`120000`) rather than a blob, `cat-file
  -p` succeeds at exit 0 and prints a directory listing or the symlink's
  link target, respectively — confirmed directly — which then reaches
  the unguarded `JSON.parse` at `coordination.ts:56` (see failure mode 8,
  widened below). Implement a checked resolution instead, on `git ls-tree
  --full-tree --end-of-options <commit> -- <path>` (confirmed: this exits
  0 whether or not the path exists — check the *output*, not the exit
  code):

  - **Empty output**: no entry. Return `null`.
  - **Exactly one entry, whose mode is `100644` and whose path field is
    byte-identical to the requested `<path>`**: read it with `git cat-file
    -p --end-of-options <commit>:<path>`.
  - **Anything else** — more than one entry, a single entry whose path
    field differs from the requested path, any other mode (`040000` tree,
    `120000` symlink, `160000` submodule), or a non-zero exit from either
    command — is a typed hard error that **aborts the caller's
    operation**, never silently treated as "empty."

  **`--full-tree` is not optional.** `ls-tree`'s pathspec is interpreted
  relative to the process's current directory; `cat-file -p
  <commit>:<path>` is always interpreted relative to the tree root.
  Confirmed on git 2.55, in a repository whose blob is at
  `ev/2026-09.jsonl`:

  ```
  $ cd ev/ && git ls-tree $C -- ev/2026-09.jsonl
  (exit 0, no output)
  $ git cat-file -p "$C:ev/2026-09.jsonl"
  {"a":1}
  $ git ls-tree --full-tree $C -- ev/2026-09.jsonl
  100644 blob 0187f3b…  ev/2026-09.jsonl
  ```

  Without `--full-tree`, a `claim` invoked from any subdirectory of the
  repository — the ordinary case for a CLI, which a user runs from
  wherever they happen to be — sees empty `ls-tree` output, concludes "no
  claims this month," and grants a claim on a held ticket. That is the
  same fail-open double-claim this guard exists to prevent, reachable
  with no hostile input at all, and it would be a regression against a
  `cat-file`-only read, which is cwd-insensitive for a tree-root-relative
  path. The cwd pin specified above closes the same class of trap for
  commands that have no `--full-tree` equivalent; both are required, and
  neither substitutes for the other.

  **The "exactly one entry, path equal" condition is likewise not
  optional**, and a mode check alone does not replace it: the mode on the
  first output line says nothing about *which* object was resolved. Two
  observed cases where that first line reads `100644` while the object is
  not the requested blob:

  ```
  $ git ls-tree --full-tree $C -- ev/
  100644 blob 0187f3b…  ev/2026-09.jsonl
  040000 tree 9ae38d4…  ev/sub
  $ git cat-file -p "$C:ev/"
  100644 blob 0187f3b…  2026-09.jsonl
  040000 tree 9ae38d4…  sub

  $ git ls-tree --full-tree $C -- ev/sub/../2026-09.jsonl
  100644 blob 0187f3b…  ev/2026-09.jsonl
  $ git cat-file -p "$C:ev/sub/../2026-09.jsonl"
  fatal: path 'ev/sub/../2026-09.jsonl' exists on disk, but not in '<commit>'
  ```

  In the first, a trailing-slash path makes `ls-tree` emit a multi-line
  listing whose leading line is a `100644` blob, while `cat-file` exits 0
  and prints a directory listing — both reach the unguarded `JSON.parse`.
  In the second, `ls-tree` silently normalizes the `..` component out of
  the pathspec and reports a *different* path than the one requested,
  while `cat-file` on the identical string fails at exit 128. The path
  equality test rejects both: no emitted path equals `ev/`, and
  `ev/2026-09.jsonl` is not the requested `ev/sub/../2026-09.jsonl`.
  Comparing the emitted path against the requested one is what forces the
  two commands to agree on which object is under discussion; a mode check
  alone leaves them free to disagree. **This is inherited by every
  consumer of
  `readBlobFromRef`**: M2.6 (the primitive itself), M2.7 (every
  claim/event read), and M2.8 (fold reads via M2.7) must all propagate
  the hard-error case rather than defaulting to "no data."

  Separately, for M2.7: **git's own path-traversal guard (`verify_path`,
  rejecting `../`, `.git/…`, and absolute paths) applies only on the
  tree-*write* side** (`update-index --cacheinfo` — confirmed it rejects
  `../outside.txt` with `error: Invalid path`) — **not on the read
  side**, where `<rev>:../path` is meaningful git syntax for navigating
  within a tree rather than a filesystem escape, and is not rejected the
  way a cacheinfo write of the same string would be. M2.7 must neither
  duplicate the write-side check where it doesn't apply, nor assume the
  read side carries protection it doesn't have — the `ls-tree`
  mode-and-path-equality check above is what governs what a read path may
  resolve to, and it governs it precisely because it compares the
  resolved path against the requested one rather than only inspecting a
  mode. It is not a substitute for `verify_path`, and `verify_path` is
  not a substitute for it.
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
  --end-of-options origin
  refs/cankan/coordination:refs/cankan/coordination-remote` —
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
  logic as the full spec. **The clock that check reads is fully specified
  in failure mode 7** and is not a choice left to the implementer:
  reader-local first-observation time, recorded per clone under
  `$XDG_STATE_HOME/cankan/` (`CONCEPT.md:270`). No timestamp carried in
  the coordination ref is an admissible input to it — not an event's
  `ts`, and not the CAS commit's committer or author date, which the same
  appender writes.
- **`listWorktrees`**: not covered by the concurrency decision itself, but
  needed for whatever M2.6 does with the worktree-path problem noted
  above if any lock-adjacent tooling is ever added; not otherwise
  constrained by this ADR since CAS needs no per-worktree path resolution.

### M2.7 (`events/log.ts`) must implement

- **`append(event)`**: generalize `claimViaCAS`'s pattern (read → check →
  build commit off-tree → `updateRefCAS` → on rejection, re-read and
  re-check rather than blind-retry) from "claim" events to the full event
  union.
- **The event union this ADR asks M2.7 to generalize to is not fully
  named here or by CONCEPT.md.** CONCEPT.md §3 (`CONCEPT.md:160`) names
  five event types — `claim | release | renew | move | comment` — but
  0002 (M1.3's ADR, `0002` Decision point 2 and Consequences) assumes
  `alias` and `external-write` events also exist, for Backlog.md-adoption
  relabeling and for detecting a foreign write to a ticket file,
  respectively. 0002 hedges its own reliance on them, but M2.7 must not
  build `events/schema.ts` strictly to CONCEPT.md's five-type union — it
  needs at least `alias` and `external-write` alongside the five
  CONCEPT.md names. **`alias` is a redirect primitive living in the same
  unvalidated log the next bullet addresses**: a pushed `alias` event
  from a legitimate ticket id to an attacker-chosen ticket id would
  reroute `cankan show <id>` (and any other alias-resolving lookup) to
  the attacker's ticket, under the same untrusted-writer conditions as
  below — schema validation must apply to `alias` events with the same
  rigor as `claim` events, not treat redirect events as lower-risk.
- **Every event must be validated against `events/schema.ts` at the
  boundary — before it enters the log or the fold — not merely cast.**
  The spike's `parseEvents` does `JSON.parse(line) as ClaimEvent`
  (`coordination.ts:51-57`): a TypeScript cast, not a runtime parse, over
  data written by whoever has push access to the ref — a
  mutually-distrusting peer, not a trusted process. `append`/`read` must
  validate every field's type and shape, and bound `ts` to a sane window,
  before an event is usable by anything downstream. **Ordering authority
  is the event's position in the append-only chain, not a
  remote-supplied `ts`.** Implemented literally against untrusted `ts`
  values: a backdated `ts` would win any "earliest timestamp" tie-break
  (claim theft), and a far-future `ts` would defeat a lease-expiry check
  that trusted it (a permanently unclaimable ticket) — see the
  reconciliation tie-break bullet below, revised accordingly, and failure
  mode 7 for the expiry clock. **Bounding `ts` is schema hygiene, not the
  expiry defense.** It keeps an absurd value out of anything that
  displays or sorts by it, but no bound makes a peer-supplied clock
  trustworthy: a window wide enough to tolerate honest clock skew is
  wide enough to hold a ticket hostage for the width of the window.
  Expiry must be measured against the reader-local first-observation
  clock that failure mode 7 specifies, with `ts` never an input to it.
  The same disqualification covers the CAS commit's committer and author
  timestamps, which the appending peer supplies just as freely. **Duplicate
  event ids must be resolved by rejecting the duplicate when its content
  differs from the existing event, not by silently picking one** — this
  ADR's "dedupe by event id" language (below) never specified which copy
  survives, and a differing-content duplicate is itself a sign of a
  hostile or buggy peer, not a benign coincidence. Also record: **`actor`
  is not an authenticated identity.** It is whatever string the writer
  put in the event, bounded only by who has push access to the ref —
  nothing here binds it to a git identity, a signed commit, or any other
  credential. `state/fold.ts` (M2.8) will surface `actor` as though it
  identifies who made a claim; it does not, and M2.8's design should
  account for that rather than treating a claim's `actor` field as
  trustworthy attribution.
- **Ticket IDs must be canonicalized before use as an event-log or
  coordination-ref key — this ADR did not previously say where.** 0002
  established that Backlog.md writes uppercase `id: CK-1` while CanKan's
  own convention and filenames stay lowercase, and assigned
  case-insensitive lookup with casing-preserving write to M2.2's ticket
  store — but the spike's `findClaim` (`coordination.ts:70`) does exact
  string equality on `ticket`, and neither M2.6's nor M2.7's Consequences
  mentioned normalization until now. A claim appended under `ck-1` and a
  lookup for `CK-1` (or vice versa) would silently fail to match — the
  same double-claim class as failure mode 9, via casing instead of a
  month boundary. **M2.7's `append`/`read` must canonicalize the
  `ticket` field (lowercase, matching CanKan's on-disk convention) before
  using it as a key, on both write and read**, so casing never affects
  whether two references to the same ticket collide in the log.
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
  deterministic tie-break and the losing claimant can be told. **That
  tie-break must not use "earliest timestamp wins"**: `ts` is a
  remote-supplied field (see above), and a backdated one would win every
  time under that rule; the tie-break must key on something the
  reconciliation process itself controls (e.g., position in the rebuilt
  commit chain, or an explicit ordering rule M2.8 defines) instead of
  trusting either side's clock. This ADR does not design that tie-break —
  it only flags that the event log's reconciliation step must not be the
  place that silently resolves the conflict by dropping data, and that
  whatever M2.8 does design must not be `ts`-based.

  **The property that tie-break must have is determinism, not fairness**,
  and M2.8 should not spend design effort on the latter. What is needed
  is that both peers, independently reconciling the same union of events,
  compute the same winner — so that the board does not disagree with
  itself about who holds a ticket. No *fair* tie-break exists among
  mutually-distrusting peers: every input a peer supplies is an input it
  can choose, which is the same reasoning that disqualifies `ts`.
  Position in the rebuilt commit chain is not fair either — it is
  determined by whichever side happens to reconcile first — and it is
  admissible anyway, because it is deterministic and locally verifiable
  from the union both sides hold. An attempt to make the outcome
  equitable would either reintroduce a peer-supplied input or require an
  authority this design deliberately does not have.

- **A poisoned coordination ref has no recovery path, and defining one is
  M2.7's obligation.** Every read obligation this ADR adds fails closed:
  a schema-invalid event aborts, a month path resolving to a non-blob
  aborts, a duplicate event id whose content differs is rejected rather
  than resolved. That is the correct trade for a mutual-exclusion
  primitive — a board that refuses to answer is safer than one that
  grants a double-claim — but it carries a direct consequence,
  **reasoned, not tested**: any peer with push access can append a single
  event that makes every subsequent read abort, rendering the board
  unreadable for everyone who fetches it, with no technique more
  sophisticated than one push. Nothing in this ADR, in 0002, or in
  PLAN.md names how a board gets out of that state. **M2.7 must define
  and test that recovery path** — how an operator sees which event is
  offending, and how the ref is returned to a readable state (for
  instance by quarantining the offending events behind an audit record,
  or by CASing the working ref back to a known-good ancestor and
  re-appending only the events that validate). This ADR does not design
  it. It records that fail-closed reads are a complete design only once
  the way out of the closed state exists, and that the obligation to
  build that exit belongs to the milestone that builds the reads.

### CONCEPT.md should be revised

This ADR does not itself edit `CONCEPT.md`; it records what a future
revision of it should say, since the design decisions above make parts of
its current text stale.

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

### PLAN.md notation should be revised

This ADR does not itself edit `PLAN.md` either, for the same reason: it
records what should change, not the change itself.

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

`PLAN.md:244` scopes M2.6's *Depends on* to M2.1 and M1.2 only, and
`PLAN.md:250` scopes M2.7's *Depends on* to M2.6 only — neither lists
M1.3 (0002, this repo's IDs-and-Backlog.md-compatibility ADR). Followed
literally, an implementer working from the dependency graph alone would
never read 0002 and would miss the ticket-ID casing-canonicalization
requirement this ADR now states in M2.7's Consequences above (0002
established the casing behavior; this ADR is the one that says where it
must be applied as an event-log/coordination-ref key). `PLAN.md:244` and
`PLAN.md:250` should be revised to add M1.3 to both *Depends on* lines.

`PLAN.md:248` (M2.7's *Creates* line) already lists `mode: branch-scan`
fallback reads as a deliverable: "`events/ref.ts` (initialize the ref;
`mode: branch-scan` fallback reads `.cankan/events/` in-tree instead)."
This conflicts with this ADR's Alternatives considered (above), which
directs that `branch-scan` remain documented as a fallback and "not
[be] implemented speculatively now." `PLAN.md:248` should be revised to
match this ADR's decision. Stated plainly, so M2.7 does not have to
adjudicate the conflict itself: **M2.7 does not need to implement or
stub the `branch-scan` mode switch.** `shared-ref` passed every scenario
this spike tested, with no result here motivating the fallback (see
Alternatives considered); M2.7 may defer `branch-scan` entirely until a
concrete blocker to `shared-ref` actually appears, rather than building
a mode switch for a path with no current evidence behind it.

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
   only if that path itself ultimately fails. Code must: fetch into a
   **staging ref**, not the working ref — this rejection means the
   remote has diverged from local, and a plain fetch of the working
   ref's own refspec is itself rejected as non-fast-forward in exactly
   this situation (see Evidence, "Refspec for reconciliation fetches").
   Reconcile from the staging ref (see Consequences), then retry the
   push — never force.
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
   state; always fetch with the steady-state refspec
   (`refs/cankan/coordination:refs/cankan/coordination`) into the working
   ref, and lazily initialize the ref if `readRef` returns `null` where a
   board is expected to have one.
7. **Lease expiry not enforced, and no clock reachable from the ref is
   trustworthy — reasoned, not implemented anywhere yet.** CONCEPT.md §4
   specifies expired claims return to Ready; neither the spike's
   `findClaim` nor anything else in this codebase implements that check
   today. The hard part is not the comparison but the clock it reads.
   Every timestamp reachable from the coordination ref is written by
   whoever appended the event: the event's own `ts` field, and equally
   the CAS commit's committer and author dates, which the same appender
   supplies. A peer with push access can set any of them arbitrarily, and
   a far-future value defeats an expiry check that consults it — a ticket
   no other actor can ever reclaim. Bounding `ts` to a plausible window
   does not repair this: a window wide enough for honest clock skew is
   wide enough to hold a ticket hostage for the width of the window.
   User sees: a ticket that should have become reclaimable when its lease
   expired still reports `already_claimed`, with no error and no
   indication why.

   **Code must: measure lease expiry against a reader-local
   first-observation time, and against no timestamp carried in the log.**
   Specifically, and not as a menu M2.7 chooses from:

   - **The clock.** When a reader first encounters a lease-bearing event
     id — `claim` or `renew` — while reading the ref, it records that
     event id against its own host clock's current time. An appender
     records its own append the same way, at the moment it appends. A
     claim is expired when the reader's current local time minus the
     recorded first-observation time of the ticket's most recent
     `claim`/`renew` event — **most recent by position in the append-only
     chain, never by `ts`**, per the ordering rule in M2.7's Consequences
     — exceeds the configured lease (`claims.lease`,
     `CONCEPT.md:296`). A `release` event ends the lease outright, and the
     observation records for that claim may then be discarded. The reader
     trusts exactly one clock — its own host's — and no peer's.
   - **Where the record lives.** `$XDG_STATE_HOME/cankan/`
     (`CONCEPT.md:270`, already reserved for "lease heartbeats,
     last-sync timestamps per board"), keyed by board and by event id. It
     must persist across invocations: a per-process record would
     re-observe every event on every command, and no lease would ever
     expire. The board key must be the repository's common git directory,
     not the current worktree's path — every worktree of one clone shares
     one coordination ref, so they must share one observation record or
     two worktrees will compute different expiries for the same claim.
     Derive that key as `git rev-parse --path-format=absolute
     --git-common-dir`, then `fs.realpath` the result. **The
     `--path-format=absolute` is load-bearing, not decoration**: plain
     `git rev-parse --git-common-dir` returns a path relative to the
     current directory, so it prints `.git` from a main worktree and an
     absolute path from a linked one — confirmed on git 2.55 — and an
     implementer keying on the raw output would produce two different
     keys for two worktrees of one clone, which is the exact divergence
     this obligation exists to prevent. The record is per clone by
     construction. It is never pushed, fetched, or otherwise shared, and
     no peer can write to it; that is the entire point of siting it
     there.
   - **A missing record** — the ordinary case the first time an event is
     seen — means: record the current local time now, and treat the claim
     as unexpired. That over-honors the lease, which is the fail-closed
     direction for a mutual-exclusion primitive.
   - **An unwritable or unreadable store** is a typed hard error.
     Proceeding without recording silently re-observes the event on the
     next invocation, so no lease ever expires; that failure is invisible
     from the outside and must not be one the reader shrugs off.

   Consequences of this design, **reasoned, not measured**: a clone that
   first sees an already-old claim starts its clock late, so it honors
   that claim for up to one full lease period counted from its own first
   sight of the event rather than from when the claim was made; a clone
   whose state directory is ephemeral (CI, a throwaway container) does
   this for every lease it sees. Both cost liveness — a ticket stays
   unclaimable somewhat longer than it strictly should — and neither
   costs mutual exclusion, which is the trade a coordination primitive
   should make in that direction. One residual is not closed by this and
   is not meant to be: a peer with push access can hold a ticket for as
   long as it keeps appending `renew` events. That is what `renew` is
   for, and it is bounded by who has push access, not by any timestamp.
8. **Malformed or non-blob event-log content — partly observed, partly
   reasoned.** Two distinct issues reach the same unguarded `JSON.parse`
   (`coordination.ts:56`): (a) a corrupted or partially-written *line*
   within an otherwise-valid monthly JSONL blob — reasoned, not tested —
   throws a `JSON.parse` syntax error; (b) the month path resolving to
   something other than a blob (a tree or a symlink), or a genuine read
   failure being misread as "not found" — confirmed directly (see
   `readBlobFromRef` in Consequences) — feeds a directory listing or a
   symlink target into the same parser. User sees: a hard crash reading
   board state (a), or a silently-granted double-claim (b), instead of a
   clear error either way. Code must: validate the path resolves to a
   blob before parsing at all (`readBlobFromRef`'s three-way `ls-tree`
   check), and, for (a), skip-and-warn with file/line context or fail
   with a diagnosable error identifying the offending ref/commit/file,
   rather than an unguarded parse exception.
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
10. **Coordination ref configured outside its namespace — observed,
    confirmed by direct verification for this ADR.** `coordination.ref` in
    `.cankan/config.yml` is checked-in, repo-level config
    (`CONCEPT.md:290-292`); nothing before M2.3's config loader or
    M2.6's own validation (see Consequences) stops it from naming
    `refs/heads/main`, `HEAD`, or any other ref. Reproduced directly:
    with the ref pointed at `refs/heads/main`, the CAS mechanism reads
    `main`'s tip, builds a new commit preserving `main`'s tree and
    parented on it, and the CAS write succeeds — a claim event is
    silently appended as a commit on `main`, which the mandated
    `<ref>:<ref>` push then delivers to the remote as an ordinary
    fast-forward. User sees: an extra commit on `main` (or whatever
    branch was named) with no attribution to CanKan and no error
    anywhere in the claim flow. Code must: validate `ref` against
    `^refs/cankan/[A-Za-z0-9._/-]+$` and `git check-ref-format` before it
    reaches any git invocation — in both M2.6 (defense at the point of
    use) and M2.3's config loader (defense at load time, so a bad
    config value never reaches a working board at all).
11. **Untrusted event fields accepted at face value — reasoned, not
    tested; directly derivable from the spike's own code.** The spike
    parses events with `JSON.parse(line) as ClaimEvent`
    (`coordination.ts:51-57`) — a cast, not a validated parse — over a
    log anyone with push access to the ref can write to. User sees:
    nothing wrong-looking. A backdated `ts` silently wins a
    reconciliation tie-break meant to resolve an honest race (claim
    theft); a far-future `ts` would defeat any lease-expiry check that
    consulted it (a ticket that never becomes reclaimable), which is why
    failure mode 7 places the expiry clock outside the log entirely
    rather than trying to sanitize the one inside it; a duplicate
    event id with different content silently substitutes for the real
    event if "dedupe by id" doesn't specify which copy survives. Code
    must: validate every event against `events/schema.ts` at the
    boundary (see Consequences), treat position in the append-only
    chain — not `ts` — as ordering authority, measure lease expiry
    against the reader-local first-observation clock of failure mode 7
    rather than any logged timestamp, reject rather than
    silently pick between duplicate ids with differing content, and
    never treat `actor` as an authenticated identity.
