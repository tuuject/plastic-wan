import { type APIRequestContext, expect, test } from '@playwright/test';
import { adminUrl } from './helpers.ts';

/**
 * Programmatic API keys against the real AdminServer: session-only management,
 * one-time plaintext, a Bearer surface limited to the invocation routes,
 * immediate revocation, and the unwired replay engine answering 503. The
 * fixture seeds invocation 4001 (see test/fixtures/admin-seed.ts).
 *
 * This spec is API-only and signs in itself, so it also passes when run on its
 * own (`pnpm run admin:test:e2e 14-api-keys`) before the auth spec has written
 * the shared storage state.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const USERNAME = process.env.E2E_USERNAME ?? 'e2e-admin';
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-correct-horse';

let cookie = '';

test.beforeAll(async ({ request }) => {
  const session = await request.get(await adminUrl('/api/auth/session'));
  const state = (await session.json()) as { setup_required: boolean };
  const response = state.setup_required
    ? await request.post(await adminUrl('/api/auth/setup'), { data: { username: USERNAME, password: PASSWORD } })
    : await request.post(await adminUrl('/api/auth/login'), { data: { username: USERNAME, password: PASSWORD } });
  expect(response.status()).toBe(200);
  const header = response.headers()['set-cookie'] ?? '';
  cookie = header.slice(0, header.indexOf(';'));
  expect(cookie).toContain('plasticwan_admin=');
});

function bearer(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

async function createKey(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(await adminUrl('/api/api-keys'), {
    headers: { cookie },
    data: { name },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { key: string }).key;
}

test('API keys are managed by the session and only shown once', async ({ request }) => {
  const created = await request.post(await adminUrl('/api/api-keys'), {
    headers: { cookie },
    data: { name: 'e2e-cli' },
  });
  expect(created.status()).toBe(200);
  const createdBody = (await created.json()) as { key: string; item: { id: string; prefix: string } };
  expect(createdBody.key).toMatch(/^pwk_[A-Za-z0-9_-]{43}$/);
  expect(createdBody.item.prefix).toBe(createdBody.key.slice(0, 12));

  // The listing repeats metadata but never the key itself.
  const listed = await request.get(await adminUrl('/api/api-keys'), { headers: { cookie } });
  expect(listed.status()).toBe(200);
  const listing = (await listed.json()) as { items: Array<{ id: string; name: string; revoked_at: string | null }> };
  expect(listing.items).toContainEqual(
    expect.objectContaining({ id: createdBody.item.id, name: 'e2e-cli', revoked_at: null }),
  );
  expect(JSON.stringify(listing)).not.toContain(createdBody.key);

  // The Bearer surface covers the invocation list and one invocation.
  const key = createdBody.key;
  const invocations = await request.get(await adminUrl('/api/invocations?limit=1'), { headers: bearer(key) });
  expect(invocations.status()).toBe(200);
  const detail = await request.get(await adminUrl('/api/invocations/4001'), { headers: bearer(key) });
  expect(detail.status()).toBe(200);

  // It does not cover other audits, key management, or the wider session
  // surface — not even when the request also carries the session cookie.
  for (const path of ['/api/overview', '/api/messages', '/api/api-keys', '/api/config/status']) {
    const response = await request.get(await adminUrl(path), { headers: { cookie, ...bearer(key) } });
    expect(response.status(), path).toBe(403);
  }

  // Replay is not wired into the E2E fixture.
  const replay = await request.post(await adminUrl('/api/invocations/4001/replay'), {
    headers: bearer(key),
    data: { system_prompt: 'What if?' },
  });
  expect(replay.status()).toBe(503);
  expect(((await replay.json()) as { error: string }).error).toBe('replay_unavailable');

  // Revocation via the session disables the key on its next use.
  const revoked = await request.delete(await adminUrl(`/api/api-keys/${createdBody.item.id}`), {
    headers: { cookie },
  });
  expect(revoked.status()).toBe(200);
  const afterRevoke = await request.get(await adminUrl('/api/invocations'), { headers: bearer(key) });
  expect(afterRevoke.status()).toBe(401);
  const relisted = (await (await request.get(await adminUrl('/api/api-keys'), { headers: { cookie } })).json()) as {
    items: Array<{ id: string; revoked_at: string | null }>;
  };
  expect(relisted.items).toContainEqual(
    expect.objectContaining({ id: createdBody.item.id, revoked_at: expect.any(String) }),
  );
});

test('a present Authorization header never falls back to the session cookie', async ({ request }) => {
  const garbage = await request.get(await adminUrl('/api/invocations'), {
    headers: { cookie, ...bearer('pwk_not-a-real-key') },
  });
  expect(garbage.status()).toBe(401);

  // A valid key plus the cookie is still restricted to the invocation surface.
  const key = await createKey(request, 'e2e-boundary');
  const upgraded = await request.get(await adminUrl('/api/memories'), { headers: { cookie, ...bearer(key) } });
  expect(upgraded.status()).toBe(403);

  // The session cookie itself is still intact.
  const session = await request.get(await adminUrl('/api/invocations'), { headers: { cookie } });
  expect(session.status()).toBe(200);
});
