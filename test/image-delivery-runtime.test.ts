import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import Type from 'typebox';
import { afterEach, expect, test } from 'vitest';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime, type ToolFactory } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig } from '../src/platform/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/**
 * Runtime regression for repeated picture delivery (audit 3486).
 *
 * The ordinary tool chain can deliver an image before its completion receipt is
 * injected: `image_generate` settles while the tool chain is still open, the
 * scheduler claims the receipt onto the running invocation, the model already
 * sends the picture, and only then does a no-tool turn inject the receipt. A
 * model reading that receipt naturally sends the same generation again.
 *
 * The contract under test:
 *  - `send kind:image` is deduplicated per conversation + generation + asset id
 *    against successful `telegram_sends` audit rows. A repeat is a successful
 *    no-op: details `${telegramMessageId, replayed: true}`, tool call success
 *    with `side_effect = false`, a result text that says the picture was already
 *    delivered, no new `telegram_sends` row, no `sends_used` increment and no
 *    canonical `send_count_total` / `send_seq` increment.
 *  - A real image delivery keeps its existing details and now records the
 *    delivered `asset_ids` in `telegram_sends.request_json`.
 *  - The injected image completion receipt carries `image_delivery` with the
 *    delivered / pending / unknown asset ids as of the injection instant.
 *  - A later ordinary user invocation may still resend the same generation once,
 *    but only when it passes `resend: true`; without it the call stays a no-op.
 *
 * Real store, AgentRuntime, ConversationRuntime, BucketScheduler and
 * LongTaskService; a Faux agent, mock picture bytes, and no network, real
 * config/key.json, `serve` or configuration reload.
 */

const GENERATION_ID = '7b2f8f3a-9c4d-4e5f-8a6b-1c2d3e4f5a6b';
const ASSET_ID = 'asset-3486';
const UNSENT_ASSET_ID = 'asset-3486-unsent';
const RECEIPT_MARKER = '<untrusted_task_receipt>';
const FIRST_PHOTO_MESSAGE_ID = 900;
const RESENT_PHOTO_MESSAGE_ID = 901;
// Tolerant to wording ("already been delivered", "already_delivered", ...).
const ALREADY_DELIVERED = /already[\s_-]*(been[\s_-]*)?delivered/i;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture(options: { readonly unsentOutputs?: readonly string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-delivery-'));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 0;
      config.agent.send_nudge_enabled = false;
      config.agent.send_barrier_enabled = false;
      config.agent.context.idle_grace_seconds = 0;
      config.agent.context.retained_sends_target = 20;
      config.agent.context.retained_sends_max = 30;
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
  });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const tasks = new LongTaskService(store.orm);
  const conversationRuntime = new ConversationRuntime({ agentCacheSize: 8 });
  const photoMessageIds: number[] = [];
  let nextMessageId = FIRST_PHOTO_MESSAGE_ID;
  let photoFailures = 0;
  const telegramApi: TelegramSendApi = {
    sendMessage: async () => ({ message_id: nextMessageId++, date: 1_700_000_000, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: nextMessageId++, date: 1_700_000_000, chat: { id: 123456789 } }),
    sendGeneratedPhoto: async () => {
      if (photoFailures > 0) {
        photoFailures -= 1;
        throw new HttpError('network failed', new Error('socket closed'));
      }
      const messageId = nextMessageId++;
      photoMessageIds.push(messageId);
      return {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 123456789 },
        photo: [{ file_id: `photo-${messageId}`, file_unique_id: `unique-${messageId}`, width: 512, height: 512 }],
      };
    },
    sendGeneratedPhotoGroup: async () => [],
  };
  // Mock worker: fixed bytes, only for the generation of the asking conversation.
  let activeConversationId: bigint | null = null;
  const imageGeneration = {
    resolve: (generationId: string, conversationId: bigint) =>
      generationId === GENERATION_ID && conversationId === activeConversationId
        ? [{ assetId: ASSET_ID, bytes: new Uint8Array([137, 80, 78, 71]), fileName: 'harbor.png' }]
        : undefined,
  };
  const requests: string[] = [];
  const snapshots: Record<string, unknown> = {};
  let schedulerRef: BucketScheduler | null = null;
  // Stand-in for the image capability: submits the long task and lets the
  // generation settle while the tool chain is still open, exactly like a fast
  // provider finishing before the round reaches a no-tool turn.
  const additionalTools: ToolFactory = (context) => {
    activeConversationId = context.conversationId;
    return [
      {
        name: 'image_generate',
        label: 'Generate image',
        description: 'Submit an image generation request. Stand-in for the image capability in this regression.',
        parameters: Type.Object(
          { prompt: Type.String({ minLength: 1, maxLength: 8000 }) },
          { additionalProperties: false },
        ),
        executionMode: 'sequential',
        execute: async () => {
          const scope = tasks.scoped('image', context.conversationId);
          const task = scope.create({
            payload: {
              generation_id: GENERATION_ID,
              model_id: 'mock-image-model',
              prompt_preview: 'a quiet harbor at dusk',
              output_count: 1,
            },
          });
          scope.complete(task.taskId, {
            generation_id: GENERATION_ID,
            status: 'succeeded',
            model_id: 'mock-image-model',
            prompt_preview: 'a quiet harbor at dusk',
            outputs: [
              { asset_id: ASSET_ID, file_name: 'harbor.png', mime: 'image/png' },
              ...(options.unsentOutputs ?? []).map((assetId) => ({
                asset_id: assetId,
                file_name: `${assetId}.png`,
                mime: 'image/png',
              })),
            ],
            error: null,
          });
          if (schedulerRef === null) {
            throw new Error('scheduler is not wired');
          }
          schedulerRef.processTasksDue();
          snapshots.receiptStateWhileToolChainOpen = queryReceipts(store)[0]?.state;
          return {
            content: [
              {
                type: 'text',
                text: `Generation ${GENERATION_ID} submitted on model mock-image-model (1 output(s)). The result arrives as a completion receipt; do not claim the image exists before then.`,
              },
            ],
            details: { generation_id: GENERATION_ID, model_id: 'mock-image-model', output_count: 1, replayed: false },
          };
        },
      },
    ];
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    conversationRuntime,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    telegramApi,
    additionalTools,
    imageGeneration,
  });
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  schedulerRef = scheduler;
  cleanups.push(async () => {
    await scheduler.stop(0);
  });
  return {
    store,
    faux,
    scheduler,
    ingestion,
    tasks,
    requests,
    snapshots,
    photoMessageIds,
    failNextPhoto: (): void => {
      photoFailures += 1;
    },
  };
}

function update(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function queryReceipts(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        task_id: bigint;
        bucket_id: bigint;
        invocation_id: bigint;
        state: string;
        invocation_outcome: string | null;
        completion_reason: string | null;
      }
    >(
      'SELECT task_id, bucket_id, invocation_id, state, invocation_outcome, completion_reason FROM task_receipts ORDER BY task_id',
    )
    .all();
}

function queryInvocations(store: SqliteStore) {
  return store.db
    .prepare<[], { id: bigint; state: string; sends_used: bigint }>(
      'SELECT id, state, sends_used FROM invocations ORDER BY id',
    )
    .all();
}

function querySendToolCalls(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        tool_call_id: string;
        invocation_id: bigint;
        state: string;
        side_effect: bigint;
        result_text: string | null;
        error_code: string | null;
      }
    >(
      "SELECT tool_call_id, invocation_id, state, side_effect, result_text, error_code FROM tool_calls WHERE tool_name = 'send' ORDER BY id",
    )
    .all();
}

function queryImageSends(store: SqliteStore) {
  return store.db
    .prepare<[], { id: bigint; state: string; request_json: string; telegram_message_id: bigint | null }>(
      "SELECT id, state, request_json, telegram_message_id FROM telegram_sends WHERE kind = 'image' ORDER BY id",
    )
    .all();
}

function retainedContext(store: SqliteStore, conversationId: bigint) {
  const contexts = new ConversationContextStore(store);
  const header = contexts.header(conversationId);
  if (header === undefined) {
    throw new Error('Conversation context is missing');
  }
  return { header, messages: contexts.retained(header) };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

function detailsOf(message: { readonly details?: unknown }): Record<string, unknown> {
  return (message.details ?? {}) as Record<string, unknown>;
}

function imageDeliveryOf(text: string): Record<string, unknown> | undefined {
  const json = text.split('<untrusted_task_receipt>\n')[1]?.split('\n</untrusted_task_receipt>')[0];
  if (json === undefined) {
    throw new Error('Completion receipt JSON is missing');
  }
  return (JSON.parse(json) as { image_delivery?: Record<string, unknown> }).image_delivery;
}

function sendImage(toolCallId: string, input: Record<string, unknown> = {}) {
  return fauxAssistantMessage(
    fauxToolCall(
      'send',
      { kind: 'image', image_generation_id: GENERATION_ID, text: 'harbor is ready', ...input },
      { id: toolCallId },
    ),
    { stopReason: 'toolUse' },
  );
}

async function finished(f: Awaited<ReturnType<typeof fixture>>, count: bigint) {
  await expect
    .poll(
      () =>
        f.store.db
          .prepare<[], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocations WHERE state NOT IN ('running', 'queued')",
          )
          .get()?.count,
    )
    .toBe(count);
}

test('a delivered generation is replayed as a no-op when its receipt is answered again, and resends only on an explicit request', async () => {
  const f = await fixture();

  // --- First invocation: deliver while the receipt waits, then answer the receipt --------
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      // No-tool turn: the claimed receipt is injected at this boundary, after
      // the first delivery already went out.
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('ordinary round done');
    },
    (context) => {
      // Receipt round: the model sees the receipt and the first send's success
      // result, and deliberately sends the same generation again.
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-2');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.snapshots.receiptStateWhileToolChainOpen).toBe('claimed');
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID]);

  // The receipt was claimed onto this invocation and injected exactly once.
  const receipts = queryReceipts(f.store);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    state: 'handled',
    invocation_outcome: 'completed',
    completion_reason: 'completed',
  });
  const invocationId = receipts[0]!.invocation_id;
  expect(queryInvocations(f.store)).toEqual([{ id: invocationId, state: 'completed', sends_used: 1n }]);
  const attached = f.store.db
    .prepare<[], { bucket_id: bigint; invocation_id: bigint; injected_at: string | null }>(
      'SELECT bucket_id, invocation_id, injected_at FROM invocation_buckets ORDER BY bucket_id',
    )
    .all();
  expect(attached).toHaveLength(2);
  expect(attached.map((row) => row.invocation_id)).toEqual([invocationId, invocationId]);
  expect(attached.map((row) => row.injected_at)).toEqual([expect.any(String), expect.any(String)]);
  expect(attached[1]!.bucket_id).toBe(receipts[0]!.bucket_id);
  expect(attached[0]!.bucket_id).not.toBe(attached[1]!.bucket_id);

  // One real delivery, recorded with its asset ids; the second call is an
  // audited success that never reached Telegram.
  const firstSends = queryImageSends(f.store);
  expect(firstSends).toHaveLength(1);
  expect(firstSends[0]!.state).toBe('success');
  expect(firstSends[0]!.telegram_message_id).toBe(BigInt(FIRST_PHOTO_MESSAGE_ID));
  const sendRequest = JSON.parse(firstSends[0]!.request_json) as Record<string, unknown>;
  expect(sendRequest.kind).toBe('image');
  expect(sendRequest.generation_id).toBe(GENERATION_ID);
  expect(sendRequest.asset_ids).toEqual([ASSET_ID]);
  const sendCalls = querySendToolCalls(f.store);
  expect(sendCalls.map(({ tool_call_id, state, side_effect }) => ({ tool_call_id, state, side_effect }))).toEqual([
    { tool_call_id: 'call-send-1', state: 'success', side_effect: 1n },
    { tool_call_id: 'call-send-2', state: 'success', side_effect: 0n },
  ]);
  expect(sendCalls[0]!.result_text ?? '').toContain(String(FIRST_PHOTO_MESSAGE_ID));
  expect(sendCalls[1]!.result_text ?? '').toMatch(ALREADY_DELIVERED);
  for (const call of sendCalls) {
    expect(call.error_code).toBeNull();
    expect(call.invocation_id).toBe(invocationId);
  }

  // Canonical history: two send tool results, the second one replayed; the
  // replay added neither a canonical send nor a reference.
  const firstContext = retainedContext(f.store, 1n);
  const sendResults = firstContext.messages.flatMap(({ seq, message }) =>
    message.role === 'toolResult' && message.toolName === 'send' ? [{ seq, message }] : [],
  );
  expect(sendResults).toHaveLength(2);
  expect(textOf(sendResults[0]!.message.content)).toContain(`Sent Telegram message ${FIRST_PHOTO_MESSAGE_ID}`);
  expect(detailsOf(sendResults[0]!.message)).toMatchObject({
    telegramMessageId: String(FIRST_PHOTO_MESSAGE_ID),
  });
  expect(detailsOf(sendResults[0]!.message).replayed).not.toBe(true);
  expect(textOf(sendResults[1]!.message.content)).toMatch(ALREADY_DELIVERED);
  expect(detailsOf(sendResults[1]!.message)).toMatchObject({
    telegramMessageId: String(FIRST_PHOTO_MESSAGE_ID),
    replayed: true,
  });
  expect(
    f.store.db
      .prepare<[], { seq: bigint; send_seq: bigint }>(
        'SELECT seq, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all(),
  ).toEqual([{ seq: sendResults[0]!.seq, send_seq: 1n }]);
  expect(
    f.store.db
      .prepare<[bigint], { send_seq: bigint | null }>('SELECT send_seq FROM context_messages WHERE seq = ?')
      .get(sendResults[1]!.seq),
  ).toEqual({ send_seq: null });
  expect(
    f.store.db
      .prepare<[], { send_count_total: bigint }>(
        'SELECT send_count_total FROM conversation_contexts WHERE conversation_id = 1',
      )
      .get(),
  ).toEqual({ send_count_total: 1n });
  expect(firstContext.header.headSeq).toBe(1n);
  expect(firstContext.header.nextSeq).toBe(
    f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()!.count + 1n,
  );
  expect(
    f.store.db.prepare('SELECT ref, kind, source_seq, target_conversation_id FROM context_refs ORDER BY ref').all(),
  ).toEqual([{ ref: 'reply:1', kind: 'reply', source_seq: 1n, target_conversation_id: 1n }]);

  // Faux decision order: the receipt is absent before its boundary, and the
  // second decision sees both the receipt (with image_delivery) and the first
  // send's success result; the turn after the replay sees the replay result.
  expect(f.requests[1]).not.toContain(RECEIPT_MARKER);
  expect(f.requests[2]).not.toContain(RECEIPT_MARKER);
  expect(f.requests[3]).toContain(RECEIPT_MARKER);
  expect(f.requests[3]).toContain(GENERATION_ID);
  expect(f.requests[3]).toContain(`Sent Telegram message ${FIRST_PHOTO_MESSAGE_ID}`);
  expect(f.requests[4]).toMatch(ALREADY_DELIVERED);

  // --- Second invocation: an ordinary new message still may resend, but only on request ----
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-3');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-4', { resend: true });
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('resent');
    },
  ]);
  f.ingestion.ingest(update(2, 'can you send it again?'));
  f.scheduler.processDue();
  f.scheduler.wake();
  await finished(f, 2n);

  expect(f.requests).toHaveLength(8);
  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID, RESENT_PHOTO_MESSAGE_ID]);
  const invocations = queryInvocations(f.store);
  expect(invocations).toHaveLength(2);
  expect(invocations.map(({ state, sends_used }) => ({ state, sends_used }))).toEqual([
    { state: 'completed', sends_used: 1n },
    { state: 'completed', sends_used: 1n },
  ]);
  const allCalls = querySendToolCalls(f.store);
  expect(allCalls.map(({ tool_call_id, state, side_effect }) => ({ tool_call_id, state, side_effect }))).toEqual([
    { tool_call_id: 'call-send-1', state: 'success', side_effect: 1n },
    { tool_call_id: 'call-send-2', state: 'success', side_effect: 0n },
    { tool_call_id: 'call-send-3', state: 'success', side_effect: 0n },
    { tool_call_id: 'call-send-4', state: 'success', side_effect: 1n },
  ]);
  expect(allCalls[2]!.result_text ?? '').toMatch(ALREADY_DELIVERED);
  expect(allCalls[3]!.result_text ?? '').toContain(String(RESENT_PHOTO_MESSAGE_ID));
  expect(queryImageSends(f.store).map(({ state, telegram_message_id }) => ({ state, telegram_message_id }))).toEqual([
    { state: 'success', telegram_message_id: BigInt(FIRST_PHOTO_MESSAGE_ID) },
    { state: 'success', telegram_message_id: BigInt(RESENT_PHOTO_MESSAGE_ID) },
  ]);
  for (const row of queryImageSends(f.store)) {
    const request = JSON.parse(row.request_json) as Record<string, unknown>;
    expect(request.asset_ids).toEqual([ASSET_ID]);
  }

  const secondContext = retainedContext(f.store, 1n);
  const allResults = secondContext.messages.flatMap(({ seq, message }) =>
    message.role === 'toolResult' && message.toolName === 'send' ? [{ seq, message }] : [],
  );
  expect(allResults).toHaveLength(4);
  expect(textOf(allResults[2]!.message.content)).toMatch(ALREADY_DELIVERED);
  expect(textOf(allResults[3]!.message.content)).toContain(`Sent Telegram message ${RESENT_PHOTO_MESSAGE_ID}`);
  expect(detailsOf(allResults[3]!.message)).toMatchObject({
    telegramMessageId: String(RESENT_PHOTO_MESSAGE_ID),
  });
  expect(detailsOf(allResults[3]!.message).replayed).not.toBe(true);
  expect(
    f.store.db
      .prepare<[], { seq: bigint; send_seq: bigint }>(
        'SELECT seq, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all(),
  ).toEqual([
    { seq: allResults[0]!.seq, send_seq: 1n },
    { seq: allResults[3]!.seq, send_seq: 2n },
  ]);
  for (const replay of [allResults[1]!, allResults[2]!]) {
    expect(
      f.store.db
        .prepare<[bigint], { send_seq: bigint | null }>('SELECT send_seq FROM context_messages WHERE seq = ?')
        .get(replay.seq),
    ).toEqual({ send_seq: null });
  }
  expect(
    f.store.db
      .prepare<[], { send_count_total: bigint }>(
        'SELECT send_count_total FROM conversation_contexts WHERE conversation_id = 1',
      )
      .get(),
  ).toEqual({ send_count_total: 2n });
  expect(secondContext.header.headSeq).toBe(1n);
  expect(secondContext.header.nextSeq).toBe(
    f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()!.count + 1n,
  );
  expect(queryReceipts(f.store)).toHaveLength(1);
  const attachedAll = f.store.db
    .prepare<[], { bucket_id: bigint; invocation_id: bigint; injected_at: string | null }>(
      'SELECT bucket_id, invocation_id, injected_at FROM invocation_buckets ORDER BY bucket_id',
    )
    .all();
  expect(attachedAll.filter((row) => row.invocation_id === invocations[0]!.id)).toHaveLength(2);
  expect(attachedAll.filter((row) => row.invocation_id === invocations[1]!.id)).toHaveLength(1);
  for (const row of attachedAll) {
    expect(row.injected_at).toEqual(expect.any(String));
  }

  // References stay consistent across the replay: one per ordinary batch, none minted by
  // either replay. Rendering the retained history in the second invocation authorizes the
  // one delivered picture, so exactly one media ref points at the bot's photo message.
  const userSeqs = f.store.db
    .prepare<[], { seq: bigint }>("SELECT seq FROM context_messages WHERE role = 'user' ORDER BY seq")
    .all();
  expect(userSeqs).toHaveLength(3);
  const refs = f.store.db
    .prepare<[], { ref: string; kind: string; source_seq: bigint; target_conversation_id: bigint | null }>(
      'SELECT ref, kind, source_seq, target_conversation_id FROM context_refs ORDER BY ref',
    )
    .all();
  expect(refs.map((row) => row.kind).sort()).toEqual(['media', 'reply', 'reply']);
  expect(
    refs
      .filter((row) => row.kind === 'reply')
      .map(({ ref, source_seq, target_conversation_id }) => ({ ref, source_seq, target_conversation_id })),
  ).toEqual([
    { ref: 'reply:1', source_seq: userSeqs[0]!.seq, target_conversation_id: 1n },
    { ref: 'reply:2', source_seq: userSeqs[2]!.seq, target_conversation_id: 1n },
  ]);
  expect(
    f.store.db
      .prepare<[], { telegram_message_id: bigint }>(
        `SELECT m.telegram_message_id AS telegram_message_id
         FROM context_refs r
         JOIN media md ON md.id = r.media_id
         JOIN message_revisions mr ON mr.id = md.revision_id
         JOIN messages m ON m.id = mr.message_id
         WHERE r.kind = 'media'`,
      )
      .all(),
  ).toEqual([{ telegram_message_id: BigInt(FIRST_PHOTO_MESSAGE_ID) }]);

  // The receipt injection the model actually read: one receipt, marked delivered.
  const receiptMessages = firstContext.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER)
      ? [{ text: textOf(message.content) }]
      : [],
  );
  expect(receiptMessages).toHaveLength(1);
  const receiptText = receiptMessages[0]!.text;
  expect(receiptText).toContain(GENERATION_ID);
  const delivery = imageDeliveryOf(receiptText);
  expect(delivery).toBeDefined();
  expect(delivery?.delivered_asset_ids).toEqual([ASSET_ID]);
  expect(delivery?.pending_asset_ids).toEqual([]);
  expect(delivery?.unknown_asset_ids).toEqual([]);
  expect(f.requests[3]).toContain('image_delivery');
});

test('a completion receipt round rejects resend:true and replays the delivered generation instead', async () => {
  const f = await fixture();
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('ordinary round done');
    },
    (context) => {
      // Receipt round: resend:true is a user-resolved action, not a
      // receipt-driven retry, so it must not deliver the picture again.
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-resend', { resend: true });
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-2');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID]);
  expect(queryImageSends(f.store)).toHaveLength(1);
  const calls = querySendToolCalls(f.store);
  expect(calls.map(({ tool_call_id, state }) => ({ tool_call_id, state }))).toEqual([
    { tool_call_id: 'call-send-1', state: 'success' },
    { tool_call_id: 'call-send-resend', state: 'error' },
    { tool_call_id: 'call-send-2', state: 'success' },
  ]);
  expect(calls[0]!.side_effect).toBe(1n);
  expect(calls[1]!.error_code).not.toBeNull();
  expect(calls[2]!.side_effect).toBe(0n);
  expect(calls[2]!.result_text ?? '').toMatch(ALREADY_DELIVERED);

  const context = retainedContext(f.store, 1n);
  const results = context.messages.flatMap(({ seq, message }) =>
    message.role === 'toolResult' && message.toolName === 'send' ? [{ seq, message }] : [],
  );
  expect(results).toHaveLength(3);
  expect(results[1]!.message.isError).toBe(true);
  expect(textOf(results[1]!.message.content)).toMatch(/resend/i);
  expect(detailsOf(results[2]!.message)).toMatchObject({ replayed: true });
  expect(
    f.store.db
      .prepare<[], { send_count_total: bigint }>(
        'SELECT send_count_total FROM conversation_contexts WHERE conversation_id = 1',
      )
      .get(),
  ).toEqual({ send_count_total: 1n });
  expect(
    f.store.db
      .prepare<[], { seq: bigint; send_seq: bigint }>(
        'SELECT seq, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all(),
  ).toEqual([{ seq: results[0]!.seq, send_seq: 1n }]);
});

test('an ordinary completion receipt does not carry image_delivery', async () => {
  const f = await fixture();
  f.faux.setResponses([
    () => {
      const scope = f.tasks.scoped('exporter', 1n);
      const task = scope.create({ payload: { name: 'Alice' } });
      scope.complete(task.taskId, { result: 'ordinary-result' });
      f.scheduler.processTasksDue();
      return fauxAssistantMessage('ordinary round done');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'ordinary request'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  const receipts = queryReceipts(f.store);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ state: 'handled', invocation_outcome: 'completed' });
  const context = retainedContext(f.store, 1n);
  const receiptTexts = context.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER) ? [textOf(message.content)] : [],
  );
  expect(receiptTexts).toHaveLength(1);
  expect(receiptTexts[0]).toContain('ordinary-result');
  expect(receiptTexts[0]).not.toContain('image_delivery');
});

test('a success and an unknown attempt on one asset stay mutually exclusive in the receipt, and an unsent output stays pending', async () => {
  const f = await fixture({ unsentOutputs: [UNSENT_ASSET_ID] });
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      // A user-requested resend starts before the receipt reaches the model and
      // Telegram never confirms it: the asset now has one success and one
      // unknown attempt in the same delivery ledger.
      f.requests.push(JSON.stringify(context.messages));
      f.failNextPhoto();
      return sendImage('call-send-2', { resend: true });
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt boundary');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID]);
  expect(queryImageSends(f.store).map(({ state, telegram_message_id }) => ({ state, telegram_message_id }))).toEqual([
    { state: 'success', telegram_message_id: BigInt(FIRST_PHOTO_MESSAGE_ID) },
    { state: 'outcome_unknown', telegram_message_id: null },
  ]);
  expect(JSON.parse(queryImageSends(f.store)[1]!.request_json)).toMatchObject({ asset_ids: [ASSET_ID] });

  // The receipt the model actually read: unknown wins over the earlier success,
  // and the output nothing ever tried to send is still pending.
  const context = retainedContext(f.store, 1n);
  const receiptTexts = context.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER) ? [textOf(message.content)] : [],
  );
  expect(receiptTexts).toHaveLength(1);
  expect(imageDeliveryOf(receiptTexts[0]!)).toEqual({
    delivered_asset_ids: [],
    pending_asset_ids: [UNSENT_ASSET_ID],
    unknown_asset_ids: [ASSET_ID],
  });
  expect(f.requests[4]).toContain(UNSENT_ASSET_ID);
});

test('an unprovable legacy delivery set makes the whole generation unknown instead of delivered', async () => {
  const f = await fixture();
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-2', { resend: true });
    },
    () => {
      // Migration 027 leaves `asset_ids_unknown` on a pre-`asset_ids` send whose
      // shipped set could not be proven. That uncertainty covers the whole
      // generation, so the earlier success must not read as delivered.
      const legacy = queryImageSends(f.store)[1]!;
      f.store.db
        .prepare(
          "UPDATE telegram_sends SET request_json = json_set(request_json, '$.asset_ids_unknown', json('true')) WHERE id = ?",
        )
        .run(legacy.id);
      return fauxAssistantMessage('receipt boundary');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID, RESENT_PHOTO_MESSAGE_ID]);
  const context = retainedContext(f.store, 1n);
  const receiptTexts = context.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER) ? [textOf(message.content)] : [],
  );
  expect(receiptTexts).toHaveLength(1);
  expect(imageDeliveryOf(receiptTexts[0]!)).toEqual({
    delivered_asset_ids: [],
    pending_asset_ids: [],
    unknown_asset_ids: [ASSET_ID],
  });
});
