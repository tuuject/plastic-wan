import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { adminBase, adminUrl } from './helpers.ts';

/**
 * Programmatic API keys against the real AdminServer: session-only management,
 * one-time plaintext, a Bearer surface limited to inspection and invocation routes,
 * immediate revocation, and the unwired replay engine answering 503. The
 * fixture seeds invocation 4001 (see test/fixtures/admin-seed.ts).
 *
 * `API key management UI` drives the same server through the built SPA:
 * sidebar entry, one-time display, clipboard handling, storage hygiene,
 * deep-link reload, revoke confirmation and pending/error states. It reuses
 * the API login below by injecting the session cookie into the browser
 * context.
 *
 * This spec signs in itself instead of relying on the shared storage state, so
 * it also passes when run on its own (`pnpm run admin:test:e2e 14-api-keys`)
 * before the auth spec has written that state.
 */
// Playwright also saves an ARIA error snapshot even with trace/screenshots off.
// This page displays a live key; failure artifacts must not capture its value.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ storageState: { cookies: [], origins: [] }, trace: 'off', screenshot: 'off', video: 'off' });

const USERNAME = process.env.E2E_USERNAME ?? 'e2e-admin';
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-correct-horse';

let cookie = '';
let sessionToken = '';

test.beforeAll(async ({ request }) => {
  const session = await request.get(await adminUrl('/api/auth/session'));
  const state = (await session.json()) as { setup_required: boolean };
  const response = state.setup_required
    ? await request.post(await adminUrl('/api/auth/setup'), { data: { username: USERNAME, password: PASSWORD } })
    : await request.post(await adminUrl('/api/auth/login'), { data: { username: USERNAME, password: PASSWORD } });
  expect(response.status()).toBe(200);
  const header = response.headers()['set-cookie'] ?? '';
  cookie = header.slice(0, header.indexOf(';'));
  expect(cookie.startsWith('plasticwan_admin=')).toBe(true);
  sessionToken = cookie.slice(cookie.indexOf('=') + 1);
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
  expect(/^pwk_[A-Za-z0-9_-]{43}$/.test(createdBody.key)).toBe(true);
  expect(createdBody.item.prefix === createdBody.key.slice(0, 12)).toBe(true);

  // The listing repeats metadata but never the key itself.
  const listed = await request.get(await adminUrl('/api/api-keys'), { headers: { cookie } });
  expect(listed.status()).toBe(200);
  const listing = (await listed.json()) as { items: Array<{ id: string; name: string; revoked_at: string | null }> };
  expect(
    listing.items.some(
      (item) => item.id === createdBody.item.id && item.name === 'e2e-cli' && item.revoked_at === null,
    ),
  ).toBe(true);
  expect(JSON.stringify(listing).includes(createdBody.key)).toBe(false);

  // The Bearer surface covers invocation reads and the explicit inspection allowlist.
  const key = createdBody.key;
  const invocations = await request.get(await adminUrl('/api/invocations?limit=1'), { headers: bearer(key) });
  expect(invocations.status()).toBe(200);
  const detail = await request.get(await adminUrl('/api/invocations/4001'), { headers: bearer(key) });
  expect(detail.status()).toBe(200);
  for (const source of ['active', 'file']) {
    const configuration = await request.get(await adminUrl(`/api/config/view?source=${source}`), {
      headers: bearer(key),
    });
    expect(configuration.status()).toBe(200);
    const view = (await configuration.json()) as { source: string; config: Record<string, unknown> };
    expect(view.source).toBe(source);
    expect(JSON.stringify(view.config).includes('"api_key"')).toBe(false);
    for (const scope of ['global', 'group']) {
      const query = scope === 'group' ? `source=${source}&chat=123456789` : `source=${source}`;
      const response = await request.get(await adminUrl(`/api/prompts/${scope}?${query}`), { headers: bearer(key) });
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ source, scope, core_read_only: true });
    }
  }

  // It does not cover other audits, key management, or the wider session
  // surface — not even when the request also carries the session cookie.
  for (const path of ['/api/overview', '/api/messages', '/api/api-keys', '/api/config/status']) {
    const response = await request.get(await adminUrl(path), { headers: { cookie, ...bearer(key) } });
    expect(response.status(), path).toBe(403);
  }

  // Replay is not wired into the E2E fixture.
  const replay = await request.post(await adminUrl('/api/invocations/4001/replay'), {
    headers: bearer(key),
    data: { global_prompt: 'What if?' },
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
  expect(relisted.items.some((item) => item.id === createdBody.item.id && typeof item.revoked_at === 'string')).toBe(
    true,
  );
});

test('a present Authorization header never falls back to the session cookie', async ({ request }) => {
  const garbage = await request.get(await adminUrl('/api/invocations'), {
    headers: { cookie, ...bearer('pwk_not-a-real-key') },
  });
  expect(garbage.status()).toBe(401);

  // A valid key plus the cookie is still restricted to inspection and invocation routes.
  const key = await createKey(request, 'e2e-boundary');
  const upgraded = await request.get(await adminUrl('/api/memories'), { headers: { cookie, ...bearer(key) } });
  expect(upgraded.status()).toBe(403);

  // The session cookie itself is still intact.
  const session = await request.get(await adminUrl('/api/invocations'), { headers: { cookie } });
  expect(session.status()).toBe(200);
});

/** In-page clipboard stub: Copy never touches the OS clipboard or logs the key. */
async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __e2eCopiedText?: string }).__e2eCopiedText = text;
        },
      },
    });
  });
}

/** Boolean-only scan: no full `pwk_…` key may sit in Web Storage. */
function storageHasApiKey(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const values = [...Object.values(window.localStorage), ...Object.values(window.sessionStorage)];
    return values.some((value) => /pwk_[A-Za-z0-9_-]{43}/.test(value));
  });
}

/** Boolean-only scan: is the plaintext still anywhere in the rendered DOM? */
function bodyContains(page: Page, secret: string): Promise<boolean> {
  return page.evaluate(
    (needle) =>
      (document.body.textContent?.includes(needle) ?? false) ||
      [...document.querySelectorAll('input, textarea')].some((element) =>
        (element as HTMLInputElement | HTMLTextAreaElement).value.includes(needle),
      ),
    secret,
  );
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function uniqueKeyName(scope: string): string {
  return `e2e-ui-${scope}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createKeyThroughUi(page: Page, name: string): Promise<string> {
  await page.getByRole('main').getByRole('button', { name: 'Create API key' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Name').fill(name);
  await createDialog.getByRole('button', { name: 'Create key' }).click();
  const saveDialog = page.getByRole('dialog');
  await expect(saveDialog.getByText('Save your API key', { exact: true })).toBeVisible();
  const key = await saveDialog.getByLabel('API key').inputValue();
  await saveDialog.getByRole('button', { name: 'Done' }).click();
  await expect(saveDialog).not.toBeVisible();
  return key;
}

/**
 * The real key-management surface. All tests reuse the API login above by
 * injecting its session cookie, so this block stays standalone-runnable. The
 * plaintext key lives only in the browser and in test memory: clipboard writes
 * are stubbed, artifacts are off, and every secret-shaped assertion is a
 * boolean (never `expect(key)` / `toContain(key)`, which would print it).
 */
test.describe('API key management UI', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: 'plasticwan_admin', value: sessionToken, url: await adminBase() }]);
  });

  test('creates a key from the sidebar, shows it once, and drops the plaintext afterwards', async ({ page }) => {
    await installClipboardRecorder(page);
    await page.goto(await adminUrl('/'));
    const manageGroup = page.locator('[data-sidebar="group"]').filter({ hasText: 'Manage' });
    await expect(manageGroup.getByRole('link', { name: 'API keys', exact: true })).toBeVisible();
    await manageGroup.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page).toHaveURL(/\/api-keys$/);

    const main = page.getByRole('main');
    await expect(main.getByText('API keys', { exact: true }).first()).toBeVisible();
    // The permission note names the inspection/export surface without granting production writes.
    const permissionNote = main.getByText(/plasticwan-utils CLI/);
    await expect(permissionNote).toBeVisible();
    await expect(permissionNote).toContainText('read redacted configuration and global/group prompts');
    await expect(permissionNote).toContainText('export snapshot-authorized media');
    await expect(permissionNote).toContainText('temporary prompt overrides');
    await expect(permissionNote).toContainText('cannot change production prompts or configuration, or manage keys');
    await expect(permissionNote).toContainText('may incur charges');
    await expect(main.getByRole('button', { name: 'Create API key' })).toBeVisible();

    const name = uniqueKeyName('once');
    await main.getByRole('button', { name: 'Create API key' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog.getByText('Create API key', { exact: true })).toBeVisible();
    await expect(createDialog.getByLabel('Name')).toHaveAttribute('maxlength', '80');
    await createDialog.getByLabel('Name').fill(name);
    await createDialog.getByRole('button', { name: 'Create key' }).click();

    const saveDialog = page.getByRole('dialog');
    await expect(saveDialog.getByText('Save your API key', { exact: true })).toBeVisible();
    await expect(saveDialog.getByText(/shown only once/i)).toBeVisible();
    const apiKeyBox = saveDialog.getByLabel('API key');
    await expect(apiKeyBox).toBeVisible();
    expect(await apiKeyBox.evaluate((element) => (element as HTMLTextAreaElement).readOnly)).toBe(true);
    const key = await apiKeyBox.inputValue();
    expect(/^pwk_[A-Za-z0-9_-]{43}$/.test(key)).toBe(true);
    expect(await bodyContains(page, key)).toBe(true);

    // No storage wrote the plaintext while the one-time dialog was still open.
    expect(await storageHasApiKey(page)).toBe(false);

    await saveDialog.getByRole('button', { name: 'Copy API key' }).click();
    const copied = await page.evaluate((secret) => {
      const state = window as unknown as { __e2eCopiedText?: string };
      const copied = state.__e2eCopiedText === secret && secret.startsWith('pwk_');
      delete state.__e2eCopiedText;
      return copied;
    }, key);
    expect(copied).toBe(true);

    await saveDialog.getByRole('button', { name: 'Done' }).click();
    await expect(saveDialog).not.toBeVisible();
    expect(await bodyContains(page, key)).toBe(false);
    expect(await storageHasApiKey(page)).toBe(false);

    // Deep-link reload: the row keeps metadata only, the plaintext is gone.
    await page.reload();
    const row = main.locator('table tbody tr', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText(/pwk_[A-Za-z0-9_-]+/)).toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    await expect(row.getByText('Never used', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toBeVisible();
    expect(await bodyContains(page, key)).toBe(false);
    expect(await storageHasApiKey(page)).toBe(false);

    // The REST listing repeats metadata, never the key itself.
    const listing = await page.request.get(await adminUrl('/api/api-keys'));
    expect(listing.status()).toBe(200);
    const listingBody = (await listing.json()) as { items: Array<Record<string, unknown>> };
    const listed = listingBody.items.find((item) => item.name === name);
    expect(listed).toBeTruthy();
    expect(Object.hasOwn(listed ?? {}, 'key')).toBe(false);
    expect(listingBody.items.some((item) => Object.hasOwn(item, 'key'))).toBe(false);

    // A key opens the read-only invocation surface and nothing wider.
    const invocations = await page.request.get(await adminUrl('/api/invocations?limit=1'), {
      headers: bearer(key),
    });
    expect(invocations.status()).toBe(200);
    const overview = await page.request.get(await adminUrl('/api/overview'), { headers: bearer(key) });
    expect(overview.status()).toBe(403);
  });

  test('drops an open plaintext dialog on Escape, refresh and history navigation', async ({ page }) => {
    for (const dismissal of ['escape', 'refresh', 'navigation']) {
      await page.goto(await adminUrl('/'));
      await page.getByRole('link', { name: 'API keys', exact: true }).click();
      const name = uniqueKeyName(dismissal);
      await page.getByRole('main').getByRole('button', { name: 'Create API key' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Create key' }).click();
      await expect(dialog.getByText('Save your API key', { exact: true })).toBeVisible();
      const key = await dialog.getByLabel('API key').inputValue();
      expect(await bodyContains(page, key)).toBe(true);

      if (dismissal === 'escape') {
        await page.keyboard.press('Escape');
      } else if (dismissal === 'refresh') {
        await page.reload();
      } else {
        await page.goBack();
        await expect(page).toHaveURL(await adminUrl('/'));
        await page.getByRole('link', { name: 'API keys', exact: true }).click();
      }
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('main').locator('table tbody tr', { hasText: name })).toBeVisible();
      expect(await bodyContains(page, key)).toBe(false);
      expect(await storageHasApiKey(page)).toBe(false);
    }
  });

  test('clears the one-time dialog when the session expires during the metadata refresh', async ({ page }) => {
    const gate = deferred();
    let expired = false;
    let listCalls = 0;
    await page.route('**/api/api-keys', async (route) => {
      if (route.request().method() === 'GET') {
        listCalls += 1;
        if (listCalls > 1) {
          await gate.promise;
          await route.fulfill({
            status: 401,
            json: { error: 'unauthenticated', message: 'Admin session is required' },
          });
          return;
        }
      }
      await route.fallback();
    });
    await page.route('**/api/auth/session', async (route) => {
      if (expired) {
        await route.fulfill({
          json: { setup_required: false, authenticated: false, username: null, expires_at: null },
        });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/api-keys'));
    await expect(page.getByRole('columnheader', { name: 'Prefix', exact: true })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Create API key' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(uniqueKeyName('session'));
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(dialog.getByText('Save your API key', { exact: true })).toBeVisible();
    const key = await dialog.getByLabel('API key').inputValue();
    expect(await bodyContains(page, key)).toBe(true);
    expired = true;
    gate.resolve();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await bodyContains(page, key)).toBe(false);
    expect(await storageHasApiKey(page)).toBe(false);
  });

  test('keeps a cancelled revocation request-free and revokes only after confirming', async ({ page }) => {
    await page.goto(await adminUrl('/api-keys'));
    const name = uniqueKeyName('revoke');
    const key = await createKeyThroughUi(page, name);

    const main = page.getByRole('main');
    const row = main.locator('table tbody tr', { hasText: name });
    await expect(row).toBeVisible();

    let deletes = 0;
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/api/api-keys/')) {
        deletes += 1;
      }
    });

    await row.getByRole('button', { name: 'Revoke' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText('Revoke API key?', { exact: true })).toBeVisible();
    await expect(confirm).toContainText(name);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).not.toBeVisible();
    expect(deletes).toBe(0);
    await expect(row.getByText('Active', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    expect(deletes).toBe(1);

    const afterRevoke = await page.request.get(await adminUrl('/api/invocations'), { headers: bearer(key) });
    expect(afterRevoke.status()).toBe(401);
  });

  test('a list failure offers Retry and recovers without inventing rows', async ({ page }) => {
    let listCalls = 0;
    await page.route('**/api/api-keys**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/api-keys')) {
        listCalls += 1;
        if (listCalls === 1) {
          await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic list failure' } });
        } else {
          await route.fulfill({
            json: {
              items: [
                {
                  id: '9001',
                  name: 'retry-fixture',
                  prefix: 'pwk_retryfix',
                  created_at: '2026-01-02T03:04:05.000Z',
                  last_used_at: null,
                  revoked_at: null,
                },
              ],
            },
          });
        }
        return;
      }
      await route.fallback();
    });

    await page.goto(await adminUrl('/api-keys'));
    const main = page.getByRole('main');
    await expect(main.getByText('Synthetic list failure', { exact: false })).toBeVisible();
    await expect(main.locator('table tbody tr')).toHaveCount(0);

    await main.getByRole('button', { name: 'Retry' }).click();
    const row = main.locator('table tbody tr', { hasText: 'retry-fixture' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Never used', { exact: true })).toBeVisible();
    await expect(main.getByText('Synthetic list failure', { exact: false })).toHaveCount(0);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  test('a failed create stays inline, cannot double-submit, and retries manually', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard denied');
          },
        },
      });
    });
    const gate = deferred();
    const fakeKey = `pwk_${'A'.repeat(43)}`;
    let createCalls = 0;
    await page.route('**/api/api-keys**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/api-keys')) {
        createCalls += 1;
        if (createCalls === 1) {
          await gate.promise;
          await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic create failure' } });
        } else {
          await route.fulfill({
            json: {
              key: fakeKey,
              item: {
                id: '9002',
                name: 'pending-guard',
                prefix: fakeKey.slice(0, 12),
                created_at: '2026-01-02T03:04:05.000Z',
                last_used_at: null,
                revoked_at: null,
              },
            },
          });
        }
        return;
      }
      await route.fallback();
    });

    await page.goto(await adminUrl('/api-keys'));
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Create API key' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('   ');
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(dialog.getByText('Enter a name of 1–80 characters.')).toBeVisible();
    expect(createCalls).toBe(0);
    await dialog.getByLabel('Name').fill('pending-guard');
    await dialog.getByRole('button', { name: 'Create key' }).click();

    // While the request is held the submit is disabled and no retry fires.
    await expect.poll(() => createCalls).toBe(1);
    await expect(dialog.getByRole('button', { name: /^Creat/ })).toBeDisabled();

    gate.resolve();
    await expect(dialog.getByText('Synthetic create failure', { exact: false })).toBeVisible();
    expect(createCalls).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Create key' })).toBeEnabled();

    // A manual retry is the only way to submit again, and it succeeds once.
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect.poll(() => createCalls).toBe(2);
    const saveDialog = page.getByRole('dialog');
    await expect(saveDialog.getByText('Save your API key', { exact: true })).toBeVisible();
    await saveDialog.getByRole('button', { name: 'Copy API key' }).click();
    await expect(saveDialog.getByText('Could not copy. Select the key and copy it manually.')).toBeVisible();

    await saveDialog.getByRole('button', { name: 'Done' }).click();
    await expect(saveDialog).not.toBeVisible();
    expect(await bodyContains(page, fakeKey)).toBe(false);
  });

  test('a failed revoke stays in the confirmation with a pending guard', async ({ page }) => {
    const item = {
      id: '9003',
      name: 'revoke-error-fixture',
      prefix: 'pwk_revokefix',
      created_at: '2026-01-02T03:04:05.000Z',
      last_used_at: null,
      revoked_at: null,
    };
    const gate = deferred();
    let deleteCalls = 0;
    let revoked = false;
    await page.route('**/api/api-keys**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/api-keys')) {
        await route.fulfill({
          json: { items: [{ ...item, revoked_at: revoked ? '2026-01-02T03:04:05.000Z' : null }] },
        });
        return;
      }
      if (request.method() === 'DELETE') {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          await gate.promise;
          await route.fulfill({ status: 404, json: { error: 'not_found', message: 'API key does not exist' } });
        } else {
          revoked = true;
          await route.fulfill({ json: { status: 'ok' } });
        }
        return;
      }
      await route.fallback();
    });

    await page.goto(await adminUrl('/api-keys'));
    const main = page.getByRole('main');
    const row = main.locator('table tbody tr', { hasText: item.name });
    await row.getByRole('button', { name: 'Revoke' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByRole('button', { name: 'Revoke key' }).click();

    // ConfirmDialog pending state: both buttons disabled, no second request.
    await expect.poll(() => deleteCalls).toBe(1);
    await expect(confirm.getByRole('button', { name: 'Working…' })).toBeDisabled();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    gate.resolve();
    await expect(confirm.getByText('API key does not exist', { exact: false })).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Revoke key' })).toBeEnabled();
    expect(deleteCalls).toBe(1);

    // Cancelling closes without a second request and keeps the row active.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).not.toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    expect(deleteCalls).toBe(1);

    // A manual second attempt (error cleared on reopen) can succeed.
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    expect(deleteCalls).toBe(2);
  });

  test('fits a narrow dark viewport without full-page horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('admin-theme', 'dark');
    });
    await page.goto(await adminUrl('/api-keys'));
    await expect(page.locator('html')).toHaveClass(/dark/);
    const main = page.getByRole('main');
    await expect(main.getByText('API keys', { exact: true }).first()).toBeVisible();
    await main.getByRole('button', { name: 'Create API key' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Name')).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
