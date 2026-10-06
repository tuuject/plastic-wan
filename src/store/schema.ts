import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * SQLite INTEGER column that maps to TypeScript `bigint`.
 *
 * drizzle's SQLite dialect has no built-in bigint mode, so this custom type
 * keeps the project invariant that SQLite row IDs and Telegram IDs are
 * `bigint` on both read and write. `better-sqlite3` accepts bigint bindings
 * natively; `fromDriver` also coerces plain numbers so the layer stays correct
 * regardless of the driver's safeIntegers setting.
 */
export const sqliteBigInt = customType<{ data: bigint; driverData: bigint | number }>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => BigInt(value),
});

/**
 * `sqliteBigInt` for INTEGER PRIMARY KEY columns. SQLite assigns rowids to
 * these columns automatically, so inserts may omit the value; the `default`
 * marker teaches drizzle's insert types that the column is optional. It never
 * emits a DEFAULT clause at runtime.
 */
export const sqliteBigIntId = customType<{
  data: bigint;
  driverData: bigint | number;
  default: true;
}>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => BigInt(value),
});

/**
 * Drizzle schema for the Plastic Wan SQLite database.
 *
 * The authoritative DDL lives in `src/migrations/*.sql`. This file is the
 * typed query-layer mapping for drizzle-orm: table and column names must
 * match the migration end state exactly. When you add a migration, update
 * this file in the same change and keep both in sync.
 *
 * Conventions:
 * - INTEGER identity/reference/count columns use `sqliteBigInt`; SQLite row
 *   IDs are `bigint` everywhere in this codebase.
 * - 0/1 flag columns use `integer(..., { mode: 'boolean' })`.
 * - The `sticker_search` FTS5 virtual table is intentionally not declared
 *   here; drizzle cannot express virtual tables. Query it through `sql`
 *   templates.
 * - WITHOUT ROWID tables are declared with composite primary keys only;
 *   the rowid setting itself stays in the SQL migrations.
 */

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: sqliteBigIntId('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramUpdates = sqliteTable(
  'telegram_updates',
  {
    updateId: sqliteBigIntId('update_id').primaryKey(),
    chatId: sqliteBigInt('chat_id'),
    chatType: text('chat_type'),
    receivedAt: text('received_at').notNull(),
    allowed: integer('allowed', { mode: 'boolean' }).notNull(),
    rejectionReason: text('rejection_reason'),
    rawJson: text('raw_json'),
  },
  () => [
    check(
      'telegram_updates_allowed_raw_json',
      sql`(allowed = 1 AND raw_json IS NOT NULL) OR (allowed = 0 AND raw_json IS NULL)`,
    ),
  ],
);

export const chats = sqliteTable('chats', {
  id: sqliteBigIntId('id').primaryKey(),
  telegramChatId: sqliteBigInt('telegram_chat_id').notNull().unique(),
  canonicalChatId: sqliteBigInt('canonical_chat_id').notNull(),
  type: text('type').notNull(),
  title: text('title'),
  username: text('username'),
  updatedAt: text('updated_at').notNull(),
});

export const chatMigrations = sqliteTable('chat_migrations', {
  oldChatId: sqliteBigIntId('old_chat_id').primaryKey(),
  newChatId: sqliteBigInt('new_chat_id').notNull().unique(),
  receivedAt: text('received_at').notNull(),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageThreadId: sqliteBigInt('message_thread_id').notNull().default(0n),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('conversations_chat_thread_unique').on(t.chatId, t.messageThreadId)],
);

export const senders = sqliteTable(
  'senders',
  {
    id: sqliteBigIntId('id').primaryKey(),
    telegramType: text('telegram_type').notNull(),
    telegramId: sqliteBigInt('telegram_id').notNull(),
    displayName: text('display_name').notNull(),
    username: text('username'),
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('senders_telegram_type_check', sql`telegram_type IN ('user', 'sender_chat')`),
    uniqueIndex('senders_telegram_type_id_unique').on(t.telegramType, t.telegramId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    telegramMessageId: sqliteBigInt('telegram_message_id').notNull(),
    currentRevisionId: sqliteBigInt('current_revision_id').references((): AnySQLiteColumn => messageRevisions.id),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    sentByBot: integer('sent_by_bot', { mode: 'boolean' }).notNull().default(false),
    telegramDate: text('telegram_date').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (t) => [uniqueIndex('messages_chat_telegram_unique').on(t.chatId, t.telegramMessageId)],
);

export const messageRevisions = sqliteTable(
  'message_revisions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revisionNo: sqliteBigInt('revision_no').notNull(),
    senderId: sqliteBigInt('sender_id'),
    kind: text('kind').notNull(),
    text: text('text'),
    caption: text('caption'),
    replyToMessageId: sqliteBigInt('reply_to_message_id'),
    replySnapshotJson: text('reply_snapshot_json'),
    forwardOriginJson: text('forward_origin_json'),
    mediaGroupId: text('media_group_id'),
    serviceJson: text('service_json'),
    createdAt: text('created_at').notNull(),
    rawFragmentJson: text('raw_fragment_json').notNull(),
  },
  (t) => [uniqueIndex('message_revisions_message_revision_unique').on(t.messageId, t.revisionNo)],
);

export const media = sqliteTable(
  'media',
  {
    id: sqliteBigIntId('id').primaryKey(),
    revisionId: sqliteBigInt('revision_id')
      .notNull()
      .references(() => messageRevisions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileSize: sqliteBigInt('file_size'),
    width: sqliteBigInt('width'),
    height: sqliteBigInt('height'),
    telegramJson: text('telegram_json').notNull(),
  },
  (t) => [
    check('media_kind_check', sql`kind IN ('photo', 'document', 'sticker')`),
    index('media_revision_idx').on(t.revisionId),
    index('media_unique_idx').on(t.fileUniqueId),
  ],
);

export const buckets = sqliteTable(
  'buckets',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    kind: text('kind').notNull().default('realtime'),
    firstReceivedAt: text('first_received_at').notNull(),
    deadlineAt: text('deadline_at').notNull(),
    queuedAt: text('queued_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    mergedIntoBucketId: sqliteBigInt('merged_into_bucket_id').references((): AnySQLiteColumn => buckets.id),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check(
      'buckets_state_check',
      sql`state IN ('collecting', 'queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')`,
    ),
    check('buckets_kind_check', sql`kind IN ('realtime', 'startup_catch_up')`),
    uniqueIndex('one_collecting_bucket_per_conversation').on(t.conversationId).where(sql`state = 'collecting'`),
    index('buckets_schedule_idx').on(t.state, t.deadlineAt, t.id),
  ],
);

export const bucketMessages = sqliteTable(
  'bucket_messages',
  {
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id, { onDelete: 'cascade' }),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    sourceBucketId: sqliteBigInt('source_bucket_id'),
  },
  (t) => [
    primaryKey({ columns: [t.bucketId, t.messageId] }),
    uniqueIndex('bucket_messages_bucket_sequence_unique').on(t.bucketId, t.sequenceNo),
  ],
);

export const invocations = sqliteTable(
  'invocations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id),
    state: text('state').notNull(),
    configHash: text('config_hash').notNull(),
    promptVersion: sqliteBigInt('prompt_version').notNull(),
    toolRegistryHash: text('tool_registry_hash'),
    toolRegistryJson: text('tool_registry_json'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    completionReason: text('completion_reason'),
    errorCode: text('error_code'),
    sendsUsed: sqliteBigInt('sends_used').notNull().default(0n),
    toolCallsUsed: sqliteBigInt('tool_calls_used').notNull().default(0n),
    turnsUsed: sqliteBigInt('turns_used').notNull().default(0n),
    sideEffectStarted: integer('side_effect_started', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check(
      'invocations_state_check',
      sql`state IN ('queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')`,
    ),
    uniqueIndex('one_running_invocation_per_conversation').on(t.conversationId).where(sql`state = 'running'`),
    index('invocations_queue_idx').on(t.state, t.id),
  ],
);

export const invocationMessages = sqliteTable(
  'invocation_messages',
  {
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id),
    revisionId: sqliteBigInt('revision_id')
      .notNull()
      .references(() => messageRevisions.id),
    section: text('section').notNull(),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    sourceBucketId: sqliteBigInt('source_bucket_id'),
    omittedBefore: sqliteBigInt('omitted_before').notNull().default(0n),
    snapshotJson: text('snapshot_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.invocationId, t.sequenceNo] }),
    check('invocation_messages_section_check', sql`section IN ('history', 'new')`),
  ],
);

export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'cascade',
    }),
    mediaAnalysisId: sqliteBigInt('media_analysis_id'),
    role: text('role').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    attempt: sqliteBigInt('attempt').notNull(),
    state: text('state').notNull(),
    inputTokens: sqliteBigInt('input_tokens'),
    outputTokens: sqliteBigInt('output_tokens'),
    cacheReadTokens: sqliteBigInt('cache_read_tokens'),
    cacheWriteTokens: sqliteBigInt('cache_write_tokens'),
    totalTokens: sqliteBigInt('total_tokens'),
    cost: real('cost'),
    durationMs: sqliteBigInt('duration_ms'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    toolsJson: text('tools_json'),
    requestJson: text('request_json'),
    responseJson: text('response_json'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('model_calls_invocation_idx').on(t.invocationId),
    check('model_calls_role_check', sql`role IN ('agent', 'vision_chat', 'vision_sticker', 'doctor')`),
    check(
      'model_calls_state_check',
      sql`state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')`,
    ),
  ],
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    role: text('role').notNull(),
    text: text('text').notNull(),
    thinkingText: text('thinking_text').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('agent_messages_role_check', sql`role IN ('assistant', 'tool_result', 'harness_nudge')`),
    uniqueIndex('agent_messages_invocation_sequence_unique').on(t.invocationId, t.sequenceNo),
    check('agent_messages_thinking_empty_check', sql`thinking_text = ''`),
  ],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull().unique(),
    toolName: text('tool_name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    resultText: text('result_text'),
    state: text('state').notNull(),
    sideEffect: integer('side_effect', { mode: 'boolean' }).notNull(),
    errorCode: text('error_code'),
    durationMs: sqliteBigInt('duration_ms'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('tool_calls_invocation_idx').on(t.invocationId),
    check('tool_calls_state_check', sql`state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')`),
  ],
);

export const telegramSends = sqliteTable(
  'telegram_sends',
  {
    id: sqliteBigIntId('id').primaryKey(),
    toolCallId: sqliteBigInt('tool_call_id')
      .notNull()
      .references(() => toolCalls.id),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id),
    kind: text('kind').notNull(),
    requestJson: text('request_json').notNull(),
    state: text('state').notNull(),
    telegramMessageId: sqliteBigInt('telegram_message_id'),
    responseJson: text('response_json'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('telegram_sends_image_delivery_idx')
      .on(table.conversationId, sql`json_extract(${table.requestJson}, '$.generation_id')`)
      .where(sql`${table.kind} = 'image'`),
    check('telegram_sends_kind_check', sql`kind IN ('text', 'sticker', 'image')`),
    check('telegram_sends_state_check', sql`state IN ('pending', 'success', 'error', 'outcome_unknown')`),
  ],
);

export const mediaAnalyses = sqliteTable(
  'media_analyses',
  {
    id: sqliteBigIntId('id').primaryKey(),
    fileUniqueId: text('file_unique_id').notNull(),
    analysisVersion: text('analysis_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: sqliteBigInt('prompt_version').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    description: text('description'),
    metadataJson: text('metadata_json'),
    expiresAt: text('expires_at'),
    failureCount: sqliteBigInt('failure_count').notNull().default(0n),
    nextRetryAt: text('next_retry_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('media_analyses_kind_check', sql`kind IN ('image', 'sticker')`),
    check('media_analyses_state_check', sql`state IN ('pending', 'success', 'error')`),
    uniqueIndex('media_analyses_file_version_unique').on(t.fileUniqueId, t.analysisVersion),
  ],
);

export const stickerSets = sqliteTable(
  'sticker_sets',
  {
    id: sqliteBigIntId('id').primaryKey(),
    alias: text('alias').notNull().unique(),
    telegramName: text('telegram_name').notNull().unique(),
    title: text('title'),
    configured: integer('configured', { mode: 'boolean' }).notNull().default(true),
    syncState: text('sync_state').notNull().default('pending'),
    lastSyncedAt: text('last_synced_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [check('sticker_sets_sync_state_check', sql`sync_state IN ('pending', 'running', 'success', 'error')`)],
);

export const stickers = sqliteTable(
  'stickers',
  {
    id: sqliteBigIntId('id').primaryKey(),
    stickerSetId: sqliteBigInt('sticker_set_id')
      .notNull()
      .references(() => stickerSets.id, { onDelete: 'cascade' }),
    fileUniqueId: text('file_unique_id').notNull().unique(),
    fileId: text('file_id').notNull(),
    emoji: text('emoji'),
    format: text('format').notNull(),
    thumbnailJson: text('thumbnail_json'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    currentAnalysisId: sqliteBigInt('current_analysis_id').references(() => mediaAnalyses.id),
    indexState: text('index_state').notNull().default('pending'),
    failureCount: sqliteBigInt('failure_count').notNull().default(0n),
    nextRetryAt: text('next_retry_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('stickers_format_check', sql`format IN ('static', 'animated', 'video')`),
    check('stickers_index_state_check', sql`index_state IN ('pending', 'running', 'success', 'error')`),
    index('stickers_index_queue_idx').on(t.active, t.indexState, t.nextRetryAt, t.id),
  ],
);

export const dailyUsage = sqliteTable(
  'daily_usage',
  {
    utcDate: text('utc_date').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    metric: text('metric').notNull(),
    amount: sqliteBigInt('amount').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.utcDate, t.scope, t.resource, t.metric] })],
);

export const mcpServerState = sqliteTable(
  'mcp_server_state',
  {
    alias: text('alias').primaryKey(),
    state: text('state').notNull(),
    registryHash: text('registry_hash'),
    reconnectAttempt: sqliteBigInt('reconnect_attempt').notNull().default(0n),
    nextReconnectAt: text('next_reconnect_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [check('mcp_server_state_check', sql`state IN ('starting', 'ready', 'degraded', 'stopped')`)],
);

export const adminUsers = sqliteTable('admin_users', {
  id: sqliteBigIntId('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastLoginAt: text('last_login_at'),
});

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    userId: sqliteBigInt('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [index('admin_sessions_expiry_idx').on(t.expiresAt)],
);

/**
 * Programmatic Admin API keys. `token_hash` is the SHA-256 digest of the
 * plaintext `pwk_` key, which is shown once at creation and never stored;
 * `prefix` is display-only metadata for the panel.
 */
export const adminApiKeys = sqliteTable('admin_api_keys', {
  id: sqliteBigIntId('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('memories_content_length_check', sql`length(content) BETWEEN 1 AND 150`),
    check('memories_expiry_check', sql`expires_at > created_at`),
    index('memories_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('memories_expiry_idx').on(t.expiresAt),
  ],
);

export const chatPause = sqliteTable('chat_pause', {
  chatId: sqliteBigIntId('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),
  pausedAt: text('paused_at').notNull(),
});

export const conversationContextCutoffs = sqliteTable('conversation_context_cutoffs', {
  conversationId: sqliteBigIntId('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  telegramMessageId: sqliteBigInt('telegram_message_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Post-trigger attention window, at most one row per conversation. While
 * `expiresAt` is in the future the conversation keeps starting invocations
 * even though its chat is outside every scheduled active period.
 */
export const conversationAttention = sqliteTable(
  'conversation_attention',
  {
    conversationId: sqliteBigIntId('conversation_id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    expiresAt: text('expires_at').notNull(),
    triggeredAt: text('triggered_at').notNull(),
    triggerKind: text('trigger_kind').notNull(),
    triggerTelegramMessageId: sqliteBigInt('trigger_telegram_message_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('conversation_attention_trigger_kind_check', sql`trigger_kind IN ('mention', 'reply_to_bot', 'keyword')`),
    index('conversation_attention_expiry_idx').on(t.expiresAt),
  ],
);

export const longTasks = sqliteTable(
  'long_tasks',
  {
    id: sqliteBigIntId('id').primaryKey(),
    pluginId: text('plugin_id').notNull(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdByInvocationId: sqliteBigInt('created_by_invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    createdByUserId: sqliteBigInt('created_by_user_id'),
    payloadJson: text('payload_json').notNull(),
    state: text('state').notNull(),
    scheduledAt: text('scheduled_at'),
    timerResultJson: text('timer_result_json'),
    deliveryJson: text('delivery_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    check('long_tasks_state_check', sql`state IN ('waiting', 'completed', 'failed', 'cancelled')`),
    check(
      'long_tasks_payload_json_check',
      sql`json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 16384`,
    ),
    check(
      'long_tasks_timer_result_json_check',
      sql`timer_result_json IS NULL OR (json_valid(timer_result_json) AND length(CAST(timer_result_json AS BLOB)) <= 16384)`,
    ),
    check(
      'long_tasks_delivery_json_check',
      sql`json_valid(delivery_json) AND length(CAST(delivery_json AS BLOB)) <= 4096`,
    ),
    check('long_tasks_timer_pair_check', sql`(scheduled_at IS NULL) = (timer_result_json IS NULL)`),
    index('long_tasks_schedule_idx')
      .on(t.state, t.scheduledAt, t.id)
      .where(sql`state = 'waiting' AND scheduled_at IS NOT NULL`),
    index('long_tasks_plugin_conversation_idx').on(t.pluginId, t.conversationId, t.createdAt, t.id),
    index('long_tasks_created_by_inv_idx').on(t.createdByInvocationId),
  ],
);

export const taskReceipts = sqliteTable(
  'task_receipts',
  {
    taskId: sqliteBigInt('task_id')
      .primaryKey()
      .references(() => longTasks.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    resultJson: text('result_json'),
    errorJson: text('error_json'),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    claimedAt: text('claimed_at'),
    handledAt: text('handled_at'),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    bucketId: sqliteBigInt('bucket_id').references(() => buckets.id, { onDelete: 'set null' }),
    invocationOutcome: text('invocation_outcome'),
    completionReason: text('completion_reason'),
    cancelledAt: text('cancelled_at'),
    cancelledBy: text('cancelled_by'),
    adminCancelled: integer('admin_cancelled', { mode: 'boolean' }).notNull().default(false),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    check('task_receipts_status_check', sql`status IN ('completed', 'failed', 'cancelled')`),
    check('task_receipts_state_check', sql`state IN ('pending', 'claimed', 'handled', 'suppressed')`),
    check('task_receipts_admin_cancelled_check', sql`admin_cancelled IN (0, 1)`),
    check(
      'task_receipts_result_json_check',
      sql`result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 16384)`,
    ),
    check(
      'task_receipts_error_json_check',
      sql`error_json IS NULL OR (json_valid(error_json) AND length(CAST(error_json AS BLOB)) <= 8192)`,
    ),
    check(
      'task_receipts_content_check',
      sql`(status = 'completed' AND error_json IS NULL) OR (status = 'failed' AND result_json IS NULL) OR (status = 'cancelled' AND result_json IS NULL AND error_json IS NULL)`,
    ),
    index('task_receipts_invocation_idx').on(t.invocationId),
    uniqueIndex('task_receipts_bucket_unique').on(t.bucketId).where(sql`bucket_id IS NOT NULL`),
    index('task_receipts_delivery_idx').on(t.state, t.createdAt, t.taskId).where(sql`state = 'pending'`),
  ],
);

/**
 * One persistent canonical history per Conversation. `head_seq` is the first
 * retained row after discard-only GC; `next_seq` is the next free row. The
 * agent transcript is seeded from `context_messages` and written back to it, so
 * continuity survives process restarts and agent-cache eviction.
 */
export const conversationContexts = sqliteTable('conversation_contexts', {
  id: sqliteBigIntId('id').primaryKey(),
  conversationId: sqliteBigInt('conversation_id')
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  headSeq: sqliteBigInt('head_seq').notNull().default(1n),
  nextSeq: sqliteBigInt('next_seq').notNull().default(1n),
  sendCountTotal: sqliteBigInt('send_count_total').notNull().default(0n),
  systemPromptHash: text('system_prompt_hash').notNull(),
  activeInvocationId: sqliteBigInt('active_invocation_id').references(() => invocations.id, { onDelete: 'set null' }),
  lastActiveAt: text('last_active_at').notNull(),
  lastGcAt: text('last_gc_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const contextMessages = sqliteTable(
  'context_messages',
  {
    contextId: sqliteBigInt('context_id')
      .notNull()
      .references(() => conversationContexts.id, { onDelete: 'cascade' }),
    seq: sqliteBigInt('seq').notNull(),
    role: text('role').notNull(),
    payloadJson: text('payload_json').notNull(),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, { onDelete: 'set null' }),
    isCheckpoint: integer('is_checkpoint', { mode: 'boolean' }).notNull().default(false),
    sendSeq: sqliteBigInt('send_seq'),
    estTokens: sqliteBigInt('est_tokens').notNull(),
    evictedAt: text('evicted_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.seq] }),
    check('context_messages_role_check', sql`role IN ('user', 'assistant', 'toolResult')`),
    index('context_messages_checkpoint_idx').on(t.contextId, t.isCheckpoint, t.seq),
    index('context_messages_evicted_idx').on(t.evictedAt),
  ],
);

/**
 * Capability references scoped to a Conversation Context with a TTL, so a
 * reference quoted in retained history stays usable across invocations.
 * `sourceSeq` is the context message that carried the reference.
 */
export const contextRefs = sqliteTable(
  'context_refs',
  {
    contextId: sqliteBigInt('context_id')
      .notNull()
      .references(() => conversationContexts.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    sourceSeq: sqliteBigInt('source_seq').notNull(),
    mediaId: sqliteBigInt('media_id').references(() => media.id, { onDelete: 'cascade' }),
    stickerFileId: text('sticker_file_id'),
    targetConversationId: sqliteBigInt('target_conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    targetThreadId: sqliteBigInt('target_thread_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.ref] }),
    check('context_refs_kind_check', sql`kind IN ('media', 'sticker', 'reply')`),
    index('context_refs_expiry_idx').on(t.expiresAt),
  ],
);

/** Bucket-to-invocation join: one long-lived invocation may consume many buckets. */
export const invocationBuckets = sqliteTable(
  'invocation_buckets',
  {
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id, { onDelete: 'cascade' }),
    attachedAt: text('attached_at').notNull(),
    injectedAt: text('injected_at'),
  },
  (t) => [primaryKey({ columns: [t.invocationId, t.bucketId] }), index('invocation_buckets_bucket_idx').on(t.bucketId)],
);

// ---------------------------------------------------------------------------
// Image generation domain (from @plasticwan/image-service)
//
// The image-domain tables are defined in the private image-service package and
// aggregated here so host-side queries (Admin audit, future plugins) see one
// schema. The authoritative DDL is migration 024; the package's definitions
// must stay in sync with it. Host IDs stay bigint (`sqliteBigInt`); image
// tables use text UUIDs with `safeInteger` counters inside the package.
// ---------------------------------------------------------------------------
export {
  generationAttempts as imageGenerationAttempts,
  generations as imageGenerations,
  idempotencyKeys as imageIdempotencyKeys,
  images as imageAssets,
  prompts as imagePrompts,
} from '@plasticwan/image-service';
