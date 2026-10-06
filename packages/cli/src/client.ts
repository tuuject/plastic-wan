import { Buffer } from 'node:buffer';
import { CliError, usageError } from './errors.ts';

/**
 * Upper bound for any JSON response body. The API pages and invocation details
 * are far smaller; an oversized body (a proxy page, a runaway payload) is
 * refused instead of being buffered without limit.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Validates an endpoint. Plaintext http is only accepted on loopback: the API
 * key travels in a header and must not cross the network unencrypted. URL
 * credentials are rejected so the key can never be smuggled through a URL.
 */
export function parseEndpoint(raw: string): URL {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw usageError('invalid_endpoint', 'endpoint must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError('invalid_endpoint', 'endpoint must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw usageError('invalid_endpoint', 'endpoint must not contain URL credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw usageError('invalid_endpoint', 'endpoint must not contain a query string or fragment');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw usageError('insecure_endpoint', 'plaintext http is only allowed for loopback endpoints; use https');
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export interface AdminClientOptions {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly defaultTimeoutMs: number;
}

/** A successfully downloaded media body plus the headers the CLI validates. */
export interface MediaContent {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  readonly variant: string | null;
}

/**
 * Minimal JSON client for the Admin API. Requests never follow redirects and
 * are never retried; the timeout aborts the in-flight request and the response
 * body read that follows it.
 */
export class AdminClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #defaultTimeoutMs: number;

  constructor(options: AdminClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async get(path: string, query?: URLSearchParams): Promise<unknown> {
    return await this.#request('GET', path, query, undefined);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return await this.#request('POST', path, undefined, body);
  }

  /**
   * Downloads a media body. The same redirect/timeout rules as JSON requests
   * apply; the body is bounded by `maxBytes` so an oversized or stalled stream
   * fails fast instead of filling memory or disk.
   */
  async getMedia(path: string, query: URLSearchParams, maxBytes: number): Promise<MediaContent> {
    const url = this.#resolve(path, query);
    const init: RequestInit = {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        accept: 'application/octet-stream',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.#defaultTimeoutMs),
    };
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw await responseError(response);
      }
      const body = await readBodyBytes(response, maxBytes);
      if (body.truncated) {
        throw mediaTooLarge(maxBytes);
      }
      return {
        bytes: body.bytes,
        contentType: normalizeContentType(response.headers.get('content-type')),
        variant: response.headers.get('x-plasticwan-media-variant'),
      };
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }

  #resolve(path: string, query?: URLSearchParams): URL {
    const url = new URL(path.replace(/^\/+/, ''), this.#baseUrl);
    if (query !== undefined) {
      for (const [key, value] of query) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    query: URLSearchParams | undefined,
    body: unknown,
  ): Promise<unknown> {
    const url = this.#resolve(path, query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(this.#defaultTimeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(url, init);
      // The body read belongs to the same try: a server that sends headers and
      // then stalls must hit the timeout path, not `internal_error`.
      return await readJsonResponse(response);
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }
}

function mediaTooLarge(maxBytes: number): CliError {
  return new CliError('media_file_too_large', `media content exceeded ${maxBytes} bytes`);
}

function translateFetchError(error: unknown, timeoutMs: number): CliError {
  if (error instanceof CliError) {
    // A failed body read (invalid JSON, oversized body, ...) already carries a
    // structured client error; it must keep its own code.
    return error;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new CliError('timeout', `request timed out after ${timeoutMs}ms; it was not retried`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text = `${error instanceof Error ? error.message : String(error)} ${cause}`;
  if (/redirect/i.test(text)) {
    return new CliError('redirect_not_allowed', 'the server attempted a redirect; redirects are not followed');
  }
  return new CliError('network_error', 'the request failed before a response arrived; it was not retried');
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const bodyText = await readBodyText(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    throw responseErrorFromBody(response, bodyText);
  }
  if (bodyText.truncated) {
    throw new CliError('response_too_large', `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (bodyText.text.length === 0) {
    throw new CliError('invalid_response', 'server returned an empty response');
  }
  const parsed = tryParseJson(bodyText.text);
  if (parsed === undefined) {
    throw new CliError('invalid_response', 'server response was not valid JSON');
  }
  return parsed;
}

async function responseError(response: Response): Promise<CliError> {
  return responseErrorFromBody(response, await readBodyText(response, MAX_RESPONSE_BYTES));
}

/** A JSON error body survives as the error code/message; anything else is http_error. */
function responseErrorFromBody(response: Response, bodyText: BodyText): CliError {
  if (bodyText.truncated) {
    return new CliError('http_error', `server responded with HTTP ${response.status} and an oversized body`);
  }
  const parsed = tryParseJson(bodyText.text);
  if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error.length > 0) {
    const message = typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : parsed.error;
    return new CliError(parsed.error, message);
  }
  return new CliError('http_error', `server responded with HTTP ${response.status}`);
}

function normalizeContentType(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const type = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return type.length === 0 ? null : type;
}

interface BodyText {
  readonly text: string;
  readonly truncated: boolean;
}

interface BodyBytes {
  readonly bytes: Buffer;
  readonly truncated: boolean;
}

async function readBodyText(response: Response, maxBytes: number): Promise<BodyText> {
  const body = await readBodyBytes(response, maxBytes);
  return { text: body.truncated ? '' : body.bytes.toString('utf8'), truncated: body.truncated };
}

async function readBodyBytes(response: Response, maxBytes: number): Promise<BodyBytes> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: Buffer.alloc(0), truncated: true };
  }
  const stream = response.body;
  if (stream === null) {
    return { bytes: Buffer.alloc(0), truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { bytes: Buffer.alloc(0), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
