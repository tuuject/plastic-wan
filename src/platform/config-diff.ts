import { assembleRawConfig, type FileChat, type FileConfig, type RawConfig } from './config.ts';

/**
 * How a changed configuration path can take effect.
 *
 * - `hot`: applied to the running process by the next reload.
 * - `restart`: saved in the file, but only effective after a restart.
 * - `outside_serve`: `serve` never reads it; the next `backup` run picks it up.
 */
export type ConfigChangeKind = 'hot' | 'restart' | 'outside_serve';

export interface ConfigChange {
  readonly path: string;
  readonly kind: ConfigChangeKind;
}

/** One configuration in both of its layers: the file, and the resolved raw form. */
export interface ConfigSource {
  readonly file: FileConfig;
  readonly raw: RawConfig;
}

export interface ConfigDiff {
  /** Changed paths, deduplicated and sorted. */
  readonly changes: readonly ConfigChange[];
  /** The active configuration with every hot and outside-serve field taken from the file. */
  readonly candidate: ConfigSource;
}

type ProviderFileConfig = FileConfig['providers'][string];
type CustomProviderFileConfig = Extract<ProviderFileConfig, { kind: 'custom' }>;
type ModelFileConfig = CustomProviderFileConfig['models'][number];
type RawChat = RawConfig['telegram']['chats'][number];

/**
 * The hot whitelist. This module is the only place that defines it: every path
 * that is not listed here is restart-only, and a configuration field added to
 * the schema stays restart-only until it is listed.
 */
const HOT_PATHS: ReadonlySet<string> = new Set([
  'developer',
  'developer.record_model_payloads',
  'agent.provider',
  'agent.model',
  'agent.system_prompt_file',
  'agent.thinking_level',
  'agent.context_stop_ratio',
  'agent.send_max_text_length',
  'agent.send_disallow_blank_lines',
  'agent.send_nudge_enabled',
  'agent.send_barrier_enabled',
  'agent.daily_budget.max_tokens',
  'agent.max_concurrency',
  'agent.history_messages',
  'agent.context.max_wall_clock_seconds',
  'agent.context.idle_grace_seconds',
  'vision.provider',
  'vision.model',
  'vision.max_output_tokens',
  'image',
  'telegram.admins',
]);

/**
 * `agent.rate_limits` is hot as a whole; its three fields are listed for the
 * report. Every provider field is hot — connection fields, the model list and
 * per-model paths, which are built dynamically — because a reload rebuilds the
 * model registry and publishes it with the configuration. The image section is
 * hot as a whole for the same reason: a reload re-resolves its SecretRefs and
 * republishes the image snapshot atomically.
 */
const HOT_PREFIXES: readonly string[] = ['agent.rate_limits.', 'providers.', 'image.'];

/**
 * `serve` reads these only through `backup` and the pre-migration backup, so
 * they are neither applied nor pending a restart.
 */
const OUTSIDE_SERVE_PATHS: ReadonlySet<string> = new Set([
  'paths.backups',
  'retention.online_days',
  'retention.backup_copies',
]);

function classify(path: string): ConfigChangeKind {
  if (OUTSIDE_SERVE_PATHS.has(path)) {
    return 'outside_serve';
  }
  if (HOT_PATHS.has(path) || HOT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'hot';
  }
  return 'restart';
}

/**
 * Compares a file configuration with the active one and builds the candidate the
 * running process could adopt right now.
 *
 * The candidate keeps every restart-only value from the active configuration and
 * takes every hot and outside-serve value from the file; a field the file no
 * longer carries is dropped when it is hot, and kept when it is restart-only.
 * No I/O happens here: prompt texts come from the two already-loaded raw forms,
 * so a chat and its instructions file can disappear together without failing.
 */
export function diffConfig(active: ConfigSource, file: ConfigSource): ConfigDiff {
  const recorder = new ChangeRecorder();
  const candidateFile = mergeFileConfig(active, file, recorder);
  return {
    changes: recorder.changes(),
    candidate: { file: candidateFile, raw: buildCandidateRaw(active, file, candidateFile) },
  };
}

/** Structural equality that ignores object key order, unlike a JSON comparison. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

class ChangeRecorder {
  readonly #changes = new Map<string, ConfigChangeKind>();

  add(path: string, kind: ConfigChangeKind): void {
    if (!this.#changes.has(path)) {
      this.#changes.set(path, kind);
    }
  }

  changes(): readonly ConfigChange[] {
    return [...this.#changes.entries()]
      .map(([path, kind]) => ({ path, kind }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
}

function mergeFileConfig(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig {
  const result = structuredClone(active.file);
  const activeRecord = active.file as unknown as Record<string, unknown>;
  const fileRecord = file.file as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'telegram' || key === 'providers' || key === 'agent') {
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, key, recorder);
  }
  result.telegram = mergeTelegram(active, file, recorder);
  result.agent = mergeAgent(active, file, recorder);
  result.providers = mergeProviders(active, file, recorder);
  return result;
}

function mergeTelegram(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig['telegram'] {
  const result = structuredClone(active.file.telegram);
  const activeRecord = active.file.telegram as unknown as Record<string, unknown>;
  const fileRecord = file.file.telegram as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'chats') {
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, `telegram.${key}`, recorder);
  }
  result.chats = mergeChats(active, file, recorder);
  return result;
}

function mergeAgent(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig['agent'] {
  const result = structuredClone(active.file.agent);
  const activeRecord = active.file.agent as unknown as Record<string, unknown>;
  const fileRecord = file.file.agent as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'system_prompt_file') {
      target[key] = mergeSystemPromptFile(active, file, recorder);
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, `agent.${key}`, recorder);
  }
  return result;
}

/**
 * The prompt file is compared by path and by content: an edited prompt keeps the
 * same path, and a renamed file with the same text is still a change.
 */
function mergeSystemPromptFile(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): string {
  const pathChanged = !deepEqual(active.file.agent.system_prompt_file, file.file.agent.system_prompt_file);
  const contentChanged = active.raw.agent.system_prompt !== file.raw.agent.system_prompt;
  if (pathChanged || contentChanged) {
    recorder.add('agent.system_prompt_file', 'hot');
  }
  return file.file.agent.system_prompt_file;
}

function mergeChats(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileChat[] {
  const activeChats = new Map(active.file.telegram.chats.map((chat) => [chat.id, chat]));
  const fileChats = new Map(file.file.telegram.chats.map((chat) => [chat.id, chat]));
  const activeRaw = new Map(active.raw.telegram.chats.map((chat) => [chat.id, chat]));
  const fileRaw = new Map(file.raw.telegram.chats.map((chat) => [chat.id, chat]));
  const result: FileChat[] = [];
  for (const [id, chat] of activeChats) {
    const fromFile = fileChats.get(id);
    if (fromFile === undefined) {
      // Removing a chat needs a restart: the allowlist, the participation
      // registry and every conversation row already exist for it.
      recorder.add(`telegram.chats[${id}]`, 'restart');
      result.push(structuredClone(chat));
      continue;
    }
    result.push(mergeChat(chat, fromFile, activeRaw.get(id), fileRaw.get(id), recorder));
  }
  for (const [id, chat] of fileChats) {
    if (!activeChats.has(id)) {
      // Adding a chat is hot: the ingestion allowlist, the participation
      // registry and `resolveChatConfig` all read the published configuration,
      // and a brand-new chat has no stored history to protect. Removal and
      // edits to an existing chat's restart-only fields stay restart-only.
      recorder.add(`telegram.chats[${id}]`, 'hot');
      result.push(structuredClone(chat));
    }
  }
  return result;
}

function mergeChat(
  active: FileChat,
  file: FileChat,
  activeRaw: RawChat | undefined,
  fileRaw: RawChat | undefined,
  recorder: ChangeRecorder,
): FileChat {
  const result = structuredClone(active);
  const activeRecord = active as unknown as Record<string, unknown>;
  const fileRecord = file as unknown as Record<string, unknown>;
  const target = result as unknown as Record<string, unknown>;
  for (const key of unionKeys(activeRecord, fileRecord)) {
    if (key === 'id') {
      continue;
    }
    if (key === 'instructions_file') {
      const path = `telegram.chats[${active.id}].instructions_file`;
      const pathChanged = !deepEqual(active.instructions_file, file.instructions_file);
      const contentChanged = (activeRaw?.instructions ?? '') !== (fileRaw?.instructions ?? '');
      if (pathChanged || contentChanged) {
        recorder.add(path, 'hot');
      }
      if (file.instructions_file === undefined) {
        delete result.instructions_file;
      } else {
        result.instructions_file = file.instructions_file;
      }
      continue;
    }
    if (key === 'provider' || key === 'model' || key === 'thinking_level') {
      const path = `telegram.chats[${active.id}].${key}`;
      const hasFile = Object.hasOwn(fileRecord, key);
      const hasActive = Object.hasOwn(activeRecord, key);
      if (!hasFile) {
        recorder.add(path, 'hot');
        delete target[key];
      } else if (!hasActive) {
        recorder.add(path, 'hot');
        target[key] = fileRecord[key];
      } else if (!deepEqual(activeRecord[key], fileRecord[key])) {
        recorder.add(path, 'hot');
        target[key] = fileRecord[key];
      }
      continue;
    }
    mergeField(activeRecord, fileRecord, target, key, `telegram.chats[${active.id}].${key}`, recorder);
  }
  return result;
}

function mergeProviders(active: ConfigSource, file: ConfigSource, recorder: ChangeRecorder): FileConfig['providers'] {
  const result: Record<string, ProviderFileConfig> = {};
  for (const [alias, activeProvider] of Object.entries(active.file.providers)) {
    const fileProvider = file.file.providers[alias];
    if (fileProvider === undefined || fileProvider.kind !== activeProvider.kind) {
      // Adding, removing or re-kinding a provider is hot: the reload rebuilds the
      // registry and publishes it with the configuration.
      recorder.add(`providers.${alias}`, 'hot');
      if (fileProvider !== undefined) {
        result[alias] = structuredClone(fileProvider);
      }
      continue;
    }
    const activeRecord = activeProvider as unknown as Record<string, unknown>;
    const fileRecord = fileProvider as unknown as Record<string, unknown>;
    const merged = structuredClone(activeProvider) as unknown as Record<string, unknown>;
    for (const key of unionKeys(activeRecord, fileRecord)) {
      if (key === 'models') {
        continue;
      }
      mergeField(activeRecord, fileRecord, merged, key, `providers.${alias}.${key}`, recorder);
    }
    // Both kinds carry `models`: for a builtin provider the list is the enabled
    // subset of Pi's catalog, and changing it is as hot as it is for custom.
    merged.models = mergeModels(alias, activeProvider.models, fileProvider.models, recorder);
    result[alias] = merged as unknown as ProviderFileConfig;
  }
  for (const [alias, fileProvider] of Object.entries(file.file.providers)) {
    if (!Object.hasOwn(active.file.providers, alias)) {
      recorder.add(`providers.${alias}`, 'hot');
      result[alias] = structuredClone(fileProvider);
    }
  }
  return result;
}

function mergeModels(
  alias: string,
  activeModels: readonly ModelFileConfig[],
  fileModels: readonly ModelFileConfig[],
  recorder: ChangeRecorder,
): ModelFileConfig[] {
  const activeById = new Map(activeModels.map((model) => [model.id, model]));
  const result: ModelFileConfig[] = [];
  // The file order wins: it is the order the provider is rebuilt in.
  for (const model of fileModels) {
    const path = `providers.${alias}.models[${model.id}]`;
    const activeModel = activeById.get(model.id);
    if (activeModel === undefined || !deepEqual(activeModel, model)) {
      recorder.add(path, 'hot');
    }
    result.push(structuredClone(model));
  }
  for (const model of activeModels) {
    if (!fileModels.some((candidate) => candidate.id === model.id)) {
      recorder.add(`providers.${alias}.models[${model.id}]`, 'hot');
    }
  }
  return result;
}

/**
 * The candidate's raw layer reuses the prompt texts already loaded from both
 * sides — never the disk. A chat that exists only in the active configuration is
 * waiting for a restart, so it keeps its instructions; every other chat takes
 * the text the file just loaded.
 */
function buildCandidateRaw(active: ConfigSource, file: ConfigSource, candidateFile: FileConfig): RawConfig {
  const fileInstructions = new Map(file.raw.telegram.chats.map((chat) => [chat.id, chat.instructions]));
  const activeInstructions = new Map(active.raw.telegram.chats.map((chat) => [chat.id, chat.instructions]));
  const instructions = new Map<number, string>();
  for (const chat of candidateFile.telegram.chats) {
    instructions.set(chat.id, fileInstructions.get(chat.id) ?? activeInstructions.get(chat.id) ?? '');
  }
  return assembleRawConfig(candidateFile, file.raw.agent.system_prompt, instructions);
}

/** Merges one field into a candidate record, honouring the whitelist. */
function mergeField(
  active: Record<string, unknown>,
  file: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  path: string,
  recorder: ChangeRecorder,
): void {
  const hasActive = Object.hasOwn(active, key);
  const hasFile = Object.hasOwn(file, key);
  if (!hasActive && !hasFile) {
    return;
  }
  if (!hasFile) {
    const kind = classify(path);
    recorder.add(path, kind);
    if (kind === 'restart') {
      target[key] = active[key];
    } else {
      delete target[key];
    }
    return;
  }
  if (!hasActive) {
    const kind = classify(path);
    recorder.add(path, kind);
    if (kind !== 'restart') {
      target[key] = file[key];
    }
    return;
  }
  target[key] = mergeValue(active[key], file[key], path, recorder);
}

function mergeValue(activeValue: unknown, fileValue: unknown, path: string, recorder: ChangeRecorder): unknown {
  if (isJsonObject(activeValue) && isJsonObject(fileValue)) {
    return mergeObject(activeValue, fileValue, path, recorder);
  }
  if (deepEqual(activeValue, fileValue)) {
    return fileValue;
  }
  const kind = classify(path);
  recorder.add(path, kind);
  return kind === 'restart' ? activeValue : fileValue;
}

function mergeObject(
  active: Record<string, unknown>,
  file: Record<string, unknown>,
  path: string,
  recorder: ChangeRecorder,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of unionKeys(active, file)) {
    mergeField(active, file, result, key, `${path}.${key}`, recorder);
  }
  return result;
}

function unionKeys(left: object, right: object): readonly string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
