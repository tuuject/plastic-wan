import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter, imageSchema } from '@plasticwan/image-service';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createSendTool, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { agentActor, createImageBridge } from '../src/image/bridge.ts';
import { createImageService } from '../src/image/service.ts';
import { loadConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import imagePlugin from '../src/plugins/image/index.ts';
import type { ImagePluginBridge, InvocationScope } from '../src/plugins/plugin.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import {
  buckets,
  chats,
  conversations,
  invocations,
  media,
  messages,
  taskReceipts,
  telegramSends,
  toolCalls,
} from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from './helpers.ts';

// ---------------------------------------------------------------------------
// M4: the agent tool surface. image_generate submits through the bridge; when a
// generation settles, its outstanding long task completes and a receipt is
// delivered; the send tool delivers the pictures of a generation that belongs
// to the asking conversation — and only that one.
// ---------------------------------------------------------------------------

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-agent-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  // Stop workers before closing their borrowed database or removing its files.
  let failure: unknown;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
});

type ProviderCall = { headers: Record<string, string> };

type ImageAgentFixture = {
  store: SqliteStore;
  service: ReturnType<typeof createImageService>;
  bridge: ReturnType<typeof createImageBridge>;
  pluginBridge: ImagePluginBridge;
  tasks: LongTaskService;
  calls: ProviderCall[];
};

/** Provider sink with a scripted failure plan: index i fails when plan[i] is true. */
function providerSink(calls: ProviderCall[], plan: readonly boolean[] = []): typeof fetch {
  return async (_input, init) => {
    const call: ProviderCall = { headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) };
    calls.push(call);
    if (plan[calls.length - 1] === true) {
      return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 });
    }
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    return new Response(
      JSON.stringify({ created: 0, data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }] }),
      { status: 200 },
    );
  };
}

async function fixture(plan: readonly boolean[] = []): Promise<ImageAgentFixture> {
  const calls: ProviderCall[] = [];
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      (config as Record<string, unknown>).image = {
        credentials: { openrouter: { jar: 'openrouter' } },
        models: [
          {
            id: 'gpt-image-1',
            name: 'GPT Image 1',
            provider: 'openrouter',
            upstreamModel: 'openai/gpt-image-1',
            credentialRef: 'openrouter',
            providerTag: 'openai',
            capabilities: {
              imageInput: true,
              maxInputImages: 2,
              maxOutputs: 4,
              aspectRatios: ['auto', '1:1'],
              resolutionClasses: ['auto', 'high'],
            },
          },
        ],
      };
    }),
  );
  await writeTestKeyJar(directory, { openrouter: 'sk-image-v1' });
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({ fetchImpl: providerSink(calls, plan) }),
  });
  cleanup.push(() => service.stop());
  const tasks = new LongTaskService(store.orm, () => undefined);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => {
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
      })
        .png()
        .toBuffer();
      return { base64: png.toString('base64'), mime: 'image/png' };
    },
  });
  cleanup.push(() => bridge.stop());
  // Task rows reference real conversations; seed chat 100 / conversation 42
  // (and a second conversation 99 for the cross-conversation denial test).
  const now = new Date().toISOString();
  store.orm
    .insert(chats)
    .values({ id: 100n, telegramChatId: 100n, canonicalChatId: 100n, type: 'private', updatedAt: now })
    .run();
  store.orm.insert(conversations).values({ id: 42n, chatId: 100n, createdAt: now, updatedAt: now }).run();
  store.orm
    .insert(conversations)
    .values({ id: 99n, chatId: 100n, messageThreadId: 99n, createdAt: now, updatedAt: now })
    .run();
  store.orm
    .insert(buckets)
    .values({
      id: 1n,
      conversationId: 42n,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: now,
      deadlineAt: now,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
    })
    .run();
  store.orm
    .insert(invocations)
    .values({
      id: 7n,
      bucketId: 1n,
      conversationId: 42n,
      state: 'completed',
      configHash: 'test',
      promptVersion: 1n,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    })
    .run();
  const loadedForStore = await testConfigStore(loaded);
  const reloader = new ConfigReloader({
    loaded,
    store: loadedForStore,
    modelSwitcher: new AgentModelSwitcher(loadedForStore),
    secrets: new SecretStore(keyJarPath(configPath)),
    imageConfig: {
      prepare: (candidate) => service.prepareConfig(candidate, new SecretStore(keyJarPath(configPath))),
      publish: (snapshot) => service.publishConfig(snapshot as Parameters<typeof service.publishConfig>[0]),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  const pluginBridge: ImagePluginBridge = {
    enabled: () => bridge.enabled(),
    submit: (params, signal) => bridge.submit(params, signal),
    modelList: () => bridge.modelList(),
  };
  return { store, service, bridge, pluginBridge, tasks, calls };
}

function generationIdOf(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>).generation_id;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

async function waitFor<T>(check: () => T | null | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined) {
      return value as T;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function submitFixtureWork(
  fixtureRef: ImageAgentFixture,
  options: { conversationId?: bigint; prompt?: string; outputCount?: number } = {},
): Promise<string> {
  const result = await fixtureRef.bridge.submit({
    conversationId: options.conversationId ?? 42n,
    invocationId: null,
    toolCallId: 'call-1',
    authoredPrompt: options.prompt ?? 'a quiet harbor at dusk',
    modelId: undefined,
    aspectRatio: undefined,
    resolution: undefined,
    outputCount: options.outputCount,
    inputMediaIds: [],
    extendedData: undefined,
  });
  return result.generationId;
}

test('a settled generation completes its long task and records a receipt for the conversation', async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef);
  const db = drizzle(fixtureRef.store.db, { schema: imageSchema });
  await waitFor(() => {
    const row = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, generationId)).get();
    return row?.status === 'succeeded' ? row : null;
  });

  // The completion listener reconciles the outstanding task automatically.
  const scope = fixtureRef.tasks.scoped('image', 42n);
  await waitFor(() => {
    const task = scope.list().find((entry) => generationIdOf(entry.payload) === generationId);
    return task?.state === 'completed' ? task : null;
  });
  // The receipt carries the structured result the scheduler injects later.
  const receipts = fixtureRef.store.orm
    .select({ status: taskReceipts.status, resultJson: taskReceipts.resultJson })
    .from(taskReceipts)
    .all();
  expect(receipts.length).toBe(1);
  expect(String(receipts[0]?.resultJson)).toContain('generation_id');
});

test('send kind:image delivers finished outputs of a generation owned by this conversation', async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef);
  const db = drizzle(fixtureRef.store.db, { schema: imageSchema });
  await waitFor(() => {
    const row = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, generationId)).get();
    return row?.status === 'succeeded' ? true : null;
  });
  const outputs = fixtureRef.bridge.sendableOutputs(generationId, 42n);
  expect(outputs).toHaveLength(1);
  expect(fixtureRef.bridge.assetContent(outputs?.[0]?.asset_id ?? '')?.mime).toBe('image/png');

  const sent: { chatId: string; fileName: string }[] = [];
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 1, date: 0, chat: { id: 100 } }),
    sendSticker: async () => ({ message_id: 2, date: 0, chat: { id: 100 } }),
    sendGeneratedPhoto: async (chatId, _bytes, fileName) => {
      sent.push({ chatId, fileName });
      return {
        message_id: 500,
        date: 0,
        chat: { id: 100 },
        photo: [{ file_id: 'sent-photo-1', file_unique_id: 'uniq-1', width: 512, height: 512 }],
      };
    },
    sendGeneratedPhotoGroup: async (chatId, pictures) => {
      pictures.forEach((picture) => {
        sent.push({ chatId, fileName: picture.fileName });
      });
      return [
        {
          message_id: 500,
          date: 0,
          chat: { id: 100 },
          photo: [{ file_id: 'sent-photo-1', file_unique_id: 'uniq-1', width: 512, height: 512 }],
        },
      ];
    },
  };
  const send = createSendTool({
    store: fixtureRef.store,
    api,
    context: {
      invocationId: 7n,
      conversationId: 42n,
      chatId: 100n,
      threadId: 0n,
      systemPrompt: '',
      userPrompt: '',
      directImages: [],
      visibleSenders: new Map(),
      callerUserId: 1n,
      completion: null,
      omittedNewMessages: 0,
    } as Parameters<typeof createSendTool>[0]['context'],
    capabilities: {
      resolveMedia: () => undefined,
      resolveStickerRef: () => undefined,
      resolveReplyTarget: () => undefined,
      registerStickerRef: () => 'stk_x',
    },
    sendRateLimit: { sendsPerWindow: 10, windowSeconds: 60 },
    maxTextLength: 4096,
    disallowBlankLines: false,
    deadline: Date.now() + 60_000,
    bot: { id: 777n, displayName: 'bot', username: 'bot' },
    imageGeneration: {
      resolve: (id, conversationId) => {
        const out = fixtureRef.bridge.sendableOutputs(id, conversationId)?.map((output) => {
          const content = fixtureRef.bridge.assetContent(output.asset_id);
          return { assetId: output.asset_id, bytes: content.bytes, fileName: output.file_name };
        });
        return out;
      },
    },
  });
  const result = await send.execute?.(
    'call-send-1',
    { kind: 'image', image_generation_id: generationId, text: '画好了' },
    new AbortController().signal,
  );
  expect(sent).toHaveLength(1);
  expect(result?.details.telegramMessageId).toBe('500');

  // Delivery is audited: kind image, the owning conversation, and a bot photo
  // media row so later rounds can reference the delivered picture.
  const db2 = drizzle(fixtureRef.store.db, { schema: imageSchema });
  const sendRow = db2.select().from(telegramSends).where(eq(telegramSends.kind, 'image')).get();
  expect(sendRow?.state).toBe('success');
  const messageRow = fixtureRef.store.orm.select().from(messages).where(eq(messages.sentByBot, true)).get();
  expect(messageRow).toBeDefined();
  const mediaRow = fixtureRef.store.orm.select().from(media).where(eq(media.kind, 'photo')).get();
  expect(mediaRow).toBeDefined();

  // A later output whose file disappeared must not be silently omitted, making
  // the already-delivered first picture look like the whole generation.
  const missing = await fixtureRef.service.core.images.create({
    name: 'later-output',
    base64: (
      await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer()
    ).toString('base64'),
    mime: 'image/png',
    description: '',
    category: '',
    source: 'generation',
    generationId,
    outputIndex: 1,
  });
  const missingRow = db.select().from(imageSchema.images).where(eq(imageSchema.images.id, missing.id)).get();
  if (missingRow === undefined) {
    throw new Error('Expected stored output');
  }
  await rm(join(fixtureRef.service.imageDir, missingRow.fileName));
  expect(fixtureRef.bridge.sendableOutputs(generationId, 42n)).toHaveLength(2);
  await expect(send.execute('call-send-missing', { kind: 'image', image_generation_id: generationId })).rejects.toThrow(
    'image_generation_unavailable',
  );
  expect(sent).toHaveLength(1);
  expect(fixtureRef.store.orm.select().from(telegramSends).all()).toHaveLength(1);
  expect(
    fixtureRef.store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'call-send-missing')).get(),
  ).toMatchObject({
    state: 'error',
    errorCode: 'image_generation_unavailable',
  });
  expect(fixtureRef.store.orm.select({ sendsUsed: invocations.sendsUsed }).from(invocations).get()).toEqual({
    sendsUsed: 1n,
  });
});

test("a foreign conversation cannot deliver another conversation's generation", async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef, { conversationId: 42n });
  await waitFor(() => {
    const row = drizzle(fixtureRef.store.db, { schema: imageSchema })
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, generationId))
      .get();
    return row?.status === 'succeeded' ? true : null;
  });
  expect(fixtureRef.bridge.sendableOutputs(generationId, 99n)).toBeUndefined();
  expect(fixtureRef.bridge.sendableOutputs(generationId, 42n)).not.toBeUndefined();
});

test('a failed generation still completes the task with an error receipt', async () => {
  const fixtureRef = await fixture([true]);
  const generationId = await submitFixtureWork(fixtureRef);
  await waitFor(() => {
    const row = drizzle(fixtureRef.store.db, { schema: imageSchema })
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, generationId))
      .get();
    return row !== undefined && ['failed', 'interrupted'].includes(row.status) ? true : null;
  });
  const scope = fixtureRef.tasks.scoped('image', 42n);
  await waitFor(() => {
    const task = scope.list().find((entry) => generationIdOf(entry.payload) === generationId);
    return task?.state === 'completed' || task?.state === 'failed' ? task?.state : null;
  });
  // The receipt carries the failure either way; no silent waiting.
});

test('reconcile() settles outstanding image tasks after a restart', async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef, { conversationId: 42n });
  await waitFor(() => {
    const row = drizzle(fixtureRef.store.db, { schema: imageSchema })
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, generationId))
      .get();
    return row?.status === 'succeeded' ? true : null;
  });
  // Simulate a restart gap: detach the finished listener, rewire a fresh bridge
  // over the same store, and reconcile — the waiting task must complete.
  const secondBridge = createImageBridge({
    service: fixtureRef.service,
    store: fixtureRef.store,
    tasks: fixtureRef.tasks,
    prepareInputImage: async () => ({ base64: '', mime: 'image/png' }),
  });
  secondBridge.reconcile();
  const scope = fixtureRef.tasks.scoped('image', 42n);
  await waitFor(() => {
    const task = scope.list().find((entry) => generationIdOf(entry.payload) === generationId);
    return task?.state === 'completed' ? task : null;
  });
  secondBridge.stop();
});

test('the plugin contributes image_generate only when the bridge is enabled', () => {
  const disabledScope = fakeScope({
    enabled: () => false,
    submit: () => Promise.reject(new Error('no')),
    modelList: () => [],
  });
  expect(imagePlugin.capabilities?.(disabledScope) ?? []).toHaveLength(0);

  const enabledScope = fakeScope({
    enabled: () => true,
    submit: () => Promise.reject(new Error('no')),
    modelList: () => [{ id: 'm', name: 'M' }],
  });
  const enabled = imagePlugin.capabilities?.(enabledScope) ?? [];
  expect(enabled.map((entry) => entry.tool.name)).toEqual(['image_generate']);
  expect(enabled.map((entry) => entry.sideEffect)).toEqual([true]);
});

test('unauthorized input media references are rejected before any submission', async () => {
  const fixtureRef = await fixture();
  const scope = fakeScope(fixtureRef.pluginBridge, () => undefined);
  const [imageTool] = imagePlugin.capabilities?.(scope) ?? [];
  expect(imageTool).toBeDefined();
  await expect(
    imageTool?.tool.execute?.(
      'call-x',
      { prompt: 'p', input_image_refs: ['img_foreign'] },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/not authorized/);
});

test('input media references become intent-level input images', async () => {
  const fixtureRef = await fixture();
  const calls: string[] = [];
  const submitted: { inputMediaIds: bigint[] }[] = [];
  const probingBridge: ImagePluginBridge = {
    ...fixtureRef.pluginBridge,
    submit: async (params) => {
      calls.push('submit');
      submitted.push({ inputMediaIds: [...params.inputMediaIds] });
      return { generationId: 'g', replayed: false, modelId: 'gpt-image-1', outputCount: 1 };
    },
  };
  const [probedTool] =
    imagePlugin.capabilities?.(fakeScope(probingBridge, (ref) => (ref === 'img_ok' ? 5n : undefined))) ?? [];
  await probedTool?.tool.execute?.(
    'call-refs',
    { prompt: 'p', input_image_refs: ['img_ok'] },
    new AbortController().signal,
  );
  expect(calls).toEqual(['submit']);
  expect(submitted[0]?.inputMediaIds).toEqual([5n]);
});

function fakeScope(
  bridge: ImagePluginBridge,
  resolveMedia: (ref: string) => bigint | undefined = () => undefined,
): InvocationScope {
  return {
    config: {} as InvocationScope['config'],
    context: {
      invocationId: 7n,
      conversationId: 42n,
      chatId: 100n,
      threadId: 0n,
      systemPrompt: '',
      userPrompt: '',
      directImages: [],
      visibleSenders: new Map(),
      callerUserId: 1n,
      completion: null,
      omittedNewMessages: 0,
    },
    deadline: Date.now() + 60_000,
    audit: {
      start: () => ({ succeed: () => undefined, fail: () => undefined }),
      reject: () => undefined,
    },
    tasks: new LongTaskService({} as never),
    resolveMedia,
    image: bridge,
  } as unknown as InvocationScope;
}

test('agent actor ids bind generations to their conversation', () => {
  const actor = agentActor(42n);
  expect(actor.id).toBe('agent:42');
  expect(actor.privileged).toBe(true);
  expect(actor.source).toBe('agent');
});
