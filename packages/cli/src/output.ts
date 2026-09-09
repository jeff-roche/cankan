export type OutputMode = "json" | "plain" | "table";

export interface Output {
  readonly mode: OutputMode;
  readonly quiet: boolean;
  readonly verbose: boolean;
  write(value: unknown): void;
  error(message: string): void;
}

export interface OutputOptions {
  readonly json?: boolean;
  readonly plain?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly color?: "auto" | "always" | "never";
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

const TERMINAL_INVISIBLE_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

function sanitizeTerminal(value: unknown): unknown {
  if (typeof value === "string") {
    let safe = "";
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (TERMINAL_INVISIBLE_CODE_POINTS.has(code)) continue;
      if (code === 9) {
        safe += "\\t";
        continue;
      }
      if (code === 10) {
        safe += "\\n";
        continue;
      }
      if (code === 13) {
        safe += "\\r";
        continue;
      }
      if (code <= 31 || (code >= 0x7f && code <= 0x9f)) continue;
      safe += character;
    }
    return safe;
  }
  if (Array.isArray(value)) return value.map(sanitizeTerminal);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        sanitizeTerminal(key),
        sanitizeTerminal(entry),
      ]),
    );
  }
  return value;
}

export function createOutput(options: OutputOptions = {}): Output {
  const write =
    options.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeError =
    options.writeError ?? ((text: string) => process.stderr.write(`${text}\n`));
  const mode: OutputMode = options.json
    ? "json"
    : options.plain
      ? "plain"
      : "table";
  const useColor =
    mode === "table" &&
    options.color !== "never" &&
    (options.color === "always" || Boolean(process.stdout.isTTY));

  function formatTable(value: unknown): string {
    if (
      Array.isArray(value) &&
      value.every(
        (entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    ) {
      const rows = value as Array<Record<string, unknown>>;
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const header = columns.join("\t");
      const body = rows
        .map((row) =>
          columns.map((column) => String(row[column] ?? "")).join("\t"),
        )
        .join("\n");
      return `${useColor ? "\u001b[1m" : ""}${header}${useColor ? "\u001b[22m" : ""}${body ? `\n${body}` : ""}`;
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value as Record<string, unknown>)
        .map(
          ([key, entry]) =>
            `${key}\t${typeof entry === "string" ? entry : JSON.stringify(entry)}`,
        )
        .join("\n");
    }
    return String(value);
  }

  return {
    mode,
    quiet: options.quiet ?? false,
    verbose: options.verbose ?? false,
    write(value) {
      if (options.quiet) return;
      write(
        mode === "json"
          ? JSON.stringify(value)
          : formatTable(sanitizeTerminal(value)),
      );
    },
    error(message) {
      writeError(message);
    },
  };
}
