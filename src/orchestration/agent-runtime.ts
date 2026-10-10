import { createHash } from 'node:crypto';
import { Agent, type AgentContext, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { capability, createExecuteTool, type ExecutableCapability } from '../capabilities/execute-tool.ts';
import { createReadTool } from '../capabilities/read-tool.ts';
import { createSendTools, SEND_TOOL_NAMES, type TelegramSendApi } from '../capabilities/send-tool.ts';
import { createTyping } from '../capabilities/typing.ts';
import { ContextBuilder, type ContextIdentity, type Injection, type StablePrompt } from '../context/context-builder.ts';
import { encodeContextMessage, estimateMessageTokens } from '../context/context-codec.ts';
import { type ContextGcPlan, isRenderable, planContextGc } from '../context/context-gc.ts';
import { ContextRefStore, createCapabilityResolver } from '../context/context-refs.ts';
import { type ContextHeader, ConversationContextStore, type RetainedContextMessage } from '../context/context-store.ts';
import { KeyedSemaphore } from '../platform/concurrency.ts';
import {
  type AgentSettings,
  configuredToolSchemaKeywords,
  type RawConfig,
  resolveAgentSettings,
} from '../platform/config.ts';
import {
  type CapabilityRefResolver,
  type InvocationContext,
  InvocationContextState,
  unavailableCapabilities,
  type VisibleSender,
} from '../platform/invocation-context.ts';
import { serializeModelRequestForAudit } from '../platform/model-request-audit.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SystemResources, SystemSkill } from '../platform/system-resources.ts';
import { applyToolSchemaKeywords } from '../platform/tool-schema.ts';
import { resolveChatConfig, type SqliteStore } from '../store/database.ts';
import { createToolAudit } from '../store/tool-audit.ts';
import {
  agentMessages,
  buckets,
  dailyUsage,
  invocations,
  modelCalls,
  toolCalls as toolCallsTable,
} from '../store/schema.ts';
import {
  activeSleepUntil,
  createZzzTool,
  type DailyTokenBudget,
  isDailyTokenBudgetReached,
  isLowDailyTokenBudget,
  meteredTokens,
  readDailyTokenBudget,
} from '../store/sleep.ts';
import { type CachedConversationAgent, ConversationRuntime } from './conversation-runtime.ts';
import { attachBucketToInvocation } from './invocation-queue.ts';
import type { InvocationOutcome } from './scheduler.ts';

/**
 * Builds per-invocation tools. Used for the execute registry (runtime-internal
 * capabilities) and for directly exposed extras (allowlisted MCP tools).
 */
export type ToolFactory = (
  context: InvocationContext,
  deadline: number,
  capabilities: CapabilityRefResolver,
) => readonly AgentTool[];
export type AdditionalToolFactory = ToolFactory;
export type CapabilityToolFactory = (
  context: InvocationContext,
  deadline: number,
  capabilities: CapabilityRefResolver,
) => readonly ExecutableCapability[];
export type DirectImageLoader = (context: InvocationContext, signal: AbortSignal) => Promise<readonly ImageContent[]>;

export interface AgentRuntimeOptions {
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly telegramApi: TelegramSendApi;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
  /** The bundled system:/// resource tree: read primitive backend plus skill index. */
  readonly systemResources: SystemResources;
  /** Runtime-internal capabilities dispatched through the execute primitive. */
  readonly capabilityTools?: CapabilityToolFactory;
  /** Per-invocation skill visibility rule; hides skills of disabled capabilities. */
  readonly skillVisibility?: (skill: SystemSkill) => boolean;
  /** Resolves generated pictures for the send tool; absent without image generation. */
  readonly imageGeneration?: {
    readonly resolve: (
      generationId: string,
      conversationId: bigint,
    ) => readonly { readonly assetId: string; readonly bytes: Uint8Array; readonly fileName: string }[] | undefined;
  };
  /** Directly exposed non-primitive tools (allowlisted MCP tools). */
  readonly additionalTools?: ToolFactory;
  readonly directImageLoader?: DirectImageLoader;
  readonly modelGate?: KeyedSemaphore;
  /** Shared with the scheduler so the attach path and the runtime agree. */
  readonly conversationRuntime?: ConversationRuntime;
}

/**
 * Safety net for models that draft a group-facing reply as ordinary assistant
 * text and then stop without calling send. Ordinary assistant text is private
 * and never published, so such a reply is silently lost. When a turn ends on
 * non-empty private text without calling send since the newest injected batch,
 * inject one harness-level reminder to use send. Fires at most once per injected
 * batch; if the model still does not send, we stop and let it stay silent.
 *
 * The check has to run before the inject and idle-grace paths: both extend the
 * run, and a draft is only recoverable while its batch is still the newest one.
 * Left after them, the reminder only ever fires once the conversation has been
 * quiet for a whole grace period, so every batch that is followed by another
 * bucket within the grace silently loses its reply.
 */
const SEND_NUDGE_TEXT =
  'You produced a reply as ordinary assistant text. Ordinary assistant text is private and is never published to Telegram. If that text is meant for the chat, call the send tool to publish it now. You will not be reminded again.';

/** Why a run decided to stop; audit-only, the state comes from `InvocationOutcome`. */
type StopReason = 'completed' | 'context_limit' | 'turn_budget' | 'wall_clock' | 'sleep' | 'budget';

interface RunState {
  turns: number;
  turnsSinceInjection: number;
  toolCalls: number;
  estimatedInputTokens: number;
  sendUsed: boolean;
  nudged: boolean;
  sleepRequested: boolean;
  modelBudgetBlocked: boolean;
  contextClosing: boolean;
  /** The one send-only turn closing mode promises has been handed out. */
  closingTurnGranted: boolean;
  /**
   * The send barrier already held one send back this round. Once per round, so
   * a chat that never goes quiet still gets its reply out; reset when the agent
   * becomes free, not by the injection the barrier itself caused.
   */
  barrierSpent: boolean;
  stopReason: StopReason;
}

export class AgentRuntime {
  readonly #store: SqliteStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #secrets: SecretStore;
  readonly #telegramApi: TelegramSendApi;
  readonly #bot: AgentRuntimeOptions['bot'];
  readonly #systemResources: SystemResources;
  readonly #capabilityTools: CapabilityToolFactory | undefined;
  /** Per-invocation skill visibility; used to hide disabled capability skills. */
  readonly #skillVisibility: ((skill: SystemSkill) => boolean) | undefined;
  readonly #additionalTools: ToolFactory | undefined;
  readonly #directImageLoader: DirectImageLoader | undefined;
  readonly #modelGate: KeyedSemaphore;
  readonly #contextBuilder: ContextBuilder;
  readonly #contexts: ConversationContextStore;
  readonly #refs: ContextRefStore;
  /** Resolves generated pictures for delivery; absent without image generation. */
  readonly #imageGeneration:
    | {
        readonly resolve: (
          generationId: string,
          conversationId: bigint,
        ) => readonly { readonly assetId: string; readonly bytes: Uint8Array; readonly fileName: string }[] | undefined;
      }
    | undefined;
  readonly #conversationRuntime: ConversationRuntime;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#configStore = options.configStore;
    this.#telegramApi = options.telegramApi;
    this.#bot = options.bot;
    this.#systemResources = options.systemResources;
    this.#capabilityTools = options.capabilityTools;
    this.#skillVisibility = options.skillVisibility;
    this.#additionalTools = options.additionalTools;
    this.#directImageLoader = options.directImageLoader;
    this.#modelGate = options.modelGate ?? new KeyedSemaphore();
    const config = options.configStore.current().config;
    this.#contexts = new ConversationContextStore(options.store);
    this.#refs = new ContextRefStore(options.store, { ttlHours: config.agent.context.ref_ttl_hours });
    this.#imageGeneration = options.imageGeneration;
    this.#conversationRuntime =
      options.conversationRuntime ?? new ConversationRuntime({ agentCacheSize: config.agent.context.agent_cache_size });
    this.#contextBuilder = new ContextBuilder(options.store, this.#refs, options.systemResources.skills);
  }

  get conversationRuntime(): ConversationRuntime {
    return this.#conversationRuntime;
  }

  /**
   * Checks the per-invocation tool registry against a model's context window.
   * The model is passed in because the caller resolves it: `/model` switches and
   * reloads validate against the model the run will actually get, which is not
   * the one this runtime was constructed with.
   */
  validateAdditionalTools(context: InvocationContext, additionalTools: readonly AgentTool[], model: Model<Api>): void {
    const config = this.#configStore.current().config;
    const { send, sendReply } = createSendTools({
      store: this.#store,
      api: this.#telegramApi,
      context,
      capabilities: this.#staticCapabilities,
      sendRateLimit: this.#sendRateLimit(config),
      maxTextLength: config.agent.send_max_text_length,
      disallowBlankLines: config.agent.send_disallow_blank_lines === true,
      allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
      deadline: Number.MAX_SAFE_INTEGER,
      bot: this.#bot,
    });
    validateToolRegistry(
      [
        createReadTool({ store: this.#store, context, resources: this.#systemResources }),
        send,
        sendReply,
        createExecuteTool({ audit: createToolAudit(this.#store, context.invocationId), capabilities: [] }),
        ...additionalTools,
      ],
      model.contextWindow,
    );
  }

  /** Current definitions only; scene tests never receive these production executors. */
  sceneToolDefinitions(
    context: InvocationContext,
    config: RawConfig,
  ): {
    readonly tools: readonly AgentTool[];
    readonly capabilities: readonly AgentTool[];
  } {
    const resolver = unavailableCapabilities();
    const deadline = Number.MAX_SAFE_INTEGER;
    const capabilities = [
      capability(
        createTyping(this.#telegramApi, context.chatId.toString(), context.threadId, new AbortController().signal).tool,
        false,
      ),
      ...(this.#capabilityTools?.(context, deadline, resolver) ?? []),
    ];
    return {
      tools: this.#buildTools(
        context,
        config,
        deadline,
        resolver,
        capabilities,
        isLowDailyTokenBudget(readDailyTokenBudget(this.#store.orm, config.agent.daily_budget.max_tokens))
          ? createZzzTool({
              orm: this.#store.orm,
              invocationId: context.invocationId,
              chatId: context.chatId,
              onSleep: () => {},
            })
          : undefined,
      ),
      capabilities: capabilities.map((entry) => entry.tool),
    };
  }

  #buildTools(
    target: InvocationContext,
    config: RawConfig,
    deadline: number,
    capabilities: CapabilityRefResolver,
    executableCapabilities: readonly ExecutableCapability[],
    zzz?: AgentTool,
    holdForNewMessages?: () => boolean,
  ): readonly AgentTool[] {
    const { send, sendReply } = createSendTools({
      store: this.#store,
      api: this.#telegramApi,
      context: target,
      capabilities,
      sendRateLimit: this.#sendRateLimit(config),
      maxTextLength: config.agent.send_max_text_length,
      disallowBlankLines: config.agent.send_disallow_blank_lines === true,
      allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
      deadline,
      bot: this.#bot,
      ...(holdForNewMessages === undefined ? {} : { holdForNewMessages }),
      ...(this.#imageGeneration === undefined ? {} : { imageGeneration: this.#imageGeneration }),
    });
    return [
      createReadTool({ store: this.#store, context: target, resources: this.#systemResources }),
      send,
      sendReply,
      createExecuteTool({
        audit: createToolAudit(this.#store, target.invocationId),
        capabilities: executableCapabilities,
      }),
      ...(this.#additionalTools?.(target, deadline, capabilities) ?? []),
      ...(zzz === undefined ? [] : [zzz]),
    ];
  }

  async run(
    invocationId: bigint,
    snapshot: InvocationConfigSnapshot,
    schedulerSignal: AbortSignal,
  ): Promise<InvocationOutcome> {
    try {
      return await this.#runInvocation(invocationId, snapshot, schedulerSignal);
    } catch (error) {
      // The scheduler persists an outcome vocabulary, not a message, so an error
      // that escapes the run would leave `completion_reason: 'invocation_error'`
      // and nothing else. A stored row that no longer decodes once did exactly
      // that and failed every invocation of one conversation until someone read
      // the database by hand; the message has to reach the log.
      if (!schedulerSignal.aborted) {
        this.#logInvocationError(invocationId, error);
      }
      throw error;
    }
  }

  async #runInvocation(
    invocationId: bigint,
    snapshot: InvocationConfigSnapshot,
    schedulerSignal: AbortSignal,
  ): Promise<InvocationOutcome> {
    // Every runtime-policy read below comes from the snapshot this run was
    // started with; the global daily budget and debug recording switch are re-read live. The snapshot
    // carries its own model registry, so a configuration published while this
    // run is in flight never reaches it — neither its models nor its provider
    // connections — and a model that is no longer registered fails the run
    // instead of silently falling back.
    const config = snapshot.config;
    const identity = this.#contextBuilder.identity(config, invocationId);
    const chat = resolveChatConfig(config, this.#store.orm, identity.chatId);
    if (chat === undefined) {
      throw new Error(`Invocation chat ${identity.chatId} is no longer configured`);
    }
    const settings = resolveAgentSettings(config, chat);
    const model = snapshot.models.getModel(settings.provider, settings.model);
    if (model === undefined) {
      throw new Error(`Agent model ${settings.provider}/${settings.model} is not registered`);
    }
    // The declared keyword profile of the agent model decides what its tool
    // definitions may carry; the snapshot is read so a reload cannot change the
    // schema mid-run.
    const toolSchemaKeywords = configuredToolSchemaKeywords(config, settings.provider, settings.model);
    const supportsImages = model.input.includes('image');
    const stable = this.#contextBuilder.buildSystemPrompt(
      config,
      identity,
      supportsImages,
      {
        provider: model.provider,
        model: model.id,
      },
      this.#skillVisibility === undefined ? undefined : { skillFilter: this.#skillVisibility },
    );
    const opened = this.#contexts.open(identity.conversationId, stable.systemPromptHash);
    const header = opened.header;
    if (opened.rebuilt) {
      // A changed stable system prompt restarts the Conversation Context: the
      // same conversation under two different prompts is not replayable.
      this.#conversationRuntime.forget(identity.conversationId);
      this.#logContextRebuilt(identity, stable.systemPromptHash);
    }
    const startedAt = Date.now();
    const deadline = startedAt + config.agent.context.max_wall_clock_seconds * 1_000;
    const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const signal = AbortSignal.any([schedulerSignal, timeoutSignal]);
    const contextState = new InvocationContextState({
      invocationId,
      conversationId: identity.conversationId,
      chatId: identity.chatId,
      threadId: identity.threadId,
      completion: identity.completion,
    });
    const bypassDailyBudget = (): boolean => contextState.completion?.delivery.bypassDailyBudget === true;
    contextState.setSystemPrompt(stable.systemPrompt);
    const capabilities = this.#capabilitiesFor(header);
    const state: RunState = {
      turns: 0,
      turnsSinceInjection: 0,
      toolCalls: 0,
      estimatedInputTokens: 0,
      sendUsed: false,
      nudged: false,
      sleepRequested: false,
      modelBudgetBlocked: false,
      contextClosing: false,
      closingTurnGranted: false,
      barrierSpent: false,
      stopReason: 'completed',
    };
    const zzz = createZzzTool({
      orm: this.#store.orm,
      invocationId,
      chatId: identity.chatId,
      onSleep: () => {
        state.sleepRequested = true;
      },
    });
    const initialBudget = readDailyTokenBudget(
      this.#store.orm,
      this.#configStore.current().config.agent.daily_budget.max_tokens,
    );
    let zzzExposed = !bypassDailyBudget() && isLowDailyTokenBudget(initialBudget);
    if (zzzExposed) {
      this.#logZzzExposure(invocationId, identity.chatId, initialBudget);
    }
    /**
     * Send barrier. Messages that arrive while the model works on its reply would
     * otherwise wait for the next round and get a reply of their own. Before the
     * first send of a round goes out, a batch collecting for this conversation is
     * attached to this run instead, and the send is held back; the batch reaches
     * the model at the next turn boundary through the ordinary injection path.
     */
    const holdForNewMessages = (): boolean => {
      const conversationRuntime = this.#conversationRuntime;
      const conversationId = identity.conversationId;
      // A closing run never injects again. A receipt also finishes its own round
      // before user batches, so neither may hold a send for pending messages.
      if (state.contextClosing || conversationRuntime.isClosing(conversationId) || contextState.completion !== null) {
        return false;
      }
      // A batch the barrier already queued holds back every later send of the
      // same turn too, so no reply goes out before the model has read it.
      if (conversationRuntime.hasPendingInjections(conversationId, 'messages')) {
        return true;
      }
      if (state.barrierSpent) {
        return false;
      }
      const now = new Date();
      const bucketId = this.#store.transaction(() => {
        const collecting = this.#store.orm
          .select({ id: buckets.id })
          .from(buckets)
          .where(and(eq(buckets.conversationId, conversationId), eq(buckets.state, 'collecting')))
          .get();
        if (collecting === undefined) {
          return undefined;
        }
        attachBucketToInvocation(
          this.#store,
          config.agent.history_messages,
          invocationId,
          collecting.id,
          conversationId,
          now,
        );
        return collecting.id;
      });
      if (bucketId === undefined) {
        return false;
      }
      state.barrierSpent = true;
      conversationRuntime.queueInjection(conversationId, bucketId);
      console.log(
        JSON.stringify({
          event: 'send_barrier',
          invocation_id: invocationId.toString(),
          bucket_id: bucketId.toString(),
          conversation_id: conversationId.toString(),
          chat_id: identity.chatId.toString(),
          at: now.toISOString(),
        }),
      );
      return true;
    };
    const typing = createTyping(this.#telegramApi, identity.chatId.toString(), identity.threadId, signal);
    const executableCapabilities = [
      capability(typing.tool, false),
      ...(this.#capabilityTools?.(contextState, deadline, capabilities) ?? []),
    ];
    const buildTools = (target: InvocationContext, exposeZzz: boolean): readonly AgentTool[] =>
      this.#buildTools(
        target,
        config,
        deadline,
        capabilities,
        executableCapabilities,
        exposeZzz ? zzz : undefined,
        config.agent.send_barrier_enabled === true ? holdForNewMessages : undefined,
      );
    const tools = applyToolSchemaKeywords(buildTools(contextState, zzzExposed), toolSchemaKeywords);
    validateToolRegistry(tools, model.contextWindow);
    const toolDefinitionCharacters = estimateToolRegistryCharacters(tools);
    this.#recordToolRegistry(invocationId, tools);

    const conversationId = identity.conversationId;
    const runtime = this.#conversationRuntime;
    let entry = runtime.cachedAgent(conversationId);
    if (entry !== undefined && (entry.header.id !== header.id || entry.systemPromptHash !== stable.systemPromptHash)) {
      runtime.forget(conversationId);
      entry = undefined;
    }
    if (entry === undefined) {
      entry = this.#createCachedAgent(settings, identity, header, stable, model, tools);
      runtime.remember(entry);
    } else {
      // One Context, one header object. A cached entry carries the header of the
      // run that built it, and every writer here works through `entry.header`
      // (`#persistMessage`, `#maybeCollect`), while the injection path and the
      // capability resolver close over the handle from `open()`. Left as two
      // objects, the second handle never advanced: every batch after the first in
      // a cache-reusing run recorded the run's opening `next_seq` as the
      // `source_seq` of its media and reply references, so a later GC revoked
      // them one collection too early, and the resolver kept checking a
      // `head_seq` that a mid-run GC had already moved.
      entry.header = header;
    }
    const cached: CachedConversationAgent = entry;
    let carriedStickerCatalog: string | null = null;
    /**
     * The visible sender set follows the retained transcript: senders from
     * batches that were collected away must not stay alarm targets.
     */
    const rebuildVisibleState = (retained: readonly AgentMessage[]): void => {
      const senders = new Map<string, VisibleSender>();
      let callerUserId: bigint | null = null;
      for (const message of retained) {
        if (message.role !== 'user') {
          continue;
        }
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
        const collected = ContextBuilder.collectVisibleSenders(text);
        if (collected.length > 0) {
          callerUserId = collected.at(-1)?.userId ?? callerUserId;
        }
        for (const sender of collected) {
          senders.set(sender.userId.toString(), sender);
        }
      }
      contextState.retainVisibleSenders([...senders.values()]);
      // Retained history is not a fresh authorization for a receipt-only round.
      if (contextState.callerUserId !== null) {
        contextState.setCallerUserId(callerUserId);
      }
      // A GC can evict the batch that carried the catalog; the next batch must then
      // render it again.
      carriedStickerCatalog = lastStickerCatalog(retained);
    };
    rebuildVisibleState(cached.agent.state.messages);
    const agent = cached.agent;
    // Hooks close over this run's state, so a cached agent is re-bound on every
    // invocation instead of being rebuilt from the canonical history.
    agent.state.systemPrompt = stable.systemPrompt;
    agent.state.model = model;
    // The cached agent keeps the thinking level of the run that built it, so a
    // reused entry has to be re-bound here like the prompt and the model.
    agent.state.thinkingLevel = settings.thinking_level;
    agent.state.tools = [...tools];
    agent.maxRetryDelayMs = Math.max(0, deadline - Date.now());
    state.estimatedInputTokens = this.#estimateInputTokens(cached, toolDefinitionCharacters);
    // One entry per user message handed to the agent, in delivery order. A batch
    // carries its bucket so it is acknowledged only once it is in the transcript.
    const pendingUserTags: { readonly tag: 'checkpoint' | 'harness'; readonly bucketId: bigint | null }[] = [];
    const injectBatch = async (bucketId: bigint): Promise<AgentMessage> => {
      const injection = this.#contextBuilder.renderInjection(config, {
        header,
        identity,
        bucketId,
        seq: header.nextSeq,
        injectedMessageIds: collectTranscriptMessageIds(agent.state.messages),
        sleepy: isLowDailyTokenBudget(
          readDailyTokenBudget(this.#store.orm, this.#configStore.current().config.agent.daily_budget.max_tokens),
        ),
        supportsImages,
        contextWindow: model.contextWindow,
        toolDefinitionCharacters,
        maxOutputTokens: model.maxTokens,
        transcriptCharacters: estimateTranscriptCharacters(cached),
        agentModel: { provider: model.provider, model: model.id },
        carriedStickerCatalog,
      });
      contextState.applyInjection(injection);
      if (injection.stickerCatalog.length > 0) {
        carriedStickerCatalog = injection.stickerCatalog;
      }
      runtime.beginRound(conversationId);
      const images = supportsImages ? ((await this.#directImageLoader?.(contextState, signal)) ?? []) : [];
      pendingUserTags.push({ tag: 'checkpoint', bucketId });
      state.turnsSinceInjection = 0;
      state.sendUsed = false;
      state.nudged = false;
      state.estimatedInputTokens = Math.max(
        state.estimatedInputTokens,
        estimateMessagesTokens(agent.state.messages) +
          Math.ceil((injection.text.length + toolDefinitionCharacters) / 4),
      );
      this.#logContextInjected(invocationId, identity, bucketId, injection, header.nextSeq);
      return {
        role: 'user',
        content: [{ type: 'text', text: injection.text }, ...images],
        timestamp: Date.now(),
      };
    };
    const injectPending = async (includeCompletion: boolean, turnContext: AgentContext): Promise<boolean> => {
      if (contextState.completion !== null) {
        return false;
      }
      const pending = runtime.takeNextInjections(conversationId, includeCompletion);
      if (pending.length === 0) {
        return false;
      }
      for (const bucketId of pending) {
        // `steer` only queues the message. The bucket is marked injected when the
        // message is persisted (`message_end`), so a run that ends first leaves it
        // un-injected and `releaseUninjectedBuckets` re-queues the batch.
        agent.steer(await injectBatch(bucketId));
      }
      // Pi prepares tools before shouldStopAfterTurn. An injection after that
      // boundary (including an idle wake) must refresh this same loop snapshot.
      refreshZzz(turnContext);
      return true;
    };
    /**
     * The instant the agent is free again — a turn that called no tools, or a run
     * that is ending — is where the next batch's collection window starts, so a
     * batch whose messages arrived during this round collects a full window of
     * free-agent time instead of being handed over the moment the round ends.
     */
    const freeAgent = (): void => {
      typing.stop();
      runtime.endRound(conversationId);
      state.barrierSpent = false;
      this.#deferCollectingBucket(config, conversationId, Date.now());
    };
    const stop = (reason: StopReason): true => {
      // A run that ends frees the agent just like the end of a round does.
      freeAgent();
      state.stopReason = reason;
      state.contextClosing = true;
      runtime.beginClosing(conversationId);
      return true;
    };

    agent.streamFunction = async (streamModel, modelContext, options) => {
      if (
        !bypassDailyBudget() &&
        isDailyTokenBudgetReached(
          readDailyTokenBudget(this.#store.orm, this.#configStore.current().config.agent.daily_budget.max_tokens),
        )
      ) {
        state.modelBudgetBlocked = true;
        return errorStream(streamModel, 'daily_token_budget');
      }
      const release = await this.#modelGate.acquire(identity.chatId.toString(), signal);
      // Per-request visibility audit: the exact tool names this llmContext
      // carried (the loop can trim tools to send-only near the context limit).
      const callId = this.#startModelCall(
        invocationId,
        streamModel,
        modelContext.tools?.map((tool) => tool.name) ?? [],
      );
      const recordPayloads = this.#configStore.current().config.developer.record_model_payloads;
      try {
        const stream = snapshot.models.streamSimple(streamModel, modelContext, {
          ...options,
          signal,
          maxTokens: streamModel.maxTokens,
          maxRetries: 2,
          maxRetryDelayMs: Math.max(0, deadline - Date.now()),
          // Snapshot audit: capture the provider request payload without
          // retaining inline image bytes, plus the HTTP response status, so
          // rendered context and transport outcome stay inspectable.
          onPayload: (payload) => {
            if (recordPayloads && this.#configStore.current().config.developer.record_model_payloads) {
              this.#recordModelCallRequest(callId, payload);
            }
            return undefined;
          },
          onResponse: (response) => {
            if (recordPayloads && this.#configStore.current().config.developer.record_model_payloads) {
              this.#recordModelCallResponse(callId, response);
            }
          },
        });
        void stream
          .result()
          .then(
            (message) => {
              // Reported input tokens already cover the tool schemas this request
              // carried, so adding the registry estimate on top would double count
              // it — and because this runs per model call, the addend accumulated:
              // the estimate drifted upward by one registry per turn regardless of
              // how much history there actually was. In a long-lived invocation
              // that crossed `hard_token_ratio` on turn count alone, so GC threw
              // away live history and the run then ended as `context_limit`.
              state.estimatedInputTokens = Math.max(state.estimatedInputTokens, message.usage.input);
              this.#finishModelCall(callId, identity.chatId, message);
            },
            (error) => this.#failModelCall(callId, 'stream_rejected', error),
          )
          .finally(release)
          .catch(() => undefined);
        return stream;
      } catch (error) {
        release();
        this.#failModelCall(callId, 'model_setup_error', error);
        return errorStream(streamModel, this.#secrets.redactError(error));
      }
    };
    agent.beforeToolCall = async ({ toolCall }) => {
      if (
        toolCall.name !== 'zzz' &&
        !bypassDailyBudget() &&
        (state.sleepRequested || activeSleepUntil(this.#store.orm) !== null)
      ) {
        return { block: true, reason: 'The bot is sleeping', terminate: true };
      }
      if (
        toolCall.name === 'zzz' &&
        (bypassDailyBudget() ||
          !isLowDailyTokenBudget(
            readDailyTokenBudget(this.#store.orm, this.#configStore.current().config.agent.daily_budget.max_tokens),
          ))
      ) {
        return { block: true, reason: 'You are no longer sleepy' };
      }
      // Audit-only counter: there is no per-invocation tool-call cap. Runaway
      // loops stay bounded by the per-injection turn budget, the wall clock,
      // the context stop ratio, and the daily token budget.
      state.toolCalls += 1;
      this.#store.orm
        .update(invocations)
        .set({ toolCallsUsed: BigInt(state.toolCalls) })
        .where(eq(invocations.id, invocationId))
        .run();
      return undefined;
    };
    const refreshZzz = (turnContext: AgentContext): boolean => {
      const budget = readDailyTokenBudget(
        this.#store.orm,
        this.#configStore.current().config.agent.daily_budget.max_tokens,
      );
      const shouldExposeZzz = !bypassDailyBudget() && isLowDailyTokenBudget(budget);
      if (shouldExposeZzz === zzzExposed) {
        return false;
      }
      zzzExposed = shouldExposeZzz;
      const nextTools = (turnContext.tools ?? tools).filter((tool) => tool.name !== 'zzz');
      if (shouldExposeZzz) {
        nextTools.push(zzz);
        this.#logZzzExposure(invocationId, identity.chatId, budget);
        state.estimatedInputTokens += Math.ceil(estimateToolDefinitionCharacters(zzz) / 4);
      }
      validateToolRegistry(nextTools, model.contextWindow);
      this.#recordToolRegistry(invocationId, nextTools);
      turnContext.tools = nextTools;
      agent.state.tools = nextTools;
      return true;
    };
    agent.prepareNextTurnWithContext = async (turn) => {
      const registryChanged = refreshZzz(turn.context);
      const nextTools = turn.context.tools;
      // The only safe collection point: after the tool batch closed, before the
      // next model call. Never during streaming.
      const collected = this.#maybeCollect(
        config,
        cached,
        model,
        turn.context.messages,
        invocationId,
        state.estimatedInputTokens,
        rebuildVisibleState,
      );
      const messages = collected === undefined ? undefined : turn.context.messages.slice(collected.retainedIndex);
      if (collected !== undefined) {
        // The estimate is a high-water mark that model usage only ever raises, so
        // after a collection it still describes the history just dropped and
        // would push a run that GC had relieved straight into closing mode.
        state.estimatedInputTokens = this.#estimateInputTokens(
          cached,
          estimateToolRegistryCharacters(nextTools ?? tools),
        );
      }
      const stopThreshold = Math.floor(model.contextWindow * config.agent.context_stop_ratio);
      if (state.estimatedInputTokens >= stopThreshold) {
        state.contextClosing = true;
        state.stopReason = 'context_limit';
        const closingTools = (nextTools ?? tools).filter(
          (tool) => SEND_TOOL_NAMES.has(tool.name) || tool.name === 'zzz',
        );
        return {
          context: {
            ...turn.context,
            ...(messages === undefined ? {} : { messages }),
            ...(closingTools === undefined ? {} : { tools: closingTools }),
          },
        };
      }
      if (messages === undefined && !registryChanged) {
        return undefined;
      }
      return {
        context: {
          ...turn.context,
          ...(messages === undefined ? {} : { messages }),
          ...(nextTools === undefined ? {} : { tools: nextTools }),
        },
      };
    };
    agent.shouldStopAfterTurn = async (turn) => {
      if (!bypassDailyBudget() && (state.sleepRequested || activeSleepUntil(this.#store.orm) !== null)) {
        return stop('sleep');
      }
      if (
        !bypassDailyBudget() &&
        isDailyTokenBudgetReached(
          readDailyTokenBudget(this.#store.orm, this.#configStore.current().config.agent.daily_budget.max_tokens),
        )
      ) {
        return stop('budget');
      }
      if (state.contextClosing) {
        // Pi runs `prepareNextTurnWithContext` and then this hook at the same turn
        // boundary. Stopping on the flag the first time it is seen ended the run at
        // the very boundary that entered closing mode, so the send-only turn the
        // mode exists for never ran and a run near its window could not finish its
        // answer. Grant exactly one closing turn, then stop.
        if (state.closingTurnGranted) {
          return stop(state.stopReason);
        }
        state.closingTurnGranted = true;
        runtime.beginClosing(conversationId);
        return false;
      }
      if (state.turnsSinceInjection >= config.agent.rate_limits.turns_per_injection) {
        return stop('turn_budget');
      }
      // Safety net first, before anything that can extend the run: a newer batch
      // (or the idle grace) would otherwise swallow the current batch's draft.
      // Only when this turn produced no tool calls (a would-be final message), so
      // we never interrupt an in-progress workflow. The round is deliberately not
      // treated as over here: the agent still owes a published answer.
      const hasToolCalls = turn.message.content.some((entry) => entry.type === 'toolCall');
      if (config.agent.send_nudge_enabled === true && !state.sendUsed && !state.nudged) {
        const text = turn.message.content
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join('');
        if (!hasToolCalls && text.trim().length > 0) {
          state.nudged = true;
          pendingUserTags.push({ tag: 'harness', bucketId: null });
          agent.steer({ role: 'user', content: [{ type: 'text', text: SEND_NUDGE_TEXT }], timestamp: Date.now() });
          this.recordAgentMessage(invocationId, 'harness_nudge', SEND_NUDGE_TEXT);
          return false;
        }
      }
      if (!hasToolCalls && contextState.completion !== null) {
        // A receipt's exemption ends with its round, not with the Invocation.
        // Pending ordinary messages must never spend that exemption.
        contextState.finishCompletion();
        refreshZzz(turn.context);
        if (
          state.sleepRequested ||
          activeSleepUntil(this.#store.orm) !== null ||
          isDailyTokenBudgetReached(
            readDailyTokenBudget(this.#store.orm, this.#configStore.current().config.agent.daily_budget.max_tokens),
          )
        ) {
          return stop('completed');
        }
      }
      // User batches keep their existing turn-boundary semantics. Completion
      // receipts enter one at a time between rounds, never interrupting tools or
      // merging independent mention/budget policies into one model response.
      if (!hasToolCalls) {
        typing.stop();
      }
      if (await injectPending(!hasToolCalls, turn.context)) {
        return false;
      }
      const idleGraceMilliseconds = config.agent.context.idle_grace_seconds * 1_000;
      // The grace belongs to the end of a round, not to every turn. A turn that
      // ended with tool calls, or one with a batch already queued to inject, is
      // followed by another turn regardless, so waiting here would only delay it:
      // a three-step round used to pay the grace after every step, and a batch
      // injected while the model was working paid it before being answered.
      // A batch that becomes due while a tool runs is still picked up at the next
      // turn boundary, and if that boundary falls just before the attach lands the
      // queued injection wakes this wait immediately.
      const roundIsOver = !hasToolCalls && !runtime.hasPendingInjections(conversationId);
      if (roundIsOver) {
        freeAgent();
      }
      if (roundIsOver && idleGraceMilliseconds > 0 && Date.now() < deadline) {
        const waited = await runtime.waitForInjection(
          conversationId,
          Math.min(idleGraceMilliseconds, Math.max(0, deadline - Date.now())),
          signal,
        );
        if (waited === 'pending' && (await injectPending(true, turn.context))) {
          return false;
        }
        if (waited === 'aborted') {
          return false;
        }
      }
      if (Date.now() >= deadline) {
        return stop('wall_clock');
      }
      if (roundIsOver) {
        // The loop is about to end on its own: no tool calls this turn and nothing
        // queued, which is exactly Pi's own exit condition. `stop()` never runs on
        // this path, so without marking the run closing here the attach path stayed
        // open for the whole teardown and could hand over a batch that no turn
        // boundary would ever inject.
        runtime.beginClosing(conversationId);
      }
      // Nothing to force: the loop ends on its own once the model stops calling
      // tools. Forcing a stop here would cut the answer short.
      return false;
    };
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'turn_end') {
        state.turns += 1;
        state.turnsSinceInjection += 1;
        this.#store.orm
          .update(invocations)
          .set({ turnsUsed: BigInt(state.turns) })
          .where(eq(invocations.id, invocationId))
          .run();
      }
      if (event.type === 'tool_execution_end' && SEND_TOOL_NAMES.has(event.toolName)) {
        state.sendUsed = true;
      }
      if (event.type !== 'message_end') {
        return;
      }
      const pendingUser = event.message.role === 'user' ? pendingUserTags.shift() : undefined;
      this.#persistMessage(cached, invocationId, event.message, pendingUser?.tag === 'checkpoint');
      if (pendingUser !== undefined && pendingUser.bucketId !== null) {
        this.#markBucketInjected(invocationId, pendingUser.bucketId);
      }
      if (event.message.role === 'assistant') {
        const text = event.message.content
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join('');
        this.recordAgentMessage(invocationId, 'assistant', text);
      } else if (event.message.role === 'toolResult') {
        const text = event.message.content
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join('');
        this.recordAgentMessage(invocationId, 'tool_result', text);
      }
    });
    const abortAgent = (): void => agent.abort();
    signal.addEventListener('abort', abortAgent, { once: true });
    let outcome: InvocationOutcome | undefined;
    try {
      this.#contexts.touch(header, invocationId);
      const openingBucket = this.#openingBucketId(invocationId);
      await agent.prompt(await injectBatch(openingBucket));
      if (signal.aborted) {
        const unknown =
          this.#store.orm
            .select({ id: toolCallsTable.id })
            .from(toolCallsTable)
            .where(and(eq(toolCallsTable.invocationId, invocationId), eq(toolCallsTable.state, 'outcome_unknown')))
            .limit(1)
            .get() !== undefined;
        outcome = {
          state: unknown ? 'outcome_unknown' : 'aborted',
          reason: timeoutSignal.aborted ? 'timeout' : 'aborted',
        };
      } else if (state.modelBudgetBlocked) {
        outcome = { state: 'failed', reason: 'daily_token_budget' };
      } else if (agent.state.errorMessage !== undefined) {
        outcome = { state: 'failed', reason: 'model_error' };
      } else {
        outcome = { state: 'completed', reason: state.stopReason };
      }
    } finally {
      typing.stop();
      signal.removeEventListener('abort', abortAgent);
      unsubscribe();
      // The cached agent keeps its transcript on purpose: the next invocation
      // of this Conversation continues where this one stopped.
      agent.clearAllQueues();
      // A batch that was attached but never reached a turn boundary must not stay
      // queued in memory: the next run of this Conversation would take it from the
      // queue and inject it a second time, on top of the opening injection it has
      // by then become. The database side is the scheduler's job — those rows still
      // have `injected_at IS NULL`, so `releaseUninjectedBuckets` re-queues them.
      runtime.takeInjections(conversationId);
      runtime.endClosing(conversationId);
      // Backstop for the paths that never reach `freeAgent` (abort mid-round, a
      // thrown error): the flag must not outlive the run, or the conversation
      // would look busy forever and its batches would never be attached.
      runtime.endRound(conversationId);
      this.#contexts.clearActiveInvocation(invocationId);
      this.#contexts.touch(header, null);
      // A failed run must not leave a half-broken transcript behind that the
      // next invocation would happily replay. That covers a thrown error too
      // (`outcome` is only set on a normal return): a persistence failure can
      // throw after the agent added a message but before `transcriptSeqs` knew
      // of it, and the next run would trip over the diverged arrays again.
      if (outcome === undefined || agent.state.errorMessage !== undefined) {
        runtime.forget(conversationId);
      }
    }
    if (outcome === undefined) {
      throw new Error('Agent run ended without an outcome');
    }
    return outcome;
  }

  #sendRateLimit(config: RawConfig): { sendsPerWindow: number; windowSeconds: number } {
    return {
      sendsPerWindow: config.agent.rate_limits.sends_per_window,
      windowSeconds: config.agent.rate_limits.window_seconds,
    };
  }

  /**
   * Anchors the next batch's collection window at the moment the agent becomes
   * free. A batch that collected while the model was working (its messages
   * arrived mid-round) would otherwise be handed over the instant the round ends,
   * having collected far less than `telegram.bucket_window_seconds`.
   *
   * Extension-only: a batch whose own deadline is already later — one whose first
   * message arrived after this round ended — keeps it. The write is what also
   * re-schedules the scheduler, which recomputes its next wake from deadlines.
   */
  #deferCollectingBucket(config: RawConfig, conversationId: bigint, freeSince: number): void {
    const atLeast = new Date(freeSince + config.telegram.bucket_window_seconds * 1_000).toISOString();
    this.#store.orm.run(
      sql`UPDATE buckets SET deadline_at = ${atLeast}, updated_at = ${new Date(freeSince).toISOString()}
         WHERE conversation_id = ${conversationId} AND state = 'collecting' AND deadline_at < ${atLeast}`,
    );
  }

  #capabilitiesFor(header: ContextHeader): CapabilityRefResolver {
    return createCapabilityResolver(this.#refs, header);
  }

  get #staticCapabilities(): CapabilityRefResolver {
    return unavailableCapabilities();
  }

  /**
   * The retained window to seed from, repaired if it does not start on a turn
   * boundary.
   *
   * GC only ever cuts to a checkpoint, so the window is normally valid. An
   * eviction that lands while a run is still writing is not: `/cut_topic` moves
   * `head_seq` to the end of the history, and a tool result the aborting run
   * still had in flight then lands above the new head with its assistant tool
   * call already dropped. `pi-ai` repairs a missing tool result but forwards an
   * orphaned one verbatim, so the provider rejects every request and the whole
   * Conversation fails until someone cuts the topic again. Cutting forward to the
   * first turn boundary costs at most the tail of one interrupted turn.
   */
  #alignedRetained(identity: ContextIdentity, header: ContextHeader): RetainedContextMessage[] {
    const retained = this.#contexts.retained(header);
    if (retained.length === 0 || isRenderable(retained.map((row) => row.message))) {
      return retained;
    }
    const boundary = retained.find((row) => row.message.role === 'user');
    if (boundary !== undefined && boundary.seq > header.headSeq) {
      this.#contexts.advanceHead(header, boundary.seq);
      const realigned = this.#contexts.retained(header);
      if (isRenderable(realigned.map((row) => row.message))) {
        this.#logContextRealigned(identity, header, boundary.seq);
        return realigned;
      }
    }
    // No usable boundary at all: the window cannot be made renderable, so it goes
    // rather than poisoning every later invocation.
    this.#contexts.clear(header);
    this.#logContextRealigned(identity, header, null);
    return [];
  }

  /**
   * Seeds a Pi agent from the canonical history. Everything the agent knows at
   * this point comes from `context_messages`; the transcript cache is rebuilt
   * identically after an eviction or a process restart.
   */
  #createCachedAgent(
    settings: AgentSettings,
    identity: ContextIdentity,
    header: ContextHeader,
    stable: StablePrompt,
    model: Model<Api>,
    tools: readonly AgentTool[],
  ): CachedConversationAgent {
    const retained = this.#alignedRetained(identity, header);
    const agent = new Agent({
      initialState: {
        systemPrompt: stable.systemPrompt,
        model,
        thinkingLevel: settings.thinking_level,
        tools: [...tools],
        messages: retained.map((row) => row.message),
      },
      streamFn: () => {
        throw new Error('Agent stream function is bound per invocation');
      },
    });
    agent.toolExecution = 'sequential';
    return {
      conversationId: identity.conversationId,
      agent,
      header,
      transcriptSeqs: retained.map((row) => row.seq),
      systemPromptHash: stable.systemPromptHash,
      lastUsedAt: Date.now(),
    };
  }

  #persistMessage(
    entry: CachedConversationAgent,
    invocationId: bigint,
    message: AgentMessage,
    isCheckpoint: boolean,
  ): bigint | undefined {
    const encoded = encodeContextMessage(message);
    if (encoded === undefined) {
      entry.transcriptSeqs.push(null);
      return undefined;
    }
    const seq = this.#contexts.append(entry.header, {
      invocationId,
      isCheckpoint,
      estTokens: estimateMessageTokens(message),
      json: encoded.json,
      role: encoded.role,
      countedSend:
        encoded.role === 'toolResult' &&
        message.role === 'toolResult' &&
        SEND_TOOL_NAMES.has(message.toolName) &&
        message.isError !== true &&
        !(
          message.details !== null &&
          typeof message.details === 'object' &&
          'replayed' in message.details &&
          message.details.replayed === true
        ),
    });
    entry.transcriptSeqs.push(seq);
    if (entry.transcriptSeqs.length !== entry.agent.state.messages.length) {
      throw new Error('Conversation transcript diverged from the canonical history');
    }
    return seq;
  }

  #openingBucketId(invocationId: bigint): bigint {
    const row = this.#store.orm
      .select({ bucketId: invocations.bucketId })
      .from(invocations)
      .where(eq(invocations.id, invocationId))
      .get();
    if (row === undefined) {
      throw new Error(`Invocation ${invocationId} does not exist`);
    }
    return row.bucketId;
  }

  #markBucketInjected(invocationId: bigint, bucketId: bigint): void {
    this.#store.orm.run(
      sql`UPDATE invocation_buckets SET injected_at = ${new Date().toISOString()}
          WHERE invocation_id = ${invocationId} AND bucket_id = ${bucketId} AND injected_at IS NULL`,
    );
  }

  /**
   * Discard-only collection at a turn boundary. Four things must move together
   * or the transcript forks: the canonical `head_seq`, the loop context, the
   * cached `Agent.state.messages`, and the references carried by evicted rows.
   */
  #maybeCollect(
    config: RawConfig,
    entry: CachedConversationAgent,
    // The model this run actually talks to. The constructor-time default is wrong
    // after a runtime `/model` switch: GC then judged token pressure against one
    // window while the closing threshold used another, so a switch to a smaller
    // model overran its window and a switch to a larger one collected live history.
    model: Model<Api>,
    loopMessages: readonly AgentMessage[],
    invocationId: bigint,
    estimatedInputTokens: number,
    onRetained: (retained: readonly AgentMessage[]) => void,
  ): ContextGcPlan | undefined {
    const header = entry.header;
    const plan = planContextGc({
      retainedSendsTarget: config.agent.context.retained_sends_target,
      retainedSendsMax: config.agent.context.retained_sends_max,
      hardTokenRatio: config.agent.context.hard_token_ratio,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      estimatedInputTokens,
      headSeq: header.headSeq,
      transcriptSeqs: entry.transcriptSeqs,
      window: this.#contexts.window(header),
      messages: loopMessages,
    });
    if (plan === undefined) {
      return undefined;
    }
    // Captured before the move: `advanceHead` sets `headSeq` to `targetSeq`, so
    // reading it afterwards only reported the target twice and lost the one number
    // that says how much this collection dropped.
    const previousHeadSeq = header.headSeq;
    this.#contexts.advanceHead(header, plan.targetSeq);
    const retained = loopMessages.slice(plan.retainedIndex);
    entry.transcriptSeqs = entry.transcriptSeqs.slice(plan.retainedIndex);
    entry.agent.state.messages = [...retained];
    onRetained(retained);
    this.#logContextGc(invocationId, header, previousHeadSeq, plan);
    return plan;
  }

  #estimateInputTokens(entry: CachedConversationAgent, toolDefinitionCharacters: number): number {
    const window = this.#contexts.window(entry.header);
    const retained = window.reduce((total, row) => total + Number(row.estTokens), 0);
    return retained + Math.ceil(toolDefinitionCharacters / 4);
  }

  #recordToolRegistry(invocationId: bigint, tools: readonly AgentTool[]): void {
    const toolRegistryHash = createHash('sha256')
      .update(
        tools
          .map((tool) =>
            JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
          )
          .join('\n'),
      )
      .digest('hex');
    const toolRegistry = tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description }));
    this.#store.orm
      .update(invocations)
      .set({ toolRegistryHash, toolRegistryJson: JSON.stringify(toolRegistry) })
      .where(eq(invocations.id, invocationId))
      .run();
  }

  #logZzzExposure(invocationId: bigint, chatId: bigint, budget: DailyTokenBudget): void {
    console.log(
      JSON.stringify({
        event: 'agent_low_token_budget',
        invocation_id: invocationId.toString(),
        chat_id: chatId.toString(),
        used_tokens: budget.usedTokens.toString(),
        max_tokens: budget.maxTokens.toString(),
        at: new Date().toISOString(),
      }),
    );
    console.log(
      JSON.stringify({
        event: 'zzz_tool_exposed',
        invocation_id: invocationId.toString(),
        chat_id: chatId.toString(),
        at: new Date().toISOString(),
      }),
    );
  }

  #logInvocationError(invocationId: bigint, error: unknown): void {
    try {
      console.log(
        JSON.stringify({
          event: 'agent_invocation_error',
          invocation_id: invocationId.toString(),
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: this.#secrets.redactError(error),
          at: new Date().toISOString(),
        }),
      );
    } catch {
      // A failing log line must never replace the error it was meant to explain.
    }
  }

  #logContextRebuilt(identity: ContextIdentity, systemPromptHash: string): void {
    console.log(
      JSON.stringify({
        event: 'context_rebuilt',
        conversation_id: identity.conversationId.toString(),
        chat_id: identity.chatId.toString(),
        thread_id: identity.threadId.toString(),
        system_prompt_hash: systemPromptHash,
        at: new Date().toISOString(),
      }),
    );
  }

  #logContextRealigned(identity: ContextIdentity, header: ContextHeader, boundarySeq: bigint | null): void {
    console.log(
      JSON.stringify({
        event: 'context_realigned',
        conversation_id: identity.conversationId.toString(),
        chat_id: identity.chatId.toString(),
        head_seq: header.headSeq.toString(),
        boundary_seq: boundarySeq === null ? null : boundarySeq.toString(),
        cleared: boundarySeq === null,
        at: new Date().toISOString(),
      }),
    );
  }

  #logContextInjected(
    invocationId: bigint,
    identity: ContextIdentity,
    bucketId: bigint,
    injection: Injection,
    seq: bigint,
  ): void {
    console.log(
      JSON.stringify({
        event: 'context_injected',
        invocation_id: invocationId.toString(),
        conversation_id: identity.conversationId.toString(),
        chat_id: identity.chatId.toString(),
        bucket_id: bucketId.toString(),
        seq: seq.toString(),
        checkpoint: true,
        message_count: injection.messageCount,
        history_count: injection.historyCount,
        omitted_new_messages: injection.omittedNewMessages,
        characters: injection.text.length,
        at: new Date().toISOString(),
      }),
    );
  }

  #logContextGc(invocationId: bigint, header: ContextHeader, previousHeadSeq: bigint, plan: ContextGcPlan): void {
    console.log(
      JSON.stringify({
        event: 'context_gc',
        invocation_id: invocationId.toString(),
        conversation_id: header.conversationId.toString(),
        previous_head_seq: previousHeadSeq.toString(),
        head_seq: header.headSeq.toString(),
        target_seq: plan.targetSeq.toString(),
        before_tokens: plan.beforeTokens,
        after_tokens: plan.afterTokens,
        before_sends: plan.beforeSends,
        after_sends: plan.afterSends,
        before_messages: plan.beforeMessages,
        after_messages: plan.afterMessages,
        at: new Date().toISOString(),
      }),
    );
  }

  #startModelCall(invocationId: bigint, model: Model<Api>, tools: readonly string[]): bigint {
    const created = this.#store.orm
      .insert(modelCalls)
      .values({
        invocationId,
        role: 'agent',
        provider: model.provider,
        model: model.id,
        attempt: 1n,
        state: 'pending',
        toolsJson: JSON.stringify(tools),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: modelCalls.id })
      .get();
    if (created === undefined) {
      throw new Error('model_calls insert returned no row');
    }
    return created.id;
  }
  #recordModelCallRequest(callId: bigint, payload: unknown): void {
    try {
      this.#store.orm
        .update(modelCalls)
        .set({ requestJson: serializeModelRequestForAudit(payload) })
        .where(and(eq(modelCalls.id, callId), isNull(modelCalls.requestJson)))
        .run();
    } catch {
      // Snapshotting is best-effort auditing; never break the model call itself.
    }
  }

  #recordModelCallResponse(callId: bigint, response: { status: number; headers: Record<string, string> }): void {
    try {
      this.#store.orm
        .update(modelCalls)
        .set({ responseJson: JSON.stringify({ status: response.status }) })
        .where(and(eq(modelCalls.id, callId), isNull(modelCalls.responseJson)))
        .run();
    } catch {
      // Same best-effort audit write as the request snapshot above.
    }
  }

  #finishModelCall(callId: bigint, chatId: bigint, message: AssistantMessage): void {
    this.#store.transaction(() => {
      const usage = message.usage;
      const now = new Date().toISOString();
      this.#store.orm
        .update(modelCalls)
        .set({
          state: message.stopReason === 'error' || message.stopReason === 'aborted' ? 'error' : 'success',
          inputTokens: BigInt(usage.input),
          outputTokens: BigInt(usage.output),
          cacheReadTokens: BigInt(usage.cacheRead),
          cacheWriteTokens: BigInt(usage.cacheWrite),
          totalTokens: BigInt(usage.totalTokens),
          cost: usage.cost.total,
          errorCode:
            message.stopReason === 'error' ? 'model_error' : message.stopReason === 'aborted' ? 'model_aborted' : null,
          errorDetail: message.errorMessage === undefined ? null : this.#secrets.redact(message.errorMessage),
          finishedAt: now,
        })
        .where(eq(modelCalls.id, callId))
        .run();
      this.#store.orm
        .insert(dailyUsage)
        .values({
          utcDate: now.slice(0, 10),
          scope: 'chat',
          resource: chatId.toString(),
          metric: 'model_tokens',
          amount: meteredTokens(usage),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [dailyUsage.utcDate, dailyUsage.scope, dailyUsage.resource, dailyUsage.metric],
          set: {
            amount: sql`${dailyUsage.amount} + excluded.amount`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    });
  }

  #failModelCall(callId: bigint, errorCode: string, error: unknown): void {
    this.#store.orm
      .update(modelCalls)
      .set({
        state: 'error',
        errorCode,
        errorDetail: this.#secrets.redactError(error),
        finishedAt: new Date().toISOString(),
      })
      .where(and(eq(modelCalls.id, callId), eq(modelCalls.state, 'pending')))
      .run();
  }

  recordAgentMessage(invocationId: bigint, role: 'assistant' | 'tool_result' | 'harness_nudge', text: string): bigint {
    const sequence =
      this.#store.orm
        .all<{ value: bigint }>(
          sql`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS value FROM agent_messages WHERE invocation_id = ${invocationId}`,
        )
        .at(0)?.value ?? 1n;
    const created = this.#store.orm
      .insert(agentMessages)
      .values({
        invocationId,
        sequenceNo: sequence,
        role,
        text,
        thinkingText: '',
        createdAt: new Date().toISOString(),
      })
      .returning({ id: agentMessages.id })
      .get();
    if (created === undefined) {
      throw new Error('agent_messages insert returned no row');
    }
    return created.id;
  }
}

function estimateToolDefinitionCharacters(tool: AgentTool): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }).length;
}

function estimateToolRegistryCharacters(tools: readonly AgentTool[]): number {
  return tools.reduce((total, tool) => total + estimateToolDefinitionCharacters(tool), 0);
}

function estimateTranscriptCharacters(entry: CachedConversationAgent): number {
  return estimateMessagesTokens(entry.agent.state.messages) * 4;
}

function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** The newest sticker catalog a retained transcript batch carries, or `null`. */
function lastStickerCatalog(messages: readonly AgentMessage[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role !== 'user') {
      continue;
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    const catalog = ContextBuilder.collectStickerCatalog(text);
    if (catalog !== null) {
      return catalog;
    }
  }
  return null;
}

/**
 * Telegram message IDs the retained transcript already carries, so the next
 * injection renders only the history rows that never reached the model.
 */
function collectTranscriptMessageIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    for (const id of ContextBuilder.collectInjectedMessageIds(text)) {
      ids.add(id);
    }
  }
  return ids;
}

function validateToolRegistry(tools: readonly AgentTool[], contextWindow: number): void {
  if (tools.length > 64) {
    throw new Error(`Tool registry has ${tools.length} tools; maximum is 64`);
  }
  const characters = estimateToolRegistryCharacters(tools);
  if (characters / 4 > contextWindow * 0.1) {
    throw new Error('Tool registry exceeds 10% of the model context window');
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

function errorStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'error', reason: 'error', error: message });
  return stream;
}
