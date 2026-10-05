-- Keep deduplication on the existing Telegram audit ledger, not a second outbox.
CREATE INDEX telegram_sends_image_delivery_idx
ON telegram_sends(conversation_id, json_extract(request_json, '$.generation_id'))
WHERE kind = 'image';

-- Older sends shipped every available output but recorded only their count.
-- Infer only assets that existed before the attempt, never later retry outputs.
-- A count mismatch cannot prove which assets went out: retain that uncertainty
-- explicitly so an upgrade cannot silently authorize a duplicate delivery.
WITH deliveries AS (
  SELECT s.id, (
    SELECT json_group_array(a.id)
    FROM image_assets a
    WHERE a.generation_id = json_extract(s.request_json, '$.generation_id')
      AND a.created_at <= s.created_at
  ) AS asset_ids
  FROM telegram_sends s
  WHERE s.kind = 'image' AND json_type(s.request_json, '$.asset_ids') IS NULL
)
UPDATE telegram_sends
SET request_json = json_set(
  request_json,
  '$.asset_ids', json(d.asset_ids),
  '$.asset_ids_inferred', json('true'),
  '$.asset_ids_unknown', json(CASE
    WHEN json_array_length(d.asset_ids) = json_extract(request_json, '$.pictures') THEN 'false'
    ELSE 'true'
  END)
)
FROM deliveries d
WHERE telegram_sends.id = d.id;
