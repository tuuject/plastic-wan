import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { getInvocation, listInvocations } from '../src/ingress/admin/audit.ts';
import { loadConfig, type FileConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { writeConfigEdits } from '../src/platform/config-file.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { modelCalls } from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';
import type { DeveloperSettings } from '../apps/admin-next/src/lib/api.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture(developer?: FileConfig['developer']) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-developer-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      if (developer !== undefined) {
        config.developer = developer;
      }
    }),
  );
  const loaded = await loadConfig(path);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keyJarPath(path));
  const validate = vi.fn();
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    secrets,
    validateAgentModel: validate,
    modelSwitcher: new AgentModelSwitcher(configStore),
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, secrets });
  cleanup.push(async () => {
    await server.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route: string, init: RequestInit = {}) =>
    server.handle(new Request(`http://127.0.0.1:8899/api${route}`, init));
  const setup = await request('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'test-correct-horse-battery' }),
  });
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const call = (route: string, init: RequestInit = {}) =>
    request(route, {
      ...init,
      headers: { cookie, origin: 'http://127.0.0.1:8899', ...init.headers },
    });
  const view = async (): Promise<DeveloperSettings> => (await (await call('/developer')).json()) as DeveloperSettings;
  const update = (enabled: boolean, revision: string) =>
    call('/developer', {
      method: 'PUT',
      headers: { 'if-match': revision },
      body: JSON.stringify({ record_model_payloads: enabled }),
    });
  return { loaded, path, configStore, store, reloader, validate, request, call, view, update };
}

test.each([undefined, {}, { record_model_payloads: false }, { record_model_payloads: true }])(
  'optional developer configuration resolves and round-trips %j',
  async (developer) => {
    const f = await fixture(developer);
    const expected = developer?.record_model_payloads ?? false;
    expect(f.loaded.fileConfig.developer).toEqual(developer);
    expect(f.loaded.config.developer.record_model_payloads).toBe(expected);
    expect(await f.view()).toMatchObject({ record_model_payloads: expected, active_record_model_payloads: expected });
    const unchanged = await readFile(f.path, 'utf8');
    expect(JSON.parse(unchanged).developer).toEqual(developer);
    const enabled = await f.update(true, (await f.view()).revision);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ record_model_payloads: true, active_record_model_payloads: true });
    const disabled = await f.update(false, (await f.view()).revision);
    expect(disabled.status).toBe(200);
    expect((await loadConfig(f.path)).config.developer.record_model_payloads).toBe(false);
    expect(f.configStore.current().config.developer.record_model_payloads).toBe(false);
    expect(f.reloader.status().restartRequired).toEqual([]);
    expect((await loadConfig(f.path)).fileConfig.agent).toEqual(f.loaded.fileConfig.agent);
  },
);

test('removing developer configuration hot-applies false without deleting historical payloads', async () => {
  const f = await fixture({ record_model_payloads: true });
  seedAdminFixture(f.store);
  const before = f.store.db.prepare('SELECT * FROM model_calls ORDER BY id').all();
  await writeConfigEdits(f.path, [{ path: ['developer'], value: undefined }]);
  expect(await f.reloader.reloadFromFile()).toMatchObject({ ok: true, restartRequired: [] });
  expect(await f.view()).toMatchObject({ record_model_payloads: false, active_record_model_payloads: false });
  expect(f.store.db.prepare('SELECT * FROM model_calls ORDER BY id').all()).toEqual(before);
});

test('Developer writes enforce authentication, origin, revision and boolean validation', async () => {
  const f = await fixture();
  for (const [route, method] of [
    ['/developer', 'GET'],
    ['/developer', 'PUT'],
    ['/developer/model-payloads', 'DELETE'],
  ]) {
    expect((await f.request(route!, { method: method! })).status).toBe(401);
    if (method !== 'GET') {
      expect((await f.call(route!, { method: method!, headers: { origin: 'https://other.test' } })).status).toBe(403);
    }
  }
  expect((await f.call('/developer', { method: 'POST' })).status).toBe(405);
  expect((await f.call('/developer', { method: 'PUT', body: '{}' })).status).toBe(400);
  const { revision } = await f.view();
  for (const body of [{}, { record_model_payloads: 'false' }, { record_model_payloads: true, extra: 1 }]) {
    const response = await f.call('/developer', {
      method: 'PUT',
      headers: { 'if-match': revision },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  }
  const before = await readFile(f.path, 'utf8');
  await writeFile(f.path, `${before}\n`);
  expect((await f.update(true, revision)).status).toBe(409);
  expect(await readFile(f.path, 'utf8')).toBe(`${before}\n`);
  await writeFile(
    f.path,
    before.replace('"version": 1', '"version": 1, "developer": {"record_model_payloads": "false"}'),
  );
  await expect(loadConfig(f.path)).rejects.toThrow('Invalid config');
});

test('failed apply exposes saved and active values separately and can recover', async () => {
  const f = await fixture();
  f.validate.mockImplementationOnce(() => {
    throw new Error('test apply failed');
  });
  const response = await f.update(true, (await f.view()).revision);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ message: expect.stringContaining('updated but not applied') });
  expect(await f.view()).toMatchObject({ record_model_payloads: true, active_record_model_payloads: false });
  expect(await f.reloader.reloadFromFile()).toMatchObject({ ok: true });
  expect(await f.view()).toMatchObject({ active_record_model_payloads: true });
});

test('batched payload cleanup preserves audit rows, associations and totals while yielding to new work', async () => {
  const f = await fixture({ record_model_payloads: true });
  const seed = seedAdminFixture(f.store);
  f.store.orm
    .insert(modelCalls)
    .values(
      Array.from({ length: 205 }, (_, index) => ({
        invocationId: index % 2 === 0 ? seed.invocationA : null,
        role: index % 2 === 0 ? 'agent' : 'vision_chat',
        provider: 'fixture',
        model: 'fixture',
        attempt: 1n,
        state: 'error',
        inputTokens: 11n,
        outputTokens: 3n,
        cacheReadTokens: 7n,
        cacheWriteTokens: 2n,
        totalTokens: 23n,
        cost: 0.25,
        errorCode: 'fixture_error',
        errorDetail: 'retain error',
        requestJson: index % 2 === 0 ? '{"large":"request"}' : null,
        responseJson: '{"status":500}',
        createdAt: new Date().toISOString(),
      })),
    )
    .run();
  const before = f.store.orm.select().from(modelCalls).all();
  const snapshot = () => ({
    invocations: f.store.db.prepare('SELECT * FROM invocations ORDER BY id').all(),
    tools: f.store.db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    sends: f.store.db.prepare('SELECT * FROM telegram_sends ORDER BY id').all(),
    usage: f.store.db.prepare('SELECT * FROM daily_usage').all(),
    list: listInvocations(f.store.orm, {}),
  });
  const auditBefore = snapshot();
  const clearing = f.call('/developer/model-payloads', { method: 'DELETE' });
  const duplicate = await f.call('/developer/model-payloads', { method: 'DELETE' });
  expect(duplicate.status).toBe(409);
  const newCall = f.store.orm
    .insert(modelCalls)
    .values({
      role: 'doctor',
      provider: 'fixture',
      model: 'new-call',
      attempt: 1n,
      state: 'success',
      requestJson: '{"new":true}',
      createdAt: new Date().toISOString(),
    })
    .returning({ id: modelCalls.id })
    .get()!;
  const response = await clearing;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    cleared_model_calls: before.filter((row) => row.requestJson !== null || row.responseJson !== null).length,
  });
  const after = f.store.orm.select().from(modelCalls).all();
  expect(after.filter((row) => row.id !== newCall.id)).toEqual(
    before.map((row) => ({ ...row, requestJson: null, responseJson: null })),
  );
  expect(after.find((row) => row.id === newCall.id)?.requestJson).toBe('{"new":true}');
  // Only the concurrent write keeps its payload: every row the sweep was
  // bounded to — mixed request/response rows included — lost both.
  expect(snapshot()).toEqual(auditBefore);
  expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(getInvocation(f.store.orm, seed.invocationA)).toMatchObject({
    model_calls: expect.arrayContaining([expect.objectContaining({ request_json: null, response_json: null })]),
  });
  expect(await (await f.call('/developer/model-payloads', { method: 'DELETE' })).json()).toEqual({
    cleared_model_calls: 1,
  });
  expect(await (await f.call('/developer/model-payloads', { method: 'DELETE' })).json()).toEqual({
    cleared_model_calls: 0,
  });
  expect(await f.view()).toMatchObject({ record_model_payloads: true });
});

test('migration 030 drops the retired replay snapshot column on fresh and upgraded databases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-developer-mig-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(directory, path);
  const loaded = await loadConfig(path);
  try {
    // A fresh database runs 029 (add column) and 030 (drop it) in one open, so
    // the column must be absent and the migration recorded.
    const fresh = await SqliteStore.open(loaded.config);
    try {
      const columns = fresh.db.prepare<[], { name: string }>('PRAGMA table_info(model_calls)').all();
      expect(columns.map((column) => column.name)).not.toContain('replay_input_json');
      expect(fresh.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 30').get()).toEqual({
        n: 1n,
      });
      // Recreate the pre-030 state: the column back with a legacy snapshot and
      // an audit row that must survive the drop, with 030 forgotten.
      fresh.db.exec('ALTER TABLE model_calls ADD COLUMN replay_input_json TEXT');
      fresh.db.prepare('DELETE FROM schema_migrations WHERE version = 30').run();
      fresh.db
        .prepare(
          `INSERT INTO model_calls(id, role, provider, model, attempt, state, created_at, request_json, replay_input_json)
           VALUES (9001, 'doctor', 'fixture', 'fixture', 1, 'success', '2026-01-01T00:00:00.000Z', '{"request":true}', '{"version":2}')`,
        )
        .run();
    } finally {
      fresh.close();
    }
    // Reopening applies the pending 030 against the upgraded database.
    const upgraded = await SqliteStore.open(loaded.config);
    try {
      const columns = upgraded.db.prepare<[], { name: string }>('PRAGMA table_info(model_calls)').all();
      expect(columns.map((column) => column.name)).not.toContain('replay_input_json');
      expect(upgraded.db.prepare('SELECT request_json FROM model_calls WHERE id = 9001').get()).toEqual({
        request_json: '{"request":true}',
      });
      expect(upgraded.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 30').get()).toEqual({
        n: 1n,
      });
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
