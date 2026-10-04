import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/platform/config.ts';
import { writeConfigEdits } from '../src/platform/config-file.ts';

/**
 * One-off: moves the bot admin whitelist out of the dropped `bot_admins` table
 * into the `telegram.admins` config field. Nothing else in the repository uses
 * this file; delete it once every environment has been migrated.
 *
 *   node scripts/migrate-admins.ts --config dev-data/config.jsonc
 *
 * Run it BEFORE starting a build that ships migration 026: that migration drops
 * `bot_admins` on startup, so the panel-added and self-enrolled rows only exist
 * until then (the automatic pre-migration backup is the last resort after that).
 * `paths.database` is resolved exactly like `serve` resolves it: relative values
 * follow the current working directory, so run this from the same directory as
 * `serve`. The write goes through `writeConfigEdits`, so the file must already
 * be mode 0600 in a 0700 directory; comments and formatting are kept, the
 * result is validated before it replaces the file, and only IDs are printed,
 * never file text. Running it again on a migrated file changes nothing.
 *
 * The Docker image does not ship `scripts/`: run it from a checkout with the
 * container's working directory layout before starting a new image.
 */

function parseConfigPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || argv[1] === undefined || argv[1].length === 0) {
    throw new Error('Usage: node scripts/migrate-admins.ts --config <path>');
  }
  return resolve(argv[1]);
}

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const loaded = await loadConfig(configPath);

  const databasePath = resolve(loaded.config.paths.database);
  if ((await stat(databasePath).catch(() => undefined)) === undefined) {
    // `serve` never ran against this config, so there is no whitelist to move.
    console.log(
      JSON.stringify({
        status: 'ok',
        config: configPath,
        database: databasePath,
        moved: [],
        note: 'database does not exist; nothing to migrate',
      }),
    );
    return;
  }

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  database.defaultSafeIntegers(true);
  let stored: number[];
  try {
    const table = database
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_admins'")
      .get();
    if (table === undefined) {
      // The table is gone already: either migrated or a database that never had it.
      stored = [];
    } else {
      stored = database
        .prepare<[], { telegram_user_id: bigint }>('SELECT telegram_user_id FROM bot_admins')
        .all()
        .map((row) => {
          // The config schema only accepts safe integers; refuse to lose
          // precision instead of silently writing a wrong ID.
          if (row.telegram_user_id > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`bot_admins row ${row.telegram_user_id} exceeds the config's safe integer range`);
          }
          return Number(row.telegram_user_id);
        });
    }
  } finally {
    database.close();
  }

  const configured = loaded.config.telegram.admins ?? [];
  const moved = stored.filter((id) => !configured.includes(id)).map(String);
  if (moved.length === 0) {
    console.log(JSON.stringify({ status: 'ok', config: configPath, database: databasePath, moved }));
    return;
  }
  const merged = [...new Set([...configured, ...stored])].sort((left, right) => left - right);
  await writeConfigEdits(configPath, [{ path: ['telegram', 'admins'], value: merged }]);
  console.log(JSON.stringify({ status: 'ok', config: configPath, database: databasePath, moved }));
}

main().catch((error: unknown) => {
  // A failed write reports paths and validation messages, never the file text.
  console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
