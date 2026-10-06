import { Buffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type {
  CliCommand,
  ConfigShowCommand,
  GetCommand,
  ListCommand,
  PreflightCommand,
  PromptGetCommand,
  PromptsCommand,
  ReplayCommand,
} from './args.ts';
import { type AdminClient, isRecord } from './client.ts';
import { CliError, usageError } from './errors.ts';
import { runMedia } from './media.ts';

/**
 * `--global-prompt` and `--group-prompt` accept at most 64Ki characters. The
 * byte cap bounds the buffer while reading; the character cap is the contract.
 */
export const MAX_PROMPT_CHARS = 65_536;
const MAX_PROMPT_BYTES = MAX_PROMPT_CHARS * 4;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CommandContext {
  readonly json: boolean;
  readonly io: CliIo;
  readonly timeoutMs: number;
  /** Redacts known secrets from any text the CLI prints or persists. */
  readonly redact: (text: string) => string;
}

export async function executeCommand(
  command: CliCommand,
  context: CommandContext,
  client: AdminClient,
): Promise<number> {
  switch (command.kind) {
    case 'list':
      return await runList(command, context, client);
    case 'get':
      return await runGet(command, context, client);
    case 'prompts':
      return await runPrompts(command, context, client);
    case 'preflight':
      return await runPreflight(command, context, client);
    case 'media':
      return await runMedia(command, context, client);
    case 'replay':
      return await runReplay(command, context, client);
    case 'config-show':
      return await runConfigShow(command, context, client);
    case 'prompt-get':
      return await runPromptGet(command, context, client);
  }
}

async function runList(command: ListCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const query = new URLSearchParams();
  if (command.limit !== undefined) {
    query.set('limit', String(command.limit));
  }
  if (command.cursor !== undefined) {
    query.set('cursor', command.cursor);
  }
  if (command.state !== undefined) {
    query.set('state', command.state);
  }
  if (command.chat !== undefined) {
    query.set('chat', command.chat);
  }
  if (command.search !== undefined) {
    query.set('search', command.search);
  }
  if (command.at !== undefined) {
    query.set('at', command.at);
  }
  if (command.from !== undefined) {
    query.set('from', command.from);
  }
  if (command.to !== undefined) {
    query.set('to', command.to);
  }
  const raw = await client.get('api/invocations', query);
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new CliError('invalid_response', 'invocation list response has an unexpected shape');
  }
  const nextCursor = raw.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new CliError('invalid_response', 'invocation list next_cursor must be a string or null');
  }
  context.io.stdout(context.json ? `${JSON.stringify(raw)}\n` : humanList(raw.items, nextCursor));
  return 0;
}

async function runGet(command: GetCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const raw = await client.get(`api/invocations/${command.id}`);
  if (!isRecord(raw) || typeof raw.id !== 'string') {
    throw new CliError('invalid_response', 'invocation response has an unexpected shape');
  }
  writeDocument(raw, context);
  return 0;
}

async function runPrompts(command: PromptsCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const raw = await client.get(`api/invocations/${command.id}/prompts`);
  if (
    !isRecord(raw) ||
    raw.source !== 'active' ||
    typeof raw.source_invocation_id !== 'string' ||
    typeof raw.global_prompt !== 'string' ||
    typeof raw.group_prompt !== 'string' ||
    raw.core_read_only !== true ||
    !isNullableRecord(raw.template_values)
  ) {
    throw new CliError('invalid_response', 'active prompt response has an unexpected shape');
  }
  writeDocument(raw, context);
  return 0;
}

async function runPreflight(command: PreflightCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const raw = await client.get(`api/invocations/${command.id}/replay-preflight`, preflightQuery(command.beforeSendId));
  if (!isPreflight(raw)) {
    throw new CliError('invalid_response', 'replay preflight response has an unexpected shape');
  }
  writeDocument(raw, context);
  return 0;
}

async function runReplay(command: ReplayCommand, context: CommandContext, client: AdminClient): Promise<number> {
  // Prompt input is fully resolved (including stdin) before any request, so a
  // stalled stdin never sends a preflight the old contract would not have sent.
  // A sliced replay missing --confirm-paid is already refused while parsing
  // arguments, so this path never reads stdin or reaches the preflight either.
  const body: Record<string, string> = {};
  let hasPromptOverrides = false;
  if (command.globalPromptSource !== undefined) {
    body.global_prompt = await readPromptPart('global', command.globalPromptSource, context, false);
    hasPromptOverrides = true;
  }
  if (command.groupPromptSource !== undefined) {
    body.group_prompt = await readPromptPart('group', command.groupPromptSource, context, true);
    hasPromptOverrides = true;
  }
  const preflight = await client.get(
    `api/invocations/${command.id}/replay-preflight`,
    preflightQuery(command.beforeSendId),
  );
  if (!isPreflight(preflight)) {
    throw new CliError('invalid_response', 'replay preflight response has an unexpected shape');
  }
  if (preflight.available !== true) {
    // The preflight reason is the engine's own stable code, so the CLI reports
    // exactly the failure a POST would have produced instead of a new one.
    throw unavailableError(preflight);
  }
  // `before_send_id` selects a replay boundary; it is not a prompt override, so
  // it must not require the prompt-overrides permission.
  if (hasPromptOverrides && preflight.prompt_overrides_available !== true) {
    throw new CliError(
      'replay_prompt_parts_unavailable',
      'this scene cannot replay with prompt overrides (prompt_overrides_available is false)',
    );
  }
  if (command.beforeSendId !== undefined) {
    body.before_send_id = command.beforeSendId;
  }
  const raw = await client.post(`api/invocations/${command.id}/replay`, body);
  if (!isRecord(raw)) {
    throw new CliError('invalid_response', 'replay response has an unexpected shape');
  }
  // Preserve the structured result even on failure; runCli reports the
  // failure through the shared JSON stderr and exit-code path.
  const failed = raw.error !== undefined && raw.error !== null;
  writeDocument(raw, context);
  if (failed) {
    throw new CliError('replay_failed', `replay did not complete: ${describeError(raw.error)}`);
  }
  return 0;
}

async function runConfigShow(
  command: ConfigShowCommand,
  context: CommandContext,
  client: AdminClient,
): Promise<number> {
  const query = new URLSearchParams({ source: command.source ?? 'active' });
  const raw = await client.get('api/config/view', query);
  if (!isRecord(raw) || typeof raw.source !== 'string' || !isRecord(raw.config)) {
    throw new CliError('invalid_response', 'config view response has an unexpected shape');
  }
  writeDocument(raw, context);
  return 0;
}

async function runPromptGet(command: PromptGetCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const query = new URLSearchParams({ source: command.source ?? 'active' });
  if (command.chat !== undefined) {
    query.set('chat', command.chat);
  }
  const raw = await client.get(`api/prompts/${command.scope}`, query);
  if (!isRecord(raw)) {
    throw new CliError('invalid_response', 'prompt response has an unexpected shape');
  }
  if (
    raw.scope !== command.scope ||
    typeof raw.prompt !== 'string' ||
    raw.core_read_only !== true ||
    !isNullableString(raw.chat_id) ||
    typeof raw.source !== 'string'
  ) {
    throw new CliError('invalid_response', `prompt ${command.scope} response has an unexpected shape`);
  }
  writeDocument(raw, context);
  return 0;
}

function writeDocument(raw: object, context: CommandContext): void {
  context.io.stdout(context.json ? `${JSON.stringify(raw)}\n` : `${JSON.stringify(raw, null, 2)}\n`);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableRecord(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value);
}

interface PreflightDocument {
  readonly available: boolean;
  readonly prompt_overrides_available: boolean;
  readonly reason: string | null;
  readonly message: string | null;
}

function isPreflight(value: unknown): value is PreflightDocument {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.available === 'boolean' &&
    typeof value.prompt_overrides_available === 'boolean' &&
    isNullableString(value.reason) &&
    isNullableString(value.message)
  );
}

function unavailableError(preflight: PreflightDocument): CliError {
  const reason = preflight.reason !== null && preflight.reason.length > 0 ? preflight.reason : undefined;
  const message = preflight.message !== null && preflight.message.length > 0 ? preflight.message : undefined;
  return new CliError(reason ?? 'replay_unavailable', message ?? reason ?? 'replay is not available');
}

/** An absent selection keeps the old request URL byte-for-byte. */
function preflightQuery(beforeSendId: string | undefined): URLSearchParams {
  const query = new URLSearchParams();
  if (beforeSendId !== undefined) {
    query.set('before_send_id', beforeSendId);
  }
  return query;
}

function humanList(items: readonly unknown[], nextCursor: string | null): string {
  if (items.length === 0) {
    return 'no invocations\n';
  }
  const lines = items.flatMap((item) => humanListLines(item));
  if (nextCursor !== null) {
    lines.push(`next_cursor: ${nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

function humanListLines(item: unknown): string[] {
  return [humanListLine(item), ...humanMatchedLines(item)];
}

function humanListLine(item: unknown): string {
  if (!isRecord(item)) {
    return '(malformed invocation)';
  }
  const chat = isRecord(item.chat) ? item.chat : undefined;
  const title = typeof chat?.title === 'string' && chat.title.length > 0 ? chat.title : undefined;
  const username = typeof chat?.username === 'string' && chat.username.length > 0 ? chat.username : undefined;
  const chatId =
    chat !== undefined && (typeof chat.telegram_chat_id === 'string' || typeof chat.telegram_chat_id === 'number')
      ? String(chat.telegram_chat_id)
      : '?';
  const thread =
    chat !== undefined && typeof chat.message_thread_id === 'number' && chat.message_thread_id !== 0
      ? `#${chat.message_thread_id}`
      : '';
  const parts = [
    typeof item.id === 'string' ? item.id : '?',
    typeof item.state === 'string' ? item.state : '?',
    typeof item.created_at === 'string' ? item.created_at : '?',
    `${title ?? username ?? 'chat'}(${chatId}${thread})`,
  ];
  if (typeof item.total_tokens === 'number') {
    parts.push(`tokens=${item.total_tokens}`);
  }
  if (typeof item.total_cost === 'number') {
    parts.push(`cost=${item.total_cost}`);
  }
  return parts.join(' ');
}

/** Longest matched-message excerpt kept in the human list; the JSON output is untouched. */
const MAX_MATCH_SUMMARY_CHARS = 160;

/**
 * `matched_messages` describes which messages made a filtered invocation match.
 * It keeps the invocation's own `created_at` as the leading timestamp; a matched
 * message's `at` is never presented as the invocation time.
 */
function humanMatchedLines(item: unknown): string[] {
  if (!isRecord(item) || !Array.isArray(item.matched_messages)) {
    return [];
  }
  const lines: string[] = [];
  for (const entry of item.matched_messages) {
    if (!isRecord(entry)) {
      continue;
    }
    const source = entry.source === 'incoming' || entry.source === 'bot' ? entry.source : undefined;
    if (source === undefined) {
      continue;
    }
    const parts = ['  matched', source];
    if (typeof entry.at === 'string' && entry.at.length > 0) {
      parts.push(entry.at);
    }
    if (typeof entry.telegram_message_id === 'string') {
      parts.push(`msg=${entry.telegram_message_id}`);
    }
    if (typeof entry.telegram_send_id === 'string') {
      parts.push(`send=${entry.telegram_send_id}`);
    }
    const text = matchSummary(entry.text);
    if (text.length > 0) {
      parts.push(text);
    }
    lines.push(parts.join(' '));
  }
  return lines;
}

function matchSummary(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_MATCH_SUMMARY_CHARS ? `${collapsed.slice(0, MAX_MATCH_SUMMARY_CHARS)}…` : collapsed;
}

function describeError(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  try {
    return JSON.stringify(value) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

async function readPromptPart(
  part: 'global' | 'group',
  source: string,
  context: CommandContext,
  allowEmpty: boolean,
): Promise<string> {
  const text = source === '-' ? await readStdinBounded(part, context.timeoutMs) : await readFileBounded(part, source);
  if (!allowEmpty && text.trim().length === 0) {
    throw usageError(`${part}_prompt_empty`, `${part} prompt must not be empty`);
  }
  if (text.length > MAX_PROMPT_CHARS) {
    throw promptTooLarge(part);
  }
  return text;
}

async function readFileBounded(part: 'global' | 'group', path: string): Promise<string> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    throw usageError(`${part}_prompt_read_failed`, `cannot read ${part} prompt file: ${path}`);
  }
  // A FIFO, device or socket passes stat() but can block a plain read forever;
  // only a regular file (or a symlink to one) is a bounded prompt source.
  // ponytail: path-based check; use open(O_NONBLOCK) + fstat if the containing
  // directory is adversarial and a file can be swapped in after stat().
  if (!info.isFile()) {
    throw usageError(`${part}_prompt_read_failed`, `${part} prompt file must be a regular file: ${path}`);
  }
  if (info.size > MAX_PROMPT_BYTES) {
    throw promptTooLarge(part);
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw usageError(`${part}_prompt_read_failed`, `cannot read ${part} prompt file: ${path}`);
  }
  return text;
}

async function readStdinBounded(part: 'global' | 'group', timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw usageError(
      'stdin_required',
      'stdin is a terminal; pipe the prompt or pass --global-prompt/--group-prompt <file>',
    );
  }
  const timer = setTimeout(() => {
    process.stdin.destroy(new CliError('timeout', `stdin timed out after ${timeoutMs}ms; no request was sent`));
  }, timeoutMs);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      if (total > MAX_PROMPT_BYTES) {
        process.stdin.destroy();
        throw promptTooLarge(part);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function promptTooLarge(part: 'global' | 'group'): CliError {
  return usageError(`${part}_prompt_too_large`, promptTooLargeMessage(part));
}

function promptTooLargeMessage(part: 'global' | 'group'): string {
  return `${part} prompt must be at most ${MAX_PROMPT_CHARS} characters`;
}
