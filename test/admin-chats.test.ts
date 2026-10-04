import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { loadConfig, type FileConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { chatMigrations, chats } from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';
import type { ChatsView, ChatWriteResponse } from '../apps/admin-next/src/lib/api.ts';

const cleanup: Array<() => Promise<void>> = [];
const inherited = { topic_ids: null, provider: null, model: null, thinking_level: null };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-chats-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.telegram.chats.push({
        id: -100100,
        topic_ids: [12],
        ignored_user_ids: [42],
        timezone: 'Asia/Shanghai',
        instructions_file: 'chat-instructions.md',
      });
    }),
  );
  const loaded = await loadConfig(path);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const configStore = await testConfigStore(loaded);
  const secrets = new SecretStore(keyJarPath(path));
  const switcher = new AgentModelSwitcher(configStore);
  const validate = vi.fn();
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets,
    validateAgentModel: validate,
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, modelSwitcher: switcher, secrets });
  const request = (route: string, init: RequestInit = {}) =>
    server.handle(new Request(`http://127.0.0.1:8899/api${route}`, init));
  const setup = await request('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'test-correct-horse-battery' }),
  });
  const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  const call = (route: string, init: RequestInit = {}) =>
    request(route, { ...init, headers: { cookie, ...init.headers } });
  const view = async (): Promise<ChatsView> => (await (await call('/chats')).json()) as ChatsView;
  const write = (route: string, method: string, body: unknown, revision: string) =>
    call(route, {
      method,
      headers: { 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify(body),
    });
  return { path, store, configStore, reloader, validate, secrets, request, call, view, write };
}

test('Chat views are authenticated, string-ID only and contain saved and active effective settings', async () => {
  const f = await fixture();
  expect((await f.request('/chats')).status).toBe(401);
  const view = await f.view();
  expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(view.defaults).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'low' });
  expect(view.models).toContainEqual({
    provider: 'vision',
    model: 'vision-model',
    name: 'Vision Model',
    thinking_levels: ['off'],
  });
  const chat = view.items.find((item) => item.id === '-100100');
  expect(chat).toMatchObject({
    runtime_chat_id: '-100100',
    title: null,
    saved: { topic_ids: ['12'], provider: null, effective: view.defaults },
  });
  expect(chat?.active).toEqual(chat?.saved);
  const serialized = JSON.stringify(view);
  for (const secret of [
    'telegram-secret',
    'agent-secret',
    'vision-secret',
    'api_key',
    'instructions_file',
    'private',
  ]) {
    expect(serialized).not.toContain(secret);
  }
  expect((await f.call('/chats', { method: 'POST', headers: { origin: 'https://evil.test' } })).status).toBe(403);
  expect((await f.call('/chats/123', { method: 'POST' })).status).toBe(405);
  expect((await f.call('/chats/123')).status).toBe(405);
});

test('Chat edits require the original revision before parsing a body, reject stale array indices and serialize competing writes', async () => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const missing = await f.call('/chats/-100100', { method: 'PUT', body: 'not JSON' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'revision_required' });
  const { revision } = await f.view();
  const file = JSON.parse(before) as FileConfig;
  file.telegram.chats.reverse();
  await writeFile(f.path, JSON.stringify(file));
  const stale = await f.write('/chats/-100100', 'PUT', inherited, revision);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'config_conflict' });
  expect(await readFile(f.path, 'utf8')).toBe(JSON.stringify(file));
  const fresh = await f.view();
  const results = await Promise.all([
    f.write('/chats/-100100', 'PUT', { ...inherited, thinking_level: 'high' }, fresh.revision),
    f.write('/chats/-100100', 'PUT', { ...inherited, thinking_level: 'off' }, fresh.revision),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(
    f.configStore.current().config.telegram.chats.find((chat) => chat.id === 123456789)?.thinking_level,
  ).toBeUndefined();
});

test('model changes apply hot while Topic scopes wait for restart, preserving other fields and JSONC comments', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await writeFile(f.path, `// keep this comment\n${await readFile(f.path, 'utf8')}`);
  const { revision } = await f.view();
  const response = await f.write(
    '/chats/-100100',
    'PUT',
    { topic_ids: ['24', '36'], provider: 'vision', model: 'vision-model', thinking_level: 'off' },
    revision,
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as ChatWriteResponse;
  expect(result.apply.applied).toContain('telegram.chats[-100100].model');
  expect(result.apply.restart_required).toEqual(['telegram.chats[-100100].topic_ids']);
  const row = result.items.find((chat) => chat.id === '-100100');
  expect(row?.saved?.topic_ids).toEqual(['24', '36']);
  expect(row?.active?.topic_ids).toEqual(['12']);
  expect(row?.active?.effective).toEqual({ provider: 'vision', model: 'vision-model', thinking_level: 'off' });
  const loaded = await loadConfig(f.path);
  expect(loaded.fileConfig.telegram.chats[1]).toMatchObject({
    ignored_user_ids: [42],
    timezone: 'Asia/Shanghai',
    instructions_file: 'chat-instructions.md',
  });
  expect(await readFile(f.path, 'utf8')).toContain('// keep this comment');
  expect(
    log.mock.calls.some(
      ([line]) => String(line).includes('config_reloaded') && String(line).includes('telegram.chats[-100100].model'),
    ),
  ).toBe(true);
  const reset = await f.write('/chats/-100100', 'PUT', inherited, result.revision);
  expect(reset.status).toBe(200);
  const resetView = (await reset.json()) as ChatWriteResponse;
  expect(resetView.items.find((chat) => chat.id === '-100100')?.saved).toMatchObject({
    ...inherited,
    effective: resetView.defaults,
  });
  expect(f.configStore.current().config.telegram.chats[1]?.provider).toBeUndefined();
  const bytes = await readFile(f.path, 'utf8');
  expect((await f.write('/chats/-100100', 'PUT', inherited, resetView.revision)).status).toBe(200);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
});

test('adding a Chat hot-applies while removal waits for restart, keeps removed active Chats visible and never deletes stored history', async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  f.store.orm
    .insert(chats)
    .values({
      telegramChatId: -100100n,
      canonicalChatId: -100100n,
      title: 'Saved group',
      type: 'supergroup',
      updatedAt: now,
    })
    .run();
  let view = await f.view();
  const added = await f.write('/chats', 'POST', { id: '-9007199254740991', ...inherited }, view.revision);
  expect(added.status).toBe(200);
  view = (await added.json()) as ChatWriteResponse;
  // The addition is hot: saved and active agree and nothing waits for a restart.
  expect(view.items.find((chat) => chat.id === '-9007199254740991')).toMatchObject({
    saved: inherited,
    active: { ...inherited, effective: view.defaults },
  });
  expect(view.restart_required).toEqual([]);
  expect(f.configStore.current().config.telegram.chats).toHaveLength(3);
  const removed = await f.write('/chats/-100100', 'DELETE', null, view.revision);
  expect(removed.status).toBe(200);
  view = (await removed.json()) as ChatWriteResponse;
  expect(view.items.find((chat) => chat.id === '-100100')).toMatchObject({
    title: 'Saved group',
    saved: null,
    active: { topic_ids: ['12'] },
  });
  expect(view.restart_required).toEqual(['telegram.chats[-100100]']);
  expect(f.store.orm.select().from(chats).all()).toHaveLength(1);
  const restarted = await loadConfig(f.path);
  expect(restarted.config.telegram.chats.map((chat) => chat.id)).toEqual([123456789, -9007199254740991]);
  // Removing a hot-added Chat also waits for a restart: the running allowlist
  // keeps serving it, so the row stays visible as pending.
  const removePending = await f.write('/chats/-9007199254740991', 'DELETE', null, view.revision);
  expect(removePending.status).toBe(200);
  view = (await removePending.json()) as ChatWriteResponse;
  expect(view.items.find((chat) => chat.id === '-9007199254740991')).toMatchObject({
    saved: null,
    active: { ...inherited, effective: view.defaults },
  });
  expect(view.restart_required).toEqual(
    expect.arrayContaining(['telegram.chats[-100100]', 'telegram.chats[-9007199254740991]']),
  );
  const last = await f.write('/chats/123456789', 'DELETE', null, view.revision);
  expect(last.status).toBe(409);
  expect(await last.json()).toMatchObject({ error: 'last_chat_required' });
});

test('invalid IDs, duplicate scopes, unknown models and unsupported inheritance never modify file or active state', async () => {
  const f = await fixture();
  const { revision } = await f.view();
  const before = await readFile(f.path, 'utf8');
  const active = f.configStore.current();
  const badBodies = [
    { ...inherited, id: 456 },
    { ...inherited, id: '0' },
    { ...inherited, id: '-0' },
    { ...inherited, id: '01' },
    { ...inherited, id: '9007199254740992' },
    { ...inherited, id: '456', topic_ids: [] },
    { ...inherited, id: '456', topic_ids: ['1', '1'] },
    { ...inherited, id: '456', topic_ids: ['0'] },
    { ...inherited, id: '456', topic_ids: ['9007199254740992'] },
    { ...inherited, id: '456', provider: 'vision' },
    { ...inherited, id: '456', model: 'vision-model' },
    { ...inherited, id: '456', provider: 'vision', model: 'missing' },
    { ...inherited, id: '456', provider: 'vision', model: 'vision-model' },
    { ...inherited, id: '456', thinking_level: 'nope' },
    { ...inherited, id: '456', instructions_file: 'forbidden.md' },
  ];
  for (const body of badBodies) {
    const response = await f.write('/chats', 'POST', body, revision);
    expect([400, 422], JSON.stringify(body)).toContain(response.status);
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(f.configStore.current()).toBe(active);
  }
  expect((await f.write('/chats', 'POST', { id: '-100100', ...inherited }, revision)).status).toBe(409);
  expect((await f.write('/chats/99', 'PUT', inherited, revision)).status).toBe(404);
  expect((await f.write('/chats/9007199254740992', 'DELETE', null, revision)).status).toBe(400);
  const oversized = await f.write('/chats', 'POST', { ...inherited, id: '456', padding: 'x'.repeat(9000) }, revision);
  expect(oversized.status).toBe(413);
});

test('migration titles resolve by runtime ID while edits continue targeting the configured ID', async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  f.store.orm.insert(chatMigrations).values({ oldChatId: -100100n, newChatId: -100200n, receivedAt: now }).run();
  f.store.orm
    .insert(chats)
    .values({
      telegramChatId: -100200n,
      canonicalChatId: -100200n,
      type: 'supergroup',
      title: 'Migrated group',
      updatedAt: now,
    })
    .run();
  const view = await f.view();
  expect(view.items.find((chat) => chat.id === '-100100')).toMatchObject({
    runtime_chat_id: '-100200',
    title: 'Migrated group',
  });
  expect((await f.write('/chats/-100200', 'PUT', inherited, view.revision)).status).toBe(404);
  expect((await f.write('/chats/-100100', 'PUT', { ...inherited, thinking_level: 'high' }, view.revision)).status).toBe(
    200,
  );
  expect(f.configStore.current().config.telegram.chats[1]?.thinking_level).toBe('high');
});

test('a Chat model override must carry its own thinking level', async () => {
  const f = await fixture();
  const { revision } = await f.view();
  const before = await readFile(f.path, 'utf8');
  const active = f.configStore.current();
  for (const [route, method, body] of [
    ['/chats', 'POST', { ...inherited, id: '456', provider: 'agent', model: 'agent-model' }],
    ['/chats/-100100', 'PUT', { ...inherited, provider: 'agent', model: 'agent-model' }],
  ] as const) {
    const response = await f.write(route, method, body, revision);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'thinking_level_required' });
  }
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(f.configStore.current()).toBe(active);
});

test('apply failures disclose saved-but-not-applied state, retain the running snapshot and redact audit errors', async () => {
  const f = await fixture();
  const secret = 'synthetic-chat-error-secret';
  f.secrets.remember(secret);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const active = f.configStore.current();
  f.validate.mockImplementation(() => {
    throw new Error(`Cannot use model: ${secret}`);
  });
  const response = await f.write(
    '/chats/-100100',
    'PUT',
    { ...inherited, thinking_level: 'high' },
    (await f.view()).revision,
  );
  expect(response.status).toBe(409);
  const error = (await response.json()) as { error: string; message: string };
  expect(error).toMatchObject({ error: 'model_unusable' });
  expect(error.message).toContain('config.jsonc was updated but not applied:');
  expect(error.message).not.toContain(secret);
  expect(f.configStore.current()).toBe(active);
  expect(f.reloader.status().lastError?.code).toBe('model_unusable');
  const row = (await f.view()).items.find((chat) => chat.id === '-100100');
  expect(row?.saved?.effective.thinking_level).toBe('high');
  expect(row?.active?.effective.thinking_level).toBe('low');
  expect(log.mock.calls.some(([line]) => String(line).includes('config_reload_failed'))).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
});
