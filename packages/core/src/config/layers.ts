/**
 * Locating and reading the three *file* layers of CONCEPT.md "Layers and
 * precedence" (245-260) — global, repo, repo-local — resolving XDG paths per
 * "Data directories (XDG)" (262-270). `env` and `default` are not files and
 * have no path or parse step; `resolve.ts` handles them directly.
 *
 * This file is deliberately ignorant of `!policy` semantics. It hands back
 * the parsed `yaml` `Document` (not just the validated JS value) so
 * `resolve.ts` can walk the AST for `!policy`-tagged nodes itself — the
 * `customTags` a caller wants registered are a parameter here, not a
 * decision this file makes.
 */

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { type Document, type Tags, parseDocument } from "yaml";
import type { z } from "zod";
import { CanKanError } from "../errors";
import { ConfigErrorCodes } from "./errors";

// ---------------------------------------------------------------------------
// Contract §1 — layer identity. `resolve.ts` imports these; `index.ts`
// re-exports them.
// ---------------------------------------------------------------------------

/** The five layers of CONCEPT.md "Layers and precedence", highest first. */
export type ConfigLayer = "env" | "repo-local" | "repo" | "global" | "default";

/** One config file that was found and parsed. Missing layers are absent. */
export interface LoadedLayer {
  layer: Exclude<ConfigLayer, "env" | "default">;
  /** Absolute path of the file this layer was read from. */
  file: string;
  /** The parsed, schema-validated contents of that one file. */
  data: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Path resolution (R11). Always reads from the injected `env`, never from
// `process.env` directly — that is what lets the XDG-fallback branch be
// tested without touching the developer's real environment (R11's
// testability note; see the tests for why `process.env.X = undefined` can't
// be used to exercise this).
// ---------------------------------------------------------------------------

/**
 * `$XDG_CONFIG_HOME/cankan/config.yml`, defaulting to
 * `$HOME/.config/cankan/config.yml` when `XDG_CONFIG_HOME` is unset, empty,
 * or itself relative (R11).
 *
 * Returns `undefined` when no *absolute* path can be formed at all — e.g.
 * `HOME` and `XDG_CONFIG_HOME` both absent or empty, which previously
 * produced the cwd-relative path `.config/cankan/config.yml` via
 * `join("", ".config")`. Reproduced by security review: in an environment
 * with no `HOME` (`env -i`, a distroless/scratch container, a systemd unit
 * with no `User=`, or an agent harness spawning this CLI with a scrubbed
 * environment), a repo-committed `.config/cankan/config.yml` loaded as the
 * `"global"` layer and contributed `identity`, `credentials`, `personal`
 * fields — precisely what Task A's `schema.ts` fences repo-controlled
 * config out of. The XDG spec itself says a relative `XDG_CONFIG_HOME`
 * must be ignored, which is why that case falls through to the `$HOME`
 * branch rather than being used directly. `undefined` here means "treat
 * the global layer as missing" (R12) — this is not an error condition, an
 * absent/unusable environment for locating a global config file is normal.
 */
export function resolveGlobalConfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome !== undefined && xdgConfigHome.length > 0 && isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : join(env.HOME ?? "", ".config");
  const path = join(configHome, "cankan", "config.yml");
  return isAbsolute(path) ? path : undefined;
}

/**
 * `<repoRoot>/.cankan/config.yml`. `repoRoot` is resolved defensively
 * (`path.resolve`) so `LoadedLayer.file` is always absolute even if a
 * caller passed a relative `repoRoot` — contract §1 documents `repoRoot`
 * as already absolute, but this costs nothing and closes the same
 * relative-path class of defect as the global-path fix above.
 */
export function resolveRepoConfigPath(repoRoot: string): string {
  return join(resolvePath(repoRoot), ".cankan", "config.yml");
}

/** `<repoRoot>/.cankan/local.yml`. See `resolveRepoConfigPath` on `repoRoot`. */
export function resolveRepoLocalConfigPath(repoRoot: string): string {
  return join(resolvePath(repoRoot), ".cankan", "local.yml");
}

// ---------------------------------------------------------------------------
// YAML parsing (R16 — the credential-leak mitigation) and per-layer schema
// validation (R12, R13, S2).
// ---------------------------------------------------------------------------

/** A file that was read and parsed as YAML, but not yet schema-validated. */
export interface ParsedYamlFile {
  doc: Document.Parsed;
  absPath: string;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Review round 2 finding 12: with no containment check before `readFile`
 * (which follows symlinks), a committed symlink at `.cankan/config.yml` or
 * `.cankan/local.yml` — both repo-controlled, attacker-supplyable paths —
 * turns `loadConfig` into a read oracle for any file the invoking user can
 * read. Reproduced against a `~/.config/gh/hosts.yml`-shaped target: the
 * resulting error surfaced that file's top-level YAML key names (after
 * fix round 1's truncation, bounded to a 20-char prefix each) plus a
 * file-existence/parseability oracle. R13's constructed messages and R16
 * both still hold — no *value* leaks, only key names and existence — which
 * is why this is Minor rather than Important.
 *
 * `lstat`s the target and rejects with a `CanKanError` if it is a symlink,
 * **without ever calling a realpath function** (checked deliberately: on
 * macOS `$TMPDIR` sits under `/var/folders/...`, and `/var` itself is a
 * symlink to `/private/var`, so a resolved path and a constructed one can
 * differ by a `/private` prefix — the exact hazard that broke M2.6's CI.
 * `lstat` inspects the link itself and returns no path, so it carries none
 * of that risk).
 *
 * Deliberately asymmetric: only `resolveRepoConfigPath`/
 * `resolveRepoLocalConfigPath` results are checked (`resolve.ts` passes
 * `rejectSymlink: true` for those two, `false` for the global path). The
 * global config (`~/.config/cankan/config.yml`) is the user's *own* file —
 * symlinking personal dotfiles into a dotfiles repo is an entirely normal
 * workflow, and rejecting it would break that to close nothing, since the
 * user already fully controls what that path points at.
 */
async function assertNotSymlink(absPath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(absPath);
  } catch {
    // ENOENT (or any other lstat failure) is not this check's concern --
    // `readFile` below will hit the same condition and report it uniformly
    // (R12 missing-layer, or its own read-failure message).
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new CanKanError(
      ConfigErrorCodes.INVALID_CONFIG,
      `${absPath}: refusing to read a symlinked repo config file`,
      { details: { file: absPath } },
    );
  }
}

/**
 * Reads and parses one YAML file. Returns `undefined` when the file does
 * not exist (R12 — a missing layer is normal, not an error). Throws on any
 * other read failure, and on a YAML syntax error.
 *
 * `rejectSymlink`: see `assertNotSymlink` above (review round 2 finding
 * 12). Repo/repo-local callers pass `true`; the global-layer caller passes
 * `false`.
 *
 * R16: `yaml@2.9.0`'s `YAMLParseError.message` quotes the offending source
 * line verbatim — a syntax error near `personal.remote` would otherwise put
 * a credential-bearing git URL straight into a message that gets logged.
 * The message here is **always our own construction** from
 * `doc.errors[0].linePos`; the original `YAMLParseError` goes into `cause`
 * only, never into `message` or `details`. No `version` option is passed
 * (S3) — `yaml`'s default is already YAML 1.2, under which `off`/`on` stay
 * plain strings rather than booleanizing, exactly what `sync.auto_push`
 * needs. `customTags` changes which tags resolve, not the schema version.
 */
export async function readYamlFile(
  absPath: string,
  customTags: Tags,
  rejectSymlink: boolean,
): Promise<ParsedYamlFile | undefined> {
  if (rejectSymlink) {
    await assertNotSymlink(absPath);
  }

  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return undefined;
    }
    throw new CanKanError(ConfigErrorCodes.INVALID_CONFIG, `${absPath}: could not be read`, {
      cause: err,
      details: { file: absPath },
    });
  }

  const doc = parseDocument(text, { customTags });
  if (doc.errors.length > 0) {
    const cause = doc.errors[0];
    const pos = cause?.linePos?.[0];
    const location = pos ? `${pos.line}:${pos.col}` : "?:?";
    throw new CanKanError(
      ConfigErrorCodes.INVALID_CONFIG,
      `${absPath}:${location}: YAML syntax error`,
      { cause, details: { file: absPath } },
    );
  }

  return { doc, absPath };
}

// S2 review round 2 lowered this from the original "~40" ruling: 40 is
// exactly a GitHub classic PAT's length (`ghp_` + 36 chars), so the
// original cap let a full token through untruncated whenever it happened to
// be exactly that long. 20 characters is still enough to satisfy R13's
// "names the offending key" (a human can recognize which key broke) while
// meaningfully shortening any realistic credential shape.
const MAX_ISSUE_KEY_DISPLAY_LEN = 20;

function truncateForDisplay(value: string): string {
  return value.length > MAX_ISSUE_KEY_DISPLAY_LEN
    ? `${value.slice(0, MAX_ISSUE_KEY_DISPLAY_LEN)}…`
    : value;
}

/**
 * Describes one zod issue for R13's "names the offending key" — built from
 * `issue.path` (and, for `unrecognized_keys`, `issue.keys`), never from
 * `issue.message`.
 *
 * S2: for every issue kind *except* `unrecognized_keys`, zod's own
 * `issue.message` never echoes an input value (verified: public issue
 * objects carry only `{expected, code, path, message}`, no `input`) — but
 * R13 says build our own text regardless, so this does, uniformly.
 * `unrecognized_keys` is the one echo site named in the original security
 * review: the offending key is not in `issue.path` at all, it is in
 * `issue.keys`, and zod's own `issue.message` interpolates it verbatim.
 *
 * **A second echo site, found in review round 2: `issue.path` itself.** For
 * any issue *inside* a `z.record(...)` section (`queues`, `backers`,
 * `hooks`, `status_map`, `priority_map`, `repos.names`, ...), the path
 * segments are literally the config-supplied record keys — e.g. a global
 * config with a `queues` entry keyed by a credential-shaped string and an
 * invalid value put that full string into `issue.path`, and from there into
 * this function's *un*truncated `${pathStr}` before this fix, reaching
 * `err.message` and therefore `JSON.stringify(err)` via `CanKanError.toJSON`.
 * The first version of this function truncated `issue.keys` but not
 * `issue.path`, missing this second, symmetric echo site entirely. Every
 * path segment is now truncated individually, the same way `issue.keys`
 * always was.
 *
 * A YAML indentation mistake can turn a *value* into a *key* in either
 * location, so both are truncated to `MAX_ISSUE_KEY_DISPLAY_LEN` characters
 * before ever reaching a message or `details`. This bounds, but does not
 * eliminate, the exposure — a 20-character prefix of a secret is still a
 * fragment of it, tracked here as accepted residual exposure rather than a
 * full fix.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const pathStr =
    issue.path.length > 0
      ? issue.path.map((segment) => truncateForDisplay(String(segment))).join(".")
      : "(root)";
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map(truncateForDisplay).join(", ");
    return `unrecognized key(s) [${keys}] at "${pathStr}"`;
  }
  return `invalid value at "${pathStr}" (${issue.code})`;
}

/**
 * Builds an R13/S2-compliant `CanKanError` from a zod validation failure.
 * `context` is a human-readable label prefixed to the message — usually an
 * absolute file path (per-layer validation), but `resolve.ts` also uses
 * this for the final post-merge validation, which is not about any single
 * file. Exported so that second call site does not have to hand-roll its
 * own (previously unwrapped) error text — see contract §1 amendment
 * discussion / review round 2 finding 4.
 */
export function buildConfigValidationError(context: string, error: z.ZodError): CanKanError {
  const message = `${context}: ${error.issues.map(describeIssue).join("; ")}`;
  return new CanKanError(ConfigErrorCodes.INVALID_CONFIG, message, {
    cause: error,
    details: { file: context },
  });
}

/** A parsed-and-validated layer, plus the raw `Document` for `!policy` detection. */
export interface ValidatedLayer {
  layer: LoadedLayer;
  doc: Document.Parsed;
}

/**
 * Recursively freezes `value` (objects and arrays; anything else is
 * already immutable or opaque to us). `Object.freeze` alone is shallow, so
 * `LoadedLayer.data`'s `Readonly<Record<string, unknown>>` type was
 * previously only a compile-time promise — a nested object (`data.hooks`,
 * say) was fully writable at runtime. Review round 2 reproduced the
 * consequence directly: `resolve.ts`'s merge could write one layer's value
 * into *another layer's* already-returned `LoadedLayer.data`, corrupting
 * the provenance contract §1's `layers` field exists to provide. Deep
 * freezing here is the backstop; the primary fix is in `resolve.ts` (never
 * reusing a layer's own object as a mutable container in the first place).
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

/**
 * Reads, parses, and schema-validates one layer file. Returns `undefined`
 * when the file does not exist (R12). Throws a `CanKanError` naming the
 * file for a read failure, a symlinked repo-controlled path (review round
 * 2 finding 12, when `rejectSymlink` is `true`), a YAML syntax error
 * (R16), a schema validation failure (R13/S2), or a failure converting the
 * parsed document to a plain value (e.g. `yaml`'s alias-expansion guard
 * rejecting an anchor/alias bomb) — `doc.toJS()` sat outside this
 * function's try/catch in an earlier version, so that last case escaped
 * `loadConfig` as a bare, unwrapped error with no file named and no
 * `CanKanError` code.
 *
 * `rejectSymlink`: pass `true` for the repo and repo-local paths (attacker
 * -supplyable), `false` for the global path (the user's own file — see
 * `assertNotSymlink`'s comment for why that asymmetry is deliberate).
 */
export async function loadValidatedLayer(
  layer: LoadedLayer["layer"],
  absPath: string,
  schema: z.ZodType,
  customTags: Tags,
  rejectSymlink: boolean,
): Promise<ValidatedLayer | undefined> {
  const parsed = await readYamlFile(absPath, customTags, rejectSymlink);
  if (!parsed) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = parsed.doc.toJS() ?? {};
  } catch (err) {
    throw new CanKanError(ConfigErrorCodes.INVALID_CONFIG, `${absPath}: could not be converted from YAML`, {
      cause: err,
      details: { file: absPath },
    });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw buildConfigValidationError(absPath, result.error);
  }

  return {
    layer: {
      layer,
      file: absPath,
      data: deepFreeze(result.data as Record<string, unknown>),
    },
    doc: parsed.doc,
  };
}
