import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { createSendTool, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BotCommandService, type CommandSender } from '../src/orchestration/bot-commands.ts';
import { BucketScheduler, STARTUP_CATCH_UP_STATE_KEY } from '../src/orchestration/scheduler.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { runStartupCatchUp, type StartupCatchUpApi } from '../src/startup-catch-up.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  sleep,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  type TestContextOptions,
  type TestInvocationContext,
} from './helpers.ts';

const directories: string[] = [];

const FIRST_CHAT_ID = 123456789;
const SECOND_CHAT_ID = 987654321;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function topicUpdate(updateId: number, messageId: number, chatId: number, threadId: number, date: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      message_thread_id: threadId,
      is_topic_message: true,
      date,
      chat: { id: chatId, type: 'supergroup', title: `Chat ${chatId}`, is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `chat-${chatId}-message-${messageId}`,
    },
  };
}

function textUpdate(updateId: number, messageId: number, senderId: number, chatId = FIRST_CHAT_ID): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: `Chat ${chatId}` },
      from: { id: senderId, is_bot: false, first_name: `User ${senderId}` },
      text: `message from ${senderId}`,
    },
  };
}

function commandUpdate(
  updateId: number,
  messageId: number,
  token: string,
  options: { readonly chatId?: number; readonly senderId?: number } = {},
): Update {
  // A bot_command entity spans only the command token, never trailing arguments.
  const entityLength = token.includes(' ') ? token.indexOf(' ') : token.length;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: options.chatId ?? FIRST_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: options.senderId ?? 42, is_bot: false, first_name: 'Alice' },
      text: token,
      entities: [{ offset: 0, length: entityLength, type: 'bot_command' }],
    },
  };
}

function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: FIRST_CHAT_ID, type: 'private', first_name: 'Owner' },
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

function fakeApi(updates: readonly Update[]): StartupCatchUpApi {
  return {
    getUpdates: async (options) =>
      updates
        .filter((update) => options.offset === undefined || update.update_id >= options.offset)
        .slice(0, options.limit),
  };
}

async function setup(
  twoChats: boolean,
  transform?: (config: FileConfig) => void,
): Promise<{
  readonly store: SqliteStore;
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly commands: BotCommandService;
  readonly build: (invocationId: bigint, options?: TestContextOptions) => TestInvocationContext;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-startup-catch-up-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.agent.history_messages = 10;
    if (twoChats) {
      config.telegram.chats.push({
        id: SECOND_CHAT_ID,
        instructions_file: 'chat-instructions.md',
      });
    }
    transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  return {
    store,
    loaded,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
    build: (invocationId: bigint, options: TestContextOptions = {}) =>
      renderInvocationContext(store, loaded.config, invocationId, options),
  };
}

function fixedClock(): () => Date {
  let milliseconds = Date.parse('2026-08-17T03:00:00.000Z');
  return () => new Date(milliseconds++);
}

describe('startup catch-up', () => {
  test('creates one invocation per conversation with the configured latest messages', async () => {
    const { store, ingestion, scheduler, commands } = await setup(true);
    const updates: Update[] = [];
    for (let index = 0; index < 15; index += 1) {
      updates.push(topicUpdate(index * 2 + 1, index + 1, FIRST_CHAT_ID, 100, 1_700_000_000 + index));
      updates.push(topicUpdate(index * 2 + 2, index + 101, SECOND_CHAT_ID, 200, 1_700_000_000 + index));
    }
    const result = await runStartupCatchUp({
      api: fakeApi(updates),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.updates).toBe(30);
    expect(result.invocationIds).toHaveLength(2);
    const buckets = store.db
      .prepare<[], { kind: string; state: string; count: bigint }>(
        'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state',
      )
      .all();
    expect(buckets).toEqual([{ kind: 'startup_catch_up', state: 'queued', count: 2n }]);
    const snapshots = store.db
      .prepare<[], { chat_id: bigint; section: string; count: bigint; first_message: bigint; last_message: bigint }>(
        `SELECT c.telegram_chat_id AS chat_id, im.section, COUNT(*) AS count,
                MIN(m.telegram_message_id) AS first_message, MAX(m.telegram_message_id) AS last_message
         FROM invocation_messages im
         JOIN invocations i ON i.id = im.invocation_id
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         JOIN messages m ON m.id = im.message_id
         GROUP BY c.telegram_chat_id, im.section
         ORDER BY c.telegram_chat_id`,
      )
      .all();
    expect(snapshots).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), section: 'new', count: 10n, first_message: 6n, last_message: 15n },
      { chat_id: BigInt(SECOND_CHAT_ID), section: 'new', count: 10n, first_message: 106n, last_message: 115n },
    ]);
    expect(
      store.db.prepare('SELECT value FROM app_state WHERE key = ?').get(STARTUP_CATCH_UP_STATE_KEY),
    ).toBeUndefined();
    store.close();
  });

  test('excludes ignored users from startup catch-up storage and context', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, (config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 42), textUpdate(2, 11, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    const snapshot = store.db
      .prepare<[], { snapshot_json: string }>('SELECT snapshot_json FROM invocation_messages')
      .get();
    expect(snapshot === undefined ? null : JSON.parse(snapshot.snapshot_json).sender.id).toBe('7');
    store.close();

    const ignoredOnly = await setup(false, (config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const ignoredOnlyResult = await runStartupCatchUp({
      api: fakeApi([textUpdate(3, 12, 42)]),
      store: ignoredOnly.store,
      ingestion: ignoredOnly.ingestion,
      scheduler: ignoredOnly.scheduler,
      commands: ignoredOnly.commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(ignoredOnlyResult.storedMessages).toBe(0);
    expect(ignoredOnlyResult.invocationIds).toHaveLength(0);
    ignoredOnly.store.close();
  });

  test('applies sticker_trigger_enabled to startup catch-up invocations', async () => {
    const disabled = await setup(false);
    const disabledResult = await runStartupCatchUp({
      api: fakeApi([stickerUpdate(1, 10)]),
      store: disabled.store,
      ingestion: disabled.ingestion,
      scheduler: disabled.scheduler,
      commands: disabled.commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(disabledResult.storedMessages).toBe(1);
    expect(disabledResult.invocationIds).toHaveLength(0);
    disabled.store.close();

    const enabled = await setup(false, (config) => {
      config.telegram.sticker_trigger_enabled = true;
    });
    const enabledResult = await runStartupCatchUp({
      api: fakeApi([stickerUpdate(1, 10)]),
      store: enabled.store,
      ingestion: enabled.ingestion,
      scheduler: enabled.scheduler,
      commands: enabled.commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(enabledResult.invocationIds).toHaveLength(1);
    enabled.store.close();
  });

  test('switches to realtime buckets after draining pending updates', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false);
    await runStartupCatchUp({
      api: fakeApi([topicUpdate(1, 10, FIRST_CHAT_ID, 100, 1_700_000_000)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    const live = ingestion.ingest(
      topicUpdate(2, 11, FIRST_CHAT_ID, 200, 1_700_000_100),
      new Date('2026-08-17T03:01:00.000Z'),
    );
    expect(live.bucketId).toBeDefined();
    const states = store.db
      .prepare<[], { kind: string; state: string; count: bigint }>(
        'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state ORDER BY kind',
      )
      .all();
    expect(states).toEqual([
      { kind: 'realtime', state: 'collecting', count: 1n },
      { kind: 'startup_catch_up', state: 'queued', count: 1n },
    ]);
    store.close();
  });

  test('keeps forum topics of one chat in separate invocations', async () => {
    const { store, loaded, ingestion, scheduler, commands, build } = await setup(false);
    const result = await runStartupCatchUp({
      api: fakeApi([
        topicUpdate(1, 10, FIRST_CHAT_ID, 100, 1_700_000_000),
        topicUpdate(2, 11, FIRST_CHAT_ID, 200, 1_700_000_001),
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(result.invocationIds).toHaveLength(2);
    const sentThreads: Array<number | undefined> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, _text, options) => {
        sentThreads.push(options.message_thread_id);
        return { message_id: 500 + sentThreads.length, date: 1_700_000_100, chat: { id: FIRST_CHAT_ID } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: FIRST_CHAT_ID } }),
    };
    const prompts: string[] = [];
    for (const invocationId of result.invocationIds) {
      const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
      prompts.push(context.userPrompt);
      const tool = createSendTool({
        store,
        api,
        context,
        capabilities: invocationCapabilities(store, loaded.config, context.header),
        sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
        maxTextLength: undefined,
        disallowBlankLines: false,
        deadline: Date.now() + 30_000,
        bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      });
      await tool.execute(`default-topic-${invocationId}`, { kind: 'text', text: 'latest' });
    }
    expect(sentThreads).toEqual([100, 200]);
    expect(prompts[0]).toContain(`chat-${FIRST_CHAT_ID}-message-10`);
    expect(prompts[0]).not.toContain(`chat-${FIRST_CHAT_ID}-message-11`);
    expect(prompts[1]).toContain(`chat-${FIRST_CHAT_ID}-message-11`);
    expect(prompts[1]).not.toContain(`chat-${FIRST_CHAT_ID}-message-10`);
    const outgoingThreads = store.db
      .prepare<[], { message_thread_id: bigint }>(
        'SELECT v.message_thread_id FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE m.sent_by_bot = 1 ORDER BY m.id',
      )
      .all()
      .map((row) => row.message_thread_id);
    expect(outgoingThreads).toEqual([100n, 200n]);
    store.close();
  });

  test('keeps catch-up work queued across a drain longer than the recovery age', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false);
    let now = new Date('2026-08-17T03:00:00.000Z');
    let polls = 0;
    const api: StartupCatchUpApi = {
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) {
          return [textUpdate(1, 10, 7)];
        }
        // The drain itself outlived RECOVERY_MAX_AGE_MS — the same state a
        // crash mid-drain leaves when the resumed drain finishes later.
        now = new Date(now.getTime() + 6 * 60_000);
        return [];
      },
    };
    const result = await runStartupCatchUp({
      api,
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: () => now,
    });
    expect(result.invocationIds).toHaveLength(1);

    // application.ts runs scheduler.start() right after the drain, and start()
    // calls recover(now) before its loop. Freshly queued catch-up work must
    // survive it; otherwise every message of the drain is dropped as stale.
    scheduler.recover(now);
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'queued', error_code: null });
    expect(
      store.db
        .prepare<[], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations',
        )
        .get(),
    ).toEqual({ state: 'queued', completion_reason: null });

    // Not just kept: the run reaches its audited terminal state.
    scheduler.start(now);
    try {
      const deadline = Date.now() + 10_000;
      let invocation: { state: string; completion_reason: string | null } | undefined;
      while (Date.now() < deadline) {
        invocation = store.db
          .prepare<[], { state: string; completion_reason: string | null }>(
            'SELECT state, completion_reason FROM invocations',
          )
          .get();
        if (invocation !== undefined && invocation.state !== 'queued' && invocation.state !== 'running') {
          break;
        }
        await sleep(10);
      }
      expect(invocation).toEqual({ state: 'completed', completion_reason: 'done' });
      expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state).toBe('completed');
    } finally {
      await scheduler.stop();
      store.close();
    }
  }, 20_000);

  test('still expires catch-up work whose recovery age has truly passed', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false);
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(result.invocationIds).toHaveLength(1);

    // The process died before scheduler.start() and came back six minutes
    // later. Queued work this old is exactly what recovery_age is for: the
    // freshness fix must not keep genuinely stale invocations alive forever.
    scheduler.recover(new Date(Date.parse('2026-08-17T03:00:00.000Z') + 6 * 60_000));
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'expired', error_code: 'recovery_age' });
    expect(
      store.db
        .prepare<[], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations',
        )
        .get(),
    ).toEqual({ state: 'aborted', completion_reason: 'recovery_age' });
    store.close();
  });
});

describe('startup catch-up commands', () => {
  const ADMIN: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
  const admins: (config: FileConfig) => void = (config) => {
    config.telegram.admins = [42];
  };

  test('replays /pause and /resume from the backlog in update order', async () => {
    const { store, ingestion, scheduler, commands } = await setup(true, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([
        textUpdate(1, 10, 7),
        commandUpdate(2, 11, '/pause'),
        commandUpdate(3, 12, '/resume'),
        textUpdate(4, 13, 7, SECOND_CHAT_ID),
        commandUpdate(5, 14, '/pause', { chatId: SECOND_CHAT_ID }),
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    // The first chat ends resumed and queues its catch-up invocation; the
    // second ends paused, so its bucket is skipped with chat_paused.
    expect(result.storedMessages).toBe(2);
    expect(result.invocationIds).toHaveLength(1);
    expect(
      store.db
        .prepare<[], { chat_id: bigint }>(
          'SELECT c.telegram_chat_id AS chat_id FROM chat_pause p JOIN chats c ON c.id = p.chat_id',
        )
        .all(),
    ).toEqual([{ chat_id: BigInt(SECOND_CHAT_ID) }]);
    expect(
      store.db
        .prepare<[], { chat_id: bigint; state: string; error_code: string | null }>(
          `SELECT c.telegram_chat_id AS chat_id, b.state, b.error_code
           FROM buckets b JOIN conversations v ON v.id = b.conversation_id JOIN chats c ON c.id = v.chat_id
           ORDER BY c.telegram_chat_id`,
        )
        .all(),
    ).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), state: 'queued', error_code: null },
      { chat_id: BigInt(SECOND_CHAT_ID), state: 'skipped_budget', error_code: 'chat_paused' },
    ]);
    // Commands are audited, never stored as messages.
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM message_revisions WHERE text LIKE '/%'")
        .get()?.count,
    ).toBe(0n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1').get()
        ?.count,
    ).toBe(5n);
    store.close();
  });

  test('a later /pause in the backlog overrides an earlier /resume', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/resume'), commandUpdate(3, 12, '/pause')]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.invocationIds).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(1n);
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'skipped_budget', error_code: 'chat_paused' });
    store.close();
  });

  test('a non-admin /pause in the backlog is audited and changes nothing', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, (config) => {
      config.telegram.admins = [7];
    });
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/pause', { senderId: 42 })]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'queued', error_code: null });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1').get()
        ?.count,
    ).toBe(2n);
    store.close();
  });

  test('other commands are audited but never stored, replayed, or injected', async () => {
    const { store, ingestion, scheduler, commands, build } = await setup(false, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([
        textUpdate(1, 10, 7),
        commandUpdate(2, 11, '/status'),
        commandUpdate(3, 12, '/cut_topic'),
        commandUpdate(4, 13, '/whoami'),
        commandUpdate(5, 14, '/model'),
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    // /cut_topic's cutoff is an administrative effect that must not be replayed.
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(0n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1').get()
        ?.count,
    ).toBe(5n);
    const invocationId = result.invocationIds[0];
    if (invocationId === undefined) {
      throw new Error('Expected a catch-up invocation');
    }
    const context = build(invocationId);
    expect(context.userPrompt).toContain('message from 7');
    for (const token of ['/status', '/cut_topic', '/whoami', '/model']) {
      expect(context.userPrompt).not.toContain(token);
    }
    store.close();
  });

  test('an admin /allowlist in an unlisted chat is not replayed from the backlog', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([commandUpdate(1, 10, '/allowlist', { chatId: SECOND_CHAT_ID })]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(0);
    expect(result.invocationIds).toHaveLength(0);
    expect(
      store.db
        .prepare<[], { allowed: bigint; rejection_reason: string }>(
          'SELECT allowed, rejection_reason FROM telegram_updates',
        )
        .get(),
    ).toEqual({ allowed: 0n, rejection_reason: 'chat_not_allowed' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chats').get()?.count).toBe(0n);
    store.close();
  });

  test('an edited /pause in the backlog is a revision, not a command', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const edited = commandUpdate(2, 10, '/pause');
    const editedMessage = edited.message;
    if (editedMessage === undefined) {
      throw new Error('Invalid fixture');
    }
    const result = await runStartupCatchUp({
      api: fakeApi([
        textUpdate(1, 10, 7),
        { update_id: 2, edited_message: { ...editedMessage, edit_date: 1_700_000_100 } },
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM message_revisions').get()?.count,
    ).toBe(2n);
    store.close();
  });

  test("an ignored user's /pause in the backlog is dropped", async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, (config) => {
      config.telegram.admins = [42];
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/pause')]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('a retried drain does not replay commands for duplicate updates', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const clock = fixedClock();
    const api = fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/pause')]);
    const first = await runStartupCatchUp({
      api,
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: clock,
    });
    expect(first.invocationIds).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(1n);

    // The admin resumes live, then the process dies before acknowledging and the
    // same backlog is fetched again: the duplicate /pause must not re-apply.
    expect(await commands.run({ name: 'resume' }, BigInt(FIRST_CHAT_ID), ADMIN)).toBe('已恢复本群互动。');
    const retry = await runStartupCatchUp({
      api,
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: clock,
    });
    expect(retry.storedMessages).toBe(0);
    expect(retry.invocationIds).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates').get()?.count).toBe(
      2n,
    );
    store.close();
  });

  test('live commands keep their realtime contract after the drain', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    const live = ingestion.ingest(commandUpdate(2, 11, '/pause'));
    expect(live.command).toEqual({ name: 'pause', messageId: 11n });
    expect(live.messageId).toBeUndefined();
    const command = live.command;
    if (command === undefined) {
      throw new Error('Expected a live command');
    }
    expect(await commands.run(command, BigInt(FIRST_CHAT_ID), ADMIN)).toBe('已暂停本群互动，发送 /resume 可恢复。');
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });
});
