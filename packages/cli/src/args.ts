import { parseArgs } from 'node:util';
import { parseEndpoint } from './client.ts';
import { type Credentials, validateApiKey } from './credentials.ts';
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
  'api-key-stdin': { type: 'boolean' },
  json: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  state: { type: 'string' },
  chat: { type: 'string' },
  source: { type: 'string' },
  variant: { type: 'string' },
  'global-prompt': { type: 'string' },
  'group-prompt': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

// Telegram chat ids are negative; parseArgs would read a separate `-123` token
// as a dangling option, so a negative numeric value is folded into `--opt=-123`.
const NEGATIVE_NUMBER_PATTERN = /^-\d+$/;
const NEGATIVE_VALUE_OPTIONS = new Set(['--chat', '--cursor', '--limit', '--timeout-ms']);

export type ConfigSource = 'active' | 'file';
export type PromptScope = 'global' | 'group';
export type MediaVariant = 'original' | 'preview';

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

export interface PromptsCommand {
  readonly kind: 'prompts';
  readonly id: string;
}

export interface PreflightCommand {
  readonly kind: 'preflight';
  readonly id: string;
}

export interface MediaCommand {
  readonly kind: 'media';
  readonly id: string;
  readonly variant: MediaVariant;
}

export interface ReplayCommand {
  readonly kind: 'replay';
  readonly id: string;
  readonly globalPromptSource: string | undefined;
  readonly groupPromptSource: string | undefined;
}

export interface ConfigShowCommand {
  readonly kind: 'config-show';
  readonly source: ConfigSource | undefined;
}

export interface PromptGetCommand {
  readonly kind: 'prompt-get';
  readonly scope: PromptScope;
  readonly chat: string | undefined;
  readonly source: ConfigSource | undefined;
}

export interface LoginCommand {
  readonly kind: 'login';
  readonly apiKeyStdin: boolean;
}

export interface DoctorCommand {
  readonly kind: 'doctor';
}

export type InvocationCommand =
  | ListCommand
  | GetCommand
  | PromptsCommand
  | PreflightCommand
  | MediaCommand
  | ReplayCommand;
export type CliCommand = InvocationCommand | ConfigShowCommand | PromptGetCommand;
export type Command = CliCommand | LoginCommand | DoctorCommand;
export type CredentialSource = 'argument' | 'environment' | 'file';

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
  readonly credentialSources: { readonly endpoint: CredentialSource; readonly api_key: CredentialSource };
}

interface StringFlags {
  readonly 'api-key-stdin': boolean | undefined;
  readonly source: string | undefined;
  readonly variant: string | undefined;
  readonly 'global-prompt': string | undefined;
  readonly 'group-prompt': string | undefined;
  readonly limit: string | undefined;
  readonly cursor: string | undefined;
  readonly state: string | undefined;
  readonly chat: string | undefined;
}

type FlagName = keyof StringFlags;

const INSPECTION_FLAGS: readonly FlagName[] = [
  'limit',
  'cursor',
  'state',
  'chat',
  'source',
  'variant',
  'global-prompt',
  'group-prompt',
];
const PROMPT_PART_FLAGS: readonly FlagName[] = ['global-prompt', 'group-prompt'];

export function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgsStrict(argv);
  const values = {
    endpoint: parsed.values.endpoint,
    apiKey: parsed.values['api-key'],
    timeout: parsed.values['timeout-ms'],
    json: parsed.values.json === true,
    help: parsed.values.help === true,
    flags: {
      'api-key-stdin': parsed.values['api-key-stdin'],
      source: parsed.values.source,
      variant: parsed.values.variant,
      'global-prompt': parsed.values['global-prompt'],
      'group-prompt': parsed.values['group-prompt'],
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

export function resolveCli(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  saved?: Credentials,
): ResolvedCli {
  const command = parsed.command;
  if (command === undefined) {
    throw usageError('missing_command', 'usage: plasticwan-utils login|doctor|config|prompt|invocation');
  }
  const endpointRaw = parsed.endpointRaw ?? env.PLASTICWAN_ENDPOINT ?? saved?.endpoint;
  if (endpointRaw === undefined || endpointRaw.trim().length === 0) {
    throw usageError('missing_endpoint', 'run plasticwan-utils login or set --endpoint / PLASTICWAN_ENDPOINT');
  }
  const endpoint = parseEndpoint(endpointRaw);
  const explicitKey = parsed.apiKeyRaw ?? env.PLASTICWAN_API_KEY;
  // A saved key belongs to its saved endpoint. An endpoint override alone must
  // never send that key to another service, even if both URLs use HTTPS.
  const savedKey =
    saved !== undefined && parseEndpoint(saved.endpoint).href === endpoint.href ? saved.apiKey : undefined;
  const apiKey = explicitKey ?? savedKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw usageError('missing_api_key', 'run plasticwan-utils login or supply an API key for this endpoint');
  }
  return {
    command,
    endpoint,
    apiKey: validateApiKey(apiKey),
    json: parsed.json,
    timeoutMs: parseTimeout(parsed.timeoutRaw, command.kind === 'replay'),
    credentialSources: {
      endpoint:
        parsed.endpointRaw !== undefined ? 'argument' : env.PLASTICWAN_ENDPOINT !== undefined ? 'environment' : 'file',
      api_key:
        parsed.apiKeyRaw !== undefined ? 'argument' : env.PLASTICWAN_API_KEY !== undefined ? 'environment' : 'file',
    },
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
    throw usageError('missing_command', 'usage: plasticwan-utils login|doctor|config|prompt|invocation');
  }
  if (group === 'login' || group === 'doctor') {
    if (positionals.length !== 1) {
      throw usageError('unexpected_argument', `${group} takes no positional arguments`);
    }
    rejectUnsupportedFlags(flags, INSPECTION_FLAGS);
    if (group === 'doctor') {
      rejectUnsupportedFlags(flags, ['api-key-stdin']);
      return { kind: 'doctor' };
    }
    return { kind: 'login', apiKeyStdin: flags['api-key-stdin'] === true };
  }
  rejectUnsupportedFlags(flags, ['api-key-stdin']);
  switch (group) {
    case 'config':
      return parseConfigShow(subcommand, rest, flags);
    case 'prompt':
      return parsePromptGet(subcommand, rest, flags);
    case 'invocation':
      return parseInvocation(subcommand, rest, flags);
    default:
      throw usageError('unknown_command', 'command must be login, doctor, config, prompt, or invocation');
  }
}

function parseConfigShow(
  subcommand: string | undefined,
  rest: readonly string[],
  flags: StringFlags,
): ConfigShowCommand {
  if (subcommand === undefined) {
    throw usageError('missing_subcommand', 'usage: plasticwan-utils config show');
  }
  if (subcommand !== 'show') {
    throw usageError('unknown_subcommand', 'config subcommand must be show');
  }
  if (rest.length > 0) {
    throw usageError('unexpected_argument', 'config show takes no positional arguments');
  }
  rejectUnsupportedFlags(flags, ['limit', 'cursor', 'state', 'chat', 'variant', ...PROMPT_PART_FLAGS]);
  return { kind: 'config-show', source: parseSource(flags.source) };
}

function parsePromptGet(subcommand: string | undefined, rest: readonly string[], flags: StringFlags): PromptGetCommand {
  if (subcommand === undefined) {
    throw usageError('missing_subcommand', 'usage: plasticwan-utils prompt get global|group');
  }
  if (subcommand !== 'get') {
    throw usageError('unknown_subcommand', 'prompt subcommand must be get');
  }
  const [scope, ...extra] = rest;
  if (scope !== 'global' && scope !== 'group') {
    throw usageError('unknown_subcommand', 'prompt get scope must be global or group');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'prompt get takes exactly one scope');
  }
  rejectUnsupportedFlags(flags, ['limit', 'cursor', 'state', 'variant', ...PROMPT_PART_FLAGS]);
  const source = parseSource(flags.source);
  if (scope === 'global') {
    if (flags.chat !== undefined) {
      throw usageError('unexpected_option', '--chat is only valid for prompt get group');
    }
    return { kind: 'prompt-get', scope, chat: undefined, source };
  }
  if (flags.chat === undefined) {
    throw usageError('missing_argument', 'prompt get group requires --chat <telegram chat id>');
  }
  return { kind: 'prompt-get', scope, chat: parseDecimalId(flags.chat, 'chat', true), source };
}

function parseInvocation(
  subcommand: string | undefined,
  rest: readonly string[],
  flags: StringFlags,
): InvocationCommand {
  switch (subcommand) {
    case 'list':
      return parseList(rest, flags);
    case 'get':
      return parseGet(rest, flags);
    case 'prompts':
      return parseIdOnly('prompts', rest, flags);
    case 'preflight':
      return parseIdOnly('preflight', rest, flags);
    case 'media':
      return parseMedia(rest, flags);
    case 'replay':
      return parseReplay(rest, flags);
    case undefined:
      throw usageError(
        'missing_subcommand',
        'usage: plasticwan-utils invocation list|get|prompts|preflight|media|replay',
      );
    default:
      throw usageError(
        'unknown_subcommand',
        'invocation subcommand must be list, get, prompts, preflight, media, or replay',
      );
  }
}

function parseList(rest: readonly string[], flags: StringFlags): ListCommand {
  if (rest.length > 0) {
    throw usageError('unexpected_argument', 'invocation list takes no positional arguments');
  }
  rejectUnsupportedFlags(flags, ['source', 'variant', ...PROMPT_PART_FLAGS]);
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
  rejectUnsupportedFlags(flags, INSPECTION_FLAGS);
  return { kind: 'get', id: parseDecimalId(id, 'id', false) };
}

function parseIdOnly(
  kind: 'prompts' | 'preflight',
  rest: readonly string[],
  flags: StringFlags,
): PromptsCommand | PreflightCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', `invocation ${kind} requires an invocation id`);
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', `invocation ${kind} takes exactly one id`);
  }
  rejectUnsupportedFlags(flags, INSPECTION_FLAGS);
  return { kind, id: parseDecimalId(id, 'id', false) };
}

function parseMedia(rest: readonly string[], flags: StringFlags): MediaCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation media requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation media takes exactly one id');
  }
  rejectUnsupportedFlags(flags, ['limit', 'cursor', 'state', 'chat', 'source', ...PROMPT_PART_FLAGS]);
  return {
    kind: 'media',
    id: parseDecimalId(id, 'id', false),
    variant: parseVariant(flags.variant),
  };
}

function parseReplay(rest: readonly string[], flags: StringFlags): ReplayCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation replay requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation replay takes exactly one id');
  }
  rejectUnsupportedFlags(flags, ['limit', 'cursor', 'state', 'chat', 'source', 'variant']);
  if (flags['global-prompt'] === '-' && flags['group-prompt'] === '-') {
    throw usageError('conflicting_prompt_input', 'only one of --global-prompt and --group-prompt can read from stdin');
  }
  return {
    kind: 'replay',
    id: parseDecimalId(id, 'id', false),
    globalPromptSource: flags['global-prompt'],
    groupPromptSource: flags['group-prompt'],
  };
}

function rejectUnsupportedFlags(flags: StringFlags, unsupported: readonly FlagName[]): void {
  for (const key of unsupported) {
    if (flags[key] !== undefined) {
      throw usageError('unexpected_option', `--${key} is not valid for this subcommand`);
    }
  }
}

function parseSource(text: string | undefined): ConfigSource | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (text !== 'active' && text !== 'file') {
    throw usageError('invalid_source', 'source must be active or file');
  }
  return text;
}

function parseVariant(text: string | undefined): MediaVariant {
  if (text === undefined || text === 'original') {
    return 'original';
  }
  if (text !== 'preview') {
    throw usageError('invalid_variant', 'variant must be original or preview');
  }
  return text;
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
  // The Admin API parses ids as signed 64-bit integers and echoes them back in
  // canonical decimal (`42`, not `042`), so every caller must address and
  // compare ids in that same form.
  return value.toString();
}

function parseState(text: string): string {
  if (!STATE_PATTERN.test(text)) {
    throw usageError('invalid_state', 'state filter is invalid');
  }
  return text;
}

export function parseTimeout(text: string | undefined, replay: boolean): number {
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
