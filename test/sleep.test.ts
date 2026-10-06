import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Provider,
  type Usage,
} from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { type LoadedConfig, loadConfig } from '../src/platform/config.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { activeSleepUntil, enterSleep, SLEEP_STATE_KEY } from '../src/store/sleep.ts';
import { SLEEP_STATE_PROMPT } from '../src/context/context-builder.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { fauxRegistry, testConfigStore, writeTestConfig, type TestRegistry } from './helpers.ts';

const directories: string[] = [];

const update: Update = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: 123456789, type: 'private', first_name: 'Owner' },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
    text: 'hello',
  },
};

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function openStore(
  prefix = 'plasticwan-sleep-',
  registry?: TestRegistry,
): Promise<{ loaded: LoadedConfig; configStore: RuntimeConfigurationStore; store: SqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, registry);
  return { loaded, configStore, store: await SqliteStore.open(loaded.config) };
}

/**
 * Registers the faux provider with every reply reporting `usage`. The faux
 * provider estimates its own usage and never reports cache traffic, which is
 * exactly what these budget tests need to control.
 */
function reportingUsage(faux: FauxProviderHandle, usage: Omit<Usage, 'totalTokens' | 'cost'>): TestRegistry {
  const reported: Usage = {
    ...usage,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const rewrite = (inner: AssistantMessageEventStream): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of inner) {
        outer.push(event.type === 'done' ? { ...event, message: { ...event.message, usage: reported } } : event);
      }
      outer.end();
    })();
    return outer;
  };
  const base = faux.provider;
  const provider: Provider = {
    ...base,
    stream: (model, context, options) => rewrite(base.stream(model, context, options)),
    streamSimple: (model, context, options) => rewrite(base.streamSimple(model, context, options)),
  };
  const models = createModels();
  models.setProvider(provider);
  return { models, visionModel: faux.getModel() };
}

async function runtimeSetup(
  usedTokens: bigint,
  usageResource = '123456789',
  usage?: Omit<Usage, 'totalTokens' | 'cost'>,
): Promise<{
  store: SqliteStore;
  configStore: RuntimeConfigurationStore;
  runtime: AgentRuntime;
  invocationId: bigint;
  faux: FauxProviderHandle;
}> {
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const { configStore, store } = await openStore(
    'plasticwan-sleep-',
    usage === undefined ? fauxRegistry(faux) : reportingUsage(faux, usage),
  );
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?)",
    )
    .run(now.slice(0, 10), usageResource, usedTokens, now);

  let messageId = 500;
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });
  return { store, configStore, runtime, invocationId, faux };
}

function modelToolLists(store: SqliteStore): string[][] {
  return store.db
    .prepare<[], { tools_json: string }>("SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id")
    .all()
    .map((row) => JSON.parse(row.tools_json) as string[]);
}

function todayUsage(store: SqliteStore): bigint | undefined {
  return store.db
    .prepare<[string, string], { amount: bigint }>(
      "SELECT amount FROM daily_usage WHERE utc_date = ? AND scope = 'chat' AND resource = ? AND metric = 'model_tokens'",
    )
    .get(new Date().toISOString().slice(0, 10), '123456789')?.amount;
}

test('charges a free model the cache tokens of its calls', async () => {
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(0n, '123456789', {
    input: 120,
    output: 30,
    cacheRead: 4_000,
    cacheWrite: 850,
  });
  faux.setResponses([fauxAssistantMessage('   ')]);
  await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  const call = store.db
    .prepare<
      [],
      {
        input_tokens: bigint;
        output_tokens: bigint;
        cache_read_tokens: bigint;
        cache_write_tokens: bigint;
        cost: number;
      }
    >(
      "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost FROM model_calls WHERE role = 'agent'",
    )
    .get();
  // The breakdown stays on the audit row; the budget meters all of it, and a
  // zero price changes nothing.
  expect(call).toEqual({
    input_tokens: 120n,
    output_tokens: 30n,
    cache_read_tokens: 4_000n,
    cache_write_tokens: 850n,
    cost: 0,
  });
  expect(todayUsage(store)).toBe(5_000n);
  store.close();
});

test('stops a cache-heavy runaway invocation on the daily budget', async () => {
  // Each turn generates almost nothing and re-reads a large cached prompt, the
  // shape of a tool loop on a long context. 60,000 tokens a turn against the
  // 300,000 budget trips the breaker on the fifth turn, three turns before the
  // per-injection turn limit would.
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(0n, '123456789', {
    input: 10,
    output: 5,
    cacheRead: 59_985,
    cacheWrite: 0,
  });
  faux.setResponses(
    Array.from({ length: 8 }, () =>
      fauxAssistantMessage(fauxToolCall('read', { uri: 'system:///missing.md' }), { stopReason: 'toolUse' }),
    ),
  );
  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'completed',
    reason: 'budget',
  });
  const calls = store.db
    .prepare<[], { calls: bigint; input_output: bigint }>(
      "SELECT COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS input_output FROM model_calls WHERE role = 'agent'",
    )
    .get();
  expect(calls).toEqual({ calls: 5n, input_output: 75n });
  expect(todayUsage(store)).toBe(300_000n);
  store.close();
});

test.each([285_000n, 285_001n])(
  'scene definitions use the current zzz budget gate without writes at %s tokens',
  async (used) => {
    const { store, configStore, runtime } = await runtimeSetup(used);
    try {
      const before = store.db.prepare('SELECT * FROM daily_usage').all();
      const registry = runtime.sceneToolDefinitions(previewContext(), configStore.current().config);
      expect(registry.tools.map((tool) => tool.name)).toEqual(
        used === 285_000n ? ['read', 'send', 'execute'] : ['read', 'send', 'execute', 'zzz'],
      );
      expect(store.db.prepare('SELECT * FROM daily_usage').all()).toEqual(before);
      expect(store.db.prepare('SELECT * FROM tool_calls').all()).toEqual([]);
      expect(store.db.prepare('SELECT * FROM app_state').all()).toEqual([]);
    } finally {
      store.close();
    }
  },
);

test('does not expose zzz while more than five percent remains', async () => {
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(284_999n);
  // The model deliberately stays silent with a blank draft so the send nudge
  // cannot add a second turn whose usage would push the budget over the line.
  faux.setResponses([fauxAssistantMessage('   ')]);
  await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['read', 'send', 'execute']]);
  store.close();
});

test('exposes zzz after global remaining budget falls below five percent', async () => {
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(285_001n, '987654321');
  faux.setResponses([fauxAssistantMessage('   ')]);
  await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['read', 'send', 'execute', 'zzz']]);
  store.close();
});

test('blocks model calls after another chat exhausts the global daily budget', async () => {
  const { store, configStore, runtime, invocationId } = await runtimeSetup(300_000n, '987654321');
  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'failed',
    reason: 'daily_token_budget',
  });
  expect(modelToolLists(store)).toEqual([]);
  store.close();
});

test('keeps zzz hidden at exactly five percent remaining', async () => {
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(285_000n);
  faux.setResponses([fauxAssistantMessage('   ')]);
  await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['read', 'send', 'execute']]);
  store.close();
});

test('adds zzz at the next turn boundary when a running session crosses the threshold', async () => {
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(285_000n);
  const systemPrompts: string[] = [];
  const first = fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'good night' }), {
    stopReason: 'toolUse',
  });
  faux.setResponses([
    (context) => {
      systemPrompts.push(context.systemPrompt ?? '');
      return {
        ...first,
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
    (context) => {
      systemPrompts.push(context.systemPrompt ?? '');
      return fauxAssistantMessage(fauxToolCall('zzz', {}), { stopReason: 'toolUse' });
    },
  ]);
  await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(modelToolLists(store)).toEqual([
    ['read', 'send', 'execute'],
    ['read', 'send', 'execute', 'zzz'],
  ]);
  expect(activeSleepUntil(store.orm)).not.toBeNull();
  expect(systemPrompts).toHaveLength(2);
  // The sleep state never enters the system prompt: it would invalidate the
  // whole Conversation Context on every budget transition. The prompt stays
  // byte-identical across the boundary, and the state is restated with the next
  // injected batch instead.
  expect(systemPrompts[0]).not.toContain(SLEEP_STATE_PROMPT);
  expect(systemPrompts[1]).toBe(systemPrompts[0]);
  store.close();
});

test('states the sleep state only while zzz is exposed', async () => {
  const awake = await runtimeSetup(284_999n);
  const awakePrompts: string[] = [];
  awake.faux.setResponses([
    (context) => {
      awakePrompts.push(context.systemPrompt ?? '');
      return fauxAssistantMessage('   ');
    },
  ]);
  await awake.runtime.run(awake.invocationId, awake.configStore.beginInvocation(), new AbortController().signal);
  expect(awakePrompts).toHaveLength(1);
  expect(awakePrompts[0]).not.toContain(SLEEP_STATE_PROMPT);
  expect(
    awake.store.db
      .prepare<[], { payload_json: string }>(
        "SELECT payload_json FROM context_messages WHERE role = 'user' ORDER BY seq DESC LIMIT 1",
      )
      .get()?.payload_json,
  ).not.toContain(SLEEP_STATE_PROMPT);
  awake.store.close();

  const sleepy = await runtimeSetup(285_001n);
  const sleepyPrompts: string[] = [];
  sleepy.faux.setResponses([
    (context) => {
      sleepyPrompts.push(context.systemPrompt ?? '');
      return fauxAssistantMessage('   ');
    },
  ]);
  await sleepy.runtime.run(sleepy.invocationId, sleepy.configStore.beginInvocation(), new AbortController().signal);
  expect(sleepyPrompts).toHaveLength(1);
  expect(sleepyPrompts[0]).not.toContain(SLEEP_STATE_PROMPT);
  expect(
    sleepy.store.db
      .prepare<[], { payload_json: string }>(
        "SELECT payload_json FROM context_messages WHERE role = 'user' ORDER BY seq DESC LIMIT 1",
      )
      .get()?.payload_json,
  ).toContain(SLEEP_STATE_PROMPT);
  sleepy.store.close();
});

test('zzz enters sleeping and ends without another model turn', async () => {
  const { store, configStore, runtime, invocationId, faux } = await runtimeSetup(285_001n);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('zzz', {}), { stopReason: 'toolUse' })]);
  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'completed',
    reason: 'sleep',
  });
  expect(activeSleepUntil(store.orm)).not.toBeNull();
  expect(modelToolLists(store)).toHaveLength(1);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'zzz' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(0n);
  store.close();
});

test('sleeping skips both due and already queued agent sessions', async () => {
  const { configStore, store } = await openStore();
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => {
    throw new Error('Sleeping scheduler must not create an agent session');
  });
  const now = new Date();
  ingestion.ingest(update, now);
  enterSleep(store.orm, new Date(now.getTime() + 16_000));
  expect(scheduler.processDue(new Date(now.getTime() + 15_000))).toEqual([]);

  const secondUpdate = structuredClone(update);
  if (secondUpdate.message === undefined) {
    throw new Error('Expected message update');
  }
  secondUpdate.update_id = 2;
  secondUpdate.message.message_id = 11;
  const secondReceived = new Date(now.getTime() + 17_000);
  activeSleepUntil(store.orm, new Date(now.getTime() + 16_500));
  store.db.prepare('DELETE FROM app_state WHERE key = ?').run(SLEEP_STATE_KEY);
  ingestion.ingest(secondUpdate, secondReceived);
  const [queuedId] = scheduler.processDue(new Date(secondReceived.getTime() + 15_000));
  if (queuedId === undefined) {
    throw new Error('Expected a queued invocation');
  }
  enterSleep(store.orm, new Date(secondReceived.getTime() + 16_000));
  scheduler.start(new Date(secondReceived.getTime() + 16_000));
  await scheduler.stop();
  expect(
    store.db.prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?').get(queuedId)?.state,
  ).toBe('skipped_budget');
  store.close();
});

test('sleeping persists across reopening the SQLite store', async () => {
  const { loaded, store } = await openStore('plasticwan-sleep-restart-');
  const expected = enterSleep(store.orm).sleepUntil;
  store.close();
  const reopened = await SqliteStore.open(loaded.config);
  expect(activeSleepUntil(reopened.orm)).toBe(expected);
  reopened.close();
});

test('the next UTC budget period wakes the bot after its minimum sleep', async () => {
  const { configStore, store } = await openStore();
  const slept = enterSleep(store.orm, new Date('2026-08-15T01:00:00.000Z'));
  expect(slept.sleepUntil).toBe('2026-08-16T00:00:00.000Z');
  expect(activeSleepUntil(store.orm, new Date('2026-08-15T23:59:59.999Z'))).toBe(slept.sleepUntil);
  expect(activeSleepUntil(store.orm, new Date('2026-08-16T00:00:00.000Z'))).toBeNull();
  expect(store.db.prepare('SELECT value FROM app_state WHERE key = ?').get(SLEEP_STATE_KEY)).toBeUndefined();
  const awakeAt = new Date('2026-08-16T00:00:00.001Z');
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  ingestion.ingest(update, awakeAt);
  expect(scheduler.processDue(new Date(awakeAt.getTime() + 15_000))).toHaveLength(1);
  store.close();
});

test('repeated concurrent sleep requests keep one unchanged state', async () => {
  const { store } = await openStore();
  const now = new Date('2026-08-15T20:00:00.000Z');
  const transitions = await Promise.all(Array.from({ length: 8 }, async () => enterSleep(store.orm, now)));
  expect(transitions.filter((transition) => transition.entered)).toHaveLength(1);
  expect(new Set(transitions.map((transition) => transition.sleepUntil)).size).toBe(1);
  expect(
    store.db
      .prepare<[string], { count: bigint }>('SELECT COUNT(*) AS count FROM app_state WHERE key = ?')
      .get(SLEEP_STATE_KEY)?.count,
  ).toBe(1n);
  store.close();
});
