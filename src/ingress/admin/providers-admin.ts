import Type, { type Static, type TSchema } from 'typebox';
import Compile from 'typebox/compile';
import {
  findBuiltinProvider,
  isSupportedBuiltinPreset,
  listBuiltinPresets,
  supportedBuiltinApi,
} from '../../platform/builtin-providers.ts';
import {
  assertModelConfig,
  type FileChat,
  type FileConfig,
  ModelConfigSchema,
  type ModelFileConfig,
  PROVIDER_ALIAS_PATTERN,
  type ProviderApi,
  type ThinkingLevelConfig,
  ThinkingLevelSchema,
} from '../../platform/config.ts';
import { type ConfigEdit, secretEdit } from '../../platform/config-file.ts';
import { newKeyJarName } from '../../platform/key-jar.ts';
import { type ModelMetadataDraft, resolveModelDrafts } from '../../platform/model-metadata.ts';
import { loadModelsDevCatalog, type ModelsDevCatalog } from '../../platform/models-dev.ts';
import { type DiscoveredProviderModel, fetchProviderModels } from '../../platform/provider-models.ts';
import { sameConnection } from '../../platform/providers.ts';
import type { RuntimeConfiguration } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { supportedThinkingLevels } from '../../platform/thinking-levels.ts';
import { AdminQueryError } from './audit.ts';

/** Panel bodies carry whole model lists, so they are larger than audit filters. */
export const PROVIDER_BODY_MAX_BYTES = 512 * 1024;
const MAX_MODELS_PER_REQUEST = 200;
const MAX_LOOKUP_IDS = 100;
const Strict = { additionalProperties: false } as const;

const ApiSchema = Type.Union([
  Type.Literal('openai-responses'),
  Type.Literal('openai-completions'),
  Type.Literal('anthropic-messages'),
  Type.Literal('google-generative-ai'),
]);
const PlainSecretSchema = Type.String({ minLength: 1, maxLength: 8_192 });
const HeaderValuesSchema = Type.Record(Type.String({ minLength: 1 }), PlainSecretSchema);

const CreateProviderBodySchema = Type.Object(
  {
    alias: Type.String({ pattern: PROVIDER_ALIAS_PATTERN.source }),
    kind: Type.Union([Type.Literal('builtin'), Type.Literal('custom')]),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    api_key: PlainSecretSchema,
    headers: Type.Optional(HeaderValuesSchema),
    models: Type.Array(ModelConfigSchema, { minItems: 1, maxItems: MAX_MODELS_PER_REQUEST }),
  },
  Strict,
);

const UpdateProviderBodySchema = Type.Object(
  {
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    api_key: Type.Optional(PlainSecretSchema),
    /** `null` deletes a header; a missing name keeps the stored value. */
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Union([PlainSecretSchema, Type.Null()]))),
  },
  Strict,
);

const ModelsBodySchema = Type.Object(
  { models: Type.Array(ModelConfigSchema, { minItems: 1, maxItems: MAX_MODELS_PER_REQUEST }) },
  Strict,
);

const DiscoverBodySchema = Type.Object(
  {
    alias: Type.Optional(Type.String({ minLength: 1 })),
    kind: Type.Optional(Type.Union([Type.Literal('builtin'), Type.Literal('custom')])),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    api_key: Type.Optional(PlainSecretSchema),
    headers: Type.Optional(HeaderValuesSchema),
  },
  Strict,
);

const LookupMetadataBodySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('builtin'), Type.Literal('custom')]),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_LOOKUP_IDS }),
  },
  Strict,
);

const VisionBodySchema = Type.Object(
  { provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) },
  Strict,
);
const ThinkingLevelBodySchema = Type.Object({ thinking_level: ThinkingLevelSchema }, Strict);

export type CreateProviderBody = Static<typeof CreateProviderBodySchema>;
export type UpdateProviderBody = Static<typeof UpdateProviderBodySchema>;
export type DiscoverBody = Static<typeof DiscoverBodySchema>;
export type LookupMetadataBody = Static<typeof LookupMetadataBodySchema>;

export interface ProviderView {
  readonly alias: string;
  readonly kind: 'builtin' | 'custom';
  readonly provider?: string;
  readonly api: ProviderApi;
  readonly base_url: string;
  readonly header_names: readonly string[];
  readonly models: readonly ModelFileConfig[];
}

export interface ProvidersView {
  readonly revision: string;
  /** Whether the deployment declares an external supervisor that restarts `serve`. */
  readonly supervised: boolean;
  readonly agent: { readonly provider: string; readonly model: string; readonly thinking_level: ThinkingLevelConfig };
  readonly vision: { readonly provider: string; readonly model: string };
  readonly restart_required: readonly string[];
  readonly providers: readonly ProviderView[];
}

export interface ProviderPresetView {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly base_url: string;
}

export interface ModelDiscoveryItem extends ModelMetadataDraft {
  /** The model id is already configured on this provider. */
  readonly configured: boolean;
}

export interface DiscoverResponse {
  readonly endpoint: string;
  readonly models: readonly ModelDiscoveryItem[];
  /**
   * Set when the models.dev catalog could not be fetched. The listing itself is
   * still returned: metadata is enrichment, and the admin can fill it in by hand
   * rather than being blocked by a source that is only one of several.
   */
  readonly metadata_source_error: string | null;
}

export interface LookupMetadataResponse {
  readonly models: readonly ModelMetadataDraft[];
  readonly metadata_source_error: string | null;
}

export interface ProviderWriteContext {
  /** The configuration file as it is on disk right now. */
  readonly file: FileConfig;
  readonly secrets: SecretStore;
  /**
   * The configuration the running process serves. Saved-mode discovery compares
   * the file against it, because a connection the process has not applied may
   * not receive the credentials the process resolved.
   */
  readonly snapshot: RuntimeConfiguration;
}

const createProviderValidator = Compile(CreateProviderBodySchema);
const updateProviderValidator = Compile(UpdateProviderBodySchema);
const modelsBodyValidator = Compile(ModelsBodySchema);
const modelValidator = Compile(ModelConfigSchema);
const discoverValidator = Compile(DiscoverBodySchema);
const lookupValidator = Compile(LookupMetadataBodySchema);
const visionValidator = Compile(VisionBodySchema);
const thinkingLevelValidator = Compile(ThinkingLevelBodySchema);

export function supervisedRestartEnabled(): boolean {
  return process.env.PLASTICWAN_SUPERVISED === '1';
}

export function listProviders(
  file: Pick<FileConfig, 'providers' | 'vision'> & {
    agent: Pick<FileConfig['agent'], 'provider' | 'model' | 'thinking_level'>;
  },
  revision: string,
  restartRequired: readonly string[],
): ProvidersView {
  return {
    revision,
    supervised: supervisedRestartEnabled(),
    agent: { provider: file.agent.provider, model: file.agent.model, thinking_level: file.agent.thinking_level },
    vision: { provider: file.vision.provider, model: file.vision.model },
    restart_required: [...restartRequired],
    providers: Object.entries(file.providers).map(([alias, provider]) => {
      if (provider.kind === 'custom') {
        return {
          alias,
          kind: 'custom' as const,
          api: provider.api,
          base_url: provider.base_url,
          header_names: Object.keys(provider.headers ?? {}),
          models: provider.models,
        };
      }
      const source = findBuiltinProvider(provider.provider);
      const api = source === undefined ? null : supportedBuiltinApi(source);
      if (source === undefined || api === null || source.baseUrl === undefined) {
        // `loadConfig` rejects this, so the panel only sees it if the file was
        // edited between the load and this response.
        throw new AdminQueryError(
          'provider_unsupported',
          `Built-in provider ${provider.provider} has no single supported API adapter`,
          422,
        );
      }
      return {
        alias,
        kind: 'builtin' as const,
        provider: provider.provider,
        api,
        base_url: source.baseUrl,
        header_names: [],
        models: provider.models,
      };
    }),
  };
}

export function listProviderPresets(): readonly ProviderPresetView[] {
  const presets: ProviderPresetView[] = [];
  for (const source of listBuiltinPresets()) {
    const api = supportedBuiltinApi(source);
    if (api === null || source.baseUrl === undefined) {
      continue;
    }
    presets.push({ id: source.id, name: source.name, api, base_url: source.baseUrl });
  }
  return presets;
}

export function parseAlias(segment: string): string {
  if (!PROVIDER_ALIAS_PATTERN.test(segment)) {
    throw new AdminQueryError('invalid_alias', 'alias must match the provider alias pattern');
  }
  return segment;
}

export function parseCreateProviderBody(value: unknown): CreateProviderBody {
  return parseWith(createProviderValidator, value);
}

export function parseUpdateProviderBody(value: unknown): UpdateProviderBody {
  return parseWith(updateProviderValidator, value);
}

export function parseModelsBody(value: unknown): readonly ModelFileConfig[] {
  return parseWith(modelsBodyValidator, value).models;
}

export function parseModelBody(value: unknown): ModelFileConfig {
  return parseWith(modelValidator, value);
}

export function parseDiscoverBody(value: unknown): DiscoverBody {
  return parseWith(discoverValidator, value);
}

export function parseLookupMetadataBody(value: unknown): LookupMetadataBody {
  return parseWith(lookupValidator, value);
}

export function parseVisionBody(value: unknown): { readonly provider: string; readonly model: string } {
  return parseWith(visionValidator, value);
}

export function parseThinkingLevelBody(value: unknown): { readonly thinking_level: ThinkingLevelConfig } {
  return parseWith(thinkingLevelValidator, value);
}

type Validator<T extends TSchema> = import('typebox/compile').Validator<import('typebox').TProperties, T>;

function parseWith<T extends TSchema>(validator: Validator<T>, value: unknown): Static<T> {
  if (typeof value !== 'object' || value === null) {
    throw new AdminQueryError('invalid_body', 'Request body must be a JSON object');
  }
  if (!validator.Check(value)) {
    const detail = validator
      .Errors(value)
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/'}: ${error.message}`)
      .join('; ');
    throw new AdminQueryError('invalid_body', detail);
  }
  return value as Static<T>;
}

function providerOf(file: FileConfig, alias: string): FileConfig['providers'][string] {
  const provider = file.providers[alias];
  if (provider === undefined) {
    throw new AdminQueryError('provider_not_found', `Provider ${alias} is not configured`, 404);
  }
  return provider;
}

/** The API a provider's configured models speak, for compat applicability checks. */
function providerApi(provider: FileConfig['providers'][string]): ProviderApi {
  if (provider.kind === 'custom') {
    return provider.api;
  }
  const source = findBuiltinProvider(provider.provider);
  const api = source === undefined ? null : supportedBuiltinApi(source);
  if (api === null) {
    throw new AdminQueryError(
      'provider_unsupported',
      `Built-in provider ${provider.provider} has no single supported API adapter`,
      422,
    );
  }
  return api;
}

function checkModel(api: ProviderApi, model: ModelFileConfig, label: string): void {
  try {
    assertModelConfig(api, model, label);
  } catch (error) {
    throw new AdminQueryError('invalid_model', error instanceof Error ? error.message : String(error));
  }
}

/**
 * A plaintext secret is registered with the `SecretStore` before it is written
 * or sent anywhere: until it is, redaction cannot mask it in logs, reload errors
 * or upstream failures. Submissions are remembered rather than resolved, so a
 * value that arrived with a request cannot pile up in the process-wide set.
 */
function registerSecrets(secrets: SecretStore, values: readonly string[]): void {
  for (const value of values) {
    secrets.remember(value);
  }
}

export async function createProvider(context: ProviderWriteContext, body: CreateProviderBody): Promise<ConfigEdit[]> {
  if (context.file.providers[body.alias] !== undefined) {
    throw new AdminQueryError('provider_exists', `Provider ${body.alias} already exists`, 409);
  }
  const api = await resolveNewProviderApi(body);
  for (const model of body.models) {
    checkModel(api, model, `model ${model.id}`);
  }
  registerSecrets(context.secrets, [body.api_key, ...Object.values(body.headers ?? {})]);
  const keys: Record<string, string> = {};
  const toJar = (plaintext: string): { jar: string } => {
    const name = newKeyJarName();
    keys[name] = plaintext;
    return { jar: name };
  };
  const provider =
    body.kind === 'builtin'
      ? {
          kind: 'builtin' as const,
          provider: body.provider as string,
          api_key: toJar(body.api_key),
          models: body.models,
        }
      : {
          kind: 'custom' as const,
          base_url: (body.base_url as string).replace(/\/+$/, ''),
          api: body.api as ProviderApi,
          api_key: toJar(body.api_key),
          ...(body.headers === undefined
            ? {}
            : {
                headers: Object.fromEntries(Object.entries(body.headers).map(([name, value]) => [name, toJar(value)])),
              }),
          models: body.models,
        };
  return [{ path: ['providers', body.alias], value: provider, keys }];
}

async function resolveNewProviderApi(body: CreateProviderBody): Promise<ProviderApi> {
  if (body.kind === 'builtin') {
    if (body.provider === undefined) {
      throw new AdminQueryError('invalid_body', 'provider is required for a builtin provider');
    }
    const source = findBuiltinProvider(body.provider);
    if (source === undefined) {
      throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${body.provider}`);
    }
    if (!isSupportedBuiltinPreset(source)) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} cannot be driven from a configured API key`,
      );
    }
    const api = supportedBuiltinApi(source);
    if (api === null) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} has no single supported API adapter`,
      );
    }
    return api;
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  return body.api;
}

export async function updateProvider(
  context: ProviderWriteContext,
  alias: string,
  body: UpdateProviderBody,
): Promise<ConfigEdit[]> {
  const provider = providerOf(context.file, alias);
  const edits: ConfigEdit[] = [];
  const secretsToRegister: string[] = [];
  const removedHeaders: string[] = [];
  if (provider.kind === 'builtin') {
    if (body.base_url !== undefined || body.api !== undefined || body.headers !== undefined) {
      throw new AdminQueryError(
        'immutable_field',
        'A built-in provider only allows its API key to change; its base URL, API and headers come from Pi',
      );
    }
    if (body.api_key !== undefined) {
      secretsToRegister.push(body.api_key);
      edits.push(secretEdit(['providers', alias, 'api_key'], body.api_key));
    }
  } else {
    const baseUrl = body.base_url === undefined ? provider.base_url : body.base_url.replace(/\/+$/, '');
    const baseUrlChanged = baseUrl !== provider.base_url;
    if (baseUrlChanged) {
      // Moving the endpoint without re-entering the credentials would let a
      // stolen panel session point a configured key at its own server.
      if (body.api_key === undefined) {
        throw new AdminQueryError(
          'credentials_required',
          'Changing base_url requires the API key to be submitted again in the same request',
        );
      }
      for (const name of Object.keys(provider.headers ?? {})) {
        if (typeof body.headers?.[name] !== 'string') {
          throw new AdminQueryError(
            'credentials_required',
            `Changing base_url requires every header value to be submitted again: ${name}`,
          );
        }
      }
    }
    if (body.base_url !== undefined && baseUrlChanged) {
      edits.push({ path: ['providers', alias, 'base_url'], value: baseUrl });
    }
    if (body.api !== undefined && body.api !== provider.api) {
      edits.push({ path: ['providers', alias, 'api'], value: body.api });
    }
    if (body.api_key !== undefined) {
      secretsToRegister.push(body.api_key);
      edits.push(secretEdit(['providers', alias, 'api_key'], body.api_key));
    }
    for (const [name, value] of Object.entries(body.headers ?? {})) {
      if (value === null) {
        if (provider.headers?.[name] === undefined) {
          continue;
        }
        removedHeaders.push(name);
        continue;
      }
      secretsToRegister.push(value);
      edits.push(secretEdit(['providers', alias, 'headers', name], value));
    }
    const keptHeaders = Object.keys(provider.headers ?? {}).filter((name) => !removedHeaders.includes(name));
    const addedHeaders = Object.entries(body.headers ?? {}).filter(([, value]) => value !== null).length;
    if (removedHeaders.length > 0 && keptHeaders.length === 0 && addedHeaders === 0) {
      // The last header is gone, so the empty object goes with it instead of
      // leaving a `"headers": {}` behind in the file.
      edits.push({ path: ['providers', alias, 'headers'], value: undefined });
    } else {
      for (const name of removedHeaders) {
        edits.push({ path: ['providers', alias, 'headers', name], value: undefined });
      }
    }
  }
  if (edits.length === 0) {
    throw new AdminQueryError('no_changes', 'The request does not change any connection field');
  }
  registerSecrets(context.secrets, secretsToRegister);
  return edits;
}

/**
 * Chats in the file, plus running Chats already removed from it. A removal waits
 * for a restart, so the running Chat still needs its model; without it the delete
 * would be written and only then rejected by the candidate check.
 */
function referencingChats(context: ProviderWriteContext): readonly Pick<FileChat, 'provider' | 'model'>[] {
  const saved = new Set(context.file.telegram.chats.map((chat) => chat.id));
  return [
    ...context.file.telegram.chats,
    ...context.snapshot.config.telegram.chats.filter((chat) => !saved.has(chat.id)),
  ];
}

export function deleteProvider(context: ProviderWriteContext, alias: string): ConfigEdit[] {
  providerOf(context.file, alias);
  if (
    context.file.agent.provider === alias ||
    context.file.vision.provider === alias ||
    referencingChats(context).some((chat) => chat.provider === alias)
  ) {
    throw new AdminQueryError(
      'provider_in_use',
      `Provider ${alias} is used by the default agent, a Chat, or vision`,
      409,
    );
  }
  return [{ path: ['providers', alias], value: undefined }];
}

export async function appendModels(
  context: ProviderWriteContext,
  alias: string,
  models: readonly ModelFileConfig[],
): Promise<ConfigEdit[]> {
  const provider = providerOf(context.file, alias);
  const api = providerApi(provider);
  const existing = new Set(provider.models.map((model) => model.id));
  for (const model of models) {
    if (existing.has(model.id)) {
      throw new AdminQueryError('model_exists', `Model ${model.id} is already configured on ${alias}`, 409);
    }
    existing.add(model.id);
    checkModel(api, model, `model ${model.id}`);
  }
  const offset = provider.models.length;
  return models.map((model, index) => ({
    path: ['providers', alias, 'models', offset + index],
    value: model,
  }));
}

export function replaceModel(
  context: ProviderWriteContext,
  alias: string,
  modelId: string,
  model: ModelFileConfig,
): ConfigEdit[] {
  const provider = providerOf(context.file, alias);
  if (model.id !== modelId) {
    throw new AdminQueryError('invalid_model_id', 'The model id in the body must match the path');
  }
  const index = provider.models.findIndex((candidate) => candidate.id === modelId);
  if (index < 0) {
    throw new AdminQueryError('model_not_found', `Model ${modelId} is not configured on ${alias}`, 404);
  }
  checkModel(providerApi(provider), model, `model ${model.id}`);
  return [{ path: ['providers', alias, 'models', index], value: model }];
}

export function deleteModel(context: ProviderWriteContext, alias: string, modelId: string): ConfigEdit[] {
  const provider = providerOf(context.file, alias);
  const index = provider.models.findIndex((candidate) => candidate.id === modelId);
  if (index < 0) {
    throw new AdminQueryError('model_not_found', `Model ${modelId} is not configured on ${alias}`, 404);
  }
  if (
    (context.file.agent.provider === alias && context.file.agent.model === modelId) ||
    (context.file.vision.provider === alias && context.file.vision.model === modelId) ||
    referencingChats(context).some((chat) => chat.provider === alias && chat.model === modelId)
  ) {
    throw new AdminQueryError('model_in_use', `Model ${modelId} is used by the default agent, a Chat, or vision`, 409);
  }
  return [{ path: ['providers', alias, 'models', index], value: undefined }];
}

/**
 * `vision.*` is validated only when the model registry is built, so a bad choice
 * would stop the next startup. The precheck runs against the file configuration,
 * which is what that startup will read.
 */
export function visionEdits(
  context: ProviderWriteContext,
  body: { readonly provider: string; readonly model: string },
): ConfigEdit[] {
  const provider = context.file.providers[body.provider];
  if (provider === undefined) {
    throw new AdminQueryError('unknown_provider', `Provider ${body.provider} is not configured`);
  }
  const model = provider.models.find((candidate) => candidate.id === body.model);
  if (model === undefined) {
    throw new AdminQueryError('unknown_model', `Model ${body.model} is absent from provider ${body.provider}`);
  }
  if (!model.input.includes('image')) {
    throw new AdminQueryError('not_image_capable', `Model ${body.model} does not accept image input`);
  }
  if (context.file.vision.max_output_tokens > model.max_tokens) {
    throw new AdminQueryError(
      'max_output_tokens_exceeded',
      `vision.max_output_tokens (${context.file.vision.max_output_tokens}) exceeds the model limit (${model.max_tokens})`,
    );
  }
  return [
    { path: ['vision', 'provider'], value: body.provider },
    { path: ['vision', 'model'], value: body.model },
  ];
}

/**
 * Sets the agent's thinking level. The level has to be one the agent model in
 * the file accepts, which is the same check the configuration runs on load.
 */
export function thinkingLevelEdits(
  context: ProviderWriteContext,
  body: { readonly thinking_level: ThinkingLevelConfig },
): ConfigEdit[] {
  const { provider, model: modelId } = context.file.agent;
  const model = context.file.providers[provider]?.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new AdminQueryError('unknown_model', `Agent model ${provider}/${modelId} is absent from the configuration`);
  }
  const supported = supportedThinkingLevels(model);
  if (!supported.includes(body.thinking_level)) {
    throw new AdminQueryError(
      'unsupported_thinking_level',
      `${provider}/${modelId} does not accept thinking level ${body.thinking_level} (supported: ${supported.join(', ')})`,
      422,
    );
  }
  return [{ path: ['agent', 'thinking_level'], value: body.thinking_level }];
}

export async function discover(context: ProviderWriteContext, body: DiscoverBody): Promise<DiscoverResponse> {
  const request = await discoveryRequest(context, body);
  const listing = await fetchProviderModels(request.request);
  const catalog = await loadCatalog(context.secrets);
  const drafts = resolveModelDrafts(request.descriptor, listing.models, catalog.catalog);
  const configured = new Set(
    (request.alias === undefined ? [] : (context.file.providers[request.alias]?.models ?? [])).map((model) => model.id),
  );
  return {
    endpoint: listing.endpoint,
    models: drafts.map((draft) => ({ ...draft, configured: configured.has(draft.id) })),
    metadata_source_error: catalog.error,
  };
}

interface CatalogLoad {
  readonly catalog: ModelsDevCatalog;
  readonly error: string | null;
}

/**
 * The catalog is one metadata source among several, so a fetch failure degrades
 * to "every field models.dev would have filled is missing" instead of failing
 * the request: the admin still sees the provider's own listing and can confirm
 * or type the rest.
 */
async function loadCatalog(secrets: SecretStore): Promise<CatalogLoad> {
  try {
    return { catalog: await loadModelsDevCatalog(), error: null };
  } catch (error) {
    return { catalog: {}, error: secrets.redact(error instanceof Error ? error.message : String(error)) };
  }
}

interface DiscoveryRequest {
  readonly request: Parameters<typeof fetchProviderModels>[0];
  readonly descriptor: Parameters<typeof resolveModelDrafts>[0];
  readonly alias: string | undefined;
}

async function discoveryRequest(context: ProviderWriteContext, body: DiscoverBody): Promise<DiscoveryRequest> {
  if (body.alias !== undefined) {
    if (body.kind !== undefined || body.provider !== undefined || body.base_url !== undefined) {
      throw new AdminQueryError('invalid_body', 'Pass either alias or a full connection, not both');
    }
    const configured = providerOf(context.file, body.alias);
    const active = context.snapshot.config.providers[body.alias];
    if (active === undefined) {
      throw new AdminQueryError(
        'provider_not_registered',
        `Provider ${body.alias} is not registered in the running process; apply the config file first or use the temporary mode`,
        409,
      );
    }
    if (!sameConnection(active, configured)) {
      // The running process still holds the old connection, and its credentials
      // must never be sent to an address that only exists in the file.
      throw new AdminQueryError(
        'connection_not_applied',
        `Provider ${body.alias} has connection fields the running process has not applied; apply the config file first or use the temporary mode`,
        409,
      );
    }
    const registered = context.snapshot.models.getProvider(body.alias);
    if (registered === undefined) {
      throw new AdminQueryError(
        'provider_not_registered',
        `Provider ${body.alias} is not registered in the running process; apply the config file first or use the temporary mode`,
        409,
      );
    }
    const auth = await context.snapshot.models.getAuth(body.alias);
    const apiKey = auth?.auth.apiKey;
    if (apiKey === undefined) {
      throw new AdminQueryError('credentials_unavailable', `Provider ${body.alias} has no resolved API key`, 409);
    }
    const api = providerApi(configured);
    const baseUrl = registered.baseUrl;
    if (baseUrl === undefined) {
      throw new AdminQueryError('invalid_base_url', `Provider ${body.alias} has no base URL`);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(registered.headers ?? {})) {
      // A `null` header value suppresses a provider default; there is nothing to send.
      if (value !== null) {
        headers[name] = value;
      }
    }
    const request = {
      ...(configured.kind === 'builtin' ? { builtinProvider: configured.provider } : {}),
      baseUrl,
      api,
      apiKey,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
    return {
      request,
      descriptor: {
        kind: configured.kind,
        ...(configured.kind === 'builtin' ? { builtinProvider: configured.provider } : {}),
        baseUrl,
        api,
      },
      alias: body.alias,
    };
  }
  if (body.kind === undefined || body.api_key === undefined) {
    throw new AdminQueryError('invalid_body', 'Temporary mode requires kind, a connection, and api_key');
  }
  if (body.kind === 'builtin') {
    if (body.provider === undefined) {
      throw new AdminQueryError('invalid_body', 'provider is required for a builtin provider');
    }
    const source = findBuiltinProvider(body.provider);
    if (source === undefined) {
      throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${body.provider}`);
    }
    const api = supportedBuiltinApi(source);
    if (api === null || source.baseUrl === undefined) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} has no single supported API adapter`,
      );
    }
    registerSecrets(context.secrets, [body.api_key, ...Object.values(body.headers ?? {})]);
    const request = {
      builtinProvider: body.provider,
      baseUrl: source.baseUrl,
      api,
      apiKey: body.api_key,
      ...(body.headers === undefined ? {} : { headers: body.headers }),
    };
    return {
      request,
      descriptor: { kind: 'builtin', builtinProvider: body.provider, baseUrl: source.baseUrl, api },
      alias: undefined,
    };
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  registerSecrets(context.secrets, [body.api_key, ...Object.values(body.headers ?? {})]);
  const baseUrl = body.base_url.replace(/\/+$/, '');
  const request = {
    baseUrl,
    api: body.api,
    apiKey: body.api_key,
    ...(body.headers === undefined ? {} : { headers: body.headers }),
  };
  return {
    request,
    descriptor: { kind: 'custom', baseUrl, api: body.api },
    alias: undefined,
  };
}

/** Metadata for ids the admin typed in, for endpoints with no listing to read. */
export async function lookupMetadata(body: LookupMetadataBody, secrets: SecretStore): Promise<LookupMetadataResponse> {
  const descriptor = await lookupDescriptor(body);
  const models: DiscoveredProviderModel[] = body.ids.map((id) => ({
    id,
    name: null,
    extension: { format: 'openai' },
  }));
  const catalog = await loadCatalog(secrets);
  return { models: resolveModelDrafts(descriptor, models, catalog.catalog), metadata_source_error: catalog.error };
}

async function lookupDescriptor(body: LookupMetadataBody): Promise<Parameters<typeof resolveModelDrafts>[0]> {
  if (body.kind === 'builtin') {
    if (body.provider === undefined) {
      throw new AdminQueryError('invalid_body', 'provider is required for a builtin provider');
    }
    const source = findBuiltinProvider(body.provider);
    if (source === undefined) {
      throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${body.provider}`);
    }
    const api = supportedBuiltinApi(source);
    if (api === null || source.baseUrl === undefined) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} has no single supported API adapter`,
      );
    }
    return { kind: 'builtin', builtinProvider: body.provider, baseUrl: source.baseUrl, api };
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  return { kind: 'custom', baseUrl: body.base_url.replace(/\/+$/, ''), api: body.api };
}
