import { and, eq, sql } from 'drizzle-orm';
import type { Message, Update } from 'grammy/types';
import { conversationThreadId, type ParsedCommand, parseBotCommand } from '../orchestration/bot-commands.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { asRunResult, isChatPaused, resolveChatConfig, type SqliteStore } from '../store/database.ts';
import { evaluateParticipation, ParticipationRegistry } from '../store/participation.ts';
import {
  bucketMessages,
  buckets,
  chatMigrations,
  chats,
  conversations,
  media as mediaTable,
  messageRevisions,
  messages,
  senders,
  telegramUpdates,
} from '../store/schema.ts';

const IMAGE_MIME_TYPES: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
};
const SERVICE_KEYS: Record<string, true> = {
  new_chat_members: true,
  left_chat_member: true,
  new_chat_title: true,
  new_chat_photo: true,
  delete_chat_photo: true,
  group_chat_created: true,
  supergroup_chat_created: true,
  channel_chat_created: true,
  message_auto_delete_timer_changed: true,
  migrate_to_chat_id: true,
  migrate_from_chat_id: true,
  pinned_message: true,
  forum_topic_created: true,
  forum_topic_closed: true,
  forum_topic_reopened: true,
  forum_topic_edited: true,
  general_forum_topic_hidden: true,
  general_forum_topic_unhidden: true,
  video_chat_scheduled: true,
  video_chat_started: true,
  video_chat_ended: true,
  video_chat_participants_invited: true,
};
const MAX_IMAGE_DOCUMENT_BYTES = 20 * 1024 * 1024;

interface StoredMessage {
  readonly id: bigint;
  readonly revisionId: bigint;
  readonly conversationId: bigint;
  readonly eligibleHuman: boolean;
  readonly companionOnly: boolean;
}

export interface IngestResult {
  readonly messageId?: bigint;
  readonly bucketId?: bigint;
  readonly command?: ParsedCommand;
}

export class TelegramIngestion {
  readonly #store: SqliteStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #participation: ParticipationRegistry;
  #allowedChats = new Map<string, ReadonlySet<bigint> | undefined>();
  #configGeneration = 0;
  readonly #botId: bigint;
  readonly #botUsername: string | null;

  constructor(
    store: SqliteStore,
    configStore: RuntimeConfigurationStore,
    bot: { readonly id: number; readonly username?: string | null },
  ) {
    this.#store = store;
    this.#configStore = configStore;
    this.#botId = BigInt(bot.id);
    this.#botUsername = bot.username ?? null;
    this.#syncAllowedChats();
    this.#participation = new ParticipationRegistry(configStore);
  }

  ingest(update: Update, receivedAt = new Date()): IngestResult {
    return this.#store.transaction(() => this.#ingestTransaction(update, receivedAt, true));
  }

  ingestCatchUp(update: Update, receivedAt = new Date()): IngestResult {
    return this.#store.transaction(() => this.#ingestTransaction(update, receivedAt, false));
  }

  #ingestTransaction(update: Update, receivedAt: Date, schedule: boolean): IngestResult {
    this.#syncAllowedChats();
    const message = update.edited_message ?? update.message;
    const membership = update.my_chat_member;
    const chat = message?.chat ?? membership?.chat;
    const chatId = chat === undefined ? undefined : BigInt(chat.id);
    // One rule, shared with `parseBotCommand`: the two must agree or a command
    // scoped to a Conversation cannot find the rows ingestion wrote.
    const threadId = conversationThreadId(message);
    // A migration notice is what authorizes the new supergroup ID, so it is
    // recorded before that ID is checked against the allowlist and topics. The
    // first notice the bot sees can be `migrate_from_chat_id` in the new chat.
    this.#recordMigration(message, receivedAt);
    const topics = chatId === undefined ? null : this.#topicsFor(chatId);
    const topicAllowed = topics !== null && (topics === undefined || topics.has(threadId));
    const edited = update.edited_message !== undefined;
    // Chat control commands are handled by the bot itself: they are audited
    // but never stored as messages, so they cannot trigger or taint buckets.
    const command = schedule && !edited && message !== undefined ? parseBotCommand(message, this.#botUsername) : null;
    // A chat the allowlist does not name still reaches the bot through exactly
    // one command: an admin allowlisting it. Every other command or message
    // from such a chat stays rejected, so the bot never talks where it is not
    // configured.
    const senderIsAdmin =
      message?.from !== undefined &&
      (this.#configStore.current().config.telegram.admins ?? []).includes(message.from.id);
    const adminCommand =
      topics === null && command !== null && command.name === 'allowlist' && senderIsAdmin ? command : null;
    const allowed = adminCommand !== null || (chat !== undefined && chat.type !== 'channel' && topicAllowed);
    const rejectionReason = allowed
      ? null
      : chat === undefined
        ? 'unsupported_update'
        : chat.type === 'channel'
          ? 'channel'
          : topics === null
            ? 'chat_not_allowed'
            : 'topic_not_allowed';
    const inserted = asRunResult(
      this.#store.orm
        .insert(telegramUpdates)
        .values({
          updateId: BigInt(update.update_id),
          chatId: chatId ?? null,
          chatType: chat?.type ?? null,
          receivedAt: receivedAt.toISOString(),
          allowed,
          rejectionReason,
          rawJson: allowed ? JSON.stringify(update) : null,
        })
        .onConflictDoNothing({ target: telegramUpdates.updateId })
        .run(),
    );
    if (inserted.changes === 0) {
      return {};
    }
    if (adminCommand !== null) {
      // adminCommand implies a message, so the chat is present; record the row
      // like the allowed command path does, so `/status` works before the
      // first stored message arrives.
      if (chat !== undefined && chatId !== undefined) {
        this.#upsertChat(chat, chatId, receivedAt);
      }
      return { command: adminCommand };
    }
    if (!allowed || chat === undefined || chatId === undefined || topics === null) {
      return {};
    }

    if (message === undefined) {
      this.#upsertChat(chat, chatId, receivedAt);
      return {};
    }
    const chatConfig = resolveChatConfig(this.#configStore.current().config, this.#store.orm, chatId);
    const ignoredUserIds = chatConfig?.ignored_user_ids ?? [];
    if (isIgnoredUser(message, ignoredUserIds)) {
      return {};
    }
    const internalChatId = this.#upsertChat(chat, chatId, receivedAt);
    // Ignored users are dropped before command dispatch: their commands never
    // reach the bot, exactly like their messages never reach a bucket.
    if (command !== null) {
      return { command };
    }
    const stored = this.#storeMessage(message, internalChatId, threadId, receivedAt, edited, ignoredUserIds);
    if (stored === undefined) {
      return {};
    }
    let bucketId: bigint | undefined;
    if (!edited) {
      // The window is refreshed even during startup catch-up, so a mention that
      // arrived while the process was down still leaves the chat awake.
      const decision = evaluateParticipation({
        orm: this.#store.orm,
        rule: this.#participation.ruleFor(this.#store.orm, chatId, chat.type),
        chatId: internalChatId,
        telegramChatId: chatId,
        conversationId: stored.conversationId,
        message,
        bot: { id: this.#botId, username: this.#botUsername },
        receivedAt,
        eligibleHuman: stored.eligibleHuman,
      });
      if (schedule) {
        bucketId = this.#appendToBucket(internalChatId, threadId, stored, receivedAt, decision.bucketCreationAllowed);
      }
    }
    return {
      messageId: stored.id,
      ...(bucketId === undefined ? {} : { bucketId }),
    };
  }

  // Chat additions are hot-applied configuration changes: rebuild the
  // allowlist whenever the published configuration generation moved on.
  #syncAllowedChats(): void {
    const snapshot = this.#configStore.current();
    if (snapshot.generation === this.#configGeneration) {
      return;
    }
    this.#configGeneration = snapshot.generation;
    this.#allowedChats = new Map(
      snapshot.config.telegram.chats.map((chat) => [
        String(chat.id),
        chat.topic_ids === undefined ? undefined : new Set(chat.topic_ids.map((topicId) => BigInt(topicId))),
      ]),
    );
  }

  /** `null` when the chat is not allowed; `undefined` when allowed for all topics. */
  #topicsFor(chatId: bigint): ReadonlySet<bigint> | undefined | null {
    if (this.#allowedChats.has(chatId.toString())) {
      return this.#allowedChats.get(chatId.toString());
    }
    const migration = this.#store.orm
      .select({ oldChatId: chatMigrations.oldChatId })
      .from(chatMigrations)
      .where(eq(chatMigrations.newChatId, chatId))
      .get();
    if (migration === undefined) {
      return null;
    }
    const migrated = migration.oldChatId.toString();
    return this.#allowedChats.has(migrated) ? this.#allowedChats.get(migrated) : null;
  }

  #recordMigration(message: Message | undefined, receivedAt: Date): void {
    if (message === undefined) {
      return;
    }
    let oldChatId: bigint | undefined;
    let newChatId: bigint | undefined;
    if ('migrate_to_chat_id' in message) {
      oldChatId = BigInt(message.chat.id);
      newChatId = BigInt(message.migrate_to_chat_id);
    } else if ('migrate_from_chat_id' in message) {
      oldChatId = BigInt(message.migrate_from_chat_id);
      newChatId = BigInt(message.chat.id);
    }
    // Only a chat that is itself allowed can hand its allowlist entry on.
    if (oldChatId === undefined || newChatId === undefined || this.#topicsFor(oldChatId) === null) {
      return;
    }
    this.#store.orm
      .insert(chatMigrations)
      .values({
        oldChatId,
        newChatId,
        receivedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: chatMigrations.oldChatId,
        set: { newChatId, receivedAt: receivedAt.toISOString() },
      })
      .run();
  }

  #upsertChat(chat: Message['chat'], chatId: bigint, receivedAt: Date): bigint {
    const title = 'title' in chat ? (chat.title ?? null) : null;
    const username = 'username' in chat ? (chat.username ?? null) : null;
    this.#store.orm
      .insert(chats)
      .values({
        telegramChatId: chatId,
        canonicalChatId: chatId,
        type: chat.type,
        title,
        username,
        updatedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: chats.telegramChatId,
        set: { type: chat.type, title, username, updatedAt: receivedAt.toISOString() },
      })
      .run();
    const row = this.#store.orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, chatId)).get();
    if (row === undefined) {
      throw new Error('Chat upsert did not return a row');
    }
    return row.id;
  }

  #storeMessage(
    message: Message,
    internalChatId: bigint,
    threadId: bigint,
    receivedAt: Date,
    edited: boolean,
    ignoredUserIds: readonly number[],
  ): StoredMessage | undefined {
    const sender = this.#upsertSender(message, receivedAt);
    // A message sent on behalf of a chat (anonymous group admin, a channel
    // identity, a linked-channel post) carries a placeholder bot in `from` for
    // backward compatibility, such as GroupAnonymousBot. Its author is
    // `sender_chat`, which `#upsertSender` already records as a non-bot.
    const fromBot = message.sender_chat === undefined && message.from?.is_bot === true;
    const ownMessage = message.from !== undefined && BigInt(message.from.id) === this.#botId;
    const service = isServiceMessage(message);
    if (ownMessage || (fromBot && !this.#configStore.current().config.telegram.process_bot_messages)) {
      return undefined;
    }
    const conversationId = this.#upsertConversation(internalChatId, threadId, receivedAt);
    const telegramMessageId = BigInt(message.message_id);
    const existing = this.#store.orm
      .all<{ id: bigint; revision_no: bigint }>(
        sql`SELECT m.id, COALESCE(MAX(r.revision_no), 0) AS revision_no FROM messages m LEFT JOIN message_revisions r ON r.message_id = m.id WHERE m.chat_id = ${internalChatId} AND m.telegram_message_id = ${telegramMessageId} GROUP BY m.id`,
      )
      .at(0);
    let messageId: bigint;
    let revisionNo: bigint;
    if (existing === undefined) {
      const created = this.#store.orm
        .insert(messages)
        .values({
          conversationId,
          chatId: internalChatId,
          telegramMessageId,
          telegramDate: new Date(message.date * 1000).toISOString(),
          receivedAt: receivedAt.toISOString(),
        })
        .returning({ id: messages.id })
        .get();
      if (created === undefined) {
        throw new Error('messages insert returned no row');
      }
      messageId = created.id;
      revisionNo = 1n;
    } else {
      messageId = existing.id;
      if (!edited) {
        return undefined;
      }
      revisionNo = existing.revision_no + 1n;
    }
    const normalized = normalizeMessage(message, service, ignoredUserIds);
    const stickerOnly =
      normalized.kind === 'sticker' &&
      normalized.text === null &&
      normalized.caption === null &&
      normalized.media.length === 1 &&
      normalized.media[0]?.kind === 'sticker';
    const eligibleHuman =
      !fromBot &&
      !service &&
      (!stickerOnly || this.#configStore.current().config.telegram.sticker_trigger_enabled === true);
    const revision = this.#store.orm
      .insert(messageRevisions)
      .values({
        messageId,
        revisionNo,
        senderId: sender,
        kind: normalized.kind,
        text: normalized.text,
        caption: normalized.caption,
        replyToMessageId: normalized.replyToMessageId,
        replySnapshotJson: normalized.replySnapshot,
        forwardOriginJson: normalized.forwardOrigin,
        mediaGroupId: message.media_group_id ?? null,
        serviceJson: service ? JSON.stringify(message) : null,
        createdAt: receivedAt.toISOString(),
        rawFragmentJson: JSON.stringify(message),
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('message_revisions insert returned no row');
    }
    const revisionId = revision.id;
    this.#store.orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
    for (const media of normalized.media) {
      this.#store.orm
        .insert(mediaTable)
        .values({
          revisionId,
          kind: media.kind,
          fileId: media.fileId,
          fileUniqueId: media.fileUniqueId,
          mimeType: media.mimeType,
          fileSize: media.fileSize,
          width: media.width,
          height: media.height,
          telegramJson: media.telegramJson,
        })
        .run();
    }
    return {
      id: messageId,
      revisionId,
      conversationId,
      eligibleHuman,
      companionOnly: !eligibleHuman,
    };
  }

  #upsertSender(message: Message, receivedAt: Date): bigint | null {
    const senderChat = message.sender_chat;
    let type: 'user' | 'sender_chat';
    let telegramId: bigint;
    let displayName: string;
    let username: string | null;
    let isBot: boolean;
    if (senderChat !== undefined) {
      type = 'sender_chat';
      telegramId = BigInt(senderChat.id);
      displayName = senderChat.title ?? senderChat.username ?? senderChat.id.toString();
      username = senderChat.username ?? null;
      isBot = false;
    } else if (message.from !== undefined) {
      type = 'user';
      telegramId = BigInt(message.from.id);
      displayName = [message.from.first_name, message.from.last_name].filter((part) => part !== undefined).join(' ');
      username = message.from.username ?? null;
      isBot = message.from.is_bot;
    } else {
      return null;
    }
    this.#store.orm
      .insert(senders)
      .values({
        telegramType: type,
        telegramId,
        displayName,
        username,
        isBot,
        updatedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: [senders.telegramType, senders.telegramId],
        set: { displayName, username, isBot, updatedAt: receivedAt.toISOString() },
      })
      .run();
    const row = this.#store.orm
      .select({ id: senders.id })
      .from(senders)
      .where(and(eq(senders.telegramType, type), eq(senders.telegramId, telegramId)))
      .get();
    if (row === undefined) {
      throw new Error('Sender upsert did not return a row');
    }
    return row.id;
  }

  #upsertConversation(chatId: bigint, threadId: bigint, receivedAt: Date): bigint {
    this.#store.orm
      .insert(conversations)
      .values({
        chatId,
        messageThreadId: threadId,
        createdAt: receivedAt.toISOString(),
        updatedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: [conversations.chatId, conversations.messageThreadId],
        set: { updatedAt: receivedAt.toISOString() },
      })
      .run();
    const row = this.#store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
      .get();
    if (row === undefined) {
      throw new Error('Conversation upsert did not return a row');
    }
    return row.id;
  }

  #appendToBucket(
    chatId: bigint,
    threadId: bigint,
    message: StoredMessage,
    receivedAt: Date,
    participationAllowed: boolean,
  ): bigint | undefined {
    if (isChatPaused(this.#store.orm, chatId)) {
      return undefined;
    }
    const conversation = this.#store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
      .get();
    if (conversation === undefined) {
      throw new Error('Conversation missing while assigning bucket');
    }
    const collecting = this.#store.orm
      .select({ id: buckets.id })
      .from(buckets)
      .where(and(eq(buckets.conversationId, conversation.id), eq(buckets.state, 'collecting')))
      .get();
    if (message.companionOnly && collecting === undefined) {
      return undefined;
    }
    let bucketId = collecting?.id;
    if (bucketId === undefined) {
      if (!message.eligibleHuman) {
        return undefined;
      }
      // Participation gate: outside the chat's active periods and attention
      // window a quiet conversation keeps storing messages but opens no bucket,
      // so they only reach the model as history of a later triggered session.
      if (!participationAllowed) {
        return undefined;
      }
      const now = receivedAt.toISOString();
      // Anchored to this bucket's own first message, never snapped to a chat-wide
      // grid: a grid anchor leaves a band right after every run start where a
      // bucket collects almost nothing (down to milliseconds when a message lands
      // on the grid point), which a long-lived invocation turns into an occasional
      // instant reply. Treating "an invocation is queued or running" as
      // immediately due would make every message its own zero-length bucket now
      // that attach exists, and anchoring here alone would hand over a
      // barely-collected batch the moment a long round ends —
      // `AgentRuntime#deferCollectingBucket` therefore only ever pushes this
      // deadline later, to `round end + window`.
      const deadline = receivedAt.getTime() + this.#configStore.current().config.telegram.bucket_window_seconds * 1_000;
      const created = this.#store.orm
        .insert(buckets)
        .values({
          conversationId: conversation.id,
          state: 'collecting',
          firstReceivedAt: now,
          deadlineAt: new Date(deadline).toISOString(),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: buckets.id })
        .get();
      if (created === undefined) {
        throw new Error('buckets insert returned no row');
      }
      bucketId = created.id;
      this.#adoptPendingBotMessages(conversation.id, bucketId);
    }
    const sequence = this.#store.orm
      .all<{ next_sequence: bigint }>(
        sql`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM bucket_messages WHERE bucket_id = ${bucketId}`,
      )
      .at(0);
    if (sequence === undefined) {
      throw new Error('Unable to allocate bucket sequence');
    }
    this.#store.orm
      .insert(bucketMessages)
      .values({
        bucketId,
        messageId: message.id,
        sequenceNo: sequence.next_sequence,
        sourceBucketId: bucketId,
      })
      .run();
    return bucketId;
  }

  /**
   * Other bots' messages never open a bucket, so two bots cannot keep each
   * other awake. The ones that arrived while nothing was collecting wait here
   * until a human opens the next bucket, which takes them in ahead of itself
   * so the model sees them as part of the same new batch.
   */
  #adoptPendingBotMessages(conversationId: bigint, bucketId: bigint): void {
    const pending = this.#store.orm
      .all<{ id: bigint }>(
        sql`SELECT m.id
         FROM messages m
         JOIN message_revisions r ON r.id = m.current_revision_id
         JOIN senders s ON s.id = r.sender_id
         WHERE m.conversation_id = ${conversationId} AND m.visible = 1 AND m.sent_by_bot = 0 AND s.is_bot = 1
           AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = m.id)
           AND m.received_at >= COALESCE(
             (SELECT MAX(first_received_at) FROM buckets WHERE conversation_id = ${conversationId} AND id <> ${bucketId}),
             '')
           AND m.telegram_message_id > COALESCE(
             (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = m.conversation_id), -1)
         ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
         LIMIT ${BigInt(this.#configStore.current().config.agent.history_messages)}`,
      )
      .reverse();
    for (const [index, row] of pending.entries()) {
      this.#store.orm
        .insert(bucketMessages)
        .values({ bucketId, messageId: row.id, sequenceNo: BigInt(index + 1), sourceBucketId: bucketId })
        .run();
    }
  }
}

interface NormalizedMedia {
  readonly kind: 'photo' | 'document' | 'sticker';
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly width: bigint | null;
  readonly height: bigint | null;
  readonly telegramJson: string;
}

interface NormalizedMessage {
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly replyToMessageId: bigint | null;
  readonly replySnapshot: string | null;
  readonly forwardOrigin: string | null;
  readonly media: readonly NormalizedMedia[];
}

function normalizeMessage(message: Message, service: boolean, ignoredUserIds: readonly number[]): NormalizedMessage {
  const media: NormalizedMedia[] = [];
  let kind = service ? 'service' : 'unsupported';
  if (message.text !== undefined) {
    kind = 'text';
  }
  if (message.photo !== undefined) {
    kind = 'photo';
    const photo = message.photo.at(-1);
    if (photo !== undefined) {
      media.push({
        kind: 'photo',
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        mimeType: 'image/jpeg',
        fileSize: photo.file_size === undefined ? null : BigInt(photo.file_size),
        width: BigInt(photo.width),
        height: BigInt(photo.height),
        telegramJson: JSON.stringify(photo),
      });
    }
  }
  const document = message.document;
  if (
    document !== undefined &&
    document.mime_type !== undefined &&
    document.mime_type in IMAGE_MIME_TYPES &&
    document.file_size !== undefined &&
    document.file_size <= MAX_IMAGE_DOCUMENT_BYTES
  ) {
    kind = 'document';
    media.push({
      kind: 'document',
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      mimeType: document.mime_type,
      fileSize: BigInt(document.file_size),
      width: document.thumbnail === undefined ? null : BigInt(document.thumbnail.width),
      height: document.thumbnail === undefined ? null : BigInt(document.thumbnail.height),
      telegramJson: JSON.stringify(document),
    });
  }
  const sticker = message.sticker;
  if (sticker !== undefined) {
    kind = 'sticker';
    media.push({
      kind: 'sticker',
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      mimeType: sticker.is_video ? 'video/webm' : sticker.is_animated ? 'application/x-tgsticker' : 'image/webp',
      fileSize: sticker.file_size === undefined ? null : BigInt(sticker.file_size),
      width: BigInt(sticker.width),
      height: BigInt(sticker.height),
      telegramJson: JSON.stringify(sticker),
    });
  }
  const reply = message.reply_to_message;
  const visibleReply = reply !== undefined && !isIgnoredUser(reply, ignoredUserIds) ? reply : undefined;
  return {
    kind,
    text: message.text ?? null,
    caption: message.caption ?? null,
    replyToMessageId: visibleReply === undefined ? null : BigInt(visibleReply.message_id),
    replySnapshot: visibleReply === undefined ? null : JSON.stringify(compactReply(visibleReply)),
    forwardOrigin: message.forward_origin === undefined ? null : JSON.stringify(message.forward_origin),
    media,
  };
}

function isIgnoredUser(message: Message, ignoredUserIds: readonly number[]): boolean {
  if (message.sender_chat !== undefined || message.from === undefined) {
    return false;
  }
  const senderId = BigInt(message.from.id);
  return ignoredUserIds.some((ignoredUserId) => BigInt(ignoredUserId) === senderId);
}

function compactReply(message: Message): Record<string, unknown> {
  const sender = message.sender_chat ?? message.from;
  const senderName =
    sender === undefined
      ? 'unknown'
      : 'title' in sender
        ? sender.title
        : [sender.first_name, sender.last_name].filter((part) => part !== undefined).join(' ');
  const content = message.text ?? message.caption;
  return {
    message_id: String(message.message_id),
    sender: senderName,
    content:
      content === undefined
        ? `[${message.photo !== undefined ? 'photo' : message.sticker !== undefined ? 'sticker' : 'message'}]`
        : content.slice(0, 500),
  };
}

function isServiceMessage(message: Message): boolean {
  for (const key of Object.keys(SERVICE_KEYS)) {
    if (key in message) {
      return true;
    }
  }
  return false;
}
