# coordination-ref spike (M1.1)

This is a throwaway spike, not production code. It exists to answer one
question before anything in `packages/core` is built on the answer:
**can leased ticket claims live safely on a shared orphan git ref
(`refs/cankan/coordination`), with `git update-ref` compare-and-swap as the
concurrency primitive, and no server?** See `CONCEPT.md` §3 for the design
being tested, and `PLAN.md`'s M1 section for how this feeds M1.2's go/no-go
ADR and, from there, M2.6 (git adapter) and M2.7 (event log).

It is not a `bun test` file on purpose - a three-process race is exactly
the kind of thing that flakes under a shared test runner (timing,
parallelism, CI scheduling). It's a standalone script you run directly.

## Re-running it

```sh
bun install --frozen-lockfile   # if you haven't already
bun spikes/coordination-ref/run.ts
```

It creates its own temp repos (via `@cankan/test-utils`'s `makeTempRepo()`),
runs the six survivability scenarios from the task brief against real git
processes and real spawned OS processes, and overwrites
`spikes/coordination-ref/RESULTS.md` with what happened: exact commands,
pass/fail, wall-clock timings, and any surprising git behavior. Exits 0 if
every scenario passed, 1 otherwise. Nothing it does touches this repo's own
git state - all scenarios run inside disposable temp directories that are
cleaned up when each scenario finishes.

Not fully deterministic: the race scenarios (`Scenario 2`) depend on OS
process scheduling. A shared start-time barrier (see `barrier.ts`) makes
contention likely, but the exact number of CAS rejections observed per run
can vary. See `RESULTS.md` for one specific run's numbers.

## Layout

- `run.ts` - entry point; defines and runs the six scenarios, writes
  `RESULTS.md`.
- `git-plumbing.ts` - low-level git plumbing (`hash-object`, a private-temp-index
  `write-tree`, `commit-tree`, `update-ref` with and without CAS) with no
  knowledge of claims or events.
- `coordination.ts` - the coordination-ref logic: init the ref, the monthly
  JSONL event layout, and the two claim mechanisms (`claimViaCAS`,
  `claimViaLock`) being compared.
- `lockfile.ts` - the `O_EXCL` lockfile primitive for the file-lock mechanism.
- `barrier.ts` - a shared-start-time helper so racing worker processes
  actually contend instead of finishing sequentially.
- `report.ts` - renders the collected scenario data into `RESULTS.md`.
- `workers/` - scripts spawned as real child processes (`Bun.spawn`) to make
  the races and the stale-lock experiment real multi-process scenarios
  rather than promises racing inside one process.

## Fate

This is throwaway. Once M2.6 (git adapter) and M2.7 (event log) exist and
implement whichever mechanism M1.2's ADR chooses, this directory should be
deleted or explicitly frozen (marked historical) rather than kept in sync
with the real implementation.
