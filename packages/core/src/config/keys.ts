/**
 * The policy-vs-preference classification table, transcribed verbatim from
 * CONCEPT.md "Policy vs preference (default classification)" (415-426).
 *
 * **Resolution rule (CONCEPT.md 256-257, contract R1):**
 * - Preference keys resolve `env > repo-local > repo > global > default`.
 * - Policy keys resolve `repo > repo-local > global > default` — no `env`
 *   rung at all.
 *
 * This file only classifies keys; it does not resolve them (that is Task
 * B's `resolve.ts`).
 */

/** One row of CONCEPT.md's classification table, as a matchable pattern. */
export interface KeyClassificationEntry {
  /** A dotted key path pattern; see `matchesPattern` for the matching rule. */
  pattern: string;
  class: "policy" | "preference";
}

/**
 * Verbatim transcription of CONCEPT.md 415-426, one entry per cell. A table
 * cell naming several fields at once (`backers.*.repo/site/project`) is
 * split into one pattern per field, because a pattern is matched
 * segment-by-segment against a real dotted key path — a literal
 * `"repo/site/project"` segment would never occur in an actual key and so
 * could never match anything.
 *
 * The parenthetical notes CONCEPT.md attaches to some preference entries
 * (`claims.lease` "unless pinned", `ready.order` "unless pinned",
 * `default_backer` "unless pinned", `sync.auto_push` "preference by
 * default, commonly pinned as policy") describe the `!policy` pin
 * mechanism — Task B's `resolve.ts` reads that tag and raises
 * `POLICY_VIOLATION`. Here, before any pin is considered, all four are
 * simply **preference**.
 *
 * **`hooks` — classified policy, not the two rows CONCEPT.md's table
 * literally shows** ("`hooks` in repo config" / "`hooks` in local/global
 * config"). Per contract R5: classification is per *key*, not per *file*,
 * and CONCEPT.md's own text says the split only bites "when both files set
 * the same event," at which point repo wins outright — which is exactly
 * policy precedence (`repo > repo-local > global > default`). So `hooks.*`
 * is encoded here as one policy entry. Additive execution across layers, if
 * anyone ever wants it, is M2.16's call via `ConfigResult.layers` — this
 * lane does not build it.
 */
export const KEY_CLASSIFICATION: readonly KeyClassificationEntry[] = [
  // ---- Policy (repo wins) --------------------------------------------
  { pattern: "columns", class: "policy" },
  { pattern: "id_prefix", class: "policy" },
  { pattern: "tickets_dir", class: "policy" },
  { pattern: "coordination.*", class: "policy" },
  { pattern: "claims.max_per_actor", class: "policy" },
  { pattern: "claims.require_ready", class: "policy" },
  { pattern: "queues.*", class: "policy" },
  { pattern: "ready.exclude_labels", class: "policy" },
  { pattern: "backers.*.status_map", class: "policy" },
  { pattern: "backers.*.repo", class: "policy" },
  { pattern: "backers.*.site", class: "policy" },
  { pattern: "backers.*.project", class: "policy" },
  { pattern: "sync.conflict_policy", class: "policy" },
  // R5: see the file-level comment above.
  { pattern: "hooks.*", class: "policy" },
  { pattern: "definition_of_done", class: "policy" },

  // ---- Preference (user wins) ----------------------------------------
  { pattern: "actor", class: "preference" },
  { pattern: "parent", class: "preference" },
  { pattern: "editor", class: "preference" },
  { pattern: "output.*", class: "preference" },
  // "unless pinned" — see the file-level comment above.
  { pattern: "claims.lease", class: "preference" },
  { pattern: "ready.order", class: "preference" },
  { pattern: "backers.*.credential", class: "preference" },
  { pattern: "sync.auto_pull", class: "preference" },
  { pattern: "default_backer", class: "preference" },
  // "preference by default, commonly pinned as policy" — see above.
  { pattern: "sync.auto_push", class: "preference" },
] as const;

/**
 * Every leaf key path reachable in `effectiveConfigSchema` that no pattern
 * above matches (contract R2). These resolve as preference by
 * `classifyKey`'s default, per R2 — but are listed here explicitly so the
 * gap is enumerated rather than implied. A dynamic-map segment (a backer
 * name, a queue name, a hook event, a status-map column, a priority-map
 * level) is written as `*`, exactly as in `KEY_CLASSIFICATION` patterns,
 * because the schema alone cannot enumerate a map's actual keys.
 *
 * Derived by walking `effectiveConfigSchema` (see
 * `test/config/keys.test.ts`'s gap test) and removing every leaf
 * `KEY_CLASSIFICATION` already matches. Sorted for a stable diff.
 */
export const UNCLASSIFIED_KEYS: readonly string[] = [
  "agents.default_tool",
  "agents.instructions_file",
  "agents.mcp",
  "backers.*.priority_map.*",
  "backers.*.sprint_field",
  "backers.*.type",
  "credentials.store",
  "identity.email",
  "identity.name",
  "personal.columns",
  "personal.default_backer",
  "personal.path",
  "personal.queues.*.actors",
  "personal.queues.*.filter.backer",
  "personal.queues.*.filter.labels",
  "personal.queues.*.filter.priority",
  "personal.queues.*.order",
  "personal.remote",
  "personal.sync",
  "project",
  "repos.auto_register",
  "repos.names.*",
  "version",
] as const;

/**
 * Whether `pattern` (a dotted pattern string) matches `keySegments` (already
 * split into path segments — see AMENDMENT A1 in `../.superpowers/sdd/phase-M2.3/contract.md`
 * for why `classifyKey` must classify from segments rather than a
 * re-joined-and-re-split string: a record key can itself contain a literal
 * "." — `hooks: { "release.done": ... }`, `repos.names`'s filesystem-path
 * keys — and splitting a rendered `"hooks.release.done"` string back apart
 * would miscount segments and misclassify). A pattern segment of `*`
 * matches exactly one key segment, whatever it is; every other pattern
 * segment must equal the key segment at that position literally.
 *
 * A pattern matches as a **prefix**: it need not name every segment of
 * `key`, only the leading ones. This is what lets a 3-segment pattern like
 * `backers.*.status_map` classify not just the `status_map` key itself but
 * everything beneath it (`backers.github.status_map.To Do.state`,
 * however deep the backer's own representation goes) — the map's whole
 * subtree inherits one classification, matching how CONCEPT.md's table
 * treats it as a single row. A pattern longer than `key` never matches.
 */
function matchesPattern(pattern: string, keySegments: readonly string[]): boolean {
  const patternSegments = pattern.split(".");
  if (patternSegments.length > keySegments.length) {
    return false;
  }
  return patternSegments.every(
    (segment, i) => segment === "*" || segment === keySegments[i],
  );
}

/**
 * Classifies one config key as `"policy"` or `"preference"`.
 *
 * Accepts either form (AMENDMENT A1 — union parameter, not a new method
 * name, so the export name set is unchanged for the lanes freezing against
 * it): a `readonly string[]` of path segments (the unambiguous form —
 * `resolve.ts` always calls this way, since only segments can safely
 * represent a record key that itself contains a "."), or a plain dotted
 * `string`, split on "." here for backward-compatible callers that already
 * know none of their segments contain an embedded dot (e.g. this file's own
 * tests, and the classification-table patterns themselves).
 *
 * When more than one `KEY_CLASSIFICATION` pattern matches the same key, the
 * pattern with the most segments (the most specific one) wins — mirroring
 * how `backers.*.credential` should outrank a hypothetical broader
 * `backers.*` if one ever existed. No two entries in the transcribed table
 * currently overlap this way (see the implementer report), so this tie-break
 * is defensive rather than exercised by the current table.
 *
 * A key matched by no pattern is `"preference"` — CONCEPT.md's table is a
 * default classification, not an exhaustive one, and contract R2 rules
 * unclassified keys preference by default.
 */
export function classifyKey(key: string | readonly string[]): "policy" | "preference" {
  const keySegments = Array.isArray(key) ? key : (key as string).split(".");
  let best: KeyClassificationEntry | undefined;
  for (const entry of KEY_CLASSIFICATION) {
    if (!matchesPattern(entry.pattern, keySegments)) {
      continue;
    }
    if (!best || entry.pattern.split(".").length > best.pattern.split(".").length) {
      best = entry;
    }
  }
  return best?.class ?? "preference";
}
