import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { test } from 'vitest';
import { createImageConfigSnapshot } from '../src/config.ts';
import type { Generation, GenerationInput } from '../src/contracts.ts';
import { createImageCore } from '../src/core.ts';
import { ImageStore } from '../src/image-store.ts';
import { createOpenRouterAdapter } from '../src/openrouter.ts';
import {
  adminActor,
  createTestCore,
  defaultModel,
  fakeProvider,
  openTestDatabase,
  PROVIDER_KEY,
  parseInput,
  pngBytes,
  publishDefaultConfig,
  waitFor,
} from './helpers.ts';

async function submit(
  run: Awaited<ReturnType<typeof createTestCore>>,
  payload: Partial<GenerationInput> & { authoredPrompt: string },
  key: string,
) {
  return run.core.generations.create(parseInput({ modelId: 'gpt-image-1', ...payload }), adminActor, key).generation.id;
}

async function finished(run: Awaited<ReturnType<typeof createTestCore>>, id: string): Promise<Generation> {
  return waitFor(() => {
    const row = run.core.generations.getRow(id);
    if (row === null || row.status === 'queued' || row.status === 'running') {
      return null;
    }
    return run.core.generations.get(id, adminActor);
  });
}

/** Bounded negative-assertion pause: nothing may happen while the config is invalid. */
const settle = (ms = 250): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function abortable(signal: AbortSignal | null | undefined): { promise: Promise<never> } {
  let rejectFn: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
  });
  const abort = (): void => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    rejectFn(error);
  };
  if (signal == null) {
    return { promise };
  }
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort, { once: true });
  }
  return { promise };
}

test('upstream HTTP failures are recorded as provider failures without echoing upstream text', async () => {
  const provider = fakeProvider({
    respond: async () =>
      new Response(JSON.stringify({ error: { message: 'UPSTREAM-SECRET-DETAIL' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '失败案例' }, 'http-failure');
    const generation = await finished(run, id);
    assert.equal(generation.status, 'failed');
    assert.equal(generation.attempts[0]?.status, 'failed');
    assert.equal(generation.attempts[0]?.error?.code, 'provider_http_error');
    assert.equal(generation.attempts[0]?.error?.stage, 'provider');
    assert.equal(generation.error?.message, '上游返回 HTTP 400');
    assert.ok(!JSON.stringify(generation).includes('UPSTREAM-SECRET-DETAIL'));
    assert.equal(generation.outputs.length, 0);
  } finally {
    await run.cleanup();
  }
});

test('network errors and timeouts are recorded as interrupted, not retried automatically', async () => {
  const network = fakeProvider({
    respond: async () => {
      throw new Error('ECONNRESET');
    },
  });
  const run = await createTestCore({ providerFetch: network.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '断连' }, 'network-failure');
    const generation = await finished(run, id);
    assert.equal(generation.status, 'interrupted');
    assert.equal(generation.attempts[0]?.error?.code, 'provider_unreachable');
    assert.equal(generation.attempts[0]?.error?.stage, 'interrupted');
    assert.equal(network.calls.length, 1, '不确定的调用不会被自动重发');
  } finally {
    await run.cleanup();
  }

  const hanging = fakeProvider({
    respond: async (_call, _index, init) => abortable(init?.signal).promise,
  });
  const second = await createTestCore({ providerFetch: hanging.fetchImpl, providerTimeoutMs: 1000 });
  try {
    publishDefaultConfig(second.config);
    const started = Date.now();
    const id = await submit(second, { authoredPrompt: '超时' }, 'timeout');
    const generation = await finished(second, id);
    assert.equal(generation.status, 'interrupted');
    assert.equal(generation.attempts[0]?.error?.code, 'provider_interrupted');
    assert.ok(Date.now() - started >= 1000, '超时由 providerTimeoutMs 触发');
  } finally {
    await second.cleanup();
  }
});

test('partial success keeps successful outputs and still explains the failure', async () => {
  const provider = fakeProvider({
    respond: async (_call, index) => {
      if (index === 1) {
        return new Response(JSON.stringify({ error: {} }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          data: [{ b64_json: (await pngBytes({ width: 3, height: 3 })).toString('base64'), media_type: 'image/png' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const run = await createTestCore({ providerFetch: provider.fetchImpl, shutdownTimeoutMs: 500 });
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '部分失败', outputCount: 2 }, 'partial');
    const generation = await finished(run, id);
    assert.equal(generation.status, 'partial');
    assert.equal(generation.outputs.length, 1);
    assert.equal(generation.attempts.filter((attempt) => attempt.status === 'succeeded').length, 1);
    assert.equal(generation.attempts.filter((attempt) => attempt.status === 'failed').length, 1);
    assert.ok(generation.error !== null);

    const outputId = generation.outputs[0]?.id;
    assert.ok(outputId !== undefined);
    const content = run.core.images.readContent(outputId);
    assert.ok(content.bytes.length > 0, '成功输出可作为素材读取');
  } finally {
    await run.cleanup();
  }
});

test('the global concurrency bound is finite', async () => {
  let inFlight = 0;
  let peak = 0;
  const provider = fakeProvider({
    respond: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return new Response(
        JSON.stringify({ data: [{ b64_json: (await pngBytes()).toString('base64'), media_type: 'image/png' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const run = await createTestCore({ providerFetch: provider.fetchImpl, concurrency: 1 });
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '并发', outputCount: 3 }, 'concurrency');
    const generation = await finished(run, id);
    assert.equal(generation.status, 'succeeded');
    assert.equal(provider.calls.length, 3);
    assert.equal(peak, 1, 'concurrency=1 时上游调用串行化');
  } finally {
    await run.cleanup();
  }
});

test('shutdown aborts in-flight calls and records them as interrupted', async () => {
  const provider = fakeProvider({
    respond: async (_call, _index, init) => abortable(init?.signal).promise,
  });
  const file = path.join(tmpdir(), `image-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const run = await createTestCore({ providerFetch: provider.fetchImpl, file, shutdownTimeoutMs: 2000 });
  let reopenedClient: ReturnType<typeof openTestDatabase>['client'] | null = null;
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '关闭中断' }, 'shutdown');
    await waitFor(() => (run.core.generations.getRow(id)?.status === 'running' ? true : null));

    await run.core.stop();
    run.client.close();

    // Reopen the same database with a stopped worker: the state survives.
    const reopened = openTestDatabase(file);
    reopenedClient = reopened.client;
    const second = createImageCore({
      db: reopened.db,
      store: new ImageStore({ dir: run.storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: false,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    const generation = second.generations.get(id, adminActor);
    assert.equal(generation.status, 'interrupted');
    assert.equal(generation.attempts[0]?.status, 'interrupted');
    assert.ok(!generation.attempts.some((attempt) => attempt.status === 'running'));
    await second.stop();
  } finally {
    // Windows cannot unlink an open database; release both handles even if an
    // assertion failed, and keep cleanup failures visible.
    try {
      reopenedClient?.close();
    } finally {
      try {
        await run.cleanup();
      } finally {
        rmSync(file, { force: true });
      }
    }
  }
});

test('a shutdown that leaves later items without an attempt never reports the round as succeeded', async () => {
  // Deterministic injection of the race: the first upstream call is answered while
  // items 1..2 are parked on the semaphore with no attempt yet. Stopping here is
  // exactly the window where a post-acquire early return skips those items.
  let pendingStop: Promise<void> | undefined;
  let runRef: Awaited<ReturnType<typeof createTestCore>> | null = null;
  const provider = fakeProvider({
    respond: async (_call, index) => {
      if (index === 0) {
        pendingStop = runRef?.core.worker.stop();
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: (await pngBytes()).toString('base64'), media_type: 'image/png' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const file = path.join(tmpdir(), `image-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const run = await createTestCore({ providerFetch: provider.fetchImpl, file, concurrency: 1 });
  runRef = run;
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '关停缺项', outputCount: 3 }, 'shutdown-missing-items');
    const stop = await waitFor(() => pendingStop);
    // stop() resolves only after the round task (including finalize) has settled.
    await stop;

    const generation = run.core.generations.get(id, adminActor);
    assert.equal(generation.snapshot.authored.outputCount, 3);
    assert.equal(generation.attempts.length, 1, '未执行的项不产生付费 attempt');
    assert.equal(generation.attempts[0]?.itemIndex, 0);
    assert.equal(generation.attempts[0]?.status, 'succeeded');
    assert.equal(generation.outputs.length, 1);
    assert.equal(provider.calls.length, 1, '已执行的调用不会被自动重发');
    assert.notEqual(generation.status, 'succeeded', '有输出项未执行时绝不能报告整轮成功');
    assert.equal(generation.status, 'partial');
    assert.equal(generation.error?.code, 'shutdown_incomplete', '缺项必须留下明确解释');

    // A restart must neither resend the executed call nor silently promote the round.
    run.client.close();
    const storeDir = run.storeDir;
    const reopened = openTestDatabase(file);
    const restarted = createImageCore({
      db: reopened.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    const after = restarted.generations.get(id, adminActor);
    assert.equal(after.status, 'partial');
    assert.equal(after.error?.code, 'shutdown_incomplete');
    assert.equal(after.attempts.length, 1);
    assert.equal(provider.calls.length, 1);
    await restarted.stop();
    reopened.client.close();
  } finally {
    rmSync(file, { force: true });
    try {
      run.client.close();
    } catch {
      // closed above
    }
    rmSync(run.storeDir, { recursive: true, force: true });
  }
});

test('restart resumes queued work and marks running work as interrupted without resending', async () => {
  const file = path.join(tmpdir(), `image-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const storeDir = path.join(tmpdir(), `image-service-test-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const provider = fakeProvider();
  try {
    // A generation accepted while the worker is stopped stays queued.
    const first = openTestDatabase(file);
    const withoutWorker = createImageCore({
      db: first.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: false,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(withoutWorker.config);
    const queuedId = withoutWorker.generations.create(
      parseInput({ authoredPrompt: '排队任务', modelId: 'gpt-image-1' }),
      adminActor,
      'queued',
    ).generation.id;
    assert.equal(withoutWorker.generations.getRow(queuedId)?.status, 'queued');
    assert.equal(provider.calls.length, 0);
    await withoutWorker.stop();
    first.client.close();

    const resumed = openTestDatabase(file);
    const resumedCore = createImageCore({
      db: resumed.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    // The worker resumes queued work only once a valid config snapshot is published.
    publishDefaultConfig(resumedCore.config);
    const generation = await waitFor(() => {
      const row = resumedCore.generations.getRow(queuedId);
      if (row === null || row.status === 'queued' || row.status === 'running') {
        return null;
      }
      return resumedCore.generations.get(queuedId, adminActor);
    });
    assert.equal(generation.status, 'succeeded');
    assert.equal(provider.calls.length, 1);
    await resumedCore.stop();
    resumed.client.close();

    // Now simulate a crash while a call is in flight, then restart.
    const hanging = fakeProvider({
      respond: async (_call, _index, init) => abortable(init?.signal).promise,
    });
    const running = openTestDatabase(file);
    const runningCore = createImageCore({
      db: running.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: hanging.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(runningCore.config);
    const crashId = runningCore.generations.create(
      parseInput({ authoredPrompt: '崩溃任务', modelId: 'gpt-image-1' }),
      adminActor,
      'crash',
    ).generation.id;
    await waitFor(() => (runningCore.generations.getRow(crashId)?.status === 'running' ? true : null));

    // Hard crash: drop the SQLite handle without a graceful worker shutdown.
    running.client.close();

    const recovered = openTestDatabase(file);
    const recoveredCore = createImageCore({
      db: recovered.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(recoveredCore.config);
    const after = recoveredCore.generations.get(crashId, adminActor);
    assert.equal(after.status, 'interrupted');
    assert.equal(after.attempts[0]?.status, 'interrupted');
    assert.equal(after.attempts[0]?.error?.code, 'server_restart');
    assert.equal(after.attempts[0]?.error?.stage, 'interrupted');
    assert.ok(hanging.calls.length <= 1, '崩溃恢复不重发不确定的调用');
    await recoveredCore.stop();
    recovered.client.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('a restart without a valid config keeps queued work queued until the first publish', async () => {
  const file = path.join(tmpdir(), `image-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const storeDir = path.join(tmpdir(), `image-service-test-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const provider = fakeProvider();
  try {
    // Accept a generation while the worker is stopped: it stays queued in SQLite.
    const first = openTestDatabase(file);
    const withoutWorker = createImageCore({
      db: first.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: false,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    publishDefaultConfig(withoutWorker.config);
    const id = withoutWorker.generations.create(
      parseInput({ authoredPrompt: '配置损坏重启', modelId: 'gpt-image-1' }),
      adminActor,
      'invalid-config-restart',
    ).generation.id;
    assert.equal(withoutWorker.generations.getRow(id)?.status, 'queued');
    await withoutWorker.stop();
    first.client.close();

    // Restart with the worker on but no valid config snapshot. A queued generation
    // must not become an attempt that failed before any provider call.
    const restarted = openTestDatabase(file);
    const restartedCore = createImageCore({
      db: restarted.db,
      store: new ImageStore({ dir: storeDir }),
      providerAdapter: createOpenRouterAdapter({ fetchImpl: provider.fetchImpl }),
      startWorker: true,
      concurrency: 2,
      providerTimeoutMs: 5000,
      logger: null,
    });
    assert.equal(restartedCore.config.hasValidConfig(), false);
    await settle();
    assert.equal(restartedCore.generations.getRow(id)?.status, 'queued');
    assert.equal(restartedCore.generations.attemptsFor(id).length, 0, '无效配置下不产生 attempt');
    assert.equal(provider.calls.length, 0);

    // The first valid publish resumes it exactly once.
    publishDefaultConfig(restartedCore.config);
    const generation = await finishedProxy(restartedCore, id);
    assert.equal(generation.status, 'succeeded');
    assert.equal(generation.attempts.length, 1, '恢复后只执行一次');
    assert.equal(generation.attempts[0]?.status, 'succeeded');
    assert.equal(provider.calls.length, 1, '恢复后恰好一次上游调用');
    await restartedCore.stop();
    restarted.client.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

async function finishedProxy(core: ReturnType<typeof createImageCore>, id: string): Promise<Generation> {
  return waitFor(() => {
    const row = core.generations.getRow(id);
    if (row === null || row.status === 'queued' || row.status === 'running') {
      return null;
    }
    return core.generations.get(id, adminActor);
  });
}

test('a republished config without the original credential fails that task explicitly and keeps the queue moving', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl, startWorker: false });
  try {
    publishDefaultConfig(run.config);
    const firstId = await submit(run, { authoredPrompt: '凭据被删' }, 'credential-gone-1');
    const secondId = await submit(run, { authoredPrompt: '凭据被删 2' }, 'credential-gone-2');

    // A valid config that no longer serves the old model / credential pair.
    const nextModel = defaultModel({
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      upstreamModel: 'openai/gpt-image-2',
      credentialRef: 'openrouter2',
    });
    run.config.updateConfig(
      createImageConfigSnapshot({
        version: 'rev-2',
        models: [nextModel],
        credentials: { openrouter2: PROVIDER_KEY },
      }),
    );

    // Starting the worker drains the queue against the new snapshot: the old
    // model's credential is gone, so both tasks fail explicitly without any
    // provider call, and new submissions against the new model keep working.
    run.core.worker.start();
    for (const id of [firstId, secondId]) {
      const generation = await finished(run, id);
      assert.equal(generation.status, 'failed');
      assert.equal(generation.attempts.length, 1);
      assert.equal(generation.attempts[0]?.error?.code, 'credential_missing');
      assert.equal(generation.attempts[0]?.error?.stage, 'provider');
    }
    assert.equal(provider.calls.length, 0, '凭据缺失不触达上游');

    const nextId = await submit(run, { authoredPrompt: '后续任务', modelId: 'gpt-image-2' }, 'after-credential');
    const next = await finished(run, nextId);
    assert.equal(next.status, 'succeeded');
    assert.equal(provider.calls.length, 1);
  } finally {
    await run.cleanup();
  }
});

test('provider outputs are verified with sharp before they become assets', async () => {
  const corrupt = fakeProvider({
    respond: async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not an image at all').toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const run = await createTestCore({ providerFetch: corrupt.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '损坏输出' }, 'corrupt');
    const generation = await finished(run, id);
    assert.equal(generation.status, 'failed');
    assert.equal(generation.attempts[0]?.error?.code, 'output_format_rejected');
    assert.equal(generation.outputs.length, 0);
    assert.equal(readdirSync(run.storeDir).length, 0);
  } finally {
    await run.cleanup();
  }
});

test('generated images are stored as immutable files with verified content', async () => {
  const bytes = await sharp({ create: { width: 9, height: 9, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  const provider = fakeProvider({ image: async () => bytes });
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const id = await submit(run, { authoredPrompt: '固定字节' }, 'immutable');
    const generation = await finished(run, id);
    const output = generation.outputs[0];
    assert.ok(output !== undefined);
    const content = run.core.images.readContent(output.id);
    assert.deepEqual(content.bytes, bytes);
    const files = readdirSync(run.storeDir);
    assert.equal(files.length, 1);
    const firstFile = files[0];
    assert.ok(firstFile !== undefined);
    assert.match(firstFile, new RegExp(`^${output.id}\\.png$`));
  } finally {
    await run.cleanup();
  }
});
