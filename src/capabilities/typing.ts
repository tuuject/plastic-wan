import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import type { TelegramSendApi } from './send-tool.ts';

const REFRESH_MILLISECONDS = 4_000;
// Telegram retains an action for up to five seconds; leave that tail inside the 60s cap.
const CAP_MILLISECONDS = 55_000;

/**
 * Shows typing now, refreshes it until the cap, and stops on `stop()` or when
 * `signal` aborts. Platform failures stay cosmetic. Hosts without chat actions
 * get an inert loop.
 */
export function startTypingLoop(
  api: TelegramSendApi,
  chatId: string,
  threadId: bigint,
  signal: AbortSignal,
): { readonly stop: () => void } {
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const expiresAt = performance.now() + CAP_MILLISECONDS;
  let refresh: NodeJS.Timeout | undefined;
  let cap: NodeJS.Timeout | undefined;
  const stop = (): void => {
    clearInterval(refresh);
    clearTimeout(cap);
    controller.abort();
    signal.removeEventListener('abort', stop);
  };
  if (api.sendTyping === undefined) {
    return { stop };
  }
  const ping = (): void => {
    void Promise.resolve()
      .then(() => {
        if (!requestSignal.aborted && performance.now() < expiresAt) {
          return api.sendTyping?.(chatId, threadId, requestSignal);
        }
        return undefined;
      })
      .catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  ping();
  refresh = setInterval(ping, REFRESH_MILLISECONDS);
  cap = setTimeout(stop, CAP_MILLISECONDS);
  refresh.unref();
  cap.unref();
  return { stop };
}

/** One invocation can start typing again after each idle boundary, never after its cap in the same round. */
export function createTyping(
  api: TelegramSendApi,
  chatId: string,
  threadId: bigint,
  signal: AbortSignal,
): { readonly tool: AgentTool; readonly stop: () => void } {
  let loop: { readonly stop: () => void } | undefined;
  const stop = (): void => {
    loop?.stop();
    loop = undefined;
  };
  const tool: AgentTool = {
    name: 'typing',
    label: 'Start typing',
    description:
      'Show typing only after deciding to reply when search or other work will take noticeable time. Optional: send quick replies directly and stay silent when no reply is warranted. Call once before slow work; the runtime refreshes and stops the status automatically. This does not publish a reply or guarantee delivery.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _input, toolSignal) => {
      if (signal.aborted || toolSignal?.aborted) {
        throw new Error('Typing cancelled');
      }
      if (loop === undefined && api.sendTyping !== undefined) {
        loop = startTypingLoop(api, chatId, threadId, signal);
      }
      return { content: [{ type: 'text', text: 'Typing requested; use send to publish the reply.' }], details: {} };
    },
  };
  return { tool, stop };
}
