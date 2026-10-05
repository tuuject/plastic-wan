import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { decodeContextMessage, encodeContextMessage } from '../context/context-codec.ts';

const DefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' }),
    label: Type.String(),
    description: Type.String(),
    parameters: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
const InputSchema = Type.Object(
  {
    version: Type.Literal(1),
    system_prompt: Type.String(),
    messages: Type.Array(Type.String(), { minItems: 1 }),
    tools: Type.Array(DefinitionSchema, { maxItems: 64 }),
    capabilities: Type.Array(DefinitionSchema, { maxItems: 256 }),
    omitted_images: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const validator = Compile(InputSchema);
const definitionValidator = Compile(DefinitionSchema);
export type ReplayToolDefinition = Static<typeof DefinitionSchema>;
export type ReplayInput = Static<typeof InputSchema>;

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

/** Provider-independent, text-only input. Lives with the opt-in model payload, not a second archive. */
export function serializeReplayInput(context: Context, capabilities: readonly AgentTool[]): string {
  let omittedImages = 0;
  const messages = context.messages.map((message) => {
    if (typeof message.content !== 'string') {
      omittedImages += message.content.filter((block) => block.type === 'image').length;
    }
    const encoded = encodeContextMessage(message);
    if (encoded === undefined) {
      throw new Error('Model input cannot be represented as a replay snapshot');
    }
    return encoded.json;
  });
  return JSON.stringify({
    version: 1,
    system_prompt: context.systemPrompt ?? '',
    messages,
    tools: (context.tools ?? []).map(toolDefinition),
    capabilities: capabilities.map(toolDefinition),
    omitted_images: omittedImages,
  } satisfies ReplayInput);
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
  return { input: value, messages: value.messages.map(decodeContextMessage) };
}
