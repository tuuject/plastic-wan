import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { TelegramMediaClient, type MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { AdminQueryError } from '../src/ingress/admin/audit.ts';
import {
  createInvocationMediaReader,
  type InvocationMediaItem,
  type InvocationMediaVariant,
  listInvocationMedia,
} from '../src/ingress/admin/invocation-media.ts';
import { loadConfig } from '../src/platform/config.ts';
import { type Orm, SqliteStore } from '../src/store/database.ts';
import {
  buckets,
  chats,
  conversations,
  invocationMessages,
  invocations,
  media,
  messageRevisions,
  messages,
} from '../src/store/schema.ts';
import { writeTestConfig } from './helpers.ts';

/**
 * `readFile` is wrapped so a test can park a read or abort immediately before
 * or after the bytes arrive: the timeout and cancellation cases below must land
 * inside the read window, not merely before the download. `rm` is wrapped so a
 * transient or persistent Windows-style EBUSY cleanup failure is deterministic:
 * while a failure hook is set, the wrapper reproduces Node's documented
 * `maxRetries`/`retryDelay` contract for the options the caller passed, so the
 * options the reader passes decide whether a transient failure is absorbed.
 * Every other export stays real, and without hooks both wrappers are
 * pass-throughs.
 */
const fsHooks = vi.hoisted(() => ({
  beforeRead: undefined as ((path: string) => Promise<void> | void) | undefined,
  afterRead: undefined as ((path: string) => void) | undefined,
  rmFailure: undefined as ((path: string, attempt: number) => Error | undefined) | undefined,
  rmOptions: [] as { readonly maxRetries?: number | undefined; readonly retryDelay?: number | undefined }[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (path: string, options?: { readonly signal?: AbortSignal }) => {
      await fsHooks.beforeRead?.(path);
      const bytes = await actual.readFile(path, options);
      fsHooks.afterRead?.(path);
      return bytes;
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const failure = fsHooks.rmFailure;
      if (failure === undefined) {
        return actual.rm(path, options);
      }
      fsHooks.rmOptions.push({ maxRetries: options?.maxRetries, retryDelay: options?.retryDelay });
      const maxRetries = options?.maxRetries ?? 0;
      const retryDelay = options?.retryDelay ?? 100;
      for (let attempt = 0; ; attempt += 1) {
        const error = failure(String(path), attempt);
        if (error === undefined) {
          break;
        }
        if (attempt >= maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
      return actual.rm(path, options);
    },
  };
});

/**
 * Invocation media authorization fixture.
 *
 * `invocationMain` snapshots message 6001 at its *old* revision 6101, whose
 * media row 6201 is authorized while 6204 (same revision, not listed), 6202
 * (the message's current revision), and 6205 (another conversation) are not.
 * Message 6002 lives in conversation 2002, so the second invocation proves the
 * block is conversation scoping rather than a global filter.
 */
const IDS = {
  chat: 1_001n,
  conversation: 2_001n,
  otherConversation: 2_002n,
  messageMain: 6_001n,
  messageOther: 6_002n,
  messageSticker: 6_003n,
  revisionOld: 6_101n,
  revisionCurrent: 6_102n,
  revisionOther: 6_103n,
  revisionSticker: 6_104n,
  mediaOldPhoto: 6_201n,
  mediaCurrentPhoto: 6_202n,
  mediaHiddenPhoto: 6_204n,
  mediaOtherDocument: 6_205n,
  mediaSvg: 6_206n,
  mediaUnknownMime: 6_207n,
  mediaSticker: 6_208n,
  mediaHugeSize: 6_209n,
  mediaAlphaPhoto: 6_210n,
  mediaNullSize: 6_211n,
  invocationMain: 4_001n,
  invocationOther: 4_002n,
  invocationBadJson: 4_003n,
  invocationMissingId: 4_004n,
  invocationNumericId: 4_005n,
  invocationSticker: 4_006n,
} as const;

const AT = '2026-10-06T08:00:00.000Z';
const HUGE_FILE_SIZE = 9_007_199_254_740_993n; // 2^53 + 1: not a safe JS number.

let store: SqliteStore;
let configDirectory: string;
let opaquePng: Uint8Array;
let transparentPng: Uint8Array;
const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

beforeAll(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), 'plasticwan-invocation-media-'));
  const configPath = join(configDirectory, 'config.jsonc');
  await writeTestConfig(configDirectory, configPath);
  const loaded = await loadConfig(configPath);
  store = await SqliteStore.open(loaded.config);
  seedFixture(store.orm);
  opaquePng = new Uint8Array(
    await sharp({ create: { width: 32, height: 16, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .png()
      .toBuffer(),
  );
  transparentPng = new Uint8Array(
    await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .toBuffer(),
  );
});

afterAll(async () => {
  store.close();
  await rm(configDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

afterEach(() => {
  fsHooks.beforeRead = undefined;
  fsHooks.afterRead = undefined;
  fsHooks.rmFailure = undefined;
  fsHooks.rmOptions = [];
  vi.unstubAllGlobals();
});

function seedFixture(orm: Orm): void {
  orm
    .insert(chats)
    .values({
      id: IDS.chat,
      telegramChatId: 123_456_789n,
      canonicalChatId: 123_456_789n,
      type: 'supergroup',
      title: 'Invocation media fixture',
      username: null,
      updatedAt: AT,
    })
    .run();
  orm
    .insert(conversations)
    .values([
      { id: IDS.conversation, chatId: IDS.chat, messageThreadId: 0n, createdAt: AT, updatedAt: AT },
      { id: IDS.otherConversation, chatId: IDS.chat, messageThreadId: 1n, createdAt: AT, updatedAt: AT },
    ])
    .run();
  orm
    .insert(messages)
    .values([
      messageRow(IDS.messageMain, IDS.conversation, 9_001n),
      messageRow(IDS.messageOther, IDS.otherConversation, 9_002n),
      messageRow(IDS.messageSticker, IDS.conversation, 9_003n),
    ])
    .run();
  orm
    .insert(messageRevisions)
    .values([
      revisionRow(IDS.revisionOld, IDS.messageMain, 1n, 'photo'),
      revisionRow(IDS.revisionCurrent, IDS.messageMain, 2n, 'photo'),
      revisionRow(IDS.revisionOther, IDS.messageOther, 1n, 'document'),
      revisionRow(IDS.revisionSticker, IDS.messageSticker, 1n, 'sticker'),
    ])
    .run();
  orm.update(messages).set({ currentRevisionId: IDS.revisionCurrent }).where(eq(messages.id, IDS.messageMain)).run();
  orm
    .insert(media)
    .values([
      mediaRow(IDS.mediaOldPhoto, IDS.revisionOld, 'photo', 'file-photo-old', 'image/png', 68n, '{}'),
      mediaRow(IDS.mediaCurrentPhoto, IDS.revisionCurrent, 'photo', 'file-photo-current', 'image/png', 68n, '{}'),
      mediaRow(IDS.mediaHiddenPhoto, IDS.revisionOld, 'photo', 'file-photo-hidden', 'image/png', 68n, '{}'),
      mediaRow(IDS.mediaOtherDocument, IDS.revisionOther, 'document', 'file-doc-other', 'application/pdf', 68n, '{}'),
      mediaRow(IDS.mediaSvg, IDS.revisionOld, 'document', 'file-svg', 'image/svg+xml', 68n, '{}'),
      mediaRow(IDS.mediaUnknownMime, IDS.revisionOld, 'document', 'file-unknown-mime', null, 68n, '{}'),
      mediaRow(
        IDS.mediaSticker,
        IDS.revisionSticker,
        'sticker',
        'file-sticker',
        'application/x-tgsticker',
        68n,
        JSON.stringify({ is_video: false, is_animated: false, thumbnail: { file_id: 'file-sticker-thumb' } }),
      ),
      mediaRow(IDS.mediaHugeSize, IDS.revisionOld, 'photo', 'file-photo-huge-size', 'image/png', HUGE_FILE_SIZE, '{}'),
      mediaRow(IDS.mediaAlphaPhoto, IDS.revisionOld, 'photo', 'file-photo-alpha', 'image/png', 68n, '{}'),
      // A NULL size is legal in the schema: the download-time cap is the only defense.
      mediaRow(IDS.mediaNullSize, IDS.revisionOld, 'photo', 'file-photo-null-size', 'image/png', null, '{}'),
    ])
    .run();
  const invocationIds = [
    [IDS.invocationMain, IDS.conversation],
    [IDS.invocationOther, IDS.otherConversation],
    [IDS.invocationBadJson, IDS.conversation],
    [IDS.invocationMissingId, IDS.conversation],
    [IDS.invocationNumericId, IDS.conversation],
    [IDS.invocationSticker, IDS.conversation],
  ] as const;
  orm
    .insert(buckets)
    .values(
      invocationIds.map(([, conversationId], index) => ({
        id: 3_001n + BigInt(index),
        conversationId,
        state: 'completed',
        kind: 'realtime',
        firstReceivedAt: AT,
        deadlineAt: AT,
        queuedAt: AT,
        startedAt: AT,
        finishedAt: AT,
        mergedIntoBucketId: null,
        errorCode: null,
        createdAt: AT,
        updatedAt: AT,
      })),
    )
    .run();
  orm
    .insert(invocations)
    .values(
      invocationIds.map(([id, conversationId], index) => ({
        id,
        bucketId: 3_001n + BigInt(index),
        conversationId,
        state: 'completed',
        configHash: 'invocation-media-fixture',
        promptVersion: 1n,
        toolRegistryHash: null,
        toolRegistryJson: null,
        startedAt: AT,
        finishedAt: AT,
        completionReason: 'completed',
        errorCode: null,
        sendsUsed: 0n,
        toolCallsUsed: 0n,
        turnsUsed: 0n,
        sideEffectStarted: false,
        createdAt: AT,
      })),
    )
    .run();
  orm
    .insert(invocationMessages)
    .values([
      // The old revision is snapshotted: 6201 is listed, 6204 is not.
      snapshotRow(IDS.invocationMain, IDS.messageMain, IDS.revisionOld, 1n, {
        message_id: '9001',
        kind: 'photo',
        caption: 'older revision',
        media: [
          { id: '6201', kind: 'photo' },
          { id: '6206', kind: 'document' },
          { id: '6207', kind: 'document' },
          { id: '6209', kind: 'photo' },
          { id: '6210', kind: 'photo' },
          { id: '6211', kind: 'photo' },
        ],
      }),
      // Cross-conversation snapshot row: message 6002 belongs to conversation 2002.
      snapshotRow(IDS.invocationMain, IDS.messageOther, IDS.revisionOther, 2n, { media: [{ id: '6205' }] }),
      snapshotRow(IDS.invocationOther, IDS.messageOther, IDS.revisionOther, 1n, { media: [{ id: '6205' }] }),
      snapshotRow(IDS.invocationBadJson, IDS.messageMain, IDS.revisionOld, 1n, null, '{not json'),
      snapshotRow(IDS.invocationMissingId, IDS.messageMain, IDS.revisionOld, 1n, { media: [{ kind: 'photo' }] }),
      snapshotRow(IDS.invocationNumericId, IDS.messageMain, IDS.revisionOld, 1n, { media: [{ id: 6201 }] }),
      snapshotRow(IDS.invocationSticker, IDS.messageSticker, IDS.revisionSticker, 1n, { media: [{ id: '6208' }] }),
    ])
    .run();
}

function messageRow(id: bigint, conversationId: bigint, telegramMessageId: bigint) {
  return {
    id,
    conversationId,
    chatId: IDS.chat,
    telegramMessageId,
    currentRevisionId: null,
    visible: true,
    sentByBot: false,
    telegramDate: AT,
    receivedAt: AT,
  };
}

function revisionRow(id: bigint, messageId: bigint, revisionNo: bigint, kind: string) {
  return {
    id,
    messageId,
    revisionNo,
    senderId: null,
    kind,
    text: null,
    caption: kind === 'photo' ? 'fixture caption' : null,
    replyToMessageId: null,
    replySnapshotJson: null,
    forwardOriginJson: null,
    mediaGroupId: null,
    serviceJson: null,
    createdAt: AT,
    rawFragmentJson: '{}',
  };
}

function mediaRow(
  id: bigint,
  revisionId: bigint,
  kind: string,
  fileId: string,
  mimeType: string | null,
  fileSize: bigint | null,
  telegramJson: string,
) {
  return {
    id,
    revisionId,
    kind,
    fileId,
    fileUniqueId: `${fileId}-unique`,
    mimeType,
    fileSize,
    width: 32n,
    height: 16n,
    telegramJson,
  };
}

function snapshotRow(
  invocationId: bigint,
  messageId: bigint,
  revisionId: bigint,
  sequenceNo: bigint,
  snapshot: unknown,
  rawSnapshot?: string,
) {
  return {
    invocationId,
    messageId,
    revisionId,
    section: sequenceNo === 1n ? 'history' : 'new',
    sequenceNo,
    sourceBucketId: null,
    omittedBefore: 0n,
    snapshotJson: rawSnapshot ?? JSON.stringify(snapshot),
  };
}

/**
 * Records every download and the private temp directory it landed in, so tests
 * can prove which file ID was fetched and that the directory is gone afterwards.
 */
function recordingDownloader(write: (fileId: string, destination: string, signal: AbortSignal) => Promise<void>) {
  const calls: { readonly fileId: string; readonly destination: string }[] = [];
  const directories: string[] = [];
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      calls.push({ fileId, destination });
      const directory = dirname(destination);
      if (!directories.includes(directory)) {
        directories.push(directory);
      }
      await write(fileId, destination, signal);
      signal.throwIfAborted();
    },
  };
  return { downloader, calls, directories };
}

function bytesFor(fileId: string): Uint8Array {
  switch (fileId) {
    case 'file-photo-old':
    case 'file-sticker-thumb':
      return opaquePng;
    case 'file-photo-alpha':
      return transparentPng;
    case 'file-svg':
    case 'file-unknown-mime':
      return svgBytes;
    default:
      throw new Error(`Unexpected download file ID ${fileId}`);
  }
}

/** Writes realistic bytes for known fixture file IDs; unknown IDs fail the test loudly. */
function fixtureWriter(fileId: string, destination: string): Promise<void> {
  return writeFile(destination, bytesFor(fileId));
}

function readerFor(downloader: MediaDownloader, shutdownSignal: AbortSignal = new AbortController().signal) {
  return createInvocationMediaReader({ orm: store.orm, downloader, shutdownSignal });
}

async function expectAdminError(run: Promise<unknown>, code: string, status: number): Promise<AdminQueryError> {
  const settled = await run.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (settled.ok) {
    throw new Error(`Expected ${code} (${status}) but the call succeeded`);
  }
  if (!(settled.error instanceof AdminQueryError)) {
    throw new Error(`Expected AdminQueryError, received ${String(settled.error)}`);
  }
  expect(settled.error.code).toBe(code);
  expect(settled.error.status).toBe(status);
  return settled.error;
}

function expectSyncAdminError(run: () => unknown, code: string, status: number): AdminQueryError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AdminQueryError)) {
    throw new Error(`Expected AdminQueryError, received ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
  expect(caught.status).toBe(status);
  return caught;
}

function itemOf(items: readonly InvocationMediaItem[], id: string): InvocationMediaItem {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) {
    throw new Error(`Expected media item ${id}`);
  }
  return item;
}

test('list reports only media authorized by the snapshotted revision of the invocation conversation', () => {
  const list = listInvocationMedia(store.orm, IDS.invocationMain);
  expect(list.invocation_id).toBe('4001');
  // 6201 is listed by the snapshot; 6206/6207/6209/6210/6211 too. 6204 shares
  // the revision but is not listed, 6202 belongs to the newer current revision,
  // and 6205 lives in another conversation.
  expect(list.items.map((entry) => entry.id)).toEqual(['6201', '6206', '6207', '6209', '6210', '6211']);
  expect(itemOf(list.items, '6201')).toEqual({
    id: '6201',
    message_id: '6001',
    revision_id: '6101',
    kind: 'photo',
    mime_type: 'image/png',
    file_size: 68,
    variants: ['original', 'preview'],
  });
  expect(itemOf(list.items, '6206')).toMatchObject({
    revision_id: '6101',
    kind: 'document',
    mime_type: 'image/svg+xml',
    variants: ['original'],
  });
  // A size that cannot round-trip through a JS number is reported as null.
  expect(itemOf(list.items, '6209').file_size).toBeNull();
  expect(itemOf(list.items, '6210').variants).toEqual(['original', 'preview']);
  // An unknown size stays unknown rather than being invented.
  expect(itemOf(list.items, '6211').file_size).toBeNull();
  // No file ID, Telegram JSON or Telegram message ID crosses the list API.
  expect(JSON.stringify(list)).not.toContain('file-photo-old');
  expect(JSON.stringify(list)).not.toContain('file_unique_id');
  expect(JSON.stringify(list)).not.toContain('telegram_message_id');
  expect(JSON.stringify(list)).not.toContain('9001');
});

test('list scopes media to the invocation conversation and reports sticker variants', () => {
  const other = listInvocationMedia(store.orm, IDS.invocationOther);
  expect(other.items.map((entry) => entry.id)).toEqual(['6205']);
  expect(itemOf(other.items, '6205')).toMatchObject({
    message_id: '6002',
    revision_id: '6103',
    kind: 'document',
    variants: ['original'],
  });
  const sticker = listInvocationMedia(store.orm, IDS.invocationSticker);
  expect(itemOf(sticker.items, '6208')).toMatchObject({
    kind: 'sticker',
    mime_type: 'application/x-tgsticker',
    variants: ['original', 'preview'],
  });
});

test('list rejects an unknown invocation and unreadable snapshots', () => {
  expectSyncAdminError(() => listInvocationMedia(store.orm, 9_999n), 'not_found', 404);
  expectSyncAdminError(() => listInvocationMedia(store.orm, IDS.invocationBadJson), 'snapshot_invalid', 409);
  expectSyncAdminError(() => listInvocationMedia(store.orm, IDS.invocationMissingId), 'snapshot_invalid', 409);
  expectSyncAdminError(() => listInvocationMedia(store.orm, IDS.invocationNumericId), 'snapshot_invalid', 409);
});

test('original reads return the downloaded bytes with only whitelisted MIME types', async () => {
  const { downloader, calls, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  const photo = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', signal);
  expect(photo.variant).toBe('original');
  expect(photo.mime).toBe('image/png');
  expect(Buffer.from(photo.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  expect(calls).toEqual([{ fileId: 'file-photo-old', destination: join(directories[0] ?? '', 'original') }]);
  // The per-request temp directory is gone after a successful read.
  await expect(access(directories[0] ?? '')).rejects.toThrow();

  const svg = await reader(IDS.invocationMain, IDS.mediaSvg, 'original', signal);
  expect(svg.mime).toBe('application/octet-stream');
  expect(Buffer.from(svg.bytes).equals(Buffer.from(svgBytes))).toBe(true);

  const unknown = await reader(IDS.invocationMain, IDS.mediaUnknownMime, 'original', signal);
  expect(unknown.mime).toBe('application/octet-stream');
  expect(Buffer.from(unknown.bytes).equals(Buffer.from(svgBytes))).toBe(true);

  expect(calls.map((call) => call.fileId)).toEqual(['file-photo-old', 'file-svg', 'file-unknown-mime']);
  expect(directories).toHaveLength(3);
  for (const directory of directories) {
    await expect(access(directory)).rejects.toThrow();
  }
});

test('preview normalizes photos and stickers to JPEG or PNG through the shared pipeline', async () => {
  const { downloader, calls, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  const jpeg = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'preview', signal);
  expect(jpeg.variant).toBe('preview');
  expect(jpeg.mime).toBe('image/jpeg');
  expect(jpeg.bytes[0]).toBe(0xff);
  expect(jpeg.bytes[1]).toBe(0xd8);

  const png = await reader(IDS.invocationMain, IDS.mediaAlphaPhoto, 'preview', signal);
  expect(png.mime).toBe('image/png');
  expect(png.bytes[0]).toBe(0x89);
  expect(png.bytes[1]).toBe(0x50);

  // Stickers preview from their metadata thumbnail, not from a caller-supplied ID.
  const sticker = await reader(IDS.invocationSticker, IDS.mediaSticker, 'preview', signal);
  expect(sticker.mime).toBe('image/jpeg');
  expect(calls.map((call) => call.fileId)).toEqual(['file-photo-old', 'file-photo-alpha', 'file-sticker-thumb']);
  for (const directory of directories) {
    await expect(access(directory)).rejects.toThrow();
  }
});

test('reads refuse media that is not snapshot-authorized before any download starts', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  // Media of the message's current revision is never authorized by an old snapshot.
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaCurrentPhoto, 'original', signal), 'not_found', 404);
  // Same revision as the snapshot, but not listed in it.
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaHiddenPhoto, 'original', signal), 'not_found', 404);
  // Listed by a snapshot row, but the message belongs to another conversation.
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaOtherDocument, 'original', signal), 'not_found', 404);
  // Unknown invocation and unknown media ID.
  await expectAdminError(reader(9_999n, IDS.mediaOldPhoto, 'original', signal), 'not_found', 404);
  await expectAdminError(reader(IDS.invocationMain, 9_998n, 'original', signal), 'not_found', 404);
  // The media is authorized in its own conversation.
  expect(calls).toHaveLength(0);

  await expectAdminError(reader(IDS.invocationBadJson, IDS.mediaOldPhoto, 'original', signal), 'snapshot_invalid', 409);
  await expectAdminError(
    reader(IDS.invocationMissingId, IDS.mediaOldPhoto, 'original', signal),
    'snapshot_invalid',
    409,
  );
  expect(calls).toHaveLength(0);
});

test('reads reject unsupported variants without touching Telegram', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'thumbnail' as unknown as InvocationMediaVariant, signal),
    'invalid_variant',
    400,
  );
  // Documents have no preview.
  await expectAdminError(
    reader(IDS.invocationOther, IDS.mediaOtherDocument, 'preview', signal),
    'invalid_variant',
    400,
  );
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaSvg, 'preview', signal), 'invalid_variant', 400);
  expect(calls).toHaveLength(0);
});

test('reads refuse media whose stored size already exceeds 20 MiB', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaHugeSize, 'original', new AbortController().signal),
    'media_too_large',
    413,
  );
  expect(calls).toHaveLength(0);
});

test('an aborted request fails with media_aborted and leaves no temp directory', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const aborted = new AbortController();
  aborted.abort();
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', aborted.signal),
    'media_aborted',
    499,
  );
  expect(calls).toHaveLength(0);

  const shutdown = new AbortController();
  let started = false;
  const pending = recordingDownloader(async (_fileId, destination, signal) => {
    started = true;
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await writeFile(destination, opaquePng);
  });
  const startedReader = readerFor(pending.downloader, shutdown.signal);
  const read = startedReader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  await vi.waitFor(() => {
    expect(started).toBe(true);
  });
  shutdown.abort();
  await expectAdminError(read, 'media_aborted', 499);
  expect(pending.directories).toHaveLength(1);
  await expect(access(pending.directories[0] ?? '')).rejects.toThrow();
});

test('a failing download reports one generic error and removes partial files', async () => {
  const { downloader, calls, directories } = recordingDownloader(async (_fileId, destination) => {
    await writeFile(destination, opaquePng.subarray(0, 8));
    throw new Error(`telegram getFile failed for https://api.telegram.org/file/bot987:SECRET/${destination}`);
  });
  const reader = readerFor(downloader);
  const error = await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_download_failed',
    502,
  );
  expect(error.message).toBe('Invocation media download failed');
  expect(error.message).not.toContain('SECRET');
  expect(error.message).not.toContain('telegram');
  expect(error.message).not.toContain('plasticwan-invocation-media-');
  expect(calls).toHaveLength(1);
  expect(directories).toHaveLength(1);
  // The whole per-request directory (including the partial file) is removed.
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

/**
 * The Windows-style failure Node's `rm` retries under `maxRetries`: whether a
 * single occurrence is absorbed is decided solely by the options the reader
 * passes. The message embeds the temp path, exactly like the real error, so a
 * raw leak would be visible.
 */
function ebusy(path: string): Error {
  return Object.assign(new Error(`EBUSY: resource busy or locked, rm '${path}'`), { code: 'EBUSY' });
}

test('a transient cleanup failure is retried with bounded options and the bytes still return', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  // First attempt fails, the retry succeeds: a Windows lock that lands after
  // the bytes were read must not turn a successful read into a failure.
  fsHooks.rmFailure = (path, attempt) => (attempt === 0 ? ebusy(path) : undefined);

  const result = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  expect(Buffer.from(result.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  // The retry budget is bounded and configured at the call site.
  expect(fsHooks.rmOptions).toEqual([{ maxRetries: 3, retryDelay: 100 }]);
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a persistent cleanup failure rejects a successful read with a redacted code and frees the slot', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  fsHooks.rmFailure = (path) => ebusy(path);

  // The download and the read both succeeded, yet no bytes may be returned:
  // the temp directory was not cleaned, and a raw EBUSY error carrying the temp
  // path must never reach the Admin API.
  const error = await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_cleanup_failed',
    500,
  );
  expect(error.message).toBe('Invocation media temporary files could not be removed');
  expect(error.message).not.toContain('EBUSY');
  expect(error.message).not.toContain('plasticwan-invocation-media-');
  expect(directories).toHaveLength(1);

  // The single-flight slot is released even though cleanup failed.
  fsHooks.rmFailure = undefined;
  const retry = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  expect(Buffer.from(retry.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  expect(directories).toHaveLength(2);

  // The failed cleanup left its directory behind (that is the condition under
  // test); remove it explicitly now that the injection is off.
  await rm(directories[0] ?? '', { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('a failed read whose cleanup keeps failing ends with the cleanup code, not a leaked fs error', async () => {
  const { downloader, directories } = recordingDownloader(async (_fileId, destination) => {
    throw new Error(`telegram getFile failed for https://api.telegram.org/file/bot987:SECRET/${destination}`);
  });
  const reader = readerFor(downloader);
  fsHooks.rmFailure = (path) => ebusy(path);

  const error = await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_cleanup_failed',
    500,
  );
  // The cleanup failure is reported, not swallowed, and neither the fs error
  // nor the download error leaks a path or a secret.
  expect(error.message).toBe('Invocation media temporary files could not be removed');
  expect(error.message).not.toContain('EBUSY');
  expect(error.message).not.toContain('plasticwan-invocation-media-');

  // The failed cleanup left its directory behind (that is the condition under
  // test); remove it explicitly now that the injection is off.
  fsHooks.rmFailure = undefined;
  await rm(directories[0] ?? '', { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('a second concurrent read is refused with media_busy while the metadata list still works', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      started = true;
      await gate;
      signal.throwIfAborted();
      await writeFile(destination, opaquePng);
    },
  };
  const reader = readerFor(downloader);
  const first = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  await vi.waitFor(() => {
    expect(started).toBe(true);
  });
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaAlphaPhoto, 'original', new AbortController().signal),
    'media_busy',
    429,
  );
  // The metadata list does not take the download slot.
  expect(listInvocationMedia(store.orm, IDS.invocationMain).items.length).toBeGreaterThan(0);
  release();
  const result = await first;
  expect(result.mime).toBe('image/png');
});

test('a read that exceeds the 60 second timeout fails with media_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let started = false;
    const pending = recordingDownloader(async (_fileId, destination, signal) => {
      started = true;
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      await writeFile(destination, opaquePng);
    });
    const reader = readerFor(pending.downloader);
    const read = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
    const outcome = read.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    while (!started) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = await outcome;
    expect(settled.ok).toBe(false);
    if (settled.ok) {
      throw new Error('Expected the timed-out read to fail');
    }
    expect(settled.error).toBeInstanceOf(AdminQueryError);
    expect((settled.error as AdminQueryError).code).toBe('media_timeout');
    expect((settled.error as AdminQueryError).status).toBe(504);
    expect(pending.directories).toHaveLength(1);
    await expect(access(pending.directories[0] ?? '')).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

/**
 * A body that emits the given chunks and ends. Paired with a stubbed global
 * `fetch`, this drives the real `TelegramMediaClient` without any network.
 */
function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function stubTelegramFetch(headers: Record<string, string>, chunks: readonly Uint8Array[]): void {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    body: bodyOf(chunks),
    headers: new Headers(headers),
  }));
}

function telegramClient(getFile: () => Promise<{ readonly file_path?: string }>): TelegramMediaClient {
  return new TelegramMediaClient({ getFile }, 'test-token');
}

test('a payload Telegram itself reports as oversized maps to 413 media_too_large', async () => {
  const reader = readerFor(telegramClient(async () => ({ file_path: 'photos/payload.bin' })));
  // Media 6201 stores 68 bytes; Telegram's content-length says 20 MiB + 1. The
  // stored size is metadata, and the response header alone must end as 413.
  stubTelegramFetch({ 'content-length': String(20 * 1024 * 1024 + 1) }, []);
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_too_large',
    413,
  );
});

test('a payload that only outgrows the cap while streaming maps to 413 media_too_large', async () => {
  const reader = readerFor(telegramClient(async () => ({ file_path: 'photos/payload.bin' })));
  // Media 6211 has no stored size at all, so only the streamed count can stop it.
  stubTelegramFetch({}, [new Uint8Array(1), new Uint8Array(20 * 1024 * 1024)]);
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaNullSize, 'original', new AbortController().signal),
    'media_too_large',
    413,
  );
});

test('a request abort while Telegram getFile is pending fails fast and frees the slot', async () => {
  let getFileCalls = 0;
  const client = telegramClient(() => {
    getFileCalls += 1;
    // getFile has no signal parameter: without the client-side race this would
    // never settle and the read would hold the single-flight slot forever.
    return new Promise<never>(() => undefined);
  });
  const reader = readerFor(client);
  const first = new AbortController();
  const read = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', first.signal);
  await vi.waitFor(() => {
    expect(getFileCalls).toBe(1);
  });
  first.abort();
  await expectAdminError(read, 'media_aborted', 499);

  // The slot is free again: the second read reaches its own getFile call
  // instead of being refused with media_busy.
  const second = new AbortController();
  const next = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', second.signal);
  await vi.waitFor(() => {
    expect(getFileCalls).toBe(2);
  });
  second.abort();
  await expectAdminError(next, 'media_aborted', 499);
});

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function expectSettledError<T>(settled: Promise<Settled<T>>, code: string, status: number): Promise<void> {
  const result = await settled;
  if (result.ok) {
    throw new Error(`Expected ${code} (${status}) but the call succeeded`);
  }
  if (!(result.error instanceof AdminQueryError)) {
    throw new Error(`Expected AdminQueryError, received ${String(result.error)}`);
  }
  expect(result.error.code).toBe(code);
  expect(result.error.status).toBe(status);
}

/** Parks the first `readFile` until the returned `release` is called. */
function parkFirstRead(): { readonly reached: () => boolean; readonly release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  fsHooks.beforeRead = async () => {
    if (!reached) {
      reached = true;
      await gate;
    }
  };
  return { reached: () => reached, release };
}

async function waitForPark(reached: () => boolean): Promise<void> {
  while (!reached()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a timeout while the downloaded original is being read fails with media_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { downloader, directories } = recordingDownloader(fixtureWriter);
    const reader = readerFor(downloader);
    const parked = parkFirstRead();
    const settled = settle(reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal));
    await waitForPark(parked.reached);
    await vi.advanceTimersByTimeAsync(60_000);
    parked.release();
    await expectSettledError(settled, 'media_timeout', 504);
    expect(directories).toHaveLength(1);
    await expect(access(directories[0] ?? '')).rejects.toThrow();

    // The timeout released the single-flight slot and the directory.
    fsHooks.beforeRead = undefined;
    const retry = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
    expect(Buffer.from(retry.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('a timeout while preview normalization reads its input fails with media_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { downloader, directories } = recordingDownloader(fixtureWriter);
    const reader = readerFor(downloader);
    const parked = parkFirstRead();
    const settled = settle(reader(IDS.invocationMain, IDS.mediaOldPhoto, 'preview', new AbortController().signal));
    await waitForPark(parked.reached);
    await vi.advanceTimersByTimeAsync(60_000);
    parked.release();
    await expectSettledError(settled, 'media_timeout', 504);
    expect(directories).toHaveLength(1);
    await expect(access(directories[0] ?? '')).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

test('a cancelled request during preview normalization fails with media_aborted', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const request = new AbortController();
  fsHooks.beforeRead = () => {
    request.abort();
  };
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'preview', request.signal),
    'media_aborted',
    499,
  );
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a request cancelled right after the original bytes were read fails with media_aborted', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const request = new AbortController();
  fsHooks.afterRead = () => {
    request.abort();
  };
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', request.signal),
    'media_aborted',
    499,
  );
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a request cancelled while the preview output is being read fails with media_aborted', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const request = new AbortController();
  let reads = 0;
  fsHooks.beforeRead = () => {
    reads += 1;
    if (reads === 2) {
      // The second read is the normalized output: normalization already
      // succeeded, so only the read-window check can stop this response.
      request.abort();
    }
  };
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaAlphaPhoto, 'preview', request.signal),
    'media_aborted',
    499,
  );
  expect(reads).toBe(2);
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});
