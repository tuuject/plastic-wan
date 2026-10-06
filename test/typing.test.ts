import { afterEach, expect, test, vi } from 'vitest';
import { Api } from 'grammy';
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
