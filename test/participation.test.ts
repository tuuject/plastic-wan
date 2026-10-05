import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { type FileConfig, type RawConfig, loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import {
  type ParticipationRule,
  compileParticipation,
  isWithinActiveWindows,
  matchTriggerKind,
} from '../src/platform/participation.ts';
import { type StartupCatchUpApi, runStartupCatchUp } from '../src/startup-catch-up.ts';
import { SqliteStore, purgeExpiredData } from '../src/store/database.ts';
import { renderInvocationContext, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

const GROUP_CHAT_ID = -1_001_234_567_890;
const PRIVATE_CHAT_ID = 123_456_789;
const BOT_ID = 999;
const BOT_USERNAME = 'PlasticWanBot';
const BOT_IDENTITY = { id: BigInt(BOT_ID), username: BOT_USERNAME };

// 2026-08-15 is a Saturday; 10:00 UTC is inside 09:00-12:00 and 13:00 is not.
const INSIDE_PERIOD = new Date('2026-08-15T10:00:00.000Z');
const OUTSIDE_PERIOD = new Date('2026-08-15T13:00:00.000Z');

const DAY_WINDOW = { start: '09:00', end: '12:00' };

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

type ParticipationOptions = NonNullable<FileConfig['telegram']['participation']>;

interface Harness {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly commands: BotCommandService;
}

async function setup(
  options: {
    readonly global?: ParticipationOptions;
    readonly chat?: ParticipationOptions;
    readonly timezone?: string;
    readonly chatId?: number;
  } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-participation-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats = [
      {
        id: options.chatId ?? GROUP_CHAT_ID,
        instructions_file: 'chat-instructions.md',
        ...(options.chat === undefined ? {} : { participation: options.chat }),
      },
    ];
    if (options.global !== undefined) {
      config.telegram.participation = options.global;
    }
    if (options.timezone !== undefined) {
      config.timezone = options.timezone;
    }
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
    config: loaded.config,
    configStore,
    ingestion: new TelegramIngestion(store, configStore, { id: BOT_ID, username: BOT_USERNAME }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
  };
}

// Fixtures build only the subset of a Telegram message the ingestion boundary
// reads, so the message is widened once instead of restating the full union.
type LooseFields = Record<string, unknown>;

function groupMessage(updateId: number, messageId: number, fields: LooseFields = {}): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      ...fields,
    },
  } as unknown as Update;
}

function privateMessage(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: PRIVATE_CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  } as unknown as Update;
}

function mentionText(): LooseFields {
  return {
    text: `@${BOT_USERNAME} ping`,
    entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
  };
}

function replyFields(fromId: number, isBot: boolean): LooseFields {
  return {
    text: 'replying',
    reply_to_message: {
      message_id: 900,
      date: 1_700_000_000,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: fromId, is_bot: isBot, first_name: 'Replied' },
      text: 'earlier',
    },
  };
}

function editedGroupMessage(updateId: number, messageId: number, editDate: number, fields: LooseFields): Update {
  return {
    update_id: updateId,
    edited_message: {
      message_id: messageId,
      date: 1_700_000_000,
      edit_date: editDate,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      ...fields,
    },
  } as unknown as Update;
}

function bucketCount(store: SqliteStore): bigint {
  return store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count ?? -1n;
}

function bucketMessages(store: SqliteStore): bigint {
  return store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count ?? -1n;
}

function attention(store: SqliteStore): { expiresAt: string; triggerKind: string } | null {
  const row = store.db
    .prepare<[], { expires_at: string; trigger_kind: string }>(
      'SELECT expires_at, trigger_kind FROM conversation_attention',
    )
    .get();
  return row === undefined ? null : { expiresAt: row.expires_at, triggerKind: row.trigger_kind };
}

function ruleOf(options: {
  readonly windows?: readonly { start: string; end: string; days?: number[] }[];
  readonly keywords?: readonly string[];
  readonly seconds?: number;
  readonly timezone?: string;
}): ParticipationRule {
  const rule = compileParticipation({
    global: {
      ...(options.windows === undefined ? {} : { active_windows: [...options.windows] }),
      ...(options.keywords === undefined ? {} : { trigger_keywords: [...options.keywords] }),
      ...(options.seconds === undefined ? {} : { attention_window_seconds: options.seconds }),
    },
    chat: undefined,
    timezone: options.timezone ?? 'UTC',
  });
  if (rule === undefined) {
    throw new Error('Expected the participation rule to compile');
  }
  return rule;
}

describe('participation rules', () => {
  test('treats active windows as a half-open local-time interval', () => {
    const rule = ruleOf({ windows: [DAY_WINDOW] });
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T08:59:59.000Z'))).toBe(false);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T09:00:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T11:59:59.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T12:00:00.000Z'))).toBe(false);
  });

  test('assigns a window crossing midnight to its start day', () => {
    const rule = ruleOf({ windows: [{ start: '23:00', end: '01:00', days: [5] }] });
    // Friday 2026-08-14 23:30 and the following Saturday 00:30 both match.
    expect(isWithinActiveWindows(rule, new Date('2026-08-14T23:30:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T00:30:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T23:30:00.000Z'))).toBe(false);
    expect(isWithinActiveWindows(rule, new Date('2026-08-14T00:30:00.000Z'))).toBe(false);
  });

  test('restricts windows to the listed weekdays', () => {
    const rule = ruleOf({ windows: [{ start: '09:00', end: '12:00', days: [1, 2, 3, 4, 5] }] });
    expect(isWithinActiveWindows(rule, INSIDE_PERIOD)).toBe(false);
    expect(isWithinActiveWindows(rule, new Date('2026-08-17T10:00:00.000Z'))).toBe(true);
  });

  test('covers the whole day with 00:00-24:00 and never matches an empty list', () => {
    const allDay = ruleOf({ windows: [{ start: '00:00', end: '24:00' }] });
    expect(isWithinActiveWindows(allDay, new Date('2026-08-15T00:00:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(allDay, new Date('2026-08-15T23:59:59.000Z'))).toBe(true);
    const none = ruleOf({ windows: [] });
    expect(isWithinActiveWindows(none, INSIDE_PERIOD)).toBe(false);
  });

  test('resolves windows in the configured timezone', () => {
    const shanghai = ruleOf({ windows: [DAY_WINDOW], timezone: 'Asia/Shanghai' });
    // 01:30 UTC is 09:30 in Shanghai, so the same instant differs per timezone.
    const instant = new Date('2026-08-15T01:30:00.000Z');
    expect(isWithinActiveWindows(shanghai, instant)).toBe(true);
    expect(isWithinActiveWindows(ruleOf({ windows: [DAY_WINDOW] }), instant)).toBe(false);
  });

  test('matches mentions, bot replies, and keywords in priority order', () => {
    const keywords = ['塑料碗'];
    const bot = BOT_IDENTITY;
    expect(matchTriggerKind(groupMessage(1, 10, mentionText()).message as Message, bot, keywords)).toBe('mention');
    expect(
      matchTriggerKind(
        groupMessage(2, 11, {
          text: 'hi',
          entities: [
            { type: 'text_mention', offset: 0, length: 2, user: { id: BOT_ID, is_bot: true, first_name: 'Wan' } },
          ],
        }).message as Message,
        bot,
        keywords,
      ),
    ).toBe('mention');
    expect(matchTriggerKind(groupMessage(3, 12, replyFields(BOT_ID, true)).message as Message, bot, keywords)).toBe(
      'reply_to_bot',
    );
    expect(matchTriggerKind(groupMessage(4, 13, { text: 'hey 塑料碗' }).message as Message, bot, keywords)).toBe(
      'keyword',
    );
    // A reply to a human is not a trigger, and neither is a keyword-free message.
    expect(matchTriggerKind(groupMessage(5, 14, replyFields(43, false)).message as Message, bot, keywords)).toBeNull();
    expect(
      matchTriggerKind(groupMessage(6, 15, { text: 'just chatting' }).message as Message, bot, keywords),
    ).toBeNull();
  });

  test('matches keywords against captions and ignores case', () => {
    const caption = groupMessage(1, 10, {
      caption: 'look at this WAN',
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10, file_size: 100 }],
    });
    expect(matchTriggerKind(caption.message as Message, BOT_IDENTITY, ['wan'])).toBe('keyword');
    expect(
      matchTriggerKind(groupMessage(2, 11, { text: 'hi @plasticwanbot' }).message as Message, BOT_IDENTITY, []),
    ).toBeNull();
  });

  test('lower-cases and de-duplicates merged keywords', () => {
    const rule = compileParticipation({
      global: { trigger_keywords: ['Wan', 'wan'] },
      chat: { trigger_keywords: ['塑料碗'] },
      timezone: 'UTC',
    });
    expect(rule?.keywords).toEqual(['wan', '塑料碗']);
    expect(rule?.windowSeconds).toBe(300);
  });

  test('replaces windows per chat while appending keywords', () => {
    const merged = compileParticipation({
      global: { active_windows: [DAY_WINDOW], trigger_keywords: ['global'], attention_window_seconds: 120 },
      chat: { active_windows: [], trigger_keywords: ['local'] },
      timezone: 'UTC',
    });
    expect(merged?.windows).toEqual([]);
    expect(merged?.keywords).toEqual(['global', 'local']);
    expect(merged?.windowSeconds).toBe(120);
    expect(
      compileParticipation({ global: { attention_window_seconds: 60 }, chat: undefined, timezone: 'UTC' })
        ?.windowSeconds,
    ).toBe(60);
    expect(compileParticipation({ global: undefined, chat: undefined, timezone: 'UTC' })).toBeUndefined();
  });
});

describe('participation configuration', () => {
  async function configError(transform: (config: FileConfig) => void): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-participation-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
    try {
      await loadConfig(configPath);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected loadConfig to reject the configuration');
  }

  test('rejects a zero-length active window', async () => {
    const message = await configError((config) => {
      config.telegram.participation = { active_windows: [{ start: '09:00', end: '09:00' }] };
    });
    expect(message).toContain('empty active window');
  });

  test('rejects participation on a private chat', async () => {
    const message = await configError((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected the default chat');
      }
      chat.participation = { trigger_keywords: ['塑料碗'] };
    });
    expect(message).toContain('private chat');
  });

  test('rejects malformed clock times, weekdays, and empty keywords', async () => {
    expect(
      await configError((config) => {
        config.telegram.participation = { active_windows: [{ start: '9:00', end: '12:00' }] };
      }),
    ).toContain('Invalid config');
    expect(
      await configError((config) => {
        config.telegram.participation = { active_windows: [{ start: '09:00', end: '12:00', days: [0] }] };
      }),
    ).toContain('Invalid config');
    expect(
      await configError((config) => {
        config.telegram.participation = { trigger_keywords: [''] };
      }),
    ).toContain('Invalid config');
    expect(
      await configError((config) => {
        config.telegram.participation = { attention_window_seconds: 0 };
      }),
    ).toContain('Invalid config');
  });

  test('accepts empty window and keyword lists', async () => {
    const harness = await setup({ global: { active_windows: [], trigger_keywords: [] } });
    expect(harness.config.telegram.participation?.active_windows).toEqual([]);
    harness.store.close();
  });
});

describe('participation gate', () => {
  test('keeps the unrestricted behavior when no participation is configured', async () => {
    const { store, ingestion } = await setup();
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'hello' }), OUTSIDE_PERIOD).bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(1n);
    store.close();
  });

  test('stores a quiet message without opening a bucket or a window', async () => {
    const { store, ingestion } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    const result = ingestion.ingest(groupMessage(1, 10, { text: 'quiet' }), OUTSIDE_PERIOD);
    expect(result.messageId).toBeDefined();
    expect(result.bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(0n);
    expect(attention(store)).toBeNull();
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('opens a bucket and a window for each trigger kind', async () => {
    const cases: readonly { readonly name: string; readonly fields: LooseFields; readonly kind: string }[] = [
      { name: 'mention', fields: mentionText(), kind: 'mention' },
      { name: 'reply to the bot', fields: replyFields(BOT_ID, true), kind: 'reply_to_bot' },
      { name: 'keyword in text', fields: { text: 'hey 塑料碗' }, kind: 'keyword' },
      {
        name: 'keyword in a caption',
        fields: {
          caption: '塑料碗 look',
          photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10, file_size: 100 }],
        },
        kind: 'keyword',
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const { store, ingestion } = await setup({
        global: { active_windows: [DAY_WINDOW], trigger_keywords: ['塑料碗'] },
      });
      const result = ingestion.ingest(groupMessage(index + 1, 10, entry.fields), OUTSIDE_PERIOD);
      expect(`${entry.name}:${String(result.bucketId !== undefined)}`).toBe(`${entry.name}:true`);
      expect(bucketCount(store)).toBe(1n);
      expect(attention(store)).toEqual({
        expiresAt: '2026-08-15T13:05:00.000Z',
        triggerKind: entry.kind,
      });
      store.close();
    }
  });

  test('keeps triggering inside the window and resets it on a new trigger', async () => {
    const { store, ingestion, scheduler } = await setup({
      global: { active_windows: [DAY_WINDOW], trigger_keywords: ['塑料碗'], attention_window_seconds: 300 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:05:00.000Z');
    // Let the scheduler claim the first bucket so the next message can open one.
    scheduler.processDue(new Date('2026-08-15T13:00:20.000Z'));
    expect(bucketCount(store)).toBe(1n);
    const inside = ingestion.ingest(groupMessage(2, 11, { text: 'still here' }), new Date('2026-08-15T13:01:00.000Z'));
    expect(inside.bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(2n);
    // A trigger inside the window pushes the expiry out.
    ingestion.ingest(groupMessage(3, 12, { text: 'hey 塑料碗' }), new Date('2026-08-15T13:02:00.000Z'));
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:07:00.000Z');
    store.close();
  });

  test('goes quiet once the window lapses and reopens on the next trigger', async () => {
    const { store, ingestion, scheduler } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 60 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    scheduler.processDue(new Date('2026-08-15T13:00:20.000Z'));
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:01:00.000Z');
    const late = ingestion.ingest(groupMessage(2, 11, { text: 'quiet again' }), new Date('2026-08-15T13:02:00.000Z'));
    expect(late.bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(1n);
    ingestion.ingest(groupMessage(3, 12, mentionText()), new Date('2026-08-15T13:02:00.000Z'));
    expect(bucketCount(store)).toBe(2n);
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:03:00.000Z');
    store.close();
  });

  test('treats every message as triggering inside an active period', async () => {
    const { store, ingestion } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'good morning' }), INSIDE_PERIOD).bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(1n);
    // The schedule alone is enough, so no window is recorded for later.
    expect(attention(store)).toBeNull();
    store.close();
  });

  test('lets a suppressed message join a collecting bucket', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 1 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    // The window has lapsed, but the first bucket is still collecting.
    ingestion.ingest(groupMessage(2, 11, { text: 'quiet companion' }), new Date('2026-08-15T13:00:05.000Z'));
    expect(bucketCount(store)).toBe(1n);
    expect(bucketMessages(store)).toBe(2n);
    store.close();
  });

  test('re-renders a message that was suppressed while the transcript already exists', async () => {
    const { store, config, ingestion, scheduler } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 60 },
    });
    // First run: a mention opens a bucket and the invocation seeds the context.
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    const [first] = scheduler.processDue(new Date('2026-08-15T13:00:20.000Z'));
    if (first === undefined) {
      throw new Error('Expected the first invocation');
    }
    const conversationId = store.db
      .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(first)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    const contexts = new ConversationContextStore(store);
    const stable = new ContextBuilder(
      store,
      new ContextRefStore(store, { ttlHours: config.agent.context.ref_ttl_hours }),
    ).buildSystemPrompt(
      config,
      {
        invocationId: first,
        conversationId,
        chatId: BigInt(GROUP_CHAT_ID),
        threadId: 0n,
        chatType: 'supergroup',
        bucketKind: 'realtime',
        completion: null,
        timezone: config.timezone,
      },
      false,
      { provider: config.agent.provider, model: config.agent.model },
    );
    contexts.open(conversationId, stable.systemPromptHash);
    store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
    store.db
      .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(first);

    // The window lapses, so this message never opens a bucket on its own.
    const suppressed = ingestion.ingest(
      groupMessage(2, 11, { text: 'quiet words' }),
      new Date('2026-08-15T13:05:00.000Z'),
    );
    expect(suppressed.bucketId).toBeUndefined();

    // A later trigger opens a bucket whose history section carries it. Because
    // the transcript does not hold it, the next injection still has to render
    // it — otherwise the model would never learn that it was said.
    ingestion.ingest(groupMessage(3, 12, mentionText()), new Date('2026-08-15T13:06:00.000Z'));
    const [second] = scheduler.processDue(new Date('2026-08-15T13:06:20.000Z'));
    if (second === undefined) {
      throw new Error('Expected the second invocation');
    }
    const context = renderInvocationContext(store, config, second, { contextWindow: 200_000, maxOutputTokens: 32_768 });
    expect(context.userPrompt).toContain('quiet words');
    expect(context.userPrompt).toContain('<untrusted_telegram_history>');
    store.close();
  });

  test('never records attention for an edited message', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 60 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:01:00.000Z');
    const result = ingestion.ingest(
      editedGroupMessage(2, 10, 1_700_000_030, mentionText()),
      new Date('2026-08-15T13:05:00.000Z'),
    );
    expect(result.bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(1n);
    // The window is neither refreshed nor replaced by the edit.
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:01:00.000Z');
    expect(
      store.db
        .prepare<[], { count: bigint }>(
          'SELECT COUNT(*) AS count FROM message_revisions WHERE message_id = (SELECT id FROM messages WHERE telegram_message_id = 10)',
        )
        .get()?.count,
    ).toBe(2n);
    store.close();
  });

  test('never gates a private chat', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW] },
      chatId: PRIVATE_CHAT_ID,
    });
    expect(ingestion.ingest(privateMessage(1, 10, 'hi there'), OUTSIDE_PERIOD).bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(1n);
    expect(attention(store)).toBeNull();
    store.close();
  });

  test('honours a per-chat schedule that overrides the global one', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW] },
      chat: { active_windows: [] },
      timezone: 'UTC',
    });
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'quiet' }), INSIDE_PERIOD).bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(0n);
    store.close();
  });
});

describe('startup catch-up participation', () => {
  function fakeApi(updates: readonly Update[]): StartupCatchUpApi {
    return {
      getUpdates: async (options) =>
        updates
          .filter((update) => options.offset === undefined || update.update_id >= options.offset)
          .slice(0, options.limit),
    };
  }

  const catchUpAt = new Date('2026-08-15T13:00:10.000Z');

  test('skips a quiet chat without starting an invocation', async () => {
    const { store, ingestion, scheduler, commands } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    const result = await runStartupCatchUp({
      api: fakeApi([groupMessage(1, 10, { text: 'while down' })]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: () => catchUpAt,
    });
    expect(result.invocationIds).toHaveLength(0);
    expect(
      store.db.prepare<[], { state: string; error_code: string }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'skipped_budget', error_code: 'participation_gated' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(0n);
    store.close();
  });

  test('resumes a chat whose attention window a catch-up mention refreshed', async () => {
    const { store, ingestion, scheduler, commands } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    const result = await runStartupCatchUp({
      api: fakeApi([groupMessage(1, 10, mentionText())]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: () => catchUpAt,
    });
    expect(result.invocationIds).toHaveLength(1);
    expect(attention(store)).toEqual({ expiresAt: '2026-08-15T13:05:10.000Z', triggerKind: 'mention' });
    expect(store.db.prepare<[], { kind: string; state: string }>('SELECT kind, state FROM buckets').get()).toEqual({
      kind: 'startup_catch_up',
      state: 'queued',
    });
    store.close();
  });
});

describe('participation retention', () => {
  test('deletes expired windows and keeps open ones', async () => {
    const { store, config, ingestion } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    purgeExpiredData(store.orm, config, OUTSIDE_PERIOD);
    expect(attention(store)).not.toBeNull();
    purgeExpiredData(store.orm, config, new Date('2026-08-15T13:05:00.000Z'));
    expect(attention(store)).toBeNull();
    store.close();
  });
});
