import { expect, test } from '@playwright/test';
import { adminUrl, appliedToast, authStoragePath } from './helpers.ts';
import {
  E2E_BUILTIN_ALIAS,
  E2E_RELAY_ALIAS,
  E2E_RELAY_COMPLETE_MODEL,
  E2E_RELAY_INCOMPLETE_MODEL,
  E2E_RELAY_MANUAL_MODEL,
  E2E_SECRETS,
} from './models-fixture.ts';

/**
 * The Models page against the real `AdminServer`: provider list and detail,
 * write-only credentials, the discovery dialog (saved mode against a loopback
 * upstream started by `e2e/server.ts`), manual metadata lookup, and the
 * global restart banner. Every write goes through the UI and is verified
 * against the API afterwards.
 */
test.use({ storageState: authStoragePath() });

test.describe('models page', () => {
  test('renders the provider list, the model table and the write-only key field', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await expect(page.getByText('Providers')).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` })).toBeVisible();
    await expect(page.getByText('Agent in use').first()).toBeVisible();

    // Builtin providers show Pi's address read-only and only allow the key to change.
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    await expect(page.getByText('https://openrouter.ai/api/v1')).toBeVisible();
    const keyInput = page.getByLabel('API Key', { exact: true });
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    await expect(keyInput).toHaveValue('');
    await expect(page.getByText('Set - leave empty to keep it')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('never renders a configured secret, and the API never returns one', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    const secrets = [...Object.values(E2E_SECRETS), 'telegram-secret', 'agent-secret', 'vision-secret'];
    for (const alias of [E2E_BUILTIN_ALIAS, E2E_RELAY_ALIAS, 'agent', 'vision']) {
      await page.getByRole('button', { name: `Provider ${alias}` }).click();
      await expect(page.getByLabel('API Key', { exact: true })).toBeVisible();
      const html = await page.content();
      for (const secret of secrets) {
        expect(html, `${alias} connection card leaked ${secret}`).not.toContain(secret);
      }
    }

    // Header names are shown; header values never are.
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await expect(page.locator('#provider-header-name-0')).toHaveValue('x-relay-token');
    await expect(page.locator('#provider-header-value-0')).toHaveValue('');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const serialized = JSON.stringify(view);
    for (const secret of Object.values(E2E_SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(view.providers.map((provider: { alias: string }) => provider.alias)).toContain(E2E_RELAY_ALIAS);
  });

  test('saving a builtin key applies it without a restart', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    await page.getByLabel('API Key', { exact: true }).fill('e2e-rotated-builtin-key');
    await page.getByRole('button', { name: 'Save' }).click();

    // The rotated key is applied to the running process right away.
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(view.supervised).toBe(true);
    // No provider field waits for a restart. (Settings-side restart-only fields
    // such as `admin.port` may still be pending from earlier specs.)
    expect(view.restart_required.filter((path: string) => path.startsWith('providers.'))).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('e2e-rotated-builtin-key');

    // The applied connection is live in the running registry, so the discovery
    // dialog opens in saved mode instead of demanding the key again.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await expect(page.getByRole('button', { name: 'Use temporary mode (key from this form)' })).toBeVisible();
    await expect(page.locator('#picker-api-key')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('discovery resolves metadata from the local upstream and blocks unconfirmed drafts', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Fetch models' }).click();

    // Saved mode: the running registry's connection, which points at the loopback upstream.
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByText('endpoint:')).toBeVisible();

    const completeRow = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    const incompleteRow = page.locator('li').filter({ hasText: E2E_RELAY_INCOMPLETE_MODEL });
    await expect(completeRow).toBeVisible();
    await expect(incompleteRow).toBeVisible();
    // models.dev lists a toggle plus three efforts for the known model.
    await expect(completeRow.getByText('off / low / high / max')).toBeVisible();
    // The relay's own host is unknown to models.dev, so even the model it does
    // know was matched under another provider and has to be confirmed.
    await expect(completeRow.getByText('to confirm', { exact: false })).toBeVisible();
    // Every field of the second model is missing, so it cannot be taken as it is.
    await expect(incompleteRow.getByText('to confirm', { exact: false })).toBeVisible();

    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await page.getByLabel(`Select ${E2E_RELAY_INCOMPLETE_MODEL}`).check();
    await expect(page.getByRole('button', { name: /Add \d+ models/ })).toBeDisabled();

    // Accepting the listed values covers the draft that has them all; the one
    // with empty fields still has to go through the dialog.
    await page.getByRole('button', { name: 'Accept listed values (1)' }).click();
    await expect(completeRow.getByText('Confirmed')).toBeVisible();
    await expect(page.getByRole('button', { name: /Add \d+ models/ })).toBeDisabled();

    await incompleteRow.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Confirm or fill in:', { exact: false })).toBeVisible();
    await page.locator('#model-context').fill('64000');
    await page.locator('#model-max-tokens').fill('8192');
    await page.locator('#model-input-text').check();
    await page.locator('#model-cost-input').fill('0.1');
    await page.locator('#model-cost-output').fill('0.2');
    await page.locator('#model-cost-cache_read').fill('0');
    await page.locator('#model-cost-cache_write').fill('0');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(incompleteRow.getByText('Confirmed')).toBeVisible();
    await page.getByRole('button', { name: /Add \d+ models/ }).click();
    await expect(appliedToast(page).first()).toBeVisible();

    // The write went through the real server: both models are in the file now.
    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.models.map((model: { id: string }) => model.id)).toEqual(
      expect.arrayContaining([E2E_RELAY_COMPLETE_MODEL, E2E_RELAY_INCOMPLETE_MODEL]),
    );
    const complete = relay.models.find((model: { id: string }) => model.id === E2E_RELAY_COMPLETE_MODEL);
    expect(complete.thinking_levels).toEqual(['off', 'low', 'high', 'max']);
    await expect(page.locator('table tbody tr', { hasText: E2E_RELAY_COMPLETE_MODEL })).toBeVisible();
  });

  test('switching the agent resets its thinking effort, which the In use panel then sets', async ({ page }) => {
    const agentOf = async (): Promise<{ provider: string; model: string; thinking_level: string }> =>
      (await (await page.request.get(await adminUrl('/api/providers'))).json()).agent;
    await page.goto(await adminUrl('/models'));
    // "In use" also names a table column and a provider badge, so the panel is
    // found by the one control only it has.
    const effort = page.getByRole('combobox', { name: 'Thinking effort' });
    const inUse = page.locator('[data-slot="card"]', { has: effort });

    // Added by the discovery test with the levels models.dev listed.
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page
      .locator('tr', { hasText: E2E_RELAY_COMPLETE_MODEL })
      .getByRole('button', { name: 'Set as agent' })
      .click();
    await expect(page.getByText('Thinking effort reset to off', { exact: false }).first()).toBeVisible();
    await expect(inUse.getByText(`${E2E_RELAY_ALIAS} / ${E2E_RELAY_COMPLETE_MODEL}`)).toBeVisible();
    await expect(effort).toHaveText('off');
    expect(await agentOf()).toMatchObject({ model: E2E_RELAY_COMPLETE_MODEL, thinking_level: 'off' });

    // Only the levels the model declares are offered.
    await effort.click();
    await expect(page.getByRole('option')).toHaveText(['off', 'low', 'high', 'max']);
    await page.getByRole('option', { name: 'max' }).click();
    await expect(effort).toHaveText('max');
    expect(await agentOf()).toMatchObject({ model: E2E_RELAY_COMPLETE_MODEL, thinking_level: 'max' });

    // Put the fixture agent back for the tests that follow.
    await page.getByRole('button', { name: 'Provider agent' }).click();
    await page.locator('tr', { hasText: 'agent-model' }).getByRole('button', { name: 'Set as agent' }).click();
    await expect(inUse.getByText('agent / agent-model')).toBeVisible();
    expect(await agentOf()).toMatchObject({ provider: 'agent', model: 'agent-model', thinking_level: 'off' });
  });

  test('declares thinking levels in the edit dialog only for a reasoning model', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Edit relay-existing-model' }).click();

    // Not a reasoning model: there are no levels to declare.
    await expect(page.locator('#model-thinking-off')).toHaveCount(0);
    await page.locator('#model-reasoning').check();
    await page.locator('#model-thinking-low').check();
    await page.locator('#model-thinking-xhigh').check();
    await page.getByRole('button', { name: 'Save' }).click();
    // The toast only appears once the write and the reload succeeded.
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const edited = relay.models.find((model: { id: string }) => model.id === 'relay-existing-model');
    expect(edited).toMatchObject({ reasoning: true, thinking_levels: ['low', 'xhigh'] });
  });

  test('adds a model by id through lookup-metadata', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: 'Add by id' }).click();
    await page.getByLabel('Model ids (one per line, or comma separated)').fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: 'Look up metadata' }).click();

    // A single id opens the edit dialog straight away: the metadata comes from
    // models.dev and is confirmed there before anything is written.
    await expect(page.getByText('Confirm relay-manual-model')).toBeVisible();
    await expect(page.locator('#model-context')).toHaveValue('64000');
    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.locator('li').filter({ hasText: E2E_RELAY_MANUAL_MODEL });
    await expect(row.getByText('Confirmed')).toBeVisible();
    await page.getByRole('button', { name: 'Add 1 model' }).click();
    await expect(appliedToast(page).first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.models.map((model: { id: string }) => model.id)).toContain(E2E_RELAY_MANUAL_MODEL);
  });

  test('creates a custom provider through the wizard and applies it immediately', async ({ page }) => {
    // The wizard has to reach the same loopback upstream as the relay provider.
    const before = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relayBaseUrl = before.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS)
      .base_url as string;

    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: 'New provider' }).click();

    await page.locator('#wizard-kind').click();
    await page.getByRole('option', { name: /custom/ }).click();
    await page.locator('#wizard-alias').fill('relay2');
    await page.locator('#wizard-base-url').fill(relayBaseUrl);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('#wizard-api-key').fill(E2E_SECRETS.wizard);
    await page.getByRole('button', { name: 'Next' }).click();

    // The provider is not saved yet, so the listing is fetched in temporary mode
    // with the key that was just typed.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    const row = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    await expect(row).toBeVisible();
    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await page.getByRole('button', { name: 'Accept listed values (1)' }).click();
    await page.getByRole('button', { name: 'Create provider' }).click();

    // A create is applied immediately like every other write: the wizard closes
    // and the new provider is selected in the list.
    await expect(appliedToast(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Provider relay2' })).toBeVisible();

    // The running registry already knows the new connection, so saved-mode
    // discovery fetches the listing without asking for the key again.
    await page.getByRole('button', { name: 'Fetch models' }).click();
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByText('endpoint:')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // The fetched model can be set as the agent model right away.
    await page
      .locator('tr', { hasText: E2E_RELAY_COMPLETE_MODEL })
      .getByRole('button', { name: 'Set as agent' })
      .click();
    await expect(page.getByText('Thinking effort reset to off', { exact: false }).first()).toBeVisible();

    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const created = after.providers.find((provider: { alias: string }) => provider.alias === 'relay2');
    expect(created.models.map((model: { id: string }) => model.id)).toEqual([E2E_RELAY_COMPLETE_MODEL]);
    expect(after.agent).toMatchObject({ provider: 'relay2', model: E2E_RELAY_COMPLETE_MODEL });
    expect(after.restart_required.filter((path: string) => path.startsWith('providers.'))).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(E2E_SECRETS.wizard);
  });

  test('refuses to create a provider while a header row has no value', async ({ page }) => {
    const before = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relayBaseUrl = before.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS)
      .base_url as string;

    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: 'New provider' }).click();

    await page.locator('#wizard-kind').click();
    await page.getByRole('option', { name: /custom/ }).click();
    await page.locator('#wizard-alias').fill('relay3');
    await page.locator('#wizard-base-url').fill(relayBaseUrl);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('#wizard-api-key').fill(E2E_SECRETS.wizard);
    await page.getByRole('button', { name: 'Add header' }).click();
    await page.locator('#wizard-header-name-0').fill('x-extra');
    await page.getByRole('button', { name: 'Next' }).click();

    // Metadata lookup never sends headers, so the incomplete row survives until
    // the submit — where it must be reported instead of silently dropped.
    await page.getByLabel('Or enter model ids by hand (one per line, or comma separated)').fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: 'Look up metadata' }).click();
    await page.getByLabel(`Select ${E2E_RELAY_MANUAL_MODEL}`).check();
    await page.getByRole('button', { name: 'Accept listed values (1)' }).click();
    await page.getByRole('button', { name: 'Create provider' }).click();

    await expect(page.getByText('Header x-extra needs a value')).toBeVisible();
    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(after.providers.map((provider: { alias: string }) => provider.alias)).not.toContain('relay3');
  });

  test('a header name can be typed key by key without losing focus', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByRole('button', { name: 'Add header' }).click();
    // The row used to be keyed by its own name, so every keystroke remounted it
    // and dropped the focus after the first character.
    await page.locator('#provider-header-name-1').pressSequentially('x-typed');
    await expect(page.locator('#provider-header-name-1')).toHaveValue('x-typed');
  });

  test('a model edit that loses a revision race is closed instead of overwriting', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByRole('button', { name: 'Edit relay-existing-model' }).click();
    await expect(page.locator('#model-context')).toBeVisible();

    // Another admin renames the model while this form is open.
    await page.evaluate(async (alias) => {
      const view = await (await fetch('/api/providers')).json();
      const provider = view.providers.find((candidate: { alias: string }) => candidate.alias === alias);
      const model = provider.models.find((candidate: { id: string }) => candidate.id === 'relay-existing-model');
      const response = await fetch(`/api/providers/${alias}/models/relay-existing-model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify({ ...model, name: 'Renamed elsewhere' }),
      });
      if (!response.ok) {
        throw new Error(`concurrent write failed: ${response.status}`);
      }
    }, E2E_RELAY_ALIAS);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Nothing was saved - open the model again')).toBeVisible();
    await expect(page.locator('#model-context')).toHaveCount(0);

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    const model = relay.models.find((candidate: { id: string }) => candidate.id === 'relay-existing-model');
    expect(model.name).toBe('Renamed elsewhere');
  });

  test('a connection edit built on an old revision cannot delete a header added meanwhile', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('e2e-stale-draft-key');

    // Another admin adds a header while this card holds a draft.
    await page.evaluate(async (alias) => {
      const view = await (await fetch('/api/providers')).json();
      const response = await fetch(`/api/providers/${alias}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify({ headers: { 'x-added-elsewhere': 'value' } }),
      });
      if (!response.ok) {
        throw new Error(`concurrent write failed: ${response.status}`);
      }
    }, E2E_RELAY_ALIAS);

    // The save is refused on its old revision; the refresh then marks the draft
    // stale and blocks another attempt until it is reloaded.
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('config.jsonc changed since you started editing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('#provider-header-name-1')).toHaveValue('x-added-elsewhere');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.header_names).toContain('x-added-elsewhere');
  });
});
