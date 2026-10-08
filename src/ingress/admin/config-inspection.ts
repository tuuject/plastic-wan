import type { RawConfig } from '../../platform/config.ts';
import { assertConfigPermissions, loadConfig } from '../../platform/config.ts';
import type { ConfigReloader } from '../../platform/config-reload.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { type Orm, resolveChatConfig } from '../../store/database.ts';
import { hashPromptContent } from '../../store/prompt-versions.ts';
import { AdminQueryError } from './audit.ts';
import { listProviders } from './providers-admin.ts';

export type ConfigurationSource = 'active' | 'file';

/** These reads select an owned resource, never a caller-supplied server path. */
export function inspectionQuery(url: URL, groupPrompt = false): { source: ConfigurationSource; chatId?: bigint } {
  const allowed = new Set(groupPrompt ? ['source', 'chat'] : ['source']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new AdminQueryError('invalid_query', 'Unexpected or repeated inspection parameter');
    }
  }
  const source = url.searchParams.get('source') ?? 'active';
  if (source !== 'active' && source !== 'file') {
    throw new AdminQueryError('invalid_source', 'source must be active or file');
  }
  if (!groupPrompt) {
    return { source };
  }
  const chat = url.searchParams.get('chat');
  if (chat === null || !/^-?\d{1,19}$/.test(chat)) {
    throw new AdminQueryError('invalid_chat', 'chat must be a signed 64-bit decimal ID');
  }
  const chatId = BigInt(chat);
  if (chatId < -9_223_372_036_854_775_808n || chatId > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError('invalid_chat', 'chat is out of signed 64-bit range');
  }
  return { source, chatId };
}

export async function inspectConfiguration(
  store: RuntimeConfigurationStore,
  reloader: ConfigReloader | undefined,
  source: ConfigurationSource,
) {
  const current = store.current();
  const status = reloader?.status();
  if (source === 'active') {
    return {
      config: current.config,
      source,
      generation: current.generation,
      active_hash: current.hash,
      file_hash: status?.fileHash ?? null,
      restart_required: status?.restartRequired ?? [],
    };
  }
  if (reloader === undefined) {
    throw new AdminQueryError('config_read_unavailable', 'The configuration file is not wired', 503);
  }
  try {
    await assertConfigPermissions(reloader.configPath);
    const loaded = await loadConfig(reloader.configPath);
    return {
      config: loaded.config,
      source,
      generation: current.generation,
      active_hash: current.hash,
      file_hash: loaded.hash,
      restart_required: status?.restartRequired ?? [],
    };
  } catch {
    // Config errors can quote command SecretRefs or arbitrary edited file text.
    throw new AdminQueryError('config_invalid', 'The configuration file cannot be loaded safely', 422);
  }
}

/** Explicit projection: no credentials, SecretRefs, command argv, URLs with query tokens or host paths. */
export function configurationView(config: RawConfig) {
  const providerView = listProviders(config, '', []);
  return {
    version: config.version,
    timezone: config.timezone,
    telegram: {
      process_bot_messages: config.telegram.process_bot_messages,
      sticker_trigger_enabled: config.telegram.sticker_trigger_enabled,
      bucket_window_seconds: config.telegram.bucket_window_seconds,
      participation: config.telegram.participation,
      chats: config.telegram.chats.map((chat) => ({
        id: BigInt(chat.id).toString(),
        topic_ids: chat.topic_ids?.map((id) => BigInt(id).toString()),
        ignored_user_ids: chat.ignored_user_ids?.map((id) => BigInt(id).toString()),
        timezone: chat.timezone,
        participation: chat.participation,
        provider: chat.provider,
        model: chat.model,
        thinking_level: chat.thinking_level,
        group_prompt_configured: chat.instructions.length > 0,
      })),
      admins: config.telegram.admins?.map((id) => BigInt(id).toString()),
      sticker_sets: config.telegram.sticker_sets,
    },
    providers: providerView.providers,
    agent: {
      provider: config.agent.provider,
      model: config.agent.model,
      thinking_level: config.agent.thinking_level,
      daily_budget: config.agent.daily_budget,
      send_max_text_length: config.agent.send_max_text_length,
      send_disallow_blank_lines: config.agent.send_disallow_blank_lines,
      max_concurrency: config.agent.max_concurrency,
      context_stop_ratio: config.agent.context_stop_ratio,
      history_messages: config.agent.history_messages,
      memory_ttl_warning_days: config.agent.memory_ttl_warning_days,
      send_nudge_enabled: config.agent.send_nudge_enabled,
      send_barrier_enabled: config.agent.send_barrier_enabled,
      allow_reply_message_multiple_times: config.agent.allow_reply_message_multiple_times,
      context: config.agent.context,
      rate_limits: config.agent.rate_limits,
    },
    vision: config.vision,
    retention: config.retention,
    developer: config.developer,
    admin:
      config.admin === undefined
        ? undefined
        : {
            enabled: config.admin.enabled,
            host: config.admin.host,
            port: config.admin.port,
            session_ttl_hours: config.admin.session_ttl_hours,
          },
    mcp:
      config.mcp === undefined
        ? undefined
        : {
            servers: config.mcp.servers.map((server) => ({
              alias: server.alias,
              transport: server.transport,
              required: server.required,
              tools: server.tools,
              payload_max_bytes: server.payload_max_bytes,
              result_max_bytes: server.result_max_bytes,
              tool_policies: server.tool_policies,
              default_tool_policy: server.default_tool_policy,
              header_names: server.transport === 'streamable_http' ? Object.keys(server.headers ?? {}) : [],
              env_names: server.transport === 'stdio' ? Object.keys(server.env ?? {}) : [],
            })),
          },
    image:
      config.image === undefined
        ? undefined
        : {
            models: config.image.models.map((model) => ({
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              provider: model.provider,
              upstreamModel: model.upstreamModel,
              providerTag: model.providerTag,
              capabilities: model.capabilities,
            })),
          },
    web_fetch: config.web_fetch,
  };
}

export function configuredPromptView(config: RawConfig, orm: Orm, scope: 'global' | 'group', chatId?: bigint) {
  if (scope === 'global') {
    return {
      scope,
      chat_id: null,
      prompt: config.agent.system_prompt,
      content_hash: hashPromptContent(config.agent.system_prompt),
      core_read_only: true,
    };
  }
  const chat = chatId === undefined ? undefined : resolveChatConfig(config, orm, chatId);
  if (chat === undefined) {
    throw new AdminQueryError('chat_unconfigured', 'The requested chat is not configured', 404);
  }
  return {
    scope,
    chat_id: chatId?.toString() ?? null,
    configured_chat_id: BigInt(chat.id).toString(),
    prompt: chat.instructions,
    content_hash: hashPromptContent(chat.instructions),
    core_read_only: true,
  };
}

/** Redact strings and object keys while preserving valid JSON, including short authenticated API keys. */
export function redactInspection(value: unknown, secrets: SecretStore | undefined, token?: string): unknown {
  const text = (input: string): string => {
    const redacted = secrets?.redact(input) ?? input;
    return token === undefined || token.length === 0 ? redacted : redacted.split(token).join('[REDACTED]');
  };
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === 'string') {
        return text(entry);
      }
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        return Object.fromEntries(Object.entries(entry).map(([key, child]) => [text(key), child]));
      }
      return entry;
    }),
  );
}
