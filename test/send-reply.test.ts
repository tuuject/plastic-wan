import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { createSendTools, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig, type RawConfig } from '../src/platform/config.ts';
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
 * Contract for `send_reply`: one reply published as several consecutive
 * messages. Every part is checked before the first goes out; each part then
 * runs the full `send` pipeline as its own audited call (`<id>:<n>`) under one
 * `send_reply` row. Only the first part carries the reply target and meets the
 * send barrier; a failure after it keeps the delivered parts and names them.
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
  readonly context: TestInvocationContext;
  close: () => void;
}

async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-send-reply-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [{ id: 123456789, instructions_file: 'chat-instructions.md' }];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_010,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: 'explain it',
    },
  };
  ingestion.ingest(update, received);
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  return { store, config: loaded.config, context, close: () => store.close() };
}

interface RecordedCall {
  readonly method: 'message' | 'sticker';
  readonly content: string;
  readonly replyTo: number | undefined;
}

interface RecordingApi extends TelegramSendApi {
  readonly calls: RecordedCall[];
}

function recordingApi(failMessageText?: string): RecordingApi {
  const calls: RecordedCall[] = [];
  const respond = (call: RecordedCall): Awaited<ReturnType<TelegramSendApi['sendMessage']>> => {
    calls.push(call);
    return { message_id: 500 + calls.length, date: 1_700_000_100 + calls.length, chat: { id: 123456789 } };
  };
  return {
    calls,
    sendMessage: async (_chatId, text, options) => {
      if (text === failMessageText) {
        throw new GrammyError(
          'Bad Request: message is too long',
          { ok: false, error_code: 400, description: 'Bad Request: message is too long' },
          'sendMessage',
          {},
        );
      }
      return respond({ method: 'message', content: text, replyTo: options.reply_parameters?.message_id });
    },
    sendSticker: async (_chatId, sticker, options) =>
      respond({ method: 'sticker', content: sticker, replyTo: options.reply_parameters?.message_id }),
  };
}

function makeTools(
  fixture: Fixture,
  options: { api: TelegramSendApi; sendsPerWindow?: number; holdForNewMessages?: () => boolean },
): ReturnType<typeof createSendTools> & { readonly capabilities: ReturnType<typeof invocationCapabilities> } {
  const capabilities = invocationCapabilities(fixture.store, fixture.config, fixture.context.header);
  return {
    ...createSendTools({
      store: fixture.store,
      api: options.api,
      context: fixture.context,
      capabilities,
      sendRateLimit: { sendsPerWindow: options.sendsPerWindow ?? 10, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      ...(options.holdForNewMessages === undefined ? {} : { holdForNewMessages: options.holdForNewMessages }),
    }),
    capabilities,
  };
}

interface ToolCallRow {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly state: string;
  readonly side_effect: bigint;
  readonly error_code: string | null;
  readonly result_text: string | null;
}

function toolAudit(store: SqliteStore): ToolCallRow[] {
  return store.db
    .prepare<[], ToolCallRow>(
      'SELECT tool_call_id, tool_name, state, side_effect, error_code, result_text FROM tool_calls ORDER BY id',
    )
    .all();
}

function sendAudit(store: SqliteStore): { state: string; kind: string; request_json: string }[] {
  return store.db
    .prepare<[], { state: string; kind: string; request_json: string }>(
      'SELECT state, kind, request_json FROM telegram_sends ORDER BY id',
    )
    .all();
}

function sendsUsed(fixture: Fixture): bigint {
  return (
    fixture.store.db
      .prepare<[bigint], { sends_used: bigint }>('SELECT sends_used FROM invocations WHERE id = ?')
      .get(fixture.context.invocationId)?.sends_used ?? 0n
  );
}

function botMessages(store: SqliteStore): number {
  return Number(
    store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages WHERE sent_by_bot = 1').get()
      ?.count ?? 0n,
  );
}

describe('send_reply', () => {
  test('publishes every part in order and replies with the first part only', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { sendReply, capabilities } = makeTools(fixture, { api });
      const stickerRef = capabilities.registerStickerRef('CAAD-fake-sticker');
      const result = await sendReply.execute('multi', {
        reply_to_message_id: '10',
        parts: [
          { kind: 'sticker', sticker_ref: stickerRef },
          { text: 'First, find the tangent.' },
          { text: 'Then compare.' },
        ],
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Sent 3 Telegram messages in order: 501, 502, 503' }]);
      expect(result.details).toEqual({ telegramMessageIds: ['501', '502', '503'] });
      expect(api.calls).toEqual([
        { method: 'sticker', content: 'CAAD-fake-sticker', replyTo: 10 },
        { method: 'message', content: 'First, find the tangent.', replyTo: undefined },
        { method: 'message', content: 'Then compare.', replyTo: undefined },
      ]);
      expect(toolAudit(fixture.store)).toEqual([
        {
          tool_call_id: 'multi',
          tool_name: 'send_reply',
          state: 'success',
          side_effect: 1n,
          error_code: null,
          result_text: 'telegram_message_ids=501,502,503',
        },
        ...[1, 2, 3].map((part) => ({
          tool_call_id: `multi:${part}`,
          tool_name: 'send',
          state: 'success',
          side_effect: 1n,
          error_code: null,
          result_text: `telegram_message_id=${500 + part}`,
        })),
      ]);
      expect(sendAudit(fixture.store).map((row) => [row.state, row.kind, JSON.parse(row.request_json)])).toEqual([
        ['success', 'sticker', { kind: 'sticker', reply_to_message_id: '10' }],
        ['success', 'text', { kind: 'text', reply_to_message_id: null }],
        ['success', 'text', { kind: 'text', reply_to_message_id: null }],
      ]);
      expect(sendsUsed(fixture)).toBe(3n);
      expect(botMessages(fixture.store)).toBe(3);
    } finally {
      fixture.close();
    }
  });

  test.each([
    {
      name: 'an unauthorized sticker in a later part',
      parts: [{ text: 'fine' }, { text: 'also fine' }, { kind: 'sticker' as const, sticker_ref: 'stk_forged' }],
      errorCode: 'sticker_ref_not_authorized',
      message: 'Nothing was sent: part 3 sticker_ref is not authorized',
    },
    {
      name: 'a part whose fields do not match its kind',
      parts: [{ text: 'fine' }, { kind: 'image' as const }],
      errorCode: 'send_input_invalid',
      message: 'Nothing was sent: part 2 fields do not match its kind',
    },
    {
      name: 'a generated image that is not available here',
      parts: [
        { text: 'look' },
        { kind: 'image' as const, image_generation_id: '00000000-0000-4000-8000-000000000000' },
      ],
      errorCode: 'image_generation_not_authorized',
      message: 'Nothing was sent: part 2 image_generation_id',
    },
  ])('checks every part before sending: $name', async ({ parts, errorCode, message }) => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { sendReply } = makeTools(fixture, { api });
      await expect(sendReply.execute('bad', { parts })).rejects.toThrow(message);
      expect(api.calls).toEqual([]);
      expect(toolAudit(fixture.store)).toEqual([
        {
          tool_call_id: 'bad',
          tool_name: 'send_reply',
          state: 'error',
          side_effect: 1n,
          error_code: errorCode,
          result_text: null,
        },
      ]);
      expect(sendAudit(fixture.store)).toEqual([]);
      expect(sendsUsed(fixture)).toBe(0n);
    } finally {
      fixture.close();
    }
  });

  test('rejects up front when the parts would not all fit the send rate limit', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { send, sendReply } = makeTools(fixture, { api, sendsPerWindow: 3 });
      await send.execute('earlier', { text: 'earlier message' });
      await expect(
        sendReply.execute('limited', { parts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }),
      ).rejects.toThrow('3 messages would exceed the send rate limit of 3 per 300s window');
      expect(api.calls).toHaveLength(1);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['earlier', null],
        ['limited', 'send_rate_limited'],
      ]);
      await sendReply.execute('fits', { parts: [{ text: 'a' }, { text: 'b' }] });
      expect(api.calls).toHaveLength(3);
    } finally {
      fixture.close();
    }
  });

  test('the send barrier holds back only the first part', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      let checks = 0;
      let hold = true;
      const { sendReply } = makeTools(fixture, {
        api,
        holdForNewMessages: () => {
          checks += 1;
          return hold;
        },
      });
      await expect(sendReply.execute('held', { parts: [{ text: 'a' }, { text: 'b' }] })).rejects.toThrow(
        'Nothing was sent: part 1 failed. Not sent: new messages arrived',
      );
      expect(api.calls).toEqual([]);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.tool_name, row.error_code])).toEqual([
        ['held', 'send_reply', 'send_barrier'],
        ['held:1', 'send', 'send_barrier'],
      ]);
      hold = false;
      checks = 0;
      // Messages arriving after the first part no longer hold back the rest.
      await sendReply.execute('after', { parts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
      expect(checks).toBe(1);
      expect(api.calls.map((call) => call.content)).toEqual(['a', 'b', 'c']);
    } finally {
      fixture.close();
    }
  });

  test('a failed later part keeps the delivered parts, names them, and stops', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi('broken');
      const { sendReply } = makeTools(fixture, { api });
      await expect(
        sendReply.execute('partial', {
          reply_to_message_id: '10',
          parts: [{ text: 'delivered' }, { text: 'broken' }, { text: 'never tried' }],
        }),
      ).rejects.toThrow(
        'Parts 1-1 were published as Telegram messages 501; do not send them again. Part 2 failed: Telegram send failed: telegram_400 The remaining 1 part(s) were not attempted.',
      );
      expect(api.calls.map((call) => call.content)).toEqual(['delivered']);
      expect(
        toolAudit(fixture.store).map((row) => [row.tool_call_id, row.state, row.error_code, row.result_text]),
      ).toEqual([
        ['partial', 'error', 'telegram_400', 'telegram_message_ids=501'],
        ['partial:1', 'success', null, 'telegram_message_id=501'],
        ['partial:2', 'error', 'telegram_400', null],
      ]);
      expect(sendAudit(fixture.store).map((row) => row.state)).toEqual(['success', 'error']);
      expect(botMessages(fixture.store)).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('the first part spends the reply target under the reply-once policy', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { send, sendReply } = makeTools(fixture, { api });
      await send.execute('single', { text: 'answer', reply_to_message_id: '10' });
      await expect(
        sendReply.execute('again', { reply_to_message_id: '10', parts: [{ text: 'a' }, { text: 'b' }] }),
      ).rejects.toThrow('Nothing was sent: part 1 failed. Not sent: reply_already_sent');
      expect(api.calls).toHaveLength(1);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['single', null],
        ['again', 'reply_already_sent'],
        ['again:1', 'reply_already_sent'],
      ]);
    } finally {
      fixture.close();
    }
  });
});
