import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError, HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { createSendTool, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig, type RawConfig } from '../src/platform/config.ts';
import type { CapabilityRefResolver, CompletionContext } from '../src/platform/invocation-context.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  type TestInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
} from './helpers.ts';

/**
 * `send kind:image` delivery-ledger boundary.
 *
 * Deduplication is per target conversation + generation id + asset id against
 * `telegram_sends.request_json` (`generation_id` / `asset_ids`): successful
 * deliveries are filtered out, a fully delivered generation replays as a
 * successful no-op that reaches no Telegram API and spends no rate window, and
 * pending / unknown attempts block every retry, resend or not. Authorization
 * (generation ownership, reply refs) runs before any side effect. The suite
 * drives the real store, ingestion and scheduler with a fake Telegram API and
 * mock picture bytes; no network, real config, key.json or serve process.
 */

const CHAT_ID = 123456789;
const OTHER_CHAT_ID = 987654321;
const START = new Date('2026-08-15T00:00:00.000Z');
const GENERATION_ID = '7b2f8f3a-9c4d-4e5f-8a6b-1c2d3e4f5a6b';
const OTHER_GENERATION_ID = '11111111-2222-4333-8444-555555555555';
const THIRD_GENERATION_ID = '99999999-8888-4777-8666-555555555555';
const ALREADY_DELIVERED = /already[\s_-]*(been[\s_-]*)?delivered/i;

interface Picture {
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

function picture(assetId: string, fileName: string): Picture {
  return { assetId, fileName, bytes: new Uint8Array([137, 80, 78, 71, assetId.length]) };
}

const ASSET_A = picture('asset-a', 'a.png');
const ASSET_B = picture('asset-b', 'b.png');

const directories: string[] = [];
const openedStores: SqliteStore[] = [];

afterAll(async () => {
  // Windows keeps the SQLite files locked while a store is open; close every
  // store a failed test left behind before removing the temp directories.
  for (const store of openedStores) {
    if (store.db.open) {
      store.close();
    }
  }
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly build: (invocationId: bigint) => TestInvocationContext;
}

async function setup(extraChatIds: readonly number[] = []): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-delivery-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      for (const id of extraChatIds) {
        config.telegram.chats.push({ id });
      }
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  openedStores.push(store);
  return {
    store,
    config: loaded.config,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    build: (invocationId) =>
      renderInvocationContext(store, loaded.config, invocationId, { contextWindow: 200_000, maxOutputTokens: 32_768 }),
  };
}

interface PhotoAttempt {
  readonly chatId: string;
  readonly fileNames: readonly string[];
  readonly caption: string | undefined;
}

interface FakeTelegram extends TelegramSendApi {
  readonly photoAttempts: PhotoAttempt[];
  readonly photoDeliveries: PhotoAttempt[];
  textSends: number;
  stickerSends: number;
}

function photoResponse(messageId: number) {
  return {
    message_id: messageId,
    date: 1_700_000_100,
    chat: { id: CHAT_ID },
    photo: [{ file_id: `photo-${messageId}`, file_unique_id: `unique-${messageId}`, width: 512, height: 512 }],
  };
}

/** Fake Telegram API; `beforePhoto` runs before an attempt settles and may throw. */
function fakeTelegram(beforePhoto?: (attempt: number) => void | Promise<void>): FakeTelegram {
  const api: FakeTelegram = {
    photoAttempts: [],
    photoDeliveries: [],
    textSends: 0,
    stickerSends: 0,
    sendMessage: async () => {
      api.textSends += 1;
      return { message_id: 900, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => {
      api.stickerSends += 1;
      return { message_id: 950, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendGeneratedPhoto: async (chatId, _bytes, fileName, options) => {
      const attempt = { chatId, fileNames: [fileName], caption: options.caption };
      api.photoAttempts.push(attempt);
      await beforePhoto?.(api.photoAttempts.length - 1);
      const messageId = 500 + api.photoDeliveries.length;
      api.photoDeliveries.push(attempt);
      return photoResponse(messageId);
    },
    sendGeneratedPhotoGroup: async (chatId, pictures, options) => {
      const attempt = { chatId, fileNames: pictures.map((entry) => entry.fileName), caption: options.caption };
      api.photoAttempts.push(attempt);
      await beforePhoto?.(api.photoAttempts.length - 1);
      const firstMessageId = 500 + api.photoDeliveries.length;
      api.photoDeliveries.push(attempt);
      return pictures.map((_entry, index) => photoResponse(firstMessageId + index));
    },
  };
  return api;
}

interface ToolOptions {
  readonly api?: FakeTelegram;
  readonly pictures?: (generationId: string, conversationId: bigint) => readonly Picture[] | undefined;
  readonly context?: Partial<Pick<TestInvocationContext, 'completion' | 'callerUserId'>>;
  readonly sendRateLimit?: { readonly sendsPerWindow: number; readonly windowSeconds: number };
  readonly capabilities?: CapabilityRefResolver;
}

function buildTool(
  fixture: Fixture,
  context: TestInvocationContext,
  options: ToolOptions = {},
): { readonly tool: ReturnType<typeof createSendTool>; readonly api: FakeTelegram } {
  const api = options.api ?? fakeTelegram();
  const resolvePictures = options.pictures ?? (() => [ASSET_A]);
  const toolContext = { ...context, ...(options.context ?? {}) };
  const tool = createSendTool({
    store: fixture.store,
    api,
    context: toolContext,
    capabilities: options.capabilities ?? invocationCapabilities(fixture.store, fixture.config, context.header),
    sendRateLimit: options.sendRateLimit ?? { sendsPerWindow: 6, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    imageGeneration: {
      resolve: (generationId, conversationId) =>
        resolvePictures(generationId, conversationId)?.map(({ assetId, bytes, fileName }) => ({
          assetId,
          bytes,
          fileName,
        })),
    },
  });
  return { tool, api };
}

function update(updateId: number, messageId: number, text: string, chatId = CHAT_ID): Update {
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

function completeInvocation(store: SqliteStore, invocationId: bigint): void {
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
}

function openConversation(
  fixture: Fixture,
  messageId: number,
  receivedAt: Date,
  chatId = CHAT_ID,
): TestInvocationContext {
  fixture.ingestion.ingest(update(messageId, messageId, `message-${messageId}`, chatId), receivedAt);
  return fixture.build(processOne(fixture.scheduler, new Date(receivedAt.getTime() + 15_000)));
}

interface SendRow {
  readonly id: bigint;
  readonly state: string;
  readonly error_code: string | null;
  readonly telegram_message_id: bigint | null;
  readonly request_json: string;
  readonly conversation_id: bigint;
}

function sendRows(store: SqliteStore): SendRow[] {
  return store.db
    .prepare<[], SendRow>(
      'SELECT id, state, error_code, telegram_message_id, request_json, conversation_id FROM telegram_sends ORDER BY id',
    )
    .all();
}

function imageRequests(store: SqliteStore): Record<string, unknown>[] {
  return sendRows(store).map((row) => JSON.parse(row.request_json) as Record<string, unknown>);
}

function toolCalls(store: SqliteStore) {
  return store.db
    .prepare<[], { tool_call_id: string; state: string; side_effect: bigint; error_code: string | null }>(
      'SELECT tool_call_id, state, side_effect, error_code FROM tool_calls ORDER BY id',
    )
    .all();
}

function sendsUsed(store: SqliteStore): bigint[] {
  return store.db
    .prepare<[], { sends_used: bigint }>('SELECT sends_used FROM invocations ORDER BY id')
    .all()
    .map((row) => row.sends_used);
}

function contentText(result: { readonly content: readonly { readonly type: string }[] }): string {
  return result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function resultText(store: SqliteStore, toolCallId: string): string {
  return (
    store.db
      .prepare<[string], { result_text: string | null }>('SELECT result_text FROM tool_calls WHERE tool_call_id = ?')
      .get(toolCallId)?.result_text ?? ''
  );
}

describe('send image delivery ledger', () => {
  test('records the generation and its asset ids on the first delivery', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context);

    const result = await tool.execute('img-1', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
      text: 'harbor',
    });

    expect(result.details).toEqual({ telegramMessageId: '500' });
    expect(api.photoDeliveries).toEqual([{ chatId: String(CHAT_ID), fileNames: ['a.png'], caption: 'harbor' }]);
    const rows = sendRows(fixture.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'success',
      telegram_message_id: 500n,
      error_code: null,
      conversation_id: context.conversationId,
    });
    expect(JSON.parse(rows[0]!.request_json)).toMatchObject({
      kind: 'image',
      generation_id: GENERATION_ID,
      asset_ids: ['asset-a'],
    });
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'img-1', state: 'success', side_effect: 1n, error_code: null },
    ]);
    expect(sendsUsed(fixture.store)).toEqual([1n]);
    fixture.store.close();
  });

  test('a repeat is a no-op across tool instances and invocations', async () => {
    const fixture = await setup();
    const api = fakeTelegram();
    const first = openConversation(fixture, 1, START);
    await buildTool(fixture, first, { api }).tool.execute('img-1', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });

    // A fresh tool instance over the same invocation reads the delivery from the store.
    const repeated = await buildTool(fixture, first, { api }).tool.execute('img-2', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });
    expect(repeated.details).toEqual({ telegramMessageId: '500', replayed: true });
    expect(contentText(repeated)).toContain('500');

    // Persist the next invocation before closing the store, then read its
    // predecessor's delivery ledger through a freshly opened connection.
    completeInvocation(fixture.store, first.invocationId);
    const second = openConversation(fixture, 2, new Date(START.getTime() + 20_000));
    expect(second.invocationId).not.toBe(first.invocationId);
    fixture.store.close();
    const reopened = await SqliteStore.open(fixture.config);
    openedStores.push(reopened);
    const afterRestart = await buildTool({ ...fixture, store: reopened }, second, { api }).tool.execute('img-3', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });
    expect(afterRestart.details).toEqual({ telegramMessageId: '500', replayed: true });

    expect(api.photoAttempts).toHaveLength(1);
    expect(sendRows(reopened).map((row) => row.state)).toEqual(['success']);
    expect(toolCalls(reopened)).toEqual([
      { tool_call_id: 'img-1', state: 'success', side_effect: 1n, error_code: null },
      { tool_call_id: 'img-2', state: 'success', side_effect: 0n, error_code: null },
      { tool_call_id: 'img-3', state: 'success', side_effect: 0n, error_code: null },
    ]);
    expect(sendsUsed(reopened)).toEqual([1n, 0n]);
    expect(resultText(reopened, 'img-2')).toMatch(ALREADY_DELIVERED);
    expect(resultText(reopened, 'img-3')).toContain('500');

    // Unknown outcomes also survive a connection restart and still block retry.
    const unknownApi = fakeTelegram(() => {
      throw new HttpError('network failed', new Error('socket closed'));
    });
    await expect(
      buildTool({ ...fixture, store: reopened }, second, { api: unknownApi }).tool.execute('u-1', {
        kind: 'image',
        image_generation_id: OTHER_GENERATION_ID,
      }),
    ).rejects.toThrow('outcome is unknown');
    reopened.close();
    const restarted = await SqliteStore.open(fixture.config);
    openedStores.push(restarted);
    await expect(
      buildTool({ ...fixture, store: restarted }, second, { api: unknownApi }).tool.execute('u-2', {
        kind: 'image',
        image_generation_id: OTHER_GENERATION_ID,
      }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    expect(unknownApi.photoAttempts).toHaveLength(1);
    expect(sendRows(restarted).map((row) => row.state)).toEqual(['success', 'outcome_unknown']);
    expect(toolCalls(restarted).at(-1)).toMatchObject({
      tool_call_id: 'u-2',
      state: 'error',
      error_code: 'image_delivery_unknown',
    });
    restarted.close();
  });

  test('a no-op neither spends the send window nor sends_used', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context, { sendRateLimit: { sendsPerWindow: 2, windowSeconds: 300 } });

    await tool.execute('r-1', { kind: 'image', image_generation_id: GENERATION_ID });
    const replay = await tool.execute('r-2', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(replay.details).toEqual({ telegramMessageId: '500', replayed: true });

    // The no-op spent nothing, so the second window slot is still free for a
    // real send. A new generation is not judged by the old generation's ledger.
    await tool.execute('r-3', { kind: 'image', image_generation_id: OTHER_GENERATION_ID });
    expect(sendsUsed(fixture.store)).toEqual([2n]);

    // The window really is full now: it counts recorded sends, not no-ops.
    await expect(tool.execute('r-4', { kind: 'image', image_generation_id: THIRD_GENERATION_ID })).rejects.toThrow(
      'send rate limit',
    );
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png'], ['a.png']]);
    expect(sendRows(fixture.store)).toHaveLength(2);
    expect(toolCalls(fixture.store).at(-1)).toMatchObject({
      tool_call_id: 'r-4',
      state: 'error',
      error_code: 'send_rate_limited',
    });
    fixture.store.close();
  });

  test('a generation that gained an asset sends only the new asset', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    let pictures: readonly Picture[] = [ASSET_A];
    const { tool, api } = buildTool(fixture, context, { pictures: () => pictures });

    await tool.execute('ap-1', { kind: 'image', image_generation_id: GENERATION_ID });
    pictures = [ASSET_A, ASSET_B];
    const second = await tool.execute('ap-2', { kind: 'image', image_generation_id: GENERATION_ID });

    expect(second.details).toEqual({ telegramMessageId: '501' });
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png'], ['b.png']]);
    expect(imageRequests(fixture.store).map((request) => request.asset_ids)).toEqual([['asset-a'], ['asset-b']]);

    // With everything delivered, the same generation replays instead of resending.
    const third = await tool.execute('ap-3', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(third.details.replayed).toBe(true);
    expect(contentText(third)).toContain('delivery message(s): 500, 501');
    expect(resultText(fixture.store, 'ap-3')).toBe(contentText(third));
    expect(api.photoDeliveries).toHaveLength(2);
    fixture.store.close();
  });

  test('a pending attempt is persisted before the await and blocks concurrent retries', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = fakeTelegram(async () => {
      await gate;
    });
    let pictures: readonly Picture[] = [ASSET_A];
    const { tool } = buildTool(fixture, context, { api, pictures: () => pictures });

    const first = tool.execute('pending-1', { kind: 'image', image_generation_id: GENERATION_ID });
    // The guard row is committed synchronously, before Telegram was awaited.
    const pending = sendRows(fixture.store);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: 'pending', conversation_id: context.conversationId });
    expect(JSON.parse(pending[0]!.request_json)).toMatchObject({ asset_ids: ['asset-a'] });

    // Any target asset of a pending attempt blocks the whole call, even a
    // resend and even when the request also carries a not-yet-delivered asset.
    pictures = [ASSET_A, ASSET_B];
    await expect(
      tool.execute('pending-2', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    await expect(tool.execute('pending-3', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      /pending or has an unknown outcome/,
    );
    release();
    await first;

    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png']]);
    expect(sendRows(fixture.store).map((row) => row.state)).toEqual(['success']);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'pending-1', state: 'success', side_effect: 1n, error_code: null },
      { tool_call_id: 'pending-2', state: 'error', side_effect: 1n, error_code: 'image_delivery_unknown' },
      { tool_call_id: 'pending-3', state: 'error', side_effect: 1n, error_code: 'image_delivery_unknown' },
    ]);
    fixture.store.close();
  });

  test('an unknown outcome, network or 5xx, blocks every retry', async () => {
    const network = await setup();
    const networkContext = openConversation(network, 1, START);
    const networkApi = fakeTelegram(() => {
      throw new HttpError('network failed', new Error('socket closed'));
    });
    const networkTool = buildTool(network, networkContext, { api: networkApi }).tool;
    await expect(networkTool.execute('u-1', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'outcome is unknown',
    );
    expect(sendRows(network.store)).toEqual([
      expect.objectContaining({
        state: 'outcome_unknown',
        error_code: 'telegram_network',
        telegram_message_id: null,
      }),
    ]);
    await expect(networkTool.execute('u-2', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      /pending or has an unknown outcome/,
    );
    await expect(
      networkTool.execute('u-3', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    expect(networkApi.photoAttempts).toHaveLength(1);
    expect(sendRows(network.store)).toHaveLength(1);
    expect(
      toolCalls(network.store)
        .slice(1)
        .map((row) => row.error_code),
    ).toEqual(['image_delivery_unknown', 'image_delivery_unknown']);
    network.store.close();

    const server = await setup();
    const serverContext = openConversation(server, 1, START);
    const serverApi = fakeTelegram(() => {
      throw new GrammyError(
        'Internal Server Error',
        { ok: false, error_code: 500, description: 'Internal Server Error' },
        'sendPhoto',
        {},
      );
    });
    const serverTool = buildTool(server, serverContext, { api: serverApi }).tool;
    await expect(serverTool.execute('u-4', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'Telegram send outcome is unknown',
    );
    expect(sendRows(server.store)[0]).toMatchObject({ state: 'outcome_unknown', error_code: 'telegram_500' });
    await expect(
      serverTool.execute('u-5', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    expect(serverApi.photoAttempts).toHaveLength(1);
    expect(sendRows(server.store)).toHaveLength(1);
    server.store.close();
  });

  test('a known 4xx failure can be retried', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    let failNext = true;
    const api = fakeTelegram(() => {
      if (!failNext) {
        return;
      }
      failNext = false;
      throw new GrammyError('Bad Request', { ok: false, error_code: 400, description: 'Bad Request' }, 'sendPhoto', {});
    });
    const { tool } = buildTool(fixture, context, { api });

    await expect(tool.execute('f-1', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'telegram_400',
    );
    expect(sendRows(fixture.store)[0]).toMatchObject({
      state: 'error',
      error_code: 'telegram_400',
      telegram_message_id: null,
    });

    // A known rejection delivered nothing, so the same asset may go out again.
    const retry = await tool.execute('f-2', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(retry.details).toEqual({ telegramMessageId: '500' });
    expect(api.photoAttempts).toHaveLength(2);
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png']]);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'f-1', state: 'error', side_effect: 1n, error_code: 'telegram_400' },
      { tool_call_id: 'f-2', state: 'success', side_effect: 1n, error_code: null },
    ]);
    fixture.store.close();
  });

  test('rejects a generation owned by another conversation before touching Telegram', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const seen: Array<{ generationId: string; conversationId: bigint }> = [];
    const api = fakeTelegram();
    const { tool } = buildTool(fixture, context, {
      api,
      pictures: (generationId, conversationId) => {
        seen.push({ generationId, conversationId });
        return conversationId === context.conversationId + 1n ? [ASSET_A] : undefined;
      },
    });

    await expect(tool.execute('x-1', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'does not name a finished generation of this conversation',
    );
    // The resolver decides ownership; it was asked about the invoking conversation.
    expect(seen).toEqual([{ generationId: GENERATION_ID, conversationId: context.conversationId }]);
    expect(api.photoAttempts).toHaveLength(0);
    expect(sendRows(fixture.store)).toHaveLength(0);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'x-1', state: 'error', side_effect: 1n, error_code: 'image_generation_not_authorized' },
    ]);
    fixture.store.close();
  });

  test('rejects an expired reply reference before resolving the generation', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const refs = new ContextRefStore(fixture.store, { ttlHours: fixture.config.agent.context.ref_ttl_hours });
    refs.replyRef(
      context.header,
      77n,
      { conversationId: context.conversationId, threadId: context.threadId },
      context.header.nextSeq,
      new Date(Date.now() - 100 * 3_600_000),
    );
    const resolved: unknown[] = [];
    const api = fakeTelegram();
    const { tool } = buildTool(fixture, context, {
      api,
      pictures: (...args) => {
        resolved.push(args);
        return [ASSET_A];
      },
    });

    await expect(
      tool.execute('x-2', { kind: 'image', image_generation_id: GENERATION_ID, reply_to_message_id: '77' }),
    ).rejects.toThrow('not visible');
    expect(resolved).toHaveLength(0);
    expect(api.photoAttempts).toHaveLength(0);
    expect(sendRows(fixture.store)).toHaveLength(0);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'x-2', state: 'error', side_effect: 1n, error_code: 'reply_not_visible' },
    ]);
    fixture.store.close();
  });

  test('resend is image-only and needs an explicit user turn', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const api = fakeTelegram();
    const { tool } = buildTool(fixture, context, { api });

    await expect(tool.execute('t-1', { kind: 'text', text: 'hello', resend: true })).rejects.toThrow(
      'do not match its kind',
    );
    await expect(tool.execute('t-2', { kind: 'sticker', sticker_ref: 'stk_missing', resend: true })).rejects.toThrow(
      'do not match its kind',
    );

    const receipt: CompletionContext = {
      taskId: 5n,
      pluginId: 'test',
      payload: null,
      status: 'completed',
      delivery: { bypassDailyBudget: false },
    };
    const receiptTool = buildTool(fixture, context, { api, context: { completion: receipt, callerUserId: 42n } }).tool;
    await expect(
      receiptTool.execute('t-3', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow('explicit new user request');

    const anonymousTool = buildTool(fixture, context, { api, context: { callerUserId: null } }).tool;
    await expect(
      anonymousTool.execute('t-4', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow('explicit new user request');

    expect(api.photoAttempts).toHaveLength(0);
    expect(api.textSends).toBe(0);
    expect(api.stickerSends).toBe(0);
    expect(sendRows(fixture.store)).toHaveLength(0);
    expect(toolCalls(fixture.store).map((row) => row.error_code)).toEqual([
      'send_input_invalid',
      'send_input_invalid',
      'image_resend_requires_user',
      'image_resend_requires_user',
    ]);
    fixture.store.close();
  });

  test('an explicit resend on an ordinary user turn delivers the same assets again', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context);

    await tool.execute('re-1', { kind: 'image', image_generation_id: GENERATION_ID });
    const resent = await tool.execute('re-2', { kind: 'image', image_generation_id: GENERATION_ID, resend: true });

    expect(resent.details).toEqual({ telegramMessageId: '501' });
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png'], ['a.png']]);
    expect(
      sendRows(fixture.store).map((row) => ({ state: row.state, telegram_message_id: row.telegram_message_id })),
    ).toEqual([
      { state: 'success', telegram_message_id: 500n },
      { state: 'success', telegram_message_id: 501n },
    ]);
    expect(imageRequests(fixture.store).map((request) => request.asset_ids)).toEqual([['asset-a'], ['asset-a']]);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 're-1', state: 'success', side_effect: 1n, error_code: null },
      { tool_call_id: 're-2', state: 'success', side_effect: 1n, error_code: null },
    ]);
    expect(sendsUsed(fixture.store)).toEqual([2n]);
    fixture.store.close();
  });

  test('a delivery in one conversation does not suppress the same generation in another', async () => {
    const fixture = await setup([OTHER_CHAT_ID]);
    const api = fakeTelegram();
    const first = openConversation(fixture, 1, START);
    await buildTool(fixture, first, { api }).tool.execute('c-1', { kind: 'image', image_generation_id: GENERATION_ID });
    completeInvocation(fixture.store, first.invocationId);

    const second = openConversation(fixture, 2, new Date(START.getTime() + 20_000), OTHER_CHAT_ID);
    expect(second.chatId).toBe(BigInt(OTHER_CHAT_ID));
    const result = await buildTool(fixture, second, { api }).tool.execute('c-2', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });

    expect(result.details.replayed).not.toBe(true);
    expect(api.photoDeliveries).toHaveLength(2);
    expect(sendRows(fixture.store).map((row) => row.conversation_id)).toEqual([
      first.conversationId,
      second.conversationId,
    ]);
    fixture.store.close();
  });
});
