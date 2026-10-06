/**
 * Admin time filters: turn a human-written wall-clock timestamp into a UTC
 * instant (`from`/`to`) or a precision window (`at`), resolving bare
 * timestamps in an explicitly supplied IANA timezone. The host machine's own
 * timezone is never consulted, and a local time that a DST transition makes
 * nonexistent or ambiguous is rejected instead of silently shifted.
 */

export type MessageTimeErrorReason =
  | 'syntax'
  | 'calendar'
  | 'offset'
  | 'range'
  | 'timezone'
  | 'nonexistent'
  | 'ambiguous';

export class MessageTimeError extends Error {
  readonly reason: MessageTimeErrorReason;

  constructor(reason: MessageTimeErrorReason, message: string) {
    super(message);
    this.name = 'MessageTimeError';
    this.reason = reason;
  }
}

export interface MessageTimeWindow {
  /** Inclusive UTC ISO-8601 lower bound. */
  readonly from: string;
  /** Exclusive UTC ISO-8601 upper bound. */
  readonly to: string;
}

export interface MessageTimeOptions {
  /**
   * IANA zone used by timestamps that carry no UTC offset. Those timestamps
   * are rejected when this is undefined; there is no host-timezone fallback.
   */
  readonly timezone: string | undefined;
}

/** `YYYY-MM-DD[T ]HH:mm[:ss[.S{1,3}]][Z|±HH:mm]`, anchored and fully validated below. */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Milliseconds of second precision; fractions below a second are 100/10/1ms. */
const SECOND_PRECISION_MS = 1_000;

/** Any real zone offset fits inside ±14h, which bounds the DST probes below. */
const MAX_OFFSET_MS = 14 * 3_600_000;

export function parseMessageTimeInstant(value: string, options: MessageTimeOptions): string {
  const timestamp = parseTimestamp(value);
  return toIso(resolveInstant(timestamp, options, value), value);
}

/**
 * `at` names a whole window at the written precision: the minute `10:30`
 * covers `10:30:00.000`–`10:30:59.9999…`, `10:30:30.5` covers 100ms, and so
 * on. The window is half-open so consecutive values never overlap.
 */
export function parseMessageTimeWindow(value: string, options: MessageTimeOptions): MessageTimeWindow {
  const timestamp = parseTimestamp(value);
  const start = resolveInstant(timestamp, options, value);
  return { from: toIso(start, value), to: toIso(start + timestamp.precisionMs, value) };
}

interface ParsedTimestamp {
  /** The written wall clock read as if it were UTC. */
  readonly wallMs: number;
  /** Length of the precision window the written text implies. */
  readonly precisionMs: number;
  /** Explicit UTC offset in minutes, or null when the text carries none. */
  readonly offsetMinutes: number | null;
}

function parseTimestamp(value: string): ParsedTimestamp {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    throw new MessageTimeError(
      'syntax',
      `"${value}" is not a timestamp of the form YYYY-MM-DD[T ]HH:mm[:ss[.fff]][Z|±HH:mm]`,
    );
  }
  const group = (index: number): string => match[index] ?? '';
  const year = Number(group(1));
  const month = Number(group(2));
  const day = Number(group(3));
  const hour = Number(group(4));
  const minute = Number(group(5));
  const secondsText = match[6];
  const fractionText = match[7];
  const second = secondsText === undefined ? 0 : Number(secondsText);
  const fractionMs = fractionText === undefined ? 0 : Number(fractionText.padEnd(3, '0'));
  if (year < 1000) {
    throw new MessageTimeError('range', `"${value}" must use a four-digit year between 1000 and 9999`);
  }
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, fractionMs);
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new MessageTimeError('calendar', `"${value}" is not a valid calendar timestamp`);
  }
  const precisionMs =
    secondsText === undefined
      ? 60_000
      : fractionText === undefined
        ? SECOND_PRECISION_MS
        : 10 ** (3 - fractionText.length);
  return { wallMs, precisionMs, offsetMinutes: match[8] === undefined ? null : parseOffset(group(8)) };
}

function parseOffset(text: string): number {
  if (text === 'Z') {
    return 0;
  }
  const hours = Number(text.slice(1, 3));
  const minutes = Number(text.slice(4, 6));
  const total = hours * 60 + minutes;
  if (hours > 14 || minutes > 59 || total > 14 * 60) {
    throw new MessageTimeError('offset', `UTC offset "${text}" must be between -14:00 and +14:00`);
  }
  return text.startsWith('-') ? -total : total;
}

function resolveInstant(timestamp: ParsedTimestamp, options: MessageTimeOptions, value: string): number {
  if (timestamp.offsetMinutes !== null) {
    return timestamp.wallMs - timestamp.offsetMinutes * 60_000;
  }
  const timezone = options.timezone;
  if (timezone === undefined || timezone.length === 0) {
    throw new MessageTimeError(
      'timezone',
      `no timezone is available for "${value}"; include an explicit UTC offset (Z or ±HH:mm)`,
    );
  }
  return resolveZonedInstant(timestamp.wallMs, timezone, value);
}

/**
 * Resolves one wall clock in an IANA zone. A wall clock right at a DST
 * transition can name zero instants (gap) or two (overlap); both are rejected
 * so a filter never silently means something the writer did not intend.
 */
function resolveZonedInstant(wallMs: number, timeZone: string, value: string): number {
  const formatter = zoneFormatter(timeZone);
  const candidates = new Set<number>();
  for (const probe of [wallMs - MAX_OFFSET_MS, wallMs + MAX_OFFSET_MS]) {
    const offset = zoneOffsetMs(probe, formatter);
    const candidate = wallMs - offset;
    if (zoneOffsetMs(candidate, formatter) === offset) {
      candidates.add(candidate);
    }
  }
  if (candidates.size === 0) {
    throw new MessageTimeError(
      'nonexistent',
      `"${value}" does not exist in timezone ${timeZone} because of a DST transition; include an explicit UTC offset`,
    );
  }
  if (candidates.size > 1) {
    throw new MessageTimeError(
      'ambiguous',
      `"${value}" is ambiguous in timezone ${timeZone} because of a DST transition; include an explicit UTC offset`,
    );
  }
  for (const candidate of candidates) {
    return candidate;
  }
  throw new MessageTimeError('nonexistent', `"${value}" has no instant in timezone ${timeZone}`);
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new MessageTimeError('timezone', `unknown timezone "${timeZone}"`);
  }
}

/** Offset of the zone at one instant: its wall-clock reading minus the instant itself. */
function zoneOffsetMs(instantMs: number, formatter: Intl.DateTimeFormat): number {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return wallMs - Math.floor(instantMs / 1000) * 1000;
}

function toIso(instantMs: number, value: string): string {
  if (!Number.isFinite(instantMs) || Math.abs(instantMs) > 8.64e15) {
    throw new MessageTimeError('range', `"${value}" is outside the supported timestamp range`);
  }
  return new Date(instantMs).toISOString();
}
