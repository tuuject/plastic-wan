import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Type from 'typebox';
import { Value } from 'typebox/value';
import { ConfigSchema } from '../src/platform/config.ts';
import { CODE_BLOCK_PATTERN } from './docs-markdown.ts';
import { deploymentSettings, docsRoot, exampleNames, exampleSource, repositoryRoot } from './docs-prepare.ts';

const dist = resolve(docsRoot, 'dist');
const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((file) => file.isFile())
  .map((file) => resolve(file.parentPath, file.name));
const fileSet = new Set(files);
const read = (path: string): Promise<string> => readFile(resolve(dist, path), 'utf8');
const metadata: unknown = JSON.parse(await read('build-info.json'));
const metadataSchema = Type.Object(
  {
    commit: Type.String({ pattern: '^[a-f0-9]{40}$' }),
    dirty: Type.Boolean(),
    siteOrigin: Type.String(),
    base: Type.String(),
  },
  { additionalProperties: false },
);
assert(Value.Check(metadataSchema, metadata), 'Invalid build-info.json');
const { commit, dirty, base, siteOrigin } = metadata;
deploymentSettings({ DOCS_SITE_ORIGIN: siteOrigin, DOCS_BASE_PATH: base });
assert.equal(
  commit,
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  'Build SHA is stale',
);
assert.deepEqual(
  JSON.parse(await read('config.schema.json')),
  JSON.parse(JSON.stringify(ConfigSchema)),
  'Schema is stale',
);
for (const name of exampleNames) {
  assert.equal(await read(`examples/${name}`), await readFile(exampleSource(name), 'utf8'), `Stale example: ${name}`);
}

const origin = siteOrigin || 'https://docs.invalid';
const localPaths = new Set<string>();
function checkLink(href: string, source: string): void {
  if (/^(?:#|mailto:|data:)/.test(href)) {
    return;
  }
  const url = new URL(href.replaceAll('&amp;', '&'), `${origin}${base}${source}`);
  if (url.origin !== origin) {
    return;
  }
  assert(url.pathname.startsWith(base), `Link lost base in ${source}: ${href}`);
  let path = decodeURIComponent(url.pathname.slice(base.length));
  if (!path || path.endsWith('/')) {
    path += 'index.html';
  }
  assert(fileSet.has(resolve(dist, path)), `Missing static target in ${source}: ${href}`);
  localPaths.add(path);
}

const contentRoot = resolve(docsRoot, 'content');
const pages = (await readdir(contentRoot, { recursive: true }))
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => path.endsWith('.md') && !path.startsWith('public/'));
const index = await read('llms.txt');
const bundle = await read('llms-full.txt');
for (const text of [index, bundle]) {
  assert(text.includes(commit), 'Missing provenance in llms output');
  assert(!/<(?:!doctype|html|script)\b/i.test(text), 'HTML leaked into llms output');
}
for (const page of pages) {
  const source = await readFile(resolve(contentRoot, page), 'utf8');
  assert(/^title: .+$/m.test(source) && /^description: .+$/m.test(source), `Missing frontmatter: ${page}`);
  const markdown = await read(page);
  const htmlPath = page.replace(/\.md$/, '.html');
  const html = await read(htmlPath);
  assert.equal(
    [...markdown.replace(CODE_BLOCK_PATTERN, '').matchAll(/^# .+$/gm)].length,
    1,
    `Expected one Markdown H1: ${page}`,
  );
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `Expected one HTML H1: ${page}`);
  for (const text of [markdown, html]) {
    assert(text.includes(commit), `Missing provenance: ${page}`);
    assert.equal(text.includes('（含未提交修改，仅供本地预览）'), dirty, `Wrong dirty marker: ${page}`);
    assert.equal(text.split('文档对应源码提交：').length - 1, 1, `Duplicate provenance: ${page}`);
  }
  assert(!/<(?:!doctype|html|script)\b/i.test(markdown), `HTML leaked into Markdown: ${page}`);
  if (page !== 'index.md') {
    const generated = page === 'docs/reference/fields.md';
    assert.equal(html.includes('rp-edit-link'), !generated, `Wrong edit-link visibility: ${page}`);
    if (generated) {
      assert(!html.includes('rp-last-updated'), 'Generated reference must not show a Git timestamp');
    }
  }
  for (const match of source.matchAll(CODE_BLOCK_PATTERN)) {
    assert(
      markdown.includes((match[2] ?? '').replaceAll('\r\n', '\n')),
      `Code block lost during Markdown rendering: ${page}`,
    );
  }
  for (const match of markdown.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    checkLink(match[1] ?? '', page);
  }
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    checkLink(match[1] ?? '', htmlPath);
  }
  if (page !== 'index.md') {
    assert(index.includes(`${siteOrigin}${base}${page}`), `Page missing from llms.txt: ${page}`);
    assert(bundle.includes(markdown.trim()), `Page missing from llms-full.txt: ${page}`);
  }
  localPaths.add(page);
  localPaths.add(htmlPath);
}
for (const [source, text] of [
  ['llms.txt', index],
  ['llms-full.txt', bundle],
] as const) {
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    checkLink(match[1] ?? '', source);
  }
}
assert((await read('index.md')).includes('虚构示意'), 'Homepage custom content missing from Markdown');

const searchFiles = files.filter((file) => /search_index\.zh\.[^/\\]+\.json$/.test(file));
assert.equal(searchFiles.length, 1, 'Expected one Chinese search index');
const searchText = await readFile(searchFiles[0] ?? '', 'utf8');
const searchData: unknown = JSON.parse(searchText);
const searchSchema = Type.Array(
  Type.Object({ routePath: Type.String(), title: Type.String(), content: Type.String() }),
);
assert(Value.Check(searchSchema, searchData), 'Invalid search index');
for (const page of searchData) {
  checkLink(page.routePath.startsWith('/') ? `${base}${page.routePath.slice(1)}` : page.routePath, 'index.html');
}
for (const term of ['人格', '预算', '不回复', 'online_days']) {
  assert(searchText.includes(term), `Search content missing ${term}`);
}
for (const file of files) {
  assert(
    !/(?:^|[/\\])(?:agent-doc|dev-data|node_modules|\.git|\.env|key\.json)(?:[/\\]|$)|\.sqlite(?:-|$)|\.map$/.test(
      file,
    ),
    `Private artifact: ${file}`,
  );
  if (/\.(?:html|md|txt|json|js|css)$/.test(file)) {
    const text = await readFile(file, 'utf8');
    assert(!text.includes('__DOCS_BASE__'), `Unresolved public-resource prefix: ${file}`);
    assert(
      !/(?:[A-Z]:[\\/](?:Users|Projects)[\\/]|\/Users\/|\/home\/(?:runner|[^/]+)\/)/.test(text),
      `Build-machine path leaked: ${file}`,
    );
  }
}

// Use the same native preview as docs:preview, not a test server that hides host behavior.
process.chdir(docsRoot);
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
delete process.env.PORT;
const docsRequire = createRequire(resolve(docsRoot, 'package.json'));
const { serve } = await import(pathToFileURL(docsRequire.resolve('@rspress/core/dist/index.js')).href);
const { loadConfigFile } = await import(
  pathToFileURL(docsRequire.resolve('@rspress/core/dist/config/loadConfigFile.js')).href
);
const preview = await serve({ config: await loadConfigFile(), host: '127.0.0.1', port: 5276 });
try {
  for (const path of ['llms.txt', 'llms-full.txt', 'build-info.json', 'config.schema.json']) {
    localPaths.add(path);
  }
  for (const path of localPaths) {
    const response = await fetch(`${preview.urls[0]}${base}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `HTTP failed: ${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, await readFile(resolve(dist, path)), `Response differs from artifact: ${path}`);
    const type = response.headers.get('content-type') ?? '';
    if (/\.html$/.test(path)) {
      assert(type.includes('text/html'), `Wrong HTML MIME: ${path}`);
    }
    if (/\.(?:md|txt)$/.test(path)) {
      assert(/text\/(?:markdown|plain)/.test(type), `Wrong text MIME: ${path}`);
    }
    if (/\.json$/.test(path)) {
      assert(type.includes('application/json'), `Wrong JSON MIME: ${path}`);
    }
  }
  const missing = await fetch(`${preview.urls[0]}${base}does-not-exist-verification.md`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(missing.status, 404, 'Missing Markdown was rewritten instead of returning 404');
} finally {
  await preview.server.close();
}
console.log(
  `Verified ${pages.length} HTML/Markdown pages, search, examples, schema, provenance and ${localPaths.size} HTTP resources (base ${base}).`,
);
