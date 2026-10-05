import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { and, asc, eq } from 'drizzle-orm';
import { estimateMessageTokens } from '../context/context-codec.ts';
import { isRenderable } from '../context/context-gc.ts';
import type { KeyedSemaphore } from '../platform/concurrency.ts';
import { configuredToolSchemaKeywords, resolveAgentSettings } from '../platform/config.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SystemResources } from '../platform/system-resources.ts';
import { applyToolSchemaKeywords } from '../platform/tool-schema.ts';
import { type Orm, resolveChatConfig } from '../store/database.ts';
import { parseReplayInput } from '../store/replay-input.ts';
import { chats, conversations, invocations, modelCalls } from '../store/schema.ts';
import { createReplayTools } from './replay-tools.ts';

const MAX_TRACE_BYTES = 1_048_576;
const MAX_TOOL_CALLS = 128;
const MAX_WALL_CLOCK_SECONDS = 240;
const MAX_TURNS = 20;

export class ReplayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface ReplayOptions {
  readonly orm: Orm;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly systemResources: SystemResources;
  readonly modelGate: KeyedSemaphore;
  readonly shutdownSignal: AbortSignal;
}

interface ReplayFailure {
  readonly code: string;
  readonly message: string;
}

interface ReplayToolCall {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments: unknown;
  result: unknown;
  is_error: boolean;
}

/** A fresh in-memory Pi loop. It never receives production tool executors or context writers. */
export class ReplayRunner {
  readonly #options: ReplayOptions;
  // ponytail: one replay at a time; add a separate bounded queue only if interactive demand requires it.
  #running = false;

  constructor(options: ReplayOptions) {
    this.#options = options;
  }

  async run(id: bigint, override: { readonly system_prompt?: string }, requestSignal: AbortSignal) {
    if (this.#running) {
      throw new ReplayError('replay_busy', 'Another replay is running', 429);
    }
    const { orm, configStore, secrets, systemResources, modelGate, shutdownSignal } = this.#options;
    const source = orm
      .select({
        state: invocations.state,
        finishedAt: invocations.finishedAt,
        chatId: chats.telegramChatId,
        conversationId: conversations.id,
        threadId: conversations.messageThreadId,
      })
      .from(invocations)
      .innerJoin(conversations, eq(conversations.id, invocations.conversationId))
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(eq(invocations.id, id))
      .get();
    if (source === undefined) {
      throw new ReplayError('not_found', 'Invocation not found', 404);
    }
    if (source.finishedAt === null || source.state === 'queued' || source.state === 'running') {
      throw new ReplayError('replay_source_unfinished', 'Replay requires a finished invocation');
    }
    // Never search later calls, current Context, or request_json for a replacement:
    // doing so would bypass the opt-in/clear boundary and silently change the starting point.
    const firstCall = orm
      .select({
        id: modelCalls.id,
        input: modelCalls.replayInputJson,
        provider: modelCalls.provider,
        model: modelCalls.model,
      })
      .from(modelCalls)
      .where(and(eq(modelCalls.invocationId, id), eq(modelCalls.role, 'agent')))
      .orderBy(asc(modelCalls.id))
      .limit(1)
      .get();
    if (firstCall?.input === null || firstCall === undefined) {
      throw new ReplayError(
        'replay_input_unavailable',
        'The first model request has no retained replay input; recording may have been disabled or payloads cleared',
      );
    }
    let parsed: ReturnType<typeof parseReplayInput>;
    try {
      parsed = parseReplayInput(firstCall.input);
      const last = parsed.messages.at(-1);
      if (!isRenderable(parsed.messages) || (last?.role !== 'user' && last?.role !== 'toolResult')) {
        throw new Error('Invalid starting history');
      }
    } catch {
      throw new ReplayError('replay_input_invalid', 'The retained replay input is invalid or unsupported');
    }
    const snapshot = configStore.beginInvocation();
    const config = snapshot.config;
    const chat = resolveChatConfig(config, orm, source.chatId);
    if (chat === undefined) {
      throw new ReplayError('replay_chat_unconfigured', 'The source chat is no longer configured');
    }
    const settings = resolveAgentSettings(config, chat);
    const model = snapshot.models.getModel(settings.provider, settings.model);
    if (model === undefined) {
      throw new ReplayError('replay_model_unavailable', 'The current agent model is unavailable');
    }
    const capture = createReplayTools(parsed.input, systemResources);
    const tools = applyToolSchemaKeywords(
      capture.tools,
      configuredToolSchemaKeywords(config, settings.provider, settings.model),
    );
    const systemPrompt = override.system_prompt ?? parsed.input.system_prompt;
    const maxTurns = Math.min(MAX_TURNS, config.agent.rate_limits.turns_per_injection);
    const wallClockSeconds = Math.min(MAX_WALL_CLOCK_SECONDS, config.agent.context.max_wall_clock_seconds);
    const replayId = randomUUID();
    const startedAt = new Date();
    const timeout = AbortSignal.timeout(wallClockSeconds * 1_000);
    const signal = AbortSignal.any([requestSignal, shutdownSignal, timeout]);
    let error: ReplayFailure | null = null;
    let completionReason = 'completed';
    let turns = 0;
    let traceBytes = 2;
    let partialBytes = 0;
    const trace: unknown[] = [];
    const toolCalls: ReplayToolCall[] = [];
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0 };
    const fail = (code: string, message: string): void => {
      error ??= { code, message: secrets.redact(message).slice(0, 4_096) };
      completionReason = error.code;
    };
    const redacted = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value, (_key, entry: unknown) => {
          if (typeof entry === 'string') {
            return secrets.redact(entry);
          }
          // Tool argument keys and dispatch names are model-controlled too.
          if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            return Object.fromEntries(Object.entries(entry).map(([key, child]) => [secrets.redact(key), child]));
          }
          return entry;
        }),
      );
    const agent = new Agent({
      initialState: { systemPrompt, model, thinkingLevel: settings.thinking_level, messages: parsed.messages, tools },
      sessionId: `replay-${replayId}`,
      toolExecution: 'sequential',
      streamFn: async (streamModel, context, options) => {
        signal.throwIfAborted();
        const inputTokens =
          context.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
          Math.ceil((systemPrompt.length + JSON.stringify(context.tools ?? []).length) / 4);
        if (inputTokens + streamModel.maxTokens >= streamModel.contextWindow * config.agent.context_stop_ratio) {
          fail('context_limit', 'Replay input exceeds the current model context budget');
          throw new Error('Replay context limit');
        }
        if (turns >= maxTurns) {
          fail('turn_budget', 'Replay turn budget exhausted');
          throw new Error('Replay turn budget');
        }
        const release = await modelGate.acquire(source.chatId.toString(), signal);
        try {
          signal.throwIfAborted();
          turns += 1;
          const stream = snapshot.models.streamSimple(streamModel, context, {
            ...options,
            signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
            maxTokens: streamModel.maxTokens,
            maxRetries: 0,
            maxRetryDelayMs: 0,
          });
          void stream
            .result()
            .finally(release)
            .catch(() => undefined);
          return stream;
        } catch (cause) {
          release();
          throw cause;
        }
      },
      beforeToolCall: async () => {
        if (signal.aborted || error !== null) {
          return { block: true, terminate: true, reason: 'Replay stopped' };
        }
        return undefined;
      },
      shouldStopAfterTurn: (turn) => {
        if (error !== null || signal.aborted) {
          return true;
        }
        if (turn.toolResults.some((result) => result.toolName === 'zzz' && !result.isError)) {
          completionReason = 'sleep';
          return true;
        }
        if (turn.message.content.some((block) => block.type === 'toolCall') && turns >= maxTurns) {
          fail('turn_budget', 'Replay turn budget exhausted');
          return true;
        }
        return false;
      },
    });
    agent.subscribe((event) => {
      if (event.type === 'message_start') {
        partialBytes = 0;
      } else if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta' || delta.type === 'toolcall_delta') {
          partialBytes += Buffer.byteLength(delta.delta);
          if (traceBytes + partialBytes > MAX_TRACE_BYTES) {
            fail('trace_limit', 'Replay trace exceeded its size limit');
            agent.abort();
          }
        }
      } else if (event.type === 'tool_execution_start') {
        if (error !== null || signal.aborted) {
          return;
        }
        // Pi validates arguments before beforeToolCall, so count attempted calls
        // here as well: unknown names and invalid schemas must consume the cap.
        if (toolCalls.length >= MAX_TOOL_CALLS) {
          fail('tool_budget', 'Replay tool-call budget exhausted');
          agent.abort();
          return;
        }
        toolCalls.push({
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          arguments: redacted(event.args),
          result: null,
          is_error: false,
        });
      } else if (event.type === 'tool_execution_end') {
        const call = toolCalls.findLast((entry) => entry.tool_call_id === event.toolCallId);
        if (call !== undefined) {
          const result = redacted(event.result);
          if (traceBytes + Buffer.byteLength(JSON.stringify(result)) > MAX_TRACE_BYTES) {
            fail('trace_limit', 'Replay trace exceeded its size limit');
            agent.abort();
            call.is_error = true;
          } else {
            call.result = result;
            call.is_error = event.isError;
          }
        }
      } else if (event.type === 'message_end') {
        const message = event.message;
        if (message.role === 'assistant') {
          usage.input += message.usage.input;
          usage.output += message.usage.output;
          usage.cache_read += message.usage.cacheRead;
          usage.cache_write += message.usage.cacheWrite;
          usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
          usage.cost += message.usage.cost.total;
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            fail('model_error', message.errorMessage ?? 'Model request failed');
          }
        }
        const json = JSON.stringify(redacted(message));
        traceBytes += Buffer.byteLength(json) + (trace.length > 0 ? 1 : 0);
        if (traceBytes > MAX_TRACE_BYTES) {
          fail('trace_limit', 'Replay trace exceeded its size limit');
          agent.abort();
        } else {
          trace.push(JSON.parse(json));
        }
      }
    });
    const abort = (): void => agent.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.#running = true;
    try {
      signal.throwIfAborted();
      await agent.continue();
      if (agent.state.errorMessage !== undefined) {
        fail('model_error', agent.state.errorMessage);
      }
    } catch (cause) {
      fail('replay_failed', secrets.redactError(cause));
    } finally {
      signal.removeEventListener('abort', abort);
      this.#running = false;
    }
    if (signal.aborted) {
      error = {
        code: timeout.aborted ? 'timeout' : 'aborted',
        message: timeout.aborted ? 'Replay wall-clock limit exceeded' : 'Replay cancelled',
      };
      completionReason = error.code;
    }
    return redacted({
      version: 1,
      replay_id: replayId,
      source_invocation_id: id.toString(),
      source_model_call_id: firstCall.id.toString(),
      conversation_id: source.conversationId.toString(),
      chat_id: source.chatId.toString(),
      thread_id: source.threadId.toString(),
      model: { provider: model.provider, id: model.id, thinking_level: settings.thinking_level },
      overrides: { system_prompt: override.system_prompt !== undefined },
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt.getTime(),
      completion_reason: completionReason,
      responded: capture.outputs.length > 0,
      send_count: capture.outputs.length,
      outputs: capture.outputs.map(redacted),
      tool_calls: toolCalls,
      usage: { ...usage, model_calls: turns },
      trace,
      error,
      fidelity: {
        input: 'first_model_request_text_only',
        historical_model: { provider: firstCall.provider, id: firstCall.model },
        model_selection: 'current_chat_config',
        omitted_images: parsed.input.omitted_images,
        hot_injections: 'not_replayed',
        system_resources: 'current_read_only',
        side_effects: 'synthetic',
        external_tools: 'blocked',
        memory_and_alarms: 'empty_in_memory_overlay',
        ref_authorization: 'not_revalidated',
        synthetic_validation: 'schema_only_no_world_state_checks',
        dispatch_mode: 'execution_path_not_success',
        send_nudge: 'disabled',
        production_budgets: 'not_charged',
        limits: {
          turns: maxTurns,
          tool_calls: MAX_TOOL_CALLS,
          wall_clock_seconds: wallClockSeconds,
          trace_bytes: MAX_TRACE_BYTES,
        },
        dispatches: capture.dispatches,
      },
    });
  }
}
