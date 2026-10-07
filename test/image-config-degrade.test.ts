import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter, generationCreateSchema, type ImageConfigSnapshot } from '@plasticwan/image-service';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createImageService, type ImageService } from '../src/image/service.ts';
import { loadConfig } from '../src/platform/config.ts';
import { type ConfigEdit, readConfigRevision, writeConfigEdits } from '../src/platform/config-file.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from './helpers.ts';

// ---------------------------------------------------------------------------
// Graceful degradation: image generation is an optional capability. A missing
// image section (or a structurally invalid one, which loadConfig strips with a
// warning) starts the process with image generation disabled — never a crash.
// The admin panel can then enable or repair it at any time through the
// configuration write-and-apply path; no restart is involved.
// ---------------------------------------------------------------------------

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-degrade-'));
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

const validImage = {
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

type Fixture = {
  store: SqliteStore;
  service: ImageService;
  reloader: ConfigReloader;
  configPath: string;
};

async function fixture(imageSection: unknown): Promise<Fixture> {
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    (config as Record<string, unknown>).image = imageSection;
  });
  await writeTestConfig(directory, configPath, jsonc);
  await writeTestKeyJar(directory, { openrouter: 'sk-image-v1' });
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({
      fetchImpl: async () => {
        throw new Error('provider should not be called in this suite');
      },
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
      publish: (snapshot) => service.publishConfig(snapshot as ImageConfigSnapshot | undefined),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  return { store, service, reloader, configPath };
}

async function replaceImageSection(configPath: string, image: unknown, keys?: Record<string, string>): Promise<void> {
  const revision = await readConfigRevision(configPath);
  // `keys` mirrors what the admin panel must do when (re-)introducing secret
  // references: the plaintext entries travel with the edit, never in the file.
  const edit: ConfigEdit =
    keys === undefined ? { path: ['image'], value: image as never } : { path: ['image'], value: image as never, keys };
  await writeConfigEdits(configPath, [edit], revision);
}

test('a configuration without an image section starts with image generation disabled', async () => {
  const { service, reloader } = await fixture(undefined);
  expect(service.core.config.hasValidConfig()).toBe(false);
  expect(() =>
    service.core.generations.create(
      generationCreateSchema.parse({ modelId: 'gpt-image-1', authoredPrompt: 'x', outputCount: 1 }),
      { id: 'admin:admin', name: 'admin', source: 'admin', scopes: [], privileged: true },
      'nobody',
    ),
  ).toThrow();

  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  // Still disabled: the file carries no image section.
  expect(service.core.config.hasValidConfig()).toBe(false);
});

test('a structurally invalid image section is stripped with a warning and the process starts anyway', async () => {
  const broken = {
    credentials: { openrouter: 'not-a-secret-ref' },
    models: [{ id: 'gpt-image-1' }],
  };
  const { service, reloader } = await fixture(broken);

  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.hasValidConfig()).toBe(false);
});

test.each(['', '中'.repeat(1000)])('accepts empty and maximum-length model notes', async (description) => {
  const { service, reloader } = await fixture({
    ...validImage,
    models: [{ ...validImage.models[0], description }],
  });
  expect((await reloader.reloadFromFile()).ok).toBe(true);
  expect(service.core.config.publicModels()[0]?.description).toBe(description);
});

test.each([{ description: 'x'.repeat(1001) }, { description: 42 }, { description: null }, { notes: 'unknown' }])(
  'invalid model notes disable only the image section',
  async (extra) => {
    const { service, reloader, configPath } = await fixture({
      ...validImage,
      models: [{ ...validImage.models[0], ...extra }],
    });
    const loaded = await loadConfig(configPath);
    expect(loaded.config.image).toBeUndefined();
    expect(loaded.warnings.length).toBeGreaterThan(0);
    expect((await reloader.reloadFromFile()).ok).toBe(true);
    expect(service.core.config.hasValidConfig()).toBe(false);
  },
);

test('repairing the stripped section through the config write path enables generation without a restart', async () => {
  const broken = { credentials: {}, models: 'oops' };
  const { service, reloader, configPath } = await fixture(broken);
  expect(service.core.config.hasValidConfig()).toBe(false);

  // The admin panel writes a valid section and applies it (same mechanism as
  // the chats/developer endpoints: writeConfigEdits + writeAndApply).
  await replaceImageSection(configPath, validImage);
  const applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.hasValidConfig()).toBe(true);
});

test('removing a valid section disables generation again, and it can be re-enabled', async () => {
  const { service, reloader, configPath } = await fixture(validImage);
  let applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.hasValidConfig()).toBe(true);

  await replaceImageSection(configPath, undefined);
  applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.hasValidConfig()).toBe(false);

  // Re-enabling must bring the secret back: removing the section garbage-collects
  // the now-unreferenced jar entry, so the panel sends the credential with the
  // edit (plaintext into the jar, a reference into the file).
  await replaceImageSection(configPath, validImage, { openrouter: 'sk-image-v1' });
  applied = await reloader.reloadFromFile();
  expect(applied.ok).toBe(true);
  expect(service.core.config.hasValidConfig()).toBe(true);
});
