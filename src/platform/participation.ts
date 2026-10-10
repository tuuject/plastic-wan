import type { Message } from 'grammy/types';
import type { ParticipationConfig, ParticipationWindowConfig } from './config.ts';

/** Default length of the post-trigger attention window, in seconds. */
export const DEFAULT_ATTENTION_WINDOW_SECONDS = 300;

export type TriggerKind = 'mention' | 'reply_to_bot' | 'keyword';

export interface BotIdentity {
  readonly id: bigint;
  readonly username: string | null;
}

interface CompiledWindow {
  readonly startMinutes: number;
  /** Exclusive; `1440` is the end of the day. */
  readonly endMinutes: number;
  /** ISO weekdays 1-7; `null` means every day. */
  readonly days: readonly number[] | null;
}

/**
 * A chat's participation schedule with all per-message work already done:
 * clock times are minute offsets, keywords are lower-cased, and the timezone
 * only costs one cached formatter construction.
 */
export interface ParticipationRule {
  readonly windows: readonly CompiledWindow[];
  readonly keywords: readonly string[];
  readonly windowSeconds: number;
  readonly timezone: string;
}

/**
 * Merges the global participation defaults with one chat's overrides. `windows`
 * are replaced wholesale (an empty array means the chat has no scheduled
 * activity), keywords are appended, and the window length is overridden.
 * Returns `undefined` when neither level configures participation, which keeps
 * the chat on the unrestricted default behavior.
 */
export function compileParticipation(options: {
  readonly global: ParticipationConfig | undefined;
  readonly chat: ParticipationConfig | undefined;
  readonly timezone: string;
}): ParticipationRule | undefined {
  const { global, chat, timezone } = options;
  if (global === undefined && chat === undefined) {
    return undefined;
  }
  const windows = chat?.active_windows ?? global?.active_windows ?? [];
  const keywords = [...(global?.trigger_keywords ?? []), ...(chat?.trigger_keywords ?? [])];
  return {
    windows: windows.map(compileWindow),
    keywords: uniqueLowerCased(keywords),
    windowSeconds:
      chat?.attention_window_seconds ?? global?.attention_window_seconds ?? DEFAULT_ATTENTION_WINDOW_SECONDS,
    timezone,
  };
}

/** Half-open `[start, end)` wall-clock match; a window crossing midnight belongs to its start day. */
export function isWithinActiveWindows(rule: ParticipationRule, now: Date): boolean {
  if (rule.windows.length === 0) {
    return false;
  }
  const local = localTime(rule.timezone, now);
  const previousWeekday = local.weekday === 1 ? 7 : local.weekday - 1;
  for (const window of rule.windows) {
    if (window.endMinutes > window.startMinutes) {
      if (
        local.minutes >= window.startMinutes &&
        local.minutes < window.endMinutes &&
        matchesDay(window, local.weekday)
      ) {
        return true;
      }
      continue;
    }
    if (local.minutes >= window.startMinutes && matchesDay(window, local.weekday)) {
      return true;
    }
    if (local.minutes < window.endMinutes && matchesDay(window, previousWeekday)) {
      return true;
    }
  }
  return false;
}

/** A direct mention wins over a reply, which wins over a keyword hit. */
export function matchTriggerKind(message: Message, bot: BotIdentity, keywords: readonly string[]): TriggerKind | null {
  if (mentionsBot(message, bot)) {
    return 'mention';
  }
  if (repliesToBot(message, bot)) {
    return 'reply_to_bot';
  }
  return containsKeyword(message, keywords) ? 'keyword' : null;
}

/** Whether the message @-mentions the bot by username or by a text mention of its id. */
export function mentionsBot(message: Message, bot: BotIdentity): boolean {
  const username = bot.username?.toLowerCase() ?? null;
  // `entities` offsets index `text`; `caption_entities` offsets index `caption`.
  const sources = [
    [message.text, message.entities],
    [message.caption, message.caption_entities],
  ] as const;
  for (const [content, entities] of sources) {
    for (const entity of entities ?? []) {
      if (entity.type === 'text_mention') {
        if (BigInt(entity.user.id) === bot.id) {
          return true;
        }
        continue;
      }
      // A plain `mention` only carries "@username" text, so the token must be
      // compared against this bot's username rather than trusted as-is.
      if (entity.type !== 'mention' || username === null || content === undefined) {
        continue;
      }
      if (
        content
          .slice(entity.offset, entity.offset + entity.length)
          .slice(1)
          .toLowerCase() === username
      ) {
        return true;
      }
    }
  }
  return false;
}

function repliesToBot(message: Message, bot: BotIdentity): boolean {
  const reply = message.reply_to_message;
  return reply?.from !== undefined && BigInt(reply.from.id) === bot.id;
}

function containsKeyword(message: Message, keywords: readonly string[]): boolean {
  if (keywords.length === 0) {
    return false;
  }
  for (const content of [message.text, message.caption]) {
    if (content === undefined) {
      continue;
    }
    const haystack = content.toLowerCase();
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) {
        return true;
      }
    }
  }
  return false;
}

function compileWindow(window: ParticipationWindowConfig): CompiledWindow {
  return {
    startMinutes: parseClock(window.start),
    endMinutes: window.end === '24:00' ? 1440 : parseClock(window.end),
    days: window.days ?? null,
  };
}

function parseClock(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number.parseInt(hours ?? '', 10) * 60 + Number.parseInt(minutes ?? '', 10);
}

function matchesDay(window: CompiledWindow, weekday: number): boolean {
  return window.days === null || window.days.includes(weekday);
}

function uniqueLowerCased(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

interface LocalTime {
  /** ISO weekday, 1 = Monday. */
  readonly weekday: number;
  /** Minutes since local midnight. */
  readonly minutes: number;
}

// Constructing an Intl.DateTimeFormat is the expensive part of timezone
// resolution, so one formatter per timezone is cached for the process lifetime.
// Timezones come from validated config, so the map stays tiny.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function localTime(timezone: string, now: Date): LocalTime {
  let formatter = FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    FORMATTERS.set(timezone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    parts[part.type] = part.value;
  }
  const year = Number.parseInt(parts.year ?? '', 10);
  const month = Number.parseInt(parts.month ?? '', 10);
  const day = Number.parseInt(parts.day ?? '', 10);
  // Deriving the weekday from the local calendar date keeps this locale
  // independent; 1970-01-01 was a Thursday, so day 0 is ISO weekday 4.
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  return {
    weekday: ((dayNumber + 3) % 7) + 1,
    minutes: Number.parseInt(parts.hour ?? '', 10) * 60 + Number.parseInt(parts.minute ?? '', 10),
  };
}
