import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GenerationActor,
  type GenerationInput,
  generationCreateSchema,
  imageSchema,
  type ModelDefinition,
} from '@plasticwan/image-service';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createImageService, type ImageService } from '../src/image/service.ts';
import { loadConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

// ---------------------------------------------------------------------------
// M3: the image configuration rides the host hot-reload. A reload prepares the
// candidate snapshot (resolving SecretRefs per apply), publishes it atomically
// with the configuration, and keeps the old snapshot when preparation fails.
// ---------------------------------------------------------------------------

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-reload-'));
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

const imageModels = (overrides: Partial<ModelDefinition> = {}): ModelDefinition[] => [
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
    ...overrides,
  },
];

type ProviderCall = { headers: Record<string, string>; resolve?: () => void };

function fakeProviderImageSink(calls: ProviderCall[]): typeof fetch {
  return async (_input, init) => {
    const call: ProviderCall = { headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) };
    calls.push(call);
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    return new Response(
      JSON.stringify({
        created: 0,
        data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }],
        usage: { total_tokens: 42, cost: 0.01 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `req-${calls.length}` } },
    );
  };
}

const adminActor: GenerationActor = { id: 'admin:admin', name: 'admin', source: 'admin', scopes: [], privileged: true };

function parseInput(payload: Partial<GenerationInput> & { authoredPrompt: string }): GenerationInput {
  return generationCreateSchema.parse({ modelId: 'gpt-image-1', outputCount: 1, ...payload });
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) {
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

async function rotateJarEntry(configPath: string, name: string, value: string): Promise<void> {
  const jarPath = keyJarPath(configPath);
  const jar = JSON.parse(await readFile(jarPath, 'utf8')) as Record<string, string>;
  jar[name] = value;
  await writeFile(jarPath, `${JSON.stringify(jar, null, 2)}\n`, { mode: 0o600 });
  await chmod(jarPath, 0o600);
}

async function rewriteImageSection(
  configPath: string,
  image: { credentials: Record<string, unknown>; models: ModelDefinition[] } | undefined,
): Promise<void> {
  const { readConfigRevision, writeConfigEdits } = await import('../src/platform/config-file.ts');
  const revision = await readConfigRevision(configPath);
  const edits =
    image === undefined
      ? [{ path: ['image'], value: undefined }]
      : [
          { path: ['image', 'credentials'], value: image.credentials },
          { path: ['image', 'models'], value: image.models },
        ];
  await writeConfigEdits(configPath, edits, revision);
}

type Fixture = {
  store: SqliteStore;
  service: ImageService;
  reloader: ConfigReloader;
  configPath: string;
};

/** Store + image service + reloader with the image section in the config file. */
async function fixture(providerFetch: typeof fetch): Promise<Fixture> {
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.image = {
        credentials: { openrouter: { jar: 'openrouter' } },
        models: imageModels(),
      };
    }),
  );
  const { writeTestKeyJar } = await import('./helpers.ts');
  await writeTestKeyJar(directory, { openrouter: 'sk-image-v1' });
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const service = createImageService(store, loaded.config, {
    providerAdapter: (await import('@plasticwan/image-service')).createOpenRouterAdapter({ fetchImpl: providerFetch }),
  });
  cleanup.push(() => service.stop());
  const secrets = new SecretStore(keyJarPath(configPath));
  const configStore = await testConfigStore(loaded);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets,
    imageConfig: {
      prepare: (candidate) => service.prepareConfig(candidate, secrets),
      publish: (snapshot) => service.publishConfig(snapshot as Parameters<ImageService['publishConfig']>[0]),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  return { store, service, reloader, configPath };
}

async function waitForGenerationStatus(store: SqliteStore, id: string, status: string): Promise<void> {
  const db = drizzle(store.db, { schema: imageSchema });
  await waitFor(() =>
    db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, id)).get()?.status === status
      ? true
      : null,
  );
}

test('a valid image candidate publishes without a restart and queued work completes', async () => {
  const calls: ProviderCall[] = [];
  const { store, service, reloader } = await fixture(fakeProviderImageSink(calls));

  // No snapshot yet: current() would throw configUnavailable.
  expect(service.core.config.hasValidConfig()).toBe(false);
  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.current()?.models).toHaveLength(1);

  const { generation } = service.core.generations.create(parseInput({ authoredPrompt: '热加载' }), adminActor, 'hot');
  await waitForGenerationStatus(store, generation.id, 'succeeded');
  expect(calls[0]?.headers.authorization).toBe('Bearer sk-image-v1');
});

test('an invalid image candidate is rejected and the previously published snapshot stays', async () => {
  const { service, reloader, configPath } = await fixture(fakeProviderImageSink([]));
  const first = await reloader.reloadFromFile();
  expect(first.ok).toBe(true);
  expect(service.core.config.current()?.models).toHaveLength(1);

  // A model whose provider the adapter set does not know is rejected at prepare.
  await rewriteImageSection(configPath, {
    credentials: { openrouter: { jar: 'openrouter' } },
    // 'pixai' passes the file layer (free string) and must be rejected by the
    // package contract at prepare time.
    models: imageModels({ provider: 'pixai' as never }),
  });
  const second = await reloader.reloadFromFile();
  expect(second.ok).toBe(false);
  expect(second.ok ? null : second.code).toBe('config_invalid');
  expect(service.core.config.current()?.models[0]?.provider).toBe('openrouter');
});

test('a same-name SecretRef rotation is adopted on the next reload without a file change', async () => {
  const calls: ProviderCall[] = [];
  const { store, service, reloader, configPath } = await fixture(fakeProviderImageSink(calls));

  const first = await reloader.reloadFromFile();
  expect(first.ok).toBe(true);
  const { generation } = service.core.generations.create(parseInput({ authoredPrompt: '轮换' }), adminActor, 'rotate');
  await waitForGenerationStatus(store, generation.id, 'succeeded');
  expect(calls[0]?.headers.authorization).toBe('Bearer sk-image-v1');

  // Rotate the jar entry in place: the configuration file itself does not move.
  const fileBefore = await readFile(configPath, 'utf8');
  await rotateJarEntry(configPath, 'openrouter', 'sk-image-v2');
  expect(await readFile(configPath, 'utf8')).toBe(fileBefore);

  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);

  // A new round picks up the rotated credential.
  const { generation: second } = service.core.generations.create(
    parseInput({ authoredPrompt: '轮换二' }),
    adminActor,
    'rotate-2',
  );
  await waitForGenerationStatus(store, second.id, 'succeeded');
  expect(calls[1]?.headers.authorization).toBe('Bearer sk-image-v2');
});

test('a round keeps the credential it started with even when the snapshot is republished mid-flight', async () => {
  const calls: ProviderCall[] = [];
  const gates: Array<() => void> = [];
  const { store, service, reloader, configPath } = await fixture(async (_input, init) => {
    const call: ProviderCall = { headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) };
    calls.push(call);
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    return new Response(
      JSON.stringify({ created: 0, data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }] }),
      { status: 200 },
    );
  });

  const first = await reloader.reloadFromFile();
  expect(first.ok).toBe(true);
  const { generation } = service.core.generations.create(parseInput({ authoredPrompt: '固定' }), adminActor, 'pinned');
  await waitFor(() => (calls.length > 0 ? true : null));

  // Rotate the jar and republish while the provider call is still in flight.
  await rotateJarEntry(configPath, 'openrouter', 'sk-image-rotated');
  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.current()?.credentials.openrouter).toBe('sk-image-rotated');

  // The in-flight round still completes with the credential it started with.
  gates[0]?.();
  await waitForGenerationStatus(store, generation.id, 'succeeded');
  expect(calls[0]?.headers.authorization).toBe('Bearer sk-image-v1');
});

test('an unresolved SecretRef keeps the previous snapshot and reports secret_unresolved', async () => {
  const { service, reloader, configPath } = await fixture(fakeProviderImageSink([]));
  const first = await reloader.reloadFromFile();
  expect(first.ok).toBe(true);

  await rewriteImageSection(configPath, {
    credentials: { openrouter: { jar: 'does-not-exist' } },
    models: imageModels(),
  });
  const second = await reloader.reloadFromFile();
  expect(second.ok).toBe(false);
  expect(second.ok ? null : second.code).toBe('secret_unresolved');
  expect(service.core.config.current()?.models).toHaveLength(1);
});

test('concurrent applies are serialized and converge on the file state', async () => {
  const { reloader } = await fixture(fakeProviderImageSink([]));
  const [one, two] = await Promise.all([reloader.reloadFromFile(), reloader.reloadFromFile()]);
  expect(one.ok).toBe(true);
  expect(two.ok).toBe(true);
  // Serialized by the reloader lock: the second apply observes the first's
  // published state, so file hash and active hash converge instead of racing.
  expect(one.ok && two.ok ? two.status.activeHash : '').toBe(two.ok ? two.status.fileHash : '');
});

test('creating without a published snapshot fails loudly, then succeeds after the first publish', async () => {
  const calls: ProviderCall[] = [];
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.image = {
        credentials: { openrouter: { jar: 'openrouter' } },
        models: imageModels(),
      };
    }),
  );
  const { writeTestKeyJar } = await import('./helpers.ts');
  await writeTestKeyJar(directory, { openrouter: 'sk-image-v1' });
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  // The service starts with an empty snapshot; the first reload publishes.
  const service = createImageService(store, loaded.config, {
    providerAdapter: (await import('@plasticwan/image-service')).createOpenRouterAdapter({
      fetchImpl: fakeProviderImageSink(calls),
    }),
  });
  cleanup.push(() => service.stop());
  const secrets = new SecretStore(keyJarPath(configPath));
  const configStore = await testConfigStore(loaded);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets,
    imageConfig: {
      prepare: (candidate) => service.prepareConfig(candidate, secrets),
      publish: (snapshot) => service.publishConfig(snapshot as Parameters<ImageService['publishConfig']>[0]),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });

  expect(() =>
    service.core.generations.create(parseInput({ authoredPrompt: '排队' }), adminActor, 'queued-resume'),
  ).toThrow();

  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  const { generation } = service.core.generations.create(
    parseInput({ authoredPrompt: '排队' }),
    adminActor,
    'queued-resume',
  );
  await waitForGenerationStatus(store, generation.id, 'succeeded');
  expect(calls).toHaveLength(1);
});
