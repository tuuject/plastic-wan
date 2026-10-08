import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { GrammyError, HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { createSendTool, type SendToolEnvironment, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { attachBucketToInvocation, InvocationQueueService } from '../src/orchestration/invocation-queue.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig, type RawConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { buckets, invocationBuckets, invocations, telegramSends, toolCalls } from '../src/store/schema.ts';
import {
  fauxRegistry,
  invocationCapabilities,
  renderInvocationContext,
  type TestContextOptions,
  type TestInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
} from './helpers.ts';

/**
 * Regression contract for default reply deduplication: one conversation may
 * `send` at most one reply to one Telegram message id unless explicitly allowed,
 * regardless of content changes or switching to a sticker or generated picture.
 *
 * The dedup key is the retained audit (telegram_sends.conversation_id +
 * request_json.reply_to_message_id), so it holds across invocations, freshly
 * built tools, rebuilt contexts and SQLite close/open. A prior `success`
 * rejects with `reply_already_sent`; a prior `pending` / `outcome_unknown`
 * rejects with `reply_delivery_unknown`; an explicit `error` still allows a
 * retry. A rejection must add no telegram_sends row, call no API, and consume
 * no sends_used / rate-limit budget / send barrier.
 */

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  build: (invocationId: bigint, options?: TestContextOptions) => TestInvocationContext;
  close: () => void;
}

async function setup(chatIds: number[] = [123456789], allowReplyMessageMultipleTimes?: boolean): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-reply-dedup-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = chatIds.map((id) => ({ id, instructions_file: 'chat-instructions.md' }));
      if (allowReplyMessageMultipleTimes !== undefined) {
        config.agent.allow_reply_message_multiple_times = allowReplyMessageMultipleTimes;
      }
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  return {
    store,
    config: loaded.config,
    configStore,
    ingestion,
    scheduler,
    build: (invocationId, options = {}) => renderInvocationContext(store, loaded.config, invocationId, options),
    close: () => store.close(),
  };
}

function update(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

/** Ingests one message and returns the built context for its invocation. */
async function conversationContext(
  fixture: Fixture,
  updateId: number,
  messageId: number,
  received: Date,
  text = 'hello',
  chatId = 123456789,
): Promise<TestInvocationContext> {
  fixture.ingestion.ingest(update(updateId, messageId, text, chatId), received);
  const invocationId = processOne(fixture.scheduler, new Date(received.getTime() + 15_000));
  // Close the round so the scheduler opens a fresh invocation for the next
  // message of the same chat, exactly as the runtime does after a run.
  fixture.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  fixture.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  return fixture.build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
}

type SendArgs = Parameters<ReturnType<typeof createSendTool>['execute']>[1];
type SendTool = ReturnType<typeof createSendTool>;

interface CountingApi extends TelegramSendApi {
  readonly calls: number;
}

function countingApi(gate?: Promise<void>): CountingApi {
  let calls = 0;
  const respond = async (base: number, photo = false): Promise<Awaited<ReturnType<TelegramSendApi['sendMessage']>>> => {
    calls += 1;
    const sequence = calls;
    if (gate !== undefined) {
      await gate;
    }
    const response: Awaited<ReturnType<TelegramSendApi['sendMessage']>> = {
      message_id: base + sequence,
      date: 1_700_000_100 + sequence,
      chat: { id: 123456789 },
    };
    return photo
      ? { ...response, photo: [{ file_id: 'f1', file_unique_id: 'fu1', width: 100, height: 100 }] }
      : response;
  };
  return {
    get calls() {
      return calls;
    },
    sendMessage: () => respond(500),
    sendSticker: () => respond(600),
    sendGeneratedPhoto: () => respond(700, true),
    sendGeneratedPhotoGroup: (_chatId, pictures) =>
      respond(700, true).then((response) =>
        pictures.map((_picture, index) => ({
          ...response,
          message_id: response.message_id + index,
        })),
      ),
  };
}

function makeTool(
  store: SqliteStore,
  config: RawConfig,
  context: TestInvocationContext,
  options: {
    readonly api?: TelegramSendApi;
    readonly sendsPerWindow?: number;
    readonly imageGeneration?: SendToolEnvironment['imageGeneration'];
    readonly holdForNewMessages?: () => boolean;
  } = {},
): { readonly tool: SendTool; readonly capabilities: ReturnType<typeof invocationCapabilities> } {
  const capabilities = invocationCapabilities(store, config, context.header);
  const tool = createSendTool({
    store,
    api: options.api ?? countingApi(),
    context,
    capabilities,
    sendRateLimit: { sendsPerWindow: options.sendsPerWindow ?? 6, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    ...(options.imageGeneration === undefined ? {} : { imageGeneration: options.imageGeneration }),
    ...(options.holdForNewMessages === undefined ? {} : { holdForNewMessages: options.holdForNewMessages }),
  });
  return { tool, capabilities };
}

interface ToolCallRow {
  readonly tool_call_id: string;
  readonly state: string;
  readonly error_code: string | null;
}

interface SendRow {
  readonly state: string;
  readonly error_code: string | null;
  readonly request_json: string;
}

function toolAudit(store: SqliteStore): ToolCallRow[] {
  return store.db.prepare<[], ToolCallRow>('SELECT tool_call_id, state, error_code FROM tool_calls ORDER BY id').all();
}

function sendAudit(store: SqliteStore): SendRow[] {
  return store.db.prepare<[], SendRow>('SELECT state, error_code, request_json FROM telegram_sends ORDER BY id').all();
}

function errorCodeOf(store: SqliteStore, callId: string): string | null {
  for (const row of toolAudit(store)) {
    if (row.tool_call_id === callId) {
      return row.error_code;
    }
  }
  return null;
}

function sendsUsed(store: SqliteStore, invocationId: bigint): bigint {
  return (
    store.db
      .prepare<[bigint], { sends_used: bigint }>('SELECT sends_used FROM invocations WHERE id = ?')
      .get(invocationId)?.sends_used ?? 0n
  );
}

async function expectRejected(tool: SendTool, callId: string, args: SendArgs): Promise<void> {
  await expect(tool.execute(callId, args)).rejects.toThrow();
}

const imageGeneration: SendToolEnvironment['imageGeneration'] = {
  resolve: (generationId) =>
    generationId === 'gen-1' || generationId === 'gen-2'
      ? [{ assetId: `asset-${generationId}`, bytes: new Uint8Array([1, 2, 3]), fileName: 'pic.png' }]
      : undefined,
};

describe('reply deduplication', () => {
  const matrix: {
    readonly name: string;
    readonly first: (stickerRef: string) => SendArgs;
    readonly second: (stickerRef: string) => SendArgs;
  }[] = [
    {
      name: 'changed text content',
      first: () => ({ kind: 'text', text: 'first answer', reply_to_message_id: '10' }),
      second: () => ({ kind: 'text', text: 'a different answer', reply_to_message_id: '10' }),
    },
    {
      name: 'a sticker after a text reply',
      first: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
      second: (stickerRef) => ({ kind: 'sticker', sticker_ref: stickerRef, reply_to_message_id: '10' }),
    },
    {
      name: 'a text after a sticker reply',
      first: (stickerRef) => ({ kind: 'sticker', sticker_ref: stickerRef, reply_to_message_id: '10' }),
      second: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
    },
    {
      name: 'a generated image after a text reply',
      first: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
      second: () => ({ kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' }),
    },
    {
      name: 'a text after a generated image reply',
      first: () => ({ kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' }),
      second: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
    },
    {
      name: 'a resend:true image after an image reply to the same message',
      first: () => ({ kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' }),
      second: () => ({ kind: 'image', image_generation_id: 'gen-2', resend: true, reply_to_message_id: '10' }),
    },
  ];

  test.each(matrix.flatMap((entry) => [undefined, false, true].map((allow) => ({ ...entry, allow }))))(
    'applies allow_reply_message_multiple_times=$allow to $name',
    async ({ first, second, allow }) => {
      const fixture = await setup(undefined, allow);
      try {
        const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
        const api = countingApi();
        const { tool, capabilities } = makeTool(fixture.store, fixture.config, context, { api, imageGeneration });
        expect(tool.description.includes('at most one reply')).toBe(allow !== true);
        const stickerRef = capabilities.registerStickerRef('CAAD-fake-sticker');
        const firstResult = await tool.execute('first', first(stickerRef));
        expect(firstResult.details.telegramMessageId).toBeTruthy();
        if (allow === true) {
          await tool.execute('second', second(stickerRef));
          expect(toolAudit(fixture.store)).toEqual([
            { tool_call_id: 'first', state: 'success', error_code: null },
            { tool_call_id: 'second', state: 'success', error_code: null },
          ]);
        } else {
          await expectRejected(tool, 'second', second(stickerRef));
          expect(errorCodeOf(fixture.store, 'second')).toBe('reply_already_sent');
        }
        const expectedSends = allow === true ? 2 : 1;
        expect(api.calls).toBe(expectedSends);
        expect(sendAudit(fixture.store)).toEqual(
          Array.from({ length: expectedSends }, () => ({
            state: 'success',
            error_code: null,
            request_json: expect.stringContaining('"10"'),
          })),
        );
        expect(sendsUsed(fixture.store, context.invocationId)).toBe(BigInt(expectedSends));
      } finally {
        fixture.close();
      }
    },
  );

  test('runtime freezes reply policy per invocation and applies changes to the next one', async () => {
    const fixture = await setup(undefined, false);
    try {
      const faux = fauxProvider({
        provider: 'agent',
        models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 128 }],
      });
      fixture.configStore.publish({ ...fixture.configStore.current(), ...fauxRegistry(faux) });
      const api = countingApi();
      const runtime = new AgentRuntime({
        store: fixture.store,
        configStore: fixture.configStore,
        secrets: new SecretStore(),
        telegramApi: api,
        bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
        systemResources: SystemResources.empty(),
      });
      const t0 = new Date('2026-08-15T00:00:00.000Z');
      fixture.ingestion.ingest(update(1, 10, 'hello'), t0);
      const first = processOne(fixture.scheduler, new Date(t0.getTime() + 15_000));
      faux.setResponses([
        (context) => {
          expect(context.tools?.find((tool) => tool.name === 'send')?.description).toContain('at most one reply');
          const current = fixture.configStore.current();
          fixture.configStore.publish({
            ...current,
            config: { ...current.config, agent: { ...current.config.agent, allow_reply_message_multiple_times: true } },
          });
          return fauxAssistantMessage(fauxToolCall('send', { text: 'first', reply_to_message_id: '10' }), {
            stopReason: 'toolUse',
          });
        },
        fauxAssistantMessage(fauxToolCall('send', { text: 'duplicate', reply_to_message_id: '10' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ]);
      await runtime.run(first, fixture.configStore.beginInvocation(), new AbortController().signal);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([null, 'reply_already_sent']);
      expect(api.calls).toBe(1);
      fixture.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      fixture.store.orm.update(invocations).set({ state: 'completed' }).where(eq(invocations.id, first)).run();
      const t1 = new Date(t0.getTime() + 60_000);
      fixture.ingestion.ingest(update(2, 11, 'anything else?'), t1);
      const second = processOne(fixture.scheduler, new Date(t1.getTime() + 15_000));
      faux.setResponses([
        (context) => {
          expect(context.tools?.find((tool) => tool.name === 'send')?.description).toContain(
            'permits multiple replies',
          );
          return fauxAssistantMessage(fauxToolCall('send', { text: 'follow up', reply_to_message_id: '10' }), {
            stopReason: 'toolUse',
          });
        },
        fauxAssistantMessage('done'),
      ]);
      await runtime.run(second, fixture.configStore.beginInvocation(), new AbortController().signal);
      expect(api.calls).toBe(2);
      expect(sendAudit(fixture.store).map((row) => row.state)).toEqual(['success', 'success']);
      expect(sendsUsed(fixture.store, first)).toBe(1n);
      expect(sendsUsed(fixture.store, second)).toBe(1n);
      const identity = fixture.build(second);
      expect(
        runtime
          .sceneToolDefinitions(identity, fixture.configStore.current().config)
          .tools.find((tool) => tool.name === 'send')?.description,
      ).toContain('permits multiple replies');
    } finally {
      fixture.close();
    }
  });

  test('allowing multiple replies preserves visibility, send barriers and rate limits', async () => {
    const fixture = await setup(undefined, true);
    try {
      const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const api = countingApi();
      let hold = false;
      const { tool } = makeTool(fixture.store, fixture.config, context, {
        api,
        sendsPerWindow: 1,
        holdForNewMessages: () => hold,
      });
      await tool.execute('first', { text: 'answer', reply_to_message_id: '10' });
      await expect(tool.execute('invisible', { text: 'answer', reply_to_message_id: '999' })).rejects.toThrow(
        'not visible',
      );
      expect(errorCodeOf(fixture.store, 'invisible')).toBe('reply_not_visible');
      hold = true;
      await expectRejected(tool, 'held', { text: 'answer again', reply_to_message_id: '10' });
      expect(errorCodeOf(fixture.store, 'held')).toBe('send_barrier');
      hold = false;
      await expectRejected(tool, 'limited', { text: 'answer again', reply_to_message_id: '10' });
      expect(errorCodeOf(fixture.store, 'limited')).toBe('send_rate_limited');
      expect(api.calls).toBe(1);
      expect(sendAudit(fixture.store)).toHaveLength(1);
      expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    } finally {
      fixture.close();
    }
  });

  test('allowing multiple replies does not disable image delivery deduplication or unknown-outcome protection', async () => {
    const fixture = await setup(undefined, true);
    try {
      const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const api = countingApi();
      const { tool } = makeTool(fixture.store, fixture.config, context, { api, imageGeneration });
      const input = { kind: 'image' as const, image_generation_id: 'gen-1', reply_to_message_id: '10' };
      await tool.execute('first', input);
      const replay = await tool.execute('again', input);
      expect(replay.details.replayed).toBe(true);
      fixture.store.orm.update(telegramSends).set({ state: 'outcome_unknown' }).run();
      await expect(tool.execute('unknown', { ...input, resend: true })).rejects.toThrow('unknown outcome');
      expect(errorCodeOf(fixture.store, 'unknown')).toBe('image_delivery_unknown');
      expect(api.calls).toBe(1);
      expect(sendAudit(fixture.store)).toHaveLength(1);
      expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    } finally {
      fixture.close();
    }
  });

  test('sends without a reply_to_message_id are never deduplicated', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    await tool.execute('nr-1', { kind: 'text', text: 'first' });
    await tool.execute('nr-2', { kind: 'text', text: 'second' });
    await tool.execute('nr-3', { kind: 'text', text: 'reply', reply_to_message_id: '10' });
    expect(api.calls).toBe(3);
    expect(sendAudit(fixture.store)).toHaveLength(3);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(3n);
    // The no-reply rows neither block nor are blocked by the reply dedup.
    await expectRejected(tool, 'nr-4', { kind: 'text', text: 'reply-dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'nr-4')).toBe('reply_already_sent');
    expect(api.calls).toBe(3);
    expect(sendAudit(fixture.store)).toHaveLength(3);
    fixture.close();
  });

  test.each([undefined, true])('a pending reply obeys allow_reply_message_multiple_times=%s', async (allow) => {
    const fixture = await setup(undefined, allow);
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const gate = Promise.withResolvers<void>();
    const api = countingApi(gate.promise);
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    const first = tool.execute('conc-1', { kind: 'text', text: 'first', reply_to_message_id: '10' });
    // execute() runs synchronously up to the API call, so the pending row is
    // committed before the promise is returned.
    expect(sendAudit(fixture.store)).toEqual([expect.objectContaining({ state: 'pending' })]);
    const second = tool.execute('conc-2', { kind: 'text', text: 'second', reply_to_message_id: '10' });
    gate.resolve();
    if (allow === true) {
      await second;
      expect(errorCodeOf(fixture.store, 'conc-2')).toBeNull();
    } else {
      await expect(second).rejects.toThrow('reply_delivery_unknown');
      expect(errorCodeOf(fixture.store, 'conc-2')).toBe('reply_delivery_unknown');
    }
    await first;
    const expectedSends = allow === true ? 2 : 1;
    expect(api.calls).toBe(expectedSends);
    expect(sendAudit(fixture.store).map((row) => row.state)).toEqual(Array(expectedSends).fill('success'));
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(BigInt(expectedSends));
    fixture.close();
  });

  test('a pending reply left by a crashed run stays blocked after reopen and recovery', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const now = new Date().toISOString();
    // This is the durable state at a crash after the claim but before an API result.
    fixture.store.transaction(() => {
      const call = fixture.store.orm
        .insert(toolCalls)
        .values({
          invocationId: context.invocationId,
          toolCallId: 'crashed',
          toolName: 'send',
          argumentsJson: JSON.stringify({ text: 'answer', reply_to_message_id: '10' }),
          state: 'pending',
          sideEffect: true,
          createdAt: now,
        })
        .returning({ id: toolCalls.id })
        .get()!;
      fixture.store.orm
        .insert(telegramSends)
        .values({
          toolCallId: call.id,
          conversationId: context.conversationId,
          kind: 'text',
          requestJson: JSON.stringify({ kind: 'text', reply_to_message_id: '10' }),
          state: 'pending',
          createdAt: now,
        })
        .run();
      fixture.store.orm
        .update(invocations)
        .set({ state: 'running', sideEffectStarted: true, sendsUsed: 1n })
        .where(eq(invocations.id, context.invocationId))
        .run();
    });
    fixture.close();
    const reopened = await SqliteStore.open(fixture.config);
    try {
      new InvocationQueueService(reopened, fixture.configStore).recover();
      expect(
        reopened.orm
          .select({ state: invocations.state })
          .from(invocations)
          .where(eq(invocations.id, context.invocationId))
          .get()?.state,
      ).toBe('outcome_unknown');
      const rebuilt = renderInvocationContext(reopened, fixture.config, context.invocationId);
      const api = countingApi();
      const { tool } = makeTool(reopened, fixture.config, rebuilt, { api });
      await expect(tool.execute('after-restart', { text: 'answer again', reply_to_message_id: '10' })).rejects.toThrow(
        'reply_delivery_unknown',
      );
      expect(errorCodeOf(reopened, 'after-restart')).toBe('reply_delivery_unknown');
      expect(api.calls).toBe(0);
      expect(sendAudit(reopened)).toEqual([expect.objectContaining({ state: 'pending' })]);
      expect(sendsUsed(reopened, context.invocationId)).toBe(1n);
    } finally {
      reopened.close();
    }
  });

  test('an unknown delivery outcome blocks further replies to the same message', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    let calls = 0;
    const api: TelegramSendApi = {
      sendMessage: async () => {
        calls += 1;
        throw new HttpError('network failed', new Error('socket closed'));
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    await expect(tool.execute('u-1', { kind: 'text', text: 'first', reply_to_message_id: '10' })).rejects.toThrow(
      'outcome is unknown',
    );
    await expectRejected(tool, 'u-2', { kind: 'text', text: 'second', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'u-2')).toBe('reply_delivery_unknown');
    expect(calls).toBe(1);
    expect(sendAudit(fixture.store)).toEqual([
      { state: 'outcome_unknown', error_code: 'telegram_network', request_json: expect.stringContaining('"10"') },
    ]);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    fixture.close();
  });

  test('an explicit Telegram rejection still allows retrying the same reply target', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    let calls = 0;
    const api: TelegramSendApi = {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) {
          throw new GrammyError(
            'Bad Request: message text is empty',
            { ok: false, error_code: 400, description: 'Bad Request: message text is empty' },
            'sendMessage',
            {},
          );
        }
        return { message_id: 500 + calls, date: 1_700_000_100 + calls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    await expect(tool.execute('err-1', { kind: 'text', text: 'bad', reply_to_message_id: '10' })).rejects.toThrow(
      'Telegram send failed',
    );
    expect(errorCodeOf(fixture.store, 'err-1')).toBe('telegram_400');
    const result = await tool.execute('err-2', { kind: 'text', text: 'good', reply_to_message_id: '10' });
    expect(result.details).toEqual({ telegramMessageId: '502' });
    expect(calls).toBe(2);
    expect(sendAudit(fixture.store)).toEqual([
      { state: 'error', error_code: 'telegram_400', request_json: expect.any(String) },
      { state: 'success', error_code: null, request_json: expect.any(String) },
    ]);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(2n);
    fixture.close();
  });

  test('a reply Telegram accepted still blocks retries when the outgoing record fails', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    fixture.store.db.exec(
      "CREATE TRIGGER fail_outgoing BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    const result = await tool.execute('acc-1', { kind: 'text', text: 'hello', reply_to_message_id: '10' });
    expect(result.details).toEqual({ telegramMessageId: '501' });
    await expectRejected(tool, 'acc-2', { kind: 'text', text: 'again', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'acc-2')).toBe('reply_already_sent');
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    fixture.close();
  });

  test('dedup survives new invocations, rebuilt tools and a SQLite reopen', async () => {
    const fixture = await setup();
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const context1 = await conversationContext(fixture, 1, 10, t0);
    const api1 = countingApi();
    const { tool: tool1 } = makeTool(fixture.store, fixture.config, context1, { api: api1 });
    await tool1.execute('inv-1', { kind: 'text', text: 'answer', reply_to_message_id: '10' });
    expect(api1.calls).toBe(1);

    // A new invocation and a freshly built tool in the same process stay blocked.
    const t1 = new Date(t0.getTime() + 60_000);
    const context2 = await conversationContext(fixture, 2, 11, t1, 'again');
    const api2 = countingApi();
    const { tool: tool2 } = makeTool(fixture.store, fixture.config, context2, { api: api2 });
    await expectRejected(tool2, 'inv-2', { kind: 'text', text: 'dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'inv-2')).toBe('reply_already_sent');
    expect(api2.calls).toBe(0);
    expect(sendsUsed(fixture.store, context2.invocationId)).toBe(0n);

    // Closing and reopening the database keeps the retained audit: a fresh
    // store, a fresh context header object and a fresh tool still see the
    // earlier reply.
    fixture.store.close();
    const store2 = await SqliteStore.open(fixture.config);
    const ingestion2 = new TelegramIngestion(store2, fixture.configStore, { id: 999 });
    const scheduler2 = new BucketScheduler(store2, fixture.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const t2 = new Date(t1.getTime() + 60_000);
    ingestion2.ingest(update(3, 12, 'third'), t2);
    const invocationId3 = processOne(scheduler2, new Date(t2.getTime() + 15_000));
    const context3 = renderInvocationContext(store2, fixture.config, invocationId3, {
      contextWindow: 200_000,
      maxOutputTokens: 32768,
    });
    const api3 = countingApi();
    const { tool: tool3 } = makeTool(store2, fixture.config, context3, { api: api3 });
    await expectRejected(tool3, 'inv-3', { kind: 'text', text: 'dup-again', reply_to_message_id: '10' });
    expect(errorCodeOf(store2, 'inv-3')).toBe('reply_already_sent');
    expect(api3.calls).toBe(0);
    expect(sendsUsed(store2, invocationId3)).toBe(0n);
    expect(store2.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(
      1n,
    );
    store2.close();
  });

  test('a context reset cannot forget delivery, while a different message can still receive a reply', async () => {
    const fixture = await setup();
    try {
      const t0 = new Date('2026-08-15T00:00:00.000Z');
      const first = await conversationContext(fixture, 1, 10, t0);
      const api = countingApi();
      await makeTool(fixture.store, fixture.config, first, { api }).tool.execute('before-reset', {
        text: 'answer',
        reply_to_message_id: '10',
      });
      const contexts = new ConversationContextStore(fixture.store);
      expect(contexts.open(first.conversationId, 'changed-system-prompt').rebuilt).toBe(true);
      expect(fixture.store.db.prepare('SELECT * FROM context_refs').all()).toEqual([]);
      // Re-expose the old batch so visibility does not mask the delivery check.
      fixture.build(first.invocationId);
      const second = await conversationContext(fixture, 2, 11, new Date(t0.getTime() + 60_000));
      const { tool } = makeTool(fixture.store, fixture.config, second, { api });
      await expect(tool.execute('after-reset', { text: 'answer again', reply_to_message_id: '10' })).rejects.toThrow(
        'reply_already_sent',
      );
      expect(errorCodeOf(fixture.store, 'after-reset')).toBe('reply_already_sent');
      await tool.execute('new-target', { text: 'new answer', reply_to_message_id: '11' });
      expect(api.calls).toBe(2);
      expect(sendAudit(fixture.store).map((row) => JSON.parse(row.request_json).reply_to_message_id)).toEqual([
        '10',
        '11',
      ]);
      expect(sendsUsed(fixture.store, second.invocationId)).toBe(1n);
    } finally {
      fixture.close();
    }
  });

  test('dedup is scoped per conversation and authorization still wins', async () => {
    const fixture = await setup([123456789, 987654321]);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const contextA = await conversationContext(fixture, 1, 10, t0); // chat A sees message 10
    const apiA = countingApi();
    const { tool: toolA } = makeTool(fixture.store, fixture.config, contextA, { api: apiA });
    await toolA.execute('a-1', { kind: 'text', text: 'answer', reply_to_message_id: '10' });

    // Conversation B has never seen message 10: the reply must fail
    // authorization, not dedup, even though conversation A already replied to a
    // message id 10.
    const t1 = new Date(t0.getTime() + 60_000);
    const contextB = await conversationContext(fixture, 2, 1, t1, 'other', 987654321);
    const apiB = countingApi();
    const { tool: toolB } = makeTool(fixture.store, fixture.config, contextB, { api: apiB });
    await expect(toolB.execute('b-1', { kind: 'text', text: '?', reply_to_message_id: '10' })).rejects.toThrow(
      'not visible',
    );
    expect(errorCodeOf(fixture.store, 'b-1')).toBe('reply_not_visible');
    expect(apiB.calls).toBe(0);

    // Once conversation B sees its own message 10, a reply there is allowed and
    // then deduplicated independently of conversation A's send.
    const t2 = new Date(t1.getTime() + 60_000);
    const contextB2 = await conversationContext(fixture, 3, 10, t2, 'hello too', 987654321);
    const { tool: toolB2 } = makeTool(fixture.store, fixture.config, contextB2, { api: apiB });
    const result = await toolB2.execute('b-2', { kind: 'text', text: 'answer too', reply_to_message_id: '10' });
    expect(result.details).toEqual({ telegramMessageId: '501' });
    await expectRejected(toolB2, 'b-3', { kind: 'text', text: 'dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'b-3')).toBe('reply_already_sent');
    expect(apiB.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(2);
    fixture.close();
  });

  test('a dedup rejection costs nothing: no row, no API call, no quota, no barrier', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    let armed = false;
    let barrierChecks = 0;
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, {
      api,
      sendsPerWindow: 1,
      holdForNewMessages: () => {
        barrierChecks += 1;
        return armed;
      },
    });
    const first = await tool.execute('hyg-1', { kind: 'text', text: 'answer', reply_to_message_id: '10' });
    expect(first.details.telegramMessageId).toBeTruthy();
    armed = true;
    await expectRejected(tool, 'hyg-2', { kind: 'text', text: 'dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'hyg-2')).toBe('reply_already_sent');
    expect(barrierChecks).toBe(1);
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    fixture.close();
  });

  test('a rejected-send audit failure cannot roll back a bucket the barrier already queued', async () => {
    const fixture = await setup();
    try {
      const t0 = new Date('2026-08-15T00:00:00.000Z');
      const context = await conversationContext(fixture, 1, 10, t0);
      const now = new Date(t0.getTime() + 60_000);
      fixture.ingestion.ingest(update(2, 11, 'one more thing'), now);
      const collecting = fixture.store.orm
        .select({ id: buckets.id })
        .from(buckets)
        .where(eq(buckets.state, 'collecting'))
        .get()!;
      const runtime = new ConversationRuntime({ agentCacheSize: 1 });
      const api = countingApi();
      const { tool } = makeTool(fixture.store, fixture.config, context, {
        api,
        holdForNewMessages: () => {
          fixture.store.transaction(() =>
            attachBucketToInvocation(
              fixture.store,
              fixture.config.agent.history_messages,
              context.invocationId,
              collecting.id,
              context.conversationId,
              now,
            ),
          );
          runtime.queueInjection(context.conversationId, collecting.id);
          return true;
        },
      });
      fixture.store.db.exec(
        "CREATE TRIGGER fail_send_rejection BEFORE INSERT ON tool_calls WHEN NEW.error_code = 'send_barrier' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
      );
      await expect(tool.execute('held-audit-failed', { text: 'stale', reply_to_message_id: '10' })).rejects.toThrow(
        'disk full',
      );
      expect(runtime.takeInjections(context.conversationId)).toEqual([collecting.id]);
      expect(
        fixture.store.orm.select({ state: buckets.state }).from(buckets).where(eq(buckets.id, collecting.id)).get()
          ?.state,
      ).toBe('running');
      expect(
        fixture.store.orm
          .select({ invocationId: invocationBuckets.invocationId })
          .from(invocationBuckets)
          .where(eq(invocationBuckets.bucketId, collecting.id))
          .get()?.invocationId,
      ).toBe(context.invocationId);
      expect(api.calls).toBe(0);
      expect(sendAudit(fixture.store)).toEqual([]);
      expect(sendsUsed(fixture.store, context.invocationId)).toBe(0n);
    } finally {
      fixture.close();
    }
  });

  test('a fully delivered image replays as a no-op and still does not bypass dedup', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, { api, imageGeneration });
    const first = await tool.execute('img-1', {
      kind: 'image',
      image_generation_id: 'gen-1',
      reply_to_message_id: '10',
    });
    expect(first.details).toEqual({ telegramMessageId: '701' });
    // Delivering the same generation again is a replayed no-op: no new send row.
    const replay = await tool.execute('img-2', {
      kind: 'image',
      image_generation_id: 'gen-1',
      reply_to_message_id: '10',
    });
    expect(replay.details).toEqual({ telegramMessageId: '701', replayed: true });
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    // A different generation on the same reply target is still a duplicate reply.
    await expectRejected(tool, 'img-3', {
      kind: 'image',
      image_generation_id: 'gen-2',
      resend: true,
      reply_to_message_id: '10',
    });
    expect(errorCodeOf(fixture.store, 'img-3')).toBe('reply_already_sent');
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    fixture.close();
  });
});
