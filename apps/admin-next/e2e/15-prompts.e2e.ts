import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';

/**
 * The Prompts page drives the versioned prompt API against the real config
 * files: edit → save/apply, version history, unified diff and restore. The
 * seeded config starts with the helper defaults: global prompt
 * "Participate safely." and chat 123456789 instructions "private".
 */
test.use({ storageState: authStoragePath() });

const GLOBAL_START = 'Participate safely.';
const SAVED_MESSAGE =
  'The prompt applies from the next invocation; affected Conversation Contexts rebuild on their next run.';

test.describe('prompts page', () => {
  test('renders the editor, the starting external version and the sidebar entry', async ({ page }) => {
    const finish = watchPageIssues(page);
    await page.goto(await adminUrl('/prompts'));
    await expect(page.getByText('Prompt editor')).toBeVisible();
    await expect(page.locator('#prompt-text')).toHaveValue(GLOBAL_START);
    await expect(
      page.getByText('Applies from the next invocation; affected Conversation Contexts rebuild on their next run.'),
    ).toBeVisible();
    await expect(page.getByText('Version history')).toBeVisible();
    await expect(page.getByText('The latest 100 versions per scope are kept.')).toBeVisible();
    await expect(page.getByText('Applied').first()).toBeVisible();
    const row = page.locator('table tbody tr').first();
    await expect(row).toContainText('v1');
    await expect(row).toContainText('External');

    // The sidebar entry leads back to the page.
    await page.goto(await adminUrl('/'));
    await page.getByRole('link', { name: 'Prompts' }).click();
    await expect(page.getByText('Prompt editor')).toBeVisible();
    const issues = finish();
    expect(issues.pageErrors).toEqual([]);
    expect(issues.consoleErrors).toEqual([]);
  });

  test('saving a changed global prompt records a version, renders the diff and restores', async ({ page }) => {
    await page.goto(await adminUrl('/prompts'));
    const editor = page.locator('#prompt-text');
    await expect(editor).toHaveValue(GLOBAL_START);
    await editor.fill('Participate warmly and concisely.');
    await page.locator('#prompt-note').fill('e2e tune');
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect(page.getByText(SAVED_MESSAGE)).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(2);
    const newest = page.locator('table tbody tr').first();
    await expect(newest).toContainText('v2');
    await expect(newest).toContainText('Panel');
    await expect(newest).toContainText('e2e tune');

    // The compare defaults are previous → newest; the diff shows both lines.
    await page.getByRole('button', { name: 'Compare' }).click();
    await expect(page.getByText('v1 → v2')).toBeVisible();
    // A diff row renders both line-number gutters and the +/- marker around
    // the text, so assert containment instead of the exact text.
    await expect(page.locator('[data-line-type="removed"]')).toContainText(GLOBAL_START);
    await expect(page.locator('[data-line-type="added"]')).toContainText('Participate warmly and concisely.');

    // Restoring appends a rollback version and reverts the file.
    await page.locator('table tbody tr', { hasText: 'v1' }).getByRole('button', { name: 'Restore' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Restore version 1?');
    await confirm.getByRole('button', { name: 'Restore version' }).click();
    await expect(editor).toHaveValue(GLOBAL_START);
    await expect(page.locator('table tbody tr')).toHaveCount(3);
    await expect(page.locator('table tbody tr').first()).toContainText('Rollback');
    await expect(page.locator('table tbody tr').first()).toContainText('Restored from version 1');
  });

  test('the group scope edits the chat prompt and records its own history', async ({ page }) => {
    // Earlier specs rebuild the baseline Chat without instructions, so the
    // group prompt may legitimately start empty; assert relative to that.
    const before = await (
      await page.request.get(await adminUrl('/api/prompts/group?chat=123456789&source=file'))
    ).json();
    await page.goto(await adminUrl('/prompts'));
    await page.getByRole('combobox', { name: 'Scope' }).click();
    await page.getByRole('option', { name: /123456789/ }).click();
    // The scope select commits before the editor re-seeds from the group file.
    await expect(page.getByRole('combobox', { name: 'Scope' })).toContainText('123456789');
    const editor = page.locator('#prompt-text');
    await expect(editor).toHaveValue(before.prompt);

    const rowsBefore = await page.locator('table tbody tr').count();
    await editor.fill('Group prompt from e2e');
    await page.locator('#prompt-note').fill('e2e group');
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect(page.getByText(SAVED_MESSAGE)).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(rowsBefore + 1);
    const newest = page.locator('table tbody tr').first();
    await expect(newest).toContainText('Panel');
    await expect(newest).toContainText('e2e group');

    // Switching back to the global scope restores its own draft and history.
    await page.getByRole('combobox', { name: 'Scope' }).click();
    await page.getByRole('option', { name: 'Global prompt' }).click();
    await expect(page.locator('#prompt-text')).toHaveValue(GLOBAL_START);
    await expect(page.locator('table tbody tr')).toHaveCount(3);
  });
});
