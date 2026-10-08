import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { type FileConfig, type LoadedConfig, loadConfig, type ModelFileConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { loadModelsDevCatalog, resetModelsDevCatalogCache } from '../src/platform/models-dev.ts';
import { buildModelRegistry } from '../src/platform/providers.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { modelCalls } from '../src/store/schema.ts';
import {
  startFixtureServer,
  stopFixtureServer,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  writeTestKeyJar,
} from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

/**
 * The catalog is a whole-catalog download, so the tests seed the module cache
 * with a fixture instead of reaching models.dev. A test that needs the catalog
 * to fail resets the cache and stubs `fetch` for that URL only.
 */
async function seedModelsDevCatalog(): Promise<void> {
  resetModelsDevCatalogCache();
  const fetchImpl = (async () =>
    Response.json({
      openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            reasoning: true,
            interleaved: { field: 'reasoning_content' },
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 1_048_576, output: 384_000 },
            cost: { input: 0.03612, output: 0.07224, cache_read: 0.007224 },
          },
        },
      },
    })) as unknown as typeof fetch;
  await loadModelsDevCatalog({ fetchImpl, ttlMs: 600_000 });
}

beforeAll(async () => {
  await seedModelsDevCatalog();
});

afterEach(async () => {
  delete process.env.PLASTICWAN_SUPERVISED;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly configPath: string;
  readonly directory: string;
  readonly cookie: string;
  readonly restarts: () => number;
  read(): Promise<string>;
  file(): FileConfig;
  /** The plaintext `key.json` holds for a `{ jar }` SecretRef read from the file. */
  secret(reference: unknown): string | undefined;
  jarNames(): string[];
}

interface FixtureOptions {
  readonly transform?: (config: FileConfig) => void;
  readonly onRestart?: () => void;
}

async function adminFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-providers-'));
  directories.push(directory);
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
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.headers = { 'x-route': { jar: 'header' } };
      }
      options.transform?.(config);
    }),
  );
  await writeTestKeyJar(directory, { header: 'header-secret-value', builtin: 'builtin-secret' });
  const loaded = await loadConfig(configPath);
  // Kept so the restart test can restore a loadable file after breaking it.
  await writeFile(join(directory, 'original.jsonc'), await readFile(configPath, 'utf8'));
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keyJarPath(configPath));
  const registry = await buildModelRegistry(loaded.config, null, secrets);
  const configStore = await testConfigStore(loaded, registry);
  const switcher = new AgentModelSwitcher(configStore);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  let restarts = 0;
  const server = new AdminServer({
    store,
    configStore,
    modelSwitcher: switcher,
    configReloader: reloader,
    secrets,
    requestRestart: () => {
      restarts += 1;
      options.onRestart?.();
    },
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    }),
  );
  const cookie = sessionCookie(setup);
  return {
    store,
    server,
    loaded,
    configStore,
    configPath,
    directory,
    cookie,
    restarts: () => restarts,
    read: () => readFile(configPath, 'utf8'),
    file: () => JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig,
    secret: (reference) => {
      const name = (reference as { jar?: unknown } | undefined)?.jar;
      return typeof name === 'string' ? readJar(directory)[name] : undefined;
    },
    jarNames: () => Object.keys(readJar(directory)).sort(),
  };
}

function readJar(directory: string): Record<string, string> {
  return JSON.parse(readFileSync(join(directory, 'key.json'), 'utf8')) as Record<string, string>;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

// The provider payloads are asserted structurally, so a loose type keeps the
// assertions readable.
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function model(id: string, overrides: Partial<ModelFileConfig> = {}): ModelFileConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    ...overrides,
  };
}

async function revisionOf(fixture: Fixture): Promise<string> {
  const view = await readJson(await call(fixture, '/api/providers'));
  return view.revision as string;
}

function call(fixture: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return fixture.server.handle(request(path, { ...init, headers: { ...init.headers, cookie: fixture.cookie } }));
}

function write(
  fixture: Fixture,
  path: string,
  method: string,
  body: unknown,
  revision: string | null = null,
): Promise<Response> {
  return call(fixture, path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(revision === null ? {} : { 'if-match': revision }),
    },
    body: JSON.stringify(body),
  });
}

/** Edits the file behind the panel's back, as a hand edit would. */
async function rewriteFile(fixture: Fixture, transform: (config: FileConfig) => void): Promise<void> {
  const config = JSON.parse(await fixture.read()) as FileConfig;
  transform(config);
  await writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

test('lists providers without leaking keys or header values', async () => {
  const fixture = await adminFixture();
  try {
    const response = await call(fixture, '/api/providers');
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const view = await readJson(response);
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(view.supervised).toBe(false);
    expect(view.agent).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'low' });
    expect(view.vision).toEqual({ provider: 'vision', model: 'vision-model' });
    expect(view.restart_required).toEqual([]);
    const agent = view.providers.find((entry: any) => entry.alias === 'agent');
    expect(agent).toMatchObject({ kind: 'custom', api: 'openai-responses', base_url: 'https://example.test/v1' });
    expect(agent.header_names).toEqual(['x-route']);
    expect(agent.models).toHaveLength(1);
    expect(agent.models[0]).toMatchObject({ id: 'agent-model', compat: { supports_developer_role: false } });

    // The whole response body, not just the fields under test.
    expect(text).not.toContain('agent-secret');
    expect(text).not.toContain('header-secret-value');
    expect(text).not.toContain('vision-secret');
  } finally {
    fixture.store.close();
  }
});

test('offers the builtin presets the configuration may reference', async () => {
  const fixture = await adminFixture();
  try {
    const view = await readJson(await call(fixture, '/api/provider-presets'));
    const ids = view.presets.map((preset: any) => preset.id);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('google');
    // Rejected by the preset predicate: mixed APIs, an unsupported adapter, or
    // no concrete base URL.
    expect(ids).not.toContain('xai');
    expect(ids).not.toContain('mistral');
    expect(ids).not.toContain('google-vertex');
    const openrouter = view.presets.find((preset: any) => preset.id === 'openrouter');
    expect(openrouter).toMatchObject({
      api: 'openai-completions',
      base_url: 'https://openrouter.ai/api/v1',
    });
  } finally {
    fixture.store.close();
  }
});

test('requires a revision for every provider write', async () => {
  const fixture = await adminFixture();
  try {
    const missing = await write(fixture, '/api/providers', 'POST', { alias: 'relay' });
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'revision_required' });

    const stale = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        api_key: 'relay-secret',
        models: [model('relay-model')],
      },
      'f'.repeat(64),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });
    expect(fixture.file().providers.relay).toBeUndefined();

    const modelPut = await call(fixture, '/api/model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'vision', model: 'vision-model' }),
    });
    expect(modelPut.status).toBe(400);
    expect(await readJson(modelPut)).toMatchObject({ error: 'revision_required' });
  } finally {
    fixture.store.close();
  }
});

test('creates, updates, and deletes a provider through the configuration file', async () => {
  const fixture = await adminFixture();
  try {
    const created = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1/',
        api: 'openai-completions',
        api_key: 'relay-secret',
        headers: { 'x-route': 'relay-header' },
        models: [model('relay-model', { input: ['text', 'image'] })],
      },
      await revisionOf(fixture),
    );
    expect(created.status).toBe(200);
    const createdView = await readJson(created);
    expect(createdView.apply).toMatchObject({ applied: ['providers.relay'], restart_required: [] });
    const relay = createdView.providers.find((entry: any) => entry.alias === 'relay');
    expect(relay).toMatchObject({
      kind: 'custom',
      api: 'openai-completions',
      base_url: 'https://relay.example.test/v1',
      header_names: ['x-route'],
    });
    // Plaintext goes into key.json; the config file only names the entries, and
    // neither is echoed back.
    const text = await fixture.read();
    expect(text).not.toContain('relay-secret');
    expect(text).not.toContain('relay-header');
    const createdRelay = fixture.file().providers.relay;
    expect(createdRelay?.api_key).toEqual({ jar: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(fixture.secret(createdRelay?.api_key)).toBe('relay-secret');
    expect(createdRelay?.kind === 'custom' && fixture.secret(createdRelay.headers?.['x-route'])).toBe('relay-header');
    expect(JSON.stringify(createdView)).not.toContain('relay-secret');
    expect(JSON.stringify(createdView)).not.toContain('relay-header');
    expect(JSON.stringify(createdView)).not.toContain(JSON.stringify(createdRelay?.api_key));

    const duplicate = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        api_key: 'other',
        models: [model('relay-model')],
      },
      await revisionOf(fixture),
    );
    expect(duplicate.status).toBe(409);
    expect(await readJson(duplicate)).toMatchObject({ error: 'provider_exists' });

    // Changing the address forces the credentials to be re-entered (C5).
    const withoutKey = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      { base_url: 'https://attacker.example.test/v1' },
      await revisionOf(fixture),
    );
    expect(withoutKey.status).toBe(400);
    expect(await readJson(withoutKey)).toMatchObject({ error: 'credentials_required' });
    expect(fixture.file().providers.relay).toMatchObject({ base_url: 'https://relay.example.test/v1' });

    const withKey = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      {
        base_url: 'https://relay.example.test/v2',
        api_key: 'relay-secret-2',
        headers: { 'x-route': 'relay-header-2' },
      },
      await revisionOf(fixture),
    );
    expect(withKey.status).toBe(200);
    // The connection change is hot: the same reload adopts the new address, key
    // and headers, and the registry serves them from now on.
    const withKeyView = await readJson(withKey);
    expect(withKeyView.apply).toMatchObject({
      applied: ['providers.relay.api_key.jar', 'providers.relay.base_url', 'providers.relay.headers.x-route.jar'],
      restart_required: [],
    });
    expect(fixture.configStore.current().models.getProvider('relay')?.baseUrl).toBe('https://relay.example.test/v2');
    const updated = fixture.file().providers.relay;
    expect(updated).toMatchObject({ base_url: 'https://relay.example.test/v2' });
    expect(fixture.secret(updated?.api_key)).toBe('relay-secret-2');
    expect(updated?.kind === 'custom' && fixture.secret(updated.headers?.['x-route'])).toBe('relay-header-2');
    // A replaced secret gets a new entry, and the one it replaced is gone.
    expect(updated?.api_key).not.toEqual(createdRelay?.api_key);
    expect(Object.values(JSON.parse(await readFile(join(fixture.directory, 'key.json'), 'utf8')))).not.toContain(
      'relay-secret',
    );

    // A header is dropped with `null`; the key stays when it is omitted.
    const dropped = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      { headers: { 'x-route': null } },
      await revisionOf(fixture),
    );
    expect(dropped.status).toBe(200);
    expect(fixture.file().providers.relay).not.toHaveProperty('headers');
    expect(fixture.file().providers.relay?.api_key).toEqual(updated?.api_key);
    expect(fixture.secret(updated?.api_key)).toBe('relay-secret-2');

    const removed = await write(fixture, '/api/providers/relay', 'DELETE', {}, await revisionOf(fixture));
    expect(removed.status).toBe(200);
    expect(fixture.file().providers.relay).toBeUndefined();
    // Only the entries the fixture configuration itself references are left.
    expect(fixture.jarNames()).toEqual(['agent', 'builtin', 'header', 'telegram', 'vision']);
  } finally {
    fixture.store.close();
  }
});

test('refuses a builtin provider edit that is not its key', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.builtin = {
        kind: 'builtin',
        provider: 'openrouter',
        api_key: { jar: 'builtin' },
        models: [model('deepseek/deepseek-v4-flash-0731')],
      };
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/providers'));
    const builtin = view.providers.find((entry: any) => entry.alias === 'builtin');
    expect(builtin).toMatchObject({
      kind: 'builtin',
      provider: 'openrouter',
      api: 'openai-completions',
      base_url: 'https://openrouter.ai/api/v1',
      header_names: [],
    });

    const rejected = await write(
      fixture,
      '/api/providers/builtin',
      'PUT',
      { api: 'anthropic-messages' },
      await revisionOf(fixture),
    );
    expect(rejected.status).toBe(400);
    expect(await readJson(rejected)).toMatchObject({ error: 'immutable_field' });

    const key = await write(
      fixture,
      '/api/providers/builtin',
      'PUT',
      { api_key: 'rotated' },
      await revisionOf(fixture),
    );
    expect(key.status).toBe(200);
    expect(fixture.secret(fixture.file().providers.builtin?.api_key)).toBe('rotated');
    expect(fixture.jarNames()).not.toContain('builtin');
  } finally {
    fixture.store.close();
  }
});

test('protects the providers and models that are in use', async () => {
  const fixture = await adminFixture();
  try {
    const provider = await write(fixture, '/api/providers/agent', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });

    const inUseModel = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(inUseModel.status).toBe(409);
    expect(await readJson(inUseModel)).toMatchObject({ error: 'model_in_use' });

    const added = await write(
      fixture,
      '/api/providers/agent/models',
      'POST',
      { models: [model('agent-extra')] },
      await revisionOf(fixture),
    );
    expect(added.status).toBe(200);
    expect(await readJson(added)).toMatchObject({ apply: { applied: ['providers.agent.models[agent-extra]'] } });

    const duplicate = await write(
      fixture,
      '/api/providers/agent/models',
      'POST',
      { models: [model('agent-extra')] },
      await revisionOf(fixture),
    );
    expect(duplicate.status).toBe(409);
    expect(await readJson(duplicate)).toMatchObject({ error: 'model_exists' });

    const replaced = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      model('agent-model', { reasoning: true, context_window: 300_000 }),
      await revisionOf(fixture),
    );
    expect(replaced.status).toBe(200);
    expect(await readJson(replaced)).toMatchObject({
      apply: { applied: ['providers.agent.models[agent-model]'], restart_required: [] },
    });
    expect(fixture.configStore.current().models.getModel('agent', 'agent-model')?.contextWindow).toBe(300_000);

    const mismatch = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      model('other-model'),
      await revisionOf(fixture),
    );
    expect(mismatch.status).toBe(400);
    expect(await readJson(mismatch)).toMatchObject({ error: 'invalid_model_id' });

    const removed = await write(
      fixture,
      '/api/providers/agent/models/agent-extra',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toMatchObject({ apply: { applied: ['providers.agent.models[agent-extra]'] } });
  } finally {
    fixture.store.close();
  }
});

test('protects a provider and model used only by a Chat override', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent;
      if (provider === undefined) {
        throw new Error('Missing fixture provider');
      }
      config.providers.chat = { ...provider, models: [model('chat-only')] };
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'chat', model: 'chat-only', thinking_level: 'off' });
    },
  });
  try {
    const before = await fixture.read();
    const snapshot = fixture.configStore.current();
    const provider = await write(fixture, '/api/providers/chat', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });
    const selected = await write(
      fixture,
      '/api/providers/chat/models/chat-only',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(selected.status).toBe(409);
    expect(await readJson(selected)).toMatchObject({ error: 'model_in_use' });
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current()).toBe(snapshot);
  } finally {
    fixture.store.close();
  }
});

test('protects a provider and model still used by a running Chat pending removal', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent;
      if (provider === undefined) {
        throw new Error('Missing fixture provider');
      }
      config.providers.chat = { ...provider, models: [model('chat-only')] };
      config.telegram.chats.push({ id: -999, provider: 'chat', model: 'chat-only', thinking_level: 'off' });
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/chats'));
    const removed = await write(fixture, '/api/chats/-999', 'DELETE', null, view.revision as string);
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toMatchObject({ apply: { restart_required: ['telegram.chats[-999]'] } });
    expect(fixture.configStore.current().config.telegram.chats.some((chat) => chat.id === -999)).toBe(true);

    const before = await fixture.read();
    const snapshot = fixture.configStore.current();
    const provider = await write(fixture, '/api/providers/chat', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });
    const selected = await write(
      fixture,
      '/api/providers/chat/models/chat-only',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(selected.status).toBe(409);
    expect(await readJson(selected)).toMatchObject({ error: 'model_in_use' });
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current()).toBe(snapshot);
  } finally {
    fixture.store.close();
  }
});

test('discovers models in saved mode from the registry connection', async () => {
  const requests: string[] = [];
  const upstream = await startFixtureServer((incoming) => {
    requests.push(new URL(incoming.url).pathname);
    expect(new URL(incoming.url).pathname).toBe('/v1/models');
    expect(incoming.headers.get('authorization')).toBe('Bearer agent-secret');
    expect(incoming.headers.get('x-route')).toBe('header-secret-value');
    return Response.json({
      object: 'list',
      data: [
        {
          id: 'agent-model',
          name: 'Agent Model',
          context_length: 200_000,
          top_provider: { max_completion_tokens: 32_768 },
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['reasoning'],
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
        { id: 'fresh-model', name: 'Fresh', context_length: 100_000, top_provider: { max_completion_tokens: 4_096 } },
      ],
    });
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.base_url = `http://127.0.0.1:${upstream.port}/v1`;
    },
  });
  try {
    const discovered = await write(fixture, '/api/providers/discover', 'POST', { alias: 'agent' });
    expect(discovered.status).toBe(200);
    const body = await readJson(discovered);
    expect(body.endpoint).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);
    expect(body.metadata_source_error).toBeNull();
    const existing = body.models.find((entry: any) => entry.id === 'agent-model');
    expect(existing).toMatchObject({ configured: true });
    // The fixture endpoint is OpenAI-shaped without extensions, so only
    // models.dev could have filled the limits, and it does not know this id.
    expect(existing.context_window).toBeNull();
    expect(existing.sources.context_window).toBe('missing');
    const fresh = body.models.find((entry: any) => entry.id === 'fresh-model');
    expect(fresh).toMatchObject({ configured: false });
    expect(fresh.needs_confirmation).toContain('input');

    // A connection change the process could not apply must never send the
    // credentials it resolved to an address that only exists in the file.
    const changed = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { base_url: `http://127.0.0.1:${upstream.port}/v2`, api_key: 'agent-secret', headers: { 'x-route': 'r' } },
      await revisionOf(fixture),
    );
    expect(changed.status).toBe(200);
    expect(requests).toEqual(['/v1/models']);

    // The file now describes another address and a pending restart-only field
    // the running process cannot adopt, so nothing of the file is applied.
    await rewriteFile(fixture, (config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent.context.idle_grace_seconds = 10;
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.base_url = `http://127.0.0.1:${upstream.port}/v3`;
    });
    const refused = await write(fixture, '/api/config/apply', 'POST', {}, null);
    expect(refused.status).toBe(422);
    expect(await readJson(refused)).toMatchObject({ error: 'candidate_invalid' });

    const pending = await write(fixture, '/api/providers/discover', 'POST', { alias: 'agent' });
    expect(pending.status).toBe(409);
    expect(await readJson(pending)).toMatchObject({ error: 'connection_not_applied' });
    // Nothing was sent anywhere: the saved mode refuses before it dials.
    expect(requests).toEqual(['/v1/models']);
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('redacts an upstream error that echoes the submitted key', async () => {
  const upstream = await startFixtureServer(() =>
    Response.json({ error: { message: 'invalid key: temporary-secret' } }, { status: 401 }),
  );
  const fixture = await adminFixture();
  try {
    const response = await write(fixture, '/api/providers/discover', 'POST', {
      kind: 'custom',
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api: 'openai-completions',
      api_key: 'temporary-secret',
    });
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.error).toBe('provider_discovery_failed');
    expect(body.message).toContain('[REDACTED]');
    expect(body.message).not.toContain('temporary-secret');
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('checks the vision model before writing it', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.models.push({
        id: 'tiny-vision',
        name: 'Tiny Vision',
        reasoning: false,
        input: ['text', 'image'],
        context_window: 4_096,
        max_tokens: 1_024,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
      agent.models.push({
        id: 'text-only',
        name: 'Text Only',
        reasoning: false,
        input: ['text'],
        context_window: 200_000,
        max_tokens: 32_768,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
    },
  });
  try {
    const revision = await revisionOf(fixture);
    const missing = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'ghost' }, revision);
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'unknown_model' });

    const textOnly = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'text-only' }, revision);
    expect(textOnly.status).toBe(400);
    expect(await readJson(textOnly)).toMatchObject({ error: 'not_image_capable' });

    const tooSmall = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'tiny-vision' }, revision);
    expect(tooSmall.status).toBe(400);
    expect(await readJson(tooSmall)).toMatchObject({ error: 'max_output_tokens_exceeded' });

    const ok = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'agent-model' }, revision);
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({
      apply: { applied: ['vision.model', 'vision.provider'], restart_required: [] },
    });
    expect(fixture.file().vision).toMatchObject({ provider: 'agent', model: 'agent-model' });
    // The switch is hot: the running process analyzes with the new model.
    expect(fixture.configStore.current().config.vision).toMatchObject({ provider: 'agent', model: 'agent-model' });
    expect(fixture.configStore.current().visionModel.id).toBe('agent-model');
  } finally {
    fixture.store.close();
  }
});

test('sets the agent thinking level only to a level the agent model accepts', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const model = config.providers.agent?.models[0];
      if (model === undefined) {
        throw new Error('Expected an agent model fixture');
      }
      model.thinking_levels = ['off', 'low', 'high', 'max'];
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/providers'));
    expect(view).toMatchObject({ agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' } });
    const revision = await revisionOf(fixture);

    const unknown = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'turbo' }, revision);
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toMatchObject({ error: 'invalid_body' });

    const unsupported = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'medium' }, revision);
    expect(unsupported.status).toBe(422);
    expect(await readJson(unsupported)).toMatchObject({
      error: 'unsupported_thinking_level',
      message: 'agent/agent-model does not accept thinking level medium (supported: off, low, high, max)',
    });
    expect(fixture.file().agent.thinking_level).toBe('low');

    const missingRevision = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'max' });
    expect(missingRevision.status).toBe(400);
    expect(await readJson(missingRevision)).toMatchObject({ error: 'revision_required' });

    const ok = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'max' }, revision);
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({
      agent: { thinking_level: 'max' },
      apply: { applied: ['agent.thinking_level'], restart_required: [] },
    });
    expect(fixture.file().agent.thinking_level).toBe('max');
    // A whitelisted field: the next invocation already runs with it.
    expect(fixture.configStore.current().config.agent.thinking_level).toBe('max');

    // Editing the agent model so that it loses the level in use is refused
    // before anything is written; the level has to move first.
    const before = await readFile(fixture.configPath, 'utf8');
    const narrowed = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      { ...fixture.file().providers.agent?.models[0], thinking_levels: ['off', 'high'] },
      await revisionOf(fixture),
    );
    expect(narrowed.status).toBe(422);
    const refusal = (await readJson(narrowed)) as { error: string; message: string };
    expect(refusal.error).toBe('config_invalid');
    expect(refusal.message).toContain(
      'agent.thinking_level max is not supported by agent/agent-model (supported: off, high)',
    );
    expect(await readFile(fixture.configPath, 'utf8')).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('global Admin writes preserve Chat overrides and reject incompatible inherited thinking', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.agent.thinking_level = 'off';
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'vision', model: 'vision-model' });
      config.telegram.chats.push({ id: -999, provider: 'agent', model: 'agent-model', thinking_level: 'high' });
    },
  });
  try {
    const original = await fixture.read();
    const before = fixture.configStore.current();
    const rejected = await write(
      fixture,
      '/api/thinking-level',
      'PUT',
      { thinking_level: 'low' },
      await revisionOf(fixture),
    );
    expect(rejected.status).toBe(422);
    expect(await readJson(rejected)).toMatchObject({
      error: 'config_invalid',
      message: expect.stringContaining('chat 123456789.thinking_level low is not supported'),
    });
    expect(await fixture.read()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);

    const switched = await write(
      fixture,
      '/api/model',
      'PUT',
      { provider: 'vision', model: 'vision-model' },
      await revisionOf(fixture),
    );
    expect(switched.status).toBe(200);
    expect(fixture.file().agent).toMatchObject({ provider: 'vision', model: 'vision-model', thinking_level: 'off' });
    expect(fixture.file().telegram.chats).toEqual(fixture.loaded.fileConfig.telegram.chats);
    expect(fixture.configStore.current().config.telegram.chats).toEqual(before.config.telegram.chats);
  } finally {
    fixture.store.close();
  }
});

test('restarts only when the deployment declares a supervisor and the file loads', async () => {
  let restarts = 0;
  const fixture = await adminFixture({ onRestart: () => (restarts += 1) });
  try {
    const unsupervised = await call(fixture, '/api/restart', { method: 'POST' });
    expect(unsupervised.status).toBe(409);
    expect(await readJson(unsupervised)).toMatchObject({ error: 'restart_unsupported' });
    expect(restarts).toBe(0);

    process.env.PLASTICWAN_SUPERVISED = '1';
    await writeFile(fixture.configPath, '{ "version": 1 }');
    const invalid = await call(fixture, '/api/restart', { method: 'POST' });
    expect(invalid.status).toBe(422);
    expect(await readJson(invalid)).toMatchObject({ error: 'config_invalid' });
    expect(restarts).toBe(0);

    await writeFile(fixture.configPath, await readFile(join(fixture.directory, 'original.jsonc'), 'utf8'));
    const restarted = await call(fixture, '/api/restart', { method: 'POST' });
    expect(restarted.status).toBe(202);
    expect(await readJson(restarted)).toEqual({ status: 'restarting' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restarts).toBe(1);
  } finally {
    fixture.store.close();
  }
});

test('still lists models when the models.dev catalog is unreachable', async () => {
  const upstream = await startFixtureServer(() =>
    Response.json({
      object: 'list',
      data: [{ id: 'fresh-model', name: 'Fresh' }],
    }),
  );
  const fixture = await adminFixture();
  const originalFetch = globalThis.fetch;
  try {
    resetModelsDevCatalogCache();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('models.dev')) {
        return Promise.reject(new Error('models.dev is unreachable'));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await write(fixture, '/api/providers/discover', 'POST', {
      kind: 'custom',
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api: 'openai-completions',
      api_key: 'temporary-secret',
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.endpoint).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);
    expect(body.metadata_source_error).toContain('models.dev is unreachable');
    // The listing survives; only the metadata models.dev would have supplied is
    // missing, and the admin confirms it in the edit dialog.
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ id: 'fresh-model', context_window: null });
    expect(body.models[0].needs_confirmation).toContain('context_window');

    const lookup = await write(fixture, '/api/providers/lookup-metadata', 'POST', {
      kind: 'custom',
      base_url: 'https://relay.example.test/v1',
      api: 'openai-completions',
      ids: ['some-model'],
    });
    expect(lookup.status).toBe(200);
    const lookupBody = await readJson(lookup);
    expect(lookupBody.metadata_source_error).toContain('models.dev is unreachable');
    expect(lookupBody.models[0].sources.context_window).toBe('missing');
  } finally {
    globalThis.fetch = originalFetch;
    fixture.store.close();
    await stopFixtureServer(upstream.server);
    await seedModelsDevCatalog();
  }
});

test('answers a malformed model id with a request error, not a server error', async () => {
  const fixture = await adminFixture();
  try {
    const response = await call(fixture, '/api/providers/agent/models/%ZZ', {
      method: 'DELETE',
      headers: { 'if-match': await revisionOf(fixture) },
    });
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: 'invalid_path' });
  } finally {
    fixture.store.close();
  }
});

const HEALTH_PATH = '/api/providers/health-check';
const HEALTH_TARGET = { provider: 'agent', model: 'agent-model' };

function healthMessage(text = 'ok', stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'agent',
    model: 'agent-model',
    content: [{ type: 'text', text }],
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 9,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test('checks a real streaming provider with one fixed prompt and audits usage without changing configuration', async () => {
  let requests = 0;
  const finishBody = Promise.withResolvers<void>();
  const receivedRequest = Promise.withResolvers<{ request: Request; body: Record<string, unknown> }>();
  const upstream = await startFixtureServer(async (incoming) => {
    requests += 1;
    const body = (await incoming.json()) as Record<string, unknown>;
    receivedRequest.resolve({ request: incoming, body });
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              'data: {"id":"health","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
            ),
          );
          await finishBody.promise;
          controller.enqueue(
            encoder.encode(
              'data: {"id":"health","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent!;
      if (provider.kind === 'custom') {
        provider.base_url = `http://127.0.0.1:${upstream.port}/v1`;
        provider.api = 'openai-completions';
        provider.models[0]!.reasoning = false;
        provider.models[0]!.max_tokens = 64;
        config.agent.thinking_level = 'off';
        config.developer = { record_model_payloads: true };
      }
    },
  });
  const registry = fixture.configStore.current().models;
  const original = registry.completeSimple.bind(registry);
  const receivedHeaders = Promise.withResolvers<void>();
  const probe = vi.spyOn(registry, 'completeSimple').mockImplementation((model, context, options) =>
    original(model, context, {
      ...options,
      onResponse: (response, selected) => {
        options?.onResponse?.(response, selected);
        receivedHeaders.resolve();
      },
    }),
  );
  try {
    const before = await fixture.read();
    const pending = write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET);
    await Promise.race([
      receivedHeaders.promise,
      pending.then(async (response) => {
        throw new Error(
          `Health check finished before response headers: ${JSON.stringify(await readJson(response.clone()))}`,
        );
      }),
    ]);
    // The header is observable before the stream finishes, never total latency.
    expect(fixture.store.orm.select().from(modelCalls).get()?.state).toBe('pending');
    finishBody.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    const result = await readJson(response);
    expect(result).toMatchObject({ ...HEALTH_TARGET, status: 'ok', response_text: 'ok', error: null });
    expect(result.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(result.ttfb_ms);
    expect(requests).toBe(1);
    const received = await receivedRequest.promise;
    expect(new URL(received.request.url).pathname).toBe('/v1/chat/completions');
    expect(received.request.headers.get('authorization')).toBe('Bearer agent-secret');
    expect(received.request.headers.get('x-route')).toBe('header-secret-value');
    expect(received.body.model).toBe('agent-model');
    expect(received.body.messages).toEqual([{ role: 'user', content: 'reply with extract content: ok' }]);
    expect(received.body.tools).toBeUndefined();
    expect(received.body.max_tokens ?? received.body.max_completion_tokens).toBe(64);
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current().generation).toBe(1);
    expect(fixture.store.orm.select().from(modelCalls).get()).toMatchObject({
      role: 'doctor',
      state: 'success',
      invocationId: null,
      toolsJson: '[]',
      totalTokens: 10n,
      requestJson: null,
      responseJson: null,
      errorCode: null,
    });
  } finally {
    finishBody.resolve();
    await fixture.server.stop();
    probe.mockRestore();
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('reports mismatched, empty, truncated and redacted failures independently, and leaves absent TTFB null', async () => {
  let requests = 0;
  const upstream = await startFixtureServer(() => {
    requests += 1;
    return Response.json({ error: { message: 'bad credentials agent-secret header-secret-value' } }, { status: 503 });
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent!;
      if (provider.kind === 'custom') {
        provider.base_url = `http://127.0.0.1:${upstream.port}/v1`;
        provider.api = 'openai-completions';
      }
    },
  });
  const registry = fixture.configStore.current().models;
  try {
    const failed = await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('[REDACTED]');
    expect(JSON.stringify(failed)).not.toMatch(/agent-secret|header-secret-value/);
    expect(requests).toBe(1);
    const probe = vi.spyOn(registry, 'completeSimple');
    try {
      for (const [text, stopReason, status] of [
        [' OK ', 'stop', 'unexpected_response'],
        ['  ', 'stop', 'error'],
        ['ok', 'length', 'error'],
        ['agent-secret', 'stop', 'unexpected_response'],
        [' ok\n', 'stop', 'ok'],
      ] as const) {
        probe.mockResolvedValueOnce(healthMessage(text, stopReason));
        const result = await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
        expect(result.status).toBe(status);
        expect(result.ttfb_ms).toBeNull();
        expect(result.response_text).not.toContain('agent-secret');
      }
    } finally {
      probe.mockRestore();
    }
    const audit = fixture.store.orm.select().from(modelCalls).all();
    expect(audit.map((row) => row.state)).toEqual(['error', 'error', 'error', 'error', 'error', 'success']);
    expect(audit.every((row) => row.finishedAt !== null)).toBe(true);
    expect(JSON.stringify(audit, (_key, value) => (typeof value === 'bigint' ? String(value) : value))).not.toMatch(
      /agent-secret|header-secret-value/,
    );
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('the health-check route does not shadow edits to a provider with that alias', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers['health-check'] = structuredClone(config.providers.vision!);
    },
  });
  try {
    const updated = await write(
      fixture,
      HEALTH_PATH,
      'PUT',
      { api_key: 'replacement-fixture-key' },
      await revisionOf(fixture),
    );
    expect(updated.status).toBe(200);
    expect(fixture.secret(fixture.file().providers['health-check']?.api_key)).toBe('replacement-fixture-key');
    const deleted = await call(fixture, HEALTH_PATH, {
      method: 'DELETE',
      headers: { 'if-match': await revisionOf(fixture) },
    });
    expect(deleted.status).toBe(200);
    expect(fixture.file().providers['health-check']).toBeUndefined();
    expect(fixture.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    fixture.store.close();
  }
});

test('health checks reject unauthorized, invalid and unapplied targets before calling a model', async () => {
  const fixture = await adminFixture();
  const probe = vi.spyOn(fixture.configStore.current().models, 'completeSimple');
  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(HEALTH_TARGET),
    };
    expect((await fixture.server.handle(request(HEALTH_PATH, init))).status).toBe(401);
    expect(
      (await call(fixture, HEALTH_PATH, { ...init, headers: { ...init.headers, origin: 'https://evil.example' } }))
        .status,
    ).toBe(403);
    const key = await readJson(await write(fixture, '/api/api-keys', 'POST', { name: 'health-test' }));
    expect(
      (await call(fixture, HEALTH_PATH, { ...init, headers: { ...init.headers, authorization: `Bearer ${key.key}` } }))
        .status,
    ).toBe(403);
    for (const body of [
      {},
      { ...HEALTH_TARGET, prompt: 'different' },
      { ...HEALTH_TARGET, base_url: 'http://evil.example' },
    ]) {
      expect((await write(fixture, HEALTH_PATH, 'POST', body)).status).toBe(400);
    }
    expect((await call(fixture, HEALTH_PATH)).status).toBe(405);
    expect((await write(fixture, HEALTH_PATH, 'POST', { ...HEALTH_TARGET, model: 'missing' })).status).toBe(404);
    await rewriteFile(fixture, (config) => {
      config.providers.agent!.models[0]!.max_tokens -= 1;
    });
    expect(await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET))).toMatchObject({
      error: 'model_not_applied',
    });
    await rewriteFile(fixture, (config) => {
      const provider = config.providers.agent!;
      if (provider.kind === 'custom') {
        provider.base_url = 'https://evil.example/v1';
      }
    });
    expect(await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET))).toMatchObject({
      error: 'connection_not_applied',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(fixture.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    probe.mockRestore();
    fixture.store.close();
  }
});

test('rejects image-only health targets and broken saved configuration without an upstream request', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.vision!.models[0]!.input = ['image'];
    },
  });
  const probe = vi.spyOn(fixture.configStore.current().models, 'completeSimple');
  try {
    const response = await write(fixture, HEALTH_PATH, 'POST', { provider: 'vision', model: 'vision-model' });
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ error: 'not_text_capable' });
    await writeFile(fixture.configPath, 'not json');
    expect((await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET)).status).toBe(422);
    expect(probe).not.toHaveBeenCalled();
    expect(fixture.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    probe.mockRestore();
    fixture.store.close();
  }
});

test('health checks cancel on request abort, release their slot, and bound redacted output', async () => {
  const fixture = await adminFixture();
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  let adapterSignal: AbortSignal | undefined;
  const probe = vi
    .spyOn(fixture.configStore.current().models, 'completeSimple')
    .mockImplementationOnce((_model, _context, options) => {
      adapterSignal = options?.signal;
      started.resolve();
      return new Promise(() => {});
    });
  try {
    const pending = call(fixture, HEALTH_PATH, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(HEALTH_TARGET),
    });
    await started.promise;
    controller.abort(new Error('Client left agent-secret'));
    expect(await readJson(await pending)).toMatchObject({ status: 'error', error: 'Client left [REDACTED]' });
    expect(adapterSignal?.aborted).toBe(true);
    probe.mockResolvedValueOnce(healthMessage(`header-secret-value${'a'.repeat(5000)}`));
    const long = await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
    expect(long.response_text).toHaveLength(4096);
    expect(long.response_text).toMatch(/^\[REDACTED\]/);
    probe.mockResolvedValueOnce({
      ...healthMessage(),
      content: [{ type: 'toolCall', id: 'bad-call', name: 'send', arguments: {} }],
      stopReason: 'toolUse',
    });
    expect(await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET))).toMatchObject({ status: 'error' });
    expect(
      fixture.store.orm
        .select()
        .from(modelCalls)
        .all()
        .every((row) => row.state === 'error' && row.finishedAt !== null),
    ).toBe(true);
  } finally {
    await fixture.server.stop();
    probe.mockRestore();
    fixture.store.close();
  }
});

test('health checks time out and audit completion even if an adapter ignores cancellation', async () => {
  const fixture = await adminFixture();
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const probe = vi
    .spyOn(fixture.configStore.current().models, 'completeSimple')
    .mockImplementation((_model, _context, options) => {
      signal = options?.signal;
      expect(options).toMatchObject({ maxTokens: 128, maxRetries: 0, timeoutMs: 30_000 });
      started.resolve();
      return new Promise(() => {});
    });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET);
    await started.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await readJson(await pending);
    expect(result).toMatchObject({ status: 'error', ttfb_ms: null, response_text: '' });
    expect(result.error).toContain('timed out');
    expect(signal?.aborted).toBe(true);
    expect(fixture.store.orm.select().from(modelCalls).get()).toMatchObject({
      state: 'error',
      errorCode: 'model_health_error',
    });
  } finally {
    vi.useRealTimers();
    probe.mockRestore();
    fixture.store.close();
  }
});

test('limits simultaneous health checks and cancels and drains them before Admin shutdown', async () => {
  const fixture = await adminFixture();
  const signals: AbortSignal[] = [];
  const started = Promise.withResolvers<void>();
  const probe = vi
    .spyOn(fixture.configStore.current().models, 'completeSimple')
    .mockImplementation((_model, _context, options) => {
      signals.push(options!.signal!);
      if (signals.length === 3) {
        started.resolve();
      }
      return new Promise(() => {});
    });
  try {
    const pending = Array.from({ length: 3 }, () => write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
    await started.promise;
    expect((await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET)).status).toBe(429);
    await fixture.server.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET)).status).toBe(503);
    expect(probe).toHaveBeenCalledTimes(3);
    for (const response of await Promise.all(pending)) {
      expect(await readJson(response)).toMatchObject({ status: 'error', error: 'Admin server is stopping' });
    }
    expect(
      fixture.store.orm
        .select()
        .from(modelCalls)
        .all()
        .map((row) => row.state),
    ).toEqual(['error', 'error', 'error']);
  } finally {
    await fixture.server.stop();
    probe.mockRestore();
    fixture.store.close();
  }
});

test('rejects cross-origin provider writes', async () => {
  const fixture = await adminFixture();
  try {
    const response = await fixture.server.handle(
      request('/api/providers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: fixture.cookie,
          origin: 'http://evil.example.test',
        },
        body: JSON.stringify({ alias: 'relay' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ error: 'bad_origin' });
  } finally {
    fixture.store.close();
  }
});
