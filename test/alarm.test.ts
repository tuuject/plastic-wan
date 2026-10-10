import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Tool } from '@earendil-works/pi-ai';
import { getJsonSchemaToolParameters } from '@earendil-works/pi-ai/api/constrained-sampling';
import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { Compile } from 'typebox/compile';
import { cancelAlarm, listAlarms } from '../src/plugins/alarm/admin.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { AlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { alarmTools, getAlarmTask } from './alarm-fixtures.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { purgeExpiredData, SqliteStore } from '../src/store/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { createSendTool, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { enterSleep } from '../src/store/sleep.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { capability } from '../src/capabilities/execute-tool.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import {
  fauxRegistry,
  invocationCapabilities,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  type TestContextOptions,
  type TestRegistry,
} from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 30_000);

async function setup(registry?: TestRegistry, recordPayloads = false) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.developer = { record_model_payloads: recordPayloads };
      config.telegram.admins = [42];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, registry);
  const store = await SqliteStore.open(loaded.config);
  return {
    directory,
    configPath,
    loaded,
    configStore,
    config: loaded.config,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    })),
    build: (invocationId: bigint, options: TestContextOptions = {}) =>
      renderInvocationContext(store, loaded.config, invocationId, options),
  };
}

async function setupAdmin(): Promise<{
  store: SqliteStore;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  configStore: RuntimeConfigurationStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
      };
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded, configStore };
}

function update(updateId: number, messageId: number, text: string, userId = 42): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function processDue(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

const ADMIN_PASSWORD = 'correct-horse-battery';

function adminRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function adminPost(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return adminRequest(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function adminSessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function futureIso(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString();
}

function ensureConversation(store: SqliteStore): bigint {
  const existing = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1').get();
  if (existing !== undefined) {
    return existing.id;
  }
  const chat = store.db
    .prepare<[string], { id: bigint }>(
      "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (123456789, 123456789, 'private', 'Owner', ?) RETURNING id",
    )
    .get(new Date().toISOString());
  const conversation = store.db
    .prepare<[bigint, string, string], { id: bigint }>(
      'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
    )
    .get(chat?.id ?? 0n, new Date().toISOString(), new Date().toISOString());
  return conversation?.id ?? 0n;
}

function insertAlarm(
  store: SqliteStore,
  conversationId: bigint,
  scheduledAt: string,
  options: {
    targetUserId?: bigint;
    displayName?: string;
    summary?: string;
    state?: string;
    invocationId?: bigint;
  } = {},
): bigint {
  const targetUserId = options.targetUserId ?? 42n;
  const displayName = options.displayName ?? 'Alice';
  const payload = {
    target_user_id: targetUserId.toString(),
    target_display_name: displayName,
    summary: options.summary ?? 'test alarm',
  };
  const createdAt = new Date(Date.parse(scheduledAt) - 60_000).toISOString();
  const taskId = new LongTaskService(store.orm).scoped('alarm', conversationId).create(
    {
      payload,
      scheduledAt,
      timerResult: payload,
      delivery: { bypassDailyBudget: true, mentionUser: { userId: targetUserId, displayName } },
    },
    new Date(createdAt),
  ).taskId;
  const state = options.state ?? 'pending';
  if (state !== 'pending') {
    new LongTaskService(store.orm).processDue(new Date(scheduledAt));
    if (state === 'firing' || state === 'fired') {
      store.db
        .prepare(
          `UPDATE task_receipts SET state = ?, invocation_id = ?, claimed_at = ?, handled_at = ?, updated_at = ? WHERE task_id = ?`,
        )
        .run(
          state === 'firing' ? 'claimed' : 'handled',
          options.invocationId ?? null,
          scheduledAt,
          state === 'fired' ? scheduledAt : null,
          scheduledAt,
          taskId,
        );
    } else if (state === 'cancelled') {
      store.db
        .prepare(`UPDATE long_tasks SET state = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ?`)
        .run(scheduledAt, scheduledAt, taskId);
      store.db
        .prepare(
          `UPDATE task_receipts SET status = 'cancelled', result_json = NULL, state = 'suppressed', cancelled_at = ?, updated_at = ? WHERE task_id = ?`,
        )
        .run(scheduledAt, scheduledAt, taskId);
    }
  }
  return taskId;
}
describe('alarm tool', () => {
  test('validates schema boundaries and persists a pending alarm with UTC deadline', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });

    expect(Compile(AlarmInputSchema).Check({ target_user_id: '42', summary: 'x', datetime: futureIso(3600_000) })).toBe(
      true,
    );
    expect(Compile(AlarmInputSchema).Check({ target_user_id: '42', summary: '', datetime: futureIso(3600_000) })).toBe(
      false,
    );
    expect(
      Compile(AlarmInputSchema).Check({
        target_user_id: '42',
        summary: 'x'.repeat(501),
        datetime: futureIso(3600_000),
      }),
    ).toBe(false);
    expect(Compile(AlarmInputSchema).Check({ target_user_id: '0', summary: 'x', datetime: futureIso(3600_000) })).toBe(
      false,
    );

    const scheduled = futureIso(3_600_000);
    const tool = alarmTools(store, config, context).alarm;
    expect(tool.description).toContain('Use only when a new user message explicitly requests a future reminder');
    expect(tool.description).toContain('use send to clarify instead of calling alarm');
    expect(tool.description).toContain('After success, use send to briefly confirm');
    const result = await tool.execute('call-1', {
      target_user_id: '42',
      summary: 'follow up on the hospital visit',
      datetime: scheduled,
    });
    expect(result.details.scheduled_at).toBe(scheduled);
    const row = store.db
      .prepare<
        [string],
        { state: string; target_user_id: string; created_by_user_id: bigint | null; scheduled_at: string }
      >(`SELECT state, json_extract(payload_json, '$.target_user_id') AS target_user_id,
                created_by_user_id, scheduled_at FROM long_tasks WHERE id = ?`)
      .get(result.details.id);
    expect(row).toEqual({ state: 'waiting', target_user_id: '42', created_by_user_id: 42n, scheduled_at: scheduled });
    const audit = store.db
      .prepare<[], { state: string; error_code: string | null; result_text: string | null }>(
        'SELECT state, error_code, result_text FROM tool_calls',
      )
      .get();
    expect(audit?.state).toBe('success');
    expect(audit?.error_code).toBe(null);
    expect(audit?.result_text).toContain('alarm_id=');
    store.close();
  });

  test('rejects unauthorized targets, bad datetimes, and enforces a per-invocation quota', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello', 42), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const tool = alarmTools(store, config, context).alarm;

    await expect(
      tool.execute('unauthorized', { target_user_id: '999', summary: 'x', datetime: futureIso(3600_000) }),
    ).rejects.toThrow('not visible');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>(
          "SELECT error_code FROM tool_calls WHERE tool_call_id = 'unauthorized'",
        )
        .get()?.error_code,
    ).toBe('alarm_target_not_authorized');

    await expect(
      tool.execute('past', { target_user_id: '42', summary: 'x', datetime: futureIso(-1000) }),
    ).rejects.toThrow('datetime is invalid');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'past'")
        .get()?.error_code,
    ).toBe('alarm_datetime_not_future');

    await expect(
      tool.execute('far', { target_user_id: '42', summary: 'x', datetime: futureIso(366 * 86_400_000) }),
    ).rejects.toThrow('datetime is invalid');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'far'")
        .get()?.error_code,
    ).toBe('alarm_datetime_too_far');

    for (let index = 0; index < 3; index += 1) {
      await tool.execute(`quota-${index}`, {
        target_user_id: '42',
        summary: `alarm ${index}`,
        datetime: futureIso((index + 1) * 3_600_000),
      });
    }
    await expect(
      tool.execute('quota-3', { target_user_id: '42', summary: 'fourth', datetime: futureIso(5 * 3_600_000) }),
    ).rejects.toThrow('quota');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'quota-3'")
        .get()?.error_code,
    ).toBe('alarm_quota_exceeded');
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM long_tasks WHERE plugin_id = 'alarm'")
        .get()?.count,
    ).toBe(3n);
    store.close();
  });

  test('list_alarm parameters schema is a strict empty object accepted by provider adapters', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const tool = alarmTools(store, config, context).list_alarm;
    expect(tool.description).toContain('Use when the user asks what reminders they have');
    expect(tool.description).toContain('call delete_alarm directly');
    expect(tool.description).toContain('never expose internal alarm IDs');

    // Regression: `Invalid schema for function 'list_alarm':
    // schema must be a JSON Schema of type object, got type null`.
    const schema = tool.parameters as unknown as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
    expect(schema.additionalProperties).toBe(false);
    // The same transformation provider adapters apply before sending tools.
    expect(getJsonSchemaToolParameters(tool as Tool, undefined)).toEqual(schema);
    expect(() => getJsonSchemaToolParameters(tool as Tool, true)).not.toThrow();
    const strictSchema = getJsonSchemaToolParameters(tool as Tool, true) as Record<string, unknown>;
    expect(strictSchema.type).toBe('object');
    expect(strictSchema.required).toEqual([]);
    expect(strictSchema.additionalProperties).toBe(false);

    // An empty-object tool call passes runtime argument validation, and the
    // audit trail records the empty-object arguments instead of null.
    const validator = Compile(tool.parameters);
    expect(validator.Check({})).toBe(true);
    expect(validator.Check({ user_id: '42' })).toBe(false);
    const result = await tool.execute('schema-call', {});
    expect(result.details.items).toEqual([]);
    const audit = store.db
      .prepare<[string], { arguments_json: string; state: string; error_code: string | null }>(
        'SELECT arguments_json, state, error_code FROM tool_calls WHERE tool_call_id = ?',
      )
      .get('schema-call');
    expect(audit?.state).toBe('success');
    expect(audit?.error_code).toBe(null);
    expect(audit?.arguments_json).toBe('{}');
    store.close();
  });

  test('the agent runtime presents list_alarm with an object schema to the model', async () => {
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const { store, config, ingestion, scheduler, configStore } = await setup(fauxRegistry(faux), true);
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '我有哪些闹钟'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));

    faux.setResponses([
      (context, options) => {
        // Mirror what real adapters do: capture the provider payload for audit.
        options?.onPayload?.(
          { model: 'agent-model', messages: context.messages, tools: context.tools },
          faux.getModel(),
        );
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        // list_alarm is no longer directly exposed; its schema reaches the
        // model through the execute help action instead.
        return fauxAssistantMessage(fauxToolCall('execute', { action: 'help', tool: 'list_alarm' }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        const last = context.messages.filter((message) => message.role === 'toolResult').at(-1);
        const helpText =
          last === undefined
            ? ''
            : last.content
                .filter((entry) => entry.type === 'text')
                .map((entry) => entry.text)
                .join('');
        const helped = JSON.parse(helpText) as { name: string; parameters: unknown };
        expect(helped.name).toBe('list_alarm');
        expect(helped.parameters).toEqual({
          type: 'object',
          properties: {},
          additionalProperties: false,
        });
        return fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'list_alarm', input: {} }), {
          stopReason: 'toolUse',
        });
      },
      fauxAssistantMessage('listed'),
      // Non-empty draft triggers the send nudge; the model then stays silent.
      fauxAssistantMessage(''),
    ]);
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      telegramApi: {
        sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
        sendSticker: async () => ({ message_id: 501, date: 1_700_000_101, chat: { id: 123456789 } }),
      },
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      modelGate: new KeyedSemaphore(),
      systemResources: SystemResources.empty(),
      capabilityTools: (context) => [capability(alarmTools(store, config, context).list_alarm, false)],
    });
    expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'completed',
      reason: 'completed',
    });

    const presented = store.db
      .prepare<[], { tools_json: string }>(
        "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
      )
      .get();
    expect(presented?.tools_json).toBe(JSON.stringify(['read', 'send', 'send_reply', 'execute']));
    const auditPayload = store.db
      .prepare<[], { request_json: string | null }>(
        "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
      )
      .get();
    const payload = JSON.parse(auditPayload?.request_json ?? 'null') as { tools?: Array<Record<string, unknown>> };
    // The model-facing registry carries only the runtime primitives; the
    // list_alarm schema was served by the execute help action above.
    expect(payload.tools?.map((entry) => entry.name)).toEqual(['read', 'send', 'send_reply', 'execute']);
    // The faux tool call id is generated; match by tool name instead.
    const listAudit = store.db
      .prepare<[], { arguments_json: string; state: string }>(
        "SELECT arguments_json, state FROM tool_calls WHERE tool_name = 'list_alarm' LIMIT 1",
      )
      .get();
    expect(listAudit?.state).toBe('success');
    expect(listAudit?.arguments_json).toBe('{}');
    store.close();
  });
});

describe('alarm scheduler', () => {
  test('claims a due alarm into an invocation and leaves the topic conversation untouched', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    const invocations = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(invocations).toHaveLength(1);
    const alarm = getAlarmTask(store, alarmId);
    expect(alarm?.task_state).toBe('completed');
    expect(alarm?.receipt_state).toBe('claimed');
    expect(alarm?.state).toBe('firing');
    expect(alarm?.invocation_id).toBe(invocations[0]);
    const context = build(invocations[0] ?? 0n, { contextWindow: 200_000, maxOutputTokens: 32768 });
    expect(context.completion?.delivery.mentionUser?.userId).toBe(42n);
    // The alarm task is per-invocation state and travels with the injected batch.
    expect(context.userPrompt).toContain('test alarm');
    expect(context.userPrompt).toContain('long-running task has finished');
    expect(context.systemPrompt).not.toContain('test alarm');
    const newCount = store.db
      .prepare<[bigint], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? AND section = 'new'",
      )
      .get(invocations[0] ?? 0n)?.count;
    expect(newCount).toBe(0n);
    store.close();
  });

  test('cancels due alarms for pause, chat removal, and topic removal', async () => {
    const { store, scheduler } = await setup();
    const conversation = ensureConversation(store);
    const chat = store.db
      .prepare<[bigint], { chat_id: bigint }>('SELECT chat_id FROM conversations WHERE id = ?')
      .get(conversation);
    const pausedAlarm = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
    store.db
      .prepare('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)')
      .run(chat?.chat_id ?? 0n, new Date().toISOString());
    scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(getAlarmTask(store, pausedAlarm)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'suppressed',
      state: 'cancelled',
      cancel_reason: 'chat_paused',
    });

    const removedChat = store.db
      .prepare<[string], { id: bigint }>(
        "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (999999999, 999999999, 'group', 'Removed', ?) RETURNING id",
      )
      .get(new Date().toISOString());
    const removedConversation = store.db
      .prepare<[bigint, string, string], { id: bigint }>(
        'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
      )
      .get(removedChat?.id ?? 0n, new Date().toISOString(), new Date().toISOString());
    const removedAlarm = insertAlarm(store, removedConversation?.id ?? 0n, '2026-08-14T23:59:00.000Z');
    scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(getAlarmTask(store, removedAlarm)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'suppressed',
      state: 'cancelled',
      cancel_reason: 'chat_removed',
    });
    store.close();
  });

  test('recovers a firing alarm as fired/outcome_unknown and never returns it to pending', async () => {
    const { store, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { state: 'firing' });
    scheduler.recover(new Date('2026-08-15T00:00:00.000Z'));
    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'handled',
      state: 'fired',
      invocation_outcome: 'outcome_unknown',
      completion_reason: 'outcome_unknown',
    });
    scheduler.recover(new Date('2026-08-15T00:00:01.000Z'));
    expect(getAlarmTask(store, alarmId)?.state).toBe('fired');
    store.close();
  });
});

describe('alarm runtime budget bypass', () => {
  test('an alarm invocation bypasses the daily token gate while an ordinary invocation still blocks', async () => {
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const { store, ingestion, scheduler, loaded, configStore } = await setup(fauxRegistry(faux));
    // Real-clock-relative dates: the runtime anchors a batch's collection window
    // to the instant the agent becomes free, so a test that drives ingestion with
    // frozen dates in the past would compare fake instants against real ones.
    const start = Date.now();
    const received = new Date(start);
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    // Exhaust the daily token budget for the real UTC date.
    const today = new Date().toISOString().slice(0, 10);
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?) ON CONFLICT(utc_date, scope, resource, metric) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at",
      )
      .run(today, '123456789', BigInt(loaded.config.agent.daily_budget.max_tokens), new Date().toISOString());

    insertAlarm(store, conversation.id, new Date(start - 60_000).toISOString());
    const [alarmInvocation] = scheduler.processTasksDue(new Date(start));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }

    faux.setResponses([
      fauxAssistantMessage('followed up'),
      // Non-empty draft triggers the send nudge; the model then stays silent.
      fauxAssistantMessage(''),
    ]);
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      telegramApi: {
        sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
        sendSticker: async () => ({ message_id: 501, date: 1_700_000_101, chat: { id: 123456789 } }),
      },
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      modelGate: new KeyedSemaphore(),
      systemResources: SystemResources.empty(),
    });
    expect(await runtime.run(alarmInvocation, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'completed',
      reason: 'completed',
    });

    // Release the alarm invocation so the same chat can schedule a normal bucket.
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), alarmInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date().toISOString(), alarmInvocation);
    ingestion.ingest(update(2, 11, 'next'), new Date(start));
    // The alarm run re-anchored the collecting batch to its round end, so the
    // batch is due one bucket window after that: ask for a moment past it.
    const [normalInvocation] = scheduler.processDue(
      new Date(Math.max(Date.now(), start) + loaded.config.telegram.bucket_window_seconds * 1_000 + 1_000),
    );
    if (normalInvocation === undefined) {
      throw new Error('Expected normal invocation');
    }
    expect(await runtime.run(normalInvocation, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'failed',
      reason: 'daily_token_budget',
    });
    store.close();
  });
});

describe('alarm send mention', () => {
  test('prefixes the first successful text send with a target mention and leaves later sends alone', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });
    expect(context.completion).not.toBe(null);

    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      api,
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    // A sticker ref comes from search_stickers: without one, send refuses, and a
    // successful sticker send carries no alarm mention.
    await expect(tool.execute('sticker-1', { kind: 'sticker', sticker_ref: 'stk_unknown' })).rejects.toThrow(
      'not authorized',
    );
    const stickerRef = capabilities.registerStickerRef('file-id');
    await tool.execute('sticker-2', { kind: 'sticker', sticker_ref: stickerRef });
    expect(requests).toHaveLength(0);
    await tool.execute('text-1', { kind: 'text', text: 'how are you now?' });
    expect(requests[0]?.text).toBe('@Alice how are you now?');
    expect(requests[0]?.options.entities).toEqual([
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=42' },
    ]);
    await tool.execute('text-2', { kind: 'text', text: 'second message' });
    expect(requests[1]?.text).toBe('second message');
    expect(requests[1]?.options.entities).toBeUndefined();
    store.close();
  });
});

describe('alarm admin', () => {
  test('lists alarms with pending-first ordering and stable cursor pagination', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    const pending1 = insertAlarm(store, conversation, '2026-08-15T02:00:00.000Z', { summary: 'pending 1' });
    const pending2 = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z', { summary: 'pending 2' });
    const fired = insertAlarm(store, conversation, '2026-08-15T00:30:00.000Z', { state: 'fired', summary: 'fired' });
    store.db
      .prepare('UPDATE task_receipts SET claimed_at = ?, handled_at = ?, updated_at = ? WHERE task_id = ?')
      .run('2026-08-15T00:30:00.000Z', '2026-08-15T00:30:00.000Z', '2026-08-15T00:30:00.000Z', fired);

    const first = listAlarms(store.orm, { limit: '2' });
    expect(first.items.map((item) => item.id)).toEqual([pending2.toString(), pending1.toString()]);
    expect(first.next_cursor).not.toBe(null);
    const second = listAlarms(store.orm, { limit: '2', cursor: first.next_cursor });
    expect(second.items.map((item) => item.id)).toEqual([fired.toString()]);
    expect(second.next_cursor).toBe(null);
    store.close();
  });

  test('filters by state, chat, and target and keeps bigint ids as strings', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z', { summary: 'mine', targetUserId: 42n });
    insertAlarm(store, conversation, '2026-08-15T02:00:00.000Z', { summary: 'other', targetUserId: 7n });
    const mine = listAlarms(store.orm, { target: '42' });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]?.target_user_id).toBe('42');
    expect(mine.items[0]?.chat.message_thread_id).toBe('0');
    expect(mine.items[0]?.conversation_id).toBe(conversation.toString());
    const pending = listAlarms(store.orm, { state: 'pending' });
    expect(pending.items).toHaveLength(2);
    const fired = listAlarms(store.orm, { state: 'fired' });
    expect(fired.items).toHaveLength(0);
    store.close();
  });

  test('atomically cancels only pending alarms and records the admin actor', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z');
    expect(cancelAlarm(new LongTaskService(store.orm), store.orm, pending, 'owner')).toEqual({ status: 'cancelled' });
    const row = store.db
      .prepare<
        [bigint],
        { state: string; cancelled_by: string | null; admin_cancelled: bigint; cancel_reason: string | null }
      >(`SELECT lt.state, tr.cancelled_by, tr.admin_cancelled, tr.cancel_reason
         FROM long_tasks lt JOIN task_receipts tr ON tr.task_id = lt.id WHERE lt.id = ?`)
      .get(pending);
    expect(row).toEqual({
      state: 'cancelled',
      cancelled_by: 'owner',
      admin_cancelled: 1n,
      cancel_reason: 'admin_cancelled',
    });
    expect(() => cancelAlarm(new LongTaskService(store.orm), store.orm, pending, 'owner')).toThrow(
      'Only pending alarms can be cancelled',
    );
    expect(() => cancelAlarm(new LongTaskService(store.orm), store.orm, 999999n, 'owner')).toThrow('does not exist');
    store.close();
  });
});

describe('alarm scheduling behavior', () => {
  test('launches a claimed alarm before an already-queued normal invocation, then the queued normal runs', async () => {
    const { store, ingestion, scheduler, configStore } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const normalInvocation = processDue(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');

    const launched: bigint[] = [];
    let releaseGate!: () => void;
    let firstLaunched!: () => void;
    const firstSignal = new Promise<void>((resolve) => {
      firstLaunched = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const recording = new BucketScheduler(store, configStore, async (id) => {
      launched.push(id);
      if (launched.length === 1) {
        firstLaunched();
        await gate;
      }
      return { state: 'completed', reason: 'done' };
    });
    recording.start(new Date('2026-08-15T00:00:00.000Z'));
    await firstSignal;
    const alarmInvocation = store.db
      .prepare<[], { invocation_id: bigint }>(
        "SELECT invocation_id FROM task_receipts WHERE state IN ('claimed', 'handled') ORDER BY task_id LIMIT 1",
      )
      .get()?.invocation_id;
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    // While the alarm is still running, the queued normal invocation must wait.
    expect(
      store.db.prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?').get(normalInvocation)
        ?.state,
    ).toBe('queued');
    releaseGate();
    while (launched.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await recording.stop(30_000);
    expect(launched).toEqual([alarmInvocation, normalInvocation]);
    store.close();
  });

  test('a claimed alarm still launches while the bot is sleeping', async () => {
    const { store, ingestion, scheduler, configStore } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const normalInvocation = processDue(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    enterSleep(store.orm);

    const launched: bigint[] = [];
    const recording = new BucketScheduler(store, configStore, async (id) => {
      launched.push(id);
      return { state: 'completed', reason: 'done' };
    });
    recording.start(new Date('2026-08-15T00:00:00.000Z'));
    await recording.stop(30_000);

    const alarmInvocation = store.db
      .prepare<[], { invocation_id: bigint }>(
        "SELECT invocation_id FROM task_receipts WHERE state = 'handled' ORDER BY task_id LIMIT 1",
      )
      .get()?.invocation_id;
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    expect(launched).toEqual([alarmInvocation]);
    expect(
      store.db.prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?').get(normalInvocation)
        ?.state,
    ).toBe('skipped_budget');
    store.close();
  });

  test('does not claim while a same-chat invocation is running, then claims on release', async () => {
    const { store, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(received.toISOString(), invocationId);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(received.toISOString(), invocationId);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');

    expect(scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'))).toEqual([]);
    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'pending',
      state: 'pending',
    });

    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run('2026-08-15T00:00:01.000Z', invocationId);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run('2026-08-15T00:00:01.000Z', invocationId);

    const claimed = scheduler.processTasksDue(new Date('2026-08-15T00:00:01.000Z'));
    expect(claimed).toHaveLength(1);
    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'claimed',
      state: 'firing',
    });
    store.close();
  });

  test('pause after claim closes the firing alarm as cancelled/chat_paused', async () => {
    const { store, scheduler, configStore } = await setup();
    const conversation = ensureConversation(store);
    const alarmId = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
    const [invocationId] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (invocationId === undefined) {
      throw new Error('Expected claimed alarm invocation');
    }

    const commands = new BotCommandService(store, configStore, scheduler);
    expect(
      await commands.run(
        { name: 'pause' },
        123456789n,
        { id: 42n, name: 'Alice', username: null },
        new Date('2026-08-15T00:00:00.000Z'),
      ),
    ).toContain('已暂停');

    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'suppressed',
      state: 'cancelled',
      cancel_reason: 'chat_paused',
      admin_cancelled: 0n,
    });
    expect(
      store.db
        .prepare<[bigint], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations WHERE id = ?',
        )
        .get(invocationId),
    ).toEqual({ state: 'aborted', completion_reason: 'chat_paused' });
    store.close();
  });

  test('every terminal invocation outcome closes the alarm without retry', async () => {
    const { store, configStore } = await setup();
    const outcomes: Array<{ state: 'completed' | 'failed' | 'aborted' | 'outcome_unknown'; reason: string }> = [
      { state: 'completed', reason: 'completed' },
      { state: 'failed', reason: 'model_error' },
      { state: 'aborted', reason: 'timeout' },
      { state: 'outcome_unknown', reason: 'telegram_unknown' },
    ];
    for (const outcome of outcomes) {
      const conversation = ensureConversation(store);
      const alarmId = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
      const scheduler = new BucketScheduler(store, configStore, async () => outcome);
      scheduler.start(new Date('2026-08-15T00:00:00.000Z'));
      await scheduler.stop(30_000);
      expect(getAlarmTask(store, alarmId)).toMatchObject({
        task_state: 'completed',
        receipt_state: 'handled',
        state: 'fired',
        invocation_outcome: outcome.state,
        completion_reason: outcome.reason,
      });
    }
    store.close();
  });
});

describe('alarm retention', () => {
  test('keeps pending and firing alarms but purges terminal history', async () => {
    const { store, loaded } = await setup();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z');
    const firing = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'firing' });
    const fired = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'fired' });
    const cancelled = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'cancelled' });
    store.db
      .prepare('UPDATE long_tasks SET finished_at = ?, updated_at = ? WHERE id IN (?, ?)')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', fired, cancelled);
    store.db
      .prepare('UPDATE task_receipts SET claimed_at = ?, handled_at = ?, updated_at = ? WHERE task_id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', fired);
    store.db
      .prepare('UPDATE task_receipts SET cancelled_at = ?, updated_at = ? WHERE task_id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', cancelled);

    purgeExpiredData(store.orm, loaded.config, new Date('2026-03-01T00:00:00.000Z'));
    const ids = [pending, firing, fired, cancelled];
    const tasks = store.db
      .prepare<bigint[], { id: bigint; task_state: string; receipt_state: string | null }>(
        `SELECT lt.id, lt.state AS task_state, tr.state AS receipt_state
           FROM long_tasks lt LEFT JOIN task_receipts tr ON tr.task_id = lt.id
          WHERE lt.id IN (?, ?, ?, ?) ORDER BY lt.id`,
      )
      .all(...ids);
    expect(tasks).toEqual([
      { id: pending, task_state: 'completed', receipt_state: 'pending' },
      { id: firing, task_state: 'completed', receipt_state: 'claimed' },
    ]);
    expect(
      store.db
        .prepare<bigint[], { count: bigint }>(
          'SELECT COUNT(*) AS count FROM task_receipts WHERE task_id IN (?, ?, ?, ?)',
        )
        .get(...ids)?.count,
    ).toBe(2n);
    store.close();
  });
});

describe('alarm send mention', () => {
  test('retries the first target contact after a Telegram text failure', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });

    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    let calls = 0;
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        calls += 1;
        if (calls === 1) {
          throw new GrammyError(
            'Bad Request',
            { ok: false, error_code: 400, description: 'bad request', parameters: {} } as never,
            'sendMessage',
            {},
          );
        }
        requests.push({ text, options });
        return { message_id: 500 + calls, date: 1_700_000_100 + calls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      api,
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(tool.execute('fail-1', { kind: 'text', text: 'are you ok?' })).rejects.toThrow(
      'Telegram send failed: telegram_400',
    );
    await tool.execute('ok-1', { kind: 'text', text: 'are you ok now?' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe('@Alice are you ok now?');
    expect(requests[0]?.options.entities).toEqual([
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=42' },
    ]);
    expect(
      store.db
        .prepare<[], { state: string; error_code: string | null }>(
          "SELECT state, error_code FROM tool_calls WHERE tool_call_id = 'fail-1'",
        )
        .get(),
    ).toEqual({ state: 'error', error_code: 'telegram_400' });
    store.close();
  });

  test('keeps MarkdownV2 parsing while adding the first-text mention', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Back\\slash!ok[test]' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });

    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100 + requests.length, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      api,
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await tool.execute('md-1', { kind: 'text', text: '*bold* ok', parse_mode: 'MarkdownV2' });
    expect(requests[0]?.text).toBe('[@Back\\\\slash\\!ok\\[test\\]](tg://user?id=42) *bold* ok');
    expect(requests[0]?.options.parse_mode).toBe('MarkdownV2');
    expect(requests[0]?.options.entities).toBeUndefined();
    store.close();
  });

  test('applies length and blank-line checks after adding the mention prefix', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });

    let sendCalls = 0;
    const api: TelegramSendApi = {
      sendMessage: async () => {
        sendCalls += 1;
        return { message_id: 500 + sendCalls, date: 1_700_000_100 + sendCalls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      api,
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: 20,
      disallowBlankLines: true,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(tool.execute('long-1', { kind: 'text', text: 'x'.repeat(20) })).rejects.toThrow('exceeds');
    await expect(tool.execute('blank-1', { kind: 'text', text: 'a\n\nb' })).rejects.toThrow('blank lines');
    expect(sendCalls).toBe(0);
    await tool.execute('ok-1', { kind: 'text', text: 'ok' });
    expect(sendCalls).toBe(1);
    store.close();
  });
});

describe('alarm admin HTTP', () => {
  test('enforces auth/Origin/method and 404/409/wake semantics for alarm routes', async () => {
    const { store, configStore } = await setupAdmin();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z');
    let wakeCalls = 0;
    const fakeScheduler = {
      wake: () => {
        wakeCalls += 1;
      },
    };
    const server = new AdminServer({
      store,
      configStore,
      scheduler: fakeScheduler as unknown as BucketScheduler,
    });
    try {
      expect((await server.handle(adminRequest('/api/alarms'))).status).toBe(401);

      const created = await server.handle(
        adminPost('/api/auth/setup', { username: 'owner', password: ADMIN_PASSWORD }),
      );
      const cookie = adminSessionCookie(created);

      const list = await readJson(await server.handle(adminRequest('/api/alarms', { headers: { cookie } })));
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        id: pending.toString(),
        chat: { telegram_chat_id: '123456789', message_thread_id: '0' },
      });

      const method = await server.handle(adminPost('/api/alarms', {}, cookie));
      expect(method.status).toBe(405);

      const missing = await server.handle(
        adminRequest('/api/alarms/999999', { method: 'DELETE', headers: { cookie } }),
      );
      expect(missing.status).toBe(404);
      expect(await readJson(missing)).toMatchObject({ error: 'not_found' });

      const crossOrigin = await server.handle(
        adminRequest(`/api/alarms/${pending}`, {
          method: 'DELETE',
          headers: { cookie, origin: 'http://evil.test' },
        }),
      );
      expect(crossOrigin.status).toBe(403);
      expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

      const cancelled = await server.handle(
        adminRequest(`/api/alarms/${pending}`, { method: 'DELETE', headers: { cookie } }),
      );
      expect(cancelled.status).toBe(200);
      expect(await readJson(cancelled)).toEqual({ status: 'cancelled' });
      expect(wakeCalls).toBe(1);

      const conflict = await server.handle(
        adminRequest(`/api/alarms/${pending}`, { method: 'DELETE', headers: { cookie } }),
      );
      expect(conflict.status).toBe(409);
      expect(await readJson(conflict)).toMatchObject({ error: 'alarm_not_pending' });
    } finally {
      store.close();
    }
  });
});
