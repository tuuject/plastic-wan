import { stripHtmlComments } from './prompt-markdown.ts';
import { renderPromptTemplate, type PromptTemplateValues, validatePromptTemplate } from './prompt-template.ts';

/** One global/group replay override, bounded like the configuration prompt files. */
export const MAX_PROMPT_OVERRIDE_CHARS = 65_536;

/**
 * The ordered layers of the stable system prompt. `prefix` and `middle` are
 * runtime-owned text (core protocol, skill index, media handling, sticker
 * handling, conversation mode, memory guidance) and are never replaceable;
 * `global` and `group` are the raw comment-stripped templates of
 * `agent.system_prompt` and the chat's `instructions`. A replay can rebuild the
 * exact prompt from these four layers plus the recorded template values.
 */
export interface AgentPromptLayers {
  readonly prefix: string;
  readonly global: string;
  readonly middle: string;
  readonly group: string;
}

/** Which replaceable layer an override targets. */
export type PromptLayer = 'global' | 'group';

export class PromptOverrideError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PromptOverrideError';
    this.code = code;
  }
}

/**
 * Rebuilds a system prompt from its layers exactly as `ContextBuilder` does:
 * fixed prefix, rendered global template, fixed middle, rendered group template,
 * empty segments dropped, segments joined by a blank line. The templates render
 * with the values they were recorded with, so a later configuration change
 * cannot leak into a replay.
 */
export function composeAgentPrompt(layers: AgentPromptLayers, values: PromptTemplateValues): string {
  return [
    layers.prefix,
    renderPromptTemplate(layers.global, values),
    layers.middle,
    renderPromptTemplate(layers.group, values),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * Validates and normalizes one replay prompt override. It goes through the same
 * boundary as the configuration loader's prompt files — HTML comments stripped
 * before the text reaches the model — plus BOM and NUL checks and the template
 * variable allowlist. The returned text is a raw template: rendering happens
 * later against the values recorded with the source invocation.
 */
export function preparePromptOverride(value: string, layer: PromptLayer): string {
  if (value.length > MAX_PROMPT_OVERRIDE_CHARS) {
    throw new PromptOverrideError(
      'replay_prompt_too_large',
      `${layer} prompt must be at most ${MAX_PROMPT_OVERRIDE_CHARS} characters`,
    );
  }
  if (value.includes('\u0000')) {
    throw new PromptOverrideError('replay_prompt_invalid', `${layer} prompt contains a NUL character`);
  }
  if (value.includes('\uFEFF')) {
    throw new PromptOverrideError('replay_prompt_invalid', `${layer} prompt contains a BOM character`);
  }
  const template = stripHtmlComments(value);
  if (layer === 'global' && template.trim().length === 0) {
    throw new PromptOverrideError(
      'replay_prompt_empty',
      'global prompt must not be empty; the global layer cannot be removed, only the group layer can',
    );
  }
  try {
    validatePromptTemplate(template, `${layer} prompt`);
  } catch {
    throw new PromptOverrideError(
      'replay_prompt_invalid',
      `${layer} prompt contains an unsupported template variable or a malformed template expression`,
    );
  }
  return template;
}
