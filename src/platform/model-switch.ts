import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { RuntimeConfigurationStore } from './runtime-config.ts';

export class ModelSwitchError extends Error {
  readonly code: 'unknown_provider' | 'unknown_model' | 'not_text_capable';

  constructor(code: 'unknown_provider' | 'unknown_model' | 'not_text_capable', message: string) {
    super(message);
    this.name = 'ModelSwitchError';
    this.code = code;
  }
}

export interface AgentModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** One text-capable model of the active snapshot, keyed by its configured provider alias. */
export interface AgentModelCatalogEntry {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly context_window: number;
  readonly max_tokens: number;
  readonly input: readonly ('text' | 'image')[];
  readonly reasoning: boolean;
  readonly thinking_levels: readonly ModelThinkingLevel[];
}

/**
 * The text-capable models of the current generation, one entry per configured
 * provider alias. This is a pure registry read: no upstream discovery, no
 * secret resolution and no provider connection is touched, so it is safe for
 * a read-only model directory.
 */
export function listActiveTextModels(configStore: RuntimeConfigurationStore): readonly AgentModelCatalogEntry[] {
  const snapshot = configStore.current();
  const entries: AgentModelCatalogEntry[] = [];
  for (const alias of Object.keys(snapshot.config.providers)) {
    for (const candidate of snapshot.models.getModels(alias)) {
      if (!candidate.input.includes('text')) {
        continue;
      }
      entries.push({
        provider: alias,
        model: candidate.id,
        name: candidate.name,
        context_window: candidate.contextWindow,
        max_tokens: candidate.maxTokens,
        input: [...candidate.input],
        reasoning: candidate.reasoning,
        thinking_levels: getSupportedThinkingLevels(candidate),
      });
    }
  }
  return entries;
}

/**
 * Reads and validates agent model references against the live configuration and
 * the model registry published with it.
 *
 * There is no in-memory override: the model in use is always the one the active
 * configuration names, so a switch has to reach the configuration file to mean
 * anything (`ConfigReloader.setAgentModel`).
 */
export class AgentModelSwitcher {
  readonly #configStore: RuntimeConfigurationStore;

  constructor(configStore: RuntimeConfigurationStore) {
    this.#configStore = configStore;
  }

  current(): AgentModelOption {
    const config = this.#configStore.current().config;
    return this.option(config.agent.provider, config.agent.model);
  }

  /** The live thinking level; a model switch resets it (`ConfigReloader.setAgentModel`). */
  thinkingLevel(): ModelThinkingLevel {
    return this.#configStore.current().config.agent.thinking_level;
  }

  model(): Model<Api> {
    const snapshot = this.#configStore.current();
    const config = snapshot.config;
    const found = snapshot.models.getModel(config.agent.provider, config.agent.model);
    if (found === undefined) {
      throw new Error(`Agent model ${config.agent.provider}/${config.agent.model} is not registered`);
    }
    return found;
  }

  list(): readonly AgentModelOption[] {
    return listActiveTextModels(this.#configStore).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      name: entry.name,
      contextWindow: entry.context_window,
      maxTokens: entry.max_tokens,
    }));
  }

  /** Validates a target without applying it. */
  option(provider: string, modelId: string): AgentModelOption {
    const snapshot = this.#configStore.current();
    if (snapshot.config.providers[provider] === undefined) {
      throw new ModelSwitchError('unknown_provider', `Provider ${provider} is not configured`);
    }
    const found = snapshot.models.getModel(provider, modelId);
    if (found === undefined) {
      throw new ModelSwitchError('unknown_model', `Model ${provider}/${modelId} is not registered`);
    }
    if (!found.input.includes('text')) {
      throw new ModelSwitchError('not_text_capable', `Model ${provider}/${modelId} does not accept text input`);
    }
    return {
      provider,
      model: modelId,
      name: found.name,
      contextWindow: found.contextWindow,
      maxTokens: found.maxTokens,
    };
  }
}
