import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_LENGTH } from '../packages/cli/src/args.ts';
import {
  errorDocument,
  jsonResponse,
  onlyRequest,
  requestPath,
  requestQuery,
  runCli,
  startServer,
} from './cli-harness.ts';

const API_KEY = 'test-api-key-inspect';
const ENV = (baseUrl: string) => ({ PLASTICWAN_ENDPOINT: baseUrl, PLASTICWAN_API_KEY: API_KEY });

const CONFIG_VIEW = {
  source: 'active',
  generation: 12,
  active_hash: 'active-hash',
  file_hash: 'file-hash',
  config: { agent: { model: 'test-model' }, telegram: { token_env: 'TELEGRAM_TOKEN' } },
};

const PROMPT_GLOBAL = {
  source: 'active',
  scope: 'global',
  chat_id: null,
  prompt: 'global prompt body',
  core_read_only: true,
  generation: 12,
  hash: 'prompt-hash',
};

const PROMPT_GROUP = {
  source: 'file',
  scope: 'group',
  chat_id: '-100123',
  prompt: 'group prompt body',
  core_read_only: true,
  generation: 3,
  hash: 'group-hash',
};

const ACTIVE_PROMPTS = {
  source: 'active',
  source_invocation_id: '42',
  global_prompt: 'current global',
  group_prompt: 'current group',
  template_values: { time: '2026-10-06 10:00' },
  core_read_only: true,
};

const PREFLIGHT = {
  available: true,
  reason: null,
  message: null,
  prompt_overrides_available: true,
  omitted_images: 0,
  scene: {
    cutoff_at: '2026-10-06T10:00:00Z',
    source_bucket_id: '1',
    message_count: 1,
    history_count: 0,
    omitted_messages: 0,
  },
  fidelity: {
    input: 'historical_public_chat',
    prompt_selection: 'current_chat_config',
    tool_selection: 'current_registry',
  },
};

const LIST_ITEM = {
  id: '9',
  state: 'completed',
  created_at: '2026-10-06T12:00:00.000Z',
  chat: { telegram_chat_id: '-100123', title: 'Inspect Group', username: null, message_thread_id: 0 },
  total_tokens: 10,
  total_cost: 0.001,
  matched_messages: [
    {
      source: 'incoming',
      telegram_message_id: '55',
      telegram_send_id: null,
      at: '2026-10-06T11:58:00Z',
      text: 'hello keyword',
    },
    {
      source: 'bot',
      telegram_message_id: null,
      telegram_send_id: '77',
      at: '2026-10-06T11:59:30Z',
      text: 'matched reply',
    },
  ],
};

const PLAIN_ITEM = {
  id: '9',
  state: 'completed',
  created_at: '2026-10-06T12:00:00.000Z',
  chat: { telegram_chat_id: '-100123', title: 'Inspect Group', username: null, message_thread_id: 0 },
  total_tokens: 10,
  total_cost: 0.001,
};

describe('plasticwan-utils inspection commands', () => {
  it('config show defaults to the active source and prints pretty JSON without --json', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, CONFIG_VIEW);
    });
    try {
      const result = await runCli(['config', 'show'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(CONFIG_VIEW);
      expect(result.stdout).toContain('\n  ');
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      expect(requestPath(request)).toBe('/api/config/view');
      expect(requestQuery(request)).toEqual({ source: 'active' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('config show --source file sends the file source and --json keeps one compact document', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...CONFIG_VIEW, source: 'file' });
    });
    try {
      const result = await runCli(['config', 'show', '--source', 'file', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(requestQuery(onlyRequest(server))).toEqual({ source: 'file' });
      expect(result.stdout).toBe(`${JSON.stringify({ ...CONFIG_VIEW, source: 'file' })}\n`);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('config show refuses a response without the redacted config object', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { source: 'active', generation: 1 });
    });
    try {
      const result = await runCli(['config', 'show', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('prompt get global reads the current global prompt', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PROMPT_GLOBAL);
    });
    try {
      const result = await runCli(['prompt', 'get', 'global'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(PROMPT_GLOBAL);
      const request = onlyRequest(server);
      expect(requestPath(request)).toBe('/api/prompts/global');
      expect(requestQuery(request)).toEqual({ source: 'active' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('prompt get group sends the chat id and file source', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PROMPT_GROUP);
    });
    try {
      const result = await runCli(['prompt', 'get', 'group', '--chat', '-100123', '--source', 'file', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(PROMPT_GROUP);
      expect(requestQuery(onlyRequest(server))).toEqual({ source: 'file', chat: '-100123' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('prompt get refuses a response for another scope', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...PROMPT_GLOBAL, scope: 'group' });
    });
    try {
      const result = await runCli(['prompt', 'get', 'global', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation prompts returns the active prompt template for that conversation', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, ACTIVE_PROMPTS);
    });
    try {
      const result = await runCli(['invocation', 'prompts', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(ACTIVE_PROMPTS);
      const request = onlyRequest(server);
      expect(request.method).toBe('GET');
      expect(requestPath(request)).toBe('/api/invocations/42/prompts');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation prompts refuses a historical recorded template', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...ACTIVE_PROMPTS, source: 'recorded' });
    });
    try {
      const result = await runCli(['invocation', 'prompts', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('invalid_response');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation preflight prints the preflight document without posting', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PREFLIGHT);
    });
    try {
      const result = await runCli(['invocation', 'preflight', '42'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(PREFLIGHT);
      expect(server.requests).toHaveLength(1);
      expect(requestPath(onlyRequest(server))).toBe('/api/invocations/42/replay-preflight');
      expect(requestQuery(onlyRequest(server))).toEqual({});
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation preflight forwards --before-send as before_send_id without posting', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PREFLIGHT);
    });
    try {
      const result = await runCli(['invocation', 'preflight', '42', '--before-send', '123', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(PREFLIGHT);
      expect(server.requests).toHaveLength(1);
      expect(onlyRequest(server).method).toBe('GET');
      expect(requestPath(onlyRequest(server))).toBe('/api/invocations/42/replay-preflight');
      expect(requestQuery(onlyRequest(server))).toEqual({ before_send_id: '123' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation list forwards search and time filters verbatim and passes matched_messages through', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [LIST_ITEM], next_cursor: null });
    });
    try {
      const env = ENV(server.baseUrl);
      const filtered = await runCli(
        [
          'invocation',
          'list',
          '--search',
          '100%_literal',
          '--from',
          '2026-10-06 11:00',
          '--to',
          '2026-10-06T12:00:30.5+08:00',
          '--json',
        ],
        { env },
      );
      expect(filtered.code).toBe(0);
      expect(filtered.stderr).toBe('');
      expect(requestQuery(onlyRequest(server, 0))).toEqual({
        search: '100%_literal',
        from: '2026-10-06 11:00',
        to: '2026-10-06T12:00:30.5+08:00',
      });
      // The JSON document is exactly what the server returned: matched_messages included.
      expect(JSON.parse(filtered.stdout)).toEqual({ items: [LIST_ITEM], next_cursor: null });

      const at = await runCli(['invocation', 'list', '--at', '2024-02-29T12:00:30', '--json'], { env });
      expect(at.code).toBe(0);
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ at: '2024-02-29T12:00:30' });

      const ascending = await runCli(
        ['invocation', 'list', '--from', '2026-10-06T00:00:00Z', '--to', '2026-10-06T09:00:00+08:00', '--json'],
        { env },
      );
      expect(ascending.code).toBe(0);
      expect(requestQuery(onlyRequest(server, 2))).toEqual({
        from: '2026-10-06T00:00:00Z',
        to: '2026-10-06T09:00:00+08:00',
      });

      // A keyword of exactly the maximum length is accepted; the rejected
      // overlong case is covered by the argument-validation suite.
      const longest = 'a'.repeat(MAX_SEARCH_LENGTH);
      const boundary = await runCli(['invocation', 'list', '--search', longest, '--json'], { env });
      expect(boundary.code).toBe(0);
      expect(requestQuery(onlyRequest(server, 3))).toEqual({ search: longest });
    } finally {
      await server.close();
    }
  }, 30_000);

  it('invocation list leaves timezone-less ranges to the server instead of guessing an order', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [], next_cursor: null });
    });
    try {
      const result = await runCli(
        ['invocation', 'list', '--from', '2026-10-07 00:00:00', '--to', '2026-10-06 00:00:00.9', '--json'],
        { env: ENV(server.baseUrl) },
      );
      expect(result.code).toBe(0);
      expect(requestQuery(onlyRequest(server))).toEqual({
        from: '2026-10-07 00:00:00',
        to: '2026-10-06 00:00:00.9',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation list human output appends matched summaries without replacing the invocation time', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [LIST_ITEM], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list', '--search', 'keyword'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      const firstLine = result.stdout.split('\n')[0] ?? '';
      // The invocation's own time stays the leading timestamp; a matched message
      // time must never be presented as the invocation creation time.
      expect(firstLine).toContain(LIST_ITEM.created_at);
      expect(firstLine).not.toContain('2026-10-06T11:58:00Z');
      expect(result.stdout).toContain('matched incoming');
      expect(result.stdout).toContain('msg=55');
      expect(result.stdout).toContain('hello keyword');
      expect(result.stdout).toContain('matched bot');
      expect(result.stdout).toContain('send=77');
      expect(result.stdout).toContain('matched reply');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation list without matches keeps the old human format', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { items: [PLAIN_ITEM], next_cursor: null });
    });
    try {
      const result = await runCli(['invocation', 'list', '--limit', '5'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('matched');
      expect(result.stdout).toContain(`${PLAIN_ITEM.id} completed ${PLAIN_ITEM.created_at}`);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation replay slices before a send even when prompt overrides are unavailable', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/replay-preflight')) {
        jsonResponse(response, 200, { ...PREFLIGHT, prompt_overrides_available: false });
        return;
      }
      jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--before-send', '0042', '--confirm-paid', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(server.requests).toHaveLength(2);
      // The slice selection is a boundary, not a prompt override: it is sent as
      // the preflight query and the canonical POST body field.
      expect(requestQuery(onlyRequest(server, 0))).toEqual({ before_send_id: '42' });
      expect(requestPath(onlyRequest(server, 1))).toBe('/api/invocations/42/replay');
      expect(JSON.parse(onlyRequest(server, 1).body)).toEqual({ before_send_id: '42' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('refuses a sliced replay without --confirm-paid before any HTTP request', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, PREFLIGHT);
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--before-send', '123', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(errorDocument(result)).toEqual({
        error: 'confirm_paid_required',
        message: 'invocation replay --before-send requires --confirm-paid to confirm the billed model call',
      });
      // Not even the free preflight leaves the client: the billed slice is
      // refused as an argument error before any request is built.
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('keeps an unsliced replay unchanged when --confirm-paid is also given', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/replay-preflight')) {
        jsonResponse(response, 200, PREFLIGHT);
        return;
      }
      jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--confirm-paid', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code, result.stderr).toBe(0);
      expect(server.requests).toHaveLength(2);
      // The flag is only a required acknowledgement for a slice; without one
      // the request stays byte-for-byte the plain replay it always was.
      expect(requestQuery(onlyRequest(server, 0))).toEqual({});
      expect(JSON.parse(onlyRequest(server, 1).body)).toEqual({});
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation replay does not post when the slice preflight refuses', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, {
        ...PREFLIGHT,
        available: false,
        reason: 'replay_slice_target_invalid',
        message: 'before_send_id does not identify a successful send of this invocation',
      });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--before-send', '123', '--confirm-paid', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(server.requests).toHaveLength(1);
      expect(requestQuery(onlyRequest(server))).toEqual({ before_send_id: '123' });
      expect(errorDocument(result)).toEqual({
        error: 'replay_slice_target_invalid',
        message: 'before_send_id does not identify a successful send of this invocation',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('invocation replay still refuses prompt overrides alongside a slice without posting', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...PREFLIGHT, prompt_overrides_available: false });
    });
    try {
      const result = await runCli(
        ['invocation', 'replay', '42', '--global-prompt', '-', '--before-send', '123', '--confirm-paid', '--json'],
        { env: ENV(server.baseUrl), stdin: 'override' },
      );
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('replay_prompt_parts_unavailable');
      expect(server.requests).toHaveLength(1);
      expect(requestQuery(onlyRequest(server))).toEqual({ before_send_id: '123' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('replay reports the preflight reason and message without posting when unavailable', async () => {
    const unavailable = {
      ...PREFLIGHT,
      available: false,
      reason: 'replay_source_unfinished',
      message: 'Replay requires a finished invocation',
    };
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, unavailable);
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(server.requests).toHaveLength(1);
      expect(errorDocument(result)).toEqual({
        error: 'replay_source_unfinished',
        message: 'Replay requires a finished invocation',
      });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('replay posts current prompt overrides without a recorded prompt layer', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/replay-preflight')) {
        jsonResponse(response, 200, PREFLIGHT);
      } else {
        jsonResponse(response, 200, { error: null });
      }
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--global-prompt', '-', '--json'], {
        env: ENV(server.baseUrl),
        stdin: 'override',
      });
      expect(result.code).toBe(0);
      expect(server.requests).toHaveLength(2);
      expect(JSON.parse(onlyRequest(server, 1).body)).toEqual({ global_prompt: 'override' });
    } finally {
      await server.close();
    }
  }, 20_000);

  it('rejects a prompt override when preflight does not authorize it, without posting', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, { ...PREFLIGHT, prompt_overrides_available: false });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--global-prompt', '-', '--json'], {
        env: ENV(server.baseUrl),
        stdin: 'override',
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('replay_prompt_parts_unavailable');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('replay without overrides still posts when prompt overrides are unavailable', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/replay-preflight')) {
        jsonResponse(response, 200, { ...PREFLIGHT, prompt_overrides_available: false });
        return;
      }
      jsonResponse(response, 200, { status: 'started', invocation_id: '43', error: null });
    });
    try {
      const result = await runCli(['invocation', 'replay', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(server.requests).toHaveLength(2);
      expect(requestPath(onlyRequest(server, 1))).toBe('/api/invocations/42/replay');
      expect(JSON.parse(onlyRequest(server, 1).body)).toEqual({});
    } finally {
      await server.close();
    }
  }, 20_000);

  it('redacts the API key echoed by the new endpoints', async () => {
    const echo = `secret ${API_KEY}`;
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/config/view') {
        jsonResponse(response, 200, { ...CONFIG_VIEW, config: { note: echo } });
        return;
      }
      if (path.startsWith('/api/prompts/')) {
        jsonResponse(response, 200, { ...PROMPT_GLOBAL, prompt: echo });
        return;
      }
      if (path.endsWith('/prompts')) {
        jsonResponse(response, 200, { ...ACTIVE_PROMPTS, group_prompt: echo });
        return;
      }
      jsonResponse(response, 200, { ...PREFLIGHT, message: echo });
    });
    try {
      const env = ENV(server.baseUrl);
      const runs: readonly (readonly string[])[] = [
        ['config', 'show', '--json'],
        ['prompt', 'get', 'global', '--json'],
        ['invocation', 'prompts', '42', '--json'],
        ['invocation', 'preflight', '42', '--json'],
      ];
      for (const args of runs) {
        const result = await runCli(args, { env });
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stdout, args.join(' ')).not.toContain(API_KEY);
        expect(result.stdout, args.join(' ')).toContain('[redacted]');
        // Redaction must not corrupt the JSON document.
        expect(() => JSON.parse(result.stdout), args.join(' ')).not.toThrow();
      }
    } finally {
      await server.close();
    }
  }, 30_000);

  it('rejects unknown or misplaced subcommands and flags before any request', async () => {
    const server = await startServer((_request, response) => {
      jsonResponse(response, 200, {});
    });
    try {
      const env = ENV(server.baseUrl);
      const cases: readonly (readonly [readonly string[], string])[] = [
        [['config'], 'missing_subcommand'],
        [['config', 'get'], 'unknown_subcommand'],
        [['config', 'show', 'extra'], 'unexpected_argument'],
        [['config', 'show', '--chat', '-1'], 'unexpected_option'],
        [['prompt'], 'missing_subcommand'],
        [['prompt', 'set'], 'unknown_subcommand'],
        [['prompt', 'get'], 'unknown_subcommand'],
        [['prompt', 'get', 'global', '--limit', '1'], 'unexpected_option'],
        [['invocation', 'prompts'], 'missing_argument'],
        [['invocation', 'prompts', '1', 'extra'], 'unexpected_argument'],
        [['invocation', 'prompts', '1', '--before-send', '5'], 'unexpected_option'],
        [['invocation', 'prompts', '1', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--cursor', '2'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--search', 'x'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--from', '2026-10-06T12:00'], 'unexpected_option'],
        [['invocation', 'preflight', '1', '--before-send', '5', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'list', '--before-send', '5'], 'unexpected_option'],
        [['invocation', 'list', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'get', '1', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'media', '1', '--confirm-paid'], 'unexpected_option'],
        [['config', 'show', '--confirm-paid'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--confirm-paid'], 'unexpected_option'],
        [['login', '--confirm-paid'], 'unexpected_option'],
        [['doctor', '--confirm-paid'], 'unexpected_option'],
        [['invocation', 'get', '1', '--search', 'x'], 'unexpected_option'],
        [['invocation', 'media', '1', '--limit', '1'], 'unexpected_option'],
        [['invocation', 'media', '1', '--at', '2026-10-06T12:00'], 'unexpected_option'],
        [['invocation', 'media', 'abc'], 'invalid_id'],
        [['invocation', 'replay', '1', '--search', 'x'], 'unexpected_option'],
        [['invocation', 'replay', '1', '--at', '2026-10-06T12:00'], 'unexpected_option'],
        [['invocation', 'replay', '1', '--system-prompt', 'x'], 'invalid_arguments'],
        [['invocation', 'replay', '1', '--variant', 'original'], 'unexpected_option'],
        [['config', 'show', '--search', 'x'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--to', '2026-10-06T12:00'], 'unexpected_option'],
        [['prompt', 'get', 'global', '--before-send', '1'], 'unexpected_option'],
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

  it('prints the new commands in --help', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    for (const fragment of [
      'plasticwan-utils config show',
      'plasticwan-utils prompt get group',
      'plasticwan-utils invocation prompts',
      'plasticwan-utils invocation preflight',
      'plasticwan-utils invocation media',
      '--global-prompt',
      '--group-prompt',
      '--search',
      '--before-send',
      '--confirm-paid',
    ]) {
      expect(result.stdout).toContain(fragment);
    }
    expect(result.stdout).not.toContain('--system-prompt');
  }, 20_000);
});
