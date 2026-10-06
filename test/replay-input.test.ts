import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { afterEach, describe, expect, test } from 'vitest';
import { composeAgentPrompt } from '../src/platform/agent-prompt.ts';
import { loadConfig } from '../src/platform/config.ts';
import { purgeExpiredData, SqliteStore } from '../src/store/database.ts';
import { parseReplayInput, ReplayInputSerializationError, serializeReplayInput } from '../src/store/replay-input.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A minimal AgentTool stand-in: serializeReplayInput only reads the definition fields. */
function agentTool(name: string, label: string, description: string): AgentTool {
  return {
    name,
    label,
    description,
    parameters: Type.Object({ input: Type.String() }),
    execute: () => Promise.resolve({ content: [], details: null }),
  };
}

const LAYERS = {
  prefix: 'fixed prefix',
  global: 'global {{agent.model}}',
  middle: 'fixed middle',
  group: 'group {{timezone}}',
};
const TEMPLATE_VALUES = {
  agent: { provider: 'gateway', model: 'chat-model' },
  vision: { provider: 'vision-gateway', model: 'vision-model' },
  timezone: 'Asia/Shanghai',
};
const SYSTEM_PROMPT = composeAgentPrompt(LAYERS, TEMPLATE_VALUES);
const PROMPT = { layers: LAYERS, templateValues: TEMPLATE_VALUES };

function validSnapshot(overrides: Record<string, unknown> = {}, version: 1 | 2 = 1): string {
  return JSON.stringify({
    version,
    system_prompt: version === 2 ? SYSTEM_PROMPT : 'snapshot',
    ...(version === 2
      ? {
          prompt_parts: {
            prefix: LAYERS.prefix,
            global: LAYERS.global,
            middle: LAYERS.middle,
            group: LAYERS.group,
            template_values: TEMPLATE_VALUES,
          },
        }
      : {}),
    messages: [JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 })],
    tools: [],
    capabilities: [],
    omitted_images: 0,
    ...overrides,
  });
}

describe('replay input codec', () => {
  test('round-trips text, an assistant tool call and its tool result with the prompt layers', () => {
    const context: Context = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling the sender', textSignature: 'sig-1' },
            { type: 'toolCall', id: 'tc-1', name: 'send', arguments: { text: 'hi', reply_to: 'reply:9' } },
          ],
          api: 'openai-responses',
          provider: 'agent',
          model: 'agent-model',
          usage: {
            input: 120,
            output: 40,
            cacheRead: 10,
            cacheWrite: 0,
            totalTokens: 160,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'send',
          content: [{ type: 'text', text: 'delivered' }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [{ name: 'send', description: 'Send a message', parameters: Type.Object({ text: Type.String() }) }],
    };

    const json = serializeReplayInput(
      context,
      [
        agentTool('web_fetch', 'Web Fetch', 'Fetch a URL'),
        agentTool('search_stickers', 'Search Stickers', 'Search the sticker index'),
      ],
      PROMPT,
    );
    const { input, messages } = parseReplayInput(json);

    expect(input).toMatchObject({
      version: 2,
      system_prompt: SYSTEM_PROMPT,
      omitted_images: 0,
      prompt_parts: {
        prefix: 'fixed prefix',
        global: 'global {{agent.model}}',
        middle: 'fixed middle',
        group: 'group {{timezone}}',
        template_values: TEMPLATE_VALUES,
      },
    });
    expect(input.tools.map((tool) => tool.name)).toEqual(['send']);
    expect(input.capabilities.map((tool) => tool.name)).toEqual(['web_fetch', 'search_stickers']);
    expect(input.capabilities[0]).toMatchObject({
      name: 'web_fetch',
      label: 'Web Fetch',
      description: 'Fetch a URL',
    });
    // Everything the model saw survives the trip: text signatures, tool call
    // arguments and the tool result that answers the call.
    expect(messages).toEqual(context.messages);
    expect(messages).toHaveLength(3);
  });

  test('refuses to record a snapshot whose layers do not reproduce the system prompt', () => {
    const context: Context = { systemPrompt: 'a different prompt', messages: [], tools: [] };
    const failure = (): unknown => {
      try {
        serializeReplayInput(context, [], PROMPT);
      } catch (error) {
        return error;
      }
      throw new Error('expected serialization to fail');
    };
    expect(failure()).toBeInstanceOf(ReplayInputSerializationError);
    expect(failure()).toMatchObject({ code: 'prompt_parts_mismatch' });
    // An unrepresentable message fails with its own code instead of a partial record.
    const unrepresentable: Context = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'failed' }],
          api: 'openai-responses',
          provider: 'agent',
          model: 'agent-model',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error',
          timestamp: 2,
        },
      ],
      tools: [],
    };
    try {
      serializeReplayInput(unrepresentable, [], PROMPT);
      throw new Error('expected serialization to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported_message' });
    }
  });

  test('drops inline images, keeps the text and reports the omitted count', () => {
    const context: Context = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', data: 'BASE64_USER', mimeType: 'image/png' },
          ],
          timestamp: 10,
        },
        {
          role: 'toolResult',
          toolCallId: 'tc-img',
          toolName: 'read_image',
          content: [
            { type: 'image', data: 'BASE64_TOOL', mimeType: 'image/jpeg' },
            { type: 'text', text: 'receipt' },
          ],
          isError: false,
          timestamp: 11,
        },
      ],
    };

    const json = serializeReplayInput(context, [], PROMPT);
    expect(json).not.toContain('BASE64_USER');
    expect(json).not.toContain('BASE64_TOOL');
    expect(json).not.toContain('image/png');

    const { input, messages } = parseReplayInput(json);
    expect(input.version).toBe(2);
    expect(input.omitted_images).toBe(2);
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'what is this' }], timestamp: 10 });
    expect(messages[1]).toEqual({
      role: 'toolResult',
      toolCallId: 'tc-img',
      toolName: 'read_image',
      content: [{ type: 'text', text: 'receipt' }],
      isError: false,
      timestamp: 11,
    });
  });

  test('rejects malformed JSON and snapshots violating the version schema', () => {
    expect(() => parseReplayInput('{ not json')).toThrow();
    expect(() => parseReplayInput(validSnapshot({ extra: true }))).toThrow('Invalid replay input snapshot');
    expect(() => parseReplayInput(validSnapshot({ messages: [] }))).toThrow('Invalid replay input snapshot');
    expect(() => parseReplayInput(validSnapshot({ omitted_images: -1 }))).toThrow('Invalid replay input snapshot');
    expect(() => parseReplayInput(validSnapshot({ tools: 'send' }))).toThrow('Invalid replay input snapshot');
    expect(() =>
      parseReplayInput(validSnapshot({ tools: [{ name: 'send!', label: 'Send', description: 'd', parameters: {} }] })),
    ).toThrow('Invalid replay input snapshot');
    // Version 2 must carry prompt parts; the version marker alone is not enough.
    expect(() => parseReplayInput(validSnapshot({}, 2))).not.toThrow();
    expect(() => parseReplayInput(validSnapshot({ prompt_parts: undefined }, 2))).toThrow(
      'Invalid replay input snapshot',
    );
    expect(() => parseReplayInput(validSnapshot({ prompt_parts: { prefix: 'x' } }, 2))).toThrow(
      'Invalid replay input snapshot',
    );
  });

  test('rejects a version 2 snapshot whose layers no longer reproduce its system prompt', () => {
    expect(() => parseReplayInput(validSnapshot({ system_prompt: 'tampered' }, 2))).toThrow(
      'Invalid replay input snapshot',
    );
    // A stored template that is no longer renderable is corruption, not a prompt.
    expect(() =>
      parseReplayInput(
        validSnapshot(
          {
            system_prompt: '{{agent.api_key}}',
            prompt_parts: {
              prefix: '',
              global: '{{agent.api_key}}',
              middle: '',
              group: '',
              template_values: TEMPLATE_VALUES,
            },
          },
          2,
        ),
      ),
    ).toThrow('Invalid replay input snapshot');
  });

  test('rejects an unknown snapshot version', () => {
    expect(() => parseReplayInput(validSnapshot({ version: 3 }))).toThrow('Invalid replay input snapshot');
    expect(() => parseReplayInput(validSnapshot({ version: '1' }))).toThrow('Invalid replay input snapshot');
  });

  test('rejects duplicate tool definitions within either list', () => {
    const tool = { name: 'send', label: 'Send', description: 'd', parameters: {} };
    expect(() => parseReplayInput(validSnapshot({ tools: [tool, { ...tool }] }))).toThrow(
      'Duplicate replay tool definition',
    );
    const capability = { name: 'web_fetch', label: 'Web Fetch', description: 'd', parameters: {} };
    expect(() => parseReplayInput(validSnapshot({ capabilities: [capability, { ...capability }] }))).toThrow(
      'Duplicate replay tool definition',
    );
  });
});

describe('replay input retention', () => {
  test('purges replay snapshots with their invocation or model call rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-replay-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      const old = '2026-01-01T00:00:00.000Z';
      const fresh = '2026-06-20T00:00:00.000Z';
      // retention.online_days is 30 in the fixture config, so with this `now`
      // the cutoff sits at 2026-06-01: `old` rows fall outside it, `fresh` in.
      const now = new Date('2026-07-01T00:00:00.000Z');
      store.db.exec(`
        INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at)
        VALUES (1, 123, 123, 'private', '${old}');
        INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
        VALUES (1, 1, 0, '${old}', '${old}');
        INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at, finished_at)
        VALUES (900, 1, 'completed', 'realtime', '${old}', '${old}', '${old}', '${old}', '${old}'),
               (901, 1, 'completed', 'realtime', '${fresh}', '${fresh}', '${fresh}', '${fresh}', '${fresh}');
        INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at, finished_at)
        VALUES (9001, 900, 1, 'completed', 'h', 1, '${old}', '${old}'),
               (9002, 901, 1, 'completed', 'h', 1, '${fresh}', '${fresh}');
        INSERT INTO model_calls(id, invocation_id, role, provider, model, attempt, state, created_at, replay_input_json)
        VALUES (9101, 9001, 'agent', 'p', 'm', 1, 'success', '${old}', '{"marker":"old"}'),
               (9102, 9002, 'agent', 'p', 'm', 1, 'success', '${fresh}', '{"marker":"fresh"}'),
               (9103, NULL, 'doctor', 'p', 'm', 1, 'success', '${old}', '{"marker":"orphan-old"}'),
               (9104, NULL, 'doctor', 'p', 'm', 1, 'success', '${fresh}', '{"marker":"orphan-fresh"}');
      `);

      purgeExpiredData(store.orm, config, now);

      const count = (table: string, id: bigint): bigint | undefined =>
        store.db.prepare<[bigint], { n: bigint }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id)?.n;
      expect(count('invocations', 9001n)).toBe(0n);
      expect(count('invocations', 9002n)).toBe(1n);
      // The invocation cascade takes its replay snapshot with it.
      expect(count('model_calls', 9101n)).toBe(0n);
      expect(count('model_calls', 9102n)).toBe(1n);
      expect(
        store.db
          .prepare<[], { replay_input_json: string }>('SELECT replay_input_json FROM model_calls WHERE id = 9102')
          .get(),
      ).toEqual({ replay_input_json: '{"marker":"fresh"}' });
      // Invocation-less calls age out on their own schedule; the snapshot goes too.
      expect(count('model_calls', 9103n)).toBe(0n);
      expect(count('model_calls', 9104n)).toBe(1n);
      expect(count('buckets', 900n)).toBe(0n);
      expect(count('buckets', 901n)).toBe(1n);
      expect(
        store.db
          .prepare<[], { n: bigint }>('SELECT COUNT(*) AS n FROM model_calls WHERE replay_input_json IS NOT NULL')
          .get(),
      ).toEqual({ n: 2n });
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
