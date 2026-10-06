import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type MediaRow, prepareMediaImage } from '../src/capabilities/media/media-image.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';

/**
 * `spawnProcess` is wrapped so the cancellation regressions below can observe
 * every external command attempt: the wrapper records the argv, then delegates
 * to the real spawn, so the ffmpeg-backed tests in this file still work. In the
 * cancellation regressions nothing may be recorded at all.
 */
const spawnHooks = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock('../src/platform/subprocess.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/subprocess.ts')>();
  return {
    ...actual,
    spawnProcess: (argv: readonly string[], options: Parameters<typeof actual.spawnProcess>[1]) => {
      spawnHooks.calls.push([...argv]);
      return actual.spawnProcess(argv, options);
    },
  };
});

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

afterEach(() => {
  spawnHooks.calls = [];
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function ffmpeg(args: readonly string[]): boolean {
  return spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' }).status === 0;
}

function videoSticker(): MediaRow {
  return {
    id: 1n,
    kind: 'sticker',
    fileId: 'sticker-file',
    fileUniqueId: 'sticker-unique',
    mimeType: 'video/webm',
    fileSize: null,
    telegramJson: JSON.stringify({ is_video: true, is_animated: false }),
  };
}

/** Stands in for Telegram: the "downloaded" sticker is whatever file the test prepared. */
function serving(source: string) {
  return { download: async (_fileId: string, destination: string) => copyFile(source, destination) };
}

describe.skipIf(!hasFfmpeg)('video sticker frame extraction', () => {
  test('only WebM is decoded: another container posing as a video sticker is refused', async () => {
    // With format probing on, ffprobe/ffmpeg decode whatever the bytes look like,
    // including playlist and concat formats that open further files or URLs.
    // (This ffmpeg may refuse those itself; older builds do not.) Forcing the
    // Matroska demuxer is observable with any non-WebM input, such as MPEG-TS.
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
    directories.push(directory);
    const transport = join(directory, 'clip.ts');
    expect(
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x64:rate=10',
        '-t',
        '1',
        '-c:v',
        'mpeg2video',
        '-f',
        'mpegts',
        transport,
      ]),
    ).toBe(true);
    await expect(
      prepareMediaImage(
        videoSticker(),
        join(directory, 'input'),
        directory,
        serving(transport),
        new AbortController().signal,
      ),
    ).rejects.toThrow('ffprobe failed');
  });

  test('a real WebM video sticker still yields a frame', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
    directories.push(directory);
    const webm = join(directory, 'sticker.webm');
    const encoded = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-t', '1', '-c:v', 'libvpx-vp9', webm]);
    if (!encoded) {
      // This ffmpeg build has no VP9 encoder; the refusal test above still runs.
      return;
    }
    const image = await prepareMediaImage(
      videoSticker(),
      join(directory, 'input'),
      directory,
      serving(webm),
      new AbortController().signal,
    );
    expect(image.width).toBeGreaterThan(0);
  });
});

test('an animated sticker that decompresses past the TGS ceiling is refused before conversion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  directories.push(directory);
  // 64 MiB of JSON that gzips to a few dozen KiB: inside the download limit, and
  // otherwise inflated in one synchronous call on the event loop.
  const bomb = join(directory, 'bomb.tgs');
  await writeFile(bomb, gzipSync(`{"ip":0,"op":10,"pad":"${' '.repeat(64 * 1024 * 1024)}"}`));
  const sticker: MediaRow = {
    ...videoSticker(),
    mimeType: 'application/x-tgsticker',
    telegramJson: JSON.stringify({ is_video: false, is_animated: true }),
  };
  await expect(
    prepareMediaImage(sticker, join(directory, 'input'), directory, serving(bomb), new AbortController().signal),
  ).rejects.toThrow('larger than 8 MiB');
});

async function expectCancelled(promise: Promise<unknown>): Promise<void> {
  const settled = await promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (settled.ok) {
    throw new Error('Expected the cancelled media preparation to reject');
  }
  expect((settled.error as { readonly name?: string }).name).toBe('AbortError');
}

/** A downloader that downloads anyway, as if the cancellation raced its own check. */
function ignoringCancellation(bytes: Uint8Array): MediaDownloader {
  return {
    download: async (_fileId, destination) => {
      await writeFile(destination, bytes);
    },
  };
}

/** Aborts the signal inside the downloader, right before it resolves. */
function abortedAfterDownload(bytes: Uint8Array): {
  readonly signal: AbortSignal;
  readonly downloader: MediaDownloader;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    downloader: {
      download: async (_fileId, destination) => {
        await writeFile(destination, bytes);
        controller.abort();
      },
    },
  };
}

test('a pre-cancelled signal refuses to spawn ffprobe or ffmpeg for a video sticker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  directories.push(directory);
  const controller = new AbortController();
  controller.abort();
  // The video sticker path has no checkpoint between the download and ffprobe:
  // the shared command runner itself must refuse to start anything.
  await expectCancelled(
    prepareMediaImage(
      videoSticker(),
      join(directory, 'input'),
      directory,
      ignoringCancellation(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
      controller.signal,
    ),
  );
  expect(spawnHooks.calls).toEqual([]);
});

test('a cancellation landing right after the download refuses to spawn ffprobe or ffmpeg', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  directories.push(directory);
  const { signal, downloader } = abortedAfterDownload(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  await expectCancelled(prepareMediaImage(videoSticker(), join(directory, 'input'), directory, downloader, signal));
  expect(spawnHooks.calls).toEqual([]);
});

test('a cancellation landing right after the download refuses to spawn the Lottie converter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  directories.push(directory);
  const { signal, downloader } = abortedAfterDownload(gzipSync(JSON.stringify({ ip: 0, op: 10 })));
  const sticker: MediaRow = {
    ...videoSticker(),
    mimeType: 'application/x-tgsticker',
    telegramJson: JSON.stringify({ is_video: false, is_animated: true }),
  };
  await expectCancelled(prepareMediaImage(sticker, join(directory, 'input'), directory, downloader, signal));
  expect(spawnHooks.calls).toEqual([]);
});
