import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter } from '@plasticwan/image-service';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createImageBridge } from '../src/image/bridge.ts';
import { createImageService } from '../src/image/service.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from './helpers.ts';

// ---------------------------------------------------------------------------
// Regression: the image dispatch used `'bytes' in response` to detect the
// binary content record. Node 26 added a `bytes()` method to Response, so the
// flag matched every Response and the enable request's JSON answer was
// rebuilt as a binary record with an undefined content-type, which crashes
// @hono/node-server's writeHead (ERR_HTTP_INVALID_HEADER_VALUE). The dispatch
// must use the explicit `kind` discriminant; this test pins the panel-facing
// behavior through AdminServer.handle, below the HTTP layer.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct-horse-battery';
const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-admin-server-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  vi.restoreAllMocks();
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

interface Fixture {
  readonly server: AdminServer;
  readonly cookie: string;
  readonly configPath: string;
  revision(): Promise<string>;
}

async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
      config.providers['saved-router'] = {
        kind: 'builtin',
        provider: 'openrouter',
        api_key: { jar: 'agent' },
        models: config.providers.agent!.models,
      };
      transform?.(config);
    }),
  );
  await writeTestKeyJar(directory, {});
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({
      fetchImpl: async () =>
        new Response(JSON.stringify({ created: 0, data: [{ b64_json: 'AAAA', media_type: 'image/png' }] }), {
          status: 200,
        }),
    }),
  });
  cleanup.push(() => service.stop());
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
  const tasks = new LongTaskService(store.orm, () => undefined);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => ({ base64: '', mime: 'image/png' }),
  });
  cleanup.push(() => bridge.stop());
  const server = new AdminServer({
    store,
    configStore: storeForConfig,
    configReloader: reloader,
    secrets: new SecretStore(keyJarPath(configPath)),
    imageService: service,
    imageBridge: bridge,
  });
  const setup = await server.handle(
    new Request('http://admin.test/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ops', password: PASSWORD }),
    }),
  );
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(setup.status).toBe(200);
  return {
    server,
    cookie,
    configPath,
    revision: async () => {
      const res = await server.handle(new Request('http://admin.test/api/providers', { headers: { cookie } }));
      const body = (await res.json()) as { revision: string };
      return body.revision;
    },
  };
}

test('image config enable request answers JSON through the admin dispatch, not a rebuilt binary response', async () => {
  const app = await fixture();
  const models = [
    {
      id: 'gpt-image-1',
      name: 'GPT Image',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-image-1',
      credentialRef: 'openrouter',
      providerTag: 'openrouter',
      capabilities: {
        imageInput: true,
        maxInputImages: 4,
        maxOutputs: 4,
        aspectRatios: ['auto', '1:1'],
        resolutionClasses: ['auto', 'low', 'medium', 'high'],
      },
    },
  ];
  const res = await app.server.handle(
    new Request('http://admin.test/api/image/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: app.cookie, 'if-match': await app.revision() },
      body: JSON.stringify({ enabled: true, credentials: { openrouter: 'sk-or-test' }, models }),
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const body = (await res.json()) as { enabled: boolean; apply: { applied: readonly string[] } };
  expect(body.enabled).toBe(true);
  expect(body.apply.applied).toContain('image');

  // The section landed in the file with jar references, never plaintext.
  const file = await (await import('node:fs/promises')).readFile(app.configPath, 'utf8');
  expect(file).toContain('"image":');
  expect(file).toContain('"jar"');
  expect(file).toContain('"openrouter"');
  expect(file).not.toContain('sk-or-test');

  const view = await app.server.handle(
    new Request('http://admin.test/api/image/config', { headers: { cookie: app.cookie } }),
  );
  const config = (await view.json()) as { revision: string; credentials: string[]; models: typeof models };
  expect(config.credentials).toEqual(['openrouter']);
  expect(config.models).toEqual(models);
  expect(JSON.stringify(config)).not.toContain('sk-or-test');

  const update = await app.server.handle(
    new Request('http://admin.test/api/image/config', {
      method: 'PUT',
      headers: { cookie: app.cookie, 'if-match': config.revision },
      body: JSON.stringify({ enabled: true, credentials: {}, models: [{ ...models[0], name: 'Renamed' }] }),
    }),
  );
  expect(update.status).toBe(200);
  expect(((await update.json()) as { enabled: boolean }).enabled).toBe(true);
  expect((await loadConfig(app.configPath)).fileConfig.image?.credentials).toEqual({
    openrouter: { jar: 'openrouter' },
  });

  const beforeConflict = await readFile(app.configPath, 'utf8');
  const stale = await app.server.handle(
    new Request('http://admin.test/api/image/config', {
      method: 'PUT',
      headers: { cookie: app.cookie, 'if-match': config.revision },
      body: JSON.stringify({ enabled: false }),
    }),
  );
  expect(stale.status).toBe(409);
  expect(await readFile(app.configPath, 'utf8')).toBe(beforeConflict);
});

test('image settings discovery requires auth, supports disabled images and enforces config revision and Origin', async () => {
  const app = await fixture();
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      data: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2', architecture: { output_modalities: ['image'] } }],
    }),
  );
  const request = (path: string, headers: Record<string, string> = {}) =>
    app.server.handle(new Request(`http://admin.test/api/image/${path}`, { headers }));
  expect((await request('models')).status).toBe(401);
  expect((await request('config')).status).toBe(401);
  expect(spy).not.toHaveBeenCalled();
  const catalog = await request('models', { cookie: app.cookie });
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toEqual({ models: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2' }] });
  const config = await request('config', { cookie: app.cookie });
  expect(await config.json()).toMatchObject({ enabled: false, credentials: [], models: [] });
  expect((await request('models/endpoints?model=bad', { cookie: app.cookie })).status).toBe(400);
  spy.mockResolvedValueOnce(new Response('upstream details', { status: 503 }));
  const failure = await request('models', { cookie: app.cookie });
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain('upstream details');
  for (const [headers, status] of [
    [{ cookie: app.cookie }, 400],
    [{ cookie: app.cookie, 'if-match': await app.revision(), origin: 'http://other.test' }, 403],
  ] as const) {
    const response = await app.server.handle(
      new Request('http://admin.test/api/image/config', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(response.status).toBe(status);
  }
});

test('image content requests still stream the stored bytes with the asset mime', async () => {
  const app = await fixture();
  const created = await app.server.handle(
    new Request('http://admin.test/api/image/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie, origin: 'http://admin.test' },
      body: JSON.stringify({ name: 'anime', body: 'anime style illustration' }),
    }),
  );
  expect(created.status).toBe(201);
  const listing = await app.server.handle(
    new Request('http://admin.test/api/image/prompts', { headers: { cookie: app.cookie } }),
  );
  const body = (await listing.json()) as { items: readonly { id: string }[] };
  expect(body.items.length).toBe(1);
});

test('repairs missing image credentials with a saved OpenRouter reference and rejects invalid drafts before writing', async () => {
  const model = {
    id: 'legacy-image',
    name: 'Legacy Image',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
    capabilities: {
      imageInput: false,
      maxInputImages: 0,
      maxOutputs: 1,
      aspectRatios: ['auto'],
      resolutionClasses: ['auto'],
    },
  };
  const app = await fixture((config) => {
    config.image = { credentials: {}, models: [model, model] };
  });
  const view = await app.server.handle(
    new Request('http://admin.test/api/image/config', { headers: { cookie: app.cookie } }),
  );
  const projection = (await view.json()) as { credential_providers: string[]; credentials: string[] };
  expect(projection.credential_providers).toEqual(['saved-router']);
  expect(projection.credentials).toEqual([]);
  expect(JSON.stringify(projection)).not.toContain('agent-secret');
  expect(JSON.stringify(projection)).not.toContain('jar');
  const request = (body: unknown) =>
    app.server.handle(
      new Request('http://admin.test/api/image/config', {
        method: 'PUT',
        headers: { cookie: app.cookie, 'if-match': revision },
        body: JSON.stringify(body),
      }),
    );
  const revision = await app.revision();
  const before = await readFile(app.configPath, 'utf8');
  for (const body of [
    { enabled: true, credentials: {}, models: [model] },
    { enabled: true, credentials: {}, credential_sources: { openrouter: 'saved-router' }, models: [model, model] },
    { enabled: true, credentials: {}, credential_sources: { openrouter: 'agent' }, models: [model] },
    { enabled: true, credentials: {}, credential_sources: { openrouter: 123 }, models: [model] },
    { enabled: true, credentials: {}, credential_sources: { openrouter: 'toString' }, models: [model] },
  ]) {
    expect((await request(body)).status).toBe(400);
    expect(await readFile(app.configPath, 'utf8')).toBe(before);
  }
  const saved = await request({
    enabled: true,
    credentials: {},
    credential_sources: { openrouter: 'saved-router' },
    models: [model],
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    enabled: true,
    apply: { applied: ['image.credentials.openrouter', 'image.models'] },
  });
  const loaded = await loadConfig(app.configPath);
  expect(loaded.fileConfig.image?.credentials).toEqual({ openrouter: { jar: 'agent' } });
  expect(loaded.fileConfig.image?.models).toEqual([model]);
  const status = await app.server.handle(
    new Request('http://admin.test/api/image/status', { headers: { cookie: app.cookie } }),
  );
  expect(await status.json()).toMatchObject({ enabled: true, models: [{ id: 'legacy-image' }] });
  expect(await readFile(app.configPath, 'utf8')).not.toContain('agent-secret');
});
