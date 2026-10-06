import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import { afterEach, expect, test } from 'vitest';
import { createExecuteTool } from '../src/capabilities/execute-tool.ts';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { AdminQueryError } from '../src/ingress/admin/audit.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { ReplayError, ReplayRunner } from '../src/orchestration/replay.ts';
import { composeAgentPrompt } from '../src/platform/agent-prompt.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/platform/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { SqliteStore } from '../src/store/database.ts';
import { snapshotInvocation } from '../src/store/invocation-snapshot.ts';
import { bucketMessages, invocationMessages, messageRevisions, messages, telegramSends } from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/**
 * End-to-end CLI -> real HTTP AdminServer -> ReplayRunner integration.
 *
 * The AdminServer is wired exactly like `serve` wires it: the host callback
 * invokes a real ReplayRunner and converts ReplayError to AdminQueryError with
 * the same code/status. A faux provider stands in for the model, so every
 * asserted side effect is synthetic and nothing reaches Telegram or a network.
 */

const PASSWORD = 'integration-panel-password';
const BIN = fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

const definition = (name: string, parameters = Type.Object({})) => ({
  name,
  label: name,
  description: `fixture ${name}`,
  parameters,
});
const OVERRIDE_PROMPT = 'You are the overridden replay prompt.';
function sceneRegistry() {
  return {
    tools: [
      definition('send', SendInputSchema),
      createExecuteTool({
        capabilities: [],
        audit: { start: () => ({ succeed: () => {}, fail: () => {} }), reject: () => {} },
      }),
      definition('zzz'),
      definition('mcp_remote_write'),
    ],
    capabilities: [
      {
        ...definition('add_memory', AddMemoryInputSchema),
        execute: async () => {
          throw new Error('not wired');
        },
      },
      {
        ...definition('alarm', AlarmInputSchema),
        execute: async () => {
          throw new Error('not wired');
        },
      },
      {
        ...definition('list_alarm', ListAlarmInputSchema),
        execute: async () => {
          throw new Error('not wired');
        },
      },
    ],
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-replay-http-'));
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
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', contextWindow: 200_000, maxTokens: 128 }],
    tokenSize: { min: 100_000, max: 100_000 },
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const seed = seedAdminFixture(store);
  const opening = seed.messageIds[1]!;
  store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, seed.invocationA)).run();
  store.orm
    .insert(bucketMessages)
    .values({ bucketId: seed.bucketA, messageId: opening, sourceBucketId: seed.bucketA, sequenceNo: 1n })
    .run();
  // Align this synthetic seed with a real freeze moment. The writer itself
  // supplies complete snapshots; no historical model payload is installed.
  store.orm
    .update(messages)
    .set({ telegramDate: '2026-09-10T07:59:40.000Z', receivedAt: '2026-09-10T07:59:40.000Z' })
    .where(eq(messages.id, opening))
    .run();
  const revision = store.orm
    .select({ id: messageRevisions.id })
    .from(messageRevisions)
    .where(eq(messageRevisions.messageId, opening))
    .orderBy(messageRevisions.revisionNo)
    .get()!;
  store.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, opening)).run();
  store.orm
    .update(messageRevisions)
    .set({ createdAt: '2026-09-10T07:59:40.000Z' })
    .where(eq(messageRevisions.id, revision.id))
    .run();
  snapshotInvocation(store, 0, seed.invocationA, seed.bucketA, seed.conversationId, false);
  const builder = new ContextBuilder(
    store,
    new ContextRefStore(store, { ttlHours: loaded.config.agent.context.ref_ttl_hours }),
  );
  const stable = builder.buildSystemPrompt(loaded.config, builder.identity(loaded.config, seed.invocationA), false, {
    provider: 'agent',
    model: 'agent-model',
  });
  const secrets = new SecretStore();
  const shutdown = new AbortController();
  const gate = new KeyedSemaphore();
  const runner = new ReplayRunner({
    store,
    configStore,
    secrets,
    systemResources: SystemResources.empty(),
    modelGate: gate,
    shutdownSignal: shutdown.signal,
    toolDefinitions: () => sceneRegistry(),
  });
  // Same wiring as `serve` in src/application.ts: ReplayError becomes an
  // AdminQueryError with the engine's code and status, anything else is 500.
  const toAdminQueryError = (error: unknown): never => {
    if (error instanceof ReplayError) {
      throw new AdminQueryError(error.code, error.message, error.status);
    }
    throw error;
  };
  const server = new AdminServer({
    store,
    configStore,
    secrets,
    replayPreflight: (id, selection) => {
      try {
        return runner.inspect(id, selection);
      } catch (error) {
        return toAdminQueryError(error);
      }
    },
    invocationPrompts: (id) => {
      try {
        return runner.prompts(id);
      } catch (error) {
        return toAdminQueryError(error);
      }
    },
    replayInvocation: async (id, input, signal) => {
      try {
        return await runner.run(id, input, signal);
      } catch (error) {
        if (error instanceof ReplayError) {
          throw new AdminQueryError(error.code, error.message, error.status);
        }
        throw error;
      }
    },
  });
  const listening = await server.start();
  cleanup.push(async () => {
    shutdown.abort(new Error('test shutdown'));
    await server.stop();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const clearScene = () =>
    store.orm.delete(invocationMessages).where(eq(invocationMessages.invocationId, seed.invocationA)).run();
  const rows = () => stateRows(store);
  return {
    directory,
    loaded,
    faux,
    configStore,
    store,
    seed,
    secrets,
    listening,
    baseUrl: `http://127.0.0.1:${listening.port}`,
    clearScene,
    stable,
    rows,
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

/** Session-authenticated reads also update the existing session activity clock. */
function expectSessionActivityOnly(before: Record<string, unknown[]>, after: Record<string, unknown[]>): void {
  expect(after).toEqual({
    ...before,
    admin_sessions: before.admin_sessions?.map((row) => ({
      ...(row as Record<string, unknown>),
      last_seen_at: expect.any(String),
    })),
  });
}

/** SQLite INTEGER columns come back as bigint; JSON needs a string form to search. */
function stringifyRows(rows: unknown): string {
  return JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
}

function apiKeyRow(store: SqliteStore, id: string) {
  return store.db
    .prepare<[bigint], { token_hash: string; last_used_at: string | null; revoked_at: string | null }>(
      'SELECT token_hash, last_used_at, revoked_at FROM admin_api_keys WHERE id = ?',
    )
    .get(BigInt(id));
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

  const confirmed = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
  expect(await asObject(confirmed)).toMatchObject({ setup_required: false, authenticated: true, username: 'owner' });

  const createdResponse = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'replay-http-integration' }),
  });
  expect(createdResponse.status).toBe(200);
  const created = await asObject(createdResponse);
  expect(created.item).toMatchObject({
    id: expect.stringMatching(/^\d+$/),
    name: 'replay-http-integration',
    prefix: expect.stringMatching(/^pwk_[A-Za-z0-9_-]{8}$/),
    created_at: expect.any(String),
    last_used_at: null,
    revoked_at: null,
  });
  const key = created.key;
  if (typeof key !== 'string') {
    throw new Error('key creation did not return a plaintext key');
  }
  // The secret exists only in the create response, never in the item metadata.
  expect(JSON.stringify(created.item)).not.toContain(key);
  const item = created.item as { readonly id: string };
  return { cookie, key, keyId: item.id };
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The real CLI bin as a child process; the API key travels by environment only. */
function runCli(args: readonly string[], env: Record<string, string>): Promise<CliResult> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.PLASTICWAN_ENDPOINT;
  delete childEnv.PLASTICWAN_API_KEY;
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface ReplayResult {
  readonly version: number;
  readonly source_invocation_id: string;
  readonly conversation_id: string;
  readonly chat_id: string;
  readonly thread_id: string;
  readonly model: { readonly provider: string; readonly id: string; readonly thinking_level: string };
  readonly overrides: { readonly global_prompt: boolean; readonly group_prompt: boolean };
  readonly completion_reason: string;
  readonly responded: boolean;
  readonly send_count: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly outputs: readonly { readonly tool_name: string; readonly arguments: Record<string, unknown> }[];
  readonly tool_calls: readonly {
    readonly tool_name: string;
    readonly is_error: boolean;
    readonly arguments: Record<string, unknown>;
    readonly result: unknown;
  }[];
  readonly usage: { readonly model_calls: number; readonly total_tokens: number };
  readonly fidelity: {
    readonly model_selection: string;
    readonly side_effects: string;
    readonly external_tools: string;
    readonly memory_and_alarms: string;
    readonly send_nudge: string;
    readonly production_budgets: string;
    readonly dispatches: readonly { readonly tool_name: string; readonly mode: string; readonly capability?: string }[];
  };
}

test('CLI replay over real HTTP runs ReplayRunner with synthetic side effects and no production writes', async () => {
  const f = await fixture();
  expect(f.listening.hostname).toBe('127.0.0.1');
  expect(f.listening.port).toBeGreaterThan(0);
  const admin = await setupAdminSession(f.baseUrl);
  const promptFile = join(f.directory, 'override-prompt.txt');
  await writeFile(promptFile, OVERRIDE_PROMPT);

  f.faux.setResponses([
    (context, options) => {
      // Only the current global template is replaced; runtime and group remain.
      expect(context.systemPrompt).toBe(
        composeAgentPrompt({ ...f.stable.promptLayers, global: OVERRIDE_PROMPT }, f.stable.templateValues),
      );
      expect(context.messages).toHaveLength(1);
      expect(JSON.stringify(context.messages)).toContain('plain text message with a reply');
      expect(JSON.stringify(context.messages)).not.toContain('long payload fixture');
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 128 });
      return fauxAssistantMessage(
        [
          fauxToolCall('send', { text: 'synthetic CLI send' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'synthetic CLI memory' } }),
          fauxToolCall('execute', {
            action: 'call',
            tool: 'alarm',
            input: { target_user_id: '42', datetime: '2099-01-01T00:00:00Z', summary: 'synthetic CLI alarm' },
          }),
          fauxToolCall('mcp_remote_write', {}),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('private completion'),
  ]);

  const env = { PLASTICWAN_ENDPOINT: f.baseUrl, PLASTICWAN_API_KEY: admin.key };
  // Baseline before any key-authenticated CLI request: only the key's
  // last_used_at may move from here on.
  const before = f.rows();
  const keyBefore = apiKeyRow(f.store, admin.keyId);
  expect(keyBefore).toMatchObject({ last_used_at: null, revoked_at: null });

  const list = await runCli(['invocation', 'list', '--limit', '10', '--json'], env);
  expect(list.code).toBe(0);
  expect(list.stderr).toBe('');
  const listing = JSON.parse(list.stdout) as { items: { id: string }[]; next_cursor: string | null };
  expect(listing.items.map((item) => item.id)).toContain('4001');

  const get = await runCli(['invocation', 'get', '4001', '--json'], env);
  expect(get.code).toBe(0);
  expect(get.stderr).toBe('');
  expect(JSON.parse(get.stdout)).toMatchObject({ id: '4001', state: 'completed' });

  const replay = await runCli(['invocation', 'replay', '4001', '--global-prompt', promptFile, '--json'], env);
  expect(replay.code, replay.stderr).toBe(0);
  expect(replay.stderr).toBe('');
  const result = JSON.parse(replay.stdout) as ReplayResult;
  expect(result).toMatchObject({
    version: 2,
    source_invocation_id: '4001',
    scene: { source_bucket_id: '3001', message_count: 1, history_count: 0 },
    conversation_id: '2001',
    chat_id: '123456789',
    thread_id: '0',
    error: null,
    responded: true,
    send_count: 1,
    completion_reason: 'completed',
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'low' },
    overrides: { global_prompt: true, group_prompt: false },
    usage: { model_calls: 2 },
    fidelity: {
      input: 'historical_public_chat',
      prompt_selection: 'current_chat_config',
      tool_selection: 'current_registry',
      model_selection: 'current_chat_config',
      side_effects: 'synthetic',
      external_tools: 'blocked',
      memory_and_alarms: 'empty_in_memory_overlay',
      send_nudge: 'disabled',
      production_budgets: 'not_charged',
    },
  });
  expect(result.usage.total_tokens).toBeGreaterThan(0);
  expect(result.outputs).toEqual([
    expect.objectContaining({ tool_name: 'send', arguments: expect.objectContaining({ text: 'synthetic CLI send' }) }),
  ]);
  const executeCalls = result.tool_calls.filter((call) => call.tool_name === 'execute');
  expect(executeCalls).toHaveLength(2);
  expect(executeCalls.every((call) => call.is_error === false)).toBe(true);
  const memoryCall = executeCalls.find((call) => JSON.stringify(call.arguments).includes('"add_memory"'));
  expect(memoryCall?.is_error).toBe(false);
  expect(JSON.stringify(memoryCall?.result)).toContain('Saved memory');
  const alarmCall = executeCalls.find((call) => JSON.stringify(call.arguments).includes('"alarm"'));
  expect(alarmCall?.is_error).toBe(false);
  expect(JSON.stringify(alarmCall?.result)).toContain('Scheduled alarm');
  // The blocked MCP tool never runs, and every dispatch is synthetic or blocked.
  const blocked = result.tool_calls.find((call) => call.tool_name === 'mcp_remote_write');
  expect(blocked?.is_error).toBe(true);
  expect(result.fidelity.dispatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_name: 'send', mode: 'synthetic' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'alarm' }),
      expect.objectContaining({ tool_name: 'mcp_remote_write', mode: 'blocked' }),
    ]),
  );
  expect(f.faux.state.callCount).toBe(2);

  // Production state is untouched apart from the auth layer's last_used_at.
  const after = f.rows();
  expect(productionTables(after)).toEqual(productionTables(before));
  expect(after.telegram_sends).toEqual(before.telegram_sends);
  expect(before.telegram_sends).toHaveLength(1);
  expect(stringifyRows(after.telegram_sends)).not.toContain('synthetic CLI send');
  expect(after.model_calls).toEqual(before.model_calls);
  expect(after.context_messages).toEqual(before.context_messages);
  expect(after.long_tasks).toEqual(before.long_tasks);
  expect(after.daily_usage).toEqual(before.daily_usage);
  const keyAfter = apiKeyRow(f.store, admin.keyId);
  expect(keyAfter).toMatchObject({ token_hash: keyBefore?.token_hash, revoked_at: null });
  expect(keyAfter?.last_used_at).toEqual(expect.any(String));
}, 120_000);

test('bot-sliced CLI replay injects its window immediately and validates selection before model work', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const env = { PLASTICWAN_ENDPOINT: f.baseUrl, PLASTICWAN_API_KEY: admin.key };
  const send = f.store.orm.select().from(telegramSends).get()!;
  f.store.orm.update(messages).set({ sentByBot: true }).where(eq(messages.id, f.seed.messageIds[0]!)).run();
  const frozen = f.store.orm
    .select()
    .from(invocationMessages)
    .where(eq(invocationMessages.invocationId, f.seed.invocationA))
    .get()!;
  const snapshot = JSON.parse(frozen.snapshotJson) as Record<string, unknown>;
  f.store.orm
    .update(invocationMessages)
    .set({
      snapshotJson: JSON.stringify({
        ...snapshot,
        reply_to_message_id: '900',
        reply_snapshot: { sender: 'Bot', content: 'old answer outside window' },
      }),
    })
    .where(eq(invocationMessages.invocationId, f.seed.invocationA))
    .run();
  const before = productionTables(f.rows());
  const selection = ['--before-send', send.id.toString()];
  const preflight = await runCli(['invocation', 'preflight', '4001', ...selection, '--json'], env);
  expect(preflight.code, preflight.stderr).toBe(0);
  expect(JSON.parse(preflight.stdout)).toMatchObject({
    available: true,
    scene: {
      cutoff_at: send.createdAt,
      message_count: 1,
      history_count: 0,
      slice: { before_send_id: send.id.toString(), before_message_id: '902', after_bot_message_id: '900' },
    },
  });
  expect(f.faux.state.callCount).toBe(0);
  f.faux.setResponses([
    (context) => {
      expect(context.messages).toHaveLength(1);
      const text = JSON.stringify(context.messages);
      expect(text).toContain('plain text message with a reply');
      for (const excluded of [
        'old answer outside window',
        'first caption',
        're:900',
        'Hello from the seeded invocation',
        'private reasoning',
      ]) {
        expect(text).not.toContain(excluded);
      }
      return fauxAssistantMessage(
        [fauxToolCall('send', { text: 'synthetic slice answer', reply_to_message_id: '901' })],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('private finish'),
  ]);
  const replay = await runCli(['invocation', 'replay', '4001', ...selection, '--confirm-paid', '--json'], env);
  expect(replay.code, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({
    error: null,
    send_count: 1,
    overrides: { global_prompt: false, group_prompt: false },
    scene: {
      message_count: 1,
      history_count: 0,
      slice: { before_send_id: send.id.toString() },
    },
  });
  expect(f.faux.state.callCount).toBe(2);
  for (const params of [
    'before_send_id=0',
    'before_send_id=9223372036854775808',
    'before_send_id=1&before_send_id=2',
    'unknown=1',
  ]) {
    const invalid = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight?${params}`, {
      headers: { authorization: `Bearer ${admin.key}` },
    });
    expect(invalid.status).toBe(400);
  }
  const empty = await runCli(
    ['invocation', 'replay', '4001', '--before-send', '999999', '--confirm-paid', '--json'],
    env,
  );
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain('replay_slice_target_invalid');
  for (const input of [
    { before_send_id: 1 },
    { before_send_id: '0' },
    { before_send_id: '9223372036854775808' },
    { before_send_id: send.id.toString(), extra: true },
  ]) {
    const invalid = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(invalid.status).toBe(400);
  }
  const invalidTarget = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ before_send_id: '999999' }),
  });
  expect(invalidTarget.status).toBe(409);
  expect(await invalidTarget.json()).toMatchObject({ error: 'replay_slice_target_invalid' });
  const sessionReplay = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ before_send_id: send.id.toString() }),
  });
  expect(sessionReplay.status).toBe(405);
  expect(await sessionReplay.json()).toMatchObject({ error: 'method_not_allowed' });
  expect(f.faux.state.callCount).toBe(2);
  expectSessionActivityOnly(before, productionTables(f.rows()));
}, 120_000);

test('a sliced replay without --confirm-paid is refused before any request', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const env = { PLASTICWAN_ENDPOINT: f.baseUrl, PLASTICWAN_API_KEY: admin.key };
  const send = f.store.orm.select().from(telegramSends).get()!;
  const before = f.rows();
  const refused = await runCli(['invocation', 'replay', '4001', '--before-send', send.id.toString(), '--json'], env);
  expect(refused.code).toBe(2);
  expect(refused.stdout).toBe('');
  expect(JSON.parse(refused.stderr)).toEqual({
    error: 'confirm_paid_required',
    message: 'invocation replay --before-send requires --confirm-paid to confirm the billed model call',
  });
  // No HTTP request reached the server at all: not even the free preflight ran,
  // so nothing moved — including the API key's last_used_at clock — and the
  // model was never asked to bill anything.
  expect(f.rows()).toEqual(before);
  expect(f.faux.state.callCount).toBe(0);
}, 120_000);

test('keyword and precise public-message time search work through key and session HTTP without model work', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const env = { PLASTICWAN_ENDPOINT: f.baseUrl, PLASTICWAN_API_KEY: admin.key };
  const before = productionTables(f.rows());
  const incoming = await runCli(
    ['invocation', 'list', '--search', 'plain text', '--at', '2026-09-10 07:59', '--json'],
    env,
  );
  expect(incoming.code, incoming.stderr).toBe(0);
  expect(JSON.parse(incoming.stdout)).toMatchObject({
    items: [
      expect.objectContaining({
        id: '4001',
        matched_messages: [expect.objectContaining({ source: 'incoming', telegram_message_id: '901' })],
      }),
    ],
  });
  const bot = await runCli(
    ['invocation', 'list', '--search', 'seeded invocation', '--at', '2026-09-10T08:00:03Z', '--json'],
    env,
  );
  expect(bot.code, bot.stderr).toBe(0);
  expect(JSON.parse(bot.stdout)).toMatchObject({
    items: [
      expect.objectContaining({
        id: '4001',
        matched_messages: [
          expect.objectContaining({ source: 'bot', telegram_message_id: '902', telegram_send_id: expect.any(String) }),
        ],
      }),
    ],
  });
  const noMatch = await runCli(['invocation', 'list', '--search', 'private reasoning', '--json'], env);
  expect(noMatch.code).toBe(0);
  expect(JSON.parse(noMatch.stdout)).toEqual({ items: [], next_cursor: null });
  const key = await fetch(`${f.baseUrl}/api/invocations?search=plain&at=2026-09-10T07%3A59Z`, {
    headers: { authorization: `Bearer ${admin.key}` },
  });
  const session = await fetch(`${f.baseUrl}/api/invocations?search=plain&at=2026-09-10T07%3A59Z`, {
    headers: { cookie: admin.cookie },
  });
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual(await key.json());
  const invalid = await fetch(`${f.baseUrl}/api/invocations?at=2026-02-30T10%3A00Z`, {
    headers: { authorization: `Bearer ${admin.key}` },
  });
  expect(invalid.status).toBe(400);
  expect(f.faux.state.callCount).toBe(0);
  expectSessionActivityOnly(before, productionTables(f.rows()));
}, 120_000);

test('missing opening scene fails the CLI and a revoked key fails unauthenticated', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  f.clearScene();
  const env = { PLASTICWAN_ENDPOINT: f.baseUrl, PLASTICWAN_API_KEY: admin.key };

  // The CLI preflights first and reports the engine's stable reason verbatim.
  const cleared = await runCli(['invocation', 'replay', '4001', '--json'], env);
  expect(cleared.code).toBe(1);
  expect(cleared.stdout).toBe('');
  expect(JSON.parse(cleared.stderr)).toEqual({
    error: 'replay_scene_unavailable',
    message: expect.any(String),
  });
  expect(f.faux.state.callCount).toBe(0);

  // ReplayError -> AdminQueryError yields the engine's 409; an unconverted
  // error would surface as the generic 500 internal_error.
  const direct = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.key}` },
    body: JSON.stringify({}),
  });
  expect(direct.status).toBe(409);
  expect(await asObject(direct)).toMatchObject({ error: 'replay_scene_unavailable' });
  expect(f.faux.state.callCount).toBe(0);

  // Revocation over the session-authenticated panel surface disables the same
  // key for the CLI immediately.
  const revoked = await fetch(`${f.baseUrl}/api/api-keys/${admin.keyId}`, {
    method: 'DELETE',
    headers: { cookie: admin.cookie },
  });
  expect(revoked.status).toBe(200);
  const refused = await runCli(['invocation', 'list', '--json'], env);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe('');
  expect(JSON.parse(refused.stderr)).toMatchObject({ error: 'unauthenticated' });
  expect(f.faux.state.callCount).toBe(0);
}, 120_000);

test('preflight and active prompts are read-only HTTP reads that never call the model', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const headers = { authorization: `Bearer ${admin.key}` };
  const before = productionTables(f.rows());

  const preflight = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight`, { headers });
  expect(preflight.status).toBe(200);
  expect(await asObject(preflight)).toEqual({
    available: true,
    reason: null,
    message: null,
    scene: {
      cutoff_at: '2026-09-10T07:59:45.000Z',
      source_bucket_id: '3001',
      message_count: 1,
      history_count: 0,
      omitted_messages: 0,
    },
    prompt_overrides_available: true,
    omitted_images: 0,
    fidelity: {
      input: 'historical_public_chat',
      model_selection: 'current_chat_config',
      prompt_selection: 'current_chat_config',
      tool_selection: 'current_registry',
      hot_injections: 'not_replayed',
      external_tools: 'blocked',
      system_resources: 'current_read_only',
      side_effects: 'synthetic',
    },
  });

  const prompts = await fetch(`${f.baseUrl}/api/invocations/4001/prompts`, { headers });
  expect(prompts.status).toBe(200);
  expect(await asObject(prompts)).toMatchObject({
    source: 'active',
    source_invocation_id: '4001',
    global_prompt: f.stable.promptLayers.global,
    group_prompt: f.stable.promptLayers.group,
    template_values: f.stable.templateValues,
    core_read_only: true,
  });
  expect(f.faux.state.callCount).toBe(0);
  // Neither read wrote anything, apart from the API key's own last_used_at.
  expect(productionTables(f.rows())).toEqual(before);

  // Clearing the payload makes the same preflight unavailable, and a missing
  // invocation is still a 404 rather than an "unavailable" document.
  f.clearScene();
  const cleared = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight`, { headers });
  expect(cleared.status).toBe(200);
  expect(await asObject(cleared)).toMatchObject({
    available: false,
    reason: 'replay_scene_unavailable',
  });
  const missing = await fetch(`${f.baseUrl}/api/invocations/999999/replay-preflight`, { headers });
  expect(missing.status).toBe(404);
  expect(await asObject(missing)).toMatchObject({ error: 'not_found' });
  expect(f.faux.state.callCount).toBe(0);
  // The reads themselves wrote nothing; only the explicit payload clear moved a row.
  expect(productionTables(f.rows())).not.toEqual(before);
}, 120_000);
