# 0002: IDs and Backlog.md compatibility

## Status

Accepted (2026-09-04).

## Context

CONCEPT.md's compatibility bet (line 46) is that CanKan's ticket format is
"Backlog.md-compatible by construction": same directory layout
(`backlog/tasks/<ID> - <title>.md`), same frontmatter field names, with
CanKan-specific fields namespaced under a `cankan:` key that Backlog.md is
assumed to "ignore." CanKan uses hash IDs (`ck-a1b2c3`); Backlog.md uses
sequential `TASK-N`. Line 48 says: "if its parser turns out to require
numeric IDs (verify in Phase 0), `cankan adopt backlog` renumbers in one
pass and writes alias events." Nobody had run real Backlog.md against
either assumption before this task.

`backlog.md` is not a dependency of this repo (a known gap in M0.4's
fixture) and must not become one for this task - per the controller
ruling, it was installed only into a scratch directory outside the repo.

### Method

Scratch install, outside the repo:

```
$ mkdir -p /tmp/backlog-scratch && cd /tmp/backlog-scratch
$ bun init -y
$ bun add backlog.md
bun add v1.4.0 (34cbb9a40)
Resolving dependencies
Resolved, downloaded and extracted [17]
Saved lockfile

installed backlog.md@1.51.0 with binaries:
 - backlog

2 packages installed [1127.00ms]
```

Resolved version:

```
$ ./node_modules/.bin/backlog --version
1.51.0
```

Scratch `bun.lock` entry:

```
"backlog.md": ["backlog.md@1.51.0", "", { "optionalDependencies": {
"backlog.md-darwin-arm64": "1.51.0", "backlog.md-darwin-x64": "1.51.0",
"backlog.md-linux-arm64": "1.51.0", "backlog.md-linux-x64": "1.51.0",
"backlog.md-windows-arm64": "1.51.0", "backlog.md-windows-x64": "1.51.0" },
"bin": { "backlog": "cli.js" } }, ...]
```

**Pinned version for this decision and for M4.10: `backlog.md@1.51.0`.**

A fixture repo was created at `/tmp/backlog-probe` (outside this repo, not
committed) and invoked with `BACKLOG_BIN=/tmp/backlog-scratch/node_modules/.bin/backlog`:

```
$ git init -q && git config user.email test@test.com && git config user.name Test
$ $BACKLOG_BIN init --help
...
  --task-prefix <prefix>             custom task prefix, letters only
                                       (default: task); draft, doc, and decision
                                       are reserved
  --defaults                         use default values for all prompts
...
$ $BACKLOG_BIN init "Probe Project" --defaults --agent-instructions none
...
Initialized backlog project: Probe Project
```

`backlog/config.yml` after init (defaults): `task_prefix: "task"`,
`statuses: ["To Do", "In Progress", "Done"]`.

A ticket was hand-written at `backlog/tasks/ck-a1b2c3 - Some title.md`
using Backlog.md's frontmatter schema plus the `cankan:` block from
CONCEPT.md's ticket-file example (~line 430), including `origin`,
`display_id`, `sync`, `deps`, and `aliases`.

A second, independent scratch install (`/tmp/backlog-scratch2`, same
resolved `backlog.md@1.51.0`) and fixture repo (`/tmp/backlog-probe2`)
were used for two follow-up checks surfaced while analyzing probe 1 and
probe 3 (the mixed-prefix gap and the numeric-looking-hash collision,
both below) - neither committed, both deleted after use.

## Evidence

### Probe 1 - read tolerance

With `task_prefix: "task"` (Backlog.md's default), the hand-written
`ck-a1b2c3` ticket is **completely invisible**:

```
$ $BACKLOG_BIN task list --plain
No tasks found.

$ $BACKLOG_BIN task list --json
{
  "schemaVersion": 1,
  "kind": "task-list",
  "tasks": []
}

$ $BACKLOG_BIN task ck-a1b2c3 --plain
Task ck-a1b2c3 not found. Task lookups read only the local working copy;
use 'backlog browser' to see tasks from other branches.
```

This is not a parse failure - it is filename-prefix-gated discovery.
Backlog.md only scans files whose filename starts with the *configured*
`task_prefix` (case-sensitive). Confirmed by copying the same file to a
filename that matches the default prefix, `id:` field left as `ck-a1b2c3`:

```
$ cp "backlog/tasks/ck-a1b2c3 - Some title.md" "backlog/tasks/task-a1b2c3 - Some title.md"
$ $BACKLOG_BIN task list --plain
To Do:
  CK-A1B2C3 - Some title (ac: 0/2)
```

...and disconfirmed by trying an uppercase filename prefix (`TASK-`),
which Backlog.md does **not** match either (case-sensitive, lowercase
only):

```
$ cp "backlog/tasks/ck-a1b2c3 - Some title.md" "backlog/tasks/TASK-a1b2c3 - Some title.md"
$ $BACKLOG_BIN task list --plain
No tasks found.
```

Setting `backlog/config.yml`'s `task_prefix` to `"ck"` (matching CanKan's
own ID prefix) instead of renaming files makes the original
`ck-a1b2c3 - Some title.md` fully visible, with the `cankan:` block
parsed without error and simply absent from every rendered/JSON view:

```
$ sed -i 's/task_prefix: "task"/task_prefix: "ck"/' backlog/config.yml
$ $BACKLOG_BIN task list --json
{
  "schemaVersion": 1,
  "kind": "task-list",
  "tasks": [
    {
      "id": "CK-A1B2C3",
      "title": "Some title",
      "status": "To Do",
      ...
      "acceptanceCriteriaCompleted": 0,
      "acceptanceCriteriaCount": 2,
      ...
    }
  ]
}

$ $BACKLOG_BIN task ck-a1b2c3 --plain
File: /tmp/backlog-probe/backlog/tasks/ck-a1b2c3 - Some title.md

Task CK-A1B2C3 - Some title
==================================================
Status: ○ To Do
...
Description:
--------------------------------------------------
Hand-written probe ticket for M1.3 read-tolerance testing.

Acceptance Criteria:
--------------------------------------------------
- [ ] #1 Returns 429 above 100 req/min per key
- [ ] #2 Documented in API reference
```

Lookup by `CK-A1B2C3` (uppercase) also resolves to the same file - display
and lookup are case-insensitive; the frontmatter's literal casing
(`ck-a1b2c3`, lowercase, matching CanKan's convention) is read correctly
and displayed uppercased.

**Mixed-prefix gap.** `task_prefix` is a single global config value, so a
repo cannot have both `task-*` and `ck-*` tickets visible to Backlog.md
at once - exactly the scenario `cankan adopt backlog` exists for (a repo
that already has Backlog.md-native tickets). Confirmed with a second,
independent scratch install/fixture (`backlog.md@1.51.0` again):

```
$ $BACKLOG_BIN init "Probe2" --defaults --agent-instructions none
$ $BACKLOG_BIN task create "Existing backlog task" --plain
File: .../backlog/tasks/task-1 - Existing-backlog-task.md
...
$ sed -i 's/task_prefix: "task"/task_prefix: "ck"/' backlog/config.yml
$ $BACKLOG_BIN task list --plain
No tasks found.
$ $BACKLOG_BIN task TASK-1 --plain
Task TASK-1 not found. Task lookups read only the local working copy;
use 'backlog browser' to see tasks from other branches.
```

Setting `task_prefix: ck` to make native CanKan tickets visible makes the
*pre-existing* `task-1` ticket disappear from Backlog.md's own view. This
is not a hypothetical edge case; it is the default outcome of following
CONCEPT.md's detection table ("`backlog/` present -> reuse the existing
task directory as-is") and then also creating native `ck-` tickets.

**Conclusion: read tolerance holds, conditionally, and only for a single
ID family at a time.** Backlog.md's parser does not require numeric IDs
and does not choke on the `cankan:` block. But discovery is gated on
`backlog/config.yml`'s `task_prefix` matching the file's actual filename
prefix, case-sensitively, and only one prefix is configured at a time.
This is **not documented in CONCEPT.md** and is a new requirement,
addressed in Decision below: `cankan init`/`cankan adopt backlog` must
either set `task_prefix: ck` (silently orphaning any pre-existing
Backlog.md tickets from Backlog.md's own view) or migrate pre-existing
tickets into the `ck-` namespace first.

### Probe 2 - write preservation (decisive)

Starting from the `ck-a1b2c3` ticket above (config `task_prefix: "ck"`,
full `cankan:` block present), a single field was edited:

```
$ $BACKLOG_BIN task edit ck-a1b2c3 -s "In Progress" --plain
File: /tmp/backlog-probe/backlog/tasks/ck-a1b2c3 - Some title.md
Task CK-A1B2C3 - Some title
==================================================
Status: ◒ In Progress
...
```

Byte-for-byte diff of the frontmatter before and after:

```diff
--- before.md
+++ "backlog/tasks/ck-a1b2c3 - Some title.md"
@@ -1,24 +1,13 @@
 ---
 id: ck-a1b2c3
 title: Some title
-status: To Do
+status: In Progress
 assignee: []
+created_date: '2026-09-04 22:00'
+updated_date: '2026-09-04 22:04'
 labels: []
 dependencies: []
-created_date: '2026-09-04 22:00'
 ordinal: 1000
-cankan:
-  origin: jira:PROJ-45
-  display_id: PROJ-45
-  sync:
-    state: ahead
-    base_hash: 3c9fabc
-    pulled_at: 2026-09-04T10:12:00Z
-    url: https://acme.atlassian.net/browse/PROJ-45
-  deps:
-    - { type: blocks, id: ck-2b1e44 }
-    - { type: discovered-from, id: ck-91ab02 }
-  aliases: [TASK-12]
 ---

 ## Description
```

**The entire `cankan:` block is deleted**, not merely reordered around.
`created_date`/`updated_date` were also moved, but every key Backlog.md's
schema does not know about is gone. This is not a targeted strip of one
field -
the edit only touched `status`, yet the whole frontmatter object was
reserialized from Backlog.md's internal task model, which has no
"unknown fields" passthrough. The `id:` field's literal casing
(`ck-a1b2c3`, lowercase) was preserved; only the human-readable render
and `--json` output uppercase it.

**Conclusion: `CONCEPT.md` line 46's "Backlog.md ignores it" is false as
stated.** Ignore-on-read is true (probe 1). Ignore-on-write is false:
Backlog.md actively **destroys** the `cankan:` block on the first `backlog
task edit` (and, by the same reserialize-from-internal-model mechanism,
presumably any other Backlog.md command that writes the file - `task
archive`, editing via `backlog browser`, etc.; this was not separately
probed but the mechanism -- full frontmatter reserialization with no
unknown-field passthrough, no CLI flag to opt out -- gives no reason to
expect any write path behaves differently). This is not inconclusive: the
diff is unambiguous and reproducible.

### Probe 3 - ID allocation

With `ck-a1b2c3` present (config `task_prefix: "ck"`) and no other tasks:

```
$ $BACKLOG_BIN task create "New task after hash id present" --plain
File: /tmp/backlog-probe/backlog/tasks/ck-1 - New-task-after-hash-id-present.md
Task CK-1 - New task after hash id present
...
Ordinal: 2000
$ echo $?
0
```

A second create:

```
$ $BACKLOG_BIN task create "Second new task" --plain
File: /tmp/backlog-probe/backlog/tasks/ck-2 - Second-new-task.md
...
```

No crash, no error, no collision with `ck-a1b2c3`. Resulting frontmatter
`id:` fields are `CK-1`, `CK-2` (Backlog.md's own writes use uppercase).
Inspecting `backlog/` turned up no separate ID-counter file - the
allocator scans existing filenames for the configured prefix, extracts
the numeric suffix of each, and takes `max + 1`. Non-numeric suffixes
(`a1b2c3`) are excluded from that scan entirely rather than causing an
error, so the counter effectively restarted at `1`, oblivious to
`ck-a1b2c3`'s existence for ID-uniqueness purposes (it is not oblivious
for ordinal purposes: the new task's ordinal, 2000, is `ck-a1b2c3`'s
1000 + 1000).

**Collision case: a hash ID that happens to be all decimal digits.**
CanKan's hash format is not specified precisely enough in CONCEPT.md to
rule this out, so it was tested directly rather than assumed away.
Dropped a hand-written `ck-847213 - Numeric looking hash.md` in (config
still `task_prefix: "ck"`) and ran `task create` again:

```
$ $BACKLOG_BIN task list --plain
To Do:
  CK-847213 - Numeric looking hash

$ $BACKLOG_BIN task create "Next after numeric-looking hash" --plain
File: .../backlog/tasks/ck-847214 - Next-after-numeric-looking-hash.md
Task CK-847214 - Next after numeric-looking hash
...
```

Backlog.md minted `ck-847214` - it treated `847213` as the numeric
watermark and incremented it, exactly as the "scan numeric suffixes,
take max + 1" mechanism inferred from the first create test predicts.
If CanKan's own hash generator later produces a ck- ID with an
all-digit suffix, a subsequent `backlog task create` **will** collide
with it in the same run.

**Conclusion: no crash on a non-numeric maximum, but a real (if
narrow) collision risk when the hash happens to look numeric.**
Backlog.md's sequential allocator does not error on a non-numeric
maximum; it silently ignores every non-numeric-suffixed ID when
computing the next integer, but a numeric-looking suffix is fully
absorbed into that computation and can collide.

## Decision

**`cankan adopt backlog` does not need to renumber CanKan's native
`ck-a1b2c3` IDs.** Evidence: Backlog.md's parser tolerates a non-numeric
ID field and a non-numeric filename suffix without crashing (probes 1
and 3); its own ID allocator copes with their presence by ignoring them,
not by erroring or colliding. Renumbering to `TASK-N` would buy nothing
that keeping `ck-a1b2c3` doesn't already have, and would cost CanKan its
collision-free, coordination-free ID scheme (CONCEPT.md line 48's whole
point).

What *is* required, and is new relative to CONCEPT.md's current text:

1. **`cankan init` (detecting an existing `backlog/`) and `cankan adopt
   backlog` must set `task_prefix: ck` in `backlog/config.yml`.**
   Without this, native CanKan tickets are invisible to every `backlog`
   command and to `backlog browser` - not a parse failure, a silent
   zero-result discovery gate. This is a one-line config write, not a
   renumbering pass.
2. **If the repo already has Backlog.md-native `task-N` tickets when
   `cankan adopt backlog` runs, they must be migrated into the `ck-`
   namespace, not renumbered.** Because `task_prefix` is a single global
   value (mixed-prefix gap, probe 1), setting it to `ck` for native
   tickets makes any pre-existing `task-N` tickets invisible to Backlog.md
   tooling - the opposite of the compatibility CONCEPT.md line 46
   promises. The fix reuses machinery CanKan already has for imported
   tickets (CONCEPT.md line 48): treat each pre-existing `task-N` as an
   import, mint a `ck-` ID for it, rename the file, rewrite `id:` to the
   new `ck-` ID, set that ticket's `cankan.display_id`/alias to `TASK-N`,
   and write an `alias` event recording `from: TASK-N, to: ck-<hash>` so
   `cankan show`, old branch names, and commit references referring to
   `TASK-N` still resolve. This is **not** the renumbering this ADR
   answers "no" to - it never touches a `ck-` ID's own numbering scheme,
   it only relabels pre-existing sequential tickets into the same
   namespace CanKan already uses for every other backer's imports. It is
   required once, at adoption time, only when Backlog.md tickets already
   exist; a repo starting from `cankan init` with no prior `backlog/`
   never needs it.
3. **CanKan-specific fields cannot live safely in a file Backlog.md is
   allowed to write.** Probe 2 shows `backlog task edit` deletes the
   entire `cankan:` block on any edit, regardless of which field changed.
   CONCEPT.md line 46's "ignores" claim needs correcting to "ignores on
   read, destroys on write." This does not force abandoning the shared
   file (CanKan can re-derive/re-attach `cankan:` state after detecting
   an external Backlog.md write - the event log is the durable source of
   truth for `claim`/`sync`/`deps` already, per CONCEPT.md's own
   "Claims are not stored in the ticket file" note), but it means the
   `cankan:` block must be treated as a **disposable cache**, not
   durable storage, whenever Backlog.md coexists as an active editor.
4. **`ticket/id.ts` (M2.2) must not generate all-digit hash suffixes**,
   or must existence-check against Backlog.md-visible files before
   minting. Probe 3 confirmed (not merely inferred) that Backlog.md's
   allocator absorbs a numeric-looking `ck-` suffix into its own
   watermark and will mint a colliding next ID.

No probe was inconclusive; all three produced reproducible, unambiguous
output.

## Alternatives considered

- **Renumber to `TASK-N` on adopt anyway, for maximum Backlog.md
  fidelity:** rejected. Nothing in the probes shows numeric IDs are
  required, and renumbering reintroduces the coordination problem
  hash IDs exist to avoid (two branches/worktrees would need to agree on
  the next integer). Would also do nothing for the actual failure mode
  found (write destruction of `cankan:`).
- **Keep `task_prefix: task` and rename CanKan's own file/ID prefix to
  `task` to match:** rejected. `task` is Backlog.md's own reserved
  default and its ID format assumes small sequential integers; forcing
  CanKan's hash IDs under that prefix does not change Probe 3's finding
  that Backlog.md's allocator would still generate colliding-looking
  `task-1`, `task-2`, etc. against a *different* meaning of "task-N",
  and it abandons the `ck-` namespacing CONCEPT.md uses to distinguish
  CanKan tickets from Backlog.md-native ones at a glance.
- **Give up on same-file coexistence; store `cankan:` metadata in a
  sidecar file instead:** not rejected outright, but deferred - probe 2's
  finding narrows this to "necessary only if Backlog.md is an active
  editor in a given repo," not universally. M2.2 can implement the
  disposable-cache/re-attach strategy first and fall back to a sidecar
  only if that proves unworkable in practice.

## Consequences

- **M2.2** (`ticket/schema.ts`, `ticket/frontmatter.ts`): the "byte-
  identical round-trip including ones written by real Backlog.md"
  requirement must account for the fact that a file legitimately written
  by Backlog.md **will not have a `cankan:` block** even if it had one
  before Backlog.md last touched it. The round-trip guarantee is
  therefore: CanKan parse -> CanKan serialize -> byte-identical, for both
  CanKan-authored and Backlog.md-authored files; it is explicitly *not*
  "the `cankan:` block always survives a foreign write" - that block's
  persistence is CanKan's own responsibility to re-derive, not something
  the file format guarantees. `frontmatter.ts` should treat a missing
  `cankan:` block as "native, unsynced" rather than a parse error.
- **M4.10** (`packages/core/test/backlog-compat.test.ts`): pin
  **`backlog.md@1.51.0`** for the CI install referenced there and in
  PLAN.md's "CI installs a pinned version" note. The test must also set
  `task_prefix: ck` in the fixture repo's `backlog/config.yml` before
  asserting `backlog task list --json` sees CanKan-written tickets -
  the default `task_prefix: task` will make the test fail on discovery
  alone, independent of any real incompatibility. The test should
  explicitly assert the write-destruction behavior from probe 2 (edit
  with `backlog task edit`, confirm `cankan:` is gone) so a future
  Backlog.md release that starts preserving unknown frontmatter keys is
  noticed rather than silently changing CanKan's required
  reconciliation behavior.
- **`cankan init`/`cankan adopt backlog`** (CONCEPT.md's detection table,
  ~line 38, and the adoption flow, ~line 48-50) must additionally write
  `task_prefix: ck` (or whatever CanKan's configured native prefix is)
  into `backlog/config.yml` when reusing an existing Backlog.md
  directory, **and** must migrate any pre-existing `task-N` tickets into
  the `ck-` namespace (rename, rewrite `id:`, set `display_id`/alias,
  write an `alias` event) before doing so - otherwise setting
  `task_prefix: ck` silently orphans those tickets from Backlog.md's own
  view. Neither step is currently mentioned in CONCEPT.md or PLAN.md;
  CONCEPT.md's detection-table line ("reuse the existing task directory
  as-is; no import needed") is incomplete once native `ck-` tickets are
  also in play and should be revised to describe this migration.
- CONCEPT.md line 46 ("with CanKan-specific fields ... namespaced under a
  `cankan:` key that Backlog.md ignores") should be corrected: Backlog.md
  ignores the block on read but deletes it on write. The compatibility
  claim survives, but only if CanKan never treats the in-file `cankan:`
  block as authoritative/durable in a repo where Backlog.md is also
  editing tickets.
- **`ticket/id.ts` (M2.2)** must exclude or existence-check all-digit
  hash suffixes (e.g. `ck-847213`) before minting - probe 3 confirmed
  Backlog.md's own allocator will absorb such an ID as its numeric
  watermark and mint a colliding next ID on the very next
  `backlog task create`.
