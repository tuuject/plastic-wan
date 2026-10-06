import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, type Mock, test, vi } from 'vitest';
import { credentialsPath } from '../packages/cli/src/credentials.ts';
import { runCli } from '../packages/cli/src/run.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { loadConfig } from '../src/platform/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/**
 * End-to-end `plasticwan-utils login` / `doctor` against a real loopback
 * AdminServer — no mocked client and no fake fetch:
 *
 * - `login` writes the synthetic panel key into a temp HOME and contacts
 *   nothing at all;
 * - `doctor` probes the real listener with `GET /api/invocations?limit=1` and
 *   reports the saved credential sources;
 * - the saved pair then drives `invocation list` / `invocation get`;
 * - the probe moves only `admin_api_keys.last_used_at`; every other table,
 *   production and audit alike, stays byte-identical;
 * - revoking the key through the panel session makes the next `doctor` exit 1
 *   unauthenticated with no healthy stdout and no state change.
 *
 * The replay engine is a `vi.fn` that throws, every real HTTP request is
 * counted through the `handle` spy, and every fetch the process makes is
 * recorded, so a model/replay dispatch or an external call is a hard failure.
 */

const PASSWORD = 'integration-panel-password';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

interface Fixture {
  readonly home: string;
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly replayInvocation: Mock;
  readonly seed: ReturnType<typeof seedAdminFixture>;
  readonly baseUrl: string;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-cli-login-http-'));
  const home = await mkdtemp(join(tmpdir(), 'plasticwan-cli-login-home-'));
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
    }),
  );
  const loaded = await loadConfig(configPath);
  const admin = loaded.config.admin;
  if (admin === undefined) {
    throw new Error('fixture config has no admin block');
  }
  // The config schema pins admin.port >= 1; the in-memory snapshot uses 0 so
  // the real listener binds an OS-assigned loopback port for this test.
  admin.port = 0;
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const seed = seedAdminFixture(store);
  const secrets = new SecretStore();
  const replayInvocation = vi.fn(async () => {
    throw new Error('replay must not run for login or doctor');
  });
  const server = new AdminServer({ store, configStore, secrets, replayInvocation });
  const listening = await server.start();
  cleanup.push(async () => {
    await server.stop();
  });
  cleanup.push(async () => {
    store.close();
  });
  cleanup.push(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  cleanup.push(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    home,
    store,
    server,
    replayInvocation,
    seed,
    baseUrl: `http://127.0.0.1:${listening.port}`,
  };
}

/** Every non-internal table and all of its rows, for before/after comparison. */
function stateRows(store: SqliteStore): Record<string, unknown[]> {
  const names = store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}

/** The API key layer records use, which is the one expected auth write. */
function productionTables(rows: Record<string, unknown[]>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(rows).filter(([name]) => name !== 'admin_api_keys'));
}

function apiKeyRow(store: SqliteStore, id: string) {
  return store.db
    .prepare<[bigint], { token_hash: string; last_used_at: string | null; revoked_at: string | null }>(
      'SELECT token_hash, last_used_at, revoked_at FROM admin_api_keys WHERE id = ?',
    )
    .get(BigInt(id));
}

function fetchTarget(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function asObject(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`expected a JSON object body, got HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

interface AdminSessionFixture {
  readonly cookie: string;
  /** Plaintext key: fixture-only, never printed by this test. */
  readonly key: string;
  readonly keyId: string;
}

/** Real HTTP: unauthenticated session check, first-user setup, then key creation. */
async function setupAdminSession(baseUrl: string): Promise<AdminSessionFixture> {
  const session = await fetch(`${baseUrl}/api/auth/session`);
  expect(session.status).toBe(200);
  expect(await asObject(session)).toMatchObject({ setup_required: true, authenticated: false, username: null });

  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  });
  expect(setup.status).toBe(200);
  const setCookie = setup.headers.get('set-cookie');
  if (setCookie === null || setCookie.length === 0) {
    throw new Error('admin setup returned no session cookie');
  }
  const cookie = setCookie.slice(0, setCookie.indexOf(';'));

  const createdResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'cli-login-http' }),
  });
  expect(createdResponse.status).toBe(200);
  const created = await asObject(createdResponse);
  const item = created.item;
  const key = created.key;
  if (typeof key !== 'string' || typeof item !== 'object' || item === null) {
    throw new Error('key creation did not return a plaintext key');
  }
  expect(item).toMatchObject({ last_used_at: null, revoked_at: null });
  const keyId = (item as { readonly id?: unknown }).id;
  if (typeof keyId !== 'string') {
    throw new Error('key creation did not return a key id');
  }
  return { cookie, key, keyId };
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** In-process CLI on a temp HOME: no real env and no real saved credentials. */
async function cli(args: readonly string[], homeDir: string): Promise<CliResult> {
  const output = { stdout: '', stderr: '' };
  const code = await runCli(args, {
    homeDir,
    env: {},
    io: {
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    },
  });
  return { code, ...output };
}

test('login, doctor and reads over the real Admin API leave production state alone and revocation locks the CLI out', async () => {
  const f = await fixture();
  // `server.start()` routes every real request through `handle`, so the spy is
  // a complete record of what the CLI sent over the loopback listener.
  const handleSpy = vi.spyOn(f.server, 'handle');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  cleanup.push(async () => {
    handleSpy.mockRestore();
  });
  cleanup.push(async () => {
    fetchSpy.mockRestore();
  });

  const admin = await setupAdminSession(f.baseUrl);
  expect(handleSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  handleSpy.mockClear();

  // login stores the pair locally and must not touch the Admin API.
  const login = await cli(['login', '--endpoint', f.baseUrl, '--api-key', admin.key, '--json'], f.home);
  expect(login.code).toBe(0);
  expect(login.stderr).toBe('');
  expect(JSON.parse(login.stdout)).toEqual({
    status: 'saved',
    endpoint: `${f.baseUrl}/`,
    credentials_file: credentialsPath(f.home),
  });
  expect(login.stdout).not.toContain(admin.key);
  expect(handleSpy.mock.calls).toHaveLength(0);
  expect(JSON.parse(await readFile(credentialsPath(f.home), 'utf8'))).toEqual({
    endpoint: `${f.baseUrl}/`,
    apiKey: admin.key,
  });

  // Baseline after the panel setup wrote its own rows, before any CLI request.
  const before = stateRows(f.store);
  const keyBefore = apiKeyRow(f.store, admin.keyId);
  expect(keyBefore).toMatchObject({ last_used_at: null, revoked_at: null });

  const doctor = await cli(['doctor', '--json'], f.home);
  expect(doctor.code).toBe(0);
  expect(doctor.stderr).toBe('');
  expect(JSON.parse(doctor.stdout)).toEqual({
    status: 'ok',
    endpoint: `${f.baseUrl}/`,
    credential_sources: { endpoint: 'file', api_key: 'file' },
  });
  expect(doctor.stdout).not.toContain(admin.key);

  // Exactly one GET, the documented read-only probe, carrying the saved key.
  expect(handleSpy.mock.calls).toHaveLength(1);
  const probe = handleSpy.mock.calls[0]?.[0];
  if (probe === undefined) {
    throw new Error('doctor sent no request through the admin server');
  }
  expect(probe.method).toBe('GET');
  const probeUrl = new URL(probe.url);
  expect(probeUrl.pathname).toBe('/api/invocations');
  expect([...probeUrl.searchParams.entries()]).toEqual([['limit', '1']]);
  expect(probe.headers.get('authorization')).toBe(`Bearer ${admin.key}`);

  // The probe may only move the key's own last_used_at; nothing else changes.
  const keyAfter = apiKeyRow(f.store, admin.keyId);
  expect(keyAfter).toMatchObject({ token_hash: keyBefore?.token_hash, revoked_at: null });
  expect(keyAfter?.last_used_at).toEqual(expect.any(String));
  const afterDoctor = stateRows(f.store);
  expect(Object.keys(afterDoctor)).toEqual(Object.keys(before));
  expect(productionTables(afterDoctor)).toEqual(productionTables(before));

  // The saved pair, with no env or flags, drives list and get as well.
  const list = await cli(['invocation', 'list', '--limit', '10', '--json'], f.home);
  expect(list.code).toBe(0);
  expect(list.stderr).toBe('');
  const listing = JSON.parse(list.stdout) as { items: { id: string }[]; next_cursor: string | null };
  expect(listing.items.map((item) => item.id)).toContain(f.seed.invocationA.toString());
  expect(list.stdout).not.toContain(admin.key);

  const get = await cli(['invocation', 'get', f.seed.invocationA.toString(), '--json'], f.home);
  expect(get.code).toBe(0);
  expect(get.stderr).toBe('');
  expect(JSON.parse(get.stdout)).toMatchObject({ id: f.seed.invocationA.toString(), state: 'completed' });

  expect(handleSpy.mock.calls.map(([request]) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    'GET /api/invocations',
    'GET /api/invocations',
    `GET /api/invocations/${f.seed.invocationA}`,
  ]);
  expect(f.replayInvocation).not.toHaveBeenCalled();
  expect(productionTables(stateRows(f.store))).toEqual(productionTables(before));

  // Revoke through the panel session, then prove the CLI is locked out.
  const revoked = await fetch(`${f.baseUrl}/api/api-keys/${admin.keyId}`, {
    method: 'DELETE',
    headers: { cookie: admin.cookie },
  });
  expect(revoked.status).toBe(200);
  const beforeRefused = stateRows(f.store);
  handleSpy.mockClear();

  const refused = await cli(['doctor', '--json'], f.home);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe('');
  expect(JSON.parse(refused.stderr)).toMatchObject({ error: 'unauthenticated' });
  expect(refused.stderr).not.toContain(admin.key);
  expect(handleSpy.mock.calls).toHaveLength(1);
  expect(f.replayInvocation).not.toHaveBeenCalled();
  // A refused probe writes nothing at all, not even last_used_at.
  expect(stateRows(f.store)).toEqual(beforeRefused);

  // Every request this process made went to the loopback panel: no provider,
  // Telegram, or other external service was contacted.
  const fetched = fetchSpy.mock.calls.map(([input]) => fetchTarget(input));
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((url) => url.startsWith(`${f.baseUrl}/`))).toBe(true);
}, 120_000);
