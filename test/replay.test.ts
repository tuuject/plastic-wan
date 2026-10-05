import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { createExecuteTool } from '../src/capabilities/execute-tool.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { clearModelPayloads } from '../src/ingress/admin/developer-admin.ts';
import { ReplayRunner } from '../src/orchestration/replay.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { SqliteStore } from '../src/store/database.ts';
import { serializeReplayInput } from '../src/store/replay-input.ts';
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
function replayInput(messages = defaultMessages): string {
  return serializeReplayInput(
    {
      systemPrompt: 'recorded system prompt',
      messages,
      tools: [
        definition('send', SendInputSchema),
        createExecuteTool({
          capabilities: [],
          audit: { start: () => ({ succeed: () => {}, fail: () => {} }), reject: () => {} },
        }),
        definition('zzz'),
        definition('mcp_remote_write'),
      ],
    },
    [
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
    ],
  );
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
  const run = (override: { system_prompt?: string } = {}, signal = new AbortController().signal) =>
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

test('empty prompt override is preserved and a silent run is successful without mutating config', async () => {
  const f = await fixture();
  const config = f.configStore.current();
  f.faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toBe('');
      return fauxAssistantMessage('private thought');
    },
  ]);
  const result = await f.run({ system_prompt: '' });
  expect(result).toMatchObject({
    error: null,
    responded: false,
    send_count: 0,
    overrides: { system_prompt: true },
    completion_reason: 'completed',
  });
  expect(f.configStore.current()).toBe(config);
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
