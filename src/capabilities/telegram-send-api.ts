import type { Api } from 'grammy';
import { InputFile } from 'grammy';
import type { TelegramSendApi } from '../capabilities/send-tool.ts';

/**
 * Adapts the grammY API to the send tool's explicit surface. The two plain
 * methods pass through; the generated-picture methods map onto sendPhoto and
 * sendMediaGroup, carrying back the photo sizes the tool records for canonical
 * history. Only the fields the send tool reads are preserved.
 */
export function grammySendApi(api: Api): TelegramSendApi {
  const typingRequests = new Map<string, { at: number; pending: boolean }>();
  type SentMessage = { message_id: number; date: number; chat: { id: number }; photo?: unknown };
  const narrow = (
    message: SentMessage,
  ): {
    message_id: number;
    date: number;
    chat: { id: number };
    photo?: readonly { file_id: string; file_unique_id: string; width: number; height: number }[] | undefined;
  } => {
    const raw = message.photo;
    const sizes = Array.isArray(raw)
      ? (raw as { file_id: string; file_unique_id: string; width: number; height: number }[])
      : undefined;
    return {
      message_id: message.message_id,
      date: message.date,
      chat: message.chat,
      ...(sizes === undefined ? {} : { photo: sizes }),
    };
  };
  return {
    sendTyping: async (chatId, threadId, signal) => {
      const key = `${chatId}:${threadId}`;
      const previous = typingRequests.get(key);
      if (signal.aborted || (previous !== undefined && (previous.pending || Date.now() - previous.at < 4_000))) {
        return;
      }
      const current = { at: Date.now(), pending: true };
      typingRequests.set(key, current);
      try {
        await api.sendChatAction(
          chatId,
          'typing',
          threadId === 0n ? {} : { message_thread_id: Number(threadId) },
          // grammY still types its signal as the older abort-controller shim; it forwards abort events.
          AbortSignal.any([signal, AbortSignal.timeout(3_500)]) as unknown as Parameters<Api['sendChatAction']>[3],
        );
      } finally {
        current.pending = false;
        setTimeout(
          () => {
            if (typingRequests.get(key) === current) {
              typingRequests.delete(key);
            }
          },
          Math.max(0, current.at + 4_000 - Date.now()),
        ).unref();
      }
    },
    sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
    sendSticker: (chatId, sticker, options) => api.sendSticker(chatId, sticker, options),
    sendGeneratedPhoto: async (chatId, bytes, fileName, options) => {
      const message = await api.sendPhoto(chatId, new InputFile(Buffer.from(bytes), fileName), {
        ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
        ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
        ...(options.caption === undefined ? {} : { caption: options.caption }),
      });
      return narrow(message);
    },
    sendGeneratedPhotoGroup: async (chatId, pictures, options) => {
      const messages = await api.sendMediaGroup(
        chatId,
        pictures.map((picture, index) => ({
          type: 'photo' as const,
          media: new InputFile(Buffer.from(picture.bytes), picture.fileName),
          ...(index === 0 && options.caption !== undefined ? { caption: options.caption } : {}),
        })),
        {
          ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
          ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
        },
      );
      return messages.map(narrow);
    },
  };
}
