import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigSchema } from '../src/platform/config.ts';

export const repositoryRoot = resolve(import.meta.dirname, '..');
export const docsRoot = resolve(repositoryRoot, 'apps/docs');
export const exampleNames = ['config.example.jsonc', 'system-prompt.example.md', 'docker-compose.yml'] as const;

// The Compose template lives at the repository root so README and the docs site
// share a single deployment file; every other example lives in apps/docs/examples.
export function exampleSource(name: (typeof exampleNames)[number]): string {
  return name === 'docker-compose.yml' ? resolve(repositoryRoot, name) : resolve(docsRoot, 'examples', name);
}

interface SchemaNode {
  type?: string;
  const?: unknown;
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  required?: string[] | undefined;
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  uniqueItems?: boolean;
}

function typeLabel(schema: SchemaNode): string {
  if ('const' in schema) {
    return JSON.stringify(schema.const);
  }
  if (schema.anyOf) {
    return schema.anyOf.map(typeLabel).join(' / ');
  }
  if (!schema.type) {
    throw new Error('Unsupported configuration schema node');
  }
  return schema.type;
}

export function renderConfigFields(): string {
  const lines = [
    '---',
    'title: 配置字段参考',
    'description: 从当前源码 ConfigSchema 生成的字段类型、必填性与取值限制。',
    'editLink: false',
    'lastUpdated: false',
    '---',
    '',
    '# 配置字段参考',
    '',
    '本页由同一提交的 ConfigSchema 自动生成。**必填是相对于所在对象而言**；可选对象未启用时不要求它的子字段。',
    '可选不等于有默认值，类型合法也不等于通过跨字段语义校验。默认行为、热更新与覆盖关系请读[配置说明](config.md)。',
    '',
    '[下载 JSON Schema](__DOCS_BASE__/config.schema.json)。日常配置优先从[完整示例](../configure/config-file.md)开始。',
    '',
  ];
  function walk(schema: SchemaNode, name: string, required: boolean, depth: number): void {
    if (name) {
      const constraints = [
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'minLength',
        'minItems',
        'maxItems',
        'pattern',
        'uniqueItems',
      ] as const;
      const limits = constraints
        .filter((key) => schema[key] !== undefined)
        .map((key) => `${key}: ${JSON.stringify(schema[key])}`);
      lines.push(
        `${'#'.repeat(Math.min(depth + 1, 4))} \`${name}\``,
        '',
        `类型：\`${typeLabel(schema)}\`；${required ? '必填' : '可选'}。`,
        '',
      );
      if (limits.length) {
        lines.push(`限制：${limits.map((limit) => `\`${limit}\``).join('，')}。`, '');
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      walk(child, name ? `${name}.${key}` : key, schema.required?.includes(key) ?? false, depth + 1);
    }
    for (const child of Object.values(schema.patternProperties ?? {})) {
      walk(child, `${name}.<名称>`, false, depth + 1);
    }
    if (schema.items) {
      walk(schema.items, `${name}[]`, true, depth + 1);
    }
    for (const [index, child] of (schema.anyOf ?? []).entries()) {
      if (child.type === 'object') {
        walk(child, `${name}（分支 ${index + 1}）`, required, depth + 1);
      }
    }
  }
  walk(ConfigSchema, '', true, 0);
  return `${lines.join('\n')}\n`;
}

export function deploymentSettings(env: NodeJS.ProcessEnv): { siteOrigin: string; base: string } {
  const siteOrigin = env.DOCS_SITE_ORIGIN ?? '';
  const base = env.DOCS_BASE_PATH ?? '/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
    throw new Error('DOCS_BASE_PATH must be / or slash-delimited URL segments ending in /');
  }
  if (siteOrigin) {
    const url = new URL(siteOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== siteOrigin) {
      throw new Error('DOCS_SITE_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment');
    }
  }
  return { siteOrigin, base };
}

export async function prepareDocs(): Promise<void> {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('A full Git commit is required for documentation provenance');
  }
  const publicRoot = resolve(docsRoot, 'content/public');
  const fieldsPath = resolve(docsRoot, 'content/docs/reference');
  await mkdir(resolve(publicRoot, 'examples'), { recursive: true });
  await mkdir(fieldsPath, { recursive: true });
  await writeFile(
    resolve(publicRoot, 'build-info.json'),
    `${JSON.stringify({ commit, dirty, ...deploymentSettings(process.env) }, null, 2)}\n`,
  );
  await writeFile(resolve(publicRoot, 'config.schema.json'), `${JSON.stringify(ConfigSchema, null, 2)}\n`);
  await writeFile(resolve(fieldsPath, 'fields.md'), renderConfigFields());
  for (const name of exampleNames) {
    await copyFile(exampleSource(name), resolve(publicRoot, 'examples', name));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareDocs();
}
