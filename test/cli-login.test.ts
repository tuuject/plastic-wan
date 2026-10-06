import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialsPath, writeCredentials } from '../packages/cli/src/credentials.ts';
import { runCli } from '../packages/cli/src/run.ts';

const KEY = 'synthetic-login-key-never-print';
const BIN = fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plasticwan-login-'));
  cleanup.push(async () => await rm(dir, { recursive: true, force: true }));
  return dir;
}

async function server(handler: (response: ServerResponse) => void) {
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> =
    [];
  const http = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    handler(response);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture failed to bind');
  }
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function cli(args: readonly string[], homeDir: string, env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    homeDir,
    env,
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  });
  return { code, stdout, stderr };
}

async function child(
  args: readonly string[],
  homeDir: string,
  input: string,
  keepOpen = false,
  overrides: Record<string, string> = {},
) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.PLASTICWAN_API_KEY;
  delete env.PLASTICWAN_ENDPOINT;
  Object.assign(env, overrides);
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [BIN, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    let stdout = '';
    let stderr = '';
    process.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
    });
    process.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    process.on('error', reject);
    process.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    process.stdin.on('error', () => {});
    process.stdin.write(input);
    if (!keepOpen) {
      process.stdin.end();
    }
  });
}

function terminal() {
  let stderr = '';
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (value: boolean) => {
      rawModes.push(value);
    },
  });
  const output = Object.assign(
    new Writable({
      write: (chunk, _encoding, callback) => {
        stderr += String(chunk);
        callback();
      },
    }),
    { isTTY: true },
  );
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.spyOn(process, 'stderr', 'get').mockReturnValue(output as unknown as typeof process.stderr);
  cleanup.push(async () => {
    input.destroy();
    output.destroy();
  });
  return { input, rawModes, stderr: () => stderr };
}

describe('plasticwan-utils login and doctor', () => {
  it('saves a complete pair without networking, then doctor and list use the saved login', async () => {
    const homeDir = await home();
    const http = await server((response) =>
      json(response, 200, {
        items: [{ id: '42', private_message: 'not for the diagnostic output', echoed_key: KEY }],
        next_cursor: null,
      }),
    );
    const login = await cli(['login', '--endpoint', http.endpoint, '--json'], homeDir, { PLASTICWAN_API_KEY: KEY });
    expect(login.code).toBe(0);
    expect(login.stderr).toBe('');
    expect(JSON.parse(login.stdout)).toEqual({
      status: 'saved',
      endpoint: `${http.endpoint}/`,
      credentials_file: credentialsPath(homeDir),
    });
    expect(login.stdout).not.toContain(KEY);
    expect(http.requests).toHaveLength(0);
    expect(JSON.parse(await readFile(credentialsPath(homeDir), 'utf8'))).toEqual({
      endpoint: `${http.endpoint}/`,
      apiKey: KEY,
    });

    const doctor = await cli(['doctor', '--json'], homeDir);
    expect(doctor.code).toBe(0);
    expect(doctor.stderr).toBe('');
    expect(JSON.parse(doctor.stdout)).toEqual({
      status: 'ok',
      endpoint: `${http.endpoint}/`,
      credential_sources: { endpoint: 'file', api_key: 'file' },
    });
    expect(doctor.stdout).not.toContain('private_message');
    expect(doctor.stdout).not.toContain(KEY);
    expect(http.requests).toEqual([{ method: 'GET', url: '/api/invocations?limit=1', authorization: `Bearer ${KEY}` }]);

    const list = await cli(['invocation', 'list', '--json'], homeDir);
    expect(list.code).toBe(0);
    expect(list.stdout).not.toContain(KEY);
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.url).toBe('/api/invocations');
  });

  it('honors argument, environment and file priority without modifying the saved pair', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const before = await readFile(credentialsPath(homeDir), 'utf8');
    const fromEnv = await cli(['doctor', '--json'], homeDir, { PLASTICWAN_API_KEY: 'synthetic-environment-key' });
    expect(fromEnv.code).toBe(0);
    expect(JSON.parse(fromEnv.stdout).credential_sources).toEqual({ endpoint: 'file', api_key: 'environment' });
    const fromArgs = await cli(
      ['doctor', '--endpoint', http.endpoint, '--api-key', 'synthetic-argument-key', '--json'],
      homeDir,
      {
        PLASTICWAN_ENDPOINT: 'https://unused.example.com',
        PLASTICWAN_API_KEY: 'synthetic-environment-key',
      },
    );
    expect(fromArgs.code).toBe(0);
    expect(JSON.parse(fromArgs.stdout).credential_sources).toEqual({ endpoint: 'argument', api_key: 'argument' });
    expect(http.requests.map((request) => request.authorization)).toEqual([
      'Bearer synthetic-environment-key',
      'Bearer synthetic-argument-key',
    ]);
    expect(await readFile(credentialsPath(homeDir), 'utf8')).toBe(before);
  });

  it('bypasses a malformed saved file for an explicit pair but fails safely when fallback is needed', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    const path = credentialsPath(homeDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corrupted = `{"apiKey":"${KEY}",`;
    await writeFile(path, corrupted, { mode: 0o600 });
    const explicit = await cli(['doctor', '--endpoint', http.endpoint, '--api-key', KEY, '--json'], homeDir);
    expect(explicit.code).toBe(0);
    expect(http.requests).toHaveLength(1);
    const fromEnvironment = await cli(['doctor', '--json'], homeDir, {
      PLASTICWAN_ENDPOINT: http.endpoint,
      PLASTICWAN_API_KEY: KEY,
    });
    expect(fromEnvironment.code).toBe(0);
    expect(http.requests).toHaveLength(2);
    const fallback = await cli(['doctor', '--json'], homeDir);
    expect(fallback.code).toBe(1);
    expect(JSON.parse(fallback.stderr).error).toBe('invalid_credentials');
    expect(fallback.stderr).not.toContain(KEY);
    expect(http.requests).toHaveLength(2);
    expect(await readFile(path, 'utf8')).toBe(corrupted);

    const repaired = await cli(['login', '--endpoint', http.endpoint, '--json'], homeDir, {
      PLASTICWAN_API_KEY: KEY,
    });
    expect(repaired.code).toBe(0);
    expect(repaired.stderr).toBe('');
    expect(repaired.stdout).not.toContain(KEY);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ endpoint: `${http.endpoint}/`, apiKey: KEY });
    expect(http.requests).toHaveLength(2);
    expect((await cli(['doctor', '--json'], homeDir)).code).toBe(0);
    expect(http.requests).toHaveLength(3);
  });

  it('treats empty explicit values as invalid instead of silently falling back', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    for (const env of [{ PLASTICWAN_API_KEY: '' }, { PLASTICWAN_ENDPOINT: '' }]) {
      const result = await cli(['doctor', '--json'], homeDir, env);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    }
    expect(http.requests).toHaveLength(0);
  });

  it.each(['{', '42', '"', '\\', 'synthetic-quote-"-key', 'synthetic-backslash-key-\\'])(
    'keeps JSON valid while redacting saved keys, including structural characters (%j)',
    async (apiKey) => {
      const homeDir = await home();
      const http = await server((response) =>
        json(response, 200, { id: '7', error: null, items: [{ id: 42, echo: `key ${apiKey}` }], next_cursor: null }),
      );
      await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey });
      for (const args of [
        ['invocation', 'list', '--json'],
        ['invocation', 'get', '7', '--json'],
        ['invocation', 'get', '7'],
        ['invocation', 'replay', '7', '--json'],
        ['invocation', 'replay', '7'],
      ]) {
        const result = await cli(args, homeDir);
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          id: '7',
          error: null,
          items: [{ id: 42, echo: 'key [redacted]' }],
          next_cursor: null,
        });
      }
      const doctor = await cli(['doctor', '--json'], homeDir);
      expect(doctor.code).toBe(0);
      expect(JSON.parse(doctor.stdout).status).toBe('ok');
      expect(http.requests).toHaveLength(6);
    },
  );

  it('never sends a saved key to a different endpoint override', async () => {
    const homeDir = await home();
    const first = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    const other = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    await writeCredentials(credentialsPath(homeDir), { endpoint: first.endpoint, apiKey: KEY });
    for (const options of [
      { args: ['doctor', '--endpoint', other.endpoint, '--json'], env: {} },
      { args: ['doctor', '--json'], env: { PLASTICWAN_ENDPOINT: other.endpoint } },
    ]) {
      const result = await cli(options.args, homeDir, options.env);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).error).toBe('missing_api_key');
      expect(result.stderr).not.toContain(KEY);
    }
    expect(first.requests).toHaveLength(0);
    expect(other.requests).toHaveLength(0);
  });

  it('reports missing login, rejects irrelevant flags and never prompts in a non-TTY', async () => {
    const homeDir = await home();
    const missing = await cli(['doctor', '--json'], homeDir);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stderr).error).toBe('missing_endpoint');
    for (const args of [
      ['doctor', '--limit', '1'],
      ['invocation', 'list', '--api-key-stdin'],
      ['login', 'extra'],
    ]) {
      const result = await cli(args, homeDir);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    }
    const login = await child(['login', '--json'], homeDir, '');
    expect(login.code).toBe(2);
    expect(JSON.parse(login.stderr).error).toBe('login_input_required');
  });

  it('prompts for endpoint and hidden key, allows editing and restores terminal mode', async () => {
    const homeDir = await home();
    const tty = terminal();
    const pending = cli(['login', '--json'], homeDir);
    expect(tty.stderr()).toContain('Admin API endpoint: ');
    tty.input.write('https://admin.example.com\r');
    await vi.waitFor(() => expect(tty.stderr()).toContain('API key (hidden): '));
    tty.input.write(`${KEY}x\u007f\r`);
    const result = await pending;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('saved');
    expect(result.stderr).toBe('');
    expect(tty.stderr()).not.toContain(KEY);
    expect(tty.rawModes).toEqual([true, false, true, false]);
    expect(JSON.parse(await readFile(credentialsPath(homeDir), 'utf8')).apiKey).toBe(KEY);
  });

  it.each(['interrupt', 'eof', 'timeout'])(
    'cancels hidden input on %s without saving and restores terminal mode',
    async (action) => {
      const homeDir = await home();
      const tty = terminal();
      const pending = cli(
        ['login', '--endpoint', 'https://admin.example.com', '--timeout-ms', '100', '--json'],
        homeDir,
      );
      expect(tty.stderr()).toContain('API key (hidden): ');
      tty.input.write(KEY);
      if (action === 'interrupt') {
        tty.input.write('\u0003');
      } else if (action === 'eof') {
        // Ctrl+D closes readline only on an empty editing buffer.
        tty.input.write('\u0015\u0004');
      }
      const result = await pending;
      expect(result.code).toBe(action === 'timeout' ? 1 : 2);
      expect(JSON.parse(result.stderr).error).toBe(action === 'timeout' ? 'timeout' : 'login_cancelled');
      expect(result.stdout).toBe('');
      expect(`${tty.stderr()}${result.stderr}`).not.toContain(KEY);
      expect(tty.rawModes).toEqual([true, false]);
      await expect(readFile(credentialsPath(homeDir))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('accepts a piped single-line API key without printing it', async () => {
    const homeDir = await home();
    const result = await child(
      ['login', '--endpoint', 'https://admin.example.com', '--api-key-stdin', '--json'],
      homeDir,
      `${KEY}\r\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).status).toBe('saved');
    expect(result.stdout).not.toContain(KEY);
    expect(JSON.parse(await readFile(credentialsPath(homeDir), 'utf8')).apiKey).toBe(KEY);
  });

  it('bounds stdin, rejects conflicting sources, and preserves existing credentials on invalid login', async () => {
    const homeDir = await home();
    await writeCredentials(credentialsPath(homeDir), { endpoint: 'https://admin.example.com', apiKey: KEY });
    const before = await readFile(credentialsPath(homeDir), 'utf8');
    for (const input of ['', `${KEY}\nsecond-line`, Buffer.alloc(4_099, 0x61).toString()]) {
      const result = await child(
        ['login', '--endpoint', 'https://admin.example.com', '--api-key-stdin', '--json'],
        homeDir,
        input,
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).error).toBe('invalid_api_key');
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(KEY);
      expect(await readFile(credentialsPath(homeDir), 'utf8')).toBe(before);
    }
    const conflict = await child(
      ['login', '--endpoint', 'https://admin.example.com', '--api-key-stdin'],
      homeDir,
      KEY,
      false,
      {
        PLASTICWAN_API_KEY: KEY,
      },
    );
    expect(conflict.code).toBe(2);
    expect(JSON.parse(conflict.stderr).error).toBe('conflicting_key_input');
    expect(await readFile(credentialsPath(homeDir), 'utf8')).toBe(before);
  }, 20_000);

  it('times out on unfinished key input without saving or sending HTTP', async () => {
    const homeDir = await home();
    const http = await server((response) => json(response, 200, { items: [], next_cursor: null }));
    const result = await child(
      ['login', '--endpoint', http.endpoint, '--api-key-stdin', '--timeout-ms', '100', '--json'],
      homeDir,
      KEY,
      true,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBe('timeout');
    expect(result.stderr).not.toContain(KEY);
    expect(http.requests).toHaveLength(0);
    await expect(readFile(credentialsPath(homeDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([401, 403])('doctor fails on HTTP %s and redacts a reflected saved key without retrying', async (status) => {
    const homeDir = await home();
    const http = await server((response) =>
      json(response, status, { error: 'unauthenticated', message: `reflected ${KEY}` }),
    );
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const result = await cli(['doctor', '--json'], homeDir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'unauthenticated', message: 'reflected [redacted]' });
    expect(http.requests).toHaveLength(1);
  });

  it('doctor rejects a redirect and unexpected successful JSON without reporting a healthy login', async () => {
    const homeDir = await home();
    const http = await server((response) => {
      if (http.requests.length === 1) {
        response.writeHead(302, { location: `${http.endpoint}/elsewhere` });
        response.end();
      } else {
        json(response, 200, { status: 'ok' });
      }
    });
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const redirect = await cli(['doctor', '--json'], homeDir);
    expect(redirect.code).toBe(1);
    expect(JSON.parse(redirect.stderr).error).toBe('redirect_not_allowed');
    const invalid = await cli(['doctor', '--json'], homeDir);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stderr).error).toBe('invalid_response');
    expect(invalid.stdout).toBe('');
    expect(http.requests).toHaveLength(2);
  });

  it('doctor aborts a stalled server without retries', async () => {
    const homeDir = await home();
    const http = await server(() => {});
    await writeCredentials(credentialsPath(homeDir), { endpoint: http.endpoint, apiKey: KEY });
    const result = await cli(['doctor', '--timeout-ms', '100', '--json'], homeDir);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBe('timeout');
    expect(http.requests).toHaveLength(1);
  });
});
