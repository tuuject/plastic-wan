import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { type LoadedConfig, loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { sleep, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const ALICE = { id: 42n, name: 'Alice', username: 'alice' };
const FIRST_CHAT = 123456789n;
const SECOND_CHAT = 987654321n;
const BUCKET_WINDOW_MS = 15_000;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function groupUpdate(updateId: number, messageId: number, text: string, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function commandUpdate(updateId: number, messageId: number, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/cut_topic',
      entities: [{ offset: 0, length: 10, type: 'bot_command' }],
    },
  };
}

function forumUpdate(updateId: number, messageId: number, text: string, threadId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(FIRST_CHAT), type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      message_thread_id: threadId,
      is_topic_message: true,
      text,
    },
  } as Update;
}

async function setup(): Promise<{
  loaded: LoadedConfig;
  configStore: RuntimeConfigurationStore;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  commands: BotCommandService;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-cut-topic-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.admins = [42];
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.id = Number(FIRST_CHAT);
      config.telegram.chats.push({
        id: Number(SECOND_CHAT),
        instructions_file: 'chat-instructions.md',
      });
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  return {
    loaded,
    configStore,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999, username: 'plasticwan_test_bot' }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
  };
}

function completeInvocation(store: SqliteStore, invocationId: bigint, at: Date): void {
  store.db
    .prepare("UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ? WHERE id = ?")
    .run(new Date(at.getTime() - 1_000).toISOString(), at.toISOString(), invocationId);
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
}

function chatOfInvocation(store: SqliteStore, invocationId: bigint): bigint | undefined {
  return store.db
    .prepare<[bigint], { chat_id: bigint }>(
      'SELECT c.telegram_chat_id AS chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id JOIN chats c ON c.id = v.chat_id WHERE i.id = ?',
    )
    .get(invocationId)?.chat_id;
}

/**
 * Queues and completes every due bucket (mirroring the runtime pacing), then
 * ingests the trigger message, runs its invocation to completion and returns
 * the frozen history texts of that invocation.
 */
function invocationHistory(
  store: SqliteStore,
  ingestion: TelegramIngestion,
  scheduler: BucketScheduler,
  chatId: bigint,
  updateId: number,
  messageId: number,
  text: string,
  at: Date,
): string[] {
  const flushAt = new Date(at.getTime() - 1);
  for (const invocationId of scheduler.processDue(flushAt)) {
    completeInvocation(store, invocationId, flushAt);
  }
  ingestion.ingest(groupUpdate(updateId, messageId, text, chatId), at);
  const queued = scheduler.processDue(new Date(at.getTime() + BUCKET_WINDOW_MS + 1_000));
  if (queued.length === 0) {
    throw new Error(`Expected a queued invocation for chat ${chatId}`);
  }
  let invocationId: bigint | undefined;
  for (const id of queued) {
    completeInvocation(store, id, new Date(at.getTime() + BUCKET_WINDOW_MS + 2_000));
    if (chatOfInvocation(store, id) === chatId) {
      invocationId = id;
    }
  }
  if (invocationId === undefined) {
    throw new Error(`No queued invocation found for chat ${chatId}`);
  }
  return store.db
    .prepare<[bigint], { snapshot_json: string }>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no",
    )
    .all(invocationId)
    .map((row) => (JSON.parse(row.snapshot_json) as { text: string | null }).text ?? '');
}

describe('cut_topic', () => {
  test('without a cutoff, history includes earlier messages unchanged', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'old', FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 11, 'later', FIRST_CHAT), new Date(start.getTime() + 1_000));
    const history = invocationHistory(
      store,
      ingestion,
      scheduler,
      FIRST_CHAT,
      3,
      12,
      'trigger',
      new Date(start.getTime() + BUCKET_WINDOW_MS + 1_000),
    );
    expect(history).toEqual(['old', 'later']);
    store.close();
  });

  test('cut_topic excludes the command message and everything before it from new invocations', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 11, 'still old', FIRST_CHAT), new Date(start.getTime() + 1_000));
    const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date(start.getTime() + 2_000)).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 12n });
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('已切掉');
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(12n);

    const history = invocationHistory(
      store,
      ingestion,
      scheduler,
      FIRST_CHAT,
      4,
      13,
      'after cut',
      new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
    );
    expect(history).toEqual([]);
    store.close();
  });

  test('cut_topic also clears the retained Conversation Context', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    const invocationId = scheduler.processDue(new Date(start.getTime() + BUCKET_WINDOW_MS))[0];
    if (invocationId === undefined) {
      throw new Error('Expected an invocation');
    }
    const conversationId = store.db
      .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(invocationId)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    // A retained transcript the model would otherwise keep seeing.
    const contexts = new ConversationContextStore(store);
    const { header } = contexts.open(conversationId, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'old note', timestamp: 1 }),
      role: 'user',
    });
    expect(contexts.retained(header)).toHaveLength(1);

    const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date(start.getTime() + 2_000)).command;
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('清空');

    // The truncation has to reach the transcript too: otherwise the command
    // would only trim the rendered history while the model kept its memory.
    const reopened = contexts.header(conversationId);
    expect(reopened?.headSeq).toBe(reopened?.nextSeq);
    expect(contexts.retained(reopened!)).toEqual([]);
    store.close();
  });

  // Regression: Telegram sets `message_thread_id` on more than forum topics — a
  // private chat with thread mode enabled carries one, and so does a reply inside a
  // plain supergroup. Ingestion files both under thread 0, but `parseBotCommand` read
  // the raw field, so `/cut_topic` looked for a Conversation nobody ever wrote,
  // cleared nothing, and still wrote the per-Chat cutoff and replied that it had
  // cleared. That is exactly the failure the cut exists to prevent: rendered history
  // truncated, transcript intact. Observed in production in a private chat.
  const threadedShapes: readonly {
    readonly label: string;
    readonly shape: (update: Update) => Update;
  }[] = [
    {
      label: 'a private chat in thread mode',
      shape: (update) =>
        ({
          ...update,
          message: {
            ...update.message!,
            chat: { id: update.message!.chat.id, type: 'private', first_name: 'Alice' },
            message_thread_id: 7,
          },
        }) as Update,
    },
    {
      label: 'a reply thread of a plain supergroup',
      shape: (update) =>
        ({
          ...update,
          message: { ...update.message!, message_thread_id: 10, reply_to_message_id: 10 },
        }) as Update,
    },
  ];

  for (const { label, shape } of threadedShapes) {
    test(`cut_topic clears the Context when the command carries a thread id from ${label}`, async () => {
      const { store, ingestion, scheduler, commands } = await setup();
      const start = new Date('2026-08-15T00:00:00.000Z');
      ingestion.ingest(shape(groupUpdate(1, 10, 'polluted', FIRST_CHAT)), start);
      const invocationId = scheduler.processDue(new Date(start.getTime() + BUCKET_WINDOW_MS))[0];
      if (invocationId === undefined) {
        throw new Error('Expected an invocation');
      }
      const conversationId = store.db
        .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
        .get(invocationId)?.conversation_id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // Ingestion put this Conversation on thread 0, because the chat is not a forum.
      expect(
        store.db
          .prepare<[bigint], { message_thread_id: bigint }>('SELECT message_thread_id FROM conversations WHERE id = ?')
          .get(conversationId)?.message_thread_id,
      ).toBe(0n);
      const contexts = new ConversationContextStore(store);
      const { header } = contexts.open(conversationId, 'hash-a');
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: 'old note', timestamp: 1 }),
        role: 'user',
      });
      expect(contexts.retained(header)).toHaveLength(1);

      const command = ingestion.ingest(
        shape(commandUpdate(3, 12, FIRST_CHAT)),
        new Date(start.getTime() + 2_000),
      ).command;
      expect(command?.threadId).toBeUndefined();
      expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('清空');

      const reopened = contexts.header(conversationId);
      expect(reopened?.headSeq).toBe(reopened?.nextSeq);
      expect(contexts.retained(reopened!)).toEqual([]);
      store.close();
    });
  }

  test('cut_topic interrupts the invocation that still holds the pre-cut transcript', async () => {
    // A run in flight keeps the pre-cut transcript in memory and a header snapshot
    // taken at its start, so leaving it alive let it answer from the history the
    // admin had just cut and write its stale, lower `head_seq` back over the cut.
    const { store, ingestion, configStore } = await setup();
    let abortReason: string | undefined;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const scheduler = new BucketScheduler(store, configStore, async (_invocationId, _snapshot, signal) => {
      signal.addEventListener('abort', () => {
        abortReason = (signal.reason as Error | undefined)?.message;
      });
      await gate;
      return { state: 'completed', reason: 'done' };
    });
    const commands = new BotCommandService(store, configStore, scheduler);
    try {
      scheduler.start();
      // Backdated so the bucket is already past its window and launches at once.
      ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), new Date(Date.now() - BUCKET_WINDOW_MS - 1_000));
      scheduler.wake();
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        store.db.prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1").get() ===
          undefined
      ) {
        await sleep(10);
      }
      expect(
        store.db.prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1").get(),
      ).not.toBeUndefined();

      const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date()).command;
      expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('清空');
      expect(abortReason).toBe('context_cut');
    } finally {
      release();
      await scheduler.stop();
      store.close();
    }
  }, 30_000);

  test('messages after the cutoff remain and re-running cut_topic moves the cutoff forward', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);

    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), at(0));
    const first = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), at(1)).command;
    await commands.run(first!, FIRST_CHAT, ALICE);

    // After the first cut, the trigger itself is the only eligible message and
    // sits in its own bucket, so the frozen history is empty.
    expect(invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 3, 12, 'fresh start', at(17))).toEqual([]);

    const second = ingestion.ingest(commandUpdate(4, 13, FIRST_CHAT), at(34)).command;
    await commands.run(second!, FIRST_CHAT, ALICE);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(13n);

    // A message arriving after the second cut stays eligible for later sessions.
    ingestion.ingest(groupUpdate(5, 14, 'between', FIRST_CHAT), at(50));
    expect(invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 6, 15, 'new topic', at(66))).toEqual(['between']);
    store.close();
  });

  test('the cutoff only affects its own chat', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, `polluted ${FIRST_CHAT}`, FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 10, `polluted ${SECOND_CHAT}`, SECOND_CHAT), start);
    const command = ingestion.ingest(commandUpdate(3, 11, FIRST_CHAT), new Date(start.getTime() + 1_000)).command;
    await commands.run(command!, FIRST_CHAT, ALICE);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(1n);

    expect(
      invocationHistory(
        store,
        ingestion,
        scheduler,
        FIRST_CHAT,
        4,
        12,
        'trigger',
        new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
      ),
    ).toEqual([]);
    expect(
      invocationHistory(
        store,
        ingestion,
        scheduler,
        SECOND_CHAT,
        5,
        13,
        'trigger',
        new Date(start.getTime() + 2 * BUCKET_WINDOW_MS + 4_000),
      ),
    ).toEqual([`polluted ${SECOND_CHAT}`]);
    store.close();
  });

  test('non-admin senders are denied and no cutoff row is written', async () => {
    const { store, ingestion, commands } = await setup();
    const command = ingestion.ingest(commandUpdate(1, 10, FIRST_CHAT), new Date()).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 10n });
    expect(await commands.run(command!, FIRST_CHAT, { id: 99n, name: 'Mallory', username: 'mallory' })).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(0n);
    store.close();
  });

  test('the cutoff survives scheduler and command service recreation', async () => {
    const { store, ingestion, scheduler, commands, configStore } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    const command = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), new Date(start.getTime() + 1_000)).command;
    await commands.run(command!, FIRST_CHAT, ALICE);
    await scheduler.stop();

    const reopened = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const recreatedCommands = new BotCommandService(store, configStore, reopened);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(11n);
    recreatedCommands.run({ name: 'cut_topic', messageId: 20n }, FIRST_CHAT, ALICE);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(20n);
    expect(
      invocationHistory(
        store,
        ingestion,
        reopened,
        FIRST_CHAT,
        3,
        21,
        'trigger',
        new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
      ),
    ).toEqual([]);
    await reopened.stop();
    store.close();
  });

  test("cut_topic in one forum topic leaves the other topics' history alone", async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);
    ingestion.ingest(forumUpdate(1, 10, 'topic A old', 100), at(0));
    ingestion.ingest(forumUpdate(2, 11, 'topic B old', 200), at(1));
    for (const id of scheduler.processDue(at(60))) {
      completeInvocation(store, id, at(61));
    }
    for (const id of scheduler.processDue(at(62))) {
      completeInvocation(store, id, at(63));
    }
    const commandUpdate = forumUpdate(3, 12, '/cut_topic', 100);
    commandUpdate.message!.entities = [{ offset: 0, length: 10, type: 'bot_command' }];
    const command = ingestion.ingest(commandUpdate, at(70)).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 12n, threadId: 100n });
    await commands.run(command!, FIRST_CHAT, ALICE);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(1n);

    const historyOf = (updateId: number, messageId: number, threadId: number, seconds: number): string[] => {
      ingestion.ingest(forumUpdate(updateId, messageId, 'trigger', threadId), at(seconds));
      const [invocationId] = scheduler.processDue(at(seconds + 20));
      if (invocationId === undefined) {
        throw new Error(`Expected an invocation for topic ${threadId}`);
      }
      completeInvocation(store, invocationId, at(seconds + 21));
      return store.db
        .prepare<[bigint], { snapshot_json: string }>(
          "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no",
        )
        .all(invocationId)
        .map((row) => (JSON.parse(row.snapshot_json) as { text: string | null }).text ?? '');
    };
    expect(historyOf(4, 13, 100, 80)).toEqual([]);
    expect(historyOf(5, 14, 200, 120)).toEqual(['topic B old']);
    store.close();
  });

  test('an older cut_topic never moves the cutoff backwards', async () => {
    const { store, ingestion, commands } = await setup();
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), new Date('2026-08-15T00:00:00.000Z'));
    await commands.run({ name: 'cut_topic', messageId: 20n }, FIRST_CHAT, ALICE);
    await commands.run({ name: 'cut_topic', messageId: 15n }, FIRST_CHAT, ALICE);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(20n);
    store.close();
  });
});
