import { eq } from 'drizzle-orm';
import type { Orm, SqliteStore } from '../../src/store/database.ts';
import {
  agentMessages,
  buckets,
  chats,
  contextMessages,
  contextRefs,
  conversationContexts,
  conversations,
  dailyUsage,
  invocationMessages,
  invocations,
  longTasks,
  media,
  mediaAnalyses,
  memories,
  messageRevisions,
  messages,
  modelCalls,
  senders,
  stickerSets,
  stickers,
  taskReceipts,
  telegramSends,
  toolCalls,
} from '../../src/store/schema.ts';

/**
 * Synthetic admin-panel fixture data (backend only, no React). The Playwright
 * E2E server (`apps/admin-next/e2e/server.ts`) writes this into a fresh
 * SqliteStore so every list and detail page has representative rows:
 *
 * - two invocations: one completed (with a `send` tool call + linked
 *   telegram_sends row, retained/new context messages, an oversized request
 *   payload) and one failed (with a failed model call carrying a redacted
 *   error detail);
 * - messages with revisions and media, sticker sets/analyses, a pending
 *   alarm, active + expired memories, a conversation context with messages
 *   (one payload above the admin preview cap, so the truncated marker shows)
 *   and a capability ref, and daily usage rows.
 *
 * All row IDs are deterministic bigints so tests can assert on them. Do not
 * wire this into any production code path.
 */

const T = {
  chat: 1_001n,
  conversation: 2_001n,
  bucketA: 3_001n,
  bucketB: 3_002n,
  invocationA: 4_001n,
  invocationB: 4_002n,
  sender: 5_001n,
  messageA: 6_001n,
  messageB: 6_002n,
  revisionA1: 6_101n,
  revisionA2: 6_102n,
  revisionB1: 6_103n,
  revisionB2: 6_104n,
  mediaPhoto: 6_201n,
  modelOkA: 7_001n,
  modelFailedB: 7_002n,
  modelOkB: 7_003n,
  toolReadA: 8_001n,
  toolSendA: 8_002n,
  toolReadB: 8_003n,
  sendA: 8_101n,
  stickerSet: 9_001n,
  stickerSetLegacy: 9_002n,
  analysisSticker: 9_101n,
  analysisImage: 9_102n,
  stickerStatic: 9_201n,
  stickerAnimated: 9_202n,
  alarm: 10_001n,
  context: 11_001n,
} as const;

const AT = '2026-09-10T08:00:00.000Z';

interface AlarmTaskSeed {
  readonly id: bigint;
  readonly conversationId: bigint;
  readonly targetUserId: bigint;
  readonly summary: string;
  readonly scheduledAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByInvocationId?: bigint | null;
  readonly state?: 'waiting' | 'cancelled';
  readonly cancelledAt?: string;
  readonly cancelledBy?: string;
}

function insertAlarmTask(orm: Orm, seed: AlarmTaskSeed): void {
  const targetDisplayName = 'Alice';
  const payload = JSON.stringify({
    target_user_id: seed.targetUserId.toString(),
    target_display_name: targetDisplayName,
    summary: seed.summary,
  });
  orm
    .insert(longTasks)
    .values({
      id: seed.id,
      pluginId: 'alarm',
      conversationId: seed.conversationId,
      createdByInvocationId: seed.createdByInvocationId ?? null,
      createdByUserId: seed.targetUserId,
      payloadJson: payload,
      state: seed.state ?? 'waiting',
      scheduledAt: seed.scheduledAt,
      timerResultJson: payload,
      deliveryJson: JSON.stringify({
        bypassDailyBudget: true,
        mentionUser: { userId: seed.targetUserId.toString(), displayName: targetDisplayName },
      }),
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt,
      finishedAt: seed.cancelledAt ?? null,
    })
    .run();
  if (seed.state === 'cancelled') {
    orm
      .insert(taskReceipts)
      .values({
        taskId: seed.id,
        status: 'cancelled',
        resultJson: null,
        errorJson: null,
        state: 'suppressed',
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt,
        claimedAt: null,
        handledAt: null,
        invocationId: null,
        invocationOutcome: null,
        completionReason: null,
        cancelledAt: seed.cancelledAt ?? seed.updatedAt,
        cancelledBy: seed.cancelledBy ?? 'admin-panel',
        adminCancelled: true,
        cancelReason: 'admin_cancelled',
      })
      .run();
  }
}

/** A JSON payload well above the frontend's 2_000-char collapse threshold. */
export const OVERSIZED_REQUEST_JSON: string = JSON.stringify({
  system: 'long payload fixture',
  instructions: 'x'.repeat(3_000),
  context_messages: Array.from({ length: 150 }, (_, index) => ({
    seq: index + 1,
    role: 'user',
    text: `message ${index + 1}`,
  })),
});

/** Redacted provider error detail: must never contain live keys. */
export const REDACTED_ERROR_DETAIL: string = JSON.stringify({
  error: 'provider_timeout',
  message: 'The provider timed out while streaming (redacted for display)',
  request_id: 'req_seed_001',
  hints: ['retry later', 'reduce max_tokens'],
  key: 'sk-***',
});

/** Context payload well above the admin API's 2_000-char preview cap. */
export const LONG_CONTEXT_PAYLOAD_JSON: string = JSON.stringify({
  role: 'user',
  kind: 'text',
  text: 'x'.repeat(2_200),
});

export interface AdminSeedResult {
  readonly chatId: bigint;
  readonly conversationId: bigint;
  readonly bucketA: bigint;
  readonly bucketB: bigint;
  readonly invocationA: bigint;
  readonly invocationB: bigint;
  readonly messageIds: readonly bigint[];
  readonly stickerSetId: bigint;
  readonly alarmId: bigint;
  readonly memoryActiveId: string;
  readonly memoryExpiredId: string;
  readonly contextId: bigint;
}

export function seedAdminFixture(store: SqliteStore): AdminSeedResult {
  const orm = store.orm;

  orm
    .insert(chats)
    .values({
      id: T.chat,
      telegramChatId: 123_456_789n,
      canonicalChatId: 123_456_789n,
      type: 'supergroup',
      title: 'Plastic Wan Test Group',
      username: 'plasticwan_test',
      updatedAt: AT,
    })
    .run();
  orm
    .insert(conversations)
    .values({
      id: T.conversation,
      chatId: T.chat,
      messageThreadId: 0n,
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
  orm
    .insert(senders)
    .values({
      id: T.sender,
      telegramType: 'user',
      telegramId: 42n,
      displayName: 'Alice',
      username: 'alice',
      isBot: false,
      updatedAt: AT,
    })
    .run();

  // --- messages + revisions + media (Messages page / message detail) ---
  orm
    .insert(messages)
    .values({
      id: T.messageA,
      conversationId: T.conversation,
      chatId: T.chat,
      telegramMessageId: 900n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      telegramDate: '2026-09-10T07:59:30.000Z',
      receivedAt: AT,
    })
    .run();
  orm
    .insert(messages)
    .values({
      id: T.messageB,
      conversationId: T.conversation,
      chatId: T.chat,
      telegramMessageId: 901n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      telegramDate: '2026-09-10T08:00:05.000Z',
      receivedAt: '2026-09-10T08:00:06.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionA1,
      messageId: T.messageA,
      revisionNo: 1n,
      senderId: T.sender,
      kind: 'photo',
      text: null,
      caption: 'first caption',
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T07:59:31.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionA2,
      messageId: T.messageA,
      revisionNo: 2n,
      senderId: T.sender,
      kind: 'photo',
      text: null,
      caption: 'edited caption',
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T07:59:40.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionB1,
      messageId: T.messageB,
      revisionNo: 1n,
      senderId: T.sender,
      kind: 'text',
      text: 'plain text message with a reply',
      caption: null,
      replyToMessageId: 900n,
      replySnapshotJson: '{"sender":{"username":"alice"},"text":"first caption"}',
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T08:00:05.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionB2,
      messageId: T.messageB,
      revisionNo: 2n,
      senderId: T.sender,
      kind: 'text',
      text: 'edited text with forward origin',
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: JSON.stringify({ type: 'user', user: { id: 42, username: 'alice' } }),
      mediaGroupId: null,
      serviceJson: JSON.stringify({ type: 'edited', edit_date: '2026-09-10T08:00:20.000Z' }),
      createdAt: '2026-09-10T08:00:20.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm.update(messages).set({ currentRevisionId: T.revisionA2 }).where(eq(messages.id, T.messageA)).run();
  orm.update(messages).set({ currentRevisionId: T.revisionB2 }).where(eq(messages.id, T.messageB)).run();
  orm
    .insert(media)
    .values({
      id: T.mediaPhoto,
      revisionId: T.revisionA1,
      kind: 'photo',
      fileId: 'file_photo_seed_1',
      fileUniqueId: 'unique_photo_seed_1',
      mimeType: 'image/jpeg',
      fileSize: 12_345n,
      width: 1280n,
      height: 720n,
      telegramJson: '{}',
    })
    .run();

  // --- buckets + invocations ---
  orm
    .insert(buckets)
    .values({
      id: T.bucketA,
      conversationId: T.conversation,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: '2026-09-10T07:59:30.000Z',
      deadlineAt: '2026-09-10T07:59:45.000Z',
      queuedAt: '2026-09-10T07:59:45.000Z',
      startedAt: '2026-09-10T07:59:46.000Z',
      finishedAt: '2026-09-10T08:00:06.000Z',
      errorCode: null,
      createdAt: AT,
      updatedAt: '2026-09-10T08:00:06.000Z',
    })
    .run();
  orm
    .insert(buckets)
    .values({
      id: T.bucketB,
      conversationId: T.conversation,
      state: 'failed',
      kind: 'realtime',
      firstReceivedAt: '2026-09-10T09:00:00.000Z',
      deadlineAt: '2026-09-10T09:00:15.000Z',
      queuedAt: '2026-09-10T09:00:15.000Z',
      startedAt: '2026-09-10T09:00:16.000Z',
      finishedAt: '2026-09-10T09:00:40.000Z',
      errorCode: 'model_failed',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:40.000Z',
    })
    .run();

  orm
    .insert(invocations)
    .values({
      id: T.invocationA,
      bucketId: T.bucketA,
      conversationId: T.conversation,
      state: 'completed',
      configHash: 'seed-config-hash-aaaa',
      promptVersion: 7n,
      toolRegistryHash: 'seed-registry-hash-1',
      toolRegistryJson: JSON.stringify([
        { name: 'send', label: 'Send message', description: 'Sends a message to Telegram.' },
        { name: 'read', label: 'Read document', description: 'Reads a system resource.' },
      ]),
      startedAt: '2026-09-10T07:59:46.000Z',
      finishedAt: '2026-09-10T08:00:06.000Z',
      completionReason: 'turn_limit_reached',
      errorCode: null,
      sendsUsed: 1n,
      toolCallsUsed: 2n,
      turnsUsed: 3n,
      sideEffectStarted: true,
      createdAt: '2026-09-10T07:59:45.000Z',
    })
    .run();
  orm
    .insert(invocations)
    .values({
      id: T.invocationB,
      bucketId: T.bucketB,
      conversationId: T.conversation,
      state: 'failed',
      configHash: 'seed-config-hash-bbbb',
      promptVersion: 7n,
      toolRegistryHash: 'seed-registry-hash-2',
      toolRegistryJson: null,
      startedAt: '2026-09-10T09:00:16.000Z',
      finishedAt: '2026-09-10T09:00:40.000Z',
      completionReason: 'model_error',
      errorCode: 'model_failed',
      sendsUsed: 0n,
      toolCallsUsed: 1n,
      turnsUsed: 1n,
      sideEffectStarted: false,
      createdAt: '2026-09-10T09:00:15.000Z',
    })
    .run();

  // --- model calls: A success ×2, B failed with redacted detail ---
  orm
    .insert(modelCalls)
    .values({
      id: T.modelOkA,
      invocationId: T.invocationA,
      role: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      attempt: 1n,
      state: 'success',
      inputTokens: 1_000n,
      outputTokens: 250n,
      cacheReadTokens: 500n,
      cacheWriteTokens: 0n,
      totalTokens: 1_750n,
      cost: 0.0032,
      durationMs: 1_234n,
      errorCode: null,
      errorDetail: null,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: OVERSIZED_REQUEST_JSON,
      responseJson: JSON.stringify({ status: 'ok', usage: { total_tokens: 1750 } }),
      createdAt: '2026-09-10T07:59:46.000Z',
      finishedAt: '2026-09-10T07:59:48.000Z',
    })
    .run();
  orm
    .insert(modelCalls)
    .values({
      id: T.modelOkB,
      invocationId: T.invocationA,
      role: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      attempt: 2n,
      state: 'success',
      inputTokens: 1_200n,
      outputTokens: 80n,
      cacheReadTokens: 900n,
      cacheWriteTokens: 0n,
      totalTokens: 2_180n,
      cost: 0.0016,
      durationMs: 812n,
      errorCode: null,
      errorDetail: null,
      toolsJson: JSON.stringify(['send']),
      requestJson: null,
      responseJson: null,
      createdAt: '2026-09-10T08:00:01.000Z',
      finishedAt: '2026-09-10T08:00:02.000Z',
    })
    .run();
  orm
    .insert(modelCalls)
    .values({
      id: T.modelFailedB,
      invocationId: T.invocationB,
      role: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      attempt: 1n,
      state: 'error',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      cost: null,
      durationMs: 5_000n,
      errorCode: 'provider_timeout',
      errorDetail: REDACTED_ERROR_DETAIL,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: OVERSIZED_REQUEST_JSON,
      responseJson: null,
      createdAt: '2026-09-10T09:00:16.000Z',
      finishedAt: '2026-09-10T09:00:40.000Z',
    })
    .run();

  // --- tool calls + telegram sends (send call linked by tool_call_id string) ---
  orm
    .insert(toolCalls)
    .values({
      id: T.toolReadA,
      invocationId: T.invocationA,
      toolCallId: 'call_read_001',
      toolName: 'read',
      argumentsJson: '{"path":"system:///skills/readme.md"}',
      resultText: 'ok',
      state: 'success',
      sideEffect: false,
      errorCode: null,
      durationMs: 12n,
      createdAt: '2026-09-10T07:59:48.000Z',
      finishedAt: '2026-09-10T07:59:48.000Z',
    })
    .run();
  orm
    .insert(toolCalls)
    .values({
      id: T.toolSendA,
      invocationId: T.invocationA,
      toolCallId: 'call_send_001',
      toolName: 'send',
      argumentsJson: '{"kind":"text","text":"Hello from the seeded invocation","reply_to_message_id":900}',
      resultText: 'sent',
      state: 'success',
      sideEffect: true,
      errorCode: null,
      durationMs: 204n,
      createdAt: '2026-09-10T08:00:03.000Z',
      finishedAt: '2026-09-10T08:00:03.000Z',
    })
    .run();
  orm
    .insert(toolCalls)
    .values({
      id: T.toolReadB,
      invocationId: T.invocationB,
      toolCallId: 'call_read_002',
      toolName: 'read',
      argumentsJson: '{"path":"system:///skills/missing.md"}',
      resultText: null,
      state: 'error',
      sideEffect: false,
      errorCode: 'not_found',
      durationMs: 3n,
      createdAt: '2026-09-10T09:00:38.000Z',
      finishedAt: '2026-09-10T09:00:38.000Z',
    })
    .run();
  orm
    .insert(telegramSends)
    .values({
      id: T.sendA,
      toolCallId: T.toolSendA,
      conversationId: T.conversation,
      kind: 'text',
      requestJson: '{"chat_id":123456789,"text":"Hello from the seeded invocation"}',
      state: 'success',
      telegramMessageId: 902n,
      responseJson: '{"message_id":902}',
      errorCode: null,
      createdAt: '2026-09-10T08:00:03.000Z',
      finishedAt: '2026-09-10T08:00:03.000Z',
    })
    .run();

  // --- agent transcript ---
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationA,
      sequenceNo: 1n,
      role: 'assistant',
      text: 'private reasoning before calling read',
      thinkingText: '',
      createdAt: '2026-09-10T07:59:46.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationA,
      sequenceNo: 2n,
      role: 'tool_result',
      text: '{"path":"system:///skills/readme.md","ok":true}',
      thinkingText: '',
      createdAt: '2026-09-10T07:59:48.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationA,
      sequenceNo: 3n,
      role: 'assistant',
      text: 'I will send the reply via the send tool.',
      thinkingText: '',
      createdAt: '2026-09-10T08:00:02.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationB,
      sequenceNo: 1n,
      role: 'assistant',
      text: 'trying to answer but the model call failed',
      thinkingText: '',
      createdAt: '2026-09-10T09:00:16.000Z',
    })
    .run();

  // --- frozen context (history + new partitions) ---
  orm
    .insert(invocationMessages)
    .values({
      invocationId: T.invocationA,
      messageId: T.messageA,
      revisionId: T.revisionA2,
      section: 'history',
      sequenceNo: 1n,
      sourceBucketId: null,
      omittedBefore: 0n,
      snapshotJson: JSON.stringify({
        sender: { id: '42', username: 'alice', name: 'Alice' },
        kind: 'photo',
        caption: 'edited caption',
        telegram_date: '2026-09-10T07:59:30.000Z',
        message_id: '900',
        media: [{ kind: 'photo' }],
      }),
    })
    .run();
  orm
    .insert(invocationMessages)
    .values({
      invocationId: T.invocationA,
      messageId: T.messageB,
      revisionId: T.revisionB1,
      section: 'new',
      sequenceNo: 2n,
      sourceBucketId: null,
      omittedBefore: 0n,
      snapshotJson: JSON.stringify({
        sender: { id: '42', username: 'alice', name: 'Alice' },
        kind: 'text',
        text: 'plain text message with a reply',
        telegram_date: '2026-09-10T08:00:05.000Z',
        message_id: '901',
      }),
    })
    .run();
  orm
    .insert(invocationMessages)
    .values({
      invocationId: T.invocationB,
      messageId: T.messageB,
      revisionId: T.revisionB1,
      section: 'new',
      sequenceNo: 1n,
      sourceBucketId: null,
      omittedBefore: 0n,
      snapshotJson: JSON.stringify({
        sender: { username: 'alice', name: 'Alice' },
        kind: 'text',
        text: 'plain text message with a reply',
        telegram_date: '2026-09-10T09:00:00.000Z',
        message_id: '901',
      }),
    })
    .run();

  // --- sticker set + analyses + stickers ---
  orm
    .insert(stickerSets)
    .values({
      id: T.stickerSet,
      alias: 'mascot',
      telegramName: 'plasticwan_mascot',
      title: 'Plastic Wan Mascot',
      configured: true,
      syncState: 'success',
      lastSyncedAt: '2026-09-10T08:00:10.000Z',
      errorCode: null,
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(stickerSets)
    .values({
      id: T.stickerSetLegacy,
      alias: 'legacy',
      telegramName: 'old_pack',
      title: null,
      configured: false,
      syncState: 'error',
      lastSyncedAt: null,
      errorCode: 'sticker_set_not_found',
      updatedAt: '2026-09-10T08:00:00.000Z',
    })
    .run();
  orm
    .insert(mediaAnalyses)
    .values({
      id: T.analysisSticker,
      fileUniqueId: 'unique_sticker_seed_1',
      analysisVersion: 'v1',
      provider: 'vision',
      model: 'vision-model',
      promptVersion: 1n,
      kind: 'sticker',
      state: 'success',
      description: 'A cheerful mascot waving hello',
      metadataJson: JSON.stringify({ dominant_color: 'pink' }),
      expiresAt: null,
      failureCount: 0n,
      nextRetryAt: null,
      createdAt: '2026-09-10T08:00:10.000Z',
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(mediaAnalyses)
    .values({
      id: T.analysisImage,
      fileUniqueId: 'unique_photo_seed_1',
      analysisVersion: 'v1',
      provider: 'vision',
      model: 'vision-model',
      promptVersion: 1n,
      kind: 'image',
      state: 'success',
      description: 'Photo caption analysis',
      metadataJson: null,
      expiresAt: null,
      failureCount: 0n,
      nextRetryAt: null,
      createdAt: '2026-09-10T08:00:10.000Z',
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(stickers)
    .values({
      id: T.stickerStatic,
      stickerSetId: T.stickerSet,
      fileUniqueId: 'unique_sticker_seed_1',
      fileId: 'file_sticker_seed_1',
      emoji: '👋',
      format: 'static',
      thumbnailJson: null,
      active: true,
      currentAnalysisId: T.analysisSticker,
      indexState: 'success',
      failureCount: 0n,
      nextRetryAt: null,
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(stickers)
    .values({
      id: T.stickerAnimated,
      stickerSetId: T.stickerSet,
      fileUniqueId: 'unique_sticker_seed_2',
      fileId: 'file_sticker_seed_2',
      emoji: '😢',
      format: 'animated',
      thumbnailJson: null,
      active: true,
      currentAnalysisId: null,
      indexState: 'error',
      failureCount: 3n,
      nextRetryAt: '2026-09-11T08:00:10.000Z',
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();

  // --- alarm task (pending) + memories (active + expired) ---
  insertAlarmTask(orm, {
    id: T.alarm,
    conversationId: T.conversation,
    targetUserId: 42n,
    summary: 'Remind Alice about the fixture data',
    scheduledAt: '2026-09-10T20:00:00.000Z',
    createdAt: '2026-09-10T08:00:11.000Z',
    createdByInvocationId: T.invocationA,
    updatedAt: '2026-09-10T08:00:11.000Z',
  });

  const memoryActiveId = 'mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  orm
    .insert(memories)
    .values({
      id: memoryActiveId,
      conversationId: T.conversation,
      content: 'Alice prefers short replies.',
      createdAt: '2026-09-10T08:00:12.000Z',
      // Must stay active regardless of when the fixture runs: a fixed date
      // silently aged into "expired" and broke the state=expired filter E2E.
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      updatedAt: '2026-09-10T08:00:12.000Z',
    })
    .run();
  const memoryExpiredId = 'mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  orm
    .insert(memories)
    .values({
      id: memoryExpiredId,
      conversationId: T.conversation,
      content: 'Old note that expired already.',
      createdAt: '2026-09-01T08:00:12.000Z',
      expiresAt: '2026-09-05T08:00:12.000Z',
      updatedAt: '2026-09-01T08:00:12.000Z',
    })
    .run();

  // --- conversation context + messages + capability ref (Contexts page) ---
  orm
    .insert(conversationContexts)
    .values({
      id: T.context,
      conversationId: T.conversation,
      headSeq: 1n,
      nextSeq: 4n,
      sendCountTotal: 1n,
      systemPromptHash: 'seed-system-prompt-hash',
      activeInvocationId: null,
      lastActiveAt: '2026-09-10T08:00:06.000Z',
      lastGcAt: null,
      createdAt: '2026-09-10T07:59:30.000Z',
      updatedAt: '2026-09-10T08:00:06.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 1n,
      role: 'user',
      payloadJson: JSON.stringify({ text: 'edited caption' }),
      invocationId: T.invocationA,
      isCheckpoint: true,
      sendSeq: null,
      estTokens: 20n,
      evictedAt: null,
      createdAt: '2026-09-10T07:59:30.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 2n,
      role: 'assistant',
      payloadJson: JSON.stringify({ text: 'private reasoning before calling read' }),
      invocationId: T.invocationA,
      isCheckpoint: false,
      sendSeq: null,
      estTokens: 30n,
      evictedAt: null,
      createdAt: '2026-09-10T07:59:46.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 3n,
      role: 'assistant',
      payloadJson: JSON.stringify({ text: 'Hello from the seeded invocation', send: true }),
      invocationId: T.invocationA,
      isCheckpoint: false,
      sendSeq: 1n,
      estTokens: 25n,
      evictedAt: null,
      createdAt: '2026-09-10T08:00:03.000Z',
    })
    .run();
  // Seq 4 carries a payload above the admin API preview cap so the detail
  // page's `payload_truncated` marker is exercised by test/admin.test.ts.
  orm
    .insert(contextMessages)
    .values({
      contextId: T.context,
      seq: 4n,
      role: 'user',
      payloadJson: LONG_CONTEXT_PAYLOAD_JSON,
      invocationId: T.invocationA,
      isCheckpoint: false,
      sendSeq: null,
      estTokens: 60n,
      evictedAt: null,
      createdAt: '2026-09-10T08:05:00.000Z',
    })
    .run();
  orm.update(conversationContexts).set({ nextSeq: 5n }).where(eq(conversationContexts.id, T.context)).run();
  orm
    .insert(contextRefs)
    .values({
      contextId: T.context,
      ref: 'img:unique_photo_seed_1',
      kind: 'media',
      sourceSeq: 1n,
      mediaId: T.mediaPhoto,
      stickerFileId: null,
      targetConversationId: null,
      targetThreadId: null,
      expiresAt: '2026-09-13T08:00:03.000Z',
      createdAt: '2026-09-10T08:00:03.000Z',
    })
    .run();

  // --- daily usage (Overview / Usage charts) ---
  const usageRows: readonly (readonly [string, string, string, string, bigint])[] = [
    ['2026-09-13', 'global', 'agent_model', 'tokens', 12_000n],
    ['2026-09-13', 'global', 'agent_model', 'invocations', 4n],
    ['2026-09-13', 'global', 'tools', 'tool_calls', 9n],
    ['2026-09-14', 'global', 'agent_model', 'tokens', 8_000n],
    ['2026-09-14', 'global', 'agent_model', 'invocations', 2n],
    ['2026-09-14', 'global', 'tools', 'tool_calls', 5n],
  ];
  for (const [utcDate, scope, resource, metric, amount] of usageRows) {
    orm
      .insert(dailyUsage)
      .values({
        utcDate,
        scope,
        resource,
        metric,
        amount,
        updatedAt: AT,
      })
      .run();
  }

  return {
    chatId: T.chat,
    conversationId: T.conversation,
    bucketA: T.bucketA,
    bucketB: T.bucketB,
    invocationA: T.invocationA,
    invocationB: T.invocationB,
    messageIds: [T.messageA, T.messageB],
    stickerSetId: T.stickerSet,
    alarmId: T.alarm,
    memoryActiveId: memoryActiveId,
    memoryExpiredId: memoryExpiredId,
    contextId: T.context,
  };
}

/**
 * Bulk rows for the Playwright E2E suite. Every cursor list needs more
 * than `PAGE_SIZE` (25) rows so "Load more" appears and actually fetches the
 * next page against the real backend:
 *
 * - 28 extra invocations (+28 buckets), ids 4_100..4_127;
 * - 28 extra messages (+1 revision each), ids 6_100..6_127, text
 *   `e2e message N` (searchable);
 * - 26 extra conversations (+26 conversation contexts), ids 2_100..2_125 /
 *   11_100..11_125, `last_active_at` newer than the base fixture;
 * - 26 extra pending alarms (10_100..10_125, `e2e alarm N`) plus one
 *   pre-cancelled alarm (10_200) for the state filter;
 * - 28 extra active memories with pattern-valid ids (`mem_` + 32 hex) so the
 *   memory cursor passes `MEMORY_ID_PATTERN`;
 * - 28 extra stickers across the two seeded sets with searchable emoji.
 *
 * Returns the ids the E2E specs need to address specific rows (conflict
 * alarm, searchable message, paginated lists). Do not wire this into any
 * production code path.
 */
export interface AdminBulkSeedIds {
  readonly invocationStart: bigint;
  readonly invocationCount: number;
  readonly messageStart: bigint;
  readonly messageCount: number;
  readonly contextConversationStart: bigint;
  readonly contextCount: number;
  readonly alarmStart: bigint;
  readonly alarmCount: number;
  readonly cancelledAlarmId: bigint;
  readonly stickerStart: bigint;
  readonly stickerCount: number;
  /** id of the first extra memory (`mem_` + 32 hex). */
  readonly memoryFirstId: string;
}

const BULK_BASE = '2026-09-11T08:00:00.000Z';
const EXTRA_INVOCATIONS = 28;
const EXTRA_MESSAGES = 28;
const EXTRA_CONTEXTS = 26;
const EXTRA_ALARMS = 26;
const EXTRA_STICKERS = 28;
const EXTRA_MEMORIES = 28;

export function seedAdminBulkRows(store: SqliteStore): AdminBulkSeedIds {
  const orm = store.orm;
  const iso = (offsetMinutes: number): string => new Date(Date.parse(BULK_BASE) + offsetMinutes * 60_000).toISOString();
  orm
    .insert(senders)
    .values([
      {
        id: 5_002n,
        telegramType: 'sender_chat',
        telegramId: -1009876543210n,
        displayName: 'Anonymous channel',
        username: null,
        isBot: false,
        updatedAt: AT,
      },
      {
        id: 5_003n,
        telegramType: 'user',
        telegramId: 43n,
        displayName: 'Bob',
        username: null,
        isBot: false,
        updatedAt: AT,
      },
    ])
    .run();

  // --- 28 buckets + 28 invocations (24 completed / 4 failed) ---
  for (let index = 0; index < EXTRA_INVOCATIONS; index += 1) {
    const bucketId = 3_100n + BigInt(index);
    const invocationId = 4_100n + BigInt(index);
    const offset = index * 2;
    const failed = index >= EXTRA_INVOCATIONS - 4;
    orm
      .insert(buckets)
      .values({
        id: bucketId,
        conversationId: T.conversation,
        state: failed ? 'failed' : 'completed',
        kind: 'realtime',
        firstReceivedAt: iso(offset),
        deadlineAt: iso(offset + 1),
        queuedAt: iso(offset + 1),
        startedAt: iso(offset + 1),
        finishedAt: iso(offset + 2),
        errorCode: failed ? 'model_failed' : null,
        createdAt: iso(offset),
        updatedAt: iso(offset + 2),
      })
      .run();
    orm
      .insert(invocations)
      .values({
        id: invocationId,
        bucketId,
        conversationId: T.conversation,
        state: failed ? 'failed' : 'completed',
        configHash: `seed-e2e-config-hash-${index}`,
        promptVersion: 7n,
        toolRegistryHash: null,
        toolRegistryJson: null,
        startedAt: iso(offset + 1),
        finishedAt: iso(offset + 2),
        completionReason: failed ? 'model_error' : 'turn_limit_reached',
        errorCode: failed ? 'model_failed' : null,
        sendsUsed: 0n,
        toolCallsUsed: 0n,
        turnsUsed: 1n,
        sideEffectStarted: false,
        createdAt: iso(offset),
      })
      .run();
  }

  // --- 28 messages, each with one text revision (`e2e message N`) ---
  for (let index = 0; index < EXTRA_MESSAGES; index += 1) {
    const messageId = 6_100n + BigInt(index);
    const revisionId = 6_300n + BigInt(index);
    const offset = index + 30;
    orm
      .insert(messages)
      .values({
        id: messageId,
        conversationId: T.conversation,
        chatId: T.chat,
        telegramMessageId: 1_000n + BigInt(index),
        currentRevisionId: null,
        visible: true,
        sentByBot: false,
        telegramDate: iso(offset),
        receivedAt: iso(offset),
      })
      .run();
    orm
      .insert(messageRevisions)
      .values({
        id: revisionId,
        messageId,
        revisionNo: 1n,
        senderId: index === 25 ? 5_003n : index === 26 ? 5_002n : index === 27 ? null : T.sender,
        kind: 'text',
        text: `e2e message ${index + 1}`,
        caption: null,
        replyToMessageId: null,
        replySnapshotJson: null,
        forwardOriginJson: null,
        mediaGroupId: null,
        serviceJson: null,
        createdAt: iso(offset),
        rawFragmentJson: '{}',
      })
      .run();
    orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
  }

  // --- 26 extra conversations + contexts, newest `last_active_at` ---
  for (let index = 0; index < EXTRA_CONTEXTS; index += 1) {
    const conversationId = 2_100n + BigInt(index);
    const contextId = 11_100n + BigInt(index);
    const offset = index + 10;
    orm
      .insert(conversations)
      .values({
        id: conversationId,
        chatId: T.chat,
        messageThreadId: BigInt(100 + index),
        createdAt: iso(offset),
        updatedAt: iso(offset),
      })
      .run();
    orm
      .insert(conversationContexts)
      .values({
        id: contextId,
        conversationId,
        headSeq: 1n,
        nextSeq: 1n,
        sendCountTotal: 0n,
        systemPromptHash: 'seed-e2e-context-hash',
        activeInvocationId: null,
        lastActiveAt: iso(offset),
        lastGcAt: null,
        createdAt: iso(offset),
        updatedAt: iso(offset),
      })
      .run();
  }

  // --- 26 pending alarm tasks + 1 pre-cancelled task ---
  for (let index = 0; index < EXTRA_ALARMS; index += 1) {
    const alarmId = 10_100n + BigInt(index);
    const scheduled = iso(index + 20);
    insertAlarmTask(orm, {
      id: alarmId,
      conversationId: T.conversation,
      targetUserId: 42n,
      summary: `e2e alarm ${index + 1}`,
      scheduledAt: scheduled,
      createdAt: BULK_BASE,
      updatedAt: scheduled,
    });
  }
  insertAlarmTask(orm, {
    id: 10_200n,
    conversationId: T.conversation,
    targetUserId: 42n,
    summary: 'e2e alarm already cancelled',
    scheduledAt: '2026-09-11T10:00:00.000Z',
    createdAt: '2026-09-11T08:00:00.000Z',
    updatedAt: '2026-09-11T09:00:00.000Z',
    state: 'cancelled',
    cancelledAt: '2026-09-11T09:00:00.000Z',
    cancelledBy: 'admin-panel',
  });

  // --- 28 active memories with pattern-valid ids (`mem_` + 32 hex) ---
  const memoryFirstId = `mem_${'0'.repeat(31)}1`;
  for (let index = 0; index < EXTRA_MEMORIES; index += 1) {
    const id = `mem_${String(index + 1).padStart(32, '0')}`;
    orm
      .insert(memories)
      .values({
        id,
        conversationId: T.conversation,
        content: `e2e memory ${index + 1}`,
        createdAt: iso(index),
        expiresAt: '2026-10-15T08:00:00.000Z',
        updatedAt: iso(index),
      })
      .run();
  }

  // --- 28 extra stickers: 16 on `mascot` (14 success / 2 error), 12 on `legacy` ---
  for (let index = 0; index < EXTRA_STICKERS; index += 1) {
    const stickerId = 9_300n + BigInt(index);
    const onMascot = index < 16;
    const failed = index >= 14 && index < 16;
    orm
      .insert(stickers)
      .values({
        id: stickerId,
        stickerSetId: onMascot ? T.stickerSet : T.stickerSetLegacy,
        fileUniqueId: `e2e_sticker_${index + 1}`,
        fileId: `file_e2e_sticker_${index + 1}`,
        emoji: `e2e-${index + 1}`,
        format: 'static',
        thumbnailJson: null,
        active: true,
        currentAnalysisId: null,
        indexState: failed ? 'error' : 'success',
        failureCount: failed ? 1n : 0n,
        nextRetryAt: failed ? '2026-09-12T08:00:10.000Z' : null,
        updatedAt: iso(index),
      })
      .run();
  }

  // --- one today-relative usage row so Overview's "Today's usage" is non-empty ---
  const today = new Date().toISOString().slice(0, 10);
  orm
    .insert(dailyUsage)
    .values({
      utcDate: today,
      scope: 'global',
      resource: 'agent_model',
      metric: 'model_tokens',
      amount: 1_000n,
      updatedAt: new Date().toISOString(),
    })
    .run();

  return {
    invocationStart: 4_100n,
    invocationCount: EXTRA_INVOCATIONS,
    messageStart: 6_100n,
    messageCount: EXTRA_MESSAGES,
    contextConversationStart: 2_100n,
    contextCount: EXTRA_CONTEXTS,
    alarmStart: 10_100n,
    alarmCount: EXTRA_ALARMS,
    cancelledAlarmId: 10_200n,
    stickerStart: 9_300n,
    stickerCount: EXTRA_STICKERS,
    memoryFirstId,
  };
}
