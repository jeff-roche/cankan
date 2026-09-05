/**
 * `$XDG_DATA_HOME` resolution, shared by `registry.ts` (`repos.yml`) and
 * `personal.ts` (the personal board directory) — both live under
 * `$XDG_DATA_HOME/cankan/...` per CONCEPT.md "Data directories (XDG)".
 *
 * Deliberately not exported from `board/index.ts`: it is an internal
 * building block for this module's two XDG-rooted paths, not part of the
 * public surface dispatch B or later lanes need.
 */
import { isAbsolute, join } from "node:path";

/**
 * `$XDG_DATA_HOME`, defaulting to `$HOME/.local/share` when
 * `XDG_DATA_HOME` is unset, empty, or itself relative. Mirrors the rule
 * `config/layers.ts`'s `resolveGlobalConfigPath` established for
 * `XDG_CONFIG_HOME` (~lines 47-57), including its "relative values are
 * ignored, not used cwd-relative" reading of the XDG spec.
 *
 * Returns `undefined` only when neither var yields an absolute path at all
 * (no `HOME` and no absolute `XDG_DATA_HOME`) — callers treat that as "no
 * data directory can be located," never as a cwd-relative fallback.
 */
export function resolveDataHome(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const xdgDataHome = env.XDG_DATA_HOME;
  const dataHome =
    xdgDataHome !== undefined && xdgDataHome.length > 0 && isAbsolute(xdgDataHome)
      ? xdgDataHome
      : join(env.HOME ?? "", ".local", "share");
  return isAbsolute(dataHome) ? dataHome : undefined;
}
