import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';

/**
 * The business routes and their deep links render real content (not the
 * error boundary, not a blank page) with an authenticated session.
 */
test.use({ storageState: authStoragePath() });

const INVOCATION_A = '4001';
const CONVERSATION_ID = '2001';
const MESSAGE_A = '6001';

test.describe('routes and deep links', () => {
  test('/ overview renders the real stats and bot status', async ({ page }) => {
    await page.goto(await adminUrl('/'));
    await expect(page.getByText('Stored messages')).toBeVisible();
    await expect(page.getByText('Cached media analyses')).toBeVisible();
    await expect(page.getByText('Bot status')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/invocations lists tool sessions and offers Load more', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/invocations/:id renders the six-tab detail', async ({ page }) => {
    await page.goto(await adminUrl(`/invocations/${INVOCATION_A}`));
    await expect(page.getByText(`Invocation ${INVOCATION_A}`).first()).toBeVisible();
    for (const tab of [
      'Overview',
      'Tool calls',
      'Model calls',
      'Telegram sends',
      'Agent transcript',
      'Frozen context',
    ]) {
      await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toBeVisible();
    }
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/contexts lists conversation contexts', async ({ page }) => {
    await page.goto(await adminUrl('/contexts'));
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/contexts/:conversationId shows retained messages, capability refs and the truncation marker', async ({
    page,
  }) => {
    await page.goto(await adminUrl(`/contexts/${CONVERSATION_ID}`));
    await expect(page.getByText(`Conversation context ${CONVERSATION_ID}`).first()).toBeVisible();
    await expect(page.getByText('Retained messages (4)')).toBeVisible();
    await expect(page.getByText('Capability refs (1)')).toBeVisible();
    // seq 4 carries a payload above the preview cap; expanding it shows the marker
    const seq4Row = page.locator('table tbody tr', { hasText: 'img:unique_photo_seed_1' }).first();
    await expect(seq4Row).toBeVisible();
    const seq4Toggle = page.getByRole('button', { name: 'Toggle row details' }).nth(3);
    await seq4Toggle.click();
    await expect(page.getByText('Preview truncated; the stored payload is longer.')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/messages lists messages with search and pagination controls', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/messages/:id shows every revision and the media row', async ({ page }) => {
    await page.goto(await adminUrl(`/messages/${MESSAGE_A}`));
    await expect(page.getByText(`Message ${MESSAGE_A}`).first()).toBeVisible();
    await expect(page.getByText('first caption')).toBeVisible();
    await expect(page.getByText('edited caption')).toBeVisible();
    await expect(page.getByText('unique_photo_seed_1')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/alarms lists pending alarms with the seeded summary first', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    await expect(page.getByText('Remind Alice about the fixture data')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/memories lists seeded memories', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await expect(page.getByText('Alice prefers short replies.')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/prompts shows the prompt editor and version history', async ({ page }) => {
    await page.goto(await adminUrl('/prompts'));
    await expect(page.getByText('Prompt editor')).toBeVisible();
    await expect(page.locator('#prompt-text')).toHaveValue('Participate safely.');
    await expect(page.getByText('Version history')).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/admins renders the empty bot-admin list', async ({ page }) => {
    await page.goto(await adminUrl('/admins'));
    await expect(page.getByText('Telegram bot admins')).toBeVisible();
    await expect(page.getByText('No bot admins configured.')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/chats shows the allowlist with topics and agent models', async ({ page }) => {
    await page.goto(await adminUrl('/chats'));
    await expect(page.getByText('Chat allowlist')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Topics' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Agent model' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Chat' })).toBeVisible();
  });

  test('/models lists providers, their models and the discovery actions', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await expect(page.getByText('Providers')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Provider agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch models' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add by id' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/stickers lists configured sets and the search index', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await expect(page.getByText('Configured sticker sets')).toBeVisible();
    await expect(page.locator('table tbody tr', { hasText: 'mascot' }).first()).toBeVisible();
    await expect(page.getByText('Bot search index')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/settings renders the credentials form and the config card', async ({ page }) => {
    await page.goto(await adminUrl('/settings'));
    await expect(page.getByText('Admin credentials')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update credentials' })).toBeVisible();
    await expect(page.getByText('Configuration file')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply config file' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('/developer renders the recording switch and cleanup action', async ({ page }) => {
    await page.goto(await adminUrl('/developer'));
    await expect(page.getByRole('switch', { name: 'Record raw request payloads for debugging' })).not.toBeChecked();
    await expect(
      page.getByRole('button', { name: 'Clear previously recorded raw request payloads', exact: true }),
    ).toBeVisible();
  });

  test('/api-keys renders the key table and the create action', async ({ page }) => {
    await page.goto(await adminUrl('/api-keys'));
    await expect(page.getByRole('main').getByText('API keys', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create API key' })).toBeVisible();
    for (const header of ['Name', 'Prefix', 'Created', 'Last used', 'Status', 'Actions']) {
      await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
    }
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
});

test.describe('no page errors while deep-linking', () => {
  const routes = [
    '/',
    '/invocations',
    `/invocations/${INVOCATION_A}`,
    '/contexts',
    `/contexts/${CONVERSATION_ID}`,
    '/messages',
    `/messages/${MESSAGE_A}`,
    '/alarms',
    '/memories',
    '/admins',
    '/chats',
    '/models',
    '/stickers',
    '/settings',
    '/developer',
    '/api-keys',
  ];
  for (const route of routes) {
    test(`browsing ${route} raises no pageerror`, async ({ page }) => {
      const finish = watchPageIssues(page);
      await page.goto(await adminUrl(route));
      await page.waitForLoadState('networkidle');
      const issues = finish();
      expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
      expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
    });
  }
});
