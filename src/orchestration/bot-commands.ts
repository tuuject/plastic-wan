import { and, eq, sql } from 'drizzle-orm';
import type { Message } from 'grammy/types';
import { ConversationContextStore, listConversationContexts } from '../context/context-store.ts';
import { type AgentSettings, type RawConfig, resolveAgentSettings } from '../platform/config.ts';
import type { ConfigReloader } from '../platform/config-reload.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../platform/model-switch.ts';
import { isWithinActiveWindows } from '../platform/participation.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { isChatPaused, resolveChatConfig, type SqliteStore } from '../store/database.ts';
import { chatAttentionUntil, ParticipationRegistry } from '../store/participation.ts';
import { chatPause, chats, conversationContextCutoffs, conversations, dailyUsage } from '../store/schema.ts';
import { readDailyTokenBudget } from '../store/sleep.ts';
import type { ConversationRuntime } from './conversation-runtime.ts';
import type { BucketScheduler } from './scheduler.ts';

export interface ParsedCommand {
  readonly name:
    | 'pause'
    | 'resume'
    | 'status'
    | 'model'
    | 'cut_topic'
    | 'whoami'
    | 'allowlist'
    | 'ignoreme'
    | 'unignoreme';
  readonly argument?: string;
  /** Telegram message ID of the command message itself; used by cut_topic. */
  readonly messageId?: bigint;
  /**
   * Forum topic the command was sent in; the Conversation Context to cut. Absent
   * for every chat that has one Conversation, which is the `message_thread_id = 0`
   * case — see `conversationThreadId`.
   */
  readonly threadId?: bigint;
}

/**
 * The Conversation a Telegram message belongs to, as a thread id.
 *
 * Telegram sets `message_thread_id` on more than forum topics: a private chat
 * with thread mode enabled carries one on its messages, and so does a reply
 * inside a plain supergroup. Ingestion files all of those under thread 0, so this
 * rule is the only one that agrees with `conversations`; reading the raw field
 * instead (as `parseBotCommand` once did) makes `/cut_topic` look for a
 * Conversation that was never written, clear no Context, and still reply that it
 * did — the exact failure the cut exists to prevent.
 */
export function conversationThreadId(message: Message | undefined): bigint {
  return message?.chat.type === 'supergroup' &&
    message.chat.is_forum === true &&
    message.is_topic_message === true &&
    message.message_thread_id !== undefined
    ? BigInt(message.message_thread_id)
    : 0n;
}

export interface CommandSender {
  readonly id: bigint;
  readonly name: string;
  readonly username: string | null;
}

/** What chat-scoped `/model` itself writes; any other applied path came from the file. */
function switchPaths(configuredChatId: number): ReadonlySet<string> {
  return new Set([
    `telegram.chats[${configuredChatId}].provider`,
    `telegram.chats[${configuredChatId}].model`,
    `telegram.chats[${configuredChatId}].thinking_level`,
  ]);
}
const COMMAND_NAMES: Record<string, true> = {
  pause: true,
  resume: true,
  status: true,
  model: true,
  cut_topic: true,
  whoami: true,
  allowlist: true,
  ignoreme: true,
  unignoreme: true,
} satisfies Record<ParsedCommand['name'], true>;
const DENIED_REPLY = '该命令仅对本 Bot 的管理员可用。';
const MODEL_PAGE_SIZE = 20;

export interface BotCommandRegistration {
  readonly command: string;
  readonly description: string;
}

// Single source of truth for the Telegram command menu: everything registered
// via setMyCommands must also parse in parseBotCommand.
export const BOT_COMMANDS: readonly BotCommandRegistration[] = [
  { command: 'pause', description: '暂停本群互动（仅管理员）' },
  { command: 'resume', description: '恢复本群互动（仅管理员）' },
  { command: 'status', description: '查看当前模型、thinking effort 与本日 token 用量' },
  { command: 'model', description: '查看或切换 agent 模型（仅管理员）' },
  { command: 'cut_topic', description: '切掉此消息及更早的历史，仅对新会话生效（仅管理员）' },
  { command: 'whoami', description: '查看你的 Telegram 数字 ID' },
  { command: 'allowlist', description: '将本群加入白名单，立即生效（仅管理员）' },
  { command: 'ignoreme', description: '让 Bot 忽略你在本 Chat 的消息' },
  { command: 'unignoreme', description: '恢复 Bot 接收你在本 Chat 的消息' },
];

export interface CommandRegistrationApi {
  setMyCommands(commands: readonly BotCommandRegistration[]): Promise<unknown>;
}

export async function registerBotCommands(api: CommandRegistrationApi): Promise<void> {
  for (const entry of BOT_COMMANDS) {
    if (COMMAND_NAMES[entry.command] !== true) {
      throw new Error(`Command not handled by parseBotCommand: ${entry.command}`);
    }
  }
  await api.setMyCommands(BOT_COMMANDS);
}

// Telegram command tokens are case-insensitive and may carry an explicit
// bot mention (`/pause@PlasticWanBot`); the mention must match this bot.
export function parseBotCommand(message: Message, botUsername: string | null): ParsedCommand | null {
  if (message.text === undefined || message.from?.is_bot === true) {
    return null;
  }
  const entity = message.entities?.find((entry) => entry.type === 'bot_command' && entry.offset === 0);
  if (entity === undefined) {
    return null;
  }
  const token = message.text.slice(0, entity.length);
  const separator = token.indexOf('@');
  const name = (separator === -1 ? token.slice(1) : token.slice(1, separator)).toLowerCase();
  const mention = separator === -1 ? null : token.slice(separator + 1).toLowerCase();
  if (mention !== null && mention !== botUsername?.toLowerCase()) {
    return null;
  }
  if (COMMAND_NAMES[name] !== true) {
    return null;
  }
  const base: ParsedCommand =
    name !== 'model'
      ? { name: name as ParsedCommand['name'] }
      : (() => {
          const argument = message.text.slice(entity.offset + entity.length).trim();
          return argument.length === 0 ? { name: 'model' } : { name: 'model', argument };
        })();
  const threadId = conversationThreadId(message);
  const scoped: ParsedCommand = {
    ...base,
    ...(message.message_id === undefined ? {} : { messageId: BigInt(message.message_id) }),
    ...(threadId === 0n ? {} : { threadId }),
  };
  return scoped;
}

// Chat-scoped control commands. State changes and replies are deterministic
// bot responses, not model output, so they bypass the agent send tool.
export class BotCommandService {
  readonly #store: SqliteStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #scheduler: BucketScheduler;
  readonly #modelSwitcher: AgentModelSwitcher | undefined;
  readonly #configReloader: ConfigReloader | undefined;
  readonly #participation: ParticipationRegistry;
  readonly #contexts: ConversationContextStore;
  readonly #conversationRuntime: ConversationRuntime | undefined;

  constructor(
    store: SqliteStore,
    configStore: RuntimeConfigurationStore,
    scheduler: BucketScheduler,
    modelSwitcher?: AgentModelSwitcher,
    conversationRuntime?: ConversationRuntime,
    configReloader?: ConfigReloader,
  ) {
    this.#store = store;
    this.#configStore = configStore;
    this.#scheduler = scheduler;
    this.#modelSwitcher = modelSwitcher;
    this.#configReloader = configReloader;
    this.#participation = new ParticipationRegistry(configStore);
    this.#contexts = new ConversationContextStore(store);
    this.#conversationRuntime = conversationRuntime;
  }

  async run(
    command: ParsedCommand,
    telegramChatId: bigint,
    sender: CommandSender | null,
    now = new Date(),
  ): Promise<string> {
    switch (command.name) {
      case 'pause':
        return this.#adminGate(sender) ? this.#pause(telegramChatId, now) : DENIED_REPLY;
      case 'resume':
        return this.#adminGate(sender) ? this.#resume(telegramChatId) : DENIED_REPLY;
      case 'status':
        return this.#status(telegramChatId, now);
      case 'model':
        return this.#adminGate(sender) ? await this.#modelSwitch(command.argument, telegramChatId) : DENIED_REPLY;
      case 'cut_topic':
        return this.#adminGate(sender)
          ? this.#cutTopic(telegramChatId, command.messageId, command.threadId, now)
          : DENIED_REPLY;
      case 'whoami':
        return sender === null ? '无法识别发送者。' : sender.id.toString();
      case 'allowlist':
        return this.#adminGate(sender) ? await this.#allowlist(telegramChatId) : DENIED_REPLY;
      case 'ignoreme':
      case 'unignoreme':
        return await this.#setSelfIgnored(telegramChatId, sender, command.name === 'ignoreme');
    }
  }

  #adminGate(sender: CommandSender | null): boolean {
    if (sender === null) {
      return false;
    }
    // The whitelist is `telegram.admins`, read from the live configuration so a
    // hot-applied list change takes effect on the next command.
    const admins = this.#configStore.current().config.telegram.admins ?? [];
    return admins.some((id) => BigInt(id) === sender.id);
  }

  #pause(telegramChatId: bigint, now: Date): string {
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) {
      throw new Error(`Chat ${telegramChatId} has no stored row`);
    }
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#store.orm
        .insert(chatPause)
        .values({ chatId, pausedAt: timestamp })
        .onConflictDoUpdate({ target: chatPause.chatId, set: { pausedAt: timestamp } })
        .run();
      this.#store.orm.run(
        sql`UPDATE buckets SET state = 'expired', error_code = 'chat_paused', finished_at = ${timestamp}, updated_at = ${timestamp}
           WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})
             AND (state IN ('collecting', 'queued') OR (state = 'running' AND id IN (
               SELECT ib.bucket_id FROM invocation_buckets ib JOIN invocations i ON i.id = ib.invocation_id
               WHERE i.state = 'running' AND ib.injected_at IS NULL AND ib.bucket_id <> i.bucket_id
             )))`,
      );
      // Suppress only queued deliveries. Running work settles normally after abort.
      this.#store.orm.run(
        sql`UPDATE task_receipts SET state = 'suppressed', cancelled_at = ${timestamp}, cancel_reason = 'chat_paused', admin_cancelled = 0, updated_at = ${timestamp}
           WHERE state = 'claimed' AND invocation_id IN (
             SELECT i.id FROM invocations i
             JOIN conversations v ON v.id = i.conversation_id
             WHERE i.state = 'queued' AND v.chat_id = ${chatId}
           )`,
      );
      this.#store.orm.run(
        sql`UPDATE invocations SET state = 'aborted', completion_reason = 'chat_paused', finished_at = ${timestamp}
           WHERE state = 'queued' AND conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})`,
      );
    });
    this.#scheduler.pauseChat(chatId);
    return '已暂停本群互动，发送 /resume 可恢复。';
  }

  #resume(telegramChatId: bigint): string {
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) {
      throw new Error(`Chat ${telegramChatId} has no stored row`);
    }
    this.#store.orm.delete(chatPause).where(eq(chatPause.chatId, chatId)).run();
    return '已恢复本群互动。';
  }

  // Cuts one Conversation's agent-session history at the command message itself:
  // the cutoff row stores the command's Telegram message ID, so the command and
  // everything before it in the same topic drop out of future invocations. Other
  // topics of the chat keep their history, matching the Context clear below.
  // Replying is safe even when this chat has never triggered the agent.
  //
  // The continuous Conversation Context is cleared in the same step. Without
  // that, the command would only trim the rendered history while the model kept
  // seeing everything through its retained transcript.
  #cutTopic(telegramChatId: bigint, messageId: bigint | undefined, threadId: bigint | undefined, now: Date): string {
    if (messageId === undefined) {
      throw new Error(`cut_topic command is missing its Telegram message ID`);
    }
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) {
      throw new Error(`Chat ${telegramChatId} has no stored row`);
    }
    const timestamp = now.toISOString();
    const conversationId = this.#store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId ?? 0n)))
      .get()?.id;
    // No Conversation row means this topic has stored nothing yet, so there is
    // no history to cut and no Context to clear.
    if (conversationId !== undefined) {
      // The cutoff only moves forward: a late or re-delivered older command must
      // not bring back history a newer cut already removed.
      this.#store.orm
        .insert(conversationContextCutoffs)
        .values({ conversationId, telegramMessageId: messageId, createdAt: timestamp, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: conversationContextCutoffs.conversationId,
          set: {
            telegramMessageId: sql`MAX(${conversationContextCutoffs.telegramMessageId}, excluded.telegram_message_id)`,
            updatedAt: timestamp,
          },
        })
        .run();
      // Interrupt before clearing. A run in flight holds the pre-cut transcript and
      // a header snapshot taken at its start, so it would keep answering from the
      // history just cut and could write a lower `head_seq` back over the cut.
      this.#scheduler.abortConversation(conversationId);
      const header = this.#contexts.header(conversationId);
      if (header !== undefined) {
        this.#contexts.clear(header, now);
        console.log(
          JSON.stringify({
            event: 'context_cleared',
            conversation_id: conversationId.toString(),
            chat_id: telegramChatId.toString(),
            head_seq: header.headSeq.toString(),
            at: timestamp,
          }),
        );
      }
      // Drop the in-memory transcript too; the canonical history is the truth.
      this.#conversationRuntime?.forget(conversationId);
    }
    return '已切掉此消息及更早的历史，并清空该话题的连续 Context。';
  }

  // The one command that may run in a chat the allowlist does not yet name:
  // ingestion passes it through for admins precisely so it can extend the
  // allowlist itself. The entry is appended to `telegram.chats` as `{ id }` and
  // hot-applied, so the chat joins the normal ingestion path without a restart.
  async #allowlist(telegramChatId: bigint): Promise<string> {
    if (resolveChatConfig(this.#configStore.current().config, this.#store.orm, telegramChatId) !== undefined) {
      return '本群已在白名单中。';
    }
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return '运行时配置应用不可用。';
    }
    const chatId = Number(telegramChatId);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      return `无效的 Chat ID: ${telegramChatId.toString()}`;
    }
    const result = await reloader.addChat(chatId);
    if (!result.ok) {
      return result.fileWritten
        ? `已写入 config.jsonc，但应用失败: ${result.message}`
        : `加入白名单失败: ${result.message}`;
    }
    const lines = ['已将本群加入白名单，配置已立即生效。'];
    if (result.restartRequired.length > 0) {
      lines.push(`另有 ${result.restartRequired.length} 项配置需要重启后生效。`);
    }
    return lines.join('\n');
  }

  async #setSelfIgnored(telegramChatId: bigint, sender: CommandSender | null, ignored: boolean): Promise<string> {
    if (sender === null) {
      return '无法识别发送者，请使用个人账号发送命令。';
    }
    const reloader = this.#configReloader;
    if (reloader === undefined) {
      return '运行时配置应用不可用。';
    }
    const chat = resolveChatConfig(this.#configStore.current().config, this.#store.orm, telegramChatId);
    if (chat === undefined) {
      return '本 Chat 未在配置中找到。';
    }
    const result = await reloader.setChatUserIgnored(chat.id, sender.id, ignored);
    if (!result.ok) {
      return result.fileWritten
        ? `已写入 config.jsonc，但应用失败: ${result.message}`
        : `更新忽略名单失败: ${result.message}`;
    }
    const lines = [
      ignored
        ? '已忽略你在本 Chat 的消息，配置已立即生效。发送 /unignoreme 可恢复。'
        : '已恢复接收你在本 Chat 的消息，配置已立即生效。',
    ];
    const other = result.applied.filter((path) => path !== `telegram.chats[${chat.id}].ignored_user_ids`);
    if (other.length > 0) {
      lines.push(`同时应用了配置文件中的其它修改: ${other.join(', ')}`);
    }
    if (result.restartRequired.length > 0) {
      lines.push(`另有 ${result.restartRequired.length} 项配置需要重启后生效。`);
    }
    return lines.join('\n');
  }

  async #modelSwitch(argument: string | undefined, telegramChatId: bigint): Promise<string> {
    const switcher = this.#modelSwitcher;
    const reloader = this.#configReloader;
    if (switcher === undefined || reloader === undefined) {
      return '运行时模型切换不可用。';
    }
    const config = this.#configStore.current().config;
    const chatConfig = resolveChatConfig(config, this.#store.orm, telegramChatId);
    if (chatConfig === undefined) {
      return '本 Chat 未在配置中找到。';
    }
    const configuredChatId = chatConfig.id;
    const effective = resolveAgentSettings(config, chatConfig);
    const options = switcher.list();

    if (argument === undefined) {
      return this.#modelMenu(1, options, effective, chatConfig);
    }

    const pageMatch = /^page\s+(\d+)$/.exec(argument);
    if (pageMatch !== null) {
      const page = Number.parseInt(pageMatch[1] ?? '', 10);
      const pageCount = Math.max(1, Math.ceil(options.length / MODEL_PAGE_SIZE));
      if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
        return `无效页码。${this.#modelMenu(1, options, effective, chatConfig)}`;
      }
      return this.#modelMenu(page, options, effective, chatConfig);
    }
    const reset = argument === 'default';
    const index = /^\d+$/.test(argument) ? Number.parseInt(argument, 10) : NaN;
    const option = options[index - 1];
    if (!reset && option === undefined) {
      return `无效序号。${this.#modelMenu(1, options, effective, chatConfig)}`;
    }
    const result =
      option === undefined
        ? await reloader.resetChatModel(configuredChatId)
        : await reloader.setChatModel(configuredChatId, option.provider, option.model);
    if (!result.ok) {
      return result.fileWritten
        ? `已写入 config.jsonc，但应用失败: ${result.message}`
        : `${reset ? '恢复' : '切换'}失败: ${result.message}`;
    }
    const current = this.#configStore.current().config;
    const settings = resolveAgentSettings(current, resolveChatConfig(current, this.#store.orm, telegramChatId));
    const paths = switchPaths(configuredChatId);
    const lines = reset
      ? [`已清除本群模型覆盖，跟随全局 ${settings.provider} / ${settings.model}，将在下一次 agent session 生效。`]
      : [
          `已为本群切换: ${settings.provider} / ${settings.model}，已写入 config.jsonc，将在下一次 agent session 生效。`,
          `思考强度已重置为该模型最弱的一档: ${settings.thinking_level}`,
        ];
    const other = result.applied.filter((path) => !paths.has(path));
    if (other.length > 0) {
      lines.push(`同时应用了配置文件中的其它修改: ${other.join(', ')}`);
    }
    if (result.restartRequired.length > 0) {
      lines.push(`另有 ${result.restartRequired.length} 项配置需要重启后生效。`);
    }
    return lines.join('\n');
  }

  #modelMenu(
    page: number,
    options: readonly AgentModelOption[],
    effective: AgentSettings,
    chatConfig: RawConfig['telegram']['chats'][number],
  ): string {
    const hasProviderOverride = chatConfig.provider !== undefined;
    const hasModelOverride = chatConfig.model !== undefined;
    const hasThinkingOverride = chatConfig.thinking_level !== undefined;
    const pageCount = Math.max(1, Math.ceil(options.length / MODEL_PAGE_SIZE));
    const start = (page - 1) * MODEL_PAGE_SIZE;
    const end = Math.min(start + MODEL_PAGE_SIZE, options.length);
    const lines = [
      `本群模型: ${effective.provider} / ${effective.model}${hasProviderOverride || hasModelOverride ? '' : '（继承全局）'}`,
      `思考强度: ${effective.thinking_level}${hasThinkingOverride ? '' : '（继承全局）'}`,
      `可用模型（第 ${page}/${pageCount} 页，共 ${options.length} 条）:`,
    ];
    for (let index = start; index < end; index += 1) {
      const option = options[index];
      if (option === undefined) {
        break;
      }
      lines.push(`${index + 1}. ${option.provider} / ${option.model}（${option.name}）`);
    }
    lines.push('使用 /model 序号 切换，/model page 页码 翻页，/model default 清除本群覆盖');
    return lines.join('\n');
  }

  #status(telegramChatId: bigint, now: Date): string {
    const chat = this.#chatConfig(telegramChatId);
    if (chat === undefined) {
      throw new Error(`Chat ${telegramChatId} is not configured`);
    }
    const date = now.toISOString().slice(0, 10);
    const chatId = this.#internalChatId(telegramChatId);
    const tokens =
      this.#store.orm
        .select({ amount: dailyUsage.amount })
        .from(dailyUsage)
        .where(
          and(
            eq(dailyUsage.utcDate, date),
            eq(dailyUsage.scope, 'chat'),
            eq(dailyUsage.resource, telegramChatId.toString()),
            eq(dailyUsage.metric, 'model_tokens'),
          ),
        )
        .get()?.amount ?? 0n;
    const dailyBudget = readDailyTokenBudget(
      this.#store.orm,
      this.#configStore.current().config.agent.daily_budget.max_tokens,
      now,
    );
    const dailyBudgetBasisPoints =
      (dailyBudget.usedTokens * 10_000n + dailyBudget.maxTokens / 2n) / dailyBudget.maxTokens;
    const dailyBudgetPercentage = `${dailyBudgetBasisPoints / 100n}.${(dailyBudgetBasisPoints % 100n).toString().padStart(2, '0')}%`;
    const tokenBreakdown =
      chatId === null
        ? null
        : this.#store.orm
            .all<{
              readTokens: bigint;
              writeTokens: bigint;
              cacheReadTokens: bigint;
              cacheWriteTokens: bigint;
            }>(
              sql`SELECT COALESCE(SUM(model_calls.input_tokens), 0) AS readTokens,
                      COALESCE(SUM(model_calls.output_tokens), 0) AS writeTokens,
                      COALESCE(SUM(model_calls.cache_read_tokens), 0) AS cacheReadTokens,
                      COALESCE(SUM(model_calls.cache_write_tokens), 0) AS cacheWriteTokens
               FROM model_calls
               JOIN invocations ON invocations.id = model_calls.invocation_id
               WHERE invocations.conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})
                 AND substr(model_calls.finished_at, 1, 10) = ${date}`,
            )
            .at(0);
    const config = this.#configStore.current().config;
    const effective = resolveAgentSettings(config, chat);
    const paused = chatId !== null && isChatPaused(this.#store.orm, chatId);
    const hasProviderOverride = chat.provider !== undefined;
    const hasModelOverride = chat.model !== undefined;
    const hasThinkingOverride = chat.thinking_level !== undefined;
    const lines = [
      `本群模型: ${effective.provider} / ${effective.model}${hasProviderOverride || hasModelOverride ? '' : '（继承全局）'}`,
      `思考强度: ${effective.thinking_level}${hasThinkingOverride ? '' : '（继承全局）'}`,
      `本群今日 token 用量: ${tokens.toLocaleString('en-US')}`,
      `全局今日 token 用量: ${dailyBudget.usedTokens.toLocaleString('en-US')} / ${dailyBudget.maxTokens.toLocaleString('en-US')} (${dailyBudgetPercentage})`,
      `读取: ${(tokenBreakdown?.readTokens ?? 0n).toLocaleString('en-US')}`,
      `写入: ${(tokenBreakdown?.writeTokens ?? 0n).toLocaleString('en-US')}`,
      `缓存读取: ${(tokenBreakdown?.cacheReadTokens ?? 0n).toLocaleString('en-US')}`,
      `缓存写入: ${(tokenBreakdown?.cacheWriteTokens ?? 0n).toLocaleString('en-US')}`,
    ];
    if (paused) {
      lines.push('互动: 已暂停');
      lines.push(...this.#contextLines(telegramChatId));
      return lines.join('\n');
    }
    const participation = this.#participationLine(telegramChatId, chatId, now);
    if (participation !== null) {
      lines.push(participation);
    }
    lines.push(...this.#contextLines(telegramChatId));
    return lines.join('\n');
  }

  /**
   * Conversation Context visibility: how much retained history the agent sees,
   * how many sends are inside the GC window, and when the last collection ran.
   */
  #contextLines(telegramChatId: bigint): string[] {
    const rows = listConversationContexts(this.#store, { telegramChatId });
    if (rows.length === 0) {
      return ['Context: 尚未建立'];
    }
    return rows.map((row) => {
      const topic = row.messageThreadId === 0n ? '' : `#${row.messageThreadId.toString()} `;
      const header = this.#contexts.header(row.conversationId);
      const stats = header === undefined ? null : this.#contexts.stats(header);
      const gc = stats?.lastGcAt == null ? '未 GC' : `上次 GC ${stats.lastGcAt}`;
      return `Context ${topic}消息 ${stats?.messageCount ?? Number(row.messageCount)}，保留 send ${stats?.retainedSends ?? 0}，head_seq ${row.headSeq}，${gc}`;
    });
  }

  // Only chats with a configured schedule report a participation line, so chats
  // that always participate keep the previous `/status` layout.
  #participationLine(telegramChatId: bigint, chatId: bigint | null, now: Date): string | null {
    const chat = this.#store.orm
      .select({ type: chats.type })
      .from(chats)
      .where(eq(chats.telegramChatId, telegramChatId))
      .get();
    if (chat === undefined) {
      return null;
    }
    const rule = this.#participation.ruleFor(this.#store.orm, telegramChatId, chat.type);
    if (rule === undefined) {
      return null;
    }
    if (isWithinActiveWindows(rule, now)) {
      return '互动: 活跃时段内';
    }
    const until = chatId === null ? null : chatAttentionUntil(this.#store.orm, chatId, now);
    return until === null ? '互动: 静默（仅 @、Reply 或关键词触发）' : `互动: 注意力窗口至 ${until}`;
  }

  #internalChatId(telegramChatId: bigint): bigint | null {
    return (
      this.#store.orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, telegramChatId)).get()?.id ??
      null
    );
  }

  #chatConfig(telegramChatId: bigint): RawConfig['telegram']['chats'][number] | undefined {
    return resolveChatConfig(this.#configStore.current().config, this.#store.orm, telegramChatId);
  }
}
