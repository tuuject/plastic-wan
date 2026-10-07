import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import { PromptOverrideError, preparePromptOverride } from '../../platform/agent-prompt.ts';
import { type LoadedConfig, loadConfig } from '../../platform/config.ts';
import { readConfigRevision } from '../../platform/config-file.ts';
import type { ConfigApplyResult, ConfigErrorCode, ConfigReloader } from '../../platform/config-reload.ts';
import { asRunResult, type Orm, resolveChatConfig } from '../../store/database.ts';
import {
  getPromptVersion,
  hashPromptContent,
  latestPromptVersion,
  listPromptVersions,
  PROMPT_VERSIONS_RETAINED,
  type PromptScope,
  type PromptVersionRecord,
  recordPromptVersion,
} from '../../store/prompt-versions.ts';
import { chatMigrations } from '../../store/schema.ts';
import { AdminQueryError } from './audit.ts';
import { unifiedPromptDiff } from './prompt-diff.ts';

const CHAT_ID_PATTERN = '^-?[1-9][0-9]{0,18}$';
const MAX_NOTE_CHARS = 200;

const PromptSaveBodySchema = Type.Object(
  {
    prompt: Type.String({ maxLength: 65_536 }),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS })),
  },
  { additionalProperties: false },
);
const PromptRestoreBodySchema = Type.Object(
  { note: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS })) },
  { additionalProperties: false },
);
const PromptCancelBodySchema = Type.Object(
  {
    scope: Type.Union([Type.Literal('global'), Type.Literal('group')]),
    chat_id: Type.Optional(Type.String({ pattern: CHAT_ID_PATTERN })),
  },
  { additionalProperties: false },
);
const promptSaveValidator = Compile(PromptSaveBodySchema);
const promptRestoreValidator = Compile(PromptRestoreBodySchema);
const promptCancelValidator = Compile(PromptCancelBodySchema);

export type PromptSaveBody = Static<typeof PromptSaveBodySchema>;
export type PromptRestoreBody = Static<typeof PromptRestoreBodySchema>;
export type PromptCancelBody = Static<typeof PromptCancelBodySchema>;

export function parsePromptSaveBody(value: unknown): PromptSaveBody {
  if (!promptSaveValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      `Expected a prompt of at most 65536 characters and an optional note of at most ${MAX_NOTE_CHARS} characters`,
    );
  }
  return value;
}

export function parsePromptRestoreBody(value: unknown): PromptRestoreBody {
  if (!promptRestoreValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', `Expected an optional note of at most ${MAX_NOTE_CHARS} characters`);
  }
  return value;
}

export function parsePromptCancelBody(value: unknown): PromptCancelBody {
  if (!promptCancelValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', 'Expected scope and, for the group scope, a chat_id string');
  }
  return value;
}

/** One signed Telegram chat ID from a query parameter, validated like `inspectionQuery`. */
export function parsePromptChatParam(value: string | null): bigint {
  if (value === null || !/^-?[1-9][0-9]{0,18}$/.test(value)) {
    throw new AdminQueryError('invalid_chat', 'chat must be a signed 64-bit decimal ID');
  }
  const chatId = BigInt(value);
  if (chatId < -9_223_203_685_477_580_8n || chatId > 9_223_203_685_477_580_7n) {
    throw new AdminQueryError('invalid_chat', 'chat is out of signed 64-bit range');
  }
  return chatId;
}

export function parsePromptVersionsQuery(url: URL): { scope: 'global' } | { scope: 'group'; chatId: bigint } {
  for (const key of url.searchParams.keys()) {
    if (key !== 'scope' && key !== 'chat') {
      throw new AdminQueryError('invalid_query', 'Unexpected prompt version parameter');
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new AdminQueryError('invalid_query', 'Repeated prompt version parameter');
    }
  }
  const scope = url.searchParams.get('scope');
  if (scope !== 'global' && scope !== 'group') {
    throw new AdminQueryError('invalid_scope', 'scope must be global or group');
  }
  if (scope === 'global') {
    if (url.searchParams.has('chat')) {
      throw new AdminQueryError('invalid_query', 'The global scope takes no chat parameter');
    }
    return { scope };
  }
  return { scope, chatId: parsePromptChatParam(url.searchParams.get('chat')) };
}

export function parsePromptDiffQuery(url: URL): { from: bigint; to: bigint } {
  const parse = (key: string): bigint => {
    const value = url.searchParams.get(key);
    if (value === null || !/^[1-9]\d{0,18}$/.test(value)) {
      throw new AdminQueryError(`invalid_${key}`, `${key} must be a positive 64-bit decimal version ID`);
    }
    return BigInt(value);
  };
  for (const key of url.searchParams.keys()) {
    if (key !== 'from' && key !== 'to') {
      throw new AdminQueryError('invalid_query', 'Prompt diff only accepts from and to parameters');
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new AdminQueryError('invalid_query', 'Repeated prompt diff parameter');
    }
  }
  return { from: parse('from'), to: parse('to') };
}

export function promptVersionView(row: PromptVersionRecord) {
  return {
    id: row.id.toString(),
    scope: row.scope,
    chat_id: row.scope === 'group' ? row.chatId.toString() : null,
    seq: row.seq.toString(),
    content_hash: row.contentHash,
    content_chars: row.content.length,
    source: row.source,
    note: row.note,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

export function promptVersionContentView(row: PromptVersionRecord) {
  return { ...promptVersionView(row), content: row.content };
}

export function promptVersionsView(orm: Orm, scope: PromptScope, chatId: bigint) {
  const items = listPromptVersions(orm, scope, chatId).map(promptVersionView);
  return {
    scope,
    chat_id: scope === 'group' ? chatId.toString() : null,
    retained: Number(PROMPT_VERSIONS_RETAINED),
    current: items.at(0) ?? null,
    items,
  };
}

export function promptDiffView(orm: Orm, fromId: bigint, toId: bigint) {
  const from = getPromptVersion(orm, fromId);
  if (from === undefined) {
    throw new AdminQueryError('version_not_found', 'The from version does not exist', 404);
  }
  const to = getPromptVersion(orm, toId);
  if (to === undefined) {
    throw new AdminQueryError('version_not_found', 'The to version does not exist', 404);
  }
  if (from.scope !== to.scope || from.chatId !== to.chatId) {
    throw new AdminQueryError('diff_scope_mismatch', 'The two versions belong to different prompt scopes', 400);
  }
  return {
    from: promptVersionView(from),
    to: promptVersionView(to),
    hunks: unifiedPromptDiff(from.content, to.content),
  };
}

export interface PromptSaveInput {
  readonly scope: PromptScope;
  readonly chatId: bigint | undefined;
  readonly content: string;
  readonly note: string | undefined;
  readonly source: 'panel' | 'rollback';
  /** SHA-256 of the prompt content the caller last read, from `If-Match`. */
  readonly expectedHash: string;
  readonly username: string;
}

export type PromptSaveResult =
  | { readonly kind: 'unchanged'; readonly latest: PromptVersionRecord | undefined }
  | {
      readonly kind: 'saved';
      readonly version: PromptVersionRecord;
      readonly result: Extract<ConfigApplyResult, { readonly ok: true }>;
      readonly affectedRunning: number;
    }
  | {
      readonly kind: 'apply_failed';
      readonly version: PromptVersionRecord;
      readonly code: ConfigErrorCode;
      readonly message: string;
    };

/**
 * Writes one prompt version: validate, overwrite the prompt file, record the
 * version, then apply the configuration so the next invocation starts under it.
 * The `If-Match` hash pins the file's current comment-stripped content, so a
 * concurrent edit anywhere between the panel's read and this write is refused
 * instead of silently overwritten.
 */
export async function savePromptVersion(
  orm: Orm,
  reloader: ConfigReloader,
  input: PromptSaveInput,
  now = new Date(),
): Promise<PromptSaveResult> {
  const template = validatePromptContent(input.content, input.scope);
  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig(reloader.configPath);
  } catch {
    // Config errors can quote command SecretRefs or arbitrary edited file text.
    throw new AdminQueryError('config_invalid', 'The configuration file cannot be loaded safely', 422);
  }
  const configDir = dirname(reloader.configPath);
  let chatId = 0n;
  let configuredChatId: bigint | undefined;
  let current = loaded.config.agent.system_prompt;
  let promptPath = resolve(configDir, loaded.fileConfig.agent.system_prompt_file);
  let creationRelative: string | undefined;
  let chatIndex = 0;
  if (input.scope === 'group') {
    if (input.chatId === undefined) {
      throw new AdminQueryError('invalid_body', 'chat is required for the group scope', 400);
    }
    const chat = resolveChatConfig(loaded.config, orm, input.chatId);
    if (chat === undefined) {
      throw new AdminQueryError('chat_unconfigured', 'The requested chat is not configured', 404);
    }
    configuredChatId = BigInt(chat.id);
    chatId = configuredChatId;
    current = chat.instructions;
    chatIndex = loaded.fileConfig.telegram.chats.findIndex((entry) => entry.id === chat.id);
    if (chatIndex < 0) {
      // resolveChatConfig found this chat in the same loaded configuration.
      throw new AdminQueryError('chat_unconfigured', 'The requested chat is not configured', 404);
    }
    const fileChat = loaded.fileConfig.telegram.chats[chatIndex];
    if (fileChat !== undefined && fileChat.instructions_file !== undefined) {
      promptPath = resolve(configDir, fileChat.instructions_file);
    } else {
      // Creating the group prompt: a conventional path next to the config file.
      // An existing file there is refused rather than clobbered.
      creationRelative = `prompts/chat-${chat.id}.md`;
      promptPath = join(configDir, creationRelative);
    }
  }
  if (creationRelative !== undefined && template.length === 0) {
    throw new AdminQueryError('prompt_empty', 'This chat has no group prompt; provide content to create one', 400);
  }
  if (hashPromptContent(current) !== input.expectedHash) {
    throw new AdminQueryError(
      'prompt_conflict',
      'The prompt file changed since it was read; reload the prompt and try again',
      409,
    );
  }
  const latest = latestPromptVersion(orm, input.scope, chatId);
  if (current === template) {
    return { kind: 'unchanged', latest };
  }
  if (creationRelative !== undefined) {
    if (await fileExists(promptPath)) {
      throw new AdminQueryError(
        'prompt_file_exists',
        `A file already exists at ${creationRelative}; reference it in the configuration or remove it first`,
        409,
      );
    }
    await mkdir(dirname(promptPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
  } else {
    await assertPromptWritable(promptPath);
  }
  await writePromptFile(promptPath, template);
  const recorded = recordPromptVersion(
    orm,
    input.scope,
    chatId,
    template,
    input.source,
    input.note,
    input.username,
    now,
  );
  const version = recorded ?? latest;
  if (version === undefined) {
    // Deduplication always has a previous version to point at.
    throw new Error('Deduplicated prompt version without a previous version');
  }
  // Applying the config re-reads the prompt files, publishes the new prompt for
  // the next invocation, and rebuilds the affected Conversation Contexts.
  const apply: ConfigApplyResult =
    creationRelative === undefined
      ? await reloader.reloadFromFile()
      : await reloader.writeAndApply(
          [{ path: ['telegram', 'chats', chatIndex, 'instructions_file'], value: creationRelative }],
          await readConfigRevision(reloader.configPath),
        );
  if (!apply.ok) {
    return { kind: 'apply_failed', version, code: apply.code, message: apply.message };
  }
  const affected = affectedRunningInvocations(orm, apply.status.activeHash, input.scope, configuredChatId);
  return { kind: 'saved', version, result: apply, affectedRunning: affected.length };
}

/** Restores one recorded version by writing its content back as a new version. */
export async function restorePromptVersion(
  orm: Orm,
  reloader: ConfigReloader,
  versionId: bigint,
  input: { readonly expectedHash: string; readonly note: string | undefined; readonly username: string },
  now = new Date(),
): Promise<PromptSaveResult> {
  const version = getPromptVersion(orm, versionId);
  if (version === undefined) {
    throw new AdminQueryError('version_not_found', 'The prompt version does not exist', 404);
  }
  // The table CHECK keeps scope to the two literals; narrow it for the input.
  if (version.scope !== 'global' && version.scope !== 'group') {
    throw new AdminQueryError('prompt_invalid', 'The prompt version has an unknown scope', 422);
  }
  return await savePromptVersion(
    orm,
    reloader,
    {
      scope: version.scope,
      chatId: version.scope === 'group' ? version.chatId : undefined,
      content: version.content,
      note: input.note ?? `Restored from version ${version.seq}`,
      source: 'rollback',
      expectedHash: input.expectedHash,
      username: input.username,
    },
    now,
  );
}

export interface AffectedInvocation {
  readonly id: bigint;
  readonly conversationId: bigint;
}

/**
 * Running invocations still under a prompt older than the active one: their
 * `config_hash` is the snapshot they started with, so any hash difference means
 * a prompt they did not start with is now active. Queued invocations take the
 * new prompt when they start and are never affected.
 */
export function affectedRunningInvocations(
  orm: Orm,
  activeHash: string,
  scope: PromptScope,
  configuredChatId: bigint | undefined,
): AffectedInvocation[] {
  let telegramIds: bigint[] | undefined;
  if (scope === 'group') {
    if (configuredChatId === undefined) {
      return [];
    }
    telegramIds = groupTelegramIds(orm, configuredChatId);
    if (telegramIds.length === 0) {
      return [];
    }
  }
  return orm.all<AffectedInvocation>(sql`SELECT i.id AS id, i.conversation_id AS conversation_id
    FROM invocations i
    JOIN conversations v ON v.id = i.conversation_id
    WHERE i.state = 'running' AND i.config_hash <> ${activeHash}${
      telegramIds === undefined
        ? sql``
        : sql` AND v.chat_id IN (SELECT c.id FROM chats c WHERE c.telegram_chat_id IN (${sql.join(
            telegramIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`
    }`);
}

/**
 * Telegram chat IDs whose conversations run under this configured Chat: the
 * configured ID plus the group-migration target, so pre-migration
 * conversations are covered too.
 */
function groupTelegramIds(orm: Orm, configuredChatId: bigint): bigint[] {
  const ids = [configuredChatId];
  const migration = orm
    .select({ newChatId: chatMigrations.newChatId })
    .from(chatMigrations)
    .where(eq(chatMigrations.oldChatId, configuredChatId))
    .get();
  if (migration !== undefined && !ids.includes(migration.newChatId)) {
    ids.push(migration.newChatId);
  }
  return ids;
}

export interface CancelPromptRunningResult {
  readonly expired_buckets: number;
  readonly canceled_invocations: number;
}

/**
 * Cancels only the running invocations affected by a prompt change, unlike the
 * global cancel: collecting and queued buckets stay untouched — they are future
 * invocations and start under the new prompt. Already-sent messages and
 * completed effects are not undone.
 */
export function cancelPromptRunningInvocations(
  orm: Orm,
  scheduler: BucketScheduler | undefined,
  activeHash: string,
  scope: PromptScope,
  configuredChatId: bigint | undefined,
  now = new Date(),
): CancelPromptRunningResult {
  const affected = affectedRunningInvocations(orm, activeHash, scope, configuredChatId);
  if (affected.length === 0) {
    return { expired_buckets: 0, canceled_invocations: 0 };
  }
  const ids = sql.join(
    affected.map((row) => sql`${row.id}`),
    sql`, `,
  );
  const timestamp = now.toISOString();
  // Close the database side first: the aborted runs release their un-injected
  // batches when they stop, and those must already be expired by then.
  const buckets = asRunResult(
    orm.run(sql`UPDATE buckets
     SET state = 'expired', error_code = 'admin_cancel', finished_at = ${timestamp}, updated_at = ${timestamp}
     WHERE state IN ('collecting', 'queued', 'running') AND id IN (
       SELECT ib.bucket_id FROM invocation_buckets ib
       JOIN invocations i ON i.id = ib.invocation_id
       WHERE i.id IN (${ids}) AND ib.injected_at IS NULL AND ib.bucket_id <> i.bucket_id
     )`),
  );
  const canceled = scheduler?.abortInvocations(affected.map((row) => row.id)) ?? 0;
  scheduler?.wake();
  return { expired_buckets: buckets.changes, canceled_invocations: canceled };
}

/** The same validation boundary the replay override and the prompt files share. */
function validatePromptContent(content: string, scope: PromptScope): string {
  try {
    return preparePromptOverride(content, scope);
  } catch (error) {
    if (error instanceof PromptOverrideError) {
      if (error.code === 'replay_prompt_too_large') {
        throw new AdminQueryError('prompt_too_large', error.message, 413);
      }
      if (error.code === 'replay_prompt_empty') {
        throw new AdminQueryError('prompt_empty', error.message, 400);
      }
      throw new AdminQueryError('prompt_invalid', error.message, 400);
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertPromptWritable(promptPath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(promptPath);
  } catch (error) {
    throw new AdminQueryError('prompt_write_failed', `Cannot read the prompt file: ${messageOf(error)}`, 500);
  }
  if (info.isSymbolicLink()) {
    // The rename below would replace the link itself with a regular file,
    // silently detaching the prompt file the operator thinks they edit.
    throw new AdminQueryError('prompt_symlink', `The prompt file must not be a symbolic link: ${promptPath}`, 409);
  }
}

async function writePromptFile(promptPath: string, content: string): Promise<void> {
  const temporary = join(
    dirname(promptPath),
    `.${basename(promptPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, promptPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new AdminQueryError('prompt_write_failed', `Cannot write the prompt file: ${messageOf(error)}`, 500);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
