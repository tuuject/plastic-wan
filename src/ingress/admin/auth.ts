import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { asRunResult, type Orm } from '../../store/database.ts';
import { adminPasskeys, adminSessions, adminUsers } from '../../store/schema.ts';

const SESSION_TOKEN_BYTES = 32;
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60_000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
// Bounds for the unauthenticated paths. Failures are tracked per client, the
// map is swept and capped, and at most this many 64 MiB Argon2 jobs run for
// login and setup at once; the rest are turned away instead of queued.
const MAX_TRACKED_CLIENTS = 1_000;
const MAX_CONCURRENT_HASHES = 2;
// The runtime defaults to Argon2id; the explicit cost parameters keep the
// strength of the Bun.password defaults this project was built on (64 MiB
// memory), where @node-rs/argon2 would otherwise drop to its 19 MiB default.
// Stored PHC strings carry their own parameters, so hashes created before
// the switch verify either way.
const HASH_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface AdminCredentials {
  readonly username: string;
  readonly password: string;
}

export interface AdminSession {
  readonly userId: bigint;
  readonly username: string;
  readonly expiresAt: string;
}

export class AdminAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface UserRow {
  readonly id: bigint;
  readonly passwordHash: string | null;
}

interface SessionRow {
  readonly id: bigint;
  readonly userId: bigint;
  readonly username: string;
  readonly expiresAt: string;
}

export class AdminAuth {
  readonly #orm: Orm;
  readonly #ttlMs: number;
  // Insertion order is recency order: a failure re-inserts its entry.
  readonly #failures = new Map<string, { count: number; lastAt: number; lockedUntil: number }>();
  #hashing = 0;

  constructor(orm: Orm, sessionTtlHours: number) {
    this.#orm = orm;
    this.#ttlMs = sessionTtlHours * 3_600_000;
  }

  setupRequired(): boolean {
    const row = this.#orm.select({ count: sql<bigint>`count(*)` }).from(adminUsers).get();
    return (row?.count ?? 0n) === 0n;
  }

  async createFirstUser(credentials: AdminCredentials, now = new Date()): Promise<string> {
    assertCredentials(credentials);
    // Checked before hashing so a finished setup endpoint cannot be used to burn
    // Argon2 work; the transaction below still settles a race between two setups.
    if (!this.setupRequired()) {
      throw new AdminAuthError(409, 'setup_complete', 'Administrator account already exists');
    }
    const passwordHash = await this.#withHashSlot(() => hash(credentials.password, HASH_OPTIONS));
    const iso = now.toISOString();
    const userId = this.#orm.transaction(
      () => {
        if (!this.setupRequired()) {
          throw new AdminAuthError(409, 'setup_complete', 'Administrator account already exists');
        }
        const created = this.#orm
          .insert(adminUsers)
          .values({
            username: credentials.username,
            passwordHash,
            createdAt: iso,
            updatedAt: iso,
            lastLoginAt: iso,
          })
          .returning({ id: adminUsers.id })
          .get();
        if (created === undefined) {
          throw new Error('admin_users insert returned no row');
        }
        return created.id;
      },
      { behavior: 'immediate' },
    );
    return this.#createSession(userId, now);
  }
  async changeCredentials(userId: bigint, credentials: AdminCredentials, now = new Date()): Promise<string> {
    assertCredentials(credentials);
    const passwordHash = await this.#withHashSlot(() => hash(credentials.password, HASH_OPTIONS));
    const iso = now.toISOString();
    return this.#orm.transaction(
      () => {
        const existing = this.#orm
          .select({ id: adminUsers.id })
          .from(adminUsers)
          .where(eq(adminUsers.username, credentials.username))
          .get();
        if (existing !== undefined && existing.id !== userId) {
          throw new AdminAuthError(409, 'username_taken', 'Username is already in use');
        }
        const updated = asRunResult(
          this.#orm
            .update(adminUsers)
            .set({ username: credentials.username, passwordHash, updatedAt: iso })
            .where(eq(adminUsers.id, userId))
            .run(),
        );
        if (updated.changes === 0) {
          throw new AdminAuthError(401, 'unauthenticated', 'Admin session is required');
        }
        this.#orm.delete(adminSessions).where(eq(adminSessions.userId, userId)).run();
        return this.#createSession(userId, now);
      },
      { behavior: 'immediate' },
    );
  }

  /**
   * `clientKey` is the transport address of the caller. Failures are counted per
   * client, not per username, so rotating usernames does not reset the lockout.
   */
  async login(credentials: AdminCredentials, now = new Date(), clientKey = 'unknown'): Promise<string> {
    const username = typeof credentials.username === 'string' ? credentials.username : '';
    const password = typeof credentials.password === 'string' ? credentials.password : '';
    const nowMs = now.getTime();
    this.#sweepFailures(nowMs);
    const failure = this.#failures.get(clientKey);
    if (failure !== undefined && failure.lockedUntil > nowMs) {
      throw new AdminAuthError(429, 'too_many_attempts', 'Too many failed attempts; retry later');
    }
    // No stored account can match input outside these bounds, so it is refused
    // without spending a hash on it.
    if (!USERNAME_PATTERN.test(username) || password.length > MAX_PASSWORD_LENGTH) {
      this.#recordFailure(clientKey, nowMs);
      throw new AdminAuthError(401, 'invalid_credentials', 'Invalid username or password');
    }
    const row = this.#orm
      .select({ id: adminUsers.id, passwordHash: adminUsers.passwordHash })
      .from(adminUsers)
      .where(eq(adminUsers.username, username))
      .get() satisfies UserRow | undefined;
    const verified = await this.#withHashSlot(async () => {
      // Counted before the slow verification, so concurrent failures all count
      // instead of each overwriting the same snapshot.
      this.#recordFailure(clientKey, nowMs);
      if (row === undefined || row.passwordHash === null) {
        // Burn comparable time on unknown usernames so response latency does not leak account existence.
        await hash(password.length === 0 ? 'absent-account-placeholder' : password, HASH_OPTIONS);
        return false;
      }
      return verify(row.passwordHash, password);
    });
    if (row === undefined || !verified) {
      throw new AdminAuthError(401, 'invalid_credentials', 'Invalid username or password');
    }
    this.#failures.delete(clientKey);
    return this.#orm.transaction(
      () => {
        // The password may have changed while it was being verified; a change
        // revokes every session, so a login checked against the old hash must
        // not create a new one.
        const current = this.#orm
          .select({ passwordHash: adminUsers.passwordHash })
          .from(adminUsers)
          .where(eq(adminUsers.id, row.id))
          .get();
        if (current?.passwordHash !== row.passwordHash) {
          throw new AdminAuthError(401, 'invalid_credentials', 'Invalid username or password');
        }
        this.#orm
          .update(adminUsers)
          .set({ lastLoginAt: now.toISOString(), updatedAt: now.toISOString() })
          .where(eq(adminUsers.id, row.id))
          .run();
        return this.#createSession(row.id, now);
      },
      { behavior: 'immediate' },
    );
  }

  hasPassword(userId: bigint): boolean {
    const user = this.#orm.select().from(adminUsers).where(eq(adminUsers.id, userId)).get();
    if (user === undefined) {
      throw new AdminAuthError(401, 'unauthenticated', 'Admin session is required');
    }
    return user.passwordHash !== null;
  }

  removePassword(userId: bigint, rpId: string, now = new Date()): string {
    return this.#orm.transaction(
      () => {
        this.hasPassword(userId);
        const passkey = this.#orm
          .select({ id: adminPasskeys.id })
          .from(adminPasskeys)
          .where(and(eq(adminPasskeys.userId, userId), eq(adminPasskeys.rpId, rpId)))
          .get();
        if (passkey === undefined) {
          throw new AdminAuthError(
            409,
            'passkey_required',
            'Add a passkey for this website before removing the password',
          );
        }
        this.#orm
          .update(adminUsers)
          .set({ passwordHash: null, updatedAt: now.toISOString() })
          .where(eq(adminUsers.id, userId))
          .run();
        this.#orm.delete(adminSessions).where(eq(adminSessions.userId, userId)).run();
        return this.#createSession(userId, now);
      },
      { behavior: 'immediate' },
    );
  }

  /** Local, offline recovery: never reopens the unauthenticated setup endpoint. */
  async recoverCredentials(credentials: AdminCredentials, now = new Date()): Promise<void> {
    assertCredentials(credentials);
    const user = this.#orm
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.username, credentials.username))
      .get();
    if (user === undefined) {
      throw new AdminAuthError(404, 'admin_not_found', 'Administrator account does not exist');
    }
    const passwordHash = await this.#withHashSlot(() => hash(credentials.password, HASH_OPTIONS));
    this.#orm.transaction(
      () => {
        const updated = asRunResult(
          this.#orm
            .update(adminUsers)
            .set({ passwordHash, updatedAt: now.toISOString() })
            .where(and(eq(adminUsers.id, user.id), eq(adminUsers.username, credentials.username)))
            .run(),
        );
        if (updated.changes !== 1) {
          throw new AdminAuthError(409, 'credentials_changed', 'Administrator account changed during recovery');
        }
        this.#orm.delete(adminPasskeys).where(eq(adminPasskeys.userId, user.id)).run();
        this.#orm.delete(adminSessions).where(eq(adminSessions.userId, user.id)).run();
      },
      { behavior: 'immediate' },
    );
  }

  /** Called only inside the passkey verification transaction. */
  createPasskeySession(userId: bigint, now = new Date()): string {
    this.#orm.update(adminUsers).set({ lastLoginAt: now.toISOString() }).where(eq(adminUsers.id, userId)).run();
    return this.#createSession(userId, now);
  }

  async #withHashSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#hashing >= MAX_CONCURRENT_HASHES) {
      throw new AdminAuthError(429, 'too_many_attempts', 'Too many concurrent sign-in attempts; retry later');
    }
    this.#hashing += 1;
    try {
      return await work();
    } finally {
      this.#hashing -= 1;
    }
  }

  #recordFailure(clientKey: string, nowMs: number): void {
    const count = (this.#failures.get(clientKey)?.count ?? 0) + 1;
    this.#failures.delete(clientKey);
    this.#failures.set(clientKey, {
      count,
      lastAt: nowMs,
      lockedUntil: count >= MAX_FAILED_ATTEMPTS ? nowMs + LOCKOUT_MS : 0,
    });
    while (this.#failures.size > MAX_TRACKED_CLIENTS) {
      const oldest = this.#failures.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#failures.delete(oldest);
    }
  }

  /** Forgets expired lockouts and failures older than one lockout window. */
  #sweepFailures(nowMs: number): void {
    for (const [key, entry] of this.#failures) {
      if (Math.max(entry.lastAt + LOCKOUT_MS, entry.lockedUntil) <= nowMs) {
        this.#failures.delete(key);
      }
    }
  }

  authenticate(token: string, now = new Date()): AdminSession | null {
    if (token.length === 0) {
      return null;
    }
    const row = this.#orm
      .select({
        id: adminSessions.id,
        userId: adminSessions.userId,
        username: adminUsers.username,
        expiresAt: adminSessions.expiresAt,
      })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
      .where(eq(adminSessions.tokenHash, hashToken(token)))
      .get() satisfies SessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.expiresAt <= now.toISOString()) {
      this.#orm.delete(adminSessions).where(eq(adminSessions.id, row.id)).run();
      return null;
    }
    this.#orm.update(adminSessions).set({ lastSeenAt: now.toISOString() }).where(eq(adminSessions.id, row.id)).run();
    return { userId: row.userId, username: row.username, expiresAt: row.expiresAt };
  }

  logout(token: string): void {
    if (token.length === 0) {
      return;
    }
    this.#orm
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, hashToken(token)))
      .run();
  }

  purgeExpired(now = new Date()): void {
    this.#orm.run(sql`DELETE FROM admin_sessions WHERE expires_at <= ${now.toISOString()}`);
  }

  get sessionTtlMs(): number {
    return this.#ttlMs;
  }

  #createSession(userId: bigint, now: Date): string {
    this.purgeExpired(now);
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const iso = now.toISOString();
    this.#orm
      .insert(adminSessions)
      .values({
        userId,
        tokenHash: hashToken(token),
        createdAt: iso,
        expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
        lastSeenAt: iso,
      })
      .run();
    return token;
  }
}

function assertCredentials(credentials: AdminCredentials): void {
  if (typeof credentials.username !== 'string' || !USERNAME_PATTERN.test(credentials.username)) {
    throw new AdminAuthError(
      400,
      'invalid_username',
      'Username must be 3-32 characters of letters, digits, dot, underscore, or hyphen',
    );
  }
  if (
    typeof credentials.password !== 'string' ||
    credentials.password.length < MIN_PASSWORD_LENGTH ||
    credentials.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new AdminAuthError(
      400,
      'invalid_password',
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

/** Digest stored for session tokens and API keys; plaintext is never persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
