import { password } from '@inquirer/prompts';
import { assertConfigPermissions, loadConfig } from '../../platform/config.ts';
import { ServeLock, SqliteStore } from '../../store/database.ts';
import { AdminAuth } from './auth.ts';

/**
 * The password is only ever read from stdin or a hidden TTY prompt, never from
 * argv (shell history) and never echoed back; error output stays static so no
 * validation failure can leak it.
 */
const STDIN_PASSWORD_MAX_BYTES = 800;
/** A pipe that stays open is a mistake; stop waiting instead of hanging forever. */
const STDIN_PASSWORD_TIMEOUT_MS = 10_000;
/** Recovery creates no session, so the TTL is inert; the constructor still needs a value. */
const FALLBACK_SESSION_TTL_HOURS = 168;

export interface AdminResetOptions {
  readonly configPath: string;
  readonly username: string;
  readonly passwordStdin: boolean;
}

/**
 * `admin-reset`: replaces the stored Argon2id password of an existing
 * administrator, deletes all of their passkeys, and revokes every active login
 * session. Offline and purely local: no Telegram, no Admin HTTP server, no
 * setup path. The recovery refuses to run while a `serve` process holds the
 * data directory's lock, and never takes the lock over.
 */
export async function runAdminReset(options: AdminResetOptions): Promise<void> {
  const loaded = await loadConfig(options.configPath);
  await assertConfigPermissions(loaded.configPath);
  if (!options.passwordStdin && process.stdin.isTTY !== true) {
    throw new Error('admin-reset needs a terminal to ask for the password; pipe it on stdin with --password-stdin');
  }
  const lock = await ServeLock.acquire(loaded.config.data_dir);
  let store: SqliteStore | undefined;
  try {
    console.error(
      `admin-reset will replace the password of administrator "${options.username}", delete all of their passkeys, and revoke every active login session`,
    );
    const credentials = {
      username: options.username,
      password: options.passwordStdin ? await readPasswordFromStdin() : await promptNewPassword(),
    };
    store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, loaded.config.admin?.session_ttl_hours ?? FALLBACK_SESSION_TTL_HOURS);
    await auth.recoverCredentials(credentials);
  } finally {
    // Closing the store must come before releasing the lock: the lock is the
    // guarantee that no `serve` touches the database mid-recovery.
    store?.close();
    await lock.release();
  }
  console.log(JSON.stringify({ status: 'ok', username: options.username }));
}

async function promptNewPassword(): Promise<string> {
  const first = await password({ message: 'New administrator password', mask: true });
  const second = await password({ message: 'Repeat new administrator password', mask: true });
  if (first !== second) {
    throw new Error('Passwords do not match');
  }
  return first;
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > STDIN_PASSWORD_MAX_BYTES) {
        cleanup();
        process.stdin.destroy();
        reject(new Error(`Password on stdin must be at most ${STDIN_PASSWORD_MAX_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      const text = Buffer.concat(chunks).toString('utf8');
      // A terminal-less pipe normally ends with a single newline; strip exactly
      // one trailing LF or CRLF so `printf 'pw\n'` yields the password itself.
      resolve(text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('Could not read the password from stdin'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      process.stdin.destroy();
      reject(new Error('Timed out waiting for the password on stdin'));
    }, STDIN_PASSWORD_TIMEOUT_MS);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}
