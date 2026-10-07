import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { adminPublicOrigin } from '../../platform/config.ts';
import { asRunResult, type Orm } from '../../store/database.ts';
import { adminPasskeys, adminUsers } from '../../store/schema.ts';
import { type AdminAuth, AdminAuthError, hashToken } from './auth.ts';

const CHALLENGE_MS = 5 * 60_000;
const MAX_PENDING = 1_000;
const MAX_CLIENT_REQUESTS = 60;
const base64url = Type.String({ minLength: 1, maxLength: 65_536, pattern: '^[A-Za-z0-9_-]+$' });
const transports = Type.Array(
  Type.Union([
    Type.Literal('ble'),
    Type.Literal('cable'),
    Type.Literal('hybrid'),
    Type.Literal('internal'),
    Type.Literal('nfc'),
    Type.Literal('smart-card'),
    Type.Literal('usb'),
  ]),
  { maxItems: 7 },
);
const credentialFields = {
  id: base64url,
  rawId: base64url,
  type: Type.Literal('public-key'),
  clientExtensionResults: Type.Object({}, { additionalProperties: true }),
  authenticatorAttachment: Type.Optional(Type.Union([Type.Literal('platform'), Type.Literal('cross-platform')])),
};
const registrationBody = Compile(
  Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 80 }),
      response: Type.Object(
        {
          ...credentialFields,
          response: Type.Object(
            {
              clientDataJSON: base64url,
              attestationObject: base64url,
              transports: Type.Optional(transports),
              authenticatorData: Type.Optional(base64url),
              publicKey: Type.Optional(base64url),
              publicKeyAlgorithm: Type.Optional(Type.Integer()),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
);
const authenticationBody = Compile(
  Type.Object(
    {
      response: Type.Object(
        {
          ...credentialFields,
          response: Type.Object(
            {
              clientDataJSON: base64url,
              authenticatorData: base64url,
              signature: base64url,
              userHandle: base64url,
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
);

interface Pending {
  readonly challenge: string;
  readonly kind: 'register' | 'login';
  readonly sessionHash: string;
  readonly expires: number;
}

/** Challenges are one-use, bounded, browser-bound, and intentionally lost on restart. */
export class AdminPasskeys {
  readonly origin: string;
  readonly rpId: string;
  readonly #orm: Orm;
  readonly #auth: AdminAuth;
  readonly #pending = new Map<string, Pending>();
  readonly #clients = new Map<string, { count: number; expires: number }>();

  constructor(orm: Orm, auth: AdminAuth, publicUrl: string) {
    this.#orm = orm;
    this.#auth = auth;
    this.origin = adminPublicOrigin(publicUrl);
    this.rpId = new URL(this.origin).hostname;
  }

  checkOrigin(origin: string | null): void {
    // Unlike legacy password endpoints, WebAuthn is browser-only and requires
    // the configured, exact origin; Host/forwarded headers never select the RP.
    if (origin !== this.origin) {
      throw new AdminAuthError(403, 'bad_origin', 'Passkeys require the configured website origin');
    }
  }

  throttle(client: string, now = Date.now()): void {
    for (const [key, value] of this.#clients) {
      if (value.expires <= now) {
        this.#clients.delete(key);
      }
    }
    const value = this.#clients.get(client) ?? { count: 0, expires: now + CHALLENGE_MS };
    if (value.count >= MAX_CLIENT_REQUESTS || (!this.#clients.has(client) && this.#clients.size >= MAX_PENDING)) {
      throw new AdminAuthError(429, 'too_many_attempts', 'Too many passkey requests; retry later');
    }
    value.count += 1;
    this.#clients.set(client, value);
  }

  list(userId: bigint): {
    items: { id: string; name: string; created_at: string; last_used_at: string | null; usable: boolean }[];
    has_password: boolean;
  } {
    return {
      items: this.#orm
        .select()
        .from(adminPasskeys)
        .where(eq(adminPasskeys.userId, userId))
        .all()
        .map((row) => ({
          id: row.id.toString(),
          name: row.name,
          created_at: row.createdAt,
          last_used_at: row.lastUsedAt,
          usable: row.rpId === this.rpId,
        })),
      has_password: this.#auth.hasPassword(userId),
    };
  }

  async registrationOptions(sessionToken: string, previousToken: string) {
    const session = this.#requireSession(sessionToken);
    const user = this.#orm.select().from(adminUsers).where(eq(adminUsers.id, session.userId)).get();
    if (user === undefined) {
      throw new AdminAuthError(401, 'unauthenticated', 'Admin session is required');
    }
    const options = await generateRegistrationOptions({
      rpName: 'Plastic Wan',
      rpID: this.rpId,
      userName: user.username,
      userID: new TextEncoder().encode(user.webauthnUserId),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: this.#orm
        .select({ id: adminPasskeys.credentialId })
        .from(adminPasskeys)
        .where(and(eq(adminPasskeys.userId, user.id), eq(adminPasskeys.rpId, this.rpId)))
        .all(),
    });
    this.#requireSession(sessionToken);
    return { options, token: this.#issue(options.challenge, 'register', sessionToken, previousToken) };
  }

  async register(body: unknown, challengeToken: string, sessionToken: string): Promise<void> {
    const pending = this.#consume(challengeToken, 'register', sessionToken);
    const session = this.#requireSession(sessionToken);
    if (!registrationBody.Check(body) || body.name.trim().length === 0) {
      throw new AdminAuthError(400, 'invalid_body', 'A passkey name and registration response are required');
    }
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    }).catch(() => {
      throw invalidPasskey();
    });
    if (!result.verified || result.registrationInfo === undefined) {
      throw invalidPasskey();
    }
    const { credential } = result.registrationInfo;
    this.#orm.transaction(
      () => {
        // A password change/logout/recovery during verification must not add a
        // credential using the now-revoked authorization.
        this.#requireSession(sessionToken);
        if (
          this.#orm
            .select({ id: adminPasskeys.id })
            .from(adminPasskeys)
            .where(eq(adminPasskeys.credentialId, credential.id))
            .get() !== undefined
        ) {
          throw new AdminAuthError(409, 'passkey_exists', 'This passkey is already registered');
        }
        this.#orm
          .insert(adminPasskeys)
          .values({
            userId: session.userId,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: BigInt(credential.counter),
            rpId: this.rpId,
            name: body.name.trim(),
            createdAt: new Date().toISOString(),
          })
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  async loginOptions(previousToken: string) {
    const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: 'required' });
    return { options, token: this.#issue(options.challenge, 'login', '', previousToken) };
  }

  async login(body: unknown, challengeToken: string): Promise<string> {
    const pending = this.#consume(challengeToken, 'login', '');
    if (!authenticationBody.Check(body)) {
      throw new AdminAuthError(400, 'invalid_body', 'A discoverable passkey authentication response is required');
    }
    const passkey = this.#orm
      .select()
      .from(adminPasskeys)
      .where(and(eq(adminPasskeys.credentialId, body.response.id), eq(adminPasskeys.rpId, this.rpId)))
      .get();
    const user =
      passkey === undefined
        ? undefined
        : this.#orm.select().from(adminUsers).where(eq(adminUsers.id, passkey.userId)).get();
    if (
      passkey === undefined ||
      user === undefined ||
      body.response.response.userHandle !== Buffer.from(user.webauthnUserId).toString('base64url')
    ) {
      throw invalidPasskey();
    }
    const result = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
        counter: Number(passkey.counter),
      },
    }).catch(() => {
      throw invalidPasskey();
    });
    if (!result.verified) {
      throw invalidPasskey();
    }
    return this.#orm.transaction(
      () => {
        // Re-read after async crypto: deleted/recovered credentials and racing
        // assertions cannot resurrect a removed key or roll its counter back.
        const currentUser = this.#orm.select().from(adminUsers).where(eq(adminUsers.id, user.id)).get();
        if (
          currentUser === undefined ||
          currentUser.passwordHash !== user.passwordHash ||
          currentUser.updatedAt !== user.updatedAt
        ) {
          throw invalidPasskey();
        }
        const update = asRunResult(
          this.#orm
            .update(adminPasskeys)
            .set({ counter: BigInt(result.authenticationInfo.newCounter), lastUsedAt: new Date().toISOString() })
            .where(
              and(
                eq(adminPasskeys.id, passkey.id),
                eq(adminPasskeys.credentialId, passkey.credentialId),
                eq(adminPasskeys.publicKey, passkey.publicKey),
                eq(adminPasskeys.counter, passkey.counter),
              ),
            )
            .run(),
        );
        if (update.changes !== 1) {
          throw invalidPasskey();
        }
        return this.#auth.createPasskeySession(user.id);
      },
      { behavior: 'immediate' },
    );
  }

  remove(userId: bigint, id: bigint): void {
    this.#orm.transaction(
      () => {
        const keys = this.#orm.select().from(adminPasskeys).where(eq(adminPasskeys.userId, userId)).all();
        if (!keys.some((key) => key.id === id)) {
          throw new AdminAuthError(404, 'not_found', 'Passkey does not exist');
        }
        if (!this.#auth.hasPassword(userId) && !keys.some((key) => key.id !== id && key.rpId === this.rpId)) {
          throw new AdminAuthError(
            409,
            'password_required',
            'Set a login password before removing the last usable passkey',
          );
        }
        this.#orm
          .delete(adminPasskeys)
          .where(and(eq(adminPasskeys.id, id), eq(adminPasskeys.userId, userId)))
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  #requireSession(token: string) {
    const session = this.#auth.authenticate(token);
    if (session === null) {
      throw new AdminAuthError(401, 'unauthenticated', 'Admin session is required');
    }
    return session;
  }

  #issue(challenge: string, kind: Pending['kind'], sessionToken: string, previousToken: string): string {
    const now = Date.now();
    for (const [key, value] of this.#pending) {
      if (value.expires <= now) {
        this.#pending.delete(key);
      }
    }
    this.#pending.delete(hashToken(previousToken));
    if (this.#pending.size >= MAX_PENDING) {
      throw new AdminAuthError(429, 'too_many_attempts', 'Too many pending passkey requests; retry later');
    }
    const token = randomBytes(32).toString('base64url');
    this.#pending.set(hashToken(token), {
      challenge,
      kind,
      sessionHash: hashToken(sessionToken),
      expires: now + CHALLENGE_MS,
    });
    return token;
  }

  #consume(token: string, kind: Pending['kind'], sessionToken: string): Pending {
    const key = hashToken(token);
    const pending = this.#pending.get(key);
    this.#pending.delete(key);
    if (
      pending === undefined ||
      pending.expires <= Date.now() ||
      pending.kind !== kind ||
      pending.sessionHash !== hashToken(sessionToken)
    ) {
      throw new AdminAuthError(400, 'invalid_challenge', 'Passkey request expired or was already used; start again');
    }
    return pending;
  }
}

function invalidPasskey(): AdminAuthError {
  // Authenticator payloads and library error details never enter logs/responses.
  return new AdminAuthError(401, 'invalid_passkey', 'Passkey verification failed');
}
