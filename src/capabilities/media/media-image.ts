import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { pickEnv, readBoundedOutput, spawnProcess } from '../../platform/subprocess.ts';
import type { MediaDownloader } from './media-download.ts';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_PIXELS = 40_000_000;
const MAX_NORMALIZED_BYTES = 10 * 1024 * 1024;

const ALLOWED_IMAGE_FORMATS: Record<string, true> = {
  jpeg: true,
  png: true,
  webp: true,
  svg: true,
};

export const StickerTelegramSchema = Type.Object(
  {
    is_video: Type.Boolean(),
    is_animated: Type.Boolean(),
    thumbnail: Type.Optional(Type.Object({ file_id: Type.String() }, { additionalProperties: true })),
  },
  { additionalProperties: true },
);
const TgsMetadataSchema = Type.Object({ ip: Type.Number(), op: Type.Number() }, { additionalProperties: true });
export const stickerTelegramValidator = Compile(StickerTelegramSchema);
const tgsMetadataValidator = Compile(TgsMetadataSchema);

export interface MediaRow {
  readonly id: bigint;
  readonly kind: string;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly telegramJson: string;
}

/**
 * Ceiling for a decompressed TGS. Telegram caps the gzip file at 64 KiB and real
 * Lottie JSON stays far below this, but the download limit alone lets a gzip
 * bomb expand to gigabytes inside a synchronous call on the event loop. The
 * converter only runs once this check has passed.
 */
const MAX_TGS_JSON_BYTES = 8 * 1024 * 1024;

/**
 * Input options for a downloaded video sticker. Telegram video stickers are
 * WebM, and `is_video` says nothing about the bytes: with format probing left
 * on, a playlist or concat file makes ffprobe/ffmpeg open further local files
 * or network URLs. Forcing the Matroska demuxer and the `file` protocol keeps
 * them on the one downloaded file.
 */
const VIDEO_STICKER_INPUT = ['-f', 'matroska', '-protocol_whitelist', 'file'] as const;

export interface NormalizedImage {
  readonly path: string;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
}

/**
 * Turns a media row into one normalized still image ready for a vision model:
 * downloads the payload, prefers sticker thumbnails, extracts a representative
 * frame from video/TGS stickers via ffmpeg/lottie, then normalizes with sharp.
 */
export async function prepareMediaImage(
  media: MediaRow,
  inputPath: string,
  directory: string,
  downloader: MediaDownloader,
  signal: AbortSignal,
): Promise<NormalizedImage> {
  if (media.kind !== 'sticker') {
    await downloader.download(media.fileId, inputPath, signal);
    return normalizeImage(inputPath, directory, signal);
  }
  let telegram: unknown;
  try {
    telegram = JSON.parse(media.telegramJson);
  } catch {
    throw new Error('Stored sticker metadata is invalid JSON');
  }
  if (!stickerTelegramValidator.Check(telegram)) {
    throw new Error('Stored sticker metadata does not match its schema');
  }
  if (telegram.thumbnail !== undefined) {
    const thumbnailPath = join(directory, 'thumbnail');
    await downloader.download(telegram.thumbnail.file_id, thumbnailPath, signal);
    return normalizeImage(thumbnailPath, directory, signal);
  }
  await downloader.download(media.fileId, inputPath, signal);
  if (!telegram.is_video && !telegram.is_animated) {
    return normalizeImage(inputPath, directory, signal);
  }
  if (telegram.is_video) {
    const outputPath = join(directory, 'representative.png');
    const durationText = await runExternal(
      [
        'ffprobe',
        '-v',
        'error',
        ...VIDEO_STICKER_INPUT,
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      true,
      signal,
    );
    const duration = Number.parseFloat(durationText.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('ffprobe returned an invalid sticker duration');
    }
    await runExternal(
      [
        'ffmpeg',
        '-v',
        'error',
        '-ss',
        String(duration / 2),
        ...VIDEO_STICKER_INPUT,
        '-i',
        inputPath,
        '-frames:v',
        '1',
        outputPath,
      ],
      false,
      signal,
    );
    return normalizeImage(outputPath, directory, signal);
  }
  const outputPath = join(directory, 'representative.svg');
  const compressed = new Uint8Array(await readFile(inputPath, { signal }));
  signal.throwIfAborted();
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder().decode(gunzipSync(compressed, { maxOutputLength: MAX_TGS_JSON_BYTES })));
  } catch {
    throw new Error('Animated sticker TGS metadata is invalid or larger than 8 MiB');
  }
  if (!tgsMetadataValidator.Check(metadata) || metadata.op <= metadata.ip) {
    throw new Error('Animated sticker frame range is invalid');
  }
  const frame = Math.floor((metadata.ip + metadata.op) / 2);
  await runExternal(createLottieCommand([inputPath, outputPath, '--frame', String(frame)]), false, signal);
  return normalizeImage(outputPath, directory, signal);
}

export function createLottieCommand(argumentsList: readonly string[]): string[] {
  if (process.platform !== 'win32') {
    return ['lottie_convert.py', ...argumentsList];
  }
  const runner =
    "import os, runpy, sysconfig; runpy.run_path(os.path.join(sysconfig.get_path('scripts'), 'lottie_convert.py'), run_name='__main__')";
  return ['python', '-c', runner, ...argumentsList];
}

async function runExternal(argv: readonly string[], captureOutput: boolean, signal: AbortSignal): Promise<string> {
  // A cancellation that already landed must refuse to start the command at all:
  // spawning first and only then registering the abort listener would let the
  // command run to completion while the caller already gave up.
  signal.throwIfAborted();
  const processHandle = spawnProcess(argv, {
    env: pickEnv(
      process.platform === 'win32'
        ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
        : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'],
    ),
    stdout: captureOutput ? 'pipe' : 'ignore',
  });
  const abortProcess = (): void => processHandle.kill();
  signal.addEventListener('abort', abortProcess, { once: true });
  const timeout = setTimeout(() => processHandle.kill(), 30_000);
  try {
    const output =
      captureOutput && processHandle.stdout !== null
        ? await readBoundedOutput(processHandle.stdout, 65_536, () => {
            processHandle.kill();
            return new Error('Media command output exceeds 64 KiB');
          })
        : '';
    const exitCode = await processHandle.exited;
    if (signal.aborted) {
      throw new Error('Media command aborted');
    }
    if (exitCode !== 0) {
      throw new Error(`${argv[0]} failed with exit code ${exitCode}`);
    }
    return output;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortProcess);
  }
}

/**
 * One still image from `inputPath` with sharp. The signal is observed around
 * every await this function controls: sharp's native decode/encode cannot be
 * interrupted, but a cancellation that lands while it runs must surface as a
 * failure before any bytes are handed back to the caller.
 */
async function normalizeImage(inputPath: string, directory: string, signal: AbortSignal): Promise<NormalizedImage> {
  signal.throwIfAborted();
  const input = await readFile(inputPath, { signal });
  signal.throwIfAborted();
  if (input.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('Image input exceeds 20 MB');
  }
  const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_DECODED_PIXELS });
  const metadata = await source.metadata();
  signal.throwIfAborted();
  if (metadata.format === undefined || !(metadata.format in ALLOWED_IMAGE_FORMATS)) {
    throw new Error('Unsupported image format');
  }
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error('Image dimensions are unavailable');
  }
  if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
    throw new Error('Decoded image exceeds pixel limit');
  }
  const transparent = metadata.hasAlpha === true;
  const outputPath = join(directory, transparent ? 'normalized.png' : 'normalized.jpg');
  const pipeline = source.rotate().resize({
    width: 2048,
    height: 2048,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const output = transparent
    ? await pipeline.png().toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  signal.throwIfAborted();
  if (output.data.byteLength > MAX_NORMALIZED_BYTES) {
    throw new Error('Normalized image exceeds output limit');
  }
  await writeFile(outputPath, output.data);
  signal.throwIfAborted();
  if (process.platform !== 'win32') {
    await chmod(outputPath, 0o600);
  }
  signal.throwIfAborted();
  return {
    path: outputPath,
    mimeType: transparent ? 'image/png' : 'image/jpeg',
    width: output.info.width,
    height: output.info.height,
  };
}
