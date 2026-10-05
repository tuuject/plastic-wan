import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { asRunResult, type Orm } from '../../store/database.ts';
import { adminApiKeys } from '../../store/schema.ts';
import { AdminQueryError } from './audit.ts';
import { hashToken } from './auth.ts';

/**
 * Programmatic Admin API keys.
 *
 * A key is `pwk_` plus 32 random bytes (256-bit) rendered as base64url. The
 * database stores only the SHA-256 digest, so the plaintext is recoverable
 * exactly once, from the create response. Keys are disabled permanently by
 * setting `revoked_at`; the row is kept so the panel can still show what was
 * issued and when it was last used.
 */
export const API_KEY_PREFIX = 'pwk_';
const API_KEY_BYTES = 32;
/** Display prefix length: `pwk_` plus the first 8 base64url characters. */
const PREFIX_DISPLAY_LENGTH = 12;
const MAX_NAME_LENGTH = 80;

const createApiKeyBodyValidator = Compile(
  Type.Object({ name: Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH }) }, { additionalProperties: false }),
);

export interface AdminApiKeyItem {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export interface CreatedAdminApiKey {
  /** Plaintext key; the only copy that will ever exist outside the caller. */
  readonly key: string;
  readonly item: AdminApiKeyItem;
}

const API_KEY_FIELDS = {
  id: adminApiKeys.id,
  name: adminApiKeys.name,
  prefix: adminApiKeys.prefix,
  createdAt: adminApiKeys.createdAt,
  lastUsedAt: adminApiKeys.lastUsedAt,
  revokedAt: adminApiKeys.revokedAt,
} as const;

interface ApiKeyRow {
  readonly id: bigint;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export function createApiKey(orm: Orm, name: string, now = new Date()): CreatedAdminApiKey {
  const token = `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString('base64url')}`;
  const row = orm
    .insert(adminApiKeys)
    .values({
      name,
      prefix: token.slice(0, PREFIX_DISPLAY_LENGTH),
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
    })
    .returning(API_KEY_FIELDS)
    .get();
  if (row === undefined) {
    throw new Error('admin_api_keys insert returned no row');
  }
  return { key: token, item: toItem(row) };
}

export function listApiKeys(orm: Orm): readonly AdminApiKeyItem[] {
  return orm.select(API_KEY_FIELDS).from(adminApiKeys).orderBy(desc(adminApiKeys.id)).all().map(toItem);
}

/** Revokes an active key; revoking twice is a not-found error, not a no-op. */
export function revokeApiKey(orm: Orm, id: bigint, now = new Date()): void {
  const result = asRunResult(
    orm
      .update(adminApiKeys)
      .set({ revokedAt: now.toISOString() })
      .where(and(eq(adminApiKeys.id, id), isNull(adminApiKeys.revokedAt)))
      .run(),
  );
  if (result.changes === 0) {
    throw new AdminQueryError('not_found', 'API key does not exist', 404);
  }
}

/**
 * Resolves a plaintext key to its row and records usage. Returns `null` for an
 * unknown, revoked, or malformed key — callers must answer with the same fixed
 * failure either way.
 */
export function authenticateApiKey(orm: Orm, token: string, now = new Date()): { readonly id: bigint } | null {
  if (token.length === 0) {
    return null;
  }
  const row = orm
    .select({ id: adminApiKeys.id, revokedAt: adminApiKeys.revokedAt })
    .from(adminApiKeys)
    .where(eq(adminApiKeys.tokenHash, hashToken(token)))
    .get();
  if (row === undefined || row.revokedAt !== null) {
    return null;
  }
  orm.update(adminApiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(adminApiKeys.id, row.id)).run();
  return { id: row.id };
}

export function parseCreateApiKeyBody(value: unknown): string {
  if (!createApiKeyBodyValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', `name must be a string of 1-${MAX_NAME_LENGTH} characters`);
  }
  return (value as { name: string }).name;
}

function toItem(row: ApiKeyRow): AdminApiKeyItem {
  return {
    id: row.id.toString(),
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
  };
}
