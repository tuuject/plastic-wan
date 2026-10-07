import { afterAll, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { AdminAuth } from '../src/ingress/admin/auth.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../src/platform/config.ts';
import { readConfigRevision } from '../src/platform/config-file.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { attachBucketToInvocation } from '../src/orchestration/invocation-queue.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { enterSleep } from '../src/store/sleep.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { sleep, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly directory: string;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeFile(join(staticDir, 'static', 'app.js'), "console.log('admin');");
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
      config.telegram.admins = [7, 42];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return { store, server: new AdminServer({ store, configStore }), loaded, configStore, directory };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

// Audit payloads are asserted structurally, so a loose type keeps assertions readable.
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

test('admin panel demands first-run setup, then authenticates and revokes sessions', async () => {
  const { store, server } = await fixture();
  try {
    const initial = await readJson(await server.handle(request('/api/auth/session')));
    expect(initial).toEqual({
      setup_required: true,
      authenticated: false,
      username: null,
      expires_at: null,
      passkeys_enabled: false,
      has_password: null,
    });

    const unauthenticated = await server.handle(request('/api/invocations'));
    expect(unauthenticated.status).toBe(401);
    expect(await readJson(unauthenticated)).toMatchObject({ error: 'unauthenticated' });

    const weak = await server.handle(post('/api/auth/setup', { username: 'owner', password: 'short' }));
    expect(weak.status).toBe(400);
    expect(await readJson(weak)).toMatchObject({ error: 'invalid_password' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_users').get()?.count).toBe(0n);

    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    expect(created.status).toBe(200);
    const cookie = sessionCookie(created);
    expect(created.headers.get('set-cookie')).toContain('HttpOnly');
    expect(created.headers.get('set-cookie')).toContain('SameSite=Strict');

    const repeat = await server.handle(post('/api/auth/setup', { username: 'other', password: PASSWORD }));
    expect(repeat.status).toBe(409);
    expect(await readJson(repeat)).toMatchObject({ error: 'setup_complete' });

    const session = await readJson(await server.handle(request('/api/auth/session', { headers: { cookie } })));
    expect(session).toMatchObject({ setup_required: false, authenticated: true, username: 'owner' });

    const authorized = await server.handle(request('/api/invocations', { headers: { cookie } }));
    expect(authorized.status).toBe(200);
    expect(await readJson(authorized)).toEqual({ items: [], next_cursor: null });

    expect((await server.handle(post('/api/auth/logout', {}, cookie))).status).toBe(200);
    const afterLogout = await server.handle(request('/api/invocations', { headers: { cookie } }));
    expect(afterLogout.status).toBe(401);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_sessions').get()?.count).toBe(
      0n,
    );
  } finally {
    store.close();
  }
});

test('admin login persists only hashes and rejects invalid credentials', async () => {
  const { store, server } = await fixture();
  try {
    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    const token = cookie.slice(cookie.indexOf('=') + 1);

    const stored = store.db.prepare<[], { password_hash: string }>('SELECT password_hash FROM admin_users').get();
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored?.password_hash).not.toContain(PASSWORD);
    const sessionRow = store.db.prepare<[], { token_hash: string }>('SELECT token_hash FROM admin_sessions').get();
    expect(sessionRow?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionRow?.token_hash).not.toBe(token);

    const wrongPassword = await server.handle(
      post('/api/auth/login', { username: 'owner', password: 'wrong-password-value' }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(await readJson(wrongPassword)).toMatchObject({ error: 'invalid_credentials' });
    const unknownUser = await server.handle(post('/api/auth/login', { username: 'ghost', password: PASSWORD }));
    expect(unknownUser.status).toBe(401);
    expect(await readJson(unknownUser)).toMatchObject({ error: 'invalid_credentials' });

    const loggedIn = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(loggedIn.status).toBe(200);
    const second = sessionCookie(loggedIn);
    expect(second).not.toBe(cookie);
    expect((await server.handle(request('/api/auth/session', { headers: { cookie: second } }))).status).toBe(200);
    expect(
      store.db.prepare<[], { last_login_at: string | null }>('SELECT last_login_at FROM admin_users').get()
        ?.last_login_at,
    ).not.toBeNull();

    const crossOrigin = await server.handle(
      request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.test' },
        body: JSON.stringify({ username: 'owner', password: PASSWORD }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });
  } finally {
    store.close();
  }
});

test('the login lockout cannot be dodged by rotating X-Forwarded-For or usernames', async () => {
  const { store, server } = await fixture();
  try {
    await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await server.handle(
        request('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${attempt}` },
          body: JSON.stringify({ username: `guess${attempt}`, password: 'wrong-password-value' }),
        }),
      );
      expect(failed.status).toBe(401);
    }
    const locked = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(locked.status).toBe(429);
    expect(await readJson(locked)).toMatchObject({ error: 'too_many_attempts' });
    // Another transport peer has its own bucket.
    expect(
      (await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }), '198.51.100.7')).status,
    ).toBe(200);
  } finally {
    store.close();
  }
}, 30_000);

test('concurrent failures all count, and an expired lockout starts a fresh count', async () => {
  const { store } = await fixture();
  try {
    const auth = new AdminAuth(store.orm, 12);
    const start = new Date('2026-09-26T00:00:00.000Z');
    await auth.createFirstUser({ username: 'owner', password: PASSWORD }, start);
    const wrong = (at: Date) => auth.login({ username: 'owner', password: 'wrong-password-value' }, at, 'peer');
    // Two at once used to compute the same next count from one snapshot.
    await Promise.allSettled([wrong(start), wrong(start)]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(wrong(start)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    await expect(auth.login({ username: 'owner', password: PASSWORD }, start, 'peer')).rejects.toMatchObject({
      code: 'too_many_attempts',
    });

    // After the lockout the count starts over instead of re-locking on the
    // very next mistake.
    const later = new Date(start.getTime() + 15 * 60_000 + 1);
    await expect(wrong(later)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(wrong(later)).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(typeof (await auth.login({ username: 'owner', password: PASSWORD }, later, 'peer'))).toBe('string');
  } finally {
    store.close();
  }
}, 30_000);

test('request bodies are limited by bytes as they stream in', async () => {
  const { store, server } = await fixture();
  try {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4_096).fill(0x20));
      },
    });
    const chunked = await server.handle(
      request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: endless,
        duplex: 'half',
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(10);

    // 3,000 three-byte characters are ~9 KiB but only ~3,000 UTF-16 units.
    const multibyte = await server.handle(post('/api/auth/login', { username: '\u4e2d'.repeat(3_000), password: 'x' }));
    expect(multibyte.status).toBe(413);
  } finally {
    store.close();
  }
});

test('session cookies are Secure when the browser is on HTTPS', async () => {
  const { store, server } = await fixture();
  try {
    const plain = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    expect(plain.headers.get('set-cookie')).not.toContain('Secure');

    // Behind a TLS-terminating proxy only the Origin shows the page is on HTTPS.
    const https = (path: string, body: unknown): Request =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://127.0.0.1:8899' },
        body: JSON.stringify(body),
      });
    const login = await server.handle(https('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/; Secure(;|$)/);
    const logout = await server.handle(https('/api/auth/logout', {}));
    expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(logout.headers.get('set-cookie')).toContain('Secure');
  } finally {
    store.close();
  }
});

test('login verifies a legacy Bun.password hash with the argon2 runtime', async () => {
  const { store, server } = await fixture();
  try {
    // PHC fixture generated by Bun 1.4.0 with
    // `Bun.password.hash('legacy-admin-passphrase', { algorithm: 'argon2id' })`.
    // Accounts created before the @node-rs/argon2 switch must keep logging in.
    const legacyHash =
      '$argon2id$v=19$m=65536,t=2,p=1$qqFrECrTOHeD0MZPyFSrw5qy1PwJmdOjo25xGu12zo0$xBM+zfhLz2zdpwT8CwseqbDa0Y9/3K4B7RRxYwmSzEc';
    const now = new Date().toISOString();
    store.db
      .prepare(
        'INSERT INTO admin_users (username, password_hash, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy', legacyHash, now, now, now);

    const ok = await server.handle(
      post('/api/auth/login', { username: 'legacy', password: 'legacy-admin-passphrase' }),
    );
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({ status: 'ok' });

    const wrong = await server.handle(
      post('/api/auth/login', { username: 'legacy', password: 'not-the-legacy-passphrase' }),
    );
    expect(wrong.status).toBe(401);
    expect(await readJson(wrong)).toMatchObject({ error: 'invalid_credentials' });
  } finally {
    store.close();
  }
});

test('admin can change username and password from an authenticated session', async () => {
  const { store, server } = await fixture();
  try {
    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    const otherLogin = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    const otherCookie = sessionCookie(otherLogin);
    const updated = await server.handle(
      post('/api/auth/credentials', { username: 'new-owner', password: 'new-correct-horse-battery' }, cookie),
    );
    expect(updated.status).toBe(200);
    const refreshedCookie = sessionCookie(updated);
    expect(refreshedCookie).not.toBe(cookie);

    const currentSession = await readJson(
      await server.handle(request('/api/auth/session', { headers: { cookie: refreshedCookie } })),
    );
    expect(currentSession).toMatchObject({ authenticated: true, username: 'new-owner' });
    expect((await server.handle(request('/api/invocations', { headers: { cookie: otherCookie } }))).status).toBe(401);
    expect((await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }))).status).toBe(401);
    expect(
      (await server.handle(post('/api/auth/login', { username: 'new-owner', password: 'new-correct-horse-battery' })))
        .status,
    ).toBe(200);

    const stored = store.db
      .prepare<[], { username: string; password_hash: string }>('SELECT username, password_hash FROM admin_users')
      .get();
    expect(stored?.username).toBe('new-owner');
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored?.password_hash).not.toContain('new-correct-horse-battery');
  } finally {
    store.close();
  }
});

test('audit routes expose tool sessions, messages and sticker cache', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const received = new Date('2026-03-01T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello audit panel'), received);
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected an invocation');
    }
    const iso = received.toISOString();
    store.db
      .prepare(
        "UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ?, completion_reason = 'done', turns_used = 1, tool_calls_used = 1, sends_used = 1, tool_registry_json = ? WHERE id = ?",
      )
      .run(
        received.toISOString(),
        received.toISOString(),
        JSON.stringify([
          { name: 'send', label: 'Send to Telegram', description: 'Send one plain-text message' },
          { name: 'add_memory', label: 'Add memory', description: 'Save a short-term note' },
        ]),
        invocationId,
      );
    store.db
      .prepare(
        "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, duration_ms, created_at, finished_at) VALUES (?, 'call-1', 'send', '{\"text\":\"hi\"}', 'sent', 'success', 1, 42, ?, ?)",
      )
      .run(invocationId, iso, iso);
    const toolRow = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM tool_calls WHERE tool_call_id = 'call-1'")
      .get();
    if (toolRow === undefined) {
      throw new Error('Expected the tool call row');
    }
    store.db
      .prepare(
        "INSERT INTO telegram_sends(tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (?, (SELECT conversation_id FROM invocations WHERE id = ?), 'text', '{\"text\":\"hi\"}', 'success', 555, ?, ?)",
      )
      .run(toolRow.id, invocationId, iso, iso);
    store.db
      .prepare(
        "INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, duration_ms, error_code, error_detail, tools_json, created_at, finished_at) VALUES (?, 'agent', 'agent', 'agent-model', 1, 'error', 100, 20, 500, 30, 620, 0.5, 900, 'model_error', 'status=500\nbody={\"error\":\"upstream exploded\"}', ?, ?, ?)",
      )
      .run(invocationId, JSON.stringify(['send', 'add_memory']), iso, iso);
    store.db
      .prepare(
        "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, created_at) VALUES (?, 1, 'assistant', 'private reasoning', ?)",
      )
      .run(invocationId, iso);
    store.db
      .prepare(
        "INSERT INTO sticker_sets(alias, telegram_name, title, configured, sync_state, last_synced_at, updated_at) VALUES ('cats', 'CatPack', 'Cat Pack', 1, 'success', ?, ?)",
      )
      .run(iso, iso);
    store.db
      .prepare(
        "INSERT INTO media_analyses(file_unique_id, analysis_version, provider, model, prompt_version, kind, state, description, metadata_json, created_at, updated_at) VALUES ('uniq-1', 'v1', 'vision', 'vision-model', 1, 'sticker', 'success', 'a grinning cat', '{\"tags_en\":[\"cat\"]}', ?, ?)",
      )
      .run(iso, iso);
    const analysis = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM media_analyses WHERE file_unique_id = 'uniq-1'")
      .get();
    if (analysis === undefined) {
      throw new Error('Expected the analysis row');
    }
    store.db
      .prepare(
        "INSERT INTO stickers(sticker_set_id, file_unique_id, file_id, emoji, format, active, current_analysis_id, index_state, updated_at) VALUES ((SELECT id FROM sticker_sets WHERE alias = 'cats'), 'uniq-1', 'file-1', '😺', 'static', 1, ?, 'success', ?)",
      )
      .run(analysis.id, iso);

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };

    const invocations = await readJson(await server.handle(request('/api/invocations', { headers })));
    expect(invocations.items).toHaveLength(1);
    expect(invocations.items[0]).toMatchObject({
      id: invocationId.toString(),
      tool_call_count: 1,
      // Budget definition: input + output + cache read + cache write.
      total_tokens: 650,
      cache_read_tokens: 500,
      cache_write_tokens: 30,
      chat: { telegram_chat_id: '123456789', type: 'private' },
    });

    const detail = await readJson(await server.handle(request(`/api/invocations/${invocationId}`, { headers })));
    expect(detail.tool_calls[0]).toMatchObject({
      tool_name: 'send',
      state: 'success',
      side_effect: true,
      duration_ms: 42,
    });
    expect(detail.tool_registry).toHaveLength(2);
    expect(detail.tool_registry[0]).toMatchObject({ name: 'send', label: 'Send to Telegram' });
    expect(detail.tool_registry[1]?.description).toBe('Save a short-term note');
    expect(detail.model_calls[0]).toMatchObject({
      provider: 'agent',
      model: 'agent-model',
      state: 'error',
      // The provider's raw total is kept for audit but never trusted as the sum.
      total_tokens: 650,
      provider_total_tokens: 620,
      cache_read_tokens: 500,
      cache_write_tokens: 30,
      error_code: 'model_error',
      error_detail: 'status=500\nbody={"error":"upstream exploded"}',
    });
    expect(detail.model_calls[0].tools).toEqual(['send', 'add_memory']);
    expect(detail.agent_messages[0]).toMatchObject({ role: 'assistant', text: 'private reasoning' });
    expect(detail.telegram_sends[0]).toMatchObject({ kind: 'text', state: 'success', telegram_message_id: '555' });
    expect(detail.context_messages.some((entry: { section: string }) => entry.section === 'new')).toBe(true);

    const missing = await server.handle(request('/api/invocations/999999', { headers }));
    expect(missing.status).toBe(404);
    const badId = await server.handle(request('/api/invocations/not-a-number', { headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });

    const messages = await readJson(await server.handle(request('/api/messages?search=audit', { headers })));
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0]).toMatchObject({
      telegram_message_id: '10',
      text: 'hello audit panel',
      revision_count: 1,
      sender: { telegram_id: '42', telegram_type: 'user', display_name: 'Alice' },
    });
    const filteredOut = await readJson(await server.handle(request('/api/messages?search=absent-text', { headers })));
    expect(filteredOut.items).toHaveLength(0);
    const messageDetail = await readJson(
      await server.handle(request(`/api/messages/${messages.items[0].id}`, { headers })),
    );
    expect(messageDetail.revisions[0]).toMatchObject({
      revision_no: 1,
      text: 'hello audit panel',
      sender: { telegram_id: '42', telegram_type: 'user', display_name: 'Alice' },
    });

    const sets = await readJson(await server.handle(request('/api/sticker-sets', { headers })));
    expect(sets.items[0]).toMatchObject({ alias: 'cats', sync_state: 'success', sticker_count: 1, indexed_count: 1 });
    const stickers = await readJson(
      await server.handle(request('/api/stickers?set=cats&state=success&search=grinning', { headers })),
    );
    expect(stickers.items).toHaveLength(1);
    expect(stickers.items[0]).toMatchObject({
      set_alias: 'cats',
      file_unique_id: 'uniq-1',
      index_state: 'success',
      analysis: { provider: 'vision', model: 'vision-model', description: 'a grinning cat', prompt_version: 1 },
    });
    const otherSet = await readJson(await server.handle(request('/api/stickers?set=dogs', { headers })));
    expect(otherSet.items).toHaveLength(0);

    const chat = store.db.prepare<[], { id: bigint }>('SELECT id FROM chats WHERE telegram_chat_id = 123456789').get();
    if (chat === undefined) {
      throw new Error('Expected the chat row');
    }
    store.db.prepare('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)').run(chat.id, iso);
    const sleeping = enterSleep(store.orm);

    const overview = await readJson(await server.handle(request('/api/overview', { headers })));
    expect(overview.invocation_states).toContainEqual({ label: 'completed', count: 1 });
    expect(overview.top_tools).toContainEqual({ label: 'send', count: 1 });
    expect(overview.message_count).toBe(1);
    expect(overview.cached_analysis_count).toBe(1);
    expect(overview.runtime_status).toEqual({
      sleeping: true,
      sleep_until: sleeping.sleepUntil,
      paused_chats: [
        {
          telegram_chat_id: '123456789',
          type: 'private',
          title: null,
          username: null,
          paused_at: iso,
        },
      ],
    });

    const awakened = await server.handle(post('/api/wake', {}, cookie));
    expect(awakened.status).toBe(200);
    expect(await readJson(awakened)).toEqual({ status: 'awake', was_sleeping: true });
    expect((await readJson(await server.handle(request('/api/overview', { headers })))).runtime_status).toMatchObject({
      sleeping: false,
      sleep_until: null,
    });
    expect(await readJson(await server.handle(post('/api/wake', {}, cookie)))).toEqual({
      status: 'awake',
      was_sleeping: false,
    });

    const now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', '123456789', 'model_tokens', 500, ?)",
      )
      .run(now.slice(0, 10), now);

    // Invocation and tool-call counts are read straight from the audit tables,
    // so date them into the requested window instead of writing daily_usage.
    store.db.prepare('UPDATE invocations SET created_at = ?').run(now);
    store.db.prepare('UPDATE tool_calls SET created_at = ?').run(now);

    const usage = await readJson(await server.handle(request('/api/usage?days=7', { headers })));
    expect(usage.days).toBe(7);
    expect(usage.series.length).toBe(7);
    const today = now.slice(0, 10);
    const todayEntry = usage.series.find((entry: { date: string }) => entry.date === today);
    expect(todayEntry).toMatchObject({ date: today, model_tokens: 500, agent_invocations: 1, tool_calls: 1 });

    const invalidDays = await server.handle(request('/api/usage?days=0', { headers }));
    expect(invalidDays.status).toBe(400);
    const tooManyDays = await server.handle(request('/api/usage?days=365', { headers }));
    expect(tooManyDays.status).toBe(400);

    const rejectedLimit = await server.handle(request('/api/invocations?limit=500', { headers }));
    expect(rejectedLimit.status).toBe(400);
    expect(await readJson(rejectedLimit)).toMatchObject({ error: 'invalid_limit' });
    const rejectedFilter = await server.handle(request("/api/stickers?state=success'%20OR%201=1", { headers }));
    expect(rejectedFilter.status).toBe(400);
    expect(await readJson(rejectedFilter)).toMatchObject({ error: 'invalid_state' });
    const writeAttempt = await server.handle(post('/api/invocations', {}, cookie));
    expect(writeAttempt.status).toBe(405);
  } finally {
    store.close();
  }
});

test('context API exposes conversation contexts read-only', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const received = new Date('2026-03-02T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'context audit'), received);

    const conversation = store.db
      .prepare<[], { id: bigint; chat_id: bigint }>('SELECT id, chat_id FROM conversations')
      .get();
    if (conversation === undefined) {
      throw new Error('Expected the conversation row');
    }
    const iso = received.toISOString();
    const olderIso = new Date(received.getTime() - 60_000).toISOString();
    const expiresIso = new Date(received.getTime() + 3_600_000).toISOString();
    store.db
      .prepare('INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 7, ?, ?)')
      .run(conversation.chat_id, iso, iso);
    const second = store.db
      .prepare<[], { id: bigint }>('SELECT id FROM conversations WHERE message_thread_id = 7')
      .get();
    if (second === undefined) {
      throw new Error('Expected the second conversation row');
    }
    store.db
      .prepare(
        "INSERT INTO conversation_contexts(conversation_id, head_seq, next_seq, send_count_total, system_prompt_hash, last_active_at, last_gc_at, created_at, updated_at) VALUES (?, 2, 4, 1, 'prompt-hash', ?, NULL, ?, ?)",
      )
      .run(conversation.id, iso, iso, iso);
    store.db
      .prepare(
        "INSERT INTO conversation_contexts(conversation_id, head_seq, next_seq, send_count_total, system_prompt_hash, last_active_at, created_at, updated_at) VALUES (?, 1, 1, 0, 'other-hash', ?, ?, ?)",
      )
      .run(second.id, olderIso, olderIso, olderIso);
    const context = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversation_contexts ORDER BY id').get();
    if (context === undefined) {
      throw new Error('Expected the context row');
    }
    // seq 1 sits below head_seq: it is soft-evicted and must stay out of the detail payload.
    store.db
      .prepare(
        'INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, send_seq, est_tokens, evicted_at, created_at) VALUES (?, 1, \'user\', \'{"role":"user","text":"evicted"}\', NULL, 1, NULL, 3, ?, ?)',
      )
      .run(context.id, iso, iso);
    const longPayload = `{"role":"user","text":"${'x'.repeat(2_500)}"}`;
    store.db
      .prepare(
        "INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, send_seq, est_tokens, evicted_at, created_at) VALUES (?, 2, 'user', ?, NULL, 1, NULL, 12, NULL, ?)",
      )
      .run(context.id, longPayload, iso);
    store.db
      .prepare(
        "INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, send_seq, est_tokens, evicted_at, created_at) VALUES (?, 3, 'assistant', ?, NULL, 0, 1, 4, NULL, ?)",
      )
      .run(context.id, JSON.stringify({ role: 'assistant', text: 'ok' }), iso);
    store.db
      .prepare(
        "INSERT INTO context_refs(context_id, ref, kind, source_seq, media_id, sticker_file_id, target_conversation_id, target_thread_id, expires_at, created_at) VALUES (?, 'cap-1', 'media', 2, NULL, NULL, NULL, NULL, ?, ?)",
      )
      .run(context.id, expiresIso, iso);

    const unauthenticated = await server.handle(request('/api/contexts'));
    expect(unauthenticated.status).toBe(401);

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };

    const list = await readJson(await server.handle(request('/api/contexts', { headers })));
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({
      conversation_id: conversation.id.toString(),
      telegram_chat_id: '123456789',
      chat_type: 'private',
      chat_title: null,
      message_thread_id: 0,
      head_seq: 2,
      next_seq: 4,
      send_count_total: 1,
      message_count: 2,
      last_active_at: iso,
      last_gc_at: null,
      active_invocation_id: null,
    });
    expect(list.items[1]).toMatchObject({
      conversation_id: second.id.toString(),
      message_thread_id: 7,
      head_seq: 1,
      next_seq: 1,
      message_count: 0,
      last_active_at: olderIso,
    });

    const firstPage = await readJson(await server.handle(request('/api/contexts?limit=1', { headers })));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0].conversation_id).toBe(conversation.id.toString());
    expect(typeof firstPage.next_cursor).toBe('string');
    const secondPage = await readJson(
      await server.handle(
        request(`/api/contexts?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`, { headers }),
      ),
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].conversation_id).toBe(second.id.toString());
    expect(secondPage.next_cursor).toBeNull();

    const byChat = await readJson(await server.handle(request('/api/contexts?chat=123456789', { headers })));
    expect(byChat.items).toHaveLength(2);
    expect((await readJson(await server.handle(request('/api/contexts?chat=999', { headers })))).items).toHaveLength(0);
    // `search` and `conversation` are not context filters; unknown parameters are ignored.
    const unfiltered = await readJson(
      await server.handle(request(`/api/contexts?search=absent-title&conversation=${second.id}`, { headers })),
    );
    expect(unfiltered.items).toHaveLength(2);
    const badChat = await server.handle(request('/api/contexts?chat=abc', { headers }));
    expect(badChat.status).toBe(400);
    expect(await readJson(badChat)).toMatchObject({ error: 'invalid_chat' });
    const badCursor = await server.handle(request('/api/contexts?cursor=bad', { headers }));
    expect(badCursor.status).toBe(400);
    expect(await readJson(badCursor)).toMatchObject({ error: 'invalid_cursor' });
    const badLimit = await server.handle(request('/api/contexts?limit=0', { headers }));
    expect(badLimit.status).toBe(400);
    expect(await readJson(badLimit)).toMatchObject({ error: 'invalid_limit' });

    const detail = await readJson(await server.handle(request(`/api/contexts/${conversation.id}`, { headers })));
    expect(detail).toMatchObject({
      conversation_id: conversation.id.toString(),
      system_prompt_hash: 'prompt-hash',
      head_seq: 2,
      message_count: 2,
    });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]).toMatchObject({
      seq: 2,
      role: 'user',
      is_checkpoint: true,
      send_seq: null,
      est_tokens: 12,
      invocation_id: null,
      evicted_at: null,
    });
    expect(detail.messages[0].payload_preview).toHaveLength(2_000);
    expect(detail.messages[0].payload_truncated).toBe(true);
    expect(detail.messages[1]).toMatchObject({
      seq: 3,
      role: 'assistant',
      is_checkpoint: false,
      send_seq: 1,
      payload_truncated: false,
    });
    expect(detail.refs).toEqual([{ ref: 'cap-1', kind: 'media', source_seq: 2, expires_at: expiresIso }]);

    const missing = await server.handle(request('/api/contexts/999999', { headers }));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });
    const badId = await server.handle(request('/api/contexts/not-a-number', { headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });
    const writeAttempt = await server.handle(post('/api/contexts', {}, cookie));
    expect(writeAttempt.status).toBe(405);
  } finally {
    store.close();
  }
});

test('admin static serving falls back to index.html and refuses traversal', async () => {
  const { store, server } = await fixture();
  try {
    const index = await server.handle(request('/'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await index.text()).toContain('<title>admin</title>');

    const deepRoute = await server.handle(request('/invocations/42'));
    expect(deepRoute.status).toBe(200);
    expect(await deepRoute.text()).toContain('<title>admin</title>');

    const script = await server.handle(request('/static/app.js'));
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    const traversal = await server.handle(request('/../../config.jsonc'));
    expect(traversal.status).toBe(200);
    expect(await traversal.text()).not.toContain('telegram-secret');
  } finally {
    store.close();
  }
});

test('admin config accepts a non-loopback bind host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-host-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '0.0.0.0',
        port: 8899,
        session_ttl_hours: 12,
      };
    }),
  );
  // The operator owns the bind address, so a non-loopback host must load for
  // LAN/desktop deployments.
  await expect(loadConfig(configPath)).resolves.toMatchObject({
    config: { admin: { host: '0.0.0.0', port: 8899 } },
  });
});

test('admin can cancel all ongoing sessions', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const received = new Date('2026-03-01T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'backlogged'), received);
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected an invocation');
    }

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };

    const canceled = await server.handle(post('/api/cancel-ongoing-sessions', {}, cookie));
    expect(canceled.status).toBe(200);
    const body = await readJson(canceled);
    expect(body).toMatchObject({ canceled_buckets: 1, canceled_invocations: 1 });

    const bucketState = store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state;
    expect(bucketState).toBe('expired');
    const invocationState = store.db
      .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
      .get(invocationId)?.state;
    expect(invocationState).toBe('aborted');

    const overview = await readJson(await server.handle(request('/api/overview', { headers })));
    expect(overview.invocation_states).toContainEqual({ label: 'aborted', count: 1 });
  } finally {
    store.close();
  }
});

test('cancel ongoing aborts a running invocation without re-queuing its attached batch', async () => {
  const { store, configStore } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new BucketScheduler(store, configStore, async (_id, _snapshot, signal) => {
    await gate;
    return signal.aborted ? { state: 'aborted', reason: 'aborted' } : { state: 'completed', reason: 'done' };
  });
  const server = new AdminServer({ store, configStore, scheduler });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const invocationStates = (): string[] =>
    store.db
      .prepare<[], { state: string }>('SELECT state FROM invocations ORDER BY id')
      .all()
      .map((row) => row.state);
  const until = async (check: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) {
        return;
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  try {
    const start = new Date();
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    store.db.prepare('UPDATE buckets SET deadline_at = ?').run(new Date(start.getTime() - 1_000).toISOString());
    scheduler.start();
    await until(() => invocationStates()[0] === 'running', 'the running invocation');

    // A second batch attached mid-run and not yet injected.
    ingestion.ingest(textUpdate(2, 11, 'second'), new Date());
    const running = store.db
      .prepare<[], { id: bigint; conversation_id: bigint }>(
        "SELECT id, conversation_id FROM invocations WHERE state = 'running'",
      )
      .get()!;
    const attached = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM buckets WHERE state = 'collecting'")
      .get()!.id;
    attachBucketToInvocation(store, 20, running.id, attached, running.conversation_id, new Date());

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const canceled = await server.handle(post('/api/cancel-ongoing-sessions', {}, cookie));
    expect(canceled.status).toBe(200);
    expect(await readJson(canceled)).toMatchObject({ canceled_buckets: 1, canceled_invocations: 1 });

    release();
    await until(() => invocationStates()[0] === 'aborted', 'the aborted invocation');
    expect(invocationStates()).toEqual(['aborted']);
    const bucketStates = store.db
      .prepare<[], { id: bigint; state: string }>('SELECT id, state FROM buckets ORDER BY id')
      .all()
      .map((row) => [row.id === attached ? 'attached' : 'opening', row.state]);
    expect(bucketStates).toEqual([
      ['opening', 'aborted'],
      ['attached', 'expired'],
    ]);
  } finally {
    release();
    await scheduler.stop();
    store.close();
  }
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

test('message audit preserves Telegram sender IDs as strings and distinguishes user, channel and missing identity', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const userId = Number.MAX_SAFE_INTEGER;
    const user = textUpdate(1, 10, 'large sender ID');
    user.message!.from!.id = userId;
    const storedUser = ingestion.ingest(user);
    ingestion.ingest({
      update_id: 2,
      edited_message: { ...user.message!, text: 'edited large sender ID', edit_date: 1_700_000_100 },
    });
    const channel = textUpdate(3, 11, 'anonymous channel message');
    channel.message!.sender_chat = { id: -1009876543210, type: 'channel', title: 'Channel' };
    const storedChannel = ingestion.ingest(channel);
    const unknown = textUpdate(4, 12, 'no sender');
    const storedUnknown = ingestion.ingest(unknown);
    store.db
      .prepare('UPDATE message_revisions SET sender_id = NULL WHERE message_id = ?')
      .run(storedUnknown.messageId!);
    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };
    const listing = await readJson(await server.handle(request('/api/messages', { headers })));
    expect(
      listing.items.find((item: { id: string }) => item.id === storedUser.messageId?.toString())?.sender,
    ).toMatchObject({ telegram_id: userId.toString(), telegram_type: 'user', username: null });
    expect(
      listing.items.find((item: { id: string }) => item.id === storedChannel.messageId?.toString())?.sender,
    ).toMatchObject({ telegram_id: '-1009876543210', telegram_type: 'sender_chat', display_name: 'Channel' });
    expect(
      listing.items.find((item: { id: string }) => item.id === storedUnknown.messageId?.toString())?.sender,
    ).toBeNull();
    const detail = await readJson(await server.handle(request(`/api/messages/${storedUser.messageId}`, { headers })));
    expect(detail.revisions).toHaveLength(2);
    for (const revision of detail.revisions) {
      expect(revision.sender).toMatchObject({ telegram_id: '9007199254740991', telegram_type: 'user' });
    }
    const anonymous = await readJson(
      await server.handle(request(`/api/messages/${storedChannel.messageId}`, { headers })),
    );
    expect(anonymous.revisions[0].sender).toMatchObject({
      telegram_id: '-1009876543210',
      telegram_type: 'sender_chat',
    });
    const missing = await readJson(
      await server.handle(request(`/api/messages/${storedUnknown.messageId}`, { headers })),
    );
    expect(missing.revisions[0].sender).toBeNull();
  } finally {
    store.close();
  }
});

test('admins API manages the config whitelist and hot-applies it', async () => {
  const { store, loaded, configStore, directory } = await fixture();
  const configPath = join(directory, 'config.jsonc');
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader });
  try {
    const unauthenticated = await server.handle(request('/api/admins'));
    expect(unauthenticated.status).toBe(401);

    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    let revision = await readConfigRevision(configPath);
    const write = (path: string, method: string, body?: unknown): Request => {
      const headers: Record<string, string> = { cookie, 'if-match': revision };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      return request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };

    const initial = await readJson(await server.handle(request('/api/admins', { headers: { cookie } })));
    expect(initial.items).toEqual([{ telegram_user_id: '7' }, { telegram_user_id: '42' }]);

    const withoutRevision = await server.handle(
      request('/api/admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ telegram_user_id: 99 }),
      }),
    );
    expect(withoutRevision.status).toBe(400);
    expect(await readJson(withoutRevision)).toMatchObject({ error: 'revision_required' });

    const stale = await server.handle(
      request('/api/admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'if-match': 'stale' },
        body: JSON.stringify({ telegram_user_id: 99 }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });

    const invalid = await server.handle(write('/api/admins', 'POST', { telegram_user_id: -5 }));
    expect(invalid.status).toBe(400);
    expect(await readJson(invalid)).toMatchObject({ error: 'invalid_telegram_user_id' });

    const added = await readJson(await server.handle(write('/api/admins', 'POST', { telegram_user_id: 99 })));
    expect(added.items.map((item: { telegram_user_id: string }) => item.telegram_user_id)).toEqual(['7', '42', '99']);
    expect(added.apply.applied).toContain('telegram.admins');
    // Hot: the running configuration — and thus the command gate — already sees 99.
    expect(configStore.current().config.telegram.admins).toEqual([7, 42, 99]);
    // The file is the source of truth across restarts.
    expect((await loadConfig(configPath)).config.telegram.admins).toEqual([7, 42, 99]);

    revision = added.revision;
    const idempotent = await readJson(await server.handle(write('/api/admins', 'POST', { telegram_user_id: 99 })));
    expect(idempotent.items).toEqual(added.items);
    expect(idempotent.apply.applied).toEqual([]);

    const removed = await readJson(await server.handle(write('/api/admins/99', 'DELETE')));
    expect(removed.items.map((item: { telegram_user_id: string }) => item.telegram_user_id)).toEqual(['7', '42']);
    expect(configStore.current().config.telegram.admins).toEqual([7, 42]);
    revision = removed.revision;

    const missing = await server.handle(write('/api/admins/55', 'DELETE'));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });
  } finally {
    store.close();
  }
});

test('model API lists and switches the agent model through the config file', async () => {
  const { store, loaded, configStore, directory } = await fixture();
  const configPath = join(directory, 'config.jsonc');
  const switcher = new AgentModelSwitcher(configStore);
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, modelSwitcher: switcher, configReloader });
  try {
    const unauthenticated = await server.handle(
      request('/api/model', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    // The panel takes the revision from `GET /providers`; this test reads it the
    // same way the server computes it.
    const revision = await readConfigRevision(configPath);
    const call = (init: RequestInit = {}): Request =>
      request('/api/model', { ...init, headers: { ...init.headers, cookie } });
    const switchModel = (body: unknown): Request =>
      call({
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': revision },
        body: JSON.stringify(body),
      });

    // `GET /model` is gone with the Model page; the read now falls through to the
    // read-only audit branch.
    const removedGet = await server.handle(call());
    expect(removedGet.status).toBe(404);

    const withoutRevision = await server.handle(
      call({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'vision', model: 'vision-model' }),
      }),
    );
    expect(withoutRevision.status).toBe(400);
    expect(await readJson(withoutRevision)).toMatchObject({ error: 'revision_required' });

    const switched = await readJson(await server.handle(switchModel({ provider: 'vision', model: 'vision-model' })));
    // The vision model does not reason, so the switch resets the level to `off`.
    expect(switched.current).toMatchObject({
      provider: 'vision',
      model: 'vision-model',
      max_tokens: 8_192,
      thinking_level: 'off',
    });
    expect(switched.apply).toEqual({
      applied: ['agent.model', 'agent.provider', 'agent.thinking_level'],
      restart_required: [],
    });

    const malformed = await server.handle(switchModel({ provider: 'vision' }));
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: 'invalid_model_reference' });

    const unknownProvider = await server.handle(switchModel({ provider: 'ghost', model: 'agent-model' }));
    expect(unknownProvider.status).toBe(400);
    expect(await readJson(unknownProvider)).toMatchObject({ error: 'unknown_provider' });

    const unknownModel = await server.handle(switchModel({ provider: 'agent', model: 'ghost-model' }));
    expect(unknownModel.status).toBe(400);
    expect(await readJson(unknownModel)).toMatchObject({ error: 'unknown_model' });

    // The failed switches must not change the effective model.
    expect(switcher.current()).toMatchObject({ provider: 'vision', model: 'vision-model' });
    expect(configStore.current().config.agent).toMatchObject({ provider: 'vision', model: 'vision-model' });

    // There is no default to restore: the request falls through to the read-only 405.
    const removed = await server.handle(call({ method: 'DELETE' }));
    expect(removed.status).toBe(405);
  } finally {
    store.close();
  }
});
