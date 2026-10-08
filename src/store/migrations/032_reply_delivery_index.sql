-- Existing sends already record reply targets. Keep their audit as the ledger,
-- including unresolved attempts; a unique index would reject historical duplicates.
CREATE INDEX telegram_sends_reply_delivery_idx
ON telegram_sends(conversation_id, json_extract(request_json, '$.reply_to_message_id'))
WHERE state IN ('success', 'pending', 'outcome_unknown');
