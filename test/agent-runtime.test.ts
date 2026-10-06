import { afterAll, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import Type from 'typebox';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { modelCalls } from '../src/store/schema.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { capability } from '../src/capabilities/execute-tool.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';
import { SystemResources } from '../src/platform/system-resources.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

test.each([undefined, false, true])(
  'a fresh Agent preserves auditing and hot-applies payload recording from %s',
  async (recordPayloads) => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        if (recordPayloads !== undefined) {
          config.developer = { record_model_payloads: recordPayloads };
        }
      }),
    );
    const loaded = await loadConfig(configPath);
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const configStore = await testConfigStore(loaded, fauxRegistry(faux));
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

    faux.setResponses([
      (context, options) => {
        // The faux provider never touches the network, so the snapshot hooks are
        // triggered manually to mirror what real adapters do.
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        // OpenAI-compatible endpoints reject a tool whose `parameters` is not a root
        // object schema; the top-level union `execute` used to carry failed every
        // gpt-4o invocation with 400 invalid_function_parameters.
        const tools = context.tools ?? [];
        expect(tools.map((tool) => tool.name)).toEqual(['read', 'send', 'execute']);
        for (const tool of tools) {
          expect(tool.parameters).toMatchObject({ type: 'object' });
        }
        const current = configStore.current();
        configStore.publish({
          ...current,
          config: { ...current.config, developer: { record_model_payloads: !recordPayloads } },
        });
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        return fauxAssistantMessage('private assistant text');
      },
    ]);
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
    const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM telegram_sends WHERE state = 'success'")
        .get()?.count,
    ).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages WHERE sent_by_bot = 1').get()
        ?.count,
    ).toBe(1n);
    const assistantTexts = store.db
      .prepare<[], { text: string }>("SELECT text FROM agent_messages WHERE role = 'assistant' ORDER BY sequence_no")
      .all()
      .map((row) => row.text);
    expect(assistantTexts).toContain('private assistant text');
    expect(
      store.db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE state = 'success'").get()
        ?.count,
    ).toBe(2n);
    const presented = store.db
      .prepare<[], { tools_json: string | null }>(
        "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
      )
      .get();
    expect(presented?.tools_json).toBe(JSON.stringify(['read', 'send', 'execute']));
    const snapshot = store.db
      .prepare<[], { request_json: string | null; response_json: string | null }>(
        "SELECT request_json, response_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
      )
      .get();
    if (recordPayloads === true) {
      expect(String(snapshot?.request_json)).toContain('"messages"');
      expect(snapshot?.response_json).toBe(JSON.stringify({ status: 200 }));
    } else {
      expect(snapshot).toEqual({ request_json: null, response_json: null });
    }
    const nextCall = store.db
      .prepare<[], { request_json: string | null; response_json: string | null }>(
        'SELECT request_json, response_json FROM model_calls ORDER BY id DESC LIMIT 1',
      )
      .get();
    if (recordPayloads === true) {
      expect(nextCall).toEqual({ request_json: null, response_json: null });
    } else {
      expect(nextCall?.request_json).toContain('"messages"');
      expect(nextCall?.response_json).toBe('{"status":200}');
    }
    const auditedCalls = store.orm.select().from(modelCalls).all();
    // The replay snapshot path is retired: whichever recording mode is active,
    // the migrated schema has no column left to hold one.
    const callColumns = store.db
      .prepare<[], { name: string }>('PRAGMA table_info(model_calls)')
      .all()
      .map((column) => column.name);
    expect(callColumns).not.toContain('replay_input_json');
    for (const call of auditedCalls) {
      expect(call.outputTokens).toBeGreaterThan(0n);
      expect(call.totalTokens).toBe(
        call.inputTokens! + call.outputTokens! + call.cacheReadTokens! + call.cacheWriteTokens!,
      );
      expect(call.cost).toBe(0);
      expect(call.cacheReadTokens).toBeGreaterThanOrEqual(0n);
      expect(call.cacheWriteTokens).toBeGreaterThanOrEqual(0n);
      expect(call.finishedAt).not.toBeNull();
    }
    expect(
      store.db
        .prepare(
          "SELECT amount FROM daily_usage WHERE scope = 'chat' AND resource = '123456789' AND metric = 'model_tokens'",
        )
        .get(),
    ).toEqual({
      amount: auditedCalls.reduce((total, call) => total + call.totalTokens!, 0n),
    });
    const registryRow = store.db
      .prepare<[bigint], { tool_registry_json: string | null }>(
        'SELECT tool_registry_json FROM invocations WHERE id = ?',
      )
      .get(invocationId);
    expect(registryRow?.tool_registry_json).toContain('"name":"send"');
    expect(registryRow?.tool_registry_json).toContain('"label":"Send to Telegram"');
    expect(registryRow?.tool_registry_json).toContain('Publish exactly one warranted user-visible Telegram message');
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
        .get()?.count,
    ).toBe(0n);
    store.close();
  },
);

test('an invocation keeps running past the removed per-invocation tool-call cap and still audits the count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-no-tool-cap-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 3,
    message: {
      message_id: 12,
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

  const noop: AgentTool = {
    name: 'noop',
    label: 'Noop',
    description: 'Test-only tool that returns without side effects.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
  // 6 tool turns x 3 calls = 18 tool calls: the former max_tool_calls cap of 12
  // is gone, so only the per-injection turn budget (8) bounds the run. That
  // budget stops the run at the 8th turn, which is what 'turn_budget' records.
  faux.setResponses([
    ...Array.from({ length: 6 }, () =>
      fauxAssistantMessage([fauxToolCall('noop', {}), fauxToolCall('noop', {}), fauxToolCall('noop', {})], {
        stopReason: 'toolUse',
      }),
    ),
    fauxAssistantMessage('done'),
    fauxAssistantMessage(''),
  ]);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    additionalTools: () => [noop],
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'turn_budget' });
  const audited = store.db
    .prepare<[bigint], { tool_calls_used: bigint }>('SELECT tool_calls_used FROM invocations WHERE id = ?')
    .get(invocationId);
  expect(audited?.tool_calls_used).toBe(18n);
  store.close();
});

test('counts tool descriptions in registry limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-tool-budget-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    // The id must match `agent.model`: the registry is validated against the
    // model the run's configuration snapshot names.
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 1_000, maxTokens: 100 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });
  const oversizedDescriptionTool: AgentTool = {
    name: 'large_description',
    label: 'Large description',
    description: 'x'.repeat(500),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };

  expect(() => runtime.validateAdditionalTools(previewContext(), [oversizedDescriptionTool], faux.getModel())).toThrow(
    'Tool registry exceeds 10%',
  );
  store.close();
});

test('audits complete redacted model error details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-error-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'trigger a model error',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const errorDetail = 'Provider request failed with telegram-secret\nstatus=500\nbody={"error":"upstream exploded"}';
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: errorDetail })]);
  const secrets = new SecretStore(keyJarPath(loaded.configPath));
  await secrets.resolve(loaded.config.telegram.token);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets,
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });

  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'failed',
    reason: 'model_error',
  });
  expect(
    store.db
      .prepare<[], { state: string; error_code: string | null; error_detail: string | null }>(
        'SELECT state, error_code, error_detail FROM model_calls',
      )
      .get(),
  ).toEqual({
    state: 'error',
    error_code: 'model_error',
    error_detail: errorDetail.replace('telegram-secret', '[REDACTED]'),
  });
  store.close();
});

test('passes Telegram photos directly to the multimodal agent and keeps stickers tool-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.developer = { record_model_payloads: true };
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({
    create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  const update: Update = {
    update_id: 2,
    message: {
      message_id: 20,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      photo: [
        { file_id: 'photo-small', file_unique_id: 'photo-small-unique', width: 8, height: 4, file_size: 50 },
        { file_id: 'photo-large', file_unique_id: 'photo-large-unique', width: 16, height: 8, file_size: 100 },
      ],
      sticker: {
        file_id: 'sticker-file',
        file_unique_id: 'sticker-unique',
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const inlineImageBytes = Buffer.from('provider inline image bytes');
  const inlineImageDataUrl = `data:image/jpeg;base64,${inlineImageBytes.toString('base64')}`;
  faux.setResponses([
    (context, options) => {
      const providerPayload = {
        model: 'agent-model',
        messages: [{ content: [{ type: 'image_url', image_url: { url: inlineImageDataUrl } }] }],
      };
      options?.onPayload?.(providerPayload, faux.getModel());
      expect(providerPayload.messages[0]?.content[0]?.image_url.url).toBe(inlineImageDataUrl);
      const user = context.messages[0];
      expect(user?.role).toBe('user');
      if (user?.role !== 'user' || typeof user.content === 'string') {
        throw new Error('Expected multimodal user content');
      }
      const images = user.content.filter((entry) => entry.type === 'image');
      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe('image/jpeg');
      expect(user.content[0]).toMatchObject({ type: 'text' });
      expect(user.content).toContainEqual({ type: 'text', text: expect.stringContaining('[photo figure_1 ') });
      return fauxAssistantMessage('saw the photo');
    },
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      expect(fileId).toBe('photo-large');
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
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 502, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM media').get()?.count).toBe(2n);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image'")
      .get()?.count,
  ).toBe(0n);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat'")
      .get()?.count,
  ).toBe(0n);
  const requestJson = store.db
    .prepare<[], { request_json: string | null }>(
      "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
    )
    .get()?.request_json;
  expect(requestJson).not.toContain(inlineImageDataUrl);
  expect(requestJson === null || requestJson === undefined ? null : JSON.parse(requestJson)).toMatchObject({
    messages: [
      {
        content: [
          {
            image_url: {
              url: {
                __plasticwan_audit_omission__: 'base64_image',
                mime_type: 'image/jpeg',
                encoded_characters: inlineImageBytes.toString('base64').length,
                decoded_bytes: inlineImageBytes.byteLength,
                sha256: createHash('sha256').update(inlineImageBytes).digest('hex'),
              },
            },
          },
        ],
      },
    ],
  });
  // The stored transcript drops the attachment, so a replay can only reach the
  // photo through the img_ ref carried on its figure line.
  const storedBatch = store.db
    .prepare<[], { payload_json: string }>(
      "SELECT payload_json FROM context_messages WHERE role = 'user' ORDER BY seq LIMIT 1",
    )
    .get()?.payload_json;
  expect(storedBatch).not.toContain('"type":"image"');
  const storedRef = /\[photo figure_1 (img_[^\s\]]+)/.exec(storedBatch ?? '')?.[1];
  expect(storedRef).toBeDefined();
  expect(
    store.db
      .prepare<[string], { kind: string }>(
        "SELECT m.kind FROM context_refs r JOIN media m ON m.id = r.media_id WHERE r.ref = ? AND r.kind = 'media'",
      )
      .get(storedRef ?? ''),
  ).toEqual({ kind: 'photo' });
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});

test('keeps history photos as img_ refs for the multimodal agent while attaching only new photos', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-history-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const visionFaux = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-model', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const configStore = await testConfigStore(loaded, { models, visionModel: visionFaux.getModel() });
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));

  // First bucket: a photo message that becomes history for the next invocation.
  const firstReceived = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 10,
      message: {
        message_id: 40,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        photo: [
          { file_id: 'history-photo', file_unique_id: 'history-photo-unique', width: 16, height: 8, file_size: 100 },
        ],
      },
    },
    firstReceived,
  );
  const [firstInvocation] = scheduler.processDue(new Date(firstReceived.getTime() + 15_000));
  if (firstInvocation === undefined) {
    throw new Error('Expected the first invocation');
  }
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(firstInvocation);
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(firstInvocation);

  // Second bucket: text-only trigger; the earlier photo is history now.
  const secondReceived = new Date(firstReceived.getTime() + 60_000);
  ingestion.ingest(
    {
      update_id: 11,
      message: {
        message_id: 41,
        date: 1_700_000_060,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'what was in that picture?',
      },
    },
    secondReceived,
  );
  const [secondInvocation] = scheduler.processDue(new Date(secondReceived.getTime() + 15_000));
  if (secondInvocation === undefined) {
    throw new Error('Expected the second invocation');
  }

  let historyRef: string | undefined;
  agentFaux.setResponses([
    (context) => {
      const user = context.messages[0];
      expect(user?.role).toBe('user');
      if (user?.role !== 'user' || typeof user.content === 'string') {
        throw new Error('Expected multimodal user content');
      }
      expect(user.content.filter((entry) => entry.type === 'image')).toHaveLength(0);
      const text = user.content.find((entry) => entry.type === 'text')?.text ?? '';
      expect(text).toContain('\n[40 ');
      expect(text).not.toContain(' figure_');
      const match = /\[photo (img_\S+)/.exec(text);
      historyRef = match?.[1];
      if (historyRef === undefined) {
        throw new Error('Multimodal agent context omitted the history img_ ref');
      }
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: historyRef } }),
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('understood'),
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  visionFaux.setResponses([fauxAssistantMessage('A dark rectangle.')]);
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: {
      download: async (fileId, destination, signal) => {
        signal.throwIfAborted();
        expect(fileId).toBe('history-photo');
        await copyFile(fixturePath, destination);
      },
    },
    modelGate: new KeyedSemaphore(),
  });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 601, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 602, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    capabilityTools: (context, deadline, capabilities) => [
      capability(media.createReadImageTool(context, capabilities, deadline), false),
    ],
  });
  const outcome = await runtime.run(secondInvocation, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(agentFaux.state.callCount).toBe(3);
  expect(visionFaux.state.callCount).toBe(1);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});
test('lets a text-only agent read a Telegram photo through read_image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-fallback-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
      throw new Error('Expected custom agent provider fixture');
    }
    provider.models[0].input = ['text'];
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
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
  const visionModel = visionFaux.getModel();
  const configStore = await testConfigStore(loaded, { models, visionModel });
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 3,
      message: {
        message_id: 30,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 16, height: 8, file_size: 100 }],
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  let photoRef: string | undefined;
  agentFaux.setResponses([
    (context) => {
      const content = context.messages[0]?.content;
      if (typeof content !== 'string') {
        const text = content?.find((entry) => entry.type === 'text')?.text ?? '';
        const match = /\[photo (\S+)/.exec(text);
        photoRef = match?.[1];
      }
      if (photoRef === undefined) {
        throw new Error('Text-only agent context omitted image_ref');
      }
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: photoRef } }),
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('understood'),
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  visionFaux.setResponses([fauxAssistantMessage('A dark rectangle.')]);
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: {
      download: async (fileId, destination, signal) => {
        signal.throwIfAborted();
        expect(fileId).toBe('photo-file');
        await copyFile(fixturePath, destination);
      },
    },
    modelGate: new KeyedSemaphore(),
  });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 601, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 602, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    capabilityTools: (context, deadline, capabilities) => [
      capability(media.createReadImageTool(context, capabilities, deadline), false),
    ],
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(agentFaux.state.callCount).toBe(3);
  expect(visionFaux.state.callCount).toBe(1);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  const presented = store.db
    .prepare<[], { tools_json: string | null }>(
      "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
    )
    .get();
  const toolsJson = presented?.tools_json ?? null;
  expect(toolsJson === null ? null : JSON.parse(toolsJson)).toEqual(['read', 'send', 'execute']);
  store.close();
});

test('nudges the model once to use send when it drafts a private reply and never re-nudges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-nudge-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
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

  // Turn 1: a short would-be reply drafted as private assistant text, no send
  // call — shorter drafts must nudge too (regression: a 40-char threshold used
  // to swallow them). Turn 2: after the nudge, the model still forgets send —
  // proving no re-nudge.
  let sawNudge = false;
  faux.setResponses([
    fauxAssistantMessage('short private reply'),
    (context) => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const content = lastUser?.content;
      const nudgeText = Array.isArray(content) ? (content.find((block) => block.type === 'text')?.text ?? '') : '';
      if (nudgeText.includes('call the send tool')) {
        sawNudge = true;
      }
      return fauxAssistantMessage('still no send');
    },
  ]);
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(sawNudge).toBe(true);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
      .get()?.count,
  ).toBe(1n);
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(0n);
  expect(faux.state.callCount).toBe(2);
  store.close();
});

test('does not nudge when the model ends without any draft text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-nudge-empty-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 5,
    message: {
      message_id: 11,
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

  // The model deliberately stays silent: no tool call and only blank drafts.
  faux.setResponses([fauxAssistantMessage('   ')]);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
      .get()?.count,
  ).toBe(0n);
  expect(faux.state.callCount).toBe(1);
  store.close();
});

test('a model that declares minimal tool-schema keywords is sent reduced tool definitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-tool-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider fixture');
      }
      const model = provider.models[0];
      if (model === undefined) {
        throw new Error('Expected an agent model fixture');
      }
      model.tool_schema_keywords = 'minimal';
      config.developer = { record_model_payloads: true };
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 6,
    message: {
      message_id: 12,
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

  let presented: { name: string; parameters: unknown }[] = [];
  faux.setResponses([
    (context, options) => {
      // The faux provider never touches the network, so the snapshot hooks are
      // triggered manually to mirror what real adapters do.
      options?.onPayload?.({ model: 'agent-model', messages: context.messages, tools: context.tools }, faux.getModel());
      void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
      presented = (context.tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters }));
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('private assistant text'),
  ]);
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });

  // What the provider was handed: the shape of every call survives, the
  // validation-only annotations a grammar endpoint rejects are gone.
  expect(presented.map((tool) => tool.name)).toEqual(['read', 'send', 'execute']);
  expect(JSON.stringify(presented)).not.toContain('minLength');
  expect(JSON.stringify(presented)).not.toContain('maxLength');
  expect(JSON.stringify(presented)).not.toContain('patternProperties');
  expect(presented.find((tool) => tool.name === 'read')?.parameters).toMatchObject({
    type: 'object',
    required: ['uri'],
    properties: { uri: { type: 'string' } },
  });

  // The audit records the reduced schema too: the registry hash is taken over the
  // definitions the model was handed.
  const registryRow = store.db
    .prepare<[bigint], { tool_registry_json: string | null }>('SELECT tool_registry_json FROM invocations WHERE id = ?')
    .get(invocationId);
  expect(registryRow?.tool_registry_json).toContain('"name":"read"');
  expect(registryRow?.tool_registry_json).not.toContain('minLength');
  const snapshot = store.db
    .prepare<[], { request_json: string | null }>(
      "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
    )
    .get();
  expect(snapshot?.request_json).not.toContain('minLength');
  store.close();
});

test.each([true, false])(
  'payload recording %s writes request/response only, never a replay snapshot',
  async (recordPayloads) => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-replay-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.developer = { record_model_payloads: recordPayloads };
        // One turn without a nudge: this test is about what a run records.
        config.agent.send_nudge_enabled = false;
      }),
    );
    const loaded = await loadConfig(configPath);
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const configStore = await testConfigStore(loaded, fauxRegistry(faux));
    const store = await SqliteStore.open(loaded.config);
    // The migrated schema no longer carries the retired replay snapshot column,
    // so no recording mode has a place to write one.
    const columns = store.db
      .prepare<[], { name: string }>('PRAGMA table_info(model_calls)')
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain('replay_input_json');

    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      {
        update_id: 7,
        message: {
          message_id: 13,
          date: 1_700_000_000,
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: 'hello',
        },
      },
      received,
    );
    const scheduler = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected a due invocation');
    }

    faux.setResponses([
      (context, options) => {
        // The faux provider never touches the network, so the audit hooks are
        // triggered manually to mirror what real adapters do.
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        return fauxAssistantMessage('private assistant text');
      },
    ]);
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      telegramApi: {
        sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
        sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
      },
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      systemResources: SystemResources.empty(),
    });
    const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });

    // Exactly one model call: no extra snapshot row, and nothing beyond the
    // opt-in request/response payload audit in either recording mode.
    const auditedCalls = store.orm.select().from(modelCalls).all();
    expect(auditedCalls).toHaveLength(1);
    const [call] = auditedCalls;
    expect(call?.state).toBe('success');
    expect(call?.finishedAt).not.toBeNull();
    if (recordPayloads) {
      expect(call?.requestJson).toContain('"messages"');
      expect(call?.responseJson).toBe('{"status":200}');
    } else {
      expect(call?.requestJson).toBeNull();
      expect(call?.responseJson).toBeNull();
    }
    store.close();
  },
);
