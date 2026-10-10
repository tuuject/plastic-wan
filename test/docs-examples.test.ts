import { afterAll, expect, test } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { deploymentSettings, docsRoot, renderConfigFields } from '../scripts/docs-prepare.ts';
import { loadConfig, plaintextSecrets } from '../src/platform/config.ts';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

function parseExample(text: string): unknown {
  const errors: ParseError[] = [];
  const result: unknown = parse(text, errors, { allowTrailingComma: true });
  expect(errors).toEqual([]);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) {
    return patch;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = merge(base[key], value);
  }
  return result;
}

async function fixture(): Promise<{ directory: string; configPath: string; baseline: unknown }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-docs-'));
  directories.push(directory);
  await copyFile(resolve(docsRoot, 'examples/system-prompt.example.md'), join(directory, 'system-prompt.md'));
  await mkdir(join(directory, 'prompts'));
  for (const name of ['system', 'group', 'social']) {
    await writeFile(join(directory, `prompts/${name}.md`), 'Synthetic documentation test prompt.');
  }
  return {
    directory,
    configPath: join(directory, 'config.jsonc'),
    baseline: parseExample(await readFile(resolve(docsRoot, 'examples/config.example.jsonc'), 'utf8')),
  };
}

test('public full example passes the real loader without resolving credentials or contacting services', async () => {
  const { configPath, baseline } = await fixture();
  expect(plaintextSecrets(baseline)).toEqual([]);
  await writeFile(configPath, JSON.stringify(baseline));
  const loaded = await loadConfig(configPath);
  expect(loaded.config.telegram.token).toEqual({ env: 'TELEGRAM_BOT_TOKEN' });
  expect(loaded.config.agent.system_prompt).not.toBe('');
  expect(loaded.config.vision.model).toBe(loaded.config.agent.model);
  expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
});

test('every hand-written JSONC fragment merges into the public baseline and passes semantic validation', async () => {
  const { configPath, baseline } = await fixture();
  const root = resolve(docsRoot, 'content/docs');
  const pages = (await readdir(root, { recursive: true })).filter(
    (path) => path.endsWith('.md') && !path.endsWith('fields.md'),
  );
  let checked = 0;
  for (const page of pages) {
    const text = await readFile(join(root, page), 'utf8');
    for (const match of text.matchAll(/```jsonc\r?\n([\s\S]*?)\r?\n```/g)) {
      const combined = merge(baseline, parseExample(match[1] ?? ''));
      expect(plaintextSecrets(combined), page).toEqual([]);
      await writeFile(configPath, JSON.stringify(combined));
      await expect(loadConfig(configPath), page).resolves.toHaveProperty('hash');
      checked++;
    }
  }
  expect(checked).toBeGreaterThanOrEqual(12);
});

test('schema reference covers nested arrays, union policies and required/optional distinctions', () => {
  const fields = renderConfigFields();
  for (const name of [
    'telegram.chats[].topic_ids',
    'tool_policies[].name',
    'agent.context.ref_ttl_hours',
    'retention.online_days',
    'web_fetch',
    'developer.record_model_payloads',
  ]) {
    expect(fields).toContain(name);
  }
  expect(fields).toContain('可选不等于有默认值');
  expect(fields).toContain('exclusiveMinimum');
  expect(fields).not.toContain('undefined');
});

test('deployment URL settings reject credentials and malformed base paths', () => {
  expect(deploymentSettings({})).toEqual({ siteOrigin: '', base: '/' });
  expect(deploymentSettings({ DOCS_SITE_ORIGIN: 'https://docs.example.com', DOCS_BASE_PATH: '/surowan/' })).toEqual(
    { siteOrigin: 'https://docs.example.com', base: '/surowan/' },
  );
  for (const origin of [
    'https://user:pass@docs.example.com',
    'https://docs.example.com/a',
    'https://docs.example.com?key=example',
    'file:///tmp',
    'not-a-url',
  ]) {
    expect(() => deploymentSettings({ DOCS_SITE_ORIGIN: origin })).toThrow();
  }
  for (const base of ['relative/', '/no-trailing-slash', '//', '/../', '/a?b/']) {
    expect(() => deploymentSettings({ DOCS_BASE_PATH: base })).toThrow();
  }
});
