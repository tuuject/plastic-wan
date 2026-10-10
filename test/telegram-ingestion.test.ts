import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup(
  transform?: (config: FileConfig) => void,
  botUsername?: string,
): Promise<{ store: SqliteStore; ingestion: TelegramIngestion }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-ingest-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const { config } = loaded;
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(config);
  return {
    store,
    ingestion: new TelegramIngestion(store, configStore, {
      id: 999,
      ...(botUsername === undefined ? {} : { username: botUsername }),
    }),
  };
}

function textUpdate(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function groupTextUpdate(updateId: number, messageId: number, senderId: number, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'supergroup', title: 'Group' },
      from: { id: senderId, is_bot: false, first_name: `User ${senderId}` },
      text: `message from ${senderId}`,
    },
  };
}

function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      sticker: {
        file_id: `sticker-${messageId}`,
        file_unique_id: `sticker-unique-${messageId}`,
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
}

describe('Telegram ingestion', () => {
  test('stores denied metadata without content', async () => {
    const { store, ingestion } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'private text', 777));
    const row = store.db
      .prepare<[], { raw_json: string | null; rejection_reason: string }>(
        'SELECT raw_json, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(row).toEqual({ raw_json: null, rejection_reason: 'chat_not_allowed' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    store.close();
  });

  test('uses the configured window and preserves the first deadline', async () => {
    const { store, ingestion } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const firstTime = new Date('2026-08-15T00:00:00.000Z');
    const first = ingestion.ingest(textUpdate(1, 10, 'first'), firstTime);
    const duplicate = ingestion.ingest(textUpdate(1, 10, 'first'), firstTime);
    const second = ingestion.ingest(textUpdate(2, 11, 'second'), new Date(firstTime.getTime() + 5_000));
    expect(duplicate.messageId).toBeUndefined();
    expect(first.bucketId).toBe(second.bucketId);
    const bucket = store.db
      .prepare<[], { deadline_at: string; messages: bigint }>(
        'SELECT b.deadline_at, COUNT(bm.message_id) AS messages FROM buckets b JOIN bucket_messages bm ON bm.bucket_id = b.id GROUP BY b.id',
      )
      .get();
    expect(bucket).toEqual({ deadline_at: '2026-08-15T00:00:06.000Z', messages: 2n });
    store.close();
  });

  test('waits a full window for a message that arrives while the conversation is being served', async () => {
    // Regression: with the pace rule once treating every message that arrived
    // during an active invocation as immediately due, a long-lived run consumed
    // each such bucket on the spot — one message became one zero-length bucket
    // and one injection, so the fixed window disappeared.
    const { store, ingestion } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    // The conversation is being served right now, past its own window.
    store.db
      .prepare(
        `INSERT INTO invocations(bucket_id, conversation_id, state, config_hash, prompt_version, started_at, created_at)
         VALUES ((SELECT id FROM buckets LIMIT 1), (SELECT id FROM conversations LIMIT 1), 'running', 'hash', 1, ?, ?)`,
      )
      .run(new Date(start.getTime() + 6_000).toISOString(), start.toISOString());
    store.db
      .prepare("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations LIMIT 1)")
      .run();

    ingestion.ingest(textUpdate(2, 11, 'late arrival'), new Date(start.getTime() + 20_000));
    const bucket = store.db
      .prepare<[], { state: string; first_received_at: string; deadline_at: string }>(
        'SELECT state, first_received_at, deadline_at FROM buckets ORDER BY id DESC LIMIT 1',
      )
      .get();
    // Due one window after it arrived, not the moment it landed: the batch has
    // to be able to collect the messages that follow it.
    expect(bucket).toEqual({
      state: 'collecting',
      first_received_at: '2026-08-15T00:00:20.000Z',
      deadline_at: '2026-08-15T00:00:26.000Z',
    });
    store.close();
  });

  test('edits append revisions without creating or extending buckets', async () => {
    const { store, ingestion } = await setup();
    const receivedAt = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), receivedAt);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_005,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(receivedAt.getTime() + 5_000));
    const row = store.db
      .prepare<[], { revisions: bigint; text: string; buckets: bigint }>(
        'SELECT (SELECT COUNT(*) FROM message_revisions) AS revisions, r.text, (SELECT COUNT(*) FROM buckets) AS buckets FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id',
      )
      .get();
    expect(row).toEqual({ revisions: 2n, text: 'after', buckets: 1n });
    store.close();
  });

  test('bot and service messages cannot trigger collection', async () => {
    const { store, ingestion } = await setup();
    const botUpdate = textUpdate(1, 10, 'bot');
    if (botUpdate.message === undefined || botUpdate.message.from === undefined) {
      throw new Error('Invalid fixture');
    }
    botUpdate.message.from.is_bot = true;
    botUpdate.message.from.id = 500;
    const serviceUpdate: Update = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        new_chat_members: [{ id: 43, is_bot: false, first_name: 'Bob' }],
      },
    };
    ingestion.ingest(botUpdate);
    ingestion.ingest(serviceUpdate);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    store.close();
  });

  test('drops ignored users before commands, storage, and bucket collection', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const trigger = ingestion.ingest(groupTextUpdate(1, 10, 7));
    const ignored = ingestion.ingest(groupTextUpdate(2, 11, 42));
    const commandUpdate = groupTextUpdate(3, 12, 42);
    if (commandUpdate.message === undefined) {
      throw new Error('Invalid fixture');
    }
    commandUpdate.message.text = '/pause';
    commandUpdate.message.entities = [{ type: 'bot_command', offset: 0, length: 6 }];
    const ignoredCommand = ingestion.ingest(commandUpdate);
    const replyUpdate = groupTextUpdate(4, 13, 7);
    if (replyUpdate.message === undefined) {
      throw new Error('Invalid fixture');
    }
    replyUpdate.message.text = 'reply from 7';
    replyUpdate.message.reply_to_message = {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'User 42' },
      text: 'message from 42',
      reply_to_message: undefined as never,
    };
    ingestion.ingest(replyUpdate);

    expect(trigger.bucketId).toBeDefined();
    expect(ignored).toEqual({});
    expect(ignoredCommand).toEqual({});
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates').get()?.count).toBe(
      4n,
    );
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM senders').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count).toBe(
      2n,
    );
    expect(
      store.db
        .prepare<[string], { reply_to_message_id: bigint | null; reply_snapshot_json: string | null }>(
          'SELECT reply_to_message_id, reply_snapshot_json FROM message_revisions WHERE text = ?',
        )
        .get('reply from 7'),
    ).toEqual({ reply_to_message_id: null, reply_snapshot_json: null });
    store.close();
  });

  test('drops edits from ignored users without changing a stored message', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    ingestion.ingest(groupTextUpdate(1, 10, 7));
    const ignoredEdit = groupTextUpdate(2, 10, 42);
    if (ignoredEdit.message === undefined) {
      throw new Error('Invalid fixture');
    }
    const editedMessage = ignoredEdit.message;
    const editedUpdate: Update = {
      update_id: ignoredEdit.update_id,
      edited_message: { ...editedMessage, text: 'ignored edit', edit_date: 1_700_000_010 },
    };
    expect(ingestion.ingest(editedUpdate)).toEqual({});
    expect(
      store.db
        .prepare<[], { revisions: bigint; text: string }>(
          'SELECT COUNT(*) AS revisions, MAX(text) AS text FROM message_revisions',
        )
        .get(),
    ).toEqual({ revisions: 1n, text: 'message from 7' });
    store.close();
  });

  test('scopes ignored users to the configured chat and not sender_chat identities', async () => {
    const secondChatId = 987654321;
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
      config.telegram.chats.push({
        id: secondChatId,
      });
    });
    expect(ingestion.ingest(groupTextUpdate(1, 10, 42))).toEqual({});
    expect(ingestion.ingest(groupTextUpdate(2, 11, 42, secondChatId)).bucketId).toBeDefined();
    const senderChatUpdate: Update = {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 42, is_bot: false, first_name: 'Anonymous sender' },
        sender_chat: { id: 42, type: 'channel', title: 'Channel identity' },
        text: 'sender chat message',
      },
    };
    expect(ingestion.ingest(senderChatUpdate).messageId).toBeDefined();
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    store.close();
  });

  test('inherits ignored users after a group migrates to a supergroup', async () => {
    const migratedChatId = -1001234567890;
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const migration = groupTextUpdate(1, 10, 7);
    if (migration.message === undefined) {
      throw new Error('Invalid fixture');
    }
    migration.message.chat = { id: 123456789, type: 'group', title: 'Old group' };
    migration.message.migrate_to_chat_id = migratedChatId;
    ingestion.ingest(migration);

    expect(ingestion.ingest(groupTextUpdate(2, 11, 42, migratedChatId))).toEqual({});
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('an anonymous admin message is a human message despite its placeholder bot sender', async () => {
    const { store, ingestion } = await setup();
    const anonymous: Update = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
        sender_chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        text: 'from an anonymous admin',
      },
    };
    const result = ingestion.ingest(anonymous);
    expect(result.messageId).toBeDefined();
    expect(result.bucketId).toBeDefined();
    expect(
      store.db
        .prepare<[], { telegram_type: string; is_bot: bigint }>(
          'SELECT telegram_type, is_bot FROM senders WHERE telegram_id = 123456789',
        )
        .get(),
    ).toEqual({ telegram_type: 'sender_chat', is_bot: 0n });
    // A real bot without a sender_chat is still dropped by default.
    const bot: Update = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 555, is_bot: true, first_name: 'Other', username: 'other_bot' },
        text: 'bot message',
      },
    };
    expect(ingestion.ingest(bot)).toEqual({});
    store.close();
  });

  test('authorizes the new supergroup from a migrate_from notice seen first', async () => {
    const migratedChatId = -1001234567890;
    const { store, ingestion } = await setup();
    // The notice arrives in the new supergroup, whose ID is not configured yet.
    const notice: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: migratedChatId, type: 'supergroup', title: 'Group' },
        from: { id: 7, is_bot: false, first_name: 'User 7' },
        migrate_from_chat_id: 123456789,
      },
    } as Update;
    ingestion.ingest(notice);
    expect(
      store.db.prepare<[], { new_chat_id: bigint }>('SELECT new_chat_id FROM chat_migrations').get()?.new_chat_id,
    ).toBe(BigInt(migratedChatId));
    expect(ingestion.ingest(groupTextUpdate(2, 2, 7, migratedChatId)).messageId).toBeDefined();
    store.close();
  });

  test('a migrate_from notice cannot hand on an allowlist entry the old chat never had', async () => {
    const { store, ingestion } = await setup();
    const notice: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: -1009999999999, type: 'supergroup', title: 'Other' },
        from: { id: 7, is_bot: false, first_name: 'User 7' },
        migrate_from_chat_id: 555,
      },
    } as Update;
    ingestion.ingest(notice);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_migrations').get()?.count).toBe(
      0n,
    );
    expect(ingestion.ingest(groupTextUpdate(2, 2, 7, -1009999999999))).toEqual({});
    store.close();
  });

  test('requires sticker_trigger_enabled for a sticker to open a bucket', async () => {
    const disabled = await setup();
    const standalone = disabled.ingestion.ingest(stickerUpdate(1, 10));
    expect(standalone.messageId).toBeDefined();
    expect(standalone.bucketId).toBeUndefined();
    expect(disabled.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(
      0n,
    );
    const text = disabled.ingestion.ingest(textUpdate(2, 11, 'hello'));
    const companion = disabled.ingestion.ingest(stickerUpdate(3, 12));
    expect(companion.bucketId).toBe(text.bucketId);
    expect(
      disabled.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count,
    ).toBe(2n);
    disabled.store.close();

    const enabled = await setup((config) => {
      config.telegram.sticker_trigger_enabled = true;
    });
    expect(enabled.ingestion.ingest(stickerUpdate(4, 20)).bucketId).toBeDefined();
    enabled.store.close();
  });

  test('holds other bots messages until a human opens the next bucket', async () => {
    const botUpdate = (updateId: number, messageId: number): Update => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1_700_000_000 + messageId,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 77, is_bot: true, first_name: 'OtherBot' },
        text: `beep ${messageId}`,
      },
    });
    const bucketRows = (store: SqliteStore) =>
      store.db
        .prepare<[], { bucket_id: bigint; sequence_no: bigint; telegram_message_id: bigint }>(
          `SELECT bm.bucket_id, bm.sequence_no, m.telegram_message_id
           FROM bucket_messages bm JOIN messages m ON m.id = bm.message_id
           ORDER BY bm.bucket_id, bm.sequence_no`,
        )
        .all();

    const disabled = await setup();
    expect(disabled.ingestion.ingest(botUpdate(1, 10))).toEqual({});
    expect(
      disabled.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count,
    ).toBe(0n);
    disabled.store.close();

    const { store, ingestion } = await setup((config) => {
      config.telegram.process_bot_messages = true;
    });
    const first = ingestion.ingest(botUpdate(1, 10));
    expect(first.messageId).toBeDefined();
    expect(first.bucketId).toBeUndefined();
    expect(ingestion.ingest(botUpdate(2, 11)).bucketId).toBeUndefined();
    expect(bucketRows(store)).toEqual([]);

    const human = ingestion.ingest(groupTextUpdate(3, 12, 42));
    expect(human.bucketId).toBeDefined();
    const bucketId = human.bucketId ?? 0n;
    // A bot message while the bucket is collecting simply joins it.
    expect(ingestion.ingest(botUpdate(4, 13)).bucketId).toBe(bucketId);
    expect(bucketRows(store)).toEqual([
      { bucket_id: bucketId, sequence_no: 1n, telegram_message_id: 10n },
      { bucket_id: bucketId, sequence_no: 2n, telegram_message_id: 11n },
      { bucket_id: bucketId, sequence_no: 3n, telegram_message_id: 12n },
      { bucket_id: bucketId, sequence_no: 4n, telegram_message_id: 13n },
    ]);

    // Once that bucket is consumed, later bot messages wait for the next human
    // and are adopted exactly once.
    store.db.prepare("UPDATE buckets SET state = 'running'").run();
    expect(ingestion.ingest(botUpdate(5, 14)).bucketId).toBeUndefined();
    const next = ingestion.ingest(groupTextUpdate(6, 15, 42));
    expect(next.bucketId).toBeDefined();
    expect(bucketRows(store).filter((row) => row.bucket_id === next.bucketId)).toEqual([
      { bucket_id: next.bucketId ?? 0n, sequence_no: 1n, telegram_message_id: 14n },
      { bucket_id: next.bucketId ?? 0n, sequence_no: 2n, telegram_message_id: 15n },
    ]);
    store.close();
  });

  test('keeps ordinary supergroup reply threads in the main conversation', async () => {
    const { store, ingestion } = await setup();
    const chat = { id: 123456789, type: 'supergroup' as const, title: 'Group' };
    const sender = { id: 42, is_bot: false, first_name: 'Alice' };
    const rootMessage = {
      message_id: 10,
      date: 1_700_000_000,
      chat,
      from: sender,
      text: 'root',
    };
    const first = ingestion.ingest({ update_id: 1, message: rootMessage });
    const second = ingestion.ingest({
      update_id: 2,
      message: {
        message_id: 11,
        message_thread_id: 10,
        date: 1_700_000_001,
        chat,
        from: sender,
        text: 'reply',
      },
    });
    expect(second.bucketId).toBe(first.bucketId);
    expect(
      store.db
        .prepare<[], { conversations: bigint; thread_id: bigint; messages: bigint }>(
          `SELECT COUNT(DISTINCT v.id) AS conversations, MAX(v.message_thread_id) AS thread_id,
                  COUNT(bm.message_id) AS messages
           FROM conversations v
           JOIN buckets b ON b.conversation_id = v.id
           JOIN bucket_messages bm ON bm.bucket_id = b.id`,
        )
        .get(),
    ).toEqual({ conversations: 1n, thread_id: 0n, messages: 2n });
    store.close();
  });

  test('isolates allowed forum topics and rejects unconfigured topics', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.topic_ids = [100, 200];
    });
    const topicUpdate = (updateId: number, messageId: number, threadId: number): Update => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        message_thread_id: threadId,
        is_topic_message: true,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: `topic-${threadId}`,
      },
    });
    ingestion.ingest(topicUpdate(1, 10, 100));
    ingestion.ingest(topicUpdate(2, 11, 200));
    ingestion.ingest(topicUpdate(3, 12, 300));
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversations').get()?.count).toBe(
      2n,
    );
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(2n);
    expect(
      store.db
        .prepare<[], { reason: string }>('SELECT rejection_reason AS reason FROM telegram_updates WHERE update_id = 3')
        .get()?.reason,
    ).toBe('topic_not_allowed');
    store.close();
  });

  describe('mention signal for immediate typing', () => {
    const BOT = 'PlasticWanBot';
    const mentionUpdate = (
      updateId: number,
      messageId: number,
      fields: Record<string, unknown> = {},
      kind: 'message' | 'edited_message' = 'message',
    ): Update => {
      const message = {
        message_id: messageId,
        date: 1_700_000_000,
        ...(kind === 'edited_message' ? { edit_date: 1_700_000_100 } : {}),
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: `@${BOT} ping`,
        entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }],
        ...fields,
      };
      return { update_id: updateId, [kind]: message } as unknown as Update;
    };

    test('reports chat and topic for a live @mention that joined a bucket', async () => {
      const { store, ingestion } = await setup(undefined, BOT);
      const result = ingestion.ingest(mentionUpdate(1, 10));
      expect(result.bucketId).toBeDefined();
      expect(result.mention).toEqual({ chatId: 123456789n, threadId: 0n });
      const topic = ingestion.ingest(
        mentionUpdate(2, 11, {
          message_thread_id: 77,
          is_topic_message: true,
          chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
        }),
      );
      expect(topic.mention).toEqual({ chatId: 123456789n, threadId: 77n });
      store.close();
    });

    test('counts text mentions of the bot id and captions, case-insensitively', async () => {
      const { store, ingestion } = await setup(undefined, BOT);
      const textMention = ingestion.ingest(
        mentionUpdate(1, 10, {
          text: 'Wan hello',
          entities: [
            { type: 'text_mention', offset: 0, length: 3, user: { id: 999, is_bot: true, first_name: 'Wan' } },
          ],
        }),
      );
      const caption = ingestion.ingest(
        mentionUpdate(2, 11, {
          text: undefined,
          caption: `@${BOT.toLowerCase()} look`,
          entities: undefined,
          caption_entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }],
        }),
      );
      expect(textMention.mention).toBeDefined();
      expect(caption.mention).toBeDefined();
      store.close();
    });

    test('stays silent for everything that is not a live human @mention of this bot', async () => {
      const { store, ingestion } = await setup(undefined, BOT);
      const other = ingestion.ingest(
        mentionUpdate(1, 10, { text: '@SomeoneElse hi', entities: [{ type: 'mention', offset: 0, length: 12 }] }),
      );
      const plain = ingestion.ingest(mentionUpdate(2, 11, { text: 'hello', entities: undefined }));
      const reply = ingestion.ingest(
        mentionUpdate(3, 12, {
          text: 'replying',
          entities: undefined,
          reply_to_message: {
            message_id: 5,
            date: 1_700_000_000,
            chat: { id: 123456789, type: 'supergroup', title: 'Group' },
            from: { id: 999, is_bot: true, first_name: 'Wan' },
            text: 'earlier',
          },
        }),
      );
      const fromBot = ingestion.ingest(mentionUpdate(4, 13, { from: { id: 555, is_bot: true, first_name: 'Other' } }));
      const edited = ingestion.ingest(mentionUpdate(5, 14, {}, 'edited_message'));
      const catchUp = ingestion.ingestCatchUp(mentionUpdate(6, 15));
      for (const result of [other, plain, reply, fromBot, edited, catchUp]) {
        expect(result.mention).toBeUndefined();
      }
      store.close();
    });

    test('stays silent while the chat is paused and when the option is turned off', async () => {
      const paused = await setup(undefined, BOT);
      paused.ingestion.ingest(mentionUpdate(1, 10, { text: 'warm up', entities: undefined }));
      paused.store.db
        .prepare("INSERT INTO chat_pause (chat_id, paused_at) SELECT id, '2026-08-15T00:00:00.000Z' FROM chats")
        .run();
      expect(paused.ingestion.ingest(mentionUpdate(2, 11)).mention).toBeUndefined();
      paused.store.close();

      const off = await setup((config) => {
        config.telegram.mention_typing_enabled = false;
      }, BOT);
      const result = off.ingestion.ingest(mentionUpdate(1, 10));
      expect(result.bucketId).toBeDefined();
      expect(result.mention).toBeUndefined();
      off.store.close();
    });

    test('a message participation keeps out of every bucket reports nothing, a mention that opens the window does', async () => {
      const { store, ingestion } = await setup((config) => {
        config.telegram.participation = { active_windows: [{ start: '00:00', end: '00:01' }] };
      }, BOT);
      const plain = ingestion.ingest(
        mentionUpdate(1, 10, { text: 'hello', entities: undefined }),
        new Date('2026-08-15T13:00:00.000Z'),
      );
      expect(plain.bucketId).toBeUndefined();
      expect(plain.mention).toBeUndefined();
      const mention = ingestion.ingest(mentionUpdate(2, 11), new Date('2026-08-15T13:00:05.000Z'));
      expect(mention.bucketId).toBeDefined();
      expect(mention.mention).toBeDefined();
      store.close();
    });
  });
});
