---
title: CLI 参考
description: Plastic Wan 的服务、配置校验、诊断、备份命令，以及用于查询与重放 Invocation 的 Admin API 工具客户端。
---

# CLI 参考

服务命令显式指定配置路径；下文的 Admin API 工具客户端改用 endpoint 与 API key。配置和密钥错误信息会尝试脱敏，但仍不要将完整日志公开。

## 服务与校验

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc --takeover
```

`check-config` 仅验证 JSONC、语义和引用，输出配置哈希，不连接外部服务。`serve` 启动 Telegram long polling；成功日志包含 `serve_started`。`--takeover` 仅用于替换持有同一数据目录锁的本地实例，会请求旧实例优雅退出，不能作为生产 supervisor 的替代。

## 真实诊断与备份

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
node src/cli.ts backup --config /path/to/config.jsonc
```

`doctor` 会探测 SQLite、媒体依赖、Telegram、Provider、Vision 与 required MCP，并可能消耗 Provider Token；不要把它当离线检查。`backup` 执行保留清理、SQLite 备份与轮换；之后仍应在隔离环境验证恢复。

## 交互式配置

```bash
node src/cli.ts configure --config /path/to/config.jsonc
```

`configure` 只能在 TTY 中编辑已有、可加载的配置；它不是无人值守初始化器，也不适合让部署 Agent 自动调用。

## Docker 等价命令

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

这些一次性命令不启动 `serve`，可与正在运行的服务共存；不要用 `docker compose run` 再启动一个 `serve`。

## Admin API 工具客户端（plasticwan-utils）

`packages/cli` 提供 Admin API 工具客户端 `plasticwan-utils`（npm 包 `@tuuject/plasticwan-utils`），用于查询与重放 Invocation。当前只实现 `invocation list` / `get` / `replay` 三个子命令，群聊管理等其它能力尚未实现，也不包含 SDK、密钥管理或 Eval 能力。

它与服务端入口 `plasticwan`（`node src/cli.ts`）不同：本客户端直接访问 Admin API，不包含 `serve`、`check-config`、`doctor`、`backup`、`configure` 等服务命令。

从 npm 全局安装（Node.js ≥ 24，无额外运行时依赖；命令名为 `plasticwan-utils`）：

```bash
npm install -g @tuuject/plasticwan-utils           # 稳定版，dist-tag latest
npm install -g @tuuject/plasticwan-utils@canary    # main 分支的 canary 构建
plasticwan-utils --help
```

自动发布中，`latest` 来自维护者推送的稳定 tag，`canary` 随 `main` 的成功发布更新且不移动 `latest`；试用版须显式指定 `@canary`。registry 上还没有该包（安装返回 404）时，先在源码仓库安装依赖，再打包后本地安装：

```bash
pnpm install --frozen-lockfile
pnpm --filter @tuuject/plasticwan-utils pack --pack-destination "$PWD/dist/npm"
npm install -g ./dist/npm/tuuject-plasticwan-utils-0.1.0.tgz   # 文件名以实际打包输出为准
```

不想全局安装时，也可以直接运行构建产物：`node packages/cli/dist/bin.js …`。维护者的自动化发布、首次发布 bootstrap 与 trusted publisher 配置见仓库的 [packages/cli/README.md](https://github.com/tuuject/plastic-wan/blob/main/packages/cli/README.md)。

客户端用 API key 认证。请在面板的 **Manage → API keys** 页面创建密钥（明文只在创建弹窗出现一次，关闭后不可再取回），见[使用管理面板](../configure/admin.md#api-密钥)；密钥只覆盖 Invocation 查询与重放。通过安全环境注入设置 `PLASTICWAN_API_KEY`，不要在命令参数、聊天或 Skill 文件中填写真实 key；直接输入含 key 的 `export` 也会被 shell 历史记录。

```bash
export PLASTICWAN_ENDPOINT=https://admin.example.com   # 必填；明文 http 只允许本机
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
| `--endpoint <url>` / `PLASTICWAN_ENDPOINT` | Admin Panel 基地址，必填；明文 `http` 只允许 loopback（`127.0.0.0/8`、`::1`、`localhost`），远端必须 `https`；URL 不能带凭据、query 或 fragment |
| `--api-key <key>` / `PLASTICWAN_API_KEY` | API key，必填；命令行参数优先于环境变量 |
| `--timeout-ms <ms>` | 请求超时；默认 list/get 30 秒、replay 300 秒。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时中止请求，均不自动重试 |
| `--json` | stdout 恰好一个 JSON 文档；人类模式输出列表摘要或缩进 JSON |
| `--limit`（1–100）/ `--cursor` / `--state` / `--chat` | `invocation list` 的过滤参数，发出前先做形状校验 |
| `--system-prompt <file\|->` | 仅 `invocation replay`；`-` 表示从标准输入读取（标准输入是终端时会拒绝），内容不能为空、最多 64Ki 字符 |

失败时 stderr 输出 `{"error":"<code>","message":"<message>"}`，错误信息经 key 脱敏，密钥不会出现在任何输出中；退出码 `0` 表示成功、`1` 表示请求/服务端/replay 失败、`2` 表示参数或输入不合法。请求不跟随重定向；响应体超过 4 MiB 会被拒绝。重放不会发送 Telegram 消息，也不修改生产会话与业务数据（鉴权仍会更新密钥使用时间），但它会真实调用模型并计费，限制与注意事项见[使用管理面板](../configure/admin.md#invocation-重放)。

### 让外部 Agent 使用配套 Skill

CLI 安装包还包含 `skills/plasticwan-utils/`，指导外部 Agent 定位 Invocation、核对模型调用/工具/真实发送记录，并在明确授权后重放或比较 prompt。它不是 Bot 的只读 System Skill，无需放入服务器的 `system:///` 资源树。Skill 以 `SKILL.md` 为轻量入口，主题细节按当前任务加载子文档：审计流程见 `references/invocations.md`，重放的保真限制、授权要求与错误处理见 `references/replay.md`，不要一次加载全部内容。

**安装 CLI 不会自动启用 Skill。** 以下以 [Codex 的项目级目录](https://developers.openai.com/codex/build-skills)为例；其他宿主请使用其自己的 Skill 导入功能，不假定自动兼容。

1. 先按上文全局安装 CLI，运行 `plasticwan-utils --help` 确认命令可用。
2. 在准备用 Agent 排障的项目根目录，复制包内整个 Skill 目录。若目标已存在，先比较内容再决定更新，不直接覆盖。

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

   未全局安装时，可从源码的 `packages/cli/skills/plasticwan-utils/`，或解压后的 `package/skills/plasticwan-utils/` 复制整个目录；`SKILL.md`、`references/` 与 `agents/openai.yaml` 都要保留。最终文件应位于 `.agents/skills/plasticwan-utils/SKILL.md`，不要多嵌套一层。
3. 由操作员安全注入 endpoint 和 API key 到 Agent 的命令执行环境，不要让 Agent 索取聊天中的明文 key。
4. 在 Agent 的 Skill 列表中确认 `plasticwan-utils`；未发现时重新打开会话。然后发出只读任务：

   > 使用 $plasticwan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

Skill 默认先报告审计证据；重放需要明确确认目标、次数和可选的 system prompt 覆盖，且不会自动重试。重放使用首个 agent 模型请求的纯文本快照和当前 Chat 模型配置，合成发送成功不等于生产发送成功。查询结果也可能包含私密消息和 prompt，不要直接公开完整输出。

Skill 是复制的本地副本，不会随 CLI 升级自动更新（升级命令如 `npm install -g @tuuject/plasticwan-utils@latest`）；升级 CLI 时同步检查副本。宿主仍须允许命令执行和访问相应 endpoint，安装 Skill 本身不会授予权限。
