import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { and, asc, eq } from 'drizzle-orm';
import { composeAgentPrompt, preparePromptOverride, PromptOverrideError } from '../platform/agent-prompt.ts';
import { estimateMessageTokens } from '../context/context-codec.ts';
import { isRenderable } from '../context/context-gc.ts';
import type { KeyedSemaphore } from '../platform/concurrency.ts';
import {
  type AgentSettings,
  configuredToolSchemaKeywords,
  type RawConfig,
  resolveAgentSettings,
} from '../platform/config.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SystemResources } from '../platform/system-resources.ts';
import { applyToolSchemaKeywords } from '../platform/tool-schema.ts';
import { type Orm, resolveChatConfig } from '../store/database.ts';
import { parseReplayInput, replayPromptParts, type ReplayInput } from '../store/replay-input.ts';
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

/** Prompt overrides for one replay; absent means the recorded layer is kept. */
export interface ReplayPromptOverrides {
  readonly global_prompt?: string;
  readonly group_prompt?: string;
}

/** One replayable source: the finished invocation and its retained first request. */
interface ReplaySource {
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
}

interface ReplayCall {
  readonly id: bigint;
  readonly provider: string;
  readonly model: string;
  readonly input: string | null;
}

interface ReplayRuntime {
  readonly snapshot: InvocationConfigSnapshot;
  readonly settings: AgentSettings;
  readonly model: Model<Api>;
}

type ReplayCheck =
  | {
      readonly ok: true;
      readonly source: ReplaySource;
      readonly call: ReplayCall;
      readonly input: ReplayInput;
      readonly messages: ReturnType<typeof parseReplayInput>['messages'];
    }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly call: ReplayCall | null };

type ReplayRuntimeCheck =
  | { readonly ok: true; readonly runtime: ReplayRuntime }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * What a caller can learn about a replay before running one. `fidelity` mirrors
 * the run result's own fidelity block for the checks that happen before any
 * model request; the fields that only exist after a run are not invented here.
 */
export interface ReplayPreflight {
  readonly available: boolean;
  readonly reason: string | null;
  readonly message: string | null;
  readonly source_model_call_id: string | null;
  readonly historical_model: { readonly provider: string; readonly id: string } | null;
  readonly prompt_overrides_available: boolean;
  readonly omitted_images: number | null;
  readonly recording_enabled: boolean;
  readonly fidelity: {
    readonly input: 'first_model_request_text_only';
    readonly model_selection: 'current_chat_config';
    readonly hot_injections: 'not_replayed';
    readonly external_tools: 'blocked';
    readonly system_resources: 'current_read_only';
    readonly side_effects: 'synthetic';
  };
}

/** The recorded global and group prompt templates; the runtime-owned layers are not returned. */
export interface ReplayPrompts {
  readonly source: 'recorded';
  readonly source_invocation_id: string;
  readonly source_model_call_id: string;
  readonly global_prompt: string;
  readonly group_prompt: string;
  readonly template_values: {
    readonly agent: { readonly provider: string; readonly model: string };
    readonly vision: { readonly provider: string; readonly model: string };
    readonly timezone: string;
  };
  readonly core_read_only: true;
}

const PREFLIGHT_FIDELITY = {
  input: 'first_model_request_text_only',
  model_selection: 'current_chat_config',
  hot_injections: 'not_replayed',
  external_tools: 'blocked',
  system_resources: 'current_read_only',
  side_effects: 'synthetic',
} as const;

/** A fresh in-memory Pi loop. It never receives production tool executors or context writers. */
export class ReplayRunner {
  readonly #options: ReplayOptions;
  // ponytail: one replay at a time; add a separate bounded queue only if interactive demand requires it.
  #running = false;

  constructor(options: ReplayOptions) {
    this.#options = options;
  }

  /**
   * The read-only preflight for one invocation: the same source and runtime
   * guards `run` applies, resolved without any model request. A missing
   * invocation still throws; every other failure is reported in the result so a
   * panel or CLI can explain it.
   */
  inspect(id: bigint): ReplayPreflight {
    const recordingEnabled = this.#options.configStore.current().config.developer.record_model_payloads;
    const check = this.#checkSource(id);
    if (!check.ok) {
      return {
        available: false,
        reason: check.code,
        message: check.message,
        source_model_call_id: check.call === null ? null : check.call.id.toString(),
        historical_model: check.call === null ? null : { provider: check.call.provider, id: check.call.model },
        prompt_overrides_available: false,
        omitted_images: null,
        recording_enabled: recordingEnabled,
        fidelity: PREFLIGHT_FIDELITY,
      };
    }
    const runtime = this.#checkRuntime(check.source);
    const promptParts = replayPromptParts(check.input);
    return {
      available: runtime.ok,
      reason: runtime.ok ? null : runtime.code,
      message: runtime.ok ? null : runtime.message,
      source_model_call_id: check.call.id.toString(),
      historical_model: { provider: check.call.provider, id: check.call.model },
      prompt_overrides_available: promptParts !== null,
      omitted_images: check.input.omitted_images,
      recording_enabled: recordingEnabled,
      fidelity: PREFLIGHT_FIDELITY,
    };
  }

  /**
   * The global and group templates as they were recorded, with the values their
   * variables rendered with. Version 1 records never retained layers, so they
   * are reported as unavailable instead of being guessed from current
   * configuration or the assembled prompt string.
   */
  prompts(id: bigint): ReplayPrompts {
    const check = this.#checkSource(id);
    if (!check.ok) {
      throw new ReplayError(check.code, check.message);
    }
    const parts = replayPromptParts(check.input);
    if (parts === null) {
      throw new ReplayError(
        'replay_prompt_parts_unavailable',
        'The invocation was recorded before prompt layers were retained; only an as-recorded replay is available',
      );
    }
    return {
      source: 'recorded',
      source_invocation_id: id.toString(),
      source_model_call_id: check.call.id.toString(),
      global_prompt: parts.global,
      group_prompt: parts.group,
      template_values: parts.template_values,
      core_read_only: true,
    };
  }

  async run(id: bigint, override: ReplayPromptOverrides, requestSignal: AbortSignal) {
    if (this.#running) {
      throw new ReplayError('replay_busy', 'Another replay is running', 429);
    }
    // Never search later calls, current Context, or request_json for a replacement:
    // doing so would bypass the opt-in/clear boundary and silently change the starting point.
    const check = this.#checkSource(id);
    if (!check.ok) {
      throw new ReplayError(check.code, check.message);
    }
    const { source, call } = check;
    const parts = replayPromptParts(check.input);
    const wantsOverride = override.global_prompt !== undefined || override.group_prompt !== undefined;
    if (parts === null && wantsOverride) {
      throw new ReplayError(
        'replay_prompt_parts_unavailable',
        'The invocation was recorded before prompt layers were retained; only an as-recorded replay is available',
      );
    }
    let globalTemplate: string | undefined;
    let groupTemplate: string | undefined;
    try {
      globalTemplate =
        override.global_prompt === undefined ? undefined : preparePromptOverride(override.global_prompt, 'global');
      groupTemplate =
        override.group_prompt === undefined ? undefined : preparePromptOverride(override.group_prompt, 'group');
    } catch (error) {
      if (error instanceof PromptOverrideError) {
        throw new ReplayError(error.code, error.message, 400);
      }
      throw error;
    }
    // The recorded prompt either replays byte for byte, or is rebuilt from its
    // stored layers with only the overridden templates swapped. Layout, order
    // and empty-segment filtering all come from the recorded layers.
    const systemPrompt =
      parts === null
        ? check.input.system_prompt
        : composeAgentPrompt(
            {
              prefix: parts.prefix,
              global: globalTemplate ?? parts.global,
              middle: parts.middle,
              group: groupTemplate ?? parts.group,
            },
            parts.template_values,
          );
    const runtime = this.#checkRuntime(source);
    if (!runtime.ok) {
      throw new ReplayError(runtime.code, runtime.message);
    }
    const { snapshot, settings, model } = runtime.runtime;
    const { secrets, systemResources, modelGate, shutdownSignal } = this.#options;
    const config = snapshot.config;
    const capture = createReplayTools(check.input, systemResources);
    const tools = applyToolSchemaKeywords(
      capture.tools,
      configuredToolSchemaKeywords(config, settings.provider, settings.model),
    );
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
      initialState: { systemPrompt, model, thinkingLevel: settings.thinking_level, messages: check.messages, tools },
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
        const callEntry = toolCalls.findLast((entry) => entry.tool_call_id === event.toolCallId);
        if (callEntry !== undefined) {
          const result = redacted(event.result);
          if (traceBytes + Buffer.byteLength(JSON.stringify(result)) > MAX_TRACE_BYTES) {
            fail('trace_limit', 'Replay trace exceeded its size limit');
            agent.abort();
            callEntry.is_error = true;
          } else {
            callEntry.result = result;
            callEntry.is_error = event.isError;
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
      source_model_call_id: call.id.toString(),
      conversation_id: source.conversationId.toString(),
      chat_id: source.chatId.toString(),
      thread_id: source.threadId.toString(),
      model: { provider: model.provider, id: model.id, thinking_level: settings.thinking_level },
      overrides: {
        global_prompt: override.global_prompt !== undefined,
        group_prompt: override.group_prompt !== undefined,
      },
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
        historical_model: { provider: call.provider, id: call.model },
        model_selection: 'current_chat_config',
        omitted_images: check.input.omitted_images,
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

  /**
   * The shared source guard: a finished invocation, its first agent model
   * request, and that request's retained snapshot. It never searches later model
   * calls or the current Context for a replacement; `run`, `inspect` and
   * `prompts` all start here.
   */
  #checkSource(id: bigint): ReplayCheck {
    const { orm } = this.#options;
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
      return {
        ok: false,
        code: 'replay_source_unfinished',
        message: 'Replay requires a finished invocation',
        call: null,
      };
    }
    const call = orm
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
    if (call === undefined) {
      return {
        ok: false,
        code: 'replay_no_agent_request',
        message: 'The invocation has no agent model request to replay from',
        call: null,
      };
    }
    if (call.input === null) {
      return {
        ok: false,
        code: 'replay_input_unavailable',
        message:
          'The first model request has no retained replay input; recording may have been disabled or payloads cleared',
        call,
      };
    }
    let parsed: ReturnType<typeof parseReplayInput>;
    try {
      parsed = parseReplayInput(call.input);
      const last = parsed.messages.at(-1);
      if (!isRenderable(parsed.messages) || (last?.role !== 'user' && last?.role !== 'toolResult')) {
        throw new Error('Invalid starting history');
      }
    } catch {
      return {
        ok: false,
        code: 'replay_input_invalid',
        message: 'The retained replay input is invalid or unsupported',
        call,
      };
    }
    return {
      ok: true,
      source: {
        conversationId: source.conversationId,
        chatId: source.chatId,
        threadId: source.threadId,
      },
      call,
      input: parsed.input,
      messages: parsed.messages,
    };
  }

  /** The current-configuration half of the guard: the source chat and its agent model must still exist. */
  #checkRuntime(source: ReplaySource): ReplayRuntimeCheck {
    const snapshot = this.#options.configStore.beginInvocation();
    const config: RawConfig = snapshot.config;
    const chat = resolveChatConfig(config, this.#options.orm, source.chatId);
    if (chat === undefined) {
      return { ok: false, code: 'replay_chat_unconfigured', message: 'The source chat is no longer configured' };
    }
    const settings = resolveAgentSettings(config, chat);
    const model = snapshot.models.getModel(settings.provider, settings.model);
    if (model === undefined) {
      return { ok: false, code: 'replay_model_unavailable', message: 'The current agent model is unavailable' };
    }
    return { ok: true, runtime: { snapshot, settings, model } };
  }
}
