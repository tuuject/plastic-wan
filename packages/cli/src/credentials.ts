import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isRecord, parseEndpoint } from './client.ts';
import { CliError, usageError } from './errors.ts';

/**
 * Credentials for the Admin API, stored as one 0600 file under
 * `~/.config/plasticwan-utils/`. Reading and writing share the same posture:
 * the file must be a regular file that group/other cannot read or write, its
 * bytes never reach an error message, and a replacement is renamed into place
 * so a failure cannot damage the previous pair.
 */
export interface Credentials {
  /** Normalized base URL, in the form `parseEndpoint` produces. */
  readonly endpoint: string;
  readonly apiKey: string;
}

/** A credentials file is tiny; anything larger is not one this tool wrote. */
export const MAX_CREDENTIALS_BYTES = 16 * 1024;

const MAX_API_KEY_LENGTH = 4096;
/** Whitespace (including Unicode spaces) and control characters. */
const FORBIDDEN_API_KEY_CHARACTERS = /[\p{White_Space}\p{Cc}]/u;
const INVALID_CREDENTIALS = 'invalid_credentials';

/**
 * `~/.config/plasticwan-utils/credentials.json` on every platform, Windows
 * included: one documented location beats an XDG/AppData guess that would hide
 * the file from users who followed the guide.
 */
export function credentialsPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'plasticwan-utils', 'credentials.json');
}

/**
 * A key is an opaque token: no `pwk_` prefix is required, and synthetic keys
 * (including ones ending in a backslash) must round-trip unchanged. Only what
 * would corrupt a header or a log line is refused.
 */
export function validateApiKey(value: string): string {
  if (value.length < 1 || value.length > MAX_API_KEY_LENGTH || FORBIDDEN_API_KEY_CHARACTERS.test(value)) {
    throw usageError(
      'invalid_api_key',
      `API key must be 1 to ${MAX_API_KEY_LENGTH} characters with no whitespace or control characters`,
    );
  }
  return value;
}

/**
 * Reads the stored credentials, or `undefined` when nothing is stored yet.
 * Every other anomaly fails fast with a fixed `CliError`: a JSON parse error
 * quotes the surrounding text, and that text is the key.
 */
export async function readCredentials(path: string): Promise<Credentials | undefined> {
  const info = await inspectCredentialsFile(path);
  if (info === undefined) {
    return undefined;
  }
  if (info.size > MAX_CREDENTIALS_BYTES) {
    throw invalidCredentials(path, `credentials file must not exceed ${MAX_CREDENTIALS_BYTES} bytes`);
  }
  await assertCredentialsDirectory(dirname(path), path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw invalidCredentials(path, 'credentials file could not be read');
  }
  return parseStoredCredentials(text, path);
}

/**
 * Writes the complete pair over whatever was stored before. The bytes land in
 * a freshly created 0600 file that is renamed into place, so a failed write
 * leaves the old file byte-for-byte intact. An existing symlink or an
 * over-permissive file or directory is refused rather than replaced. No lock
 * is taken: two concurrent logins are last-writer-wins.
 */
export async function writeCredentials(path: string, credentials: Credentials): Promise<void> {
  const endpoint = parseEndpoint(credentials.endpoint).href;
  const apiKey = validateApiKey(credentials.apiKey);
  const text = `${JSON.stringify({ endpoint, apiKey })}\n`;
  if (Buffer.byteLength(text) > MAX_CREDENTIALS_BYTES) {
    throw usageError('credentials_too_large', `credentials must not exceed ${MAX_CREDENTIALS_BYTES} bytes`);
  }
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertCredentialsDirectory(directory, path);
    await inspectCredentialsFile(path);
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    // The filesystem message is dropped: it can name the temporary file, and
    // the caller only ever needs to know that the write did not happen.
    throw new CliError('credentials_write_failed', `credentials file could not be written: ${path}`);
  }
}

/**
 * In-place inspection shared by both directions. `undefined` means nothing is
 * stored; anything that is present must be a regular file that group and other
 * cannot read or write (POSIX modes; on Windows the home ACL is inherited).
 */
async function inspectCredentialsFile(path: string): Promise<Stats | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw invalidCredentials(path, 'credentials file could not be inspected');
  });
  if (info === undefined) {
    return undefined;
  }
  if (info.isSymbolicLink()) {
    throw invalidCredentials(path, 'credentials file must not be a symbolic link');
  }
  if (!info.isFile()) {
    throw invalidCredentials(path, 'credentials file must be a regular file');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw invalidCredentials(path, 'credentials file permissions must be 0600 or narrower');
  }
  return info;
}

/** The containing directory must be real (not a symlink) and not group/other accessible. */
async function assertCredentialsDirectory(directory: string, path: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw invalidCredentials(path, 'credentials directory must be a real directory');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw invalidCredentials(path, 'credentials directory permissions must be 0700 or narrower');
  }
}

function parseStoredCredentials(text: string, path: string): Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalidCredentials(path, 'credentials file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw invalidCredentials(path, 'credentials file must contain exactly "endpoint" and "apiKey" strings');
  }
  const { endpoint: rawEndpoint, apiKey: rawApiKey } = parsed;
  if (Object.keys(parsed).length !== 2 || typeof rawEndpoint !== 'string' || typeof rawApiKey !== 'string') {
    throw invalidCredentials(path, 'credentials file must contain exactly "endpoint" and "apiKey" strings');
  }
  let endpoint: string;
  try {
    endpoint = parseEndpoint(rawEndpoint).href;
  } catch {
    throw invalidCredentials(path, 'credentials file endpoint is invalid');
  }
  try {
    validateApiKey(rawApiKey);
  } catch {
    throw invalidCredentials(path, 'credentials file API key is invalid');
  }
  return { endpoint, apiKey: rawApiKey };
}

function invalidCredentials(path: string, reason: string): CliError {
  return new CliError(INVALID_CREDENTIALS, `${reason}: ${path}`);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
