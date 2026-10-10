import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, normalizeHref } from '@rspress/core';
import buildInfo from './content/public/build-info.json';

const repository = 'https://github.com/tuuject/surowan';
const version = `文档对应源码提交：${buildInfo.commit}${buildInfo.dirty ? '（含未提交修改，仅供本地预览）' : ''}`;

export default defineConfig({
  root: resolve(import.meta.dirname, 'content'),
  outDir: 'dist',
  lang: 'zh',
  title: '塑料碗',
  description: '自行部署的 Telegram Agent Bot。部署、配置，以及把碗配置成自己的使用指南。',
  icon: '/favicon.svg',
  logoText: '塑料碗',
  base: buildInfo.base,
  siteOrigin: buildInfo.siteOrigin,
  ssg: true,
  builderConfig: {
    server: { htmlFallback: false },
    resolve: {
      alias: {
        // Rspress uses Document without workers or persistence. The compact build
        // omits the unused worker fallback that embeds import.meta.url as a local path.
        flexsearch$: resolve(
          dirname(createRequire(import.meta.resolve('@rspress/core')).resolve('flexsearch')),
          'flexsearch.compact.module.min.js',
        ),
      },
    },
  },
  // SSG-MD preserves public links verbatim, including when pages become llms-full.txt.
  // Resolve the explicit public-resource prefix before either output is rendered.
  replaceRules: [{ search: /__DOCS_BASE__\//g, replace: buildInfo.base }],
  llms: {
    llmsTxt: ({ title, description, sections }) =>
      [
        `# ${title}`,
        '',
        `> ${description}`,
        '',
        `${version}。源码：https://github.com/tuuject/surowan/commit/${buildInfo.commit}`,
        '',
        '先核实用户的代码或镜像版本，再读快速开始与具体任务页。不要读取或转发真实密钥；重启、迁移与覆盖配置前须获得确认。',
        '这是部署文档，不是 Bot 的 System Skills；不保证 Agent 自动发现此索引。',
        '',
        ...sections.flatMap((section) => [
          `## ${section.title}`,
          '',
          ...section.pages.map((page) => `- [${page.title}](${page.link}): ${page.description ?? ''}`),
          '',
        ]),
      ].join('\n'),
  },
  route: { extensions: ['.md', '.mdx'], cleanUrls: false },
  plugins: [
    {
      name: 'static-search-links',
      modifySearchIndexData(pages) {
        // Rspress 2.0.22 leaves leaf search routes extensionless. Directory routes
        // must keep their slash: this hook also feeds the runtime page-data lookup.
        for (const page of pages) {
          if (!page.routePath.endsWith('/')) {
            page.routePath = normalizeHref(page.routePath, false);
          }
        }
      },
    },
  ],
  markdown: {
    link: {
      checkDeadLinks: {
        excludes: [
          'llms.txt',
          'llms-full.txt',
          'config.schema.json',
          'examples/config.example.jsonc',
          'examples/system-prompt.example.md',
          'examples/docker-compose.yml',
        ].map((path) => `${buildInfo.base}${path}`),
      },
      checkAnchors: true,
    },
    image: { checkDeadImages: true },
  },
  themeConfig: {
    lastUpdated: true,
    editLink: { docRepoBaseUrl: `${repository}/tree/main/apps/docs/content` },
    llmsUI: { placement: 'title', viewOptions: ['markdownLink'] },
  },
});
