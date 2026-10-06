import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url));

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface TestServer {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

export async function startServer(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    // A client that cancels an oversized download destroys the socket; keep the
    // resulting response/socket errors from crashing the test process.
    response.on('error', () => undefined);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let sharedHome: string | undefined;

async function cliHome(): Promise<string> {
  sharedHome ??= await mkdtemp(join(tmpdir(), 'plasticwan-cli-home-'));
  return sharedHome;
}

export interface RunCliOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly keepStdinOpen?: boolean;
  /** Overrides the isolated HOME/USERPROFILE used to keep the credential file local. */
  readonly home?: string;
}

export async function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.PLASTICWAN_ENDPOINT;
  delete env.PLASTICWAN_API_KEY;
  // File fallback must never consult the operator's real saved credentials.
  env.HOME = options.home ?? (await cliHome());
  env.USERPROFILE = env.HOME;
  Object.assign(env, options.env ?? {});
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.keepStdinOpen === true ? 5_000 : 0,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    if (options.keepStdinOpen !== true) {
      child.stdin.end();
    }
  });
}

export function onlyRequest(server: TestServer, index = 0): CapturedRequest {
  const request = server.requests.at(index);
  if (request === undefined) {
    throw new Error(`the test server received no request at index ${index}`);
  }
  return request;
}

export function errorDocument(result: CliResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.stderr);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`stderr was not a JSON object: ${result.stderr}`);
  }
  return parsed as Record<string, unknown>;
}

export function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function binaryResponse(
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
): void {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': String(buffer.byteLength),
    ...headers,
  });
  response.end(buffer);
}

export function requestPath(request: CapturedRequest): string {
  return new URL(request.url, 'http://127.0.0.1').pathname;
}

export function requestQuery(request: CapturedRequest): Record<string, string> {
  return Object.fromEntries(new URL(request.url, 'http://127.0.0.1').searchParams);
}
