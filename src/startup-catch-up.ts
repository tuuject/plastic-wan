import { eq } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { TelegramIngestion } from './ingress/telegram-ingestion.ts';
import { type BotCommandService, commandSender } from './orchestration/bot-commands.ts';
import { type BucketScheduler, STARTUP_CATCH_UP_STATE_KEY } from './orchestration/scheduler.ts';
import type { SqliteStore } from './store/database.ts';
import { appState } from './store/schema.ts';

interface GetUpdatesOptions {
  readonly offset?: number;
  readonly limit: number;
  readonly timeout: number;
  readonly allowed_updates?: readonly Exclude<keyof Update, 'update_id'>[];
}

export interface StartupCatchUpApi {
  getUpdates(options: GetUpdatesOptions): Promise<Update[]>;
}

export interface StartupCatchUpOptions {
  readonly api: StartupCatchUpApi;
  readonly store: SqliteStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  /**
   * Runs the commands ingestion reports during the drain — `/pause` and
   * `/resume` only, in update order. The service applies the same admin gate
   * and state transitions as live commands; its reply is discarded because
   * these updates are old.
   */
  readonly commands: BotCommandService;
  readonly allowedUpdates: readonly Exclude<keyof Update, 'update_id'>[];
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface StartupCatchUpResult {
  readonly updates: number;
  readonly storedMessages: number;
  readonly invocationIds: readonly bigint[];
}

export async function runStartupCatchUp(options: StartupCatchUpOptions): Promise<StartupCatchUpResult> {
  const currentTime = options.now ?? (() => new Date());
  const requestedStart = currentTime();
  const startedAt = options.store.transaction(() => {
    options.store.orm
      .insert(appState)
      .values({
        key: STARTUP_CATCH_UP_STATE_KEY,
        value: requestedStart.toISOString(),
        updatedAt: requestedStart.toISOString(),
      })
      .onConflictDoNothing({ target: appState.key })
      .run();
    const state = options.store.orm
      .select({ value: appState.value })
      .from(appState)
      .where(eq(appState.key, STARTUP_CATCH_UP_STATE_KEY))
      .get();
    if (state === undefined || !Number.isFinite(Date.parse(state.value))) {
      throw new Error('Startup catch-up state is missing or invalid');
    }
    return new Date(state.value);
  });

  let offset: number | undefined;
  let updatesReceived = 0;
  let storedMessages = 0;
  let firstRequest = true;
  while (true) {
    const request: GetUpdatesOptions = {
      limit: 100,
      timeout: 0,
      ...(offset === undefined ? {} : { offset }),
      ...(firstRequest ? { allowed_updates: options.allowedUpdates } : {}),
    };
    options.signal?.throwIfAborted();
    const updates = await options.api.getUpdates(request);
    if (updates.length === 0) {
      break;
    }
    for (const update of updates) {
      const receivedAt = currentTime();
      const result = options.ingestion.ingestCatchUp(update, receivedAt);
      updatesReceived += 1;
      if (result.messageId !== undefined && update.message !== undefined) {
        storedMessages += 1;
      }
      const command = result.command;
      const message = update.message;
      if (command !== undefined && message !== undefined) {
        // In update order, so a later /resume or /pause wins exactly as it
        // would have live; duplicates never get here (ingestion dedupes them).
        await options.commands.run(command, BigInt(message.chat.id), commandSender(message), receivedAt);
      }
    }
    const lastUpdate = updates.at(-1);
    if (lastUpdate !== undefined) {
      offset = lastUpdate.update_id + 1;
    }
    firstRequest = false;
  }

  const invocationIds = options.scheduler.finishStartupCatchUp(startedAt, currentTime());
  return { updates: updatesReceived, storedMessages, invocationIds };
}
