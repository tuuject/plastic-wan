/** A failure with a stable machine-readable code and a process exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, options: { readonly exitCode?: number } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** Bad invocation input: exit code 2, like conventional CLI usage errors. */
export function usageError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}
