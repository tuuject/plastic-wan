export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface SessionState {
  readonly setup_required: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly expires_at: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ChatSummary {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username?: string | null;
  readonly message_thread_id: number;
}

export interface AlarmChatSummary {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly message_thread_id: string;
}

export interface InvocationListItem {
  readonly id: string;
  readonly state: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly side_effect_started: boolean;
  readonly config_hash: string;
  readonly chat: ChatSummary;
  readonly tool_call_count: number;
  /**
   * Daily-budget definition: input + output + cache read + cache write.
   * The cache counters are also listed on their own as a breakdown.
   */
  readonly total_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly total_cost: number | null;
}

export interface ToolCallEntry {
  readonly id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments_json: string;
  readonly result_text: string | null;
  readonly state: string;
  readonly side_effect: boolean;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface ModelCallEntry {
  readonly id: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly state: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  /** Input + output + cache read + cache write, the daily-budget definition. */
  readonly total_tokens: number;
  /** Raw provider `total_tokens`, kept for audit; not guaranteed to equal `total_tokens`. */
  readonly provider_total_tokens: number | null;
  readonly cost: number | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly request_json: string | null;
  readonly response_json: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly tools: readonly string[] | null;
}

export interface ToolRegistryEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
}

export interface AgentMessageEntry {
  readonly sequence_no: number;
  readonly role: string;
  readonly text: string;
  readonly created_at: string;
}

export interface TelegramSendEntry {
  readonly id: string;
  readonly tool_call_id: string;
  readonly kind: string;
  readonly request_json: string;
  readonly state: string;
  readonly telegram_message_id: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface ContextMessageEntry {
  readonly section: string;
  readonly sequence_no: number;
  readonly message_id: string;
  readonly revision_id: string;
  readonly omitted_before: number;
  readonly snapshot_json: string;
}

export interface ConversationContextListItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly telegram_chat_id: string;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: number;
  readonly head_seq: number;
  readonly next_seq: number;
  readonly send_count_total: number;
  readonly message_count: number;
  readonly last_active_at: string;
  readonly last_gc_at: string | null;
  readonly active_invocation_id: string | null;
}

export interface ConversationContextMessageEntry {
  readonly seq: number;
  readonly role: string;
  readonly is_checkpoint: boolean;
  readonly send_seq: number | null;
  readonly est_tokens: number;
  readonly invocation_id: string | null;
  readonly evicted_at: string | null;
  readonly created_at: string;
  readonly payload_preview: string;
  readonly payload_truncated: boolean;
}

export interface ConversationContextRefEntry {
  readonly ref: string;
  readonly kind: string;
  readonly source_seq: number;
  readonly expires_at: string;
}

export interface ConversationContextDetail extends ConversationContextListItem {
  readonly system_prompt_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly messages: readonly ConversationContextMessageEntry[];
  readonly refs: readonly ConversationContextRefEntry[];
}

export interface InvocationDetail extends InvocationListItem {
  readonly bucket_id: string;
  readonly prompt_version: number;
  readonly tool_registry_hash: string | null;
  readonly tool_registry: readonly ToolRegistryEntry[] | null;
  readonly tool_calls: readonly ToolCallEntry[];
  readonly model_calls: readonly ModelCallEntry[];
  readonly agent_messages: readonly AgentMessageEntry[];
  readonly telegram_sends: readonly TelegramSendEntry[];
  readonly context_messages: readonly ContextMessageEntry[];
}

export interface SenderSummary {
  readonly display_name: string;
  readonly username: string | null;
  readonly is_bot?: boolean;
}

export interface MessageListItem {
  readonly id: string;
  readonly telegram_message_id: string;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: boolean;
  readonly sent_by_bot: boolean;
  readonly chat: ChatSummary;
  readonly revision_no: number | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: string | null;
  readonly media_group_id: string | null;
  readonly sender: SenderSummary | null;
  readonly revision_count: number;
  readonly media_count: number;
}

export interface RevisionEntry {
  readonly id: string;
  readonly revision_no: number;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: string | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly service_json: string | null;
  readonly created_at: string;
  readonly sender: SenderSummary | null;
}

export interface MediaEntry {
  readonly id: string;
  readonly revision_id: string;
  readonly kind: string;
  readonly file_unique_id: string;
  readonly mime_type: string | null;
  readonly file_size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly analysis_state: string | null;
  readonly analysis_description: string | null;
}

export interface MessageDetail {
  readonly id: string;
  readonly telegram_message_id: string;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: boolean;
  readonly sent_by_bot: boolean;
  readonly chat: ChatSummary;
  readonly revisions: readonly RevisionEntry[];
  readonly media: readonly MediaEntry[];
}

export interface StickerSetEntry {
  readonly id: string;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
  readonly configured: boolean;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly error_code: string | null;
  readonly updated_at: string;
  readonly sticker_count: number;
  readonly indexed_count: number;
  readonly pending_count: number;
  readonly error_count: number;
}

export interface StickerAnalysis {
  readonly id: string;
  readonly state: string | null;
  readonly analysis_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: number | null;
  readonly description: string | null;
  readonly metadata_json: string | null;
  readonly updated_at: string | null;
}

export interface MemoryEntry {
  readonly id: string;
  readonly conversation_id: string;
  readonly chat: ChatSummary;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly updated_at: string;
  readonly ttl_seconds: number;
  readonly remaining_seconds: number;
  readonly expired: boolean;
  readonly long_ttl: boolean;
}

export interface MemoryChatOption {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
}

export interface MemoryDraft {
  readonly chat_id: string;
  readonly message_thread_id: number;
  readonly content: string;
  readonly ttl_seconds: number;
}

export interface MemoryUpdate {
  readonly content?: string;
  readonly ttl_seconds?: number;
}

export interface AlarmListItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly state: string;
  readonly scheduled_at: string;
  readonly created_at: string;
  readonly created_by_invocation_id: string | null;
  readonly fired_at: string | null;
  readonly invocation_id: string | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly admin_cancelled: boolean;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: string;
  readonly target_display_name: string;
  readonly summary: string;
  readonly chat: AlarmChatSummary;
}

export interface BotAdminEntry {
  readonly telegram_user_id: string;
}

export interface ModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
}

export interface CurrentModel extends ModelOption {
  readonly context_window: number;
  readonly max_tokens: number;
  /** Live level; switching the agent model resets it to the new model's weakest one. */
  readonly thinking_level: ThinkingLevel;
}

export interface ModelState {
  readonly current: CurrentModel;
  readonly options: readonly ModelOption[];
}

export interface ModelSwitchRequest {
  readonly provider: string;
  readonly model: string;
}

export interface ModelApplySummary {
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
}

export interface ModelSwitchResponse extends ModelState {
  readonly apply: ModelApplySummary;
}

/** The four adapters the configuration supports; anything else is rejected. */
export const PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

export type ProviderKind = 'builtin' | 'custom';

export type ModelInput = 'text' | 'image';

/**
 * Where one metadata field of a model draft came from. The two qualified
 * models.dev sources are guesses: the id was found under another provider, or
 * only after normalizing it.
 */
export type MetadataSource =
  | 'openrouter'
  | 'vercel'
  | 'gemini'
  | 'models.dev'
  | 'models.dev-cross-provider'
  | 'models.dev-fuzzy'
  | 'missing';

/** How far the models.dev lookup had to reach for a draft. */
export type ModelsDevConfidence = 'exact' | 'cross-provider' | 'fuzzy';

export interface ModelsDevMatch {
  readonly provider: string;
  readonly model: string;
  readonly confidence: ModelsDevConfidence;
}

export type DraftField = 'name' | 'reasoning' | 'thinking_levels' | 'input' | 'context_window' | 'max_tokens' | 'cost';

/** Pi's thinking levels, weakest first. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ThinkingFormat = 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'string-thinking';

export interface ModelCostConfig {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** Selected Pi compat overrides; an absent field leaves Pi's own detection in charge. */
export interface ModelCompatConfig {
  readonly supports_developer_role?: boolean;
  readonly thinking_format?: ThinkingFormat;
  readonly max_tokens_field?: 'max_completion_tokens' | 'max_tokens';
  readonly requires_reasoning_content?: boolean;
  readonly cache_control_format?: 'anthropic';
}

/** A model as it is stored in config.jsonc. */
export interface ProviderModelConfig {
  readonly id: string;
  readonly name?: string;
  readonly reasoning: boolean;
  /** Reasoning models only; absent means Pi's default (`off` through `high`). */
  readonly thinking_levels?: readonly ThinkingLevel[];
  readonly compat?: ModelCompatConfig;
  /**
   * Which JSON Schema keywords this model's tool definitions may carry; absent
   * sends every keyword the runtime builds.
   */
  readonly tool_schema_keywords?: 'minimal';
  readonly input: readonly ModelInput[];
  readonly context_window: number;
  readonly max_tokens: number;
  readonly cost: ModelCostConfig;
}

export interface ProviderView {
  readonly alias: string;
  readonly kind: ProviderKind;
  /** Pi's provider id; present on builtin providers only. */
  readonly provider?: string;
  readonly api: ProviderApi;
  readonly base_url: string;
  /** Header names only; the values never leave the process. */
  readonly header_names: readonly string[];
  readonly models: readonly ProviderModelConfig[];
}

export interface ProviderModelReference {
  readonly provider: string;
  readonly model: string;
}

export interface AgentModelReference extends ProviderModelReference {
  /** The level every invocation runs with; it has to be one the agent model accepts. */
  readonly thinking_level: ThinkingLevel;
}

export interface ProvidersView {
  /** SHA-256 of config.jsonc; every write has to echo it back via `If-Match`. */
  readonly revision: string;
  /** Whether the deployment declares an external supervisor that restarts `serve`. */
  readonly supervised: boolean;
  readonly agent: AgentModelReference;
  readonly vision: ProviderModelReference;
  /** Config paths whose new value is on disk but not live yet. */
  readonly restart_required: readonly string[];
  readonly providers: readonly ProviderView[];
}

export interface ChatSettings {
  readonly topic_ids: readonly string[] | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking_level: ThinkingLevel | null;
}

export interface ChatSettingsView extends ChatSettings {
  readonly effective: AgentModelReference;
}

export interface ChatEntry {
  readonly id: string;
  readonly runtime_chat_id: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly saved: ChatSettingsView | null;
  readonly active: ChatSettingsView | null;
}

export interface ChatsView {
  readonly revision: string;
  readonly supervised: boolean;
  readonly restart_required: readonly string[];
  readonly defaults: AgentModelReference;
  readonly models: readonly (ProviderModelReference & {
    readonly name: string;
    readonly thinking_levels: readonly ThinkingLevel[];
  })[];
  readonly items: readonly ChatEntry[];
}

export interface ChatWriteResponse extends ChatsView {
  readonly apply: ModelApplySummary;
}

export interface ProviderPresetView {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly base_url: string;
}

export interface ModelMetadataDraft {
  readonly id: string;
  readonly name: string | null;
  readonly reasoning: boolean | null;
  /** Only ever set on a reasoning model; `null` leaves the model on Pi's default. */
  readonly thinking_levels: readonly ThinkingLevel[] | null;
  readonly input: readonly ModelInput[] | null;
  readonly context_window: number | null;
  readonly max_tokens: number | null;
  readonly cost: ModelCostConfig | null;
  /** `true` only when models.dev records that reasoning content must be replayed. */
  readonly requires_reasoning_content: boolean;
  readonly sources: Readonly<Record<DraftField, MetadataSource>>;
  readonly requires_reasoning_content_source: MetadataSource;
  readonly match: ModelsDevMatch | null;
  readonly candidates: readonly ModelsDevMatch[];
  /** Fields the admin has to fill or confirm before the model may be saved. */
  readonly needs_confirmation: readonly DraftField[];
}

export interface DiscoveredModel extends ModelMetadataDraft {
  readonly configured: boolean;
}

export interface DiscoverResponse {
  readonly endpoint: string;
  readonly models: readonly DiscoveredModel[];
  /**
   * Set when models.dev could not be fetched: the listing is still usable, but
   * every field only that catalog could have filled needs manual confirmation.
   */
  readonly metadata_source_error: string | null;
}

export interface LookupMetadataResponse {
  readonly models: readonly ModelMetadataDraft[];
  readonly metadata_source_error: string | null;
}

export interface ProviderApplySummary {
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
  readonly outside_serve: readonly string[];
}

/** Every provider write answers with the refreshed view plus what the apply did. */
export interface ProviderWriteResponse extends ProvidersView {
  readonly apply: ProviderApplySummary;
}

export interface CreateProviderRequest {
  readonly alias: string;
  readonly kind: ProviderKind;
  readonly provider?: string;
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly api_key: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly ProviderModelConfig[];
}

/** Omitted fields keep their stored value; `null` header values delete the header. */
export interface UpdateProviderRequest {
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly api_key?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
}

export interface DiscoverRequest {
  readonly alias?: string;
  readonly kind?: ProviderKind;
  readonly provider?: string;
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly api_key?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LookupMetadataRequest {
  readonly kind: ProviderKind;
  readonly provider?: string;
  readonly base_url?: string;
  readonly api?: ProviderApi;
  readonly ids: readonly string[];
}

export interface RestartResponse {
  readonly status: string;
}

export interface ConfigErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface ConfigStatus {
  readonly generation: number;
  readonly active_hash: string;
  readonly file_hash: string;
  readonly restart_required: readonly string[];
  readonly last_error: ConfigErrorDetail | null;
}

export interface ConfigApplyResponse {
  readonly status: string;
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
  readonly outside_serve: readonly string[];
  readonly generation: number;
  readonly active_hash: string;
  readonly file_hash: string;
}

export interface StickerEntry {
  readonly id: string;
  readonly set_alias: string;
  readonly file_unique_id: string;
  readonly emoji: string | null;
  readonly format: string;
  readonly active: boolean;
  readonly index_state: string;
  readonly failure_count: number;
  readonly next_retry_at: string | null;
  readonly updated_at: string;
  readonly analysis: StickerAnalysis | null;
}

export interface LabelCount {
  readonly label: string;
  readonly count: number;
}

export interface UsageEntry {
  readonly resource: string;
  readonly metric: string;
  readonly scope: string;
  readonly amount: number;
}

export interface CancelOngoingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
}

export interface WakeResult {
  readonly status: 'awake';
  readonly was_sleeping: boolean;
}

export interface PausedChat {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
  readonly paused_at: string;
}

export interface RuntimeStatus {
  readonly sleeping: boolean;
  readonly sleep_until: string | null;
  readonly paused_chats: readonly PausedChat[];
}

export interface Overview {
  readonly generated_at: string;
  readonly invocation_states: readonly LabelCount[];
  readonly sticker_index_states: readonly LabelCount[];
  readonly top_tools: readonly LabelCount[];
  readonly daily_usage: readonly UsageEntry[];
  readonly runtime_status: RuntimeStatus;
  readonly message_count: number;
  readonly cached_analysis_count: number;
}

export interface UsageResponse {
  readonly days: number;
  readonly series: readonly UsagePoint[];
}

export interface UsagePoint {
  readonly date: string;
  readonly model_tokens: number;
  readonly vision_tokens: number;
  readonly tool_calls: number;
  readonly agent_invocations: number;
}

export interface ListFilters {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly state?: string | undefined;
  readonly chat?: string | undefined;
  readonly set?: string | undefined;
  readonly search?: string | undefined;
  readonly target?: string | undefined;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'Admin API returned a non-JSON response');
    }
  }
  if (!response.ok) {
    const body = payload as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.error ?? 'request_failed',
      body?.message ?? `Admin API request failed with status ${response.status}`,
    );
  }
  return payload as T;
}

function listPath(path: string, filters: ListFilters): string {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.cursor !== undefined && filters.cursor !== null) {
    params.set('cursor', filters.cursor);
  }
  for (const key of ['state', 'chat', 'set', 'search', 'target'] as const) {
    const value = filters[key];
    if (value !== undefined && value.length > 0) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

export function getSession(): Promise<SessionState> {
  return call<SessionState>('/auth/session');
}

function postCredentials(path: string): (credentials: Credentials) => Promise<{ status: string }> {
  return (credentials) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
}

export const createFirstAdmin = postCredentials('/auth/setup');

export const login = postCredentials('/auth/login');

export const updateCredentials = postCredentials('/auth/credentials');

export function logout(): Promise<{ status: string }> {
  return call('/auth/logout', { method: 'POST' });
}

export function getOverview(): Promise<Overview> {
  return call<Overview>('/overview');
}

export function listInvocations(filters: ListFilters): Promise<Page<InvocationListItem>> {
  return call<Page<InvocationListItem>>(listPath('/invocations', filters));
}

export function getInvocation(id: string): Promise<InvocationDetail> {
  return call<InvocationDetail>(`/invocations/${encodeURIComponent(id)}`);
}

export function listMessages(filters: ListFilters): Promise<Page<MessageListItem>> {
  return call<Page<MessageListItem>>(listPath('/messages', filters));
}

export function getMessage(id: string): Promise<MessageDetail> {
  return call<MessageDetail>(`/messages/${encodeURIComponent(id)}`);
}

export function listStickerSets(): Promise<{ items: readonly StickerSetEntry[] }> {
  return call<{ items: readonly StickerSetEntry[] }>('/sticker-sets');
}

export function listStickers(filters: ListFilters): Promise<Page<StickerEntry>> {
  return call<Page<StickerEntry>>(listPath('/stickers', filters));
}

export function listMemories(filters: ListFilters): Promise<Page<MemoryEntry>> {
  return call<Page<MemoryEntry>>(listPath('/memories', filters));
}

export function listAlarms(filters: ListFilters): Promise<Page<AlarmListItem>> {
  return call<Page<AlarmListItem>>(listPath('/alarms', filters));
}

export function listConversationContexts(filters: ListFilters): Promise<Page<ConversationContextListItem>> {
  return call<Page<ConversationContextListItem>>(listPath('/contexts', filters));
}

export function getConversationContext(conversationId: string): Promise<ConversationContextDetail> {
  return call<ConversationContextDetail>(`/contexts/${encodeURIComponent(conversationId)}`);
}

export function cancelAlarm(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/alarms/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listMemoryChats(): Promise<{ items: readonly MemoryChatOption[] }> {
  return call<{ items: readonly MemoryChatOption[] }>('/memories/chats');
}

export function createMemory(draft: MemoryDraft): Promise<MemoryEntry> {
  return call<MemoryEntry>('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

export function updateMemory(id: string, update: MemoryUpdate): Promise<MemoryEntry> {
  return call<MemoryEntry>(`/memories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
}

export function deleteMemory(id: string): Promise<{ status: string }> {
  return call<{ status: string }>(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listBotAdmins(): Promise<{ items: readonly BotAdminEntry[] }> {
  return call<{ items: readonly BotAdminEntry[] }>('/admins');
}

/**
 * Write requests carry the revision they were built against, so the server
 * rejects a write whose configuration has moved on (`409 config_conflict`)
 * instead of silently overwriting somebody else's edit.
 */
function writeHeaders(revision: string): Record<string, string> {
  return { 'content-type': 'application/json', 'if-match': revision };
}

export function switchAgentModel(request: ModelSwitchRequest, revision: string): Promise<ModelSwitchResponse> {
  return call<ModelSwitchResponse>('/model', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(request),
  });
}

export function getChats(): Promise<ChatsView> {
  return call<ChatsView>('/chats');
}

export function createChat(body: ChatSettings & { readonly id: string }, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>('/chats', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function updateChat(id: string, body: ChatSettings, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function deleteChat(id: string, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

export function getProviders(): Promise<ProvidersView> {
  return call<ProvidersView>('/providers');
}

export function getProviderPresets(): Promise<{ readonly presets: readonly ProviderPresetView[] }> {
  return call<{ readonly presets: readonly ProviderPresetView[] }>('/provider-presets');
}

export function createProvider(body: CreateProviderRequest, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/providers', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function updateProvider(
  alias: string,
  body: UpdateProviderRequest,
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function deleteProvider(alias: string, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

export function appendProviderModels(
  alias: string,
  models: readonly ProviderModelConfig[],
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}/models`, {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify({ models }),
  });
}

/** Model ids may contain `/`, so the path segment has to stay percent-encoded. */
export function replaceProviderModel(
  alias: string,
  modelId: string,
  model: ProviderModelConfig,
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}/models/${encodeURIComponent(modelId)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(model),
  });
}

export function deleteProviderModel(alias: string, modelId: string, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>(`/providers/${encodeURIComponent(alias)}/models/${encodeURIComponent(modelId)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

/** Discovery and metadata lookup write nothing and therefore need no revision. */
export function discoverProviderModels(body: DiscoverRequest): Promise<DiscoverResponse> {
  return call<DiscoverResponse>('/providers/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function lookupModelMetadata(body: LookupMetadataRequest): Promise<LookupMetadataResponse> {
  return call<LookupMetadataResponse>('/providers/lookup-metadata', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Hot: the next invocation runs with the new level. */
export function setAgentThinkingLevel(thinkingLevel: ThinkingLevel, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/thinking-level', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify({ thinking_level: thinkingLevel }),
  });
}

export function switchVisionModel(request: ModelSwitchRequest, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/vision', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(request),
  });
}

/** Asks a supervised deployment to restart; the process exits with code 75. */
export function restartServer(): Promise<RestartResponse> {
  return call<RestartResponse>('/restart', { method: 'POST' });
}

export function getConfigStatus(): Promise<ConfigStatus> {
  return call<ConfigStatus>('/config/status');
}

export interface DeveloperSettings {
  readonly revision: string;
  readonly record_model_payloads: boolean;
  readonly active_record_model_payloads: boolean;
}

export function getDeveloperSettings(): Promise<DeveloperSettings> {
  return call<DeveloperSettings>('/developer');
}

export function updateDeveloperSettings(
  enabled: boolean,
  revision: string,
): Promise<DeveloperSettings & { readonly apply: ModelApplySummary }> {
  return call('/developer', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify({ record_model_payloads: enabled }),
  });
}

export function clearModelPayloads(): Promise<{ readonly cleared_model_calls: number }> {
  return call('/developer/model-payloads', { method: 'DELETE' });
}

export function applyConfigFile(): Promise<ConfigApplyResponse> {
  return call<ConfigApplyResponse>('/config/apply', { method: 'POST' });
}

export function cancelOngoingSessions(): Promise<CancelOngoingResult> {
  return call<CancelOngoingResult>('/cancel-ongoing-sessions', { method: 'POST' });
}

export function wakeBot(): Promise<WakeResult> {
  return call<WakeResult>('/wake', { method: 'POST' });
}

export function getUsage(days: number): Promise<UsageResponse> {
  return call<UsageResponse>(`/usage?days=${encodeURIComponent(String(days))}`);
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export interface ImageModelInfo {
  readonly id: string;
  readonly name: string;
}

export interface ImageStatus {
  readonly enabled: boolean;
  readonly models: readonly ImageModelInfo[];
}

export interface ImagePromptAsset {
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly description: string;
  readonly category: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ImageAssetInfo {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly description: string;
  readonly category: string;
  readonly source: 'upload' | 'generation';
  readonly generation_id: string | null;
  readonly output_index: number | null;
  readonly created_at: string;
}

export interface ImageGenerationAttempt {
  readonly id: string;
  readonly round: number;
  readonly itemIndex: number;
  readonly status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly providerRequestId: string | null;
  readonly usage: Record<string, number> | null;
  readonly outputAssetId: string | null;
}

export interface ImageGenerationOutput {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageGenerationRecord {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  readonly source: string;
  readonly actorName: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly snapshot: {
    readonly authored: {
      readonly authoredPrompt: string;
      readonly modelId: string;
      readonly aspectRatio: string;
      readonly resolution: string;
      readonly outputCount: number;
    };
    readonly resolvedPrompt: string;
    readonly finalPrompt: string;
    readonly promptAssets: readonly { readonly id: string; readonly name: string }[];
    readonly imageAssets: readonly { readonly id: string; readonly name: string }[];
  };
  readonly outputs: readonly ImageGenerationOutput[];
  readonly attempts: readonly ImageGenerationAttempt[];
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly replayed?: boolean;
}

export interface ImageSimplePage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ImageSubmitInput {
  readonly prompt: string;
  readonly model_id?: string | undefined;
  readonly aspect_ratio?: string | undefined;
  readonly resolution?: string | undefined;
  readonly output_count?: number | undefined;
  readonly prompt_refs?: readonly string[] | undefined;
  readonly input_image_refs?: readonly string[] | undefined;
  readonly idempotency_key?: string | undefined;
}

export function getImageStatus(): Promise<ImageStatus> {
  return call<ImageStatus>('/image/status');
}

export interface ImageModelConfig {
  id: string;
  name: string;
  provider: string;
  upstreamModel: string;
  credentialRef: string;
  providerTag: string;
  capabilities: {
    imageInput: boolean;
    maxInputImages: number;
    maxOutputs: number;
    aspectRatios: string[];
    resolutionClasses: string[];
  };
}

export interface ImageConfigView {
  revision: string;
  enabled: boolean;
  credentials: string[];
  credential_providers: string[];
  models: ImageModelConfig[];
}

export interface ImageCatalogEndpoint {
  id: string;
  providerTag: string;
  providerName: string;
  capabilities: ImageModelConfig['capabilities'];
  unavailableReason: string | null;
}

export function getImageConfig(): Promise<ImageConfigView> {
  return call('/image/config');
}

export function getImageModelCatalog(): Promise<{ models: { id: string; name: string }[] }> {
  return call('/image/models');
}

export function getImageModelEndpoints(model: string): Promise<{ endpoints: ImageCatalogEndpoint[] }> {
  return call(`/image/models/endpoints?${new URLSearchParams({ model })}`);
}

export function listImagePrompts(
  filters: { readonly q?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<ImageSimplePage<ImagePromptAsset>> {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set('q', filters.q);
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  return call(`/image/prompts?${params.toString()}`);
}

export function createImagePrompt(body: {
  name: string;
  body: string;
  description?: string;
  category?: string;
}): Promise<ImagePromptAsset> {
  return call('/image/prompts', { method: 'POST', body: JSON.stringify(body) });
}

export function updateImagePrompt(
  id: string,
  body: { name?: string; body?: string; description?: string; category?: string },
): Promise<ImagePromptAsset> {
  return call(`/image/prompts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function archiveImagePrompt(id: string): Promise<{ status: string }> {
  return call(`/image/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listImageAssets(
  filters: { readonly q?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<ImageSimplePage<ImageAssetInfo>> {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set('q', filters.q);
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  return call(`/image/images?${params.toString()}`);
}

export function uploadImageAsset(body: {
  name: string;
  base64: string;
  mime: string;
  description?: string;
  category?: string;
}): Promise<ImageAssetInfo> {
  return call('/image/images', { method: 'POST', body: JSON.stringify(body) });
}

export function updateImageAsset(
  id: string,
  body: { name?: string; description?: string; category?: string },
): Promise<ImageAssetInfo> {
  return call(`/image/images/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function archiveImageAsset(id: string): Promise<{ status: string }> {
  return call(`/image/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function imageUrl(assetId: string): string {
  return `/api/image/images/${encodeURIComponent(assetId)}/content`;
}

export function listImageGenerations(
  filters: { readonly limit?: number; readonly offset?: number } = {},
): Promise<ImageSimplePage<ImageGenerationRecord>> {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  return call(`/image/generations?${params.toString()}`);
}

export function getImageGeneration(id: string): Promise<ImageGenerationRecord> {
  return call(`/image/generations/${encodeURIComponent(id)}`);
}

export function submitImageGeneration(
  input: ImageSubmitInput,
): Promise<{ generation: ImageGenerationRecord; replayed: boolean }> {
  return call('/image/generations', { method: 'POST', body: JSON.stringify(input) });
}

export function resolveImageGeneration(input: ImageSubmitInput): Promise<Record<string, unknown>> {
  return call('/image/generations/resolve', { method: 'POST', body: JSON.stringify(input) });
}

export function retryImageGeneration(id: string): Promise<{ generation: ImageGenerationRecord; replayed: boolean }> {
  return call(`/image/generations/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ idempotency_key: `retry-${Date.now()}` }),
  });
}

export function putImageConfig(
  body: { enabled: boolean; credentials?: Record<string, string>; models?: unknown[] },
  revision: string,
): Promise<{ enabled: boolean; apply: ModelApplySummary }> {
  return call('/image/config', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}
