import { eq } from 'drizzle-orm';
import { Bot, type Context } from 'grammy';
import { capability } from './capabilities/execute-tool.ts';
import { McpManager } from './capabilities/mcp.ts';
import { MediaService } from './capabilities/media/media.ts';
import { TelegramMediaClient } from './capabilities/media/media-download.ts';
import { StickerService } from './capabilities/stickers.ts';
import { MentionTyping } from './capabilities/mention-typing.ts';
import { grammySendApi } from './capabilities/telegram-send-api.ts';
import { createMemoryTools, MemoryStore } from './context/memory.ts';
import { createImageBridge, type ImageBridge } from './image/bridge.ts';
import { createImageService, type ImageService } from './image/service.ts';
import { AdminQueryError } from './ingress/admin/audit.ts';
import { AdminServer } from './ingress/admin/server.ts';
import { TelegramIngestion } from './ingress/telegram-ingestion.ts';
import { AgentRuntime, type CapabilityToolFactory, type ToolFactory } from './orchestration/agent-runtime.ts';
import {
  BOT_COMMANDS,
  BotCommandService,
  commandSender,
  type ParsedCommand,
  registerBotCommands,
} from './orchestration/bot-commands.ts';
import { ConversationRuntime } from './orchestration/conversation-runtime.ts';
import { ReplayError, ReplayRunner } from './orchestration/replay.ts';
import { BucketScheduler } from './orchestration/scheduler.ts';
import { KeyedSemaphore } from './platform/concurrency.ts';
import { assertConfigPermissions, loadConfig } from './platform/config.ts';
import { ConfigReloader } from './platform/config-reload.ts';
import { previewContext, unavailableCapabilities } from './platform/invocation-context.ts';
import { keyJarPath } from './platform/key-jar.ts';
import { AgentModelSwitcher } from './platform/model-switch.ts';
import { buildModelRegistry, configuredAgentModels } from './platform/providers.ts';
import { RuntimeConfigurationStore } from './platform/runtime-config.ts';
import { SecretStore } from './platform/secrets.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, SystemResources } from './platform/system-resources.ts';
import { BUILTIN_PLUGINS } from './plugins/builtin.ts';
import { loadPlugins } from './plugins/plugin.ts';
import { runStartupCatchUp } from './startup-catch-up.ts';
import { ServeLock, SqliteStore, stopRunningInstance, watchStopRequests } from './store/database.ts';
import { LongTaskService } from './store/long-tasks.ts';
import { activeSleepUntil } from './store/sleep.ts';
import { recordPromptVersionsFromConfig } from './store/prompt-versions.ts';
import { appState } from './store/schema.ts';

const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'] as const;

/**
 * Exit code of a panel-requested restart. `EX_TEMPFAIL` marks an intentional
 * stop that a supervisor should bring back, and stays distinguishable from a
 * crash in logs and container restart policies.
 */
export const RESTART_EXIT_CODE = 75;

export async function serve(configPath: string, takeover = false): Promise<void> {
  const loaded = await loadConfig(configPath);
  await assertConfigPermissions(loaded.configPath);
  const secrets = new SecretStore(keyJarPath(loaded.configPath));
  let lock: ServeLock | undefined;
  let stopWatcher: (() => void) | undefined;
  let store: SqliteStore | undefined;
  let imageService: ImageService | undefined;
  let imageBridge: ImageBridge | undefined;
  let bot: Bot | undefined;
  let scheduler: BucketScheduler | undefined;
  let stickers: StickerService | undefined;
  let mcp: McpManager | undefined;
  let mentionTyping: MentionTyping | undefined;
  let admin: AdminServer | undefined;
  let startupCatchUpController: AbortController | undefined;
  const replayShutdown = new AbortController();
  let shuttingDown = false;
  let restartRequested = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logEvent('shutdown_requested');
    startupCatchUpController?.abort(new Error('shutdown'));
    replayShutdown.abort(new Error('shutdown'));
    // Unblock bot.start() so the finally block below runs the full cleanup.
    // grammY's stop() also fires a best-effort offset-confirming getUpdates;
    // swallow its rejection so it can never become an unhandled promise
    // rejection and crash the process mid-shutdown.
    void bot?.stop().catch(() => undefined);
  };
  /**
   * The Admin Panel's restart: the same graceful shutdown as a signal, but the
   * process leaves with `RESTART_EXIT_CODE` so the supervisor starts it again.
   *
   * Shutdown reaches `admin.stop()` only through the `finally` block below,
   * after `bot.stop()` has unblocked `bot.start()`, so the panel's 202 is long
   * gone by the time the Admin server destroys its connections. Anything that
   * stops the Admin server earlier would cut that response off.
   */
  const requestRestart = (): void => {
    if (restartRequested || shuttingDown) {
      return;
    }
    restartRequested = true;
    logEvent('restart_requested');
    shutdown();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    const token = await secrets.resolve(loaded.config.telegram.token);
    if (takeover) {
      // Stop the incumbent only once this process knows it can start at all:
      // the config, its permissions and the bot token are checked by now.
      const stoppedPid = await stopRunningInstance(loaded.config.data_dir);
      logEvent('takeover_completed', { stopped_pid: stoppedPid });
    }
    lock = await ServeLock.acquire(loaded.config.data_dir);
    stopWatcher = watchStopRequests(loaded.config.data_dir, () => {
      logEvent('takeover_requested');
      shutdown();
    });
    store = await SqliteStore.open(loaded.config);
    const openedStore = store;
    // The startup load is the first place a hand-edited prompt file becomes
    // visible to the process; record the starting versions before any apply.
    recordPromptVersionsFromConfig(openedStore.orm, loaded.config);
    imageService = createImageService(openedStore, loaded.config, {
      logger: { warn: (message) => logEvent('image_service_warning', { message }) },
    });
    try {
      imageService.publishConfig(await imageService.prepareConfig(loaded.config, secrets));
    } catch (error) {
      // Image generation is optional; an unusable snapshot must not stop the bot.
      logEvent('image_service_warning', {
        message: secrets.redact(error instanceof Error ? error.message : String(error)),
      });
    }
    logEvent('image_service_started', {
      image_dir: imageService.imageDir,
      enabled: imageService.core.config.hasValidConfig(),
    });
    if (loaded.warnings.length > 0) {
      logEvent('config_warnings', { warnings: loaded.warnings.join(' | ') });
    }
    bot = new Bot(token);
    // The registry is built once here and republished by every reload; the
    // configuration and its models always travel together.
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
    const modelSwitcher = new AgentModelSwitcher(configStore);
    const me = await bot.api.getMe();
    try {
      await registerBotCommands(bot.api);
      logEvent('commands_registered', { commands: BOT_COMMANDS.map((entry) => entry.command).join(',') });
    } catch (error) {
      // Registration is convenience only: command parsing works without the
      // Telegram menu, so a failed setMyCommands must not block startup.
      logEvent('command_registration_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const initialized =
      store.orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, 'telegram_initialized'))
        .get() !== undefined;
    await bot.api.deleteWebhook({ drop_pending_updates: !initialized });
    if (!initialized) {
      store.orm
        .insert(appState)
        .values({ key: 'telegram_initialized', value: '1', updatedAt: new Date().toISOString() })
        .run();
    }
    const ingestion = new TelegramIngestion(store, configStore, me);
    const modelGate = new KeyedSemaphore();
    const mediaClient = new TelegramMediaClient(bot.api, token);
    const media = new MediaService({
      store,
      configStore,
      secrets,
      mediaClient,
      modelGate,
    });
    const stickerService = new StickerService({ store, config: loaded.config, api: bot.api, media });
    stickers = stickerService;
    await stickerService.sync();
    stickerService.start();
    const mcpManager = new McpManager(store, loaded.config, secrets);
    mcp = mcpManager;
    const memoryStore = new MemoryStore(store.orm);
    const tasks = new LongTaskService(store.orm, () => scheduler?.wake());
    const bridge = createImageBridge({
      service: imageService,
      store: openedStore,
      tasks,
      prepareInputImage: (mediaId, signal) => media.prepareInputImage(mediaId, signal),
    });
    imageBridge = bridge;
    bridge.reconcile();
    const plugins = loadPlugins(BUILTIN_PLUGINS, {
      image: imageBridge,
    });
    const systemResources = await SystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR, plugins.skillDirectories);
    logEvent('system_skills_loaded', { skills: systemResources.skills.map((skill) => skill.name).join(',') });
    const conversationRuntime = new ConversationRuntime({
      agentCacheSize: loaded.config.agent.context.agent_cache_size,
    });
    // Runtime-internal capabilities: dispatched through the execute primitive.
    const capabilityTools: CapabilityToolFactory = (context, deadline, capabilities) => [
      capability(media.createReadImageTool(context, capabilities, deadline), false),
      capability(stickerService.createSearchTool(context, capabilities), false),
      ...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true)),
      ...plugins.capabilities(
        openedStore,
        configStore.current().config,
        context,
        deadline,
        tasks,
        capabilities.resolveMedia,
      ),
    ];
    // Directly exposed non-primitive tools: allowlisted MCP tools only.
    const additionalTools: ToolFactory = (context, deadline) => [...mcpManager.createTools(context, deadline)];
    // One transport for both: its per-chat throttle is what keeps the mention
    // status and the model's own `typing` call from doubling up requests.
    const sendApi = grammySendApi(bot.api);
    const mentionStatus = new MentionTyping(sendApi);
    mentionTyping = mentionStatus;
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets,
      telegramApi: mentionStatus.wrap(sendApi),
      mentionTyping: mentionStatus,
      ...(imageBridge === undefined
        ? {}
        : {
            imageGeneration: {
              resolve: (generationId: string, conversationId: bigint) => {
                const current = imageBridge;
                if (current === undefined) {
                  return undefined;
                }
                const outputs = current.sendableOutputs(generationId, conversationId);
                if (outputs === undefined) {
                  return undefined;
                }
                return outputs.map((output) => {
                  const content = current.assetContent(output.asset_id);
                  return { assetId: output.asset_id, bytes: content.bytes, fileName: output.file_name };
                });
              },
            },
          }),
      bot: {
        id: BigInt(me.id),
        displayName: [me.first_name, me.last_name].filter((part) => part !== undefined).join(' '),
        username: me.username ?? null,
      },
      modelGate,
      systemResources,
      directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
      capabilityTools,
      additionalTools,
      conversationRuntime,
      skillVisibility: (skill) => skill.name !== 'image-generation' || (imageBridge?.enabled() ?? false),
    });
    const startedScheduler = new BucketScheduler(
      store,
      configStore,
      (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
      conversationRuntime,
      tasks,
    );
    scheduler = startedScheduler;
    const preview = previewContext();
    const configReloader = new ConfigReloader({
      loaded,
      store: configStore,
      modelSwitcher,
      secrets,
      imageConfig: {
        prepare: (candidate) =>
          imageService === undefined ? Promise.resolve(undefined) : imageService.prepareConfig(candidate, secrets),
        publish: (snapshot) => imageService?.publishConfig(snapshot as Parameters<ImageService['publishConfig']>[0]),
      },
      validateAgentModel: (model) =>
        runtime.validateAdditionalTools(
          preview,
          additionalTools(preview, Number.MAX_SAFE_INTEGER, unavailableCapabilities()),
          model,
        ),
      // A raised max_concurrency only takes effect on the next scheduler tick.
      onPublished: () => {
        startedScheduler.wake();
        // A hand-edited prompt file picked up by this apply becomes a version
        // here; panel saves already recorded themselves before applying.
        recordPromptVersionsFromConfig(openedStore.orm, configStore.current().config);
      },
    });
    const commands = new BotCommandService(
      store,
      configStore,
      startedScheduler,
      modelSwitcher,
      conversationRuntime,
      configReloader,
    );
    mcpManager.setRegistryValidator((mcpTools) => {
      const snapshot = configStore.current();
      for (const { model } of configuredAgentModels(snapshot.config, snapshot.models)) {
        runtime.validateAdditionalTools(preview, mcpTools, model);
      }
    });
    const catchUpController = new AbortController();
    startupCatchUpController = catchUpController;
    const catchUp = await runStartupCatchUp({
      api: bot.api,
      store,
      ingestion,
      scheduler: startedScheduler,
      commands,
      allowedUpdates: ALLOWED_UPDATES,
      signal: catchUpController.signal,
    });
    startupCatchUpController = undefined;
    logEvent('startup_catch_up_completed', {
      updates: catchUp.updates,
      stored_messages: catchUp.storedMessages,
      invocations: catchUp.invocationIds.length,
    });
    await mcpManager.start();
    startedScheduler.start();
    if (loaded.config.admin?.enabled === true) {
      const replay = new ReplayRunner({
        store,
        configStore,
        secrets,
        systemResources,
        modelGate,
        shutdownSignal: replayShutdown.signal,
        toolDefinitions: (context, config) => runtime.sceneToolDefinitions(context, config),
        skillVisibility: (skill) => skill.name !== 'image-generation' || (imageBridge?.enabled() ?? false),
        imageLoader: async (mediaId, signal) => {
          const image = await media.prepareSceneImage(mediaId, signal);
          return { type: 'image', data: image.base64, mimeType: image.mime };
        },
      });
      const adminServer = new AdminServer({
        store,
        configStore,
        scheduler: startedScheduler,
        tasks,
        modelSwitcher,
        configReloader,
        secrets,
        requestRestart,
        imageService,
        imageBridge,
        mediaDownloader: mediaClient,
        shutdownSignal: replayShutdown.signal,
        replayPreflight: (id, selection) => {
          try {
            return replay.inspect(id, selection);
          } catch (error) {
            if (error instanceof ReplayError) {
              throw new AdminQueryError(error.code, error.message, error.status);
            }
            throw error;
          }
        },
        invocationPrompts: (id) => {
          try {
            return replay.prompts(id);
          } catch (error) {
            if (error instanceof ReplayError) {
              throw new AdminQueryError(error.code, error.message, error.status);
            }
            throw error;
          }
        },
        replayInvocation: async (id, input, signal) => {
          try {
            return await replay.run(id, input, signal);
          } catch (error) {
            if (error instanceof ReplayError) {
              throw new AdminQueryError(error.code, error.message, error.status);
            }
            throw error;
          }
        },
      });
      admin = adminServer;
      const listening = await adminServer.start();
      logEvent('admin_started', { host: listening.hostname, port: listening.port });
    }
    bot.use(async (context) => {
      const result = ingestion.ingest(context.update);
      // A sleeping bot skips queued invocations, so a status would promise a reply that never comes.
      if (result.mention !== undefined && activeSleepUntil(openedStore.orm) === null) {
        mentionStatus.start(result.mention.chatId.toString(), result.mention.threadId);
      }
      if (result.command !== undefined) {
        await replyToCommand(context, commands, result.command);
      }
      startedScheduler.wake();
    });
    logEvent('serve_started', { bot_id: String(me.id), config_hash: loaded.hash });
    await bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(secrets.redact(message));
  } finally {
    replayShutdown.abort(new Error('shutdown'));
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    stopWatcher?.();
    await admin?.stop();
    await scheduler?.stop(30_000);
    mentionTyping?.stopAll();
    // The image worker borrows the SQLite connection; it must settle (marking
    // late results interrupted if the shutdown budget expires) before the
    // store closes underneath it.
    imageBridge?.stop();
    await imageService?.stop();
    await stickers?.stop();
    await mcp?.stop();
    store?.close();
    await lock?.release();
  }
  if (restartRequested) {
    logEvent('restart_exit', { code: RESTART_EXIT_CODE });
    // Leaving through the exit code lets pending output flush; the unref'd timer
    // only fires if some handle outlives the cleanup, so the supervisor is not
    // left waiting on a process that cannot finish.
    process.exitCode = RESTART_EXIT_CODE;
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 1_000).unref();
  }
}

export function logEvent(event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

async function replyToCommand(context: Context, commands: BotCommandService, command: ParsedCommand): Promise<void> {
  const message = context.update.message;
  if (message === undefined) {
    return;
  }
  const chatId = message.chat.id;
  const sender = commandSender(message);
  let text: string;
  try {
    text = await commands.run(command, BigInt(chatId), sender);
  } catch (error) {
    logEvent('command_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    await context.api.sendMessage(String(chatId), text, {
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      reply_parameters: { message_id: message.message_id },
    });
    logEvent('command_reply_sent', { command: command.name, chat_id: String(chatId) });
  } catch (error) {
    logEvent('command_reply_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
