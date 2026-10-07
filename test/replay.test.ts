import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ImageContent,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';
import Type, { type TSchema } from 'typebox';
import { afterEach, expect, test } from 'vitest';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { ContextBuilder, type StablePrompt } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { clearModelPayloads } from '../src/ingress/admin/developer-admin.ts';
import { type ReplayPromptOverrides, ReplayRunner } from '../src/orchestration/replay.ts';
import { composeAgentPrompt } from '../src/platform/agent-prompt.ts';
import { CORE_AGENT_PROTOCOL } from '../src/platform/agent-protocol.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { type FileConfig, loadConfig, type RawConfig } from '../src/platform/config.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, SystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { SqliteStore } from '../src/store/database.ts';
import { invocationMessages, invocations, media, messageRevisions, messages, modelCalls } from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { fauxRegistry, type TestRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/**
 * Scene replay contract: a replay no longer reads a recorded model request.
 * It rebuilds one historical public group-chat scene from the seeded chat
 * (`seedAdminFixture` provides the real chat, conversation, bucket, invocation
 * and frozen opening batch), runs it against the *current* prompt layers, the
 * current chat's model, and the current tool registry, and only ever produces
 * synthetic side effects. Recording mode and model-call payloads are irrelevant.
 *
 * `prepareScene` completes the seeded fixture into the shape the scene builder
 * reads: a valid opening-batch snapshot plus public history before the scene
 * cutoff (including a bot message) and one message after it.
 */

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

/** invocations.created_at of the seeded invocation A: the scene cutoff. */
const CUTOFF_AT = '2026-09-10T07:59:45.000Z';
const OPENING_TEXT = 'plain text message with a reply';
const HISTORY_CAPTION = 'history photo caption';
const LATE_TEXT = 'message after the scene cutoff';
const HISTORY_MESSAGE = 6_050n;
const HISTORY_REVISION = 6_150n;
const HISTORY_MEDIA = 6_250n;
const LATE_MESSAGE = 6_051n;
const LATE_REVISION = 6_151n;

const SCENE_FIDELITY = {
  input: 'historical_public_chat',
  model_selection: 'current_chat_config',
  prompt_selection: 'current_chat_config',
  tool_selection: 'current_registry',
  hot_injections: 'not_replayed',
  external_tools: 'blocked',
  system_resources: 'current_read_only',
  side_effects: 'synthetic',
} as const;

/** Fixture executors throw: a scene test must never reach a production tool. */
const unusedExecutor: AgentTool['execute'] = async () => {
  throw new Error('fixture executor must never run');
};

function definition(name: string, parameters: TSchema = Type.Object({})): AgentTool {
  return { name, label: name, description: `fixture ${name}`, parameters, execute: unusedExecutor };
}

/** The registry a caller may inject through `toolDefinitions`, like production does. */
function sceneRegistry(): { readonly tools: readonly AgentTool[]; readonly capabilities: readonly AgentTool[] } {
  return {
    tools: [
      definition('read', Type.Object({ uri: Type.String(), base: Type.Optional(Type.String()) })),
      definition('send', SendInputSchema),
      definition('execute'),
      definition('zzz'),
      definition('mcp_remote_write'),
    ],
    capabilities: [
      definition('add_memory', AddMemoryInputSchema),
      definition('alarm', AlarmInputSchema),
      definition('list_alarm', ListAlarmInputSchema),
      definition('search_stickers'),
    ],
  };
}

/**
 * Turns the seeded fixture into a complete scene:
 * - the seeded opening batch (messageB) gets the full snapshot shape the current
 *   writer stores, so it is a valid frozen `new` batch;
 * - a bot message before the cutoff joins the public history (with one photo,
 *   which a text-only scene reports as omitted), and a message after the cutoff
 *   proves the scene never reads past the opening bucket.
 */
function prepareScene(store: SqliteStore, seed: ReturnType<typeof seedAdminFixture>): void {
  const orm = store.orm;
  // The Admin rendering seed intentionally uses abbreviated snapshots. This
  // fixture exercises as-of history and supplies its own complete opening row.
  orm
    .delete(invocationMessages)
    .where(and(eq(invocationMessages.invocationId, seed.invocationA), eq(invocationMessages.section, 'history')))
    .run();
  orm
    .update(invocationMessages)
    .set({
      snapshotJson: JSON.stringify({
        message_id: '901',
        telegram_date: '2026-09-10T08:00:05.000Z',
        sent_by_bot: false,
        revision: '1',
        sender: { id: '42', name: 'Alice', username: 'alice' },
        kind: 'text',
        text: OPENING_TEXT,
        caption: null,
        reply_to_message_id: null,
        reply_snapshot: null,
        forward_origin: null,
        media_group_id: null,
        media: [],
      }),
    })
    .where(and(eq(invocationMessages.invocationId, seed.invocationA), eq(invocationMessages.section, 'new')))
    .run();
  orm
    .insert(messages)
    .values({
      id: HISTORY_MESSAGE,
      conversationId: seed.conversationId,
      chatId: seed.chatId,
      telegramMessageId: 880n,
      currentRevisionId: null,
      visible: true,
      sentByBot: true,
      telegramDate: '2026-09-10T07:58:00.000Z',
      receivedAt: '2026-09-10T07:58:01.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: HISTORY_REVISION,
      messageId: HISTORY_MESSAGE,
      revisionNo: 1n,
      senderId: null,
      kind: 'photo',
      text: null,
      caption: HISTORY_CAPTION,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T07:58:02.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(media)
    .values({
      id: HISTORY_MEDIA,
      revisionId: HISTORY_REVISION,
      kind: 'photo',
      fileId: 'file_history_seed',
      fileUniqueId: 'unique_history_seed',
      mimeType: 'image/jpeg',
      fileSize: 4_096n,
      width: 640n,
      height: 480n,
      telegramJson: '{}',
    })
    .run();
  orm
    .insert(messages)
    .values({
      id: LATE_MESSAGE,
      conversationId: seed.conversationId,
      chatId: seed.chatId,
      telegramMessageId: 999n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      telegramDate: '2026-09-10T08:30:00.000Z',
      receivedAt: '2026-09-10T08:30:00.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: LATE_REVISION,
      messageId: LATE_MESSAGE,
      revisionNo: 1n,
      senderId: null,
      kind: 'text',
      text: LATE_TEXT,
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T08:30:00.000Z',
      rawFragmentJson: '{}',
    })
    .run();
}

interface FixtureOptions {
  readonly change?: (config: FileConfig) => void;
  readonly contextWindow?: number;
  readonly images?: boolean;
  readonly imageLoader?: (mediaId: bigint, signal: AbortSignal) => Promise<ImageContent>;
  readonly resources?: SystemResources;
  /** Same hook production wires through `AgentRuntime.sceneToolDefinitions`. */
  readonly defaultRegistry?: boolean;
  readonly definitions?: (
    context: InvocationContext,
    config: RawConfig,
  ) => {
    readonly tools: readonly AgentTool[];
    readonly capabilities: readonly AgentTool[];
  };
  /** The rendered global prompt layer; defaults to the fixture's 'Participate safely.'. */
  readonly systemPrompt?: string;
  /**
   * Builds a registry beyond the single agent faux (e.g. for cross-provider
   * selection). `extra` are the additional faux handles the test asserts on.
   */
  readonly registry?: (faux: FauxProviderHandle) => {
    readonly registry: TestRegistry;
    readonly extra: readonly FauxProviderHandle[];
  };
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-replay-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(directory, path, testConfigJsonc(directory, options.change), options.systemPrompt);
  const loaded = await loadConfig(path);
  const faux = fauxProvider({
    provider: 'agent',
    models: [
      {
        id: 'agent-model',
        input: options.images === true ? ['text', 'image'] : ['text'],
        contextWindow: options.contextWindow ?? 200_000,
        maxTokens: 128,
      },
    ],
    tokenSize: { min: 100_000, max: 100_000 },
  });
  const built = options.registry?.(faux);
  const configStore = await testConfigStore(loaded, built?.registry ?? fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const seed = seedAdminFixture(store);
  prepareScene(store, seed);
  const secrets = new SecretStore();
  const shutdown = new AbortController();
  const gate = new KeyedSemaphore();
  const runner = new ReplayRunner({
    store,
    configStore,
    secrets,
    systemResources: options.resources ?? SystemResources.empty(),
    modelGate: gate,
    shutdownSignal: shutdown.signal,
    ...(options.imageLoader === undefined ? {} : { imageLoader: options.imageLoader }),
    ...(options.defaultRegistry === true ? {} : { toolDefinitions: options.definitions ?? (() => sceneRegistry()) }),
  });
  const run = (override: ReplayPromptOverrides = {}, signal: AbortSignal = new AbortController().signal) =>
    runner.run(seed.invocationA, override, signal);
  return {
    directory,
    loaded,
    faux,
    extraFauxes: built?.extra ?? [],
    configStore,
    store,
    seed,
    secrets,
    shutdown,
    gate,
    runner,
    run,
    rows: () => stateRows(store),
  };
}

/** Every table and all of its rows, for before/after comparison. */
function stateRows(store: SqliteStore): Record<string, unknown[]> {
  const names = store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}

/** The stable prompt the scene composes from the current config, with no skills. */
function stablePrompt(store: SqliteStore, config: RawConfig, invocationId: bigint): StablePrompt {
  const builder = new ContextBuilder(
    store,
    new ContextRefStore(store, { ttlHours: config.agent.context.ref_ttl_hours }),
  );
  return builder.buildSystemPrompt(config, builder.identity(config, invocationId), false, {
    provider: config.agent.provider,
    model: config.agent.model,
  });
}

/** All model-visible message text as one string; layout details stay free. */
function messageText(context: { readonly messages: readonly unknown[] }): string {
  return JSON.stringify(context.messages);
}

/** Asserts a synchronous ReplayError code; returns the error for further checks. */
function replayError(action: () => unknown, code: string): Error {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error as Error;
  }
  throw new Error(`expected replay error ${code}`);
}

test('a scene replay runs the historical public chat under the current config with synthetic effects and no writes', async () => {
  const contexts: InvocationContext[] = [];
  const f = await fixture({
    definitions: (context) => {
      contexts.push(context);
      return sceneRegistry();
    },
  });
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);

  // The read-only preflight describes the scene without any model request.
  expect(f.runner.inspect(f.seed.invocationA)).toEqual({
    available: true,
    reason: null,
    message: null,
    prompt_overrides_available: true,
    omitted_images: 1,
    fidelity: { ...SCENE_FIDELITY },
    scene: {
      cutoff_at: CUTOFF_AT,
      source_bucket_id: '3001',
      message_count: 2,
      history_count: 1,
      omitted_messages: 0,
    },
  });
  expect(f.runner.prompts(f.seed.invocationA)).toEqual({
    source: 'active',
    source_invocation_id: '4001',
    global_prompt: 'Participate safely.',
    group_prompt: 'private',
    template_values: {
      agent: { provider: 'agent', model: 'agent-model' },
      vision: { provider: 'vision', model: 'vision-model' },
      timezone: 'UTC',
    },
    core_read_only: true,
  });
  expect(f.faux.state.callCount).toBe(0);

  f.faux.setResponses([
    (context, options) => {
      expect(context.systemPrompt).toBe(stable.systemPrompt);
      // The scene carries the public chat: the bot's own earlier message, the
      // opening batch, a text-only media marker, and nothing past the cutoff or
      // from the internal agent history.
      const scene = messageText(context);
      expect(scene).toContain(HISTORY_CAPTION);
      expect(scene).toContain('media_unavailable');
      expect(scene).toContain(OPENING_TEXT);
      expect(scene).not.toContain(LATE_TEXT);
      expect(scene).not.toContain('private reasoning before calling read');
      expect(scene).not.toContain('trying to answer but the model call failed');
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 128 });
      return fauxAssistantMessage(
        [
          fauxToolCall('send', { kind: 'text', text: 'synthetic scene send' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'synthetic scene memory' } }),
          fauxToolCall('execute', { action: 'call', tool: 'search_stickers', input: {} }),
          fauxToolCall('mcp_remote_write', {}),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('private completion'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result).toMatchObject({
    version: 2,
    source_invocation_id: '4001',
    conversation_id: '2001',
    chat_id: '123456789',
    thread_id: '0',
    error: null,
    responded: true,
    send_count: 1,
    completion_reason: 'completed',
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'low' },
    overrides: { global_prompt: false, group_prompt: false },
    usage: { model_calls: 2 },
    fidelity: { ...SCENE_FIDELITY },
  });
  expect(result).not.toHaveProperty('source_model_call_id');
  expect(result.fidelity).not.toHaveProperty('historical_model');
  expect(result.outputs).toEqual([
    expect.objectContaining({
      tool_name: 'send',
      arguments: expect.objectContaining({ text: 'synthetic scene send' }),
    }),
  ]);
  const memoryCall = result.tool_calls.find((call) => JSON.stringify(call.arguments).includes('"add_memory"'));
  expect(memoryCall?.is_error).toBe(false);
  expect(JSON.stringify(memoryCall?.result)).toContain('Saved memory');
  // Sticker search has no scene executor and MCP tools are deny-by-default.
  const stickerCall = result.tool_calls.find((call) => JSON.stringify(call.arguments).includes('"search_stickers"'));
  expect(stickerCall?.is_error).toBe(true);
  const mcpCall = result.tool_calls.find((call) => call.tool_name === 'mcp_remote_write');
  expect(mcpCall?.is_error).toBe(true);
  expect(result.fidelity.dispatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_name: 'send', mode: 'synthetic' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'blocked', capability: 'search_stickers' }),
      expect.objectContaining({ tool_name: 'mcp_remote_write', mode: 'blocked' }),
    ]),
  );
  expect(f.faux.state.callCount).toBe(2);
  // The tool-definition hook receives the source identity and its config.
  expect(contexts).toHaveLength(3); // inspect, prompts, run each resolve the current registry
  expect(contexts[0]).toMatchObject({
    invocationId: f.seed.invocationA,
    conversationId: f.seed.conversationId,
    chatId: 123_456_789n,
    threadId: 0n,
  });
  // The whole database, production tables included, is untouched.
  expect(f.rows()).toEqual(before);
});

test('the scene prompt is the current config and an override replaces only its own layer', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  expect(stable.promptLayers.prefix.startsWith(CORE_AGENT_PROTOCOL)).toBe(true);
  expect(stable.systemPrompt).toContain('Participate safely.');
  expect(stable.systemPrompt).toContain('Conversation mode: group chat.');
  expect(stable.systemPrompt.endsWith('\n\nprivate')).toBe(true);

  const globalOverride = composeAgentPrompt(
    { ...stable.promptLayers, global: 'Replacement global layer.' },
    stable.templateValues,
  );
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe(globalOverride);
      // Fixed runtime layers survive an override byte for byte.
      expect(context.systemPrompt).toContain(CORE_AGENT_PROTOCOL);
      expect(context.systemPrompt).toContain('Conversation mode: group chat.');
      expect(context.systemPrompt?.endsWith('\n\nprivate')).toBe(true);
      // A prompt override never touches the scene input.
      expect(messageText(context)).toContain(HISTORY_CAPTION);
      return fauxAssistantMessage('global override');
    },
  ]);
  expect(await f.run({ global_prompt: 'Replacement global layer.' })).toMatchObject({
    error: null,
    overrides: { global_prompt: true, group_prompt: false },
  });

  const groupOverride = composeAgentPrompt(
    { ...stable.promptLayers, group: 'Replacement group layer.' },
    stable.templateValues,
  );
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe(groupOverride);
      expect(context.systemPrompt).toContain('Participate safely.');
      return fauxAssistantMessage('group override');
    },
  ]);
  expect(await f.run({ group_prompt: 'Replacement group layer.' })).toMatchObject({
    error: null,
    overrides: { global_prompt: false, group_prompt: true },
  });

  // Publishing a different configuration is what the next replay composes:
  // nothing about the scene is pinned to an old recording.
  const current = f.configStore.current();
  f.configStore.publish({
    ...current,
    config: {
      ...current.config,
      agent: { ...current.config.agent, system_prompt: 'A different current global layer.' },
      telegram: {
        ...current.config.telegram,
        chats: current.config.telegram.chats.map((chat) =>
          chat.id === 123_456_789 ? { ...chat, instructions: 'a different current group layer' } : chat,
        ),
      },
    },
  });
  const published = stablePrompt(f.store, f.configStore.current().config, f.seed.invocationA);
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe(published.systemPrompt);
      expect(context.systemPrompt).toContain('A different current global layer.');
      expect(context.systemPrompt?.endsWith('\n\na different current group layer')).toBe(true);
      return fauxAssistantMessage('current config');
    },
  ]);
  expect(await f.run()).toMatchObject({ error: null });
  expect(f.runner.prompts(f.seed.invocationA)).toMatchObject({
    source: 'active',
    global_prompt: 'A different current global layer.',
    group_prompt: 'a different current group layer',
  });
});

test('prompt overrides reject unknown templates, NUL, BOM, oversize and emptied global layers', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  const cases: readonly [ReplayPromptOverrides, string][] = [
    [{ global_prompt: '{{agent.api_key}}' }, 'replay_prompt_invalid'],
    [{ group_prompt: '{{ nope }}' }, 'replay_prompt_invalid'],
    [{ global_prompt: '{{agent.model' }, 'replay_prompt_invalid'],
    [{ global_prompt: 'a\u0000b' }, 'replay_prompt_invalid'],
    [{ global_prompt: 'a\uFEFFb' }, 'replay_prompt_invalid'],
    [{ global_prompt: 'x'.repeat(65_537) }, 'replay_prompt_too_large'],
    [{ global_prompt: '' }, 'replay_prompt_empty'],
    [{ global_prompt: '<!-- only a note -->' }, 'replay_prompt_empty'],
  ];
  for (const [override, code] of cases) {
    await expect(f.run(override)).rejects.toMatchObject({ code });
  }
  expect(f.faux.state.callCount).toBe(0);

  // Comments are stripped before the override becomes a template.
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe(
        composeAgentPrompt({ ...stable.promptLayers, global: 'Replacement' }, stable.templateValues),
      );
      return fauxAssistantMessage('stripped');
    },
  ]);
  expect(await f.run({ global_prompt: 'Replacement\n<!-- operator note -->' })).toMatchObject({ error: null });
});

test('a scene replays with recording off, without any model call, after developer payload clearing', async () => {
  const f = await fixture();
  expect(f.loaded.config.developer?.record_model_payloads ?? false).toBe(false);
  const preflight = f.runner.inspect(f.seed.invocationA);
  expect(preflight).toMatchObject({ available: true, scene: { message_count: 2, history_count: 1 } });

  // The source invocation needs neither its model calls nor any retained
  // request/response payload: the scene comes from the chat itself.
  f.store.orm.delete(modelCalls).where(eq(modelCalls.invocationId, f.seed.invocationA)).run();
  await clearModelPayloads(f.store.orm);
  expect(
    f.store.orm
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(eq(modelCalls.invocationId, f.seed.invocationA))
      .all(),
  ).toEqual([]);
  expect(f.runner.inspect(f.seed.invocationA)).toEqual(preflight);

  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toContain('Participate safely.');
      expect(messageText(context)).toContain(OPENING_TEXT);
      return fauxAssistantMessage(fauxToolCall('send', { text: 'still replayable' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('done'),
  ]);
  const before = f.rows();
  expect(await f.run()).toMatchObject({ error: null, send_count: 1, usage: { model_calls: 2 } });
  expect(f.rows()).toEqual(before);
});

test('the default registry is the current read, send, and execute definitions', async () => {
  const resources = await SystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR);
  const skill = resources.skills[0];
  if (skill === undefined) {
    throw new Error('Bundled system skills are missing');
  }
  const f = await fixture({ resources, defaultRegistry: true });

  f.faux.setResponses([
    (context) => {
      // No toolDefinitions hook: read/send/execute are the basic current set,
      // and no capability is registered.
      expect(context.tools?.map((tool) => tool.name).sort()).toEqual(['execute', 'read', 'send']);
      return fauxAssistantMessage(
        [
          fauxToolCall('read', { uri: skill.uri }),
          fauxToolCall('send', { kind: 'text', text: 'default registry send' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'x' } }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('done'),
  ]);
  const result = await f.run();
  const readCall = result.tool_calls.find((call) => call.tool_name === 'read');
  expect(readCall?.is_error).toBe(false);
  expect(JSON.stringify(readCall?.result)).toContain(skill.uri);
  const capabilityCall = result.tool_calls.find((call) => call.tool_name === 'execute');
  expect(capabilityCall?.is_error).toBe(true);
  expect(JSON.stringify(capabilityCall?.result)).toContain('no capability named add_memory');
  expect(result).toMatchObject({ error: null, send_count: 1 });
  expect(result.fidelity.dispatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_name: 'read', mode: 'live_read' }),
      expect.objectContaining({ tool_name: 'send', mode: 'synthetic' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'blocked', capability: 'add_memory' }),
    ]),
  );
});

test('scene image reads and reply targets are isolated, with text-only and retention degradation', async () => {
  const loaded: bigint[] = [];
  const registry = () => ({
    ...sceneRegistry(),
    capabilities: [
      ...sceneRegistry().capabilities,
      definition('read_image', Type.Object({ image_ref: Type.String() }, { additionalProperties: false })),
    ],
  });
  const f = await fixture({
    images: true,
    definitions: registry,
    imageLoader: async (id, signal) => {
      signal.throwIfAborted();
      loaded.push(id);
      return { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
    },
  });
  let ref = '';
  f.faux.setResponses([
    (context) => {
      ref = messageText(context).match(/img_[a-f0-9]+/)![0];
      expect(messageText(context)).not.toContain('file_history_seed');
      return fauxAssistantMessage(
        [
          fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: ref } }),
          fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: 'img_foreign' } }),
          fauxToolCall('send', { text: 'valid reply', reply_to_message_id: '880' }),
          fauxToolCall('send', { text: 'invisible reply', reply_to_message_id: '999' }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('aW1hZ2U=');
      return fauxAssistantMessage('done');
    },
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result).toMatchObject({ error: null, send_count: 1, fidelity: { omitted_images: 0 } });
  expect(loaded).toEqual([HISTORY_MEDIA]);
  expect(result.tool_calls.map((call) => call.is_error)).toEqual([false, true, false, true]);
  expect(f.rows()).toEqual(before);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: ref } }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  const next = await f.run();
  expect(next.tool_calls[0]?.is_error).toBe(true); // previous scene reference expired
  expect(loaded).toEqual([HISTORY_MEDIA]);
  const textOnly = await fixture({
    definitions: registry,
    imageLoader: async () => {
      throw new Error('must not load');
    },
  });
  textOnly.faux.setResponses([
    (context) => {
      expect(messageText(context)).not.toMatch(/img_[a-f0-9]+/);
      return fauxAssistantMessage('done');
    },
  ]);
  expect(await textOnly.run()).toMatchObject({ error: null, fidelity: { omitted_images: 1 } });
  f.store.orm.delete(media).where(eq(media.id, HISTORY_MEDIA)).run();
  f.faux.setResponses([
    (context) => {
      expect(messageText(context)).not.toMatch(/img_[a-f0-9]+/);
      return fauxAssistantMessage('done');
    },
  ]);
  expect(await f.run()).toMatchObject({ error: null });
});

test('failed scene image loading degrades to a redacted tool error without production writes', async () => {
  const f = await fixture({
    images: true,
    definitions: () => ({
      ...sceneRegistry(),
      capabilities: [definition('read_image', Type.Object({ image_ref: Type.String() }))],
    }),
    imageLoader: async () => {
      throw new Error('download failed with replay-secret-fixture');
    },
  });
  f.secrets.remember('replay-secret-fixture');
  f.faux.setResponses([
    (context) =>
      fauxAssistantMessage(
        fauxToolCall('execute', {
          action: 'call',
          tool: 'read_image',
          input: { image_ref: messageText(context).match(/img_[a-f0-9]+/)![0] },
        }),
        { stopReason: 'toolUse' },
      ),
    fauxAssistantMessage('cannot see the image'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result.error).toBeNull();
  expect(result.tool_calls[0]?.is_error).toBe(true);
  expect(JSON.stringify(result.tool_calls)).toContain('download failed');
  expect(JSON.stringify(result)).not.toContain('replay-secret-fixture');
  expect(f.rows()).toEqual(before);
});

test('scene replay shares the live model gate, rejects concurrent runs and releases its lock on cancellation', async () => {
  const f = await fixture();
  const release = await f.gate.acquire('123456789', new AbortController().signal);
  const request = new AbortController();
  const pending = f.run({}, request.signal);
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_busy', status: 429 });
  request.abort();
  expect(await pending).toMatchObject({ error: { code: 'aborted' }, usage: { model_calls: 0 } });
  release();
  f.faux.setResponses([fauxAssistantMessage('after abort')]);
  expect(await f.run()).toMatchObject({ error: null, usage: { model_calls: 1 } });
  const controller = new AbortController();
  controller.abort();
  expect(await f.run({}, controller.signal)).toMatchObject({ error: { code: 'aborted' } });
});

test('shutdown cancels an in-flight model request without writes and model errors are redacted', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  f.faux.setResponses([
    async (_context, options) => {
      started.resolve();
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return fauxAssistantMessage('cancelled', { stopReason: 'aborted' });
    },
  ]);
  const before = f.rows();
  const pending = f.run();
  await started.promise;
  f.shutdown.abort();
  expect(await pending).toMatchObject({ error: { code: 'aborted' } });
  expect(f.rows()).toEqual(before);

  const g = await fixture();
  g.secrets.remember('fixture-private-secret');
  g.faux.setResponses([
    () => {
      throw new Error('fixture-private-secret');
    },
  ]);
  const failed = await g.run();
  expect(failed.error).not.toBeNull();
  expect(JSON.stringify(failed)).not.toContain('fixture-private-secret');
});

test('configured wall-clock limit covers waiting for a model slot', async () => {
  const f = await fixture({ change: (config) => (config.agent.context!.max_wall_clock_seconds = 1) });
  const release = await f.gate.acquire('123456789', new AbortController().signal);
  try {
    expect(await f.run()).toMatchObject({ error: { code: 'timeout' }, usage: { model_calls: 0 } });
  } finally {
    release();
  }
});

test('context, turn and tool budgets stop the loop, including malformed unknown tool calls', async () => {
  const tiny = await fixture({ contextWindow: 256 });
  expect(await tiny.run()).toMatchObject({ error: { code: 'context_limit' }, usage: { model_calls: 0 } });

  const f = await fixture({ change: (config) => (config.agent.rate_limits.turns_per_injection = 1) });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('send', { text: 'once' }), { stopReason: 'toolUse' })]);
  expect(await f.run()).toMatchObject({ error: { code: 'turn_budget' }, send_count: 1, usage: { model_calls: 1 } });

  const g = await fixture();
  g.faux.setResponses([
    fauxAssistantMessage(
      Array.from({ length: 150 }, () => fauxToolCall('not_registered', {})),
      { stopReason: 'toolUse' },
    ),
  ]);
  const bounded = await g.run();
  expect(bounded.error?.code).toBe('tool_budget');
  expect(bounded.tool_calls.length).toBeLessThanOrEqual(128);
  expect(bounded.usage.model_calls).toBe(1);
});

test('trace bounds stop before oversized arguments can be retained or synthetic sends executed', async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('send', { text: 'x'.repeat(1_100_000) }), { stopReason: 'toolUse' }),
  ]);
  const result = await f.run();
  expect(result.error?.code).toBe('trace_limit');
  expect(result.send_count).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_100_000);
});

test('redaction covers arbitrary argument property names and dispatch metadata, not just text', async () => {
  const f = await fixture();
  const key = 'fixture-private-secret';
  f.secrets.remember(key);
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('not_registered', { [key]: key }),
        fauxToolCall('execute', { action: 'call', tool: key, input: {} }),
        fauxToolCall('send', { text: `quoted ${key}` }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('done'),
  ]);
  const result = await f.run();
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.send_count).toBe(1);
});

test('successful sleep terminates the replay without producing a real sleep record', async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('zzz', {}), { stopReason: 'toolUse' })]);
  const before = f.rows();
  expect(await f.run()).toMatchObject({
    error: null,
    completion_reason: 'sleep',
    usage: { model_calls: 1 },
    send_count: 0,
  });
  expect(f.rows()).toEqual(before);
});

test('scene guards report missing, unfinished, unconfigured, invalid and empty scenes without model calls', async () => {
  const f = await fixture();
  replayError(() => f.runner.inspect(999_999n), 'not_found');
  await expect(f.runner.run(999_999n, {}, new AbortController().signal)).rejects.toMatchObject({
    code: 'not_found',
    status: 404,
  });

  f.store.orm
    .update(invocations)
    .set({ state: 'running', finishedAt: null })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_source_unfinished',
    message: 'Replay requires a finished invocation',
    prompt_overrides_available: false,
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_source_unfinished' });
  f.store.orm
    .update(invocations)
    .set({ state: 'completed', finishedAt: '2026-09-10T08:00:06.000Z' })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();

  // A chat the current configuration dropped, and a model it no longer routes.
  const current = f.configStore.current();
  f.configStore.publish({
    ...current,
    config: { ...current.config, telegram: { ...current.config.telegram, chats: [] } },
  });
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_chat_unconfigured',
    message: 'The source chat is no longer configured',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_chat_unconfigured' });
  f.configStore.publish({
    ...current,
    config: { ...current.config, agent: { ...current.config.agent, model: 'retired-model' } },
  });
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_model_unavailable',
    message: 'The current agent model is unavailable',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_model_unavailable' });
  f.configStore.publish(current);
  expect(f.faux.state.callCount).toBe(0);
});

test('a topic outside the current allowlist and an invalid or empty scene are refused before the model', async () => {
  const g = await fixture({ change: (config) => (config.telegram.chats[0]!.topic_ids = [7]) });
  expect(g.runner.inspect(g.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_topic_unconfigured',
    message: 'The source topic is no longer configured',
  });
  await expect(g.run()).rejects.toMatchObject({ code: 'replay_topic_unconfigured' });

  const f = await fixture();
  f.store.orm
    .update(invocationMessages)
    .set({ snapshotJson: '{' })
    .where(and(eq(invocationMessages.invocationId, f.seed.invocationA), eq(invocationMessages.section, 'new')))
    .run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_scene_invalid',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_scene_invalid' });

  // No public message exists at the cutoff at all: there is nothing to replay.
  f.store.orm.delete(invocationMessages).run();
  f.store.orm.update(messages).set({ currentRevisionId: null }).run();
  f.store.orm.delete(messages).run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_scene_unavailable',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_scene_unavailable' });
  expect(g.faux.state.callCount).toBe(0);
  expect(f.faux.state.callCount).toBe(0);
});

/**
 * A second provider (`alt`) with a reasoning text+image model, registered next
 * to the default agent faux. The scene prompt names the current model so the
 * test can prove the selected model drives the rendered template values.
 */
function crossProviderFixture() {
  let altFaux: FauxProviderHandle | undefined;
  let clipFaux: FauxProviderHandle | undefined;
  const f = fixture({
    systemPrompt: 'Current model {{agent.provider}}/{{agent.model}}.',
    change: (config) => {
      config.providers.alt = {
        kind: 'custom',
        base_url: 'https://example.test/alt/v1',
        api: 'openai-responses',
        api_key: { jar: 'alt' },
        models: [
          {
            id: 'alt-model',
            name: 'Alt Model',
            reasoning: true,
            input: ['text', 'image'],
            context_window: 200_000,
            max_tokens: 64,
            cost: { input: 2, output: 3, cache_read: 0.2, cache_write: 2 },
          },
        ],
      };
      config.providers.clip = {
        kind: 'custom',
        base_url: 'https://example.test/clip/v1',
        api: 'openai-responses',
        api_key: { jar: 'clip' },
        models: [
          {
            id: 'clip-model',
            reasoning: false,
            input: ['image'],
            context_window: 8_000,
            max_tokens: 100,
            cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          },
        ],
      };
    },
    definitions: () => ({
      ...sceneRegistry(),
      capabilities: [
        ...sceneRegistry().capabilities,
        definition('read_image', Type.Object({ image_ref: Type.String() }, { additionalProperties: false })),
      ],
    }),
    imageLoader: async (_id, signal) => {
      signal.throwIfAborted();
      return { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
    },
    registry: (agentFaux) => {
      altFaux = fauxProvider({
        provider: 'alt',
        models: [
          {
            id: 'alt-model',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200_000,
            maxTokens: 64,
            cost: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 },
          },
        ],
        tokenSize: { min: 100_000, max: 100_000 },
      });
      clipFaux = fauxProvider({
        provider: 'clip',
        models: [{ id: 'clip-model', reasoning: false, input: ['image'], contextWindow: 8_000, maxTokens: 100 }],
        tokenSize: { min: 100_000, max: 100_000 },
      });
      const models = createModels();
      models.setProvider(agentFaux.provider);
      models.setProvider(altFaux.provider);
      models.setProvider(clipFaux.provider);
      return { registry: { models, visionModel: agentFaux.getModel() }, extra: [altFaux, clipFaux] };
    },
  });
  return { promise: f, altFaux: () => altFaux };
}

test('an explicit cross-provider model pair drives prompt, image, budget, cost and provider connection', async () => {
  const { promise, altFaux } = crossProviderFixture();
  const f = await promise;
  const alt = altFaux();
  if (alt === undefined) {
    throw new Error('alt faux provider was not built');
  }
  const before = f.rows();

  // The free preflight discloses the resolved target and its weakest level.
  const preflight = f.runner.inspect(f.seed.invocationA, { provider: 'alt', model: 'alt-model' });
  expect(preflight).toMatchObject({
    available: true,
    fidelity: { model_selection: 'temporary_override' },
    model: { provider: 'alt', id: 'alt-model', thinking_level: 'off' },
  });
  expect(preflight.scene?.omitted_messages).toBe(0);

  alt.setResponses([
    (context, options, _state, model) => {
      // Prompt variables render the selected model, not the Chat settings.
      expect(context.systemPrompt).toContain('Current model alt/alt-model.');
      // The selected model's image capability turns the scene media into refs.
      expect(messageText(context)).toMatch(/img_[a-f0-9]+/);
      // The scene budget is the target's maxTokens and the target's provider
      // object is the one that streams, carrying the target's own cost rates.
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 64 });
      expect(model).toMatchObject({ id: 'alt-model', provider: 'alt', reasoning: true });
      expect(model.cost.input).toBe(2);
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'alt selected send' }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('alt done'),
  ]);
  const result = await f.run({ provider: 'alt', model: 'alt-model' });
  expect(result).toMatchObject({
    error: null,
    send_count: 1,
    model: { provider: 'alt', id: 'alt-model', thinking_level: 'off' },
    overrides: { global_prompt: false, group_prompt: false, provider: true, model: true, thinking_level: false },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.faux.state.callCount).toBe(0);
  expect(alt.state.callCount).toBe(2);
  expect(f.rows()).toEqual(before);

  // The same scene fails on a target with a smaller window: the context
  // budget follows the selected model before any request is made.
  const tiny = await fixture({
    change: (config) => {
      config.providers.tiny = {
        kind: 'custom',
        base_url: 'https://example.test/tiny/v1',
        api: 'openai-responses',
        api_key: { jar: 'tiny' },
        models: [
          {
            id: 'tiny-model',
            reasoning: false,
            input: ['text'],
            context_window: 256,
            max_tokens: 64,
            cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          },
        ],
      };
    },
    registry: (agentFaux) => {
      const tinyFaux = fauxProvider({
        provider: 'tiny',
        models: [{ id: 'tiny-model', reasoning: false, input: ['text'], contextWindow: 256, maxTokens: 64 }],
        tokenSize: { min: 100_000, max: 100_000 },
      });
      const models = createModels();
      models.setProvider(agentFaux.provider);
      models.setProvider(tinyFaux.provider);
      return { registry: { models, visionModel: agentFaux.getModel() }, extra: [tinyFaux] };
    },
  });
  expect(await tiny.run({ provider: 'tiny', model: 'tiny-model' })).toMatchObject({
    error: { code: 'context_limit' },
    usage: { model_calls: 0 },
  });
  expect(tiny.faux.state.callCount).toBe(0);
});

test('unknown targets, missing text capability and unsupported thinking levels are rejected before any request', async () => {
  const { promise, altFaux } = crossProviderFixture();
  const f = await promise;
  const alt = altFaux();
  if (alt === undefined) {
    throw new Error('alt faux provider was not built');
  }
  const cases: readonly [ReplayPromptOverrides, string, string][] = [
    [{ provider: 'nope', model: 'x' }, 'unknown_provider', 'Provider nope is not configured'],
    [{ provider: 'agent', model: 'nope' }, 'unknown_model', 'Model agent/nope is not registered'],
    // The vision alias exists in the config but its models are not registered.
    [{ provider: 'vision', model: 'vision-model' }, 'unknown_model', 'Model vision/vision-model is not registered'],
    // The clip model is registered but takes only image input: no text scene.
    [{ provider: 'clip', model: 'clip-model' }, 'not_text_capable', 'Model clip/clip-model does not accept text input'],
    [{ provider: 'alt', model: 'alt-model', thinking_level: 'xhigh' }, 'replay_thinking_level_unsupported', ''],
    [{ thinking_level: 'xhigh' }, 'replay_thinking_level_unsupported', ''],
    [{ thinking_level: 'banana' as unknown as ModelThinkingLevel }, 'replay_thinking_level_invalid', ''],
    [{ provider: 'alt' }, 'replay_model_pair_required', 'provider and model must be provided together'],
    [{ model: 'alt-model' }, 'replay_model_pair_required', 'provider and model must be provided together'],
  ];
  for (const [selection, code, message] of cases) {
    // The read-only preflight reports the same engine rejection as a document;
    // the run throws it before any model request.
    const preflight = f.runner.inspect(f.seed.invocationA, selection);
    expect(preflight).toMatchObject({
      available: false,
      reason: code,
      fidelity: { model_selection: 'temporary_override' },
    });
    if (message.length > 0) {
      expect(preflight.message).toBe(message);
    }
    await expect(f.run(selection)).rejects.toMatchObject({ code, status: 400 });
  }
  expect(f.faux.state.callCount).toBe(0);
  expect(alt.state.callCount).toBe(0);
});

test('an explicit same-model pair resets thinking to the weakest level and a standalone level must be supported', async () => {
  const f = await fixture();
  // Current chat settings: agent/agent-model at 'low'; the faux model does not
  // reason, so its only supported level is 'off'.
  const preflight = f.runner.inspect(f.seed.invocationA, { provider: 'agent', model: 'agent-model' });
  expect(preflight).toMatchObject({
    available: true,
    fidelity: { model_selection: 'temporary_override' },
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
  });

  f.faux.setResponses([fauxAssistantMessage('same model reset')]);
  const before = f.rows();
  const result = await f.run({ provider: 'agent', model: 'agent-model' });
  expect(result).toMatchObject({
    error: null,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    overrides: { global_prompt: false, group_prompt: false, provider: true, model: true, thinking_level: false },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.faux.state.callCount).toBe(1);
  expect(f.rows()).toEqual(before);

  // A standalone thinking override is still a temporary selection, even
  // though the provider/model pair remains unchanged.
  f.faux.setResponses([fauxAssistantMessage('standalone level')]);
  const standalone = await f.run({ thinking_level: 'off' });
  expect(standalone).toMatchObject({
    error: null,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    overrides: { provider: false, model: false, thinking_level: true },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.runner.inspect(f.seed.invocationA, { thinking_level: 'off' })).toMatchObject({
    available: true,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    fidelity: { model_selection: 'temporary_override' },
  });
  await expect(f.run({ thinking_level: 'low' })).rejects.toMatchObject({ code: 'replay_thinking_level_unsupported' });
  expect(f.faux.state.callCount).toBe(2);
});
