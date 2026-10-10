# Documentation site

中文、单版本 Rspress 2 静态站，独立于 Bot/Admin 服务。公开内容根仅为 `content/`；维护者主题文档仍在 [`agent-doc/`](../../agent-doc/README.md)。

## 本地开发与验证

在仓库根目录使用 Node.js 24+ 与 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm run docs:dev
pnpm run docs:check
pnpm test test/docs-examples.test.ts test/docs-search.test.ts test/docs-markdown.test.ts
pnpm run docs:build
pnpm run docs:verify
pnpm run docs:preview
```

开发与预览默认监听 `127.0.0.1:5274`，不要同时占用同一端口。`docs:verify` 对已有 `dist/` 验证内容、链接、来源提交、搜索索引、下载文件，并临时启动框架原生生产预览（回环地址、5276 起可用端口），逐个 HTTP 核对后关闭。它不调用 Bot、Doctor、Telegram 或 Provider；不存在的 Markdown 必须返回 404，不得用 SPA fallback 返回首页。

Markdown、`llms.txt`、`llms-full.txt` 只有生产构建能完整验证，不能用 dev 页面代替。每次更改正文、主题或生成逻辑后重新构建再 verify。

## 内容与生成边界

- 用户正文：`content/docs/`，按任务拆页，写 `title`、`description` 与一个 H1；页面间用相对 `.md` 链接，公开下载用 `__DOCS_BASE__/文件名`。Rspress `replaceRules` 为后者加部署 base，确保 HTML、单页 Markdown 与合并的 `llms-full.txt` 都可用；新增下载须列入精确 dead-link 例外，由 `docs:verify` 检查真实产物。导航由 `_nav.json` / `_meta.json` 维护。
- 安全下载示例唯一源：`examples/`；Compose 模板例外，直接发布仓库根目录的 `docker-compose.yml`，与 README 共用一份。完整配置与正文 JSONC 片段由真实 `loadConfig` 做离线校验，不解析 SecretRef 或使用真实密钥。
- `scripts/docs-prepare.ts` 从当前 `ConfigSchema` 生成 `reference/fields.md` 和 `public/config.schema.json`，复制白名单示例，并生成 `public/build-info.json`。这些文件被 Git 忽略，不手改、不另存第二份 Schema。生成页关闭编辑链接与 Git 更新时间：2.0.22 的默认组件不识别这些 frontmatter 开关，主题以两个小包装落实，`docs:verify` 验证生成页隐藏且手写页仍有编辑链接。
- Schema 字段表只描述类型与显式约束，不推导运行时默认值。字段、权限、热更新、迁移、用户可见行为改变时，同一变更更新相关手写指南和测试。
- 页面与 llms 共享完整 Git SHA；未提交修改明确标为本地预览。更新时间不是适用版本，SHA 也不自动等于 `latest` 镜像。
- 仅保留轻量主题扩展，布局/导航/搜索/Markdown 使用 Rspress。`static-search-links` 针对 2.0.22 的 extensionless 搜索结果补上原生 `normalizeHref`。其本地搜索仅用 FlexSearch Document（不启用 worker/持久化），因此精确 alias 到同包 compact ESM 构建，避免完整版未使用的 worker fallback 把构建机路径带入 JS；不跳过泄漏检查。
- `patches/@rspress__core@2.0.22.patch` 修复默认搜索的全局 Enter 越界和空结果上下键取模：仅处理打开面板的搜索输入，有实际结果才导航。通过 pnpm 的 `patchedDependencies` 锁定并安装，不手改安装目录；`test/docs-search.test.ts` 执行已安装包的实际事件处理器。Docker 安装层也复制补丁，最终 runtime 不复制补丁或 docs。按钮补充 `:focus-visible` 边框。升级 Rspress/FlexSearch 后复查路由、compact alias、来源控件与键盘补丁的必要性，并运行生产浏览器验收。
- 禁止把真实配置、密钥、SQLite、日志、`dev-data` 或 `agent-doc/design` 放进公开内容/资源。示例只用占位符与 SecretRef。当前无真实 Admin 截图；不制作假截图。

## 静态部署

`.github/workflows/docs.yml` 验证根路径与 `/surowan/`，仅上传静态检查 artifact；还会构建 Bot 镜像验证站点依赖隔离。**没有公开发布 job**，不绑定域名。检查 artifact 中的 `docs.example.com` 是测试域名，不能直接当生产部署。

选择实际托管平台后，用干净、已提交的 checkout 显式设置：

```bash
DOCS_SITE_ORIGIN=https://your-docs-host.example DOCS_BASE_PATH=/ pnpm run docs:build
pnpm run docs:verify
```

PowerShell 请用 `$env:DOCS_SITE_ORIGIN` 和 `$env:DOCS_BASE_PATH`。origin 不带路径/凭据/查询；base 必须以 `/` 开头、结尾。子路径部署把 **`dist/` 的内容**挂载到该 base，不重复嵌套一层 base 目录。只上传 `dist/`，不要上传源码或 workspace。

选定主机后仍须实测 `.html` 深链、`.md`/`.txt`/`.json` 的内容与 MIME，以及缺失 `.md` 的 404；主机行为不由本地 preview 保证。不要开启把所有请求重写到 `index.html` 的 SPA catch-all。

真实 Docker 运行、Provider/Telegram、Doctor、迁移和恢复演练需要另行授权与隔离环境。离线示例测试和静态站检查不能代表这些链路通过。
