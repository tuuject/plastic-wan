import { parseArgs } from 'node:util';
import { parseEndpoint } from './client.ts';
import { usageError } from './errors.ts';

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_REPLAY_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 3_600_000;

const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;
const MIN_SIGNED_64 = -9_223_372_036_854_775_808n;
const DECIMAL_PATTERN = /^\d{1,19}$/;
const SIGNED_DECIMAL_PATTERN = /^-?\d{1,19}$/;
const STATE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TIMEOUT_PATTERN = /^\d{1,8}$/;

const OPTIONS = {
  endpoint: { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  state: { type: 'string' },
  chat: { type: 'string' },
  'system-prompt': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

// Telegram chat ids are negative; parseArgs would read a separate `-123` token
// as a dangling option, so a negative numeric value is folded into `--opt=-123`.
const NEGATIVE_NUMBER_PATTERN = /^-\d+$/;
const NEGATIVE_VALUE_OPTIONS = new Set(['--chat', '--cursor', '--limit', '--timeout-ms']);

export interface ListCommand {
  readonly kind: 'list';
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
  readonly state: string | undefined;
  readonly chat: string | undefined;
}

export interface GetCommand {
  readonly kind: 'get';
  readonly id: string;
}

export interface ReplayCommand {
  readonly kind: 'replay';
  readonly id: string;
  readonly systemPromptSource: string | undefined;
}

export type Command = ListCommand | GetCommand | ReplayCommand;

export interface ParsedCli {
  readonly help: boolean;
  readonly json: boolean;
  readonly command: Command | undefined;
  readonly endpointRaw: string | undefined;
  readonly apiKeyRaw: string | undefined;
  readonly timeoutRaw: string | undefined;
}

export interface ResolvedCli {
  readonly command: Command;
  readonly endpoint: URL;
  readonly apiKey: string;
  readonly json: boolean;
  readonly timeoutMs: number;
}

interface StringFlags {
  readonly 'api-key': string | undefined;
  readonly 'system-prompt': string | undefined;
  readonly limit: string | undefined;
  readonly cursor: string | undefined;
  readonly state: string | undefined;
  readonly chat: string | undefined;
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgsStrict(argv);
  const values = {
    endpoint: parsed.values.endpoint,
    apiKey: parsed.values['api-key'],
    timeout: parsed.values['timeout-ms'],
    json: parsed.values.json === true,
    help: parsed.values.help === true,
    flags: {
      'api-key': parsed.values['api-key'],
      'system-prompt': parsed.values['system-prompt'],
      limit: parsed.values.limit,
      cursor: parsed.values.cursor,
      state: parsed.values.state,
      chat: parsed.values.chat,
    } satisfies StringFlags,
  };
  return {
    help: values.help,
    json: values.json,
    command: values.help ? undefined : parseCommand(parsed.positionals, values.flags),
    endpointRaw: values.endpoint,
    apiKeyRaw: values.apiKey,
    timeoutRaw: values.timeout,
  };
}

export function resolveCli(parsed: ParsedCli, env: Record<string, string | undefined>): ResolvedCli {
  const command = parsed.command;
  if (command === undefined) {
    throw usageError('missing_command', 'usage: plasticwan-debug invocation list|get|replay');
  }
  const endpointRaw = parsed.endpointRaw ?? env.PLASTICWAN_ENDPOINT;
  if (endpointRaw === undefined || endpointRaw.trim().length === 0) {
    throw usageError('missing_endpoint', 'set --endpoint or PLASTICWAN_ENDPOINT to the Admin Panel base URL');
  }
  const apiKey = parsed.apiKeyRaw ?? env.PLASTICWAN_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw usageError('missing_api_key', 'set --api-key or PLASTICWAN_API_KEY');
  }
  return {
    command,
    endpoint: parseEndpoint(endpointRaw),
    apiKey,
    json: parsed.json,
    timeoutMs: parseTimeout(parsed.timeoutRaw, command.kind === 'replay'),
  };
}

function parseArgsStrict(argv: readonly string[]) {
  try {
    return parseArgs({ args: normalizeArgv(argv), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError('invalid_arguments', sanitizeArgumentMessage(error));
  }
}

function normalizeArgv(argv: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    const next = argv[index + 1];
    if (NEGATIVE_VALUE_OPTIONS.has(token) && next !== undefined && NEGATIVE_NUMBER_PATTERN.test(next)) {
      normalized.push(`${token}=${next}`);
      index += 1;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}

/** Node's parse error can quote an `=value`; that value is never echoed back. */
function sanitizeArgumentMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'invalid arguments';
  const sanitized = message.replace(/=([^\s'"]*)/g, '').trim();
  return sanitized.length > 0 ? sanitized : 'invalid arguments';
}

function parseCommand(positionals: readonly string[], flags: StringFlags): Command {
  const [group, subcommand, ...rest] = positionals;
  if (group === undefined) {
    throw usageError('missing_command', 'usage: plasticwan-debug invocation list|get|replay');
  }
  if (group !== 'invocation') {
    throw usageError('unknown_command', 'the only command group is "invocation"');
  }
  switch (subcommand) {
    case 'list':
      return parseList(rest, flags);
    case 'get':
      return parseGet(rest, flags);
    case 'replay':
      return parseReplay(rest, flags);
    case undefined:
      throw usageError('missing_subcommand', 'usage: plasticwan-debug invocation list|get|replay');
    default:
      throw usageError('unknown_subcommand', 'invocation subcommand must be list, get, or replay');
  }
}

function parseList(rest: readonly string[], flags: StringFlags): ListCommand {
  if (rest.length > 0) {
    throw usageError('unexpected_argument', 'invocation list takes no positional arguments');
  }
  rejectUnsupportedFlags(flags, ['system-prompt']);
  return {
    kind: 'list',
    limit: flags.limit === undefined ? undefined : parseLimit(flags.limit),
    cursor: flags.cursor === undefined ? undefined : parseDecimalId(flags.cursor, 'cursor', false),
    state: flags.state === undefined ? undefined : parseState(flags.state),
    chat: flags.chat === undefined ? undefined : parseDecimalId(flags.chat, 'chat', true),
  };
}

function parseGet(rest: readonly string[], flags: StringFlags): GetCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation get requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation get takes exactly one id');
  }
  rejectUnsupportedFlags(flags, ['system-prompt', 'limit', 'cursor', 'state', 'chat']);
  return { kind: 'get', id: parseDecimalId(id, 'id', false) };
}

function parseReplay(rest: readonly string[], flags: StringFlags): ReplayCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation replay requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation replay takes exactly one id');
  }
  rejectUnsupportedFlags(flags, ['limit', 'cursor', 'state', 'chat']);
  return { kind: 'replay', id: parseDecimalId(id, 'id', false), systemPromptSource: flags['system-prompt'] };
}

function rejectUnsupportedFlags(flags: StringFlags, unsupported: readonly (keyof StringFlags)[]): void {
  for (const key of unsupported) {
    if (flags[key] !== undefined) {
      throw usageError('unexpected_option', `--${key} is not valid for this subcommand`);
    }
  }
}

function parseLimit(text: string): number {
  if (!DECIMAL_PATTERN.test(text)) {
    throw usageError('invalid_limit', 'limit must be a decimal integer');
  }
  const limit = Number(text);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw usageError('invalid_limit', `limit must be between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return limit;
}

function parseDecimalId(text: string, label: 'id' | 'cursor' | 'chat', allowNegative: boolean): string {
  const pattern = allowNegative ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
  if (!pattern.test(text)) {
    throw usageError(`invalid_${label}`, `${label} must be a decimal integer`);
  }
  const value = BigInt(text);
  if (value > MAX_SIGNED_64 || value < MIN_SIGNED_64) {
    throw usageError(`invalid_${label}`, `${label} is out of signed 64-bit range`);
  }
  return text;
}

function parseState(text: string): string {
  if (!STATE_PATTERN.test(text)) {
    throw usageError('invalid_state', 'state filter is invalid');
  }
  return text;
}

function parseTimeout(text: string | undefined, replay: boolean): number {
  if (text === undefined) {
    return replay ? DEFAULT_REPLAY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  }
  if (!TIMEOUT_PATTERN.test(text)) {
    throw usageError('invalid_timeout', `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  const timeout = Number(text);
  if (timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw usageError('invalid_timeout', `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  return timeout;
}
