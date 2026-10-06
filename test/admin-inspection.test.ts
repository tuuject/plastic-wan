import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fauxProvider } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';
import { createApiKey } from '../src/ingress/admin/api-keys.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { loadConfig } from '../src/platform/config.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { chatMigrations, invocationMessages, media } from '../src/store/schema.ts';
import { runCli } from './cli-harness.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-inspection-'));
  const configPath = join(directory, 'config.jsonc');
  const secret = 'inspection-secret-must-not-be-output';
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.telegram.chats[0]!.id = -100123456789;
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.headers = { 'x-private': { env: 'PLASTICWAN_TEST_HEADER_SECRET' } };
      }
      config.mcp = {
        servers: [
          {
            alias: 'remote',
            transport: 'streamable_http',
            url: `https://example.test/mcp?token=${secret}`,
            follow_redirects: false,
            required: false,
            tools: [],
            payload_max_bytes: 1024,
            result_max_bytes: 1024,
            headers: { 'x-private': { command: ['fixed-command', secret] } },
          },
        ],
      };
    }),
    'You are a concise test agent.',
    'Be brief.',
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(fauxProvider({ provider: 'agent' })));
  const secrets = new SecretStore();
  secrets.remember(secret);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const seeded = seedAdminFixture(store);
  const snapshot = store.orm
    .select()
    .from(invocationMessages)
    .where(and(eq(invocationMessages.invocationId, seeded.invocationA), eq(invocationMessages.sequenceNo, 1n)))
    .get();
  const photo = store.orm.select().from(media).get();
  if (snapshot === undefined || photo === undefined) {
    throw new Error('Inspection fixture is missing its photo snapshot');
  }
  store.orm
    .update(invocationMessages)
    .set({
      revisionId: photo.revisionId,
      snapshotJson: JSON.stringify({ media: [{ id: photo.id.toString(), kind: 'photo' }] }),
    })
    .where(and(eq(invocationMessages.invocationId, seeded.invocationA), eq(invocationMessages.sequenceNo, 1n)))
    .run();
  const key = createApiKey(store.orm, 'inspection').key;
  let modelCalls = 0;
  const server = new AdminServer({
    store,
    configStore,
    configReloader: reloader,
    secrets,
    replayPreflight: () => ({
      available: false,
      reason: 'replay_input_unavailable',
      message: secret,
      recording_enabled: false,
    }),
    invocationPrompts: (id) => ({
      source: 'recorded',
      source_invocation_id: id.toString(),
      global_prompt: secret,
      group_prompt: 'historical group',
      core_read_only: true,
    }),
    replayInvocation: async () => {
      modelCalls += 1;
      return {};
    },
    mediaDownloader: {
      download: async (_fileId, path, signal) => {
        signal.throwIfAborted();
        await writeFile(path, Buffer.from('fixture-original-bytes'));
      },
    },
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner', password: 'inspection-panel-password' }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  return {
    directory,
    configPath,
    store,
    configStore,
    server,
    key,
    cookie,
    seeded,
    secret,
    modelCalls: () => modelCalls,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

test('configuration and prompts are explicit read projections for both keys and sessions', async () => {
  const f = await fixture();
  const before = await readFile(f.configPath, 'utf8');
  for (const headers of [auth(f.key), { cookie: f.cookie }]) {
    const response = await f.server.handle(request('/api/config/view', { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      source: 'active',
      generation: 1,
      active_hash: f.configStore.current().hash,
      config: {
        telegram: { chats: [{ id: '-100123456789', group_prompt_configured: true }] },
        providers: [
          { alias: 'agent', header_names: ['x-private'] },
          { alias: 'vision', header_names: [] },
        ],
      },
    });
    const encoded = JSON.stringify(body);
    for (const forbidden of [
      f.secret,
      f.directory,
      'api_key',
      'system_prompt',
      'instructions_file',
      'fixed-command',
      'credentialRef',
      'token=',
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    const global = await f.server.handle(request('/api/prompts/global', { headers }));
    expect(global.status).toBe(200);
    expect(await global.json()).toMatchObject({
      scope: 'global',
      source: 'active',
      chat_id: null,
      prompt: 'You are a concise test agent.',
      core_read_only: true,
    });
    const group = await f.server.handle(request('/api/prompts/group?chat=-100123456789', { headers }));
    expect(group.status).toBe(200);
    expect(await group.json()).toMatchObject({
      scope: 'group',
      chat_id: '-100123456789',
      prompt: 'Be brief.',
      core_read_only: true,
    });
  }
  expect(await readFile(f.configPath, 'utf8')).toBe(before);
  expect(f.modelCalls()).toBe(0);
});

test('file and active prompt reads never silently substitute for each other', async () => {
  const f = await fixture();
  const initialHash = f.configStore.current().hash;
  await writeFile(join(f.directory, 'agent-system-prompt.md'), 'Changed file only.');
  const file = await f.server.handle(request('/api/prompts/global?source=file', { headers: auth(f.key) }));
  const data = await file.json();
  expect(data).toMatchObject({ source: 'file', prompt: 'Changed file only.', active_hash: initialHash });
  expect(data).not.toMatchObject({ file_hash: initialHash });
  const active = await f.server.handle(request('/api/prompts/global?source=active', { headers: auth(f.key) }));
  expect(await active.json()).toMatchObject({ prompt: 'You are a concise test agent.', active_hash: initialHash });
  f.store.orm
    .insert(chatMigrations)
    .values({ oldChatId: -100123456789n, newChatId: -100987654321n, receivedAt: new Date().toISOString() })
    .run();
  const migrated = await f.server.handle(request('/api/prompts/group?chat=-100987654321', { headers: auth(f.key) }));
  expect(await migrated.json()).toMatchObject({
    configured_chat_id: '-100123456789',
    chat_id: '-100987654321',
    prompt: 'Be brief.',
  });
  await writeFile(f.configPath, `invalid file quoting ${f.secret}`);
  const invalid = await f.server.handle(request('/api/config/view?source=file', { headers: auth(f.key) }));
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toEqual({
    error: 'config_invalid',
    message: 'The configuration file cannot be loaded safely',
  });
});

test('inspection rejects path inputs, repeated filters, unknown routes and every key write surface', async () => {
  const f = await fixture();
  for (const path of [
    '/api/config/view?source=other',
    '/api/config/view?source=active&source=file',
    '/api/prompts/global?path=secret',
    '/api/prompts/group',
    '/api/prompts/group?chat=9223372036854775808',
    '/api/prompts/group?chat=0&chat=1',
    '/api/invocations/9223372036854775808',
    '/api/invocations/-9223372036854775809',
    '/api/invocations/9223372036854775808/prompts',
    '/api/invocations/-9223372036854775809/replay-preflight',
    '/api/invocations/9223372036854775808/media',
    '/api/invocations/4001/media/-9223372036854775809/content',
  ]) {
    expect((await f.server.handle(request(path, { headers: auth(f.key) }))).status, path).toBe(400);
  }
  expect((await f.server.handle(request('/api/prompts/group?chat=999', { headers: auth(f.key) }))).status).toBe(404);
  expect((await f.server.handle(request('/api/prompts/global'))).status).toBe(401);
  expect(
    (
      await f.server.handle(
        request('/api/prompts/global', { headers: { cookie: f.cookie, authorization: 'Bearer invalid' } }),
      )
    ).status,
  ).toBe(401);
  for (const path of [
    '/api/prompts/system',
    '/api/config/unknown',
    '/api/providers',
    '/api/api-keys',
    '/api/unknown',
  ]) {
    expect((await f.server.handle(request(path, { headers: auth(f.key) }))).status, path).toBe(403);
  }
  for (const path of [
    '/api/config/view',
    '/api/prompts/global',
    '/api/prompts/group',
    `/api/invocations/${f.seeded.invocationA}/prompts`,
    `/api/invocations/${f.seeded.invocationA}/media`,
  ]) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(
        (await f.server.handle(request(path, { method, body: '{}', headers: auth(f.key) }))).status,
        `${method} ${path}`,
      ).toBe(403);
    }
  }
});

test('retained prompt and preflight reads redact metadata without any model request', async () => {
  const f = await fixture();
  for (const headers of [auth(f.key), { cookie: f.cookie }]) {
    const preflight = await f.server.handle(
      request(`/api/invocations/${f.seeded.invocationA}/replay-preflight`, { headers }),
    );
    expect(await preflight.json()).toMatchObject({
      available: false,
      reason: 'replay_input_unavailable',
      message: '[REDACTED]',
    });
    const prompts = await f.server.handle(request(`/api/invocations/${f.seeded.invocationA}/prompts`, { headers }));
    expect(await prompts.json()).toMatchObject({
      global_prompt: '[REDACTED]',
      group_prompt: 'historical group',
      core_read_only: true,
    });
  }
  expect(f.modelCalls()).toBe(0);
});

test('CLI media export accepts the real authenticated Admin media projection and preserves original bytes', async () => {
  const f = await fixture();
  const admin = f.configStore.current().config.admin;
  if (admin === undefined) {
    throw new Error('Inspection fixture is missing its admin listener');
  }
  // The file schema requires a fixed positive port; only this isolated listener
  // uses an OS-assigned loopback port, with no access to saved CLI credentials.
  admin.port = 0;
  const listening = await f.server.start();
  let exportDirectory: string | undefined;
  try {
    const result = await runCli(['invocation', 'media', f.seeded.invocationA.toString(), '--json'], {
      env: {
        PLASTICWAN_ENDPOINT: `http://127.0.0.1:${listening.port}`,
        PLASTICWAN_API_KEY: f.key,
      },
      home: f.directory,
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout) as {
      invocation_id: string;
      directory: string;
      items: Array<{ id: string; status: string; path: string; bytes: number; sha256: string }>;
    };
    exportDirectory = manifest.directory;
    expect(manifest.invocation_id).toBe(f.seeded.invocationA.toString());
    expect(manifest.items).toHaveLength(1);
    const photo = f.store.orm.select().from(media).get();
    const downloaded = manifest.items[0];
    expect(downloaded).toMatchObject({ id: photo?.id.toString(), status: 'downloaded' });
    expect(downloaded).not.toHaveProperty('telegram_message_id');
    if (downloaded === undefined) {
      throw new Error('CLI export is missing its source media item');
    }
    const bytes = await readFile(downloaded.path);
    expect(bytes).toEqual(Buffer.from('fixture-original-bytes'));
    expect(downloaded.bytes).toBe(bytes.byteLength);
    expect(downloaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const savedManifest = await readFile(join(manifest.directory, 'manifest.json'), 'utf8');
    expect(JSON.parse(savedManifest)).toEqual(manifest);
    for (const forbidden of [f.key, 'file_id', 'file_unique_id', 'telegram_message_id']) {
      expect(result.stdout).not.toContain(forbidden);
      expect(savedManifest).not.toContain(forbidden);
    }
    expect(f.modelCalls()).toBe(0);
  } finally {
    await f.server.stop();
    if (exportDirectory !== undefined) {
      await rm(exportDirectory, { recursive: true, force: true });
    }
  }
}, 30_000);

test('media content is authenticated, bounded to the source invocation and served as an attachment', async () => {
  const f = await fixture();
  const path = `/api/invocations/${f.seeded.invocationA}/media`;
  const list = await f.server.handle(request(path, { headers: auth(f.key) }));
  expect(list.status).toBe(200);
  const data = await list.json();
  const photo = f.store.orm.select().from(media).get();
  if (photo === undefined) {
    throw new Error('Inspection fixture is missing its photo');
  }
  expect(data).toMatchObject({ items: [{ id: photo.id.toString() }] });
  expect(JSON.stringify(data)).not.toContain('file_id');
  expect(JSON.stringify(data)).not.toContain('telegram_message_id');
  f.store.orm.update(media).set({ mimeType: 'image/svg+xml' }).where(eq(media.id, photo.id)).run();
  const contentPath = `${path}/${photo.id}/content`;
  expect((await f.server.handle(request(contentPath))).status).toBe(401);
  const response = await f.server.handle(request(`${contentPath}?variant=original`, { headers: auth(f.key) }));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-disposition')).toBe('attachment');
  expect(response.headers.get('x-plasticwan-media-variant')).toBe('original');
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    createHash('sha256').update('fixture-original-bytes').digest('hex'),
  );
  expect((await f.server.handle(request(`${contentPath}?variant=bad`, { headers: auth(f.key) }))).status).toBe(400);
  expect((await f.server.handle(request(`${contentPath}?path=anything`, { headers: auth(f.key) }))).status).toBe(400);
  expect((await f.server.handle(request(`${path}/999999/content`, { headers: auth(f.key) }))).status).toBe(404);
});
