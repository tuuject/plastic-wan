import { createHash } from 'node:crypto';
import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import {
  type AgentSettings,
  assertConfigPermissions,
  type FileConfig,
  type LoadedConfig,
  loadConfig,
  type RawConfig,
  validateSemantics,
} from './config.ts';
import { type ConfigChange, type ConfigSource, diffConfig } from './config-diff.ts';
import { type ConfigEdit, ConfigWriteError, readConfigRevision, writeConfigEdits } from './config-file.ts';
import { type AgentModelSwitcher, ModelSwitchError } from './model-switch.ts';
import { buildModelRegistry, configuredAgentModels } from './providers.ts';
import type { ConfigurationModels, RuntimeConfigurationStore } from './runtime-config.ts';
import { SecretResolutionError, type SecretStore } from './secrets.ts';

/**
 * The image configuration gateway. The reloader prepares a candidate snapshot
 * (resolving SecretRefs) before anything is published and republishes it
 * together with the configuration; a failed prepare keeps the old snapshot.
 * Optional: absent when the process runs without the image service.
 */
export interface ImageConfigGateway {
  prepare: (candidate: RawConfig) => Promise<unknown>;
  publish: (snapshot: unknown) => void;
}

export type ConfigErrorCode =
  | 'config_permissions'
  | 'config_invalid'
  | 'config_conflict'
  | 'candidate_invalid'
  | 'model_unusable'
  | 'secret_unresolved'
  | 'unknown_provider'
  | 'unknown_model'
  | 'not_text_capable'
  | 'config_symlink'
  | 'config_write_failed';

export interface ConfigErrorDetail {
  readonly code: ConfigErrorCode;
  readonly message: string;
  readonly at: string;
}

export interface ConfigStatus {
  readonly generation: number;
  /** Identity of the configuration the process is running. */
  readonly activeHash: string;
  /** Identity of the file as of the last successful load. */
  readonly fileHash: string;
  readonly restartRequired: readonly string[];
  readonly lastError: ConfigErrorDetail | null;
}

export type ConfigApplyResult =
  | {
      readonly ok: true;
      readonly applied: readonly string[];
      readonly restartRequired: readonly string[];
      readonly outsideServe: readonly string[];
      readonly status: ConfigStatus;
    }
  | {
      readonly ok: false;
      readonly code: ConfigErrorCode;
      readonly message: string;
      /** A failed apply after the requested edits already rewrote the file. */
      readonly fileWritten: boolean;
      readonly status: ConfigStatus;
    };

export interface ConfigReloaderOptions {
  /** The startup load result: the base for the first diff. */
  readonly loaded: LoadedConfig;
  readonly store: RuntimeConfigurationStore;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly secrets: SecretStore;
  /** Throws when the tool registry does not fit the model's context window. */
  readonly validateAgentModel: (model: Model<Api>) => void;
  /** Called after every successful publish; the composition root wakes the scheduler. */
  readonly onPublished: () => void;
  /** Optional image configuration gateway; present when the image service runs. */
  readonly imageConfig?: ImageConfigGateway;
}

/**
 * Applies the configuration file to the running process.
 *
 * The file is the desired configuration; this class decides which of its changes
 * the process can adopt right now (the hot whitelist in `config-diff.ts`) and
 * which have to wait for a restart. Both layers of a candidate are validated
 * before anything is published: the file itself, so the next startup will work,
 * and the candidate, so the running process will.
 */
export class ConfigReloader {
  readonly #configPath: string;
  readonly #store: RuntimeConfigurationStore;
  readonly #modelSwitcher: AgentModelSwitcher;
  readonly #secrets: SecretStore;
  readonly #validateAgentModel: (model: Model<Api>) => void;
  readonly #onPublished: () => void;
  readonly #imageConfig: ImageConfigGateway | undefined;
  /** Identity of the last published image snapshot; detects key-jar-only rotations. */
  #imageSnapshotId: string | null = null;
  #activeFile: FileConfig;
  #fileHash: string;
  #restartRequired: readonly string[] = [];
  #lastError: ConfigErrorDetail | null = null;
  /** Serializes reloads; a reload and a `/model` write never interleave. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ConfigReloaderOptions) {
    this.#configPath = options.loaded.configPath;
    this.#store = options.store;
    this.#modelSwitcher = options.modelSwitcher;
    this.#secrets = options.secrets;
    this.#validateAgentModel = options.validateAgentModel;
    this.#onPublished = options.onPublished;
    this.#imageConfig = options.imageConfig;
    this.#activeFile = structuredClone(options.loaded.fileConfig);
    this.#fileHash = options.loaded.hash;
  }

  status(): ConfigStatus {
    const current = this.#store.current();
    return {
      generation: current.generation,
      activeHash: current.hash,
      fileHash: this.#fileHash,
      restartRequired: this.#restartRequired,
      lastError: this.#lastError,
    };
  }

  reloadFromFile(): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#applyFile());
  }

  /**
   * Writes edits into the configuration file and applies the result, both inside
   * one lock hold so two panel writes cannot interleave.
   *
   * `expectedRevision` is the revision the caller read the file at; a stale one
   * is refused with `config_conflict` and leaves the file untouched.
   */
  writeAndApply(edits: readonly ConfigEdit[], expectedRevision?: string): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#writeAndApply(edits, expectedRevision));
  }

  /** Absolute path of the configuration file this reloader owns. */
  get configPath(): string {
    return this.#configPath;
  }

  /** Revision of the file on disk, for the panel's optimistic concurrency. */
  revision(): Promise<string> {
    return readConfigRevision(this.#configPath);
  }

  /**
   * Writes `agent.provider` / `agent.model` into the configuration file and
   * applies the file. The model must be usable before anything is written, so a
   * rejected switch leaves the file untouched; once it is written, a failed
   * apply reports `fileWritten` instead of pretending nothing happened.
   *
   * The switch also resets `agent.thinking_level` to the weakest level the new
   * model accepts: models do not share one set of levels, and the level chosen
   * for the old model may not exist on the new one.
   */
  setAgentModel(provider: string, model: string, expectedRevision?: string): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#setModel(provider, model, expectedRevision));
  }

  /** The ID is the configured Chat ID, after resolving any Telegram group migration. */
  setChatModel(configuredChatId: number, provider: string, model: string): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#setModel(provider, model, undefined, configuredChatId));
  }

  /** Removes all three overrides; if absent, still applies other pending file changes without rewriting. */
  resetChatModel(configuredChatId: number): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#writeChatSettings(configuredChatId, null));
  }

  /**
   * Appends a bare allowlist entry `{ id }` for the chat to the configuration
   * file and applies it. Adding a chat is a hot change (see `config-diff.ts`),
   * so a successful apply lets the running process accept the chat immediately.
   * A chat the file already allowlists is not written again; applying the file
   * then covers a previously written but unapplied add.
   */
  addChat(configuredChatId: number): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#addChat(configuredChatId));
  }

  /** Reads the latest file under the write lock so concurrent members cannot overwrite each other's IDs. */
  setChatUserIgnored(configuredChatId: number, userId: bigint, ignored: boolean): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#setChatUserIgnored(configuredChatId, userId, ignored));
  }

  async #setChatUserIgnored(configuredChatId: number, userId: bigint, ignored: boolean): Promise<ConfigApplyResult> {
    if (userId <= 0n || userId > BigInt(Number.MAX_SAFE_INTEGER)) {
      return this.#rejected('config_invalid', `Invalid Telegram user ID: ${userId}`, 'config_write_failed');
    }
    if (!this.#store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
      return this.#rejected(
        'config_invalid',
        `Chat ${configuredChatId} is not configured in the running process`,
        'config_write_failed',
      );
    }
    let revision: string;
    let loaded: LoadedConfig;
    try {
      revision = await readConfigRevision(this.#configPath);
      loaded = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#rejected('config_invalid', messageOf(error), 'config_write_failed');
    }
    const index = loaded.fileConfig.telegram.chats.findIndex((chat) => chat.id === configuredChatId);
    const chat = loaded.fileConfig.telegram.chats[index];
    if (chat === undefined) {
      return this.#rejected(
        'config_invalid',
        `Chat ${configuredChatId} is no longer present in the configuration file`,
        'config_write_failed',
      );
    }
    const id = Number(userId);
    const ids = chat.ignored_user_ids ?? [];
    if (ids.includes(id) === ignored) {
      return await this.#applyFile();
    }
    return await this.#writeAndApply(
      [
        {
          path: ['telegram', 'chats', index, 'ignored_user_ids'],
          value: ignored ? [...ids, id] : ids.filter((entry) => entry !== id),
        },
      ],
      revision,
    );
  }

  async #addChat(configuredChatId: number): Promise<ConfigApplyResult> {
    if (!Number.isSafeInteger(configuredChatId) || configuredChatId === 0) {
      return this.#rejected('config_invalid', `Invalid Telegram chat ID: ${configuredChatId}`);
    }
    let revision: string;
    let loaded: LoadedConfig;
    try {
      revision = await readConfigRevision(this.#configPath);
      loaded = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#rejected('config_invalid', messageOf(error));
    }
    if (loaded.fileConfig.telegram.chats.some((chat) => chat.id === configuredChatId)) {
      return await this.#applyFile();
    }
    const edits: ConfigEdit[] = [
      { path: ['telegram', 'chats', loaded.fileConfig.telegram.chats.length], value: { id: configuredChatId } },
    ];
    return await this.#writeAndApply(edits, revision);
  }

  async #setModel(
    provider: string,
    model: string,
    expectedRevision?: string,
    configuredChatId?: number,
  ): Promise<ConfigApplyResult> {
    try {
      this.#modelSwitcher.option(provider, model);
    } catch (error) {
      if (error instanceof ModelSwitchError) {
        return this.#rejected(error.code, error.message);
      }
      throw error;
    }
    const resolved = this.#store.current().models.getModel(provider, model);
    if (resolved === undefined) {
      return this.#rejected('model_unusable', `Model ${provider}/${model} is not registered`);
    }
    try {
      this.#validateAgentModel(resolved);
    } catch (error) {
      return this.#rejected('model_unusable', messageOf(error));
    }
    const [weakest = 'off'] = getSupportedThinkingLevels(resolved);
    if (configuredChatId !== undefined) {
      return await this.#writeChatSettings(configuredChatId, { provider, model, thinking_level: weakest });
    }
    return await this.#writeAndApply(
      [
        { path: ['agent', 'provider'], value: provider },
        { path: ['agent', 'model'], value: model },
        { path: ['agent', 'thinking_level'], value: weakest },
      ],
      expectedRevision,
      'model_switch_failed',
    );
  }

  async #writeChatSettings(configuredChatId: number, settings: AgentSettings | null): Promise<ConfigApplyResult> {
    if (!this.#store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
      return this.#rejected('config_invalid', `Chat ${configuredChatId} is not configured in the running process`);
    }
    let revision: string;
    let loaded: LoadedConfig;
    try {
      // Array order may differ from the active configuration. Locate by ID in the
      // file, then pin its revision so a concurrent reorder cannot target another Chat.
      revision = await readConfigRevision(this.#configPath);
      loaded = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#rejected('config_invalid', messageOf(error));
    }
    const index = loaded.fileConfig.telegram.chats.findIndex((chat) => chat.id === configuredChatId);
    const chat = loaded.fileConfig.telegram.chats[index];
    if (chat === undefined) {
      return this.#rejected(
        'config_invalid',
        `Chat ${configuredChatId} is no longer present in the configuration file`,
      );
    }
    const edits: ConfigEdit[] = [];
    for (const key of ['provider', 'model', 'thinking_level'] as const) {
      const value = settings?.[key];
      if (chat[key] !== value) {
        edits.push({ path: ['telegram', 'chats', index, key], value });
      }
    }
    return edits.length === 0
      ? await this.#applyFile()
      : await this.#writeAndApply(edits, revision, 'model_switch_failed');
  }

  async #writeAndApply(
    edits: readonly ConfigEdit[],
    expectedRevision: string | undefined,
    rejectedEvent = 'config_write_failed',
  ): Promise<ConfigApplyResult> {
    try {
      await writeConfigEdits(this.#configPath, edits, expectedRevision);
    } catch (error) {
      return error instanceof ConfigWriteError
        ? this.#rejected(error.code, error.message, rejectedEvent)
        : this.#rejected('config_write_failed', messageOf(error), rejectedEvent);
    }
    const result = await this.#applyFile();
    return result.ok ? result : { ...result, fileWritten: true };
  }

  async #applyFile(): Promise<ConfigApplyResult> {
    const active: ConfigSource = { file: this.#activeFile, raw: this.#store.current().config };
    try {
      await assertConfigPermissions(this.#configPath);
    } catch (error) {
      return this.#failure('config_permissions', messageOf(error), false);
    }
    let file: LoadedConfig;
    try {
      file = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#failure('config_invalid', messageOf(error), false);
    }
    const fromFile: ConfigSource = { file: file.fileConfig, raw: file.config };
    const diff = diffConfig(active, fromFile);
    const restartRequired = pathsOf(diff.changes, 'restart');
    try {
      validateSemantics(diff.candidate.file);
    } catch (error) {
      // The file is valid on its own, so the next startup is fine; only this
      // process cannot adopt it while the restart-only fields are still pending.
      const pending = restartRequired.length === 0 ? '' : ` Pending restart paths: ${restartRequired.join(', ')}.`;
      return this.#failure(
        'candidate_invalid',
        `The file itself is valid, but it is not valid together with the restart-only fields still pending in this process; those take effect together after a restart. ${messageOf(error)}${pending}`,
        false,
      );
    }
    const rebuilt = await this.#buildRegistry(diff.candidate.raw);
    if (!rebuilt.ok) {
      return this.#failure(rebuilt.code, rebuilt.error, false);
    }
    try {
      for (const { model } of configuredAgentModels(diff.candidate.raw, rebuilt.registry.models)) {
        this.#validateAgentModel(model);
      }
    } catch (error) {
      return this.#failure('model_unusable', messageOf(error), false);
    }
    // The image candidate is prepared with every apply — including ones where
    // the file is unchanged — so a key-jar rotation is picked up by the next
    // explicit reload even though the configuration file hash did not move.
    let imageSnapshot: unknown;
    let imageSnapshotId: string | null;
    if (this.#imageConfig === undefined) {
      imageSnapshot = undefined;
      imageSnapshotId = null;
    } else {
      try {
        imageSnapshot = await this.#imageConfig.prepare(diff.candidate.raw);
      } catch (error) {
        const code = error instanceof SecretResolutionError ? 'secret_unresolved' : 'config_invalid';
        return this.#failure(code, messageOf(error), false);
      }
      // `undefined` (no image section) is the disabled state with its own
      // stable identity, so disabling and re-enabling each count as changes.
      imageSnapshotId =
        imageSnapshot === undefined
          ? 'disabled'
          : createHash('sha256').update(JSON.stringify(imageSnapshot)).digest('hex').slice(0, 32);
    }
    const imageChanged = imageSnapshotId !== this.#imageSnapshotId;
    const applied = pathsOf(diff.changes, 'hot');
    const outsideServe = pathsOf(diff.changes, 'outside_serve');
    const changed = applied.length > 0 || outsideServe.length > 0 || imageChanged;
    const currentHash = this.#store.current().hash;
    // With nothing pending, the candidate is exactly the file, so its hash is the
    // file hash and stays comparable with `check-config` output. With fields
    // pending, a changed candidate matches no file version and gets a hash of its
    // own, while an unchanged one keeps the identity it already has.
    const activeHash =
      restartRequired.length === 0
        ? file.hash
        : changed
          ? createHash('sha256').update(JSON.stringify(diff.candidate.raw)).digest('hex')
          : currentHash;
    if (!changed && activeHash === currentHash) {
      // Nothing to publish, but the file hash and the pending list still move.
      this.#fileHash = file.hash;
      this.#restartRequired = restartRequired;
      this.#lastError = null;
      this.#logReloaded(applied, restartRequired, outsideServe);
      return this.#applied(applied, restartRequired, outsideServe);
    }
    // Reaching here without a changed field means only the hash moved: the active
    // configuration now equals a different file version, e.g. after a pending
    // field was reverted or only a comment was edited. Publishing the equal
    // candidate adopts that identity.
    // Synchronous from here on: the registry and the configuration are published
    // together, and no run can observe one without the other.
    this.#store.publish({
      config: diff.candidate.raw,
      hash: activeHash,
      models: rebuilt.registry.models,
      visionModel: rebuilt.registry.visionModel,
    });
    this.#activeFile = diff.candidate.file;
    this.#fileHash = file.hash;
    this.#restartRequired = restartRequired;
    this.#lastError = null;
    if (this.#imageConfig !== undefined) {
      // Same synchronous section as the configuration publish: no run can
      // observe a configuration whose image snapshot has not been swapped.
      // `undefined` publishes the disabled state: a missing (or stripped)
      // image section is a valid target state, not an error.
      this.#imageConfig.publish(imageSnapshot);
    }
    this.#imageSnapshotId = imageSnapshotId;
    this.#onPublished();
    this.#logReloaded(applied, restartRequired, outsideServe);
    return this.#applied(applied, restartRequired, outsideServe);
  }

  /**
   * Builds the candidate's registry. Every provider keeps the connection the
   * running process already resolved unless the file describes a different one,
   * so this is the only place a reload may resolve a SecretRef — a `command`
   * reference therefore runs here, exactly as it does at startup.
   */
  async #buildRegistry(
    candidate: RawConfig,
  ): Promise<
    | { readonly ok: true; readonly registry: ConfigurationModels }
    | { readonly ok: false; readonly code: ConfigErrorCode; readonly error: string }
  > {
    try {
      return {
        ok: true,
        registry: await buildModelRegistry(
          candidate,
          { file: this.#activeFile, models: this.#store.current().models },
          this.#secrets,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof SecretResolutionError ? 'secret_unresolved' : 'model_unusable',
        error: messageOf(error),
      };
    }
  }

  #applied(
    applied: readonly string[],
    restartRequired: readonly string[],
    outsideServe: readonly string[],
  ): ConfigApplyResult {
    return { ok: true, applied, restartRequired, outsideServe, status: this.status() };
  }

  /**
   * A write refused before the file was written. No reload ran, so the status
   * keeps describing the last apply: the caller gets the error, and the log
   * records it under its own event.
   */
  #rejected(code: ConfigErrorCode, message: string, event = 'model_switch_failed'): ConfigApplyResult {
    const redacted = this.#secrets.redact(message);
    console.log(JSON.stringify({ event, code, error: redacted, at: new Date().toISOString() }));
    return { ok: false, code, message: redacted, fileWritten: false, status: this.status() };
  }

  /** A failed apply: the active configuration stays, and the status records why. */
  #failure(code: ConfigErrorCode, message: string, fileWritten: boolean): ConfigApplyResult {
    const redacted = this.#secrets.redact(message);
    this.#lastError = { code, message: redacted, at: new Date().toISOString() };
    console.log(JSON.stringify({ event: 'config_reload_failed', code, error: redacted, at: this.#lastError.at }));
    return { ok: false, code, message: redacted, fileWritten, status: this.status() };
  }

  #logReloaded(applied: readonly string[], restartRequired: readonly string[], outsideServe: readonly string[]): void {
    const current = this.#store.current();
    console.log(
      JSON.stringify({
        event: 'config_reloaded',
        generation: current.generation,
        active_hash: current.hash,
        file_hash: this.#fileHash,
        applied: applied.join(','),
        restart_required: restartRequired.join(','),
        outside_serve: outsideServe.join(','),
        at: new Date().toISOString(),
      }),
    );
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function pathsOf(changes: readonly ConfigChange[], kind: ConfigChange['kind']): readonly string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
