import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binaryResponse,
  errorDocument,
  jsonResponse,
  onlyRequest,
  requestPath,
  requestQuery,
  runCli,
  startServer,
} from './cli-harness.ts';

const API_KEY = 'test-api-key-media';
const ENV = (baseUrl: string) => ({ PLASTICWAN_ENDPOINT: baseUrl, PLASTICWAN_API_KEY: API_KEY });
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PDF_BYTES = Buffer.from('%PDF-1.4 test document');

interface ItemOverrides {
  readonly kind?: string;
  readonly mime_type?: string | null;
  readonly file_size?: number | null;
  readonly variants?: readonly string[];
  readonly [key: string]: unknown;
}

function mediaItem(id: string, overrides: ItemOverrides = {}) {
  return {
    id,
    message_id: `msg-${id}`,
    revision_id: `rev-${id}`,
    kind: 'photo',
    mime_type: 'image/jpeg',
    file_size: null,
    variants: ['original', 'preview'],
    ...overrides,
  };
}

interface ContentEntry {
  readonly body: Buffer | string;
  readonly contentType?: string;
  readonly variant?: string | null;
}

/** Routes the media list plus each `/media/<id>/content` download. */
function mediaServer(invocationId: string, items: readonly unknown[], entries: ReadonlyMap<string, ContentEntry>) {
  const contentPattern = new RegExp(`^/api/invocations/${invocationId}/media/(\\d+)/content$`);
  return startServer((request, response) => {
    const path = requestPath(request);
    if (path === `/api/invocations/${invocationId}/media`) {
      jsonResponse(response, 200, { invocation_id: invocationId, items });
      return;
    }
    const match = contentPattern.exec(path);
    const entry = match?.[1] !== undefined ? entries.get(match[1]) : undefined;
    if (entry === undefined) {
      // Echo the key like a sloppy proxy would, to prove manifest redaction.
      jsonResponse(response, 404, { error: 'media_missing', message: `no such media (key ${API_KEY})` });
      return;
    }
    const headers: Record<string, string> = {};
    if (entry.contentType !== undefined) {
      headers['content-type'] = entry.contentType;
    }
    if (entry.variant !== null) {
      headers['x-plasticwan-media-variant'] = entry.variant ?? requestQuery(request).variant ?? 'original';
    }
    binaryResponse(response, 200, entry.body, headers);
  });
}

interface MediaManifest {
  readonly invocation_id: string;
  readonly variant: string;
  readonly directory: string;
  readonly items: readonly {
    readonly id: string;
    readonly status: string;
    readonly path: string | null;
    readonly mime_type: string | null;
    readonly bytes: number | null;
    readonly sha256: string | null;
    readonly error: { readonly code: string; readonly message: string } | null;
  }[];
}

async function cleanup(manifest: MediaManifest | undefined): Promise<void> {
  if (manifest !== undefined) {
    await rm(manifest.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('plasticwan-utils invocation media', () => {
  it('downloads every item sequentially into a fresh directory with a hashed manifest', async () => {
    const items = [
      mediaItem('5'),
      mediaItem('6', { kind: 'document', mime_type: 'application/pdf', variants: ['original'] }),
    ];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([
        ['5', { body: JPEG_BYTES, contentType: 'image/jpeg' }],
        ['6', { body: PDF_BYTES, contentType: 'application/pdf' }],
      ]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42'], { env: ENV(server.baseUrl) });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.invocation_id).toBe('42');
      expect(manifest.variant).toBe('original');
      expect(isAbsolute(manifest.directory)).toBe(true);
      expect(result.stdout).toContain('\n  ');

      expect(server.requests).toHaveLength(3);
      expect(requestPath(onlyRequest(server, 0))).toBe('/api/invocations/42/media');
      expect(requestPath(onlyRequest(server, 1))).toBe('/api/invocations/42/media/5/content');
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ variant: 'original' });
      expect(requestPath(onlyRequest(server, 2))).toBe('/api/invocations/42/media/6/content');

      const [photo, pdf] = manifest.items;
      expect(photo?.status).toBe('downloaded');
      expect(photo?.path).toBe(join(manifest.directory, '5.jpg'));
      expect(photo?.mime_type).toBe('image/jpeg');
      expect(photo?.bytes).toBe(JPEG_BYTES.byteLength);
      expect(photo?.sha256).toBe(createHash('sha256').update(JPEG_BYTES).digest('hex'));
      expect(photo?.error).toBeNull();
      expect(pdf?.path).toBe(join(manifest.directory, '6.pdf'));
      expect(pdf?.sha256).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));

      expect(await readFile(join(manifest.directory, '5.jpg'))).toEqual(JPEG_BYTES);
      expect(await readFile(join(manifest.directory, '6.pdf'))).toEqual(PDF_BYTES);
      const manifestFile = JSON.parse(await readFile(join(manifest.directory, 'manifest.json'), 'utf8'));
      expect(manifestFile).toEqual(manifest);
      expect((await readdir(manifest.directory)).sort()).toEqual(['5.jpg', '6.pdf', 'manifest.json']);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('canonicalizes a leading-zero invocation id before comparing the echoed id', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/media')) {
        // The Admin API always echoes the canonical decimal invocation id.
        jsonResponse(response, 200, { invocation_id: '42', items: [mediaItem('5')] });
        return;
      }
      binaryResponse(response, 200, JPEG_BYTES, {
        'content-type': 'image/jpeg',
        'x-plasticwan-media-variant': 'original',
      });
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '042', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.invocation_id).toBe('42');
      expect(manifest.items[0]?.status).toBe('downloaded');
      expect(server.requests.map((request) => requestPath(request))).toEqual([
        '/api/invocations/42/media',
        '/api/invocations/42/media/5/content',
      ]);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('keeps media bytes intact even when they contain the test key, while the manifest stays redacted', async () => {
    const bytes = Buffer.from(`binary fixture ${API_KEY}`, 'utf8');
    const server = await mediaServer(
      '42',
      [mediaItem('5')],
      new Map<string, ContentEntry>([['5', { body: bytes, contentType: 'application/octet-stream' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(API_KEY);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      const item = manifest.items[0];
      expect(item?.bytes).toBe(bytes.byteLength);
      expect(item?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(await readFile(join(manifest.directory, '5.bin'))).toEqual(bytes);
      const saved = await readFile(join(manifest.directory, 'manifest.json'), 'utf8');
      expect(saved).not.toContain(API_KEY);
      expect(JSON.parse(saved)).toEqual(manifest);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('uses the requested variant and records an item that cannot offer it', async () => {
    const items = [mediaItem('5'), mediaItem('6', { variants: ['original'] })];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([['5', { body: JPEG_BYTES, contentType: 'image/jpeg', variant: 'preview' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--variant', 'preview', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ variant: 'preview' });
      expect(errorDocument(result).error).toBe('media_download_failed');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.variant).toBe('preview');
      expect(manifest.items[0]?.status).toBe('downloaded');
      expect(manifest.items[1]?.status).toBe('failed');
      expect(manifest.items[1]?.error?.code).toBe('variant_not_available');
      expect(await readFile(join(manifest.directory, '5.jpg'))).toEqual(JPEG_BYTES);
      expect(result.stderr).not.toContain(API_KEY);
      expect(JSON.stringify(manifest)).not.toContain(API_KEY);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('derives file names from the validated id and MIME type, ignoring remote file names', async () => {
    const items = [
      mediaItem('9', {
        mime_type: '../../evil.jpg',
        filename: '../../evil.sh',
        path: 'C:\\Windows\\evil.exe',
        url: 'https://evil.example/evil',
        telegram_message_id: 'tg-must-not-leak',
      }),
    ];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([['9', { body: JPEG_BYTES, contentType: 'application/octet-stream' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.path).toBe(join(manifest.directory, '9.bin'));
      expect((await readdir(manifest.directory)).sort()).toEqual(['9.bin', 'manifest.json']);
      expect(JSON.stringify(manifest)).not.toContain('evil');
      // Fields the server may add are neither required nor copied into the manifest.
      expect(manifest.items[0]).not.toHaveProperty('telegram_message_id');
      expect(result.stdout).not.toContain('tg-must-not-leak');
      expect(await readFile(join(manifest.directory, 'manifest.json'), 'utf8')).not.toContain('tg-must-not-leak');
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('refuses a media id that could escape the fixed content path', async () => {
    const server = await mediaServer('42', [mediaItem('../evil')], new Map());
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('invalid_response');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('fails fast on the item-count and declared-total limits before downloading', async () => {
    const tooMany = Array.from({ length: 33 }, (_value, index) => mediaItem(String(index + 1), { file_size: 1 }));
    const manyServer = await mediaServer('42', tooMany, new Map());
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(manyServer.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_too_many_items');
      expect(manyServer.requests).toHaveLength(1);
    } finally {
      await manyServer.close();
    }

    const large = Array.from({ length: 6 }, (_value, index) =>
      mediaItem(String(index + 1), { file_size: 20 * 1024 * 1024 }),
    );
    const largeServer = await mediaServer('42', large, new Map());
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(largeServer.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_total_too_large');
      expect(largeServer.requests).toHaveLength(1);
      expect(result.stdout).toBe('');
    } finally {
      await largeServer.close();
    }

    const oversized = [mediaItem('7', { file_size: 21 * 1024 * 1024 })];
    const oversizedServer = await mediaServer('42', oversized, new Map());
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(oversizedServer.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      expect(oversizedServer.requests).toHaveLength(1);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.error?.code).toBe('media_file_too_large');
      await expect(stat(manifest.directory)).rejects.toThrow();
    } finally {
      await cleanup(manifest);
      await oversizedServer.close();
    }
  }, 30_000);

  it('refuses an oversized stream, leaves no half file and removes the directory', async () => {
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 4096, 0x61);
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/invocations/42/media') {
        jsonResponse(response, 200, { invocation_id: '42', items: [mediaItem('5', { file_size: null })] });
        return;
      }
      // Chunked (no content-length) so only the streaming cap can stop it.
      response.writeHead(200, { 'content-type': 'image/jpeg', 'x-plasticwan-media-variant': 'original' });
      response.end(oversized);
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(errorDocument(result).error).toBe('media_download_failed');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.status).toBe('failed');
      expect(manifest.items[0]?.error?.code).toBe('media_file_too_large');
      expect(manifest.items[0]?.path).toBeNull();
      await expect(stat(manifest.directory)).rejects.toThrow();
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 60_000);

  it('aborts the last stream when the cumulative 100MiB budget runs out and keeps the partial manifest', async () => {
    // Every item declares no size and the server answers chunked (no
    // content-length), so only the streaming budget can stop the sixth item:
    // 20+20+20+20+19 MiB succeed and the last 1 MiB of the total is what the
    // final 4 MiB stream runs into.
    const body = Buffer.alloc(20 * 1024 * 1024, 0x62);
    const megabytes = [20, 20, 20, 20, 19, 4];
    const items = megabytes.map((_size, index) => mediaItem(String(index + 1), { file_size: null }));
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/invocations/42/media') {
        jsonResponse(response, 200, { invocation_id: '42', items });
        return;
      }
      const match = /\/(\d+)\/content$/.exec(path);
      const size = match?.[1] === undefined ? undefined : megabytes[Number(match[1]) - 1];
      if (size === undefined) {
        jsonResponse(response, 404, { error: 'media_missing' });
        return;
      }
      response.writeHead(200, { 'content-type': 'image/jpeg', 'x-plasticwan-media-variant': 'original' });
      response.end(body.subarray(0, size * 1024 * 1024));
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      // The list plus all six content requests: the item that cannot fit is
      // still attempted, then cancelled while its body streams.
      expect(server.requests).toHaveLength(7);
      expect(server.requests.map((request) => requestPath(request))).toEqual([
        '/api/invocations/42/media',
        ...megabytes.map((_size, index) => `/api/invocations/42/media/${index + 1}/content`),
      ]);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items.map((item) => item.status)).toEqual([
        'downloaded',
        'downloaded',
        'downloaded',
        'downloaded',
        'downloaded',
        'failed',
      ]);
      const downloadedBytes = manifest.items.reduce((total, item) => total + (item.bytes ?? 0), 0);
      expect(downloadedBytes).toBe(99 * 1024 * 1024);
      const last = manifest.items[5];
      expect(last?.error?.code).toBe('media_total_too_large');
      expect(last?.error?.message).toContain(String(1024 * 1024));
      expect(last?.path).toBeNull();
      expect(last?.bytes).toBeNull();
      expect(last?.sha256).toBeNull();
      // Partial successes keep their files and the manifest; the aborted item
      // left neither a body file nor a stray partial file.
      expect((await readdir(manifest.directory)).sort()).toEqual([
        '1.jpg',
        '2.jpg',
        '3.jpg',
        '4.jpg',
        '5.jpg',
        'manifest.json',
      ]);
      expect(JSON.parse(await readFile(join(manifest.directory, 'manifest.json'), 'utf8'))).toEqual(manifest);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 120_000);

  it('turns a redirect, a stall and an unconfirmed variant into item failures', async () => {
    const items = [mediaItem('5'), mediaItem('6'), mediaItem('7')];
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/invocations/42/media') {
        jsonResponse(response, 200, { invocation_id: '42', items });
        return;
      }
      if (path.endsWith('/media/5/content')) {
        response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
        response.end();
        return;
      }
      if (path.endsWith('/media/6/content')) {
        response.writeHead(200, { 'content-type': 'image/jpeg', 'x-plasticwan-media-variant': 'original' });
        response.write(JPEG_BYTES);
        // Never end the body: only the client-side timeout can stop the read.
        return;
      }
      binaryResponse(response, 200, JPEG_BYTES, {
        'content-type': 'image/jpeg',
        'x-plasticwan-media-variant': 'preview',
      });
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--timeout-ms', '400', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items.map((item) => [item.id, item.error?.code])).toEqual([
        ['5', 'redirect_not_allowed'],
        ['6', 'timeout'],
        ['7', 'invalid_response'],
      ]);
      await expect(stat(manifest.directory)).rejects.toThrow();
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 60_000);

  it('keeps successful files on a partial failure and redacts the manifest on stdout and disk', async () => {
    const items = [mediaItem('5'), mediaItem('6')];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([['5', { body: JPEG_BYTES, contentType: 'image/jpeg' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      expect(result.stderr).not.toContain(API_KEY);
      // `--json` stdout is compact, so the key can only be echoed by the item error.
      expect(result.stdout).not.toContain(API_KEY);
      expect(result.stdout).toContain('[redacted]');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.status).toBe('downloaded');
      expect(manifest.items[1]?.status).toBe('failed');
      expect(manifest.items[1]?.error?.code).toBe('media_missing');
      expect(await readFile(join(manifest.directory, '5.jpg'))).toEqual(JPEG_BYTES);
      const manifestText = await readFile(join(manifest.directory, 'manifest.json'), 'utf8');
      expect(manifestText).not.toContain(API_KEY);
      expect(manifestText).toContain('[redacted]');
      expect(JSON.parse(manifestText)).toEqual(manifest);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);
});
