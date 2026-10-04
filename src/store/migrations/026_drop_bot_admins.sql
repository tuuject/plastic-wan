-- The bot admin whitelist moved into the `telegram.admins` config field, which
-- is the single source of truth and hot-appliable (see config-diff.ts). Existing
-- rows must be migrated with scripts/migrate-admins.ts before starting this
-- version; the table itself is dropped here.
DROP TABLE bot_admins;
