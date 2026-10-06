import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import type { TelegramSendApi } from './send-tool.ts';

/** One invocation can start typing again after each idle boundary, never after its cap in the same round. */
export function createTyping(
  api: TelegramSendApi,
  chatId: string,
  threadId: bigint,
  signal: AbortSignal,
): { readonly tool: AgentTool; readonly stop: () => void } {
  let started = false;
  let controller: AbortController | undefined;
  let refresh: NodeJS.Timeout | undefined;
  let cap: NodeJS.Timeout | undefined;
  const clear = (): void => {
    clearInterval(refresh);
    clearTimeout(cap);
    controller?.abort();
    signal.removeEventListener('abort', stop);
  };
  const stop = (): void => {
    clear();
    started = false;
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
      if (!started && api.sendTyping !== undefined) {
        started = true;
        controller = new AbortController();
        const requestSignal = AbortSignal.any([signal, controller.signal]);
        const expiresAt = performance.now() + 55_000;
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
        refresh = setInterval(ping, 4_000);
        // Telegram retains an action for up to five seconds; leave that tail inside the 60s cap.
        cap = setTimeout(clear, 55_000);
        refresh.unref();
        cap.unref();
      }
      return { content: [{ type: 'text', text: 'Typing requested; use send to publish the reply.' }], details: {} };
    },
  };
  return { tool, stop };
}
