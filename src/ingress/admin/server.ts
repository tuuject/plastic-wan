import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { type ServerType, serve } from '@hono/node-server';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { MediaDownloader } from '../../capabilities/media/media-download.ts';
import { DEFAULT_MEMORY_TTL_WARNING_DAYS } from '../../context/memory.ts';
import type { ImageBridge } from '../../image/bridge.ts';
import type { ImageService } from '../../image/service.ts';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import { assertConfigPermissions, loadConfig, type RawConfig } from '../../platform/config.ts';
import { type ConfigEdit, readConfigRevision } from '../../platform/config-file.ts';
import type { ConfigErrorCode, ConfigReloader } from '../../platform/config-reload.ts';
import {
  listOpenRouterImageEndpoints,
  listOpenRouterImageModels,
  validImageModelId,
} from '../../platform/image-models.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../../platform/model-switch.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { cancelAlarm, listAlarms, parseAlarmId } from '../../plugins/alarm/admin.ts';
import type { SqliteStore } from '../../store/database.ts';
import { resolveChatConfig } from '../../store/database.ts';
import { LongTaskService } from '../../store/long-tasks.ts';
import { getPromptVersion } from '../../store/prompt-versions.ts';
import { wakeFromSleep } from '../../store/sleep.ts';
import { authenticateApiKey, createApiKey, listApiKeys, parseCreateApiKeyBody, revokeApiKey } from './api-keys.ts';
import {
  AdminQueryError,
  getConversationContext,
  getInvocation,
  getMessage,
  type ListQuery,
  listConversationContexts,
  listInvocations,
  listMessages,
  listStickerSets,
  listStickers,
  overview,
  parseId,
  usage,
} from './audit.ts';
import { AdminAuth, AdminAuthError, type AdminCredentials } from './auth.ts';
import {
  createChat,
  deleteChat,
  listChats,
  parseChatId,
  parseChatSettings,
  parseCreateChat,
  updateChat,
} from './chats-admin.ts';
import {
  configurationView,
  configuredPromptView,
  inspectConfiguration,
  inspectionQuery,
  redactInspection,
} from './config-inspection.ts';
import { clearModelPayloads, parseDeveloperSettings } from './developer-admin.ts';
import { createImageAdminHandler, type ImageAdminResponse, reusableImageCredentials } from './image-admin.ts';
import { createInvocationMediaReader, listInvocationMedia } from './invocation-media.ts';
import {
  createMemory,
  deleteMemory,
  listMemories,
  listMemoryChats,
  parseCreateMemoryBody,
  parseMemoryId,
  parseUpdateMemoryBody,
  updateMemory,
} from './memory-admin.ts';
import { cancelOngoingSessions } from './operations.ts';
import { AdminPasskeys } from './passkeys.ts';
import {
  cancelPromptRunningInvocations,
  type PromptSaveResult,
  parsePromptCancelBody,
  parsePromptChatParam,
  parsePromptDiffQuery,
  parsePromptRestoreBody,
  parsePromptSaveBody,
  parsePromptVersionsQuery,
  promptDiffView,
  promptVersionContentView,
  promptVersionsView,
  promptVersionView,
  restorePromptVersion,
  savePromptVersion,
} from './prompts-admin.ts';
import {
  appendModels,
  createProvider,
  deleteModel,
  deleteProvider,
  discover,
  listProviderPresets,
  listProviders,
  lookupMetadata,
  PROVIDER_BODY_MAX_BYTES,
  type ProviderWriteContext,
  parseAlias,
  parseCreateProviderBody,
  parseDiscoverBody,
  parseLookupMetadataBody,
  parseModelBody,
  parseModelsBody,
  parseThinkingLevelBody,
  parseUpdateProviderBody,
  parseVisionBody,
  replaceModel,
  supervisedRestartEnabled,
  thinkingLevelEdits,
  updateProvider,
  visionEdits,
} from './providers-admin.ts';

const SESSION_COOKIE = 'plasticwan_admin';
const MAX_BODY_BYTES = 8_192;
/** Two prompt templates may each carry 64Ki characters, including JSON escaping overhead. */
const REPLAY_BODY_MAX_BYTES = 1_024 * 1_024;
const MAX_PROMPT_LENGTH = 65_536;
const imageCredentialSourcesValidator = Compile(
  Type.Record(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), Type.String({ minLength: 1, maxLength: 80 })),
);
const replayBodyValidator = Compile(
  Type.Object(
    {
      global_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH })),
      group_prompt: Type.Optional(Type.String({ maxLength: MAX_PROMPT_LENGTH })),
      before_send_id: Type.Optional(Type.String({ pattern: '^[1-9]\\d{0,18}$' })),
    },
    { additionalProperties: false },
  ),
);
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export type AdminConfig = NonNullable<RawConfig['admin']>;

/** Replay-only template overrides. Runtime protocol and other fixed prompt parts are never writable. */
export interface ReplayInvocationInput {
  readonly global_prompt?: string;
  readonly group_prompt?: string;
  readonly before_send_id?: string;
}

export interface AdminServerOptions {
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly scheduler?: BucketScheduler;
  readonly tasks?: LongTaskService;
  readonly modelSwitcher?: AgentModelSwitcher;
  readonly configReloader?: ConfigReloader;
  /** Registers panel-supplied plaintext secrets before they are written or sent. */
  readonly secrets?: SecretStore;
  /** Image generation service; absent when the host runs without one. */
  readonly imageService?: ImageService;
  /** The image bridge; absent without image generation. */
  readonly imageBridge?: ImageBridge;
  /** Starts the graceful shutdown that exits with the restart code. */
  readonly requestRestart?: () => void;
  /** Replays one audit invocation; absent when the agent runtime is not wired. */
  readonly replayInvocation?: (id: bigint, input: ReplayInvocationInput, signal: AbortSignal) => Promise<unknown>;
  /** Read-only replay checks and retained editable templates; neither calls a model. */
  readonly replayPreflight?: (id: bigint, selection?: Pick<ReplayInvocationInput, 'before_send_id'>) => unknown;
  readonly invocationPrompts?: (id: bigint) => unknown;
  /** Telegram bytes stay on the server; the caller can only name invocation-associated media IDs. */
  readonly mediaDownloader?: MediaDownloader;
  readonly shutdownSignal?: AbortSignal;
}

/** Model reference problems are user errors; everything else is a conflict. */
const MODEL_ERROR_STATUS: Partial<Record<ConfigErrorCode, number>> = {
  unknown_provider: 400,
  unknown_model: 400,
  not_text_capable: 400,
  model_unusable: 400,
  secret_unresolved: 422,
};

/** Write failures the panel can act on, versus the ones that need an operator. */
const CONFIG_WRITE_STATUS: Partial<Record<ConfigErrorCode, number>> = {
  config_conflict: 409,
  config_invalid: 422,
  config_permissions: 409,
  config_symlink: 409,
  secret_unresolved: 422,
  config_write_failed: 500,
};

export class AdminServer {
  readonly #store: SqliteStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #admin: AdminConfig;
  readonly #auth: AdminAuth;
  readonly #passkeys: AdminPasskeys | undefined;
  readonly #scheduler: BucketScheduler | undefined;
  readonly #tasks: LongTaskService;
  readonly #image: ReturnType<typeof createImageAdminHandler> | undefined;
  readonly #imageBridge: ImageBridge | undefined;
  readonly #modelSwitcher: AgentModelSwitcher | undefined;
  readonly #configReloader: ConfigReloader | undefined;
  readonly #secrets: SecretStore | undefined;
  readonly #requestRestart: (() => void) | undefined;
  readonly #replayInvocation:
    | ((id: bigint, input: ReplayInvocationInput, signal: AbortSignal) => Promise<unknown>)
    | undefined;
  readonly #replayPreflight: AdminServerOptions['replayPreflight'];
  readonly #invocationPrompts: ((id: bigint) => unknown) | undefined;
  readonly #readInvocationMedia: ReturnType<typeof createInvocationMediaReader> | undefined;
  readonly #staticDir: string;
  readonly #memoryWarningDays: number;
  #server: ServerType | undefined;
  #payloadClear: Promise<number> | undefined;

  constructor(options: AdminServerOptions) {
    const config = options.configStore.current().config;
    const admin = config.admin;
    if (admin === undefined) {
      throw new Error('Admin panel is not configured');
    }
    this.#store = options.store;
    this.#configStore = options.configStore;
    this.#admin = admin;
    this.#auth = new AdminAuth(options.store.orm, admin.session_ttl_hours);
    this.#passkeys =
      admin.public_url === undefined ? undefined : new AdminPasskeys(options.store.orm, this.#auth, admin.public_url);
    this.#scheduler = options.scheduler;
    this.#tasks = options.tasks ?? new LongTaskService(options.store.orm, () => this.#scheduler?.wake());
    this.#image =
      options.imageService === undefined || options.imageBridge === undefined
        ? undefined
        : createImageAdminHandler({
            service: options.imageService,
            bridge: options.imageBridge,
          });
    this.#imageBridge = options.imageBridge;
    this.#modelSwitcher = options.modelSwitcher;
    this.#configReloader = options.configReloader;
    this.#secrets = options.secrets;
    this.#requestRestart = options.requestRestart;
    this.#replayInvocation = options.replayInvocation;
    this.#replayPreflight = options.replayPreflight;
    this.#invocationPrompts = options.invocationPrompts;
    this.#readInvocationMedia =
      options.mediaDownloader === undefined
        ? undefined
        : createInvocationMediaReader({
            orm: options.store.orm,
            downloader: options.mediaDownloader,
            shutdownSignal: options.shutdownSignal ?? new AbortController().signal,
          });
    this.#staticDir = resolve(
      admin.static_dir ?? join(import.meta.dirname, '..', '..', '..', 'apps', 'admin-next', 'dist'),
    );
    this.#memoryWarningDays = config.agent.memory_ttl_warning_days ?? DEFAULT_MEMORY_TTL_WARNING_DAYS;
  }

  async start(): Promise<{ readonly hostname: string; readonly port: number }> {
    if (this.#server !== undefined) {
      throw new Error('Admin server is already listening');
    }
    this.#auth.purgeExpired();
    const server = serve({
      // The socket address, not a forwarded header: a caller controls
      // X-Forwarded-For, so keying the login throttle on it let every attempt
      // pick a fresh bucket.
      fetch: (request, env) =>
        this.handle(request, 'incoming' in env ? (env.incoming.socket.remoteAddress ?? 'unknown') : 'unknown'),
      hostname: this.#admin.host,
      port: this.#admin.port,
      serverOptions: {
        // Idle header waiting and idle keep-alive sockets are cut at 30s, while
        // slow but actively streaming responses are not interrupted.
        headersTimeout: 30_000,
        keepAliveTimeout: 30_000,
      },
    });
    this.#server = server;
    try {
      // @hono/node-server binds asynchronously, so wait for the event before
      // treating the panel as listening. The error listener surfaces bind
      // failures such as EADDRINUSE instead of leaving only an unhandled
      // 'error' event on stderr.
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    } catch (error) {
      this.#server = undefined;
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Admin server did not report a listening address');
    }
    return { hostname: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    await this.#payloadClear?.catch(() => undefined);
    if (server === undefined) {
      return;
    }
    await closeServer(server);
  }

  async #passkeyRequest(
    request: Request,
    url: URL,
    segments: readonly string[],
    clientAddress: string,
  ): Promise<Response> {
    const passkeys = this.#passkeys;
    if (passkeys === undefined) {
      return json({ error: 'passkeys_disabled', message: 'Configure admin.public_url to enable passkeys' }, 404);
    }
    const route = segments.join('/');
    const sessionToken = readCookie(request, SESSION_COOKIE);
    const challengeCookie = 'plasticwan_passkey';
    const challengeToken = readCookie(request, challengeCookie);
    if (request.method !== 'GET') {
      passkeys.checkOrigin(request.headers.get('origin'));
      passkeys.throttle(clientAddress);
    }
    const optionsResponse = (result: { options: unknown; token: string }): Response =>
      json(result.options, 200, `${challengeCookie}=${result.token}; ${cookieAttributes(request, url)}; Max-Age=300`);
    if (route === 'auth/passkeys/login/options' && request.method === 'POST') {
      return optionsResponse(await passkeys.loginOptions(challengeToken));
    }
    if (route === 'auth/passkeys/login/verify' && request.method === 'POST') {
      const token = await passkeys.login(await readJsonObject(request, 65_536), challengeToken);
      return json({ status: 'ok' }, 200, this.#sessionCookie(request, url, token));
    }
    const session = this.#auth.authenticate(sessionToken);
    if (session === null) {
      return json({ error: 'unauthenticated', message: 'Admin session is required' }, 401);
    }
    if (route === 'auth/passkeys' && request.method === 'GET') {
      return json(passkeys.list(session.userId));
    }
    if (route === 'auth/passkeys/register/options' && request.method === 'POST') {
      return optionsResponse(await passkeys.registrationOptions(sessionToken, challengeToken));
    }
    if (route === 'auth/passkeys/register/verify' && request.method === 'POST') {
      await passkeys.register(await readJsonObject(request, 65_536), challengeToken, sessionToken);
      return json({ status: 'ok' });
    }
    if (segments[1] === 'passkeys' && segments.length === 3 && request.method === 'DELETE') {
      passkeys.remove(session.userId, parseId(segments[2] ?? '', 'id'));
      return json({ status: 'ok' });
    }
    if (route === 'auth/password' && request.method === 'DELETE') {
      const token = this.#auth.removePassword(session.userId, passkeys.rpId);
      return json({ status: 'ok' }, 200, this.#sessionCookie(request, url, token));
    }
    return json({ error: 'method_not_allowed', message: 'Unsupported passkey operation' }, 405);
  }

  /** `clientAddress` is the transport peer; tests calling this directly share one. */
  async handle(request: Request, clientAddress = 'local'): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    try {
      if (segments[0] === 'api') {
        return await this.#api(request, url, segments.slice(1), clientAddress);
      }
      return await this.#staticAsset(request, segments);
    } catch (error) {
      if (error instanceof AdminAuthError || error instanceof AdminQueryError) {
        return json({ error: this.#redact(error.code), message: this.#redact(error.message) }, error.status);
      }
      console.error(
        JSON.stringify({
          event: 'admin_request_failed',
          path: this.#redact(url.pathname),
          error: this.#redact(error),
          at: new Date().toISOString(),
        }),
      );
      return json({ error: 'internal_error', message: 'Admin request failed' }, 500);
    }
  }

  async #api(request: Request, url: URL, segments: readonly string[], clientAddress: string): Promise<Response> {
    if (
      request.method !== 'GET' &&
      request.method !== 'POST' &&
      request.method !== 'PUT' &&
      request.method !== 'DELETE'
    ) {
      return json({ error: 'method_not_allowed', message: 'Unsupported method' }, 405);
    }
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
      const origin = request.headers.get('origin');
      if (origin !== null) {
        const originHost = parseOriginHost(origin);
        if (originHost === null) {
          return json({ error: 'bad_origin', message: 'Origin header is malformed' }, 400);
        }
        if (this.#passkeys === undefined ? originHost !== url.host : origin !== this.#passkeys.origin) {
          return json(
            {
              error: 'bad_origin',
              message:
                this.#passkeys === undefined
                  ? 'Cross-origin admin requests are rejected'
                  : 'Open the exact origin configured in admin.public_url to use this panel',
            },
            403,
          );
        }
      }
    }
    const route = segments.join('/');
    // Authorization never falls back to a panel cookie. The fixed programmatic
    // surface includes inspection reads and invocation replay, not panel writes.
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      return await this.#apiKeyRequest(request, url, segments, authorization);
    }
    if (route === 'auth/session' && request.method === 'GET') {
      const session = this.#auth.authenticate(readCookie(request, SESSION_COOKIE));
      return json({
        setup_required: this.#auth.setupRequired(),
        authenticated: session !== null,
        username: session?.username ?? null,
        expires_at: session?.expiresAt ?? null,
        passkeys_enabled: this.#passkeys !== undefined,
        has_password: session === null ? null : this.#auth.hasPassword(session.userId),
      });
    }
    if (segments[0] === 'auth' && (segments[1] === 'passkeys' || segments[1] === 'password')) {
      return await this.#passkeyRequest(request, url, segments, clientAddress);
    }
    if (route === 'auth/setup' && request.method === 'POST') {
      const token = await this.#auth.createFirstUser(await readCredentials(request));
      return json({ status: 'ok' }, 200, this.#sessionCookie(request, url, token));
    }
    if (route === 'auth/login' && request.method === 'POST') {
      const token = await this.#auth.login(await readCredentials(request), new Date(), clientAddress);
      return json({ status: 'ok' }, 200, this.#sessionCookie(request, url, token));
    }
    if (route === 'auth/logout' && request.method === 'POST') {
      this.#auth.logout(readCookie(request, SESSION_COOKIE));
      return json({ status: 'ok' }, 200, `${SESSION_COOKIE}=; ${cookieAttributes(request, url)}; Max-Age=0`);
    }
    const session = this.#auth.authenticate(readCookie(request, SESSION_COOKIE));
    if (session === null) {
      return json({ error: 'unauthenticated', message: 'Admin session is required' }, 401);
    }
    if (route === 'auth/credentials' && request.method === 'POST') {
      const token = await this.#auth.changeCredentials(session.userId, await readCredentials(request));
      return json({ status: 'ok' }, 200, this.#sessionCookie(request, url, token));
    }
    // API key management is session-only: an Authorization header never
    // reaches this block, so a key cannot mint, list, or revoke keys.
    if (route === 'api-keys' && request.method === 'GET') {
      return json({ items: listApiKeys(this.#store.orm) });
    }
    if (route === 'api-keys' && request.method === 'POST') {
      const created = createApiKey(this.#store.orm, parseCreateApiKeyBody(await readJsonObject(request)));
      this.#secrets?.remember(created.key);
      return json(created);
    }
    if (segments[0] === 'api-keys' && segments.length === 2 && request.method === 'DELETE') {
      revokeApiKey(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return json({ status: 'ok' });
    }
    if (route === 'cancel-ongoing-sessions' && request.method === 'POST') {
      // Close the database side first: an aborted run releases its un-injected
      // batches, and they must already be expired by then.
      const result = cancelOngoingSessions(this.#store.orm, new Date());
      const running = this.#scheduler?.abortAll() ?? 0;
      this.#scheduler?.wake();
      return json({ ...result, canceled_invocations: result.canceled_invocations + running });
    }
    if (route === 'wake' && request.method === 'POST') {
      const wasSleeping = wakeFromSleep(this.#store.orm);
      if (wasSleeping) {
        this.#scheduler?.wake();
      }
      return json({ status: 'awake', was_sleeping: wasSleeping });
    }
    if (route === 'developer/model-payloads' && request.method === 'DELETE') {
      if (this.#payloadClear !== undefined) {
        return json({ error: 'clear_in_progress', message: 'Model payload cleanup is already running' }, 409);
      }
      this.#payloadClear = clearModelPayloads(this.#store.orm);
      try {
        return json({ cleared_model_calls: await this.#payloadClear });
      } finally {
        this.#payloadClear = undefined;
      }
    }
    if (route === 'developer') {
      return await this.#developer(request);
    }
    const query = listQuery(url);
    if (route === 'memories' && request.method === 'GET') {
      return json(listMemories(this.#store.orm, query, this.#memoryWarningDays));
    }
    if (route === 'memories' && request.method === 'POST') {
      const body = parseCreateMemoryBody(await readJsonObject(request));
      return json(createMemory(this.#store.orm, body, this.#memoryWarningDays));
    }
    if (route === 'memories/chats' && request.method === 'GET') {
      return json({ items: listMemoryChats(this.#store.orm) });
    }
    if (segments[0] === 'memories' && segments.length === 2) {
      if (segments[1] === 'chats') {
        return json({ error: 'method_not_allowed', message: 'Memories chat options are read-only' }, 405);
      }
      const id = parseMemoryId(segments[1] ?? '');
      if (request.method === 'PUT') {
        const body = parseUpdateMemoryBody(await readJsonObject(request));
        return json(updateMemory(this.#store.orm, id, body, this.#memoryWarningDays));
      }
      if (request.method === 'DELETE') {
        deleteMemory(this.#store.orm, id);
        return json({ status: 'ok' });
      }
    }
    if (route === 'admins' && request.method === 'GET') {
      return await this.#adminsView();
    }
    if (route === 'admins' && request.method === 'POST') {
      return await this.#writeAdmins(request);
    }
    if (segments[0] === 'admins' && segments.length === 2 && request.method === 'DELETE') {
      return await this.#writeAdmins(request, segments[1] ?? '');
    }
    if (segments[0] === 'alarms' && segments.length === 2 && request.method === 'DELETE') {
      const id = parseAlarmId(segments[1] ?? '');
      const result = cancelAlarm(this.#tasks, this.#store.orm, id, session.username);
      return json(result);
    }
    if (route === 'model') {
      const switcher = this.#modelSwitcher;
      const reloader = this.#configReloader;
      if (switcher === undefined || reloader === undefined) {
        return json({ error: 'model_switch_unavailable', message: 'Runtime model switching is not wired' }, 503);
      }
      // `GET /model` was removed with the Model page: the Models page reads the
      // file view from `GET /providers` and gets the live model back from here.
      if (request.method === 'PUT') {
        const revision = requiredRevision(request);
        if (revision === null) {
          return revisionRequired();
        }
        const body = await readJsonObject(request);
        if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
          return json({ error: 'invalid_model_reference', message: 'provider and model must be strings' }, 400);
        }
        const result = await reloader.setAgentModel(body.provider, body.model, revision);
        if (!result.ok) {
          const status = MODEL_ERROR_STATUS[result.code] ?? 409;
          const message = result.fileWritten
            ? `config.jsonc was updated but not applied: ${result.message}`
            : result.message;
          return json({ error: result.code, message }, status);
        }
        return json({
          ...this.#modelState(switcher, switcher.current()),
          apply: { applied: result.applied, restart_required: result.restartRequired },
        });
      }
    }
    if (route === 'provider-presets' && request.method === 'GET') {
      return json({ presets: listProviderPresets() });
    }
    if (segments[0] === 'providers') {
      return await this.#providers(request, segments);
    }
    if (segments[0] === 'chats') {
      return await this.#chats(request, segments);
    }
    if (segments[0] === 'prompts') {
      // `GET prompts/global` / `prompts/group` stay on the shared inspection
      // surface; this dispatch returns `undefined` for them.
      const handled = await this.#prompts(request, url, segments, session.username);
      if (handled !== undefined) {
        return handled;
      }
    }
    if (segments[0] === 'image') {
      if (route === 'image/config' && request.method === 'GET') {
        return await this.#imageConfigView();
      }
      if (request.method === 'GET' && (route === 'image/models' || route === 'image/models/endpoints')) {
        const model = url.searchParams.get('model');
        if (route === 'image/models/endpoints' && !validImageModelId(model)) {
          return json({ error: 'invalid_model', message: '图片模型 ID 不合法' }, 400);
        }
        try {
          return json(
            route === 'image/models'
              ? { models: await listOpenRouterImageModels() }
              : { endpoints: await listOpenRouterImageEndpoints(model as string) },
          );
        } catch (error) {
          return json({ error: 'image_discovery_failed', message: this.#redact(error) }, 502);
        }
      }
      if (route === 'image/config' && request.method === 'PUT' && requiredRevision(request) === null) {
        return revisionRequired();
      }
      const handler = this.#image;
      if (handler === undefined) {
        return json({ error: 'image_unavailable', message: 'Image generation is not wired' }, 503);
      }
      const response = await handler(
        request,
        segments,
        url,
        { username: session.username },
        (maxBytes) => readJsonObject(request, maxBytes),
        async (body) => await this.#applyImageConfig(body, requiredRevision(request) ?? ''),
      );
      if (response.kind === 'content') {
        return new Response(new Uint8Array(response.bytes), {
          status: response.status,
          headers: { 'content-type': response.mime, 'cache-control': 'private, no-store' },
        });
      }
      return json(response.body, response.status);
    }
    if (route === 'vision' && request.method === 'PUT') {
      const body = parseVisionBody(await readJsonObject(request));
      return await this.#providerWrite(request, (context) => visionEdits(context, body));
    }
    if (route === 'thinking-level' && request.method === 'PUT') {
      const body = parseThinkingLevelBody(await readJsonObject(request));
      return await this.#providerWrite(request, (context) => thinkingLevelEdits(context, body));
    }
    if (route === 'restart' && request.method === 'POST') {
      return await this.#restart();
    }
    if (route === 'config/apply' && request.method === 'POST') {
      const reloader = this.#configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      const result = await reloader.reloadFromFile();
      if (!result.ok) {
        return json({ error: result.code, message: result.message }, 422);
      }
      return json({
        status: 'applied',
        applied: result.applied,
        restart_required: result.restartRequired,
        outside_serve: result.outsideServe,
        generation: result.status.generation,
        active_hash: result.status.activeHash,
        file_hash: result.status.fileHash,
      });
    }
    if (route === 'config/status' && request.method === 'GET') {
      const reloader = this.#configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      const status = reloader.status();
      return json({
        generation: status.generation,
        active_hash: status.activeHash,
        file_hash: status.fileHash,
        restart_required: status.restartRequired,
        last_error: status.lastError,
      });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed', message: 'Audit routes are read-only' }, 405);
    }
    const inspection = await this.#inspectionRead(request, url, segments);
    if (inspection !== undefined) {
      return inspection;
    }
    if (route === 'overview') {
      return json(overview(this.#store.orm));
    }
    if (route === 'alarms') {
      return json(listAlarms(this.#store.orm, query));
    }
    if (route === 'usage') {
      const daysParam = url.searchParams.get('days');
      const days = daysParam === null ? 7 : Number.parseInt(daysParam, 10);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return json({ error: 'invalid_days', message: 'days must be an integer between 1 and 90' }, 400);
      }
      return json(usage(this.#store.orm, days));
    }
    if (route === 'invocations') {
      return json(
        redactInspection(listInvocations(this.#store.orm, query, this.#configStore.current().config), this.#secrets),
      );
    }
    if (segments[0] === 'invocations' && segments.length === 2) {
      const found = getInvocation(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Invocation does not exist' }, 404) : json(found);
    }
    if (route === 'contexts') {
      return json(listConversationContexts(this.#store.orm, query));
    }
    if (segments[0] === 'contexts' && segments.length === 2) {
      const found = getConversationContext(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null
        ? json({ error: 'not_found', message: 'Conversation context does not exist' }, 404)
        : json(found);
    }
    if (route === 'messages') {
      return json(listMessages(this.#store.orm, query));
    }
    if (segments[0] === 'messages' && segments.length === 2) {
      const found = getMessage(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Message does not exist' }, 404) : json(found);
    }
    if (route === 'sticker-sets') {
      return json({ items: listStickerSets(this.#store.orm) });
    }
    if (route === 'stickers') {
      return json(listStickers(this.#store.orm, query));
    }
    return json({ error: 'not_found', message: 'Unknown admin API route' }, 404);
  }

  /**
   * The programmatic surface of an `Authorization: Bearer pwk_…` request. The
   * key authenticates the caller, but the surface is fixed: inspection reads,
   * invocation reads and isolated replay. Every other route is refused — including
   * API key management and credential/config writes. A cookie never upgrades it.
   */
  async #apiKeyRequest(
    request: Request,
    url: URL,
    segments: readonly string[],
    authorization: string,
  ): Promise<Response> {
    const scheme = 'Bearer ';
    const token =
      authorization.slice(0, scheme.length).toLowerCase() === scheme.toLowerCase()
        ? authorization.slice(scheme.length).trim()
        : '';
    if (token.length === 0 || authenticateApiKey(this.#store.orm, token) === null) {
      return json({ error: 'unauthenticated', message: 'A valid API key is required' }, 401);
    }
    this.#secrets?.remember(token);
    const inspection = await this.#inspectionRead(request, url, segments, token);
    if (inspection !== undefined) {
      return inspection;
    }
    if (segments[0] !== 'invocations') {
      return json({ error: 'forbidden', message: 'API keys may only access inspection and invocation routes' }, 403);
    }
    if (segments.length === 1 && request.method === 'GET') {
      return json(
        redactInspection(
          listInvocations(this.#store.orm, listQuery(url), this.#configStore.current().config),
          this.#secrets,
          token,
        ),
      );
    }
    if (segments.length === 2 && request.method === 'GET') {
      const found = getInvocation(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Invocation does not exist' }, 404) : json(found);
    }
    if (segments.length === 3 && segments[2] === 'replay' && request.method === 'POST') {
      return await this.#replayInvocationRoute(request, parseId(segments[1] ?? '', 'id'));
    }
    return json({ error: 'forbidden', message: 'API keys may only access inspection and invocation routes' }, 403);
  }

  /** Exact GET allowlist shared by sessions and keys; never dispatches panel writes. */
  async #inspectionRead(
    request: Request,
    url: URL,
    segments: readonly string[],
    token?: string,
  ): Promise<Response | undefined> {
    if (request.method !== 'GET') {
      return undefined;
    }
    const route = segments.join('/');
    const inspectedJson = (value: unknown): Response => json(redactInspection(value, this.#secrets, token));
    if (route === 'config/view' || route === 'prompts/global' || route === 'prompts/group') {
      const query = inspectionQuery(url, route === 'prompts/group');
      const { config, ...metadata } = await inspectConfiguration(this.#configStore, this.#configReloader, query.source);
      return inspectedJson(
        route === 'config/view'
          ? { ...metadata, config: configurationView(config) }
          : {
              ...metadata,
              ...configuredPromptView(
                config,
                this.#store.orm,
                route === 'prompts/global' ? 'global' : 'group',
                query.chatId,
              ),
            },
      );
    }
    if (segments[0] !== 'invocations') {
      return undefined;
    }
    const action = segments[2];
    if (segments.length === 3 && (action === 'replay-preflight' || action === 'prompts')) {
      for (const key of url.searchParams.keys()) {
        if (action !== 'replay-preflight' || key !== 'before_send_id' || url.searchParams.getAll(key).length !== 1) {
          throw new AdminQueryError('invalid_query', 'Only replay preflight accepts one before_send_id parameter');
        }
      }
      const id = parseId(segments[1] ?? '', 'id');
      const beforeSendId = url.searchParams.get('before_send_id');
      const selection = beforeSendId === null ? {} : { before_send_id: validateBeforeSendId(beforeSendId) };
      if (action === 'replay-preflight') {
        if (this.#replayPreflight === undefined) {
          throw new AdminQueryError('replay_unavailable', 'Invocation replay inspection is not wired', 503);
        }
        return inspectedJson(await this.#replayPreflight(id, selection));
      }
      if (this.#invocationPrompts === undefined) {
        throw new AdminQueryError('replay_unavailable', 'Invocation replay inspection is not wired', 503);
      }
      return inspectedJson(await this.#invocationPrompts(id));
    }
    if (action !== 'media') {
      return undefined;
    }
    if (segments.length === 3) {
      if (url.searchParams.size > 0) {
        throw new AdminQueryError('invalid_query', 'Media listing takes no query parameters');
      }
      return inspectedJson(listInvocationMedia(this.#store.orm, parseId(segments[1] ?? '', 'id')));
    }
    if (segments.length !== 5 || segments[4] !== 'content') {
      return undefined;
    }
    for (const key of url.searchParams.keys()) {
      if (key !== 'variant' || url.searchParams.getAll(key).length !== 1) {
        throw new AdminQueryError('invalid_query', 'Media content only accepts one variant parameter');
      }
    }
    const variant = url.searchParams.get('variant') ?? 'original';
    if (variant !== 'original' && variant !== 'preview') {
      throw new AdminQueryError('invalid_variant', 'variant must be original or preview');
    }
    const invocationId = parseId(segments[1] ?? '', 'id');
    const mediaId = parseId(segments[3] ?? '', 'media_id');
    const read = this.#readInvocationMedia;
    if (read === undefined) {
      throw new AdminQueryError('media_unavailable', 'Invocation media downloading is not wired', 503);
    }
    const content = await read(invocationId, mediaId, variant, request.signal);
    return new Response(new Uint8Array(content.bytes), {
      headers: {
        ...SECURITY_HEADERS,
        'content-type': content.mime,
        'content-length': String(content.bytes.byteLength),
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment',
        'x-plasticwan-media-variant': content.variant,
      },
    });
  }

  /**
   * Replay is dispatched to the host-supplied engine; the AdminServer neither
   * reads invocation state nor runs a model itself. Domain failures surface as
   * AdminQueryError thrown by the engine and are rendered by `handle`; anything
   * else becomes the generic internal error, so no engine detail leaks.
   */
  async #replayInvocationRoute(request: Request, invocationId: bigint): Promise<Response> {
    const replay = this.#replayInvocation;
    if (replay === undefined) {
      return json({ error: 'replay_unavailable', message: 'Invocation replay is not wired' }, 503);
    }
    const input = parseReplayInput(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
    return json(await replay(invocationId, input, request.signal));
  }

  /**
   * `/api/providers` — the model manager's read and write surface.
   *
   * Model ids may contain `/`, so the path is split on `/` first and each segment
   * is decoded afterwards: `PUT /providers/:alias/models/:id` only matches when
   * the client encoded the id.
   */
  async #providers(request: Request, segments: readonly string[]): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined || this.#secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    const parts = decodeSegments(segments);
    if (parts === null) {
      return json({ error: 'invalid_path', message: 'Path segments must be valid percent-encoded UTF-8' }, 400);
    }
    const second = parts[1];
    const third = parts[2];
    const fourth = parts[3];
    // Checked before the body is parsed, so a missing revision is reported as
    // such even when the payload is malformed too. Discovery and metadata lookup
    // write nothing and therefore need no revision.
    const readShapedPost = parts.length === 2 && (second === 'discover' || second === 'lookup-metadata');
    if (request.method !== 'GET' && !readShapedPost && requiredRevision(request) === null) {
      return revisionRequired();
    }
    if (parts.length === 1 && request.method === 'GET') {
      return json(await this.#providersView(reloader));
    }
    if (parts.length === 1 && request.method === 'POST') {
      const body = parseCreateProviderBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerWrite(request, (context) => createProvider(context, body));
    }
    if (parts.length === 2 && second === 'discover' && request.method === 'POST') {
      const body = parseDiscoverBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerResponse((context) => discover(context, body));
    }
    if (parts.length === 2 && second === 'lookup-metadata' && request.method === 'POST') {
      const body = parseLookupMetadataBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerResponse((context) => lookupMetadata(body, context.secrets));
    }
    if (parts.length === 2 && second !== undefined && request.method === 'PUT') {
      const alias = parseAlias(second);
      const body = parseUpdateProviderBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerWrite(request, (context) => updateProvider(context, alias, body));
    }
    if (parts.length === 2 && second !== undefined && request.method === 'DELETE') {
      const alias = parseAlias(second);
      return await this.#providerWrite(request, (context) => deleteProvider(context, alias));
    }
    if (parts.length === 3 && second !== undefined && third === 'models' && request.method === 'POST') {
      const alias = parseAlias(second);
      const models = parseModelsBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerWrite(request, (context) => appendModels(context, alias, models));
    }
    if (parts.length === 4 && second !== undefined && third === 'models' && fourth !== undefined) {
      const alias = parseAlias(second);
      if (request.method === 'PUT') {
        const model = parseModelBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
        return await this.#providerWrite(request, (context) => replaceModel(context, alias, fourth, model));
      }
      if (request.method === 'DELETE') {
        return await this.#providerWrite(request, (context) => deleteModel(context, alias, fourth));
      }
    }
    return json({ error: 'not_found', message: 'Unknown providers route' }, 404);
  }

  /**
   * A write endpoint: the file is read for the prechecks, the edits are applied
   * inside the reloader's lock, and the response carries both the apply summary
   * and the refreshed view so the panel needs no second round trip.
   */
  async #providerWrite(
    request: Request,
    build: (context: ProviderWriteContext) => Promise<ConfigEdit[]> | ConfigEdit[],
  ): Promise<Response> {
    const reloader = this.#configReloader;
    const secrets = this.#secrets;
    if (reloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    let context: ProviderWriteContext;
    try {
      context = await this.#providerContext(reloader);
    } catch (error) {
      return json({ error: 'config_invalid', message: this.#redact(error) }, 422);
    }
    let edits: readonly ConfigEdit[];
    try {
      edits = await build(context);
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      return json({ error: 'provider_write_failed', message: this.#redact(error) }, 500);
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await this.#providersView(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  }

  async #chats(request: Request, segments: readonly string[]): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'chats_unavailable', message: 'Chat management is not wired' }, 503);
    }
    if (request.method === 'GET' && segments.length === 1) {
      return json(await this.#chatsView(reloader));
    }
    if (
      !(
        (request.method === 'POST' && segments.length === 1) ||
        ((request.method === 'PUT' || request.method === 'DELETE') && segments.length === 2)
      )
    ) {
      return json({ error: 'method_not_allowed', message: 'Unsupported Chat operation' }, 405);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const { loaded, revision: currentRevision } = await this.#configFile(reloader);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    let edits: readonly ConfigEdit[];
    if (request.method === 'POST') {
      edits = createChat(loaded.fileConfig, parseCreateChat(await readJsonObject(request)));
    } else {
      const id = parseChatId(segments[1] ?? '');
      edits =
        request.method === 'DELETE'
          ? deleteChat(loaded.fileConfig, id)
          : updateChat(loaded.fileConfig, id, parseChatSettings(await readJsonObject(request)));
    }
    // The revision pins the ID-to-array-index mapping even if another writer reorders the file.
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await this.#chatsView(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  }

  /**
   * `/api/prompts/*` — the prompt manager's versioned read and write surface.
   * The plain prompt views (`GET prompts/global` / `prompts/group`) stay on the
   * shared inspection surface, so this dispatch returns `undefined` for them
   * and they fall through to `#inspectionRead`.
   */
  async #prompts(
    request: Request,
    url: URL,
    segments: readonly string[],
    username: string,
  ): Promise<Response | undefined> {
    const second = segments[1];
    if (segments.length === 2 && (second === 'global' || second === 'group')) {
      if (request.method === 'GET') {
        return undefined;
      }
      if (request.method !== 'PUT') {
        return json({ error: 'method_not_allowed', message: 'Use PUT to save a prompt' }, 405);
      }
      return await this.#promptSave(request, url, second === 'global' ? 'global' : 'group', username);
    }
    if (segments.length === 2 && second === 'versions') {
      if (request.method !== 'GET') {
        return json({ error: 'method_not_allowed', message: 'Prompt versions are read-only' }, 405);
      }
      return this.#promptVersionsView(url);
    }
    if (segments.length === 3 && second === 'versions' && request.method === 'GET') {
      const version = getPromptVersion(this.#store.orm, parseId(segments[2] ?? '', 'version_id'));
      if (version === undefined) {
        return json({ error: 'version_not_found', message: 'The prompt version does not exist' }, 404);
      }
      return json(redactInspection(promptVersionContentView(version), this.#secrets));
    }
    if (segments.length === 4 && second === 'versions' && segments[3] === 'restore' && request.method === 'POST') {
      return await this.#promptRestore(request, segments[2] ?? '', username);
    }
    if (segments.length === 2 && second === 'diff') {
      if (request.method !== 'GET') {
        return json({ error: 'method_not_allowed', message: 'Prompt diff is read-only' }, 405);
      }
      const { from, to } = parsePromptDiffQuery(url);
      return json(redactInspection(promptDiffView(this.#store.orm, from, to), this.#secrets));
    }
    if (segments.length === 2 && second === 'cancel-running' && request.method === 'POST') {
      return await this.#promptCancelRunning(request);
    }
    return undefined;
  }

  async #promptSave(request: Request, url: URL, scope: 'global' | 'group', username: string): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'prompts_unavailable', message: 'Prompt management is not wired' }, 503);
    }
    const expected = requiredRevision(request);
    if (expected === null) {
      return json({ error: 'revision_required', message: 'If-Match with the prompt content hash is required' }, 400);
    }
    const body = parsePromptSaveBody(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
    let chatId: bigint | undefined;
    if (scope === 'group') {
      chatId = parsePromptChatParam(url.searchParams.get('chat'));
    } else if (url.searchParams.size > 0) {
      return json({ error: 'invalid_query', message: 'The global prompt takes no query parameters' }, 400);
    }
    const outcome = await savePromptVersion(this.#store.orm, reloader, {
      scope,
      chatId,
      content: body.prompt,
      note: body.note,
      source: 'panel',
      expectedHash: expected,
      username,
    });
    return this.#promptSaveResponse(outcome);
  }

  async #promptRestore(request: Request, versionId: string, username: string): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'prompts_unavailable', message: 'Prompt management is not wired' }, 503);
    }
    const expected = requiredRevision(request);
    if (expected === null) {
      return json({ error: 'revision_required', message: 'If-Match with the prompt content hash is required' }, 400);
    }
    const body = parsePromptRestoreBody(await readJsonObject(request, REPLAY_BODY_MAX_BYTES));
    const outcome = await restorePromptVersion(this.#store.orm, reloader, parseId(versionId, 'version_id'), {
      expectedHash: expected,
      note: body.note,
      username,
    });
    return this.#promptSaveResponse(outcome);
  }

  #promptSaveResponse(outcome: PromptSaveResult): Response {
    if (outcome.kind === 'unchanged') {
      return json({
        status: 'unchanged',
        version: outcome.latest === undefined ? null : promptVersionView(outcome.latest),
      });
    }
    if (outcome.kind === 'apply_failed') {
      const message = `The prompt file was written and the version recorded, but the configuration was not applied: ${outcome.message}`;
      return json(
        { error: outcome.code, message, version: promptVersionView(outcome.version) },
        CONFIG_WRITE_STATUS[outcome.code] ?? 409,
      );
    }
    return json({
      status: 'saved',
      version: promptVersionView(outcome.version),
      applied: outcome.result.applied,
      restart_required: outcome.result.restartRequired,
      outside_serve: outcome.result.outsideServe,
      active_hash: outcome.result.status.activeHash,
      file_hash: outcome.result.status.fileHash,
      // Running invocations still on the old prompt; cancel them explicitly.
      affected_running: outcome.affectedRunning,
      // The changed stable prompt rebuilds the affected Conversation Contexts
      // on their next run.
      context_rebuild: true,
    });
  }

  #promptVersionsView(url: URL): Response {
    const query = parsePromptVersionsQuery(url);
    if (query.scope === 'group') {
      // Same resolution as `configuredPromptView`, so the panel's chat filter
      // accepts the configured or migrated ID it already shows.
      const chat = resolveChatConfig(this.#configStore.current().config, this.#store.orm, query.chatId);
      if (chat === undefined) {
        return json({ error: 'chat_unconfigured', message: 'The requested chat is not configured' }, 404);
      }
      return json(promptVersionsView(this.#store.orm, 'group', BigInt(chat.id)));
    }
    return json(promptVersionsView(this.#store.orm, 'global', 0n));
  }

  async #promptCancelRunning(request: Request): Promise<Response> {
    const body = parsePromptCancelBody(await readJsonObject(request));
    let configuredChatId: bigint | undefined;
    if (body.scope === 'group') {
      if (body.chat_id === undefined) {
        return json({ error: 'invalid_body', message: 'chat_id is required for the group scope' }, 400);
      }
      const chat = resolveChatConfig(this.#configStore.current().config, this.#store.orm, BigInt(body.chat_id));
      if (chat === undefined) {
        return json({ error: 'chat_unconfigured', message: 'The requested chat is not configured' }, 404);
      }
      configuredChatId = BigInt(chat.id);
    } else if (body.chat_id !== undefined) {
      return json({ error: 'invalid_body', message: 'chat_id is not valid for the global scope' }, 400);
    }
    const current = this.#configStore.current();
    return json(
      cancelPromptRunningInvocations(this.#store.orm, this.#scheduler, current.hash, body.scope, configuredChatId),
    );
  }

  async #configFile(reloader: ConfigReloader) {
    try {
      // A revision must describe the very file used to build the view and edit paths,
      // never a newer file read after an intervening write.
      const revision = await readConfigRevision(reloader.configPath);
      const loaded = await loadConfig(reloader.configPath);
      if (revision !== (await readConfigRevision(reloader.configPath))) {
        throw new AdminQueryError(
          'config_conflict',
          'The configuration file changed while being read; reload and try again',
          409,
        );
      }
      return { loaded, revision };
    } catch (error) {
      if (error instanceof AdminQueryError) {
        throw error;
      }
      throw new AdminQueryError('config_invalid', this.#redact(error), 422);
    }
  }

  /**
   * The bot admin whitelist is the `telegram.admins` config field. GET shows
   * the on-disk list with its revision; POST/DELETE write that field through
   * the reloader, so a successful write is hot-applied like every other
   * configuration write.
   */
  async #adminsView(): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'admins_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const { loaded, revision } = await this.#configFile(reloader);
    return json({ items: this.#adminItems(loaded.fileConfig.telegram.admins), revision });
  }

  async #writeAdmins(request: Request, removeId?: string): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'admins_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const { loaded, revision: currentRevision } = await this.#configFile(reloader);
    if (revision !== currentRevision) {
      return json({ error: 'config_conflict', message: 'The configuration file changed; reload before editing' }, 409);
    }
    const current = loaded.fileConfig.telegram.admins ?? [];
    let merged: number[];
    if (removeId === undefined) {
      const added = this.#parseTelegramUserId((await readJsonObject(request)).telegram_user_id);
      // Adding an existing ID is a no-op; a no-change edit would fail the write.
      if (current.includes(added)) {
        return json({
          items: this.#adminItems(current),
          revision: currentRevision,
          apply: { applied: [], restart_required: [], outside_serve: [] },
        });
      }
      merged = [...current, added];
    } else {
      const removed = this.#parseTelegramUserId(removeId, 'admin_id');
      if (!current.includes(removed)) {
        return json({ error: 'not_found', message: 'The Telegram user ID is not in the bot admin whitelist' }, 404);
      }
      merged = current.filter((entry) => entry !== removed);
    }
    const result = await reloader.writeAndApply([{ path: ['telegram', 'admins'], value: merged }], revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    const view = await this.#configFile(reloader);
    return json({
      items: this.#adminItems(view.loaded.fileConfig.telegram.admins),
      revision: view.revision,
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  }

  #adminItems(admins: readonly number[] | undefined): { telegram_user_id: string }[] {
    return (admins ?? []).map((id) => ({ telegram_user_id: id.toString() }));
  }

  #parseTelegramUserId(value: unknown, field = 'telegram_user_id'): number {
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new AdminQueryError('invalid_telegram_user_id', `${field} must be a positive safe integer`, 400);
    }
    return parsed;
  }

  async #chatsView(reloader: ConfigReloader) {
    const { loaded, revision } = await this.#configFile(reloader);
    return listChats(
      loaded.fileConfig,
      this.#configStore.current().config,
      this.#store,
      revision,
      reloader.status().restartRequired,
    );
  }

  async #developer(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return json({ error: 'method_not_allowed', message: 'Unsupported Developer operation' }, 405);
    }
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'developer_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    if (request.method === 'GET') {
      return json(await this.#developerView(reloader));
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    const body = parseDeveloperSettings(await readJsonObject(request));
    const result = await reloader.writeAndApply(
      [{ path: ['developer', 'record_model_payloads'], value: body.record_model_payloads }],
      revision,
    );
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await this.#developerView(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  }

  async #developerView(reloader: ConfigReloader) {
    const { loaded, revision } = await this.#configFile(reloader);
    return {
      revision,
      record_model_payloads: loaded.config.developer.record_model_payloads,
      active_record_model_payloads: this.#configStore.current().config.developer.record_model_payloads,
    };
  }

  /** A read-shaped POST: provider discovery and metadata lookup write nothing. */
  async #providerResponse(build: (context: ProviderWriteContext) => Promise<unknown>): Promise<Response> {
    const reloader = this.#configReloader;
    const secrets = this.#secrets;
    if (reloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    let context: ProviderWriteContext;
    try {
      context = await this.#providerContext(reloader);
    } catch (error) {
      return json({ error: 'config_invalid', message: this.#redact(error) }, 422);
    }
    try {
      return json(await build(context));
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      // Upstream failures echo the request, key included.
      return json({ error: 'provider_discovery_failed', message: this.#redact(error) }, 502);
    }
  }

  async #providerContext(reloader: ConfigReloader): Promise<ProviderWriteContext> {
    const secrets = this.#secrets;
    if (secrets === undefined) {
      throw new Error('Provider management is not wired');
    }
    const loaded = await loadConfig(reloader.configPath);
    return { file: loaded.fileConfig, secrets, snapshot: this.#configStore.current() };
  }

  /**
   * The panel reads the file, not the active configuration: a pending restart
   * must be visible as what is on disk, and the revision is the file's own.
   */
  async #providersView(reloader: ConfigReloader): Promise<ReturnType<typeof listProviders>> {
    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    try {
      loaded = await loadConfig(reloader.configPath);
    } catch (error) {
      throw new AdminQueryError('config_invalid', this.#redact(error), 422);
    }
    const revision = await readConfigRevision(reloader.configPath);
    return listProviders(loaded.fileConfig, revision, reloader.status().restartRequired);
  }

  async #imageConfigView(): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = await readConfigRevision(reloader.configPath);
    const loaded = await loadConfig(reloader.configPath);
    if (revision !== (await readConfigRevision(reloader.configPath))) {
      return json({ error: 'config_conflict', message: '配置已变化，请重新加载' }, 409);
    }
    return json({
      revision,
      enabled: loaded.fileConfig.image !== undefined,
      credentials: Object.keys(loaded.fileConfig.image?.credentials ?? {}),
      credential_providers: Object.keys(reusableImageCredentials(loaded.fileConfig)),
      models: loaded.fileConfig.image?.models ?? [],
    });
  }

  /**
   * The image capability switch: enable writes the `image` section (plaintext
   * credentials travel as edit keys into the key jar, the file keeps SecretRef
   * names), disable removes the section — which also garbage-collects the
   * now-unreferenced jar entries. Applies through the reloader lock, so the
   * snapshot publishes without a restart.
   */
  async #applyImageConfig(body: Record<string, unknown>, revision: string): Promise<ImageAdminResponse> {
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return {
        kind: 'json',
        status: 503,
        body: { error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' },
      };
    }
    const enabled = body.enabled;
    if (typeof enabled !== 'boolean') {
      return { kind: 'json', status: 400, body: { error: 'invalid_body', message: 'enabled must be a boolean' } };
    }
    if (revision !== (await readConfigRevision(reloader.configPath))) {
      return { kind: 'json', status: 409, body: { error: 'config_conflict', message: '配置已变化，请重新加载后保存' } };
    }
    let edits: readonly ConfigEdit[];
    if (!enabled) {
      edits = [{ path: ['image'], value: undefined }];
    } else {
      const credentials = body.credentials;
      const models = body.models;
      if (
        typeof credentials !== 'object' ||
        credentials === null ||
        Array.isArray(credentials) ||
        !Array.isArray(models) ||
        models.length === 0
      ) {
        return {
          kind: 'json',
          status: 400,
          body: { error: 'invalid_body', message: 'enabling requires credentials (name -> secret) and a models array' },
        };
      }
      const loaded = await loadConfig(reloader.configPath);
      const credentialNames: Record<string, string> = {};
      const secretRefs = { ...loaded.fileConfig.image?.credentials };
      const sources = body.credential_sources ?? {};
      if (!imageCredentialSourcesValidator.Check(sources)) {
        return { kind: 'json', status: 400, body: { error: 'invalid_body', message: '凭据来源格式不正确' } };
      }
      const reusable = reusableImageCredentials(loaded.fileConfig);
      for (const [name, alias] of Object.entries(sources)) {
        const ref = Object.hasOwn(reusable, alias) ? reusable[alias] : undefined;
        if (ref === undefined) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `OpenRouter 凭据来源不存在：${alias}` },
          };
        }
        secretRefs[name] = ref;
      }
      for (const [name, plaintext] of Object.entries(credentials)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name) || typeof plaintext !== 'string' || plaintext.length === 0) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `invalid credential entry: ${name}` },
          };
        }
        credentialNames[name] = plaintext;
        secretRefs[name] = { jar: name };
      }
      const { ImageSectionSchema } = await import('../../platform/config.ts');
      const sectionValidator = Compile(ImageSectionSchema);
      if (!sectionValidator.Check({ credentials: secretRefs, models })) {
        const detail = [...sectionValidator.Errors({ credentials: secretRefs, models })]
          .slice(0, 3)
          .map((error) => `${error.instancePath}: ${error.message ?? 'invalid'}`)
          .join('; ');
        return {
          kind: 'json',
          status: 400,
          body: { error: 'invalid_body', message: `image section is invalid: ${detail}` },
        };
      }
      const modelIds = new Set<string>();
      for (const model of models) {
        if (modelIds.has(model.id)) {
          return { kind: 'json', status: 400, body: { error: 'invalid_body', message: `模型 ID 重复：${model.id}` } };
        }
        modelIds.add(model.id);
        if (!Object.hasOwn(secretRefs, model.credentialRef)) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `模型 ${model.name} 的凭据 ${model.credentialRef} 尚未配置` },
          };
        }
      }
      for (const plaintext of Object.values(credentialNames)) {
        this.#secrets?.remember(plaintext);
      }
      edits = [
        { path: ['image', 'credentials'], value: secretRefs, keys: credentialNames },
        { path: ['image', 'models'], value: models },
      ];
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return { kind: 'json', status: CONFIG_WRITE_STATUS[result.code] ?? 409, body: { error: result.code, message } };
    }
    const bridgeEnabled = this.#imageBridge?.enabled() ?? false;
    return {
      kind: 'json',
      status: 200,
      body: {
        enabled: enabled && bridgeEnabled,
        apply: { applied: result.applied, restart_required: result.restartRequired },
      },
    };
  }

  async #restart(): Promise<Response> {
    if (!supervisedRestartEnabled()) {
      return json(
        {
          error: 'restart_unsupported',
          message:
            'This deployment does not declare an external supervisor; set PLASTICWAN_SUPERVISED=1 when something restarts the process',
        },
        409,
      );
    }
    const reloader = this.#configReloader;
    const requestRestart = this.#requestRestart;
    if (reloader === undefined || requestRestart === undefined) {
      return json({ error: 'restart_unavailable', message: 'Restarting is not wired' }, 503);
    }
    try {
      await assertConfigPermissions(reloader.configPath);
      await loadConfig(reloader.configPath);
    } catch (error) {
      return json({ error: 'config_invalid', message: this.#redact(error) }, 422);
    }
    // The response has to leave the socket before the shutdown closes it, and
    // `stop()` destroys live connections rather than draining them. Two things
    // keep the 202 intact: the adaptor writes it while resolving this promise,
    // which runs before the `setImmediate` callback, and `serve`'s shutdown only
    // reaches `admin.stop()` after `bot.stop()` has unblocked long polling. The
    // second one is a property of the caller, so `requestRestart` states it too.
    setImmediate(() => requestRestart());
    return json({ status: 'restarting' }, 202);
  }

  #redact(error: unknown): string {
    const message = messageOf(error);
    return this.#secrets === undefined ? message : this.#secrets.redact(message);
  }

  #modelState(
    switcher: AgentModelSwitcher,
    current: AgentModelOption,
  ): {
    readonly current: {
      readonly provider: string;
      readonly model: string;
      readonly name: string;
      readonly context_window: number;
      readonly max_tokens: number;
      readonly thinking_level: ModelThinkingLevel;
    };
    readonly options: readonly { readonly provider: string; readonly model: string; readonly name: string }[];
  } {
    return {
      current: {
        provider: current.provider,
        model: current.model,
        name: current.name,
        context_window: current.contextWindow,
        max_tokens: current.maxTokens,
        thinking_level: switcher.thinkingLevel(),
      },
      options: switcher.list().map((option) => ({
        provider: option.provider,
        model: option.model,
        name: option.name,
      })),
    };
  }

  async #staticAsset(request: Request, segments: readonly string[]): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed', message: 'Only GET and HEAD are supported' }, 405);
    }
    const relative = segments.length === 0 ? 'index.html' : segments.join('/');
    const candidate = resolve(this.#staticDir, relative);
    if (candidate !== this.#staticDir && !candidate.startsWith(this.#staticDir + sep)) {
      return json({ error: 'not_found', message: 'Asset does not exist' }, 404);
    }
    const direct = await readAsset(candidate);
    if (direct !== undefined) {
      return asset(direct, candidate);
    }
    const indexPath = join(this.#staticDir, 'index.html');
    const index = await readAsset(indexPath);
    if (index !== undefined) {
      return asset(index, indexPath);
    }
    return json(
      {
        error: 'admin_bundle_missing',
        message: `Admin bundle is absent: ${this.#staticDir}. Run pnpm run admin:build.`,
      },
      503,
    );
  }

  #sessionCookie(request: Request, url: URL, token: string): string {
    const maxAge = Math.floor(this.#auth.sessionTtlMs / 1000);
    return `${SESSION_COOKIE}=${token}; ${cookieAttributes(request, url)}; Max-Age=${maxAge}`;
  }
}

/**
 * Adds `Secure` whenever the browser is on HTTPS. Behind a TLS-terminating proxy
 * the request itself arrives over plain HTTP, so the Origin the browser sends
 * with every auth POST is what reveals it. A forged Origin only changes the
 * caller's own cookie, and a plain-HTTP loopback panel keeps working because
 * browsers refuse to store a Secure cookie there.
 */
function cookieAttributes(request: Request, url: URL): string {
  const secure = url.protocol === 'https:' || request.headers.get('origin')?.startsWith('https://') === true;
  return `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

/**
 * Decodes the path segments, or `null` when one of them is not valid
 * percent-encoding. A malformed id is the caller's mistake, not a server fault,
 * so it must not surface as `internal_error`.
 */
function decodeSegments(segments: readonly string[]): string[] | null {
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** Extracts the host of an Origin header; `null` when it is not a valid origin. */
function parseOriginHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function listQuery(url: URL): ListQuery {
  return {
    limit: url.searchParams.get('limit'),
    cursor: url.searchParams.get('cursor'),
    state: url.searchParams.get('state'),
    chat: url.searchParams.get('chat'),
    set: url.searchParams.get('set'),
    search: url.searchParams.get('search'),
    target: url.searchParams.get('target'),
    at: url.searchParams.get('at'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  };
}

function parseReplayInput(value: unknown): ReplayInvocationInput {
  if (!replayBodyValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      `Only before_send_id and global_prompt/group_prompt templates of at most ${MAX_PROMPT_LENGTH} characters are accepted; system prompt overrides are forbidden`,
    );
  }
  if (value.before_send_id !== undefined) {
    validateBeforeSendId(value.before_send_id);
  }
  return value;
}

function validateBeforeSendId(value: string): string {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError('invalid_before_send_id', 'before_send_id must be a positive 64-bit decimal ID');
  }
  return value;
}

/**
 * The revision of the configuration the caller last read, from `If-Match`.
 * Surrounding quotes and a weak prefix are accepted so an ETag-shaped header
 * works as well as the bare digest.
 */
function requiredRevision(request: Request): string | null {
  const header = request.headers.get('if-match');
  if (header === null) {
    return null;
  }
  const revision = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return revision.length === 0 ? null : revision;
}

function revisionRequired(): Response {
  return json(
    { error: 'revision_required', message: 'If-Match with the current configuration revision is required' },
    400,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (cookie !== undefined) {
    headers.set('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function closeServer(server: ServerType): Promise<void> {
  // Only the plain HTTP server variant exposes closeAllConnections; the
  // adaptor never creates HTTP/2 servers in this project.
  if ('closeAllConnections' in server) {
    server.closeAllConnections();
  }
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function asset(body: Buffer, path: string): Response {
  const extension = path.slice(path.lastIndexOf('.'));
  const isHtml = extension === '.html';
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'cache-control': isHtml ? 'no-store' : 'public, max-age=3600',
  });
  return new Response(new Uint8Array(body), { headers });
}

async function readAsset(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get('cookie');
  if (header === null) {
    return '';
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return '';
}

async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdminAuthError(400, 'invalid_body', 'Request body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AdminAuthError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Reads at most `maxBytes` of the body, counting bytes as they arrive. The limit
 * used to be checked after `request.text()` had buffered everything, so a
 * chunked request without Content-Length could make an unauthenticated login
 * allocate without bound, and the check counted UTF-16 units, not bytes.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const tooLarge = (): AdminAuthError => new AdminAuthError(413, 'body_too_large', 'Request body is too large');
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw tooLarge();
  }
  if (request.body === null) {
    return '';
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readCredentials(request: Request): Promise<AdminCredentials> {
  const record = await readJsonObject(request);
  const username = record.username;
  const password = record.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new AdminAuthError(400, 'invalid_body', 'username and password must be strings');
  }
  return { username, password };
}
