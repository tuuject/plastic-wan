import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, expect, test } from 'vitest';
import { unifiedPromptDiff } from '../src/ingress/admin/prompt-diff.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { attachBucketToInvocation } from '../src/orchestration/invocation-queue.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { recordPromptVersion, recordPromptVersionsFromConfig } from '../src/store/prompt-versions.ts';
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
  readonly reloader: ConfigReloader;
  readonly configStore: RuntimeConfigurationStore;
  readonly directory: string;
  readonly configPath: string;
}

async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-prompts-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      transform?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  // The composition root records the starting versions after the store opens;
  // mirror that so every test sees the startup recording behavior.
  recordPromptVersionsFromConfig(store.orm, loaded.config);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => recordPromptVersionsFromConfig(store.orm, configStore.current().config),
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader });
  return { store, server, reloader, configStore, directory, configPath };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function post(path: string, body: unknown, cookie?: string, ifMatch?: string): Request {
  return request(path, {
    method: 'POST',
    headers: promptHeaders(cookie, ifMatch),
    body: JSON.stringify(body),
  });
}

function put(path: string, body: unknown, cookie: string, ifMatch?: string): Request {
  return request(path, { method: 'PUT', headers: promptHeaders(cookie, ifMatch), body: JSON.stringify(body) });
}

function promptHeaders(cookie: string | undefined, ifMatch: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers['if-match'] = ifMatch;
  }
  return headers;
}

async function login(server: AdminServer): Promise<string> {
  const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
  const cookie = created.headers.get('set-cookie');
  if (cookie === null) {
    throw new Error('Expected a session cookie');
  }
  return cookie.slice(0, cookie.indexOf(';'));
}

// Audit payloads are asserted structurally, so a loose type keeps assertions readable.
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function textUpdate(updateId: number, messageId: number, chatId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat:
        chatId > 0
          ? { id: chatId, type: 'private', first_name: 'Owner' }
          : { id: chatId, type: 'group', title: 'E2E Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

test('unifiedPromptDiff groups changed lines into hunks with both line numbers', () => {
  const from = ['one', 'two', 'three', 'four', 'five'].join('\n');
  const to = ['one', 'two', 'THREE', 'four', 'five', 'six'].join('\n');
  expect(unifiedPromptDiff(from, to)).toEqual([
    {
      fromStart: 1,
      fromCount: 5,
      toStart: 1,
      toCount: 6,
      lines: [
        { type: 'context', text: 'one', fromLine: 1, toLine: 1 },
        { type: 'context', text: 'two', fromLine: 2, toLine: 2 },
        { type: 'removed', text: 'three', fromLine: 3, toLine: null },
        { type: 'added', text: 'THREE', fromLine: null, toLine: 3 },
        { type: 'context', text: 'four', fromLine: 4, toLine: 4 },
        { type: 'context', text: 'five', fromLine: 5, toLine: 5 },
        { type: 'added', text: 'six', fromLine: null, toLine: 6 },
      ],
    },
  ]);
  expect(unifiedPromptDiff('same', 'same')).toEqual([]);
  expect(unifiedPromptDiff('', 'added')).toEqual([
    {
      fromStart: 0,
      fromCount: 0,
      toStart: 1,
      toCount: 1,
      lines: [{ type: 'added', text: 'added', fromLine: null, toLine: 1 }],
    },
  ]);
  expect(unifiedPromptDiff('gone', '')).toEqual([
    {
      fromStart: 1,
      fromCount: 1,
      toStart: 0,
      toCount: 0,
      lines: [{ type: 'removed', text: 'gone', fromLine: 1, toLine: null }],
    },
  ]);
});

test('prompt versions deduplicate identical content and prune to the retained count', async () => {
  const { store } = await fixture();
  try {
    const orm = store.orm;
    // The startup load recorded the starting global prompt as version 1.
    const first = recordPromptVersion(orm, 'global', 0n, 'base', 'panel', 'first', 'owner');
    expect(first?.seq).toBe(2n);
    expect(recordPromptVersion(orm, 'global', 0n, 'base', 'panel', 'again', 'owner')).toBeNull();
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM prompt_versions WHERE scope = 'global'")
        .get()?.count,
    ).toBe(2n);
    for (let index = 0; index < 105; index += 1) {
      recordPromptVersion(orm, 'global', 0n, `content ${index}`, 'panel', undefined, 'owner');
    }
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM prompt_versions WHERE scope = 'global'")
        .get()?.count,
    ).toBe(100n);
    expect(
      store.db.prepare<[], { min: bigint }>("SELECT MIN(seq) AS min FROM prompt_versions WHERE scope = 'global'").get()
        ?.min,
    ).toBe(8n);
  } finally {
    store.close();
  }
});

test('prompt save applies the next invocation, records versions, diffs and restores', async () => {
  const { store, server, configStore, directory } = await fixture();
  try {
    const unauthenticated = await server.handle(request('/api/prompts/versions?scope=global'));
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(server);
    const startHash = configStore.current().hash;

    // API keys never reach the prompt surface.
    const key = await readJson(await server.handle(post('/api/api-keys', { name: 'probe' }, cookie)));
    const bearer = await server.handle(
      request('/api/prompts/versions?scope=global', { headers: { authorization: `Bearer ${key.key as string}` } }),
    );
    expect(bearer.status).toBe(403);

    const view = await readJson(
      await server.handle(request('/api/prompts/global?source=file', { headers: { cookie } })),
    );
    expect(view.prompt).toBe('Participate safely.');
    expect(view.content_hash).toHaveLength(64);

    const withoutMatch = await server.handle(put('/api/prompts/global', { prompt: 'New persona.' }, cookie));
    expect(withoutMatch.status).toBe(400);
    expect(await readJson(withoutMatch)).toMatchObject({ error: 'revision_required' });

    const stale = await server.handle(put('/api/prompts/global', { prompt: 'New persona.' }, cookie, 'deadbeef'));
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'prompt_conflict' });

    let versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.retained).toBe(100);
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({ seq: '1', source: 'external', created_by: null });
    const v1 = versions.items[0].id;

    const saved = await readJson(
      await server.handle(
        put('/api/prompts/global', { prompt: 'New persona.', note: 'tighten tone' }, cookie, view.content_hash),
      ),
    );
    expect(saved).toMatchObject({
      status: 'saved',
      affected_running: 0,
      context_rebuild: true,
      applied: ['agent.system_prompt_file'],
      restart_required: [],
    });
    expect(saved.version).toMatchObject({ seq: '2', source: 'panel', created_by: 'owner', note: 'tighten tone' });
    expect(await readFile(join(directory, 'agent-system-prompt.md'), 'utf8')).toBe('New persona.');
    expect(configStore.current().hash).not.toBe(startHash);
    const active = await readJson(
      await server.handle(request('/api/prompts/global?source=active', { headers: { cookie } })),
    );
    expect(active.prompt).toBe('New persona.');

    // Saving the file's current content back changes nothing.
    const savedView = await readJson(
      await server.handle(request('/api/prompts/global?source=file', { headers: { cookie } })),
    );
    const unchanged = await readJson(
      await server.handle(put('/api/prompts/global', { prompt: 'New persona.' }, cookie, savedView.content_hash)),
    );
    expect(unchanged).toMatchObject({ status: 'unchanged' });

    // Restoring version 1 appends a rollback version instead of deleting history.
    const restored = await readJson(
      await server.handle(post('/api/prompts/versions/' + v1 + '/restore', {}, cookie, savedView.content_hash)),
    );
    expect(restored).toMatchObject({ status: 'saved' });
    expect(restored.version).toMatchObject({ seq: '3', source: 'rollback', note: 'Restored from version 1' });
    expect(await readFile(join(directory, 'agent-system-prompt.md'), 'utf8')).toBe('Participate safely.');

    versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.items.map((item: { seq: string }) => item.seq)).toEqual(['3', '2', '1']);
    expect(versions.current).toMatchObject({ seq: '3', source: 'rollback' });

    const detail = await readJson(
      await server.handle(request('/api/prompts/versions/' + versions.items[1].id, { headers: { cookie } })),
    );
    expect(detail).toMatchObject({ seq: '2', content: 'New persona.' });

    const diff = await readJson(
      await server.handle(
        request(`/api/prompts/diff?from=${versions.items[1].id}&to=${versions.items[0].id}`, { headers: { cookie } }),
      ),
    );
    expect(diff.hunks).toEqual([
      {
        fromStart: 1,
        fromCount: 1,
        toStart: 1,
        toCount: 1,
        lines: [
          { type: 'removed', text: 'New persona.', fromLine: 1, toLine: null },
          { type: 'added', text: 'Participate safely.', fromLine: null, toLine: 1 },
        ],
      },
    ]);

    const groupVersions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=group&chat=123456789', { headers: { cookie } })),
    );
    const mismatch = await server.handle(
      request(`/api/prompts/diff?from=${groupVersions.items[0].id}&to=${versions.items[0].id}`, {
        headers: { cookie },
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await readJson(mismatch)).toMatchObject({ error: 'diff_scope_mismatch' });

    const missing = await server.handle(request('/api/prompts/diff?from=999&to=1', { headers: { cookie } }));
    expect(missing.status).toBe(404);
  } finally {
    store.close();
  }
});

test('a hand-edited prompt file becomes a version on the next apply, comment-only edits do not', async () => {
  const { store, server, directory } = await fixture();
  try {
    const cookie = await login(server);
    await writeFile(join(directory, 'agent-system-prompt.md'), 'Hand edited.');
    expect((await server.handle(post('/api/config/apply', {}, cookie))).status).toBe(200);
    let versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.items).toHaveLength(2);
    expect(versions.items[0]).toMatchObject({ seq: '2', source: 'external', created_by: null });

    // A comment-only edit changes the file bytes but not the prompt text.
    await writeFile(join(directory, 'agent-system-prompt.md'), '<!-- note -->Hand edited.');
    expect((await server.handle(post('/api/config/apply', {}, cookie))).status).toBe(200);
    versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.items).toHaveLength(2);
  } finally {
    store.close();
  }
});

test('group prompt save edits the configured file, validates chat scope and rejects unknown chats', async () => {
  const { store, server, directory } = await fixture();
  try {
    const cookie = await login(server);

    const unconfigured = await server.handle(
      put('/api/prompts/group?chat=-100333', { prompt: 'nope' }, cookie, 'deadbeef'),
    );
    expect(unconfigured.status).toBe(404);
    expect(await readJson(unconfigured)).toMatchObject({ error: 'chat_unconfigured' });

    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    expect(view.prompt).toBe('private');

    const saved = await readJson(
      await server.handle(
        put('/api/prompts/group?chat=123456789', { prompt: 'group v2', note: 'per group' }, cookie, view.content_hash),
      ),
    );
    expect(saved).toMatchObject({ status: 'saved', affected_running: 0 });
    expect(saved.version).toMatchObject({ chat_id: '123456789', seq: '2', source: 'panel' });
    expect(await readFile(join(directory, 'chat-instructions.md'), 'utf8')).toBe('group v2');
    const active = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=active', { headers: { cookie } })),
    );
    expect(active.prompt).toBe('group v2');

    const versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=group&chat=123456789', { headers: { cookie } })),
    );
    expect(versions.items.map((item: { seq: string }) => item.seq)).toEqual(['2', '1']);
    expect(versions.items[0]).toMatchObject({ chat_id: '123456789', note: 'per group' });
  } finally {
    store.close();
  }
});

test('group prompt creation writes a conventional file, references it and refuses clobbering', async () => {
  const { store, server, directory } = await fixture((config) => {
    const chat = config.telegram.chats[0];
    if (chat !== undefined) {
      delete chat.instructions_file;
    }
  });
  try {
    const cookie = await login(server);
    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    expect(view.prompt).toBe('');

    // An unreferenced file at the conventional path is never clobbered.
    const promptDir = join(directory, 'prompts');
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(promptDir, 'chat-123456789.md'), 'operator file');
    const refused = await server.handle(
      put('/api/prompts/group?chat=123456789', { prompt: 'fresh' }, cookie, view.content_hash),
    );
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({ error: 'prompt_file_exists' });
    await unlink(join(promptDir, 'chat-123456789.md'));

    const saved = await readJson(
      await server.handle(put('/api/prompts/group?chat=123456789', { prompt: 'fresh' }, cookie, view.content_hash)),
    );
    expect(saved).toMatchObject({ status: 'saved' });
    expect(saved.applied).toContain('telegram.chats[123456789].instructions_file');
    expect(await readFile(join(promptDir, 'chat-123456789.md'), 'utf8')).toBe('fresh');
    expect(await readFile(directory + '/config.jsonc', 'utf8')).toContain('"prompts/chat-123456789.md"');
    const active = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=active', { headers: { cookie } })),
    );
    expect(active.prompt).toBe('fresh');
    const versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=group&chat=123456789', { headers: { cookie } })),
    );
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({ seq: '1', source: 'panel', chat_id: '123456789' });
  } finally {
    store.close();
  }
});

test('saving a prompt reports affected runs and the scoped cancel stops only those', async () => {
  const {
    store,
    server: baseServer,
    reloader,
    configStore,
  } = await fixture((config) => {
    config.telegram.chats.push({ id: -100222 });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new BucketScheduler(store, configStore, async (_id, _snapshot, signal) => {
    await gate;
    return signal.aborted ? { state: 'aborted', reason: 'aborted' } : { state: 'completed', reason: 'done' };
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, scheduler });
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
    ingestion.ingest(textUpdate(1, 10, 123456789, 'hello chat a'), start);
    ingestion.ingest(textUpdate(2, 20, -100222, 'hello chat b'), start);
    store.db.prepare('UPDATE buckets SET deadline_at = ?').run(new Date(start.getTime() - 1_000).toISOString());
    scheduler.start();
    await until(
      () => invocationStates().filter((state) => state === 'running').length === 2,
      'both running invocations',
    );

    // A second batch attached mid-run to chat A and not yet injected.
    ingestion.ingest(textUpdate(3, 11, 123456789, 'again chat a'), new Date());
    const running = store.db
      .prepare<[], { id: bigint; conversation_id: bigint; chat_id: bigint }>(
        "SELECT i.id, i.conversation_id, c.telegram_chat_id AS chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id JOIN chats c ON c.id = v.chat_id WHERE i.state = 'running'",
      )
      .all();
    const chatA = running.find((row) => row.chat_id === 123456789n);
    if (chatA === undefined) {
      throw new Error('Expected a running invocation for chat A');
    }
    const attached = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM buckets WHERE state = 'collecting'")
      .get()!.id;
    attachBucketToInvocation(store, 20, chatA.id, attached, chatA.conversation_id, new Date());

    const cookie = await login(baseServer);
    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    const saved = await readJson(
      await server.handle(
        put('/api/prompts/group?chat=123456789', { prompt: 'new group prompt' }, cookie, view.content_hash),
      ),
    );
    expect(saved).toMatchObject({ status: 'saved', affected_running: 1 });

    const canceled = await server.handle(
      post('/api/prompts/cancel-running', { scope: 'group', chat_id: '123456789' }, cookie),
    );
    expect(canceled.status).toBe(200);
    expect(await readJson(canceled)).toMatchObject({ canceled_invocations: 1, expired_buckets: 1 });

    release();
    await until(() => !invocationStates().includes('running'), 'both runs to settle');
    expect(invocationStates()).toEqual(['aborted', 'completed']);
    const bucketStates = store.db
      .prepare<[bigint], { chat_id: bigint; kind: string; state: string; error_code: string | null }>(
        "SELECT c.telegram_chat_id AS chat_id, CASE WHEN b.id = ? THEN 'attached' ELSE 'batch' END AS kind, b.state, b.error_code FROM buckets b JOIN conversations v ON v.id = b.conversation_id JOIN chats c ON c.id = v.chat_id ORDER BY b.id",
      )
      .all(attached);
    expect(bucketStates).toEqual([
      { chat_id: 123456789n, kind: 'batch', state: 'aborted', error_code: null },
      { chat_id: -100222n, kind: 'batch', state: 'completed', error_code: null },
      { chat_id: 123456789n, kind: 'attached', state: 'expired', error_code: 'admin_cancel' },
    ]);
  } finally {
    release();
    await scheduler.stop();
    store.close();
  }
});
