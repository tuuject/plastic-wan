import { eq, sql } from 'drizzle-orm';
import type { Message } from 'grammy/types';
import type { RawConfig } from '../platform/config.ts';
import {
  type BotIdentity,
  compileParticipation,
  isWithinActiveWindows,
  matchTriggerKind,
  type ParticipationRule,
  type TriggerKind,
} from '../platform/participation.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { isChatPaused, type Orm, resolveChatConfig } from './database.ts';
import { conversationAttention } from './schema.ts';

export interface ParticipationDecision {
  /** Whether this message may open a new bucket. */
  readonly bucketCreationAllowed: boolean;
  readonly triggerKind: TriggerKind | null;
  /** Expiry of the conversation's attention window after this message. */
  readonly expiresAt: string | null;
}

/**
 * Participation rules compiled per configured chat. The rule only gates
 * bucket creation: messages are always stored, so a quiet chat keeps filling
 * the history that the next triggered invocation reads.
 *
 * Chat additions are hot-applied configuration changes, so the registry holds
 * the configuration store and recompiles whenever the published generation
 * moves; a snapshot taken before a publish keeps serving the run it started
 * with until the next `ruleFor` call.
 */
export class ParticipationRegistry {
  readonly #configStore: RuntimeConfigurationStore;
  #generation = 0;
  #config: RawConfig | undefined;
  #rules: ReadonlyMap<string, ParticipationRule | undefined> = new Map();

  constructor(configStore: RuntimeConfigurationStore) {
    this.#configStore = configStore;
  }

  /**
   * `undefined` means the chat participates unrestricted. Private chats never
   * gate, so a global schedule cannot silence direct messages. Rules are keyed
   * by the configured chat ID, so migrated supergroups resolve like
   * `resolveChatConfig`.
   */
  ruleFor(orm: Orm, telegramChatId: bigint, chatType: string): ParticipationRule | undefined {
    if (chatType === 'private') {
      return undefined;
    }
    const snapshot = this.#configStore.current();
    let config = this.#config;
    if (config === undefined || snapshot.generation !== this.#generation) {
      // Chat additions are hot-applied configuration changes: recompile the
      // rules whenever the published generation moved on.
      const rules = new Map<string, ParticipationRule | undefined>();
      for (const chat of snapshot.config.telegram.chats) {
        rules.set(
          String(chat.id),
          compileParticipation({
            global: snapshot.config.telegram.participation,
            chat: chat.participation,
            timezone: chat.timezone ?? snapshot.config.timezone,
          }),
        );
      }
      this.#generation = snapshot.generation;
      this.#config = config = snapshot.config;
      this.#rules = rules;
    }
    const chatConfig = resolveChatConfig(config, orm, telegramChatId);
    return chatConfig === undefined ? undefined : this.#rules.get(String(chatConfig.id));
  }
}

export function attentionWindowUntil(orm: Orm, conversationId: bigint, now: Date): string | null {
  const row = orm
    .select({ expiresAt: conversationAttention.expiresAt })
    .from(conversationAttention)
    .where(eq(conversationAttention.conversationId, conversationId))
    .get();
  return row === undefined || row.expiresAt <= now.toISOString() ? null : row.expiresAt;
}

/** Whether a scheduled period covers `now` or the conversation's window is still open. */
export function isConversationActive(orm: Orm, rule: ParticipationRule, conversationId: bigint, now: Date): boolean {
  return isWithinActiveWindows(rule, now) || attentionWindowUntil(orm, conversationId, now) !== null;
}

/** Latest open window across every conversation of a chat, for `/status`. */
export function chatAttentionUntil(orm: Orm, chatId: bigint, now: Date): string | null {
  const row = orm
    .all<{ expires_at: string | null }>(
      sql`SELECT MAX(a.expires_at) AS expires_at
       FROM conversation_attention a
       JOIN conversations v ON v.id = a.conversation_id
       WHERE v.chat_id = ${chatId} AND a.expires_at > ${now.toISOString()}`,
    )
    .at(0);
  return row?.expires_at ?? null;
}

/**
 * Single decision point for the participation gate. A triggering message
 * refreshes the window before the decision is taken, so the message that opens
 * a window is itself always allowed and the live ingestion path cannot disagree
 * with startup catch-up.
 */
export function evaluateParticipation(options: {
  readonly orm: Orm;
  readonly rule: ParticipationRule | undefined;
  /** Internal `chats.id`. */
  readonly chatId: bigint;
  readonly telegramChatId: bigint;
  readonly conversationId: bigint;
  readonly message: Message;
  readonly bot: BotIdentity;
  readonly receivedAt: Date;
  readonly eligibleHuman: boolean;
}): ParticipationDecision {
  const { orm, rule, receivedAt } = options;
  if (rule === undefined) {
    return { bucketCreationAllowed: true, triggerKind: null, expiresAt: null };
  }
  // An administrator pause must not record attention either: the bucket is
  // rejected downstream, so a window would only fire once the pause is lifted.
  if (isChatPaused(orm, options.chatId)) {
    return { bucketCreationAllowed: true, triggerKind: null, expiresAt: null };
  }
  // Windows are only maintained outside active periods, so the schedule ends
  // exactly at the configured time instead of lingering for another window.
  if (isWithinActiveWindows(rule, receivedAt)) {
    return { bucketCreationAllowed: true, triggerKind: null, expiresAt: null };
  }
  const triggerKind = options.eligibleHuman ? matchTriggerKind(options.message, options.bot, rule.keywords) : null;
  if (triggerKind === null) {
    const expiresAt = attentionWindowUntil(orm, options.conversationId, receivedAt);
    return { bucketCreationAllowed: expiresAt !== null, triggerKind: null, expiresAt };
  }
  const expiresAt = new Date(receivedAt.getTime() + rule.windowSeconds * 1_000).toISOString();
  const timestamp = receivedAt.toISOString();
  const telegramMessageId = options.message.message_id;
  orm
    .insert(conversationAttention)
    .values({
      conversationId: options.conversationId,
      expiresAt,
      triggeredAt: timestamp,
      triggerKind,
      triggerTelegramMessageId: BigInt(telegramMessageId),
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: conversationAttention.conversationId,
      set: {
        expiresAt,
        triggeredAt: timestamp,
        triggerKind,
        triggerTelegramMessageId: BigInt(telegramMessageId),
        updatedAt: timestamp,
      },
    })
    .run();
  console.log(
    JSON.stringify({
      event: 'agent_attention_triggered',
      chat_id: options.telegramChatId.toString(),
      conversation_id: options.conversationId.toString(),
      trigger_kind: triggerKind,
      telegram_message_id: String(telegramMessageId),
      expires_at: expiresAt,
      at: timestamp,
    }),
  );
  return { bucketCreationAllowed: true, triggerKind, expiresAt };
}
