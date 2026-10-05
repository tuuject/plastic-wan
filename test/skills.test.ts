import { afterAll, expect, test } from 'vitest';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import Type from 'typebox';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { createToolAudit } from '../src/store/tool-audit.ts';
import { capability, createExecuteTool } from '../src/capabilities/execute-tool.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { createMemoryTools, MemoryStore } from '../src/context/memory.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { StickerService } from '../src/capabilities/stickers.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import {
  bundledSystemResources,
  fauxRegistry,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  type TestRegistry,
} from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface InvocationSetup {
  readonly store: SqliteStore;
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
  readonly configStore: RuntimeConfigurationStore;
  readonly invocationId: bigint;
}

async function setupInvocation(
  prefix: string,
  withStickers: boolean,
  registry: TestRegistry,
): Promise<InvocationSetup & { stickerId?: bigint }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    if (withStickers) {
      config.telegram.sticker_sets = [{ alias: 'cats', name: 'CatSet' }];
    }
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, registry);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
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
  return { store, loaded, configStore, invocationId };
}

async function indexOneSticker(
  setup: InvocationSetup,
  visionFaux: ReturnType<typeof fauxProvider>,
): Promise<{ stickers: StickerService; stickerId: bigint }> {
  const { store, loaded, configStore } = setup;
  const fixturePath = join(tmpdir(), `plasticwan-skills-sticker-${crypto.randomUUID()}.webp`);
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
    .webp()
    .toFile(fixturePath);
  directories.push(fixturePath);
  visionFaux.setResponses([
    () =>
      fauxAssistantMessage(
        fauxToolCall('report_sticker_analysis', {
          description_zh: '一只委屈猫正在哭泣',
          emotion_zh: ['委屈'],
          action_zh: ['哭泣'],
          tags_zh: ['猫'],
          tags_en: ['cat'],
        }),
      ),
  ]);
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      await copyFile(fixturePath, destination);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const stickers = new StickerService({
    store,
    config: loaded.config,
    media,
    api: {
      getStickerSet: async () => ({
        name: 'CatSet',
        title: 'Cats',
        stickers: [
          {
            file_id: 'sticker-file',
            file_unique_id: 'sticker-unique',
            width: 64,
            height: 64,
            is_animated: false,
            is_video: false,
            emoji: '😭',
            thumbnail: { file_id: 'thumb-file' },
          },
        ],
      }),
    },
  });
  await stickers.sync();
  expect(await stickers.runOne()).toBe(true);
  const stickerId = store.db.prepare<[], { id: bigint }>('SELECT id FROM stickers').get()?.id;
  if (stickerId === undefined) {
    throw new Error('Sticker indexing did not create a row');
  }
  return { stickers, stickerId };
}

function lastToolResult(messages: readonly Message[]): ToolResultMessage {
  const last = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult').at(-1);
  if (last === undefined) {
    throw new Error('Expected a tool result message');
  }
  return last;
}

function toolResultText(message: ToolResultMessage): string {
  return message.content
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('');
}

test('the skill index reaches the system prompt and primitives stay directly callable', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('plasticwan-skills-index-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  agentFaux.setResponses([
    (context) => {
      expect(context.systemPrompt).toContain('System skills:');
      expect(context.systemPrompt).toContain('system:///skills/sticker-search/SKILL.md');
      expect(context.systemPrompt).toContain('This index is the complete list');
      expect(context.systemPrompt).toContain('read_image capability (called via execute)');
      expect(context.systemPrompt).toContain('add_memory capability (called via execute)');
      expect(context.systemPrompt).not.toContain('# Web fetch');
      expect(context.tools?.map((tool) => tool.name)).toEqual(['read', 'send', 'execute']);
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'help', tool: 'web_fetch' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      const help = lastToolResult(context.messages);
      expect(help.isError).toBe(false);
      const parsed = JSON.parse(toolResultText(help)) as { name: string; parameters: unknown };
      expect(parsed.name).toBe('web_fetch');
      expect(parsed.parameters).toMatchObject({ type: 'object' });
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'search', query: 'fetch a web page' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      const search = lastToolResult(context.messages);
      const results = JSON.parse(toolResultText(search)) as { name: string; summary: string }[];
      expect(results.some((result) => result.name === 'web_fetch' && result.summary === 'Fetch a web page')).toBe(true);
      return fauxAssistantMessage('done');
    },
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  const memoryStore = new MemoryStore(store.orm);
  const runtime = new AgentRuntime({
    store,
    configStore: setup.configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: await bundledSystemResources(),
    capabilityTools: (context, deadline) => [
      ...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true)),
      ...loadPlugins(BUILTIN_PLUGINS).capabilities(store, setup.loaded.config, context, deadline),
    ],
  });
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  const executeRows = store.db
    .prepare<[], { state: string; error_code: string | null }>(
      "SELECT state, error_code FROM tool_calls WHERE tool_name = 'execute' ORDER BY id",
    )
    .all();
  expect(executeRows).toEqual([
    { state: 'success', error_code: null },
    { state: 'success', error_code: null },
  ]);
  store.close();
});

test('search_stickers runs through execute and its refs authorize a sticker send', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const visionFaux = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-model', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const setup = await setupInvocation('plasticwan-skills-sticker-', true, {
    models,
    visionModel: visionFaux.getModel(),
  });
  const { store } = setup;
  const { stickers, stickerId } = await indexOneSticker(setup, visionFaux);
  agentFaux.setResponses([
    (context) => {
      expect(context.systemPrompt ?? '').toContain('search_stickers capability via execute');
      expect(context.messages.some((message) => message.role === 'user')).toBe(true);
      return fauxAssistantMessage(
        fauxToolCall('execute', {
          action: 'call',
          tool: 'search_stickers',
          input: { ids: [stickerId.toString()] },
        }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const call = lastToolResult(context.messages);
      expect(call.isError).toBe(false);
      const envelope = JSON.parse(toolResultText(call)) as {
        text: string;
        refs: { sticker_ref: string[] };
      };
      expect(envelope.text).toContain(stickerId.toString());
      expect(envelope.refs.sticker_ref).toHaveLength(1);
      const stickerRef = envelope.refs.sticker_ref[0];
      if (stickerRef === undefined || !stickerRef.startsWith('stk_')) {
        throw new Error('Expected an authorized stk_ sticker_ref');
      }
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'sticker', sticker_ref: stickerRef }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('sent'),
  ]);
  let sentSticker: string | undefined;
  const runtime = new AgentRuntime({
    store,
    configStore: setup.configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 501, date: 1, chat: { id: 123456789 } }),
      sendSticker: async (_chatId, sticker) => {
        sentSticker = sticker;
        return { message_id: 502, date: 1, chat: { id: 123456789 } };
      },
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: await bundledSystemResources(),
    capabilityTools: (context, _deadline, capabilities) => [
      capability(stickers.createSearchTool(context, capabilities), false),
    ],
  });
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  expect(sentSticker).toBe('sticker-file');
  const rows = store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    { tool_name: 'execute', state: 'success', error_code: null },
    { tool_name: 'search_stickers', state: 'success', error_code: null },
    { tool_name: 'send', state: 'success', error_code: null },
  ]);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM telegram_sends WHERE state = 'success'")
      .get()?.count,
  ).toBe(1n);
  store.close();
});

test('execute refuses primitives and unknown capabilities while memory calls still work', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('plasticwan-skills-memory-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  agentFaux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('execute', { action: 'call', tool: 'send', input: { kind: 'text', text: 'nope' } }),
      { stopReason: 'toolUse' },
    ),
    (context) => {
      const rejected = lastToolResult(context.messages);
      expect(rejected.isError).toBe(true);
      expect(toolResultText(rejected)).toContain('runtime primitive send');
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'owner likes cats' } }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const saved = lastToolResult(context.messages);
      expect(saved.isError).toBe(false);
      expect(toolResultText(saved)).toContain('Saved memory');
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'generate_image', input: { prompt: 'x' } }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const unknown = lastToolResult(context.messages);
      expect(unknown.isError).toBe(true);
      expect(toolResultText(unknown)).toContain('no capability named generate_image');
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'saved' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('done'),
  ]);
  const memoryStore = new MemoryStore(store.orm);
  const runtime = new AgentRuntime({
    store,
    configStore: setup.configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: await bundledSystemResources(),
    capabilityTools: (context) => [...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true))],
  });
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  const rows = store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    { tool_name: 'execute', state: 'error', error_code: 'execute_primitive_rejected' },
    { tool_name: 'execute', state: 'success', error_code: null },
    { tool_name: 'add_memory', state: 'success', error_code: null },
    { tool_name: 'execute', state: 'error', error_code: 'unknown_capability' },
    { tool_name: 'send', state: 'success', error_code: null },
  ]);
  const memories = store.db
    .prepare<[], { content: string }>('SELECT content FROM memories')
    .all()
    .map((row) => row.content);
  expect(memories).toEqual(['owner likes cats']);
  store.close();
});

test('execute rejects a half-filled action before dispatch and audits the rejection', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('plasticwan-skills-invalid-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  agentFaux.setResponses([
    // The flattened provider schema cannot require `input` for call alone, so a
    // lenient endpoint can hand this over; the runtime must reject it.
    fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'add_memory' }), { stopReason: 'toolUse' }),
    (context) => {
      const missingInput = lastToolResult(context.messages);
      expect(missingInput.isError).toBe(true);
      expect(toolResultText(missingInput)).toContain('execute.call requires an input object');
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'search' }), { stopReason: 'toolUse' });
    },
    (context) => {
      const missingQuery = lastToolResult(context.messages);
      expect(missingQuery.isError).toBe(true);
      expect(toolResultText(missingQuery)).toContain('execute.search requires a query string');
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'help', tool: 'add_memory' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      const help = lastToolResult(context.messages);
      expect(help.isError).toBe(false);
      expect(toolResultText(help)).toContain('add_memory');
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'nothing to save' }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('done'),
  ]);
  const memoryStore = new MemoryStore(store.orm);
  const runtime = new AgentRuntime({
    store,
    configStore: setup.configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: await bundledSystemResources(),
    capabilityTools: (context) => [...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true))],
  });
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  const rows = store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    { tool_name: 'execute', state: 'error', error_code: 'invalid_arguments' },
    { tool_name: 'execute', state: 'error', error_code: 'invalid_arguments' },
    { tool_name: 'execute', state: 'success', error_code: null },
    { tool_name: 'send', state: 'success', error_code: null },
  ]);
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(0n);
  store.close();
});

test('execute does not dispatch a capability once the run is aborted', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('plasticwan-skills-aborted-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  let dispatched = 0;
  // Like the alarm capability, this side effect ignores its signal.
  const sideEffect = capability(
    {
      name: 'record_note',
      label: 'Record a note',
      description: 'Records a note.',
      parameters: Type.Object({ note: Type.String() }),
      execute: async () => {
        dispatched += 1;
        return { content: [{ type: 'text', text: 'recorded' }], details: {} };
      },
    },
    true,
  );
  const tool = createExecuteTool({
    audit: createToolAudit(store, setup.invocationId),
    capabilities: [sideEffect],
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    tool.execute('aborted-call', { action: 'call', tool: 'record_note', input: { note: 'x' } }, controller.signal),
  ).rejects.toThrow('execute.call record_note failed');
  expect(dispatched).toBe(0);
  expect(
    store.db
      .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
        'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
      )
      .all(),
  ).toEqual([{ tool_name: 'execute', state: 'error', error_code: 'aborted' }]);
  store.close();
});
