import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { buildSceneContext, type SceneContextOptions } from '../src/context/scene-context.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { attachBucketToInvocation } from '../src/orchestration/invocation-queue.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { type FileConfig, loadConfig, type RawConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  appState,
  conversationContextCutoffs,
  invocationMessages,
  media,
  messageRevisions,
  messages,
  senders,
} from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

const GROUP_CHAT = 111000111n;
const FORUM_CHAT = 222000222n;
const TOPIC_A = 100n;
const TOPIC_B = 200n;
const BOT_ID = 999n;
const BOT_USERNAME = 'plasticwan_test';
const START = new Date('2026-08-15T00:00:00.000Z');
const DEFAULT_OPTIONS: SceneContextOptions = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  toolDefinitionCharacters: 0,
};

interface Person {
  readonly id: number;
  readonly name: string;
  readonly username: string;
}

const ALICE: Person = { id: 42, name: 'Alice', username: 'alice' };
const BOB: Person = { id: 77, name: 'Bob', username: 'bob' };

const at = (seconds: number): Date => new Date(START.getTime() + seconds * 1_000);

interface Fixture {
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
  readonly configStore: RuntimeConfigurationStore;
  readonly store: SqliteStore;
  readonly scheduler: BucketScheduler;
  readonly ingestion: TelegramIngestion;
}

async function setup(tune?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-scene-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('fixture: expected the default chat');
      }
      chat.id = Number(GROUP_CHAT);
      config.telegram.chats.push({
        id: Number(FORUM_CHAT),
        topic_ids: [Number(TOPIC_A), Number(TOPIC_B)],
        instructions_file: 'chat-instructions.md',
      });
      tune?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const ingestion = new TelegramIngestion(store, configStore, { id: Number(BOT_ID), username: BOT_USERNAME });
  return { loaded, configStore, store, scheduler, ingestion };
}

interface MessageOptions {
  readonly chatId?: bigint;
  readonly from?: Person;
  readonly replyTo?: { readonly messageId: number; readonly text: string; readonly from?: Person };
}

function telegramMessage(chatId: bigint, messageId: number, seconds: number, from: Person): Record<string, unknown> {
  return {
    message_id: messageId,
    date: Math.floor(at(seconds).getTime() / 1_000),
    chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
    from: { id: from.id, is_bot: false, first_name: from.name, username: from.username },
  };
}

function groupUpdate(
  updateId: number,
  messageId: number,
  text: string,
  seconds: number,
  options: MessageOptions = {},
): Update {
  const chatId = options.chatId ?? GROUP_CHAT;
  const from = options.from ?? ALICE;
  const message: Record<string, unknown> = { ...telegramMessage(chatId, messageId, seconds, from), text };
  if (options.replyTo !== undefined) {
    const replyFrom = options.replyTo.from ?? ALICE;
    message.reply_to_message = {
      ...telegramMessage(chatId, options.replyTo.messageId, seconds, replyFrom),
      text: options.replyTo.text,
    };
  }
  return { update_id: updateId, message } as unknown as Update;
}

function editUpdate(
  updateId: number,
  messageId: number,
  text: string,
  seconds: number,
  options: MessageOptions = {},
): Update {
  const chatId = options.chatId ?? GROUP_CHAT;
  const from = options.from ?? ALICE;
  return {
    update_id: updateId,
    edited_message: { ...telegramMessage(chatId, messageId, seconds, from), text },
  } as unknown as Update;
}

function forumUpdate(updateId: number, messageId: number, text: string, threadId: bigint, seconds: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(at(seconds).getTime() / 1_000),
      chat: { id: Number(FORUM_CHAT), type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: ALICE.id, is_bot: false, first_name: ALICE.name, username: ALICE.username },
      message_thread_id: Number(threadId),
      is_topic_message: true,
      text,
    },
  } as Update;
}

function photoUpdate(updateId: number, messageId: number, caption: string, seconds: number): Update {
  return {
    update_id: updateId,
    message: {
      ...telegramMessage(GROUP_CHAT, messageId, seconds, ALICE),
      caption,
      photo: [{ file_id: `file-${messageId}`, file_unique_id: `unique-${messageId}`, width: 800, height: 600 }],
    },
  } as unknown as Update;
}

function conversationIdOf(store: SqliteStore, chatId: bigint, threadId: bigint): bigint {
  const row = store.orm
    .all<{ id: bigint }>(
      sql`SELECT v.id FROM conversations v JOIN chats c ON c.id = v.chat_id
          WHERE c.telegram_chat_id = ${chatId} AND v.message_thread_id = ${threadId}`,
    )
    .at(0);
  if (row === undefined) {
    throw new Error(`fixture: no conversation for chat ${chatId} thread ${threadId}`);
  }
  return row.id;
}

function latestInvocation(store: SqliteStore, conversationId: bigint): bigint {
  const row = store.orm
    .all<{ id: bigint }>(
      sql`SELECT id FROM invocations WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT 1`,
    )
    .at(0);
  if (row === undefined) {
    throw new Error('fixture: no invocation was queued');
  }
  return row.id;
}

/**
 * Queues every due bucket and completes its invocation immediately, so the
 * next batch of the same chat can open its own invocation (a queued invocation
 * blocks further queuing by design).
 */
function flush(fixture: Fixture, seconds: number): void {
  const { store, scheduler } = fixture;
  for (const invocationId of scheduler.processDue(at(seconds))) {
    store.db
      .prepare("UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ? WHERE id = ?")
      .run(at(seconds - 1).toISOString(), at(seconds).toISOString(), invocationId);
    store.db
      .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(invocationId);
  }
}

function invocationBucket(store: SqliteStore, invocationId: bigint): bigint {
  const row = store.orm
    .all<{ bucket_id: bigint }>(sql`SELECT bucket_id FROM invocations WHERE id = ${invocationId}`)
    .at(0);
  if (row === undefined) {
    throw new Error('fixture: invocation has no bucket');
  }
  return row.bucket_id;
}

/** The chat's internal row ID, as `messages` references it. */
function chatRowId(store: SqliteStore, chatId: bigint): bigint {
  const row = store.orm.all<{ id: bigint }>(sql`SELECT id FROM chats WHERE telegram_chat_id = ${chatId}`).at(0);
  if (row === undefined) {
    throw new Error(`fixture: chat ${chatId} was never stored`);
  }
  return row.id;
}

/** Inserts a stored message the way a send or a fixture would; no bucket, no snapshot. */
function insertRawMessage(
  fixture: Fixture,
  input: {
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly telegramMessageId: bigint;
    readonly seconds: number;
    readonly text: string | null;
    readonly sentByBot?: boolean;
    /** `null` creates no revision at all; a later date puts the only revision past the cutoff. */
    readonly revisionSeconds?: number | null;
  },
): bigint {
  const { store } = fixture;
  const senderId = input.sentByBot === true ? botSenderId(fixture) : null;
  const receivedAt = at(input.seconds).toISOString();
  const created = store.orm
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      chatId: input.chatId,
      telegramMessageId: input.telegramMessageId,
      visible: true,
      sentByBot: input.sentByBot ?? false,
      telegramDate: receivedAt,
      receivedAt,
    })
    .returning({ id: messages.id })
    .get();
  if (created === undefined) {
    throw new Error('fixture: messages insert returned no row');
  }
  const revisionSeconds = input.revisionSeconds === undefined ? input.seconds : input.revisionSeconds;
  if (revisionSeconds !== null) {
    const revision = store.orm
      .insert(messageRevisions)
      .values({
        messageId: created.id,
        revisionNo: 1n,
        senderId,
        kind: 'text',
        text: input.text,
        caption: null,
        replyToMessageId: null,
        createdAt: at(revisionSeconds).toISOString(),
        rawFragmentJson: '{}',
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('fixture: revision insert returned no row');
    }
    store.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, created.id)).run();
  }
  return created.id;
}

function botSenderId(fixture: Fixture): bigint {
  const { store } = fixture;
  store.orm
    .insert(senders)
    .values({
      telegramType: 'user',
      telegramId: BOT_ID,
      displayName: 'PlasticWan',
      username: BOT_USERNAME,
      isBot: true,
      updatedAt: at(0).toISOString(),
    })
    .onConflictDoNothing()
    .run();
  const row = store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(and(eq(senders.telegramType, 'user'), eq(senders.telegramId, BOT_ID)))
    .get();
  if (row === undefined) {
    throw new Error('fixture: bot sender row is missing');
  }
  return row.id;
}

/** The scene configuration: current `config.jsonc` with an optional test-only mutation. */
function sceneConfig(fixture: Fixture, mutate?: (config: RawConfig) => void): RawConfig {
  const config = structuredClone(fixture.loaded.config);
  mutate?.(config);
  return config;
}

function chatConfigOf(config: RawConfig, chatId: bigint): RawConfig['telegram']['chats'][number] {
  const chat = config.telegram.chats.find((entry) => BigInt(entry.id) === chatId);
  if (chat === undefined) {
    throw new Error(`fixture: chat ${chatId} is not in the configuration`);
  }
  return chat;
}

function invocationMessagesJson(store: SqliteStore, invocationId: bigint): string[] {
  return store.orm
    .all<{ snapshot_json: string }>(
      sql`SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ${invocationId} ORDER BY sequence_no`,
    )
    .map((row) => row.snapshot_json);
}

describe('scene context', () => {
  test('builds a text-only scene from the frozen opening batch and provable history', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'old one', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.cutoffAt).toBe(at(50).toISOString());
    expect(scene.chatId).toBe(GROUP_CHAT);
    expect(scene.threadId).toBe(0n);
    expect(scene.conversationId).toBe(conversationId);
    expect(scene.bucketId).toBe(invocationBucket(store, invocationId));
    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.omittedMessages).toBe(0);
    expect(scene.omittedImages).toBe(0);
    expect(scene.mediaIds).toEqual([]);
    expect(scene.replyMessageIds).toEqual(['10', '11']);
    expect(scene.text.startsWith('<runtime_state>\ncurrent_time: ')).toBe(true);
    expect(scene.text).toContain(' (UTC)');
    expect(scene.text).toContain('<untrusted_telegram_history>');
    expect(scene.text).toContain('[10 00:00:00 uid:42 @alice] Alice\n  old one');
    expect(scene.text).toContain('<untrusted_new_messages>');
    expect(scene.text).toContain('[11 00:00:30 uid:42 @alice] Alice\n  trigger text');
    expect(scene.text).toContain('<memory_list>\n</memory_list>');
    store.close();
  });

  test("keeps only the same conversation's history (topic isolation)", async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(forumUpdate(1, 10, 'topic A old', TOPIC_A, 0), at(0));
    ingestion.ingest(forumUpdate(2, 11, 'topic B old', TOPIC_B, 5), at(5));
    flush(fixture, 30);
    ingestion.ingest(forumUpdate(3, 12, 'topic A trigger', TOPIC_A, 40), at(40));
    flush(fixture, 60);
    const invocationId = latestInvocation(store, conversationIdOf(store, FORUM_CHAT, TOPIC_A));

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.threadId).toBe(TOPIC_A);
    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.text).toContain('  topic A old');
    expect(scene.text).toContain('  topic A trigger');
    expect(scene.text).not.toContain('topic B old');
    store.close();
  });

  test("keeps the bot's old message in history but never its later reply", async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'human words', 0), at(0));
    flush(fixture, 20);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const chatId = chatRowId(store, GROUP_CHAT);
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 20n,
      seconds: 25,
      text: 'bot old words',
      sentByBot: true,
    });
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationId);
    // The actual reply the run produced, ingested long after the batch was frozen.
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 21n,
      seconds: 60,
      text: 'bot answer words',
      sentByBot: true,
    });

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.historyCount).toBe(2);
    expect(scene.messageCount).toBe(3);
    expect(scene.text).toContain('[20 00:00:25 you uid:999 @plasticwan_test] PlasticWan\n  bot old words');
    expect(scene.text).not.toContain('bot answer words');
    store.close();
  });

  test('renders replies like production and lists only reply targets visible in the scene', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'first message', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(
      groupUpdate(2, 11, 'reply inside', 30, { replyTo: { messageId: 10, text: 'first message' } }),
      at(30),
    );
    ingestion.ingest(
      groupUpdate(3, 12, 'reply outside', 31, { replyTo: { messageId: 999, text: 'outside message' } }),
      at(31),
    );
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.messageCount).toBe(3);
    expect(scene.replyMessageIds).toEqual(['10', '11', '12']);
    // The target is itself in the scene, so the stored quote is not repeated.
    expect(scene.text).toContain('re:10');
    expect(scene.text).not.toContain('> Alice: first message');
    // An invisible target keeps its quoted copy but is not claimed as visible.
    expect(scene.text).toContain('re:999');
    expect(scene.text).toContain('> Alice: outside message');
    store.close();
  });

  test('renders the revision that existed at the cutoff, not later edits', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'original words', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    // Both the history message and the trigger are edited after the cutoff.
    ingestion.ingest(editUpdate(3, 10, 'edited words', 60), at(60));
    ingestion.ingest(editUpdate(4, 11, 'edited trigger', 61), at(61));

    const currentRevision = store.orm
      .all<{ revision_no: bigint }>(
        sql`SELECT r.revision_no FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id
            WHERE m.chat_id = ${chatRowId(store, GROUP_CHAT)} AND m.telegram_message_id = 10`,
      )
      .at(0);
    expect(currentRevision?.revision_no).toBe(2n);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.text).toContain('  original words');
    expect(scene.text).not.toContain('edited words');
    expect(scene.text).toContain('  trigger text');
    expect(scene.text).not.toContain('edited trigger');
    store.close();
  });

  test('never leaks a later attached bucket, even when its clock sits before the cutoff', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'opening text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    const attached = ingestion.ingest(groupUpdate(2, 11, 'attached text', 51), at(51)).bucketId;
    if (attached === undefined) {
      throw new Error('fixture: attached message opened no bucket');
    }
    attachBucketToInvocation(
      store,
      fixture.loaded.config.agent.history_messages,
      invocationId,
      attached,
      conversationId,
      at(52),
    );
    // Rewrite the clock so only the opening-batch filter can keep it out.
    const attachedMessage = store.orm
      .all<{ id: bigint }>(
        sql`SELECT id FROM messages WHERE chat_id = ${chatRowId(store, GROUP_CHAT)} AND telegram_message_id = 11`,
      )
      .at(0);
    if (attachedMessage === undefined) {
      throw new Error('fixture: attached message is missing');
    }
    store.orm
      .update(messages)
      .set({ receivedAt: at(40).toISOString() })
      .where(eq(messages.id, attachedMessage.id))
      .run();

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.messageCount).toBe(1);
    expect(scene.text).toContain('  opening text');
    expect(scene.text).not.toContain('attached text');
    expect(invocationMessagesJson(store, invocationId)).toHaveLength(2);
    store.close();
  });

  test('accepts a legacy untagged opening batch only while no other bucket is attached', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'legacy trigger', 0), at(0));
    flush(fixture, 30);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    store.db
      .prepare("UPDATE invocation_messages SET source_bucket_id = NULL WHERE invocation_id = ? AND section = 'new'")
      .run(invocationId);

    const beforeAttach = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(beforeAttach.messageCount).toBe(1);
    expect(beforeAttach.text).toContain('  legacy trigger');

    const attached = ingestion.ingest(groupUpdate(2, 11, 'attached later', 31), at(31)).bucketId;
    if (attached === undefined) {
      throw new Error('fixture: attached message opened no bucket');
    }
    attachBucketToInvocation(
      store,
      fixture.loaded.config.agent.history_messages,
      invocationId,
      attached,
      conversationId,
      at(32),
    );

    expect(() => buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS)).toThrow(
      'opening messages unavailable',
    );
    store.close();
  });

  test('does not retroactively apply current ignored users to retained public messages', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'bob words', 0, { from: BOB }), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'alice trigger', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    const ignoring = sceneConfig(fixture, (config) => {
      chatConfigOf(config, GROUP_CHAT).ignored_user_ids = [BOB.id];
    });

    const scene = buildSceneContext(store, ignoring, invocationId, DEFAULT_OPTIONS);
    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.text).toContain('  alice trigger');
    expect(scene.text).toContain('  bob words');

    ingestion.ingest(groupUpdate(3, 12, 'bob trigger', 55, { from: BOB }), at(55));
    flush(fixture, 75);
    const bobInvocationId = latestInvocation(store, conversationId);
    const bobScene = buildSceneContext(store, ignoring, bobInvocationId, DEFAULT_OPTIONS);
    expect(bobScene.text).toContain('  bob trigger');
    expect(bobScene.text).toContain('  bob words');

    // ignored_user_ids is an ingress decision, not a retroactive history filter.
    const stored = store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM message_revisions WHERE text LIKE 'bob%'")
      .get();
    expect(stored?.count).toBe(2n);
    store.close();
  });

  test('counts history without a provable revision and renders the rest', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'has revision', 0), at(0));
    flush(fixture, 20);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const chatId = chatRowId(store, GROUP_CHAT);
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 50n,
      seconds: 25,
      text: 'no revision at all',
      revisionSeconds: null,
    });
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 51n,
      seconds: 28,
      text: 'revision only after the cutoff',
      revisionSeconds: 55,
    });
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationId);
    // Catch-up/attach can have no history snapshot; force that case so the
    // fallback must prove revisions at the cutoff rather than trust a snapshot.
    store.db
      .prepare("DELETE FROM invocation_messages WHERE invocation_id = ? AND section = 'history'")
      .run(invocationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.omittedMessages).toBe(2);
    expect(scene.text).toContain('  has revision');
    expect(scene.text).not.toContain('no revision at all');
    expect(scene.text).not.toContain('revision only after the cutoff');
    store.close();
  });

  test('trims history to the character budget and keeps the newest messages', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    for (let index = 0; index < 20; index += 1) {
      ingestion.ingest(groupUpdate(1 + index, 10 + index, `history ${index} ${'x'.repeat(80)}`, 0), at(0));
    }
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(30, 40, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, {
      contextWindow: 320,
      maxOutputTokens: 0,
      toolDefinitionCharacters: 0,
    });

    expect(scene.messageCount).toBe(scene.historyCount + 1);
    expect(scene.historyCount).toBeGreaterThanOrEqual(1);
    expect(scene.historyCount).toBeLessThan(20);
    expect(scene.text).toContain(`  history 19 ${'x'.repeat(80)}`);
    expect(scene.text).not.toContain(`  history 0 ${'x'.repeat(80)}`);
    expect(scene.omittedMessages).toBe(20 - scene.historyCount);
    store.close();
  });

  test('respects the conversation cutoff', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'cut old', 0), at(0));
    flush(fixture, 20);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    store.orm
      .insert(conversationContextCutoffs)
      .values({
        conversationId,
        telegramMessageId: 10n,
        createdAt: at(25).toISOString(),
        updatedAt: at(25).toISOString(),
      })
      .run();
    ingestion.ingest(groupUpdate(2, 11, 'after cut', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.historyCount).toBe(0);
    expect(scene.messageCount).toBe(1);
    expect(scene.text).not.toContain('<untrusted_telegram_history>');
    expect(scene.text).not.toContain('cut old');
    expect(scene.text).toContain('  after cut');
    store.close();
  });

  test('marks media as unavailable or missing and reports it without loading bytes', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(photoUpdate(1, 10, 'history photo', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(photoUpdate(2, 11, 'trigger photo', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);

    const first = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(first.omittedImages).toBe(2);
    expect(first.mediaIds).toHaveLength(2);
    expect(first.text.match(/\[photo media_unavailable 800x600\]/g)).toHaveLength(2);
    expect(first.text).toContain('  history photo');
    expect(first.text).toContain('  trigger photo');
    expect(first.text).not.toMatch(/img_|figure_/);

    // The trigger's media row disappears (retention) while its snapshot remains.
    const triggerRevision = store.orm
      .all<{ revision_id: bigint }>(
        sql`SELECT m.current_revision_id AS revision_id FROM messages m
            WHERE m.chat_id = ${chatRowId(store, GROUP_CHAT)} AND m.telegram_message_id = 11`,
      )
      .at(0);
    if (triggerRevision === undefined) {
      throw new Error('fixture: trigger revision is missing');
    }
    store.orm.delete(media).where(eq(media.revisionId, triggerRevision.revision_id)).run();

    const second = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(second.omittedImages).toBe(2);
    expect(second.text.match(/\[photo media_missing 800x600\]/g)).toHaveLength(1);
    expect(second.text.match(/\[photo media_unavailable 800x600\]/g)).toHaveLength(1);
    store.close();
  });

  test('fails fast when the chat or topic is no longer allowed, or the invocation is gone', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(forumUpdate(1, 10, 'topic A', TOPIC_A, 0), at(0));
    flush(fixture, 30);
    const invocationId = latestInvocation(store, conversationIdOf(store, FORUM_CHAT, TOPIC_A));

    const withoutChat = sceneConfig(fixture, (config) => {
      config.telegram.chats = config.telegram.chats.filter((chat) => BigInt(chat.id) !== FORUM_CHAT);
    });
    expect(() => buildSceneContext(store, withoutChat, invocationId, DEFAULT_OPTIONS)).toThrow(
      /chat .* is no longer configured/,
    );

    const withoutTopic = sceneConfig(fixture, (config) => {
      chatConfigOf(config, FORUM_CHAT).topic_ids = [Number(TOPIC_B)];
    });
    expect(() => buildSceneContext(store, withoutTopic, invocationId, DEFAULT_OPTIONS)).toThrow(
      /topic .* is not allowed/,
    );

    expect(() => buildSceneContext(store, fixture.loaded.config, 999_999n, DEFAULT_OPTIONS)).toThrow(
      /invocation 999999 does not exist/,
    );
    store.close();
  });

  test('frozen history wins even when receipt or revision clocks are later than invocation creation', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'frozen history', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
    const frozen = store.orm
      .select()
      .from(invocationMessages)
      .where(and(eq(invocationMessages.invocationId, invocationId), eq(invocationMessages.section, 'history')))
      .get()!;
    store.orm
      .update(messages)
      .set({ receivedAt: at(51).toISOString() })
      .where(eq(messages.id, frozen.messageId))
      .run();
    store.orm
      .update(messageRevisions)
      .set({ createdAt: at(51).toISOString(), text: 'mutable revision changed' })
      .where(eq(messageRevisions.id, frozen.revisionId))
      .run();
    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(scene.historyCount).toBe(1);
    expect(scene.text).toContain('  frozen history');
    expect(scene.text).not.toContain('mutable revision changed');
    store.close();
  });

  test('catch-up without frozen history proves fallback arrivals, edits and trigger ordering', async () => {
    const fixture = await setup();
    const { store, ingestion, scheduler } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'before restart', 0), at(0));
    flush(fixture, 20);
    store.orm
      .insert(appState)
      .values({ key: 'telegram_startup_catch_up', value: at(30).toISOString(), updatedAt: at(30).toISOString() })
      .run();
    ingestion.ingestCatchUp(groupUpdate(2, 20, 'catch-up trigger', 35), at(40));
    const [invocationId] = scheduler.finishStartupCatchUp(at(30), at(50));
    expect(invocationId).toBeDefined();
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const chatId = chatRowId(store, GROUP_CHAT);
    expect(invocationMessagesJson(store, invocationId!)).toHaveLength(1);
    const future = insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 19n,
      seconds: 35,
      text: 'late arrival',
    });
    store.orm
      .update(messages)
      .set({ receivedAt: at(51).toISOString() })
      .where(eq(messages.id, future))
      .run();
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 21n,
      seconds: 35,
      text: 'after trigger ordering',
    });
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 18n,
      seconds: 34,
      revisionSeconds: 51,
      text: 'future revision',
    });
    ingestion.ingest(editUpdate(3, 10, 'later edit', 60), at(60));
    const scene = buildSceneContext(store, fixture.loaded.config, invocationId!, DEFAULT_OPTIONS);
    expect(scene.historyCount).toBe(1);
    expect(scene.omittedMessages).toBe(1);
    expect(scene.text).toContain('  before restart');
    expect(scene.text).toContain('  catch-up trigger');
    expect(scene.text).not.toMatch(/late arrival|after trigger ordering|future revision|later edit/);
    store.close();
  });

  test('image references authorize only rendered retained media from the frozen revision', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(photoUpdate(1, 10, `old photo ${'x'.repeat(1_024)}`, 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(photoUpdate(2, 11, 'trigger photo', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
    const options = { ...DEFAULT_OPTIONS, supportsImages: true };
    const before = store.db.prepare('SELECT * FROM context_refs').all();
    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, options);
    expect(scene.mediaRefs.size).toBe(2);
    expect(scene.omittedImages).toBe(0);
    expect([...scene.mediaRefs.keys()].every((ref) => scene.text.includes(ref))).toBe(true);
    const trimmed = buildSceneContext(store, fixture.loaded.config, invocationId, {
      ...options,
      contextWindow: 256,
      maxOutputTokens: 0,
      toolDefinitionCharacters: 0,
    });
    expect(trimmed.mediaRefs.size).toBe(1);
    expect(trimmed.historyCount).toBe(0);
    expect(trimmed.omittedMessages).toBe(1);
    expect(trimmed.text).not.toContain('old photo');
    expect([...trimmed.mediaRefs.keys()].every((ref) => trimmed.text.includes(ref))).toBe(true);
    const rows = store.orm
      .select()
      .from(invocationMessages)
      .where(eq(invocationMessages.invocationId, invocationId))
      .orderBy(invocationMessages.sequenceNo)
      .all();
    const opening = rows.at(-1)!;
    const history = rows[0]!;
    const openingSnapshot = JSON.parse(opening.snapshotJson);
    const historySnapshot = JSON.parse(history.snapshotJson);
    openingSnapshot.media[0].id = historySnapshot.media[0].id;
    store.orm
      .update(invocationMessages)
      .set({ snapshotJson: JSON.stringify(openingSnapshot) })
      .where(
        and(eq(invocationMessages.invocationId, invocationId), eq(invocationMessages.messageId, opening.messageId)),
      )
      .run();
    const forged = buildSceneContext(store, fixture.loaded.config, invocationId, options);
    expect(forged.mediaRefs.size).toBe(1);
    expect(forged.omittedImages).toBe(1);
    expect(forged.text).toContain('media_missing');
    expect(store.db.prepare('SELECT * FROM context_refs').all()).toEqual(before);
    store.close();
  });

  test.each(['new', 'history'])(
    'rejects %s media when its frozen revision belongs to another message',
    async (section) => {
      const fixture = await setup();
      const { store, ingestion } = fixture;
      try {
        ingestion.ingest(photoUpdate(1, 10, 'history photo', 0), at(0));
        flush(fixture, 20);
        ingestion.ingest(photoUpdate(2, 11, 'trigger photo', 30), at(30));
        flush(fixture, 50);
        const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
        const rows = store.orm
          .select()
          .from(invocationMessages)
          .where(eq(invocationMessages.invocationId, invocationId))
          .all();
        const target = rows.find((row) => row.section === section)!;
        const other = rows.find((row) => row.section !== section)!;
        const snapshot = JSON.parse(target.snapshotJson);
        snapshot.media = JSON.parse(other.snapshotJson).media;
        store.orm
          .update(invocationMessages)
          .set({ revisionId: other.revisionId, snapshotJson: JSON.stringify(snapshot) })
          .where(
            and(
              eq(invocationMessages.invocationId, invocationId),
              eq(invocationMessages.sequenceNo, target.sequenceNo),
            ),
          )
          .run();
        const before = store.db.prepare('SELECT * FROM invocation_messages').all();
        expect(() =>
          buildSceneContext(store, fixture.loaded.config, invocationId, { ...DEFAULT_OPTIONS, supportsImages: true }),
        ).toThrow(/Scene context:.*snapshot/);
        expect(store.db.prepare('SELECT * FROM invocation_messages').all()).toEqual(before);
        expect(store.db.prepare('SELECT * FROM context_refs').all()).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  test('writes nothing and is deterministic', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'old one', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));

    const tables = [
      'messages',
      'message_revisions',
      'media',
      'invocations',
      'invocation_messages',
      'invocation_buckets',
      'buckets',
      'bucket_messages',
      'senders',
      'conversation_context_cutoffs',
      'conversation_contexts',
      'context_messages',
      'context_refs',
      'memories',
    ];
    const counts = (): Record<string, number> =>
      Object.fromEntries(
        tables.map((table) => {
          const row = store.db.prepare<[], { count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
          return [table, Number(row?.count ?? -1n)] as const;
        }),
      );

    const before = counts();
    const first = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    const second = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    const after = counts();

    expect(after).toEqual(before);
    expect(after.context_refs).toBe(0);
    expect(after.context_messages).toBe(0);
    expect(after.conversation_contexts).toBe(0);
    expect(first.text).toBe(second.text);
    store.close();
  });

  test('treats the cutoff as inclusive and lets options.now drive the rendering clock', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    const chatId = chatRowId(store, GROUP_CHAT);
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 8n,
      seconds: 25,
      revisionSeconds: 50,
      text: 'boundary in',
    });
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 9n,
      seconds: 25,
      revisionSeconds: 50,
      text: 'boundary out',
    });
    store.orm
      .update(messages)
      .set({ receivedAt: new Date(at(50).getTime() + 1).toISOString() })
      .where(eq(messages.telegramMessageId, 9n))
      .run();

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(scene.text).toContain('  boundary in');
    expect(scene.text).not.toContain('boundary out');

    const nextDay = new Date(START.getTime() + 86_400_000);
    const rendered = buildSceneContext(store, fixture.loaded.config, invocationId, {
      ...DEFAULT_OPTIONS,
      now: nextDay,
    });
    expect(rendered.cutoffAt).toBe(at(50).toISOString());
    expect(rendered.text).toContain('August 16, 2026');
    expect(rendered.text).toContain('[10 2026-08-15T00:00:30 uid:42 @alice] Alice');
    store.close();
  });
});
