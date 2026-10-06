import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter, imageSchema } from '@plasticwan/image-service';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createImageBridge } from '../src/image/bridge.ts';
import { createImageService } from '../src/image/service.ts';
import { adminActor, createImageAdminHandler, type ImageAdminResponse } from '../src/ingress/admin/image-admin.ts';
import { loadConfig } from '../src/platform/config.ts';
import { readConfigRevision, writeConfigEdits } from '../src/platform/config-file.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { chats, conversations } from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from './helpers.ts';

// ---------------------------------------------------------------------------
// M5: the Admin panel's image API — asset management, resolve preview,
// submissions with an admin actor, generation audit, and the enable/disable
// switch that writes the image section through the config edit path.
// ---------------------------------------------------------------------------

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-admin-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  // Teardown runs LIFO: fixture resources (worker, connection) release before the
  // temp directory is removed. Deleting first would fail with EBUSY on Windows
  // while SQLite still holds the database file. Every step still runs when an
  // earlier one fails, and the first failure is rethrown.
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

async function fixture(): Promise<{
  handle: ReturnType<typeof createImageAdminHandler>;
  applyImageConfig: (body: Record<string, unknown>) => Promise<ImageAdminResponse>;
  configPath: string;
  store: SqliteStore;
}> {
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, () => undefined),
  );
  await writeTestKeyJar(directory, {});
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const now = new Date().toISOString();
  store.orm
    .insert(chats)
    .values({ id: 100n, telegramChatId: 100n, canonicalChatId: 100n, type: 'private', updatedAt: now })
    .run();
  store.orm.insert(conversations).values({ id: 42n, chatId: 100n, createdAt: now, updatedAt: now }).run();
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({
      fetchImpl: async () => {
        const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
          .png()
          .toBuffer();
        return new Response(
          JSON.stringify({ created: 0, data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }] }),
          { status: 200 },
        );
      },
    }),
  });
  cleanup.push(() => service.stop());
  const tasks = new LongTaskService(store.orm, () => undefined);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => ({ base64: '', mime: 'image/png' }),
  });
  cleanup.push(() => bridge.stop());
  const storeForConfig = await testConfigStore(loaded);
  const reloader = new ConfigReloader({
    loaded,
    store: storeForConfig,
    modelSwitcher: new AgentModelSwitcher(storeForConfig),
    secrets: new SecretStore(keyJarPath(configPath)),
    imageConfig: {
      prepare: (candidate) => service.prepareConfig(candidate, new SecretStore(keyJarPath(configPath))),
      publish: (snapshot) => service.publishConfig(snapshot as Parameters<typeof service.publishConfig>[0]),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const secrets = new SecretStore(keyJarPath(configPath));
  const handle = createImageAdminHandler({ service, bridge });
  const applyImageConfig = async (body: Record<string, unknown>): Promise<ImageAdminResponse> => {
    const enabled = body.enabled;
    if (typeof enabled !== 'boolean') {
      return { kind: 'json', status: 400, body: { error: 'invalid_body' } };
    }
    const revision = await readConfigRevision(configPath);
    if (!enabled) {
      await writeConfigEdits(configPath, [{ path: ['image'], value: undefined }], revision);
    } else {
      const credentials = body.credentials as Record<string, string>;
      const models = body.models;
      const refs: Record<string, { jar: string }> = {};
      for (const [name, plaintext] of Object.entries(credentials)) {
        refs[name] = { jar: name };
        secrets.remember(plaintext);
      }
      await writeConfigEdits(
        configPath,
        [
          { path: ['image', 'credentials'], value: refs, keys: credentials },
          { path: ['image', 'models'], value: models },
        ],
        revision,
      );
    }
    const applied = await reloader.reloadFromFile();
    return { kind: 'json', status: 200, body: { enabled: bridge.enabled(), applied: applied.ok } };
  };
  return { handle, applyImageConfig, configPath, store };
}

function url(path: string): URL {
  return new URL(`http://admin.local/api/${path}`);
}

function segmentsOf(path: string): readonly string[] {
  const withoutQuery = path.split('?')[0] ?? path;
  return withoutQuery.split('/').filter((segment) => segment.length > 0);
}

async function call(
  fixtureRef: Awaited<ReturnType<typeof fixture>>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; bytes?: Uint8Array }> {
  const request = new Request(url(path), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await fixtureRef.handle(
    request,
    segmentsOf(path),
    url(path),
    { username: 'ops' },
    (maxBytes) => readBody(request, maxBytes),
    fixtureRef.applyImageConfig,
  );
  if (response.kind === 'content') {
    return { status: response.status, body: null, bytes: response.bytes };
  }
  return { status: response.status, body: response.body };
}

async function readBody(request: Request, maxBytes?: number): Promise<Record<string, unknown>> {
  void maxBytes;
  return (await request.json()) as Record<string, unknown>;
}

test('status reports disabled until the section is written, then enabled', async () => {
  const fixtureRef = await fixture();
  const before = await call(fixtureRef, 'GET', 'image/status');
  expect(before.body).toEqual({ enabled: false, models: [] });

  const enable = await fixtureRef.applyImageConfig({
    enabled: true,
    credentials: { openrouter: 'sk-live-1' },
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
  });
  expect(enable.kind === 'json' && enable.body).toEqual({ enabled: true, applied: true });

  // The file keeps only the SecretRef name; the plaintext lands in the jar.
  const file = await readFile(fixtureRef.configPath, 'utf8');
  expect(file).toContain('"jar": "openrouter"');
  expect(file).not.toContain('sk-live-1');
  const jar = JSON.parse(await readFile(keyJarPath(fixtureRef.configPath), 'utf8')) as Record<string, string>;
  expect(jar.openrouter).toBe('sk-live-1');

  const after = await call(fixtureRef, 'GET', 'image/status');
  expect((after.body as { enabled: boolean }).enabled).toBe(true);
});

test('disabling removes the section, garbage-collects the jar entry, and republishes empty', async () => {
  const fixtureRef = await fixture();
  await fixtureRef.applyImageConfig({
    enabled: true,
    credentials: { openrouter: 'sk-live-1' },
    models: [
      {
        id: 'm1',
        name: 'M1',
        provider: 'openrouter',
        upstreamModel: 'openai/gpt-image-1',
        credentialRef: 'openrouter',
        providerTag: 'openai',
        capabilities: {
          imageInput: false,
          maxInputImages: 0,
          maxOutputs: 4,
          aspectRatios: ['auto'],
          resolutionClasses: ['auto'],
        },
      },
    ],
  });
  const disable = await fixtureRef.applyImageConfig({ enabled: false });
  expect(disable.kind === 'json' && disable.body).toEqual({ enabled: false, applied: true });
  const file = await readFile(fixtureRef.configPath, 'utf8');
  expect(file).not.toContain('"image":');
  const jar = JSON.parse(await readFile(keyJarPath(fixtureRef.configPath), 'utf8')) as Record<string, string>;
  expect(jar.openrouter).toBeUndefined();
});

test('asset CRUD and binary content round-trip through the handler', async () => {
  const fixtureRef = await fixture();
  const created = await call(fixtureRef, 'POST', 'image/prompts', {
    name: '水彩风格',
    body: '柔和的水彩画风，高留白',
    category: 'style',
  });
  expect(created.status).toBe(201);
  const promptId = (created.body as { id: string }).id;

  const listed = await call(fixtureRef, 'GET', 'image/prompts?q=水彩');
  expect((listed.body as { items: { id: string }[] }).items.map((item) => item.id)).toContain(promptId);

  const updated = await call(fixtureRef, 'PUT', `image/prompts/${promptId}`, { description: '柔和' });
  expect((updated.body as { description: string }).description).toBe('柔和');

  const png = await sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 2, g: 4, b: 6 } } })
    .png()
    .toBuffer();
  const uploaded = await call(fixtureRef, 'POST', 'image/images', {
    name: '参考图',
    base64: png.toString('base64'),
    mime: 'image/png',
  });
  expect(uploaded.status).toBe(201);
  const assetId = (uploaded.body as { id: string }).id;

  const content = await call(fixtureRef, 'GET', `image/images/${assetId}/content`);
  expect(content.status).toBe(200);
  expect(content.bytes?.length).toBeGreaterThan(0);

  const archived = await call(fixtureRef, 'DELETE', `image/prompts/${promptId}`);
  expect(archived.body).toEqual({ status: 'archived' });
  const gone = await call(fixtureRef, 'GET', `image/prompts/${promptId}`);
  expect(gone.status).toBe(404);
});

test('admin submissions run under an admin actor and appear in the audit list', async () => {
  const fixtureRef = await fixture();
  await fixtureRef.applyImageConfig({
    enabled: true,
    credentials: { openrouter: 'sk-live-1' },
    models: [
      {
        id: 'm1',
        name: 'M1',
        provider: 'openrouter',
        upstreamModel: 'openai/gpt-image-1',
        credentialRef: 'openrouter',
        providerTag: 'openai',
        capabilities: {
          imageInput: false,
          maxInputImages: 0,
          maxOutputs: 4,
          aspectRatios: ['auto'],
          resolutionClasses: ['auto'],
        },
      },
    ],
  });

  const submitted = await call(fixtureRef, 'POST', 'image/generations', {
    prompt: 'a lighthouse',
    model_id: 'm1',
    idempotency_key: 'ops-1',
  });
  expect([200, 201]).toContain(submitted.status);
  const generationId = (submitted.body as { generation: { id: string } }).generation.id;

  // Same key replays instead of re-billing.
  const replay = await call(fixtureRef, 'POST', 'image/generations', {
    prompt: 'a lighthouse',
    model_id: 'm1',
    idempotency_key: 'ops-1',
  });
  expect((replay.body as { replayed: boolean }).replayed).toBe(true);

  const detail = await call(fixtureRef, 'GET', `image/generations/${generationId}`);
  const record = detail.body as { source: string; actorName: string; outputs: { id: string }[] };
  expect(record.source).toBe('admin');
  expect(record.actorName).toBe('ops');

  const db = drizzle(fixtureRef.store.db, { schema: imageSchema });
  const deadline = Date.now() + 8000;
  for (;;) {
    const row = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, generationId)).get();
    if (row?.status === 'succeeded') {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error('generation did not finish');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  const list = await call(fixtureRef, 'GET', 'image/generations');
  const ids = (list.body as { items: { id: string }[] }).items.map((item) => item.id);
  expect(ids).toContain(generationId);

  // Bind the actor identity for audit display.
  expect(adminActor('ops').id).toBe('admin:ops');
});
