import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { AdminQueryError } from '../src/ingress/admin/audit.ts';
import { AdminServer, type ReplayInvocationInput } from '../src/ingress/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface ReplayCall {
  readonly id: bigint;
  readonly input: ReplayInvocationInput;
  readonly signal: AbortSignal;
}

type ReplayFn = (id: bigint, input: ReplayInvocationInput, signal: AbortSignal) => Promise<unknown>;

interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly secrets: SecretStore;
  readonly calls: ReplayCall[];
}

async function fixture(replay?: ReplayFn): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-api-keys-'));
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
    }),
  );
  const loaded: LoadedConfig = await loadConfig(configPath);
  const configStore: RuntimeConfigurationStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore();
  const server =
    replay === undefined
      ? new AdminServer({ store, configStore, secrets })
      : new AdminServer({ store, configStore, secrets, replayInvocation: replay });
  return { store, server, secrets, calls: [] };
}

async function setupAdmin(server: AdminServer): Promise<string> {
  const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
  expect(created.status).toBe(200);
  return sessionCookie(created);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

async function readJson(response: Response): Promise<any> {
  return await response.json();
}

async function createKey(server: AdminServer, cookie: string, name = 'eval-cli'): Promise<any> {
  const response = await server.handle(post('/api/api-keys', { name }, { cookie }));
  expect(response.status).toBe(200);
  return await readJson(response);
}

test('API keys are shown once in plaintext and stored only as a SHA-256 digest', async () => {
  const { store, server, secrets } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie, 'evaluation tool');
    expect(created.key).toMatch(/^pwk_[A-Za-z0-9_-]{43}$/);
    expect(created.item).toEqual({
      id: expect.stringMatching(/^\d+$/),
      name: 'evaluation tool',
      prefix: created.key.slice(0, 12),
      created_at: expect.any(String),
      last_used_at: null,
      revoked_at: null,
    });

    const row = store.db
      .prepare<[], { name: string; prefix: string; token_hash: string; created_at: string }>(
        'SELECT name, prefix, token_hash, created_at FROM admin_api_keys',
      )
      .get();
    expect(row?.name).toBe('evaluation tool');
    expect(row?.prefix).toBe(created.key.slice(0, 12));
    expect(row?.token_hash).toBe(createHash('sha256').update(created.key).digest('hex'));
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    // The key material exists nowhere in the row, only its digest.
    expect(JSON.stringify(row)).not.toContain(created.key);

    // The listing repeats the metadata but never the secret.
    const listed = await server.handle(request('/api/api-keys', { headers: { cookie } }));
    expect(listed.status).toBe(200);
    const listing = await readJson(listed);
    expect(listing.items).toHaveLength(1);
    expect(Object.keys(listing.items[0]).sort()).toEqual([
      'created_at',
      'id',
      'last_used_at',
      'name',
      'prefix',
      'revoked_at',
    ]);
    expect(JSON.stringify(listing)).not.toContain(created.key);

    // The plaintext is registered for redaction, so it cannot leak through
    // error output later in the process lifetime.
    expect(secrets.redact(`upstream rejected ${created.key} for key`)).toBe('upstream rejected [REDACTED] for key');
  } finally {
    store.close();
  }
});

test('API key creation validates the TypeBox boundary and stays session-only', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const cases: readonly [unknown, string][] = [
      [{}, 'invalid_body'],
      [{ name: '' }, 'invalid_body'],
      [{ name: 'x'.repeat(81) }, 'invalid_body'],
      [{ name: 'ok', extra: true }, 'invalid_body'],
      [[{ name: 'ok' }], 'invalid_body'],
      ['not json', 'invalid_body'],
    ];
    for (const [body, code] of cases) {
      const response = await server.handle(post('/api/api-keys', body, { cookie }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await readJson(response)).toMatchObject({ error: code });
    }
    // Nothing was created by the rejected attempts.
    const count = store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_api_keys').get();
    expect(count?.count).toBe(0n);

    const unauthenticated = await server.handle(post('/api/api-keys', { name: 'nope' }));
    expect(unauthenticated.status).toBe(401);
    expect(await readJson(unauthenticated)).toMatchObject({ error: 'unauthenticated' });
  } finally {
    store.close();
  }
});

test('revocation disables a key immediately and keeps its metadata', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);

    const before = await server.handle(request('/api/invocations', { headers: bearer(created.key) }));
    expect(before.status).toBe(200);

    const revoked = await server.handle(
      request(`/api/api-keys/${created.item.id}`, { method: 'DELETE', headers: { cookie } }),
    );
    expect(revoked.status).toBe(200);
    const stored = store.db
      .prepare<[bigint], { revoked_at: string | null }>('SELECT revoked_at FROM admin_api_keys WHERE id = ?')
      .get(BigInt(created.item.id));
    expect(stored?.revoked_at).toEqual(expect.any(String));

    const after = await server.handle(request('/api/invocations', { headers: bearer(created.key) }));
    expect(after.status).toBe(401);
    expect(await readJson(after)).toMatchObject({ error: 'unauthenticated' });

    const listing = await readJson(await server.handle(request('/api/api-keys', { headers: { cookie } })));
    expect(listing.items[0]).toMatchObject({ id: created.item.id, revoked_at: expect.any(String) });
    expect(listing.items[0].last_used_at).toEqual(expect.any(String));

    // Revoking twice and revoking an unknown id are not idempotent no-ops.
    const again = await server.handle(
      request(`/api/api-keys/${created.item.id}`, { method: 'DELETE', headers: { cookie } }),
    );
    expect(again.status).toBe(404);
    const unknown = await server.handle(request('/api/api-keys/999999', { method: 'DELETE', headers: { cookie } }));
    expect(unknown.status).toBe(404);
    const malformed = await server.handle(
      request('/api/api-keys/not-a-number', { method: 'DELETE', headers: { cookie } }),
    );
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: 'invalid_id' });
  } finally {
    store.close();
  }
});

test('Bearer keys reach only the invocation read/replay surface', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    const auth = bearer(created.key);

    const list = await server.handle(request('/api/invocations', { headers: auth }));
    expect(list.status).toBe(200);
    expect(await readJson(list)).toEqual({ items: [], next_cursor: null });

    // The read-only model directory is part of the exact key surface.
    const models = await server.handle(request('/api/models', { headers: auth }));
    expect(models.status).toBe(200);
    expect(await readJson(models)).toMatchObject({
      source: 'active',
      generation: 1,
      models: expect.arrayContaining([expect.objectContaining({ provider: 'agent', model: 'agent-model' })]),
    });
    expect(
      JSON.stringify(await readJson(await server.handle(request('/api/models', { headers: auth })))),
    ).not.toContain('base_url');
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await server.handle(
        request('/api/invocations', {
          headers: { authorization: `${scheme} ${created.key}` },
        }),
      );
      expect(response.status).toBe(200);
    }

    const missing = await server.handle(request('/api/invocations/999999', { headers: auth }));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });
    const badId = await server.handle(request('/api/invocations/not-a-number', { headers: auth }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });

    // No replay engine is wired in this fixture.
    const replay = await server.handle(post('/api/invocations/1/replay', {}, auth));
    expect(replay.status).toBe(503);
    expect(await readJson(replay)).toMatchObject({ error: 'replay_unavailable' });

    // Every other route is refused, including key management, other audits and
    // every write surface of the panel.
    const forbidden: readonly [string, string][] = [
      ['GET', '/api/overview'],
      ['GET', '/api/usage'],
      ['GET', '/api/contexts'],
      ['GET', '/api/messages'],
      ['GET', '/api/stickers'],
      ['GET', '/api/alarms'],
      ['GET', '/api/memories'],
      ['GET', '/api/admins'],
      ['GET', '/api/developer'],
      ['GET', '/api/config/status'],
      ['GET', '/api/api-keys'],
      ['POST', '/api/api-keys'],
      ['DELETE', '/api/api-keys/1'],
      ['POST', '/api/invocations/1'],
      ['GET', '/api/invocations/1/replay'],
      ['PUT', '/api/model'],
      ['POST', '/api/config/apply'],
      ['POST', '/api/auth/credentials'],
      ['DELETE', '/api/developer/model-payloads'],
      ['POST', '/api/wake'],
      ['POST', '/api/models'],
      ['GET', '/api/unknown-route'],
    ];
    for (const [method, path] of forbidden) {
      const init: RequestInit =
        method === 'GET'
          ? { headers: auth }
          : { method, headers: { 'content-type': 'application/json', ...auth }, body: '{}' };
      const response = await server.handle(request(path, init));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await readJson(response), `${method} ${path}`).toMatchObject({ error: 'forbidden' });
    }
    // The refusal did not consume the cookie or create anything.
    const count = store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_api_keys').get();
    expect(count?.count).toBe(1n);
  } finally {
    store.close();
  }
});

test('an Authorization header never falls back to the cookie and cannot be upgraded by one', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);

    // Valid session + invalid key: the key wins, so the request is rejected
    // instead of silently using the cookie.
    const both = await server.handle(
      request('/api/invocations', { headers: { cookie, ...bearer('pwk_definitely-not-a-key') } }),
    );
    expect(both.status).toBe(401);
    expect(await readJson(both)).toMatchObject({ error: 'unauthenticated' });

    // Valid session + valid key is still limited to the key surface.
    const upgraded = await server.handle(request('/api/memories', { headers: { cookie, ...bearer(created.key) } }));
    expect(upgraded.status).toBe(403);
    expect(await readJson(upgraded)).toMatchObject({ error: 'forbidden' });

    const upgradedKeyManagement = await server.handle(
      post('/api/api-keys', { name: 'via-bearer' }, { cookie, ...bearer(created.key) }),
    );
    expect(upgradedKeyManagement.status).toBe(403);

    const basic = await server.handle(
      request('/api/invocations', { headers: { cookie, authorization: 'Basic dXNlcjpwYXNz' } }),
    );
    expect(basic.status).toBe(401);
    const empty = await server.handle(request('/api/invocations', { headers: { cookie, authorization: '' } }));
    expect(empty.status).toBe(401);
    const rawKey = await server.handle(
      request('/api/invocations', { headers: { cookie, authorization: created.key } }),
    );
    expect(rawKey.status).toBe(401);
    const unknown = await server.handle(request('/api/invocations', { headers: bearer('pwk_unknown') }));
    expect(unknown.status).toBe(401);
    expect(await readJson(unknown)).toEqual({
      error: 'unauthenticated',
      message: 'A valid API key is required',
    });
  } finally {
    store.close();
  }
});

test('replay accepts only editable templates, caps the body, and forwards the abort signal', async () => {
  const calls: ReplayCall[] = [];
  const { store, server } = await fixture(async (id, input, signal) => {
    calls.push({ id, input, signal });
    return { status: 'replayed' };
  });
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    const auth = bearer(created.key);

    const sessionOnly = await server.handle(post('/api/invocations/42/replay', {}, { cookie }));
    expect(sessionOnly.status).toBe(405);
    expect(await readJson(sessionOnly)).toMatchObject({ error: 'method_not_allowed' });
    expect(calls).toHaveLength(0);

    const replayRequest = post(
      '/api/invocations/42/replay',
      { global_prompt: 'Use the rubric.', group_prompt: 'Group tone.' },
      auth,
    );
    const response = await server.handle(replayRequest);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: 'replayed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(42n);
    expect(calls[0]?.input).toEqual({ global_prompt: 'Use the rubric.', group_prompt: 'Group tone.' });
    expect(calls[0]?.signal).toBe(replayRequest.signal);

    const empty = await server.handle(post('/api/invocations/7/replay', { group_prompt: '' }, auth));
    expect(empty.status).toBe(200);
    expect(calls[1]?.input).toEqual({ group_prompt: '' });

    const omitted = await server.handle(post('/api/invocations/7/replay', {}, auth));
    expect(omitted.status).toBe(200);
    expect(calls[2]?.input).toEqual({});

    const maxLength = await server.handle(
      post('/api/invocations/7/replay', { global_prompt: 'a'.repeat(65_536), group_prompt: 'b'.repeat(65_536) }, auth),
    );
    expect(maxLength.status).toBe(200);
    expect(calls[3]?.input.global_prompt).toHaveLength(65_536);
    expect(calls[3]?.input.group_prompt).toHaveLength(65_536);

    const invalid: readonly [unknown, number][] = [
      [{ system_prompt: 'not writable' }, 400],
      [{ global_prompt: 'a'.repeat(65_537) }, 400],
      [{ group_prompt: 'a'.repeat(65_537) }, 400],
      [{ global_prompt: '' }, 400],
      [{ global_prompt: 42 }, 400],
      [{ prompt: 'wrong field' }, 400],
      [{ global_prompt: 'ok', extra: true }, 400],
      [[], 400],
      ['just a string', 400],
      ['{', 400],
    ];
    for (const [body, status] of invalid) {
      const rejected = await server.handle(post('/api/invocations/7/replay', body, auth));
      expect(rejected.status, JSON.stringify(body).slice(0, 60)).toBe(status);
      expect(await readJson(rejected)).toMatchObject({ error: 'invalid_body' });
    }
    expect(calls).toHaveLength(4);

    // Body cap: declared Content-Length is refused before reading...
    const declared = await server.handle(
      post('/api/invocations/7/replay', { global_prompt: 'a'.repeat(1_048_576) }, auth),
    );
    expect(declared.status).toBe(413);
    expect(await readJson(declared)).toMatchObject({ error: 'body_too_large' });
    // ...and a chunked body without Content-Length is counted while it streams.
    const streamed = request('/api/invocations/7/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"global_prompt":"'));
          controller.enqueue(new TextEncoder().encode('a'.repeat(1_048_576)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const streamedResponse = await server.handle(streamed);
    expect(streamedResponse.status).toBe(413);

    // The request signal is the same object, and an aborted caller is visible
    // as aborted inside the engine.
    const controller = new AbortController();
    controller.abort();
    const abortedRequest = request('/api/invocations/9/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: '{}',
      signal: controller.signal,
    });
    const aborted = await server.handle(abortedRequest);
    expect(aborted.status).toBe(200);
    expect(calls.at(-1)?.signal.aborted).toBe(true);
    expect(calls.at(-1)?.id).toBe(9n);
  } finally {
    store.close();
  }
});

test('replay renders engine errors as AdminQueryError and redacts known failures', async () => {
  let failure = new AdminQueryError('invocation_not_found', 'Invocation does not exist', 404);
  const { store, server, secrets } = await fixture(async () => {
    throw failure;
  });
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    const response = await server.handle(post('/api/invocations/1/replay', {}, bearer(created.key)));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: 'invocation_not_found', message: 'Invocation does not exist' });
    // Simulate a key no longer in the process redaction cache, e.g. after restart.
    for (let index = 0; index < 64; index += 1) {
      secrets.remember(`unrelated-secret-${index}`);
    }
    expect(secrets.redact(created.key)).toBe(created.key);
    failure = new AdminQueryError(`failed_${created.key}`, `Engine echoed ${created.key}`, 409);
    const redacted = await server.handle(post('/api/invocations/1/replay', {}, bearer(created.key)));
    expect(redacted.status).toBe(409);
    expect(await readJson(redacted)).toEqual({ error: 'failed_[REDACTED]', message: 'Engine echoed [REDACTED]' });
  } finally {
    store.close();
  }
});

test('engine failures are logged without the key and answered with a fixed error', async () => {
  let leaked = '';
  const { store, server } = await fixture(async () => {
    throw new Error(`engine exploded with ${leaked}`);
  });
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    leaked = created.key;
    const response = await server.handle(post('/api/invocations/1/replay', {}, bearer(created.key)));
    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: 'internal_error', message: 'Admin request failed' });
    const logged = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('admin_request_failed');
    expect(logged).not.toContain(created.key);
    expect(logged).toContain('[REDACTED]');
  } finally {
    spy.mockRestore();
    store.close();
  }
});

test('malformed Origin headers are a clean 4xx and Origin still guards only writes', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const malformed = await server.handle(
      post('/api/api-keys', { name: 'origin' }, { cookie, origin: 'not a real origin' }),
    );
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: 'bad_origin' });

    const crossOrigin = await server.handle(
      post('/api/api-keys', { name: 'origin' }, { cookie, origin: 'http://evil.test' }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

    // No Origin at all is the CLI/non-browser path and stays accepted.
    const created = await createKey(server, cookie, 'no-origin');
    const withMalformedOriginRead = await server.handle(
      request('/api/invocations', { headers: { ...bearer(created.key), origin: 'not a real origin' } }),
    );
    expect(withMalformedOriginRead.status).toBe(200);
  } finally {
    store.close();
  }
});
