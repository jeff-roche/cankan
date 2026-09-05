/**
 * The precedence engine (contract §1's `loadConfig`, `ConfigResult`,
 * `ResolvedEntry`, `LoadConfigOptions`, as amended by AMENDMENT A1) -- per-key
 * precedence (R1), per-leaf map resolution (R3), the `!policy` tag (R6),
 * eager `POLICY_VIOLATION` (R7), and `CANKAN_*` env overrides (R8-R10).
 *
 * **AMENDMENT A1 note:** attribution is keyed by `path: readonly string[]`
 * throughout this file, never by a `.`-joined string. A record key can
 * itself contain a literal "." (`hooks: { "release.done": ... }`, and above
 * all `repos.names`, whose keys are filesystem paths) -- joining a path to a
 * string and later splitting it back apart on "." is lossy and ambiguous,
 * and was the root cause of a real defect (a raw `ZodError` escaping
 * `loadConfig` for any `repos.names` key containing a dot). `key` /
 * `ResolvedEntry.key` still exist as the **rendered, display-only** form
 * (`path.join(".")`); nothing in this file's internal logic reads a
 * rendered key back apart into segments. Where a `Map`/`Set` needs a
 * primitive key to dedupe or look up an array by value, `encodePathKey`
 * (`JSON.stringify`) is used -- that encoding is lossless and unambiguous,
 * unlike a dot-join, and nothing ever decodes it back into segments either;
 * it is purely a hashing trick for `Map`/`Set`, not a second "the key" in
 * the amendment's sense.
 *
 * The core move: every value anywhere in a layer's data -- not just
 * map-valued fields -- is flattened to a leaf `path` and resolved
 * independently (`resolved(["claims","lease"])` works exactly like
 * `resolved(["backers","github","credential"])`). Array values (`columns`,
 * `ready.order`, `definition_of_done`, `exclude_labels`, and any
 * `backers.*`/`queues.*` array field) are one leaf each -- replaced
 * wholesale by whichever layer wins, never element-merged. That is a
 * deliberate reading of R3 ("map-valued keys resolve per leaf"): an array
 * is a single value, not a map, so there is no smaller unit to merge per
 * *element* without inventing an ordering/dedup policy CONCEPT.md never
 * specifies.
 */

import { relative } from "node:path";
import {
  type CollectionTag,
  type Document,
  type ScalarTag,
  type Tags,
  isMap,
  isPair,
  isScalar,
  isSeq,
  visit,
} from "yaml";
import type { z } from "zod";
import { CanKanError, ErrorCodes } from "../errors";
import { ConfigErrorCodes } from "./errors";
import { classifyKey } from "./keys";
import {
  buildConfigValidationError,
  type ConfigLayer,
  type LoadedLayer,
  type ValidatedLayer,
  loadValidatedLayer,
  resolveGlobalConfigPath,
  resolveRepoConfigPath,
  resolveRepoLocalConfigPath,
  truncateForDisplay,
} from "./layers";
import {
  type EffectiveConfig,
  effectiveConfigSchema,
  globalConfigSchema,
  localConfigSchema,
  repoConfigSchema,
} from "./schema";

export type { ConfigLayer, LoadedLayer } from "./layers";

// ---------------------------------------------------------------------------
// Contract §1 (as amended by A1) -- attribution and the result.
// ---------------------------------------------------------------------------

/** Where one effective key's value came from. */
export interface ResolvedEntry {
  /** AUTHORITATIVE: the key as path segments. A segment may itself contain
   *  ".", so this is the only lossless form (AMENDMENT A1). */
  path: readonly string[];
  /** Display form: `path.join(".")`. LOSSY and ambiguous when a segment
   *  contains a dot -- for display and for `cankan config show --resolved`
   *  output, never for programmatic lookup. */
  key: string;
  value: unknown;
  layer: ConfigLayer;
  /** Absolute path of the winning file. Absent for layer "env" and "default". */
  file?: string;
  /** The environment variable name. Present iff layer === "env". */
  envVar?: string;
  /** Absolute path of the file that pinned this key with !policy, if pinned. */
  pinnedBy?: string;
}

export interface ConfigResult {
  /** The merged, typed, effective configuration. */
  readonly value: EffectiveConfig;
  /** Every layer file that was found, in precedence order (highest first). */
  readonly layers: readonly LoadedLayer[];
  /**
   * Attribution for one effective key. Returns undefined if the key has no
   * effective value (not set anywhere and no built-in default).
   *
   * AMENDMENT A1: accepts either form. `readonly string[]` matches
   * segment-by-segment -- the unambiguous lookup. A plain `string` matches
   * **exactly against the rendered `entry.key`**, and is never split on
   * "." -- `resolved("hooks.release.done")` finds the entry whose single
   * record key is `"release.done"`, because that is plainly what a caller
   * means. If two distinct paths render to the same string (a record key
   * containing "." colliding with a differently-nested nested key), the
   * string form returns whichever appears **first in `entries()` order**;
   * the array form is the escape hatch for that case.
   */
  resolved(key: string | readonly string[]): ResolvedEntry | undefined;
  /** Attribution for every effective key, sorted by `key`. Powers
   *  `cankan config show --resolved` (M3.3) and `doctor` (M3.9). */
  entries(): readonly ResolvedEntry[];
}

export interface LoadConfigOptions {
  /** Absolute path of the board root that contains `.cankan/`. When absent,
   *  the repo and repo-local layers are simply not loaded (a valid state:
   *  global + env + defaults only). M2.4 passes `BoardRef.root` here. */
  repoRoot?: string;
  /** Environment to read XDG paths and CANKAN_* overrides from.
   *  Defaults to `process.env`. Tests pass an explicit object. */
  env?: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// Path-array plumbing (AMENDMENT A1). `render` is display-only;
// `encodePathKey` is an internal `Map`/`Set` bucketing trick, never
// decoded back into segments by anything in this file.
// ---------------------------------------------------------------------------

function renderPath(path: readonly string[]): string {
  return path.join(".");
}

function encodePathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function pathStartsWith(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length > path.length) {
    return false;
  }
  return prefix.every((segment, i) => segment === path[i]);
}

function isStrictPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  return shorter.length < longer.length && pathStartsWith(shorter, longer);
}

/**
 * Drops any path that is a strict prefix of another path in the same set
 * (review round 2 finding 6). This arises only from a present-but-empty
 * map entry (`backers: { github: {} }`) coexisting with a more specific
 * leaf under the same name from a *different* layer (`backers.github.type`
 * from global): without this filter, `entries()` would carry both the
 * phantom intermediate entry (value `{}`, attributed to whichever layer
 * merely declared the entry) and the real leaf entries beneath it, which
 * is actively misleading for `cankan config show --resolved` and `doctor`,
 * not merely redundant. `value` itself was never affected -- the merge
 * already combines both correctly -- this is purely an `entries()`/
 * `resolved()` presentation fix, done by skipping both the `ResolvedEntry`
 * and the `setPath` call for the shorter path.
 */
function dropStrictPrefixes(paths: readonly (readonly string[])[]): (readonly string[])[] {
  return paths.filter((p) => !paths.some((q) => q !== p && isStrictPrefix(p, q)));
}

// ---------------------------------------------------------------------------
// The `!policy` tag (R6, S3, S4, and review round 2 finding 7).
//
// Registered for every layer's parse, not just the repo file: `yaml@2`
// leaves a node's `.tag` set to `!policy` even when the tag can't be
// resolved against any registered tag (verified empirically -- an unknown
// named tag on a scalar/map/seq degrades to a *warning* plus normal
// structural fallback resolution, not a parse error), so the detection walk
// below would work either way. Registering the tag everywhere instead buys
// correct *type* coercion for a tagged scalar (`claims.max_per_actor:
// !policy 5` must resolve to the number 5, not the string "5" a fallback
// resolution would give) and avoids relying on that unresolved-tag fallback
// behaviour, which isn't part of yaml's documented contract.
//
// No `version` option is passed anywhere in this module (S3): registering
// `customTags` does not change the default YAML 1.2 core schema, so
// `sync.auto_push: off` still parses as the string `"off"`, not `false`
// (verified by a dedicated test).
// ---------------------------------------------------------------------------

const POLICY_TAG = "!policy";

const INT_PATTERN = /^[-+]?\d+$/;
const FLOAT_PATTERN = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;

/**
 * Mimics YAML 1.2 core schema's untagged-scalar resolution (null/bool/
 * int/float, else string) for a scalar explicitly tagged `!policy`.
 *
 * This is a real, if narrow, limitation shared by *any* named YAML tag, not
 * specific to this implementation: `ScalarTag.resolve()` receives only the
 * already-decoded string content, with no memory of whether the source was
 * quoted or plain -- `!!int "5"` has exactly the same blind spot. A
 * hand-rolled core-type sniff (rather than routing through `yaml`'s
 * internal, unexported schema modules) keeps this self-contained and
 * stable across `yaml` versions. Octal/hex integer forms are not
 * recognized (CONCEPT.md's own config values never use them); anything
 * that isn't null/bool/int/float stays a string.
 */
function resolvePolicyScalar(raw: string): unknown {
  if (raw === "" || raw === "~" || raw === "null" || raw === "Null" || raw === "NULL") {
    return null;
  }
  if (raw === "true" || raw === "True" || raw === "TRUE") {
    return true;
  }
  if (raw === "false" || raw === "False" || raw === "FALSE") {
    return false;
  }
  if (INT_PATTERN.test(raw)) {
    return Number(raw);
  }
  if (FLOAT_PATTERN.test(raw) && /[.eE]/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

const policyScalarTag: ScalarTag = {
  tag: POLICY_TAG,
  resolve: (value) => resolvePolicyScalar(value),
};

/**
 * Map and sequence `!policy` nodes resolve to the same already-composed
 * node the default (untagged) path would have produced -- returning it
 * unchanged, just tagged. `yaml` sets `.tag` on the returned node itself
 * regardless of what `resolve` returns, so this is purely "resolve
 * structurally as normal" with no behaviour change to the value.
 */
const policySeqTag: CollectionTag = {
  tag: POLICY_TAG,
  collection: "seq",
  resolve: (node) => node,
};

const policyMapTag: CollectionTag = {
  tag: POLICY_TAG,
  collection: "map",
  resolve: (node) => node,
};

const POLICY_TAGS: Tags = [policyScalarTag, policySeqTag, policyMapTag];

/**
 * Every path in `doc` whose node is tagged `!policy`, i.e. every pinned
 * "root" (R6: "applies to the tagged node and every leaf beneath it" --
 * callers check pin status with `pathStartsWith`, not equality).
 * `visit.SKIP`s into an already-pinned subtree: a nested `!policy` there
 * would only ever be redundant, and skipping keeps the result to one entry
 * per genuinely distinct pin.
 *
 * **Review round 2 finding 7:** a `!policy` tag on the *document root*
 * (no `Pair` ancestor at all, so the accumulated segments array is empty)
 * previously produced a pinned root of `""`, which `findPinnedRoot` could
 * never match against any real key -- silently pinning nothing. That is a
 * silently-broken security control, worse than an upfront rejection, and
 * it fails *open* for the repo (the attacker in this threat model): a
 * repo author writing `!policy` at the top of the file, intending to pin
 * everything, would get no error and no protection. This function now
 * throws instead, for repo, repo-local, and global alike (repo-local and
 * global already reject *any* `!policy` occurrence one level up in
 * `loadConfig`; a root-level tag on either would already be caught there
 * too, but this throws with a specific, actionable message either way).
 *
 * An aliased (`*ref`) occurrence of a pinned anchor does **not** itself
 * carry `.tag` (only the `&anchor !policy ...` definition site does), so it
 * is never recorded as a separate pinned root here. That is a strictly
 * *weaker* pin, not a bypass: S4's actual concern (can `!policy` be
 * smuggled *into* local/global via an alias?) is settled in `loadConfig`,
 * where the rejection walk finds the tag at its one real definition site
 * regardless of how many places later alias it.
 */
function findPolicyTaggedPaths(doc: Document, absPath: string): string[][] {
  const paths: string[][] = [];
  visit(doc, (_key, node, path) => {
    if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag === POLICY_TAG) {
      const segments: string[] = [];
      for (const entry of path) {
        if (isPair(entry) && isScalar(entry.key)) {
          segments.push(String(entry.key.value));
        }
      }
      if (segments.length === 0) {
        throw new CanKanError(
          ConfigErrorCodes.INVALID_CONFIG,
          `${absPath}: "!policy" on the document root is not supported; tag individual keys`,
          { details: { file: absPath } },
        );
      }
      paths.push(segments);
      return visit.SKIP;
    }
    return undefined;
  });
  return paths;
}

/**
 * The pinned root (if any) covering `path` -- exact match or a path
 * ancestor, per R6's "every leaf beneath it".
 */
function findPinnedRoot(
  path: readonly string[],
  pinnedRoots: readonly (readonly string[])[],
): readonly string[] | undefined {
  return pinnedRoots.find((root) => pathStartsWith(root, path));
}

// ---------------------------------------------------------------------------
// S1 -- the prototype-pollution guard. Exported (not via `index.ts`) so a
// white-box test can exercise it directly -- see the review round 2
// finding 9 comment below on why an end-to-end fixture alone does not
// prove this guard is load-bearing.
// ---------------------------------------------------------------------------

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeSegment(segment: string): boolean {
  return !FORBIDDEN_SEGMENTS.has(segment);
}

/**
 * S6: not `value.constructor === Object` -- `constructor` can be a spoofed
 * *own* string property surviving `yaml` -> `zod` (see below), so that
 * check is exactly the wrong tool here. Prototype identity does not have
 * that problem.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Sentinel `flattenLeaves` records for a present-but-empty map entry
 * (`queues: { urgent: {} }` -- a legal, empty `queueEntrySchema`) instead
 * of the layer's own object reference.
 *
 * **Review round 2 finding 5:** the previous version stored `value` (the
 * layer's own, shallow-frozen-at-best object) directly as the leaf value.
 * `setPath`'s intermediate-container step then *reused* that exact
 * reference as a container for a more specific leaf from a *different*
 * layer, mutating it in place -- reproduced as: user's global config has
 * `hooks: {}`, a hostile repo has `hooks: { post_close: "curl ... | sh" }`,
 * and after `loadConfig`, `layers[global].data.hooks` (returned to the
 * caller as-is) had been mutated to contain the repo's hook command, even
 * though the file on disk never changed. Contract §1 exposes `layers`
 * *precisely* so M2.16 can reason about which file a hook came from; this
 * defeated that provenance guarantee entirely. Recording a sentinel here
 * means `setPath` (below) always materializes a **fresh** `{}` for this
 * case, never a reference back into any layer's data. `layers.ts` also now
 * deep-freezes `LoadedLayer.data` as a backstop.
 */
const EMPTY_OBJECT_LEAF = Symbol("empty-object-leaf");

/** One flattened leaf: its full path and its value (or `EMPTY_OBJECT_LEAF`). */
export interface FlatLeaf {
  path: string[];
  value: unknown;
}

/**
 * Flattens a parsed layer's data (or the effective defaults) into leaves,
 * keyed by `encodePathKey` for `Map` lookup. Arrays and every other
 * non-plain-object value are leaves (see the file-level comment on array
 * handling); a forbidden segment (S1) drops that whole subtree from the
 * result rather than merely the final leaf, since a hostile
 * `hooks.__proto__.pwned` must never reach the merge step at any depth.
 *
 * A genuinely empty object is itself a leaf (see `EMPTY_OBJECT_LEAF`'s
 * comment): with no keys to recurse into, a naive version of this function
 * recorded nothing at all for it, silently dropping a present-but-empty
 * map entry from the merged result. An object left empty only *after*
 * forbidden segments are filtered out (e.g. `{ __proto__: {...} }` alone)
 * is not this case -- it still records nothing, which is correct: S1 says
 * that whole subtree should vanish, not collapse into a `{}` placeholder.
 */
export function flattenLeaves(
  value: unknown,
  prefix: readonly string[],
  out: Map<string, FlatLeaf>,
): Map<string, FlatLeaf> {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 && prefix.length > 0) {
      const path = [...prefix];
      out.set(encodePathKey(path), { path, value: EMPTY_OBJECT_LEAF });
      return out;
    }
    for (const key of keys) {
      if (!isSafeSegment(key)) {
        continue;
      }
      flattenLeaves(value[key], [...prefix, key], out);
    }
    return out;
  }
  if (prefix.length > 0) {
    const path = [...prefix];
    out.set(encodePathKey(path), { path, value });
  }
  return out;
}

/** Replaces the `EMPTY_OBJECT_LEAF` sentinel with a fresh, unshared `{}`. */
function materializeLeafValue(value: unknown): unknown {
  return value === EMPTY_OBJECT_LEAF ? {} : value;
}

/**
 * Rebuilds the merged object one leaf at a time. `value` here is always
 * already materialized (never the `EMPTY_OBJECT_LEAF` sentinel, and never
 * a reference read out of a `LoadedLayer.data`'s own object graph -- see
 * `materializeLeafValue` and the finding-5 comment above): `setPath` never
 * reuses a caller-supplied object as a container, only ever objects it
 * creates itself.
 *
 * A forbidden segment (S1) anywhere in the path silently drops that leaf
 * rather than throwing -- a hostile repo config setting
 * `hooks.__proto__.pwned` fails closed (the hook event is simply never
 * resolved) instead of denying service for every other key in the same
 * file. Intermediate containers are created with `Object.create(null)`.
 *
 * **Review round 2 finding 9, on why this guard is defense-in-depth, not
 * the sole barrier:** a security review replayed this fixture through a
 * faithful reimplementation of this function with `FORBIDDEN_SEGMENTS`
 * fully removed, and found no live bypass either way, because:
 * - `__proto__` never reaches this function at all for data that came
 *   through a real config file -- `zod`'s `z.record(...)` strips an own
 *   `__proto__` key during schema validation, before `flattenLeaves` ever
 *   runs (verified: `yaml` materializes it as an own property, but
 *   `z.record().parse(...)` silently drops it).
 * - `constructor`/`prototype` *do* survive validation as ordinary own
 *   string-valued properties, but reading/writing them against an
 *   `Object.create(null)` container (this function's intermediate nodes)
 *   is inert -- there is no prototype chain there for those names to
 *   reach into.
 * So the end-to-end path is already fail-closed for reasons independent of
 * this guard. That does not make the guard redundant: it is the one place
 * in this codebase (not a library) that would otherwise construct exactly
 * the primitive a naive `setPath` demonstrates -- `naiveSetPath({},
 * ["hooks","__proto__","pwned"], true)` (a plain-object-container version
 * with no segment check) genuinely pollutes `Object.prototype` in this
 * runtime. The guard is kept, unweakened, as deliberate defense-in-depth;
 * see the white-box test exercising it directly.
 */
export function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string;
    if (!isSafeSegment(segment)) {
      return;
    }
    const next = node[segment];
    if (!isPlainObject(next)) {
      node[segment] = Object.create(null);
    }
    node = node[segment] as Record<string, unknown>;
  }
  const last = path[path.length - 1] as string;
  if (!isSafeSegment(last)) {
    return;
  }
  if (isPlainObject(value) && isPlainObject(node[last])) {
    // A leaf whose value is itself a plain object (only ever the fresh
    // `{}` from `materializeLeafValue`) must not clobber a more-specific
    // leaf already written under the same prefix (`queues.urgent.order`)
    // -- regardless of which leaf a `Set`/`Map` iterates first.
    return;
  }
  node[last] = value;
}

// ---------------------------------------------------------------------------
// Schema introspection: walking `effectiveConfigSchema` to enumerate its
// fixed-shape leaves (R2's classification walk in keys.ts does the same
// thing for a different purpose) and to look up the leaf schema at an
// arbitrary path (for env coercion, R9).
// ---------------------------------------------------------------------------

type IntrospectableSchema = z.ZodType & { type: string; def: Record<string, unknown> };

const UNWRAPPED_TYPES = new Set([
  "optional",
  "default",
  "nullable",
  "readonly",
  "nonoptional",
  "prefault",
]);

function unwrapSchema(schema: IntrospectableSchema): IntrospectableSchema {
  if (UNWRAPPED_TYPES.has(schema.type)) {
    return unwrapSchema(schema.def.innerType as IntrospectableSchema);
  }
  return schema;
}

/**
 * Every leaf path reachable through `effectiveConfigSchema`'s *fixed*
 * shape -- object fields only. A `z.record(...)` field (`backers`,
 * `queues`, `hooks`, ...) is a dynamic map whose real keys the schema
 * cannot enumerate; those leaves are discovered from actual layer data
 * instead (`flattenLeaves` over each loaded layer), not from here.
 */
function collectFixedLeafPaths(
  schema: IntrospectableSchema,
  prefix: readonly string[],
  out: string[][],
): void {
  const s = unwrapSchema(schema);
  if (s.type === "object") {
    const shape = s.def.shape as Record<string, IntrospectableSchema>;
    for (const key of Object.keys(shape)) {
      collectFixedLeafPaths(shape[key] as IntrospectableSchema, [...prefix, key], out);
    }
    return;
  }
  if (s.type === "record") {
    return;
  }
  if (prefix.length > 0) {
    out.push([...prefix]);
  }
}

/**
 * The zod schema governing one path, navigating through both fixed object
 * fields and `z.record(...)` maps (any segment is a legal record key).
 * Returns `undefined` when the path does not exist in
 * `effectiveConfigSchema` at all (R10: `CANKAN_*` resolves only against
 * keys that exist here) or when it names a container rather than a leaf.
 * A record whose value type is opaque (`z.unknown()`/`z.any()` -- e.g.
 * `status_map`'s per-backer representation) is treated as the leaf itself,
 * with any further path segments unchecked, mirroring the schema's own
 * intentional opacity there.
 *
 * S5: this walks `effectiveConfigSchema`, which -- unlike
 * `repoConfigSchema`/`localConfigSchema` -- includes `personal`,
 * `credentials`, `identity`, and `repos`. So `CANKAN_PERSONAL__REMOTE` can
 * set what a checked-in `.cankan/config.yml` deliberately cannot
 * (`schema.ts`'s file-level comment). That asymmetry is a ruling, not a
 * bug: the per-file scoping exists to stop a *repo-controlled* file from
 * reaching those sections; a user's own environment is exactly the actor
 * that scoping was never meant to restrict.
 */
function getLeafSchema(root: z.ZodType, path: readonly string[]): z.ZodType | undefined {
  let current = unwrapSchema(root as unknown as IntrospectableSchema);
  for (const segment of path) {
    if (current.type === "object") {
      const shape = current.def.shape as Record<string, IntrospectableSchema>;
      const next = shape[segment];
      if (!next) {
        return undefined;
      }
      current = unwrapSchema(next);
    } else if (current.type === "record") {
      current = unwrapSchema(current.def.valueType as IntrospectableSchema);
      if (current.type === "unknown" || current.type === "any") {
        return current as unknown as z.ZodType;
      }
    } else {
      return undefined;
    }
  }
  if (current.type === "object" || current.type === "record") {
    return undefined;
  }
  return current as unknown as z.ZodType;
}

// ---------------------------------------------------------------------------
// Env overrides (R8-R10).
//
// AMENDMENT A1's "known limit, accepted": this mapping cannot express a
// segment that itself contains a dot, a space (`status_map` keys are
// column names like "To Do"), or mixed case -- `CANKAN_` + upper-snake with
// `__` for dots has no escape mechanism for any of those. Such keys are
// simply not settable from the environment; this is an accepted limitation
// of the env channel, not a defect, and no encoding is invented for it.
// ---------------------------------------------------------------------------

/** The inverse of R8's mapping rule -- `undefined` for anything not `CANKAN_*`. */
function envVarToPath(varName: string): string[] | undefined {
  if (!varName.startsWith("CANKAN_")) {
    return undefined;
  }
  const rest = varName.slice("CANKAN_".length);
  if (rest.length === 0) {
    return undefined;
  }
  return rest.split("__").map((segment) => segment.toLowerCase());
}

/**
 * Coerces a raw env string through the target key's own schema (R9). Tries
 * the value as JSON first (handles numbers, booleans, and arrays without
 * any bespoke per-type logic: `"3"` -> `3`, `"true"` -> `true`), then falls
 * back to the raw string (handles plain strings and enum members like
 * `"all"`, which are not valid JSON on their own).
 */
function coerceEnvValue(
  raw: string,
  schema: z.ZodType,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const asJson: unknown = JSON.parse(raw);
    const jsonResult = schema.safeParse(asJson);
    if (jsonResult.success) {
      return { ok: true, value: jsonResult.data };
    }
  } catch {
    // Not valid JSON -- fall through to the raw-string attempt below.
  }
  const rawResult = schema.safeParse(raw);
  if (rawResult.success) {
    return { ok: true, value: rawResult.data };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Precedence chains (R1). Policy has no "env" rung at all -- not "env is
// checked and ignored", but literally absent from the array walked below.
// That is what makes R7(b) (env on a policy/pinned key is silently
// ignored, never an error) fall out for free: this module never even
// attempts to read or coerce that env var for such a key.
// ---------------------------------------------------------------------------

const PREFERENCE_CHAIN: readonly ConfigLayer[] = [
  "env",
  "repo-local",
  "repo",
  "global",
  "default",
];
const POLICY_CHAIN: readonly ConfigLayer[] = ["repo", "repo-local", "global", "default"];

const FILE_LAYER_ORDER: readonly Exclude<ConfigLayer, "env" | "default">[] = [
  "repo-local",
  "repo",
  "global",
];

type FileLayer = Exclude<ConfigLayer, "env" | "default">;

/** See contract §1 (as amended by A1). */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ConfigResult> {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot;

  // Review round 2 finding 1: `resolveGlobalConfigPath` now returns
  // `undefined` when no absolute path can be formed (HOME/XDG_CONFIG_HOME
  // both absent/relative) -- treated as R12's "missing layer", not loaded.
  //
  // Review round 2 finding 12: `rejectSymlink` is `true` for the repo and
  // repo-local paths (attacker-supplyable via a committed symlink) and
  // `false` for the global path (the user's own file -- see
  // `assertNotSymlink` in layers.ts for why that asymmetry is deliberate).
  const globalPath = resolveGlobalConfigPath(env);
  // `Promise.all` rejects with whichever load settles first, which made the
  // reported error a race whenever more than one layer fails at once. A
  // symlinked `.cankan` DIRECTORY is exactly that case: the repo and
  // repo-local guards both reject, and the filename in the message flipped
  // between `config.yml` and `local.yml` run to run (~25% locally). Settle
  // all three, then rethrow in a fixed order so a board with several broken
  // layers always names the same file.
  //
  // That order is `repo`, then `repo-local`, then `global` -- deliberately
  // NOT `FILE_LAYER_ORDER` (below), which is precedence order and puts
  // `repo-local` first. Reporting order answers a different question than
  // precedence does: `.cankan/config.yml` is the checked-in file a board
  // must have to be inited, and the one a hostile-repo failure is actually
  // about, whereas `local.yml` is optional and gitignored. Naming the
  // required file first is what tells a user which one to go fix.
  const settled = await Promise.allSettled([
    globalPath
      ? loadValidatedLayer("global", globalPath, globalConfigSchema, POLICY_TAGS, false)
      : Promise.resolve(undefined),
    repoRoot
      ? loadValidatedLayer(
          "repo",
          resolveRepoConfigPath(repoRoot),
          repoConfigSchema,
          POLICY_TAGS,
          true,
        )
      : Promise.resolve(undefined),
    repoRoot
      ? loadValidatedLayer(
          "repo-local",
          resolveRepoLocalConfigPath(repoRoot),
          localConfigSchema,
          POLICY_TAGS,
          true,
        )
      : Promise.resolve(undefined),
  ]);

  const [globalSettled, repoSettled, repoLocalSettled] = settled;
  // Reporting order (see above), not array order and not FILE_LAYER_ORDER.
  for (const outcome of [repoSettled, repoLocalSettled, globalSettled]) {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
  }
  const fulfilledValue = <T,>(outcome: PromiseSettledResult<T>): T => {
    /* c8 ignore next 3 -- unreachable: every rejection was rethrown above */
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    return outcome.value;
  };
  const globalLoaded = fulfilledValue(globalSettled);
  const repoLoaded = fulfilledValue(repoSettled);
  const repoLocalLoaded = fulfilledValue(repoLocalSettled);

  // R6: !policy is honored only in .cankan/config.yml -- a load error
  // naming the file otherwise. This also settles S4's alias/nested-tag
  // concern: the AST walk finds a !policy-tagged node wherever it
  // literally appears (an anchor definition, nested arbitrarily deep),
  // regardless of whether it is later aliased elsewhere in the same file.
  // A multi-document file is already rejected before this point -- yaml
  // itself reports a MULTIPLE_DOCS parse error, caught by
  // `loadValidatedLayer`'s R16 path. `findPolicyTaggedPaths` itself throws
  // for a root-level tag (finding 7), for any of the three files.
  for (const loaded of [repoLocalLoaded, globalLoaded]) {
    if (!loaded) {
      continue;
    }
    if (findPolicyTaggedPaths(loaded.doc, loaded.layer.file).length > 0) {
      throw new CanKanError(
        ConfigErrorCodes.INVALID_CONFIG,
        `${loaded.layer.file}: "!policy" is only allowed in .cankan/config.yml`,
        { details: { file: loaded.layer.file } },
      );
    }
  }

  const pinnedRoots: string[][] = repoLoaded
    ? findPolicyTaggedPaths(repoLoaded.doc, repoLoaded.layer.file)
    : [];

  const globalLeaves = globalLoaded
    ? flattenLeaves(globalLoaded.layer.data, [], new Map())
    : new Map<string, FlatLeaf>();
  const repoLeaves = repoLoaded
    ? flattenLeaves(repoLoaded.layer.data, [], new Map())
    : new Map<string, FlatLeaf>();
  const repoLocalLeaves = repoLocalLoaded
    ? flattenLeaves(repoLocalLoaded.layer.data, [], new Map())
    : new Map<string, FlatLeaf>();

  const leavesByLayer: Record<FileLayer, Map<string, FlatLeaf>> = {
    "repo-local": repoLocalLeaves,
    repo: repoLeaves,
    global: globalLeaves,
  };
  const loadedByLayer: Record<FileLayer, ValidatedLayer | undefined> = {
    "repo-local": repoLocalLoaded,
    repo: repoLoaded,
    global: globalLoaded,
  };

  // R7: POLICY_VIOLATION is eager, at loadConfig -- checked before any
  // caller ever calls `.resolved()`. (a) A built-in policy key set by
  // repo-local/global with NO pin is not a violation (it is simply
  // overridden by precedence below); only a key the repo pinned with
  // !policy raises here.
  if (repoLoaded && pinnedRoots.length > 0) {
    const attemptLayers: readonly Exclude<FileLayer, "repo">[] = ["repo-local", "global"];
    for (const attemptedLayer of attemptLayers) {
      const loaded = loadedByLayer[attemptedLayer];
      if (!loaded) {
        continue;
      }
      const sortedLeaves = [...leavesByLayer[attemptedLayer].values()].sort((a, b) => {
        const ka = renderPath(a.path);
        const kb = renderPath(b.path);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const leaf of sortedLeaves) {
        const pin = findPinnedRoot(leaf.path, pinnedRoots);
        if (!pin) {
          continue;
        }
        const pinningFile = repoLoaded.layer.file;
        const pinningFileRelative = repoRoot ? relative(repoRoot, pinningFile) : pinningFile;
        // Final review round, finding 6: `leaf.path` is config-supplied --
        // a repo can force this throw at will by pinning a section
        // (`queues: !policy {}`) while a credential-shaped record key sits
        // underneath it in a *different* layer -- so this must get the
        // same per-segment truncation as `describeIssue`'s S2 fix, not
        // `renderPath`'s untruncated join. `pinningFile`/`loaded.layer.file`
        // are file paths, not config-supplied strings, and stay as they are.
        const key = leaf.path.map(truncateForDisplay).join(".");
        throw new CanKanError(
          ErrorCodes.POLICY_VIOLATION,
          `${key} is set as policy by ${pinningFileRelative}`,
          {
            details: {
              key,
              pinnedBy: pinningFile,
              attemptedBy: loaded.layer.file,
              attemptedLayer,
            },
          },
        );
      }
    }
  }

  // The full candidate path set: every fixed schema leaf, every dynamic
  // leaf any loaded layer actually set, and every CANKAN_* var that maps
  // to a real leaf in effectiveConfigSchema (R10) -- e.g. CANKAN_ACTOR
  // when no file sets `actor` at all.
  const fixedLeaves: string[][] = [];
  collectFixedLeafPaths(effectiveConfigSchema as unknown as IntrospectableSchema, [], fixedLeaves);

  const envPathByVar = new Map<string, string>(); // encodePathKey(path) -> CANKAN_* var name
  const envPaths: string[][] = [];
  for (const [varName, raw] of Object.entries(env)) {
    if (raw === undefined || !varName.startsWith("CANKAN_")) {
      continue;
    }
    const path = envVarToPath(varName);
    if (!path?.every(isSafeSegment)) {
      continue;
    }
    if (getLeafSchema(effectiveConfigSchema, path) === undefined) {
      continue; // R10: only keys that exist in effectiveConfigSchema
    }
    envPathByVar.set(encodePathKey(path), varName);
    envPaths.push(path);
  }

  const allPathsByKey = new Map<string, string[]>();
  for (const path of [
    ...fixedLeaves,
    ...[...globalLeaves.values()].map((l) => l.path),
    ...[...repoLeaves.values()].map((l) => l.path),
    ...[...repoLocalLeaves.values()].map((l) => l.path),
    ...envPaths,
  ]) {
    allPathsByKey.set(encodePathKey(path), path);
  }

  // Review round 2 finding 6: drop any candidate path that is a strict
  // prefix of another candidate path (see `dropStrictPrefixes`'s comment).
  const candidatePaths = dropStrictPrefixes([...allPathsByKey.values()]);

  const defaultsFlat = flattenLeaves(effectiveConfigSchema.parse({}), [], new Map());

  const resolvedByPath = new Map<string, ResolvedEntry>();
  const merged: Record<string, unknown> = {};

  for (const path of candidatePaths) {
    const classification = classifyKey(path);
    const pin = findPinnedRoot(path, pinnedRoots);
    const chain = classification === "policy" || pin ? POLICY_CHAIN : PREFERENCE_CHAIN;
    const pathKey = encodePathKey(path);

    let winner:
      | { layer: ConfigLayer; value: unknown; file?: string; envVar?: string }
      | undefined;

    for (const rung of chain) {
      if (rung === "env") {
        const varName = envPathByVar.get(pathKey);
        if (varName === undefined) {
          continue;
        }
        const raw = env[varName];
        if (raw === undefined) {
          continue;
        }
        const leafSchema = getLeafSchema(effectiveConfigSchema, path);
        if (!leafSchema) {
          continue;
        }
        const coerced = coerceEnvValue(raw, leafSchema);
        if (!coerced.ok) {
          throw new CanKanError(
            ConfigErrorCodes.INVALID_CONFIG,
            `${varName} does not satisfy ${renderPath(path)}'s schema`,
            { details: { envVar: varName, key: renderPath(path) } },
          );
        }
        winner = { layer: "env", value: coerced.value, envVar: varName };
        break;
      }
      if (rung === "default") {
        const leaf = defaultsFlat.get(pathKey);
        if (leaf) {
          winner = { layer: "default", value: materializeLeafValue(leaf.value) };
        }
        break;
      }
      const leaves = leavesByLayer[rung];
      const loaded = loadedByLayer[rung];
      const leaf = leaves.get(pathKey);
      if (loaded && leaf) {
        winner = { layer: rung, value: materializeLeafValue(leaf.value), file: loaded.layer.file };
        break;
      }
    }

    if (!winner) {
      continue;
    }

    const key = renderPath(path);
    const entry: ResolvedEntry = {
      path,
      key,
      value: winner.value,
      layer: winner.layer,
      ...(winner.file !== undefined ? { file: winner.file } : {}),
      ...(winner.envVar !== undefined ? { envVar: winner.envVar } : {}),
      ...(pin && repoLoaded ? { pinnedBy: repoLoaded.layer.file } : {}),
    };
    resolvedByPath.set(pathKey, entry);
    setPath(merged, path, winner.value);
  }

  // Review round 2 finding 4: this used to be a bare `.parse(...)`, so a
  // schema mismatch here (which AMENDMENT A1's path-array fix should make
  // effectively unreachable in practice, since the lossy dotted round-trip
  // that could cause one is gone) would throw a raw `ZodError` out of
  // `loadConfig` -- `isCanKanError` false, `code` undefined, invisible to
  // M3.10's exit-code map. Wrapped defensively regardless.
  const parsedValue = effectiveConfigSchema.safeParse(merged);
  if (!parsedValue.success) {
    throw buildConfigValidationError("merged effective config", parsedValue.error);
  }
  const value = parsedValue.data;

  const layers: LoadedLayer[] = FILE_LAYER_ORDER.map((name) => loadedByLayer[name]?.layer).filter(
    (l): l is LoadedLayer => l !== undefined,
  );

  const sortedEntries = Object.freeze(
    [...resolvedByPath.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );

  // AMENDMENT A1 rule 3: the string form of `resolved()` matches exactly
  // against the rendered `key`, and on a collision returns whichever entry
  // appears first in `entries()` order.
  const resolvedByRenderedKey = new Map<string, ResolvedEntry>();
  for (const entry of sortedEntries) {
    if (!resolvedByRenderedKey.has(entry.key)) {
      resolvedByRenderedKey.set(entry.key, entry);
    }
  }

  function resolved(key: string | readonly string[]): ResolvedEntry | undefined {
    if (Array.isArray(key)) {
      return resolvedByPath.get(encodePathKey(key));
    }
    return resolvedByRenderedKey.get(key as string);
  }

  return {
    value,
    layers: Object.freeze(layers),
    resolved,
    entries: () => sortedEntries,
  };
}
