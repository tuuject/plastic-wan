import { afterAll, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileConfig, type RawConfig, loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { createToolAudit } from '../src/store/tool-audit.ts';
import { createWebFetchTool } from '../src/plugins/web-fetch/web-fetch.ts';
import { renderInvocationContext, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly context: InvocationContext;
}

async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-web-fetch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'fetch the page',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  return { store, config: loaded.config, context };
}

test('proxy synthetic DNS answers are refused unless the deployment opts in', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '198.18.0.42', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await expect(tool.execute('web-default', { url: 'https://attacker.example/' })).rejects.toThrow(
      'non-public address',
    );
    expect(requests).toBe(0);
  } finally {
    store.close();
  }
});

test('web_fetch returns bounded untrusted text through proxy synthetic DNS and audits it', async () => {
  const { store, context } = await fixture();
  try {
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      allowProxySyntheticAddresses: true,
      resolveHostname: async (hostname) => {
        expect(hostname).toBe('public.example');
        return [{ address: '198.18.0.42', family: 4 }];
      },
      requestResolved: async (url, address) => {
        expect(url.href).toBe('https://public.example/article?q=1');
        expect(address).toBe('198.18.0.42');
        return new Response('你'.repeat(20_000), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      },
    });
    const result = await tool.execute('web-1', { url: 'https://public.example/article?q=1' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    expect(text.startsWith('Untrusted web content follows.')).toBe(true);
    expect(text.endsWith('[content truncated]')).toBe(true);
    expect(result.details).toEqual({
      url: 'https://public.example/article?q=1',
      status: 200,
      format: 'raw',
      truncated: true,
    });
    expect(
      store.db
        .prepare<[], { state: string; side_effect: bigint; result_text: string }>(
          "SELECT state, side_effect, result_text FROM tool_calls WHERE tool_call_id = 'web-1'",
        )
        .get(),
    ).toEqual({ state: 'success', side_effect: 0n, result_text: text });
  } finally {
    store.close();
  }
});

test('web_fetch config flags reach the built-in plugin tool', async () => {
  const { store, config, context } = await fixture((file) => {
    file.web_fetch = { dangerously_allow_all_ip_addresses: true };
  });
  try {
    const plugins = loadPlugins(BUILTIN_PLUGINS);
    const tool = plugins
      .capabilities(store, config, context, Date.now() + 30_000)
      .find((entry) => entry.tool.name === 'web_fetch')?.tool;
    expect(tool?.description).toContain('This deployment also allows private and local addresses.');
  } finally {
    store.close();
  }
});

test('dangerously_allow_all_ip_addresses skips address checks but keeps URL rules', async () => {
  const { store, context } = await fixture();
  try {
    const addresses: string[] = [];
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      allowAllAddresses: true,
      resolveHostname: async () => [{ address: '10.0.0.8', family: 4 }],
      requestResolved: async (url, address) => {
        addresses.push(address);
        if (url.pathname === '/start') {
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
        }
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    expect(tool.description).toContain('This deployment also allows private and local addresses.');
    expect(tool.description).not.toContain('use it for private/local resources');
    await tool.execute('web-lan', { url: 'http://nas.lan/status' });
    await tool.execute('web-loopback', { url: 'http://[::1]/' });
    await tool.execute('web-redirect-local', { url: 'https://public.example/start' });
    expect(addresses).toEqual(['10.0.0.8', '::1', '10.0.0.8', '127.0.0.1']);
    await expect(tool.execute('web-port', { url: 'http://127.0.0.1:8080/' })).rejects.toThrow('default ports');
    expect(
      store.db
        .prepare<[], { tool_call_id: string; state: string }>('SELECT tool_call_id, state FROM tool_calls ORDER BY id')
        .all(),
    ).toEqual([
      { tool_call_id: 'web-lan', state: 'success' },
      { tool_call_id: 'web-loopback', state: 'success' },
      { tool_call_id: 'web-redirect-local', state: 'success' },
      { tool_call_id: 'web-port', state: 'error' },
    ]);
  } finally {
    store.close();
  }
});

test('web_fetch allows public IPv4 answers and still blocks IPv4-mapped IPv6 literals', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
      requestResolved: async (_url, address) => {
        requests += 1;
        expect(address).toBe('93.184.216.34');
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await tool.execute('web-public-v4', { url: 'https://public.example/' });
    await expect(tool.execute('web-mapped', { url: 'http://[::ffff:7f00:1]/' })).rejects.toThrow('non-public address');
    expect(requests).toBe(1);
  } finally {
    store.close();
  }
});

test('web_fetch blocks IPv6 transition addresses that embed an IPv4 destination', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const resolved: Record<string, string> = {
      'six-to-four.example': '2002:7f00:1::1',
      'teredo.example': '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    };
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async (hostname) => [{ address: resolved[hostname] ?? '2606:4700::1', family: 6 }],
      requestResolved: async () => {
        requests += 1;
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await expect(tool.execute('web-6to4', { url: 'https://six-to-four.example/' })).rejects.toThrow(
      'non-public address',
    );
    await expect(tool.execute('web-teredo', { url: 'https://teredo.example/' })).rejects.toThrow('non-public address');
    await expect(tool.execute('web-literal-6to4', { url: 'http://[2002:a00:1::1]/' })).rejects.toThrow(
      'non-public address',
    );
    // An ordinary global unicast address still passes.
    await tool.execute('web-public-v6', { url: 'https://public.example/' });
    expect(requests).toBe(1);
  } finally {
    store.close();
  }
});

test('web_fetch blocks private and literal synthetic addresses, including redirects', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      // Even with the opt-in, a literal synthetic IP and a private redirect stay blocked.
      allowProxySyntheticAddresses: true,
      resolveHostname: async () => [{ address: '198.18.0.42', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      },
    });
    await expect(tool.execute('web-private', { url: 'http://127.0.0.1/secret' })).rejects.toThrow('non-public address');
    await expect(tool.execute('web-synthetic', { url: 'http://198.18.0.42/secret' })).rejects.toThrow(
      'non-public address',
    );
    await expect(tool.execute('web-redirect', { url: 'https://public.example/start' })).rejects.toThrow(
      'non-public address',
    );
    expect(requests).toBe(1);
    expect(
      store.db
        .prepare<[], { tool_call_id: string; state: string; error_code: string }>(
          'SELECT tool_call_id, state, error_code FROM tool_calls ORDER BY id',
        )
        .all(),
    ).toEqual([
      { tool_call_id: 'web-private', state: 'error', error_code: 'blocked_address' },
      { tool_call_id: 'web-synthetic', state: 'error', error_code: 'blocked_address' },
      { tool_call_id: 'web-redirect', state: 'error', error_code: 'blocked_address' },
    ]);
  } finally {
    store.close();
  }
});

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function articlePage(): string {
  // The article sits past the first 32 KiB, where a result-sized read would cut it off.
  const navigation = Array.from({ length: 400 }, (_, index) => `<li><a href="/nav/${index}">Section ${index}</a></li>`);
  return [
    '<!doctype html><html><head><title>Plastic bowls explained</title>',
    `<script>${'var tracking = 1;'.repeat(2_000)}</script></head><body>`,
    `<nav><ul>${navigation.join('')}</ul></nav>`,
    '<article><h1>Plastic bowls explained</h1>',
    '<p>A plastic bowl is light, cheap and hard to break. This paragraph carries the article body that must survive extraction.</p>',
    '<p>See the <a href="/care">care guide</a> for washing instructions.</p>',
    '<img src="/photo.jpg" alt="bowl photo"></article>',
    '<footer>Copyright footer</footer></body></html>',
  ].join('');
}

test('web_fetch converts HTML main content to Markdown by default and audits it', async () => {
  const { store, context } = await fixture();
  try {
    const html = articlePage();
    expect(Buffer.byteLength(html)).toBeGreaterThan(32_768);
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () => htmlResponse(html),
    });
    const result = await tool.execute('web-md', { url: 'https://public.example/bowls' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text.startsWith('Untrusted web content follows.')).toBe(true);
    expect(text).toContain('Format: main content converted to Markdown');
    expect(text).toContain('Title: Plastic bowls explained');
    expect(text).toContain('A plastic bowl is light, cheap and hard to break.');
    expect(text).toContain('[care guide](https://public.example/care)');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('Section 399');
    expect(text).not.toContain('var tracking');
    expect(text).not.toContain('photo.jpg');
    expect(result.details).toEqual({
      url: 'https://public.example/bowls',
      status: 200,
      format: 'markdown',
      truncated: false,
    });
    expect(
      store.db
        .prepare<[], { state: string; result_text: string }>(
          "SELECT state, result_text FROM tool_calls WHERE tool_call_id = 'web-md'",
        )
        .get(),
    ).toEqual({ state: 'success', result_text: text });
  } finally {
    store.close();
  }
});

test('web_fetch returns the original HTML when raw is requested', async () => {
  const { store, context } = await fixture();
  try {
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () => htmlResponse('<html><body><p>raw body</p></body></html>'),
    });
    const result = await tool.execute('web-raw', { url: 'https://public.example/', raw: true });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('<p>raw body</p>');
    expect(text).not.toContain('Format:');
    expect(result.details).toMatchObject({ format: 'raw', truncated: false });
  } finally {
    store.close();
  }
});

test('web_fetch truncates converted Markdown to the result budget on a UTF-8 boundary', async () => {
  const { store, context } = await fixture();
  try {
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () =>
        htmlResponse(
          `<html><head><title>长文</title></head><body><article><p>${'碗'.repeat(20_000)}</p></article></body></html>`,
        ),
    });
    const result = await tool.execute('web-long', { url: 'https://public.example/long' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    expect(text.endsWith('碗\n[content truncated]')).toBe(true);
    expect(result.details).toMatchObject({ format: 'markdown', truncated: true });
  } finally {
    store.close();
  }
});

test('web_fetch HTML conversion makes no network requests of its own', async () => {
  const { store, context } = await fixture();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return htmlResponse('<html><head><title>video</title></head><body></body></html>');
      },
    });
    // Both URLs match Defuddle extractors that call YouTube/X APIs when async extraction is on.
    await tool.execute('web-youtube', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    await tool.execute('web-x', { url: 'https://x.com/someone/status/123' });
    expect(requests).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    store.close();
  }
});

test('web_fetch asks for Markdown and passes site-served Markdown through unchanged', async () => {
  const { store, context } = await fixture();
  try {
    const accepts: string[] = [];
    const markdown = '# Workers\n\n<p>Served as Markdown, not converted.</p>\n';
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async (_url, _address, accept) => {
        accepts.push(accept);
        return accept.startsWith('text/markdown')
          ? new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
          : htmlResponse('<html><body><p>html body</p></body></html>');
      },
    });
    const served = await tool.execute('web-served-md', { url: 'https://docs.example/workers' });
    const text = served.content[0]?.type === 'text' ? served.content[0].text : '';
    expect(text).toContain('Content-Type: text/markdown; charset=utf-8');
    expect(text).toContain('Format: Markdown served by the site');
    expect(text.endsWith(markdown)).toBe(true);
    expect(served.details).toMatchObject({ format: 'markdown', truncated: false });

    const raw = await tool.execute('web-served-raw', { url: 'https://docs.example/workers', raw: true });
    const rawText = raw.content[0]?.type === 'text' ? raw.content[0].text : '';
    expect(rawText).toContain('<p>html body</p>');
    expect(raw.details).toMatchObject({ format: 'raw' });

    expect(accepts[0]?.startsWith('text/markdown, text/html;q=0.9')).toBe(true);
    expect(accepts[1]).not.toContain('text/markdown');
  } finally {
    store.close();
  }
});

test('web_fetch.accept_markdown false loads and stops advertising Markdown', async () => {
  const { store, config, context } = await fixture((file) => {
    file.web_fetch = { accept_markdown: false };
  });
  try {
    expect(config.web_fetch).toEqual({ accept_markdown: false });
    const accepts: string[] = [];
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      acceptMarkdown: false,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async (_url, _address, accept) => {
        accepts.push(accept);
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await tool.execute('web-no-md', { url: 'https://docs.example/' });
    expect(accepts).toEqual(['text/html, application/xhtml+xml, application/json, text/plain;q=0.9, */*;q=0.1']);
  } finally {
    store.close();
  }
});
