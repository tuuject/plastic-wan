import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  type Api,
  getSupportedThinkingLevels,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import { modelDefinitionSchema, type PublicModel } from '@plasticwan/image-service';
import { eq } from 'drizzle-orm';
import { createExecuteTool } from '../capabilities/execute-tool.ts';
import { createReadTool } from '../capabilities/read-tool.ts';
import { createSendTool } from '../capabilities/send-tool.ts';
import { ContextBuilder, type StablePrompt } from '../context/context-builder.ts';
import { estimateMessageTokens } from '../context/context-codec.ts';
import { ContextRefStore } from '../context/context-refs.ts';
import { buildSceneContext, type SceneContext, SceneSliceError } from '../context/scene-context.ts';
import { composeAgentPrompt, PromptOverrideError, preparePromptOverride } from '../platform/agent-prompt.ts';
import type { KeyedSemaphore } from '../platform/concurrency.ts';
import {
  type AgentSettings,
  configuredToolSchemaKeywords,
  type RawConfig,
  resolveAgentSettings,
} from '../platform/config.ts';
import { type InvocationContext, unavailableCapabilities } from '../platform/invocation-context.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SystemResources, SystemSkill } from '../platform/system-resources.ts';
import { isThinkingLevel } from '../platform/thinking-levels.ts';
import { applyToolSchemaKeywords } from '../platform/tool-schema.ts';
import { resolveChatConfig, type SqliteStore } from '../store/database.ts';
import { chats, conversations, invocations } from '../store/schema.ts';
import { createReplayTools, type ReplayToolRegistry, toolDefinition } from './replay-tools.ts';

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
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly systemResources: SystemResources;
  readonly modelGate: KeyedSemaphore;
  readonly shutdownSignal: AbortSignal;
  readonly toolDefinitions?: (context: InvocationContext, config: RawConfig) => ReplayToolRegistry;
  readonly skillVisibility?: (skill: SystemSkill) => boolean;
  readonly imageLoader?: (mediaId: bigint, signal: AbortSignal) => Promise<ImageContent>;
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

/** Prompt and model overrides for one scene test; absent means the current layer or Chat settings are kept. */
export interface ReplayPromptOverrides extends ReplaySelection {
  readonly global_prompt?: string;
  readonly group_prompt?: string;
}

/** Optional model-selection fields of one replay; absent fields inherit the current Chat settings. */
export interface ReplayModelSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking_level?: ModelThinkingLevel;
}

/** The read-only selection a preflight accepts: no prompt overrides. */
export interface ReplaySelection extends ReplayModelSelection {
  readonly before_send_id?: string;
}

/** Source identity only; no historical model requests or private agent history. */
interface ReplaySource {
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
}

interface ReplayRuntime {
  readonly snapshot: InvocationConfigSnapshot;
  readonly settings: AgentSettings;
  readonly model: Model<Api>;
  /** Which explicit model-selection fields the caller supplied, for disclosure. */
  readonly selection: {
    readonly provider: boolean;
    readonly model: boolean;
    readonly thinking_level: boolean;
  };
}

type ReplayCheck =
  | { readonly ok: true; readonly source: ReplaySource }
  | { readonly ok: false; readonly code: string; readonly message: string };

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
  readonly prompt_overrides_available: boolean;
  readonly omitted_images: number | null;
  readonly scene?: ReturnType<typeof sceneMetadata>;
  /** The effective model when any model-selection field was given; absent inherits the current Chat settings. */
  readonly model?: {
    readonly provider: string;
    readonly id: string;
    readonly thinking_level: ModelThinkingLevel;
  };
  readonly fidelity: {
    readonly input: 'historical_public_chat';
    readonly model_selection: 'current_chat_config' | 'temporary_override';
    readonly prompt_selection: 'current_chat_config';
    readonly tool_selection: 'current_registry';
    readonly hot_injections: 'not_replayed' | 'flattened_before_send';
    readonly external_tools: 'blocked';
    readonly system_resources: 'current_read_only';
    readonly side_effects: 'synthetic';
  };
}

/** Active global/group templates; runtime-owned layers remain read-only. */
export interface ReplayPrompts {
  readonly source: 'active';
  readonly source_invocation_id: string;
  readonly global_prompt: string;
  readonly group_prompt: string;
  readonly template_values: {
    readonly agent: { readonly provider: string; readonly model: string };
    readonly vision: { readonly provider: string; readonly model: string };
    readonly timezone: string;
  };
  readonly core_read_only: true;
}

function sceneMetadata(scene: SceneContext) {
  return {
    cutoff_at: scene.cutoffAt,
    source_bucket_id: scene.bucketId.toString(),
    message_count: scene.messageCount,
    history_count: scene.historyCount,
    omitted_messages: scene.omittedMessages,
    ...(scene.slice === undefined
      ? {}
      : {
          slice: {
            before_send_id: scene.slice.beforeSendId,
            before_message_id: scene.slice.beforeMessageId,
            after_bot_message_id: scene.slice.afterBotMessageId,
          },
        }),
  };
}

const PREFLIGHT_FIDELITY = {
  input: 'historical_public_chat',
  model_selection: 'current_chat_config',
  prompt_selection: 'current_chat_config',
  tool_selection: 'current_registry',
  hot_injections: 'not_replayed',
  external_tools: 'blocked',
  system_resources: 'current_read_only',
  side_effects: 'synthetic',
} as const;

/** Validate the core contract without resolving secrets or calling a provider. */
function publicImageModels(config: RawConfig): PublicModel[] {
  const parsed = modelDefinitionSchema.array().safeParse(config.image?.models ?? []);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    providerTag: model.providerTag,
    capabilities: model.capabilities,
    ...(model.description === undefined ? {} : { description: model.description }),
  }));
}

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
  inspect(id: bigint, selection: ReplaySelection = {}): ReplayPreflight {
    const modelSelected =
      selection.provider !== undefined || selection.model !== undefined || selection.thinking_level !== undefined;
    try {
      const { scene, runtime } = this.#prepare(id, selection);
      return {
        available: true,
        reason: null,
        message: null,
        prompt_overrides_available: true,
        omitted_images: scene.omittedImages,
        fidelity: {
          ...PREFLIGHT_FIDELITY,
          model_selection: modelSelected ? 'temporary_override' : 'current_chat_config',
          hot_injections: scene.slice === undefined ? 'not_replayed' : 'flattened_before_send',
        },
        scene: sceneMetadata(scene),
        ...(modelSelected
          ? {
              model: {
                provider: runtime.model.provider,
                id: runtime.model.id,
                thinking_level: runtime.settings.thinking_level,
              },
            }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof ReplayError) || error.status === 404) {
        throw error;
      }
      return {
        available: false,
        reason: error.code,
        message: error.message,
        prompt_overrides_available: false,
        omitted_images: null,
        fidelity: {
          ...PREFLIGHT_FIDELITY,
          model_selection: modelSelected ? 'temporary_override' : 'current_chat_config',
        },
      };
    }
  }

  prompts(id: bigint): ReplayPrompts {
    const { stable } = this.#prepare(id);
    return {
      source: 'active',
      source_invocation_id: id.toString(),
      global_prompt: stable.promptLayers.global,
      group_prompt: stable.promptLayers.group,
      template_values: stable.templateValues,
      core_read_only: true,
    };
  }

  async run(id: bigint, override: ReplayPromptOverrides, requestSignal: AbortSignal) {
    if (this.#running) {
      throw new ReplayError('replay_busy', 'Another replay is running', 429);
    }
    const { source, runtime, stable, scene, registry } = this.#prepare(id, override);
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
    const systemPrompt = composeAgentPrompt(
      {
        ...stable.promptLayers,
        global: globalTemplate ?? stable.promptLayers.global,
        group: groupTemplate ?? stable.promptLayers.group,
      },
      stable.templateValues,
    );
    const { snapshot, settings, model, selection: modelSelection } = runtime;
    const { secrets, systemResources, modelGate, shutdownSignal } = this.#options;
    const config = snapshot.config;
    const imageLoader = this.#options.imageLoader;
    const capture = createReplayTools(registry, systemResources, {
      imageModels: publicImageModels(config),
      ...(config.agent.send_max_text_length === undefined ? {} : { maxTextLength: config.agent.send_max_text_length }),
      disallowBlankLines: config.agent.send_disallow_blank_lines === true,
      allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
      replyMessageIds: new Set(scene.replyMessageIds),
      ...(imageLoader === undefined || !model.input.includes('image')
        ? {}
        : {
            readImage: async (ref: string, imageSignal: AbortSignal) => {
              const mediaId = scene.mediaRefs.get(ref);
              if (mediaId === undefined) {
                throw new Error('image_ref is not visible in this scene');
              }
              return await imageLoader(mediaId, AbortSignal.any([signal, imageSignal]));
            },
          }),
    });
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
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: settings.thinking_level,
        messages: [{ role: 'user', content: scene.text, timestamp: Date.parse(scene.cutoffAt) }],
        tools,
      },
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
      version: 2,
      replay_id: replayId,
      source_invocation_id: id.toString(),
      scene: sceneMetadata(scene),
      conversation_id: source.conversationId.toString(),
      chat_id: source.chatId.toString(),
      thread_id: source.threadId.toString(),
      model: { provider: model.provider, id: model.id, thinking_level: settings.thinking_level },
      overrides: {
        global_prompt: override.global_prompt !== undefined,
        group_prompt: override.group_prompt !== undefined,
        provider: override.provider !== undefined,
        model: override.model !== undefined,
        thinking_level: override.thinking_level !== undefined,
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
        ...PREFLIGHT_FIDELITY,
        model_selection:
          modelSelection.provider || modelSelection.model || modelSelection.thinking_level
            ? 'temporary_override'
            : 'current_chat_config',
        hot_injections: scene.slice === undefined ? 'not_replayed' : 'flattened_before_send',
        omitted_images: scene.omittedImages,
        memory_and_alarms: 'empty_in_memory_overlay',
        ref_authorization: 'scene_local_media_and_reply',
        synthetic_validation: 'current_schema_and_send_limits_no_world_state_checks',
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

  #prepare(
    id: bigint,
    selection: ReplaySelection = {},
  ): {
    source: ReplaySource;
    runtime: ReplayRuntime;
    stable: StablePrompt;
    scene: SceneContext;
    registry: ReplayToolRegistry;
  } {
    if (
      selection.before_send_id !== undefined &&
      (!/^[1-9]\d{0,18}$/.test(selection.before_send_id) ||
        BigInt(selection.before_send_id) > 9_223_372_036_854_775_807n)
    ) {
      throw new ReplayError('invalid_before_send_id', 'before_send_id must be a positive 64-bit decimal ID', 400);
    }
    const check = this.#checkSource(id);
    if (!check.ok) {
      throw new ReplayError(check.code, check.message);
    }
    const checkedRuntime = this.#checkRuntime(check.source, selection);
    if (!checkedRuntime.ok) {
      throw new ReplayError(checkedRuntime.code, checkedRuntime.message);
    }
    const runtime = checkedRuntime.runtime;
    const config = runtime.snapshot.config;
    const builder = new ContextBuilder(
      this.#options.store,
      new ContextRefStore(this.#options.store, { ttlHours: config.agent.context.ref_ttl_hours }),
      this.#options.systemResources.skills,
    );
    const stable = builder.buildSystemPrompt(
      config,
      builder.identity(config, id),
      runtime.model.input.includes('image'),
      { provider: runtime.model.provider, model: runtime.model.id },
      {
        imageInput: 'on_demand',
        ...(this.#options.skillVisibility === undefined ? {} : { skillFilter: this.#options.skillVisibility }),
      },
    );
    const context: InvocationContext = {
      invocationId: id,
      ...check.source,
      systemPrompt: stable.systemPrompt,
      userPrompt: '',
      directImages: [],
      visibleSenders: new Map(),
      callerUserId: null,
      completion: null,
      omittedNewMessages: 0,
    };
    const registry = this.#options.toolDefinitions?.(context, config) ?? this.#defaultRegistry(context, config);
    let scene: SceneContext;
    try {
      scene = buildSceneContext(this.#options.store, config, id, {
        contextWindow: runtime.model.contextWindow,
        maxOutputTokens: runtime.model.maxTokens,
        toolDefinitionCharacters:
          stable.systemPrompt.length + JSON.stringify(registry.tools.map(toolDefinition)).length,
        supportsImages: runtime.model.input.includes('image') && this.#options.imageLoader !== undefined,
        ...(selection.before_send_id === undefined ? {} : { beforeSendId: BigInt(selection.before_send_id) }),
      });
    } catch (error) {
      if (error instanceof SceneSliceError) {
        throw new ReplayError(error.code, error.message);
      }
      if (error instanceof Error && error.message.includes('unavailable')) {
        throw new ReplayError('replay_scene_unavailable', 'The invocation has no retained public opening messages');
      }
      throw new ReplayError('replay_scene_invalid', 'The retained public chat scene is invalid or unsupported');
    }
    return { source: check.source, runtime, stable, scene, registry };
  }

  #defaultRegistry(context: InvocationContext, config: RawConfig): ReplayToolRegistry {
    const blocked = async (): Promise<never> => {
      throw new Error('No production executor is wired');
    };
    const send = createSendTool({
      store: this.#options.store,
      context,
      api: { sendMessage: blocked, sendSticker: blocked },
      capabilities: unavailableCapabilities(),
      sendRateLimit: { sendsPerWindow: 1, windowSeconds: 1 },
      maxTextLength: config.agent.send_max_text_length,
      disallowBlankLines: config.agent.send_disallow_blank_lines === true,
      allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
      deadline: Number.MAX_SAFE_INTEGER,
      bot: { id: 0n, displayName: '', username: null },
    });
    return {
      tools: [
        createReadTool({ store: this.#options.store, context, resources: this.#options.systemResources }),
        send,
        createExecuteTool({
          capabilities: [],
          audit: { start: () => ({ succeed: () => {}, fail: () => {} }), reject: () => {} },
        }),
      ].map(toolDefinition),
      capabilities: [],
    };
  }

  /** Finished source identity, independent of developer recording. */
  #checkSource(id: bigint): ReplayCheck {
    const { orm } = this.#options.store;
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
      };
    }
    return {
      ok: true,
      source: {
        conversationId: source.conversationId,
        chatId: source.chatId,
        threadId: source.threadId,
      },
    };
  }

  /**
   * The current-configuration half of the guard: the source chat and the
   * effective agent model must still exist. An explicit model selection is
   * validated against the same snapshot before anything else runs: the pair
   * rule, registry membership, text capability and thinking-level support are
   * all rejected before a preflight or a run can reach the model.
   */
  #checkRuntime(source: ReplaySource, selection: ReplayModelSelection = {}): ReplayRuntimeCheck {
    const snapshot = this.#options.configStore.beginInvocation();
    const config: RawConfig = snapshot.config;
    const chat = resolveChatConfig(config, this.#options.store.orm, source.chatId);
    if (chat === undefined) {
      return { ok: false, code: 'replay_chat_unconfigured', message: 'The source chat is no longer configured' };
    }
    if (chat.topic_ids !== undefined && !chat.topic_ids.some((topic) => BigInt(topic) === source.threadId)) {
      return { ok: false, code: 'replay_topic_unconfigured', message: 'The source topic is no longer configured' };
    }
    const settings = resolveAgentSettings(config, chat);
    const currentModel = snapshot.models.getModel(settings.provider, settings.model);
    if (currentModel === undefined) {
      return { ok: false, code: 'replay_model_unavailable', message: 'The current agent model is unavailable' };
    }
    const selectionFlags = {
      provider: selection.provider !== undefined,
      model: selection.model !== undefined,
      thinking_level: selection.thinking_level !== undefined,
    };
    let model = currentModel;
    let effective: AgentSettings = settings;
    if (selection.provider !== undefined || selection.model !== undefined) {
      // An explicit pair overrides the Chat settings for this replay only; a
      // pair without a thinking level resets it to the weakest level the target
      // supports, exactly like a configuration model switch.
      if (selection.provider === undefined || selection.model === undefined) {
        throw new ReplayError('replay_model_pair_required', 'provider and model must be provided together', 400);
      }
      const target = this.#targetModel(snapshot, selection.provider, selection.model);
      const supported = getSupportedThinkingLevels(target);
      const thinkingLevel = selection.thinking_level ?? supported[0] ?? 'off';
      if (!supported.includes(thinkingLevel)) {
        throw new ReplayError(
          'replay_thinking_level_unsupported',
          `Thinking level ${thinkingLevel} is not supported by ${selection.provider}/${selection.model}`,
          400,
        );
      }
      model = target;
      effective = { provider: selection.provider, model: selection.model, thinking_level: thinkingLevel };
    } else if (selection.thinking_level !== undefined) {
      if (!isThinkingLevel(selection.thinking_level)) {
        throw new ReplayError(
          'replay_thinking_level_invalid',
          `Unknown thinking level ${selection.thinking_level}`,
          400,
        );
      }
      if (!getSupportedThinkingLevels(currentModel).includes(selection.thinking_level)) {
        throw new ReplayError(
          'replay_thinking_level_unsupported',
          `Thinking level ${selection.thinking_level} is not supported by ${settings.provider}/${settings.model}`,
          400,
        );
      }
      effective = { ...settings, thinking_level: selection.thinking_level };
    }
    return { ok: true, runtime: { snapshot, settings: effective, model, selection: selectionFlags } };
  }

  /** Validates one explicit target against the active configuration and its registry. */
  #targetModel(snapshot: InvocationConfigSnapshot, provider: string, modelId: string): Model<Api> {
    if (snapshot.config.providers[provider] === undefined) {
      throw new ReplayError('unknown_provider', `Provider ${provider} is not configured`, 400);
    }
    const found = snapshot.models.getModel(provider, modelId);
    if (found === undefined) {
      throw new ReplayError('unknown_model', `Model ${provider}/${modelId} is not registered`, 400);
    }
    if (!found.input.includes('text')) {
      throw new ReplayError('not_text_capable', `Model ${provider}/${modelId} does not accept text input`, 400);
    }
    return found;
  }
}
