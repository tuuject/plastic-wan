import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaCommand, MediaVariant } from './args.ts';
import type { AdminClient, MediaContent } from './client.ts';
import { isRecord } from './client.ts';
import type { CommandContext } from './commands.ts';
import { CliError } from './errors.ts';

/** Bounds for one `invocation media` run; requests are sequential and bounded by these. */
export const MAX_MEDIA_ITEMS = 32;
export const MAX_MEDIA_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 100 * 1024 * 1024;

export const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * Known MIME types and the extension used for the saved file. Content types
 * outside this table (but syntactically valid) are stored as `.bin`; a value
 * that is not a MIME type at all is refused.
 */
const MEDIA_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
  ['audio/ogg', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/flac', 'flac'],
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['application/json', 'json'],
  ['application/octet-stream', 'bin'],
  ['application/x-tgsticker', 'tgs'],
  ['text/plain', 'txt'],
]);

const MEDIA_ID_PATTERN = /^\d{1,19}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

interface MediaItem {
  readonly id: string;
  readonly message_id: string;
  readonly revision_id: string;
  readonly kind: string;
  readonly mime_type: string | null;
  readonly file_size: number | null;
  readonly variants: readonly string[];
}

interface ManifestError {
  readonly code: string;
  readonly message: string;
}

interface ManifestItem {
  readonly id: string;
  readonly message_id: string;
  readonly revision_id: string;
  readonly kind: string;
  readonly status: 'downloaded' | 'failed';
  readonly path: string | null;
  readonly mime_type: string | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly error: ManifestError | null;
}

interface MediaManifest {
  readonly invocation_id: string;
  readonly variant: MediaVariant;
  readonly directory: string;
  readonly items: readonly ManifestItem[];
}

export async function runMedia(command: MediaCommand, context: CommandContext, client: AdminClient): Promise<number> {
  const invocationId = command.id;
  const items = parseMediaList(await client.get(`api/invocations/${invocationId}/media`), invocationId);
  if (items.length > MAX_MEDIA_ITEMS) {
    throw new CliError(
      'media_too_many_items',
      `media list has ${items.length} items; at most ${MAX_MEDIA_ITEMS} can be downloaded`,
    );
  }
  const declaredBytes = items.reduce((total, item) => total + (item.file_size ?? 0), 0);
  if (declaredBytes > MAX_MEDIA_TOTAL_BYTES) {
    throw new CliError(
      'media_total_too_large',
      `media list declares ${declaredBytes} bytes; the total limit is ${MAX_MEDIA_TOTAL_BYTES}`,
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  const records: ManifestItem[] = [];
  let totalBytes = 0;
  for (const item of items) {
    const outcome = await downloadItem(item, {
      invocationId,
      variant: command.variant,
      directory,
      client,
      budgetBytes: MAX_MEDIA_TOTAL_BYTES - totalBytes,
    });
    totalBytes += outcome.bytes;
    records.push(outcome.record);
  }
  const manifest: MediaManifest = { invocation_id: invocationId, variant: command.variant, directory, items: records };
  const failures = records.filter((record) => record.status === 'failed');
  const manifestJson = context.redact(JSON.stringify(manifest, null, 2));
  if (records.length > 0 && failures.length === records.length) {
    await rm(directory, { recursive: true, force: true });
    printManifest(manifest, manifestJson, context);
    throw mediaFailure(failures, records.length);
  }
  try {
    await writeFile(join(directory, MANIFEST_FILE_NAME), `${manifestJson}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new CliError('media_manifest_write_failed', `could not write ${MANIFEST_FILE_NAME}: ${messageOf(error)}`);
  }
  printManifest(manifest, manifestJson, context);
  if (failures.length > 0) {
    throw mediaFailure(failures, records.length);
  }
  return 0;
}

interface DownloadOptions {
  readonly invocationId: string;
  readonly variant: MediaVariant;
  readonly directory: string;
  readonly client: AdminClient;
  readonly budgetBytes: number;
}

async function downloadItem(
  item: MediaItem,
  options: DownloadOptions,
): Promise<{ readonly record: ManifestItem; readonly bytes: number }> {
  if (!item.variants.includes(options.variant)) {
    return {
      record: failureRecord(item, 'variant_not_available', `variant ${options.variant} is not available for this item`),
      bytes: 0,
    };
  }
  if (item.file_size !== null && item.file_size > MAX_MEDIA_FILE_BYTES) {
    return {
      record: failureRecord(
        item,
        'media_file_too_large',
        `item declares ${item.file_size} bytes; the per-file limit is ${MAX_MEDIA_FILE_BYTES}`,
      ),
      bytes: 0,
    };
  }
  if (item.file_size !== null && item.file_size > options.budgetBytes) {
    return { record: budgetFailure(item, options.budgetBytes), bytes: 0 };
  }
  const cap = Math.min(MAX_MEDIA_FILE_BYTES, options.budgetBytes);
  let download: MediaContent;
  try {
    download = await options.client.getMedia(
      `api/invocations/${options.invocationId}/media/${item.id}/content`,
      new URLSearchParams({ variant: options.variant }),
      cap,
    );
  } catch (error) {
    if (error instanceof CliError && error.code === 'media_file_too_large' && cap < MAX_MEDIA_FILE_BYTES) {
      return { record: budgetFailure(item, options.budgetBytes), bytes: 0 };
    }
    return { record: failureRecord(item, errorCode(error), messageOf(error)), bytes: 0 };
  }
  if (download.variant !== options.variant) {
    return {
      record: failureRecord(item, 'invalid_response', `media content did not confirm variant ${options.variant}`),
      bytes: 0,
    };
  }
  const contentType = download.contentType;
  if (contentType !== null && !MIME_PATTERN.test(contentType)) {
    return { record: failureRecord(item, 'invalid_response', 'media content type is not a valid MIME type'), bytes: 0 };
  }
  const extension = contentType === null ? 'bin' : (MEDIA_EXTENSIONS.get(contentType) ?? 'bin');
  const path = join(options.directory, `${item.id}.${extension}`);
  try {
    await writeFile(path, download.bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    return { record: failureRecord(item, 'media_write_failed', messageOf(error)), bytes: 0 };
  }
  const bytes = download.bytes.byteLength;
  return {
    record: {
      id: item.id,
      message_id: item.message_id,
      revision_id: item.revision_id,
      kind: item.kind,
      status: 'downloaded',
      path,
      mime_type: contentType,
      bytes,
      sha256: createHash('sha256').update(download.bytes).digest('hex'),
      error: null,
    },
    bytes,
  };
}

function failureRecord(item: MediaItem, code: string, message: string): ManifestItem {
  return {
    id: item.id,
    message_id: item.message_id,
    revision_id: item.revision_id,
    kind: item.kind,
    status: 'failed',
    path: null,
    mime_type: item.mime_type,
    bytes: null,
    sha256: null,
    error: { code, message },
  };
}

function budgetFailure(item: MediaItem, budgetBytes: number): ManifestItem {
  return failureRecord(
    item,
    'media_total_too_large',
    `this item does not fit in the remaining ${budgetBytes} bytes of the ${MAX_MEDIA_TOTAL_BYTES} byte total`,
  );
}

function printManifest(manifest: MediaManifest, manifestJson: string, context: CommandContext): void {
  context.io.stdout(context.json ? `${JSON.stringify(manifest)}\n` : `${manifestJson}\n`);
}

function mediaFailure(failures: readonly ManifestItem[], total: number): CliError {
  const details = failures
    .slice(0, 3)
    .map(
      (item) => `${item.id}: ${item.error?.code ?? 'failed'}${item.error?.message ? ` (${item.error.message})` : ''}`,
    )
    .join('; ');
  const remaining = failures.length > 3 ? `; +${failures.length - 3} more` : '';
  return new CliError(
    'media_download_failed',
    `${failures.length} of ${total} media items failed: ${details}${remaining}`,
  );
}

function errorCode(error: unknown): string {
  return error instanceof CliError ? error.code : 'internal_error';
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'unexpected failure';
}

function parseMediaList(raw: unknown, invocationId: string): readonly MediaItem[] {
  if (!isRecord(raw) || raw.invocation_id !== invocationId || !Array.isArray(raw.items)) {
    throw new CliError('invalid_response', 'media list response has an unexpected shape');
  }
  return raw.items.map((item) => parseMediaItem(item));
}

function parseMediaItem(raw: unknown): MediaItem {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    !MEDIA_ID_PATTERN.test(raw.id) ||
    !isNonEmptyString(raw.message_id) ||
    !isNonEmptyString(raw.revision_id) ||
    !isNonEmptyString(raw.kind) ||
    !(raw.mime_type === null || typeof raw.mime_type === 'string') ||
    !(
      raw.file_size === null ||
      (typeof raw.file_size === 'number' && Number.isSafeInteger(raw.file_size) && raw.file_size >= 0)
    ) ||
    !Array.isArray(raw.variants) ||
    raw.variants.length === 0 ||
    !raw.variants.every((variant) => variant === 'original' || variant === 'preview')
  ) {
    throw new CliError('invalid_response', 'media list item has an unexpected shape');
  }
  return {
    id: raw.id,
    message_id: raw.message_id,
    revision_id: raw.revision_id,
    kind: raw.kind,
    mime_type: raw.mime_type,
    file_size: raw.file_size,
    variants: raw.variants,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
