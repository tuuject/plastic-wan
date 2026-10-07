import { expect, type Page, test } from '@playwright/test';
import { adminBase, authStoragePath, e2eFetch } from './helpers.ts';

/**
 * Auth state machine against the real AdminServer: first-run setup, logout,
 * bad-password handling, and session revocation. Every flow asserts real UI
 * state (shell content / login form), not just response codes.
 */
test.describe.configure({ mode: 'serial' });

async function fillCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
}

async function login(page: Page, base: string, username: string, password: string): Promise<void> {
  await page.goto(base);
  await expect(page.getByText('Plastic Wan admin sign-in')).toBeVisible();
  await fillCredentials(page, username, password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Stored messages')).toBeVisible();
}

test('first-run setup creates the administrator and enters the shell', async ({ page, context }) => {
  const base = await adminBase();
  await page.goto(base);

  // setup_required gate renders the real setup form
  await expect(page.getByText('Create the administrator account')).toBeVisible();
  await fillCredentials(page, process.env.E2E_USERNAME ?? 'e2e-admin', process.env.E2E_PASSWORD ?? 'e2e-correct-horse');
  await page.getByRole('button', { name: 'Create account' }).click();

  // shell with the real Overview payload
  await expect(page.getByText('Stored messages')).toBeVisible();
  await expect(page.getByText('Cached media analyses')).toBeVisible();
  await expect(page.getByText('Bot status')).toBeVisible();
  await expect(page.getByText(process.env.E2E_USERNAME ?? 'e2e-admin')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // share this session with the rest of the suite
  await context.storageState({ path: authStoragePath() });
});

test('logout returns to the login form; bad password shows invalid_credentials and keeps the URL', async ({
  page,
  context,
}) => {
  const base = await adminBase();
  await login(page, base, process.env.E2E_USERNAME ?? 'e2e-admin', process.env.E2E_PASSWORD ?? 'e2e-correct-horse');

  // Sign out from the shell footer → login form (not an error screen)
  await page.getByText('Sign out').click();
  await expect(page.getByText('Plastic Wan admin sign-in')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // wrong password: inline error with the stable code, URL unchanged
  const before = page.url();
  await fillCredentials(page, process.env.E2E_USERNAME ?? 'e2e-admin', 'definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('invalid_credentials', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(before);
  await expect(page.getByText('Plastic Wan admin sign-in')).toBeVisible();

  // correct login restores the shell and refreshes the shared session
  await login(page, base, process.env.E2E_USERNAME ?? 'e2e-admin', process.env.E2E_PASSWORD ?? 'e2e-correct-horse');
  await context.storageState({ path: authStoragePath() });
});

test('a revoked session is bounced to the login form without an error screen', async ({ page, context }) => {
  const base = await adminBase();
  await login(page, base, process.env.E2E_USERNAME ?? 'e2e-admin', process.env.E2E_PASSWORD ?? 'e2e-correct-horse');

  // Revoke every admin session straight from the database.
  const revoked = await e2eFetch<{ deleted: number }>('/revoke-sessions', { method: 'POST' });
  expect(revoked.deleted).toBeGreaterThanOrEqual(1);

  // The next protected request 401s; the global handler returns to the gate.
  await page.goto(await baseURLPath('/invocations'));
  await expect(page.getByText('Plastic Wan admin sign-in')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // Re-authenticate so later specs keep a live session. The gate preserves the
  // current route (/invocations), so assert the shell, then the overview.
  await fillCredentials(page, process.env.E2E_USERNAME ?? 'e2e-admin', process.env.E2E_PASSWORD ?? 'e2e-correct-horse');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Plastic Wan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await page.goto(await baseURLPath('/'));
  await expect(page.getByText('Stored messages')).toBeVisible();
  await context.storageState({ path: authStoragePath() });
});

async function baseURLPath(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
}
