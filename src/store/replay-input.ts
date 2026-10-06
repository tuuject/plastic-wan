import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { type AgentPromptLayers, composeAgentPrompt } from '../platform/agent-prompt.ts';
import type { PromptTemplateValues } from '../platform/prompt-template.ts';
import { decodeContextMessage, encodeContextMessage } from '../context/context-codec.ts';

const Strict = { additionalProperties: false } as const;
const DefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' }),
    label: Type.String(),
    description: Type.String(),
    parameters: Type.Record(Type.String(), Type.Unknown()),
  },
  Strict,
);
const ModelRefSchema = Type.Object({ provider: Type.String(), model: Type.String() }, Strict);
/**
 * The layered half of a version 2 snapshot: the fixed prefix and middle exactly
 * as they stood at the source invocation, the raw comment-stripped global and
 * group templates, and the template values they rendered with. `composeAgentPrompt`
 * over these fields must reproduce `system_prompt` byte for byte.
 */
const PromptPartsSchema = Type.Object(
  {
    prefix: Type.String(),
    global: Type.String(),
    middle: Type.String(),
    group: Type.String(),
    template_values: Type.Object(
      {
        agent: ModelRefSchema,
        vision: ModelRefSchema,
        timezone: Type.String(),
      },
      Strict,
    ),
  },
  Strict,
);
const CommonFields = {
  system_prompt: Type.String(),
  messages: Type.Array(Type.String(), { minItems: 1 }),
  tools: Type.Array(DefinitionSchema, { maxItems: 64 }),
  capabilities: Type.Array(DefinitionSchema, { maxItems: 256 }),
  omitted_images: Type.Integer({ minimum: 0 }),
} as const;
const V1Schema = Type.Object(
  {
    version: Type.Literal(1),
    ...CommonFields,
  },
  Strict,
);
const V2Schema = Type.Object(
  {
    version: Type.Literal(2),
    ...CommonFields,
    prompt_parts: PromptPartsSchema,
  },
  Strict,
);
const validator = Compile(Type.Union([V1Schema, V2Schema]));
const definitionValidator = Compile(DefinitionSchema);
export type ReplayToolDefinition = Static<typeof DefinitionSchema>;
export type ReplayPromptParts = Static<typeof PromptPartsSchema>;
export type ReplayInputV1 = Static<typeof V1Schema>;
export type ReplayInputV2 = Static<typeof V2Schema>;
export type ReplayInput = ReplayInputV1 | ReplayInputV2;

/** Recording failures that must not leak conversation or prompt content into logs. */
export class ReplayInputSerializationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReplayInputSerializationError';
    this.code = code;
  }
}

export interface ReplayPromptSnapshot {
  readonly layers: AgentPromptLayers;
  readonly templateValues: PromptTemplateValues;
}

export function toolDefinition(
  tool: Pick<AgentTool, 'name' | 'description' | 'parameters'> & { label?: string },
): ReplayToolDefinition {
  const definition = {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  if (!definitionValidator.Check(definition)) {
    throw new Error('Invalid replay tool definition');
  }
  return definition;
}

/**
 * Provider-independent, text-only input. Lives with the opt-in model payload,
 * not a second archive. The prompt layers are stored alongside the exact system
 * prompt so a replay can rebuild it or replace only the global/group layers; the
 * composition is verified here, and again on parse, so a snapshot can never
 * describe a prompt different from the one the model saw.
 */
export function serializeReplayInput(
  context: Context,
  capabilities: readonly AgentTool[],
  prompt: ReplayPromptSnapshot,
): string {
  const layers = prompt.layers;
  let composed: string;
  try {
    composed = composeAgentPrompt(layers, prompt.templateValues);
  } catch {
    throw new ReplayInputSerializationError('invalid_prompt_template', 'The prompt layers are not a valid template');
  }
  if (composed !== (context.systemPrompt ?? '')) {
    throw new ReplayInputSerializationError(
      'prompt_parts_mismatch',
      'The prompt layers do not reproduce the recorded system prompt',
    );
  }
  let omittedImages = 0;
  const messages = context.messages.map((message) => {
    if (typeof message.content !== 'string') {
      omittedImages += message.content.filter((block) => block.type === 'image').length;
    }
    const encoded = encodeContextMessage(message);
    if (encoded === undefined) {
      throw new ReplayInputSerializationError(
        'unsupported_message',
        'Model input cannot be represented as a replay snapshot',
      );
    }
    return encoded.json;
  });
  return JSON.stringify({
    version: 2,
    system_prompt: composed,
    prompt_parts: {
      prefix: layers.prefix,
      global: layers.global,
      middle: layers.middle,
      group: layers.group,
      template_values: prompt.templateValues,
    },
    messages,
    tools: (context.tools ?? []).map(toolDefinition),
    capabilities: capabilities.map(toolDefinition),
    omitted_images: omittedImages,
  } satisfies ReplayInputV2);
}

export function parseReplayInput(json: string): { input: ReplayInput; messages: AgentMessage[] } {
  const value: unknown = JSON.parse(json);
  if (!validator.Check(value)) {
    throw new Error('Invalid replay input snapshot');
  }
  const names = value.tools.map((tool) => tool.name);
  const capabilities = value.capabilities.map((tool) => tool.name);
  if (new Set(names).size !== names.length || new Set(capabilities).size !== capabilities.length) {
    throw new Error('Duplicate replay tool definition');
  }
  if (value.version === 2) {
    // A version 2 snapshot must reproduce its own system prompt; anything else
    // is a corrupted record, not a replayable starting point.
    let composed: string;
    try {
      composed = composeAgentPrompt(value.prompt_parts, value.prompt_parts.template_values);
    } catch {
      throw new Error('Invalid replay input snapshot');
    }
    if (composed !== value.system_prompt) {
      throw new Error('Invalid replay input snapshot');
    }
  }
  return { input: value, messages: value.messages.map(decodeContextMessage) };
}

/** The recorded prompt layers of a version 2 snapshot, or `null` for a version 1 record. */
export function replayPromptParts(input: ReplayInput): ReplayPromptParts | null {
  return input.version === 2 ? input.prompt_parts : null;
}
