import process from 'node:process';
import { type ParsedCli, parseCli, type ResolvedCli, resolveCli } from './args.ts';
import { AdminClient } from './client.ts';
import { type CliIo, executeCommand } from './commands.ts';
import { CliError } from './errors.ts';

export const USAGE = `plasticwan-debug - Plastic Wan Admin API 调试客户端

用法:
  plasticwan-debug invocation list [--limit N] [--cursor ID] [--state STATE] [--chat ID] [--json]
  plasticwan-debug invocation get <id> [--json]
  plasticwan-debug invocation replay <id> [--system-prompt <file|->] [--json]

全局选项:
  --endpoint <url>    Admin Panel 基地址（或 PLASTICWAN_ENDPOINT）；明文 http 仅允许 loopback
  --api-key <key>     API key（或 PLASTICWAN_API_KEY，推荐用环境变量）
  --timeout-ms <ms>   请求超时（stdin 读取单独使用同一上限）；默认 list/get 30000，replay 300000，不自动重试
  --json              输出稳定 JSON
  -h, --help          显示本帮助

退出码: 0 成功；1 请求或 replay 失败；2 参数/输入错误。错误以 JSON 写到 stderr。`;

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  let parsed: ParsedCli | undefined;
  let resolved: ResolvedCli;
  try {
    parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    resolved = resolveCli(parsed, env);
  } catch (error) {
    // `parseCli` can fail before the flag value is resolved; the raw --api-key
    // (and the environment key) must stay redacted even then.
    return reportError(error, io, [parsed?.apiKeyRaw, env.PLASTICWAN_API_KEY]);
  }
  const secrets = [resolved.apiKey, env.PLASTICWAN_API_KEY];
  try {
    const client = new AdminClient({
      baseUrl: resolved.endpoint,
      apiKey: resolved.apiKey,
      defaultTimeoutMs: resolved.timeoutMs,
    });
    return await executeCommand(
      resolved.command,
      { json: resolved.json, io: redactingIo(io, secrets), timeoutMs: resolved.timeoutMs },
      client,
    );
  } catch (error) {
    return reportError(error, io, secrets);
  }
}

/** Every byte written by a command passes through redaction, success or failure. */
function redactingIo(io: CliIo, secrets: readonly (string | undefined)[]): CliIo {
  return {
    stdout: (text) => io.stdout(redactSecrets(text, secrets)),
    stderr: (text) => io.stderr(redactSecrets(text, secrets)),
  };
}

function reportError(error: unknown, io: CliIo, secrets: readonly (string | undefined)[]): number {
  const cli = error instanceof CliError ? error : undefined;
  // A server-provided error string becomes the CliError code; it is just as
  // capable of echoing the key as the message is.
  const code = redactSecrets(cli?.code ?? 'internal_error', secrets);
  const rawMessage = cli?.message ?? (error instanceof Error ? error.message : 'unexpected failure');
  io.stderr(`${JSON.stringify({ error: code, message: redactSecrets(rawMessage, secrets) })}\n`);
  return cli?.exitCode ?? 1;
}

/** The API key must never appear in output, even if a server echoes it back. */
function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    // Replace the JSON-escaped form first: inside a JSON document that is the
    // form actually written, and an escaped match cannot cut through a
    // structural quote (a raw match on a key ending in `\` can).
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) {
      redacted = redacted.split(escaped).join('[redacted]');
    }
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
