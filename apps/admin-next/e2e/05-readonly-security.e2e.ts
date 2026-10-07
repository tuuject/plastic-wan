import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';

/**
 * Read-only guarantee and the production security posture, exercised against
 * the real static hosting (not the Rsbuild dev server): audit pages must never
 * issue write methods to `/api/**`, the CSP header must be present, and the
 * whole browsing session must stay same-origin with zero console/page errors.
 */
test.use({ storageState: authStoragePath() });

const READ_ONLY_ROUTES = [
  '/',
  '/invocations',
  '/invocations/4001',
  '/contexts',
  '/contexts/2001',
  '/messages',
  '/messages/6001',
  '/stickers',
] as const;

test('browsing every audit page sends no write method to /api/**', async ({ page }) => {
  const finish = watchPageIssues(page);
  for (const route of READ_ONLY_ROUTES) {
    await page.goto(await adminUrl(route));
    await page.waitForLoadState('networkidle');
  }
  const issues = finish();
  expect(issues.writeApiCalls, JSON.stringify(issues.writeApiCalls)).toEqual([]);
});

test('the active replay model catalog exposes only usable model metadata to the authenticated session', async ({
  request,
}) => {
  const response = await request.get(await adminUrl('/api/models'));
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  expect(catalog.source).toBe('active');
  expect(Number.isSafeInteger(catalog.generation)).toBe(true);
  expect(catalog.models.length).toBeGreaterThan(0);
  for (const model of catalog.models) {
    expect(Object.keys(model).sort()).toEqual([
      'context_window',
      'input',
      'max_tokens',
      'model',
      'name',
      'provider',
      'reasoning',
      'thinking_levels',
    ]);
    expect(model.input).toContain('text');
    expect(model.thinking_levels.length).toBeGreaterThan(0);
  }
  const serialized = JSON.stringify(catalog);
  for (const secret of ['telegram-secret', 'agent-secret', 'vision-secret']) {
    expect(serialized).not.toContain(secret);
  }
});

test('the production bundle is served with the strict CSP header', async ({ request }) => {
  const index = await request.get(await adminUrl('/'));
  expect(index.status()).toBe(200);
  const csp = index.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(index.headers()['x-frame-options']).toBe('DENY');
  expect(index.headers()['x-content-type-options']).toBe('nosniff');
});

test('browsing the panel stays same-origin with no console errors, page errors or CSP violations', async ({ page }) => {
  const finish = watchPageIssues(page);
  for (const route of READ_ONLY_ROUTES) {
    await page.goto(await adminUrl(route));
    await page.waitForLoadState('networkidle');
  }
  const issues = finish();
  expect(issues.externalRequests, JSON.stringify(issues.externalRequests)).toEqual([]);
  expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
  expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
});
