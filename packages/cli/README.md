# @tuuject/plasticwan-utils

Plastic Wan Admin API 工具客户端，包内命令为 `plasticwan-utils`。它是 monorepo 工作区包（仓库根与其它 workspace 仍为 private），已配置为可公开发布到 npm；当前只实现 invocation 的 `list`/`get`/`replay` 三个子命令，群聊管理等其它能力尚未实现，也不包含 SDK、密钥管理或 Eval 能力。

它与服务端入口 `plasticwan`（`node src/cli.ts`）不是同一个程序：本客户端只通过 Admin API 查询与重放 Invocation，不包含 `serve`、`check-config`、`doctor`、`backup`、`configure` 等服务命令。

## 安装

发布可用后从 npm 全局安装（Node.js ≥ 24，无额外运行时依赖；命令名为 `plasticwan-utils`）：

```bash
npm install -g @tuuject/plasticwan-utils           # 稳定版，dist-tag latest
npm install -g @tuuject/plasticwan-utils@canary    # main 分支的 canary 构建
plasticwan-utils --help
```

canary 版本号形如 `0.0.0-canary.<run>.<attempt>.g<sha12>`。默认安装使用 `latest`；workflow 只把 canary 发布到独立的 `canary` 标签，不移动 `latest`，因此试用时须显式指定 `@canary`。

registry 上还没有该包（`npm install` 返回 404）或需要离线安装时，从源码检出打包后本地安装：

```bash
pnpm install --frozen-lockfile
pnpm --filter @tuuject/plasticwan-utils pack --pack-destination "$PWD/dist/npm"
npm install -g ./dist/npm/tuuject-plasticwan-utils-0.1.0.tgz   # 文件名以实际版本为准
```

不全局安装时，可在源码仓库内运行 `node packages/cli/dist/bin.js …`（先 `pnpm cli:build`）。

包以编译后的 ESM JavaScript 分发；不新增任何运行时依赖（只用标准库 `node:util` parseArgs 与全局 `fetch`）。源码内的相对导入带 `.ts` 后缀，由 `rewriteRelativeImportExtensions` 在编译产物中改写为 `.js`，因此 `node_modules` 内不会出现 Node type stripping 拒绝的 `.ts` 文件。

## 安装配套 Agent Skill

包内的 [`skills/plasticwan-utils/SKILL.md`](skills/plasticwan-utils/SKILL.md) 给外部 Agent 使用：先定位 Invocation、关联模型/工具/真实发送证据，再在明确授权后重放或比较 prompt。它不是 Bot 的 `system:///` Skill，不需要服务器源码或数据库，也不增加 CLI 命令。

Skill 采用渐进披露：`SKILL.md` 是轻量入口，主题细节按当前任务加载子文档——审计流程在 `references/invocations.md`，重放的保真限制、授权要求与错误处理在 `references/replay.md`——不要一次加载全部内容。

安装 CLI **不会自动注册 Skill**。以 [Codex 的项目级 Skill 目录](https://developers.openai.com/codex/build-skills) 为例，在希望使用 Skill 的项目根目录执行以下一种复制方式；如果目标已存在，先比较版本，不直接覆盖。

PowerShell：

```powershell
$source = Join-Path (npm root -g) '@tuuject/plasticwan-utils/skills/plasticwan-utils'
$target = '.agents/skills/plasticwan-utils'
if (Test-Path $target) { throw 'Skill already exists; review it before updating.' }
New-Item -ItemType Directory -Path '.agents/skills' -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse
```

Bash / Zsh：

```bash
test ! -e .agents/skills/plasticwan-utils &&
  mkdir -p .agents/skills &&
  cp -R "$(npm root -g)/@tuuject/plasticwan-utils/skills/plasticwan-utils" .agents/skills/
```

未全局安装时，从源码的 `packages/cli/skills/plasticwan-utils/` 或解压后的 `package/skills/plasticwan-utils/` 复制整个目录（含 `references/invocations.md`、`references/replay.md` 与 `agents/openai.yaml`）。最终布局应为 `.agents/skills/plasticwan-utils/SKILL.md`，不要多嵌套一层目录。其他 Agent 按其自身 Skill 导入机制注册，不假定兼容 Codex 的目录。

重新打开 Agent 会话，确认发现 `plasticwan-utils` 后可请求：

> 使用 $plasticwan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

由操作员通过安全环境注入向 Agent 的命令执行环境提供 endpoint 和 API key，不要把 key 放入 Skill 或聊天。Skill 副本不会随全局 CLI 升级自动更新；更新 CLI（例如 `npm install -g @tuuject/plasticwan-utils@latest`）时同步检查 Skill 版本。是否允许注册、执行命令及访问网络，仍取决于宿主权限。

## 用法

先在 Admin Panel 的 **Manage → API keys** 创建密钥，再通过安全环境注入设置 `PLASTICWAN_API_KEY`。环境变量避免把 key 放在命令参数中，但直接输入含明文 key 的 `export` 仍会进入 shell 历史；不要这样配置真实凭据。

```bash
# endpoint 必须显式给出：admin.port 在配置里没有默认值，不猜端口
export PLASTICWAN_ENDPOINT=https://admin.example.com
# PLASTICWAN_API_KEY 已由安全渠道注入，不在此回显或赋明文

plasticwan-utils invocation list --limit 20 --state completed --chat -1001234567890 --json
plasticwan-utils invocation list --cursor 12345 --json
plasticwan-utils invocation get 12345 --json
plasticwan-utils invocation replay 12345 --json
plasticwan-utils invocation replay 12345 --system-prompt prompt.txt --json
printf '%s' '临时替换的 system prompt' | plasticwan-utils invocation replay 12345 --system-prompt - --json
```

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `PLASTICWAN_ENDPOINT` | Admin Panel 基地址，必填。明文 `http` 仅允许 loopback（`127.0.0.0/8`、`::1`、`localhost`）；远端必须 `https`；禁止 URL 内凭据、query 与 fragment |
| `--api-key <key>` / `PLASTICWAN_API_KEY` | API key，必填；以 `Authorization: Bearer <key>` 发送。命令行参数优先级高于环境变量 |
| `--timeout-ms <ms>` | 请求超时；默认 list/get 30s，replay 300s。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时会中止请求，均**不自动重试** |
| `--json` | 稳定 JSON 输出；成功时 stdout 恰好一个 JSON 文档 |
| `--limit` / `--cursor` / `--state` / `--chat` | 透传给 `GET /api/invocations` 的过滤参数，本地先做形状校验（limit 1–100；Invocation ID/cursor 为非负十进制，Chat ID 可带负号，均限制在有符号 64 位范围） |
| `--system-prompt <file\|->` | 仅 replay：`-` 表示从 stdin 读取；最多 64Ki 字符 |

## API 契约

| 命令 | 请求 | 成功响应形状 |
| --- | --- | --- |
| `invocation list` | `GET /api/invocations?limit&cursor&state&chat` | `{ items: [...], next_cursor: string \| null }` |
| `invocation get <id>` | `GET /api/invocations/<id>` | invocation 详情对象（含 `id: string`），原样输出 |
| `invocation replay <id>` | `POST /api/invocations/<id>/replay`，body `{}` 或 `{ "system_prompt": "..." }` | 对象；`error` 非 null 表示 replay 未完成 |

响应边界只做最小校验：必须是 JSON 对象，且 list 的 `items` 为数组、`next_cursor` 为字符串或 null；get 必须含字符串 `id`。响应体超过 4 MiB 会被拒绝。

## 输出与退出码

- 成功：stdout 一个 JSON 文档（`--json`）或简洁的人类可读输出。
- 失败：stderr 一个 JSON 文档 `{"error": "<code>", "message": "<message>"}`；错误信息经 key 脱敏，key 不会出现在任何输出中。
- replay 的响应即使 `error` 非 null 也会完整保留结构并写在 stdout，同时以非零退出码结束；stderr 仍是 JSON，`error` 为 `replay_failed`，`message` 以 `replay did not complete: ...` 开头。
- 退出码：`0` 成功，`1` 请求/服务端/replay 失败，`2` 参数或输入不合法。
- 请求不跟随重定向（`redirect: "error"`），只允许 `http(s)`，未知参数会直接报错而不是忽略。

## 发布（维护者）

### 自动化发布

`.github/workflows/npm.yml` 负责发布，独立于 Docker workflow（不等待 Docker gates）：

- `main` 的 push：版本 `0.0.0-canary.<run_number>.<run_attempt>.g<12 位提交 SHA>`，dist-tag `canary`。
- 严格 `vMAJOR.MINOR.PATCH` 的 tag（无前导零、无 prerelease、无 build 后缀）：tag 中的版本号即发布版本，dist-tag `latest`。
- 版本只在 CI 的一次性 checkout 内改写（在 `packages/cli` 执行 `npm version --no-git-tag-version`），不回写、不提交源码；稳定 tag 是稳定版本的唯一来源。
- `pnpm --filter @tuuject/plasticwan-utils pack` 之后，dry-run 与实际发布使用同一个 tarball：先 `npm publish <tgz> --dry-run --access public --tag <dist-tag> --ignore-scripts` 检查内容，再发布同一文件。
- 认证使用 GitHub OIDC（job 持有 `id-token: write`）：不使用 `NPM_TOKEN`，不依赖 GitHub Environment。跑在 Node 24 上，发布前安装 npm 11.16.0（trusted publishing 要求 npm CLI ≥ 11.5.1、Node ≥ 22.14.0）。
- 只有 `tuuject/plastic-wan` 的 push 能进入发布 job；版本 guard（`scripts/npm-release.ts`）再次校验事件、仓库与 ref，不支持的输入会被拒绝。
- 发布串行且不取消正在运行的任务；`queue: max` 最多保留 100 个等待任务，避免后续 main push 顶掉等待中的稳定发布。队满时 GitHub 会取消新增任务，须人工检查并重跑。

稳定发布由维护者手动打 tag 触发（以下仅为示例，不在本仓库自动执行）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

push 后到 Actions 日志与 npm 包页面确认真实的 publish 与 provenance。几点注意：

- prerelease tag（如 `v1.0.0-rc.1`）虽会匹配 workflow 的 trigger，但会被版本 guard 拒绝，不会发布。
- Docker workflow 用 `GITHUB_TOKEN` 推送的 `v0.0.0-next-<UTC 时间戳>` tag 不会触发本 workflow。
- 每次稳定发布都会显式移动 `latest`，不会按版本大小跳过：在 `v2.0.0` 之后发布 `v1.2.4` 会把 `latest` 回退到 `1.2.4`。本 workflow 不区分旧维护线，打 tag 前必须确认这是预期。
- dry-run 只检查 tarball 内容，不验证 OIDC、权限或版本冲突；这些只能在真实发布时暴露。

### 首次发布 bootstrap

trusted publisher 只能配置到 npm 上已存在的包，因此第一次发布必须由对 `@tuuject` scope 有写权限的维护者在本机手工完成。不要把 token 写进命令或仓库。

1. 本机安装 Node.js ≥ 24，在仓库根目录安装依赖：

   ```bash
   pnpm install --frozen-lockfile
   ```

2. 运行静态检查与相关测试（跨模块改动再跑完整 `pnpm test`）：

   ```bash
   pnpm run check
   pnpm test test/invocation-cli.test.ts test/npm-release.test.ts
   ```

3. 打包到明确的输出目录（用绝对路径，避免相对路径歧义；产物名随版本变化）：

   ```bash
   pnpm --filter @tuuject/plasticwan-utils pack --pack-destination "$PWD/dist/npm"
   # 形如 dist/npm/tuuject-plasticwan-utils-0.1.0.tgz
   ```

4. 先用 dry-run 检查 tarball 内容：

   ```bash
   npm publish ./dist/npm/tuuject-plasticwan-utils-0.1.0.tgz --dry-run --access public --tag latest --ignore-scripts
   ```

5. 交互式登录 npm 并确认本机账号（`npm whoami` 只确认本机身份，不是 OIDC/trusted publishing 的验证）：

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm whoami
   ```

   账号需要 `@tuuject` scope 的写权限，并在发布时启用 2FA。

6. 确认 dry-run 内容无误后，发布同一个 tarball：

   ```bash
   npm publish ./dist/npm/tuuject-plasticwan-utils-0.1.0.tgz --access public --tag latest --ignore-scripts
   ```

   npm 的包名与版本组合不可复用，即使撤包也不能重发同版本。`0.1.0` 用过之后，既不能用它再次手动发布，也不能再用 `v0.1.0` tag 发它；后续稳定版本选择 `v0.1.1` 或 `v1.0.0` 这类未使用过的版本。

### 配置 trusted publisher

1. 首次手工发布成功后，在 npm 打开该包的 Settings → Trusted publishing → GitHub Actions，填写：
   - Organization or user：`tuuject`
   - Repository：`plastic-wan`
   - Workflow filename：`npm.yml`（只填文件名，不能带 `.github/workflows/` 路径，必须带 `.yml`）
   - Environment：留空
2. Allowed actions 中必须开启 **Allow npm publish**。npm 新配置默认只允许 stage publish，不显式开启直接发布时 CI 会被拒绝。官方将直接发布与 `npm dist-tag` 管理列为独立权限；本 workflow 用 `npm publish --tag <dist-tag>`，没有单独的 `npm dist-tag` 步骤。不要以 dry-run 推断权限已经满足，须在首次真实发布后核对目标 dist-tag。
3. trusted publisher 配置保存后不可编辑：填错只能删除后重建。

配置完成后，用一次真实的 `main` push 和一次稳定 tag 验证发布与 provenance——CI 里的 dry-run 覆盖不到这条路径。成功后建议：

- 在包 Settings → Publishing access 选择 **Require two-factor authentication and disallow tokens**；这仍然允许 OIDC/trusted publishing，只是关闭长期 token 发布。
- 对 `main` 分支与 `v*` tag 启用仓库保护，限制谁能修改发布 workflow、创建或移动稳定 tag。

官方参考：[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[`npm trust` 前提条件](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
