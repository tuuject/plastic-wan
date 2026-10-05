import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES, parseEndpoint } from '../packages/cli/src/client.ts';
import { MAX_SYSTEM_PROMPT_CHARS } from '../packages/cli/src/commands.ts';
import { CliError } from '../packages/cli/src/errors.ts';

const API_KEY = 'test-api-key-a1b2c3';
const BIN = fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url));
const ITEM = {
  id: '7',
  state: 'completed',
  created_at: '2026-10-05T01:02:03.000Z',
  chat: { telegram_chat_id: '-1001234567890', title: 'Test Group', username: null, message_thread_id: 0 },
  total_tokens: 120,
  total_cost: 0.0012,
};

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

interface TestServer {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

async function startServer(handler: (request: CapturedRequest, response: ServerResponse) => void): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
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

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  options: {
    readonly env?: Record<string, string>;
    readonly stdin?: string;
    readonly keepStdinOpen?: boolean;
  } = {},
): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.PLASTICWAN_ENDPOINT;
  delete env.PLASTICWAN_API_KEY;
  Object.assign(env, options.env ?? {});
  return new Promise((resolve, reject) => {
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

function onlyRequest(server: TestServer): CapturedRequest {
  const request = server.requests.at(0);
  if (request === undefined) {
    throw new Error('the test server received no request');
  }
  return request;
}

function errorDocument(result: CliResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.stderr);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`stderr was not a JSON object: ${result.stderr}`);
  }
  return parsed as Record<string, unknown>;
}

function endpointErrorCode(raw: string): string | undefined {
  try {
    parseEndpoint(raw);
    return undefined;
  } catch (error) {
    return error instanceof CliError ? error.code : 'not_a_cli_error';
  }
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

let workDir: string;
let promptFile: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'plasticwan-cli-'));
  promptFile = join(workDir, 'prompt.txt');
  await writeFile(promptFile, 'from the prompt file');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('plasticwan-debug invocation CLI', () => {
  it('list sends filters and auth, and prints one stable JSON document', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [ITEM], next_cursor: '7' });
    });
    try {
      const result = await runCli(
        ['invocation', 'list', '--limit', '5', '--cursor', '9', '--state', 'completed', '--chat', '-100123', '--json'],
        { env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY } },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ items: [ITEM], next_cursor: '7' });
      expect(server.requests).toHaveLength(1);
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      const url = new URL(request.url, server.baseUrl);
      expect(url.pathname).toBe('/api/invocations');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: '5',
        cursor: '9',
        state: 'completed',
        chat: '-100123',
      });
      expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.headers.accept).toContain('application/json');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('list without filters sends no query string and keeps human output concise', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [ITEM], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const request = onlyRequest(server);
      expect(request.url).toBe('/api/invocations');
      expect(result.stdout).not.toContain('{');
      expect(result.stdout).toContain('7');
      expect(result.stdout).toContain('completed');
      expect(result.stdout).toContain('Test Group');
      expect(result.stdout).toContain('(-1001234567890)');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('--api-key overrides PLASTICWAN_API_KEY', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json', '--api-key', 'flag-key'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: 'env-key' },
      });
      expect(result.code).toBe(0);
      expect(onlyRequest(server).headers.authorization).toBe('Bearer flag-key');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('get returns the invocation detail document unchanged', async () => {
    const detail = { id: '42', state: 'failed', error_code: 'provider_error', turns_used: 3 };
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, detail);
    });
    try {
      const result = await runCli(['invocation', 'get', '42', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(detail);
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/invocations/42');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('replay sends an empty JSON object without --system-prompt', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const request = onlyRequest(server);
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/invocations/42/replay');
      expect(request.headers['content-type']).toContain('application/json');
      expect(JSON.parse(request.body)).toEqual({});
    } finally {
      await server.close();
    }
  }, 20_000);

  it('replay reads --system-prompt from a file and from stdin', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { status: 'started', error: null });
    });
    try {
      const env = { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY };
      const fromFile = await runCli(['invocation', 'replay', '42', '--system-prompt', promptFile, '--json'], { env });
      expect(fromFile.code).toBe(0);
      expect(JSON.parse(onlyRequest(server).body)).toEqual({ system_prompt: 'from the prompt file' });

      const fromStdin = await runCli(['invocation', 'replay', '42', '--system-prompt', '-', '--json'], {
        env,
        stdin: 'from stdin',
      });
      expect(fromStdin.code).toBe(0);
      expect(JSON.parse(server.requests[1]?.body ?? '')).toEqual({ system_prompt: 'from stdin' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it.each(['provider_unavailable', { code: 'model_error', message: 'upstream down' }])(
    'replay keeps a structured failure on stdout and emits JSON stderr: %j',
    async (error) => {
      const failure = { version: 1, source_invocation_id: '42', error };
      const server = await startServer((_request, response) => {
        jsonResponse(response, 200, failure);
      });
      try {
        const result = await runCli(['invocation', 'replay', '42', '--json'], {
          env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
        });
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual(failure);
        expect(errorDocument(result)).toEqual({
          error: 'replay_failed',
          message: `replay did not complete: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
        });
        expect(result.stderr).not.toContain(API_KEY);
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('server JSON errors become JSON on stderr with a non-zero exit', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 400, { error: 'invalid_state', message: 'state filter is invalid' });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result)).toEqual({ error: 'invalid_state', message: 'state filter is invalid' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('rejects a non-JSON success body', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>proxy error</html>');
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('does not follow redirects', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: `${server.baseUrl}/elsewhere` });
      response.end();
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('redirect_not_allowed');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it.each(['', 'unfinished prompt'])(
    'times out on stdin without EOF before sending HTTP: %j',
    async (stdin) => {
      const server = await startServer((_request, response) => {
        jsonResponse(response, 200, { error: null });
      });
      try {
        const result = await runCli(
          ['invocation', 'replay', '42', '--system-prompt', '-', '--timeout-ms', '250', '--json'],
          {
            env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
            stdin,
            keepStdinOpen: true,
          },
        );
        expect(server.requests).toHaveLength(0);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(errorDocument(result)).toEqual({
          error: 'timeout',
          message: 'stdin timed out after 250ms; no request was sent',
        });
        expect(result.stderr).not.toContain(API_KEY);
      } finally {
        await server.close();
      }
    },
    20_000,
  );

  it('aborts on timeout without retrying', async () => {
    const server = await startServer(() => {
      // Never respond: the client must abort the in-flight request itself.
    });
    try {
      const result = await runCli(['invocation', 'list', '--timeout-ms', '500', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('timeout');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('times out when a 200 response body stalls, without retrying', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"items": [');
      // Never end the body: only the client-side timeout can stop the read.
    });
    try {
      const result = await runCli(['invocation', 'list', '--timeout-ms', '500', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('timeout');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('refuses an oversized response body', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1024, 0x61));
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('response_too_large');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('never echoes the API key, even when a server reflects it', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 500, { error: 'internal_error', message: `request for ${API_KEY} failed` });
    });
    try {
      const result = await runCli(['invocation', 'list', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(API_KEY);
      expect(result.stderr).toContain('[redacted]');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts the API key echoed by successful bodies and keeps JSON valid', async () => {
    const echo = `key ${API_KEY}`;
    const server = await startServer((request, response) => {
      const path = request.url ?? '';
      if (path.endsWith('/replay')) {
        jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null, echo });
        return;
      }
      if (path.startsWith('/api/invocations/')) {
        jsonResponse(response, 200, { id: '42', state: 'failed', echo });
        return;
      }
      jsonResponse(response, 200, {
        items: [{ ...ITEM, chat: { ...ITEM.chat, title: `group ${API_KEY}` } }],
        next_cursor: echo,
      });
    });
    try {
      const env = { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY };
      const runs: readonly (readonly [readonly string[], string])[] = [
        [['invocation', 'list', '--json'], 'next_cursor'],
        [['invocation', 'get', '42', '--json'], 'echo'],
        [['invocation', 'replay', '42', '--json'], 'echo'],
      ];
      for (const [args, field] of runs) {
        const result = await runCli(args, { env });
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stderr, args.join(' ')).toBe('');
        expect(result.stdout, args.join(' ')).not.toContain(API_KEY);
        const document = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(document[field], args.join(' ')).toBe('key [redacted]');
      }
      const human = await runCli(['invocation', 'list'], { env });
      expect(human.code).toBe(0);
      expect(human.stdout).not.toContain(API_KEY);
      expect(human.stdout).toContain('group [redacted]');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('redacts a structured replay failure on stdout and stderr', async () => {
    const failure = {
      status: 'failed',
      invocation_id: '44',
      error: `provider_unavailable ${API_KEY}`,
      message: `upstream ${API_KEY} is down`,
    };
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, failure);
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain(API_KEY);
      expect(result.stderr).not.toContain(API_KEY);
      expect(result.stderr).toContain('replay did not complete');
      expect(result.stderr).toContain('[redacted]');
      expect(JSON.parse(result.stdout)).toEqual({
        ...failure,
        error: 'provider_unavailable [redacted]',
        message: 'upstream [redacted] is down',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts an API key echoed through a server error code', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 400, { error: `bad_key_${API_KEY}`, message: `key ${API_KEY} was rejected` });
    });
    try {
      const result = await runCli(['invocation', 'get', '42', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY },
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(API_KEY);
      expect(errorDocument(result)).toEqual({ error: 'bad_key_[redacted]', message: 'key [redacted] was rejected' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts a JSON-escaped key form without corrupting the JSON document', async () => {
    // This key ends in a backslash, so the raw form does not appear in JSON
    // output; only its escaped form does. Redacting it must not unbalance the
    // enclosing document.
    const escapedKey = 'esc\\';
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { id: '42', echo: `echo ${escapedKey}` });
    });
    try {
      const result = await runCli(['invocation', 'get', '42', '--json'], {
        env: { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: escapedKey },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(escapedKey);
      const document = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(document.echo).toBe('echo [redacted]');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('rejects unknown arguments and subcommands instead of ignoring them', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const env = { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY };
      const unknownOption = await runCli(['invocation', 'list', '--bogus', '--json'], { env });
      expect(unknownOption.code).toBe(2);
      expect(errorDocument(unknownOption).error).toBe('invalid_arguments');

      const unknownSubcommand = await runCli(['invocation', 'frobnicate', '--json'], { env });
      expect(unknownSubcommand.code).toBe(2);
      expect(errorDocument(unknownSubcommand).error).toBe('unknown_subcommand');

      const extraPositional = await runCli(['invocation', 'list', 'extra', '--json'], { env });
      expect(extraPositional.code).toBe(2);
      expect(errorDocument(extraPositional).error).toBe('unexpected_argument');

      const wrongOption = await runCli(['invocation', 'get', '4', '--limit', '5', '--json'], { env });
      expect(wrongOption.code).toBe(2);
      expect(errorDocument(wrongOption).error).toBe('unexpected_option');

      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('validates ids, limits and filters before any request', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const env = { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY };
      const cases: readonly (readonly [readonly string[], string])[] = [
        [['invocation', 'get', '12abc', '--json'], 'invalid_id'],
        [['invocation', 'get', '99999999999999999999', '--json'], 'invalid_id'],
        [['invocation', 'get', '9223372036854775808', '--json'], 'invalid_id'],
        [['invocation', 'list', '--limit', '0', '--json'], 'invalid_limit'],
        [['invocation', 'list', '--limit', '101', '--json'], 'invalid_limit'],
        [['invocation', 'list', '--limit', 'abc', '--json'], 'invalid_limit'],
        [['invocation', 'list', '--state', 'bad state', '--json'], 'invalid_state'],
      ];
      for (const [args, code] of cases) {
        const result = await runCli(args, { env });
        expect(result.code, args.join(' ')).toBe(2);
        expect(errorDocument(result).error, args.join(' ')).toBe(code);
      }
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('requires an endpoint and an API key, and refuses unsafe endpoints', async () => {
    const missingEndpoint = await runCli(['invocation', 'list', '--json']);
    expect(missingEndpoint.code).toBe(2);
    expect(errorDocument(missingEndpoint).error).toBe('missing_endpoint');

    const missingKey = await runCli(['invocation', 'list', '--json'], {
      env: { PLASTICWAN_ENDPOINT: 'http://127.0.0.1:8787' },
    });
    expect(missingKey.code).toBe(2);
    expect(errorDocument(missingKey).error).toBe('missing_api_key');

    const remotePlaintext = await runCli(['invocation', 'list', '--endpoint', 'http://10.255.255.1:9', '--json'], {
      env: { PLASTICWAN_API_KEY: API_KEY },
    });
    expect(remotePlaintext.code).toBe(2);
    expect(errorDocument(remotePlaintext).error).toBe('insecure_endpoint');

    const credentialUrl = await runCli(
      ['invocation', 'list', '--endpoint', 'http://user:pass@127.0.0.1:8787', '--json'],
      { env: { PLASTICWAN_API_KEY: API_KEY } },
    );
    expect(credentialUrl.code).toBe(2);
    expect(errorDocument(credentialUrl).error).toBe('invalid_endpoint');

    const nonHttp = await runCli(['invocation', 'list', '--endpoint', 'ftp://127.0.0.1:8787', '--json'], {
      env: { PLASTICWAN_API_KEY: API_KEY },
    });
    expect(nonHttp.code).toBe(2);
    expect(errorDocument(nonHttp).error).toBe('invalid_endpoint');
  }, 30_000);

  it('caps --system-prompt input and rejects empty prompts', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { status: 'started', error: null });
    });
    try {
      const env = { PLASTICWAN_ENDPOINT: server.baseUrl, PLASTICWAN_API_KEY: API_KEY };
      const tooLarge = await runCli(['invocation', 'replay', '5', '--system-prompt', '-', '--json'], {
        env,
        stdin: 'a'.repeat(MAX_SYSTEM_PROMPT_CHARS + 1),
      });
      expect(tooLarge.code).toBe(2);
      expect(errorDocument(tooLarge).error).toBe('system_prompt_too_large');

      const empty = await runCli(['invocation', 'replay', '5', '--system-prompt', '-', '--json'], {
        env,
        stdin: '   ',
      });
      expect(empty.code).toBe(2);
      expect(errorDocument(empty).error).toBe('system_prompt_empty');

      const missingFile = await runCli(
        ['invocation', 'replay', '5', '--system-prompt', join(workDir, 'absent.txt'), '--json'],
        { env },
      );
      expect(missingFile.code).toBe(2);
      expect(errorDocument(missingFile).error).toBe('system_prompt_read_failed');

      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('prints usage for --help without requiring an endpoint', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('invocation replay');
    expect(result.stderr).toBe('');
  }, 20_000);

  it('accepts https and loopback http endpoints and rejects unsafe forms', () => {
    expect(parseEndpoint('https://admin.example.com').href).toBe('https://admin.example.com/');
    expect(parseEndpoint('http://localhost:8787/base').href).toBe('http://localhost:8787/base/');
    expect(parseEndpoint('http://127.0.0.2:8787').hostname).toBe('127.0.0.2');
    expect(endpointErrorCode('http://10.0.0.5:8787')).toBe('insecure_endpoint');
    expect(endpointErrorCode('http://user:pass@127.0.0.1:8787')).toBe('invalid_endpoint');
    expect(endpointErrorCode('ftp://127.0.0.1:8787')).toBe('invalid_endpoint');
    expect(endpointErrorCode('http://127.0.0.1:8787/?a=1')).toBe('invalid_endpoint');
    expect(endpointErrorCode('not a url')).toBe('invalid_endpoint');
  });
});
