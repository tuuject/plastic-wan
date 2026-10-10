import type { TelegramSendApi } from './send-tool.ts';
import { startTypingLoop } from './typing.ts';

/** Matches the typing loop's own cap: a loop older than this has already stopped itself. */
const LOOP_LIFETIME_MILLISECONDS = 55_000;

/**
 * Runtime-started typing for a message that @-mentions the bot. It starts at
 * ingestion, before the bucket window closes and before any model call, so the
 * mentioner sees the status immediately. Each Chat + Topic has at most one loop;
 * a repeated mention never resets its cap. The loop ends on its own after the
 * cap, when the agent publishes into that Chat + Topic, or when the runtime
 * calls `stop` because the round ended.
 */
export class MentionTyping {
  readonly #api: TelegramSendApi;
  readonly #loops = new Map<string, { readonly stop: () => void; readonly startedAt: number }>();

  constructor(api: TelegramSendApi) {
    this.#api = api;
  }

  start(chatId: string, threadId: bigint): void {
    if (this.#api.sendTyping === undefined) {
      return;
    }
    const key = keyOf(chatId, threadId);
    const existing = this.#loops.get(key);
    if (existing !== undefined) {
      if (performance.now() - existing.startedAt < LOOP_LIFETIME_MILLISECONDS) {
        return;
      }
      existing.stop();
    }
    this.#loops.set(key, {
      ...startTypingLoop(this.#api, chatId, threadId, new AbortController().signal),
      startedAt: performance.now(),
    });
  }

  stop(chatId: string, threadId: bigint): void {
    const key = keyOf(chatId, threadId);
    this.#loops.get(key)?.stop();
    this.#loops.delete(key);
  }

  stopAll(): void {
    for (const loop of this.#loops.values()) {
      loop.stop();
    }
    this.#loops.clear();
  }

  /** Publishing a message clears Telegram's status, so the loop must not bring it back. */
  wrap(api: TelegramSendApi): TelegramSendApi {
    const afterSend =
      <Args extends readonly unknown[], Result>(
        send: (...args: Args) => Promise<Result>,
        locate: (...args: Args) => { chatId: string; threadId: number | undefined },
      ) =>
      async (...args: Args): Promise<Result> => {
        const result = await send(...args);
        const { chatId, threadId } = locate(...args);
        this.stop(chatId, BigInt(threadId ?? 0));
        return result;
      };
    return {
      ...api,
      sendMessage: afterSend(api.sendMessage.bind(api), (chatId, _text, options) => ({
        chatId,
        threadId: options.message_thread_id,
      })),
      sendSticker: afterSend(api.sendSticker.bind(api), (chatId, _sticker, options) => ({
        chatId,
        threadId: options.message_thread_id,
      })),
      ...(api.sendGeneratedPhoto === undefined
        ? {}
        : {
            sendGeneratedPhoto: afterSend(api.sendGeneratedPhoto.bind(api), (chatId, _bytes, _name, options) => ({
              chatId,
              threadId: options.message_thread_id,
            })),
          }),
      ...(api.sendGeneratedPhotoGroup === undefined
        ? {}
        : {
            sendGeneratedPhotoGroup: afterSend(api.sendGeneratedPhotoGroup.bind(api), (chatId, _pictures, options) => ({
              chatId,
              threadId: options.message_thread_id,
            })),
          }),
    };
  }
}

function keyOf(chatId: string, threadId: bigint): string {
  return `${chatId}:${threadId}`;
}
