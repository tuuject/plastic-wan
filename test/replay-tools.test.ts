import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PublicModel } from '@plasticwan/image-service';
import Type, { type TSchema } from 'typebox';
import { expect, test } from 'vitest';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { AddMemoryInputSchema, DeleteMemoryInputSchema } from '../src/context/memory.ts';
import {
  createReplayTools,
  type ReplayToolDefinition,
  type ReplayToolRegistry,
  type ReplayTools,
} from '../src/orchestration/replay-tools.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, SystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, DeleteAlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { ImageGenerateInputSchema, ListImageModelsInputSchema } from '../src/plugins/image/image.ts';

const EMPTY_PARAMETERS = Type.Object({}, { additionalProperties: false });
const ReadParameters = Type.Object(
  { uri: Type.String(), base: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

function definition(name: string, parameters: TSchema = EMPTY_PARAMETERS): ReplayToolDefinition {
  return {
    name,
    label: name,
    description: `${name} current definition`,
    parameters,
  };
}

function replayInput(options: {
  tools?: ReplayToolDefinition[];
  capabilities?: ReplayToolDefinition[];
}): ReplayToolRegistry {
  return { tools: options.tools ?? [], capabilities: options.capabilities ?? [] };
}

function toolOf(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`No replay tool named ${name}`);
  }
  return found;
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((entry) => (entry.type === 'text' ? [entry.text] : [])).join('\n');
}

function envelopeOf(result: AgentToolResult<unknown>): { text: string; refs?: Record<string, string[]> } {
  return JSON.parse(textOf(result)) as { text: string; refs?: Record<string, string[]> };
}

function callCapability(
  replay: ReplayTools,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  return toolOf(replay.tools, 'execute').execute(toolCallId, { action: 'call', tool: name, input }) as Promise<
    AgentToolResult<unknown>
  >;
}

/** A credential-free PublicModel directory entry; `description` is optional. */
function imageModel(overrides: Partial<PublicModel> = {}): PublicModel {
  return {
    id: 'model-a',
    name: 'Model A',
    provider: 'openrouter',
    upstreamModel: 'org/model-a',
    providerTag: 'image',
    capabilities: {
      imageInput: false,
      maxInputImages: 0,
      maxOutputs: 4,
      aspectRatios: ['1:1', '16:9'],
      resolutionClasses: ['auto', 'medium'],
    },
    ...overrides,
  };
}

test('send synthesizes text, image, and sticker messages and preserves arguments', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send', SendInputSchema)] }),
    SystemResources.empty(),
  );
  const send = toolOf(replay.tools, 'send');
  const textResult = await send.execute('send-1', { kind: 'text', text: 'hello', reply_to_message_id: '42' });
  expect(textResult.content).toEqual([{ type: 'text', text: 'Sent Telegram message 1' }]);
  expect(textResult.details).toEqual({ telegramMessageId: '1' });
  const imageId = '00000000-0000-4000-8000-000000000000';
  const imageResult = await send.execute('send-2', { kind: 'image', image_generation_id: imageId, text: 'picture' });
  expect(imageResult.content).toEqual([{ type: 'text', text: 'Sent Telegram message 2' }]);
  const stickerResult = await send.execute('send-3', { kind: 'sticker', sticker_ref: 'stk_abc' });
  expect(stickerResult.details).toEqual({ telegramMessageId: '3' });
  // kind may be omitted for text, mirroring the production send semantics.
  await send.execute('send-4', { text: 'no kind' });
  expect(replay.outputs).toEqual([
    {
      tool_call_id: 'send-1',
      tool_name: 'send',
      arguments: { kind: 'text', text: 'hello', reply_to_message_id: '42' },
      reply_to_message_id: '42',
    },
    {
      tool_call_id: 'send-2',
      tool_name: 'send',
      arguments: { kind: 'image', image_generation_id: imageId, text: 'picture' },
      reply_to_message_id: null,
    },
    {
      tool_call_id: 'send-3',
      tool_name: 'send',
      arguments: { kind: 'sticker', sticker_ref: 'stk_abc' },
      reply_to_message_id: null,
    },
    { tool_call_id: 'send-4', tool_name: 'send', arguments: { text: 'no kind' }, reply_to_message_id: null },
  ]);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'send-1', tool_name: 'send', mode: 'synthetic' },
    { tool_call_id: 'send-2', tool_name: 'send', mode: 'synthetic' },
    { tool_call_id: 'send-3', tool_name: 'send', mode: 'synthetic' },
    { tool_call_id: 'send-4', tool_name: 'send', mode: 'synthetic' },
  ]);
  await expect(send.execute('send-5', {})).rejects.toThrow('send input fields do not match its kind');
  await expect(
    send.execute('send-6', { kind: 'sticker', sticker_ref: 'stk_abc', parse_mode: 'MarkdownV2' }),
  ).rejects.toThrow('send input fields do not match its kind');
  await expect(send.execute('send-7', { kind: 'text', text: 'x'.repeat(5_000) })).rejects.toThrow(
    'send input does not match the tool schema',
  );
  expect(replay.outputs).toHaveLength(4);
});

test('send rejects repeated reply targets within the scene without recording another output', async () => {
  const registry = replayInput({ tools: [definition('send', SendInputSchema)] });
  const replay = createReplayTools(registry, SystemResources.empty(), { replyMessageIds: new Set(['42', '43']) });
  const send = toolOf(replay.tools, 'send');
  await send.execute('first', { text: 'first answer', reply_to_message_id: '42' });
  await expect(send.execute('duplicate-text', { text: 'different answer', reply_to_message_id: '42' })).rejects.toThrow(
    'reply_already_sent',
  );
  await expect(
    send.execute('duplicate-sticker', { kind: 'sticker', sticker_ref: 'stk_test', reply_to_message_id: '42' }),
  ).rejects.toThrow('reply_already_sent');
  await send.execute('other', { text: 'another discussion', reply_to_message_id: '43' });
  await send.execute('no-reply', { text: 'independent completion' });
  expect(replay.outputs.map((output) => output.reply_to_message_id)).toEqual(['42', '43', null]);
  expect(replay.dispatches).toHaveLength(5);
  // A replay is an isolated experiment, not a new read of production delivery state.
  const separate = createReplayTools(registry, SystemResources.empty());
  await toolOf(separate.tools, 'send').execute('fresh', { text: 'new scene', reply_to_message_id: '42' });
  expect(separate.outputs).toHaveLength(1);
});

test('send allows repeated reply targets when configured without bypassing scene visibility', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send', SendInputSchema)] }),
    SystemResources.empty(),
    { allowReplyMessageMultipleTimes: true, replyMessageIds: new Set(['42']) },
  );
  const send = toolOf(replay.tools, 'send');
  await send.execute('first', { text: 'first answer', reply_to_message_id: '42' });
  await send.execute('second', { kind: 'sticker', sticker_ref: 'stk_test', reply_to_message_id: '42' });
  await expect(send.execute('invisible', { text: 'not visible', reply_to_message_id: '43' })).rejects.toThrow(
    'reply_to_message_id is not visible',
  );
  expect(replay.outputs.map((output) => output.reply_to_message_id)).toEqual(['42', '42']);
  expect(replay.dispatches).toHaveLength(2);
});

test('memory capabilities use an in-memory map without a store', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [
        definition('add_memory', AddMemoryInputSchema),
        definition('delete_memory', DeleteMemoryInputSchema),
      ],
    }),
    SystemResources.empty(),
  );
  const added = envelopeOf(await callCapability(replay, 'exec-1', 'add_memory', { content: 'owner likes cats' }));
  const id = /^Saved memory (mem_[a-f0-9]{32}); it expires at /.exec(added.text)?.[1];
  if (id === undefined) {
    throw new Error(`Unexpected add_memory result: ${added.text}`);
  }
  expect(envelopeOf(await callCapability(replay, 'exec-2', 'delete_memory', { id }))).toEqual({
    text: `Memory ${id} deleted`,
  });
  expect(envelopeOf(await callCapability(replay, 'exec-3', 'delete_memory', { id }))).toEqual({
    text: `Memory ${id} was already gone`,
  });
  await expect(callCapability(replay, 'exec-4', 'add_memory', {})).rejects.toThrow(
    'execute.call input does not match the schema of add_memory',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'exec-1', tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' },
    { tool_call_id: 'exec-2', tool_name: 'execute', mode: 'synthetic', capability: 'delete_memory' },
    { tool_call_id: 'exec-3', tool_name: 'execute', mode: 'synthetic', capability: 'delete_memory' },
    { tool_call_id: 'exec-4', tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' },
  ]);
});

test('alarm capabilities schedule, list, and delete in memory and start unseeded', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [
        definition('alarm', AlarmInputSchema),
        definition('list_alarm', ListAlarmInputSchema),
        definition('delete_alarm', DeleteAlarmInputSchema),
      ],
    }),
    SystemResources.empty(),
  );
  const unseeded = envelopeOf(await callCapability(replay, 'alarm-list-1', 'list_alarm', {}));
  expect(JSON.parse(unseeded.text)).toEqual({ items: [] });
  const created = envelopeOf(
    await callCapability(replay, 'alarm-1', 'alarm', {
      target_user_id: '42',
      summary: 'check the oven',
      datetime: '2030-01-02T03:04:05Z',
    }),
  );
  expect(created.text).toBe('Scheduled alarm 1 for 2030-01-02T03:04:05.000Z');
  const listed = envelopeOf(await callCapability(replay, 'alarm-list-2', 'list_alarm', {}));
  expect(JSON.parse(listed.text)).toEqual({
    items: [{ id: '1', scheduled_at: '2030-01-02T03:04:05.000Z', summary: 'check the oven' }],
  });
  expect(envelopeOf(await callCapability(replay, 'alarm-3', 'delete_alarm', { id: '1' }))).toEqual({
    text: 'Cancelled alarm 1',
  });
  await expect(callCapability(replay, 'alarm-4', 'delete_alarm', { id: '1' })).rejects.toThrow(
    'execute.call delete_alarm failed: alarm not found',
  );
});

test('image_generate synthesizes distinct generation ids without the image bridge', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('image_generate', ImageGenerateInputSchema)],
    }),
    SystemResources.empty(),
  );
  const first = envelopeOf(await callCapability(replay, 'image-1', 'image_generate', { prompt: 'a cat' }));
  expect(first.text).toMatch(
    /^Generation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} submitted on model replay \(1 output\(s\)\)\./,
  );
  const second = envelopeOf(
    await callCapability(replay, 'image-2', 'image_generate', { prompt: 'a dog', output_count: 3 }),
  );
  expect(second.text).toContain('(3 output(s))');
  expect(second.text).not.toBe(first.text);
  expect(replay.outputs).toEqual([]);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'image-1', tool_name: 'execute', mode: 'synthetic', capability: 'image_generate' },
    { tool_call_id: 'image-2', tool_name: 'execute', mode: 'synthetic', capability: 'image_generate' },
  ]);
});

test('list_image_models pages the configured directory with descriptions and no credentials', async () => {
  const models = [
    imageModel({ id: 'line-art', name: 'Line Art', description: 'clean line art, good for stickers' }),
    imageModel({ id: 'anime', name: 'Anime', description: 'anime style' }),
    imageModel({ id: 'photo', name: 'Photo' }),
    imageModel({ id: 'pixel', name: 'Pixel' }),
    imageModel({ id: 'ink', name: 'Ink' }),
  ];
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('list_image_models', ListImageModelsInputSchema)],
    }),
    SystemResources.empty(),
    { imageModels: models },
  );
  const first = envelopeOf(await callCapability(replay, 'models-1', 'list_image_models', {}));
  expect(JSON.parse(first.text)).toEqual({ models: models.slice(0, 4), total: 5, next_offset: 4 });
  expect(first.text).toContain('clean line art, good for stickers');
  // The directory is credential-free by contract; the serialized page must never
  // mention credentials, and nothing here can submit a generation or touch the bridge.
  expect(first.text).not.toMatch(/credential/i);
  const second = envelopeOf(await callCapability(replay, 'models-2', 'list_image_models', { offset: 4 }));
  expect(JSON.parse(second.text)).toEqual({ models: models.slice(4), total: 5, next_offset: null });
  await expect(callCapability(replay, 'models-3', 'list_image_models', { offset: 101 })).rejects.toThrow(
    'execute.call input does not match the schema of list_image_models',
  );
  await expect(callCapability(replay, 'models-4', 'list_image_models', { offset: -1 })).rejects.toThrow(
    'execute.call input does not match the schema of list_image_models',
  );
  expect(replay.outputs).toEqual([]);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'models-1', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
    { tool_call_id: 'models-2', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
    { tool_call_id: 'models-3', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
    { tool_call_id: 'models-4', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
  ]);
});

test('list_image_models without a catalog is an explicit empty page and stays blocked when unregistered', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('list_image_models', ListImageModelsInputSchema)],
    }),
    SystemResources.empty(),
  );
  const empty = envelopeOf(await callCapability(replay, 'models-1', 'list_image_models', {}));
  expect(JSON.parse(empty.text)).toEqual({ models: [], total: 0, next_offset: null });
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'models-1', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
  ]);
  // A registry that never listed the capability still refuses it: the current
  // registry is the only source of truth for what a scene may call.
  const without = createReplayTools(
    replayInput({ tools: [definition('execute')], capabilities: [] }),
    SystemResources.empty(),
  );
  await expect(callCapability(without, 'models-2', 'list_image_models', {})).rejects.toThrow(
    'execute has no capability named list_image_models',
  );
  expect(without.dispatches).toEqual([
    { tool_call_id: 'models-2', tool_name: 'execute', mode: 'blocked', capability: 'list_image_models' },
  ]);
});

test('zzz reports a synthetic sleep transition without writing global state', async () => {
  const replay = createReplayTools(replayInput({ tools: [definition('zzz')] }), SystemResources.empty());
  const result = await toolOf(replay.tools, 'zzz').execute('zzz-1', {});
  const details = result.details as { sleep_until: string; entered: boolean };
  expect(details.entered).toBe(true);
  expect(Date.parse(details.sleep_until)).toBeGreaterThan(Date.now());
  expect(textOf(result)).toBe(`Sleeping until ${details.sleep_until}`);
  expect(replay.dispatches).toEqual([{ tool_call_id: 'zzz-1', tool_name: 'zzz', mode: 'synthetic' }]);
});

test('read serves bundled system resources and refuses paths outside the tree', async () => {
  const resources = await SystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR);
  const skill = resources.skills[0];
  if (skill === undefined) {
    throw new Error('Bundled system skills are missing');
  }
  const replay = createReplayTools(replayInput({ tools: [definition('read', ReadParameters)] }), resources);
  const read = toolOf(replay.tools, 'read');
  const result = await read.execute('read-1', { uri: skill.uri });
  expect(textOf(result).length).toBeGreaterThan(0);
  expect(result.details).toMatchObject({ uri: skill.uri });
  await expect(read.execute('read-2', { uri: 'file:///etc/passwd' })).rejects.toThrow('read failed: invalid_uri');
  await expect(read.execute('read-3', { uri: 'system:///skills/../../etc/passwd' })).rejects.toThrow(
    'read failed: invalid_uri',
  );
  await expect(read.execute('read-4', { uri: 'system:///skills/memory/missing.md' })).rejects.toThrow(
    'read failed: resource_not_found',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'read-1', tool_name: 'read', mode: 'live_read' },
    { tool_call_id: 'read-2', tool_name: 'read', mode: 'live_read' },
    { tool_call_id: 'read-3', tool_name: 'read', mode: 'live_read' },
    { tool_call_id: 'read-4', tool_name: 'read', mode: 'live_read' },
  ]);
});

test('unknown top-level tools and MCP tools are blocked', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send_file'), definition('mcp__demo__search')] }),
    SystemResources.empty(),
  );
  await expect(toolOf(replay.tools, 'send_file').execute('call-1', { path: 'x' })).rejects.toThrow(
    'scene test blocks tool send_file',
  );
  await expect(toolOf(replay.tools, 'mcp__demo__search').execute('call-2', { query: 'x' })).rejects.toThrow(
    'scene test blocks tool mcp__demo__search',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'call-1', tool_name: 'send_file', mode: 'blocked' },
    { tool_call_id: 'call-2', tool_name: 'mcp__demo__search', mode: 'blocked' },
  ]);
  expect(replay.outputs).toEqual([]);
});

test('execute denies primitives, unknown names, and side-effect-free production capabilities', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('web_fetch', Type.Object({ url: Type.String() })), definition('search_stickers')],
    }),
    SystemResources.empty(),
  );
  await expect(callCapability(replay, 'exec-1', 'web_fetch', { url: 'https://example.com' })).rejects.toThrow(
    'execute.call web_fetch failed: replay blocks capability web_fetch',
  );
  await expect(callCapability(replay, 'exec-2', 'search_stickers', {})).rejects.toThrow(
    'replay blocks capability search_stickers',
  );
  await expect(callCapability(replay, 'exec-3', 'read', { uri: 'system:///skills/x/SKILL.md' })).rejects.toThrow(
    'execute cannot dispatch the runtime primitive read; call it directly',
  );
  await expect(callCapability(replay, 'exec-4', 'not_a_capability', {})).rejects.toThrow(
    'execute has no capability named not_a_capability',
  );
  // A known synthetic name is still blocked when the snapshot never listed it.
  await expect(callCapability(replay, 'exec-5', 'add_memory', { content: 'x' })).rejects.toThrow(
    'execute has no capability named add_memory',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'exec-1', tool_name: 'execute', mode: 'blocked', capability: 'web_fetch' },
    { tool_call_id: 'exec-2', tool_name: 'execute', mode: 'blocked', capability: 'search_stickers' },
    { tool_call_id: 'exec-3', tool_name: 'execute', mode: 'blocked', capability: 'read' },
    { tool_call_id: 'exec-4', tool_name: 'execute', mode: 'blocked', capability: 'not_a_capability' },
    { tool_call_id: 'exec-5', tool_name: 'execute', mode: 'blocked', capability: 'add_memory' },
  ]);
  expect(replay.outputs).toEqual([]);
});

test('execute search and help stay inside the current registry', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [
        definition('web_fetch', Type.Object({ url: Type.String() })),
        definition('add_memory', AddMemoryInputSchema),
      ],
    }),
    SystemResources.empty(),
  );
  const execute = toolOf(replay.tools, 'execute');
  const search = await execute.execute('exec-5', { action: 'search', query: 'fetch a web page' });
  expect(JSON.parse(textOf(search))).toEqual([{ name: 'web_fetch', summary: 'web_fetch' }]);
  const help = await execute.execute('exec-6', { action: 'help', tool: 'add_memory' });
  expect(JSON.parse(textOf(help))).toMatchObject({ name: 'add_memory', description: 'add_memory current definition' });
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'exec-5', tool_name: 'execute', mode: 'synthetic' },
    { tool_call_id: 'exec-6', tool_name: 'execute', mode: 'synthetic' },
  ]);
});

test('an aborted signal stops every replay tool before dispatch', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('send', SendInputSchema), definition('read', ReadParameters), definition('execute')],
      capabilities: [definition('add_memory', AddMemoryInputSchema)],
    }),
    SystemResources.empty(),
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    toolOf(replay.tools, 'send').execute('abort-1', { kind: 'text', text: 'hi' }, controller.signal),
  ).rejects.toThrow();
  await expect(
    toolOf(replay.tools, 'read').execute('abort-2', { uri: 'system:///skills/memory/SKILL.md' }, controller.signal),
  ).rejects.toThrow();
  await expect(
    toolOf(replay.tools, 'execute').execute(
      'abort-3',
      { action: 'call', tool: 'add_memory', input: { content: 'x' } },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(replay.outputs).toEqual([]);
  expect(replay.dispatches).toEqual([]);
});

test('replay tools import no production wiring and need no store', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'orchestration', 'replay-tools.ts'), 'utf8');
  for (const banned of [
    'store/database.ts',
    'store/schema.ts',
    'store/long-tasks.ts',
    'drizzle-orm',
    'platform/config.ts',
    'orchestration/agent-runtime',
    'application.ts',
    'capabilities/mcp.ts',
  ]) {
    expect(source).not.toContain(banned);
  }
  expect(source).not.toMatch(/\bSqliteStore\b/);
});
