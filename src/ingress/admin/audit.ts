import { and, desc, eq, gte, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Orm } from '../../store/database.ts';
import {
  agentMessages,
  chats,
  contextMessages,
  contextRefs,
  conversationContexts,
  conversations,
  dailyUsage,
  invocationMessages,
  media,
  mediaAnalyses,
  messageRevisions,
  messages,
  modelCalls,
  senders,
  telegramSends,
  toolCalls,
} from '../../store/schema.ts';
import { meteredTokens, storedSleepUntil } from '../../store/sleep.ts';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_SEARCH_LENGTH = 100;
/** Payload previews are truncated so one huge transcript row cannot bloat the API response. */
const MAX_PAYLOAD_PREVIEW_LENGTH = 2_000;

const num = (value: unknown): number | null => (value === null ? null : Number(value));
const bit = (value: unknown): boolean => value === 1n;

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ListQuery {
  readonly limit?: string | null;
  readonly cursor?: string | null;
  readonly state?: string | null;
  readonly chat?: string | null;
  readonly set?: string | null;
  readonly search?: string | null;
  readonly target?: string | null;
}

export class AdminQueryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface PausedChatRow {
  readonly telegram_chat_id: bigint;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
  readonly paused_at: string;
}

interface InvocationListRow {
  readonly id: bigint;
  readonly state: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: bigint;
  readonly tool_calls_used: bigint;
  readonly turns_used: bigint;
  readonly side_effect_started: bigint;
  readonly config_hash: string;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly chat_username: string | null;
  readonly message_thread_id: bigint;
  readonly tool_call_count: bigint;
  /**
   * Tokens this invocation consumed under the daily-budget definition
   * (`meteredTokens`): input, output, cache read and cache write. The cache
   * counters are also reported on their own as a breakdown of this total.
   */
  readonly total_tokens: bigint;
  readonly cache_read_tokens: bigint;
  readonly cache_write_tokens: bigint;
  readonly total_cost: number | null;
}

interface InvocationDetailRow extends InvocationListRow {
  readonly prompt_version: bigint;
  readonly tool_registry_hash: string | null;
  readonly tool_registry_json: string | null;
  readonly bucket_id: bigint;
}

interface MessageListRow {
  readonly id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: bigint;
  readonly sent_by_bot: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
  readonly revision_no: bigint | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly media_group_id: string | null;
  readonly sender_display_name: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_telegram_type: string | null;
  readonly sender_username: string | null;
  readonly sender_is_bot: bigint | null;
  readonly revision_count: bigint;
  readonly media_count: bigint;
}

interface StickerSetRow {
  readonly id: bigint;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
  readonly configured: bigint;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly error_code: string | null;
  readonly updated_at: string;
  readonly sticker_count: bigint;
  readonly indexed_count: bigint;
  readonly pending_count: bigint;
  readonly error_count: bigint;
}

interface StickerRow {
  readonly id: bigint;
  readonly set_alias: string;
  readonly file_unique_id: string;
  readonly emoji: string | null;
  readonly format: string;
  readonly active: bigint;
  readonly index_state: string;
  readonly failure_count: bigint;
  readonly next_retry_at: string | null;
  readonly updated_at: string;
  readonly analysis_id: bigint | null;
  readonly analysis_state: string | null;
  readonly analysis_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: bigint | null;
  readonly description: string | null;
  readonly metadata_json: string | null;
  readonly analysis_updated_at: string | null;
}

interface CountRow {
  readonly label: string;
  readonly count: bigint;
}

interface ConversationContextRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
  readonly head_seq: bigint;
  readonly next_seq: bigint;
  readonly send_count_total: bigint;
  readonly system_prompt_hash: string;
  readonly last_active_at: string;
  readonly last_gc_at: string | null;
  readonly active_invocation_id: bigint | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly message_count: bigint;
}

interface ConversationContextCursor {
  readonly lastActiveAt: string;
  readonly id: bigint;
}

const CONTEXT_FIELDS = {
  id: conversationContexts.id,
  conversation_id: conversationContexts.conversationId,
  telegram_chat_id: chats.telegramChatId,
  chat_type: chats.type,
  chat_title: chats.title,
  message_thread_id: conversations.messageThreadId,
  head_seq: conversationContexts.headSeq,
  next_seq: conversationContexts.nextSeq,
  send_count_total: conversationContexts.sendCountTotal,
  system_prompt_hash: conversationContexts.systemPromptHash,
  last_active_at: conversationContexts.lastActiveAt,
  last_gc_at: conversationContexts.lastGcAt,
  active_invocation_id: conversationContexts.activeInvocationId,
  created_at: conversationContexts.createdAt,
  updated_at: conversationContexts.updatedAt,
  message_count: sql<bigint>`(SELECT COUNT(*) FROM context_messages cm WHERE cm.context_id = ${conversationContexts.id} AND cm.seq >= ${conversationContexts.headSeq})`,
};

/** Recently active first; the cursor carries the same pair so paging stays stable. */
export function listConversationContexts(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  const chatId = optionalFilter(query.chat);
  if (chatId !== undefined) {
    conditions.push(eq(chats.telegramChatId, parseId(chatId, 'chat')));
  }
  const cursor = optionalFilter(query.cursor);
  if (cursor !== undefined) {
    const parsed = parseContextCursor(cursor);
    const before = or(
      lt(conversationContexts.lastActiveAt, parsed.lastActiveAt),
      and(eq(conversationContexts.lastActiveAt, parsed.lastActiveAt), lt(conversationContexts.id, parsed.id)),
    );
    if (before !== undefined) {
      conditions.push(before);
    }
  }
  const rows = orm
    .select(CONTEXT_FIELDS)
    .from(conversationContexts)
    .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(...conditions))
    .orderBy(desc(conversationContexts.lastActiveAt), desc(conversationContexts.id))
    .limit(limit + 1)
    .all();
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(contextListItem),
    next_cursor: rows.length > limit && last !== undefined ? encodeContextCursor(last) : null,
  };
}

export function getConversationContext(orm: Orm, conversationId: bigint): Record<string, unknown> | null {
  const context = orm
    .select(CONTEXT_FIELDS)
    .from(conversationContexts)
    .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(eq(conversationContexts.conversationId, conversationId))
    .get();
  if (context === undefined) {
    return null;
  }
  const messageRows = orm
    .select({
      seq: contextMessages.seq,
      role: contextMessages.role,
      payload_json: contextMessages.payloadJson,
      invocation_id: contextMessages.invocationId,
      is_checkpoint: contextMessages.isCheckpoint,
      send_seq: contextMessages.sendSeq,
      est_tokens: contextMessages.estTokens,
      evicted_at: contextMessages.evictedAt,
      created_at: contextMessages.createdAt,
    })
    .from(contextMessages)
    .where(and(eq(contextMessages.contextId, context.id), gte(contextMessages.seq, context.head_seq)))
    .orderBy(contextMessages.seq)
    .all();
  const refRows = orm
    .select({
      ref: contextRefs.ref,
      kind: contextRefs.kind,
      source_seq: contextRefs.sourceSeq,
      expires_at: contextRefs.expiresAt,
    })
    .from(contextRefs)
    .where(eq(contextRefs.contextId, context.id))
    .orderBy(contextRefs.sourceSeq, contextRefs.ref)
    .all();
  return {
    ...contextListItem(context),
    system_prompt_hash: context.system_prompt_hash,
    created_at: context.created_at,
    updated_at: context.updated_at,
    messages: messageRows.map((row) => ({
      seq: Number(row.seq),
      role: row.role,
      is_checkpoint: row.is_checkpoint,
      send_seq: row.send_seq === null ? null : Number(row.send_seq),
      est_tokens: Number(row.est_tokens),
      invocation_id: row.invocation_id === null ? null : row.invocation_id.toString(),
      evicted_at: row.evicted_at,
      created_at: row.created_at,
      payload_preview: row.payload_json.slice(0, MAX_PAYLOAD_PREVIEW_LENGTH),
      payload_truncated: row.payload_json.length > MAX_PAYLOAD_PREVIEW_LENGTH,
    })),
    refs: refRows.map((row) => ({
      ref: row.ref,
      kind: row.kind,
      source_seq: Number(row.source_seq),
      expires_at: row.expires_at,
    })),
  };
}

function contextListItem(row: ConversationContextRow): Record<string, unknown> {
  return {
    id: row.id.toString(),
    conversation_id: row.conversation_id.toString(),
    telegram_chat_id: row.telegram_chat_id.toString(),
    chat_type: row.chat_type,
    chat_title: row.chat_title,
    message_thread_id: Number(row.message_thread_id),
    head_seq: Number(row.head_seq),
    next_seq: Number(row.next_seq),
    send_count_total: Number(row.send_count_total),
    message_count: Number(row.message_count),
    last_active_at: row.last_active_at,
    last_gc_at: row.last_gc_at,
    active_invocation_id: row.active_invocation_id === null ? null : row.active_invocation_id.toString(),
  };
}

function encodeContextCursor(row: ConversationContextRow): string {
  return `${row.last_active_at}|${row.id.toString()}`;
}

function parseContextCursor(value: string): ConversationContextCursor {
  const separator = value.lastIndexOf('|');
  const lastActiveAt = value.slice(0, separator);
  const idText = value.slice(separator + 1);
  if (separator <= 0 || !/^[0-9A-Za-z:+.-]{10,40}$/.test(lastActiveAt) || !/^\d{1,19}$/.test(idText)) {
    throw new AdminQueryError('invalid_cursor', 'cursor is invalid');
  }
  return { lastActiveAt, id: BigInt(idText) };
}

/** Empty filter parameters mean "no filter"; anything else is validated by the caller. */
function optionalFilter(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function listInvocations(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  appendCursor(conditions, sql`i.id`, query.cursor);
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    conditions.push(sql`i.state = ${assertToken(query.state, 'state')}`);
  }
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(sql`ch.telegram_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  const rows =
    orm.all<InvocationListRow>(sql`SELECT i.id, i.state, i.created_at, i.started_at, i.finished_at, i.completion_reason, i.error_code,
              i.sends_used, i.tool_calls_used, i.turns_used, i.side_effect_started, i.config_hash,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, ch.username AS chat_username,
              c.message_thread_id,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.invocation_id = i.id) AS tool_call_count,
              (SELECT COALESCE(SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0) + COALESCE(mc.cache_read_tokens, 0) + COALESCE(mc.cache_write_tokens, 0)), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
              (SELECT COALESCE(SUM(mc.cache_read_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_read_tokens,
              (SELECT COALESCE(SUM(mc.cache_write_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_write_tokens,
              (SELECT SUM(mc.cost) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_cost
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       ${whereSql(conditions)}
       ORDER BY i.id DESC
       LIMIT ${BigInt(limit + 1)}`);
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    state: row.state,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    completion_reason: row.completion_reason,
    error_code: row.error_code,
    sends_used: Number(row.sends_used),
    tool_calls_used: Number(row.tool_calls_used),
    turns_used: Number(row.turns_used),
    side_effect_started: bit(row.side_effect_started),
    config_hash: row.config_hash,
    chat: chatSummary(row),
    tool_call_count: Number(row.tool_call_count),
    total_tokens: Number(row.total_tokens),
    cache_read_tokens: Number(row.cache_read_tokens),
    cache_write_tokens: Number(row.cache_write_tokens),
    total_cost: row.total_cost,
  }));
}

export function getInvocation(orm: Orm, id: bigint): Record<string, unknown> | null {
  const invocation = orm
    .all<InvocationDetailRow>(sql`SELECT i.id, i.state, i.created_at, i.started_at, i.finished_at, i.completion_reason, i.error_code,
              i.sends_used, i.tool_calls_used, i.turns_used, i.side_effect_started, i.config_hash,
              i.prompt_version, i.tool_registry_hash, i.tool_registry_json, i.bucket_id,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, ch.username AS chat_username,
              c.message_thread_id,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.invocation_id = i.id) AS tool_call_count,
              (SELECT COALESCE(SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0) + COALESCE(mc.cache_read_tokens, 0) + COALESCE(mc.cache_write_tokens, 0)), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
              (SELECT COALESCE(SUM(mc.cache_read_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_read_tokens,
              (SELECT COALESCE(SUM(mc.cache_write_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_write_tokens,
              (SELECT SUM(mc.cost) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_cost
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       WHERE i.id = ${id}`)
    .at(0);
  if (invocation === undefined) {
    return null;
  }
  const toolCallRows = orm
    .select({
      id: toolCalls.id,
      toolCallId: toolCalls.toolCallId,
      toolName: toolCalls.toolName,
      argumentsJson: toolCalls.argumentsJson,
      resultText: toolCalls.resultText,
      state: toolCalls.state,
      sideEffect: toolCalls.sideEffect,
      errorCode: toolCalls.errorCode,
      durationMs: toolCalls.durationMs,
      createdAt: toolCalls.createdAt,
      finishedAt: toolCalls.finishedAt,
    })
    .from(toolCalls)
    .where(eq(toolCalls.invocationId, id))
    .orderBy(toolCalls.id)
    .all();
  const modelCallRows = orm
    .select({
      id: modelCalls.id,
      role: modelCalls.role,
      provider: modelCalls.provider,
      model: modelCalls.model,
      attempt: modelCalls.attempt,
      state: modelCalls.state,
      inputTokens: modelCalls.inputTokens,
      outputTokens: modelCalls.outputTokens,
      cacheReadTokens: modelCalls.cacheReadTokens,
      cacheWriteTokens: modelCalls.cacheWriteTokens,
      totalTokens: modelCalls.totalTokens,
      cost: modelCalls.cost,
      durationMs: modelCalls.durationMs,
      errorCode: modelCalls.errorCode,
      errorDetail: modelCalls.errorDetail,
      requestJson: modelCalls.requestJson,
      responseJson: modelCalls.responseJson,
      createdAt: modelCalls.createdAt,
      finishedAt: modelCalls.finishedAt,
      toolsJson: modelCalls.toolsJson,
    })
    .from(modelCalls)
    .where(eq(modelCalls.invocationId, id))
    .orderBy(modelCalls.id)
    .all();
  const agentMessageRows = orm
    .select({
      sequenceNo: agentMessages.sequenceNo,
      role: agentMessages.role,
      text: agentMessages.text,
      createdAt: agentMessages.createdAt,
    })
    .from(agentMessages)
    .where(eq(agentMessages.invocationId, id))
    .orderBy(agentMessages.sequenceNo)
    .all();
  const sendRows = orm
    .select({
      id: telegramSends.id,
      toolCallId: toolCalls.toolCallId,
      kind: telegramSends.kind,
      requestJson: telegramSends.requestJson,
      state: telegramSends.state,
      telegramMessageId: telegramSends.telegramMessageId,
      errorCode: telegramSends.errorCode,
      createdAt: telegramSends.createdAt,
      finishedAt: telegramSends.finishedAt,
    })
    .from(telegramSends)
    .innerJoin(toolCalls, eq(telegramSends.toolCallId, toolCalls.id))
    .where(eq(toolCalls.invocationId, id))
    .orderBy(telegramSends.id)
    .all();
  const contextMessageRows = orm
    .select({
      section: invocationMessages.section,
      sequenceNo: invocationMessages.sequenceNo,
      messageId: invocationMessages.messageId,
      revisionId: invocationMessages.revisionId,
      omittedBefore: invocationMessages.omittedBefore,
      snapshotJson: invocationMessages.snapshotJson,
    })
    .from(invocationMessages)
    .where(eq(invocationMessages.invocationId, id))
    .orderBy(invocationMessages.sequenceNo)
    .all();
  return {
    id: invocation.id.toString(),
    bucket_id: invocation.bucket_id.toString(),
    state: invocation.state,
    created_at: invocation.created_at,
    started_at: invocation.started_at,
    finished_at: invocation.finished_at,
    completion_reason: invocation.completion_reason,
    error_code: invocation.error_code,
    sends_used: Number(invocation.sends_used),
    tool_calls_used: Number(invocation.tool_calls_used),
    turns_used: Number(invocation.turns_used),
    side_effect_started: bit(invocation.side_effect_started),
    config_hash: invocation.config_hash,
    prompt_version: Number(invocation.prompt_version),
    tool_registry_hash: invocation.tool_registry_hash,
    tool_registry: parseToolRegistry(invocation.tool_registry_json),
    chat: chatSummary(invocation),
    total_tokens: Number(invocation.total_tokens),
    cache_read_tokens: Number(invocation.cache_read_tokens),
    cache_write_tokens: Number(invocation.cache_write_tokens),
    total_cost: invocation.total_cost,
    tool_calls: toolCallRows.map((row) => ({
      id: row.id.toString(),
      tool_call_id: row.toolCallId,
      tool_name: row.toolName,
      arguments_json: row.argumentsJson,
      result_text: row.resultText,
      state: row.state,
      side_effect: row.sideEffect,
      error_code: row.errorCode,
      duration_ms: num(row.durationMs),
      created_at: row.createdAt,
      finished_at: row.finishedAt,
    })),
    model_calls: modelCallRows.map((row) => ({
      id: row.id.toString(),
      role: row.role,
      provider: row.provider,
      model: row.model,
      attempt: Number(row.attempt),
      state: row.state,
      input_tokens: num(row.inputTokens),
      output_tokens: num(row.outputTokens),
      cache_read_tokens: num(row.cacheReadTokens),
      cache_write_tokens: num(row.cacheWriteTokens),
      total_tokens: Number(
        meteredTokens({
          input: row.inputTokens ?? 0n,
          output: row.outputTokens ?? 0n,
          cacheRead: row.cacheReadTokens ?? 0n,
          cacheWrite: row.cacheWriteTokens ?? 0n,
        }),
      ),
      provider_total_tokens: num(row.totalTokens),
      cost: row.cost,
      duration_ms: num(row.durationMs),
      error_code: row.errorCode,
      error_detail: row.errorDetail,
      request_json: row.requestJson,
      response_json: row.responseJson,
      created_at: row.createdAt,
      finished_at: row.finishedAt,
      tools: parseStringArray(row.toolsJson),
    })),
    agent_messages: agentMessageRows.map((row) => ({
      sequence_no: Number(row.sequenceNo),
      role: row.role,
      text: row.text,
      created_at: row.createdAt,
    })),
    telegram_sends: sendRows.map((row) => ({
      id: row.id.toString(),
      tool_call_id: row.toolCallId,
      kind: row.kind,
      request_json: row.requestJson,
      state: row.state,
      telegram_message_id: row.telegramMessageId === null ? null : row.telegramMessageId.toString(),
      error_code: row.errorCode,
      created_at: row.createdAt,
      finished_at: row.finishedAt,
    })),
    context_messages: contextMessageRows.map((row) => ({
      section: row.section,
      sequence_no: Number(row.sequenceNo),
      message_id: row.messageId.toString(),
      revision_id: row.revisionId.toString(),
      omitted_before: Number(row.omittedBefore),
      snapshot_json: row.snapshotJson,
    })),
  };
}

const MESSAGE_SELECT = sql`SELECT m.id, m.telegram_message_id, m.telegram_date, m.received_at, m.visible, m.sent_by_bot,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id,
              r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.media_group_id,
              sd.display_name AS sender_display_name, sd.telegram_id AS sender_telegram_id,
              sd.telegram_type AS sender_telegram_type, sd.username AS sender_username, sd.is_bot AS sender_is_bot,
              (SELECT COUNT(*) FROM message_revisions mr WHERE mr.message_id = m.id) AS revision_count,
              (SELECT COUNT(*) FROM media md WHERE md.revision_id = m.current_revision_id) AS media_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN chats ch ON ch.id = m.chat_id
       LEFT JOIN message_revisions r ON r.id = m.current_revision_id
       LEFT JOIN senders sd ON sd.id = r.sender_id`;

export function listMessages(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  appendCursor(conditions, sql`m.id`, query.cursor);
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(sql`ch.telegram_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    if (query.search.length > MAX_SEARCH_LENGTH) {
      throw new AdminQueryError('invalid_search', 'Search text is too long');
    }
    const like = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(sql`(r.text LIKE ${like} ESCAPE '\\' OR r.caption LIKE ${like} ESCAPE '\\')`);
  }
  const rows = orm.all<MessageListRow>(
    sql`${MESSAGE_SELECT} ${whereSql(conditions)} ORDER BY m.id DESC LIMIT ${BigInt(limit + 1)}`,
  );
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    telegram_message_id: row.telegram_message_id.toString(),
    telegram_date: row.telegram_date,
    received_at: row.received_at,
    visible: bit(row.visible),
    sent_by_bot: bit(row.sent_by_bot),
    chat: {
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.chat_type,
      title: row.chat_title,
      message_thread_id: Number(row.message_thread_id),
    },
    revision_no: num(row.revision_no),
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    reply_to_message_id: row.reply_to_message_id === null ? null : row.reply_to_message_id.toString(),
    media_group_id: row.media_group_id,
    sender:
      row.sender_display_name === null
        ? null
        : {
            display_name: row.sender_display_name,
            telegram_id: row.sender_telegram_id?.toString() ?? null,
            telegram_type: row.sender_telegram_type,
            username: row.sender_username,
            is_bot: bit(row.sender_is_bot),
          },
    revision_count: Number(row.revision_count),
    media_count: Number(row.media_count),
  }));
}

export function getMessage(orm: Orm, id: bigint): Record<string, unknown> | null {
  const message = orm.all<MessageListRow>(sql`${MESSAGE_SELECT} WHERE m.id = ${id}`).at(0);
  if (message === undefined) {
    return null;
  }
  const revisionRows = orm
    .select({
      id: messageRevisions.id,
      revisionNo: messageRevisions.revisionNo,
      kind: messageRevisions.kind,
      text: messageRevisions.text,
      caption: messageRevisions.caption,
      replyToMessageId: messageRevisions.replyToMessageId,
      replySnapshotJson: messageRevisions.replySnapshotJson,
      forwardOriginJson: messageRevisions.forwardOriginJson,
      mediaGroupId: messageRevisions.mediaGroupId,
      serviceJson: messageRevisions.serviceJson,
      createdAt: messageRevisions.createdAt,
      senderDisplayName: senders.displayName,
      senderTelegramId: senders.telegramId,
      senderTelegramType: senders.telegramType,
      senderUsername: senders.username,
    })
    .from(messageRevisions)
    .leftJoin(senders, eq(messageRevisions.senderId, senders.id))
    .where(eq(messageRevisions.messageId, id))
    .orderBy(messageRevisions.revisionNo)
    .all();
  const mediaRows = orm
    .select({
      id: media.id,
      revisionId: media.revisionId,
      kind: media.kind,
      fileUniqueId: media.fileUniqueId,
      mimeType: media.mimeType,
      fileSize: media.fileSize,
      width: media.width,
      height: media.height,
      analysisState: mediaAnalyses.state,
      analysisDescription: mediaAnalyses.description,
    })
    .from(media)
    .innerJoin(messageRevisions, eq(media.revisionId, messageRevisions.id))
    .leftJoin(
      mediaAnalyses,
      and(eq(mediaAnalyses.fileUniqueId, media.fileUniqueId), eq(mediaAnalyses.state, 'success')),
    )
    .where(eq(messageRevisions.messageId, id))
    .orderBy(media.id)
    .all();
  return {
    id: message.id.toString(),
    telegram_message_id: message.telegram_message_id.toString(),
    telegram_date: message.telegram_date,
    received_at: message.received_at,
    visible: bit(message.visible),
    sent_by_bot: bit(message.sent_by_bot),
    chat: {
      telegram_chat_id: message.telegram_chat_id.toString(),
      type: message.chat_type,
      title: message.chat_title,
      message_thread_id: Number(message.message_thread_id),
    },
    revisions: revisionRows.map((row) => ({
      id: row.id.toString(),
      revision_no: Number(row.revisionNo),
      kind: row.kind,
      text: row.text,
      caption: row.caption,
      reply_to_message_id: row.replyToMessageId === null ? null : row.replyToMessageId.toString(),
      reply_snapshot_json: row.replySnapshotJson,
      forward_origin_json: row.forwardOriginJson,
      media_group_id: row.mediaGroupId,
      service_json: row.serviceJson,
      created_at: row.createdAt,
      sender:
        row.senderDisplayName === null
          ? null
          : {
              display_name: row.senderDisplayName,
              telegram_id: row.senderTelegramId?.toString() ?? null,
              telegram_type: row.senderTelegramType,
              username: row.senderUsername,
            },
    })),
    media: mediaRows.map((row) => ({
      id: row.id.toString(),
      revision_id: row.revisionId.toString(),
      kind: row.kind,
      file_unique_id: row.fileUniqueId,
      mime_type: row.mimeType,
      file_size: num(row.fileSize),
      width: num(row.width),
      height: num(row.height),
      analysis_state: row.analysisState,
      analysis_description: row.analysisDescription,
    })),
  };
}

export function listStickerSets(orm: Orm): readonly Record<string, unknown>[] {
  const rows =
    orm.all<StickerSetRow>(sql`SELECT ss.id, ss.alias, ss.telegram_name, ss.title, ss.configured, ss.sync_state, ss.last_synced_at,
              ss.error_code, ss.updated_at,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1) AS sticker_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state = 'success') AS indexed_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state IN ('pending', 'running')) AS pending_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state = 'error') AS error_count
       FROM sticker_sets ss
       ORDER BY ss.configured DESC, ss.alias`);
  return rows.map((row) => ({
    id: row.id.toString(),
    alias: row.alias,
    telegram_name: row.telegram_name,
    title: row.title,
    configured: bit(row.configured),
    sync_state: row.sync_state,
    last_synced_at: row.last_synced_at,
    error_code: row.error_code,
    updated_at: row.updated_at,
    sticker_count: Number(row.sticker_count),
    indexed_count: Number(row.indexed_count),
    pending_count: Number(row.pending_count),
    error_count: Number(row.error_count),
  }));
}

export function listStickers(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  appendCursor(conditions, sql`s.id`, query.cursor);
  if (query.set !== undefined && query.set !== null && query.set.length > 0) {
    conditions.push(sql`ss.alias = ${assertToken(query.set, 'set')}`);
  }
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    conditions.push(sql`s.index_state = ${assertToken(query.state, 'state')}`);
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    if (query.search.length > MAX_SEARCH_LENGTH) {
      throw new AdminQueryError('invalid_search', 'Search text is too long');
    }
    const like = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(sql`(ma.description LIKE ${like} ESCAPE '\\' OR s.emoji LIKE ${like} ESCAPE '\\')`);
  }
  const rows =
    orm.all<StickerRow>(sql`SELECT s.id, ss.alias AS set_alias, s.file_unique_id, s.emoji, s.format, s.active, s.index_state,
              s.failure_count, s.next_retry_at, s.updated_at,
              ma.id AS analysis_id, ma.state AS analysis_state, ma.analysis_version, ma.provider, ma.model,
              ma.prompt_version, ma.description, ma.metadata_json, ma.updated_at AS analysis_updated_at
       FROM stickers s
       JOIN sticker_sets ss ON ss.id = s.sticker_set_id
       LEFT JOIN media_analyses ma ON ma.id = s.current_analysis_id
       ${whereSql(conditions)}
       ORDER BY s.id DESC
       LIMIT ${BigInt(limit + 1)}`);
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    set_alias: row.set_alias,
    file_unique_id: row.file_unique_id,
    emoji: row.emoji,
    format: row.format,
    active: bit(row.active),
    index_state: row.index_state,
    failure_count: Number(row.failure_count),
    next_retry_at: row.next_retry_at,
    updated_at: row.updated_at,
    analysis:
      row.analysis_id === null
        ? null
        : {
            id: row.analysis_id.toString(),
            state: row.analysis_state,
            analysis_version: row.analysis_version,
            provider: row.provider,
            model: row.model,
            prompt_version: num(row.prompt_version),
            description: row.description,
            metadata_json: row.metadata_json,
            updated_at: row.analysis_updated_at,
          },
  }));
}

export function overview(orm: Orm, now = new Date()): Record<string, unknown> {
  const today = now.toISOString().slice(0, 10);
  const invocationStates = orm.all<CountRow>(
    sql`SELECT state AS label, COUNT(*) AS count FROM invocations GROUP BY state ORDER BY state`,
  );
  const stickerStates = orm.all<CountRow>(
    sql`SELECT index_state AS label, COUNT(*) AS count FROM stickers WHERE active = 1 GROUP BY index_state ORDER BY index_state`,
  );
  const toolNames = orm.all<CountRow>(
    sql`SELECT tool_name AS label, COUNT(*) AS count FROM tool_calls GROUP BY tool_name ORDER BY count DESC LIMIT 10`,
  );
  const usageRows = orm
    .select({
      resource: dailyUsage.resource,
      metric: dailyUsage.metric,
      scope: dailyUsage.scope,
      amount: dailyUsage.amount,
    })
    .from(dailyUsage)
    .where(eq(dailyUsage.utcDate, today))
    .orderBy(dailyUsage.resource, dailyUsage.metric, dailyUsage.scope)
    .all();
  const storedSleep = storedSleepUntil(orm);
  const sleepUntil = storedSleep !== null && storedSleep > now.toISOString() ? storedSleep : null;
  const pausedChats = orm.all<PausedChatRow>(sql`SELECT c.telegram_chat_id, c.type, c.title, c.username, p.paused_at
       FROM chat_pause p JOIN chats c ON c.id = p.chat_id
       ORDER BY p.paused_at, c.telegram_chat_id`);
  const messageCount = orm.select({ count: sql<bigint>`count(*)` }).from(messages).get();
  const analysisCount = orm
    .select({ count: sql<bigint>`count(*)` })
    .from(mediaAnalyses)
    .where(eq(mediaAnalyses.state, 'success'))
    .get();
  return {
    generated_at: now.toISOString(),
    invocation_states: invocationStates.map((row) => ({ label: row.label, count: Number(row.count) })),
    sticker_index_states: stickerStates.map((row) => ({ label: row.label, count: Number(row.count) })),
    top_tools: toolNames.map((row) => ({ label: row.label, count: Number(row.count) })),
    daily_usage: usageRows.map((row) => ({
      resource: row.resource,
      metric: row.metric,
      scope: row.scope,
      amount: Number(row.amount),
    })),
    runtime_status: {
      sleeping: sleepUntil !== null,
      sleep_until: sleepUntil,
      paused_chats: pausedChats.map((row) => ({
        telegram_chat_id: row.telegram_chat_id.toString(),
        type: row.type,
        title: row.title,
        username: row.username,
        paused_at: row.paused_at,
      })),
    },
    message_count: Number(messageCount?.count ?? 0n),
    cached_analysis_count: Number(analysisCount?.count ?? 0n),
  };
}

function chatSummary(row: {
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly chat_username?: string | null;
  readonly message_thread_id: bigint;
}): Record<string, unknown> {
  return {
    telegram_chat_id: row.telegram_chat_id.toString(),
    type: row.chat_type,
    title: row.chat_title,
    username: row.chat_username ?? null,
    message_thread_id: Number(row.message_thread_id),
  };
}

export function page<Row extends { readonly id: bigint | string }, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    next_cursor: rows.length > limit && last !== undefined ? last.id.toString() : null,
  };
}

/** SQL-chunk WHERE builder for drizzle `sql` templates; binds every value. */
function whereSql(conditions: readonly SQL[]): SQL {
  return conditions.length === 0 ? sql.empty() : sql` WHERE ${sql.join([...conditions], sql` AND `)}`;
}

function appendCursor(conditions: SQL[], column: SQL, cursor: string | null | undefined): void {
  if (cursor === undefined || cursor === null || cursor.length === 0) {
    return;
  }
  conditions.push(sql`${column} < ${parseId(cursor, 'cursor')}`);
}

export function parseId(value: string, label: string): bigint {
  if (!/^-?\d{1,19}$/.test(value)) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must be an integer`);
  }
  const id = BigInt(value);
  if (id < -9_223_372_036_854_775_808n || id > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must fit in a signed 64-bit integer`);
  }
  return id;
}

export function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value.length === 0) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d{1,3}$/.test(value)) {
    throw new AdminQueryError('invalid_limit', 'limit must be a positive integer');
  }
  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new AdminQueryError('invalid_limit', `limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

function assertToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new AdminQueryError(`invalid_${label}`, `${label} filter is invalid`);
  }
  return value;
}

/** Stored JSON is untrusted; only accept a well-formed array of strings. */
function parseStringArray(json: string | null): string[] | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseToolRegistry(
  json: string | null,
): readonly { name: string; label: string; description: string }[] | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const entries = parsed.map((entry): { name: string; label: string; description: string } | null => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const name = record.name;
      const label = record.label;
      const description = record.description;
      if (typeof name !== 'string' || typeof label !== 'string' || typeof description !== 'string') {
        return null;
      }
      return { name, label, description };
    });
    const valid = entries.filter(
      (entry): entry is { name: string; label: string; description: string } => entry !== null,
    );
    if (valid.length !== entries.length) {
      return null;
    }
    return valid;
  } catch {
    return null;
  }
}
export interface UsageSeries {
  readonly days: number;
  readonly series: readonly UsagePoint[];
}

export interface UsagePoint {
  readonly date: string;
  readonly model_tokens: number;
  readonly vision_tokens: number;
  readonly tool_calls: number;
  readonly agent_invocations: number;
}

export function usage(orm: Orm, days: number, now = new Date()): UsageSeries {
  const result: UsagePoint[] = [];
  const today = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    result.push({
      date: d.toISOString().slice(0, 10),
      model_tokens: 0,
      vision_tokens: 0,
      tool_calls: 0,
      agent_invocations: 0,
    });
  }
  const firstDate = new Date(today);
  firstDate.setUTCDate(today.getUTCDate() - (days - 1));
  const from = firstDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  // Exclusive upper bound for the ISO-8601 `created_at` strings, so the count
  // queries stay range comparisons instead of per-row substr().
  const before = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
    .toISOString()
    .slice(0, 10);
  const byDate = new Map<string, UsagePoint>();
  for (const point of result) {
    byDate.set(point.date, point);
  }
  const apply = (date: string, metric: keyof UsagePoint, total: bigint): void => {
    const point = byDate.get(date);
    if (point === undefined) {
      return;
    }
    byDate.set(date, { ...point, [metric]: Number(total) });
  };
  const tokenRows = orm.all<{ utc_date: string; metric: string; total: bigint }>(
    sql`SELECT utc_date, metric, SUM(amount) AS total
       FROM daily_usage
       WHERE utc_date >= ${from} AND utc_date <= ${to} AND metric IN ('model_tokens', 'vision_tokens')
       GROUP BY utc_date, metric`,
  );
  for (const row of tokenRows) {
    apply(row.utc_date, row.metric === 'vision_tokens' ? 'vision_tokens' : 'model_tokens', row.total);
  }
  // Counted from the audit tables: daily_usage only records budget metrics
  // (tokens, images), so it cannot be the source for these counts.
  const invocationRows = orm.all<{ utc_date: string; total: bigint }>(
    sql`SELECT substr(created_at, 1, 10) AS utc_date, COUNT(*) AS total
       FROM invocations
       WHERE created_at >= ${from} AND created_at < ${before}
       GROUP BY utc_date`,
  );
  for (const row of invocationRows) {
    apply(row.utc_date, 'agent_invocations', row.total);
  }
  const toolCallRows = orm.all<{ utc_date: string; total: bigint }>(
    sql`SELECT substr(created_at, 1, 10) AS utc_date, COUNT(*) AS total
       FROM tool_calls
       WHERE created_at >= ${from} AND created_at < ${before}
       GROUP BY utc_date`,
  );
  for (const row of toolCallRows) {
    apply(row.utc_date, 'tool_calls', row.total);
  }
  return { days, series: Array.from(byDate.values()) };
}
