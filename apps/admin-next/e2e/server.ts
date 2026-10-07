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
import { adminSessions, longTasks, taskReceipts } from '../../../src/store/schema.ts';
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
let directory = '';
let shuttingDown = false;
let failNextConfigApply = false;

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
    if (url.pathname !== '/v1/models') {
      return Response.json({ error: { message: 'not found' } }, { status: 404 });
    }
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
  const admin = new AdminServer({
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

  const started = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__e2e/')) {
        return await handleHook(request, url);
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
  console.log(`E2E_READY base=http://127.0.0.1:${port}`);
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
