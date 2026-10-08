/**
 * E2E backend process. Started by Playwright's globalSetup as a child process
 * so the real `AdminServer` + real `SqliteStore` + the synthetic admin fixture
 * run under Node.js. It binds 127.0.0.1 on a random port and prints:
 *
 *   E2E_READY base=http://127.0.0.1:<port>
 *
 * The wrapper serves two trees on that single port:
 * - `/__e2e/**`  test-only hooks (state manipulation + shutdown);
 * - everything else is handed to `AdminServer.handle` (real API + static SPA).
 *
 * Passkeys mode (`E2E_PASSKEYS=1`) binds `localhost` instead of `127.0.0.1`
 * and sets `admin.public_url` to the live random origin before `AdminServer`
 * is constructed: Chromium rejects an IP literal as a WebAuthn RP ID
 * (`SecurityError: This is an invalid domain.`), so the RP must be a domain.
 *
 * Graceful shutdown: POST /__e2e/shutdown, or SIGTERM/SIGINT. The temp
 * directory and its SQLite file are removed on shutdown. Nothing here reads
 * dev-data/, starts `serve`, or touches any user process.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import { and, eq, sql } from 'drizzle-orm';
import { AdminServer } from '../../../src/ingress/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../../../src/platform/config.ts';
import { ConfigReloader } from '../../../src/platform/config-reload.ts';
import { keyJarPath } from '../../../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../../../src/platform/model-switch.ts';
import { loadModelsDevCatalog } from '../../../src/platform/models-dev.ts';
import { buildModelRegistry } from '../../../src/platform/providers.ts';
import { RuntimeConfigurationStore } from '../../../src/platform/runtime-config.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { asRunResult, SqliteStore } from '../../../src/store/database.ts';
import { recordPromptVersionsFromConfig } from '../../../src/store/prompt-versions.ts';
import { adminPasskeys, adminSessions, longTasks, taskReceipts } from '../../../src/store/schema.ts';
import { enterSleep, wakeFromSleep } from '../../../src/store/sleep.ts';
import { seedAdminBulkRows, seedAdminFixture } from '../../../test/fixtures/admin-seed.ts';
import {
  startFixtureServer,
  stopFixtureServer,
  testConfigJsonc,
  writeTestConfig,
  writeTestKeyJar,
} from '../../../test/helpers.ts';
import {
  E2E_ACCEPTED_RELAY_KEYS,
  E2E_BUILTIN_ALIAS,
  E2E_BUILTIN_PROVIDER,
  E2E_HEALTH_FAIL_MODEL,
  E2E_HEALTH_OK_2_MODEL,
  E2E_HEALTH_OK_MODEL,
  E2E_HEALTH_PROMPT,
  E2E_HEALTH_UNEXPECTED_MODEL,
  E2E_MODELS_DEV_CATALOG,
  E2E_RELAY_ALIAS,
  E2E_RELAY_DISCOVERED_MODELS,
  E2E_SECRETS,
} from './models-fixture.ts';

const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-correct-horse';

/**
 * The Models page only offers "Restart now" when the deployment declared a
 * supervisor; nothing here actually exits the process (see `requestRestart`).
 */
process.env.PLASTICWAN_SUPERVISED = '1';

let store: SqliteStore | null = null;
let server: ServerType | null = null;
let upstream: ServerType | null = null;
let admin: AdminServer | null = null;
let directory = '';
let shuttingDown = false;
let failNextConfigApply = false;

/**
 * Every chat-completion request the fixture upstream served (the health-check
 * calls), plus rejection, concurrency and in-flight counters. Exposed to the
 * specs via `GET /__e2e/relay-stats` so they can assert what actually left the
 * process: one request per click, a batch capped at three in flight, the
 * exact body Pi sent (single fixed prompt, no system message, no tools), and
 * that a real client disconnect (request signal abort) frees the slot instead
 * of waiting for the canned delay to expire.
 */
interface RelayChatRecord {
  readonly model: string;
  readonly body: Record<string, unknown>;
  /** Set once the fixture observed the peer abort the request before it finished. */
  aborted: boolean;
  /** Set once the fixture's handler reached its end state (response written or torn down). */
  completed: boolean;
}
const relayChatStats = {
  requests: [] as RelayChatRecord[],
  rejected: 0,
  inFlight: 0,
  maxConcurrent: 0,
  aborted: 0,
  completed: 0,
};

/**
 * Per-model upstream latency. `health-ok` settles in ~120ms while the other
 * three models hold their stream open for ~2s. Ordering assertions no longer
 * depend on these values: the hold gate parks a model upstream until a spec
 * explicitly releases it, so "fast settled while slow still checking" and
 * "cancelled while still held" are deterministic by construction. The delays
 * only bound how long a released response takes to arrive.
 */
const HEALTH_DELAY_MS: Readonly<Record<string, number>> = {
  [E2E_HEALTH_OK_MODEL]: 120,
  [E2E_HEALTH_OK_2_MODEL]: 2000,
  [E2E_HEALTH_UNEXPECTED_MODEL]: 2000,
  [E2E_HEALTH_FAIL_MODEL]: 2000,
};

function healthDelayMs(model: string): number {
  return HEALTH_DELAY_MS[model] ?? 600;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The upstream answers per requested model id: `health-ok*` streams the
 * expected reply, `health-unexpected` streams a different one, `health-fail`
 * answers HTTP 500, and everything else is unknown.
 */
function healthBehavior(model: string): 'ok' | 'unexpected' | 'http-error' | 'unknown' {
  if (model === E2E_HEALTH_OK_MODEL || model === E2E_HEALTH_OK_2_MODEL) {
    return 'ok';
  }
  if (model === E2E_HEALTH_UNEXPECTED_MODEL) {
    return 'unexpected';
  }
  if (model === E2E_HEALTH_FAIL_MODEL) {
    return 'http-error';
  }
  return 'unknown';
}

/**
 * Test-only response gate. While a model (or all models) is held, arriving
 * health requests are parked before any response bytes: the upstream has not
 * answered yet, for as long as the spec wants. This replaces wall-clock delay
 * races (a 2s stream can complete before a 120ms one is asserted on, or a
 * "cancelled" batch can simply have finished naturally) with explicit
 * hold/release control. A peer disconnect while a request is parked is a real
 * upstream cancel — the fixture observed the connection die before it replied.
 */
const healthGate = {
  all: false,
  models: new Set<string>(),
};
const gateReleaseListeners = new Set<() => void>();

function isHeld(model: string): boolean {
  return healthGate.all || healthGate.models.has(model);
}

/** Resolves once `model` is released; rejects when the peer aborts while parked. */
function waitForRelease(model: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      gateReleaseListeners.delete(listener);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const listener = (): void => {
      if (!isHeld(model)) {
        cleanup();
        resolve();
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    gateReleaseListeners.add(listener);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseHealthGate(model?: string): void {
  if (model === undefined) {
    healthGate.all = false;
    healthGate.models.clear();
  } else {
    healthGate.models.delete(model);
  }
  for (const listener of [...gateReleaseListeners]) {
    listener();
  }
}

/**
 * Enforces the health-check contract at the wire: one user message with the
 * exact fixed prompt, no system role, no tools, streaming, output capped at
 * 128. A violation answers 400 so the check surfaces as an upstream error and
 * the spec fails with a message naming the broken field.
 */
function validateHealthRequest(body: Record<string, unknown>): string | null {
  const model = body.model;
  if (typeof model !== 'string' || model.length === 0) {
    return 'fixture: health request must carry a model id';
  }
  if (body.stream !== true) {
    return 'fixture: health request must stream';
  }
  if (body.tools !== undefined) {
    return 'fixture: health request must not carry tools';
  }
  if (body.tool_choice !== undefined) {
    return 'fixture: health request must not carry tool_choice';
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    return 'fixture: health request must carry exactly one message';
  }
  const message = messages[0] as Record<string, unknown> | undefined;
  if (message === undefined || message.role !== 'user') {
    return 'fixture: the only message must have role user';
  }
  if (message.content !== E2E_HEALTH_PROMPT) {
    return 'fixture: the only message must be exactly the fixed health prompt';
  }
  const cap = body.max_tokens ?? body.max_completion_tokens;
  if (cap !== undefined && (typeof cap !== 'number' || !Number.isInteger(cap) || cap > 128)) {
    return 'fixture: the output cap must be an integer <= 128';
  }
  return null;
}

/** One OpenAI-style SSE stream with the canned reply, then `data: [DONE]`. */
function healthSseChunks(model: string, content: string): string[] {
  const id = `chatcmpl-e2e-${model}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content }, null),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ];
}

async function handleHealthCompletions(request: Request): Promise<Response> {
  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!E2E_ACCEPTED_RELAY_KEYS.includes(presented)) {
    return Response.json({ error: { message: 'invalid key' } }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: 'fixture: request body is not JSON' } }, { status: 400 });
  }
  const validationError = validateHealthRequest(body);
  if (validationError !== null) {
    relayChatStats.rejected += 1;
    return Response.json({ error: { message: validationError } }, { status: 400 });
  }
  const model = String(body.model);
  const behavior = healthBehavior(model);
  const record: RelayChatRecord = { model, body, aborted: false, completed: false };
  relayChatStats.requests.push(record);
  if (behavior === 'unknown') {
    return Response.json({ error: { message: `fixture: no canned behavior for model ${model}` } }, { status: 404 });
  }
  // Every canned request counts as in-flight from arrival until its response
  // is written or the peer disconnects — including the HTTP-500 one, so a
  // batch whose slots hold a failing model reports real concurrency.
  relayChatStats.inFlight += 1;
  relayChatStats.maxConcurrent = Math.max(relayChatStats.maxConcurrent, relayChatStats.inFlight);
  const onAbort = (): void => {
    if (!record.aborted) {
      record.aborted = true;
      relayChatStats.aborted += 1;
    }
  };
  if (request.signal.aborted) {
    onAbort();
  } else {
    request.signal.addEventListener('abort', onAbort, { once: true });
  }
  let finished = false;
  const finish = (): void => {
    request.signal.removeEventListener('abort', onAbort);
    if (!finished) {
      finished = true;
      record.completed = true;
      relayChatStats.completed += 1;
      // Defensive clamp: a request torn down after the next spec reset the
      // counters must not push the shared counter below zero.
      relayChatStats.inFlight = Math.max(0, relayChatStats.inFlight - 1);
    }
  };
  try {
    // Test-only gate: while the model is held the upstream has not answered.
    // If the peer disconnects here, that is a real upstream cancel.
    if (isHeld(model)) {
      await waitForRelease(model, request.signal);
    }
    if (behavior === 'http-error') {
      await sleep(healthDelayMs(model));
      finish();
      return Response.json({ error: { message: 'fixture upstream failure' } }, { status: 500 });
    }
    const content = behavior === 'ok' ? 'ok' : 'hello';
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await sleep(healthDelayMs(model));
          const encoder = new TextEncoder();
          for (const chunk of healthSseChunks(model, content)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch {
          // The client went away mid-stream; nothing more to send.
        } finally {
          finish();
        }
      },
      cancel: finish,
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  } catch {
    // The peer disconnected while this handler was parked or answering; free
    // the slot without trying to reply into a dead socket.
    finish();
    return Response.json({ error: { message: 'fixture: client disconnected' } }, { status: 499 });
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    if (server !== null) {
      if ('closeAllConnections' in server) {
        server.closeAllConnections();
      }
      server.close();
    }
  } catch {
    // best effort
  }
  try {
    if (upstream !== null) {
      await stopFixtureServer(upstream);
    }
  } catch {
    // best effort
  }
  try {
    store?.close();
  } catch {
    // best effort
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // best effort
  }
  process.exit(0);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleHook(request: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice('/__e2e'.length);
  if (request.method === 'GET' && route === '/health') {
    return json({ ok: true });
  }
  if (request.method === 'GET' && route === '/relay-stats') {
    const byModel = new Map<string, number>();
    for (const record of relayChatStats.requests) {
      byModel.set(record.model, (byModel.get(record.model) ?? 0) + 1);
    }
    return json({
      total: relayChatStats.requests.length,
      by_model: Object.fromEntries(byModel),
      max_concurrent: relayChatStats.maxConcurrent,
      in_flight: relayChatStats.inFlight,
      rejected: relayChatStats.rejected,
      aborted: relayChatStats.aborted,
      completed: relayChatStats.completed,
      records: relayChatStats.requests.map((record) => ({
        model: record.model,
        aborted: record.aborted,
        completed: record.completed,
      })),
      bodies: relayChatStats.requests.map((record) => record.body),
    });
  }
  if (request.method === 'POST' && route === '/relay-stats/reset') {
    relayChatStats.requests.length = 0;
    relayChatStats.rejected = 0;
    relayChatStats.inFlight = 0;
    relayChatStats.maxConcurrent = 0;
    relayChatStats.aborted = 0;
    relayChatStats.completed = 0;
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/health-gate/hold') {
    const gateBody = (await request.json().catch(() => null)) as { model?: string } | null;
    if (gateBody === null) {
      return json({ error: 'invalid_body' }, 400);
    }
    if (gateBody.model === undefined) {
      healthGate.all = true;
    } else {
      healthGate.models.add(gateBody.model);
    }
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/health-gate/release') {
    const gateBody = (await request.json().catch(() => null)) as { model?: string } | null;
    if (gateBody === null) {
      return json({ error: 'invalid_body' }, 400);
    }
    releaseHealthGate(gateBody.model);
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/fail-next-config-apply') {
    failNextConfigApply = true;
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/shutdown') {
    setTimeout(() => void shutdown(), 50);
    return json({ status: 'stopping' });
  }
  if (request.method === 'POST' && route === '/revoke-sessions') {
    const result = store === null ? null : asRunResult(store.orm.delete(adminSessions).run());
    return json({ deleted: Number(result?.changes ?? 0) });
  }
  if (request.method === 'POST' && route === '/passkeys-rp-fixture') {
    const active = url.searchParams.get('active');
    if (active !== 'none' && active !== 'latest') {
      return json({ error: 'invalid_active' }, 400);
    }
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const latest = store.orm.select().from(adminPasskeys).orderBy(adminPasskeys.id).all().at(-1);
    store.orm.update(adminPasskeys).set({ rpId: 'old.example.test' }).run();
    if (active === 'latest' && latest !== undefined) {
      store.orm.update(adminPasskeys).set({ rpId: 'localhost' }).where(eq(adminPasskeys.id, latest.id)).run();
    }
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/enter-sleep') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const transition = enterSleep(store.orm);
    return json({ sleep_until: transition.sleepUntil, entered: transition.entered });
  }
  if (request.method === 'POST' && route === '/wake') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    return json({ was_sleeping: wakeFromSleep(store.orm) });
  }
  if (request.method === 'POST' && route === '/set-alarm-terminal') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const now = new Date().toISOString();
    const taskId = BigInt(id);
    const result = asRunResult(
      store.orm
        .update(longTasks)
        .set({ state: 'completed', finishedAt: now, updatedAt: now })
        .where(and(eq(longTasks.id, taskId), eq(longTasks.pluginId, 'alarm'), eq(longTasks.state, 'waiting')))
        .run(),
    );
    if (result.changes > 0) {
      store.orm
        .insert(taskReceipts)
        .values({
          taskId,
          status: 'completed',
          resultJson: null,
          errorJson: null,
          state: 'handled',
          createdAt: now,
          updatedAt: now,
          claimedAt: now,
          handledAt: now,
          invocationId: null,
          invocationOutcome: null,
          completionReason: null,
          cancelledAt: null,
          cancelledBy: null,
          adminCancelled: false,
          cancelReason: null,
        })
        .onConflictDoNothing()
        .run();
    }
    return json({ updated: Number(result.changes) });
  }
  if (request.method === 'GET' && route === '/alarm-state') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    const row =
      store?.orm
        .select({ taskState: longTasks.state, receiptState: taskReceipts.state, cancelledBy: taskReceipts.cancelledBy })
        .from(longTasks)
        .leftJoin(taskReceipts, eq(taskReceipts.taskId, longTasks.id))
        .where(and(eq(longTasks.id, BigInt(id)), eq(longTasks.pluginId, 'alarm')))
        .get() ?? null;
    if (row === null) {
      return json({ state: null });
    }
    const state =
      row.taskState === 'cancelled' || row.receiptState === 'suppressed'
        ? 'cancelled'
        : row.receiptState === 'claimed'
          ? 'firing'
          : row.receiptState === 'handled'
            ? 'fired'
            : 'pending';
    return json({ state, cancelled_by: row.cancelledBy });
  }
  if (request.method === 'GET' && route === '/session-count') {
    const row = store?.orm.select({ count: sql`COUNT(*)` }).from(adminSessions).get();
    return json({ count: Number(row?.count ?? 0n) });
  }
  return json({ error: 'not_found' }, 404);
}

async function main(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-e2e-'));
  const configPath = join(directory, 'config.jsonc');
  const staticDir = resolve(join(import.meta.dirname, '..', 'dist'));
  // A local listing endpoint for the custom relay provider: the Models page's
  // discovery must never reach the network, and the key/header assertions only
  // hold when the request lands here.
  const relay = await startFixtureServer((incoming) => {
    const url = new URL(incoming.url);
    if (url.pathname === '/v1/models') {
      if (incoming.headers.get('authorization') === null) {
        return Response.json({ error: { message: 'missing key' } }, { status: 401 });
      }
      const presented = (incoming.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!E2E_ACCEPTED_RELAY_KEYS.includes(presented)) {
        return Response.json({ error: { message: 'invalid key' } }, { status: 401 });
      }
      return Response.json({
        object: 'list',
        data: E2E_RELAY_DISCOVERED_MODELS.map((id) => ({ id, name: id, object: 'model' })),
      });
    }
    // Health checks reach this path with the same loopback upstream.
    if (url.pathname === '/v1/chat/completions' && incoming.method === 'POST') {
      return handleHealthCompletions(incoming);
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  });
  upstream = relay.server;
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 1,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
      // A builtin provider with a model list: Pi supplies the address and the
      // adapter, the file supplies the enabled models.
      config.providers[E2E_BUILTIN_ALIAS] = {
        kind: 'builtin',
        provider: E2E_BUILTIN_PROVIDER,
        api_key: { jar: 'e2e-builtin' },
        models: [
          {
            id: 'openrouter/auto',
            name: 'Auto Router',
            reasoning: false,
            input: ['text'],
            context_window: 128_000,
            max_tokens: 8_192,
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
        ],
      };
      config.providers[E2E_RELAY_ALIAS] = {
        kind: 'custom',
        base_url: `http://127.0.0.1:${String(relay.port)}/v1`,
        api: 'openai-completions',
        api_key: { jar: 'e2e-relay' },
        headers: { 'x-relay-token': { jar: 'e2e-relay-header' } },
        models: [
          {
            id: 'relay-existing-model',
            name: 'Relay Existing Model',
            reasoning: false,
            input: ['text', 'image'],
            context_window: 64_000,
            max_tokens: 4_096,
            cost: { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 },
          },
        ],
      };
    }),
  );
  await writeTestKeyJar(directory, {
    'e2e-builtin': E2E_SECRETS.builtin,
    'e2e-relay': E2E_SECRETS.relay,
    'e2e-relay-header': E2E_SECRETS.relayHeader,
  });
  // `discover` and `lookup-metadata` resolve metadata against the models.dev
  // catalog. Priming it with a fixture (the module's own test seam) keeps the
  // E2E server offline.
  await loadModelsDevCatalog({
    ttlMs: 60 * 60 * 1000,
    fetchImpl: () => Promise.resolve(Response.json(E2E_MODELS_DEV_CATALOG)),
  });
  const loaded: LoadedConfig = await loadConfig(configPath);
  const adminConfig = loaded.config.admin;
  if (adminConfig === undefined) {
    throw new Error('Admin config is missing from the E2E config');
  }
  // Production validation demands port >= 1; tests bind an OS-assigned port
  // by overriding to 0 in memory after a normal load.
  adminConfig.port = 0;

  store = await SqliteStore.open(loaded.config);
  seedAdminFixture(store);
  seedAdminBulkRows(store);
  // Production records the starting prompt versions at startup; mirror that so
  // the Prompts page has history to show.
  recordPromptVersionsFromConfig(store.orm, loaded.config);

  const secrets = new SecretStore(keyJarPath(configPath));
  const registry = await buildModelRegistry(loaded.config, null, secrets);

  // Bind the loopback listener FIRST so the random port is known before the
  // passkeys origin is derived from it; `AdminServer` reads `admin.public_url`
  // at construction, so the in-memory config is patched before it is created.
  // WebAuthn RP IDs must be domains, hence `localhost` in passkeys mode.
  const passkeysMode = process.env.E2E_PASSKEYS === '1';
  const hostname = passkeysMode ? 'localhost' : '127.0.0.1';
  const started = serve({
    hostname,
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__e2e/')) {
        return await handleHook(request, url);
      }
      if (admin === null) {
        return json({ error: 'admin_not_ready', message: 'E2E server is still starting' }, 503);
      }
      return await admin.handle(request);
    },
  });
  server = started;
  // @hono/node-server binds asynchronously; Bun.serve was listening on return.
  await new Promise<void>((resolve, reject) => {
    started.once('listening', resolve);
    started.once('error', reject);
  });
  const address = started.address();
  if (address === null || typeof address === 'string') {
    throw new Error('E2E server did not bind a port');
  }
  const port = address.port;
  if (passkeysMode) {
    // Written after loadConfig because only the live port yields a valid
    // canonical origin. It is never written to the fixture file.
    adminConfig.public_url = `http://localhost:${port}`;
    console.log(`E2E_PASSKEYS origin=${adminConfig.public_url} rp_id=localhost`);
  }

  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const modelSwitcher = new AgentModelSwitcher(configStore);
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    // This fixture runs no agent runtime, so there is no tool registry to fit
    // into the model's context window; production wires the real validator.
    validateAgentModel: () => {
      if (failNextConfigApply) {
        failNextConfigApply = false;
        throw new Error('Synthetic apply failure');
      }
    },
    onPublished: () => undefined,
  });
  admin = new AdminServer({
    store,
    configStore,
    modelSwitcher,
    configReloader,
    secrets,
    // The E2E process has to outlive the suite, so a restart request is recorded
    // instead of shutting the process down. `POST /api/restart` itself (the
    // config check and the 202) is exercised by test/admin-providers.test.ts.
    requestRestart: () => {
      console.log('E2E_RESTART_REQUESTED');
    },
  });

  console.log(`E2E_READY base=http://${hostname}:${port}`);
  // Exposed to the specs so they can log in again after revoking sessions.
  console.log(`E2E_CREDENTIALS ${ADMIN_USERNAME} ${ADMIN_PASSWORD}`);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('uncaughtException', (error) => {
  console.error(`E2E_SERVER_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  void shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error(`E2E_SERVER_ERROR ${reason instanceof Error ? reason.message : String(reason)}`);
  void shutdown();
});

void main().catch((error) => {
  console.error(`E2E_SERVER_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
