import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { effectiveConfigSchema } from "../../src/config/schema";
import { classifyKey, KEY_CLASSIFICATION, UNCLASSIFIED_KEYS } from "../../src/config/keys";

describe("classifyKey — every row of CONCEPT.md 415-426, by example key", () => {
  test.each([
    ["columns", "policy"],
    ["id_prefix", "policy"],
    ["tickets_dir", "policy"],
    ["actor", "preference"],
    ["parent", "preference"],
    ["editor", "preference"],
    ["coordination.ref", "policy"],
    ["coordination.mode", "policy"],
    ["output.color", "preference"],
    ["output.json_pretty", "preference"],
    ["claims.max_per_actor", "policy"],
    ["claims.require_ready", "policy"],
    ["claims.lease", "preference"],
    ["queues.backend-urgent", "policy"],
    ["ready.exclude_labels", "policy"],
    ["ready.order", "preference"],
    ["backers.github.status_map", "policy"],
    ["backers.github.repo", "policy"],
    ["backers.jira.site", "policy"],
    ["backers.github.project", "policy"],
    ["backers.github.credential", "preference"],
    ["sync.conflict_policy", "policy"],
    ["sync.auto_pull", "preference"],
    ["definition_of_done", "policy"],
    ["default_backer", "preference"],
    ["sync.auto_push", "preference"],
  ] as const)("%s -> %s", (key, expected) => {
    expect(classifyKey(key)).toBe(expected);
  });

  // Contract R3 / R5: hooks is one policy row (not "repo policy, local
  // preference" split by file) because classification is per key.
  test("hooks.<event> is policy regardless of which file would set it (contract R5)", () => {
    expect(classifyKey("hooks.on_close")).toBe("policy");
    expect(classifyKey("hooks.on_claim")).toBe("policy");
  });

  // Contract R3: the same map splits across both columns, resolved leaf by
  // leaf — status_map and credential live on the same `backers.github.*`
  // map but classify oppositely.
  test("the same backers map splits per leaf (contract R3)", () => {
    expect(classifyKey("backers.github.status_map")).toBe("policy");
    expect(classifyKey("backers.github.credential")).toBe("preference");
  });

  test("a nested leaf beneath a wildcard-matched subtree inherits that subtree's class", () => {
    // backers.*.status_map matches as a prefix, so everything the backer's
    // own status representation nests beneath it is still policy.
    expect(classifyKey("backers.github.status_map.To Do.state")).toBe("policy");
  });

  test("an unmatched key defaults to preference (contract R2)", () => {
    expect(classifyKey("version")).toBe("preference");
    expect(classifyKey("some.made.up.key")).toBe("preference");
  });
});

/**
 * Whether some `KEY_CLASSIFICATION` pattern matches `key`, mirroring
 * `keys.ts`'s own `matchesPattern` (not exported — it's an implementation
 * detail of `classifyKey`). Kept as one small local helper rather than
 * inlined twice below, so a drift in the prefix/wildcard rule only needs
 * fixing in one place in this file. This intentionally does not route
 * through `classifyKey` itself: `classifyKey` collapses "matched by a
 * preference pattern" and "matched by nothing" to the same `"preference"`
 * result (contract R2's default), which is exactly the distinction these
 * tests need to keep separate.
 */
function isMatchedByAnyPattern(key: string): boolean {
  const keySegments = key.split(".");
  return KEY_CLASSIFICATION.some((entry) => {
    const patternSegments = entry.pattern.split(".");
    if (patternSegments.length > keySegments.length) return false;
    return patternSegments.every((segment, i) => segment === "*" || segment === keySegments[i]);
  });
}

describe("UNCLASSIFIED_KEYS", () => {
  test("every listed key is genuinely unmatched by KEY_CLASSIFICATION", () => {
    for (const key of UNCLASSIFIED_KEYS) {
      expect(isMatchedByAnyPattern(key), `${key} should be unmatched`).toBe(false);
    }
  });

  test("classifyKey resolves every listed key to preference, per contract R2", () => {
    for (const key of UNCLASSIFIED_KEYS) {
      expect(classifyKey(key), key).toBe("preference");
    }
  });
});

// ---------------------------------------------------------------------------
// The gap test (contract R2): every leaf key path reachable in
// effectiveConfigSchema is either matched by a KEY_CLASSIFICATION pattern or
// listed in UNCLASSIFIED_KEYS. This is what keeps the gap list honest as the
// schema evolves, rather than a comment that rots.
// ---------------------------------------------------------------------------

type IntrospectableSchema = z.ZodType & {
  type: string;
  def: Record<string, unknown>;
};

/** Unwraps optional/default/nullable/readonly wrappers to the inner schema. */
function unwrap(schema: IntrospectableSchema): IntrospectableSchema {
  if (
    schema.type === "optional" ||
    schema.type === "default" ||
    schema.type === "nullable" ||
    schema.type === "readonly" ||
    schema.type === "nonoptional" ||
    schema.type === "prefault"
  ) {
    return unwrap(schema.def.innerType as IntrospectableSchema);
  }
  return schema;
}

/**
 * Walks a zod object/record tree and collects every leaf's dotted path,
 * writing a dynamic map key (a record's key) as `*` — mirroring
 * `KEY_CLASSIFICATION`'s own pattern syntax, since a schema alone cannot
 * enumerate a record's actual runtime keys. Recursion stops at a record
 * whose value type is `unknown`/`any` (an intentionally opaque shape, e.g.
 * `status_map`'s per-backer representation) — there is nothing further the
 * schema can tell us about what's beneath it.
 */
function collectLeafPaths(schema: IntrospectableSchema, prefix: string[], out: string[]): void {
  const s = unwrap(schema);
  if (s.type === "object") {
    const shape = s.def.shape as Record<string, IntrospectableSchema>;
    for (const key of Object.keys(shape)) {
      collectLeafPaths(shape[key] as IntrospectableSchema, [...prefix, key], out);
    }
    return;
  }
  if (s.type === "record") {
    const valueType = unwrap(s.def.valueType as IntrospectableSchema);
    if (valueType.type === "unknown" || valueType.type === "any") {
      out.push([...prefix, "*"].join("."));
      return;
    }
    collectLeafPaths(s.def.valueType as IntrospectableSchema, [...prefix, "*"], out);
    return;
  }
  out.push(prefix.join("."));
}

describe("the gap test (contract R2)", () => {
  test("every leaf key path reachable in effectiveConfigSchema is classified or listed as a gap", () => {
    const leaves: string[] = [];
    collectLeafPaths(effectiveConfigSchema as unknown as IntrospectableSchema, [], leaves);

    expect(leaves.length).toBeGreaterThan(0);

    const unclassifiedSet = new Set(UNCLASSIFIED_KEYS);
    const unaccountedFor = leaves.filter(
      (key) => !isMatchedByAnyPattern(key) && !unclassifiedSet.has(key),
    );

    expect(unaccountedFor).toEqual([]);
  });

  test("UNCLASSIFIED_KEYS contains no stale entry — every listed key is a real reachable leaf", () => {
    const collected: string[] = [];
    collectLeafPaths(effectiveConfigSchema as unknown as IntrospectableSchema, [], collected);
    const leaves = new Set(collected);

    for (const key of UNCLASSIFIED_KEYS) {
      expect(leaves.has(key), `${key} should be a real reachable leaf`).toBe(true);
    }
  });
});
