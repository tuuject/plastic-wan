import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { buildSceneContext } from '../src/context/scene-context.ts';
import { loadConfig } from '../src/platform/config.ts';
import { purgeExpiredData, SqliteStore } from '../src/store/database.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { writeTestConfig } from './helpers.ts';

test('migration 030 drops only legacy replay payloads; retention cascades public scene and audit rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-scene-retention-'));
  let store: SqliteStore | undefined;
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    store = await SqliteStore.open(config, false);
    const migrationDirectory = join(import.meta.dirname, '../src/store/migrations');
    for (const file of (await readdir(migrationDirectory)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort()) {
      const version = Number(file.slice(0, 3));
      if (version >= 30) {
        break;
      }
      const text = await readFile(join(migrationDirectory, file), 'utf8');
      store.db.transaction(() => {
        store!.db.exec(text);
        store!.db
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(BigInt(version), new Date().toISOString());
      })();
    }
    const seed = seedAdminFixture(store);
    store.db.prepare('UPDATE model_calls SET replay_input_json = ?').run('{"version":2,"obsolete":true}');
    const preserved = () => ({
      calls: store!.db
        .prepare('SELECT * FROM model_calls ORDER BY id')
        .all()
        .map((row) => {
          const { replay_input_json: _removed, ...rest } = row as Record<string, unknown>;
          return rest;
        }),
      tools: store!.db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      sends: store!.db.prepare('SELECT * FROM telegram_sends ORDER BY id').all(),
      usage: store!.db.prepare('SELECT * FROM daily_usage ORDER BY utc_date, scope, resource, metric').all(),
      snapshots: store!.db.prepare('SELECT * FROM invocation_messages ORDER BY invocation_id, sequence_no').all(),
    });
    const before = preserved();
    expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 29n });
    store.close();
    store = undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      store = await SqliteStore.open(config);
      expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 31n });
      expect(store.db.prepare('PRAGMA table_info(model_calls)').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'replay_input_json' })]),
      );
      expect(preserved()).toEqual(before);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (attempt === 0) {
        const backups = (await readdir(config.paths.backups)).filter((name) => name.startsWith('pre-migration-'));
        expect(backups).toHaveLength(1);
        const backup = new Database(join(config.paths.backups, backups[0]!), { readonly: true, fileMustExist: true });
        try {
          backup.defaultSafeIntegers(true);
          expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
            version: 29n,
          });
          expect(backup.prepare('SELECT replay_input_json FROM model_calls LIMIT 1').get()).toEqual({
            replay_input_json: '{"version":2,"obsolete":true}',
          });
          expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        } finally {
          backup.close();
        }
        store.close();
        store = undefined;
      }
    }
    purgeExpiredData(store!.orm, config, new Date('2026-12-31T00:00:00.000Z'));
    for (const table of [
      'invocations',
      'invocation_messages',
      'invocation_buckets',
      'model_calls',
      'tool_calls',
      'telegram_sends',
      'media',
      'message_revisions',
      'messages',
    ]) {
      expect(store!.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0n });
    }
    expect(() =>
      buildSceneContext(store!, config, seed.invocationA, {
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        toolDefinitionCharacters: 0,
      }),
    ).toThrow('does not exist');
    expect(store!.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
