import { Buffer } from 'node:buffer';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  credentialsPath,
  MAX_CREDENTIALS_BYTES,
  readCredentials,
  validateApiKey,
  writeCredentials,
} from '../packages/cli/src/credentials.ts';
import { CliError } from '../packages/cli/src/errors.ts';

const ENDPOINT = 'https://panel.example.com/admin';
const NORMALIZED_ENDPOINT = 'https://panel.example.com/admin/';
const API_KEY = 'pwk_synthetic_0123456789abcdef';
const CANARY = 'synthetic-canary-0f1e2d3c';

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'plasticwan-credentials-'));
  directories.push(directory);
  return directory;
}

/** The layout the tool itself uses, under a throwaway home. */
function credentialsFile(): string {
  return credentialsPath(join(tempDir(), 'home'));
}

/** Creates the 0700 directory, then writes fixture bytes as a 0600 file. */
function writeFixture(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectCredentialsError(error: unknown, context?: string): CliError {
  expect(error, context).toBeInstanceOf(CliError);
  const cli = error as CliError;
  expect(cli.code, context).toBe('invalid_credentials');
  expect(cli.message, context).not.toContain(CANARY);
  expect(cli.message, context).not.toContain(API_KEY);
  return cli;
}

/** File symlinks need Developer Mode (or elevation) on Windows; the probe decides skipping. */
function canCreateFileSymlink(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'plasticwan-credentials-linkprobe-'));
  try {
    writeFileSync(join(directory, 'target'), 'target');
    symlinkSync(join(directory, 'target'), join(directory, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Directory links work without elevation on Windows when created as junctions. */
function linkDirectory(target: string, path: string): void {
  if (process.platform === 'win32') {
    symlinkSync(target, path, 'junction');
  } else {
    symlinkSync(target, path);
  }
}

function canCreateDirectoryLink(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'plasticwan-credentials-linkprobe-'));
  try {
    const target = join(directory, 'target');
    mkdirSync(target);
    linkDirectory(target, join(directory, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const hasFileSymlinks = canCreateFileSymlink();
const hasDirectoryLinks = canCreateDirectoryLink();
const isPosix = process.platform !== 'win32';

describe('credentialsPath', () => {
  it('is fixed under the home directory on every platform', () => {
    const home = join(tmpdir(), 'plasticwan-home-fixture');
    expect(credentialsPath(home)).toBe(join(home, '.config', 'plasticwan-utils', 'credentials.json'));
    expect(credentialsPath()).toBe(join(homedir(), '.config', 'plasticwan-utils', 'credentials.json'));
  });

  it('ignores XDG overrides', () => {
    const home = join(tmpdir(), 'plasticwan-home-fixture');
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(tmpdir(), 'plasticwan-xdg-fixture');
    try {
      expect(credentialsPath(home)).toBe(join(home, '.config', 'plasticwan-utils', 'credentials.json'));
      expect(credentialsPath(home)).not.toContain('plasticwan-xdg-fixture');
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previous;
      }
    }
  });
});

describe('validateApiKey', () => {
  it('accepts opaque keys, including a trailing backslash and no prefix', () => {
    const trailingBackslash = 'synthetic-key-\\';
    expect(validateApiKey(trailingBackslash)).toBe(trailingBackslash);
    expect(validateApiKey('x')).toBe('x');
    expect(validateApiKey('plain-token-without-prefix')).toBe('plain-token-without-prefix');
    expect(validateApiKey('x'.repeat(4096))).toBe('x'.repeat(4096));
  });

  it('rejects empty, whitespace, control characters and overlength keys without echoing them', () => {
    const rejected = [
      '',
      ' ',
      'a b',
      'a\nb',
      'a\tb',
      'a\u0000b',
      'a\u007fb',
      'a\u009fb',
      'a\u00a0b',
      'a\u2028b',
      'x'.repeat(4097),
    ];
    for (const value of rejected) {
      let error: unknown;
      try {
        validateApiKey(value);
      } catch (thrown: unknown) {
        error = thrown;
      }
      expect(error, `case ${JSON.stringify(value.slice(0, 12))}`).toBeInstanceOf(CliError);
      const cli = error as CliError;
      expect(cli.code).toBe('invalid_api_key');
      expect(cli.exitCode).toBe(2);
      expect(cli.message).toBe('API key must be 1 to 4096 characters with no whitespace or control characters');
    }
  });
});

describe('readCredentials', () => {
  it('reports not logged in as undefined, including through the fixed path', async () => {
    const directory = tempDir();
    await expect(readCredentials(join(directory, 'credentials.json'))).resolves.toBeUndefined();
    await expect(readCredentials(credentialsPath(join(directory, 'missing-home')))).resolves.toBeUndefined();
  });

  it('round-trips the pair and normalizes the endpoint', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    await expect(readCredentials(path)).resolves.toEqual({ endpoint: NORMALIZED_ENDPOINT, apiKey: API_KEY });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({ endpoint: NORMALIZED_ENDPOINT, apiKey: API_KEY });
    expect(Object.keys(parsed)).toEqual(['endpoint', 'apiKey']);
  });

  it('round-trips a key that ends in a backslash', async () => {
    const path = credentialsFile();
    const apiKey = 'synthetic-key-with-backslash-\\';
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey });
    await expect(readCredentials(path)).resolves.toEqual({ endpoint: NORMALIZED_ENDPOINT, apiKey });
  });

  it('accepts loopback http and rejects unsafe stored endpoints', async () => {
    const path = credentialsFile();
    writeFixture(path, JSON.stringify({ endpoint: 'http://127.0.0.1:8123/admin', apiKey: API_KEY }));
    await expect(readCredentials(path)).resolves.toEqual({
      endpoint: 'http://127.0.0.1:8123/admin/',
      apiKey: API_KEY,
    });
    const rejected = [
      'not-a-url',
      'ftp://example.com/',
      'http://example.com/',
      'https://synthetic-user:synthetic-password@example.com/',
      'https://example.com/?token=x',
      'https://example.com/#fragment',
    ];
    for (const endpoint of rejected) {
      writeFixture(path, JSON.stringify({ endpoint, apiKey: API_KEY }));
      const error = expectCredentialsError(await capture(readCredentials(path)), endpoint);
      expect(error.message).toContain('endpoint');
      expect(error.message).not.toContain('synthetic-password');
    }
  });

  it('rejects malformed files without quoting them', async () => {
    const path = credentialsFile();
    const malformed: readonly (readonly [string, string])[] = [
      ['empty', ''],
      ['not JSON', `${CANARY} truncated {`],
      ['array', JSON.stringify([ENDPOINT, API_KEY])],
      ['string', JSON.stringify(CANARY)],
      ['null', 'null'],
      ['number', '42'],
      ['missing apiKey', JSON.stringify({ endpoint: ENDPOINT })],
      ['extra key', JSON.stringify({ endpoint: ENDPOINT, apiKey: API_KEY, extra: CANARY })],
      ['extra nested value', JSON.stringify({ endpoint: ENDPOINT, apiKey: API_KEY, nested: { canary: CANARY } })],
      ['non-string endpoint', JSON.stringify({ endpoint: 42, apiKey: API_KEY })],
      ['non-string apiKey', JSON.stringify({ endpoint: ENDPOINT, apiKey: { canary: CANARY } })],
      ['trailing text', `${JSON.stringify({ endpoint: ENDPOINT, apiKey: API_KEY })} ${CANARY}`],
    ];
    for (const [label, text] of malformed) {
      writeFixture(path, text);
      expectCredentialsError(await capture(readCredentials(path)), `malformed ${label}`);
    }
  });

  it('rejects invalid stored API keys', async () => {
    const path = credentialsFile();
    const rejected = ['', 'has space', 'line\nbreak', 'tab\tkey', 'x'.repeat(4097)];
    for (const apiKey of rejected) {
      writeFixture(path, JSON.stringify({ endpoint: ENDPOINT, apiKey }));
      const error = expectCredentialsError(await capture(readCredentials(path)), `key ${apiKey.length} chars`);
      expect(error.message).toContain('API key');
    }
  });

  it('rejects a directory where the file should be', async () => {
    const path = credentialsFile();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 });
    const error = expectCredentialsError(await capture(readCredentials(path)));
    expect(error.message).toContain('regular file');
  });

  it(`accepts ${MAX_CREDENTIALS_BYTES} bytes and refuses one more`, async () => {
    const path = credentialsFile();
    const apiKey = 'k'.repeat(32);
    const prefix = '{"endpoint":"https://example.com/';
    const suffix = `","apiKey":"${apiKey}"}`;
    const padding = MAX_CREDENTIALS_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    expect(padding).toBeGreaterThan(0);

    const atLimit = `${prefix}${'a'.repeat(padding)}${suffix}`;
    expect(Buffer.byteLength(atLimit)).toBe(MAX_CREDENTIALS_BYTES);
    writeFixture(path, atLimit);
    const stored = await readCredentials(path);
    expect(stored?.apiKey).toBe(apiKey);
    expect(stored?.endpoint.startsWith('https://example.com/')).toBe(true);

    writeFixture(path, `${prefix}${'a'.repeat(padding + 1)}${suffix}`);
    const error = expectCredentialsError(await capture(readCredentials(path)));
    expect(error.message).toContain(String(MAX_CREDENTIALS_BYTES));
  });
});

describe('writeCredentials', () => {
  it('replaces both fields on re-login, leaving nothing of the old pair behind', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: 'first-synthetic-key' });
    await writeCredentials(path, { endpoint: 'https://second.example.com/panel', apiKey: 'second-synthetic-key' });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('first-synthetic-key');
    expect(raw).not.toContain('panel.example.com');
    await expect(readCredentials(path)).resolves.toEqual({
      endpoint: 'https://second.example.com/panel/',
      apiKey: 'second-synthetic-key',
    });
  });

  it('refuses invalid input before touching the stored file', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    const before = readFileSync(path);
    const attempts = [
      { endpoint: ENDPOINT, apiKey: 'bad key' },
      { endpoint: ENDPOINT, apiKey: '' },
      { endpoint: 'http://example.com/', apiKey: 'synthetic-key' },
      { endpoint: 'not-a-url', apiKey: 'synthetic-key' },
    ];
    for (const attempt of attempts) {
      const error = await capture(writeCredentials(path, attempt));
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(readdirSync(dirname(path))).toEqual(['credentials.json']);
    }
  });

  it('refuses an oversized serialized pair before touching the directory or old file', async () => {
    const path = credentialsFile();
    const tooLarge = { endpoint: `https://example.com/${'a'.repeat(MAX_CREDENTIALS_BYTES)}`, apiKey: API_KEY };
    const error = await capture(writeCredentials(path, tooLarge));
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('credentials_too_large');
    expect((error as CliError).exitCode).toBe(2);
    expect(() => lstatSync(dirname(path))).toThrow();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    const before = readFileSync(path);
    await expect(writeCredentials(path, tooLarge)).rejects.toMatchObject({ code: 'credentials_too_large' });
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(['credentials.json']);
  });

  it('rejects a directory at the file path without touching it', async () => {
    const path = credentialsFile();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 });
    const error = expectCredentialsError(await capture(writeCredentials(path, { endpoint: ENDPOINT, apiKey: CANARY })));
    expect(error.message).toContain('regular file');
    expect(error.message).not.toContain(CANARY);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });
});

describe.skipIf(!hasFileSymlinks)('file symlink protection', () => {
  it('refuses to read through a symlink', async () => {
    const directory = tempDir();
    const target = join(directory, 'target.json');
    writeFixture(target, JSON.stringify({ endpoint: ENDPOINT, apiKey: API_KEY }));
    const path = join(directory, 'credentials.json');
    symlinkSync(target, path);
    const error = expectCredentialsError(await capture(readCredentials(path)));
    expect(error.message).toContain('symbolic link');
    await expect(readCredentials(target)).resolves.toEqual({ endpoint: NORMALIZED_ENDPOINT, apiKey: API_KEY });
  });

  it('refuses to write through a symlink and leaves the target alone', async () => {
    const directory = tempDir();
    const target = join(directory, 'target.json');
    writeFixture(target, JSON.stringify({ endpoint: ENDPOINT, apiKey: API_KEY }));
    const before = readFileSync(target);
    const path = join(directory, 'credentials.json');
    symlinkSync(target, path);
    const error = expectCredentialsError(
      await capture(writeCredentials(path, { endpoint: 'https://other.example.com/', apiKey: CANARY })),
    );
    expect(error.message).toContain('symbolic link');
    expect(readFileSync(target).equals(before)).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe.skipIf(!hasDirectoryLinks)('directory link protection', () => {
  it('refuses a linked credentials directory', async () => {
    const directory = tempDir();
    const real = join(directory, 'real-credentials');
    mkdirSync(real, { recursive: true, mode: 0o700 });
    writeFixture(join(real, 'credentials.json'), JSON.stringify({ endpoint: ENDPOINT, apiKey: API_KEY }));
    const link = join(directory, 'linked-credentials');
    linkDirectory(real, link);
    const path = join(link, 'credentials.json');

    const readError = expectCredentialsError(await capture(readCredentials(path)));
    expect(readError.message).toContain('real directory');
    const writeError = expectCredentialsError(
      await capture(writeCredentials(path, { endpoint: ENDPOINT, apiKey: CANARY })),
    );
    expect(writeError.message).toContain('real directory');
    expect(readdirSync(real)).toEqual(['credentials.json']);
  });
});

describe.skipIf(!isPosix)('POSIX permissions', () => {
  it('creates the directory 0700 and the file 0600', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it('accepts a file narrower than 0600', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    chmodSync(path, 0o400);
    await expect(readCredentials(path)).resolves.toEqual({ endpoint: NORMALIZED_ENDPOINT, apiKey: API_KEY });
  });

  it('refuses a group- or other-accessible file, in both directions', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    const before = readFileSync(path);
    chmodSync(path, 0o644);

    const readError = expectCredentialsError(await capture(readCredentials(path)));
    expect(readError.message).toContain('0600');
    const writeError = expectCredentialsError(
      await capture(writeCredentials(path, { endpoint: 'https://other.example.com/', apiKey: 'synthetic-key' })),
    );
    expect(writeError.message).toContain('0600');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('refuses an accessible directory without replacing the stored file', async () => {
    const path = credentialsFile();
    await writeCredentials(path, { endpoint: ENDPOINT, apiKey: API_KEY });
    const before = readFileSync(path);
    chmodSync(dirname(path), 0o755);

    const readError = expectCredentialsError(await capture(readCredentials(path)));
    expect(readError.message).toContain('0700');
    const writeError = expectCredentialsError(
      await capture(writeCredentials(path, { endpoint: 'https://other.example.com/', apiKey: 'synthetic-key' })),
    );
    expect(writeError.message).toContain('0700');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dirname(path))).toEqual(['credentials.json']);
  });
});

describe('error secrecy', () => {
  it('never puts the file text or the key into a read error', async () => {
    const path = credentialsFile();
    writeFixture(path, `{ "endpoint": "${ENDPOINT}", "apiKey": "${API_KEY}", "leftover": "${CANARY}" `);
    const error = expectCredentialsError(await capture(readCredentials(path)));
    expect(error.message).not.toContain('leftover');
    expect(error.message).toContain(path);
  });

  it('never puts an invalid key into a write error', async () => {
    const path = credentialsFile();
    const secretLooking = `${CANARY} with spaces`;
    const error = await capture(writeCredentials(path, { endpoint: ENDPOINT, apiKey: secretLooking }));
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('invalid_api_key');
    expect((error as CliError).message).not.toContain(CANARY);
    expect((error as CliError).message).not.toContain('with spaces');
  });
});
