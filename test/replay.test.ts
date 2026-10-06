import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context, type Message } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { createExecuteTool } from '../src/capabilities/execute-tool.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { ContextBuilder, type StablePrompt } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { encodeContextMessage } from '../src/context/context-codec.ts';
import { clearModelPayloads } from '../src/ingress/admin/developer-admin.ts';
import { ReplayRunner, type ReplayPromptOverrides } from '../src/orchestration/replay.ts';
import { CORE_AGENT_PROTOCOL } from '../src/platform/agent-protocol.ts';
import { composeAgentPrompt, type AgentPromptLayers } from '../src/platform/agent-prompt.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { type FileConfig, type RawConfig, loadConfig } from '../src/platform/config.ts';
import type { PromptTemplateValues } from '../src/platform/prompt-template.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { SqliteStore } from '../src/store/database.ts';
import { serializeReplayInput, toolDefinition } from '../src/store/replay-input.ts';
import { invocations, modelCalls } from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

const definition = (name: string, parameters = Type.Object({})) => ({
  name,
  label: name,
  description: `fixture ${name}`,
  parameters,
});
const defaultMessages: Message[] = [{ role: 'user', content: 'recorded user input', timestamp: 1 }];
const TOOL_DEFINITIONS = [
  definition('send', SendInputSchema),
  createExecuteTool({
    capabilities: [],
    audit: { start: () => ({ succeed: () => {}, fail: () => {} }), reject: () => {} },
  }),
  definition('zzz'),
  definition('mcp_remote_write'),
];
const CAPABILITIES = [
  {
    ...definition('add_memory', AddMemoryInputSchema),
    execute: async () => {
      throw new Error('not wired');
    },
  },
  {
    ...definition('alarm', AlarmInputSchema),
    execute: async () => {
      throw new Error('not wired');
    },
  },
  {
    ...definition('list_alarm', ListAlarmInputSchema),
    execute: async () => {
      throw new Error('not wired');
    },
  },
];

/** A version 1 record: the shape written before prompt layers were retained. */
function replayInput(messages: Message[] = defaultMessages, systemPrompt = 'recorded system prompt'): string {
  return JSON.stringify({
    version: 1,
    system_prompt: systemPrompt,
    messages: messages.map((message) => {
      const encoded = encodeContextMessage(message);
      if (encoded === undefined) {
        throw new Error('fixture message cannot be encoded');
      }
      return encoded.json;
    }),
    tools: TOOL_DEFINITIONS.map(toolDefinition),
    capabilities: CAPABILITIES.map(toolDefinition),
    omitted_images: 0,
  });
}

/** The layered (version 2) record built from a real ContextBuilder prompt. */
function layeredInput(
  stable: Pick<StablePrompt, 'systemPrompt' | 'promptLayers' | 'templateValues'>,
  messages: Message[] = defaultMessages,
): string {
  return serializeReplayInput(
    { systemPrompt: stable.systemPrompt, messages, tools: TOOL_DEFINITIONS } satisfies Context,
    CAPABILITIES,
    { layers: stable.promptLayers, templateValues: stable.templateValues },
  );
}

function stablePrompt(store: SqliteStore, config: RawConfig, invocationId: bigint): StablePrompt {
  const builder = new ContextBuilder(
    store,
    new ContextRefStore(store, { ttlHours: config.agent.context.ref_ttl_hours }),
  );
  return builder.buildSystemPrompt(config, builder.identity(config, invocationId), false, {
    provider: 'agent',
    model: 'agent-model',
  });
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

async function fixture(change?: (config: FileConfig) => void, contextWindow = 200_000) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-replay-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(directory, path, testConfigJsonc(directory, change));
  const loaded = await loadConfig(path);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', contextWindow, maxTokens: 128 }],
    tokenSize: { min: 100_000, max: 100_000 },
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const seed = seedAdminFixture(store);
  const secrets = new SecretStore();
  const shutdown = new AbortController();
  const gate = new KeyedSemaphore();
  const runner = new ReplayRunner({
    orm: store.orm,
    configStore,
    secrets,
    systemResources: SystemResources.empty(),
    modelGate: gate,
    shutdownSignal: shutdown.signal,
  });
  const setInput = (input: string | null) =>
    store.orm.update(modelCalls).set({ replayInputJson: input }).where(eq(modelCalls.id, 7_001n)).run();
  setInput(replayInput());
  const run = (override: ReplayPromptOverrides = {}, signal = new AbortController().signal) =>
    runner.run(seed.invocationA, override, signal);
  const rows = () =>
    Object.fromEntries(
      store.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
    );
  return { directory, loaded, faux, configStore, store, seed, secrets, shutdown, gate, runner, setInput, run, rows };
}

test('replay uses historical input and current model, captures effects without any production writes', async () => {
  const f = await fixture();
  f.faux.setResponses([
    (context, options) => {
      expect(context.systemPrompt).toBe('recorded system prompt');
      expect(context.messages).toEqual(defaultMessages);
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 128 });
      return fauxAssistantMessage(
        [
          fauxToolCall('send', { text: 'synthetic text' }),
          fauxToolCall('send', { kind: 'image', image_generation_id: '00000000-0000-0000-0000-000000000001' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'synthetic memory' } }),
          fauxToolCall('execute', {
            action: 'call',
            tool: 'alarm',
            input: { target_user_id: '42', datetime: '2099-01-01T00:00:00Z', summary: 'synthetic alarm' },
          }),
          fauxToolCall('mcp_remote_write', {}),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'list_alarm', input: {} }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('private completion'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result).toMatchObject({
    version: 1,
    source_invocation_id: '4001',
    source_model_call_id: '7001',
    error: null,
    send_count: 2,
    responded: true,
    model: { provider: 'agent', id: 'agent-model' },
    usage: { model_calls: 3 },
    overrides: { global_prompt: false, group_prompt: false },
  });
  expect(result.tool_calls.find((call) => call.tool_name === 'mcp_remote_write')?.is_error).toBe(true);
  const executeCalls = result.tool_calls.filter((call) => call.tool_name === 'execute');
  expect(executeCalls).toHaveLength(3);
  expect(executeCalls.every((call) => !call.is_error)).toBe(true);
  expect(JSON.stringify(executeCalls.at(-1)?.result)).toContain('synthetic alarm');
  expect(result.fidelity).toMatchObject({
    historical_model: { provider: 'openai', id: 'gpt-4.1-mini' },
    side_effects: 'synthetic',
    external_tools: 'blocked',
  });
  expect(f.rows()).toEqual(before);
});

test('overridden layers replay the fixed protocol verbatim, independent of each other and with no writes', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  f.setInput(layeredInput(stable));
  const before = f.rows();
  const globalOnly = composeAgentPrompt(
    { ...stable.promptLayers, global: 'Replacement global layer.' },
    stable.templateValues,
  );
  const groupOnly = composeAgentPrompt(
    { ...stable.promptLayers, group: 'Replacement group layer.' },
    stable.templateValues,
  );
  const both = composeAgentPrompt(
    { ...stable.promptLayers, global: 'Replacement global layer.', group: '' },
    stable.templateValues,
  );

  // The fixed prefix and middle are the runtime's own protocol, skill index,
  // media handling, conversation mode and memory guidance, byte for byte.
  expect(stable.promptLayers.prefix.startsWith(CORE_AGENT_PROTOCOL)).toBe(true);
  expect(stable.systemPrompt).toContain('Conversation mode: group chat.');
  expect(stable.systemPrompt).toContain('Memory: short-term notes you deliberately saved');
  expect(stable.systemPrompt).toContain('read_image capability');
  // Composition order and empty-segment filtering are unchanged: fixed prefix,
  // rendered global template, fixed middle, rendered group template last.
  const order = [
    'Core agent protocol',
    'read_image capability',
    'Participate safely.',
    'Conversation mode: group chat.',
    'Memory: short-term notes',
  ].map((marker) => stable.systemPrompt.indexOf(marker));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(new Set(order).size).toBe(order.length);
  expect(stable.promptLayers.group).toBe('private');
  expect(stable.systemPrompt.endsWith('\n\nprivate')).toBe(true);
  for (const expected of [globalOnly, groupOnly, both]) {
    expect(expected.startsWith(stable.promptLayers.prefix)).toBe(true);
    expect(expected).toContain(CORE_AGENT_PROTOCOL);
    expect(expected).toContain('Conversation mode: group chat.');
    expect(expected).toContain('Memory: short-term notes you deliberately saved');
  }

  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe(globalOnly);
      // The recorded group layer is still rendered from its own template.
      expect(context.systemPrompt?.endsWith('private')).toBe(true);
      return fauxAssistantMessage('global only');
    },
    (context) => {
      expect(context.systemPrompt).toBe(groupOnly);
      // The recorded global layer is still rendered from its own template.
      expect(context.systemPrompt).toContain('Participate safely.');
      return fauxAssistantMessage('group only');
    },
    (context) => {
      expect(context.systemPrompt).toBe(both);
      expect(context.systemPrompt?.endsWith('private')).toBe(false);
      return fauxAssistantMessage('both');
    },
  ]);
  expect(await f.run({ global_prompt: 'Replacement global layer.' })).toMatchObject({
    error: null,
    overrides: { global_prompt: true, group_prompt: false },
  });
  expect(await f.run({ group_prompt: 'Replacement group layer.' })).toMatchObject({
    error: null,
    overrides: { global_prompt: false, group_prompt: true },
  });
  expect(await f.run({ global_prompt: 'Replacement global layer.', group_prompt: '' })).toMatchObject({
    error: null,
    overrides: { global_prompt: true, group_prompt: true },
  });
  expect(f.rows()).toEqual(before);
});

test('prompt overrides reject unknown templates, NUL, BOM, oversize and emptied global layers', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  f.setInput(layeredInput(stable));
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

test('version 1 records replay as recorded but refuse every layered override', async () => {
  const f = await fixture();
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe('recorded system prompt');
      return fauxAssistantMessage('as recorded');
    },
  ]);
  expect(await f.run()).toMatchObject({
    error: null,
    overrides: { global_prompt: false, group_prompt: false },
  });
  for (const override of [{ global_prompt: 'x' }, { group_prompt: 'y' }, { global_prompt: 'x', group_prompt: 'y' }]) {
    await expect(f.run(override)).rejects.toMatchObject({ code: 'replay_prompt_parts_unavailable' });
  }
  // The same refusal is visible before a replay is attempted.
  replayError(() => f.runner.prompts(f.seed.invocationA), 'replay_prompt_parts_unavailable');
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: true,
    prompt_overrides_available: false,
  });
  expect(f.faux.state.callCount).toBe(1);
});

test('inspect preflights without a model call and prompts returns the recorded editable templates', async () => {
  const f = await fixture();
  const stable = stablePrompt(f.store, f.loaded.config, f.seed.invocationA);
  f.setInput(layeredInput(stable));
  const before = f.rows();
  expect(f.runner.inspect(f.seed.invocationA)).toEqual({
    available: true,
    reason: null,
    message: null,
    source_model_call_id: '7001',
    historical_model: { provider: 'openai', id: 'gpt-4.1-mini' },
    prompt_overrides_available: true,
    omitted_images: 0,
    recording_enabled: false,
    fidelity: {
      input: 'first_model_request_text_only',
      model_selection: 'current_chat_config',
      hot_injections: 'not_replayed',
      external_tools: 'blocked',
      system_resources: 'current_read_only',
      side_effects: 'synthetic',
    },
  });
  expect(f.runner.prompts(f.seed.invocationA)).toEqual({
    source: 'recorded',
    source_invocation_id: '4001',
    source_model_call_id: '7001',
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
  expect(f.rows()).toEqual(before);

  // The current recording switch is reported as it is now, not as it was.
  const g = await fixture((config) => {
    config.developer = { record_model_payloads: true };
  });
  expect(g.runner.inspect(g.seed.invocationA)).toMatchObject({ available: true, recording_enabled: true });
  // A live switch never resurrects a cleared payload or fakes its history.
  g.setInput(null);
  expect(g.runner.inspect(g.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_input_unavailable',
    recording_enabled: true,
  });
});

test('inspect reports missing, unfinished, absent, cleared and invalid sources without model calls', async () => {
  const f = await fixture();
  replayError(() => f.runner.inspect(999_999n), 'not_found');
  await expect(f.runner.run(999_999n, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'not_found' });

  f.store.orm
    .update(invocations)
    .set({ state: 'running', finishedAt: null })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_source_unfinished',
    source_model_call_id: null,
    historical_model: null,
    prompt_overrides_available: false,
    omitted_images: null,
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_source_unfinished' });
  f.store.orm
    .update(invocations)
    .set({ state: 'completed', finishedAt: new Date().toISOString() })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();

  // A later model call with a retained payload never substitutes for the first
  // agent request.
  f.store.orm.update(modelCalls).set({ replayInputJson: replayInput() }).where(eq(modelCalls.id, 7_003n)).run();
  f.setInput(null);
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_input_unavailable',
    source_model_call_id: '7001',
    historical_model: { provider: 'openai', id: 'gpt-4.1-mini' },
    prompt_overrides_available: false,
    omitted_images: null,
  });
  replayError(() => f.runner.prompts(f.seed.invocationA), 'replay_input_unavailable');

  f.setInput('{');
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_input_invalid',
    source_model_call_id: '7001',
  });

  // No agent model call at all is its own reason, not an unavailable payload.
  f.store.orm
    .update(modelCalls)
    .set({ invocationId: f.seed.invocationB })
    .where(eq(modelCalls.invocationId, f.seed.invocationA))
    .run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_no_agent_request',
    source_model_call_id: null,
    historical_model: null,
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_no_agent_request' });
  expect(f.faux.state.callCount).toBe(0);
});

test('inspect and run refuse a source chat or agent model the current configuration dropped', async () => {
  const f = await fixture();
  const before = f.rows();
  f.configStore.publish({
    ...f.configStore.current(),
    config: { ...f.configStore.current().config, telegram: { ...f.configStore.current().config.telegram, chats: [] } },
  });
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_chat_unconfigured',
    message: 'The source chat is no longer configured',
    source_model_call_id: '7001',
    historical_model: { provider: 'openai', id: 'gpt-4.1-mini' },
    prompt_overrides_available: false,
    omitted_images: 0,
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_chat_unconfigured' });
  expect(f.faux.state.callCount).toBe(0);
  expect(f.rows()).toEqual(before);

  // The agent model is the other half of the current-configuration guard: a
  // model the current config dropped blocks inspect and run the same way.
  const g = await fixture();
  const gBefore = g.rows();
  g.configStore.publish({
    ...g.configStore.current(),
    config: {
      ...g.configStore.current().config,
      agent: { ...g.configStore.current().config.agent, model: 'retired-model' },
    },
  });
  expect(g.runner.inspect(g.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_model_unavailable',
    message: 'The current agent model is unavailable',
    source_model_call_id: '7001',
    historical_model: { provider: 'openai', id: 'gpt-4.1-mini' },
    prompt_overrides_available: false,
    omitted_images: 0,
  });
  await expect(g.run()).rejects.toMatchObject({ code: 'replay_model_unavailable' });
  expect(g.faux.state.callCount).toBe(0);
  expect(g.rows()).toEqual(gBefore);
});

test('recorded template values are pinned to the snapshot, never re-read from current config', async () => {
  const f = await fixture();
  const layers: AgentPromptLayers = {
    prefix: 'FIXED PROTOCOL TEXT',
    global: 'recorded {{agent.provider}}/{{agent.model}} at {{timezone}}',
    middle: 'FIXED MIDDLE TEXT',
    group: 'recorded group for {{vision.model}}',
  };
  const templateValues: PromptTemplateValues = {
    agent: { provider: 'snapshot-provider', model: 'snapshot-model' },
    vision: { provider: 'snapshot-vision', model: 'snapshot-vision-model' },
    timezone: 'Snapshot/Zone',
  };
  const systemPrompt = composeAgentPrompt(layers, templateValues);
  f.setInput(
    serializeReplayInput(
      { systemPrompt, messages: defaultMessages, tools: TOOL_DEFINITIONS } satisfies Context,
      CAPABILITIES,
      { layers, templateValues },
    ),
  );
  const before = f.rows();
  f.faux.setResponses([
    (context) => {
      // Recorded values, not the current config's agent/agent-model/UTC.
      expect(context.systemPrompt).toBe(
        'FIXED PROTOCOL TEXT\n\nrecorded snapshot-provider/snapshot-model at Snapshot/Zone\n\nFIXED MIDDLE TEXT\n\nrecorded group for snapshot-vision-model',
      );
      return fauxAssistantMessage('pinned');
    },
  ]);
  expect(await f.run()).toMatchObject({ error: null });
  expect(f.rows()).toEqual(before);

  // A replay override is a brand-new template, but its variables still render
  // with the snapshot's values: the current config's agent/agent-model must not
  // leak in, not even through {{agent.model}}.
  const override = 'override {{agent.model}} for {{vision.model}} at {{timezone}}';
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe(composeAgentPrompt({ ...layers, global: override }, templateValues));
      expect(context.systemPrompt).toContain('override snapshot-model for snapshot-vision-model at Snapshot/Zone');
      expect(context.systemPrompt).not.toContain('agent-model');
      return fauxAssistantMessage('override pinned');
    },
  ]);
  expect(await f.run({ global_prompt: override })).toMatchObject({
    error: null,
    overrides: { global_prompt: true, group_prompt: false },
  });
  expect(f.rows()).toEqual(before);
});

test('source guards reject missing, unfinished, absent first input and invalid history, never use later calls', async () => {
  const f = await fixture();
  await expect(f.runner.run(999999n, {}, new AbortController().signal)).rejects.toMatchObject({
    code: 'not_found',
    status: 404,
  });
  f.store.orm
    .update(invocations)
    .set({ state: 'running', finishedAt: null })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_source_unfinished' });
  f.store.orm
    .update(invocations)
    .set({ state: 'completed', finishedAt: new Date().toISOString() })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();
  f.store.orm.update(modelCalls).set({ replayInputJson: replayInput() }).where(eq(modelCalls.id, 7003n)).run();
  f.setInput(null);
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_input_unavailable' });
  for (const bad of [
    '{',
    JSON.stringify({ version: 99 }),
    replayInput([...defaultMessages, fauxAssistantMessage('already answered')]),
    replayInput([
      { role: 'toolResult', toolCallId: 'missing', toolName: 'send', content: [], isError: false, timestamp: 1 },
    ]),
    // A version 2 record that no longer matches its own layers is invalid too.
    JSON.stringify({ ...(JSON.parse(replayInput()) as Record<string, unknown>), version: 2 }),
  ]) {
    f.setInput(bad);
    await expect(f.run()).rejects.toMatchObject({ code: 'replay_input_invalid' });
  }
  f.setInput(replayInput());
  await clearModelPayloads(f.store.orm);
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_input_unavailable' });
  expect(f.faux.state.callCount).toBe(0);
});

test('replay resumes a recorded tool-result tail rather than replaying its historical side effect', async () => {
  const f = await fixture();
  const call = fauxToolCall('send', { text: 'historical' });
  f.setInput(
    replayInput([
      ...defaultMessages,
      fauxAssistantMessage(call, { stopReason: 'toolUse' }),
      {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: 'send',
        content: [{ type: 'text', text: 'sent' }],
        isError: false,
        timestamp: 2,
      },
    ]),
  );
  f.faux.setResponses([fauxAssistantMessage('done')]);
  expect(await f.run()).toMatchObject({ error: null, send_count: 0, usage: { model_calls: 1 } });
});

test('replay shares the live model gate, rejects concurrent runs and releases its lock on cancellation', async () => {
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
  const f = await fixture((config) => {
    config.agent.context!.max_wall_clock_seconds = 1;
  });
  const release = await f.gate.acquire('123456789', new AbortController().signal);
  try {
    expect(await f.run()).toMatchObject({ error: { code: 'timeout' }, usage: { model_calls: 0 } });
  } finally {
    release();
  }
});

test('context, turn and tool budgets stop the loop, including malformed unknown tool calls', async () => {
  const tiny = await fixture(undefined, 256);
  expect(await tiny.run()).toMatchObject({ error: { code: 'context_limit' }, usage: { model_calls: 0 } });
  const f = await fixture((config) => {
    config.agent.rate_limits.turns_per_injection = 1;
  });
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
