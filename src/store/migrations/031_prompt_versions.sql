-- Version history for the editable prompt layers: the global persona prompt
-- (`agent.system_prompt_file`) and each configured Chat's group instructions
-- (`telegram.chats[].instructions_file`). One row per recorded content change:
-- panel saves, restores, and prompt-file edits picked up at startup or on an
-- explicit config apply. The stored content is the comment-stripped template
-- the model sees, exactly what the admin editor edits.
--
-- Rows are pruned per scope by seq (see src/store/prompt-versions.ts), never
-- by the online retention window: prompt history is configuration, not
-- conversation data. chat_id is 0 for the global scope and the configured
-- Chat ID for the group scope; the CHECK keeps the pair consistent so the
-- (scope, chat_id, seq) unique index also enforces global uniqueness (SQLite
-- treats NULLs as distinct inside unique indexes).
CREATE TABLE prompt_versions (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  chat_id INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (scope IN ('global', 'group')),
  CHECK ((scope = 'global' AND chat_id = 0) OR (scope = 'group' AND chat_id <> 0)),
  CHECK (source IN ('panel', 'external', 'rollback')),
  CHECK (seq > 0)
) STRICT;
CREATE UNIQUE INDEX prompt_versions_scope_seq_unique ON prompt_versions(scope, chat_id, seq);
