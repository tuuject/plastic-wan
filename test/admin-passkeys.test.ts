import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { createApiKey } from '../src/ingress/admin/api-keys.ts';
import { AdminAuth } from '../src/ingress/admin/auth.ts';
import { AdminPasskeys } from '../src/ingress/admin/passkeys.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { adminPublicOrigin, loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { adminPasskeys, adminUsers } from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const origin = 'https://example.com';
const password = 'fixture-correct-horse';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-passkeys-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        ...(enabled ? { public_url: origin } : {}),
      };
    }),
  );
  const loaded = await loadConfig(path);
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const server = new AdminServer({ store, configStore: await testConfigStore(loaded) });
  const auth = new AdminAuth(store.orm, 12);
  const token = await auth.createFirstUser({ username: 'owner', password });
  const session = auth.authenticate(token)!;
  const cookie = `plasticwan_admin=${token}`;
  return { store, server, auth, token, session, cookie };
}

function cookie(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
}
function req(path: string, method = 'POST', cookies = '', body: unknown = {}, source: string | null = origin) {
  return new Request(`http://127.0.0.1:8899/api/auth/${path}`, {
    method,
    headers: { cookie: cookies, ...(source === null ? {} : { origin: source }), 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}
function key() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  );
  return { ...pair, publicKey, id: randomBytes(32).toString('base64url') };
}
function clientData(type: string, challenge: string, clientOrigin = origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin: clientOrigin, crossOrigin: false }));
}
function authData(flags: number, counter: number, rpId = 'example.com') {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), count]);
}
function registration(
  k: ReturnType<typeof key>,
  challenge: string,
  overrides: { origin?: string; rp?: string; flags?: number } = {},
) {
  const id = Buffer.from(k.id, 'base64url');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const data = Buffer.concat([
    authData(overrides.flags ?? 0x45, 0, overrides.rp),
    Buffer.alloc(16),
    length,
    id,
    k.publicKey,
  ]);
  return {
    id: k.id,
    rawId: k.id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData('webauthn.create', challenge, overrides.origin).toString('base64url'),
      attestationObject: Buffer.from(
        isoCBOR.encode(
          new Map<string, string | Uint8Array | Map<string, string>>([
            ['fmt', 'none'],
            ['authData', new Uint8Array(data)],
            ['attStmt', new Map()],
          ]),
        ),
      ).toString('base64url'),
      transports: ['internal'],
    },
  };
}
function assertion(
  k: ReturnType<typeof key>,
  challenge: string,
  userHandle: string,
  counter: number,
  overrides: { origin?: string; rp?: string; flags?: number } = {},
) {
  const client = clientData('webauthn.get', challenge, overrides.origin);
  const data = authData(overrides.flags ?? 5, counter, overrides.rp);
  return {
    id: k.id,
    rawId: k.id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: client.toString('base64url'),
      authenticatorData: data.toString('base64url'),
      userHandle,
      signature: sign(
        'sha256',
        Buffer.concat([data, createHash('sha256').update(client).digest()]),
        k.privateKey,
      ).toString('base64url'),
    },
  };
}
async function register(f: Awaited<ReturnType<typeof fixture>>, k = key(), name = 'My passkey') {
  const response = await f.server.handle(req('passkeys/register/options', 'POST', f.cookie));
  expect(response.status).toBe(200);
  const options: any = await response.json();
  expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  const result = await f.server.handle(
    req('passkeys/register/verify', 'POST', `${f.cookie}; ${cookie(response)}`, {
      name,
      response: registration(k, options.challenge),
    }),
  );
  expect(result.status).toBe(200);
  return { k, userHandle: options.user.id };
}

test('public URL is opt-in and validates secure canonical origins', async () => {
  for (const value of [
    'https://example.com',
    'https://example.com/',
    'https://example.com:8443',
    'http://localhost:1234',
  ]) {
    expect(adminPublicOrigin(value)).toBe(new URL(value).origin);
  }
  for (const value of [
    'http://127.0.0.1:1234',
    'https://127.0.0.1',
    'https://192.0.2.1',
    'http://[::1]:1234',
    'https://[::1]',
    'https://[2001:db8::1]',
    'http://example.com',
    'ftp://example.com',
    'https://a:b@example.com',
    'https://example.com/path',
    'https://example.com?q=x',
    'https://example.com/#x',
    'bad',
    ' https://example.com',
    'https://example.com/?',
    'https://example.com/#',
  ]) {
    expect(() => adminPublicOrigin(value)).toThrow('admin.public_url');
  }
  const f = await fixture(false);
  expect(await (await f.server.handle(req('session', 'GET', f.cookie))).json()).toMatchObject({
    passkeys_enabled: false,
    has_password: true,
  });
  expect((await f.server.handle(req('passkeys/login/options', 'POST', '', {}, 'http://127.0.0.1:8899'))).status).toBe(
    404,
  );
  expect((await f.server.handle(req('password', 'DELETE', f.cookie, {}, 'http://127.0.0.1:8899'))).status).toBe(404);
});

test('real registration/assertion, multi-passkey lifecycle, password deletion and restoration', async () => {
  const f = await fixture();
  expect((await f.server.handle(req('password', 'DELETE', f.cookie))).status).toBe(409);
  const first = await register(f);
  await register(f, key(), 'Backup');
  const list: any = await (await f.server.handle(req('passkeys', 'GET', f.cookie))).json();
  expect(list.items).toHaveLength(2);
  expect(list.items.every((item: { usable: boolean }) => item.usable)).toBe(true);
  expect(JSON.stringify(list)).not.toContain('publicKey');
  const removed = await f.server.handle(req('password', 'DELETE', f.cookie));
  expect(removed.status).toBe(200);
  expect(f.auth.authenticate(f.token)).toBeNull();
  f.cookie = cookie(removed);
  await expect(f.auth.login({ username: 'owner', password })).rejects.toMatchObject({ code: 'invalid_credentials' });
  expect((await f.server.handle(req(`passkeys/${list.items[0].id}`, 'DELETE', f.cookie))).status).toBe(200);
  expect((await f.server.handle(req(`passkeys/${list.items[1].id}`, 'DELETE', f.cookie))).status).toBe(409);
  const restored = await f.server.handle(req('credentials', 'POST', f.cookie, { username: 'owner', password }));
  expect(restored.status).toBe(200);
  f.cookie = cookie(restored);
  expect((await f.server.handle(req(`passkeys/${list.items[1].id}`, 'DELETE', f.cookie))).status).toBe(200);
  expect(f.store.orm.select().from(adminPasskeys).all()).toHaveLength(0);
  // Register again, then sign in without a username or password.
  const active = await register(f, first.k);
  const options = await f.server.handle(req('passkeys/login/options'));
  const body: any = await options.json();
  expect(body.allowCredentials ?? []).toEqual([]);
  const verify = req('passkeys/login/verify', 'POST', cookie(options), {
    response: assertion(active.k, body.challenge, active.userHandle, 1),
  });
  const logged = await f.server.handle(verify.clone());
  expect(logged.status).toBe(200);
  expect(await (await f.server.handle(req('session', 'GET', cookie(logged)))).json()).toMatchObject({
    authenticated: true,
    username: 'owner',
  });
  expect((await f.server.handle(verify)).status).toBe(400);
  expect(f.store.orm.select().from(adminPasskeys).get()?.counter).toBe(1n);
});

test('enforces configured origin, session-only management, bearer exclusion and bounded bodies', async () => {
  const f = await fixture();
  for (const source of [null, 'https://evil.test', 'http://example.com', 'https://example.com:8443']) {
    expect((await f.server.handle(req('passkeys/login/options', 'POST', '', {}, source))).status).toBe(403);
  }
  for (const path of ['setup', 'login', 'passkeys/login/options']) {
    const rejected = await f.server.handle(req(path, 'POST', '', {}, 'https://example.com:8443'));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      error: 'bad_origin',
      message: expect.stringContaining('admin.public_url'),
    });
  }
  expect((await f.server.handle(req('passkeys/register/options'))).status).toBe(401);
  const apiKey = createApiKey(f.store.orm, 'fixture');
  const bearer = req('passkeys/register/options', 'POST', f.cookie);
  bearer.headers.set('authorization', `Bearer ${apiKey.key}`);
  expect((await f.server.handle(bearer)).status).toBe(403);
  const oversized = req('passkeys/login/verify', 'POST', '', { junk: 'x'.repeat(70_000) });
  expect((await f.server.handle(oversized)).status).toBe(413);
});

test('rejects forged, wrong-origin/RP/UV, expired, mismatched-session and reused challenges', async () => {
  const f = await fixture();
  const active = await register(f);
  for (const overrides of [{ origin: 'https://evil.test' }, { rp: 'evil.test' }, { flags: 1 }]) {
    const options = await f.server.handle(req('passkeys/login/options'));
    const body: any = await options.json();
    const result = await f.server.handle(
      req('passkeys/login/verify', 'POST', cookie(options), {
        response: assertion(active.k, body.challenge, active.userHandle, 1, overrides),
      }),
    );
    expect(result.status).toBe(401);
  }
  const options = await f.server.handle(req('passkeys/login/options'));
  const body: any = await options.json();
  const forged = assertion(active.k, body.challenge, active.userHandle, 1);
  forged.response.signature = randomBytes(70).toString('base64url');
  expect(
    (await f.server.handle(req('passkeys/login/verify', 'POST', cookie(options), { response: forged }))).status,
  ).toBe(401);
  const missingCookie = await f.server.handle(
    req('passkeys/login/verify', 'POST', '', { response: assertion(active.k, body.challenge, active.userHandle, 1) }),
  );
  expect(missingCookie.status).toBe(400);
  const expired = await f.server.handle(req('passkeys/login/options'));
  const expiredBody: any = await expired.json();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
  expect(
    (
      await f.server.handle(
        req('passkeys/login/verify', 'POST', cookie(expired), {
          response: assertion(active.k, expiredBody.challenge, active.userHandle, 1),
        }),
      )
    ).status,
  ).toBe(400);
  vi.restoreAllMocks();
  const registrationOptions = await f.server.handle(req('passkeys/register/options', 'POST', f.cookie));
  const ro: any = await registrationOptions.json();
  const otherToken = await f.auth.login({ username: 'owner', password });
  expect(
    (
      await f.server.handle(
        req('passkeys/register/verify', 'POST', `plasticwan_admin=${otherToken}; ${cookie(registrationOptions)}`, {
          name: 'wrong-session',
          response: registration(key(), ro.challenge),
        }),
      )
    ).status,
  ).toBe(400);
});

test('rejects stale signature counters, deleted keys, ownership violations and throttles options', async () => {
  const f = await fixture();
  const active = await register(f);
  for (const expected of [200, 401]) {
    const options = await f.server.handle(req('passkeys/login/options'));
    const body: any = await options.json();
    expect(
      (
        await f.server.handle(
          req('passkeys/login/verify', 'POST', cookie(options), {
            response: assertion(active.k, body.challenge, active.userHandle, 1),
          }),
        )
      ).status,
    ).toBe(expected);
  }
  const other = f.store.orm
    .insert(adminUsers)
    .values({
      username: 'other',
      passwordHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning()
    .get()!;
  const foreign = f.store.orm
    .insert(adminPasskeys)
    .values({
      userId: other.id,
      name: 'foreign',
      credentialId: 'foreign',
      publicKey: 'unused',
      counter: 0n,
      rpId: 'example.com',
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get()!;
  expect((await f.server.handle(req(`passkeys/${foreign.id}`, 'DELETE', f.cookie))).status).toBe(404);
  const options = await f.server.handle(req('passkeys/login/options'));
  const body: any = await options.json();
  f.store.orm.delete(adminPasskeys).where(eq(adminPasskeys.credentialId, active.k.id)).run();
  expect(
    (
      await f.server.handle(
        req('passkeys/login/verify', 'POST', cookie(options), {
          response: assertion(active.k, body.challenge, active.userHandle, 2),
        }),
      )
    ).status,
  ).toBe(401);
  let response: Response | undefined;
  for (let i = 0; i < 61; i++) {
    response = await f.server.handle(req('passkeys/login/options'), 'throttle-fixture');
  }
  expect(response?.status).toBe(429);
});

test('registration rejects wrong challenge/origin/RP/UV, duplicate keys and revoked authorization', async () => {
  const f = await fixture();
  const active = await register(f);
  const passkeys = new AdminPasskeys(f.store.orm, f.auth, origin);
  for (const overrides of [{ origin: 'https://evil.test' }, { rp: 'evil.test' }, { flags: 0x41 }]) {
    const pending = await passkeys.registrationOptions(f.token, '');
    await expect(
      passkeys.register(
        { name: 'invalid', response: registration(key(), pending.options.challenge, overrides) },
        pending.token,
        f.token,
      ),
    ).rejects.toMatchObject({ code: 'invalid_passkey' });
  }
  const wrong = await passkeys.registrationOptions(f.token, '');
  await expect(
    passkeys.register({ name: 'invalid', response: registration(key(), 'wrong-challenge') }, wrong.token, f.token),
  ).rejects.toMatchObject({ code: 'invalid_passkey' });
  const duplicate = await passkeys.registrationOptions(f.token, '');
  await expect(
    passkeys.register(
      { name: 'duplicate', response: registration(active.k, duplicate.options.challenge) },
      duplicate.token,
      f.token,
    ),
  ).rejects.toMatchObject({ code: 'passkey_exists' });
  const pending = await passkeys.registrationOptions(f.token, '');
  const inFlight = passkeys.register(
    { name: 'revoked', response: registration(key(), pending.options.challenge) },
    pending.token,
    f.token,
  );
  f.auth.logout(f.token);
  await expect(inFlight).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(f.store.orm.select().from(adminPasskeys).all()).toHaveLength(1);
});

test('in-flight assertions cannot revive deleted keys or bypass recovery; concurrent counters commit once', async () => {
  const f = await fixture();
  const active = await register(f);
  const passkeys = new AdminPasskeys(f.store.orm, f.auth, origin);
  const one = await passkeys.loginOptions('');
  const two = await passkeys.loginOptions('');
  const results = await Promise.allSettled([
    passkeys.login({ response: assertion(active.k, one.options.challenge, active.userHandle, 1) }, one.token),
    passkeys.login({ response: assertion(active.k, two.options.challenge, active.userHandle, 1) }, two.token),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const wrongUser = await passkeys.loginOptions('');
  await expect(
    passkeys.login({ response: assertion(active.k, wrongUser.options.challenge, 'wrong-user', 2) }, wrongUser.token),
  ).rejects.toMatchObject({ code: 'invalid_passkey' });
  const wrongChallenge = await passkeys.loginOptions('');
  await expect(
    passkeys.login({ response: assertion(active.k, 'wrong-challenge', active.userHandle, 2) }, wrongChallenge.token),
  ).rejects.toMatchObject({ code: 'invalid_passkey' });
  const pending = await passkeys.loginOptions('');
  const inFlight = passkeys.login(
    { response: assertion(active.k, pending.options.challenge, active.userHandle, 2) },
    pending.token,
  );
  passkeys.remove(f.session.userId, f.store.orm.select().from(adminPasskeys).get()!.id);
  await expect(inFlight).rejects.toMatchObject({ code: 'invalid_passkey' });
  await register(f);
  await f.auth.recoverCredentials({ username: 'owner', password: 'fixture-reset-password' });
  expect(f.store.orm.select().from(adminPasskeys).all()).toHaveLength(0);
  expect(f.auth.authenticate(f.token)).toBeNull();
  expect(f.auth.setupRequired()).toBe(false);
});

test('passwordless accounts can sign in repeatedly with zero-counter synced keys; wrong-RP keys cannot remove password', async () => {
  const f = await fixture();
  const active = await register(f);
  f.cookie = cookie(await f.server.handle(req('password', 'DELETE', f.cookie)));
  for (let i = 0; i < 2; i++) {
    const options = await f.server.handle(req('passkeys/login/options'));
    const body: any = await options.json();
    expect(
      (
        await f.server.handle(
          req('passkeys/login/verify', 'POST', cookie(options), {
            response: assertion(active.k, body.challenge, active.userHandle, 0),
          }),
        )
      ).status,
    ).toBe(200);
  }
  f.cookie = cookie(await f.server.handle(req('credentials', 'POST', f.cookie, { username: 'owner', password })));
  f.store.orm.update(adminPasskeys).set({ rpId: 'old.example.com' }).run();
  const stale: any = await (await f.server.handle(req('passkeys', 'GET', f.cookie))).json();
  expect(stale.items).toHaveLength(1);
  expect(stale.items[0].usable).toBe(false);
  expect((await f.server.handle(req('password', 'DELETE', f.cookie))).status).toBe(409);
  expect(f.auth.hasPassword(f.session.userId)).toBe(true);
});

test('032 migration preserves users and sessions with foreign keys enabled and permits password removal', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(await readFile(new URL('../src/store/migrations/003_admin.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO admin_users VALUES(42,'owner','old-hash','created','updated',NULL)");
    db.exec("INSERT INTO admin_sessions VALUES(9,42,'digest','created','expires','seen')");
    const sql = await readFile(new URL('../src/store/migrations/032_admin_passkeys.sql', import.meta.url), 'utf8');
    db.transaction(() => {
      db.exec(sql);
    }).immediate();
    expect(db.prepare('SELECT * FROM admin_sessions').get()).toMatchObject({
      id: 9,
      user_id: 42,
      token_hash: 'digest',
    });
    expect(db.prepare('SELECT * FROM admin_users').get()).toMatchObject({ id: 42, password_hash: 'old-hash' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('UPDATE admin_users SET password_hash = NULL');
    db.exec('DELETE FROM admin_users');
    expect(db.prepare('SELECT * FROM admin_sessions').all()).toEqual([]);
  } finally {
    db.close();
  }
});
