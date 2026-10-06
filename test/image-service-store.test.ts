import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createImageConfigSnapshot,
  createImageCore,
  createOpenRouterAdapter,
  type GenerationActor,
  type GenerationInput,
  generationCreateSchema,
  type ImageConfigSnapshot,
  ImageStore,
  imageSchema,
  type ModelDefinition,
} from '@plasticwan/image-service';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createImageService } from '../src/image/service.ts';
import { loadConfig, type RawConfig } from '../src/platform/config.ts';
import { backupDatabase, SqliteStore } from '../src/store/database.ts';
import { writeTestConfig } from './helpers.ts';

// ---------------------------------------------------------------------------
// M2 host-integration fixtures. Unlike the package-internal tests (which own
// their SQLite handles), these run the core against the real host connection:
// `SqliteStore.open` applies the numbered migrations and enables
// `defaultSafeIntegers(true)`, so every INTEGER column arrives as bigint.
// ---------------------------------------------------------------------------

const cleanup: Array<() => void | Promise<void>> = [];

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-service-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  // Teardown runs LIFO: `openHostStore`/fixtures push their closers after the
  // directory removal registered in beforeEach, so connections and workers
  // release before the temp directory goes away. Deleting first would fail with
  // EBUSY on Windows while SQLite still holds the database file. Every step
  // still runs when an earlier one fails, and the first failure is rethrown.
  let failure: unknown;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
});

/** Real host store: numbered migrations run, `defaultSafeIntegers(true)` is on. */
async function openHostStore(): Promise<{ store: SqliteStore; config: RawConfig }> {
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(() => {
    if (store.db.open) {
      store.close();
    }
  });
  return { store, config: loaded.config };
}

const PROVIDER_KEY = 'sk-or-v1-test-provider-secret';

const defaultModel = (overrides: Partial<ModelDefinition> = {}): ModelDefinition => ({
  id: 'gpt-image-1',
  name: 'GPT Image 1',
  provider: 'openrouter',
  upstreamModel: 'openai/gpt-image-1',
  credentialRef: 'openrouter',
  providerTag: 'openai',
  capabilities: {
    imageInput: true,
    maxInputImages: 2,
    maxOutputs: 4,
    aspectRatios: ['auto', '1:1', '2:3'],
    resolutionClasses: ['auto', 'low', 'high'],
  },
  ...overrides,
});

const adminActor: GenerationActor = { id: 'admin:admin', name: 'admin', source: 'admin', scopes: [], privileged: true };

type ProviderCall = { url: string; body: Record<string, unknown>; resolve?: () => void };
type FakeProvider = { fetchImpl: typeof fetch; calls: ProviderCall[] };

function fakeProvider(
  respond?: (call: ProviderCall, index: number, init: RequestInit | undefined) => Promise<Response>,
): FakeProvider {
  const calls: ProviderCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: ProviderCall = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    if (respond !== undefined) {
      return respond(call, calls.length - 1, init ?? undefined);
    }
    const image = await pngBytes({ width: 4, height: 4 });
    return new Response(
      JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }],
        usage: { total_tokens: 42, cost: 0.01 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `req-${calls.length}` } },
    );
  };
  return { fetchImpl, calls };
}

async function pngBytes(size: { width: number; height: number }): Promise<Buffer> {
  return sharp({
    create: { width: size.width, height: size.height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

function publishConfig(configStore: { updateConfig(snapshot: ImageConfigSnapshot): void }): void {
  const models = [defaultModel()];
  configStore.updateConfig(
    createImageConfigSnapshot({
      // 32-hex, shaped like the host's config hash.
      version: createHash('sha256').update(JSON.stringify({ models })).digest('hex').slice(0, 32),
      models,
      credentials: { openrouter: PROVIDER_KEY },
    }),
  );
}

function parseInput(payload: Partial<GenerationInput> & { authoredPrompt: string }): GenerationInput {
  return generationCreateSchema.parse({ modelId: 'gpt-image-1', outputCount: 1, ...payload });
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) {
      return value as T;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

test('a full generation on the host safe-integer connection keeps plain numbers through rows and JSON', async () => {
  const { store, config } = await openHostStore();
  const provider = fakeProvider();
  const service = createImageService(store, config, { providerFetch: provider.fetchImpl });
  cleanup.push(() => service.stop());
  publishConfig(service.core.config);

  // Sanity: the borrowed connection really is in bigint mode.
  expect(store.db.prepare('SELECT 1 AS v').get()).toEqual({ v: 1n });

  const input = parseInput({ authoredPrompt: '宿主连接', outputCount: 2 });
  const { generation } = service.core.generations.create(input, adminActor, 'host-safe-int');
  const finished = await waitFor(() => {
    const row = service.core.generations.get(generation.id, adminActor);
    return row === null || row === undefined || row.status === 'queued' || row.status === 'running' ? null : row;
  });
  expect(finished.status).toBe('succeeded');
  expect(provider.calls).toHaveLength(2);

  // No BigInt anywhere in the serializable surface.
  expect(() => JSON.stringify(finished)).not.toThrow();

  // Rows read back through the borrowed connection are numbers, not bigint.
  const db = drizzle(store.db, { schema: imageSchema });
  const row = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, generation.id)).get();
  expect(row?.round).toBe(1);
  expect(typeof row?.round).toBe('number');
  const attempts = db.select().from(imageSchema.generationAttempts).all();
  expect(attempts.length).toBe(2);
  for (const attempt of attempts) {
    expect(typeof attempt.round).toBe('number');
    expect(typeof attempt.itemIndex).toBe('number');
  }
  const assets = db.select().from(imageSchema.images).all();
  expect(assets.length).toBe(2);
  for (const asset of assets) {
    expect(typeof asset.width).toBe('number');
    expect(typeof asset.bytes).toBe('number');
  }
  expect(() => JSON.stringify(attempts)).not.toThrow();

  // Original image files live under <data_dir>/images.
  const files = await readdir(join(config.data_dir, 'images'));
  expect(files.length).toBe(2);
});

test('migration 024 replays cleanly on an existing host database that already holds data', async () => {
  const { store, config } = await openHostStore();
  // Seed host data, then simulate the pre-024 state: image tables dropped and
  // the migration record removed, as if the database predated the feature.
  store.db
    .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('probe', '1', '2026-01-01T00:00:00.000Z')")
    .run();
  store.db.exec('DROP TABLE image_idempotency_keys');
  store.db.exec('DROP TABLE image_generation_attempts');
  store.db.exec('DROP TABLE image_generations');
  store.db.exec('DROP TABLE image_assets');
  store.db.exec('DROP TABLE image_prompts');
  store.db.prepare('DELETE FROM schema_migrations WHERE version = 24').run();
  store.close();

  // Reopening re-applies 024 (after a pre-migration backup) without touching
  // existing rows, and the core works on the upgraded schema.
  const reopened = await SqliteStore.open(config);
  cleanup.push(() => reopened.close());
  const probe = reopened.db.prepare("SELECT value FROM app_state WHERE key = 'probe'").get() as { value: string };
  expect(probe.value).toBe('1');
  const tables = reopened.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'image_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  expect(tables.map((row) => row.name)).toEqual([
    'image_assets',
    'image_generation_attempts',
    'image_generations',
    'image_idempotency_keys',
    'image_prompts',
  ]);
  const provider = fakeProvider();
  const service = createImageService(reopened, config, { providerFetch: provider.fetchImpl });
  cleanup.push(() => service.stop());
  publishConfig(service.core.config);
  const { generation } = service.core.generations.create(
    parseInput({ authoredPrompt: '升级后' }),
    adminActor,
    'after-upgrade',
  );
  const finished = await waitFor(() => {
    const row = service.core.generations.get(generation.id, adminActor);
    return row === null || row === undefined || row.status === 'queued' || row.status === 'running' ? null : row;
  });
  expect(finished.status).toBe('succeeded');
});

test('host transactions roll back core writes atomically', async () => {
  const { store, config } = await openHostStore();
  const provider = fakeProvider();
  const service = createImageService(store, config, { providerFetch: provider.fetchImpl });
  cleanup.push(() => service.stop());
  publishConfig(service.core.config);

  expect(() =>
    store.transaction(() => {
      service.core.generations.create(parseInput({ authoredPrompt: '回滚' }), adminActor, 'rollback-key');
      throw new Error('rollback now');
    }),
  ).toThrow('rollback now');

  const db = drizzle(store.db, { schema: imageSchema });
  expect(db.select().from(imageSchema.generations).all()).toHaveLength(0);
  expect(db.select().from(imageSchema.idempotencyKeys).all()).toHaveLength(0);
});

test('startup reconciliation interrupts claimed rounds and resumes queued ones', async () => {
  const { store, config } = await openHostStore();
  const db = drizzle(store.db, { schema: imageSchema });
  const provider = fakeProvider();
  const core = createImageCore({
    db,
    store: new ImageStore({ dir: join(config.data_dir, 'images') }),
    providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
    startWorker: true,
    concurrency: 1,
    providerTimeoutMs: 5000,
    logger: null,
  });
  cleanup.push(() => core.stop());
  publishConfig(core.config);

  // Produce one legitimately completed generation; its snapshot is the seed
  // for stale rows that mimic a crash mid-round.
  const seed = core.generations.create(parseInput({ authoredPrompt: '恢复种子' }), adminActor, 'recon-seed').generation;
  await waitFor(() => {
    const row = core.generations.get(seed.id, adminActor);
    return row !== null && row.status === 'succeeded' ? row : null;
  });
  const seedRow = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, seed.id)).get();
  expect(seedRow?.snapshot.finalPrompt).toContain('恢复种子');

  // A claimed round (running with a running attempt) and a queued round, both
  // cloned from the real snapshot. The claimed one is missing its later items,
  // so reconciliation must interrupt it; the queued one resumes and succeeds.
  const insert = store.db.prepare(
    `INSERT INTO image_generations (id, status, source, actor_kind, actor_id, actor_name, snapshot, config_version, round, created_at)
     VALUES (?, ?, 'admin', 'admin', 'admin:admin', 'admin', json(?), ?, 1, ?)`,
  );
  const clone = (id: string, status: string) =>
    insert.run(
      id,
      status,
      JSON.stringify({ ...seedRow?.snapshot, round: 1 }),
      seedRow?.configVersion,
      new Date().toISOString(),
    );
  clone('11111111-1111-4111-8111-111111111111', 'running');
  clone('22222222-2222-4222-8222-222222222222', 'queued');
  db.insert(imageSchema.generationAttempts)
    .values({
      id: '33333333-3333-4333-8333-333333333333',
      generationId: '11111111-1111-4111-8111-111111111111',
      round: 1,
      itemIndex: 0,
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    .run();

  // A fresh core on the same borrowed connection reconciles on start; the
  // config store is process-level, so it is shared, not rebuilt.
  const resumed = createImageCore({
    db,
    store: new ImageStore({ dir: join(config.data_dir, 'images') }),
    providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
    startWorker: true,
    concurrency: 1,
    providerTimeoutMs: 5000,
    logger: null,
    configStore: core.config,
  });
  cleanup.push(() => resumed.stop());

  const claimed = await waitFor(() => {
    const row = db
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, '11111111-1111-4111-8111-111111111111'))
      .get();
    return row?.status === 'interrupted' ? row : null;
  });
  expect(claimed.status).toBe('interrupted');
  const attempt = db
    .select()
    .from(imageSchema.generationAttempts)
    .where(eq(imageSchema.generationAttempts.generationId, '11111111-1111-4111-8111-111111111111'))
    .get();
  expect(attempt?.status).toBe('interrupted');
  const recovered = await waitFor(() => {
    const row = resumed.generations.get('22222222-2222-4222-8222-222222222222', adminActor);
    return row !== null && row.status === 'succeeded' ? row : null;
  });
  expect(recovered.status).toBe('succeeded');
});

test('graceful shutdown aborts in-flight provider work and lands interrupted', async () => {
  const { store, config } = await openHostStore();
  const db = drizzle(store.db, { schema: imageSchema });
  // The provider honours the abort signal, like real HTTP fetches do.
  const provider = fakeProvider(async (_call, _index, init) => {
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort);
    });
  });
  const core = createImageCore({
    db,
    store: new ImageStore({ dir: join(config.data_dir, 'images') }),
    providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
    startWorker: true,
    concurrency: 1,
    providerTimeoutMs: 5000,
    shutdownTimeoutMs: 2000,
    logger: null,
  });
  cleanup.push(() => core.stop());
  publishConfig(core.config);
  const { generation } = core.generations.create(parseInput({ authoredPrompt: '关闭中断' }), adminActor, 'shutdown');
  await waitFor(() => (core.generations.get(generation.id, adminActor)?.status === 'running' ? true : null));

  await core.stop();
  const finished = core.generations.get(generation.id, adminActor);
  expect(finished?.status).toBe('interrupted');
  expect(finished?.attempts.every((attempt) => attempt.status === 'interrupted')).toBe(true);
});

test('backups snapshot the image directory beside the SQLite copy and rotate together', async () => {
  const { store, config } = await openHostStore();
  const provider = fakeProvider();
  const service = createImageService(store, config, { providerFetch: provider.fetchImpl });
  cleanup.push(() => service.stop());
  publishConfig(service.core.config);

  const bytes = await pngBytes({ width: 9, height: 5 });
  const uploaded = await service.core.images.create({
    name: '备份资产',
    base64: bytes.toString('base64'),
    mime: 'image/png',
    description: '',
    category: '',
    source: 'upload',
  });
  const { generation } = service.core.generations.create(parseInput({ authoredPrompt: '备份' }), adminActor, 'backup');
  await waitFor(() => {
    const row = service.core.generations.get(generation.id, adminActor);
    return row === null || row === undefined || row.status === 'queued' || row.status === 'running' ? null : row;
  });

  const filesOnDisk = await readdir(join(config.data_dir, 'images'));
  expect(filesOnDisk.length).toBe(2); // one upload + one generation output
  const first = await backupDatabase(config);
  expect(basename(first)).toMatch(/\.sqlite$/);
  const imageSnapshot = first.replace(/\.sqlite$/, '.images');
  // The uploaded asset plus the generated outputs: image files are
  // content-addressed, so two identical outputs share one file.
  const snapshotted = await readdir(imageSnapshot);
  expect(snapshotted.length).toBe(2);

  // Restore both halves into a fresh directory and verify the asset bytes.
  const restoredDbPath = join(directory, 'restore', 'database.sqlite');
  await mkdir(join(directory, 'restore'), { recursive: true });
  await writeFile(restoredDbPath, await readFile(first));
  const restored = new Database(restoredDbPath);
  cleanup.push(() => {
    restored.close();
  });
  restored.defaultSafeIntegers(true);
  const row = restored.prepare('SELECT id, file_name FROM image_assets WHERE id = ?').get(uploaded.id) as {
    id: string;
    file_name: string;
  };
  expect(row.id).toBe(uploaded.id);
  const restoredBytes = await readFile(join(imageSnapshot, row.file_name));
  expect(restoredBytes.length).toBe(bytes.length);
  restored.close();

  // Rotation removes SQLite copies and their image snapshots together: run
  // well past the retention limit and check the pairs stay in lockstep.
  const keep = config.retention.backup_copies;
  for (let index = 0; index < keep + 2; index += 1) {
    await backupDatabase(config);
  }
  const backups = await readdir(config.paths.backups);
  const sqliteCopies = backups.filter((name) => name.endsWith('.sqlite'));
  const imageSnapshots = backups.filter((name) => name.endsWith('.images'));
  expect(sqliteCopies.length).toBe(keep);
  expect(imageSnapshots.length).toBe(keep);
  expect(new Set(sqliteCopies.map((name) => name.replace(/\.sqlite$/, '.images')))).toEqual(new Set(imageSnapshots));
});

test('backupDatabase succeeds when no image assets exist yet', async () => {
  const { config } = await openHostStore();
  const backup = await backupDatabase(config);
  expect(backup.endsWith('.sqlite')).toBe(true);
  const backups = await readdir(config.paths.backups);
  expect(backups.some((name) => name.endsWith('.images'))).toBe(false);
});
