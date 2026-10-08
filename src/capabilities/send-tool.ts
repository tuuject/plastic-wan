import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { and, eq, sql } from 'drizzle-orm';
import { GrammyError, HttpError } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import Type, { type Static } from 'typebox';
import type { CapabilityRefResolver, InvocationContext } from '../platform/invocation-context.ts';
import { rejectToolCall, type SqliteStore } from '../store/database.ts';
import { imageDeliveryState } from '../store/image-delivery.ts';
import {
  chats,
  invocations,
  media,
  messageRevisions,
  messages,
  senders,
  stickers,
  telegramSends,
  toolCalls,
} from '../store/schema.ts';

export const SendInputSchema = Type.Object(
  {
    kind: Type.Optional(Type.Enum({ text: 'text', sticker: 'sticker', image: 'image' })),
    resend: Type.Optional(Type.Boolean()),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    parse_mode: Type.Optional(Type.Literal('MarkdownV2')),
    sticker_ref: Type.Optional(Type.String({ minLength: 1 })),
    image_generation_id: Type.Optional(Type.String({ pattern: '^[0-9a-f-]{36}$' })),
    reply_to_message_id: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  },
  { additionalProperties: false },
);

/** A 429 retry that the send barrier stopped before it reached Telegram. */
class SendHeldBack extends Error {}

/**
 * Tool error for a send held back by the barrier. The new batch is injected at
 * the next turn boundary, so the model reads it right after this result.
 */
export const SEND_BARRIER_TEXT =
  'Not sent: new messages arrived in this conversation before this reply went out. They follow as a new batch; read them, then decide again what, if anything, to send. One message can answer both batches when they continue the same discussion; when they are separate discussions, answer each with its own send.';

export type SendToolInput =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly parse_mode?: 'MarkdownV2';
      readonly reply_to_message_id?: string;
    }
  | { readonly kind: 'sticker'; readonly sticker_ref: string; readonly reply_to_message_id?: string }
  | {
      readonly kind: 'image';
      readonly image_generation_id: string;
      readonly resend?: boolean;
      readonly text?: string;
      readonly reply_to_message_id?: string;
    };

function narrowSendInput(input: Static<typeof SendInputSchema>): SendToolInput | undefined {
  const kind =
    input.kind ??
    (input.text !== undefined && input.sticker_ref === undefined && input.image_generation_id === undefined
      ? 'text'
      : undefined);
  if (
    kind === undefined ||
    (kind === 'sticker' && input.parse_mode !== undefined) ||
    (kind !== 'image' && input.resend !== undefined)
  ) {
    return undefined;
  }
  const reply = input.reply_to_message_id === undefined ? {} : { reply_to_message_id: input.reply_to_message_id };
  if (kind === 'text') {
    if (input.text === undefined) {
      return undefined;
    }
    const parseMode = input.parse_mode !== undefined ? { parse_mode: input.parse_mode } : {};
    return { kind, text: input.text, ...parseMode, ...reply };
  }
  if (kind === 'sticker') {
    if (input.sticker_ref === undefined) {
      return undefined;
    }
    return { kind, sticker_ref: input.sticker_ref, ...reply };
  }
  if (input.image_generation_id === undefined) {
    return undefined;
  }
  const caption = input.text === undefined ? {} : { text: input.text };
  return {
    kind: 'image',
    image_generation_id: input.image_generation_id,
    ...(input.resend === undefined ? {} : { resend: input.resend }),
    ...caption,
    ...reply,
  };
}

interface TelegramSendResponse {
  readonly message_id: number;
  readonly date: number;
  readonly chat: { readonly id: number };
  /** Sizes of a sent photo (largest last); present on image deliveries. */
  readonly photo?:
    | readonly {
        readonly file_id: string;
        readonly file_unique_id: string;
        readonly width: number;
        readonly height: number;
      }[]
    | undefined;
}

export interface TelegramSendApi {
  /** Cosmetic status only; hosts without chat actions can omit it. */
  sendTyping?(chatId: string, threadId: bigint, signal: AbortSignal): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    options: {
      readonly message_thread_id?: number;
      readonly parse_mode?: 'MarkdownV2';
      readonly reply_parameters?: { readonly message_id: number };
      readonly entities?: MessageEntity[];
    },
  ): Promise<TelegramSendResponse>;
  sendSticker(
    chatId: string,
    sticker: string,
    options: {
      readonly message_thread_id?: number;
      readonly reply_parameters?: { readonly message_id: number };
    },
  ): Promise<TelegramSendResponse>;
  /**
   * Delivers one generated picture. Optional so hosts that never ship image
   * generation can reuse this interface; the send tool rejects image sends
   * with a clear error when it is missing.
   */
  sendGeneratedPhoto?(
    chatId: string,
    bytes: Uint8Array,
    fileName: string,
    options: {
      readonly message_thread_id?: number;
      readonly reply_parameters?: { readonly message_id: number };
      readonly caption?: string;
    },
  ): Promise<TelegramSendResponse>;
  /** Delivers several pictures of one generation as a single album. */
  sendGeneratedPhotoGroup?(
    chatId: string,
    pictures: readonly { readonly bytes: Uint8Array; readonly fileName: string }[],
    options: {
      readonly message_thread_id?: number;
      readonly reply_parameters?: { readonly message_id: number };
      readonly caption?: string;
    },
  ): Promise<TelegramSendResponse[]>;
}

export interface SendToolEnvironment {
  readonly store: SqliteStore;
  readonly api: TelegramSendApi;
  readonly context: InvocationContext;
  readonly capabilities: CapabilityRefResolver;
  /**
   * Sliding-window send rate limit, applied per Telegram chat: a long-lived
   * invocation may legitimately send many times, but a loop must never flood
   * one group.
   */
  readonly sendRateLimit: { readonly sendsPerWindow: number; readonly windowSeconds: number };
  readonly maxTextLength: number | undefined;
  readonly disallowBlankLines: boolean;
  readonly allowReplyMessageMultipleTimes?: boolean;
  readonly deadline: number;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
  /**
   * Send barrier: returns true when this send must not go out because newer
   * messages of the conversation are about to be injected. Absent when the
   * barrier is off.
   */
  readonly holdForNewMessages?: () => boolean;
  /**
   * Resolves a generated picture set for delivery. Authorization is the
   * generation's owning conversation: `undefined` for unknown or foreign ids.
   * Absent when the host runs without image generation.
   */
  readonly imageGeneration?: {
    readonly resolve: (
      generationId: string,
      conversationId: bigint,
    ) => readonly { readonly assetId: string; readonly bytes: Uint8Array; readonly fileName: string }[] | undefined;
  };
}

function completionMention(
  completion: InvocationContext['completion'],
): { readonly text: string; readonly entity: MessageEntity; readonly url: string } | null {
  const target = completion?.delivery.mentionUser;
  if (target === undefined) {
    return null;
  }
  const text = target.displayName.length > 0 ? `@${target.displayName}` : `@${target.userId.toString()}`;
  const url = `tg://user?id=${target.userId.toString()}`;
  return {
    text,
    url,
    entity: {
      type: 'text_link',
      offset: 0,
      length: text.length,
      url,
    },
  };
}

function escapeMarkdownV2LinkText(text: string): string {
  return text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, (character) => `\\${character}`);
}

export function createSendTool(
  environment: SendToolEnvironment,
): AgentTool<typeof SendInputSchema, { telegramMessageId: string; replayed?: boolean }> {
  const mentionedTasks = new Set<bigint>();
  const replyPolicy =
    environment.allowReplyMessageMultipleTimes === true
      ? 'Current configuration permits multiple replies to the same message; each send must still be warranted.'
      : 'Each message may receive at most one reply across text, stickers, and images, even across later invocations; changing the content or setting resend:true does not permit another reply. A pending or unknown earlier reply also blocks a new one. Do not omit or change reply_to_message_id to bypass a rejected duplicate.';
  const textConstraints = [
    environment.maxTextLength === undefined
      ? 'Text must fit the schema limit.'
      : `Text must not exceed ${environment.maxTextLength} characters.`,
    environment.disallowBlankLines ? 'Text must not contain blank lines; use single newlines between paragraphs.' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  return {
    name: 'send',
    label: 'Send to Telegram',
    description: `Publish exactly one warranted user-visible Telegram message or sticker. Use this only after deciding the new messages or a current task completion require a reply, clarification, or confirmation; do not use it merely because the tool is available, to answer history-only content, or to publish private reasoning. Keep the message concise and self-contained. For text, kind may be omitted; omit parse_mode for plain text, or set parse_mode to MarkdownV2 only when the text is correctly escaped. ${textConstraints} For generated images, use kind:image with image_generation_id from this conversation. Already delivered outputs are not sent again; a replayed result reports the earlier delivery, not a new message. Set resend:true only when a new user message explicitly asks to resend those pictures, never just to handle a completion receipt or retry an unknown outcome. For a sticker, kind must be sticker and sticker_ref must be a stk_ value returned by the search_stickers capability (via execute); img_ refs cannot be sent. Set reply_to_message_id only to a message visible in this conversation, preferring the relevant new message; when several separate discussions are active, set it on every message so each reply is visibly attached to the one it answers. ${replyPolicy} Success means Telegram accepted the send; if the tool fails or reports an unknown outcome, do not claim it was sent and do not blindly retry. One batch of new messages may hold several separate discussions among different people: keep one message to one discussion, calling send once per discussion you choose to answer rather than merging unrelated discussions into a single message, and leave a discussion unanswered when you have nothing to add to it. Still do not split one answer across several messages; repeated sends are rate limited per chat.`,
    parameters: SendInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const send = narrowSendInput(input);
      if (send === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'send_input_invalid');
        throw new Error('send input fields do not match its kind');
      }
      const replyTarget =
        send.reply_to_message_id === undefined
          ? undefined
          : environment.capabilities.resolveReplyTarget(send.reply_to_message_id);
      if (send.reply_to_message_id !== undefined && replyTarget === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'reply_not_visible');
        throw new Error('reply_to_message_id is not visible in this conversation context');
      }
      const targetConversationId = replyTarget?.conversationId ?? environment.context.conversationId;
      const targetThreadId = replyTarget?.threadId ?? environment.context.threadId;
      const completion = environment.context.completion;
      let mention: { readonly text: string; readonly entity: MessageEntity; readonly url: string } | null = null;
      let sendText = '';
      if (send.kind === 'text') {
        if (completion !== null && !mentionedTasks.has(completion.taskId)) {
          mention = completionMention(completion);
        }
        if (mention === null) {
          sendText = send.text;
        } else if (send.parse_mode === 'MarkdownV2') {
          // Telegram rejects `entities` together with `parse_mode`, so a
          // MarkdownV2 first contact encodes the target mention as an inline
          // `[text](tg://user?id=...)` link and keeps parse_mode intact.
          sendText = `[${escapeMarkdownV2LinkText(mention.text)}](${mention.url}) ${send.text}`;
        } else {
          sendText = `${mention.text} ${send.text}`;
        }
        if (environment.maxTextLength !== undefined && sendText.length > environment.maxTextLength) {
          recordRejectedSend(environment, toolCallId, input, 'send_text_too_long');
          throw new Error(
            `text length ${sendText.length} exceeds the configured limit of ${environment.maxTextLength} characters`,
          );
        }
        if (environment.disallowBlankLines && /\n[ \t]*\n/.test(sendText)) {
          recordRejectedSend(environment, toolCallId, input, 'send_blank_lines');
          throw new Error('text must not contain blank lines; separate paragraphs with single newlines');
        }
      }
      const stickerFileId =
        send.kind === 'sticker' ? environment.capabilities.resolveStickerRef(send.sticker_ref) : undefined;
      if (send.kind === 'sticker' && stickerFileId === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'sticker_ref_not_authorized');
        throw new Error('sticker_ref is not authorized in this conversation context');
      }
      let resolvedPictures: ReturnType<NonNullable<SendToolEnvironment['imageGeneration']>['resolve']>;
      try {
        resolvedPictures =
          send.kind === 'image'
            ? environment.imageGeneration?.resolve(send.image_generation_id, environment.context.conversationId)
            : undefined;
      } catch {
        recordRejectedSend(environment, toolCallId, input, 'image_generation_unavailable');
        throw new Error('image_generation_unavailable: generated output files could not be read');
      }
      let generationPictures =
        send.kind === 'image' ? (resolvedPictures === undefined ? [] : resolvedPictures) : undefined;
      if (send.kind === 'image' && resolvedPictures === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'image_generation_not_authorized');
        throw new Error(
          'image_generation_id does not name a finished generation of this conversation; use ids from tool results or receipts here',
        );
      }
      if (send.kind === 'image' && (generationPictures?.length ?? 0) === 0) {
        recordRejectedSend(environment, toolCallId, input, 'image_generation_no_outputs');
        throw new Error('that generation produced no pictures to send');
      }
      if (send.kind === 'image' && (send.text?.length ?? 0) > 1024) {
        recordRejectedSend(environment, toolCallId, input, 'send_caption_too_long');
        throw new Error('image caption must not exceed 1024 characters');
      }
      // A cancelled or expired run must not start a side effect: the model may
      // have queued this call before the abort or deadline landed.
      if (signal?.aborted === true || Date.now() >= environment.deadline) {
        const errorCode = signal?.aborted === true ? 'aborted' : 'deadline_exceeded';
        recordRejectedSend(environment, toolCallId, input, errorCode);
        throw new Error(`Not sent: ${errorCode}`);
      }
      if (send.kind === 'image' && generationPictures !== undefined) {
        if (send.resend === true && (completion !== null || environment.context.callerUserId === null)) {
          recordRejectedSend(environment, toolCallId, input, 'image_resend_requires_user');
          throw new Error('resend:true requires an explicit new user request, not a completion receipt');
        }
        const delivery = imageDeliveryState(environment.store.orm, targetConversationId, send.image_generation_id);
        // A prior uncertain attempt is not permission to try again, even when a
        // model asks for a resend. The user must resolve that outcome first.
        if (delivery.unknownAssets || generationPictures.some((picture) => delivery.uncertain.has(picture.assetId))) {
          recordRejectedSend(environment, toolCallId, input, 'image_delivery_unknown');
          throw new Error('An earlier image delivery is pending or has an unknown outcome; do not resend blindly');
        }
        if (send.resend !== true) {
          const messageIds = [
            ...new Set(
              generationPictures.flatMap((picture) => {
                const messageId = delivery.delivered.get(picture.assetId);
                return messageId === undefined ? [] : [messageId];
              }),
            ),
          ];
          const firstMessageId = messageIds[0];
          generationPictures = generationPictures.filter((picture) => !delivery.delivered.has(picture.assetId));
          if (generationPictures.length === 0 && firstMessageId !== undefined) {
            const text = `Images already delivered; Telegram delivery message(s): ${messageIds.join(', ')}. No new message was sent.`;
            const now = new Date().toISOString();
            environment.store.orm
              .insert(toolCalls)
              .values({
                invocationId: environment.context.invocationId,
                toolCallId,
                toolName: 'send',
                argumentsJson: JSON.stringify(send),
                state: 'success',
                sideEffect: false,
                resultText: text,
                createdAt: now,
                finishedAt: now,
              })
              .run();
            return {
              content: [{ type: 'text', text }],
              details: { telegramMessageId: firstMessageId, replayed: true },
            };
          }
        }
      }
      const rejectDuplicateReply = (): { error: string } | undefined => {
        if (environment.allowReplyMessageMultipleTimes !== true && send.reply_to_message_id !== undefined) {
          const previous = environment.store.orm
            .select({ state: telegramSends.state })
            .from(telegramSends)
            .where(
              and(
                eq(telegramSends.conversationId, targetConversationId),
                sql`json_extract(${telegramSends.requestJson}, '$.reply_to_message_id') = ${send.reply_to_message_id}`,
                sql`${telegramSends.state} IN ('success', 'pending', 'outcome_unknown')`,
              ),
            )
            // A success does not resolve another pending or uncertain attempt.
            .orderBy(sql`${telegramSends.state} = 'success'`)
            .limit(1)
            .get();
          if (previous !== undefined) {
            const errorCode = previous.state === 'success' ? 'reply_already_sent' : 'reply_delivery_unknown';
            recordRejectedSend(environment, toolCallId, input, errorCode);
            return {
              error:
                previous.state === 'success'
                  ? 'Not sent: reply_already_sent. This message has already been replied to. Do not send another reply or bypass this by omitting or changing reply_to_message_id.'
                  : 'Not sent: reply_delivery_unknown. An earlier reply to this message is pending or has an unknown outcome. Do not retry or bypass this by omitting or changing reply_to_message_id.',
            };
          }
        }
        return undefined;
      };
      // Reject known duplicates before spending the barrier. The barrier commits
      // bucket attachments before queueing them in memory, so it must run outside
      // the send transaction: a later audit failure must not undo those attachments.
      const duplicate = rejectDuplicateReply();
      if (duplicate !== undefined) {
        throw new Error(duplicate.error);
      }
      if (environment.holdForNewMessages?.() === true) {
        recordRejectedSend(environment, toolCallId, input, 'send_barrier');
        throw new Error(SEND_BARRIER_TEXT);
      }
      const pending = environment.store.transaction(() => {
        // Recheck under the write lock and claim with the pending send atomically.
        // The retained audit survives context resets and restarts.
        const duplicate = rejectDuplicateReply();
        if (duplicate !== undefined) {
          return duplicate;
        }
        const now = new Date().toISOString();
        const createdToolCall = environment.store.orm
          .insert(toolCalls)
          .values({
            invocationId: environment.context.invocationId,
            toolCallId,
            toolName: 'send',
            argumentsJson: JSON.stringify(send),
            state: 'pending',
            sideEffect: true,
            createdAt: now,
          })
          .returning({ id: toolCalls.id })
          .get();
        if (createdToolCall === undefined) {
          throw new Error('tool_calls insert returned no row');
        }
        const toolId = createdToolCall.id;
        if (recentSendCount(environment, new Date()) >= environment.sendRateLimit.sendsPerWindow) {
          environment.store.orm
            .update(toolCalls)
            .set({ state: 'error', errorCode: 'send_rate_limited', finishedAt: now })
            .where(eq(toolCalls.id, toolId))
            .run();
          return {
            error: `send rate limit of ${environment.sendRateLimit.sendsPerWindow} per ${environment.sendRateLimit.windowSeconds}s window reached`,
          };
        }
        // Audit counters, not a limit: the sliding window above is the brake.
        // `side_effect_started` marks the invocation from the moment a send is
        // attempted, which is what turns a crash into `outcome_unknown`.
        environment.store.orm
          .update(invocations)
          .set({ sendsUsed: sql`${invocations.sendsUsed} + 1`, sideEffectStarted: true })
          .where(eq(invocations.id, environment.context.invocationId))
          .run();
        const createdSend = environment.store.orm
          .insert(telegramSends)
          .values({
            toolCallId: toolId,
            conversationId: targetConversationId,
            kind: send.kind,
            requestJson: JSON.stringify({
              kind: send.kind,
              reply_to_message_id: send.reply_to_message_id ?? null,
              ...(send.kind === 'image'
                ? {
                    generation_id: send.image_generation_id,
                    pictures: generationPictures?.length ?? 0,
                    asset_ids: generationPictures?.map((picture) => picture.assetId) ?? [],
                    resend: send.resend === true,
                  }
                : {}),
            }),
            state: 'pending',
            createdAt: now,
          })
          .returning({ id: telegramSends.id })
          .get();
        if (createdSend === undefined) {
          throw new Error('telegram_sends insert returned no row');
        }
        return { toolId, sendId: createdSend.id };
      });
      if ('error' in pending) {
        throw new Error(pending.error);
      }
      const sendId = pending.sendId;
      const options = {
        ...(targetThreadId === 0n ? {} : { message_thread_id: Number(targetThreadId) }),
        ...(send.reply_to_message_id === undefined
          ? {}
          : { reply_parameters: { message_id: Number(send.reply_to_message_id) } }),
        ...(send.kind === 'text' && send.parse_mode !== undefined ? { parse_mode: send.parse_mode } : {}),
        ...(send.kind === 'text' && mention !== null && send.parse_mode !== 'MarkdownV2'
          ? { entities: [mention.entity] }
          : {}),
      };
      const startedAt = performance.now();
      let response: TelegramSendResponse;
      try {
        while (true) {
          try {
            if (send.kind === 'text') {
              response = await environment.api.sendMessage(environment.context.chatId.toString(), sendText, options);
              break;
            }
            if (stickerFileId !== undefined) {
              response = await environment.api.sendSticker(
                environment.context.chatId.toString(),
                stickerFileId,
                options,
              );
              break;
            }
            if (generationPictures !== undefined) {
              const pictures = generationPictures;
              const sendPhoto = environment.api.sendGeneratedPhoto;
              const sendPhotoGroup = environment.api.sendGeneratedPhotoGroup;
              if (sendPhoto === undefined || sendPhotoGroup === undefined) {
                throw new Error('picture delivery is not wired into this runtime');
              }
              const caption = send.kind === 'image' && send.text !== undefined ? { caption: send.text } : {};
              const responses =
                pictures.length === 1
                  ? [
                      await sendPhoto(
                        environment.context.chatId.toString(),
                        pictures[0]?.bytes ?? new Uint8Array(),
                        pictures[0]?.fileName ?? 'image.png',
                        { ...options, ...caption },
                      ),
                    ]
                  : await sendPhotoGroup(
                      environment.context.chatId.toString(),
                      pictures.map((picture) => ({ bytes: picture.bytes, fileName: picture.fileName })),
                      { ...options, ...caption },
                    );
              const first = responses[0];
              if (first === undefined) {
                throw new Error('Telegram returned no message for the delivered pictures');
              }
              response = first;
              break;
            }
            throw new Error('sticker_ref is not authorized in this conversation context');
          } catch (error) {
            if (!(error instanceof GrammyError) || error.error_code !== 429) {
              throw error;
            }
            const retryAfter = error.parameters.retry_after;
            if (retryAfter === undefined || Date.now() + retryAfter * 1000 >= environment.deadline) {
              throw error;
            }
            await delay(retryAfter * 1000, undefined, { signal });
            // Messages that arrived during the wait make this reply stale, just
            // as they would have before the first attempt.
            if (environment.holdForNewMessages?.() === true) {
              throw new SendHeldBack();
            }
          }
        }
      } catch (error) {
        const held = error instanceof SendHeldBack;
        const unknown = error instanceof HttpError || (error instanceof GrammyError && error.error_code >= 500);
        const errorCode = held
          ? 'send_barrier'
          : error instanceof GrammyError
            ? `telegram_${error.error_code}`
            : error instanceof HttpError
              ? 'telegram_network'
              : signal?.aborted
                ? 'aborted'
                : 'send_error';
        environment.store.transaction(() => {
          const now = new Date().toISOString();
          const state = unknown ? 'outcome_unknown' : 'error';
          environment.store.orm
            .update(toolCalls)
            .set({
              state,
              errorCode,
              durationMs: BigInt(Math.round(performance.now() - startedAt)),
              finishedAt: now,
            })
            .where(eq(toolCalls.id, pending.toolId))
            .run();
          environment.store.orm
            .update(telegramSends)
            .set({ state, errorCode, finishedAt: now })
            .where(eq(telegramSends.id, sendId))
            .run();
        });
        throw new Error(
          held
            ? SEND_BARRIER_TEXT
            : unknown
              ? 'Telegram send outcome is unknown'
              : `Telegram send failed: ${errorCode}`,
        );
      }
      if (mention !== null && completion !== null) {
        mentionedTasks.add(completion.taskId);
      }
      // Telegram has accepted the message from here on. A failure to record it
      // must not read as a failed send, or the model would send it again.
      const now = new Date().toISOString();
      const markAccepted = (): void => {
        environment.store.orm
          .update(toolCalls)
          .set({
            state: 'success',
            resultText: `telegram_message_id=${response.message_id}`,
            durationMs: BigInt(Math.round(performance.now() - startedAt)),
            finishedAt: now,
          })
          .where(eq(toolCalls.id, pending.toolId))
          .run();
        environment.store.orm
          .update(telegramSends)
          .set({
            state: 'success',
            telegramMessageId: BigInt(response.message_id),
            responseJson: JSON.stringify({ message_id: response.message_id }),
            finishedAt: now,
          })
          .where(eq(telegramSends.id, sendId))
          .run();
      };
      try {
        environment.store.transaction(() => {
          markAccepted();
          recordOutgoingMessage(
            environment,
            response,
            send,
            stickerFileId ?? null,
            targetConversationId,
            sendText,
            now,
          );
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'send_record_failed',
            invocation_id: environment.context.invocationId.toString(),
            telegram_message_id: String(response.message_id),
            error: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          }),
        );
        // Keep at least the accepted outcome when only the outgoing-message
        // record failed; if the store itself is failing, the log is the record.
        try {
          markAccepted();
        } catch {}
      }
      return {
        content: [{ type: 'text', text: `Sent Telegram message ${response.message_id}` }],
        details: { telegramMessageId: String(response.message_id) },
      };
    },
  };
}

/**
 * Send attempts that reached Telegram in this chat inside the rate-limit window.
 * Every state counts, including pending, unknown and error: those are exactly
 * what a runaway loop piles up during a Telegram hiccup or when every attempt is
 * rejected (a MarkdownV2 escape the model keeps getting wrong, for example).
 */
function recentSendCount(environment: SendToolEnvironment, now: Date): number {
  const since = new Date(now.getTime() - environment.sendRateLimit.windowSeconds * 1_000).toISOString();
  const row = environment.store.db
    .prepare<[bigint, string], { count: bigint }>(
      `SELECT COUNT(*) AS count
       FROM telegram_sends ts
       JOIN conversations v ON v.id = ts.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE c.telegram_chat_id = ?
         AND ts.created_at >= ?`,
    )
    .get(environment.context.chatId, since);
  return Number(row?.count ?? 0n);
}

function recordRejectedSend(
  environment: SendToolEnvironment,
  toolCallId: string,
  input: unknown,
  errorCode: string,
): void {
  rejectToolCall(
    environment.store.orm,
    environment.context.invocationId,
    toolCallId,
    'send',
    JSON.stringify(input),
    true,
    errorCode,
  );
}

function recordOutgoingMessage(
  environment: SendToolEnvironment,
  response: TelegramSendResponse,
  input: SendToolInput,
  stickerFileId: string | null,
  conversationId: bigint,
  sentText: string,
  recordedAt: string,
): void {
  environment.store.orm
    .insert(senders)
    .values({
      telegramType: 'user',
      telegramId: environment.bot.id,
      displayName: environment.bot.displayName,
      username: environment.bot.username,
      isBot: true,
      updatedAt: recordedAt,
    })
    .onConflictDoUpdate({
      target: [senders.telegramType, senders.telegramId],
      set: {
        displayName: sql`excluded.display_name`,
        username: sql`excluded.username`,
        isBot: true,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run();
  const sender = environment.store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(and(eq(senders.telegramType, 'user'), eq(senders.telegramId, environment.bot.id)))
    .get();
  if (sender === undefined) {
    throw new Error('Bot sender row is missing after upsert');
  }
  const chat = environment.store.orm
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.telegramChatId, environment.context.chatId))
    .get();
  if (chat === undefined) {
    throw new Error('Outgoing chat row does not exist');
  }
  const createdMessage = environment.store.orm
    .insert(messages)
    .values({
      conversationId,
      chatId: chat.id,
      telegramMessageId: BigInt(response.message_id),
      visible: true,
      sentByBot: true,
      telegramDate: new Date(response.date * 1000).toISOString(),
      receivedAt: recordedAt,
    })
    .returning({ id: messages.id })
    .get();
  if (createdMessage === undefined) {
    throw new Error('messages insert returned no row');
  }
  const messageId = createdMessage.id;
  const createdRevision = environment.store.orm
    .insert(messageRevisions)
    .values({
      messageId,
      revisionNo: 1n,
      senderId: sender.id,
      kind: input.kind,
      text: input.kind === 'text' ? sentText : null,
      caption: input.kind === 'image' ? (input.text ?? null) : null,
      replyToMessageId: input.reply_to_message_id === undefined ? null : BigInt(input.reply_to_message_id),
      createdAt: recordedAt,
      rawFragmentJson: JSON.stringify({
        message_id: response.message_id,
        kind: input.kind,
        ...(input.kind === 'image' ? { generation_id: input.image_generation_id } : {}),
      }),
    })
    .returning({ id: messageRevisions.id })
    .get();
  if (createdRevision === undefined) {
    throw new Error('message_revisions insert returned no row');
  }
  const revisionId = createdRevision.id;
  environment.store.orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
  if (input.kind === 'image' && response.photo !== undefined && response.photo.length > 0) {
    const largest = response.photo[response.photo.length - 1];
    if (largest !== undefined) {
      environment.store.orm
        .insert(media)
        .values({
          revisionId,
          kind: 'photo',
          fileId: largest.file_id,
          fileUniqueId: largest.file_unique_id,
          mimeType: 'image/jpeg',
          width: BigInt(largest.width),
          height: BigInt(largest.height),
          telegramJson: JSON.stringify({ sent: true, generated: true }),
        })
        .run();
    }
  }
  if (input.kind === 'sticker' && stickerFileId !== null) {
    const sticker = environment.store.orm
      .select({ fileUniqueId: stickers.fileUniqueId })
      .from(stickers)
      .where(eq(stickers.fileId, stickerFileId))
      .get();
    if (sticker !== undefined) {
      environment.store.orm
        .insert(media)
        .values({
          revisionId,
          kind: 'sticker',
          fileId: stickerFileId,
          fileUniqueId: sticker.fileUniqueId,
          mimeType: 'image/webp',
          telegramJson: JSON.stringify({ sent: true }),
        })
        .run();
    }
  }
}
