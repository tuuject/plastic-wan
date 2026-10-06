/**
 * Rebuilds one historical public-chat scene out of stored data.
 *
 * A scene is the model input a fresh invocation would have had at the moment
 * its opening bucket was frozen: the opening bucket's `new` snapshots (the
 * trigger batch) plus the conversation history that provably existed then.
 * It reads only `messages` / `message_revisions` / `invocation_messages` (and
 * the surrounding rows they reference) and never writes — no Context refs, no
 * canonical history, no snapshots of its own.
 *
 * Retained images receive ephemeral scene-local references when the current
 * model supports image input. Other media carry explicit unavailable/missing
 * markers. This builder never fetches bytes or persists capability references.
 *
 * Deliberate boundaries:
 * - The trigger batch is the *frozen* opening batch. Later attached buckets,
 *   later edits and the bot's own later reply are never read for it; a legacy
 *   `source_bucket_id IS NULL` batch counts as opening only when the invocation
 *   has no other attached bucket.
 * - Frozen history takes precedence; remaining history uses revisions and
 *   arrivals provable at `invocations.created_at`, before the last opening
 *   message. Current history limits, `/cut_topic` and chat/topic allowlists
 *   apply. Ignored-user settings are ingress-only, not retroactive filters.
 *   Missing revisions are counted, never replaced with later edits.
 * - With `beforeSendId`, the input is only frozen public messages strictly
 *   between the previous bot message and the selected successful send. Proven
 *   pre-send injections are flattened into one batch; no earlier history or
 *   reply quotes enter it. The cutoff is the selected send's request start;
 *   equal-millisecond injections are omitted because their order is unproven.
 * - The runtime block carries `current_time` (the scene cutoff, or `options.now`)
 *   and an empty `<memory_list>`; live memory, sticker catalogs and task
 *   receipts are never read.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Static } from 'typebox';
import Compile from 'typebox/compile';
import type { RawConfig } from '../platform/config.ts';
import { resolveChatConfig, type SqliteStore } from '../store/database.ts';
import { media } from '../store/schema.ts';
import { formatSnapshot, MessageSnapshotSchema, type PreparedSnapshot } from './context-builder.ts';

const storedSnapshotValidator = Compile(MessageSnapshotSchema);
type StoredSnapshot = Static<typeof MessageSnapshotSchema>;

export interface SceneContextOptions {
  /** Same three inputs `renderInjection` uses to size one batch. */
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly toolDefinitionCharacters: number;
  /** Rendering clock; defaults to the scene cutoff. History bounds never move. */
  readonly now?: Date;
  readonly supportsImages?: boolean;
  /** Successful telegram_sends row: replay only the public input since the previous bot message. */
  readonly beforeSendId?: bigint;
}

export interface SceneContext {
  /** Rendered scene: runtime block, untrusted history block, untrusted new block. */
  readonly text: string;
  readonly historyCount: number;
  readonly messageCount: number;
  /** Window messages the scene could not render (missing revision or character budget). */
  readonly omittedMessages: number;
  /** Rendered media entries without an authorized image reference. */
  readonly omittedImages: number;
  /** The moment the opening batch was frozen (`invocations.created_at`). */
  readonly cutoffAt: string;
  readonly bucketId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  /** Media row IDs referenced by the rendered messages, for statistics only. */
  readonly mediaIds: readonly bigint[];
  readonly mediaRefs: ReadonlyMap<string, bigint>;
  /** Every rendered message is a possible same-scene reply target. */
  readonly replyMessageIds: readonly string[];
  readonly slice?: {
    readonly beforeSendId: string;
    readonly beforeMessageId: string;
    readonly afterBotMessageId: string | null;
  };
}

export class SceneSliceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MEDIA_UNAVAILABLE = 'media_unavailable';
const MEDIA_MISSING = 'media_missing';

interface SceneSource {
  readonly bucketId: bigint;
  readonly bucketKind: string;
  readonly conversationId: bigint;
  readonly createdAt: string;
  readonly threadId: bigint;
  readonly chatId: bigint;
}

/** One rendered message plus the media rows it references, for statistics. */
interface SceneMessage {
  snapshot: PreparedSnapshot;
  readonly mediaIds: readonly bigint[];
}

interface OpeningRow {
  readonly snapshot_json: string;
  readonly revision_id: bigint | null;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
}

interface HistoryRow {
  readonly message_id: bigint;
  readonly snapshot_json: string | null;
  readonly frozen_revision_id: bigint | null;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly sent_by_bot: bigint;
  readonly revision_id: bigint | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_display_name: string | null;
  readonly sender_username: string | null;
}

interface HistoryMediaRow {
  readonly revision_id: bigint;
  readonly id: bigint;
  readonly kind: string;
  readonly mime_type: string | null;
  readonly width: bigint | null;
  readonly height: bigint | null;
}

export function buildSceneContext(
  store: SqliteStore,
  config: RawConfig,
  invocationId: bigint,
  options: SceneContextOptions,
): SceneContext {
  const originalSource = loadSource(store, invocationId);
  const slice =
    options.beforeSendId === undefined
      ? undefined
      : loadBotSlice(store, invocationId, originalSource, options.beforeSendId);
  const source = slice === undefined ? originalSource : { ...originalSource, createdAt: slice.cutoffAt };
  const chatConfig = resolveChatConfig(config, store.orm, source.chatId);
  if (chatConfig === undefined) {
    throw new Error(`Scene context: chat ${source.chatId} is no longer configured`);
  }
  const topics = chatConfig.topic_ids;
  if (topics !== undefined && !topics.some((topicId) => BigInt(topicId) === source.threadId)) {
    throw new Error(`Scene context: topic ${source.threadId} of chat ${source.chatId} is not allowed`);
  }
  const opening =
    slice === undefined
      ? loadOpeningBatch(store, invocationId, source)
      : loadSliceBatch(store, invocationId, source, slice);
  if (slice !== undefined) {
    const ids = new Set(opening.map((entry) => entry.snapshot.message_id));
    for (const entry of opening) {
      entry.snapshot = {
        ...entry.snapshot,
        reply_to_message_id: ids.has(entry.snapshot.reply_to_message_id ?? '')
          ? entry.snapshot.reply_to_message_id
          : null,
        reply_snapshot: null,
      };
    }
  }
  const last = opening
    .map((entry) => entry.snapshot)
    .sort(compareMessages)
    .at(-1);
  if (last === undefined) {
    throw new Error('Scene context: opening messages unavailable');
  }
  const { newestFirst, missing } =
    slice === undefined
      ? loadHistoryWindow(store, invocationId, source, config, last)
      : { newestFirst: [], missing: 0 };
  const mediaRefs = new Map<string, bigint>();
  if (options.supportsImages === true) {
    for (const entry of [...opening, ...newestFirst]) {
      entry.snapshot.media.forEach((image, index) => {
        const id = entry.mediaIds[index];
        if (
          id !== undefined &&
          image.image_ref !== MEDIA_MISSING &&
          (image.kind === 'photo' ||
            image.kind === 'sticker' ||
            (image.kind === 'document' && image.mime_type?.startsWith('image/') === true))
        ) {
          const ref = `img_${randomUUID().replaceAll('-', '')}`;
          entry.snapshot = {
            ...entry.snapshot,
            media: entry.snapshot.media.map((value, i) => (i === index ? { ...value, image_ref: ref } : value)),
          };
          mediaRefs.set(ref, id);
        }
      });
    }
  }

  const timezone = chatConfig.timezone ?? config.timezone;
  const renderedAt = options.now ?? new Date(source.createdAt);
  const showTopic = source.bucketKind === 'startup_catch_up';
  const renderOptions = { timezone, now: renderedAt, showTopic, inlineReplies: new Set<string>() };
  const render = (entry: SceneMessage, inlineReplies: ReadonlySet<string>): string =>
    formatSnapshot(entry.snapshot, { ...renderOptions, inlineReplies });
  const maximumCharacters = Math.max(
    1_024,
    Math.floor(options.contextWindow * 4 * config.agent.context_stop_ratio) -
      options.toolDefinitionCharacters -
      options.maxOutputTokens * 4,
  );

  // Same selection order and same "newest wins" rule as `renderInjection`: the
  // trigger batch is measured first (its newest message always survives, even
  // oversized), then history fills the remaining character budget.
  let usedCharacters = 0;
  const selectedNew: SceneMessage[] = [];
  for (const entry of opening.toReversed()) {
    const size = render(entry, renderOptions.inlineReplies).length + 1;
    if (selectedNew.length > 0 && usedCharacters + size > maximumCharacters) {
      break;
    }
    selectedNew.unshift(entry);
    usedCharacters += size;
  }
  const selectedHistory: SceneMessage[] = [];
  for (const entry of newestFirst) {
    const size = render(entry, renderOptions.inlineReplies).length + 1;
    if (usedCharacters + size > maximumCharacters) {
      break;
    }
    selectedHistory.unshift(entry);
    usedCharacters += size;
  }
  const omittedNew = opening.length - selectedNew.length;
  const omittedMessages = missing + (newestFirst.length - selectedHistory.length) + omittedNew;
  const inlineReplies = new Set([...selectedHistory, ...selectedNew].map((entry) => entry.snapshot.message_id));
  if (slice !== undefined) {
    for (const entry of selectedNew) {
      entry.snapshot = {
        ...entry.snapshot,
        // Slice replies can name rendered input only, never quote an earlier bot answer or omitted message.
        reply_to_message_id: inlineReplies.has(entry.snapshot.reply_to_message_id ?? '')
          ? entry.snapshot.reply_to_message_id
          : null,
        reply_snapshot: null,
      };
    }
  }
  const historyText = selectedHistory.map((entry) => render(entry, inlineReplies)).join('\n');
  const currentText = selectedNew.map((entry) => render(entry, inlineReplies)).join('\n');
  const omission = omittedNew === 0 ? '' : `[${omittedNew} earlier new messages omitted to fit the model context]\n`;
  const runtimeState = [
    `current_time: ${renderCurrentTime(timezone, renderedAt)}`,
    '<memory_list>\n</memory_list>',
  ].join('\n');
  const text = [
    '<runtime_state>',
    runtimeState,
    '</runtime_state>',
    ...(historyText.length === 0 ? [] : ['<untrusted_telegram_history>', historyText, '</untrusted_telegram_history>']),
    '<untrusted_new_messages>',
    `${omission}${currentText}`,
    '</untrusted_new_messages>',
  ].join('\n');

  const rendered = [...selectedHistory, ...selectedNew];
  const renderedIds = new Set(rendered.map((entry) => entry.snapshot.message_id));
  const mediaIds = new Set<bigint>();
  const selectedRefs = new Map<string, bigint>();
  let omittedImages = 0;
  for (const entry of rendered) {
    for (const id of entry.mediaIds) {
      mediaIds.add(id);
    }
    for (const image of entry.snapshot.media) {
      const id = mediaRefs.get(image.image_ref);
      if (id === undefined) {
        omittedImages += 1;
      } else {
        selectedRefs.set(image.image_ref, id);
      }
    }
  }
  return {
    text,
    historyCount: selectedHistory.length,
    messageCount: rendered.length,
    omittedMessages,
    omittedImages,
    cutoffAt: source.createdAt,
    bucketId: source.bucketId,
    conversationId: source.conversationId,
    chatId: source.chatId,
    threadId: source.threadId,
    mediaIds: [...mediaIds],
    mediaRefs: selectedRefs,
    replyMessageIds: [...renderedIds],
    ...(slice === undefined
      ? {}
      : {
          slice: {
            beforeSendId: slice.sendId.toString(),
            beforeMessageId: slice.messageId.toString(),
            afterBotMessageId: slice.previousMessageId?.toString() ?? null,
          },
        }),
  };
}

function loadSource(store: SqliteStore, invocationId: bigint): SceneSource {
  const source = store.orm
    .all<{
      bucket_id: bigint;
      bucket_kind: string;
      conversation_id: bigint;
      created_at: string;
      message_thread_id: bigint;
      telegram_chat_id: bigint;
    }>(
      sql`SELECT i.bucket_id, i.conversation_id, i.created_at, b.kind AS bucket_kind,
                 v.message_thread_id, c.telegram_chat_id
          FROM invocations i
          JOIN buckets b ON b.id = i.bucket_id
          JOIN conversations v ON v.id = i.conversation_id
          JOIN chats c ON c.id = v.chat_id
          WHERE i.id = ${invocationId}`,
    )
    .at(0);
  if (source === undefined) {
    throw new Error(`Scene context: invocation ${invocationId} does not exist`);
  }
  return {
    bucketId: source.bucket_id,
    bucketKind: source.bucket_kind,
    conversationId: source.conversation_id,
    createdAt: source.created_at,
    threadId: source.message_thread_id,
    chatId: source.telegram_chat_id,
  };
}

/**
 * The opening bucket's frozen `new` rows. Current writers tag every row with its
 * bucket; rows without a tag are accepted as opening only for invocations that
 * never attached another bucket, so a legacy NULL batch can be used while a
 * modern attach can never leak through.
 */
function loadOpeningBatch(store: SqliteStore, invocationId: bigint, source: SceneSource): SceneMessage[] {
  const rows = store.orm.all<OpeningRow>(
    sql`SELECT im.snapshot_json, r.id AS revision_id, m.telegram_message_id, m.telegram_date
        FROM invocation_messages im
        JOIN messages m ON m.id = im.message_id
        LEFT JOIN message_revisions r ON r.id = im.revision_id AND r.message_id = m.id
        WHERE im.invocation_id = ${invocationId}
          AND im.section = 'new'
          AND m.conversation_id = ${source.conversationId}
          AND (im.source_bucket_id = ${source.bucketId} OR (
            im.source_bucket_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM invocation_buckets ib
              WHERE ib.invocation_id = im.invocation_id AND ib.bucket_id <> ${source.bucketId}
            )
          ))
        ORDER BY im.sequence_no`,
  );
  const parsed: StoredSnapshot[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.snapshot_json);
    } catch {
      throw new Error(`Scene context: invocation ${invocationId} contains an invalid message snapshot`);
    }
    if (
      !storedSnapshotValidator.Check(value) ||
      value.message_id !== row.telegram_message_id.toString() ||
      value.telegram_date !== row.telegram_date ||
      (value.message_thread_id !== undefined && value.message_thread_id !== source.threadId.toString())
    ) {
      throw new Error(`Scene context: invocation ${invocationId} contains an unexpected message snapshot`);
    }
    parsed.push(value);
  }
  return parsed.map((snapshot, index) => {
    const row = rows[index];
    if (row === undefined || row.revision_id === null) {
      throw new Error(`Scene context: invocation ${invocationId} contains an invalid revision snapshot`);
    }
    const missing = missingMediaIds(
      store,
      snapshot.media.map((entry) => BigInt(entry.id)),
      row.revision_id,
    );
    return {
      snapshot: {
        message_id: snapshot.message_id,
        ...(snapshot.message_thread_id === undefined ? {} : { message_thread_id: snapshot.message_thread_id }),
        telegram_date: snapshot.telegram_date,
        sent_by_bot: snapshot.sent_by_bot,
        sender: snapshot.sender,
        kind: snapshot.kind,
        text: snapshot.text,
        caption: snapshot.caption,
        reply_to_message_id: snapshot.reply_to_message_id,
        reply_snapshot: snapshot.reply_snapshot,
        forward_origin: snapshot.forward_origin,
        media_group_id: snapshot.media_group_id,
        media: snapshot.media.map((entry) => ({
          // Only retained media belonging to this frozen revision can receive
          // an ephemeral reference when the scene supports image input.
          image_ref: missing.has(BigInt(entry.id)) ? MEDIA_MISSING : MEDIA_UNAVAILABLE,
          kind: entry.kind,
          mime_type: entry.mime_type,
          width: entry.width,
          height: entry.height,
        })),
      },
      mediaIds: snapshot.media.map((entry) => BigInt(entry.id)),
    };
  });
}

/**
 * The newest `agent.history_messages` messages of the conversation that were
 * provably visible at the cutoff. Each message contributes the newest revision
 * created no later than the cutoff; a message whose provable revision is gone
 * is dropped and counted. Frozen history takes precedence over the fallback,
 * and all opening/attached messages are excluded from this history window.
 */
function loadHistoryWindow(
  store: SqliteStore,
  invocationId: bigint,
  source: SceneSource,
  config: RawConfig,
  last: PreparedSnapshot,
): { readonly newestFirst: readonly SceneMessage[]; readonly missing: number } {
  const rows = store.orm.all<HistoryRow>(
    sql`SELECT m.id AS message_id, im.snapshot_json, frozen.id AS frozen_revision_id,
               m.telegram_message_id, m.telegram_date, m.sent_by_bot,
               r.id AS revision_id, r.kind, r.text, r.caption, r.reply_to_message_id,
               r.reply_snapshot_json, r.forward_origin_json, r.media_group_id,
               s.telegram_id AS sender_telegram_id, s.display_name AS sender_display_name, s.username AS sender_username
        FROM messages m
        LEFT JOIN invocation_messages im ON im.message_id = m.id
          AND im.invocation_id = ${invocationId} AND im.section = 'history'
        LEFT JOIN message_revisions frozen ON frozen.id = im.revision_id AND frozen.message_id = m.id
        LEFT JOIN message_revisions r ON r.id = (
          SELECT r2.id FROM message_revisions r2
          WHERE r2.message_id = m.id AND r2.created_at <= ${source.createdAt}
          ORDER BY r2.revision_no DESC LIMIT 1
        )
        LEFT JOIN senders s ON s.id = r.sender_id
        WHERE m.conversation_id = ${source.conversationId}
          AND m.visible = 1
          AND (im.message_id IS NOT NULL OR m.received_at <= ${source.createdAt})
          AND m.telegram_message_id > COALESCE(
            (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = ${source.conversationId}),
            -1)
          AND (m.telegram_date < ${last.telegram_date} OR
            (m.telegram_date = ${last.telegram_date} AND m.telegram_message_id < ${BigInt(last.message_id)}))
          AND m.id NOT IN (SELECT bm.message_id FROM bucket_messages bm
            JOIN invocation_buckets ib ON ib.bucket_id = bm.bucket_id WHERE ib.invocation_id = ${invocationId})
          AND m.id NOT IN (
            SELECT im.message_id FROM invocation_messages im
            WHERE im.invocation_id = ${invocationId} AND im.section = 'new')
        ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
        LIMIT ${BigInt(config.agent.history_messages)}`,
  );
  return renderHistoryRows(store, rows, source, config.agent.history_messages);
}

function renderHistoryRows(
  store: SqliteStore,
  rows: readonly HistoryRow[],
  source: SceneSource,
  limit = rows.length,
): { readonly newestFirst: readonly SceneMessage[]; readonly missing: number } {
  const revisionIds = rows.flatMap((row) => (row.revision_id === null ? [] : [row.revision_id]));
  const mediaByRevision = new Map<bigint, HistoryMediaRow[]>();
  if (revisionIds.length > 0) {
    const mediaRows = store.orm
      .select({
        revisionId: media.revisionId,
        id: media.id,
        kind: media.kind,
        mimeType: media.mimeType,
        width: media.width,
        height: media.height,
      })
      .from(media)
      .where(inArray(media.revisionId, revisionIds))
      .orderBy(media.id)
      .all();
    for (const row of mediaRows) {
      const entry: HistoryMediaRow = {
        revision_id: row.revisionId,
        id: row.id,
        kind: row.kind,
        mime_type: row.mimeType,
        width: row.width,
        height: row.height,
      };
      const list = mediaByRevision.get(row.revisionId);
      if (list === undefined) {
        mediaByRevision.set(row.revisionId, [entry]);
      } else {
        list.push(entry);
      }
    }
  }
  const newestFirst: SceneMessage[] = [];
  let missing = 0;
  for (const row of rows) {
    if (row.snapshot_json !== null) {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      if (
        !storedSnapshotValidator.Check(parsed) ||
        row.frozen_revision_id === null ||
        parsed.message_id !== row.telegram_message_id.toString() ||
        parsed.telegram_date !== row.telegram_date ||
        (parsed.message_thread_id !== undefined && parsed.message_thread_id !== source.threadId.toString())
      ) {
        throw new Error('Scene context: invalid history snapshot');
      }
      const absent = missingMediaIds(
        store,
        parsed.media.map((image) => BigInt(image.id)),
        row.frozen_revision_id,
      );
      newestFirst.push({
        snapshot: {
          ...parsed,
          media: parsed.media.map((image) => ({
            kind: image.kind,
            mime_type: image.mime_type,
            width: image.width,
            height: image.height,
            image_ref: absent.has(BigInt(image.id)) ? MEDIA_MISSING : MEDIA_UNAVAILABLE,
          })),
        },
        mediaIds: parsed.media.map((image) => BigInt(image.id)),
      });
      continue;
    }
    if (row.revision_id === null) {
      missing += 1;
      continue;
    }
    const mediaRows = mediaByRevision.get(row.revision_id) ?? [];
    newestFirst.push({
      snapshot: {
        message_id: row.telegram_message_id.toString(),
        message_thread_id: source.threadId.toString(),
        telegram_date: row.telegram_date,
        sent_by_bot: row.sent_by_bot === 1n,
        sender: {
          id: row.sender_telegram_id?.toString() ?? null,
          name: row.sender_display_name,
          username: row.sender_username,
        },
        kind: row.kind ?? 'unknown',
        text: row.text,
        caption: row.caption,
        reply_to_message_id: row.reply_to_message_id?.toString() ?? null,
        reply_snapshot: parseStoredJson(row.reply_snapshot_json),
        forward_origin: parseStoredJson(row.forward_origin_json),
        media_group_id: row.media_group_id,
        media: mediaRows.map((entry) => ({
          image_ref: MEDIA_UNAVAILABLE,
          kind: entry.kind,
          mime_type: entry.mime_type,
          width: entry.width?.toString() ?? null,
          height: entry.height?.toString() ?? null,
        })),
      },
      mediaIds: mediaRows.map((entry) => entry.id),
    });
  }
  const unique = new Map(newestFirst.map((entry) => [entry.snapshot.message_id, entry]));
  return {
    newestFirst: [...unique.values()].sort((a, b) => compareMessages(b.snapshot, a.snapshot)).slice(0, limit),
    missing,
  };
}

interface BotSlice {
  readonly sendId: bigint;
  readonly messageId: bigint;
  readonly previousMessageId: bigint | null;
  /** Request start, not delivery completion: later arrivals cannot influence this answer. */
  readonly cutoffAt: string;
}

function loadBotSlice(store: SqliteStore, invocationId: bigint, source: SceneSource, sendId: bigint): BotSlice {
  const target = store.orm
    .all<{ message_id: bigint; cutoff_at: string }>(
      sql`SELECT ts.telegram_message_id AS message_id, ts.created_at AS cutoff_at
        FROM telegram_sends ts JOIN tool_calls tc ON tc.id = ts.tool_call_id
        WHERE ts.id = ${sendId} AND tc.invocation_id = ${invocationId}
          AND ts.conversation_id = ${source.conversationId}
          AND ts.state = 'success' AND ts.telegram_message_id IS NOT NULL`,
    )
    .at(0);
  if (target === undefined) {
    throw new SceneSliceError(
      'replay_slice_target_invalid',
      'Slice target must be a retained successful send from this invocation',
    );
  }
  const previous = store.orm
    .all<{ message_id: bigint }>(
      sql`SELECT MAX(message_id) AS message_id FROM (
          SELECT telegram_message_id AS message_id FROM messages
          WHERE conversation_id = ${source.conversationId} AND sent_by_bot = 1
            AND telegram_message_id < ${target.message_id}
          UNION ALL
          SELECT telegram_message_id AS message_id FROM telegram_sends
          WHERE conversation_id = ${source.conversationId} AND state = 'success'
            AND telegram_message_id < ${target.message_id}
        )`,
    )
    .at(0);
  return {
    sendId,
    messageId: target.message_id,
    previousMessageId: previous?.message_id ?? null,
    cutoffAt: target.cutoff_at,
  };
}

/** Only frozen public inputs known before the selected send; all batches enter immediately. */
function loadSliceBatch(
  store: SqliteStore,
  invocationId: bigint,
  source: SceneSource,
  slice: BotSlice,
): SceneMessage[] {
  const rows = store.orm.all<HistoryRow>(
    sql`WITH eligible AS (
          SELECT im.* FROM invocation_messages im
          JOIN message_revisions known ON known.id = im.revision_id AND known.message_id = im.message_id
          WHERE im.invocation_id = ${invocationId} AND known.created_at <= ${slice.cutoffAt}
            AND im.section IN ('history', 'new') AND (
            im.section = 'history' OR im.source_bucket_id = ${source.bucketId} OR
            (im.source_bucket_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM invocation_buckets ib WHERE ib.invocation_id = im.invocation_id
                AND ib.bucket_id <> ${source.bucketId}
            )) OR EXISTS (
              SELECT 1 FROM invocation_buckets ib WHERE ib.invocation_id = im.invocation_id
                AND ib.bucket_id = im.source_bucket_id AND ib.injected_at < ${slice.cutoffAt}
            )
          )
        )
        SELECT m.id AS message_id, im.snapshot_json, r.id AS frozen_revision_id,
               m.telegram_message_id, m.telegram_date, m.sent_by_bot,
               r.id AS revision_id, r.kind, r.text, r.caption, r.reply_to_message_id,
               r.reply_snapshot_json, r.forward_origin_json, r.media_group_id,
               s.telegram_id AS sender_telegram_id, s.display_name AS sender_display_name, s.username AS sender_username
        FROM eligible im JOIN messages m ON m.id = im.message_id
        LEFT JOIN message_revisions r ON r.id = im.revision_id AND r.message_id = m.id
        LEFT JOIN senders s ON s.id = r.sender_id
        WHERE m.conversation_id = ${source.conversationId} AND m.visible = 1 AND m.sent_by_bot = 0
          AND m.received_at <= ${slice.cutoffAt}
          AND m.telegram_message_id > ${slice.previousMessageId ?? -1n}
          AND m.telegram_message_id < ${slice.messageId}
          AND m.telegram_message_id > COALESCE(
            (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = ${source.conversationId}), -1)
          AND NOT EXISTS (SELECT 1 FROM eligible newer WHERE newer.message_id = im.message_id
            AND newer.sequence_no > im.sequence_no)
        ORDER BY m.telegram_date DESC, m.telegram_message_id DESC`,
  );
  if (rows.length === 0) {
    throw new SceneSliceError('replay_slice_empty', 'No retained public input exists between these bot messages');
  }
  return [...renderHistoryRows(store, rows, source).newestFirst].reverse();
}

function compareMessages(
  a: Pick<PreparedSnapshot, 'telegram_date' | 'message_id'>,
  b: Pick<PreparedSnapshot, 'telegram_date' | 'message_id'>,
): number {
  if (a.telegram_date !== b.telegram_date) {
    return a.telegram_date < b.telegram_date ? -1 : 1;
  }
  const left = BigInt(a.message_id);
  const right = BigInt(b.message_id);
  return left === right ? 0 : left < right ? -1 : 1;
}

function missingMediaIds(store: SqliteStore, ids: readonly bigint[], revisionId: bigint): ReadonlySet<bigint> {
  if (ids.length === 0) {
    return new Set();
  }
  const present = new Set(
    store.orm
      .select({ id: media.id })
      .from(media)
      .where(and(inArray(media.id, ids), eq(media.revisionId, revisionId)))
      .all()
      .map((row) => row.id),
  );
  return new Set(ids.filter((id) => !present.has(id)));
}

/** Stored JSON that a scene only ever displays: a corrupt copy renders as absent, never crashes. */
function parseStoredJson(json: string | null): unknown {
  if (json === null) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * The runtime block's clock line. `ContextBuilder#renderCurrentTime` is the
 * production twin but stays private; this is the only piece of the injection
 * envelope the scene renders itself.
 */
function renderCurrentTime(timezone: string, now: Date): string {
  return `${new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
    hourCycle: 'h23',
  }).format(now)} (${timezone})`;
}
