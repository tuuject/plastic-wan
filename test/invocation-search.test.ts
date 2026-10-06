import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { AdminQueryError, type ListQuery, listInvocations } from '../src/ingress/admin/audit.ts';
import { loadConfig, type RawConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

/**
 * Synthetic coverage for `listInvocations` keyword/time search: public-message
 * matching (frozen `section = 'new'` snapshots plus successful sends only),
 * precision windows, timezone/DST resolution, same-message keyword+time
 * semantics, pagination/isolation and the read-only guarantee.
 */

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
}

interface MatchedMessage {
  readonly source: string;
  readonly telegram_message_id: string | null;
  readonly telegram_send_id: string | null;
  readonly at: string;
  readonly text: string | null;
}

interface Item {
  readonly id: string;
  readonly matched_messages?: readonly MatchedMessage[];
}

let fixture: Fixture | undefined;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-invocation-search-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.timezone = 'UTC';
      config.telegram.chats = [
        { id: -100111, timezone: 'Asia/Shanghai', instructions_file: 'chat-instructions.md' },
        { id: -100222, timezone: 'America/New_York', instructions_file: 'chat-instructions.md' },
      ];
    }),
  );
  const { config } = await loadConfig(configPath);
  const store = await SqliteStore.open(config);
  seed(store);
  fixture = { store, config };
});

afterEach(async () => {
  fixture?.store.close();
  await rm(directory, { recursive: true, force: true });
});

function current(): Fixture {
  if (fixture === undefined) {
    throw new Error('fixture was not initialized');
  }
  return fixture;
}

function list(query: ListQuery): Item[] {
  return listInvocations(current().store.orm, query, current().config).items as unknown as Item[];
}

function ids(query: ListQuery): string[] {
  return list(query).map((item) => item.id);
}

function matched(item: Item): readonly MatchedMessage[] {
  expect(item.matched_messages).toBeDefined();
  return item.matched_messages ?? [];
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AdminQueryError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected an AdminQueryError');
}

test('keyword search matches only public messages; private text and failures stay invisible', () => {
  const items = list({ search: '苹果' });
  expect(items.map((item) => item.id)).toEqual(['403', '401']);

  const invocationA = items.find((item) => item.id === '401');
  expect(invocationA).toBeDefined();
  // Newest first: the bot's send at 00:06:30Z, then the incoming message at 00:00:10Z.
  expect(matched(invocationA as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2001',
      telegram_send_id: '801',
      at: '2025-01-01T00:06:30.000Z',
      text: '机器人回复 苹果',
    },
    {
      source: 'incoming',
      telegram_message_id: '1001',
      telegram_send_id: null,
      at: '2025-01-01T00:00:10.000Z',
      text: '苹果 100% 好吃',
    },
  ]);

  const invocationC = items.find((item) => item.id === '403');
  expect(matched(invocationC as Item)).toEqual([
    {
      source: 'incoming',
      telegram_message_id: '1008',
      telegram_send_id: null,
      at: '2024-03-10T06:29:30.000Z',
      text: '苹果在纽约',
    },
  ]);

  // Private assistant reasoning, tool results, failed sends and history-section
  // snapshots never make an invocation searchable.
  expect(ids({ search: '私密思考' })).toEqual([]);
  expect(ids({ search: '工具结果' })).toEqual([]);
  expect(ids({ search: '失败的发送' })).toEqual([]);
  expect(ids({ search: '也许失败' })).toEqual([]);
  expect(ids({ search: '历史里的秘密' })).toEqual([]);
});

test('cross-conversation successful sends remain searchable under their owning invocation', () => {
  const { store } = current();
  store.db.prepare('UPDATE telegram_sends SET conversation_id = 202 WHERE id = 801').run();
  const items = list({ search: '机器人回复', chat: '-100111' });
  expect(items.map((item) => item.id)).toEqual(['401']);
  expect(matched(items[0] as Item)[0]).toMatchObject({
    source: 'bot',
    telegram_send_id: '801',
    text: '机器人回复 苹果',
  });
  expect(ids({ search: '机器人回复', chat: '-100222' })).toEqual([]);
});

test('a photo caption is matched and previewed when text is empty', () => {
  const items = list({ search: '夜晚' });
  expect(items.map((item) => item.id)).toEqual(['401']);
  expect(matched(items[0] as Item)).toEqual([
    {
      source: 'incoming',
      telegram_message_id: '1002',
      telegram_send_id: null,
      at: '2025-01-01T00:05:20.000Z',
      text: '夜晚的猫',
    },
  ]);
});

test('literal wildcard characters never widen the search', () => {
  expect(ids({ search: '100%' })).toEqual(['401']);
  expect(ids({ search: '%' })).toEqual(['401']);
  expect(ids({ search: 'a_b' })).toEqual(['402']);
  expect(ids({ search: 'axb' })).toEqual(['403']);
});

test('without search or time filters the response keeps its original shape', () => {
  const items = list({});
  expect(items.map((item) => item.id)).toEqual(['405', '404', '403', '402', '401']);
  for (const item of items) {
    expect('matched_messages' in item).toBe(false);
  }
});

test('at is a precision window resolved in the chat timezone, not the host timezone', () => {
  // 2025-01-01T08:00 Asia/Shanghai == 00:00Z-00:01Z.
  const minute = list({ at: '2025-01-01T08:00', chat: '-100111' });
  expect(minute.map((item) => item.id)).toEqual(['401']);
  expect(matched(minute[0] as Item).map((message) => message.telegram_message_id)).toEqual(['1005', '1001']);

  // A minute window starting one second earlier excludes the 00:00:10.000Z message.
  expect(ids({ at: '2025-01-01T08:00:09', chat: '-100111' })).toEqual([]);
  expect(matched(list({ at: '2025-01-01T08:00:10', chat: '-100111' })[0] as Item)).toHaveLength(2);
  // Fractional precision narrows the window to 100ms.
  expect(
    matched(list({ at: '2025-01-01T08:00:10.5', chat: '-100111' })[0] as Item).map(
      (message) => message.telegram_message_id,
    ),
  ).toEqual(['1005']);
  expect(
    matched(list({ at: '2025-01-01T08:00:10.500', chat: '-100111' })[0] as Item).map(
      (message) => message.telegram_message_id,
    ),
  ).toEqual(['1005']);

  // Without a chat the global timezone (UTC here) applies: 00:00Z-00:01Z.
  expect(ids({ at: '2025-01-01T00:00' })).toEqual(['401']);
  // An explicit offset in the value wins over both.
  expect(ids({ at: '2025-01-01T08:00+08:00' })).toEqual(['401']);
  expect(ids({ at: '2025-01-01T08:00:10+08:00' })).toEqual(['401']);
});

test('from is inclusive and to is exclusive, including fractional bounds', () => {
  const window = list({ from: '2025-01-01T08:00:10.500', to: '2025-01-01T08:05:20', chat: '-100111' });
  expect(window.map((item) => item.id)).toEqual(['401']);
  expect(matched(window[0] as Item).map((message) => message.telegram_message_id)).toEqual(['1005']);

  const upperBoundary = list({ to: '2025-01-01T08:00:10.500', chat: '-100111' });
  expect(matched(upperBoundary[0] as Item).map((message) => message.telegram_message_id)).toEqual(['1001']);

  expect(codeOf(() => list({ from: '2025-01-01T10:00', to: '2025-01-01T09:00' }))).toBe('invalid_time_range');
});

test('keyword and time must hit the same message', () => {
  // Only the bot message carries 苹果 inside the 00:06Z minute.
  const items = list({ search: '苹果', at: '2025-01-01T08:06', chat: '-100111' });
  expect(items.map((item) => item.id)).toEqual(['401']);
  expect(matched(items[0] as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2001',
      telegram_send_id: '801',
      at: '2025-01-01T00:06:30.000Z',
      text: '机器人回复 苹果',
    },
  ]);
  expect(ids({ search: '苹果', at: '2025-01-01T08:10', chat: '-100111' })).toEqual([]);
  // 402 has a public message at 01:00Z, but not one containing 100%.
  expect(ids({ search: '100%', at: '2025-01-01T09:00', chat: '-100111' })).toEqual([]);
});

test('bot time prefers the outgoing message telegram_date and falls back to the send time', () => {
  const preferred = list({ search: '机器人' });
  expect(matched(preferred[0] as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2001',
      telegram_send_id: '801',
      at: '2025-01-01T00:06:30.000Z',
      text: '机器人回复 苹果',
    },
  ]);
  // The send finished at 00:07:00Z, one window later; the outgoing row wins.
  expect(ids({ search: '机器人', at: '2025-01-01T08:06:30', chat: '-100111' })).toEqual(['401']);
  expect(ids({ search: '机器人', at: '2025-01-01T08:07', chat: '-100111' })).toEqual([]);

  // A successful send whose outgoing message row is missing falls back to
  // `finished_at` and to the text Telegram accepted.
  const fallback = list({ search: '没有落盘的发送' });
  expect(fallback.map((item) => item.id)).toEqual(['402']);
  expect(matched(fallback[0] as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '3003',
      telegram_send_id: '803',
      at: '2025-01-01T03:00:00.000Z',
      text: '没有落盘的发送',
    },
  ]);
  expect(ids({ at: '2025-01-01T11:00', chat: '-100111' })).toEqual(['402']);
});

test('snapshots stay frozen when the live message is edited afterwards', () => {
  const frozen = list({ search: '旧版本' });
  expect(frozen.map((item) => item.id)).toEqual(['402']);
  expect(matched(frozen[0] as Item)[0]?.text).toBe('旧版本文本');
  // The live revision now says 新版本文本, but no snapshot ever carried it.
  expect(ids({ search: '新版本' })).toEqual([]);
});

test('matched messages keep only the five newest, newest first', () => {
  const items = list({ search: '批量' });
  expect(items.map((item) => item.id)).toEqual(['403']);
  const messages = matched(items[0] as Item);
  expect(messages).toHaveLength(5);
  // The oldest match (批量消息 1) falls outside the per-invocation cap.
  expect(messages.map((message) => message.text)).toEqual([
    '批量消息 6',
    '批量消息 5',
    '批量消息 4',
    '批量消息 3',
    '批量消息 2',
  ]);
  expect(messages.map((message) => message.telegram_message_id)).toEqual(['1026', '1025', '1024', '1023', '1022']);
});

test('more than five mixed incoming/bot matches keep the five newest across both sources', () => {
  const items = list({ search: '混流' });
  expect(items.map((item) => item.id)).toEqual(['404']);
  const messages = matched(items[0] as Item);
  // Seven matches; the newest five interleave bot sends and incoming messages,
  // and the two oldest incoming messages (混流 1/2) are dropped.
  expect(messages).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2102',
      telegram_send_id: '812',
      at: '2025-01-01T06:06:00.000Z',
      text: '混流 回复 2',
    },
    {
      source: 'incoming',
      telegram_message_id: '1105',
      telegram_send_id: null,
      at: '2025-01-01T06:05:00.000Z',
      text: '混流 5',
    },
    {
      source: 'bot',
      telegram_message_id: '2101',
      telegram_send_id: '811',
      at: '2025-01-01T06:04:30.000Z',
      text: '混流 回复 1',
    },
    {
      source: 'incoming',
      telegram_message_id: '1104',
      telegram_send_id: null,
      at: '2025-01-01T06:04:00.000Z',
      text: '混流 4',
    },
    {
      source: 'incoming',
      telegram_message_id: '1103',
      telegram_send_id: null,
      at: '2025-01-01T06:03:00.000Z',
      text: '混流 3',
    },
  ]);
});

test('same-second matches order by the Telegram message ID numerically, not as text', () => {
  const items = list({ search: '同秒' });
  expect(items.map((item) => item.id)).toEqual(['405']);
  const messages = matched(items[0] as Item);
  // All four share one second. Text comparison would put '9999999999999999'
  // and the 2^53-scale ids before the longer '10000000000000000'; the integer
  // order puts it first, and keeps >2^53 ids exact instead of float-rounded.
  expect(messages.map((message) => message.telegram_message_id)).toEqual([
    '10000000000000000',
    '9999999999999999',
    '9007199254740993',
    '9007199254740992',
  ]);
  expect(messages.map((message) => message.source)).toEqual(['incoming', 'bot', 'incoming', 'incoming']);
  for (const message of messages) {
    expect(message.at).toBe('2025-01-01T07:00:00.000Z');
  }
  expect(messages[1]).toEqual({
    source: 'bot',
    telegram_message_id: '9999999999999999',
    telegram_send_id: '813',
    at: '2025-01-01T07:00:00.000Z',
    text: '同秒 回复',
  });
});

test('previews are truncated to 2000 characters', () => {
  const items = list({ search: '超长' });
  expect(items.map((item) => item.id)).toEqual(['403']);
  expect(matched(items[0] as Item)[0]?.text).toHaveLength(2000);
});

test('pagination, chat and state filters keep intersecting with the search', () => {
  const first = listInvocations(current().store.orm, { search: '苹果', limit: '1' }, current().config);
  expect(first.items.map((item) => (item as unknown as Item).id)).toEqual(['403']);
  expect(first.next_cursor).toBe('403');
  const second = listInvocations(current().store.orm, { search: '苹果', limit: '1', cursor: '403' }, current().config);
  expect(second.items.map((item) => (item as unknown as Item).id)).toEqual(['401']);
  expect(second.next_cursor).toBeNull();

  expect(ids({ search: '苹果', chat: '-100222' })).toEqual(['403']);
  expect(ids({ search: '苹果', chat: '-100111' })).toEqual(['401']);
  expect(ids({ search: '苹果', state: 'failed' })).toEqual([]);
  expect(ids({ search: '苹果在纽约' })).toEqual(['403']);
});

test('the host timezone is never consulted and DST gaps/overlaps are rejected with guidance', () => {
  // 01:29 America/New_York is 06:29Z; a host-timezone reading of the same value
  // would look at a completely different window and find nothing.
  const items = list({ at: '2024-03-10T01:29', chat: '-100222' });
  expect(items.map((item) => item.id)).toEqual(['403']);
  expect(matched(items[0] as Item)[0]?.telegram_message_id).toBe('1008');

  expect(codeOf(() => list({ at: '2024-03-10T02:30', chat: '-100222' }))).toBe('invalid_at');
  expect(codeOf(() => list({ at: '2024-11-03T01:30', chat: '-100222' }))).toBe('invalid_at');
  expect(codeOf(() => list({ from: '2024-11-03T01:30', chat: '-100222' }))).toBe('invalid_from');
  expect(codeOf(() => list({ to: '2024-11-03T01:30', chat: '-100222' }))).toBe('invalid_to');
  // An explicit offset resolves the same wall clock without guessing: EST here.
  expect(ids({ at: '2024-03-10T01:29:30-05:00', chat: '-100222' })).toEqual(['403']);
  expect(ids({ at: '2024-03-10T02:30:00-04:00', chat: '-100222' })).toEqual([]);
});

test('invalid inputs fail fast with parameter-specific codes', () => {
  expect(codeOf(() => list({ at: '2025-02-30T10:00' }))).toBe('invalid_at');
  expect(codeOf(() => list({ at: 'not-a-date' }))).toBe('invalid_at');
  expect(codeOf(() => list({ at: '2025-01-01T10:00:00+15:00' }))).toBe('invalid_at');
  expect(codeOf(() => list({ from: '2025-13-01T00:00' }))).toBe('invalid_from');
  expect(codeOf(() => list({ to: '2025-01-01T25:00' }))).toBe('invalid_to');
  expect(codeOf(() => list({ at: '2025-01-01T10:00', from: '2025-01-01T09:00' }))).toBe('invalid_time_range');
  expect(codeOf(() => list({ search: 'x'.repeat(101) }))).toBe('invalid_search');
  // No configuration at all: a bare timestamp is rejected instead of being
  // read in the host timezone, while an explicit offset still resolves.
  expect(codeOf(() => listInvocations(current().store.orm, { at: '2025-01-01T00:00' }))).toBe('invalid_at');
  const withoutConfig = listInvocations(current().store.orm, { at: '2025-01-01T08:00:10+08:00' });
  expect(withoutConfig.items.map((item) => (item as unknown as Item).id)).toEqual(['401']);
});

test('search and time filters never write', () => {
  const tables = [
    'messages',
    'message_revisions',
    'invocation_messages',
    'telegram_sends',
    'tool_calls',
    'agent_messages',
    'invocations',
  ];
  const snapshot = (): { changes: bigint; counts: bigint[] } => ({
    changes: (current().store.db.prepare('SELECT total_changes() AS value').get() as { value: bigint }).value,
    counts: tables.map(
      (table) =>
        (current().store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: bigint }).value,
    ),
  });
  const before = snapshot();
  list({ search: '苹果' });
  list({ search: '苹果', at: '2025-01-01T08:06', chat: '-100111' });
  list({ at: '2025-01-01T08:00', chat: '-100111' });
  list({ from: '2025-01-01T00:00', to: '2025-01-02T00:00' });
  list({ search: '批量' });
  list({ search: '混流' });
  list({ search: '同秒' });
  listInvocations(current().store.orm, {});
  expect(snapshot()).toEqual(before);
});

function seed(store: SqliteStore): void {
  const run = (sql: string, ...params: Array<string | bigint | null>): void => {
    store.db.prepare(sql).run(...params);
  };

  run(
    "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (?, ?, ?, 'supergroup', 'Chat A', ?)",
    101n,
    -100111n,
    -100111n,
    '2025-01-01T00:00:00.000Z',
  );
  run(
    "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (?, ?, ?, 'supergroup', 'Chat B', ?)",
    102n,
    -100222n,
    -100222n,
    '2024-03-10T00:00:00.000Z',
  );
  for (const [id, chatId] of [
    [201n, 101n],
    [202n, 102n],
  ] as const) {
    run(
      'INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
      id,
      chatId,
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    );
  }
  run(
    "INSERT INTO senders(id, telegram_type, telegram_id, display_name, is_bot, updated_at) VALUES (501, 'user', 9001, '测试用户', 0, ?)",
    '2025-01-01T00:00:00.000Z',
  );

  for (const [id, conversationId] of [
    [301n, 201n],
    [302n, 201n],
    [303n, 202n],
  ] as const) {
    run(
      "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (?, ?, 'completed', 'realtime', ?, ?, ?, ?)",
      id,
      conversationId,
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:01:00.000Z',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:02:00.000Z',
    );
  }

  for (const [id, bucketId, conversationId, createdAt] of [
    [401n, 301n, 201n, '2025-01-01T00:00:20.000Z'],
    [402n, 302n, 201n, '2025-01-01T01:10:00.000Z'],
    [403n, 303n, 202n, '2024-03-10T06:30:00.000Z'],
  ] as const) {
    run(
      "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, finished_at, created_at) VALUES (?, ?, ?, 'completed', 'test-hash', 1, ?, ?, ?)",
      id,
      bucketId,
      conversationId,
      createdAt,
      createdAt,
      createdAt,
    );
  }

  const insertMessage = (options: {
    readonly id: bigint;
    readonly chatId: bigint;
    readonly conversationId: bigint;
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly sentByBot: boolean;
    readonly kind: string;
    readonly text: string | null;
    readonly caption: string | null;
  }): bigint => {
    const revisionId = options.id * 10n + 1n;
    run(
      'INSERT INTO messages(id, conversation_id, chat_id, telegram_message_id, visible, sent_by_bot, telegram_date, received_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      options.id,
      options.conversationId,
      options.chatId,
      options.telegramMessageId,
      options.sentByBot ? 1n : 0n,
      options.telegramDate,
      options.telegramDate,
    );
    run(
      'INSERT INTO message_revisions(id, message_id, revision_no, sender_id, kind, text, caption, created_at, raw_fragment_json) VALUES (?, ?, 1, 501, ?, ?, ?, ?, ?)',
      revisionId,
      options.id,
      options.kind,
      options.text,
      options.caption,
      options.telegramDate,
      JSON.stringify({ message_id: options.telegramMessageId.toString() }),
    );
    run('UPDATE messages SET current_revision_id = ? WHERE id = ?', revisionId, options.id);
    return revisionId;
  };

  const snapshotJson = (input: {
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly text: string | null;
    readonly caption: string | null;
  }): string =>
    JSON.stringify({
      message_id: input.telegramMessageId.toString(),
      message_thread_id: '0',
      telegram_date: input.telegramDate,
      sent_by_bot: false,
      revision: '1',
      sender: { id: '9001', name: '测试用户', username: null },
      kind: input.text === null ? 'photo' : 'text',
      text: input.text,
      caption: input.caption,
      reply_to_message_id: null,
      reply_snapshot: null,
      forward_origin: null,
      media_group_id: null,
      media: [],
    });

  const insertSnapshot = (input: {
    readonly invocationId: bigint;
    readonly sequenceNo: bigint;
    readonly section: string;
    readonly messageId: bigint;
    readonly revisionId: bigint;
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly text: string | null;
    readonly caption: string | null;
  }): void => {
    run(
      'INSERT INTO invocation_messages(invocation_id, message_id, revision_id, section, sequence_no, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)',
      input.invocationId,
      input.messageId,
      input.revisionId,
      input.section,
      input.sequenceNo,
      snapshotJson(input),
    );
  };

  const insertBotSend = (input: {
    readonly chatId: bigint;
    readonly conversationId: bigint;
    readonly invocationId: bigint;
    readonly toolCallId: bigint;
    readonly sendId: bigint;
    readonly messageId: bigint;
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly text: string;
  }): void => {
    insertMessage({
      id: input.messageId,
      chatId: input.chatId,
      conversationId: input.conversationId,
      telegramMessageId: input.telegramMessageId,
      telegramDate: input.telegramDate,
      sentByBot: true,
      kind: 'text',
      text: input.text,
      caption: null,
    });
    run(
      "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (?, ?, ?, 'send', ?, ?, 'success', 1, ?, ?)",
      input.toolCallId,
      input.invocationId,
      `call-send-${input.toolCallId}`,
      JSON.stringify({ kind: 'text', text: input.text }),
      `telegram_message_id=${input.telegramMessageId}`,
      input.telegramDate,
      input.telegramDate,
    );
    run(
      'INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, created_at, finished_at) VALUES (?, ?, ?, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'success\', ?, ?, ?, ?)',
      input.sendId,
      input.toolCallId,
      input.conversationId,
      input.telegramMessageId,
      JSON.stringify({ message_id: input.telegramMessageId.toString() }),
      input.telegramDate,
      input.telegramDate,
    );
  };

  // Invocation 401: two public incoming messages, one history snapshot, a
  // private assistant text, a tool result, and two sends of which one succeeded.
  const text601 = insertMessage({
    id: 601n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1001n,
    telegramDate: '2025-01-01T00:00:10.000Z',
    sentByBot: false,
    kind: 'text',
    text: '苹果 100% 好吃',
    caption: null,
  });
  const photo602 = insertMessage({
    id: 602n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1002n,
    telegramDate: '2025-01-01T00:05:20.000Z',
    sentByBot: false,
    kind: 'photo',
    text: null,
    caption: '夜晚的猫',
  });
  const history603 = insertMessage({
    id: 603n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1003n,
    telegramDate: '2025-01-01T00:06:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: '历史里的秘密',
    caption: null,
  });
  const edge605 = insertMessage({
    id: 605n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1005n,
    telegramDate: '2025-01-01T00:00:10.500Z',
    sentByBot: false,
    kind: 'text',
    text: '边缘 3.5 秒',
    caption: null,
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 1n,
    section: 'new',
    messageId: 601n,
    revisionId: text601,
    telegramMessageId: 1001n,
    telegramDate: '2025-01-01T00:00:10.000Z',
    text: '苹果 100% 好吃',
    caption: null,
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 2n,
    section: 'new',
    messageId: 602n,
    revisionId: photo602,
    telegramMessageId: 1002n,
    telegramDate: '2025-01-01T00:05:20.000Z',
    text: null,
    caption: '夜晚的猫',
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 3n,
    section: 'history',
    messageId: 603n,
    revisionId: history603,
    telegramMessageId: 1003n,
    telegramDate: '2025-01-01T00:06:00.000Z',
    text: '历史里的秘密',
    caption: null,
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 4n,
    section: 'new',
    messageId: 605n,
    revisionId: edge605,
    telegramMessageId: 1005n,
    telegramDate: '2025-01-01T00:00:10.500Z',
    text: '边缘 3.5 秒',
    caption: null,
  });
  run(
    "INSERT INTO agent_messages(id, invocation_id, sequence_no, role, text, created_at) VALUES (701, 401, 1, 'assistant', '私密思考 苹果', ?)",
    '2025-01-01T00:00:30.000Z',
  );
  run(
    "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (902, 401, 'call-read-a', 'read', '{}', '工具结果 苹果', 'success', 0, ?, ?)",
    '2025-01-01T00:00:40.000Z',
    '2025-01-01T00:00:41.000Z',
  );
  const outgoing604 = insertMessage({
    id: 604n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 2001n,
    telegramDate: '2025-01-01T00:06:30.000Z',
    sentByBot: true,
    kind: 'text',
    text: '机器人回复 苹果',
    caption: null,
  });
  expect(outgoing604).toBe(6041n);
  run(
    "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (901, 401, 'call-send-a', 'send', '{\"kind\":\"text\",\"text\":\"机器人回复 苹果\"}', 'telegram_message_id=2001', 'success', 1, ?, ?)",
    '2025-01-01T00:06:29.000Z',
    '2025-01-01T00:07:00.000Z',
  );
  run(
    'INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, created_at, finished_at) VALUES (801, 901, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'success\', 2001, \'{"message_id":2001}\', ?, ?)',
    '2025-01-01T00:06:29.000Z',
    '2025-01-01T00:07:00.000Z',
  );
  run(
    'INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at, finished_at) VALUES (905, 401, \'call-send-unknown\', \'send\', \'{"kind":"text","text":"也许失败 苹果Y"}\', \'outcome_unknown\', 1, ?, ?)',
    '2025-01-01T00:07:59.000Z',
    '2025-01-01T00:08:00.000Z',
  );
  run(
    'INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (802, 905, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'outcome_unknown\', NULL, ?, ?)',
    '2025-01-01T00:07:59.000Z',
    '2025-01-01T00:08:00.000Z',
  );

  // Invocation 402: a snapshot whose live message is edited afterwards, plus
  // literal-wildcard bait and a successful send with no outgoing row.
  const frozen607 = insertMessage({
    id: 607n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1007n,
    telegramDate: '2025-01-01T01:00:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: '旧版本文本',
    caption: null,
  });
  const edited609 = insertMessage({
    id: 609n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1009n,
    telegramDate: '2025-01-01T02:00:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: '100x 好吃',
    caption: null,
  });
  const underscore611 = insertMessage({
    id: 611n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1011n,
    telegramDate: '2025-01-01T02:10:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: 'a_b 边界',
    caption: null,
  });
  insertSnapshot({
    invocationId: 402n,
    sequenceNo: 1n,
    section: 'new',
    messageId: 607n,
    revisionId: frozen607,
    telegramMessageId: 1007n,
    telegramDate: '2025-01-01T01:00:00.000Z',
    text: '旧版本文本',
    caption: null,
  });
  insertSnapshot({
    invocationId: 402n,
    sequenceNo: 2n,
    section: 'new',
    messageId: 609n,
    revisionId: edited609,
    telegramMessageId: 1009n,
    telegramDate: '2025-01-01T02:00:00.000Z',
    text: '100x 好吃',
    caption: null,
  });
  insertSnapshot({
    invocationId: 402n,
    sequenceNo: 3n,
    section: 'new',
    messageId: 611n,
    revisionId: underscore611,
    telegramMessageId: 1011n,
    telegramDate: '2025-01-01T02:10:00.000Z',
    text: 'a_b 边界',
    caption: null,
  });
  // Edit message 607 after its snapshot was frozen: revision 2 becomes live.
  run(
    "INSERT INTO message_revisions(id, message_id, revision_no, sender_id, kind, text, caption, created_at, raw_fragment_json) VALUES (6072, 607, 2, 501, 'text', '新版本文本', NULL, ?, ?)",
    '2025-01-01T02:30:00.000Z',
    '{"message_id":1007}',
  );
  run('UPDATE messages SET current_revision_id = 6072 WHERE id = 607');
  run(
    'INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at, finished_at) VALUES (903, 402, \'call-send-no-row\', \'send\', \'{"kind":"text","text":"没有落盘的发送"}\', \'success\', 1, ?, ?)',
    '2025-01-01T02:59:59.000Z',
    '2025-01-01T03:00:00.000Z',
  );
  run(
    'INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, created_at, finished_at) VALUES (803, 903, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'success\', 3003, \'{"message_id":3003}\', ?, ?)',
    '2025-01-01T02:59:59.000Z',
    '2025-01-01T03:00:00.000Z',
  );
  run(
    "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, error_code, created_at, finished_at) VALUES (904, 402, 'call-send-b', 'send', '{\"kind\":\"text\",\"text\":\"失败的发送 苹果X\"}', 'error', 1, 'send_error', ?, ?)",
    '2025-01-01T03:29:59.000Z',
    '2025-01-01T03:30:00.000Z',
  );
  run(
    'INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (804, 904, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'error\', NULL, ?, ?)',
    '2025-01-01T03:29:59.000Z',
    '2025-01-01T03:30:00.000Z',
  );

  // Invocation 403 (Chat B): a DST-adjacent incoming message, underscore bait,
  // six cappable matches and an oversized preview.
  const newYork608 = insertMessage({
    id: 608n,
    chatId: 102n,
    conversationId: 202n,
    telegramMessageId: 1008n,
    telegramDate: '2024-03-10T06:29:30.000Z',
    sentByBot: false,
    kind: 'text',
    text: '苹果在纽约',
    caption: null,
  });
  const plain610 = insertMessage({
    id: 610n,
    chatId: 102n,
    conversationId: 202n,
    telegramMessageId: 1010n,
    telegramDate: '2024-03-10T06:40:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: 'axb 边界',
    caption: null,
  });
  insertSnapshot({
    invocationId: 403n,
    sequenceNo: 1n,
    section: 'new',
    messageId: 608n,
    revisionId: newYork608,
    telegramMessageId: 1008n,
    telegramDate: '2024-03-10T06:29:30.000Z',
    text: '苹果在纽约',
    caption: null,
  });
  insertSnapshot({
    invocationId: 403n,
    sequenceNo: 2n,
    section: 'new',
    messageId: 610n,
    revisionId: plain610,
    telegramMessageId: 1010n,
    telegramDate: '2024-03-10T06:40:00.000Z',
    text: 'axb 边界',
    caption: null,
  });
  for (let index = 1; index <= 6; index++) {
    const messageId = 620n + BigInt(index);
    const telegramMessageId = 1020n + BigInt(index);
    const telegramDate = `2025-01-01T04:0${index}:00.000Z`;
    const revisionId = insertMessage({
      id: messageId,
      chatId: 102n,
      conversationId: 202n,
      telegramMessageId,
      telegramDate,
      sentByBot: false,
      kind: 'text',
      text: `批量消息 ${index}`,
      caption: null,
    });
    insertSnapshot({
      invocationId: 403n,
      sequenceNo: BigInt(index + 2),
      section: 'new',
      messageId,
      revisionId,
      telegramMessageId,
      telegramDate,
      text: `批量消息 ${index}`,
      caption: null,
    });
  }
  const long630 = insertMessage({
    id: 630n,
    chatId: 102n,
    conversationId: 202n,
    telegramMessageId: 1030n,
    telegramDate: '2025-01-01T05:00:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: `超长${'喵'.repeat(2_400)}`,
    caption: null,
  });
  insertSnapshot({
    invocationId: 403n,
    sequenceNo: 9n,
    section: 'new',
    messageId: 630n,
    revisionId: long630,
    telegramMessageId: 1030n,
    telegramDate: '2025-01-01T05:00:00.000Z',
    text: `超长${'喵'.repeat(2_400)}`,
    caption: null,
  });

  // Invocation 404 (Chat A): seven mixed public matches, so the per-invocation
  // cap has to keep the five newest across both sources.
  run(
    "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (304, 201, 'completed', 'realtime', ?, ?, ?, ?)",
    '2025-01-01T06:00:00.000Z',
    '2025-01-01T06:01:00.000Z',
    '2025-01-01T06:00:00.000Z',
    '2025-01-01T06:10:00.000Z',
  );
  run(
    "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, finished_at, created_at) VALUES (404, 304, 201, 'completed', 'test-hash', 1, ?, ?, ?)",
    '2025-01-01T06:10:00.000Z',
    '2025-01-01T06:10:00.000Z',
    '2025-01-01T06:10:00.000Z',
  );
  const mixedIncoming: ReadonlyArray<[bigint, string]> = [
    [1101n, '2025-01-01T06:01:00.000Z'],
    [1102n, '2025-01-01T06:02:00.000Z'],
    [1103n, '2025-01-01T06:03:00.000Z'],
    [1104n, '2025-01-01T06:04:00.000Z'],
    [1105n, '2025-01-01T06:05:00.000Z'],
  ];
  mixedIncoming.forEach(([telegramMessageId, telegramDate], index) => {
    const messageId = 640n + BigInt(index);
    const revisionId = insertMessage({
      id: messageId,
      chatId: 101n,
      conversationId: 201n,
      telegramMessageId,
      telegramDate,
      sentByBot: false,
      kind: 'text',
      text: `混流 ${index + 1}`,
      caption: null,
    });
    insertSnapshot({
      invocationId: 404n,
      sequenceNo: BigInt(index + 1),
      section: 'new',
      messageId,
      revisionId,
      telegramMessageId,
      telegramDate,
      text: `混流 ${index + 1}`,
      caption: null,
    });
  });
  insertBotSend({
    chatId: 101n,
    conversationId: 201n,
    invocationId: 404n,
    toolCallId: 911n,
    sendId: 811n,
    messageId: 645n,
    telegramMessageId: 2101n,
    telegramDate: '2025-01-01T06:04:30.000Z',
    text: '混流 回复 1',
  });
  insertBotSend({
    chatId: 101n,
    conversationId: 201n,
    invocationId: 404n,
    toolCallId: 912n,
    sendId: 812n,
    messageId: 646n,
    telegramMessageId: 2102n,
    telegramDate: '2025-01-01T06:06:00.000Z',
    text: '混流 回复 2',
  });

  // Invocation 405 (Chat A): four matches inside one public second with
  // large (>2^53) Telegram message IDs, including one bot send.
  run(
    "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (305, 201, 'completed', 'realtime', ?, ?, ?, ?)",
    '2025-01-01T07:00:00.000Z',
    '2025-01-01T07:01:00.000Z',
    '2025-01-01T07:00:00.000Z',
    '2025-01-01T07:10:00.000Z',
  );
  run(
    "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, finished_at, created_at) VALUES (405, 305, 201, 'completed', 'test-hash', 1, ?, ?, ?)",
    '2025-01-01T07:10:00.000Z',
    '2025-01-01T07:10:00.000Z',
    '2025-01-01T07:10:00.000Z',
  );
  const sameSecond: ReadonlyArray<[bigint, string]> = [
    [9007199254740993n, '同秒 甲'],
    [9007199254740992n, '同秒 乙'],
    [10000000000000000n, '同秒 丙'],
  ];
  sameSecond.forEach(([telegramMessageId, text], index) => {
    const messageId = 650n + BigInt(index);
    const revisionId = insertMessage({
      id: messageId,
      chatId: 101n,
      conversationId: 201n,
      telegramMessageId,
      telegramDate: '2025-01-01T07:00:00.000Z',
      sentByBot: false,
      kind: 'text',
      text,
      caption: null,
    });
    insertSnapshot({
      invocationId: 405n,
      sequenceNo: BigInt(index + 1),
      section: 'new',
      messageId,
      revisionId,
      telegramMessageId,
      telegramDate: '2025-01-01T07:00:00.000Z',
      text,
      caption: null,
    });
  });
  insertBotSend({
    chatId: 101n,
    conversationId: 201n,
    invocationId: 405n,
    toolCallId: 913n,
    sendId: 813n,
    messageId: 653n,
    telegramMessageId: 9999999999999999n,
    telegramDate: '2025-01-01T07:00:00.000Z',
    text: '同秒 回复',
  });
}
