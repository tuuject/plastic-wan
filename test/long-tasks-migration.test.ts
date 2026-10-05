import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { longTasks, taskReceipts } from '../src/store/schema.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  for (const d of directories) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      // ignore EBUSY on Windows
    }
  }
  directories.length = 0;
});

async function loadMigrationFile(version: number): Promise<string> {
  const name = String(version).padStart(3, '0');
  const dirPath = join(import.meta.dirname, '..', 'src', 'store', 'migrations');
  const files = await (await import('node:fs/promises')).readdir(dirPath);
  const file = files.find((f) => f.startsWith(name));
  if (!file) {
    throw new Error(`Migration ${version} not found`);
  }
  return readFile(join(dirPath, file), 'utf8');
}

/** Create a database with migrations 001-019 applied. */
async function createPre020Db(): Promise<{
  db: Database.Database;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-mig-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const { config } = await loadConfig(configPath);
  const dbPath = config.paths.database;

  await (await import('node:fs/promises')).mkdir(dirname(dbPath), {
    recursive: true,
  });

  const db = new Database(dbPath);
  db.defaultSafeIntegers(true);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  for (let v = 1; v <= 19; v += 1) {
    const sql = await loadMigrationFile(v);
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        BigInt(v),
        new Date().toISOString(),
      );
    }).immediate();
  }

  return { db, directory };
}

/** Helper: insert minimal chat + conversation rows for FK satisfaction. */
function seedChat(db: Database.Database): void {
  db.prepare(
    `INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at)
     VALUES (1, 123, 123, 'private', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
     VALUES (1, 1, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
}

function seedBucketAndInvocation(db: Database.Database): void {
  db.prepare(
    `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
     VALUES (1, 1, 'completed', 'realtime', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
     VALUES (1, 1, 1, 'completed', 'h', 1, '2025-01-01T00:00:00.000Z')`,
  ).run();
}

async function run020(db: Database.Database): Promise<void> {
  const sql020 = await loadMigrationFile(20);
  db.transaction(() => {
    db.exec(sql020);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(20n, new Date().toISOString());
  }).immediate();
}

/** Seed canonical history and audit data independently of the obsolete sidecar. */
function seedCanonicalData(db: Database.Database): void {
  seedChat(db);
  seedBucketAndInvocation(db);
  db.prepare(`
    INSERT INTO conversation_contexts(id, conversation_id, head_seq, next_seq, send_count_total, system_prompt_hash, last_active_at, created_at, updated_at)
    VALUES (1, 1, 4, 5, 2, 'hash-abc', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, est_tokens, created_at)
    VALUES (1, 4, 'user', '{"role":"user","content":"hello","timestamp":1735689600000}', 1, 1, 10, '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO context_refs(context_id, ref, kind, source_seq, target_conversation_id, target_thread_id, expires_at, created_at)
    VALUES (1, 'reply:10', 'reply', 4, 1, 0, '2099-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO agent_messages(id, invocation_id, sequence_no, role, text, thinking_text, created_at)
    VALUES (300, 1, 1, 'tool_result', 'ordinary audit', '', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at)
    VALUES (400, 1, 'tc-real', 'send', '{}', 'success', 1, '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, created_at)
    VALUES (401, 400, 1, 'text', '{}', 'success', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO internal_contexts(id, conversation_id, invocation_id, source_agent_message_id, kind, version, observed_at, payload_json, created_at)
    VALUES (600, 1, 1, 300, 'alarm_list', 1, '2025-07-01T00:00:00.000Z', 'invalid legacy payload', '2025-07-01T00:00:00.000Z')
  `).run();
}

function canonicalSnapshot(db: Database.Database) {
  return {
    headers: db.prepare('SELECT * FROM conversation_contexts ORDER BY id').all(),
    messages: db.prepare('SELECT * FROM context_messages ORDER BY context_id, seq').all(),
    refs: db.prepare('SELECT * FROM context_refs ORDER BY context_id, ref').all(),
    agentMessages: db.prepare('SELECT * FROM agent_messages ORDER BY id').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    sends: db.prepare('SELECT * FROM telegram_sends ORDER BY id').all(),
  };
}

describe('migration 020', () => {
  test('creates long_tasks and task_receipts tables', async () => {
    const { db } = await createPre020Db();
    await run020(db);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('long_tasks', 'task_receipts', 'alarms')",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain('long_tasks');
    expect(tables).toContain('task_receipts');
    expect(tables).not.toContain('alarms');

    db.close();
  });

  test('keeps Drizzle checks and partial indexes aligned with migrated SQLite', async () => {
    const { db } = await createPre020Db();
    try {
      await run020(db);
      db.exec(await loadMigrationFile(22));
      const dialect = new SQLiteSyncDialect();
      const normalize = (text: string): string => text.replace(/["\s]/g, '').toLowerCase();
      for (const table of [longTasks, taskReceipts]) {
        const definition = getTableConfig(table);
        const ddl = db
          .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(definition.name)!.sql;
        expect(definition.checks).toHaveLength(ddl.match(/\bCHECK\s*\(/gi)?.length ?? 0);
        for (const constraint of definition.checks) {
          expect(normalize(ddl)).toContain(normalize(`CHECK (${dialect.sqlToQuery(constraint.value).sql})`));
        }
        const actualIndexes = db
          .prepare<[string], { sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
          )
          .all(definition.name);
        expect(actualIndexes).toHaveLength(definition.indexes.length);
        for (const { config } of definition.indexes) {
          const columns = config.columns.map((column) => {
            if (!('name' in column)) {
              throw new Error('Task indexes must use named columns');
            }
            return column.name;
          });
          const predicate = config.where ? ` WHERE ${dialect.sqlToQuery(config.where).sql}` : '';
          const expected = `CREATE ${config.unique ? 'UNIQUE ' : ''}INDEX ${config.name} ON ${definition.name}(${columns.join(', ')})${predicate}`;
          expect(actualIndexes.map((index) => normalize(index.sql))).toContain(normalize(expected));
        }
      }
    } finally {
      db.close();
    }
  });

  test('migrates pending alarms to waiting timer tasks', async () => {
    const { db } = await createPre020Db();
    seedChat(db);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, updated_at, created_by_user_id)
      VALUES (10, 1, 999999, 'TargetUser', 'wake up',
        '${future}', '2025-06-01T00:00:00.000Z', 'pending',
        '2025-06-01T00:00:00.000Z', 42)
    `).run();

    await run020(db);

    const task = db
      .prepare<
        [],
        {
          id: bigint;
          plugin_id: string;
          state: string;
          scheduled_at: string;
          delivery_json: string;
          payload_json: string;
          created_by_user_id: bigint;
        }
      >('SELECT * FROM long_tasks WHERE id = 10')
      .get();
    expect(task).toBeDefined();
    expect(task!.id).toBe(10n);
    expect(task!.plugin_id).toBe('alarm');
    expect(task!.state).toBe('waiting');
    expect(task!.scheduled_at).toBe(future);
    expect(task!.created_by_user_id).toBe(42n);

    const delivery = JSON.parse(task!.delivery_json);
    expect(delivery.bypassDailyBudget).toBe(true);
    expect(delivery.mentionUser.userId).toBe('999999');
    expect(delivery.mentionUser.displayName).toBe('TargetUser');

    const payload = JSON.parse(task!.payload_json);
    expect(payload.target_user_id).toBe('999999');
    expect(payload.target_display_name).toBe('TargetUser');
    expect(payload.summary).toBe('wake up');

    db.close();
  });

  test('migrates firing alarms to completed + claimed receipt', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, fired_at, invocation_id, invocation_outcome, updated_at)
      VALUES (11, 1, 888888, 'FiredUser', 'reminder',
        '${past}', '2025-06-01T00:00:00.000Z', 'firing',
        '2025-06-02T00:00:00.000Z', 1, 'completed', '2025-06-02T00:00:00.000Z')
    `).run();

    await run020(db);

    const task = db.prepare<[], { state: string }>('SELECT state FROM long_tasks WHERE id = 11').get();
    expect(task!.state).toBe('completed');

    const receipt = db
      .prepare<
        [],
        {
          status: string;
          state: string;
          invocation_id: bigint;
          invocation_outcome: string;
        }
      >('SELECT status, state, invocation_id, invocation_outcome FROM task_receipts WHERE task_id = 11')
      .get();
    expect(receipt!.status).toBe('completed');
    expect(receipt!.state).toBe('claimed');
    expect(receipt!.invocation_id).toBe(1n);
    expect(receipt!.invocation_outcome).toBe('completed');

    db.close();
  });

  test('migrates fired alarms to completed + handled receipt', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    const past = new Date(Date.now() - 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, fired_at, invocation_id, invocation_outcome, updated_at)
      VALUES (12, 1, 777777, 'DoneUser', 'done',
        '${past}', '2025-06-01T00:00:00.000Z', 'fired',
        '2025-06-02T00:00:00.000Z', 1, 'completed', '2025-06-02T00:00:00.000Z')
    `).run();

    await run020(db);

    const receipt = db.prepare<[], { state: string }>('SELECT state FROM task_receipts WHERE task_id = 12').get();
    expect(receipt!.state).toBe('handled');

    db.close();
  });

  test('migrates cancelled alarms to cancelled + suppressed receipt', async () => {
    const { db } = await createPre020Db();
    seedChat(db);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, cancelled_at, cancelled_by, cancel_reason, updated_at)
      VALUES (13, 1, 666666, 'CancelledUser', 'nope',
        '${future}', '2025-06-01T00:00:00.000Z', 'cancelled',
        '2025-06-02T00:00:00.000Z', 'user', 'changed mind', '2025-06-02T00:00:00.000Z')
    `).run();

    await run020(db);

    const task = db.prepare<[], { state: string }>('SELECT state FROM long_tasks WHERE id = 13').get();
    expect(task!.state).toBe('cancelled');

    const receipt = db
      .prepare<[], { status: string; state: string }>('SELECT status, state FROM task_receipts WHERE task_id = 13')
      .get();
    expect(receipt!.status).toBe('cancelled');
    expect(receipt!.state).toBe('suppressed');

    db.close();
  });

  test('020 ignores alarm_list rows in internal_contexts (valid, empty, invalid) — 021 drops them all later', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    const observedAt = '2025-07-01T00:00:00.000Z';
    // Valid alarm_list payload
    const validPayload = JSON.stringify({
      kind: 'alarm_list',
      version: 1,
      observed_at: observedAt,
      items: [{ id: '100', scheduled_at: '2025-08-01T00:00:00.000Z', summary: 'valid' }],
    });
    // Empty alarm_list payload
    const emptyPayload = JSON.stringify({ kind: 'alarm_list', version: 1, observed_at: observedAt, items: [] });
    // Invalid alarm_list payload (null item id)
    const invalidPayload =
      '{"kind":"alarm_list","version":1,"observed_at":"2025-07-01T00:00:00.000Z","items":[{"id":null,"scheduled_at":"2025-08-01T00:00:00.000Z","summary":"ok"}]}';
    const insert = db.prepare(`
      INSERT INTO internal_contexts(id, conversation_id, invocation_id, kind, version, observed_at, payload_json, created_at)
      VALUES (?, 1, 1, 'alarm_list', 1, ?, ?, '2025-07-01T00:00:00.000Z')
    `);
    insert.run(1n, observedAt, validPayload);
    insert.run(2n, observedAt, emptyPayload);
    insert.run(3n, observedAt, invalidPayload);

    // 020 no longer validates or converts alarm_list — all rows survive 020 unchanged
    await run020(db);

    const rows = db
      .prepare<[], { id: bigint; kind: string; payload_json: string }>(
        'SELECT id, kind, payload_json FROM internal_contexts ORDER BY id',
      )
      .all();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.kind).toBe('alarm_list');
    expect(rows[1]!.kind).toBe('alarm_list');
    expect(rows[2]!.kind).toBe('alarm_list');
    expect(rows.map((row) => row.payload_json)).toEqual([validPayload, emptyPayload, invalidPayload]);
    db.exec(await loadMigrationFile(21));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);

    db.close();
  });

  test('preserves alarm IDs as bigint (no precision loss)', async () => {
    const { db } = await createPre020Db();
    seedChat(db);

    const largeId = 0x7fffffff_ffff0000n;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, updated_at, created_by_user_id)
      VALUES (${largeId.toString()}, 1, ${largeId.toString()}, 'BigUser', 'large',
        '${future}', '2025-06-01T00:00:00.000Z', 'pending',
        '2025-06-01T00:00:00.000Z', ${largeId.toString()})
    `).run();

    await run020(db);

    const task = db
      .prepare<[bigint], { id: bigint; created_by_user_id: bigint; payload_json: string }>(
        'SELECT id, created_by_user_id, payload_json FROM long_tasks WHERE id = ?',
      )
      .get(largeId);
    expect(task!.id).toBe(largeId);
    expect(task!.created_by_user_id).toBe(largeId);
    const payload = JSON.parse(task!.payload_json);
    expect(payload.target_user_id).toBe(largeId.toString());

    db.close();
  });

  test('preserves tool_calls and telegram_sends without rebuilding either table', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    db.prepare(`
      INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at)
      VALUES (1, 1, 'tc-1', 'alarm', '{}', 'success', 1, '2025-01-01T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, created_at)
      VALUES (1, 1, 1, 'text', '{}', 'success', '2025-01-01T00:00:00.000Z')
    `).run();
    const beforeSql = db
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'tool_calls'")
      .get()!.sql;

    await run020(db);

    expect(db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'tool_calls'").get()!.sql).toBe(
      beforeSql,
    );
    expect(
      db.prepare<[], { tool_call_id: string }>('SELECT tool_call_id FROM tool_calls WHERE id = 1').get()!.tool_call_id,
    ).toBe('tc-1');
    expect(
      db.prepare<[], { tool_call_id: bigint }>('SELECT tool_call_id FROM telegram_sends WHERE id = 1').get()!
        .tool_call_id,
    ).toBe(1n);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    db.close();
  });

  test('preserves cancelled alarm claim audit and nullable owners', async () => {
    const { db } = await createPre020Db();
    try {
      seedChat(db);
      seedBucketAndInvocation(db);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      db.prepare(`
        INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
          scheduled_at, created_at, state, fired_at, cancelled_at, updated_at, created_by_user_id,
          invocation_id, admin_cancelled, cancelled_by, cancel_reason)
        VALUES (14, 1, 555, 'Cancelled', 'claimed then cancelled', ?,
          '2025-06-01T00:00:00.000Z', 'cancelled', '2025-06-01T01:00:00.000Z',
          '2025-06-01T02:00:00.000Z', '2025-06-01T02:00:00.000Z', NULL,
          1, 1, 'owner', 'admin_cancel')
      `).run(future);

      await run020(db);

      const task = db
        .prepare<[], { created_by_user_id: bigint | null }>('SELECT created_by_user_id FROM long_tasks WHERE id = 14')
        .get();
      const receipt = db.prepare('SELECT * FROM task_receipts WHERE task_id = 14').get();
      expect(task!.created_by_user_id).toBeNull();
      expect(receipt).toMatchObject({
        status: 'cancelled',
        state: 'suppressed',
        invocation_id: 1n,
        claimed_at: '2025-06-01T01:00:00.000Z',
        cancelled_at: '2025-06-01T02:00:00.000Z',
        cancelled_by: 'owner',
        admin_cancelled: 1n,
        cancel_reason: 'admin_cancel',
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

test('migration 022 backfills receipt buckets, permits shared invocations and keeps bucket bindings unique', async () => {
  const { db } = await createPre020Db();
  try {
    seedChat(db);
    seedBucketAndInvocation(db);
    await run020(db);
    db.exec(`INSERT INTO long_tasks(id, plugin_id, conversation_id, payload_json, state, delivery_json, created_at, updated_at)
      VALUES (1, 'test', 1, '{}', 'completed', '{}', 'now', 'now'), (2, 'test', 1, '{}', 'completed', '{}', 'now', 'now');
      INSERT INTO task_receipts(task_id, status, state, created_at, updated_at, invocation_id)
      VALUES (1, 'completed', 'claimed', 'now', 'now', 1), (2, 'completed', 'pending', 'now', 'now', NULL);`);
    db.exec(await loadMigrationFile(22));
    expect(db.prepare('SELECT task_id, bucket_id FROM task_receipts ORDER BY task_id').all()).toEqual([
      { task_id: 1n, bucket_id: 1n },
      { task_id: 2n, bucket_id: null },
    ]);
    expect(() => db.prepare('UPDATE task_receipts SET invocation_id = 1 WHERE task_id = 2').run()).not.toThrow();
    expect(() => db.prepare('UPDATE task_receipts SET bucket_id = 1 WHERE task_id = 2').run()).toThrow(/UNIQUE/);
    expect(() => db.prepare('UPDATE task_receipts SET bucket_id = 999 WHERE task_id = 2').run()).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM invocations WHERE id = 1').run();
    db.prepare('DELETE FROM buckets WHERE id = 1').run();
    expect(db.prepare('SELECT invocation_id, bucket_id FROM task_receipts WHERE task_id = 1').get()).toEqual({
      invocation_id: null,
      bucket_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});

describe('migration 021', () => {
  test.each([19, 20])('upgrades version %i without changing canonical history, audit, or tasks', async (version) => {
    const { db, directory } = await createPre020Db();
    seedCanonicalData(db);
    const canonical = canonicalSnapshot(db);
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, updated_at, created_by_user_id, invocation_id,
        fired_at, invocation_outcome, completion_reason)
      VALUES (500, 1, 42, 'Alice', 'retained task',
        '2025-08-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', 'fired',
        '2025-08-01T00:00:00.000Z', 42, 1, '2025-08-01T00:00:00.000Z', 'completed', 'done')
    `).run();
    if (version === 20) {
      await run020(db);
      db.prepare(`UPDATE internal_contexts SET kind = 'observation', payload_json = ? WHERE id = 600`).run(
        JSON.stringify({ kind: 'observation', version: 1, observed_at: '2025-07-01T00:00:00.000Z', text: 'legacy' }),
      );
    }
    let tasks = version === 20 ? db.prepare('SELECT * FROM long_tasks ORDER BY id').all() : undefined;
    let receipts =
      version === 20 ? db.prepare('SELECT *, 1 AS bucket_id FROM task_receipts ORDER BY task_id').all() : undefined;
    db.close();
    const { config } = await loadConfig(join(directory, 'config.jsonc'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await SqliteStore.open(config);
      try {
        expect(canonicalSnapshot(store.db)).toEqual(canonical);
        const actualTasks = store.db.prepare('SELECT * FROM long_tasks ORDER BY id').all();
        const actualReceipts = store.db.prepare('SELECT * FROM task_receipts ORDER BY task_id').all();
        expect(actualTasks).toMatchObject([
          { id: 500n, plugin_id: 'alarm', state: 'completed', created_by_user_id: 42n },
        ]);
        expect(actualReceipts).toMatchObject([
          { task_id: 500n, status: 'completed', state: 'handled', invocation_id: 1n, completion_reason: 'done' },
        ]);
        tasks ??= actualTasks;
        receipts ??= actualReceipts;
        expect(actualTasks).toEqual(tasks);
        expect(actualReceipts).toEqual(receipts);
        expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);
        expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
          version: 27n,
        });
        expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        store.close();
      }
    }
  });

  test('fresh and reopened stores have no sidecar table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-mig-021-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await SqliteStore.open(config);
      try {
        expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
          version: 27n,
        });
        expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);
      } finally {
        store.close();
      }
    }
  });
});
