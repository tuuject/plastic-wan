import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import Type from 'typebox';
import { afterEach, expect, test } from 'vitest';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { cancelOngoingSessions } from '../src/ingress/admin/operations.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime, type ToolFactory } from '../src/orchestration/agent-runtime.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture(transform?: (config: FileConfig) => void, additionalTools?: ToolFactory) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-task-hot-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 0;
      config.agent.send_nudge_enabled = false;
      config.agent.send_barrier_enabled = true;
      config.agent.context.retained_sends_target = 20;
      config.agent.context.retained_sends_max = 30;
      transform?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
  });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  ingestion.ingest(update(1, 'ordinary Alice request'));
  const tasks = new LongTaskService(store.orm);
  const conversationRuntime = new ConversationRuntime({ agentCacheSize: 8 });
  const sends: string[] = [];
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    conversationRuntime,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
    telegramApi: {
      sendMessage: async (_chatId, text) => {
        sends.push(text);
        return { message_id: 900 + sends.length, date: 1_700_000_000, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 800, date: 1_700_000_000, chat: { id: 123456789 } }),
    },
    ...(additionalTools === undefined ? {} : { additionalTools }),
  });
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  cleanups.push(() => scheduler.stop(0));
  return { store, configStore, faux, tasks, scheduler, conversationRuntime, sends, ingestion };
}

function update(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function receipts(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        task_id: bigint;
        bucket_id: bigint;
        invocation_id: bigint;
        state: string;
        invocation_outcome: string | null;
        completion_reason: string | null;
      }
    >(
      'SELECT task_id, bucket_id, invocation_id, state, invocation_outcome, completion_reason FROM task_receipts ORDER BY task_id',
    )
    .all();
}

function checkpoints(store: SqliteStore) {
  const contexts = new ConversationContextStore(store);
  const header = contexts.header(1n)!;
  return contexts.retained(header).flatMap(({ seq, message }) =>
    message.role !== 'user'
      ? []
      : [
          {
            seq,
            text:
              typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text)
                    .join('\n'),
          },
        ],
  );
}

function complete(f: Awaited<ReturnType<typeof fixture>>, name: string, bypassDailyBudget = false) {
  const scope = f.tasks.scoped('exporter', 1n);
  const task = scope.create({
    payload: { name },
    delivery: {
      bypassDailyBudget,
      mentionUser: { userId: name === 'Alice' ? 42n : 43n, displayName: name },
    },
  });
  scope.complete(task.taskId, { result: `${name}-result` });
  return task.taskId;
}

const send = (text: string) =>
  fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text }), { stopReason: 'toolUse' });

async function finished(f: Awaited<ReturnType<typeof fixture>>, count: bigint) {
  await expect
    .poll(
      () =>
        f.store.db
          .prepare<[], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocations WHERE state NOT IN ('running', 'queued')",
          )
          .get()?.count,
    )
    .toBe(count);
}

test('two hot receipts wait for the ordinary tool chain, keep independent checkpoints and mentions, and never trip its send barrier', async () => {
  const f = await fixture((config) => {
    config.developer = { record_model_payloads: true };
  });
  const requests: string[] = [];
  f.faux.setResponses([
    (context, options) => {
      requests.push(JSON.stringify(context));
      options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
      complete(f, 'Alice');
      complete(f, 'Bob');
      f.scheduler.processTasksDue();
      expect(receipts(f.store)).toHaveLength(2);
      expect(new Set(receipts(f.store).map((row) => row.invocation_id)).size).toBe(1);
      expect(checkpoints(f.store)).toHaveLength(1);
      return send('ordinary response');
    },
    (context, options) => {
      requests.push(JSON.stringify(context));
      options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
      expect(f.sends).toEqual(['ordinary response']);
      expect(checkpoints(f.store)).toHaveLength(1);
      return fauxAssistantMessage('ordinary round ended');
    },
    (context, options) => {
      requests.push(JSON.stringify(context));
      options?.onPayload?.({ messages: context.messages }, f.faux.getModel());
      expect(checkpoints(f.store)).toHaveLength(2);
      expect(checkpoints(f.store).at(-1)?.text).toContain('Alice-result');
      expect(checkpoints(f.store).at(-1)?.text).not.toContain('Bob-result');
      return send('first result');
    },
    fauxAssistantMessage('first receipt round ended'),
    () => {
      expect(checkpoints(f.store)).toHaveLength(3);
      expect(checkpoints(f.store).at(-1)?.text).toContain('Bob-result');
      expect(checkpoints(f.store).at(-1)?.text).not.toContain('Alice-result');
      return send('second result');
    },
    fauxAssistantMessage('second receipt round ended'),
  ]);
  f.scheduler.start();
  await finished(f, 1n);
  expect(f.sends).toEqual(['ordinary response', '@Alice first result', '@Bob second result']);
  expect(requests[0]).not.toContain('<untrusted_task_receipt>');
  expect(requests[1]).not.toContain('<untrusted_task_receipt>');
  const rows = receipts(f.store);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.bucket_id)).size).toBe(2);
  for (const row of rows) {
    expect(row).toMatchObject({ state: 'handled', invocation_outcome: 'completed', completion_reason: 'completed' });
    expect(f.tasks.getCompletion(row.invocation_id, row.bucket_id)?.taskId).toBe(row.task_id);
  }
  expect(
    f.store.db.prepare('SELECT invocation_id, injected_at FROM invocation_buckets ORDER BY bucket_id').all(),
  ).toEqual(
    Array.from({ length: 3 }, () => ({ invocation_id: rows[0]!.invocation_id, injected_at: expect.any(String) })),
  );
  expect(f.store.db.prepare('SELECT state, error_code FROM tool_calls ORDER BY id').all()).toEqual(
    Array.from({ length: 3 }, () => ({ state: 'success', error_code: null })),
  );
  expect(f.store.db.prepare('SELECT state FROM model_calls ORDER BY id').all()).toEqual(
    Array.from({ length: 6 }, () => ({ state: 'success' })),
  );
  expect(
    f.store.db
      .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls WHERE request_json IS NOT NULL')
      .get()?.count,
  ).toBeGreaterThanOrEqual(3n);
  const points = checkpoints(f.store);
  expect(points.filter(({ text }) => text.includes('Alice-result'))).toHaveLength(1);
  expect(points.filter(({ text }) => text.includes('Bob-result'))).toHaveLength(1);
  const header = new ConversationContextStore(f.store).header(1n)!;
  expect(header.headSeq).toBe(1n);
  expect(header.nextSeq).toBe(
    f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()!.count + 1n,
  );
  expect(f.conversationRuntime.cachedAgent(1n)?.header).toMatchObject({
    headSeq: header.headSeq,
    nextSeq: header.nextSeq,
  });
  expect(
    f.store.db.prepare('SELECT context_id, ref, source_seq, target_conversation_id FROM context_refs').all(),
  ).toEqual([{ context_id: header.id, ref: 'reply:1', source_seq: points[0]!.seq, target_conversation_id: 1n }]);
});

test('a receipt wakes idle grace in the same invocation and completes normally', async () => {
  const f = await fixture((config) => {
    config.agent.context.idle_grace_seconds = 1;
  });
  f.faux.setResponses([
    fauxAssistantMessage('ordinary round ended'),
    send('awake result'),
    fauxAssistantMessage('done'),
  ]);
  f.scheduler.start();
  await expect
    .poll(
      () =>
        f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls').get()?.count === 1n &&
        !f.conversationRuntime.isRoundInProgress(1n),
    )
    .toBe(true);
  const invocation = f.store.db.prepare<[], { id: bigint; state: string }>('SELECT id, state FROM invocations').get()!;
  expect(invocation.state).toBe('running');
  complete(f, 'Alice');
  f.scheduler.processTasksDue();
  expect(receipts(f.store)[0]?.invocation_id).toBe(invocation.id);
  await expect.poll(() => f.sends).toEqual(['@Alice awake result']);
  await expect.poll(() => !f.conversationRuntime.isRoundInProgress(1n)).toBe(true);
  expect(checkpoints(f.store)).toHaveLength(2);
  expect(f.store.db.prepare('SELECT id FROM invocations').all()).toEqual([{ id: invocation.id }]);
  expect(f.store.db.prepare('SELECT injected_at FROM invocation_buckets').all()).toEqual([
    { injected_at: expect.any(String) },
    { injected_at: expect.any(String) },
  ]);
  await expect.poll(() => receipts(f.store)[0]?.state, { timeout: 5_000 }).toBe('handled');
  expect(receipts(f.store)[0]).toMatchObject({ invocation_outcome: 'completed', completion_reason: 'completed' });
  expect(f.store.db.prepare('SELECT id, state FROM invocations').all()).toEqual([
    { id: invocation.id, state: 'completed' },
  ]);
  expect(f.store.db.prepare('SELECT state FROM model_calls ORDER BY id').all()).toEqual([
    { state: 'success' },
    { state: 'success' },
    { state: 'success' },
  ]);
});

test('an unconsumed receipt survives a model error and is handled only by a fresh invocation', async () => {
  const f = await fixture();
  let oldInvocation: bigint | undefined;
  f.faux.setResponses([
    () => {
      complete(f, 'Alice');
      f.scheduler.processTasksDue();
      oldInvocation = receipts(f.store)[0]!.invocation_id;
      expect(receipts(f.store)[0]?.state).toBe('claimed');
      expect(checkpoints(f.store)).toHaveLength(1);
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'model failed before the next boundary' });
    },
    () => {
      expect(receipts(f.store)[0]?.invocation_id).not.toBe(oldInvocation);
      expect(receipts(f.store)[0]?.state).toBe('claimed');
      expect(checkpoints(f.store).filter(({ text }) => text.includes('Alice-result'))).toHaveLength(1);
      return send('recovered result');
    },
    fauxAssistantMessage('done'),
  ]);
  f.scheduler.start();
  await expect.poll(() => receipts(f.store)[0]?.state).toBe('handled');
  await finished(f, 2n);
  expect(receipts(f.store)[0]).toMatchObject({ invocation_outcome: 'completed', completion_reason: 'completed' });
  expect(receipts(f.store)[0]?.invocation_id).not.toBe(oldInvocation);
  expect(f.sends).toEqual(['@Alice recovered result']);
  expect(checkpoints(f.store).filter(({ text }) => text.includes('Alice-result'))).toHaveLength(1);
  expect(f.store.db.prepare('SELECT state FROM invocations ORDER BY id').all()).toEqual([
    { state: 'failed' },
    { state: 'completed' },
  ]);
  expect(f.store.db.prepare('SELECT state FROM model_calls ORDER BY id').all()).toEqual([
    { state: 'error' },
    { state: 'success' },
    { state: 'success' },
  ]);
  expect(
    f.store.db
      .prepare<[bigint], { count: bigint }>(
        'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ? AND injected_at IS NOT NULL',
      )
      .get(receipts(f.store)[0]!.invocation_id)?.count,
  ).toBe(1n);
});

test.each(['pause', 'admin_cancel'] as const)(
  '%s prevents attached unconsumed receipts from resurfacing',
  async (action) => {
    const f = await fixture((config) => {
      config.telegram.admins = [42];
    });
    const commands = new BotCommandService(f.store, f.configStore, f.scheduler);
    let attached!: () => void;
    const attachedSignal = new Promise<void>((resolve) => {
      attached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.faux.setResponses([
      async () => {
        complete(f, 'Alice');
        f.scheduler.processTasksDue();
        attached();
        await gate;
        return fauxAssistantMessage('stopped');
      },
    ]);
    f.scheduler.start();
    await attachedSignal;
    expect(receipts(f.store)[0]?.state).toBe('claimed');
    expect(checkpoints(f.store)).toHaveLength(1);
    try {
      if (action === 'pause') {
        expect(await commands.run({ name: 'pause' }, 123456789n, { id: 42n, name: 'Alice', username: null })).toContain(
          '/resume',
        );
      } else {
        cancelOngoingSessions(f.store.orm);
        expect(f.scheduler.abortAll()).toBe(1);
      }
    } finally {
      release();
    }
    await finished(f, 1n);
    expect(f.sends).toEqual([]);
    expect(checkpoints(f.store)).toHaveLength(1);
    expect(f.store.db.prepare('SELECT state, cancel_reason, admin_cancelled FROM task_receipts').all()).toEqual([
      {
        state: 'suppressed',
        cancel_reason: action === 'pause' ? 'chat_paused' : 'admin_cancel',
        admin_cancelled: action === 'admin_cancel' ? 1n : 0n,
      },
    ]);
    expect(f.store.db.prepare('SELECT state FROM buckets WHERE id = ?').get(receipts(f.store)[0]!.bucket_id)).toEqual({
      state: 'expired',
    });
    if (action === 'pause') {
      await commands.run({ name: 'resume' }, 123456789n, { id: 42n, name: 'Alice', username: null });
    }
    expect(f.scheduler.processTasksDue()).toEqual([]);
    expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
  },
);

test.each(['ordinary', 'receipt'] as const)(
  'receipt budget and caller authority do not leak into the next %s round',
  async (next) => {
    let ownedTask: bigint | undefined;
    let taskService: LongTaskService;
    const observations: { caller: bigint | null; ids: bigint[]; cancel: boolean | null }[] = [];
    const f = await fixture(
      (config) => {
        config.agent.daily_budget.max_tokens = 10_000_000;
        config.agent.context.idle_grace_seconds = next === 'ordinary' ? 1 : 0;
      },
      (context) => [
        {
          name: 'inspect_scope',
          label: 'Inspect scope',
          description: 'Inspect the current task caller in this test.',
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => {
            const scope = taskService.invocationScope('exporter', context);
            ownedTask ??= scope.create({ payload: { private: 'Alice' } }).taskId;
            observations.push({
              caller: context.callerUserId,
              ids: scope.list().map((task) => task.id),
              cancel: context.callerUserId === null ? scope.cancel(ownedTask) : null,
            });
            return { content: [{ type: 'text', text: 'inspected' }], details: {} };
          },
        },
      ],
    );
    taskService = f.tasks;
    const at = new Date().toISOString();
    f.store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', '123456789', 'model_tokens', 9600000, ?)",
      )
      .run(at.slice(0, 10), at);
    const toolSets: string[][] = [];
    const inspect = fauxAssistantMessage(fauxToolCall('inspect_scope', {}), { stopReason: 'toolUse' });
    f.faux.setResponses([
      (context) => {
        toolSets.push(context.tools?.map((tool) => tool.name) ?? []);
        return inspect;
      },
      () => {
        complete(f, 'Alice', true);
        f.scheduler.processTasksDue();
        return fauxAssistantMessage('ordinary done');
      },
      (context) => {
        toolSets.push(context.tools?.map((tool) => tool.name) ?? []);
        if (next === 'receipt') {
          complete(f, 'Bob', false);
          f.scheduler.processTasksDue();
        } else {
          f.ingestion.ingest(update(2, 'next ordinary request'));
          f.scheduler.processDue();
          f.scheduler.wake();
        }
        return inspect;
      },
      () => {
        expect(checkpoints(f.store)).toHaveLength(2);
        expect(checkpoints(f.store).at(-1)?.text).toContain('Alice-result');
        return fauxAssistantMessage('receipt done');
      },
      (context) => {
        toolSets.push(context.tools?.map((tool) => tool.name) ?? []);
        return inspect;
      },
      fauxAssistantMessage('next round done'),
    ]);
    f.scheduler.start();
    await expect.poll(() => observations.length).toBe(3);
    expect(toolSets[0]).toContain('zzz');
    expect(toolSets[1]).not.toContain('zzz');
    expect(toolSets[2]).toContain('zzz');
    expect(observations[0]).toEqual({ caller: 42n, ids: [ownedTask], cancel: null });
    expect(observations[1]).toEqual({ caller: null, ids: [], cancel: false });
    expect(observations[2]).toEqual(
      next === 'ordinary' ? { caller: 42n, ids: [ownedTask], cancel: null } : { caller: null, ids: [], cancel: false },
    );
    await expect.poll(() => receipts(f.store).every((row) => row.state === 'handled'), { timeout: 5_000 }).toBe(true);
    expect(f.tasks.scoped('exporter', 1n).get(ownedTask!)?.state).toBe('waiting');
    expect(checkpoints(f.store)).toHaveLength(3);
    expect(f.store.db.prepare('SELECT id FROM invocations').all()).toEqual([
      { id: receipts(f.store)[0]!.invocation_id },
    ]);
    expect(f.store.db.prepare('SELECT injected_at FROM invocation_buckets').all()).toEqual(
      Array.from({ length: 3 }, () => ({ injected_at: expect.any(String) })),
    );
  },
);
