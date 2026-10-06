import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import {
  buildSceneContext,
  type SceneContext,
  type SceneContextOptions,
  SceneSliceError,
} from '../src/context/scene-context.ts';
import { loadConfig, type RawConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  buckets,
  contextRefs,
  conversationContextCutoffs,
  conversations,
  invocationBuckets,
  invocationMessages,
  media,
  messageRevisions,
  messages,
  senders,
  telegramSends,
  toolCalls,
} from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { writeTestConfig } from './helpers.ts';

/**
 * Bot-send slices: `buildSceneContext` with `beforeSendId` rebuilds only the
 * frozen public input that provably sat between the previous bot message and
 * one successful send of the invocation. These synthetic tests pin that
 * contract — the window, the eligible frozen batches, media/reply isolation and
 * the read-only guarantee — on top of `seedAdminFixture` (its chat,
 * conversation, invocations and send rows) plus rows written here.
 *
 * The Admin seed stores abbreviated snapshots for its rendering pages, while
 * every executed query reads the full writer shape; the seeded frozen rows are
 * therefore replaced by snapshots built from real message / revision / media
 * rows, mirroring `src/store/invocation-snapshot.ts`. Nothing here touches
 * Telegram, a provider or the network.
 */

const CHAT = 1_001n;
const CONVERSATION = 2_001n;
const OTHER_CONVERSATION = 2_002n;
const OPENING_BUCKET = 3_001n;
const INVOCATION = 4_001n;
const OTHER_INVOCATION = 4_002n;
const ALICE = 5_001n;
const BOT_SENDER = 5_002n;
const MESSAGE_HISTORY = 6_001n; // telegram 900, photo, frozen as history
const MESSAGE_OPENING = 6_002n; // telegram 901, text, the frozen trigger
const MESSAGE_ANSWER = 6_003n; // telegram 902, the bot's recorded answer to the slice target
const REVISION_A1 = 6_101n; // photo "first caption", owns the retained media row
const REVISION_A2 = 6_102n; // photo "edited caption", current revision of 900
const REVISION_B1 = 6_103n; // text, the frozen snapshot of 901 (reply to 900)
const REVISION_B2 = 6_104n; // later edit of 901, created after the send started
const REVISION_ANSWER = 6_105n; // the send's own recorded answer
const REVISION_REFRESH = 6_106n; // a second, newer freeze of 901
const MEDIA_PHOTO = 6_201n;
const SEND = 8_101n; // seed send -> telegram 902, created 08:00:03
const SECOND_SEND = 8_102n;
const OTHER_SEND = 8_103n;
const WRONG_CONVERSATION_SEND = 8_105n;
const FAILED_SEND = 8_106n;
const NO_MESSAGE_SEND = 8_107n;
const TARGET_ANSWER = 'the original bot answer';
const OUTSIDE_QUOTE = 'old answer outside window';

/** Seconds after 07:59:00Z on the fixture day; the send is created at 08:00:03 (at(63)). */
const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 10, 7, 59, 0) + seconds * 1_000).toISOString();

interface Fixture {
  readonly config: RawConfig;
  readonly store: SqliteStore;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-scene-slice-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  seedAdminFixture(store);

  // The Admin seed predates the slice contract: its freeze clocks run past the
  // send (which would make its rows unprovable) and its reply copy is not the
  // shape the renderer reads. Fix both before any build.
  store.orm
    .insert(senders)
    .values({
      id: BOT_SENDER,
      telegramType: 'user',
      telegramId: 999n,
      displayName: 'PlasticWan',
      username: 'plasticwan_test',
      isBot: true,
      updatedAt: at(30),
    })
    .run();
  store.orm
    .update(messages)
    .set({ receivedAt: at(30) })
    .where(eq(messages.id, MESSAGE_HISTORY))
    .run();
  store.orm
    .update(messages)
    .set({ telegramDate: at(55), receivedAt: at(55) })
    .where(eq(messages.id, MESSAGE_OPENING))
    .run();
  store.orm
    .update(messageRevisions)
    .set({ createdAt: at(55), replySnapshotJson: JSON.stringify({ sender: 'Bot', content: OUTSIDE_QUOTE }) })
    .where(eq(messageRevisions.id, REVISION_B1))
    .run();
  // The selected send's request start is the slice cutoff; delivery finished later.
  store.orm
    .update(telegramSends)
    .set({ finishedAt: at(65) })
    .where(eq(telegramSends.id, SEND))
    .run();
  // Production records the answered message too; it must never enter its own slice.
  insertMessage(store, {
    id: MESSAGE_ANSWER,
    revisionId: REVISION_ANSWER,
    telegramMessageId: 902n,
    at: at(63),
    text: TARGET_ANSWER,
    sentByBot: true,
  });

  store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  freeze(store, {
    messageId: MESSAGE_HISTORY,
    revisionId: REVISION_A2,
    section: 'history',
    sequenceNo: 1n,
    sourceBucketId: null,
  });
  freeze(store, {
    messageId: MESSAGE_OPENING,
    revisionId: REVISION_B1,
    section: 'new',
    sequenceNo: 2n,
    sourceBucketId: OPENING_BUCKET,
  });
  return { config: loaded.config, store };
}

interface MessageInput {
  readonly id: bigint;
  /** `null` stores no revision at all (a bare bot-owned row, for example). */
  readonly revisionId: bigint | null;
  readonly telegramMessageId: bigint;
  readonly at: string;
  readonly text?: string | null;
  readonly kind?: string;
  readonly caption?: string | null;
  readonly sentByBot?: boolean;
  readonly visible?: boolean;
  readonly receivedAt?: string;
  readonly replyToMessageId?: bigint | null;
  readonly conversationId?: bigint;
}

/** Inserts one stored message plus its revision, the way ingress or a send records them. */
function insertMessage(store: SqliteStore, input: MessageInput): void {
  const sentByBot = input.sentByBot ?? false;
  store.orm
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId ?? CONVERSATION,
      chatId: CHAT,
      telegramMessageId: input.telegramMessageId,
      visible: input.visible ?? true,
      sentByBot,
      telegramDate: input.at,
      receivedAt: input.receivedAt ?? input.at,
    })
    .run();
  if (input.revisionId === null) {
    return;
  }
  store.orm
    .insert(messageRevisions)
    .values({
      id: input.revisionId,
      messageId: input.id,
      revisionNo: 1n,
      senderId: sentByBot ? BOT_SENDER : ALICE,
      kind: input.kind ?? 'text',
      text: input.text ?? null,
      caption: input.caption ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: input.at,
      rawFragmentJson: '{}',
    })
    .run();
  store.orm.update(messages).set({ currentRevisionId: input.revisionId }).where(eq(messages.id, input.id)).run();
}

interface FreezeInput {
  readonly messageId: bigint;
  readonly revisionId: bigint;
  readonly sequenceNo: bigint;
  readonly section?: 'history' | 'new';
  readonly sourceBucketId?: bigint | null;
}

/** Freezes one message into an invocation exactly like the production writer does. */
function freeze(store: SqliteStore, input: FreezeInput): void {
  store.orm
    .insert(invocationMessages)
    .values({
      invocationId: INVOCATION,
      messageId: input.messageId,
      revisionId: input.revisionId,
      section: input.section ?? 'new',
      sequenceNo: input.sequenceNo,
      sourceBucketId: input.sourceBucketId ?? null,
      snapshotJson: snapshotFor(store, input.messageId, input.revisionId),
    })
    .run();
}

/** Re-freezes an existing row at another revision, for fixtures that start elsewhere. */
function setFrozenRevision(store: SqliteStore, messageId: bigint, revisionId: bigint): void {
  store.orm
    .update(invocationMessages)
    .set({ revisionId, snapshotJson: snapshotFor(store, messageId, revisionId) })
    .where(and(eq(invocationMessages.invocationId, INVOCATION), eq(invocationMessages.messageId, messageId)))
    .run();
}

/**
 * The full stored snapshot shape (`src/store/invocation-snapshot.ts`), rebuilt
 * from the real message, revision, sender and media rows.
 */
function snapshotFor(store: SqliteStore, messageId: bigint, revisionId: bigint): string {
  const row = store.orm
    .all<{
      telegram_message_id: bigint;
      telegram_date: string;
      sent_by_bot: bigint;
      message_thread_id: bigint;
      revision_no: bigint;
      kind: string;
      text: string | null;
      caption: string | null;
      reply_to_message_id: bigint | null;
      reply_snapshot_json: string | null;
      forward_origin_json: string | null;
      media_group_id: string | null;
      sender_telegram_id: bigint | null;
      sender_display_name: string | null;
      sender_username: string | null;
    }>(
      sql`SELECT m.telegram_message_id, m.telegram_date, m.sent_by_bot, v.message_thread_id,
                 r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
                 r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
                 s.display_name AS sender_display_name, s.username AS sender_username
          FROM messages m
          JOIN conversations v ON v.id = m.conversation_id
          JOIN message_revisions r ON r.id = ${revisionId} AND r.message_id = m.id
          LEFT JOIN senders s ON s.id = r.sender_id
          WHERE m.id = ${messageId}`,
    )
    .at(0);
  if (row === undefined) {
    throw new Error('fixture: message revision is missing');
  }
  const mediaRows = store.orm
    .select({
      id: media.id,
      kind: media.kind,
      fileUniqueId: media.fileUniqueId,
      mimeType: media.mimeType,
      width: media.width,
      height: media.height,
    })
    .from(media)
    .where(eq(media.revisionId, revisionId))
    .orderBy(media.id)
    .all();
  return JSON.stringify({
    message_id: row.telegram_message_id.toString(),
    message_thread_id: row.message_thread_id.toString(),
    telegram_date: row.telegram_date,
    sent_by_bot: row.sent_by_bot === 1n,
    revision: row.revision_no.toString(),
    sender: {
      id: row.sender_telegram_id?.toString() ?? null,
      name: row.sender_display_name,
      username: row.sender_username,
    },
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    reply_to_message_id: row.reply_to_message_id?.toString() ?? null,
    reply_snapshot: row.reply_snapshot_json === null ? null : JSON.parse(row.reply_snapshot_json),
    forward_origin: row.forward_origin_json === null ? null : JSON.parse(row.forward_origin_json),
    media_group_id: row.media_group_id,
    media: mediaRows.map((entry) => ({
      id: entry.id.toString(),
      kind: entry.kind,
      file_unique_id: entry.fileUniqueId,
      mime_type: entry.mimeType,
      width: entry.width?.toString() ?? null,
      height: entry.height?.toString() ?? null,
    })),
  });
}

interface SendInput {
  readonly id: bigint;
  readonly toolCallId: bigint;
  readonly callId: string;
  readonly invocationId: bigint;
  readonly telegramMessageId: bigint | null;
  readonly createdAt: string;
  readonly conversationId?: bigint;
  readonly state?: string;
}

/** Inserts a `send` tool call and its telegram_sends row. */
function insertSend(store: SqliteStore, input: SendInput): void {
  store.orm
    .insert(toolCalls)
    .values({
      id: input.toolCallId,
      invocationId: input.invocationId,
      toolCallId: input.callId,
      toolName: 'send',
      argumentsJson: '{}',
      resultText: 'sent',
      state: 'success',
      sideEffect: true,
      errorCode: null,
      durationMs: 1n,
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    })
    .run();
  store.orm
    .insert(telegramSends)
    .values({
      id: input.id,
      toolCallId: input.toolCallId,
      conversationId: input.conversationId ?? CONVERSATION,
      kind: 'text',
      requestJson: '{}',
      state: input.state ?? 'success',
      telegramMessageId: input.telegramMessageId,
      responseJson: input.telegramMessageId === null ? null : `{"message_id":${input.telegramMessageId}}`,
      errorCode: null,
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    })
    .run();
}

function insertBucket(store: SqliteStore, id: bigint): void {
  store.orm
    .insert(buckets)
    .values({
      id,
      conversationId: CONVERSATION,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: at(0),
      deadlineAt: at(15),
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

/** Attaches a bucket the way the queue does; `injectedAt: null` means never injected. */
function attachBucket(store: SqliteStore, bucketId: bigint, injectedAt: string | null): void {
  store.orm
    .insert(invocationBuckets)
    .values({ invocationId: INVOCATION, bucketId, attachedAt: at(40), injectedAt })
    .run();
}

function insertOtherConversation(store: SqliteStore): void {
  store.orm
    .insert(conversations)
    .values({ id: OTHER_CONVERSATION, chatId: CHAT, messageThreadId: 7n, createdAt: at(0), updatedAt: at(0) })
    .run();
}

interface SliceOptions {
  readonly beforeSendId?: bigint;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly toolDefinitionCharacters?: number;
  readonly supportsImages?: boolean;
}

function buildSlice(fixture: Fixture, options: SliceOptions = {}): SceneContext {
  const call: SceneContextOptions = {
    contextWindow: options.contextWindow ?? 200_000,
    maxOutputTokens: options.maxOutputTokens ?? 32_768,
    toolDefinitionCharacters: options.toolDefinitionCharacters ?? 0,
    beforeSendId: options.beforeSendId ?? SEND,
    ...(options.supportsImages === undefined ? {} : { supportsImages: options.supportsImages }),
  };
  return buildSceneContext(fixture.store, fixture.config, INVOCATION, call);
}

function expectSliceError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneSliceError);
    expect((error as SceneSliceError).code).toBe(code);
    return;
  }
  throw new Error(`expected a SceneSliceError with code ${code}`);
}

/** Every table and all of its rows, for before/after comparison. */
function databaseRows(store: SqliteStore): Record<string, unknown[]> {
  const names = store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}

test('builds a bot-send slice from the frozen inputs between two bot messages', async () => {
  const f = await fixture();
  // Neither row can have been read by a send that started at 08:00:03: one
  // arrived later, the other was only edited later.
  insertMessage(f.store, {
    id: 6_010n,
    revisionId: 6_110n,
    telegramMessageId: 899n,
    at: at(50),
    receivedAt: at(64),
    text: 'arrived after the send started',
  });
  freeze(f.store, { messageId: 6_010n, revisionId: 6_110n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  insertMessage(f.store, {
    id: 6_011n,
    revisionId: 6_111n,
    telegramMessageId: 898n,
    at: at(50),
    text: 'edited after the send started',
  });
  f.store.orm
    .update(messageRevisions)
    .set({ createdAt: at(64) })
    .where(eq(messageRevisions.id, 6_111n))
    .run();
  freeze(f.store, { messageId: 6_011n, revisionId: 6_111n, sequenceNo: 4n, sourceBucketId: OPENING_BUCKET });

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: null });
  expect(scene.cutoffAt).toBe(at(63));
  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(2);
  expect(scene.omittedMessages).toBe(0);
  expect(scene.omittedImages).toBe(0);
  expect(scene.mediaRefs.size).toBe(0);
  expect(scene.bucketId).toBe(OPENING_BUCKET);
  expect(scene.conversationId).toBe(CONVERSATION);
  expect(scene.chatId).toBe(123_456_789n);
  expect(scene.threadId).toBe(0n);
  expect(scene.replyMessageIds).toEqual(['900', '901']);
  expect(scene.text.startsWith('<runtime_state>\ncurrent_time: ')).toBe(true);
  expect(scene.text).toContain('September 10, 2026 at 08:00:03 UTC (UTC)');
  expect(scene.text).not.toContain('<untrusted_telegram_history>');
  expect(scene.text).toContain('<untrusted_new_messages>');
  expect(scene.text).toContain('[900 07:59:30 uid:42 @alice] Alice\n  edited caption');
  expect(scene.text).toContain('[901 07:59:55 re:900 uid:42 @alice] Alice\n  plain text message with a reply');
  expect(scene.text.indexOf('[900 ')).toBeLessThan(scene.text.indexOf('[901 '));
  for (const leak of [
    TARGET_ANSWER,
    'Hello from the seeded invocation',
    'private reasoning',
    'edited text with forward origin',
    'arrived after the send started',
    'edited after the send started',
    OUTSIDE_QUOTE,
  ]) {
    expect(scene.text).not.toContain(leak);
  }
});

test("uses a previous bot message produced by another invocation's send", async () => {
  const f = await fixture();
  insertSend(f.store, {
    id: OTHER_SEND,
    toolCallId: 8_201n,
    callId: 'call_send_other_invocation',
    invocationId: OTHER_INVOCATION,
    telegramMessageId: 895n,
    createdAt: at(58),
  });
  insertMessage(f.store, {
    id: 6_020n,
    revisionId: 6_120n,
    telegramMessageId: 895n,
    at: at(58),
    text: 'other invocation reply',
    sentByBot: true,
  });
  insertMessage(f.store, {
    id: 6_021n,
    revisionId: 6_121n,
    telegramMessageId: 890n,
    at: at(50),
    text: 'before the other bot answer',
  });
  freeze(f.store, { messageId: 6_021n, revisionId: 6_121n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  insertMessage(f.store, {
    id: 6_022n,
    revisionId: 6_122n,
    telegramMessageId: 899n,
    at: at(59),
    text: 'after the other bot answer',
  });
  freeze(f.store, { messageId: 6_022n, revisionId: 6_122n, sequenceNo: 4n, sourceBucketId: OPENING_BUCKET });
  // A frozen bot-owned input is still not public input.
  freeze(f.store, { messageId: 6_020n, revisionId: 6_120n, sequenceNo: 5n, sourceBucketId: OPENING_BUCKET });

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: '895' });
  expect(scene.messageCount).toBe(3);
  expect(scene.text).toContain('[899 07:59:59 uid:42 @alice] Alice\n  after the other bot answer');
  expect(scene.text).not.toContain('before the other bot answer');
  expect(scene.text).not.toContain('other invocation reply');
});

test('accepts a previous bot message that no send row produced', async () => {
  const f = await fixture();
  insertMessage(f.store, { id: 6_030n, revisionId: null, telegramMessageId: 880n, at: at(40), sentByBot: true });
  insertMessage(f.store, {
    id: 6_031n,
    revisionId: 6_131n,
    telegramMessageId: 875n,
    at: at(40),
    text: 'below the previous bot message',
  });
  freeze(f.store, { messageId: 6_031n, revisionId: 6_131n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  insertMessage(f.store, {
    id: 6_032n,
    revisionId: 6_132n,
    telegramMessageId: 885n,
    at: at(40),
    text: 'above the previous bot message',
  });
  freeze(f.store, { messageId: 6_032n, revisionId: 6_132n, sequenceNo: 4n, sourceBucketId: OPENING_BUCKET });

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: '880' });
  expect(scene.messageCount).toBe(3);
  expect(scene.text).toContain('above the previous bot message');
  expect(scene.text).not.toContain('below the previous bot message');
});

test('keeps the window exact when every neighbor shares one second', async () => {
  const f = await fixture();
  const second = at(50);
  f.store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  insertOtherConversation(f.store);
  insertMessage(f.store, { id: 6_040n, revisionId: null, telegramMessageId: 880n, at: second, sentByBot: true });
  const frozen: ReadonlyArray<{
    readonly id: bigint;
    readonly revisionId: bigint;
    readonly telegramMessageId: bigint;
    readonly text: string;
    readonly conversationId?: bigint;
    readonly visible?: boolean;
  }> = [
    { id: 6_041n, revisionId: 6_141n, telegramMessageId: 870n, text: 'older than the previous bot' },
    { id: 6_042n, revisionId: 6_142n, telegramMessageId: 893n, text: 'window first' },
    { id: 6_043n, revisionId: 6_143n, telegramMessageId: 894n, text: 'unfrozen neighbor' },
    { id: 6_044n, revisionId: 6_144n, telegramMessageId: 896n, text: 'window second' },
    { id: 6_045n, revisionId: 6_145n, telegramMessageId: 897n, text: 'window third' },
    { id: 6_046n, revisionId: 6_146n, telegramMessageId: 898n, text: 'hidden boundary', visible: false },
    {
      id: 6_047n,
      revisionId: 6_147n,
      telegramMessageId: 899n,
      text: 'other topic words',
      conversationId: OTHER_CONVERSATION,
    },
    { id: 6_048n, revisionId: 6_148n, telegramMessageId: 905n, text: 'after the selected send' },
  ];
  let sequence = 1n;
  for (const entry of frozen) {
    insertMessage(f.store, {
      id: entry.id,
      revisionId: entry.revisionId,
      telegramMessageId: entry.telegramMessageId,
      at: second,
      text: entry.text,
      ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
      ...(entry.visible === undefined ? {} : { visible: entry.visible }),
    });
    // The unfrozen neighbor exists as a stored message only, never as input.
    if (entry.telegramMessageId !== 894n) {
      freeze(f.store, {
        messageId: entry.id,
        revisionId: entry.revisionId,
        sequenceNo: sequence,
        sourceBucketId: OPENING_BUCKET,
      });
      sequence += 1n;
    }
  }

  const scene = buildSlice(f);

  expect(scene.slice).toEqual({ beforeSendId: '8101', beforeMessageId: '902', afterBotMessageId: '880' });
  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(3);
  expect(scene.replyMessageIds).toEqual(['893', '896', '897']);
  expect(scene.text).toContain('[893 07:59:50 uid:42 @alice] Alice\n  window first');
  expect(scene.text).toContain('[896 07:59:50 uid:42 @alice] Alice\n  window second');
  expect(scene.text).toContain('[897 07:59:50 uid:42 @alice] Alice\n  window third');
  for (const leak of [
    'older than the previous bot',
    'unfrozen neighbor',
    'hidden boundary',
    'other topic words',
    'after the selected send',
  ]) {
    expect(scene.text).not.toContain(leak);
  }
});

test('still applies the conversation context cutoff inside a slice', async () => {
  const f = await fixture();
  f.store.orm
    .insert(conversationContextCutoffs)
    .values({ conversationId: CONVERSATION, telegramMessageId: 900n, createdAt: at(61), updatedAt: at(61) })
    .run();

  const scene = buildSlice(f);
  expect(scene.messageCount).toBe(1);
  expect(scene.text).toContain('  plain text message with a reply');
  expect(scene.text).not.toContain('edited caption');

  f.store.orm
    .update(conversationContextCutoffs)
    .set({ telegramMessageId: 901n })
    .where(eq(conversationContextCutoffs.conversationId, CONVERSATION))
    .run();
  expectSliceError(() => buildSlice(f), 'replay_slice_empty');
});

test('injects only attached batches that were already injected when the send started', async () => {
  const f = await fixture();
  const injected = 3_101n;
  const never = 3_102n;
  const later = 3_103n;
  const tied = 3_104n;
  for (const id of [injected, never, later, tied]) {
    insertBucket(f.store, id);
  }
  attachBucket(f.store, injected, at(62));
  attachBucket(f.store, never, null);
  attachBucket(f.store, later, at(64));
  attachBucket(f.store, tied, at(63));
  const batches: ReadonlyArray<{
    readonly id: bigint;
    readonly revisionId: bigint;
    readonly telegramMessageId: bigint;
    readonly bucket: bigint;
    readonly text: string;
  }> = [
    { id: 6_050n, revisionId: 6_150n, telegramMessageId: 890n, bucket: injected, text: 'injected batch words' },
    { id: 6_051n, revisionId: 6_151n, telegramMessageId: 891n, bucket: never, text: 'never injected words' },
    { id: 6_052n, revisionId: 6_152n, telegramMessageId: 892n, bucket: later, text: 'future injected words' },
    { id: 6_053n, revisionId: 6_153n, telegramMessageId: 893n, bucket: tied, text: 'ambiguous injection words' },
  ];
  let sequence = 3n;
  for (const batch of batches) {
    insertMessage(f.store, {
      id: batch.id,
      revisionId: batch.revisionId,
      telegramMessageId: batch.telegramMessageId,
      at: at(10),
      text: batch.text,
    });
    freeze(f.store, {
      messageId: batch.id,
      revisionId: batch.revisionId,
      sequenceNo: sequence,
      sourceBucketId: batch.bucket,
    });
    sequence += 1n;
  }

  const scene = buildSlice(f);

  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(3);
  expect(scene.text).toContain('  injected batch words');
  expect(scene.text).not.toContain('never injected words');
  expect(scene.text).not.toContain('future injected words');
  expect(scene.text).not.toContain('ambiguous injection words');
});

test('renders the newest eligible snapshot when one message was frozen twice', async () => {
  const f = await fixture();
  f.store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  f.store.orm
    .insert(messageRevisions)
    .values({
      id: REVISION_REFRESH,
      messageId: MESSAGE_OPENING,
      revisionNo: 3n,
      senderId: ALICE,
      kind: 'text',
      text: 're-frozen newer words',
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: at(57),
      rawFragmentJson: '{}',
    })
    .run();
  freeze(f.store, { messageId: MESSAGE_OPENING, revisionId: REVISION_B1, section: 'history', sequenceNo: 1n });
  freeze(f.store, {
    messageId: MESSAGE_OPENING,
    revisionId: REVISION_REFRESH,
    sequenceNo: 2n,
    sourceBucketId: OPENING_BUCKET,
  });

  const scene = buildSlice(f);
  expect(scene.messageCount).toBe(1);
  expect(scene.text).toContain('  re-frozen newer words');
  expect(scene.text).not.toContain('plain text message with a reply');
  expect(scene.text.match(/\[901 /g)).toHaveLength(1);

  // An even later freeze of the same message cannot win: its revision was
  // created after the send started, so it is not provable input.
  freeze(f.store, {
    messageId: MESSAGE_OPENING,
    revisionId: REVISION_B2,
    sequenceNo: 3n,
    sourceBucketId: OPENING_BUCKET,
  });
  const guarded = buildSlice(f);
  expect(guarded.messageCount).toBe(1);
  expect(guarded.text).toContain('  re-frozen newer words');
  expect(guarded.text).not.toContain('edited text with forward origin');
});

test("renders the frozen snapshot, never the message's latest edit", async () => {
  const f = await fixture();

  const scene = buildSlice(f);

  expect(scene.text).toContain('  plain text message with a reply');
  expect(scene.text).not.toContain('edited text with forward origin');
  const live = f.store.orm
    .all<{ text: string | null }>(
      sql`SELECT r.text FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id
          WHERE m.id = ${MESSAGE_OPENING}`,
    )
    .at(0);
  expect(live?.text).toBe('edited text with forward origin');
});

test('keeps reply references only for messages inside the slice', async () => {
  const f = await fixture();

  const included = buildSlice(f);
  expect(included.replyMessageIds).toEqual(['900', '901']);
  expect(included.text).toContain('[901 07:59:55 re:900 uid:42 @alice] Alice');
  expect(included.text).not.toContain(`> Bot: ${OUTSIDE_QUOTE}`);

  // The replied-to message becomes the previous bot message: its reference
  // leaves the window and the reply must not carry any trace of it.
  f.store.orm.update(messages).set({ sentByBot: true }).where(eq(messages.id, MESSAGE_HISTORY)).run();
  const trimmed = buildSlice(f);
  expect(trimmed.slice?.afterBotMessageId).toBe('900');
  expect(trimmed.messageCount).toBe(1);
  expect(trimmed.replyMessageIds).toEqual(['901']);
  expect(trimmed.text).toContain('  plain text message with a reply');
  expect(trimmed.text).not.toContain('re:900');
  expect(trimmed.text).not.toContain(OUTSIDE_QUOTE);
});

test('authorizes only frozen-revision media and only for rendered messages', async () => {
  const f = await fixture();
  const refsBefore = f.store.orm.select().from(contextRefs).all();
  expect(refsBefore).toHaveLength(1);

  setFrozenRevision(f.store, MESSAGE_HISTORY, REVISION_A1);
  const scene = buildSlice(f, { supportsImages: true });
  const ref = [...scene.mediaRefs.keys()].at(0);
  expect(scene.mediaRefs.size).toBe(1);
  expect([...scene.mediaRefs.values()]).toEqual([MEDIA_PHOTO]);
  expect(ref).toBeDefined();
  expect(scene.omittedImages).toBe(0);
  expect(scene.text).toContain(`[photo ${ref} 1280x720]`);
  expect(scene.text).toContain('  first caption');

  // The retained media row is moved to a revision the frozen snapshot does not
  // name: it must be reported missing, never authorized.
  f.store.orm.update(media).set({ revisionId: REVISION_A2 }).where(eq(media.id, MEDIA_PHOTO)).run();
  const orphaned = buildSlice(f, { supportsImages: true });
  expect(orphaned.mediaRefs.size).toBe(0);
  expect(orphaned.omittedImages).toBe(1);
  expect(orphaned.text).toContain('[photo media_missing 1280x720]');

  // A message dropped by the character budget carries no reference either.
  f.store.orm.update(media).set({ revisionId: REVISION_A1 }).where(eq(media.id, MEDIA_PHOTO)).run();
  f.store.orm
    .update(messageRevisions)
    .set({ caption: 'x'.repeat(2_000) })
    .where(eq(messageRevisions.id, REVISION_A1))
    .run();
  setFrozenRevision(f.store, MESSAGE_HISTORY, REVISION_A1);
  const trimmed = buildSlice(f, {
    supportsImages: true,
    contextWindow: 320,
    maxOutputTokens: 0,
    toolDefinitionCharacters: 0,
  });
  expect(trimmed.messageCount).toBe(1);
  expect(trimmed.omittedMessages).toBe(1);
  expect(trimmed.mediaRefs.size).toBe(0);
  expect(trimmed.omittedImages).toBe(0);
  expect(trimmed.text).not.toContain('img_');

  expect(f.store.orm.select().from(contextRefs).all()).toEqual(refsBefore);
});

test("rejects sends that are not this invocation's successful same-conversation send", async () => {
  const f = await fixture();
  insertOtherConversation(f.store);
  insertSend(f.store, {
    id: OTHER_SEND,
    toolCallId: 8_301n,
    callId: 'call_send_wrong_invocation',
    invocationId: OTHER_INVOCATION,
    telegramMessageId: 906n,
    createdAt: at(70),
  });
  insertSend(f.store, {
    id: WRONG_CONVERSATION_SEND,
    toolCallId: 8_302n,
    callId: 'call_send_wrong_conversation',
    invocationId: INVOCATION,
    conversationId: OTHER_CONVERSATION,
    telegramMessageId: 907n,
    createdAt: at(70),
  });
  insertSend(f.store, {
    id: FAILED_SEND,
    toolCallId: 8_303n,
    callId: 'call_send_failed',
    invocationId: INVOCATION,
    telegramMessageId: 908n,
    state: 'error',
    createdAt: at(70),
  });
  insertSend(f.store, {
    id: NO_MESSAGE_SEND,
    toolCallId: 8_304n,
    callId: 'call_send_without_message',
    invocationId: INVOCATION,
    telegramMessageId: null,
    createdAt: at(70),
  });

  for (const id of [OTHER_SEND, WRONG_CONVERSATION_SEND, FAILED_SEND, NO_MESSAGE_SEND, 999_999n]) {
    expectSliceError(() => buildSlice(f, { beforeSendId: id }), 'replay_slice_target_invalid');
  }
  expect(buildSlice(f).messageCount).toBe(2);
});

test('sees no input between two consecutive sends of one invocation', async () => {
  const f = await fixture();
  insertSend(f.store, {
    id: SECOND_SEND,
    toolCallId: 8_401n,
    callId: 'call_send_second',
    invocationId: INVOCATION,
    telegramMessageId: 905n,
    createdAt: at(67),
  });
  insertMessage(f.store, {
    id: 6_060n,
    revisionId: 6_160n,
    telegramMessageId: 905n,
    at: at(67),
    text: 'second answer',
    sentByBot: true,
  });
  insertMessage(f.store, {
    id: 6_061n,
    revisionId: 6_161n,
    telegramMessageId: 903n,
    at: at(64),
    text: 'retained but never frozen',
  });

  expectSliceError(() => buildSlice(f, { beforeSendId: SECOND_SEND }), 'replay_slice_empty');
  expect(buildSlice(f).messageCount).toBe(2);

  // A provable input in that window renders alone; the unfrozen neighbor stays out.
  insertMessage(f.store, {
    id: 6_062n,
    revisionId: 6_162n,
    telegramMessageId: 904n,
    at: at(65),
    text: 'frozen between the two sends',
  });
  freeze(f.store, { messageId: 6_062n, revisionId: 6_162n, sequenceNo: 3n, sourceBucketId: OPENING_BUCKET });
  const scene = buildSlice(f, { beforeSendId: SECOND_SEND });
  expect(scene.slice).toEqual({ beforeSendId: '8102', beforeMessageId: '905', afterBotMessageId: '902' });
  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBe(1);
  expect(scene.text).toContain('  frozen between the two sends');
  expect(scene.text).not.toContain('retained but never frozen');
  expect(scene.text).not.toContain('second answer');
});

test('trims the slice to the character budget keeping the newest input', async () => {
  const f = await fixture();
  f.store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).run();
  for (let index = 0; index < 6; index += 1) {
    const id = 6_070n + BigInt(index);
    const revisionId = 6_170n + BigInt(index);
    insertMessage(f.store, {
      id,
      revisionId,
      telegramMessageId: 880n + BigInt(index),
      at: at(10 + index),
      text: `budget ${index} ${'x'.repeat(200)}`,
    });
    freeze(f.store, { messageId: id, revisionId, sequenceNo: BigInt(index + 1), sourceBucketId: OPENING_BUCKET });
  }

  const scene = buildSlice(f, { contextWindow: 320, maxOutputTokens: 0, toolDefinitionCharacters: 0 });

  expect(scene.historyCount).toBe(0);
  expect(scene.messageCount).toBeGreaterThanOrEqual(1);
  expect(scene.messageCount).toBeLessThan(6);
  expect(scene.omittedMessages).toBe(6 - scene.messageCount);
  expect(scene.text).toContain('budget 5');
  expect(scene.text).not.toContain('budget 0');
  expect(scene.text).toContain(`[${6 - scene.messageCount} earlier new messages omitted to fit the model context]`);
});

test('never writes while building a slice', async () => {
  const f = await fixture();
  setFrozenRevision(f.store, MESSAGE_HISTORY, REVISION_A1);
  const before = databaseRows(f.store);
  expect(
    f.store.orm.select().from(invocationMessages).where(eq(invocationMessages.invocationId, INVOCATION)).all(),
  ).toHaveLength(2);
  expect(before.context_refs).toHaveLength(1);

  const scene = buildSlice(f, { supportsImages: true });

  expect(scene.mediaRefs.size).toBe(1);
  expect(databaseRows(f.store)).toEqual(before);
});
