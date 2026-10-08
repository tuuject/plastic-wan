import { afterEach, expect, test, vi } from 'vitest';
import { Api } from 'grammy';
import { MentionTyping } from '../src/capabilities/mention-typing.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { createTyping } from '../src/capabilities/typing.ts';
import { grammySendApi } from '../src/capabilities/telegram-send-api.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  vi.useFakeTimers();
  const api = new Api('test-token');
  const action = vi.spyOn(api, 'sendChatAction').mockResolvedValue(true);
  const abort = new AbortController();
  const transport = grammySendApi(api);
  const typing = createTyping(transport, '-100123', 42n, abort.signal);
  const start = () => typing.tool.execute('typing-call', {});
  return { action, abort, transport, typing, start };
}

test('typing is opt-in and repeated calls neither duplicate refreshes nor reset the cap', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.action).not.toHaveBeenCalled();
  await f.start();
  expect(f.action).toHaveBeenCalledTimes(1);
  expect(f.action).toHaveBeenCalledWith('-100123', 'typing', { message_thread_id: 42 }, expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(40_000);
  await f.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.action).toHaveBeenCalledTimes(14);
  await f.start();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.action).toHaveBeenCalledTimes(14);
  f.typing.stop();
});

test('idle cleanup stops refreshes and a later round can start again', async () => {
  const f = fixture();
  await f.start();
  f.typing.stop();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.action).toHaveBeenCalledTimes(1);
  await f.start();
  expect(f.action).toHaveBeenCalledTimes(2);
  f.typing.stop();
});

test('abort cancels the in-flight action and a queued ping cannot run after stop', async () => {
  const f = fixture();
  f.action.mockImplementation(
    (_chat, _action, _options, signal) =>
      new Promise<true>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  await f.start();
  const requestSignal = f.action.mock.calls[0]![3]!;
  f.abort.abort();
  expect(requestSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.action).toHaveBeenCalledTimes(1);
  await expect(f.start()).rejects.toThrow('Typing cancelled');

  const other = createTyping(f.transport, '-100123', 99n, new AbortController().signal);
  const queued = other.tool.execute('queued', {});
  other.stop();
  await queued;
  expect(f.action).toHaveBeenCalledTimes(1);
});

test('the transport skips overlapping requests and throttles each chat and topic separately', async () => {
  const f = fixture();
  let finish!: (result: true) => void;
  f.action.mockImplementationOnce(
    () =>
      new Promise<true>((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.transport.sendTyping!('-100123', 42n, f.abort.signal);
  await vi.advanceTimersByTimeAsync(8_000);
  await f.transport.sendTyping!('-100123', 42n, f.abort.signal);
  expect(f.action).toHaveBeenCalledTimes(1);
  await f.transport.sendTyping!('-100123', 0n, f.abort.signal);
  expect(f.action.mock.calls[1]![2]).toEqual({});
  await f.transport.sendTyping!('-100456', 42n, f.abort.signal);
  finish(true);
  await first;
  await vi.advanceTimersByTimeAsync(0);
  await f.transport.sendTyping!('-100123', 42n, f.abort.signal);
  await f.transport.sendTyping!('-100123', 42n, f.abort.signal);
  expect(f.action).toHaveBeenCalledTimes(4);
});

test('platform failures stay cosmetic and later refreshes still run', async () => {
  const f = fixture();
  f.action.mockRejectedValue(new Error('Telegram unavailable'));
  await expect(f.start()).resolves.toBeDefined();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.action).toHaveBeenCalledTimes(3);
  f.typing.stop();
});

function mentionFixture() {
  vi.useFakeTimers();
  const api = new Api('test-token');
  const action = vi.spyOn(api, 'sendChatAction').mockResolvedValue(true);
  const sendMessage = vi.spyOn(api, 'sendMessage').mockResolvedValue({
    message_id: 1,
    date: 1,
    chat: { id: -100123, type: 'supergroup', title: 'Group' },
    text: 'hi',
  });
  const transport = grammySendApi(api);
  const mention = new MentionTyping(transport);
  return { action, sendMessage, transport, mention, wrapped: mention.wrap(transport) };
}

test('a mention shows typing immediately, refreshes, and a repeat neither duplicates nor resets the cap', async () => {
  const f = mentionFixture();
  f.mention.start('-100123', 42n);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.action).toHaveBeenCalledTimes(1);
  expect(f.action).toHaveBeenCalledWith('-100123', 'typing', { message_thread_id: 42 }, expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(40_000);
  f.mention.start('-100123', 42n);
  await vi.advanceTimersByTimeAsync(20_000);
  // One request at t=0 and one every 4s until the 55s cap: 14 in total, none from the repeat.
  expect(f.action).toHaveBeenCalledTimes(14);
  f.mention.stopAll();
});

test('a mention after the previous loop hit its cap starts a fresh one', async () => {
  const f = mentionFixture();
  f.mention.start('-100123', 0n);
  await vi.advanceTimersByTimeAsync(60_000);
  const before = f.action.mock.calls.length;
  f.mention.start('-100123', 0n);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.action).toHaveBeenCalledTimes(before + 1);
  expect(f.action.mock.calls.at(-1)![2]).toEqual({});
  f.mention.stopAll();
});

test('stop ends the loop and chats and topics are independent', async () => {
  const f = mentionFixture();
  f.mention.start('-100123', 42n);
  f.mention.start('-100123', 43n);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.action).toHaveBeenCalledTimes(2);
  f.mention.stop('-100123', 42n);
  await vi.advanceTimersByTimeAsync(8_000);
  // Only the 43 topic keeps refreshing.
  expect(
    f.action.mock.calls.filter((call) => (call[2] as { message_thread_id?: number }).message_thread_id === 42),
  ).toHaveLength(1);
  expect(
    f.action.mock.calls.filter((call) => (call[2] as { message_thread_id?: number }).message_thread_id === 43).length,
  ).toBeGreaterThan(1);
  f.mention.stopAll();
  const settled = f.action.mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.action).toHaveBeenCalledTimes(settled);
});

test('publishing into the chat and topic ends its mention status, other topics keep theirs', async () => {
  const f = mentionFixture();
  f.mention.start('-100123', 42n);
  f.mention.start('-100123', 43n);
  await vi.advanceTimersByTimeAsync(0);
  await f.wrapped.sendMessage('-100123', 'hi', { message_thread_id: 42 });
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  const afterSend = f.action.mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_000);
  const later = f.action.mock.calls.slice(afterSend);
  expect(later.length).toBeGreaterThan(0);
  expect(later.every((call) => (call[2] as { message_thread_id?: number }).message_thread_id === 43)).toBe(true);
  f.mention.stopAll();
});

test('a failed send keeps the status, and platform failures stay cosmetic', async () => {
  const f = mentionFixture();
  f.action.mockRejectedValue(new Error('Telegram unavailable'));
  f.sendMessage.mockRejectedValueOnce(new Error('send failed'));
  f.mention.start('-100123', 0n);
  await vi.advanceTimersByTimeAsync(8_000);
  await expect(f.wrapped.sendMessage('-100123', 'hi', {})).rejects.toThrow('send failed');
  const before = f.action.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.action.mock.calls.length).toBeGreaterThan(before);
  f.mention.stopAll();
});

test('hosts without chat actions get no loop and the wrapper keeps optional methods absent', async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const bare = { sendMessage: send, sendSticker: send } as unknown as TelegramSendApi;
  const mention = new MentionTyping(bare);
  mention.start('-100123', 0n);
  await vi.advanceTimersByTimeAsync(8_000);
  const wrapped = mention.wrap(bare);
  expect(wrapped.sendGeneratedPhoto).toBeUndefined();
  expect(wrapped.sendGeneratedPhotoGroup).toBeUndefined();
});
