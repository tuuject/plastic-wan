import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { RawConfig } from '../platform/config.ts';
import type { Orm } from './database.ts';
import { promptVersions } from './schema.ts';

/** How many versions each scope keeps; older rows are pruned by `seq`. */
export const PROMPT_VERSIONS_RETAINED = 100n;

export type PromptScope = 'global' | 'group';
export type PromptVersionSource = 'panel' | 'external' | 'rollback';

/** One `prompt_versions` row as drizzle reads it. */
export type PromptVersionRecord = typeof promptVersions.$inferSelect;

export function hashPromptContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function latestPromptVersion(orm: Orm, scope: PromptScope, chatId: bigint): PromptVersionRecord | undefined {
  return orm
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.scope, scope), eq(promptVersions.chatId, chatId)))
    .orderBy(desc(promptVersions.seq))
    .limit(1)
    .get();
}

export function listPromptVersions(orm: Orm, scope: PromptScope, chatId: bigint): PromptVersionRecord[] {
  return orm
    .select()
    .from(promptVersions)
    .where(and(eq(promptVersions.scope, scope), eq(promptVersions.chatId, chatId)))
    .orderBy(desc(promptVersions.seq))
    .all();
}

export function getPromptVersion(orm: Orm, id: bigint): PromptVersionRecord | undefined {
  return orm.select().from(promptVersions).where(eq(promptVersions.id, id)).get();
}

/**
 * Records one prompt version unless the scope's latest version already carries
 * the same content: a save that changes nothing keeps the history readable.
 * Returns the inserted row, or `null` when the content was deduplicated away.
 */
export function recordPromptVersion(
  orm: Orm,
  scope: PromptScope,
  chatId: bigint,
  content: string,
  source: PromptVersionSource,
  note: string | undefined,
  createdBy: string | undefined,
  now = new Date(),
): PromptVersionRecord | null {
  const latest = latestPromptVersion(orm, scope, chatId);
  if (latest !== undefined && latest.content === content) {
    return null;
  }
  const inserted = orm
    .insert(promptVersions)
    .values({
      scope,
      chatId,
      seq: (latest?.seq ?? 0n) + 1n,
      content,
      contentHash: hashPromptContent(content),
      source,
      note: note ?? null,
      createdBy: createdBy ?? null,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
  if (inserted === undefined) {
    throw new Error('prompt_versions insert returned no row');
  }
  orm.run(sql`DELETE FROM prompt_versions
    WHERE scope = ${scope} AND chat_id = ${chatId}
      AND seq <= (SELECT MAX(seq) FROM prompt_versions WHERE scope = ${scope} AND chat_id = ${chatId}) - ${PROMPT_VERSIONS_RETAINED}`);
  return inserted;
}

/**
 * Records prompt content that reached the process from outside the panel: the
 * startup load and every successful config apply land here, so a hand-edited
 * prompt file becomes a version the moment the process can see it. Content
 * equal to the scope's latest version records nothing.
 */
export function recordPromptVersionsFromConfig(orm: Orm, config: RawConfig, now = new Date()): void {
  recordPromptVersion(orm, 'global', 0n, config.agent.system_prompt, 'external', undefined, undefined, now);
  for (const chat of config.telegram.chats) {
    const chatId = BigInt(chat.id);
    if (chat.instructions.length === 0 && latestPromptVersion(orm, 'group', chatId) === undefined) {
      // A chat that never had a group prompt has no starting state to record.
      continue;
    }
    recordPromptVersion(orm, 'group', chatId, chat.instructions, 'external', undefined, undefined, now);
  }
}
