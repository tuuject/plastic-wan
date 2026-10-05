import { expect, test } from '@playwright/test';
import { adminBase, adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';

test.use({ storageState: authStoragePath() });

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: await adminBase() });
});

test('message history shows and copies the sender user ID without sending a write request', async ({ page }) => {
  const finish = watchPageIssues(page);
  await page.goto(await adminUrl('/messages'));
  const search = page.getByRole('textbox', { name: 'Search text or caption' });
  await search.fill('e2e message 5');
  await search.press('Enter');
  await expect(page.getByText('Telegram user ID:', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Telegram message ID' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy Telegram user ID 42', exact: true }).click();
  await expect(page.getByText('Copied to clipboard')).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('42');
  expect(finish()).toEqual({ consoleErrors: [], pageErrors: [], writeApiCalls: [], externalRequests: [] });
});

test('message detail displays a copyable Telegram user ID for each revision', async ({ page }) => {
  await page.goto(await adminUrl('/messages/6001'));
  const copies = page.getByRole('button', { name: 'Copy Telegram user ID 42', exact: true });
  await expect(copies).toHaveCount(2);
  await copies.last().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('42');
});

test('invocation overview and frozen context copy the frozen sender ID', async ({ page }) => {
  await page.goto(await adminUrl('/invocations/4001'));
  const overview = page.getByRole('tabpanel', { name: /Overview/ });
  await expect(overview.getByRole('button', { name: 'Copy Telegram sender ID 42', exact: true })).toHaveCount(2);
  await overview.getByRole('button', { name: 'Copy Telegram sender ID 42', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('42');
  await page.getByRole('tab', { name: /Frozen context/ }).click();
  const frozen = page.getByRole('tabpanel', { name: /Frozen context/ });
  await expect(frozen.getByRole('columnheader', { name: 'Sender', exact: true })).toBeVisible();
  await frozen.getByRole('button', { name: 'Copy Telegram sender ID 42', exact: true }).last().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('42');
});

test('users without a username and anonymous channel identities keep distinct copy labels', async ({ page }) => {
  await page.goto(await adminUrl('/messages'));
  const bob = page.locator('tbody tr').filter({ hasText: 'e2e message 26' });
  await expect(bob.getByText('Bob', { exact: true })).toBeVisible();
  await bob.getByRole('button', { name: 'Copy Telegram user ID 43', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('43');
  const channel = page.locator('tbody tr').filter({ hasText: 'e2e message 27' });
  await expect(channel.getByText('Telegram chat ID:', { exact: true })).toBeVisible();
  await expect(channel.getByRole('button', { name: /Copy Telegram user ID/ })).toHaveCount(0);
  await channel.getByRole('button', { name: 'Copy Telegram chat ID -1009876543210', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('-1009876543210');
  await expect(
    page.locator('tbody tr').filter({ hasText: 'e2e message 28' }).getByRole('button', { name: /Copy/ }),
  ).toHaveCount(0);
});

test('old invocation snapshots without an ID do not offer a fabricated copy action', async ({ page }) => {
  await page.goto(await adminUrl('/invocations/4002'));
  await expect(page.getByText('Telegram sender ID:', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy Telegram sender ID/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Frozen context/ }).click();
  await expect(page.getByRole('button', { name: /Copy Telegram sender ID/ })).toHaveCount(0);
});

test('clipboard errors offer manual copying instead of reporting success', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
      configurable: true,
    });
  });
  await page.goto(await adminUrl('/messages/6001'));
  await page.getByRole('button', { name: 'Copy Telegram user ID 42', exact: true }).first().click();
  await expect(page.getByText('Copy failed. Select the ID and copy it manually.')).toBeVisible();
  await expect(page.getByText('Copied to clipboard')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy Telegram user ID 42', exact: true }).first()).toBeEnabled();
});

test('sender ID controls remain readable in a narrow dark invocation view', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('admin-theme', 'dark');
  });
  await page.goto(await adminUrl('/invocations/4001'));
  await expect(page.locator('html')).toHaveClass(/dark/);
  const overview = page.getByRole('tabpanel', { name: /Overview/ });
  await expect(overview.getByText('Telegram sender ID:', { exact: true }).first()).toBeVisible();
  await overview.getByRole('button', { name: 'Copy Telegram sender ID 42', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('42');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sender-ids-mobile.png'), fullPage: true });
});
