import { afterAll, expect, test, vi } from 'vitest';
import { access, copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  MediaTooLargeError,
  TelegramMediaClient,
  type MediaDownloader,
} from '../src/capabilities/media/media-download.ts';
import { createLottieCommand } from '../src/capabilities/media/media-image.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import {
  fauxRegistry,
  invocationCapabilities,
  renderInvocationContext,
  testConfigStore,
  writeTestConfig,
} from './helpers.ts';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

test('a switched vision model analyzes under its own cache version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-switch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'vision',
    models: [
      { id: 'vision-model', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 },
    ],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        photo: [{ file_id: 'file-id', file_unique_id: 'unique-id', width: 32, height: 16, file_size: 100 }],
      },
    },
    new Date('2026-08-15T00:00:00.000Z'),
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date('2026-08-15T00:00:15.000Z'));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  const capabilities = invocationCapabilities(store, loaded.config, context.header);
  const [imageRef] = context.imageCapabilities.keys();
  if (imageRef === undefined) {
    throw new Error('Expected an image capability');
  }
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      await copyFile(fixturePath, destination);
    },
  };
  const modelGate = new KeyedSemaphore();
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate,
  });
  const tool = media.createReadImageTool(context, capabilities, Date.now() + 60_000);
  faux.setResponses([() => fauxAssistantMessage('described by the first model')]);
  const first = await tool.execute('read-1', { image_ref: imageRef });
  expect(first.content).toEqual([{ type: 'text', text: 'described by the first model' }]);
  expect(first.details.cached).toBe(false);

  // `PUT /vision` publishes a new snapshot: the next analysis uses the new model
  // and its own cache version, so the old row is not a hit.
  const switched = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-alt', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  switched.setResponses([() => fauxAssistantMessage('described by the second model')]);
  const models = createModels();
  models.setProvider(switched.provider);
  configStore.publish({
    config: configStore.current().config,
    hash: 'switched',
    models,
    visionModel: switched.getModel(),
  });
  const second = await tool.execute('read-2', { image_ref: imageRef });
  expect(second.content).toEqual([{ type: 'text', text: 'described by the second model' }]);
  expect(second.details.cached).toBe(false);
  expect(switched.state.callCount).toBe(1);

  const rows = store.db
    .prepare<[], { analysis_version: string; model: string; description: string }>(
      'SELECT analysis_version, model, description FROM media_analyses ORDER BY id',
    )
    .all();
  expect(rows.map((row) => row.analysis_version)).toEqual([
    'vision/vision-model/prompt-1',
    'vision/vision-alt/prompt-1',
  ]);
  expect(rows.map((row) => row.model)).toEqual(['vision-model', 'vision-alt']);

  // A switch published while an analysis waits for its model slot reaches the
  // next analysis only: the waiting one keeps its model and the output limit
  // that was validated against it, never the new model's larger limit.
  const small = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-small', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 1_024 }],
  });
  let seenMaxTokens: number | undefined;
  small.setResponses([
    (_context, options) => {
      seenMaxTokens = options?.maxTokens;
      return fauxAssistantMessage('described by the small model');
    },
  ]);
  const smallModels = createModels();
  smallModels.setProvider(small.provider);
  const pinnedConfig = structuredClone(configStore.current().config);
  pinnedConfig.vision.max_output_tokens = 1_000;
  configStore.publish({ config: pinnedConfig, hash: 'small', models: smallModels, visionModel: small.getModel() });
  const release = await modelGate.acquire('123456789', AbortSignal.timeout(5_000));
  const waiting = tool.execute('read-3', { image_ref: imageRef });
  await expect
    .poll(
      () =>
        store.db
          .prepare<[], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM media_analyses WHERE analysis_version = 'vision/vision-small/prompt-1'",
          )
          .get()?.count,
    )
    .toBe(1n);
  const largerConfig = structuredClone(pinnedConfig);
  largerConfig.vision.max_output_tokens = 4_000;
  configStore.publish({ config: largerConfig, hash: 'larger', models, visionModel: switched.getModel() });
  release();
  const third = await waiting;
  expect(third.content).toEqual([{ type: 'text', text: 'described by the small model' }]);
  expect(seenMaxTokens).toBe(1_000);
  store.close();
});
test('builds an executable Lottie command for the host platform', () => {
  const command = createLottieCommand(['input.tgs', 'output.png']);
  expect(command.slice(-2)).toEqual(['input.tgs', 'output.png']);
  if (process.platform === 'win32') {
    expect(command.slice(0, 2)).toEqual(['python', '-c']);
  } else {
    expect(command[0]).toBe('lottie_convert.py');
  }
});

/** Drives the real download client with a scripted body; no network involved. */
function scriptedFetch(chunks: readonly Uint8Array[], headers: Record<string, string> = {}) {
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    headers: new Headers(headers),
  });
}

function telegramClient(getFile: () => Promise<{ readonly file_path?: string }>): TelegramMediaClient {
  return new TelegramMediaClient({ getFile }, 'test-token');
}

test('the download client types oversized content-length and streaming as MediaTooLargeError', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-download-'));
  directories.push(directory);
  const destination = join(directory, 'payload');
  const client = telegramClient(async () => ({ file_path: 'photos/payload.bin' }));
  const signal = new AbortController().signal;
  const cap = 20 * 1024 * 1024;

  vi.stubGlobal('fetch', scriptedFetch([], { 'content-length': String(cap + 1) }));
  try {
    await expect(client.download('file-big', destination, signal)).rejects.toBeInstanceOf(MediaTooLargeError);
  } finally {
    vi.unstubAllGlobals();
  }
  await expect(access(destination)).rejects.toThrow();

  // No content-length: only the streamed byte count can see the overrun. The
  // failed attempt must unlink its partial file, so the retry can reuse the
  // same destination (`open` with 'wx' would fail on a leftover file).
  vi.stubGlobal('fetch', scriptedFetch([new Uint8Array(1), new Uint8Array(cap)]));
  try {
    await expect(client.download('file-big', destination, signal)).rejects.toBeInstanceOf(MediaTooLargeError);
  } finally {
    vi.unstubAllGlobals();
  }
  await expect(access(destination)).rejects.toThrow();

  vi.stubGlobal('fetch', scriptedFetch([new Uint8Array([1, 2, 3])]));
  try {
    await client.download('file-small', destination, signal);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(new Uint8Array(await readFile(destination))).toEqual(new Uint8Array([1, 2, 3]));
});

test('an abort while getFile is pending rejects the download and a late response writes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-download-'));
  directories.push(directory);
  const destination = join(directory, 'payload');
  const controller = new AbortController();
  let resolveGetFile: ((file: { readonly file_path?: string }) => void) | undefined;
  const pendingGetFile = new Promise<{ readonly file_path?: string }>((resolve) => {
    resolveGetFile = resolve;
  });
  const client = telegramClient(() => pendingGetFile);
  const download = client.download('file-id', destination, controller.signal);
  await vi.waitFor(() => {
    expect(resolveGetFile).toBeDefined();
  });

  // getFile cannot be cancelled; the download must not wait for Telegram.
  controller.abort();
  await expect(download).rejects.toMatchObject({ name: 'AbortError' });

  let fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch for a discarded download');
  });
  try {
    resolveGetFile?.({ file_path: 'photos/late.bin' });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    vi.unstubAllGlobals();
  }
  expect(fetchCalls).toBe(0);
  await expect(access(destination)).rejects.toThrow();
});

test('read_image normalizes once and reuses the 30-day description cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'vision',
    models: [
      { id: 'vision-model', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 },
    ],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      photo: [
        {
          file_id: 'file-id',
          file_unique_id: 'unique-id',
          width: 32,
          height: 16,
          file_size: 100,
        },
      ],
    },
  };
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  const capabilities = invocationCapabilities(store, loaded.config, context.header);
  const [imageRef] = context.imageCapabilities.keys();
  if (imageRef === undefined) {
    throw new Error('Expected an image capability');
  }
  expect(context.directImages).toEqual([]);

  let visionReasoning: string | undefined;
  faux.setResponses([
    (_context, options) => {
      visionReasoning = options?.reasoning;
      return fauxAssistantMessage('A translucent red rectangle.');
    },
  ]);
  let downloads = 0;
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      downloads += 1;
      await copyFile(fixturePath, destination);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const tool = media.createReadImageTool(context, capabilities, Date.now() + 60_000);
  const first = await tool.execute('read-1', { image_ref: imageRef });
  const second = await tool.execute('read-2', { image_ref: imageRef });
  expect(first.content).toEqual([{ type: 'text', text: 'A translucent red rectangle.' }]);
  expect(second.details.cached).toBe(true);
  expect(downloads).toBe(1);
  expect(faux.state.callCount).toBe(1);
  expect(visionReasoning).toBe('low');
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM media_analyses WHERE state = 'success'")
      .get()?.count,
  ).toBe(1n);
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});

test('prepareSceneImage reads photos, image documents and stickers read-only, while generation input still rejects stickers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-scene-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const chat = { id: 123456789, type: 'private', first_name: 'Owner' } as const;
  const from = { id: 42, is_bot: false, first_name: 'Alice' } as const;
  const photoUpdate: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat,
      from,
      photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 32, height: 16, file_size: 100 }],
    },
  };
  const stickerUpdate: Update = {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1_700_000_001,
      chat,
      from,
      sticker: {
        file_id: 'sticker-file',
        file_unique_id: 'sticker-unique',
        type: 'regular',
        width: 32,
        height: 16,
        is_animated: false,
        is_video: false,
        thumbnail: { file_id: 'sticker-thumb', file_unique_id: 'sticker-thumb-unique', width: 32, height: 16 },
      },
    },
  };
  const documentUpdate: Update = {
    update_id: 3,
    message: {
      message_id: 12,
      date: 1_700_000_002,
      chat,
      from,
      document: {
        file_id: 'document-file',
        file_unique_id: 'document-unique',
        mime_type: 'image/png',
        file_size: 100,
        thumbnail: { file_id: 'document-thumb', file_unique_id: 'document-thumb-unique', width: 32, height: 16 },
      },
    },
  };
  ingestion.ingest(photoUpdate, new Date('2026-08-15T00:00:00.000Z'));
  ingestion.ingest(stickerUpdate, new Date('2026-08-15T00:00:01.000Z'));
  ingestion.ingest(documentUpdate, new Date('2026-08-15T00:00:02.000Z'));
  const mediaRows = store.db.prepare<[], { id: bigint; kind: string }>('SELECT id, kind FROM media ORDER BY id').all();
  expect(mediaRows.map((row) => row.kind)).toEqual(['photo', 'sticker', 'document']);
  const [photoId, stickerId, documentId] = mediaRows.map((row) => row.id);
  if (photoId === undefined || stickerId === undefined || documentId === undefined) {
    throw new Error('Expected photo, sticker and document media rows');
  }

  const downloaded: string[] = [];
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      downloaded.push(fileId);
      await copyFile(fixturePath, destination);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const productionCounts = (): Record<string, bigint> => {
    const read = (table: string): bigint =>
      store.db.prepare<[], { count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? -1n;
    return {
      media_analyses: read('media_analyses'),
      model_calls: read('model_calls'),
      tool_calls: read('tool_calls'),
      daily_usage: read('daily_usage'),
      context_messages: read('context_messages'),
    };
  };
  const before = productionCounts();

  // The cache directory is created on demand: a scene read must not require an
  // earlier analysis to have made it exist.
  await rm(loaded.config.paths.media_cache, { recursive: true, force: true });
  const photo = await media.prepareSceneImage(photoId, new AbortController().signal);
  expect(photo.mime).toBe('image/png');
  const decoded = await sharp(Buffer.from(photo.base64, 'base64')).metadata();
  expect([decoded.format, decoded.width, decoded.height]).toEqual(['png', 32, 16]);

  // A sticker reads through its representative thumbnail, the same
  // normalization the vision path uses.
  const sticker = await media.prepareSceneImage(stickerId, new AbortController().signal);
  expect(sticker.mime).toBe('image/png');
  const document = await media.prepareSceneImage(documentId, new AbortController().signal);
  expect(document.mime).toBe('image/png');
  expect(downloaded).toEqual(['photo-file', 'sticker-thumb', 'document-file']);

  // The generation contract is unchanged: the same sticker stays unavailable as
  // generation input while the photo and the image document still work.
  await expect(media.prepareInputImage(stickerId, new AbortController().signal)).rejects.toThrow(
    'Media is unavailable as generation input',
  );
  await expect(media.prepareSceneImage(999_999n, new AbortController().signal)).rejects.toThrow(
    'Media is unavailable as scene input',
  );
  expect((await media.prepareInputImage(photoId, new AbortController().signal)).mime).toBe('image/png');
  expect((await media.prepareInputImage(documentId, new AbortController().signal)).mime).toBe('image/png');

  // An abort still removes the temporary directory, and every read above only
  // selected the media row: no analysis, audit, usage or context rows appear.
  const aborted = new AbortController();
  aborted.abort();
  await expect(media.prepareSceneImage(photoId, aborted.signal)).rejects.toThrow();
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  expect(productionCounts()).toEqual(before);
  store.close();
});
