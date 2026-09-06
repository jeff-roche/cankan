/** Trust for executable repository configuration. */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ConfigResult } from "../config/index";

const RECORD_VERSION = 1;
interface TrustRecord {
  version: number;
  boardRoot: string;
  fingerprint: string;
  grantedAt: string;
}
export interface RepoExecutableConfig {
  hooks: Readonly<Record<string, string>>;
  editor?: string;
  defaultTool?: string;
}

function repoData(
  cfg: ConfigResult,
): Readonly<Record<string, unknown>> | undefined {
  return cfg.layers.find((layer) => layer.layer === "repo")?.data;
}

/** Extract only the repo-layer values that can start a process. */
export function repoExecutableConfig(cfg: ConfigResult): RepoExecutableConfig {
  const data = repoData(cfg);
  const hooksValue = data?.hooks;
  const hooks: Record<string, string> = {};
  if (
    hooksValue !== null &&
    typeof hooksValue === "object" &&
    !Array.isArray(hooksValue)
  ) {
    for (const [event, command] of Object.entries(hooksValue))
      if (typeof command === "string") hooks[event] = command;
  }
  const agents = data?.agents;
  const agentValues =
    agents !== null && typeof agents === "object" && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)
      : undefined;
  const defaultTool =
    typeof agentValues?.default_tool === "string"
      ? agentValues.default_tool
      : undefined;
  return {
    hooks,
    ...(typeof data?.editor === "string" ? { editor: data.editor } : {}),
    ...(defaultTool === undefined ? {} : { defaultTool }),
  };
}

/** Stable content fingerprint: unrelated repo config edits do not revoke trust. */
export function repoExecutableFingerprint(cfg: ConfigResult): string {
  const executable = repoExecutableConfig(cfg);
  return createHash("sha256")
    .update(
      JSON.stringify({
        hooks: Object.fromEntries(
          Object.entries(executable.hooks).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
        editor: executable.editor ?? null,
        defaultTool: executable.defaultTool ?? null,
      }),
    )
    .digest("hex");
}

function stateRoot(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME))
    return join(env.XDG_STATE_HOME, "cankan", "trust");
  if (env.HOME && isAbsolute(env.HOME))
    return join(env.HOME, ".local", "state", "cankan", "trust");
  return undefined;
}
async function recordPath(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ path: string; boardRoot: string } | undefined> {
  const root = stateRoot(env);
  if (!root) return undefined;
  // `resolve()` only normalizes spelling: `/link/repo` and `/real/repo`
  // remain distinct strings. Trust must follow the actual board, including
  // across a symlinked checkout or worktree entry point, so approval cannot
  // accidentally be bypassed (or duplicated) by choosing a different path.
  const boardRoot = await realpath(resolvePath(repoRoot));
  return {
    path: join(root, `${createHash("sha256").update(boardRoot).digest("hex")}.json`),
    boardRoot,
  };
}

/** Missing, malformed, or unavailable approval is untrusted: fail closed. */
export async function hasRepoExecutableTrust(
  repoRoot: string,
  cfg: ConfigResult,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  let recordLocation: { path: string; boardRoot: string } | undefined;
  try {
    recordLocation = await recordPath(repoRoot, env);
  } catch {
    return false;
  }
  if (!recordLocation) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(recordLocation.path, "utf8"));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const record = parsed as Partial<TrustRecord>;
  return (
    record.version === RECORD_VERSION &&
    record.boardRoot === recordLocation.boardRoot &&
    record.fingerprint === repoExecutableFingerprint(cfg)
  );
}

/** Persist explicit approval for this board and this exact executable config. */
export async function grantRepoExecutableTrust(
  repoRoot: string,
  cfg: ConfigResult,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const recordLocation = await recordPath(repoRoot, env);
  if (!recordLocation)
    throw new Error(
      "No absolute XDG_STATE_HOME or HOME is available to store repository trust",
    );
  const record: TrustRecord = {
    version: RECORD_VERSION,
    boardRoot: recordLocation.boardRoot,
    fingerprint: repoExecutableFingerprint(cfg),
    grantedAt: new Date().toISOString(),
  };
  await mkdir(dirname(recordLocation.path), { recursive: true, mode: 0o700 });
  const temporary = `${recordLocation.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, recordLocation.path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Remove approval for a board. Missing state is already untrusted. */
export async function revokeRepoExecutableTrust(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  let recordLocation: { path: string; boardRoot: string } | undefined;
  try {
    recordLocation = await recordPath(repoRoot, env);
  } catch {
    return;
  }
  if (recordLocation) await unlink(recordLocation.path).catch(() => undefined);
}
