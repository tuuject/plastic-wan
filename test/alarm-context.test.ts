import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import alarmPlugin from '../src/plugins/alarm/index.ts';
import type { ListAlarmToolDetails } from '../src/plugins/alarm/alarm.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig, type FileConfig } from '../src/platform/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { fauxRegistry, renderInvocationContext, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';
import { alarmTools, completeAlarmTask, getAlarmTask, insertAlarmTask } from './alarm-fixtures.ts';

const directories: string[] = [];
const stores: SqliteStore[] = [];
const schedulers: BucketScheduler[] = [];
const CHAT_ID = 123456789;

// Failures must not leave a scheduler accessing a closed database or a locked temp directory.
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) {
    await scheduler.stop(0);
  }
  for (const store of stores.splice(0)) {
    if (store.db.open) {
      store.close();
    }
  }
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function update(id: number, text: string, userId = 42): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: userId === 42 ? 'Alice' : 'Bob' },
      text,
    },
  };
}

function retainedMessages(store: SqliteStore): AgentMessage[] {
  const contexts = new ConversationContextStore(store);
  return contexts.retained(contexts.header(1n)!).map(({ message }) => message);
}

function executeResults(messages: readonly AgentMessage[], tool: string): ToolResultMessage[] {
  return messages.filter(
    (message): message is ToolResultMessage =>
      message.role === 'toolResult' &&
      message.toolName === 'execute' &&
      !message.isError &&
      typeof message.details === 'object' &&
      message.details !== null &&
      'tool' in message.details &&
      message.details.tool === tool,
  );
}

function resultText(message: ToolResultMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function listItems(messages: readonly AgentMessage[]): ListAlarmToolDetails['items'] {
  const result = executeResults(messages, 'list_alarm').at(-1);
  if (result === undefined) {
    throw new Error('No successful list_alarm result in the model-visible history');
  }
  return (JSON.parse(JSON.parse(resultText(result)).text) as ListAlarmToolDetails).items;
}

function call(tool: string, input: Record<string, unknown> = {}) {
  return fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool, input }), { stopReason: 'toolUse' });
}

function send(text: string) {
  return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text }), { stopReason: 'toolUse' });
}

function toolCallAudits(store: SqliteStore) {
  return store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
}

function futureIso(offsetMs = 86_400_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function runtimeFixture(transform?: (config: FileConfig) => void, existingDirectory?: string) {
  const directory = existingDirectory ?? (await mkdtemp(join(tmpdir(), 'plasticwan-alarm-ctx-')));
  const configPath = join(directory, 'config.jsonc');
  if (existingDirectory === undefined) {
    directories.push(directory);
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 0;
        config.agent.send_nudge_enabled = false;
        transform?.(config);
      }),
    );
  }
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  if (existingDirectory === undefined) {
    const at = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (1, ?, ?, 'private', ?)",
      )
      .run(CHAT_ID, CHAT_ID, at);
    store.db
      .prepare(
        'INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (1, 1, 0, ?, ?)',
      )
      .run(at, at);
  }
  const sends: string[] = [];
  const tasks = new LongTaskService(store.orm);
  const plugins = loadPlugins([alarmPlugin]);
  const conversationRuntime = new ConversationRuntime({ agentCacheSize: loaded.config.agent.context.agent_cache_size });
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi: {
      sendMessage: async (_chatId, text) => {
        sends.push(text);
        return { message_id: 900 + sends.length, date: 1_700_000_000, chat: { id: CHAT_ID } };
      },
      sendSticker: async () => ({ message_id: 800, date: 1_700_000_000, chat: { id: CHAT_ID } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    conversationRuntime,
    capabilityTools: (context, deadline) => plugins.capabilities(store, loaded.config, context, deadline, tasks),
  });
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  schedulers.push(scheduler);
  scheduler.start();
  return {
    store,
    config: loaded.config,
    configStore,
    faux,
    tasks,
    scheduler,
    conversationRuntime,
    sends,
    directory,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
  };
}

async function runBatch(f: Awaited<ReturnType<typeof runtimeFixture>>, id: number, text: string, userId = 42) {
  const previous = f.store.db
    .prepare<[], { id: bigint }>('SELECT COALESCE(MAX(id), 0) AS id FROM invocations')
    .get()!.id;
  f.ingestion.ingest(update(id, text, userId));
  f.scheduler.wake();
  await expect
    .poll(
      () =>
        f.store.db
          .prepare<[], { id: bigint; state: string; completion_reason: string }>(
            'SELECT id, state, completion_reason FROM invocations ORDER BY id DESC LIMIT 1',
          )
          .get(),
      { timeout: 5_000, interval: 10 },
    )
    .toEqual({
      id: previous + 1n,
      state: 'completed',
      completion_reason: 'completed',
    });
  return previous + 1n;
}

describe('alarm canonical context', () => {
  test('list result has one canonical result and ordinary audit; only explicit send reaches Telegram', async () => {
    const f = await runtimeFixture((config) => {
      config.developer = { record_model_payloads: true };
    });
    const scheduledAt = futureIso();
    const a1 = insertAlarmTask(f.store, 1n, 42n, 'morning', scheduledAt);
    const a2 = insertAlarmTask(f.store, 1n, 42n, 'evening', scheduledAt);
    insertAlarmTask(f.store, 1n, 99n, 'not mine', scheduledAt);
    const completed = insertAlarmTask(f.store, 1n, 42n, 'completed', scheduledAt);
    completeAlarmTask(f.store, completed);
    const cancelled = insertAlarmTask(f.store, 1n, 42n, 'cancelled', scheduledAt);
    f.tasks.scoped('alarm', 1n).cancel(cancelled, { reason: 'test' });
    const expected = [
      { id: a1.toString(), scheduled_at: scheduledAt, summary: 'morning' },
      { id: a2.toString(), scheduled_at: scheduledAt, summary: 'evening' },
    ];
    let observed: ToolResultMessage | undefined;
    f.faux.setResponses([
      (context) => {
        expect(JSON.stringify(context)).not.toContain('internal_context');
        return call('list_alarm');
      },
      (context, options) => {
        observed = executeResults(context.messages, 'list_alarm')[0];
        expect(listItems(context.messages)).toEqual(expected);
        expect(f.sends).toEqual([]);
        options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
        return send('morning; evening');
      },
      fauxAssistantMessage('private done'),
    ]);
    const invocationId = await runBatch(f, 1, 'list my alarms');
    const retained = retainedMessages(f.store);
    expect(executeResults(retained, 'list_alarm')).toEqual([observed]);
    expect(observed?.details).toEqual({ action: 'call', tool: 'list_alarm' });
    expect(f.sends).toEqual(['morning; evening']);
    expect(
      f.store.db
        .prepare<[], { text: string }>("SELECT text FROM agent_messages WHERE role = 'tool_result' ORDER BY id")
        .all(),
    ).toEqual([{ text: resultText(observed!) }, { text: expect.any(String) }]);
    expect(toolCallAudits(f.store)).toEqual([
      { tool_name: 'execute', state: 'success', error_code: null },
      { tool_name: 'list_alarm', state: 'success', error_code: null },
      { tool_name: 'send', state: 'success', error_code: null },
    ]);
    expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);
    expect(
      f.store.db
        .prepare<[bigint], { request_json: string }>(
          'SELECT request_json FROM model_calls WHERE invocation_id = ? AND request_json IS NOT NULL',
        )
        .get(invocationId)?.request_json,
    ).toContain('morning');
    expect(JSON.stringify(retained)).not.toContain('<internal_context_history>');
  });

  test.each(['cached', 'reopened'] as const)(
    '%s model resolves deletion only from its retained tool history',
    async (mode) => {
      let f = await runtimeFixture();
      const first = insertAlarmTask(f.store, 1n, 42n, 'first', futureIso());
      const second = insertAlarmTask(f.store, 1n, 42n, 'second', futureIso(172_800_000));
      f.faux.setResponses([call('list_alarm'), fauxAssistantMessage('private list note')]);
      await runBatch(f, 1, 'list');
      const oldList = executeResults(retainedMessages(f.store), 'list_alarm')[0]!;
      const cached = f.conversationRuntime.cachedAgent(1n)?.agent;
      expect(cached).toBeDefined();
      if (mode === 'reopened') {
        await f.scheduler.stop(0);
        f.store.close();
        f = await runtimeFixture(undefined, f.directory);
        expect(f.conversationRuntime.cachedAgent(1n)).toBeUndefined();
      }
      let derivedId: string | undefined;
      f.faux.setResponses([
        (context, options) => {
          // Crucially derive the call argument from what the provider receives, not a DB query outside Faux.
          expect(executeResults(context.messages, 'list_alarm')).toEqual([oldList]);
          derivedId = listItems(context.messages)[1]?.id;
          expect(derivedId).toBeDefined();
          options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
          return call('delete_alarm', { id: derivedId });
        },
        (context) => {
          expect(executeResults(context.messages, 'delete_alarm')).toHaveLength(1);
          return send('second reminder cancelled');
        },
        fauxAssistantMessage('private done'),
      ]);
      await runBatch(f, 2, 'delete the second one');
      expect(derivedId).toBe(second.toString());
      expect(getAlarmTask(f.store, first)?.task_state).toBe('waiting');
      expect(getAlarmTask(f.store, second)).toMatchObject({
        task_state: 'cancelled',
        receipt_state: 'suppressed',
        cancel_reason: 'user_requested',
      });
      expect(toolCallAudits(f.store).filter((row) => row.tool_name === 'list_alarm')).toHaveLength(1);
      expect(toolCallAudits(f.store).find((row) => row.tool_name === 'delete_alarm')).toMatchObject({
        state: 'success',
      });
      expect(executeResults(retainedMessages(f.store), 'delete_alarm')).toHaveLength(1);
      expect(f.sends).toEqual(['second reminder cancelled']);
      if (mode === 'cached') {
        expect(f.conversationRuntime.cachedAgent(1n)?.agent).toBe(cached);
      } else {
        expect(f.conversationRuntime.cachedAgent(1n)?.agent).not.toBe(cached);
      }
    },
  );

  test.each(['checkpoint GC', 'topic clear'] as const)(
    '%s forgets the list in canonical history, cache and next request',
    async (mode) => {
      const f = await runtimeFixture((config) => {
        config.telegram.admins = [42];
        config.agent.context.retained_sends_target = 1;
        config.agent.context.retained_sends_max = 2;
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      insertAlarmTask(f.store, 1n, 42n, 'old-list-marker', futureIso());
      f.faux.setResponses([call('list_alarm'), send('listed'), fauxAssistantMessage('private done')]);
      await runBatch(f, 1, 'list');
      const contexts = new ConversationContextStore(f.store);
      const before = contexts.header(1n)!;
      const oldListSeq = contexts
        .retained(before)
        .find(({ message }) => executeResults([message], 'list_alarm').length > 0)!.seq;
      expect(f.store.db.prepare('SELECT ref FROM context_refs').all().length).toBeGreaterThan(0);
      let nextId: number;
      if (mode === 'checkpoint GC') {
        for (const id of [2, 3]) {
          f.faux.setResponses([send(`reply ${id}`), fauxAssistantMessage('private done')]);
          await runBatch(f, id, `new batch ${id}`);
        }
        expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"context_gc"'));
        expect(contexts.header(1n)?.lastGcAt).not.toBeNull();
        nextId = 4;
      } else {
        const commands = new BotCommandService(f.store, f.configStore, f.scheduler, undefined, f.conversationRuntime);
        const commandUpdate = update(2, '/cut_topic');
        commandUpdate.message!.entities = [{ offset: 0, length: 10, type: 'bot_command' }];
        const command = f.ingestion.ingest(commandUpdate).command;
        expect(await commands.run(command!, BigInt(CHAT_ID), { id: 42n, name: 'Alice', username: 'alice' })).toContain(
          '清空',
        );
        expect(contexts.header(1n)?.headSeq).toBe(before.nextSeq);
        expect(f.conversationRuntime.cachedAgent(1n)).toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"context_cleared"'));
        nextId = 3;
      }
      const after = contexts.header(1n)!;
      expect(after.headSeq).toBeGreaterThan(oldListSeq);
      expect(
        f.store.db
          .prepare<[bigint], { evicted_at: string | null }>(
            'SELECT evicted_at FROM context_messages WHERE context_id = 1 AND seq = ?',
          )
          .get(oldListSeq)?.evicted_at,
      ).toEqual(expect.any(String));
      expect(
        f.store.db.prepare<[bigint]>('SELECT ref FROM context_refs WHERE source_seq < ?').all(after.headSeq),
      ).toEqual([]);
      expect(executeResults(retainedMessages(f.store), 'list_alarm')).toEqual([]);
      expect(executeResults(f.conversationRuntime.cachedAgent(1n)?.agent.state.messages ?? [], 'list_alarm')).toEqual(
        [],
      );
      insertAlarmTask(f.store, 1n, 42n, 'fresh-marker', futureIso(172_800_000));
      f.faux.setResponses([
        (context) => {
          expect(executeResults(context.messages, 'list_alarm')).toEqual([]);
          expect(JSON.stringify(context)).not.toContain('old-list-marker');
          return call('list_alarm');
        },
        (context) => {
          expect(listItems(context.messages).map((item) => item.summary)).toEqual(['old-list-marker', 'fresh-marker']);
          return fauxAssistantMessage('private fresh list');
        },
      ]);
      await runBatch(f, nextId, 'list again');
      expect(executeResults(retainedMessages(f.store), 'list_alarm')).toHaveLength(1);
      expect(toolCallAudits(f.store).filter((row) => row.tool_name === 'list_alarm')).toHaveLength(2);
    },
  );

  test.each(['completed task', 'changed caller'] as const)(
    'retained IDs do not authorize deletion after %s',
    async (mode) => {
      const f = await runtimeFixture();
      const taskId = insertAlarmTask(f.store, 1n, 42n, 'stale', futureIso());
      f.faux.setResponses([call('list_alarm'), fauxAssistantMessage('private list')]);
      await runBatch(f, 1, 'list');
      if (mode === 'completed task') {
        completeAlarmTask(f.store, taskId);
      }
      let derivedId: string | undefined;
      f.faux.setResponses([
        (context) => {
          derivedId = listItems(context.messages)[0]?.id;
          return call('delete_alarm', { id: derivedId });
        },
        (context) => {
          const result = context.messages.at(-1);
          expect(result?.role).toBe('toolResult');
          if (result?.role !== 'toolResult') {
            throw new Error('Expected a rejected tool result');
          }
          expect(result.isError).toBe(true);
          expect(resultText(result)).toContain('alarm not found');
          return fauxAssistantMessage('private failure note');
        },
      ]);
      await runBatch(f, 2, 'delete that reminder', mode === 'changed caller' ? 99 : 42);
      expect(derivedId).toBe(taskId.toString());
      expect(toolCallAudits(f.store).slice(-2)).toEqual([
        { tool_name: 'execute', state: 'error', error_code: 'capability_error' },
        { tool_name: 'delete_alarm', state: 'error', error_code: 'alarm_not_found' },
      ]);
      expect(getAlarmTask(f.store, taskId)).toMatchObject(
        mode === 'completed task'
          ? { task_state: 'completed', receipt_state: 'handled' }
          : { task_state: 'waiting', receipt_state: null },
      );
      expect(f.sends).toEqual([]);
    },
  );
});

async function authFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-auth-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.agent.history_messages = 5;
      config.telegram.bucket_window_seconds = 0;
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  return {
    store,
    config: loaded.config,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    build: (id: bigint) => renderInvocationContext(store, loaded.config, id),
  };
}

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [id] = scheduler.processDue(at);
  if (id === undefined) {
    throw new Error('Expected one due invocation');
  }
  return id;
}

function finishInvocation(store: SqliteStore, id: bigint, at: string): void {
  store.db
    .prepare(
      "UPDATE invocations SET state = 'completed', finished_at = ?, completion_reason = 'completed' WHERE id = ?",
    )
    .run(at, id);
  store.db
    .prepare(
      "UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
    )
    .run(at, at, id);
}

describe('alarm authorization', () => {
  test('creator Alice can cancel an alarm targeting Bob; Bob cannot see or cancel it while pending', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'Bob is visible', 99), at);
    ingestion.ingest(update(2, 'remind Bob', 42), new Date(at.getTime() + 1_000));
    const aliceInvocation = processOne(scheduler, new Date(at.getTime() + 2_000));
    const context = build(aliceInvocation);
    const created = await alarmTools(store, config, context).alarm.execute('alice-create', {
      target_user_id: '99',
      summary: 'meeting',
      datetime: futureIso(),
    });
    expect((await alarmTools(store, config, context).list_alarm.execute('alice-list', {})).details.items).toEqual([
      expect.objectContaining({ id: created.details.id }),
    ]);
    finishInvocation(store, aliceInvocation, new Date(at.getTime() + 3_000).toISOString());
    ingestion.ingest(update(3, 'my alarms', 99), new Date(at.getTime() + 4_000));
    const bobInvocation = processOne(scheduler, new Date(at.getTime() + 5_000));
    const bob = alarmTools(store, config, build(bobInvocation));
    expect((await bob.list_alarm.execute('bob-list', {})).details.items).toEqual([]);
    await expect(bob.delete_alarm.execute('bob-delete', { id: created.details.id })).rejects.toThrow('alarm not found');
    expect(getAlarmTask(store, BigInt(created.details.id))?.task_state).toBe('waiting');
    finishInvocation(store, bobInvocation, new Date(at.getTime() + 6_000).toISOString());
    ingestion.ingest(update(4, 'cancel it', 42), new Date(at.getTime() + 7_000));
    const aliceAgain = build(processOne(scheduler, new Date(at.getTime() + 8_000)));
    expect(
      (await alarmTools(store, config, aliceAgain).delete_alarm.execute('alice-delete', { id: created.details.id }))
        .details.state,
    ).toBe('cancelled');
    expect(toolCallAudits(store).filter((row) => row.tool_name === 'delete_alarm')).toEqual([
      { tool_name: 'delete_alarm', state: 'error', error_code: 'alarm_not_found' },
      { tool_name: 'delete_alarm', state: 'success', error_code: null },
    ]);
  });

  test('delete only cancels caller-owned pending alarms and normalizes failures to not_found', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'delete alarms'), at);
    const context = build(processOne(scheduler, new Date(at.getTime() + 1_000)));
    const own = insertAlarmTask(store, context.conversationId, 42n, 'mine', futureIso());
    const other = insertAlarmTask(store, context.conversationId, 99n, 'theirs', futureIso());
    const tool = alarmTools(store, config, context).delete_alarm;
    expect((await tool.execute('delete-ok', { id: own.toString() })).details.state).toBe('cancelled');
    expect(getAlarmTask(store, own)).toMatchObject({
      task_state: 'cancelled',
      receipt_state: 'suppressed',
      cancel_reason: 'user_requested',
    });
    await expect(tool.execute('delete-other', { id: other.toString() })).rejects.toThrow('alarm not found');
    await expect(tool.execute('delete-missing', { id: '999999' })).rejects.toThrow('alarm not found');
    await expect(tool.execute('delete-already-cancelled', { id: own.toString() })).rejects.toThrow('alarm not found');
    expect(toolCallAudits(store)).toEqual([
      { tool_name: 'delete_alarm', state: 'success', error_code: null },
      ...Array.from({ length: 3 }, () => ({
        tool_name: 'delete_alarm',
        state: 'error',
        error_code: 'alarm_not_found',
      })),
    ]);
  });

  test('latest new user is the caller even with multi-user visible history', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'Alice history'), at);
    const first = processOne(scheduler, new Date(at.getTime() + 1_000));
    finishInvocation(store, first, new Date(at.getTime() + 2_000).toISOString());
    ingestion.ingest(update(2, 'Alice again'), new Date(at.getTime() + 3_000));
    ingestion.ingest(update(3, 'Bob latest', 99), new Date(at.getTime() + 4_000));
    const context = build(processOne(scheduler, new Date(at.getTime() + 5_000)));
    expect(context.visibleSenders.size).toBe(2);
    expect(context.callerUserId).toBe(99n);
    const created = await alarmTools(store, config, context).alarm.execute('latest-new', {
      target_user_id: '42',
      summary: 'Bob asks to remind Alice',
      datetime: futureIso(),
    });
    expect(
      store.db
        .prepare<[string]>(
          "SELECT created_by_user_id, json_extract(payload_json, '$.target_user_id') AS target_user_id FROM long_tasks WHERE id = ?",
        )
        .get(created.details.id),
    ).toEqual({ created_by_user_id: 99n, target_user_id: '42' });
  });

  test('tools fail closed without a reliable caller', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'seed'), at);
    const first = processOne(scheduler, new Date(at.getTime() + 1_000));
    finishInvocation(store, first, new Date(at.getTime() + 2_000).toISOString());
    store.db
      .prepare(
        "INSERT INTO senders(telegram_type, telegram_id, is_bot, display_name, updated_at) VALUES ('sender_chat', 777, 0, 'Channel', ?)",
      )
      .run(at.toISOString());
    ingestion.ingest(update(2, 'anonymous'), new Date(at.getTime() + 3_000));
    store.db
      .prepare(
        "UPDATE message_revisions SET sender_id = (SELECT id FROM senders WHERE telegram_type = 'sender_chat' LIMIT 1) WHERE message_id = (SELECT id FROM messages WHERE telegram_message_id = 2)",
      )
      .run();
    const context = build(processOne(scheduler, new Date(at.getTime() + 4_000)));
    expect(context.callerUserId).toBeNull();
    const tools = alarmTools(store, config, context);
    await expect(
      tools.alarm.execute('create', { target_user_id: '42', summary: 'x', datetime: futureIso() }),
    ).rejects.toThrow('caller identity');
    await expect(tools.list_alarm.execute('list', {})).rejects.toThrow('caller identity');
    await expect(tools.delete_alarm.execute('delete', { id: '1' })).rejects.toThrow('caller identity');
    expect(toolCallAudits(store)).toEqual(
      ['alarm', 'list_alarm', 'delete_alarm'].map((tool_name) => ({
        tool_name,
        state: 'error',
        error_code: 'alarm_caller_not_available',
      })),
    );
  });

  test('legacy alarms with nullable creator are invisible and cannot be deleted', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'list'), at);
    const context = build(processOne(scheduler, new Date(at.getTime() + 1_000)));
    const legacy = insertAlarmTask(store, context.conversationId, 42n, 'legacy', futureIso(), null);
    const tools = alarmTools(store, config, context);
    expect((await tools.list_alarm.execute('legacy-list', {})).details.items).toEqual([]);
    await expect(tools.delete_alarm.execute('legacy-delete', { id: legacy.toString() })).rejects.toThrow(
      'alarm not found',
    );
    expect(getAlarmTask(store, legacy)?.task_state).toBe('waiting');
  });
});
