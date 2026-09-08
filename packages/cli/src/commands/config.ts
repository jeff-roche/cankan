import * as core from "@jeff-roche/cankan-core";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type CollectionTag,
  type Document,
  type ScalarTag,
  type Tags,
} from "yaml";
import {
  buildContext,
  globalArgs,
  type Context,
  type GlobalArgs,
} from "../context";
import { defineCommand } from "../registry";

export type ConfigTarget = "global" | "local" | "repo";

interface ConfigEntryOutput {
  readonly key: string;
  readonly value: unknown;
  readonly layer: core.config.ConfigLayer;
  readonly file?: string;
  readonly envVar?: string;
  readonly pinnedBy?: string;
}

export interface SetConfigValueOptions {
  readonly repoRoot: string;
  readonly key: string;
  readonly rawValue: string;
  readonly target?: ConfigTarget;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ConfigCommandArgs extends GlobalArgs {
  readonly key?: string;
  readonly value?: string;
  readonly resolved?: boolean;
  readonly source?: boolean;
  readonly global?: boolean;
  readonly local?: boolean;
  readonly repo?: boolean;
}

const FORBIDDEN_KEY_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// Keep CLI edits consistent with core's YAML handling: a tagged scalar must
// retain its YAML 1.2 type while the document is validated and rewritten.
const POLICY_TAG = "!policy";
const INTEGER_PATTERN = /^[-+]?\d+$/;
const FLOAT_PATTERN = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;

function resolvePolicyScalar(raw: string): unknown {
  if (
    raw === "" ||
    raw === "~" ||
    raw === "null" ||
    raw === "Null" ||
    raw === "NULL"
  )
    return null;
  if (raw === "true" || raw === "True" || raw === "TRUE") return true;
  if (raw === "false" || raw === "False" || raw === "FALSE") return false;
  if (INTEGER_PATTERN.test(raw)) return Number(raw);
  if (FLOAT_PATTERN.test(raw) && /[.eE]/.test(raw)) return Number(raw);
  return raw;
}

const policyScalarTag: ScalarTag = {
  tag: POLICY_TAG,
  resolve: resolvePolicyScalar,
};
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

function keyPath(key: string): string[] {
  const path = key.split(".");
  if (
    path.length === 0 ||
    path.some(
      (segment) => segment.length === 0 || FORBIDDEN_KEY_SEGMENTS.has(segment),
    )
  ) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      `invalid config key "${key}"`,
    );
  }
  return path;
}

function globalConfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.XDG_CONFIG_HOME;
  const base =
    configured && isAbsolute(configured)
      ? configured
      : join(env.HOME ?? "", ".config");
  const path = join(base, "cankan", "config.yml");
  if (!isAbsolute(path)) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      "cannot locate the global config file without HOME",
    );
  }
  return path;
}

function targetPath(
  repoRoot: string,
  target: ConfigTarget,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (target === "repo") return join(repoRoot, ".cankan", "config.yml");
  if (target === "local") return join(repoRoot, ".cankan", "local.yml");
  return globalConfigPath(env);
}

function targetSchema(target: ConfigTarget) {
  if (target === "repo") return core.config.repoConfigSchema;
  if (target === "local") return core.config.localConfigSchema;
  return core.config.globalConfigSchema;
}

function explicitTarget(args: ConfigCommandArgs): ConfigTarget | undefined {
  const selected = [
    args.global ? "global" : undefined,
    args.local ? "local" : undefined,
    args.repo ? "repo" : undefined,
  ].filter((value): value is ConfigTarget => value !== undefined);
  if (selected.length > 1) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      "only one of --global, --local, or --repo may be used",
    );
  }
  return selected[0];
}

function defaultTarget(key: string[]): ConfigTarget {
  return core.config.classifyKey(key) === "policy" ? "repo" : "local";
}

function parseYamlValue(rawValue: string): unknown {
  const document = parseDocument(rawValue);
  if (document.errors.length > 0 || document.contents === null) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      "config values must be one valid YAML value",
    );
  }
  const value = document.toJS();
  if (value === undefined) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      "config values must not be empty",
    );
  }
  return value;
}

function pathFromVisit(path: readonly unknown[]): string[] {
  return path.flatMap((entry) =>
    isPair(entry) && isScalar(entry.key) ? [String(entry.key.value)] : [],
  );
}

function findPolicyPaths(document: Document, file: string): string[][] {
  const paths: string[][] = [];
  visit(document, (_key, node, path) => {
    if (
      (isScalar(node) || isMap(node) || isSeq(node)) &&
      node.tag === "!policy"
    ) {
      const segments = pathFromVisit(path);
      if (segments.length === 0) {
        throw new core.CanKanError(
          core.config.ConfigErrorCodes.INVALID_CONFIG,
          `${file}: "!policy" on the document root is not supported; tag individual keys`,
          { details: { file } },
        );
      }
      paths.push(segments);
      return visit.SKIP;
    }
    return undefined;
  });
  return paths;
}

function startsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((segment, index) => segment === path[index])
  );
}

async function assertNotSymlink(path: string): Promise<void> {
  for (const candidate of [dirname(path), path]) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(candidate);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new core.CanKanError(
        core.config.ConfigErrorCodes.INVALID_CONFIG,
        `${path}: refusing to read a symlinked repo config file or directory`,
        { details: { file: path } },
      );
    }
  }
}

async function readConfigDocument(
  path: string,
  rejectSymlink = false,
): Promise<Document> {
  if (rejectSymlink) await assertNotSymlink(path);
  try {
    return parseDocument(await readFile(path, "utf8"), {
      customTags: POLICY_TAGS,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return parseDocument("{}\n", { customTags: POLICY_TAGS });
    }
    throw error;
  }
}

async function writeAtomic(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.cankan-config-${randomUUID()}`);
  let renamed = false;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

function validateLayer(
  target: ConfigTarget,
  document: Document,
  path: string,
): void {
  if (document.errors.length > 0) {
    throw new core.CanKanError(
      core.config.ConfigErrorCodes.INVALID_CONFIG,
      `${path}: YAML syntax error`,
      {
        details: { file: path },
      },
    );
  }
  const result = targetSchema(target).safeParse(document.toJS() ?? {});
  if (!result.success) {
    throw new core.CanKanError(
      core.config.ConfigErrorCodes.INVALID_CONFIG,
      `${path}: invalid value for config key`,
      {
        details: { file: path },
      },
    );
  }
}

export async function setConfigValue(
  options: SetConfigValueOptions,
): Promise<{ target: ConfigTarget; file: string }> {
  const env = options.env ?? process.env;
  const path = keyPath(options.key);
  const target = options.target ?? defaultTarget(path);
  const file = targetPath(options.repoRoot, target, env);
  const document = await readConfigDocument(file, target !== "global");
  const repoConfigPath = targetPath(options.repoRoot, "repo", env);
  const policyDocument =
    target === "repo"
      ? document
      : await readConfigDocument(repoConfigPath, true);
  const policyPaths = findPolicyPaths(policyDocument, repoConfigPath);

  if (target !== "repo") {
    const pinningPath = policyPaths.find((pinnedPath) =>
      startsWith(path, pinnedPath),
    );
    if (pinningPath) {
      throw new core.CanKanError(
        core.ErrorCodes.POLICY_VIOLATION,
        `${options.key} is set as policy by ${repoConfigPath}`,
        {
          details: {
            key: options.key,
            pinnedBy: repoConfigPath,
          },
        },
      );
    }
  }

  const value = parseYamlValue(options.rawValue);
  document.setIn(path, value);
  const existing = await lstat(file).catch(() => undefined);
  if (
    target === "repo" &&
    policyPaths.some((pinnedPath) => startsWith(path, pinnedPath))
  ) {
    const node = document.getIn(path, true);
    if (isScalar(node) || isMap(node) || isSeq(node)) node.tag = "!policy";
  }
  validateLayer(target, document, file);
  await writeAtomic(
    file,
    document.toString(),
    target === "repo" ? (existing?.mode ?? 0o644) : 0o600,
  );
  return { target, file };
}

export function formatConfigShow(
  config: core.config.ConfigResult,
  options: { readonly resolved?: boolean; readonly source?: boolean },
): core.config.EffectiveConfig | readonly ConfigEntryOutput[] {
  if (!options.resolved && !options.source) return config.value;
  const entries: ConfigEntryOutput[] = [];
  for (const entry of config.entries()) {
    entries.push({
      key: entry.key,
      value: entry.value,
      layer: entry.layer,
      ...(entry.file === undefined ? {} : { file: entry.file }),
      ...(entry.envVar === undefined ? {} : { envVar: entry.envVar }),
      ...(entry.pinnedBy === undefined ? {} : { pinnedBy: entry.pinnedBy }),
    });
  }
  return entries;
}

export function formatConfigGet(
  config: core.config.ConfigResult,
  key: string,
): ConfigEntryOutput {
  const entry = config.resolved(key);
  if (!entry) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      `unknown config key "${key}"`,
    );
  }
  return {
    key: entry.key,
    value: entry.value,
    layer: entry.layer,
    ...(entry.file === undefined ? {} : { file: entry.file }),
    ...(entry.envVar === undefined ? {} : { envVar: entry.envVar }),
    ...(entry.pinnedBy === undefined ? {} : { pinnedBy: entry.pinnedBy }),
  };
}

async function withContext<T>(
  args: ConfigCommandArgs,
  action: (context: Context) => Promise<T>,
): Promise<T> {
  const context = await buildContext(args);
  try {
    return await action(context);
  } finally {
    context.core.dispose();
  }
}

const targetArgs = {
  global: { type: "boolean", description: "Write the global config" },
  local: { type: "boolean", description: "Write the repo-local config" },
  repo: { type: "boolean", description: "Write the repository config" },
} as const;

export const configShowCommand = defineCommand({
  meta: { name: "show", description: "Show effective configuration" },
  args: {
    ...globalArgs,
    resolved: {
      type: "boolean",
      description: "Show resolved effective values",
    },
    source: { type: "boolean", description: "Show per-key source attribution" },
  },
  async run({ args }) {
    const parsed = args as ConfigCommandArgs;
    await withContext(parsed, async (context) => {
      context.output.write(formatConfigShow(context.config, parsed));
    });
  },
});

export const configGetCommand = defineCommand({
  meta: { name: "get", description: "Get one effective config value" },
  args: {
    ...globalArgs,
    key: { type: "positional", description: "Config key" },
  },
  async run({ args }) {
    const parsed = args as ConfigCommandArgs;
    if (!parsed.key)
      throw new core.CanKanError(
        core.ErrorCodes.USAGE,
        "config get requires a key",
      );
    await withContext(parsed, async (context) => {
      context.output.write(
        formatConfigGet(context.config, parsed.key as string),
      );
    });
  },
});

export const configSetCommand = defineCommand({
  meta: { name: "set", description: "Set a configuration value" },
  args: {
    ...globalArgs,
    key: { type: "positional", description: "Config key" },
    value: { type: "positional", description: "YAML value" },
    ...targetArgs,
  },
  async run({ args }) {
    const parsed = args as ConfigCommandArgs;
    if (!parsed.key || parsed.value === undefined) {
      throw new core.CanKanError(
        core.ErrorCodes.USAGE,
        "config set requires a key and value",
      );
    }
    const target = explicitTarget(parsed);
    await withContext(parsed, async (context) => {
      const result = await setConfigValue({
        repoRoot: context.board.root,
        key: parsed.key as string,
        rawValue: parsed.value as string,
        ...(target === undefined ? {} : { target }),
      });
      context.output.write(result);
    });
  },
});

export const configCommand = defineCommand({
  meta: { name: "config", description: "Inspect and change configuration" },
  args: globalArgs,
  subCommands: {
    show: configShowCommand,
    get: configGetCommand,
    set: configSetCommand,
  },
});
