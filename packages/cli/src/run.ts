import process from 'node:process';
import { type ParsedCli, parseCli, parseTimeout, resolveCli } from './args.ts';
import { AdminClient, isRecord, parseEndpoint } from './client.ts';
import { type CliIo, executeCommand } from './commands.ts';
import { credentialsPath, readCredentials, writeCredentials } from './credentials.ts';
import { CliError, usageError } from './errors.ts';
import { promptLoginField, readLoginKey } from './login.ts';

export const USAGE = `plasticwan-utils - Plastic Wan Admin API 工具客户端

用法:
  plasticwan-utils login [--endpoint <url>] [--api-key-stdin] [--json]
  plasticwan-utils doctor [--json]
  plasticwan-utils invocation list [--limit N] [--cursor ID] [--state STATE] [--chat ID] [--json]
  plasticwan-utils invocation get <id> [--json]
  plasticwan-utils invocation replay <id> [--system-prompt <file|->] [--json]

全局选项:
  --endpoint <url>    Admin Panel 基地址（覆盖环境变量与登录文件）；明文 http 仅允许 loopback
  --api-key <key>     API key（覆盖 PLASTICWAN_API_KEY 与登录文件；建议隐藏输入、stdin 或安全环境注入）
  --api-key-stdin     仅 login：读取标准输入至 EOF，接受单行 API key，不回显
  --timeout-ms <ms>   请求/每次输入超时；默认 login/doctor/list/get 30000，replay 300000，不自动重试
  --json              输出稳定 JSON
  -h, --help          显示本帮助

登录文件: ~/.config/plasticwan-utils/credentials.json（未加密，包含 API key）。
login 只保存凭据；doctor 用只读请求验证连接与鉴权，不调用模型。更换 endpoint 时必须同时提供对应 key。
退出码: 0 成功；1 请求、replay、超时或凭据文件失败；2 参数/输入/凭据不合法。错误以 JSON 写到 stderr。`;

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
  readonly homeDir?: string;
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const secrets: Array<string | undefined> = [env.PLASTICWAN_API_KEY, ...argumentKeys(argv)];
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const path = credentialsPath(options.homeDir);
    if (parsed.command?.kind === 'login') {
      return await login(parsed, env, io, path, secrets);
    }
    const explicitEndpoint = parsed.endpointRaw ?? env.PLASTICWAN_ENDPOINT;
    const explicitKey = parsed.apiKeyRaw ?? env.PLASTICWAN_API_KEY;
    const saved = explicitEndpoint !== undefined && explicitKey !== undefined ? undefined : await readCredentials(path);
    secrets.push(saved?.apiKey);
    const resolved = resolveCli(parsed, env, saved);
    secrets.push(resolved.apiKey);
    const client = new AdminClient({
      baseUrl: resolved.endpoint,
      apiKey: resolved.apiKey,
      defaultTimeoutMs: resolved.timeoutMs,
    });
    const output = redactingIo(
      io,
      secrets,
      resolved.json || resolved.command.kind === 'get' || resolved.command.kind === 'replay',
    );
    if (resolved.command.kind === 'doctor') {
      const raw = await client.get('api/invocations', new URLSearchParams({ limit: '1' }));
      if (
        !isRecord(raw) ||
        !Array.isArray(raw.items) ||
        (raw.next_cursor !== null && typeof raw.next_cursor !== 'string')
      ) {
        throw new CliError('invalid_response', 'doctor expected an invocation list response from the Admin API');
      }
      const result = { status: 'ok', endpoint: resolved.endpoint.href, credential_sources: resolved.credentialSources };
      output.stdout(
        resolved.json
          ? `${JSON.stringify(result)}\n`
          : `Login is valid; Admin API connection and authentication succeeded (${resolved.endpoint.href}).\n`,
      );
      return 0;
    }
    if (resolved.command.kind === 'login') {
      throw usageError('invalid_command', 'login cannot execute an invocation request');
    }
    return await executeCommand(
      resolved.command,
      { json: resolved.json, io: output, timeoutMs: resolved.timeoutMs },
      client,
    );
  } catch (error) {
    return reportError(error, io, secrets);
  }
}

async function login(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  io: CliIo,
  path: string,
  secrets: Array<string | undefined>,
): Promise<number> {
  if (parsed.command?.kind !== 'login') {
    throw usageError('invalid_command', 'expected login');
  }
  const timeoutMs = parseTimeout(parsed.timeoutRaw, false);
  let endpointRaw = parsed.endpointRaw ?? env.PLASTICWAN_ENDPOINT;
  let apiKey = parsed.apiKeyRaw ?? env.PLASTICWAN_API_KEY;
  if (parsed.command.apiKeyStdin && apiKey !== undefined) {
    throw usageError(
      'conflicting_key_input',
      '--api-key-stdin cannot be combined with --api-key or PLASTICWAN_API_KEY',
    );
  }
  if (endpointRaw === undefined) {
    endpointRaw = await promptLoginField('Admin API endpoint: ', false, timeoutMs);
  }
  const endpoint = parseEndpoint(endpointRaw).href;
  if (parsed.command.apiKeyStdin) {
    apiKey = await readLoginKey(timeoutMs);
  } else if (apiKey === undefined) {
    apiKey = await promptLoginField('API key (hidden): ', true, timeoutMs);
  }
  secrets.push(apiKey);
  await writeCredentials(path, { endpoint, apiKey });
  const output = redactingIo(io, secrets, parsed.json);
  output.stdout(
    parsed.json
      ? `${JSON.stringify({ status: 'saved', endpoint, credentials_file: path })}\n`
      : 'Login credentials saved. Run plasticwan-utils doctor to verify connection and authentication.\n',
  );
  return 0;
}

/** parseArgs can fail before ParsedCli exists; retain even raw key flags for redaction. */
function argumentKeys(argv: readonly string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token?.startsWith('--api-key=')) {
      keys.push(token.slice('--api-key='.length));
    } else if (token === '--api-key' && argv[index + 1] !== undefined) {
      keys.push(argv[index + 1] ?? '');
    }
  }
  return keys;
}

/** Redact JSON string tokens without touching structural quotes, braces or numbers. */
function redactingIo(io: CliIo, secrets: readonly (string | undefined)[], jsonOutput: boolean): CliIo {
  return {
    stdout: (text) =>
      io.stdout(
        jsonOutput
          ? text.replace(/"(?:\\.|[^"\\])*"/g, (token) =>
              JSON.stringify(redactSecrets(JSON.parse(token) as string, secrets)),
            )
          : redactSecrets(text, secrets),
      ),
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
