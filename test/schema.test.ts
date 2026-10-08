import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { listInvocations } from '../src/ingress/admin/audit.ts';
import { type LoadedConfig, loadConfig, type FileConfig, resolveAgentSettings } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { imageDeliveryState } from '../src/store/image-delivery.ts';
import {
  bucketMessages,
  buckets,
  chats,
  conversations,
  imageAssets,
  invocations,
  memories,
  messages,
  schemaMigrations,
  stickerSets,
  telegramSends,
  telegramUpdates,
  toolCalls,
} from '../src/store/schema.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';
import * as schema from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function openStore(): Promise<{ store: SqliteStore; loaded: LoadedConfig }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded };
}

test('drizzle layer reads migration versions as bigint', async () => {
  const { store } = await openStore();
  try {
    const versions = store.orm
      .select()
      .from(schemaMigrations)
      .all()
      .map((row) => row.version);
    expect(versions.length).toBeGreaterThanOrEqual(14);
    for (const version of versions) {
      expect(typeof version).toBe('bigint');
    }
  } finally {
    store.close();
  }
});

test.each(['fresh', 'upgraded'])('invocation audit uses indexed calls in %s databases', async (mode) => {
  const fixture = await openStore();
  let store = fixture.store;
  try {
    const seed = seedAdminFixture(store);
    const auditBefore = {
      models: store.db.prepare('SELECT * FROM model_calls ORDER BY id').all(),
      tools: store.db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };
    if (mode === 'upgraded') {
      store.db.exec(`
        DROP INDEX IF EXISTS model_calls_invocation_idx;
        DROP INDEX IF EXISTS tool_calls_invocation_idx;
        DELETE FROM schema_migrations WHERE version = 23;
      `);
      store.close();
      store = await SqliteStore.open(fixture.loaded.config);
      store.close();
      store = await SqliteStore.open(fixture.loaded.config);
    }
    const plans: string[] = [];
    const orm = drizzle(store.db, {
      schema,
      logger: {
        logQuery(query, params) {
          const plan = store.db.prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`).all(...params);
          plans.push(...plan.map((row) => row.detail));
        },
      },
    });
    const first = listInvocations(orm, { limit: '1' });
    expect(first.items).toMatchObject([
      { id: seed.invocationB.toString(), state: 'failed', tool_call_count: 1, total_tokens: 0, total_cost: null },
    ]);
    expect(first.next_cursor).toBe(seed.invocationB.toString());
    const second = listInvocations(orm, {
      limit: '25',
      cursor: first.next_cursor,
      chat: '123456789',
      state: 'completed',
    });
    expect(second.items).toMatchObject([
      {
        id: seed.invocationA.toString(),
        state: 'completed',
        tool_call_count: 2,
        total_tokens: 3930,
        cache_read_tokens: 1400,
        cache_write_tokens: 0,
      },
    ]);
    expect(second.items[0]?.total_cost).toBeCloseTo(0.0048);
    expect(second.next_cursor).toBeNull();
    expect(listInvocations(orm, { chat: '-999' }).items).toEqual([]);
    expect(plans.some((detail) => /SCAN (?:mc|tc)\b/.test(detail))).toBe(false);
    expect(plans.some((detail) => /SEARCH mc USING .*INDEX .*\(invocation_id=\?\)/.test(detail))).toBe(true);
    expect(plans.some((detail) => /SEARCH tc USING .*INDEX .*\(invocation_id=\?\)/.test(detail))).toBe(true);
    expect(store.db.prepare('SELECT * FROM model_calls ORDER BY id').all()).toEqual(auditBefore.models);
    expect(store.db.prepare('SELECT * FROM tool_calls ORDER BY id').all()).toEqual(auditBefore.tools);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store.close();
  }
});

test.each(['fresh', 'upgraded'])(
  'reply delivery lookup preserves audit and uses its index in %s databases',
  async (mode) => {
    const fixture = await openStore();
    let store = fixture.store;
    try {
      const seed = seedAdminFixture(store);
      const now = new Date().toISOString();
      // Historical duplicates must not prevent an upgrade or rewrite past sends.
      for (const [index, state] of ['success', 'success', 'pending', 'outcome_unknown', 'error'].entries()) {
        const tool = store.orm
          .insert(toolCalls)
          .values({
            invocationId: seed.invocationA,
            toolCallId: `reply-index-${index}`,
            toolName: 'send',
            argumentsJson: '{}',
            state,
            sideEffect: true,
            createdAt: now,
          })
          .returning({ id: toolCalls.id })
          .get()!;
        store.orm
          .insert(telegramSends)
          .values({
            toolCallId: tool.id,
            conversationId: seed.conversationId,
            kind: 'text',
            requestJson: JSON.stringify({ reply_to_message_id: '900' }),
            state,
            createdAt: now,
          })
          .run();
      }
      const before = store.orm.select().from(telegramSends).all();
      if (mode === 'upgraded') {
        store.db.exec(`
        DROP INDEX telegram_sends_reply_delivery_idx;
        DELETE FROM schema_migrations WHERE version = 32;
      `);
        store.close();
        store = await SqliteStore.open(fixture.loaded.config);
        store.close();
        store = await SqliteStore.open(fixture.loaded.config);
      }
      const plans: string[] = [];
      const orm = drizzle(store.db, {
        schema,
        logger: {
          logQuery(query, params) {
            plans.push(
              ...store.db
                .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
                .all(...params)
                .map((row) => row.detail),
            );
          },
        },
      });
      const previous = orm
        .select({ state: telegramSends.state })
        .from(telegramSends)
        .where(sql`${telegramSends.conversationId} = ${seed.conversationId}
        AND json_extract(${telegramSends.requestJson}, '$.reply_to_message_id') = ${'900'}
        AND ${telegramSends.state} IN ('success', 'pending', 'outcome_unknown')`)
        .orderBy(sql`${telegramSends.state} = 'success'`)
        .limit(1)
        .get();
      expect(previous?.state).toBe('pending');
      expect(plans.some((detail) => detail.includes('USING INDEX telegram_sends_reply_delivery_idx'))).toBe(true);
      expect(store.orm.select().from(telegramSends).all()).toEqual(before);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.close();
    }
  },
);

// --- Migration 027: image delivery ledger upgrade ---

type ImageSendState = 'success' | 'pending' | 'outcome_unknown' | 'error';

interface ImageDeliveryUpgradeCase {
  readonly name: string;
  readonly state: ImageSendState;
  readonly pictures: number;
  readonly assets: readonly { readonly id: string; readonly offsetMinutes: number }[];
  readonly presetAssetIds?: readonly string[];
  readonly telegramMessageId: bigint | null;
  /** null keeps the pre-027 request_json untouched (it already carried asset_ids). */
  readonly expectedAssetIds: readonly string[] | null;
  readonly delivered: Readonly<Record<string, string>>;
  readonly uncertain: readonly string[];
  readonly unknownAssets: boolean;
}

test('migration 027 infers image delivery asset ids only when the count proves them', async () => {
  // One row per upgrade hazard: a fully proven album, every attempt state, an
  // output that only appeared on a later retry, a missing / mismatched count
  // that must stay unknown, and a record that already carries asset_ids.
  const cases: readonly ImageDeliveryUpgradeCase[] = [
    {
      name: 'success-album',
      state: 'success',
      pictures: 2,
      assets: [
        { id: 'asset-album-a', offsetMinutes: -2 },
        { id: 'asset-album-b', offsetMinutes: -1 },
      ],
      telegramMessageId: 901n,
      expectedAssetIds: ['asset-album-a', 'asset-album-b'],
      delivered: { 'asset-album-a': '901', 'asset-album-b': '901' },
      uncertain: [],
      unknownAssets: false,
    },
    {
      name: 'pending',
      state: 'pending',
      pictures: 1,
      assets: [{ id: 'asset-pending', offsetMinutes: -1 }],
      telegramMessageId: null,
      expectedAssetIds: ['asset-pending'],
      delivered: {},
      uncertain: ['asset-pending'],
      unknownAssets: false,
    },
    {
      name: 'outcome-unknown',
      state: 'outcome_unknown',
      pictures: 1,
      assets: [{ id: 'asset-unknown', offsetMinutes: -1 }],
      telegramMessageId: null,
      expectedAssetIds: ['asset-unknown'],
      delivered: {},
      uncertain: ['asset-unknown'],
      unknownAssets: false,
    },
    {
      name: 'error',
      state: 'error',
      pictures: 1,
      assets: [{ id: 'asset-error', offsetMinutes: -1 }],
      telegramMessageId: null,
      expectedAssetIds: ['asset-error'],
      delivered: {},
      uncertain: [],
      unknownAssets: false,
    },
    {
      name: 'later-retry-asset',
      state: 'success',
      pictures: 1,
      assets: [
        { id: 'asset-early', offsetMinutes: -1 },
        { id: 'asset-late', offsetMinutes: 5 },
      ],
      telegramMessageId: 905n,
      expectedAssetIds: ['asset-early'],
      delivered: { 'asset-early': '905' },
      uncertain: [],
      unknownAssets: false,
    },
    {
      name: 'missing-assets',
      state: 'success',
      pictures: 1,
      assets: [],
      telegramMessageId: 906n,
      expectedAssetIds: [],
      delivered: {},
      uncertain: [],
      unknownAssets: true,
    },
    {
      name: 'count-mismatch',
      state: 'success',
      pictures: 2,
      assets: [{ id: 'asset-half', offsetMinutes: -1 }],
      telegramMessageId: 907n,
      expectedAssetIds: ['asset-half'],
      delivered: {},
      uncertain: [],
      unknownAssets: true,
    },
    {
      name: 'already-recorded',
      state: 'success',
      pictures: 1,
      assets: [],
      presetAssetIds: ['asset-kept'],
      telegramMessageId: 908n,
      expectedAssetIds: null,
      delivered: { 'asset-kept': '908' },
      uncertain: [],
      unknownAssets: false,
    },
  ];

  const base = Date.parse('2026-09-10T10:00:00.000Z');
  const sends = cases.map((scenario, index) => {
    const generationId = `gen-${scenario.name}`;
    const payload: Record<string, unknown> = {
      kind: 'image',
      reply_to_message_id: null,
      generation_id: generationId,
      pictures: scenario.pictures,
      resend: false,
    };
    if (scenario.presetAssetIds !== undefined) {
      payload.asset_ids = [...scenario.presetAssetIds];
    }
    return {
      scenario,
      index,
      generationId,
      payload,
      requestJson: JSON.stringify(payload),
      sendAtMs: base + index * 3_600_000,
    };
  });
  const textRequestJson = JSON.stringify({ kind: 'text', chat_id: 123456789, text: 'plain text send' });
  const createdAt = new Date(base).toISOString();

  const fixture = await openStore();
  let store = fixture.store;
  try {
    store.orm
      .insert(chats)
      .values({
        id: 1n,
        telegramChatId: 123456789n,
        canonicalChatId: 123456789n,
        type: 'private',
        updatedAt: createdAt,
      })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt, updatedAt: createdAt }).run();
    store.orm
      .insert(buckets)
      .values({
        id: 1n,
        conversationId: 1n,
        state: 'completed',
        firstReceivedAt: createdAt,
        deadlineAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    store.orm
      .insert(invocations)
      .values({
        id: 1n,
        bucketId: 1n,
        conversationId: 1n,
        state: 'completed',
        configHash: 'test',
        promptVersion: 1n,
        createdAt,
      })
      .run();

    for (const item of sends) {
      const toolCallId = 101n + BigInt(item.index);
      const sendAt = new Date(item.sendAtMs).toISOString();
      store.orm
        .insert(toolCalls)
        .values({
          id: toolCallId,
          invocationId: 1n,
          toolCallId: `call-img-${item.index}`,
          toolName: 'send',
          argumentsJson: '{}',
          state: 'success',
          sideEffect: true,
          createdAt: sendAt,
          finishedAt: sendAt,
        })
        .run();
      store.orm
        .insert(telegramSends)
        .values({
          id: 201n + BigInt(item.index),
          toolCallId,
          conversationId: 1n,
          kind: 'image',
          requestJson: item.requestJson,
          state: item.scenario.state,
          telegramMessageId: item.scenario.telegramMessageId,
          createdAt: sendAt,
          finishedAt: item.scenario.state === 'pending' ? null : sendAt,
        })
        .run();
      for (const asset of item.scenario.assets) {
        const assetAt = new Date(item.sendAtMs + asset.offsetMinutes * 60_000).toISOString();
        store.orm
          .insert(imageAssets)
          .values({
            id: asset.id,
            name: asset.id,
            mime: 'image/png',
            width: 64,
            height: 64,
            bytes: 128,
            sha256: `sha256-${asset.id}`,
            fileName: `${asset.id}.png`,
            source: 'generation',
            generationId: item.generationId,
            createdAt: assetAt,
            updatedAt: assetAt,
          })
          .run();
      }
    }
    const textIndex = sends.length;
    const textSendAt = new Date(base + textIndex * 3_600_000).toISOString();
    store.orm
      .insert(toolCalls)
      .values({
        id: 101n + BigInt(textIndex),
        invocationId: 1n,
        toolCallId: `call-text-${textIndex}`,
        toolName: 'send',
        argumentsJson: '{}',
        state: 'success',
        sideEffect: true,
        createdAt: textSendAt,
        finishedAt: textSendAt,
      })
      .run();
    store.orm
      .insert(telegramSends)
      .values({
        id: 201n + BigInt(textIndex),
        toolCallId: 101n + BigInt(textIndex),
        conversationId: 1n,
        kind: 'text',
        requestJson: textRequestJson,
        state: 'success',
        telegramMessageId: 999n,
        createdAt: textSendAt,
        finishedAt: textSendAt,
      })
      .run();

    // Roll the database back to its pre-027 shape before reopening it.
    store.db.exec(`
      DROP INDEX telegram_sends_image_delivery_idx;
      DELETE FROM schema_migrations WHERE version = 27;
    `);
    expect(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'telegram_sends_image_delivery_idx'",
        )
        .get(),
    ).toEqual({ n: 0n });
    store.close();

    // Reopen once applies 027; reopening again proves the upgrade is a no-op.
    store = await SqliteStore.open(fixture.loaded.config);
    const afterFirstOpen = store.db
      .prepare<[], { id: bigint; request_json: string }>('SELECT id, request_json FROM telegram_sends ORDER BY id')
      .all();
    store.close();
    store = await SqliteStore.open(fixture.loaded.config);
    const rows = store.db
      .prepare<[], { id: bigint; request_json: string }>('SELECT id, request_json FROM telegram_sends ORDER BY id')
      .all();
    expect(rows).toEqual(afterFirstOpen);

    expect(store.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 27').get()).toEqual({ n: 1n });
    const indexRow = store.db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'telegram_sends_image_delivery_idx'",
      )
      .get();
    expect(indexRow?.sql).toContain("json_extract(request_json, '$.generation_id')");
    expect(indexRow?.sql).toContain("WHERE kind = 'image'");

    const byId = new Map(rows.map((row) => [row.id, row.request_json]));
    for (const item of sends) {
      const requestJson = byId.get(201n + BigInt(item.index));
      expect(requestJson).toBeDefined();
      if (item.scenario.expectedAssetIds === null) {
        expect(requestJson).toBe(item.requestJson);
        continue;
      }
      const payload = JSON.parse(requestJson ?? '{}') as Record<string, unknown>;
      expect([...(payload.asset_ids as string[])].sort()).toEqual([...item.scenario.expectedAssetIds].sort());
      expect(payload.asset_ids_inferred).toBe(true);
      expect(payload.asset_ids_unknown).toBe(item.scenario.unknownAssets);
      const preserved = { ...payload };
      delete preserved.asset_ids;
      delete preserved.asset_ids_inferred;
      delete preserved.asset_ids_unknown;
      expect(preserved).toEqual(item.payload);
    }
    expect(byId.get(201n + BigInt(sends.length))).toBe(textRequestJson);

    // The upgraded ledger still drives imageDeliveryState, and the partial
    // expression index serves it instead of scanning the sends table.
    const plans: string[] = [];
    const orm = drizzle(store.db, {
      schema,
      logger: {
        logQuery(query, params) {
          const plan = store.db.prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`).all(...params);
          plans.push(...plan.map((row) => row.detail));
        },
      },
    });
    for (const item of sends) {
      const delivery = imageDeliveryState(orm, 1n, item.generationId);
      expect(Object.fromEntries(delivery.delivered)).toEqual(item.scenario.delivered);
      expect([...delivery.uncertain].sort()).toEqual([...item.scenario.uncertain].sort());
      expect(delivery.unknownAssets).toBe(item.scenario.unknownAssets);
    }
    expect(
      plans.some((detail) => detail.includes('SEARCH s USING') && detail.includes('telegram_sends_image_delivery_idx')),
    ).toBe(true);
    expect(plans.some((detail) => /^SCAN s\b/.test(detail))).toBe(false);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store.close();
  }
});

test('drizzle layer round-trips bigint and boolean columns', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    const inserted = store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .returning({ id: chats.id, telegramChatId: chats.telegramChatId })
      .get();
    expect(inserted?.id).toBe(1n);
    expect(typeof inserted?.id).toBe('bigint');
    expect(inserted?.telegramChatId).toBe(123456789n);

    const allowed = store.orm
      .insert(telegramUpdates)
      .values({ updateId: 10n, chatId: 123456789n, chatType: 'private', receivedAt: now, allowed: true, rawJson: '{}' })
      .returning({ allowed: telegramUpdates.allowed })
      .get();
    expect(allowed?.allowed).toBe(true);
    expect(typeof allowed?.allowed).toBe('boolean');

    const rejected = store.orm
      .insert(telegramUpdates)
      .values({ updateId: 11n, receivedAt: now, allowed: false })
      .returning({ allowed: telegramUpdates.allowed })
      .get();
    expect(rejected?.allowed).toBe(false);
  } finally {
    store.close();
  }
});

test('strict tables still reject text values in integer columns through sql templates', async () => {
  const { store } = await openStore();
  try {
    expect(() => {
      // The typed layer would refuse this; reach around it to prove SQLite
      // STRICT still guards the raw boundary.
      store.orm.run(sql`INSERT INTO chats (id, telegram_chat_id, canonical_chat_id, type, updated_at)
        VALUES (1, ${'not-a-number'}, 123456789, 'private', '2026-09-01T00:00:00.000Z')`);
    }).toThrow();
    const count = store.orm.select({ count: sql<bigint>`count(*)` }).from(chats).get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('drizzle statements join better-sqlite3 immediate transactions and roll back on throw', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
    store.orm
      .insert(messages)
      .values({ id: 1n, conversationId: 1n, chatId: 1n, telegramMessageId: 5n, telegramDate: now, receivedAt: now })
      .run();
    expect(() => {
      store.transaction(() => {
        store.orm
          .insert(buckets)
          .values({
            id: 1n,
            conversationId: 1n,
            state: 'collecting',
            firstReceivedAt: now,
            deadlineAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        store.orm.insert(bucketMessages).values({ bucketId: 1n, messageId: 1n, sequenceNo: 0n }).run();
        throw new Error('rollback');
      });
    }).toThrow('rollback');
    const bucketCount = store.orm.select({ count: sql<bigint>`count(*)` }).from(buckets).get();
    expect(bucketCount?.count).toBe(0n);
    const bucketMessageCount = store.orm.select({ count: sql<bigint>`count(*)` }).from(bucketMessages).get();
    expect(bucketMessageCount?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('sql templates bind bigint parameters and query the fts5 virtual table', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    const set = store.orm
      .insert(stickerSets)
      .values({ alias: 'cats', telegramName: 'cat_set', updatedAt: now })
      .returning({ id: stickerSets.id })
      .get();
    expect(typeof set?.id).toBe('bigint');
    store.orm.run(
      sql`INSERT INTO sticker_search (sticker_id, description) VALUES (${set?.id ?? 0n}, ${'a happy cat'})`,
    );
    const matched = store.orm.all<{ sticker_id: bigint }>(
      sql`SELECT sticker_id FROM sticker_search WHERE sticker_search MATCH ${'cat'}`,
    );
    expect(matched[0]?.sticker_id).toBe(set?.id);

    const bound = store.orm.all<{ n: bigint }>(sql`SELECT ${9007199254740993n} AS n`);
    expect(bound[0]?.n).toBe(9007199254740993n);
  } finally {
    store.close();
  }
});

test('drizzle layer preserves check constraints from the sql migrations', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
    expect(() => {
      store.orm
        .insert(memories)
        .values({
          id: 'm1',
          conversationId: 1n,
          content: 'x'.repeat(151),
          createdAt: now,
          expiresAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
          updatedAt: now,
        })
        .run();
    }).toThrow();
    const count = store.orm
      .select({ count: sql<bigint>`count(*)` })
      .from(memories)
      .where(eq(memories.conversationId, 1n))
      .get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});

// --- Config validation: chat-level provider/model/thinking_level overrides ---

test('rejects a chat with provider but no model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'Chat 123456789: provider and model must both be set when overriding agent settings',
  );
});

test('rejects a chat with model but no provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'Chat 123456789: provider and model must both be set when overriding agent settings',
  );
});

test('accepts a chat with valid provider + model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig.telegram.chats[0]?.provider).toBe('agent');
  expect(loaded.fileConfig.telegram.chats[0]?.model).toBe('agent-model');
});

test('rejects a chat referencing a non-existent provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'ghost';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow('chat 123456789.provider references unknown alias ghost');
});

test('rejects a chat referencing a non-existent model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'no-such-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'chat 123456789.model no-such-model is absent from provider agent',
  );
});

test('rejects a chat model that lacks text input capability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Bad fixture');
    }
    provider.models = [{ ...provider.models[0]!, id: 'image-only', input: ['image'] }];
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'image-only';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow('chat 123456789.model image-only lacks text input capability');
});

test('accepts a thinking_level override without provider/model (inherits from global)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig.telegram.chats[0]?.thinking_level).toBe('high');
});

test('rejects an inherited thinking_level incompatible with the Chat model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'vision', model: 'vision-model' });
    }),
  );
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level low is not supported by vision\/vision-model/,
  );
});

test('rejects a thinking_level incompatible with the resolved model (non-reasoning)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    // The vision provider has a non-reasoning model
    config.telegram.chats[0]!.provider = 'vision';
    config.telegram.chats[0]!.model = 'vision-model';
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level high is not supported by vision\/vision-model/,
  );
});

test('rejects a thinking_level above what the model declares', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Bad fixture');
    }
    // Narrow the reasoning model to only declare off + minimal
    const model = provider.models[0]!;
    model.thinking_levels = ['off', 'minimal'];
    config.telegram.chats[0]!.thinking_level = 'xhigh';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level xhigh is not supported by agent\/agent-model/,
  );
});

test('resolveAgentSettings inherits from global when chat has no override', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' },
  } as Pick<FileConfig, 'agent'>;
  const result = resolveAgentSettings(config);
  expect(result).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'low' });
});

test('resolveAgentSettings applies chat overrides over global defaults', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' },
  } as Pick<FileConfig, 'agent'>;
  const chat = { provider: 'other', model: 'other-model', thinking_level: 'high' } as Pick<
    FileConfig['telegram']['chats'][number],
    'provider' | 'model' | 'thinking_level'
  >;
  const result = resolveAgentSettings(config, chat);
  expect(result).toEqual({ provider: 'other', model: 'other-model', thinking_level: 'high' });
});

test('resolveAgentSettings inherits thinking_level while overriding provider/model', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'medium' },
  } as Pick<FileConfig, 'agent'>;
  const chat = { provider: 'other', model: 'other-model' } as Pick<
    FileConfig['telegram']['chats'][number],
    'provider' | 'model' | 'thinking_level'
  >;
  const result = resolveAgentSettings(config, chat);
  expect(result).toEqual({ provider: 'other', model: 'other-model', thinking_level: 'medium' });
});
