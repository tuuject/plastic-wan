import { expect, type Locator, type Page, test } from '@playwright/test';
import { adminUrl, authStoragePath, e2eFetch } from './helpers.ts';
import {
  E2E_HEALTH_ALIAS_A,
  E2E_HEALTH_ALIAS_B,
  E2E_HEALTH_FAIL_MODEL,
  E2E_HEALTH_OK_2_MODEL,
  E2E_HEALTH_OK_MODEL,
  E2E_HEALTH_PROMPT,
  E2E_HEALTH_UNEXPECTED_MODEL,
  E2E_RELAY_ALIAS,
  E2E_SECRETS,
} from './models-fixture.ts';

/**
 * Model health checks against the real `AdminServer`: the page must trigger
 * exactly one upstream call per click, keep every check control disabled while
 * a check runs, report ok / unexpected / error separately (also in a mixed
 * batch that never stops at a failure), keep its selection across providers,
 * cap the batch at three concurrent calls, settle fast checks visibly before
 * slow ones, cancel the whole queue when the page unmounts (proven by a
 * test-only upstream gate: requests are held open until a spec releases them,
 * so a drop to zero in-flight while still held can only be a real abort), drop
 * page-local results on reload, never touch the configuration, and never
 * render the provider key. The local upstream (`e2e/server.ts`) verifies the
 * wire shape — a single user message with the fixed prompt, no system role,
 * no tools, an output cap of 128 — and records every body plus each request's
 * abort/completion state so the spec can assert what actually left the
 * process.
 *
 * This spec creates its own loopback providers (`health-a`, `health-b`) through
 * the real write API and deletes exactly those in `afterAll`; it does not
 * depend on the models other specs add.
 *
 * UI contract assumed (matches the Models page health-check work):
 * - the row checkbox is labelled `Select {{model}} for a health check`;
 * - the per-row button is "Check health" (aria `Check health of {{model}}`);
 * - the batch button reads `Check selected (N)`;
 * - the health cell shows a status badge and `TTFB … · … ms`;
 * - response text and error text render in the expandable row details
 *   (toggled by the table's "Toggle row details" button).
 */
test.use({ storageState: authStoragePath() });

const USERNAME = process.env.E2E_USERNAME ?? 'e2e-admin';
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-correct-horse';

/** Providers this spec creates; afterAll deletes exactly these aliases. */
const CREATED_ALIASES = [E2E_HEALTH_ALIAS_A, E2E_HEALTH_ALIAS_B] as const;

interface HealthResult {
  readonly provider: string;
  readonly model: string;
  readonly status: 'ok' | 'unexpected_response' | 'error';
  readonly ttfb_ms: number | null;
  readonly duration_ms: number;
  readonly response_text: string;
  readonly error: string | null;
}

interface RelayRequestRecord {
  readonly model: string;
  readonly aborted: boolean;
  readonly completed: boolean;
}

interface RelayStats {
  readonly total: number;
  readonly by_model: Record<string, number>;
  readonly max_concurrent: number;
  readonly in_flight: number;
  readonly rejected: number;
  readonly aborted: number;
  readonly completed: number;
  readonly records: readonly RelayRequestRecord[];
  readonly bodies: readonly Record<string, unknown>[];
}

interface ProvidersView {
  readonly revision: string;
  readonly agent: { readonly provider: string; readonly model: string };
  readonly vision: { readonly provider: string; readonly model: string };
  readonly providers: readonly { readonly alias: string; readonly base_url: string }[];
}

let cookie = '';

async function relayStats(): Promise<RelayStats> {
  return await e2eFetch<RelayStats>('/relay-stats');
}

async function resetRelayStats(): Promise<void> {
  await e2eFetch('/relay-stats/reset', { method: 'POST' });
}

/**
 * Test-only upstream gate: `hold` parks health requests for `model` (or every
 * model when omitted) before the fixture answers, `release` lets them proceed.
 * Holding before a click makes "still checking" and "cancelled" deterministic:
 * nothing settles until the spec says so.
 */
async function setHealthGate(action: 'hold' | 'release', model?: string): Promise<void> {
  await e2eFetch(`/health-gate/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model === undefined ? {} : { model }),
  });
}

const holdHealthGate = (model?: string): Promise<void> => setHealthGate('hold', model);
const releaseHealthGate = (model?: string): Promise<void> => setHealthGate('release', model);

async function selectProvider(page: Page, alias: string): Promise<void> {
  await page.getByRole('button', { name: `Provider ${alias}` }).click();
  await expect(page.locator('h2', { hasText: alias })).toBeVisible();
}

/** The table row whose model id cell is exactly `modelId` (ids may prefix each other). */
function modelRow(page: Page, modelId: string): Locator {
  return page.locator('tr').filter({ has: page.getByText(modelId, { exact: true }) });
}

/** The expandable details row that TableShell renders right after the model row. */
function expandedRow(page: Page, modelId: string): Locator {
  return modelRow(page, modelId).locator('xpath=following-sibling::tr[1]');
}

async function showHealthDetails(page: Page, modelId: string): Promise<void> {
  await modelRow(page, modelId).getByRole('button', { name: 'Toggle row details' }).click();
}

async function providersView(page: Page): Promise<ProvidersView> {
  return (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
}

/**
 * The wire contract the upstream must have seen: one user message with the
 * exact fixed prompt, no system role, no tools, streaming, output capped at 128.
 */
function assertHealthRequestShape(body: Record<string, unknown>, model: string): void {
  expect(body.model).toBe(model);
  expect(body.stream).toBe(true);
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
  const messages = body.messages as unknown;
  expect(Array.isArray(messages)).toBe(true);
  const list = messages as Array<Record<string, unknown>>;
  expect(list).toHaveLength(1);
  expect(list[0]?.role).toBe('user');
  expect(list[0]?.content).toBe(E2E_HEALTH_PROMPT);
  const cap = (body.max_tokens as number | undefined) ?? (body.max_completion_tokens as number | undefined);
  expect(cap).toBeLessThanOrEqual(128);
}

function healthModel(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    reasoning: false,
    input: ['text'],
    context_window: 4096,
    max_tokens: 128,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };
}

test.beforeAll(async ({ request }) => {
  // Sign in through the API like 14-api-keys does, so the spec also works on
  // its own; the browser tests reuse the shared storage state from 00-auth.
  const session = await request.get(await adminUrl('/api/auth/session'));
  const state = (await session.json()) as { setup_required: boolean };
  const response = state.setup_required
    ? await request.post(await adminUrl('/api/auth/setup'), { data: { username: USERNAME, password: PASSWORD } })
    : await request.post(await adminUrl('/api/auth/login'), { data: { username: USERNAME, password: PASSWORD } });
  expect(response.status()).toBe(200);
  const header = response.headers()['set-cookie'] ?? '';
  cookie = header.slice(0, header.indexOf(';'));
  expect(cookie.startsWith('plasticwan_admin=')).toBe(true);

  // The new providers reuse the relay connection the fixture already serves
  // models and chat completions from; only their model ids are new.
  const view = (await (
    await request.get(await adminUrl('/api/providers'), { headers: { cookie } })
  ).json()) as ProvidersView;
  const relay = view.providers.find((provider) => provider.alias === E2E_RELAY_ALIAS);
  expect(relay, `fixture provider ${E2E_RELAY_ALIAS} is missing`).toBeDefined();
  let revision = view.revision;
  for (const [alias, models] of [
    [
      E2E_HEALTH_ALIAS_A,
      [
        healthModel(E2E_HEALTH_OK_MODEL, 'Health OK'),
        healthModel(E2E_HEALTH_OK_2_MODEL, 'Health OK 2'),
        healthModel(E2E_HEALTH_UNEXPECTED_MODEL, 'Health unexpected'),
      ],
    ],
    [E2E_HEALTH_ALIAS_B, [healthModel(E2E_HEALTH_FAIL_MODEL, 'Health fail')]],
  ] as const) {
    const created = await request.post(await adminUrl('/api/providers'), {
      headers: { cookie, 'if-match': revision },
      data: {
        alias,
        kind: 'custom',
        base_url: relay?.base_url,
        api: 'openai-completions',
        api_key: E2E_SECRETS.health,
        models,
      },
    });
    expect(created.status(), `creating ${alias} failed`).toBe(200);
    revision = ((await created.json()) as ProvidersView).revision;
  }
});

test.afterAll(async ({ request }) => {
  if (cookie.length === 0) {
    return;
  }
  for (const alias of CREATED_ALIASES) {
    const view = (await (
      await request.get(await adminUrl('/api/providers'), { headers: { cookie } })
    ).json()) as ProvidersView;
    if (!view.providers.some((provider) => provider.alias === alias)) {
      continue;
    }
    const deleted = await request.delete(await adminUrl(`/api/providers/${alias}`), {
      headers: { cookie, 'if-match': view.revision },
    });
    expect(deleted.status(), `deleting ${alias} failed`).toBe(200);
  }
});

test.describe('model health checks', () => {
  // Whatever happens in a test that holds the upstream gate, never let the
  // hold leak into the next test.
  test.afterEach(async () => {
    await releaseHealthGate();
  });

  test('a single check reports ok with ttfb and response, and blocks repeats while in flight', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    // Loading the page and selecting the provider fires no health request.
    await expect.poll(async () => (await relayStats()).total).toBe(0);

    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    const check = row.getByRole('button', { name: /check health/i });
    await check.click();

    // The row's check is disabled while the call is in flight, so a repeat
    // click cannot fire a second request.
    await expect(check).toBeDisabled();
    await expect.poll(async () => (await relayStats()).total).toBe(1);

    // The result renders in the row: the status badge and ttfb/duration in ms.
    await expect(row.getByText(/^ok$/i)).toBeVisible();
    await expect(row.getByText(/ms/)).toBeVisible();
    await expect(check).toBeEnabled();

    // The response text lands in the expandable details.
    await showHealthDetails(page, E2E_HEALTH_OK_MODEL);
    await expect(expandedRow(page, E2E_HEALTH_OK_MODEL).getByText('ok', { exact: true })).toBeVisible();

    // The upstream saw exactly the pinned prompt, nothing else.
    const stats = await relayStats();
    expect(stats.rejected).toBe(0);
    expect(stats.by_model).toEqual({ [E2E_HEALTH_OK_MODEL]: 1 });
    expect(stats.bodies).toHaveLength(1);
    assertHealthRequestShape(stats.bodies[0] as Record<string, unknown>, E2E_HEALTH_OK_MODEL);

    // A finished check can run again.
    await check.click();
    await expect.poll(async () => (await relayStats()).total).toBe(2);
    // Let the repeat check settle upstream before the test ends: ending with a
    // request still in flight races the next spec's stats reset against the
    // page-teardown abort and can leave stale state behind.
    await expect.poll(async () => (await relayStats()).in_flight).toBe(0);
    const settled = await relayStats();
    expect(settled.aborted).toBe(0);
    expect(settled.completed).toBe(2);
  });

  test('a mixed batch keeps selection across providers, caps concurrency, and never stops at a failure', async ({
    page,
  }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    await page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`).check();
    await page.getByLabel(`Select ${E2E_HEALTH_OK_2_MODEL} for a health check`).check();
    await page.getByLabel(`Select ${E2E_HEALTH_UNEXPECTED_MODEL} for a health check`).check();

    // Selection survives switching providers: check a model of the second
    // provider, then confirm the first provider's checks are still there.
    await selectProvider(page, E2E_HEALTH_ALIAS_B);
    await page.getByLabel(`Select ${E2E_HEALTH_FAIL_MODEL} for a health check`).check();
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    await expect(page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`)).toBeChecked();

    const before = await providersView(page);
    await page.getByRole('button', { name: /^Check selected \(\d+\)$/ }).click();

    // All four models are checked, three in flight at once (never more); the
    // failing one does not interrupt the others.
    await expect.poll(async () => (await relayStats()).total, { timeout: 15_000 }).toBe(4);
    const stats = await relayStats();
    expect(stats.rejected).toBe(0);
    expect(stats.max_concurrent).toBe(3);
    expect(stats.by_model).toEqual({
      [E2E_HEALTH_OK_MODEL]: 1,
      [E2E_HEALTH_OK_2_MODEL]: 1,
      [E2E_HEALTH_UNEXPECTED_MODEL]: 1,
      [E2E_HEALTH_FAIL_MODEL]: 1,
    });
    for (const body of stats.bodies) {
      assertHealthRequestShape(body, String(body.model));
    }

    // Each outcome is displayed on its own row; the unexpected reply and the
    // upstream error are readable in the expandable details.
    await expect(modelRow(page, E2E_HEALTH_OK_MODEL).getByText(/^ok$/i)).toBeVisible();
    await expect(modelRow(page, E2E_HEALTH_OK_2_MODEL).getByText(/^ok$/i)).toBeVisible();
    await expect(modelRow(page, E2E_HEALTH_UNEXPECTED_MODEL).getByText('Unexpected response')).toBeVisible();
    await showHealthDetails(page, E2E_HEALTH_UNEXPECTED_MODEL);
    await expect(expandedRow(page, E2E_HEALTH_UNEXPECTED_MODEL).getByText('hello')).toBeVisible();

    await selectProvider(page, E2E_HEALTH_ALIAS_B);
    await expect(modelRow(page, E2E_HEALTH_FAIL_MODEL).getByText('Error', { exact: true })).toBeVisible();
    await showHealthDetails(page, E2E_HEALTH_FAIL_MODEL);
    await expect(expandedRow(page, E2E_HEALTH_FAIL_MODEL).getByText(/fixture upstream failure/)).toBeVisible();

    // Health checks are read-only: the configuration and the model references
    // did not move, and the provider key never reached the DOM.
    const after = await providersView(page);
    expect(after.revision).toBe(before.revision);
    expect(after.agent).toEqual(before.agent);
    expect(after.vision).toEqual(before.vision);
    expect(await page.content()).not.toContain(E2E_SECRETS.health);
  });

  test('a fast check settles visibly while a slow one is still checking', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    // Hold the slow model upstream before the batch starts, so the fast result
    // settling next to a still-"Checking…" row does not depend on the ~120ms
    // vs ~2s delay values: the slow request cannot settle until released.
    await holdHealthGate(E2E_HEALTH_UNEXPECTED_MODEL);
    try {
      await page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`).check();
      await page.getByLabel(`Select ${E2E_HEALTH_UNEXPECTED_MODEL} for a health check`).check();
      await page.getByRole('button', { name: /^Check selected \(\d+\)$/ }).click();

      // The fast row already shows its status and timing while the slow row is
      // still in flight — a finished and a running check coexist row by row.
      const fast = modelRow(page, E2E_HEALTH_OK_MODEL);
      const slow = modelRow(page, E2E_HEALTH_UNEXPECTED_MODEL);
      await expect(fast.getByText(/^ok$/i)).toBeVisible();
      await expect(fast.getByText(/TTFB/)).toBeVisible();
      await expect(slow.getByText('Checking…')).toBeVisible();

      // The slow check settles once released.
      await releaseHealthGate(E2E_HEALTH_UNEXPECTED_MODEL);
      await expect(slow.getByText('Unexpected response')).toBeVisible({ timeout: 15_000 });
      expect((await relayStats()).total).toBe(2);
    } finally {
      await releaseHealthGate(E2E_HEALTH_UNEXPECTED_MODEL);
    }
  });

  test('leaving the page aborts the queued and in-flight batch', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    // Hold every model upstream before the batch starts: no request can settle
    // on its own, so an in-flight drop below three can only mean a real abort.
    await holdHealthGate();
    try {
      // Queue four checks so three run and one waits behind them: the three
      // slow models fill the concurrency slots and the fast one is picked up
      // last (and never reaches the upstream).
      await page.getByLabel(`Select ${E2E_HEALTH_OK_2_MODEL} for a health check`).check();
      await page.getByLabel(`Select ${E2E_HEALTH_UNEXPECTED_MODEL} for a health check`).check();
      await selectProvider(page, E2E_HEALTH_ALIAS_B);
      await page.getByLabel(`Select ${E2E_HEALTH_FAIL_MODEL} for a health check`).check();
      await selectProvider(page, E2E_HEALTH_ALIAS_A);
      await page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`).check();
      await page.getByRole('button', { name: /^Check selected \(\d+\)$/ }).click();

      // All three concurrency slots are busy upstream (held) — including the
      // HTTP-500 model, which counts toward in-flight like any other request —
      // and the fourth is queued in the page, not upstream.
      await expect.poll(async () => (await relayStats()).total).toBe(3);
      await expect.poll(async () => (await relayStats()).in_flight).toBe(3);
      const held = await relayStats();
      expect(held.by_model).toEqual({
        [E2E_HEALTH_OK_2_MODEL]: 1,
        [E2E_HEALTH_UNEXPECTED_MODEL]: 1,
        [E2E_HEALTH_FAIL_MODEL]: 1,
      });

      // SPA navigation unmounts the Models page; the cleanup must abort the
      // batch instead of letting the queued check charge in the background.
      await page.getByRole('link', { name: 'Overview' }).click();
      await page.waitForURL((url) => url.pathname === '/');
      await expect(page.getByText('Bot status')).toBeVisible();

      // While still held, the only way in-flight drops to zero is a real
      // upstream teardown: all three requests saw their connection die before
      // the fixture ever answered, and freed their slots. Natural completion
      // is impossible here, so this is cancellation, not a wait-out.
      await expect.poll(async () => (await relayStats()).in_flight).toBe(0);
      await expect.poll(async () => (await relayStats()).aborted).toBe(3);
      const cancelled = await relayStats();
      expect(cancelled.total).toBe(3);
      expect(cancelled.by_model).toEqual(held.by_model);
      expect(cancelled.records).toHaveLength(3);
      expect(cancelled.records.every((record) => record.aborted)).toBe(true);
      expect(cancelled.rejected).toBe(0);
    } finally {
      await releaseHealthGate();
    }

    // Back on the Models page a fresh check lands in a freed backend slot and
    // completes normally: the queued fourth never sneaked in behind the page's
    // lifetime (health-ok was absent from the cancelled batch).
    await page.getByRole('link', { name: 'Models' }).click();
    await page.waitForURL((url) => url.pathname === '/models');
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    await row.getByRole('button', { name: /check health/i }).click();
    await expect(row.getByText(/^ok$/i)).toBeVisible();
    await expect(row.getByText(/TTFB/)).toBeVisible();
    const after = await relayStats();
    expect(after.total).toBe(4);
    expect(after.by_model).toEqual({
      [E2E_HEALTH_OK_2_MODEL]: 1,
      [E2E_HEALTH_UNEXPECTED_MODEL]: 1,
      [E2E_HEALTH_FAIL_MODEL]: 1,
      [E2E_HEALTH_OK_MODEL]: 1,
    });
    const fresh = after.records.find((record) => record.model === E2E_HEALTH_OK_MODEL);
    expect(fresh, 'the fresh check reached the upstream').toBeDefined();
    expect(fresh?.aborted).toBe(false);
    expect(fresh?.completed).toBe(true);
  });

  test('a reload clears the page-local health results', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    await row.getByRole('button', { name: /check health/i }).click();
    await expect(row.getByText(/^ok$/i)).toBeVisible();

    // Health state is page-local: after a full reload the row starts clean
    // again instead of replaying a stale result.
    await page.reload();
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    const check = modelRow(page, E2E_HEALTH_OK_MODEL).getByRole('button', { name: /check health/i });
    await expect(check).toBeVisible();
    await expect(modelRow(page, E2E_HEALTH_OK_MODEL).getByText(/^ok$/i)).toHaveCount(0);
  });

  test('the health-check endpoint validates its input and reports every outcome on 200', async ({ page }) => {
    // Unknown models and providers are rejected with 4xx, not probed.
    for (const data of [
      { provider: E2E_HEALTH_ALIAS_A, model: 'no-such-model' },
      { provider: 'no-such-provider', model: E2E_HEALTH_OK_MODEL },
    ]) {
      const response = await page.request.post(await adminUrl('/api/providers/health-check'), { data });
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
    }

    // A configured model answers 200 with the full result shape. No If-Match
    // is required — this is a read, not a write.
    const ok = await page.request.post(await adminUrl('/api/providers/health-check'), {
      data: { provider: E2E_HEALTH_ALIAS_A, model: E2E_HEALTH_OK_MODEL },
    });
    expect(ok.status()).toBe(200);
    const okBody = (await ok.json()) as HealthResult;
    expect(okBody).toMatchObject({
      provider: E2E_HEALTH_ALIAS_A,
      model: E2E_HEALTH_OK_MODEL,
      status: 'ok',
      error: null,
    });
    expect(typeof okBody.ttfb_ms).toBe('number');
    expect(typeof okBody.duration_ms).toBe('number');
    expect(okBody.response_text).toBe('ok');

    const unexpected = await page.request.post(await adminUrl('/api/providers/health-check'), {
      data: { provider: E2E_HEALTH_ALIAS_A, model: E2E_HEALTH_UNEXPECTED_MODEL },
    });
    expect(unexpected.status()).toBe(200);
    expect(await unexpected.json()).toMatchObject({ status: 'unexpected_response', response_text: 'hello' });

    // An upstream failure is still a 200, carrying status error and no ttfb.
    const failed = await page.request.post(await adminUrl('/api/providers/health-check'), {
      data: { provider: E2E_HEALTH_ALIAS_B, model: E2E_HEALTH_FAIL_MODEL },
    });
    expect(failed.status()).toBe(200);
    const failedBody = (await failed.json()) as HealthResult;
    expect(failedBody.status).toBe('error');
    expect(failedBody.ttfb_ms).toBeNull();
    expect(typeof failedBody.error).toBe('string');
  });

  test('a checked model with its result fits a narrow phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    await row.getByRole('button', { name: /check health/i }).click();
    await expect(row.getByText(/^ok$/i)).toBeVisible();
    await expect(row.getByText(/ms/)).toBeVisible();

    // The page itself must not scroll sideways; the table scrolls internally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
