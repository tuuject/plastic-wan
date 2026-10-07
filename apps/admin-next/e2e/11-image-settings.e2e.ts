import { expect, test } from '@playwright/test';
import type { ImageConfigView } from '../src/lib/api.ts';
import { adminUrl, authStoragePath } from './helpers.ts';

test.use({ storageState: authStoragePath() });

const capabilities = {
  imageInput: true,
  maxInputImages: 14,
  maxOutputs: 1,
  aspectRatios: ['auto', '1:1', '16:9'],
  resolutionClasses: ['auto'],
};
const endpoint = {
  id: 'nano-banana',
  providerTag: 'google-ai-studio',
  providerName: 'Google AI Studio',
  capabilities,
  unavailableReason: null,
};

test('selects an API model, fills capabilities, saves, and reloads existing configuration without a secret', async ({
  page,
}) => {
  let config: ImageConfigView = {
    revision: 'initial',
    enabled: false,
    credentials: [],
    credential_providers: [],
    models: [],
  };
  const writes: Array<{ enabled: boolean; credentials: Record<string, string>; models: ImageConfigView['models'] }> =
    [];
  await page.route('**/api/image/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/config')) {
      if (route.request().method() === 'PUT') {
        expect(route.request().headers()['if-match']).toBe(config.revision);
        const body = route.request().postDataJSON();
        writes.push(body);
        config = {
          revision: `revision-${writes.length}`,
          enabled: body.enabled,
          credentials: ['openrouter'],
          credential_providers: [],
          models: body.models,
        };
        await route.fulfill({ json: { enabled: true, apply: { applied: ['image'], restart_required: [] } } });
      } else {
        await route.fulfill({ json: config });
      }
    } else if (url.pathname.endsWith('/status')) {
      await route.fulfill({ json: { enabled: config.enabled, models: config.models } });
    } else if (url.pathname.endsWith('/endpoints')) {
      expect(url.searchParams.get('model')).toBe('google/gemini-3.1-flash-image');
      await route.fulfill({ json: { endpoints: [endpoint] } });
    } else {
      await route.fulfill({
        json: {
          models: [
            { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2' },
            { id: 'openai/gpt-image-2', name: 'GPT Image 2' },
          ],
        },
      });
    }
  });
  await page.goto(await adminUrl('/image-settings'));
  await expect(page.getByLabel('Enable image generation')).not.toBeChecked();
  await page.getByLabel('Enable image generation').check();
  await page.getByLabel('API key', { exact: true }).fill('e2e-image-key');
  await page.getByLabel('Search models').fill('banana');
  const picker = page.getByLabel('OpenRouter image model');
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.selectOption('google/gemini-3.1-flash-image');
  await expect(page.getByLabel('Provider')).toHaveValue('google-ai-studio');
  await expect(page.getByText('Up to 14 reference images', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add selected model' }).click();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('Image generation configuration applied')).toBeVisible();
  expect(writes[0]).toMatchObject({
    enabled: true,
    credentials: { openrouter: 'e2e-image-key' },
    models: [
      {
        id: 'nano-banana',
        name: 'Nano Banana 2',
        provider: 'openrouter',
        providerTag: 'google-ai-studio',
        credentialRef: 'openrouter',
        upstreamModel: 'google/gemini-3.1-flash-image',
        capabilities,
      },
    ],
  });
  await page.reload();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove Nano Banana 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]?.credentials).toEqual({});
  expect(writes[1]?.models).toEqual(writes[0]?.models);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('OpenRouter image model')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/plasticwan-image-settings-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: '/tmp/plasticwan-image-settings-desktop.png', fullPage: true });
});

test('keeps per-model description notes while typing, persists them on save, and restores them on reload', async ({
  page,
}) => {
  const gptEndpoint = {
    id: 'gpt-image-2',
    providerTag: 'openai',
    providerName: 'OpenAI',
    capabilities,
    unavailableReason: null,
  };
  let config: ImageConfigView = {
    revision: 'notes',
    enabled: true,
    credentials: ['openrouter'],
    credential_providers: [],
    models: [
      {
        id: 'nano-banana',
        name: 'Nano Banana 2',
        provider: 'openrouter',
        upstreamModel: 'google/gemini-3.1-flash-image',
        credentialRef: 'openrouter',
        providerTag: 'google-ai-studio',
        capabilities,
        description: 'Default model; realistic photos',
      },
    ],
  };
  const writes: Array<{ enabled: boolean; credentials: Record<string, string>; models: ImageConfigView['models'] }> =
    [];
  await page.route('**/api/image/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/config') && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      config = { ...config, revision: `revision-${writes.length}`, models: body.models };
      await route.fulfill({ json: { enabled: true, apply: { applied: ['image'], restart_required: [] } } });
    } else if (path.endsWith('/config')) {
      await route.fulfill({ json: config });
    } else if (path.endsWith('/endpoints')) {
      await route.fulfill({
        json: { endpoints: [url.searchParams.get('model') === 'openai/gpt-image-2' ? gptEndpoint : endpoint] },
      });
    } else if (path.endsWith('/models')) {
      await route.fulfill({
        json: {
          models: [
            { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2' },
            { id: 'openai/gpt-image-2', name: 'GPT Image 2' },
          ],
        },
      });
    } else {
      await route.fulfill({ json: { enabled: config.enabled, models: config.models } });
    }
  });
  await page.goto(await adminUrl('/image-settings'));
  const notes = page.getByLabel('Usage & prompt notes');
  const banana = notes.first();
  await expect(notes).toHaveCount(1);
  await expect(banana).toHaveValue('Default model; realistic photos');
  await expect(banana).toHaveAttribute('maxlength', '1000');

  // Add a second model from the catalog and type its note keystroke by
  // keystroke; the list item must not remount while typing (focus is kept).
  await page.getByLabel('Search models').fill('gpt');
  await page.getByLabel('OpenRouter image model').selectOption('openai/gpt-image-2');
  await expect(page.getByLabel('Provider')).toHaveValue('openai');
  await page.getByRole('button', { name: 'Add selected model' }).click();
  await expect(notes).toHaveCount(2);
  const gpt = notes.nth(1);
  await gpt.click();
  await gpt.pressSequentially('Stylized illustrations; bold colors');
  await expect(gpt).toBeFocused();
  await expect(gpt).toHaveValue('Stylized illustrations; bold colors');

  // Extend the seeded note of the first model, still without losing focus.
  await banana.press('End');
  await banana.pressSequentially('; keep as default');
  await expect(banana).toBeFocused();
  await expect(banana).toHaveValue('Default model; realistic photos; keep as default');

  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.models).toEqual([
    {
      id: 'nano-banana',
      name: 'Nano Banana 2',
      provider: 'openrouter',
      upstreamModel: 'google/gemini-3.1-flash-image',
      credentialRef: 'openrouter',
      providerTag: 'google-ai-studio',
      capabilities,
      description: 'Default model; realistic photos; keep as default',
    },
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-image-2',
      credentialRef: 'openrouter',
      providerTag: 'openai',
      capabilities,
      description: 'Stylized illustrations; bold colors',
    },
  ]);

  // Reload: both notes come back from the saved configuration.
  await page.reload();
  await expect(notes).toHaveCount(2);
  await expect(banana).toHaveValue('Default model; realistic photos; keep as default');
  await expect(gpt).toHaveValue('Stylized illustrations; bold colors');

  // Modify one note and clear the other; an empty note is omitted from the payload.
  await banana.fill('Default model; realistic photos; keep as default; landscape preferred');
  await gpt.fill('');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]?.models).toEqual([
    {
      id: 'nano-banana',
      name: 'Nano Banana 2',
      provider: 'openrouter',
      upstreamModel: 'google/gemini-3.1-flash-image',
      credentialRef: 'openrouter',
      providerTag: 'google-ai-studio',
      capabilities,
      description: 'Default model; realistic photos; keep as default; landscape preferred',
    },
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-image-2',
      credentialRef: 'openrouter',
      providerTag: 'openai',
      capabilities,
    },
  ]);

  // No horizontal overflow with notes on a phone-sized viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(banana).toBeVisible();
  await expect(gpt).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('catalog and endpoint failures are retryable without inventing a model or capabilities', async ({ page }) => {
  let catalogFailed = false;
  let endpointFailed = false;
  await page.route('**/api/image/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) {
      await route.fulfill({
        json: { revision: 'first', enabled: true, credentials: ['openrouter'], credential_providers: [], models: [] },
      });
    } else if (path.endsWith('/status')) {
      await route.fulfill({ json: { enabled: true, models: [] } });
    } else if (path.endsWith('/endpoints')) {
      if (!endpointFailed) {
        endpointFailed = true;
        await route.fulfill({
          status: 502,
          json: { error: 'image_discovery_failed', message: 'Endpoint unavailable' },
        });
      } else {
        await route.fulfill({ json: { endpoints: [endpoint] } });
      }
    } else if (!catalogFailed) {
      catalogFailed = true;
      await route.fulfill({ status: 502, json: { error: 'image_discovery_failed', message: 'Catalog unavailable' } });
    } else {
      await route.fulfill({ json: { models: [{ id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2' }] } });
    }
  });
  await page.goto(await adminUrl('/image-settings'));
  await expect(page.getByRole('alert')).toContainText('Failed to fetch the model list');
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeEnabled();
  await expect(page.getByText('Select a model and click "Add selected model" first')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh model list' }).click();
  await page.getByLabel('OpenRouter image model').selectOption('google/gemini-3.1-flash-image');
  await expect(page.getByRole('alert')).toContainText('Failed to fetch provider information');
  await expect(page.getByRole('button', { name: 'Add selected model' })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry provider lookup' }).click();
  await expect(page.getByRole('button', { name: 'Add selected model' })).toBeEnabled();
});

test('repairs legacy empty credentials and duplicate models using an existing OpenRouter credential', async ({
  page,
}) => {
  const model = {
    id: 'legacy-image',
    name: 'Legacy Image',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
    capabilities,
  };
  const writes: unknown[] = [];
  await page.route('**/api/image/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config') && route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      await route.fulfill({ json: { enabled: true, apply: { applied: ['image'], restart_required: [] } } });
    } else if (path.endsWith('/config')) {
      await route.fulfill({
        json: {
          revision: 'legacy',
          enabled: true,
          credentials: [],
          credential_providers: ['openrouter'],
          models: [model, model],
        },
      });
    } else {
      await route.fulfill({ json: { enabled: false, models: [] } });
    }
  });
  await page.goto(await adminUrl('/image-settings'));
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeEnabled();
  await expect(page.getByLabel('Key source')).toHaveValue('openrouter');
  await expect(page.getByRole('button', { name: 'Remove Legacy Image' })).toHaveCount(1);
  await expect(page.getByText('Merged 1 identical legacy model entries; takes effect on save')).toBeVisible();
  await page.getByRole('button', { name: 'Add credential', exact: true }).click();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    enabled: true,
    credentials: {},
    credential_sources: { openrouter: 'openrouter' },
    models: [model],
  });
});

test('missing credentials give a visible actionable error and do not send an invalid save', async ({ page }) => {
  let writes = 0;
  const model = {
    id: 'legacy-image',
    name: 'Legacy Image',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
    capabilities,
  };
  await page.route('**/api/image/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PUT') {
      writes += 1;
    }
    await route.fulfill({
      json: path.endsWith('/config')
        ? { revision: 'missing-key', enabled: true, credentials: [], credential_providers: [], models: [model] }
        : { enabled: false, models: [] },
    });
  });
  await page.goto(await adminUrl('/image-settings'));
  const save = page.getByRole('button', { name: 'Save and apply' });
  await expect(save).toBeEnabled();
  await expect(page.locator('#image-save-requirements')).toContainText(
    'Credential openrouter has no API key configured',
  );
  await save.click();
  await expect(page.locator('[data-sonner-toast]')).toContainText('has no API key configured');
  expect(writes).toBe(0);
  await page.getByLabel('Enable image generation').uncheck();
  await save.click();
  await expect.poll(() => writes).toBe(1);
});
