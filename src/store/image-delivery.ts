import { sql } from 'drizzle-orm';
import type { Orm } from './database.ts';
import { telegramSends } from './schema.ts';

/** Telegram audit is the delivery ledger, including attempts interrupted by a restart. */
export function imageDeliveryState(orm: Orm, conversationId: bigint, generationId: string) {
  const rows = orm.all<{
    asset_id: string | null;
    state: string;
    telegram_message_id: bigint | null;
    unknown_assets: bigint;
  }>(sql`
    SELECT asset.value AS asset_id, s.state, s.telegram_message_id,
      COALESCE(json_extract(s.request_json, '$.asset_ids_unknown'), 0) AS unknown_assets
    FROM ${telegramSends} s
    LEFT JOIN json_each(s.request_json, '$.asset_ids') asset ON asset.type = 'text'
    WHERE s.conversation_id = ${conversationId} AND s.kind = 'image'
      AND json_extract(s.request_json, '$.generation_id') = ${generationId}
      AND s.state IN ('success', 'pending', 'outcome_unknown')
    ORDER BY s.id
  `);
  const delivered = new Map<string, string>();
  const uncertain = new Set<string>();
  let unknownAssets = false;
  for (const row of rows) {
    if (row.unknown_assets !== 0n || row.asset_id === null) {
      unknownAssets = true;
      continue;
    }
    if (row.state === 'success' && row.telegram_message_id !== null) {
      delivered.set(row.asset_id, row.telegram_message_id.toString());
    } else {
      uncertain.add(row.asset_id);
    }
  }
  return { delivered, uncertain, unknownAssets };
}
