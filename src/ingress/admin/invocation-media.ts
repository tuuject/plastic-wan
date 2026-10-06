import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { MediaTooLargeError, type MediaDownloader } from '../../capabilities/media/media-download.ts';
import { MAX_DOWNLOAD_BYTES, type MediaRow, prepareMediaImage } from '../../capabilities/media/media-image.ts';
import type { Orm } from '../../store/database.ts';
import { AdminQueryError } from './audit.ts';

/**
 * Read-only Invocation media surface for the Admin panel.
 *
 * Media bytes are authorized, never addressed: the caller names an Invocation
 * and a stored media row ID, and nothing else. A row is served only when the
 * frozen `invocation_messages.snapshot_json` of that Invocation explicitly
 * lists its ID, the media row still points at the snapshotted revision, and the
 * revision -> message -> conversation chain agrees with the Invocation. A
 * snapshot that cannot prove its media list is a conflict, not an invitation to
 * fall back to "everything under this revision".
 *
 * Downloads reuse the shared `MediaDownloader` (the same Telegram client the
 * agent uses), so file IDs, Telegram file paths and tokens never cross this
 * module, and each read gets a fresh private temp directory that is removed on
 * every exit path; a directory that cannot be removed is reported as a generic
 * `media_cleanup_failed` instead of a raw fs error. Upstream failures surface
 * as one generic error; only size/abort/timeout/variant/not-found cases carry a
 * specific code.
 */

const MEDIA_READ_TIMEOUT_MS = 60_000;

/**
 * MIME types safe to echo to the browser as-is. Everything else (SVG, unknown,
 * absent) is served as an opaque download; the Admin server pairs every
 * response with `x-content-type-options: nosniff`.
 */
const PASSTHROUGH_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/webm',
  'application/x-tgsticker',
]);
const UNKNOWN_MIME = 'application/octet-stream';

/** `prepareMediaImage` normalizes to JPEG or PNG only; anything else is refused, not previewed. */
const PREVIEW_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png']);

/** Kinds `prepareMediaImage` can turn into one still image; documents have no preview. */
const PREVIEWABLE_KINDS: ReadonlySet<string> = new Set(['photo', 'sticker']);

/**
 * Snapshots carry many fields and the shape evolves; only the media ID list is
 * load-bearing here. TypeBox allows unknown sibling fields, but each media
 * entry must carry a decimal ID string, exactly as `snapshotInvocation` writes
 * it. A snapshot that fails this check rejects the read (409) instead of
 * silently widening access.
 */
const SnapshotMediaEntrySchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 20, pattern: '^[0-9]+$' }) },
  { additionalProperties: true },
);
const SnapshotMediaSchema = Type.Object(
  { media: Type.Array(SnapshotMediaEntrySchema) },
  { additionalProperties: true },
);
const snapshotMediaValidator = Compile(SnapshotMediaSchema);

export type InvocationMediaVariant = 'original' | 'preview';

export interface InvocationMediaItem {
  readonly id: string;
  readonly message_id: string;
  readonly revision_id: string;
  readonly kind: string;
  readonly mime_type: string | null;
  readonly file_size: number | null;
  readonly variants: readonly InvocationMediaVariant[];
}

export interface InvocationMediaList {
  readonly invocation_id: string;
  readonly items: readonly InvocationMediaItem[];
}

export interface InvocationMediaBytes {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly variant: InvocationMediaVariant;
}

export interface InvocationMediaReaderDeps {
  readonly orm: Orm;
  readonly downloader: MediaDownloader;
  /** Process shutdown; an in-flight read aborts and reports `media_aborted`. */
  readonly shutdownSignal: AbortSignal;
}

export type InvocationMediaReader = (
  invocationId: bigint,
  mediaId: bigint,
  variant: InvocationMediaVariant,
  requestSignal: AbortSignal,
) => Promise<InvocationMediaBytes>;

interface InvocationRow {
  readonly conversation_id: bigint;
}

interface AuthorizedMediaRow {
  readonly sequence_no: bigint;
  readonly snapshot_json: string;
  readonly message_id: bigint;
  readonly media_id: bigint;
  readonly revision_id: bigint;
  readonly kind: string;
  readonly mime_type: string | null;
  readonly file_size: bigint | null;
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly telegram_json: string;
}

/**
 * The one authorization query: every join condition is an invariant the API
 * claims, so a row that cannot satisfy them is invisible rather than repaired.
 * `media` is reached only through the snapshotted revision of the snapshot row.
 */
const AUTHORIZED_MEDIA_SELECT = sql`
  SELECT im.sequence_no, im.snapshot_json,
         m.id AS message_id,
         md.id AS media_id, md.revision_id, md.kind, md.mime_type, md.file_size,
         md.file_id, md.file_unique_id, md.telegram_json
  FROM invocation_messages im
  JOIN message_revisions r ON r.id = im.revision_id AND r.message_id = im.message_id
  JOIN media md ON md.revision_id = im.revision_id
  JOIN messages m ON m.id = im.message_id
`;

function authorizedMediaRows(
  orm: Orm,
  invocationId: bigint,
  conversationId: bigint,
  mediaId?: bigint,
): AuthorizedMediaRow[] {
  const mediaCondition = mediaId === undefined ? sql`` : sql` AND md.id = ${mediaId}`;
  return orm.all<AuthorizedMediaRow>(sql`
    ${AUTHORIZED_MEDIA_SELECT}
    WHERE im.invocation_id = ${invocationId}
      AND m.conversation_id = ${conversationId}${mediaCondition}
    ORDER BY im.sequence_no, md.id
  `);
}

function loadInvocation(orm: Orm, invocationId: bigint): InvocationRow {
  const invocation = orm
    .all<InvocationRow>(sql`SELECT conversation_id FROM invocations WHERE id = ${invocationId}`)
    .at(0);
  if (invocation === undefined) {
    throw new AdminQueryError('not_found', 'Invocation does not exist', 404);
  }
  return invocation;
}

/** The media IDs the frozen snapshot explicitly authorized, or a 409 conflict. */
function snapshotMediaIds(snapshotJson: string, invocationId: bigint, sequenceNo: bigint): ReadonlySet<string> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(snapshotJson);
  } catch {
    throw snapshotError(invocationId, sequenceNo);
  }
  if (!snapshotMediaValidator.Check(snapshot)) {
    throw snapshotError(invocationId, sequenceNo);
  }
  return new Set(snapshot.media.map((entry) => entry.id));
}

function snapshotError(invocationId: bigint, sequenceNo: bigint): AdminQueryError {
  return new AdminQueryError(
    'snapshot_invalid',
    `Invocation ${invocationId} snapshot ${sequenceNo} does not list valid media IDs`,
    409,
  );
}

/** `number` only when the stored size round-trips exactly; otherwise the API reports null. */
function safeFileSize(value: bigint | null): number | null {
  if (value === null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function variantsFor(kind: string): InvocationMediaVariant[] {
  return PREVIEWABLE_KINDS.has(kind) ? ['original', 'preview'] : ['original'];
}

function originalMime(mimeType: string | null): string {
  return mimeType !== null && PASSTHROUGH_MIME_TYPES.has(mimeType) ? mimeType : UNKNOWN_MIME;
}

/**
 * Lists the media the Invocation's frozen snapshots authorize, in snapshot
 * order. Items expose metadata only: no file ID, no Telegram JSON, no Telegram
 * message IDs, no path.
 */
export function listInvocationMedia(orm: Orm, invocationId: bigint): InvocationMediaList {
  const { conversation_id } = loadInvocation(orm, invocationId);
  const items = new Map<string, InvocationMediaItem>();
  const idsBySequence = new Map<bigint, ReadonlySet<string>>();
  for (const row of authorizedMediaRows(orm, invocationId, conversation_id)) {
    let snapshotIds = idsBySequence.get(row.sequence_no);
    if (snapshotIds === undefined) {
      snapshotIds = snapshotMediaIds(row.snapshot_json, invocationId, row.sequence_no);
      idsBySequence.set(row.sequence_no, snapshotIds);
    }
    const id = row.media_id.toString();
    if (!snapshotIds.has(id) || items.has(id)) {
      continue;
    }
    items.set(id, {
      id,
      message_id: row.message_id.toString(),
      revision_id: row.revision_id.toString(),
      kind: row.kind,
      mime_type: row.mime_type,
      file_size: safeFileSize(row.file_size),
      variants: variantsFor(row.kind),
    });
  }
  return { invocation_id: invocationId.toString(), items: [...items.values()] };
}

function authorizeMedia(orm: Orm, invocationId: bigint, mediaId: bigint): AuthorizedMediaRow {
  const { conversation_id } = loadInvocation(orm, invocationId);
  for (const row of authorizedMediaRows(orm, invocationId, conversation_id, mediaId)) {
    if (snapshotMediaIds(row.snapshot_json, invocationId, row.sequence_no).has(row.media_id.toString())) {
      return row;
    }
  }
  // Absent, cross-conversation and snapshot-omitted rows are indistinguishable
  // to the caller on purpose: none of them may be probed for existence.
  throw new AdminQueryError('not_found', 'Invocation media does not exist', 404);
}

function toMediaRow(row: AuthorizedMediaRow): MediaRow {
  return {
    id: row.media_id,
    kind: row.kind,
    fileId: row.file_id,
    fileUniqueId: row.file_unique_id,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    telegramJson: row.telegram_json,
  };
}

async function readBoundedFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
  // The stored file size is metadata and the download is capped on its own, so
  // the size is re-checked on the actual file before and after reading it. The
  // signal is observed on both sides of the read, so a cancellation that lands
  // in this window still fails the read instead of returning its bytes.
  signal.throwIfAborted();
  const info = await stat(path);
  signal.throwIfAborted();
  if (info.size > MAX_DOWNLOAD_BYTES) {
    throw tooLargeError();
  }
  const bytes = new Uint8Array(await readFile(path, { signal }));
  signal.throwIfAborted();
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw tooLargeError();
  }
  return bytes;
}

function tooLargeError(): AdminQueryError {
  return new AdminQueryError('media_too_large', 'Invocation media exceeds 20 MiB', 413);
}

function abortedError(): AdminQueryError {
  return new AdminQueryError('media_aborted', 'Invocation media read was aborted', 499);
}

/**
 * A persistent cleanup failure is reported as one generic error: the raw fs
 * error embeds the private temp path, so it must never reach the Admin API,
 * and a directory that could not be removed is not reported as success.
 */
function cleanupFailedError(): AdminQueryError {
  return new AdminQueryError('media_cleanup_failed', 'Invocation media temporary files could not be removed', 500);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/**
 * Upstream failures never leak their message: a Telegram URL or a temp file
 * path in an admin error would be a disclosure. Only the control-flow outcomes
 * keep a specific code.
 */
function mapMediaReadError(
  error: unknown,
  shutdownSignal: AbortSignal,
  requestSignal: AbortSignal,
  timedOut: boolean,
): AdminQueryError {
  if (error instanceof AdminQueryError) {
    return error;
  }
  // The downloader classifies oversize payloads typed; a stored size that was
  // NULL or understated must still end as 413, not as a generic 502.
  if (error instanceof MediaTooLargeError) {
    return tooLargeError();
  }
  if (shutdownSignal.aborted || requestSignal.aborted) {
    return abortedError();
  }
  if (timedOut) {
    return new AdminQueryError('media_timeout', 'Invocation media read timed out', 504);
  }
  if (isAbortError(error)) {
    return abortedError();
  }
  return new AdminQueryError('media_download_failed', 'Invocation media download failed', 502);
}

/**
 * Resolves media bytes for one Admin read. Exactly one download may run per
 * reader at a time: a second concurrent read is refused with 429 `media_busy`
 * instead of queueing, while the metadata list path never takes this slot.
 */
export function createInvocationMediaReader(deps: InvocationMediaReaderDeps): InvocationMediaReader {
  let busy = false;
  return async (invocationId, mediaId, variant, requestSignal) => {
    if (variant !== 'original' && variant !== 'preview') {
      throw new AdminQueryError('invalid_variant', 'variant must be original or preview');
    }
    if (busy) {
      throw new AdminQueryError('media_busy', 'Another invocation media read is already running', 429);
    }
    busy = true;
    try {
      // Authorization and the cheap size check run before any download starts.
      const media = authorizeMedia(deps.orm, invocationId, mediaId);
      if (variant === 'preview' && !PREVIEWABLE_KINDS.has(media.kind)) {
        throw new AdminQueryError('invalid_variant', 'preview is only available for photo and sticker media');
      }
      if (media.file_size !== null && media.file_size > BigInt(MAX_DOWNLOAD_BYTES)) {
        throw tooLargeError();
      }
      if (deps.shutdownSignal.aborted || requestSignal.aborted) {
        throw abortedError();
      }
      let timedOut = false;
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        timeout.abort();
      }, MEDIA_READ_TIMEOUT_MS);
      const signal = AbortSignal.any([deps.shutdownSignal, requestSignal, timeout.signal]);
      let directory: string | undefined;
      // The read outcome is held instead of returned so cleanup runs on every
      // exit path and can still reject a successful read: bytes are not handed
      // back while the per-request directory is still on disk.
      let outcome:
        | { readonly ok: true; readonly bytes: InvocationMediaBytes }
        | { readonly ok: false; readonly error: AdminQueryError };
      try {
        directory = await mkdtemp(join(tmpdir(), 'plasticwan-invocation-media-'));
        if (process.platform !== 'win32') {
          await chmod(directory, 0o700);
        }
        if (variant === 'original') {
          const destination = join(directory, 'original');
          await deps.downloader.download(media.file_id, destination, signal);
          signal.throwIfAborted();
          outcome = {
            ok: true,
            bytes: { bytes: await readBoundedFile(destination, signal), mime: originalMime(media.mime_type), variant },
          };
        } else {
          const normalized = await prepareMediaImage(
            toMediaRow(media),
            join(directory, 'input'),
            directory,
            deps.downloader,
            signal,
          );
          // sharp cannot be interrupted, so the checkpoint after it is what keeps
          // a timed-out or cancelled request from returning a preview.
          signal.throwIfAborted();
          if (!PREVIEW_MIME_TYPES.has(normalized.mimeType)) {
            throw new Error('Preview normalization produced an unsupported MIME type');
          }
          outcome = {
            ok: true,
            bytes: { bytes: await readBoundedFile(normalized.path, signal), mime: normalized.mimeType, variant },
          };
        }
      } catch (error) {
        outcome = { ok: false, error: mapMediaReadError(error, deps.shutdownSignal, requestSignal, timedOut) };
      } finally {
        clearTimeout(timer);
      }
      if (directory !== undefined) {
        // A failed download already unlinked its own partial file; the whole
        // per-request directory goes away on every exit path regardless.
        // Windows can hold a transient lock on the freshly written files, so
        // the bounded `rm` retry (EBUSY/EPERM/ENOTEMPTY) absorbs that instead
        // of leaking a raw fs error or reporting a stuck directory as clean.
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          throw cleanupFailedError();
        }
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.bytes;
    } finally {
      busy = false;
    }
  };
}
