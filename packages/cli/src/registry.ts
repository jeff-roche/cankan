import { defineCommand as defineCittyCommand, type ArgsDef, type CommandDef } from "citty";

export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly command: CommandDef;
}

const specs = new Map<string, CommandSpec>();

export function defineCommand<const T extends ArgsDef>(def: CommandDef<T>): CommandDef<T> {
  const meta = def.meta && typeof def.meta !== "function" && !(def.meta instanceof Promise) ? def.meta : undefined;
  const args = def.args && typeof def.args !== "function" && !(def.args instanceof Promise) ? def.args : undefined;
  if (meta?.name) {
    const definitions = args ?? {};
    const positional = Object.fromEntries(
      Object.entries(definitions).filter(([, value]) => (value as { type?: string }).type === "positional"),
    );
    const flags = Object.fromEntries(
      Object.entries(definitions).filter(([, value]) => (value as { type?: string }).type !== "positional"),
    );
    specs.set(meta.name, {
      name: meta.name,
      description: meta.description ?? "",
      args: positional,
      flags,
      command: def as CommandDef,
    });
  }
  return defineCittyCommand(def);
}

export function commandSpecs(): readonly CommandSpec[] {
  return [...specs.values()];
}

export function getCommandSpec(name: string): CommandSpec | undefined {
  return specs.get(name);
}
