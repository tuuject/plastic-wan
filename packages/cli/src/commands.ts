import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import type { Command, GetCommand, ListCommand, ReplayCommand } from './args.ts';
import { type AdminClient, isRecord } from './client.ts';
import { CliError, usageError } from './errors.ts';

/**
 * `--system-prompt` accepts at most 64Ki characters. The byte cap bounds the
 * buffer while reading; the character cap is the actual contract.
 */
export const MAX_SYSTEM_PROMPT_CHARS = 65_536;
const MAX_SYSTEM_PROMPT_BYTES = MAX_SYSTEM_PROMPT_CHARS * 4;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CommandContext {
  readonly json: boolean;
  readonly io: CliIo;
  readonly timeoutMs: number;
}

export async function executeCommand(command: Command, context: CommandContext, client: AdminClient): Promise<number> {
  switch (command.kind) {
    case 'list':
      return await runList(command, context, client);
    case 'get':
      return await runGet(command, context, client);
    case 'replay':
      return await runReplay(command, context, client);
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
  context.io.stdout(context.json ? `${JSON.stringify(raw)}\n` : `${JSON.stringify(raw, null, 2)}\n`);
  return 0;
}

async function runReplay(command: ReplayCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const body: Record<string, unknown> = {};
  if (command.systemPromptSource !== undefined) {
    body.system_prompt = await readSystemPrompt(command.systemPromptSource, context.timeoutMs);
  }
  const raw = await client.post(`api/invocations/${command.id}/replay`, body);
  if (!isRecord(raw)) {
    throw new CliError('invalid_response', 'replay response has an unexpected shape');
  }
  // Preserve the structured result even on failure; runCli reports the
  // failure through the shared JSON stderr and exit-code path.
  const failed = raw.error !== undefined && raw.error !== null;
  context.io.stdout(context.json ? `${JSON.stringify(raw)}\n` : `${JSON.stringify(raw, null, 2)}\n`);
  if (failed) {
    throw new CliError('replay_failed', `replay did not complete: ${describeError(raw.error)}`);
  }
  return 0;
}

function humanList(items: readonly unknown[], nextCursor: string | null): string {
  if (items.length === 0) {
    return 'no invocations\n';
  }
  const lines = items.map((item) => humanListLine(item));
  if (nextCursor !== null) {
    lines.push(`next_cursor: ${nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
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

async function readSystemPrompt(source: string, timeoutMs: number): Promise<string> {
  const text = source === '-' ? await readStdinBounded(timeoutMs) : await readFileBounded(source);
  if (text.trim().length === 0) {
    throw usageError('system_prompt_empty', 'system prompt must not be empty');
  }
  if (text.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw systemPromptTooLarge();
  }
  return text;
}

async function readFileBounded(path: string): Promise<string> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw usageError('system_prompt_read_failed', `cannot read system prompt file: ${path}`);
  }
  if (size > MAX_SYSTEM_PROMPT_BYTES) {
    throw systemPromptTooLarge();
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw usageError('system_prompt_read_failed', `cannot read system prompt file: ${path}`);
  }
  return text;
}

async function readStdinBounded(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw usageError('stdin_required', 'stdin is a terminal; pipe the prompt or pass --system-prompt <file>');
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
      if (total > MAX_SYSTEM_PROMPT_BYTES) {
        process.stdin.destroy();
        throw systemPromptTooLarge();
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function systemPromptTooLarge(): CliError {
  return usageError('system_prompt_too_large', `system prompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters`);
}
