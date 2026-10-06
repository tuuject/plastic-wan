import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { CliError, usageError } from './errors.ts';

export async function promptLoginField(label: string, secret: boolean, timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    throw usageError(
      'login_input_required',
      'login requires a terminal or an explicit endpoint and API key; use --api-key-stdin for piped keys',
    );
  }
  // readline still handles editing and terminal raw-mode restoration, but none
  // of the secret input (including paste and backspace) reaches its output.
  const output = secret ? new Writable({ write: (_chunk, _encoding, callback) => callback() }) : process.stderr;
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const cancelled = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  const cancel = () => cancelled.abort();
  terminal.on('SIGINT', cancel);
  terminal.on('close', cancel);
  process.stderr.write(label);
  try {
    return await terminal.question('', { signal: AbortSignal.any([cancelled.signal, timeout]) });
  } catch {
    if (timeout.aborted) {
      throw new CliError('timeout', `login input timed out after ${timeoutMs}ms; no credentials were saved`);
    }
    throw usageError('login_cancelled', 'login was cancelled; no credentials were saved');
  } finally {
    terminal.removeListener('SIGINT', cancel);
    terminal.removeListener('close', cancel);
    terminal.close();
    if (secret) {
      process.stderr.write('\n');
      output.destroy();
    }
  }
}

export async function readLoginKey(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw usageError('stdin_required', '--api-key-stdin requires a piped API key, not a terminal');
  }
  const timer = setTimeout(() => {
    process.stdin.destroy(new CliError('timeout', `stdin timed out after ${timeoutMs}ms; no credentials were saved`));
  }, timeoutMs);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      // Permit the usual trailing CRLF without increasing the 4 KiB key cap.
      if (total > 4_098) {
        process.stdin.destroy();
        throw usageError('invalid_api_key', 'API key input exceeds 4 KiB');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  } finally {
    clearTimeout(timer);
  }
}
