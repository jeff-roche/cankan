/**
 * Zod schemas transcribed from CONCEPT.md "Configuration" (lines 277-413).
 *
 * Three schemas mirror the three config *files* exactly as CONCEPT.md shows
 * them — `.cankan/config.yml` (repo), `.cankan/local.yml` (repo-local), and
 * `~/.config/cankan/config.yml` (global). Each is deliberately narrower than
 * the merged result: a file's schema only accepts the keys CONCEPT.md's own
 * example block for *that file* shows. That is why a fourth schema exists.
 *
 * `effectiveConfigSchema` is the superset — the union of every key any layer
 * can contribute — and is the only one of the four that carries built-in
 * (fifth-layer) defaults via `.default(...)`. The per-file schemas never
 * default: a repo file that omits `claims.lease` must parse to `undefined`
 * for that key, not silently materialize `"2h"`, or layer-precedence
 * resolution (Task B's `resolve.ts`) could not tell "this layer set it" from
 * "this layer didn't."
 *
 * Every object shape below is `z.strictObject(...)` so an unknown key
 * anywhere in a config file surfaces as a zod issue naming that key's path
 * (contract R13). Only genuinely dynamic maps (`backers`, `queues`, `hooks`,
 * `priority_map`, `status_map`, `repos.names`) use `z.record(...)`, which
 * has no notion of "unrecognized key" — any string is a legal map key.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * A bare duration like `2h` or `15m` (CONCEPT.md 298: `lease: 2h`, 379:
 * `lease: 4h`). CONCEPT.md never spells out the unit grammar beyond its own
 * examples, so this is an inference — see the implementer report's
 * "inference list".
 */
const DURATION_PATTERN = /^\d+(ms|s|m|h|d|w)$/;

/**
 * `interval:<duration>`, the non-enum member of `sync.auto_pull` (CONCEPT.md
 * 304: `interval:15m`) and `personal.sync` (CONCEPT.md 402: `interval:10m`).
 */
const INTERVAL_PATTERN = /^interval:\d+(ms|s|m|h|d|w)$/;

const durationSchema = z
  .string()
  .regex(DURATION_PATTERN, { error: "must be a duration like \"2h\" or \"15m\"" });

/**
 * ADR 0001's fail-early namespace check (contract R14). The pattern is
 * verbatim from the brief and the ADR — do not tighten it. It deliberately
 * admits a component of `..` (see the implementer report): the ADR assigns
 * rejecting that to `git check-ref-format`, which is M2.6's job, not this
 * schema's. Shelling out to git here would duplicate that backstop and pull
 * a `git/` dependency this module does not have.
 */
const COORDINATION_REF_PATTERN = /^refs\/cankan\/[A-Za-z0-9._/-]+$/;

const coordinationRefSchema = z.string().regex(COORDINATION_REF_PATTERN, {
  error:
    'coordination.ref must match refs/cankan/<path> (letters, digits, ".", "_", "-", "/" only) — e.g. "refs/cankan/coordination"',
});

/**
 * `default_backer` (CONCEPT.md 330) and `personal.default_backer` (405).
 * `"none"` is not a backer type — it means "no backer" — so it is kept out
 * of `BACKER_TYPES` below.
 */
const defaultBackerChoiceSchema = z.enum(["none", "github", "jira", "beads"]);

/** The backer *type* names implied by `default_backer`'s non-`none` members. */
const BACKER_TYPES = ["github", "jira", "beads"] as const;
const backerTypeSchema = z.enum(BACKER_TYPES);

const coordinationModeSchema = z.enum(["shared-ref", "branch-scan"]);
const syncAutoPushSchema = z.enum(["off", "transitions_only", "all"]);
const syncAutoPullSchema = z.union([
  z.enum(["off", "on_prime", "on_board"]),
  z.string().regex(INTERVAL_PATTERN, { error: 'must be "off", "on_prime", "on_board", or "interval:<duration>"' }),
]);
const syncConflictPolicySchema = z.enum(["manual", "ours", "theirs"]);
const credentialsStoreSchema = z.enum(["keychain", "file", "env"]);
const personalSyncSchema = z.union([
  z.enum(["on_command", "on_change"]),
  z.string().regex(INTERVAL_PATTERN, { error: 'must be "on_command", "on_change", or "interval:<duration>"' }),
]);

/**
 * `output.color` (CONCEPT.md 387) — **inference**: the spec's example shows
 * only `auto`, and the trailing comment on other enums (e.g. `sync.auto_push`
 * 303: `off | transitions_only | all`) is exactly how CONCEPT.md documents a
 * closed set, but line 387 carries no such comment. `always | never` are the
 * conventional counterparts to `auto` in every CLI that has this flag, so
 * this schema accepts all three and flags the two inferred members. See the
 * implementer report's "inference list".
 */
const outputColorSchema = z.enum(["auto", "always", "never"]);

// ---------------------------------------------------------------------------
// `backers` — repo keys by type, global keys by name with explicit `type`
// (contract R4). `status_map`/`priority_map` are modeled permissively, not
// as a discriminated union (see report's "inference list").
// ---------------------------------------------------------------------------

/**
 * `status_map`'s value differs per backer type (`{ state, label? }` for
 * github, `{ status }` for jira — CONCEPT.md 311-327). Modeled as an opaque
 * record rather than a discriminated union: this schema has no way to know
 * which backer type a given map entry belongs to without duplicating
 * `backers`' own keying, and CONCEPT.md never states the full field set for
 * every backer type this module doesn't yet know about (e.g. `beads`).
 */
const statusMapSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

const priorityMapSchema = z.record(z.string(), z.string());

/** Fields common to a backer entry regardless of which file declares it. */
const backerEntryFields = {
  /** `owner/name` for github (CONCEPT.md 309); absent for other backers. */
  repo: z.string().optional(),
  /** Base URL for backers with one, e.g. jira's Atlassian site (320, 393). */
  site: z.string().optional(),
  /**
   * A GitHub Projects *number* (317: `project: 12`) or a Jira project *key*
   * (320: `project: PROJ`) — the field name is shared, the value type is
   * not.
   */
  project: z.union([z.string(), z.number()]).optional(),
  /** A name in the credentials store — never a secret value (contract R10). */
  credential: z.string().optional(),
  status_map: statusMapSchema.optional(),
  priority_map: priorityMapSchema.optional(),
  /** Jira-only (CONCEPT.md 328). */
  sprint_field: z.string().optional(),
};

/** `.cankan/config.yml`'s `backers.<type>` entry — no `type` field (R4). */
const repoBackerEntrySchema = z.strictObject(backerEntryFields);

/** Global config's `backers.<name>` entry — `type` is required (R4). */
const globalBackerEntrySchema = z.strictObject({
  ...backerEntryFields,
  type: backerTypeSchema,
});

/** The merged superset entry: same fields, `type` optional (R4). */
const effectiveBackerEntrySchema = z.strictObject({
  ...backerEntryFields,
  type: backerTypeSchema.optional(),
});

// ---------------------------------------------------------------------------
// `queues` (repo, CONCEPT.md 336-346) and `personal.queues` (405-406) share
// one entry shape; `actors` happens to appear only in the repo example, but
// the brief models it as optional on the one shared shape rather than two.
// ---------------------------------------------------------------------------

const queueFilterSchema = z.strictObject({
  labels: z.array(z.string()).optional(),
  priority: z.array(z.string()).optional(),
  backer: z.array(z.string()).optional(),
});

const queueEntrySchema = z.strictObject({
  filter: queueFilterSchema.optional(),
  order: z.array(z.string()).optional(),
  /** Actor-name-pattern list; only the repo example (346) shows this. */
  actors: z.array(z.string()).optional(),
});

const queuesSchema = z.record(z.string(), queueEntrySchema);

/** `hooks.<event>` → shell command (CONCEPT.md 348-349, 367-368). */
const hooksSchema = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// `.cankan/config.yml` — repo, checked in (CONCEPT.md 277-358)
// ---------------------------------------------------------------------------

const repoCoordinationSchema = z.strictObject({
  ref: coordinationRefSchema.optional(),
  mode: coordinationModeSchema.optional(),
  push_ref: z.boolean().optional(),
});

const repoClaimsSchema = z.strictObject({
  lease: durationSchema.optional(),
  /** `0 = unlimited` (CONCEPT.md 299). */
  max_per_actor: z.number().int().min(0).optional(),
  require_ready: z.boolean().optional(),
});

const repoSyncSchema = z.strictObject({
  auto_push: syncAutoPushSchema.optional(),
  auto_pull: syncAutoPullSchema.optional(),
  conflict_policy: syncConflictPolicySchema.optional(),
});

const readySchema = z.strictObject({
  order: z.array(z.string()).optional(),
  exclude_labels: z.array(z.string()).optional(),
});

const repoAgentsSchema = z.strictObject({
  instructions_file: z.string().optional(),
  mcp: z.boolean().optional(),
});

export const repoConfigSchema = z.strictObject({
  version: z.number().int().optional(),
  project: z.string().optional(),
  id_prefix: z.string().optional(),
  tickets_dir: z.string().optional(),
  columns: z.array(z.string()).optional(),
  coordination: repoCoordinationSchema.optional(),
  claims: repoClaimsSchema.optional(),
  sync: repoSyncSchema.optional(),
  backers: z.record(z.string(), repoBackerEntrySchema).optional(),
  default_backer: defaultBackerChoiceSchema.optional(),
  ready: readySchema.optional(),
  queues: queuesSchema.optional(),
  hooks: hooksSchema.optional(),
  agents: repoAgentsSchema.optional(),
  definition_of_done: z.array(z.string()).optional(),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

// ---------------------------------------------------------------------------
// `.cankan/local.yml` — repo-local, gitignored (CONCEPT.md 360-369)
// ---------------------------------------------------------------------------

const localSyncSchema = z.strictObject({
  auto_pull: syncAutoPullSchema.optional(),
});

export const localConfigSchema = z.strictObject({
  actor: z.string().optional(),
  parent: z.string().optional(),
  default_backer: defaultBackerChoiceSchema.optional(),
  sync: localSyncSchema.optional(),
  hooks: hooksSchema.optional(),
});

export type LocalConfig = z.infer<typeof localConfigSchema>;

// ---------------------------------------------------------------------------
// `~/.config/cankan/config.yml` — global user (CONCEPT.md 371-413)
// ---------------------------------------------------------------------------

const identitySchema = z.strictObject({
  name: z.string().optional(),
  email: z.string().optional(),
});

const globalClaimsSchema = z.strictObject({
  lease: durationSchema.optional(),
});

const globalSyncSchema = z.strictObject({
  auto_push: syncAutoPushSchema.optional(),
});

const credentialsSchema = z.strictObject({
  store: credentialsStoreSchema.optional(),
});

const globalAgentsSchema = z.strictObject({
  default_tool: z.string().optional(),
});

const outputSchema = z.strictObject({
  color: outputColorSchema.optional(),
  json_pretty: z.boolean().optional(),
});

const personalSchema = z.strictObject({
  /** Raw string — no `~` expansion here; that is M2.4's job (contract R15). */
  path: z.string().optional(),
  remote: z.string().optional(),
  sync: personalSyncSchema.optional(),
  default_backer: defaultBackerChoiceSchema.optional(),
  columns: z.array(z.string()).optional(),
  queues: queuesSchema.optional(),
});

const reposSchema = z.strictObject({
  auto_register: z.boolean().optional(),
  /** `<path>: <friendly name>` (CONCEPT.md 410-412). */
  names: z.record(z.string(), z.string()).optional(),
});

export const globalConfigSchema = z.strictObject({
  version: z.number().int().optional(),
  identity: identitySchema.optional(),
  editor: z.string().optional(),
  claims: globalClaimsSchema.optional(),
  sync: globalSyncSchema.optional(),
  credentials: credentialsSchema.optional(),
  agents: globalAgentsSchema.optional(),
  output: outputSchema.optional(),
  backers: z.record(z.string(), globalBackerEntrySchema).optional(),
  personal: personalSchema.optional(),
  repos: reposSchema.optional(),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

// ---------------------------------------------------------------------------
// `effectiveConfigSchema` — the merged superset. Every field optional except
// where a built-in (fifth-layer) default exists. Each defaulted *object* is
// itself given a literal default matching what parsing `{}` through its
// inner shape would produce — `.default(x)` substitutes `x` directly without
// re-validating it (zod's own behavior), so if the whole group (e.g.
// `coordination`) is absent, its literal default must already carry every
// leaf default the group's own fields declare.
// ---------------------------------------------------------------------------

const effectiveCoordinationSchema = z.strictObject({
  ref: coordinationRefSchema.default("refs/cankan/coordination"),
  mode: coordinationModeSchema.default("shared-ref"),
  push_ref: z.boolean().default(true),
});

const effectiveClaimsSchema = z.strictObject({
  lease: durationSchema.default("2h"),
  max_per_actor: z.number().int().min(0).default(3),
  require_ready: z.boolean().default(true),
});

const effectiveSyncSchema = z.strictObject({
  auto_push: syncAutoPushSchema.default("off"),
  auto_pull: syncAutoPullSchema.default("off"),
  conflict_policy: syncConflictPolicySchema.default("manual"),
});

const effectiveReadySchema = z.strictObject({
  order: z.array(z.string()).default(["rank", "priority:desc", "created:asc"]),
  exclude_labels: z.array(z.string()).optional(),
});

const effectiveAgentsSchema = z.strictObject({
  instructions_file: z.string().default("AGENTS.md"),
  mcp: z.boolean().default(true),
  default_tool: z.string().optional(),
});

const effectiveOutputSchema = z.strictObject({
  color: outputColorSchema.default("auto"),
  json_pretty: z.boolean().default(false),
});

const effectiveReposSchema = z.strictObject({
  auto_register: z.boolean().default(true),
  names: z.record(z.string(), z.string()).optional(),
});

export const effectiveConfigSchema = z.strictObject({
  version: z.number().int().optional(),
  project: z.string().optional(),
  id_prefix: z.string().optional(),
  tickets_dir: z.string().default("backlog/tasks"),
  /**
   * The four-column default (CONCEPT.md 284-288) — **inference**, flagged
   * per the brief: CONCEPT.md never says these four names are a fallback
   * rather than "the columns this example repo happens to use," but every
   * other example in the doc (status maps, queues) assumes exactly these
   * four names exist, so treating them as the built-in default is the only
   * reading that keeps those other examples coherent with no config at all.
   */
  columns: z.array(z.string()).default(["To Do", "In Progress", "In Review", "Done"]),
  coordination: effectiveCoordinationSchema.default({
    ref: "refs/cankan/coordination",
    mode: "shared-ref",
    push_ref: true,
  }),
  claims: effectiveClaimsSchema.default({ lease: "2h", max_per_actor: 3, require_ready: true }),
  sync: effectiveSyncSchema.default({ auto_push: "off", auto_pull: "off", conflict_policy: "manual" }),
  backers: z.record(z.string(), effectiveBackerEntrySchema).optional(),
  default_backer: defaultBackerChoiceSchema.default("none"),
  ready: effectiveReadySchema.default({ order: ["rank", "priority:desc", "created:asc"] }),
  queues: queuesSchema.optional(),
  hooks: hooksSchema.optional(),
  agents: effectiveAgentsSchema.default({ instructions_file: "AGENTS.md", mcp: true }),
  definition_of_done: z.array(z.string()).optional(),
  actor: z.string().optional(),
  parent: z.string().optional(),
  editor: z.string().optional(),
  identity: identitySchema.optional(),
  credentials: credentialsSchema.optional(),
  output: effectiveOutputSchema.default({ color: "auto", json_pretty: false }),
  personal: personalSchema.optional(),
  repos: effectiveReposSchema.default({ auto_register: true }),
});

export type EffectiveConfig = z.infer<typeof effectiveConfigSchema>;
