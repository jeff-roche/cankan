/**
 * The precedence engine (contract §1's `loadConfig`, `ConfigResult`,
 * `ResolvedEntry`, `LoadConfigOptions`) -- per-key precedence (R1), per-leaf
 * map resolution (R3), the `!policy` tag (R6), eager `POLICY_VIOLATION`
 * (R7), and `CANKAN_*` env overrides (R8-R10).
 *
 * The core move: every value anywhere in a layer's data -- not just
 * map-valued fields -- is flattened to a dotted leaf path and resolved
 * independently (`resolved(key)` works for `claims.lease` exactly as it
 * does for `backers.github.credential`). Array values (`columns`,
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
  type ConfigLayer,
  type LoadedLayer,
  type ValidatedLayer,
  loadValidatedLayer,
  resolveGlobalConfigPath,
  resolveRepoConfigPath,
  resolveRepoLocalConfigPath,
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
// Contract §1 -- attribution and the result.
// ---------------------------------------------------------------------------

/** Where one effective key's value came from. */
export interface ResolvedEntry {
  /** Dotted path, e.g. "claims.lease", "backers.github.credential". */
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
  /** Attribution for one dotted key. Returns undefined if the key has no
   *  effective value (not set anywhere and no built-in default). */
  resolved(key: string): ResolvedEntry | undefined;
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
// The `!policy` tag (R6, S3, S4).
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
 * Every dotted path in `doc` whose node is tagged `!policy`, i.e. every
 * pinned "root" (R6: "applies to the tagged node and every leaf beneath
 * it" -- callers check pin status with a prefix match against these roots,
 * not equality). `visit.SKIP`s into an already-pinned subtree: a nested
 * `!policy` there would only ever be redundant, and skipping keeps the
 * result to one entry per genuinely distinct pin.
 *
 * An aliased (`*ref`) occurrence of a pinned anchor does **not** itself
 * carry `.tag` (only the `&anchor !policy ...` definition site does), so it
 * is never recorded as a separate pinned root here. That is a strictly
 * *weaker* pin, not a bypass: S4's actual concern (can `!policy` be
 * smuggled *into* local/global via an alias?) is settled below, where the
 * rejection walk finds the tag at its one real definition site regardless
 * of how many places later alias it.
 */
function findPolicyTaggedPaths(doc: Document): string[] {
  const paths: string[] = [];
  visit(doc, (_key, node, path) => {
    if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag === POLICY_TAG) {
      const segments: string[] = [];
      for (const entry of path) {
        if (isPair(entry) && isScalar(entry.key)) {
          segments.push(String(entry.key.value));
        }
      }
      paths.push(segments.join("."));
      return visit.SKIP;
    }
    return undefined;
  });
  return paths;
}

/**
 * The pinned root (if any) covering `key` -- exact match or a dotted-path
 * ancestor, per R6's "every leaf beneath it".
 */
function findPinnedRoot(key: string, pinnedRoots: readonly string[]): string | undefined {
  return pinnedRoots.find((root) => key === root || key.startsWith(`${root}.`));
}

// ---------------------------------------------------------------------------
// S1 -- the prototype-pollution guard. The dotted-path flatten/rebuild is a
// `setPath` whose keys come straight from config files; a naive rebuild of
// `hooks.__proto__.pwned` pollutes `Object.prototype` in this exact
// runtime. `__proto__` itself never survives `yaml` -> `zod` (`zod`'s
// `z.record()` silently drops it), but `constructor` and `prototype` do, as
// ordinary own string-valued properties -- so all three segments are
// rejected here, uniformly, wherever a dotted path is walked or rebuilt:
// flattening layer data into leaves, rebuilding the merged object, and
// turning an env var name back into a dotted path.
// ---------------------------------------------------------------------------

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeSegment(segment: string): boolean {
  return !FORBIDDEN_SEGMENTS.has(segment);
}

/**
 * S6: not `value.constructor === Object` -- `constructor` can be a spoofed
 * *own* string property surviving `yaml` -> `zod` (see above), so that
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
 * Flattens a parsed layer's data (or the effective defaults) into dotted
 * leaf paths. Arrays and every other non-plain-object value are leaves
 * (see the file-level comment on array handling); a forbidden segment (S1)
 * drops that whole subtree from the result rather than merely the final
 * leaf, since a hostile `hooks.__proto__.pwned` must never reach the merge
 * step at any depth.
 *
 * A genuinely empty object (`queues: { urgent: {} }` -- a legal, empty
 * `queueEntrySchema`) is itself a leaf: with no keys to recurse into, the
 * naive version of this function recorded nothing at all for `queues.urgent`,
 * silently dropping a present-but-empty map entry from the merged result.
 * An object left empty only *after* forbidden segments are filtered out
 * (e.g. `{ __proto__: {...} }` alone) is not this case -- it still records
 * nothing, which is correct: S1 says that whole subtree should vanish, not
 * collapse into a `{}` placeholder.
 */
function flattenLeaves(
  value: unknown,
  prefix: readonly string[],
  out: Map<string, unknown>,
): Map<string, unknown> {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0 && prefix.length > 0) {
      out.set(prefix.join("."), value);
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
    out.set(prefix.join("."), value);
  }
  return out;
}

/**
 * Rebuilds the merged object one leaf at a time. A forbidden segment (S1)
 * anywhere in the path silently drops that leaf rather than throwing -- a
 * hostile repo config setting `hooks.__proto__.pwned` fails closed (the
 * hook event is simply never resolved) instead of denying service for
 * every other key in the same file. Intermediate containers are created
 * with `Object.create(null)` as defense in depth on top of the segment
 * check itself.
 *
 * `allKeys` is a `Set`, so a genuinely-empty-object leaf (`queues.urgent`
 * -- see `flattenLeaves`) and a more specific leaf nested under the same
 * prefix (`queues.urgent.order`, from a different layer) can be visited in
 * either order. If the empty-object leaf's `{}` were assigned
 * unconditionally, whichever of the two happened to run *last* would
 * clobber the other's work. Guarding "don't overwrite an already-plain-
 * object destination with another plain object" makes the result the same
 * regardless of iteration order: the intermediate-container branch above
 * already reuses (rather than replaces) an existing plain object, so
 * whichever leaf lands first establishes the container and the other
 * merges into or no-ops against it.
 */
function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
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
    return;
  }
  node[last] = value;
}

// ---------------------------------------------------------------------------
// Schema introspection: walking `effectiveConfigSchema` to enumerate its
// fixed-shape leaves (R2's classification walk in keys.ts does the same
// thing for a different purpose) and to look up the leaf schema at an
// arbitrary dotted path (for env coercion, R9).
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
 * Every leaf dotted path reachable through `effectiveConfigSchema`'s
 * *fixed* shape -- object fields only. A `z.record(...)` field (`backers`,
 * `queues`, `hooks`, ...) is a dynamic map whose real keys the schema
 * cannot enumerate; those leaves are discovered from actual layer data
 * instead (`flattenLeaves` over each loaded layer), not from here.
 */
function collectFixedLeafPaths(
  schema: IntrospectableSchema,
  prefix: readonly string[],
  out: string[],
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
    out.push(prefix.join("."));
  }
}

/**
 * The zod schema governing one dotted path, navigating through both fixed
 * object fields and `z.record(...)` maps (any segment is a legal record
 * key). Returns `undefined` when the path does not exist in
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
// ---------------------------------------------------------------------------

/** The inverse of R8's mapping rule -- `undefined` for anything not `CANKAN_*`. */
function envVarToKey(varName: string): string | undefined {
  if (!varName.startsWith("CANKAN_")) {
    return undefined;
  }
  const rest = varName.slice("CANKAN_".length);
  if (rest.length === 0) {
    return undefined;
  }
  return rest
    .split("__")
    .map((segment) => segment.toLowerCase())
    .join(".");
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

/** See contract §1. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ConfigResult> {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot;

  const globalPath = resolveGlobalConfigPath(env);
  const [globalLoaded, repoLoaded, repoLocalLoaded] = await Promise.all([
    loadValidatedLayer("global", globalPath, globalConfigSchema, POLICY_TAGS),
    repoRoot
      ? loadValidatedLayer("repo", resolveRepoConfigPath(repoRoot), repoConfigSchema, POLICY_TAGS)
      : Promise.resolve(undefined),
    repoRoot
      ? loadValidatedLayer(
          "repo-local",
          resolveRepoLocalConfigPath(repoRoot),
          localConfigSchema,
          POLICY_TAGS,
        )
      : Promise.resolve(undefined),
  ]);

  // R6: !policy is honored only in .cankan/config.yml -- a load error
  // naming the file otherwise. This also settles S4's alias/nested-tag
  // concern: the AST walk finds a !policy-tagged node wherever it
  // literally appears (an anchor definition, nested arbitrarily deep),
  // regardless of whether it is later aliased elsewhere in the same file.
  // A multi-document file is already rejected before this point -- yaml
  // itself reports a MULTIPLE_DOCS parse error, caught by
  // `loadValidatedLayer`'s R16 path.
  for (const loaded of [repoLocalLoaded, globalLoaded]) {
    if (!loaded) {
      continue;
    }
    if (findPolicyTaggedPaths(loaded.doc).length > 0) {
      throw new CanKanError(
        ConfigErrorCodes.INVALID_CONFIG,
        `${loaded.layer.file}: "!policy" is only allowed in .cankan/config.yml`,
        { details: { file: loaded.layer.file } },
      );
    }
  }

  const pinnedRoots = repoLoaded ? findPolicyTaggedPaths(repoLoaded.doc) : [];

  const globalLeaves = globalLoaded
    ? flattenLeaves(globalLoaded.layer.data, [], new Map())
    : new Map<string, unknown>();
  const repoLeaves = repoLoaded
    ? flattenLeaves(repoLoaded.layer.data, [], new Map())
    : new Map<string, unknown>();
  const repoLocalLeaves = repoLocalLoaded
    ? flattenLeaves(repoLocalLoaded.layer.data, [], new Map())
    : new Map<string, unknown>();

  const leavesByLayer: Record<FileLayer, Map<string, unknown>> = {
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
      for (const key of [...leavesByLayer[attemptedLayer].keys()].sort()) {
        const pin = findPinnedRoot(key, pinnedRoots);
        if (!pin) {
          continue;
        }
        const pinningFile = repoLoaded.layer.file;
        const pinningFileRelative = repoRoot ? relative(repoRoot, pinningFile) : pinningFile;
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

  // The full candidate key set: every fixed schema leaf, every dynamic leaf
  // any loaded layer actually set, and every CANKAN_* var that maps to a
  // real leaf in effectiveConfigSchema (R10) -- e.g. CANKAN_ACTOR when no
  // file sets `actor` at all.
  const fixedLeaves: string[] = [];
  collectFixedLeafPaths(effectiveConfigSchema as unknown as IntrospectableSchema, [], fixedLeaves);

  const envKeyToVar = new Map<string, string>();
  for (const [varName, raw] of Object.entries(env)) {
    if (raw === undefined || !varName.startsWith("CANKAN_")) {
      continue;
    }
    const key = envVarToKey(varName);
    if (!key?.split(".").every(isSafeSegment)) {
      continue;
    }
    if (getLeafSchema(effectiveConfigSchema, key.split(".")) === undefined) {
      continue; // R10: only keys that exist in effectiveConfigSchema
    }
    envKeyToVar.set(key, varName);
  }

  const allKeys = new Set<string>([
    ...fixedLeaves,
    ...globalLeaves.keys(),
    ...repoLeaves.keys(),
    ...repoLocalLeaves.keys(),
    ...envKeyToVar.keys(),
  ]);

  const defaultsFlat = flattenLeaves(effectiveConfigSchema.parse({}), [], new Map());

  const resolvedMap = new Map<string, ResolvedEntry>();
  const merged: Record<string, unknown> = {};

  for (const key of allKeys) {
    const classification = classifyKey(key);
    const pin = findPinnedRoot(key, pinnedRoots);
    const chain = classification === "policy" || pin ? POLICY_CHAIN : PREFERENCE_CHAIN;

    let winner:
      | { layer: ConfigLayer; value: unknown; file?: string; envVar?: string }
      | undefined;

    for (const rung of chain) {
      if (rung === "env") {
        const varName = envKeyToVar.get(key);
        if (varName === undefined) {
          continue;
        }
        const raw = env[varName];
        if (raw === undefined) {
          continue;
        }
        const leafSchema = getLeafSchema(effectiveConfigSchema, key.split("."));
        if (!leafSchema) {
          continue;
        }
        const coerced = coerceEnvValue(raw, leafSchema);
        if (!coerced.ok) {
          throw new CanKanError(
            ConfigErrorCodes.INVALID_CONFIG,
            `${varName} does not satisfy ${key}'s schema`,
            { details: { envVar: varName, key } },
          );
        }
        winner = { layer: "env", value: coerced.value, envVar: varName };
        break;
      }
      if (rung === "default") {
        if (defaultsFlat.has(key)) {
          winner = { layer: "default", value: defaultsFlat.get(key) };
        }
        break;
      }
      const leaves = leavesByLayer[rung];
      const loaded = loadedByLayer[rung];
      if (loaded && leaves.has(key)) {
        winner = { layer: rung, value: leaves.get(key), file: loaded.layer.file };
        break;
      }
    }

    if (!winner) {
      continue;
    }

    const entry: ResolvedEntry = {
      key,
      value: winner.value,
      layer: winner.layer,
      ...(winner.file !== undefined ? { file: winner.file } : {}),
      ...(winner.envVar !== undefined ? { envVar: winner.envVar } : {}),
      ...(pin && repoLoaded ? { pinnedBy: repoLoaded.layer.file } : {}),
    };
    resolvedMap.set(key, entry);
    setPath(merged, key.split("."), winner.value);
  }

  const value = effectiveConfigSchema.parse(merged);

  const layers: LoadedLayer[] = FILE_LAYER_ORDER.map((name) => loadedByLayer[name]?.layer).filter(
    (l): l is LoadedLayer => l !== undefined,
  );

  const sortedEntries = [...resolvedMap.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  return {
    value,
    layers: Object.freeze(layers),
    resolved: (key: string) => resolvedMap.get(key),
    entries: () => sortedEntries,
  };
}
