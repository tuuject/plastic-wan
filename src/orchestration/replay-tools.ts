import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type, { type TSchema } from 'typebox';
import Compile from 'typebox/compile';
import { capability, createExecuteTool, type ExecutableCapability } from '../capabilities/execute-tool.ts';
import { SendInputSchema } from '../capabilities/send-tool.ts';
import {
  AddMemoryInputSchema,
  DEFAULT_MEMORY_TTL_SECONDS,
  DeleteMemoryInputSchema,
  newMemoryId,
} from '../context/memory.ts';
import { SystemResourceError, type SystemResources } from '../platform/system-resources.ts';
import { AlarmInputSchema, DeleteAlarmInputSchema, ListAlarmInputSchema } from '../plugins/alarm/alarm.ts';
import { ImageGenerateInputSchema } from '../plugins/image/image.ts';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ToolAudit } from '../store/tool-audit.ts';

/**
 * Scene execution against current tool definitions, never their production
 * executors. Each call is either synthesized in memory
 * (`synthetic`), served from readonly system resources or scene-authorized
 * image bytes (`live_read`), or refused (`blocked`). Production executors for
 * web fetching, sticker search, Vision, unknown capabilities, unknown
 * top-level tools, and MCP tools are all deny-by-default.
 */

export type ReplayDispatchMode = 'synthetic' | 'live_read' | 'blocked';

export type ReplayToolDefinition = Pick<AgentTool, 'name' | 'label' | 'description' | 'parameters'>;
export interface ReplayToolRegistry {
  readonly tools: readonly ReplayToolDefinition[];
  readonly capabilities: readonly ReplayToolDefinition[];
}

export function toolDefinition(tool: ReplayToolDefinition): ReplayToolDefinition {
  return { name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters };
}

export interface ReplayToolOptions {
  readonly readImage?: (ref: string, signal: AbortSignal) => Promise<ImageContent>;
  readonly maxTextLength?: number;
  readonly disallowBlankLines?: boolean;
  readonly replyMessageIds?: ReadonlySet<string>;
}

/** One successfully synthesized `send`; `arguments` are the call's own input fields. */
export interface ReplayOutput {
  readonly tool_call_id: string;
  readonly tool_name: 'send';
  readonly arguments: Record<string, unknown>;
  readonly reply_to_message_id: string | null;
}

/**
 * One attempted tool dispatch. `mode` is the path the call took, not its
 * outcome: `blocked` calls are recorded before the refusal is thrown, a
 * `live_read` is recorded before the resource read is attempted, and a
 * `synthetic` call is recorded when its tool handles it without any external
 * effect. `capability` is set for `execute.call` dispatches and names the inner
 * capability the call targeted.
 */
export interface ReplayDispatch {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly mode: ReplayDispatchMode;
  readonly capability?: string;
}

export interface ReplayTools {
  readonly tools: AgentTool[];
  readonly outputs: ReplayOutput[];
  readonly dispatches: ReplayDispatch[];
}

interface MemoryEntry {
  readonly content: string;
  readonly expiresAt: string;
}

interface AlarmEntry {
  readonly scheduledAt: string;
  readonly summary: string;
}

interface ReplayState {
  readonly outputs: ReplayOutput[];
  readonly dispatches: ReplayDispatch[];
  readonly memories: Map<string, MemoryEntry>;
  readonly alarms: Map<string, AlarmEntry>;
  readonly imageResults: Map<string, ImageContent>;
  sends: number;
  nextAlarmId: bigint;
  readonly options: ReplayToolOptions;
}

/** Current-schema guards: model-facing schemas come from the active tool registry. */
const SendInputValidator = Compile(SendInputSchema);
const AddMemoryInputValidator = Compile(AddMemoryInputSchema);
const DeleteMemoryInputValidator = Compile(DeleteMemoryInputSchema);
const AlarmInputValidator = Compile(AlarmInputSchema);
const ListAlarmInputValidator = Compile(ListAlarmInputSchema);
const DeleteAlarmInputValidator = Compile(DeleteAlarmInputSchema);
const ImageGenerateInputValidator = Compile(ImageGenerateInputSchema);
const ZzzInputValidator = Compile(Type.Object({}, { additionalProperties: false }));
/**
 * Mirrors the current ReadInputSchema, which is module-private in
 * `capabilities/read-tool.ts`; the real path check is `SystemResources.resolve`.
 */
const ReplayReadInputValidator = Compile(
  Type.Object(
    {
      uri: Type.String({ minLength: 1, maxLength: 512 }),
      base: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
);

/** Mirrors store/sleep.ts; replay never writes the sleep state. */
const REPLAY_MINIMUM_SLEEP_MS = 8 * 60 * 60 * 1_000;
const REPLAY_IMAGE_MODEL_ID = 'replay';
const REPLAY_IMAGE_DEFAULT_OUTPUT_COUNT = 1;

/** Capabilities that have a real in-memory implementation; everything else is blocked. */
const SYNTHETIC_CAPABILITIES: ReadonlySet<string> = new Set([
  'add_memory',
  'delete_memory',
  'alarm',
  'list_alarm',
  'delete_alarm',
  'image_generate',
  'typing',
]);

export function createReplayTools(
  input: ReplayToolRegistry,
  resources: SystemResources,
  options: ReplayToolOptions = {},
): ReplayTools {
  const state: ReplayState = {
    outputs: [],
    dispatches: [],
    memories: new Map(),
    alarms: new Map(),
    imageResults: new Map(),
    sends: 0,
    nextAlarmId: 0n,
    options,
  };
  // The runner captures audit events from the tool results; replay only needs a
  // no-op sink so the same createExecuteTool dispatch path can run.
  const audit: ToolAudit = {
    start: () => ({ succeed: () => {}, fail: () => {} }),
    reject: () => {},
  };
  const execute = createExecuteTool({
    audit,
    capabilities: input.capabilities.map((definition) => replayCapability(definition, state)),
  });
  const registeredCapabilities = new Set(input.capabilities.map((definition) => definition.name));
  const tools: AgentTool[] = [];
  const seen = new Set<string>();
  for (const definition of input.tools) {
    if (seen.has(definition.name)) {
      throw new Error(`Duplicate replay tool definition: ${definition.name}`);
    }
    seen.add(definition.name);
    tools.push(replayTool(definition, state, resources, execute, registeredCapabilities));
  }
  return { tools, outputs: state.outputs, dispatches: state.dispatches };
}

function replayTool(
  definition: ReplayToolDefinition,
  state: ReplayState,
  resources: SystemResources,
  execute: AgentTool,
  registeredCapabilities: ReadonlySet<string>,
): AgentTool {
  if (definition.name === 'read') {
    return replayReadTool(definition, resources, state.dispatches);
  }
  if (definition.name === 'send') {
    return replaySendTool(definition, state);
  }
  if (definition.name === 'execute') {
    return replayExecuteTool(definition, execute, state, registeredCapabilities);
  }
  if (definition.name === 'zzz') {
    return replayZzzTool(definition, state.dispatches);
  }
  return replayBlockedTool(definition, state.dispatches);
}

/** The current registry supplies name, label, description, and parameters. */
function replayToolBase(definition: ReplayToolDefinition): {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
} {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
  };
}

function replayReadTool(
  definition: ReplayToolDefinition,
  resources: SystemResources,
  dispatches: ReplayDispatch[],
): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(ReplayReadInputValidator, params, 'read');
      dispatches.push({ tool_call_id: toolCallId, tool_name: 'read', mode: 'live_read' });
      try {
        const resource = await resources.readText(input.uri, input.base);
        return {
          content: [{ type: 'text' as const, text: resource.text }],
          details: { uri: resource.uri, truncated: resource.truncated },
        };
      } catch (error) {
        throw new Error(
          error instanceof SystemResourceError
            ? `read failed: ${error.code} (${error.message})`
            : 'read failed: read_error',
        );
      }
    },
  };
}

function replaySendTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      if (!SendInputValidator.Check(params)) {
        throw new Error('send input does not match the tool schema');
      }
      const input = params as Record<string, unknown>;
      if (!sendKindResolvable(input)) {
        throw new Error('send input fields do not match its kind');
      }
      if (typeof input.text === 'string') {
        if (input.text.length > (state.options.maxTextLength ?? 4_096)) {
          throw new Error('send text exceeds the current configured length limit');
        }
        if (state.options.disallowBlankLines === true && /\n\s*\n/.test(input.text)) {
          throw new Error('send text contains blank lines disallowed by current configuration');
        }
      }
      if (
        typeof input.reply_to_message_id === 'string' &&
        state.options.replyMessageIds !== undefined &&
        !state.options.replyMessageIds.has(input.reply_to_message_id)
      ) {
        throw new Error('reply_to_message_id is not visible in this scene');
      }
      state.dispatches.push({ tool_call_id: toolCallId, tool_name: 'send', mode: 'synthetic' });
      state.sends += 1;
      const messageId = String(state.sends);
      state.outputs.push({
        tool_call_id: toolCallId,
        tool_name: 'send',
        arguments: { ...input },
        reply_to_message_id: typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id : null,
      });
      return {
        content: [{ type: 'text' as const, text: `Sent Telegram message ${messageId}` }],
        details: { telegramMessageId: messageId },
      };
    },
  };
}

function replayZzzTool(definition: ReplayToolDefinition, dispatches: ReplayDispatch[]): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      if (!ZzzInputValidator.Check(params)) {
        throw new Error('zzz input does not match the tool schema');
      }
      dispatches.push({ tool_call_id: toolCallId, tool_name: 'zzz', mode: 'synthetic' });
      const now = new Date();
      const nextResetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const sleepUntil = new Date(Math.max(now.getTime() + REPLAY_MINIMUM_SLEEP_MS, nextResetAt)).toISOString();
      return {
        content: [{ type: 'text' as const, text: `Sleeping until ${sleepUntil}` }],
        details: { sleep_until: sleepUntil, entered: true },
      };
    },
  };
}

function replayExecuteTool(
  definition: ReplayToolDefinition,
  inner: AgentTool,
  state: ReplayState,
  registeredCapabilities: ReadonlySet<string>,
): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      recordExecuteDispatch(
        state.dispatches,
        toolCallId,
        params,
        registeredCapabilities,
        state.options.readImage !== undefined,
      );
      const imageCallId = `${toolCallId}:read_image`;
      try {
        // The shared execute gateway validates and audits text envelopes. Scene
        // reads additionally return bytes to this image-capable model, not Vision.
        const result = await inner.execute(toolCallId, params, signal);
        const image = state.imageResults.get(imageCallId);
        return image === undefined ? result : { ...result, content: [...result.content, image] };
      } finally {
        state.imageResults.delete(imageCallId);
      }
    },
  };
}

function replayBlockedTool(definition: ReplayToolDefinition, dispatches: ReplayDispatch[]): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, _params, signal) => {
      signal?.throwIfAborted();
      dispatches.push({ tool_call_id: toolCallId, tool_name: definition.name, mode: 'blocked' });
      throw new Error(`scene test blocks tool ${definition.name}: no production executor is wired`);
    },
  };
}

function replayCapability(definition: ReplayToolDefinition, state: ReplayState): ExecutableCapability {
  if (definition.name === 'typing') {
    return capability(
      {
        ...replayToolBase(definition),
        execute: async (_id, _params, signal) => {
          signal?.throwIfAborted();
          return { content: [{ type: 'text', text: 'Typing requested; use send to publish the reply.' }], details: {} };
        },
      },
      false,
    );
  }
  const readImage = state.options.readImage;
  if (definition.name === 'read_image' && readImage !== undefined) {
    return capability(
      {
        ...replayToolBase(definition),
        execute: async (id, params, signal) => {
          const input = params as { image_ref?: unknown };
          if (typeof input.image_ref !== 'string') {
            throw new Error('read_image input does not match the tool schema');
          }
          const image = await readImage(input.image_ref, signal ?? new AbortController().signal);
          signal?.throwIfAborted();
          state.imageResults.set(id, image);
          return { content: [{ type: 'text', text: 'Scene image loaded.' }], details: { scene_image: true } };
        },
      },
      false,
    );
  }
  if (definition.name === 'add_memory') {
    return capability(replayAddMemoryTool(definition, state), true);
  }
  if (definition.name === 'delete_memory') {
    return capability(replayDeleteMemoryTool(definition, state), true);
  }
  if (definition.name === 'alarm') {
    return capability(replayAlarmTool(definition, state), true);
  }
  if (definition.name === 'list_alarm') {
    return capability(replayListAlarmTool(definition, state), false);
  }
  if (definition.name === 'delete_alarm') {
    return capability(replayDeleteAlarmTool(definition, state), true);
  }
  if (definition.name === 'image_generate') {
    return capability(replayImageGenerateTool(definition), true);
  }
  return replayBlockedCapability(definition);
}

function replayAddMemoryTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(AddMemoryInputValidator, params, 'add_memory');
      const ttlSeconds = input.ttl_seconds ?? DEFAULT_MEMORY_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
      const id = newMemoryId();
      state.memories.set(id, { content: input.content, expiresAt });
      return {
        content: [{ type: 'text' as const, text: `Saved memory ${id}; it expires at ${expiresAt}` }],
        details: { id, expires_at: expiresAt },
      };
    },
  };
}

function replayDeleteMemoryTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(DeleteMemoryInputValidator, params, 'delete_memory');
      const deleted = state.memories.delete(input.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: deleted ? `Memory ${input.id} deleted` : `Memory ${input.id} was already gone`,
          },
        ],
        details: { id: input.id },
      };
    },
  };
}

function replayAlarmTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(AlarmInputValidator, params, 'alarm');
      const scheduledAt = new Date(input.datetime);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new Error('alarm datetime is invalid');
      }
      const scheduledIso = scheduledAt.toISOString();
      state.nextAlarmId += 1n;
      const id = state.nextAlarmId.toString();
      state.alarms.set(id, { scheduledAt: scheduledIso, summary: input.summary });
      return {
        content: [{ type: 'text' as const, text: `Scheduled alarm ${id} for ${scheduledIso}` }],
        details: { id, scheduled_at: scheduledIso },
      };
    },
  };
}

function replayListAlarmTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      checkedInput(ListAlarmInputValidator, params, 'list_alarm');
      const items = [...state.alarms.entries()]
        .map(([id, entry]) => ({ id, scheduled_at: entry.scheduledAt, summary: entry.summary }))
        .sort((left, right) => {
          if (left.scheduled_at !== right.scheduled_at) {
            return left.scheduled_at < right.scheduled_at ? -1 : 1;
          }
          return BigInt(left.id) < BigInt(right.id) ? -1 : 1;
        });
      const details = { items };
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  };
}

function replayDeleteAlarmTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(DeleteAlarmInputValidator, params, 'delete_alarm');
      if (!state.alarms.delete(input.id)) {
        throw new Error('alarm not found');
      }
      const cancelledAt = new Date().toISOString();
      return {
        content: [{ type: 'text' as const, text: `Cancelled alarm ${input.id}` }],
        details: { id: input.id, state: 'cancelled' as const, cancelled_at: cancelledAt },
      };
    },
  };
}

function replayImageGenerateTool(definition: ReplayToolDefinition): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(ImageGenerateInputValidator, params, 'image_generate');
      const generationId = randomUUID();
      const modelId = input.model_id ?? REPLAY_IMAGE_MODEL_ID;
      const outputCount = input.output_count ?? REPLAY_IMAGE_DEFAULT_OUTPUT_COUNT;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Generation ${generationId} submitted on model ${modelId} (${outputCount} output(s)). The result arrives as a completion receipt; do not claim the image exists before then.`,
          },
        ],
        details: { generation_id: generationId, model_id: modelId, output_count: outputCount, replayed: false },
      };
    },
  };
}

function replayBlockedCapability(definition: ReplayToolDefinition): ExecutableCapability {
  return capability(
    {
      ...replayToolBase(definition),
      execute: async (_toolCallId, _params, signal) => {
        signal?.throwIfAborted();
        throw new Error(`replay blocks capability ${definition.name}: no production executor is wired`);
      },
    },
    false,
  );
}

/** Mirrors `narrowSendInput` in capabilities/send-tool.ts, which is not exported. */
function sendKindResolvable(input: Record<string, unknown>): boolean {
  const kind =
    (typeof input.kind === 'string' ? input.kind : undefined) ??
    (input.text !== undefined && input.sticker_ref === undefined && input.image_generation_id === undefined
      ? 'text'
      : undefined);
  if (
    kind === undefined ||
    (kind === 'sticker' && input.parse_mode !== undefined) ||
    (kind !== 'image' && input.resend !== undefined)
  ) {
    return false;
  }
  if (kind === 'text') {
    return input.text !== undefined;
  }
  if (kind === 'sticker') {
    return input.sticker_ref !== undefined;
  }
  return input.image_generation_id !== undefined;
}

function recordExecuteDispatch(
  dispatches: ReplayDispatch[],
  toolCallId: string,
  params: unknown,
  registeredCapabilities: ReadonlySet<string>,
  readImage: boolean,
): void {
  if (typeof params !== 'object' || params === null) {
    return;
  }
  const request = params as Record<string, unknown>;
  const action = typeof request.action === 'string' ? request.action : undefined;
  const target = typeof request.tool === 'string' ? request.tool : undefined;
  if (action === 'call' && target !== undefined) {
    const synthetic = registeredCapabilities.has(target) && SYNTHETIC_CAPABILITIES.has(target);
    dispatches.push({
      tool_call_id: toolCallId,
      tool_name: 'execute',
      mode:
        registeredCapabilities.has(target) && target === 'read_image' && readImage
          ? 'live_read'
          : synthetic
            ? 'synthetic'
            : 'blocked',
      capability: target,
    });
    return;
  }
  if (action === 'search' || action === 'help') {
    dispatches.push({ tool_call_id: toolCallId, tool_name: 'execute', mode: 'synthetic' });
  }
}

function checkedInput<T>(validator: { Check(value: unknown): value is T }, value: unknown, toolName: string): T {
  if (!validator.Check(value)) {
    throw new Error(`${toolName} input does not match the tool schema`);
  }
  return value;
}
