import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '@node-rs/argon2';
import { parseCli } from '../src/cli-options.ts';
import { AdminAuth } from '../src/ingress/admin/auth.ts';
import { loadConfig } from '../src/platform/config.ts';
import { ServeLock, SqliteStore } from '../src/store/database.ts';
import { writeTestConfig } from './helpers.ts';

const BIN = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[], stdin?: string, endStdin = true): Promise<CliResult> {
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
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
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    if (endStdin) {
      child.stdin.end();
    }
  });
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string; dataDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-recovery-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  return { directory, configPath, dataDir: join(directory, 'data') };
}

const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';

function adminId(store: SqliteStore, username: string): bigint {
  const row = store.db.prepare<[string], { id: bigint }>('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (row === undefined) {
    throw new Error(`admin user ${username} does not exist`);
  }
  return row.id;
}

function sessionCount(store: SqliteStore, userId: bigint): bigint {
  return store.db
    .prepare<[bigint], { count: bigint }>('SELECT count(*) AS count FROM admin_sessions WHERE user_id = ?')
    .get(userId)!.count;
}

function passkeyCount(store: SqliteStore, userId: bigint): bigint {
  return store.db
    .prepare<[bigint], { count: bigint }>('SELECT count(*) AS count FROM admin_passkeys WHERE user_id = ?')
    .get(userId)!.count;
}

describe('admin-reset parseCli contract', () => {
  test('parses username and password-stdin for admin-reset', () => {
    const options = parseCli([
      'admin-reset',
      '--config',
      'dev-data/config.jsonc',
      '--username',
      'admin',
      '--password-stdin',
    ]);
    expect(options.command).toBe('admin-reset');
    expect(options.configPath).toBe('dev-data/config.jsonc');
    expect(options.username).toBe('admin');
    expect(options.passwordStdin).toBe(true);
  });

  test('admin-reset without a username is rejected', () => {
    expect(() => parseCli(['admin-reset', '--config', 'dev-data/config.jsonc'])).toThrow();
  });

  test('admin-reset without --config is rejected', () => {
    expect(() => parseCli(['admin-reset', '--username', 'admin'])).toThrow();
  });

  test('a username value starting with -- is rejected', () => {
    expect(() => parseCli(['admin-reset', '--config', 'p', '--username', '--x'])).toThrow();
  });

  test('a duplicate --username is rejected', () => {
    expect(() => parseCli(['admin-reset', '--config', 'p', '--username', 'a', '--username', 'b'])).toThrow();
  });

  test('--password-stdin is rejected outside admin-reset', () => {
    expect(() => parseCli(['serve', '--config', 'p', '--password-stdin'])).toThrow();
    expect(() => parseCli(['doctor', '--config', 'p', '--password-stdin'])).toThrow();
  });

  test('--username is rejected outside admin-reset', () => {
    expect(() => parseCli(['serve', '--config', 'p', '--username', 'admin'])).toThrow();
    expect(() => parseCli(['check-config', '--config', 'p', '--username', 'admin'])).toThrow();
  });

  test('existing command flags keep their boundaries', () => {
    expect(parseCli(['serve', '--config', 'p', '--takeover']).takeover).toBe(true);
    expect(() => parseCli(['backup', '--config', 'p', '--takeover'])).toThrow();
    expect(parseCli(['doctor', '--config', 'p', '--output-agent-prompt']).outputAgentPrompt).toBe(true);
    expect(() => parseCli(['serve', '--config', 'p', '--output-agent-prompt'])).toThrow();
    expect(() => parseCli(['unknown', '--config', 'p'])).toThrow();
  });
});

describe('admin-reset password input safety', () => {
  test('an open stdin pipe times out without leaking input and releases the lock', async () => {
    const { configPath, dataDir } = await fixture();
    const result = await runCli(
      ['admin-reset', '--config', configPath, '--username', 'admin', '--password-stdin'],
      NEW_PASSWORD,
      false,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Timed out waiting');
    expect(result.stdout + result.stderr).not.toContain(NEW_PASSWORD);
    await expect(access(join(dataDir, 'serve.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  test('non-TTY stdin without --password-stdin fails immediately', async () => {
    const { configPath } = await fixture();
    const result = await runCli(['admin-reset', '--config', configPath, '--username', 'admin']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--password-stdin');
  }, 60_000);

  test('stdin passwords over 800 bytes are rejected before any recovery', async () => {
    const { configPath } = await fixture();
    const result = await runCli(
      ['admin-reset', '--config', configPath, '--username', 'admin', '--password-stdin'],
      `${'x'.repeat(801)}\n`,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('800 bytes');
    // The database file was never created, so nothing was written.
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    try {
      expect(store.db.prepare('SELECT count(*) FROM admin_users').get()).toEqual({ 'count(*)': 0n });
    } finally {
      store.close();
    }
  }, 60_000);
});

describe('admin-reset recovery flow', () => {
  test('refuses while another process holds the serve lock and writes nothing', async () => {
    const { configPath, dataDir } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    store.close();

    const lock = await ServeLock.acquire(dataDir);
    try {
      const result = await runCli(
        ['admin-reset', '--config', configPath, '--username', 'admin', '--password-stdin'],
        `${NEW_PASSWORD}\n`,
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('serve.lock');
      expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);
    } finally {
      await lock.release();
    }

    const reopened = await SqliteStore.open(loaded.config);
    try {
      const row = reopened.db.prepare<[], { password_hash: string }>('SELECT password_hash FROM admin_users').get();
      expect(row).toBeDefined();
      expect(await verify(row!.password_hash, OLD_PASSWORD)).toBe(true);
      expect(await verify(row!.password_hash, NEW_PASSWORD)).toBe(false);
    } finally {
      reopened.close();
    }
  }, 60_000);

  test('unknown usernames are refused and nothing changes', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    const userId = adminId(store, 'admin');
    store.close();

    const result = await runCli(
      ['admin-reset', '--config', configPath, '--username', 'ghost', '--password-stdin'],
      `${NEW_PASSWORD}\n`,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);

    const reopened = await SqliteStore.open(loaded.config);
    try {
      expect(sessionCount(reopened, userId)).toBe(1n);
      const row = reopened.db.prepare<[], { password_hash: string }>('SELECT password_hash FROM admin_users').get();
      expect(await verify(row!.password_hash, OLD_PASSWORD)).toBe(true);
    } finally {
      reopened.close();
    }
  }, 60_000);

  test('resets the password, clears passkeys, revokes sessions, and never prints the password', async () => {
    const { configPath, dataDir } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    await auth.login({ username: 'admin', password: OLD_PASSWORD });
    const userId = adminId(store, 'admin');
    expect(sessionCount(store, userId)).toBe(2n);
    const insert = store.db.prepare(
      `INSERT INTO admin_passkeys (user_id, credential_id, public_key, counter, rp_id, name, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    insert.run(userId, 'credential-1', 'public-key-1', 0, 'localhost', 'test-key-1', new Date().toISOString());
    insert.run(userId, 'credential-2', 'public-key-2', 0, 'localhost', 'test-key-2', new Date().toISOString());
    expect(passkeyCount(store, userId)).toBe(2n);
    // Recovery must also work when the lost passkeys were the only login method.
    store.db.prepare('UPDATE admin_users SET password_hash = NULL WHERE id = ?').run(userId);
    store.db
      .prepare('INSERT INTO admin_api_keys (name, prefix, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('recovery-fixture', 'fixture', 'fixture-token-digest', new Date().toISOString());
    const apiKeysBefore = store.db.prepare('SELECT * FROM admin_api_keys').all();
    store.close();

    const result = await runCli(
      ['admin-reset', '--config', configPath, '--username', 'admin', '--password-stdin'],
      `${NEW_PASSWORD}\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('passkeys');
    expect(result.stderr).toContain('revoke');
    expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);
    const success: unknown = JSON.parse(result.stdout);
    expect(success).toEqual({ status: 'ok', username: 'admin' });

    // The child released the lock as part of its finally block.
    await expect(access(join(dataDir, 'serve.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

    const reopened = await SqliteStore.open(loaded.config);
    try {
      expect(sessionCount(reopened, userId)).toBe(0n);
      expect(passkeyCount(reopened, userId)).toBe(0n);
      expect(reopened.db.prepare('SELECT * FROM admin_api_keys').all()).toEqual(apiKeysBefore);
      const row = reopened.db.prepare<[], { password_hash: string }>('SELECT password_hash FROM admin_users').get();
      expect(row).toBeDefined();
      expect(await verify(row!.password_hash, OLD_PASSWORD)).toBe(false);
      expect(await verify(row!.password_hash, NEW_PASSWORD)).toBe(true);
      // The account still exists; recovery never recreates the setup state.
      const recoveredAuth = new AdminAuth(reopened.orm, 168);
      expect(recoveredAuth.setupRequired()).toBe(false);
      const token = await recoveredAuth.login({ username: 'admin', password: NEW_PASSWORD });
      expect(token.length).toBeGreaterThan(0);
      expect(sessionCount(reopened, userId)).toBe(1n);
    } finally {
      reopened.close();
    }
  }, 60_000);
});
