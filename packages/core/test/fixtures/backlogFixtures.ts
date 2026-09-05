/**
 * Byte-exact fixture corpus for M2.2's frontmatter round-trip tests.
 *
 * These are lifted verbatim from `CONCEPT.md` and `docs/decisions/
 * 0002-ids-and-backlog-compat.md` wherever those documents quote real
 * Backlog.md output, per the phase brief: "if docs/decisions/0002-*.md
 * quotes real Backlog.md output you can lift verbatim into a fixture, do —
 * a fixture written by the real tool is worth more than one you invented."
 * Each export's comment names its exact source.
 *
 * `packages/test-utils/src/fixtureTickets.ts` is a different, shared,
 * additive-only fixture used by sibling lanes (M2.3, M2.6); this module is
 * M2.2-specific byte-exact test data and stays local to this package.
 */

/**
 * CONCEPT.md "Ticket file — `backlog/tasks/<id> - <slug>.md`" (~line 432),
 * the fenced example at lines 435-473, copied verbatim including its inline
 * YAML comments and the `…` placeholders in the body. This is the spec's
 * own canonical CanKan-native ticket, with a full `cankan:` block.
 */
export const CONCEPT_TICKET_EXAMPLE = "---\nid: ck-7f3a9c\ntitle: Rate-limit the webhook endpoint\nstatus: In Progress\nassignee: [alice]\nlabels: [backend]\nmilestone: v1.2\npriority: high\nordinal: 1250                    # manual rank; Backlog.md's own field\ndue_date: 2026-09-12\ndependencies: [ck-2b1e44]\ncreated_date: 2026-09-01 14:03\nupdated_date: 2026-09-04 10:12\ncankan:\n  origin: jira:PROJ-45           # omitted for native tickets\n  display_id: PROJ-45\n  sync:\n    state: ahead                 # clean | ahead | behind | diverged | conflict\n    base_hash: 3c9f…             # origin content hash at last sync point\n    pulled_at: 2026-09-04T10:12:00Z\n    url: https://acme.atlassian.net/browse/PROJ-45\n  deps:                          # typed deps beyond Backlog.md's flat list\n    - { type: blocks, id: ck-2b1e44 }\n    - { type: discovered-from, id: ck-91ab02 }\n  aliases: [TASK-12]             # previous IDs, filled by adopt/renumber\n---\n\n## Description\n…\n\n## Acceptance Criteria\n- [ ] Returns 429 above 100 req/min per key\n- [ ] Documented in API reference\n\n## Implementation Plan\n…\n\n## Notes\n- 2026-09-04 claude-code:alice/wt-auth: found existing limiter in middleware/, reusing.\n";

/**
 * ADR 0002 probe 2 ("write preservation (decisive)", ~line 229): the
 * `ck-a1b2c3 - Some title.md` fixture *before* `backlog task edit
 * ck-a1b2c3 -s "In Progress"` was run against real `backlog.md@1.51.0`.
 * Reconstructed from the ADR's byte-for-byte before/after diff (~line
 * 243-276); the body is lifted verbatim from probe 1's `--plain` render of
 * the same ticket (~line 172-181), which is the only place the ADR shows
 * this fixture's body text.
 */
export const PROBE2_BEFORE_EDIT = "---\nid: ck-a1b2c3\ntitle: Some title\nstatus: To Do\nassignee: []\nlabels: []\ndependencies: []\ncreated_date: '2026-09-04 22:00'\nordinal: 1000\ncankan:\n  origin: jira:PROJ-45\n  display_id: PROJ-45\n  sync:\n    state: ahead\n    base_hash: 3c9fabc\n    pulled_at: 2026-09-04T10:12:00Z\n    url: https://acme.atlassian.net/browse/PROJ-45\n  deps:\n    - { type: blocks, id: ck-2b1e44 }\n    - { type: discovered-from, id: ck-91ab02 }\n  aliases: [TASK-12]\n---\n\n## Description\nHand-written probe ticket for M1.3 read-tolerance testing.\n\n## Acceptance Criteria\n- [ ] Returns 429 above 100 req/min per key\n- [ ] Documented in API reference\n";

/**
 * The same file from ADR 0002 probe 2, *after* `backlog task edit
 * ck-a1b2c3 -s "In Progress"` — real Backlog.md write behavior: the entire
 * `cankan:` block is deleted, `created_date`/`updated_date` move ahead of
 * `labels`/`dependencies`, and `created_date` stays single-quoted. This is
 * the "ticket whose `cankan:` block has been stripped" fixture the task
 * brief asks for.
 */
export const PROBE2_AFTER_EDIT = "---\nid: ck-a1b2c3\ntitle: Some title\nstatus: In Progress\nassignee: []\ncreated_date: '2026-09-04 22:00'\nupdated_date: '2026-09-04 22:04'\nlabels: []\ndependencies: []\nordinal: 1000\n---\n\n## Description\nHand-written probe ticket for M1.3 read-tolerance testing.\n\n## Acceptance Criteria\n- [ ] Returns 429 above 100 req/min per key\n- [ ] Documented in API reference\n";

/**
 * ADR 0002 probe 3 ("ID allocation", ~line 299): the exact `cat` output of
 * `backlog/tasks/ck-1 - New-task-after-hash-id-present.md` (~line 328-338)
 * after a real `backlog task create`, lifted verbatim — note the uppercase
 * `id: CK-1` against the lowercase filename prefix. The ADR does not show
 * this file's body text (the shown `cat` output ends right at the closing
 * `---`, with no trailing newline shown after it either), so this fixture's
 * body is empty — the closing delimiter's own trailing newline is the last
 * byte, consistent with what was actually shown.
 */
export const PROBE3_MISMATCH_TICKET = "---\nid: CK-1\ntitle: New task after hash id present\nstatus: To Do\nassignee: []\ncreated_date: '2026-09-04 22:20'\nlabels: []\ndependencies: []\nordinal: 2000\n---\n";

/** The real filename from the same probe — casing legitimately disagrees with `PROBE3_MISMATCH_TICKET`'s `id:` field. */
export const PROBE3_MISMATCH_FILENAME = "ck-1 - New-task-after-hash-id-present.md";

/**
 * Synthetic — neither CONCEPT.md nor ADR 0002 shows a "future Backlog.md
 * field CanKan doesn't know about yet" example, so this one is invented to
 * exercise the `.passthrough()` requirement: `epic` is not in
 * `ticketFrontmatterSchema`, and must survive parse -> mutate -> serialize
 * untouched.
 */
export const UNKNOWN_FIELD_TICKET = "---\nid: ck-9d4e21\ntitle: Add rate limit dashboard panel\nstatus: To Do\nassignee: []\nlabels: []\nepic: EPIC-42\ndependencies: []\ncreated_date: '2026-09-04 09:00'\n---\n\n## Description\nTrack requests per key on a new dashboard panel.\n";
