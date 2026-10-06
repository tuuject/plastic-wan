---
title: CLI 参考
description: Plastic Wan 的服务、配置校验、诊断、备份命令，以及用于保存凭据、检查连通、只读查看配置与 prompt、查询/导出/重放 Invocation 的 Admin API 工具客户端。
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

`packages/cli` 提供 Admin API 工具客户端 `plasticwan-utils`（npm 包 `@tuuject/plasticwan-utils`），用于只读检查当前配置与 prompt、查询/导出/重放 Invocation。子命令为 `invocation list` / `get` / `prompts` / `preflight` / `media` / `replay`、`config show` 与 `prompt get global|group`，另有 `login`（把 endpoint 与 API key 成对保存到本机）与 `doctor`（一次只读请求验证连通与鉴权）；群聊管理等其它能力尚未实现，也不包含 SDK 或 Eval 能力，`login` 也不提供服务端密钥管理（密钥的创建与撤销仍只在面板进行）。

它与服务端入口 `plasticwan`（`node src/cli.ts`）不同：本客户端直接访问 Admin API，不包含 `serve`、`check-config`、`backup`、`configure` 等服务命令；客户端自己的 `doctor` 也不执行服务端 Doctor 的 SQLite、媒体、Telegram、Provider 与 MCP 探针，只检查 Admin API 连通与鉴权。

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

客户端用 API key 认证；密钥在面板的 **Manage → API keys**（`/api-keys`）页面创建、查看与撤销，明文只在创建弹窗出现一次，关闭后不可再取回，见[使用管理面板](../configure/admin.md#api-密钥)。密钥的能力面是只读检查（配置与 prompt 视图、Invocation 记录 prompt、重放预检、媒体导出）与 Invocation 读/重放；不要把真实 key 写进命令参数、聊天或 Skill 文件，也不要手动 `export` 明文 key（会进入 shell 历史）。

### 首次使用

1. 在面板创建密钥并立即保存明文。
2. 由操作员在本机运行 `plasticwan-utils login`，逐项输入 Admin Panel 基地址与 API key（key 隐藏输入、不回显）：

   ```bash
   plasticwan-utils login
   ```

   endpoint 与 key 成对保存在固定路径 `~/.config/plasticwan-utils/credentials.json`（所有平台一致；与 Bot 的 `config.jsonc`、`key.json` 无关，同一时间只保留最近一次 `login` 的一对凭据）。文件**未加密**，请当密码对待；POSIX 上目录 `0700`、文件 `0600`（更窄的权限同样接受）；Windows 不做 POSIX mode 检查，权限由用户目录 ACL 继承，工具不承诺 `chmod` 级别的保护。既有文件是符号链接、不是普通文件或权限不安全时，读写都拒绝且不自动修复或替换，需人工处理。`login` 不访问服务器，保存成功不代表鉴权已通过；序列化后超过 16384 字节会被拒绝，且写入失败（含拒绝）不会覆盖旧凭据。
3. 验证连通与鉴权；只有退出码 0 才继续：

   ```bash
   plasticwan-utils doctor --json
   ```

   `doctor` 恰好发起一次 `GET /api/invocations?limit=1`，没有 replay、没有模型/Provider 调用，也不发送 Telegram 消息；成功时 stdout 为 `{"status":"ok","endpoint":…,"credential_sources":{"endpoint":"argument|environment|file","api_key":…}}`，不输出 Invocation 正文，失败不自动重试；鉴权会在服务端更新密钥的 `last_used_at`。失败时 stderr 为 `{"error","message"}`：参数/环境变量给出的凭据缺失或不合法（`missing_endpoint`、`missing_api_key`、`invalid_api_key` 等）退出码 `2`，保存文件无效（`invalid_credentials`）或请求失败退出码 `1`。
4. 只读检查与查询 Invocation：

   ```bash
   plasticwan-utils config show --json
   plasticwan-utils prompt get global --json
   plasticwan-utils invocation prompts 12345 --json
   plasticwan-utils invocation preflight 12345 --json
   plasticwan-utils invocation list --limit 20 --state completed --chat -1001234567890 --json
   plasticwan-utils invocation get 12345 --json
   ```

无人值守环境用非交互方式；示例中的变量都由安全渠道注入，不含明文 key：

```bash
# endpoint 与 key 已注入环境变量；login 读取它们并保存，不回显
plasticwan-utils login --json

# 或让 key 只经标准输入进入：读到 EOF（不是读到第一行就停），累计不超过 4098 字节，
# 读取结束后只去掉一个尾部 LF/CRLF，其余换行/空白/控制字符非法（受 --timeout-ms 约束；不是 --api-key -）
# SECRET_KEY 由安全渠道注入；它不是 CLI 读取的环境变量，CLI 只从 stdin 收下这段内容
printf '%s' "$SECRET_KEY" | plasticwan-utils login --endpoint "$PLASTICWAN_ENDPOINT" --api-key-stdin --json
```

凭据解析顺序为命令行参数 > 环境变量 > 保存文件。参数或环境变量显式给出的空串按缺失/非法处理，不会回退到下一来源或改为提示（`missing_endpoint`/`missing_api_key`/`invalid_api_key`）。endpoint 与 key 都由参数或环境变量明确给出时完全不读取凭据文件（文件损坏、是符号链接或权限不安全也不影响）；只给其一才读文件，文件问题以 `invalid_credentials` 失败（退出码 1）。保存的 key 只属于其保存时的规范化 endpoint：当前 endpoint 与文件 endpoint 经 `parseEndpoint` 规范化后不一致就不会使用该 key（缺少显式 key 报 `missing_api_key`，退出码 2），规范化后一致则仍可使用。参数与环境变量不会被写回文件（只有 `login` 写文件）。`login --json` 输出 `{"status":"saved","endpoint":…,"credentials_file":…}`，不含 key。

查询、导出与重放示例：

```bash
plasticwan-utils invocation list --cursor 12345 --json
plasticwan-utils invocation media 12345 --json
plasticwan-utils invocation media 12345 --variant preview --json
plasticwan-utils invocation replay 12345 --json
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json
plasticwan-utils invocation replay 12345 --group-prompt group.txt --json
```

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `PLASTICWAN_ENDPOINT` | Admin Panel 基地址；解析顺序为参数 > 环境变量 > `login` 保存的凭据文件，三处都没有或显式空串/纯空白时按缺失报错（`missing_endpoint`，不回退）。明文 `http` 只允许 loopback（`127.0.0.0/8`、`::1`、`localhost`），远端必须 `https`；URL 不能带凭据、query 或 fragment；保存与比较都用 `parseEndpoint` 规范化后的 URL（trim、补尾斜杠、去默认端口） |
| `--api-key <key>` / `PLASTICWAN_API_KEY` | API key：1–4096 字符，不得含空白或控制字符（参数/环境变量报 `invalid_api_key`，保存文件内的非法值报 `invalid_credentials`）；与 endpoint 同一解析顺序，命令行参数优先于环境变量，显式空串不回退。仅当解析出的 endpoint 与文件 endpoint 规范化后相同才使用文件中的 key，否则缺少显式 key 报 `missing_api_key` |
| `--api-key-stdin` | 仅 `login`：把标准输入读到 EOF（不是读完一行就停），累计不超过 4098 字节，读取结束后只去掉一个尾部 LF/CRLF，剩余换行、空白或控制字符整体非法（`invalid_api_key`，退出码 2）；TTY 上拒绝；整次读取受 `--timeout-ms` 约束，超时 `timeout`（退出码 1）且不保存；不能与 `--api-key` 或 `PLASTICWAN_API_KEY` 同时给出；不是 `--api-key -`，其它命令不从标准输入读取 key |
| `--source <active\|file>` | 仅 `config show` 与 `prompt get`：`active`（默认）读运行中快照，`file` 读磁盘配置；两者不会互相替代 |
| `--variant <original\|preview>` | 仅 `invocation media`：下载原始文件（默认）或服务端规范化预览；preview 只对 photo/sticker 可用 |
| `--timeout-ms <ms>` | 请求/输入超时；默认除 replay（300 秒）外都是 30 秒。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时中止请求，均不自动重试 |
| `--json` | stdout 恰好一个 JSON 文档；人类模式输出列表摘要或缩进 JSON |
| `--limit`（1–100）/ `--cursor` / `--state` | `invocation list` 的过滤参数，发出前先做形状校验（cursor 为非负十进制） |
| `--chat <id>` | `invocation list` 的 Chat 过滤，或 `prompt get group` 必填的群 ID；必须是可带负号的有符号 64 位十进制 |
| `--global-prompt <file\|->` | 仅 `invocation replay`：完整替换 global 层；`-` 从非终端标准输入读取，去空白后不能为空、最多 65,536 字符，否则在发请求前以退出码 2 失败 |
| `--group-prompt <file\|->` | 仅 `invocation replay`：完整替换 group 层；允许空内容以显式清空，最多 65,536 字符；与 `--global-prompt -` 不能同时从 stdin 读取 |

失败时 stderr 输出 `{"error":"<code>","message":"<message>"}`，错误信息经 key 脱敏，密钥不会出现在任何输出中；退出码 `0` 表示成功，`1` 表示请求/服务端/replay/媒体下载失败或保存文件无效（`invalid_credentials`），`2` 表示参数、输入或凭据不合法（含 `missing_endpoint`、`missing_api_key`、`invalid_api_key`、`credentials_too_large` 与 prompt 覆盖相关错误）。标准输入只用于 `login` 的 `--api-key-stdin` 与 replay 的 `--global-prompt -` / `--group-prompt -`（不能同时）。请求不跟随重定向；JSON 响应体超过 4 MiB 会被拒绝。

`invocation media` 把每个媒体顺序下载到新建的私有临时目录（每文件不超过 20 MiB、单次合计不超过 100 MiB、最多 32 项），stdout 输出带 `sha256` 的 manifest；全部成功退出码 `0`，部分失败保留成功文件并写入 `manifest.json` 后以 `media_download_failed` 退出（退出码 `1`），全部失败先尝试清理目录，删除成功后输出 manifest；若文件系统拒绝清理，命令失败、目录可能残留，stdout 不保证含 manifest。服务端持续清理失败会作为条目错误 `media_cleanup_failed` 返回；这不等于客户端目录也已删除。manifest 等文本输出与落盘元数据经 API key 脱敏；媒体二进制保留响应原字节，不做文本脱敏，`bytes` 与 `sha256` 对应实际保存的文件。`invocation replay` 在 POST 前先调用一次免费的 `replay-preflight`：不可重放时直接以原因码结束（不发送 replay），v1 旧快照请求 prompt 覆盖时返回 `replay_prompt_parts_unavailable`。只读检查（`config show`、`prompt get`、`invocation prompts`、`invocation preflight`、媒体列表）不调用模型、不计费；重放不会发送 Telegram 消息，也不修改生产会话与业务数据（鉴权仍会更新密钥使用时间），但它会真实调用模型并计费，限制与注意事项见[使用管理面板](../configure/admin.md#invocation-重放)。

### 让外部 Agent 使用配套 Skill

CLI 安装包还包含 `skills/plasticwan-utils/`，指导外部 Agent 先运行 `doctor` 验证凭据与连通，再定位 Invocation、核对模型调用/工具/真实发送记录；只读核对可用 `config show`、`prompt get`、`invocation prompts` 与 `invocation preflight`，并在明确授权后重放或分层比较 global/group prompt。它不是 Bot 的只读 System Skill，无需放入服务器的 `system:///` 资源树。Skill 以 `SKILL.md` 为轻量入口，主题细节按当前任务加载子文档：审计流程见 `references/invocations.md`，重放的保真限制、授权要求与错误处理见 `references/replay.md`，不要一次加载全部内容。

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
3. 由操作员准备凭据：向 Agent 的命令执行环境安全注入 `PLASTICWAN_ENDPOINT` 与 `PLASTICWAN_API_KEY`，或由操作员在本机运行 `plasticwan-utils login` 保存到凭据文件。不要让 Agent 索取聊天中的明文 key，也不要让它读取或修改凭据。
4. 在 Agent 的 Skill 列表中确认 `plasticwan-utils`；未发现时重新打开会话。然后发出只读任务：

   > 使用 $plasticwan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

Skill 要求 Agent 每次任务先运行 `plasticwan-utils doctor --json`，使用同一凭据与 endpoint；只有退出码 `0` 且 `status` 为 `ok` 才继续读取对应指南并执行查询或重放。`doctor` 失败时 Agent 停止并报告错误，提醒操作员在本机用 `login` 修复，不循环重试、不自动登录或改动凭据，也不从聊天或存储直接读取 key；`--help` 只用于客户端缺失或命令不匹配时的诊断。

Skill 默认先报告审计证据；重放需要明确确认目标、次数和可选的 global/group prompt 覆盖，且不会自动重试。重放使用首个 agent 模型请求的纯文本快照和当前 Chat 模型配置，prompt 可从记录的 global/group 两层临时覆盖（v1 旧快照只能原样重放），合成发送成功不等于生产发送成功。查询结果也可能包含私密消息和 prompt，不要直接公开完整输出。

Skill 是复制的本地副本，不会随 CLI 升级自动更新（升级命令如 `npm install -g @tuuject/plasticwan-utils@latest`）；升级 CLI 时同步检查副本。宿主仍须允许命令执行和访问相应 endpoint，安装 Skill 本身不会授予权限。
