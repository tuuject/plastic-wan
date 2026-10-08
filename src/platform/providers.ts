import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type Models,
  type OpenAICompletionsCompat,
  type Provider,
  type ProviderAuth,
  type ProviderHeaders,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinProviderApi, findBuiltinProvider } from './builtin-providers.ts';
import {
  type FileConfig,
  type ModelCompatConfig,
  type ModelFileConfig,
  type RawConfig,
  resolveAgentSettings,
  type ThinkingLevelConfig,
} from './config.ts';
import { deepEqual } from './config-diff.ts';
import type { ConfigurationModels } from './runtime-config.ts';
import type { SecretStore } from './secrets.ts';
import { thinkingLevelMap } from './thinking-levels.ts';

type ProviderFileConfig = FileConfig['providers'][string];

const CUSTOM_ADAPTERS: Record<string, () => ProviderStreams> = {
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
};

/**
 * The registry a reload starts from: the file layer the running process was
 * built from, and the providers it registered.
 */
export interface PreviousRegistry {
  readonly file: FileConfig;
  readonly models: Models;
}

/**
 * Builds one generation's model registry: one provider object per configured
 * alias, plus the vision model the configuration points at.
 *
 * A provider whose connection fields are unchanged keeps its resolved connection
 * and auth, so credentials are never resolved twice — a `command` SecretRef runs
 * a process, and only an explicitly requested reload of a new or changed
 * connection may have that side effect. `previous` is `null` at startup, which
 * builds every provider from the file.
 *
 * Builtin providers keep Pi's base URL, headers and provider-specific logic, but
 * their model list comes from the configuration alone: the catalog decides what
 * may be configured, never what is reachable at runtime.
 */
export async function buildModelRegistry(
  config: RawConfig,
  previous: PreviousRegistry | null,
  secrets: SecretStore,
): Promise<ConfigurationModels> {
  const models = createModels();
  for (const [alias, configured] of Object.entries(config.providers)) {
    const existing = reusableProvider(previous, alias, configured);
    if (existing !== null) {
      // The model list is built once and closed over, exactly as the provider it
      // replaces did: a lookup must not rebuild the objects on every call.
      const reused = providerModelsFor(alias, configured, existing);
      models.setProvider({ ...existing, getModels: () => reused });
      continue;
    }
    const apiKey = await secrets.resolve(configured.api_key);
    if (configured.kind === 'builtin') {
      const source = findBuiltinProvider(configured.provider);
      if (source === undefined) {
        throw new Error(`Unknown built-in provider: ${configured.provider}`);
      }
      const api = builtinProviderApi(source);
      if (api === null) {
        throw new Error(`Built-in provider ${configured.provider} does not expose a single API adapter`);
      }
      if (source.baseUrl === undefined) {
        throw new Error(`Built-in provider ${configured.provider} has no base URL`);
      }
      models.setProvider(
        aliasBuiltinProvider(alias, source, fixedAuth(alias, apiKey), api, source.baseUrl, configured.models),
      );
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [name, reference] of Object.entries(configured.headers ?? {})) {
      headers[name] = await secrets.resolve(reference);
    }
    const adapter = CUSTOM_ADAPTERS[configured.api];
    if (adapter === undefined) {
      throw new Error(`Unsupported custom API adapter: ${configured.api}`);
    }
    const baseUrl = configured.base_url.replace(/\/+$/, '');
    models.setProvider(
      createProvider({
        id: alias,
        name: alias,
        baseUrl,
        headers,
        auth: fixedAuth(alias, apiKey),
        api: adapter(),
        models: providerModels(alias, configured.api, baseUrl, configured.models, headers),
      }),
    );
  }
  const visionModel = requireModel(models, config.vision.provider, config.vision.model, ['image']);
  if (config.vision.max_output_tokens > visionModel.maxTokens) {
    throw new Error('Vision max_output_tokens exceeds registered model limit');
  }
  return { models, visionModel };
}

/** Selected model/thinking pairs, deduplicated across the default and every Chat. */
export function configuredAgentModels(
  config: RawConfig,
  models: Models,
): { readonly model: Model<Api>; readonly thinkingLevel: ThinkingLevelConfig }[] {
  const selected = [
    resolveAgentSettings(config),
    ...config.telegram.chats.map((chat) => resolveAgentSettings(config, chat)),
  ];
  const seen = new Set<string>();
  return selected.flatMap((settings) => {
    const key = JSON.stringify([settings.provider, settings.model, settings.thinking_level]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        model: requireModel(models, settings.provider, settings.model, ['text']),
        thinkingLevel: settings.thinking_level,
      },
    ];
  });
}

/**
 * The registered provider to keep for one configured alias, or `null` when the
 * alias has to be built from scratch.
 */
function reusableProvider(
  previous: PreviousRegistry | null,
  alias: string,
  configured: ProviderFileConfig,
): Provider | null {
  if (previous === null) {
    return null;
  }
  const previousConfig = previous.file.providers[alias];
  if (previousConfig === undefined || !sameConnection(previousConfig, configured)) {
    return null;
  }
  return previous.models.getProvider(alias) ?? null;
}

/**
 * Whether two configurations of one alias describe the same connection:
 * everything the file carries but the enabled model list. Re-kinding a provider
 * counts as a different connection too, since `kind` is part of what is compared.
 */
export function sameConnection(left: ProviderFileConfig, right: ProviderFileConfig): boolean {
  return deepEqual(connectionOf(left), connectionOf(right));
}

/** One provider's connection fields: everything the file carries but `models`. */
function connectionOf(provider: ProviderFileConfig): Record<string, unknown> {
  const connection = { ...provider } as Record<string, unknown>;
  delete connection.models;
  return connection;
}

/** The model list one reused provider serves: same connection, newly enabled models. */
function providerModelsFor(alias: string, configured: ProviderFileConfig, existing: Provider): Model<Api>[] {
  if (configured.kind === 'custom') {
    return providerModels(
      alias,
      configured.api,
      existing.baseUrl ?? configured.base_url.replace(/\/+$/, ''),
      configured.models,
      existing.headers,
    );
  }
  const source = findBuiltinProvider(configured.provider);
  const api = source === undefined ? null : builtinProviderApi(source);
  if (api === null) {
    throw new Error(`Built-in provider ${configured.provider} does not expose a single API adapter`);
  }
  const baseUrl = existing.baseUrl ?? source?.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(`Built-in provider ${configured.provider} has no base URL`);
  }
  return providerModels(alias, api, baseUrl, configured.models, existing.headers);
}

/**
 * The configured model list of one provider. Builtin and custom providers share
 * this mapping: the only difference is where `api` comes from.
 *
 * Pi's completion path reads connection headers from the model rather than the
 * provider, so every model must carry them. Model headers accept strings only;
 * null provider-header entries are omitted.
 */
function providerModels(
  alias: string,
  api: Api,
  baseUrl: string,
  models: readonly ModelFileConfig[],
  headers?: ProviderHeaders,
): Model<Api>[] {
  let modelHeaders: Record<string, string> | undefined;
  if (headers !== undefined) {
    modelHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== null) {
        modelHeaders[name] = value;
      }
    }
  }
  return models.map((model) => {
    const built: Model<Api> = {
      id: model.id,
      name: model.name ?? model.id,
      api,
      provider: alias,
      baseUrl,
      ...(modelHeaders !== undefined && Object.keys(modelHeaders).length > 0 ? { headers: modelHeaders } : {}),
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cache_read,
        cacheWrite: model.cost.cache_write,
      },
    };
    const levels = thinkingLevelMap(model);
    if (levels !== undefined) {
      built.thinkingLevelMap = levels;
    }
    const compat = model.compat === undefined ? undefined : mapCompat(model.compat);
    return compat === undefined ? built : { ...built, compat };
  });
}

/** The one place that turns the file's snake_case compat into Pi's camelCase. */
export function mapCompat(compat: ModelCompatConfig): NonNullable<Model<Api>['compat']> | undefined {
  const mapped: OpenAICompletionsCompat = {};
  if (compat.supports_developer_role !== undefined) {
    mapped.supportsDeveloperRole = compat.supports_developer_role;
  }
  if (compat.thinking_format !== undefined) {
    mapped.thinkingFormat = compat.thinking_format;
  }
  if (compat.max_tokens_field !== undefined) {
    mapped.maxTokensField = compat.max_tokens_field;
  }
  if (compat.requires_reasoning_content !== undefined) {
    mapped.requiresReasoningContentOnAssistantMessages = compat.requires_reasoning_content;
  }
  if (compat.cache_control_format !== undefined) {
    mapped.cacheControlFormat = compat.cache_control_format;
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/**
 * Re-exposes a builtin provider under its configured alias.
 *
 * Requests must keep Pi's own provider id: automatic compat detection keys off
 * it (OpenRouter's cache-control format, DeepSeek's reasoning replay), so the
 * alias is only ever the registry key. `api` is the catalog's single adapter,
 * which is what the configured models are built with.
 */
function aliasBuiltinProvider(
  alias: string,
  source: Provider,
  auth: ProviderAuth,
  api: Api,
  baseUrl: string,
  configuredModels: readonly ModelFileConfig[],
): Provider {
  const aliasedModels = providerModels(alias, api, baseUrl, configuredModels, source.headers);
  const fetchDeferred = source.fetchDeferred?.bind(source);
  const cancelDeferred = source.cancelDeferred?.bind(source);
  return {
    id: alias,
    name: source.name,
    baseUrl,
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth,
    getModels: () => aliasedModels,
    stream: (model, context, options) => source.stream({ ...model, provider: source.id }, context, options),
    streamSimple: (model, context, options) => source.streamSimple({ ...model, provider: source.id }, context, options),
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (model, handle, options) => fetchDeferred({ ...model, provider: source.id }, handle, options),
        }),
    ...(cancelDeferred === undefined
      ? {}
      : {
          cancelDeferred: (model, handle, options) =>
            cancelDeferred({ ...model, provider: source.id }, handle, options),
        }),
  };
}

function fixedAuth(alias: string, apiKey: string): ProviderAuth {
  return {
    apiKey: {
      name: `${alias} API key`,
      check: async () => ({ type: 'api_key', source: 'configured SecretRef' }),
      resolve: async () => ({ auth: { apiKey }, source: 'configured SecretRef' }),
    },
  };
}

export function requireModel(
  models: Models,
  provider: string,
  modelId: string,
  capabilities: readonly ('text' | 'image')[],
): Model<Api> {
  const model = models.getModel(provider, modelId);
  if (model === undefined) {
    throw new Error(`Model ${provider}/${modelId} is not registered`);
  }
  for (const capability of capabilities) {
    if (!model.input.includes(capability)) {
      throw new Error(`Model ${provider}/${modelId} lacks ${capability} input capability`);
    }
  }
  return model;
}
