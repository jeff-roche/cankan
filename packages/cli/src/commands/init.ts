import { isCancel, multiselect } from "@clack/prompts";
import * as core from "@jeff-roche/cankan-core";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { globalArgs, type GlobalArgs } from "../context";
import { createOutput, type Output } from "../output";
import { defineCommand } from "../registry";

export type BackerType = "beads" | "github" | "jira";

export interface DetectedBacker {
  readonly type: BackerType;
  readonly repo?: string;
  readonly site?: string;
  readonly project?: string;
}

export interface InitOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly backers?: readonly string[];
  readonly noBackers?: boolean;
  readonly noWizard?: boolean;
  readonly prefix?: string;
}

export interface InitResult {
  readonly board: core.BoardRef;
  readonly detectedBackers: readonly DetectedBacker[];
  readonly selectedBackers: readonly BackerType[];
  readonly backlogDetected: boolean;
}

interface GitHubRemote {
  readonly repo: string;
}

const DEFAULT_PREFIX = "ck";
const SUPPORTED_BACKERS: readonly BackerType[] = ["beads", "github", "jira"];

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readGitConfig(root: string): Promise<string> {
  const gitPath = join(root, ".git");
  let gitDir = gitPath;
  try {
    const info = await lstat(gitPath);
    if (info.isFile()) {
      const pointer = await readFile(gitPath, "utf8");
      const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer);
      if (match?.[1]) gitDir = resolve(root, match[1]);
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  try {
    return await readFile(join(gitDir, "config"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}

function githubRemoteFromConfig(config: string): GitHubRemote | undefined {
  const remoteBlocks = config.split(/\n(?=\s*\[)/);
  for (const block of remoteBlocks) {
    if (!/^\s*\[remote\s+"[^"\n]+"\]/m.test(block)) continue;
    const url = /^\s*url\s*=\s*(\S+)\s*$/m.exec(block)?.[1];
    if (!url) continue;
    const match = /^(?:https?:\/\/|ssh:\/\/git@)github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(url)
      ?? /^git@github\.com:([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(url);
    if (match?.[1] && match[2]) return { repo: `${match[1]}/${match[2]}` };
  }
  return undefined;
}

export async function detectBackers(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly backers: readonly DetectedBacker[]; readonly backlogDetected: boolean }> {
  const [backlogDetected, beadsDetected, gitConfig] = await Promise.all([
    pathExists(join(root, "backlog")),
    pathExists(join(root, ".beads")),
    readGitConfig(root),
  ]);
  const detected: DetectedBacker[] = [];
  if (beadsDetected) detected.push({ type: "beads" });

  const github = githubRemoteFromConfig(gitConfig);
  if (github) detected.push({ type: "github", repo: github.repo });

  const jiraSite = env.JIRA_SITE ?? env.JIRA_URL;
  const jiraProject = env.JIRA_PROJECT;
  if (Object.keys(env).some((key) => key.startsWith("JIRA_"))) {
    detected.push({
      type: "jira",
      ...(jiraSite ? { site: jiraSite } : {}),
      ...(jiraProject ? { project: jiraProject } : {}),
    });
  }
  return { backers: detected, backlogDetected };
}

function collectRepeatedFlag(rawArgs: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const raw = rawArgs[index];
    if (raw === `--${name}`) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("-")) throw new core.CanKanError(core.ErrorCodes.USAGE, `--${name} requires a value`);
      values.push(value);
    } else if (raw.startsWith(`--${name}=`)) {
      const value = raw.slice(name.length + 3);
      if (!value) throw new core.CanKanError(core.ErrorCodes.USAGE, `--${name} requires a value`);
      values.push(value);
    }
  }
  return values;
}

function normalizeBackerSelection(values: readonly string[]): BackerType[] {
  const selected: BackerType[] = [];
  for (const value of values) {
    if (!SUPPORTED_BACKERS.includes(value as BackerType)) {
      throw new core.CanKanError(core.ErrorCodes.USAGE, `unknown backer "${value}"; expected github, jira, or beads`);
    }
    const type = value as BackerType;
    if (!selected.includes(type)) selected.push(type);
  }
  return selected;
}

async function selectBackers(
  detected: readonly DetectedBacker[],
  options: Pick<InitOptions, "backers" | "noBackers" | "noWizard">,
): Promise<BackerType[]> {
  if (options.noBackers && options.backers && options.backers.length > 0) {
    throw new core.CanKanError(core.ErrorCodes.USAGE, "--backer and --no-backers cannot be used together");
  }
  if (options.noBackers) return [];
  if (options.backers && options.backers.length > 0) return normalizeBackerSelection(options.backers);
  if (options.noWizard || detected.length === 0) return detected.map(({ type }) => type);

  const answer = await multiselect({
    message: "Which integrations should CanKan configure?",
    options: detected.map((backer) => ({
      value: backer.type,
      label: backer.type,
      ...(backer.repo ? { hint: backer.repo } : {}),
    })),
    initialValues: detected.map(({ type }) => type),
  });
  if (isCancel(answer)) {
    throw new core.CanKanError(core.ErrorCodes.USAGE, "initialization cancelled");
  }
  return normalizeBackerSelection(answer);
}

function configFor(
  root: string,
  prefix: string,
  detected: readonly DetectedBacker[],
  selected: readonly BackerType[],
): Record<string, unknown> {
  const backers: Record<string, Record<string, unknown>> = {};
  for (const type of selected) {
    const found = detected.find((backer) => backer.type === type);
    backers[type] = {
      ...(found?.repo ? { repo: found.repo } : {}),
      ...(found?.site ? { site: found.site } : {}),
      ...(found?.project ? { project: found.project } : {}),
    };
  }
  return {
    version: 1,
    project: basename(root),
    id_prefix: prefix,
    tickets_dir: "backlog/tasks",
    columns: ["To Do", "In Progress", "In Review", "Done"],
    coordination: { ref: "refs/cankan/coordination", mode: "shared-ref", push_ref: true },
    claims: { lease: "2h", max_per_actor: 3, require_ready: true },
    sync: { auto_push: "off", auto_pull: "off", conflict_policy: "manual" },
    ...(selected.length > 0 ? { backers } : {}),
    default_backer: selected[0] ?? "none",
  };
}

function validatePrefix(prefix: string): void {
  if (
    prefix.length === 0 ||
    prefix.trim() !== prefix ||
    prefix === "." ||
    prefix === ".." ||
    prefix.includes("/") ||
    prefix.includes("\\") ||
    /\p{Cc}|\p{Cf}/u.test(prefix)
  ) {
    throw new core.CanKanError(
      core.ErrorCodes.USAGE,
      "--prefix must be a non-empty ticket prefix without path separators or control characters",
    );
  }
}

async function ensureSetupDirectory(root: string): Promise<string> {
  const path = join(root, ".cankan");
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new core.CanKanError(core.ErrorCodes.USAGE, "the repository's .cankan entry must be a real directory");
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(path);
  }
  const canonical = await realpath(path);
  if (!core.board.isContained(root, canonical)) {
    throw new core.CanKanError(core.ErrorCodes.USAGE, "the repository's .cankan directory must stay inside the repository");
  }
  return path;
}

async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  const tempPath = join(dirname(path), `.cankan-init-${randomUUID()}`);
  let renamed = false;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode });
    await rename(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
}

async function writeIfMissing(path: string, content: string, mode?: number): Promise<void> {
  if (await pathExists(path)) return;
  await writeAtomic(path, content, mode);
}

async function ensureGitignore(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const lines = current.split(/\r?\n/);
  if (lines.includes(".cankan/local.yml")) return;
  const next = `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}.cankan/local.yml\n`;
  await writeAtomic(path, next);
}

export async function initRepo(options: InitOptions = {}): Promise<InitResult> {
  const env = options.env ?? process.env;
  const adapter = await core.git.createGitAdapter(options.cwd ?? process.cwd());
  const root = await realpath(adapter.root);
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  validatePrefix(prefix);
  const detectedResult = await detectBackers(root, env);
  const selected = await selectBackers(detectedResult.backers, options);

  const cankanDir = await ensureSetupDirectory(root);
  await writeIfMissing(join(cankanDir, "config.yml"), stringify(configFor(root, prefix, detectedResult.backers, selected)), 0o644);
  await writeIfMissing(join(cankanDir, "local.yml"), "{}\n", 0o600);
  await ensureGitignore(root);

  const board = await core.board.resolveBoard({ cwd: root, env });
  await mkdir(board.ticketsDir, { recursive: true });
  await core.events.initRef(adapter, board.coordinationRef);
  const config = await core.board.loadBoardConfig(board, { env });
  if (config.value.repos.auto_register) {
    await core.board.register(basename(root), root, env);
  }

  return {
    board,
    detectedBackers: detectedResult.backers,
    selectedBackers: selected,
    backlogDetected: detectedResult.backlogDetected,
  };
}

interface InitArgs extends GlobalArgs {
  readonly backer?: string;
  readonly noBackers?: boolean;
  readonly noWizard?: boolean;
  readonly prefix?: string;
}

export function initOptionsFromArgs(args: InitArgs, rawArgs: readonly string[]): InitOptions {
  const backers = collectRepeatedFlag(rawArgs, "backer");
  return {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(backers.length > 0 ? { backers } : {}),
    ...(args.noBackers === true || rawArgs.includes("--no-backers") ? { noBackers: true } : {}),
    ...(args.noWizard === true || rawArgs.includes("--no-wizard") ? { noWizard: true } : {}),
    ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
  };
}

export const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize a CanKan board in the current repository" },
  args: {
    ...globalArgs,
    backer: { type: "string", description: "Configure a backer (repeatable)" },
    noBackers: { type: "boolean", description: "Disable backer detection and configuration" },
    noWizard: { type: "boolean", description: "Skip the integration wizard" },
    prefix: { type: "string", default: DEFAULT_PREFIX, description: "Native ticket ID prefix" },
  },
  async run({ args, rawArgs }) {
    const parsed = args as InitArgs;
    const result = await initRepo(initOptionsFromArgs(parsed, rawArgs));
    createOutputForInit(parsed).write({
      initialized: true,
      board: result.board,
      detectedBackers: result.detectedBackers,
      selectedBackers: result.selectedBackers,
      backlogDetected: result.backlogDetected,
    });
  },
});

function createOutputForInit(args: GlobalArgs): Output {
  return createOutput({ json: args.json, plain: args.plain, quiet: args.q, verbose: args.v });
}
