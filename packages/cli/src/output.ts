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
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

export function createOutput(options: OutputOptions = {}): Output {
  const write = options.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(`${text}\n`));
  const mode: OutputMode = options.json ? "json" : options.plain ? "plain" : "table";
  return {
    mode,
    quiet: options.quiet ?? false,
    verbose: options.verbose ?? false,
    write(value) {
      if (options.quiet) return;
      write(mode === "json" ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
    },
    error(message) {
      writeError(message);
    },
  };
}
