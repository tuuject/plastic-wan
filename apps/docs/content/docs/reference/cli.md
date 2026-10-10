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

`packages/cli` 提供 Admin API 工具客户端 `plasticwan-utils`（npm 包 `@tuuject/plasticwan-utils`），用于只读检查当前配置与 prompt、查询/导出/重放 Invocation。子命令为 `invocation list` / `get` / `prompts` / `preflight` / `media` / `replay`、`models list`、`config show` 与 `prompt get global|group`，另有 `login`（把 endpoint 与 API key 成对保存到本机）与 `doctor`（一次只读请求验证连通与鉴权）；群聊管理等其它能力尚未实现，也不包含 SDK 或 Eval 能力，`login` 也不提供服务端密钥管理（密钥的创建与撤销仍只在面板进行）。

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

不想全局安装时，也可以直接运行构建产物：`node packages/cli/dist/bin.js …`。维护者的自动化发布、首次发布 bootstrap 与 trusted publisher 配置见仓库的 [packages/cli/README.md](https://github.com/tuuject/surowan/blob/main/packages/cli/README.md)。

客户端用 API key 认证；密钥在面板的 **Manage → API keys**（`/api-keys`）页面创建、查看与撤销，明文只在创建弹窗出现一次，关闭后不可再取回，见[使用管理面板](../configure/admin.md#api-密钥)。密钥的能力面是只读检查（配置与 prompt 视图、可用模型列表、场景所用的当前 prompt、重放预检、媒体导出）与 Invocation 读/重放；不要把真实 key 写进命令参数、聊天或 Skill 文件，也不要手动 `export` 明文 key（会进入 shell 历史）。

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
   plasticwan-utils models list --json
   plasticwan-utils invocation prompts 12345 --json
   plasticwan-utils invocation preflight 12345 --json
   plasticwan-utils invocation list --limit 20 --state completed --chat -1001234567890 --json
   plasticwan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
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
plasticwan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
plasticwan-utils invocation list --search '关键词' --from '2026-09-10 07:00' --to '2026-09-10 08:00' --json
plasticwan-utils invocation media 12345 --json
plasticwan-utils invocation media 12345 --variant preview --json
plasticwan-utils invocation replay 12345 --json
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json
plasticwan-utils invocation replay 12345 --group-prompt group.txt --json
# 切片重放：以某次成功 Bot 发言（telegram_sends 内部 ID）为边界重建输入窗口，需显式确认计费
plasticwan-utils invocation preflight 12345 --before-send 678 --json
plasticwan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
# 临时模型/thinking 覆盖：--provider 与 --model 必须成对，预检与重放必须使用同一选择
plasticwan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
plasticwan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
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
| `--search <keyword>` | 仅 `invocation list`：按字面关键词（1–100 字符，`%`、`_` 按字面处理）匹配公开消息——冻结新消息批次（含追加批次）的群友消息，或同一 Invocation 成功发出的 Bot 消息。与时间过滤同用时，关键词与时间必须命中同一条消息；带搜索或时间过滤时列表项追加 `matched_messages`（最新 5 条，按时间从新到旧，预览最多 2000 字符），不带时维持原形状 |
| `--at <time>` / `--from <time>` / `--to <time>` | 仅 `invocation list`：按公开消息时间过滤。`--at` 命中写出的整个精度窗口（`HH:mm` 为整分钟、`HH:mm:ss` 为整秒、小数 1/2/3 位分别对应 100/10/1 毫秒窗口），`--from`/`--to` 组成半开区间 `[from, to)`；`--at` 不能与 `--from`/`--to` 同用。格式为 `YYYY-MM-DD[空格或T]HH:mm[:ss[.1-3位]][Z\|±HH:mm]`；不带 offset 的时间由服务端按 `--chat` 对应 Chat 的时区解析、没有 `--chat` 时用全局时区；非法日历与夏令时跳变造成的不存在/重复时间会被拒绝 |
| `--before-send <send-id>` | 仅 `invocation preflight` 与 `invocation replay`：以该 `telegram_sends` 内部 ID（必须是本 Invocation 的成功发送）作为切片边界；预检与重放必须使用同一选择 |
| `--confirm-paid` | 仅 `invocation replay`：切片重放（`--before-send`）需显式确认真实模型计费；缺失时以 `confirm_paid_required`、退出码 2 拒绝，不读 prompt 或 stdin，也不发预检或 POST。未切片重放不要求该 flag |
| `--global-prompt <file\|->` | 仅 `invocation replay`：完整替换 global 层；`-` 从非终端标准输入读取，去空白后不能为空、最多 65,536 字符，否则在发请求前以退出码 2 失败 |
| `--group-prompt <file\|->` | 仅 `invocation replay`：完整替换 group 层；允许空内容以显式清空，最多 65,536 字符；与 `--global-prompt -` 不能同时从 stdin 读取 |
| `--provider <alias>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的 Provider alias；必须与 `--model` 成对（`invalid_model_override`，退出码 2），1–256 字符、不含控制字符 |
| `--model <id>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的模型 ID；必须与 `--provider` 成对，规则同上 |
| `--thinking-level <level>` | 仅 `invocation preflight` 与 `invocation replay`：临时 thinking 覆盖，取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（`invalid_thinking_level`，退出码 2）。可单独使用（只临时改 thinking，模型沿用当前 Chat 配置）；与模型对同给时按该模型校验级别，给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`），模型不支持的级别由服务端拒绝。预检与重放必须使用同一选择 |

失败时 stderr 输出 `{"error":"<code>","message":"<message>"}`，错误信息经 key 脱敏，密钥不会出现在任何输出中；退出码 `0` 表示成功，`1` 表示请求/服务端/replay/媒体下载失败或保存文件无效（`invalid_credentials`），`2` 表示参数、输入或凭据不合法（含 `missing_endpoint`、`missing_api_key`、`invalid_api_key`、`credentials_too_large`、搜索/时间过滤与 `--before-send` 的本地校验错误、模型选择的 `invalid_model_override`/`invalid_thinking_level`，以及 prompt 覆盖相关错误）。标准输入只用于 `login` 的 `--api-key-stdin` 与 replay 的 `--global-prompt -` / `--group-prompt -`（不能同时）。请求不跟随重定向；JSON 响应体不设客户端大小上限，完整读取后解析，仍受请求超时约束。

`invocation media` 把每个媒体顺序下载到新建的私有临时目录（每文件不超过 20 MiB、单次合计不超过 100 MiB、最多 32 项），stdout 输出带 `sha256` 的 manifest；全部成功退出码 `0`，部分失败保留成功文件并写入 `manifest.json` 后以 `media_download_failed` 退出（退出码 `1`），全部失败先尝试清理目录，删除成功后输出 manifest；若文件系统拒绝清理，命令失败、目录可能残留，stdout 不保证含 manifest。服务端持续清理失败会作为条目错误 `media_cleanup_failed` 返回；这不等于客户端目录也已删除。manifest 等文本输出与落盘元数据经 API key 脱敏；媒体二进制保留响应原字节，不做文本脱敏，`bytes` 与 `sha256` 对应实际保存的文件。`invocation replay` 在 POST 前先调用一次免费的 `replay-preflight`（切片重放带同一 `before_send_id`，临时模型/thinking 选择也带同一 `provider`/`model`/`thinking_level`）：不可重放时直接以原因码结束（不发送 replay），请求了 prompt 覆盖而预检不允许时返回 `replay_prompt_parts_unavailable`；`--before-send` 是重放边界而不是 prompt 覆盖，不要求该权限，但切片重放需 `--confirm-paid` 显式确认计费。只读检查（`config show`、`prompt get`、`models list`、`invocation prompts`、`invocation preflight`、媒体列表）不调用模型、不计费；重放不会发送 Telegram 消息，也不修改生产会话与业务数据（鉴权仍会更新密钥使用时间），但它会真实调用模型并计费，限制与注意事项见[使用管理面板](../configure/admin.md#invocation-重放)。

`models list` 只读列出当前 active 配置中可接受文本输入的已配置模型（`{ source: "active", generation, models: [...] }`，每项含 `provider`/`model`/`name`/`context_window`/`max_tokens`/`input`/`reasoning`/`thinking_levels`）：不发起 Provider 请求、不是上游完整目录、不保证连通，也不支持 `--source file`；列表不构成对任何模型的使用授权。`invocation preflight`/`replay` 可临时覆盖模型与 thinking：`--provider` 与 `--model` 必须成对，`--thinking-level` 可单独使用；CLI 把相同的 `provider`/`model`/`thinking_level` 放进预检查询与重放 body，覆盖只影响这一次运行，不写回配置、不改生产 Context/审计/预算，但选中模型决定 prompt 变量、图片能力、context budget、Schema、Provider 连接与真实费用。给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`），不支持请求级别会被拒绝；未给任何选择时按当前 Chat 配置。响应的 `model`（`{ provider, id, thinking_level }`）、`fidelity.model_selection`（`current_chat_config`/`temporary_override`）与 `overrides` 的 `provider`/`model`/`thinking_level` 布尔可核对实际使用的选择。

切片重放（`--before-send <send-id>`）只重建该次 Bot 发言之前的一小段公开输入：窗口严格位于上一条 Bot 发言之后、目标发言之前（两端不含），目标必须是本 Invocation 的成功发送，上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation；没有更早历史，也不读取历史的 reasoning、工具结果或 system prompt。输入只包含冻结且已注入的公开消息（目标发言之前已注入的批次会被拍平后一次性灌入，不按 Bucket 或历史节奏等待；模型并发与网络延迟仍可能造成等待），原 Bot 回答不进入模型，只作为审计对照。返回的 `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 取该次发送请求的开始时间（不是交付完成时间）；回复引用不能跨出该窗口。窗口内没有新的公开消息返回 `replay_slice_empty`，目标不是本 Invocation 的成功发送返回 `replay_slice_target_invalid`。

### 让外部 Agent 使用配套 Skill

源码仓库根目录内置 `agents/skills/plasticwan-utils/`，指导外部 Agent 先运行 `doctor` 验证凭据与连通，再定位 Invocation（可按关键词与公开消息时间用 `invocation list --search/--at/--from/--to` 搜索）、核对模型调用/工具/真实发送记录；只读核对可用 `config show`、`prompt get`、`models list`、`invocation prompts` 与 `invocation preflight`，并在明确授权后重放（含用 `--before-send` 限定窗口的切片重放、`--provider`/`--model`/`--thinking-level` 临时模型覆盖）或分层比较 global/group prompt。它不是 Bot 的只读 System Skill，无需放入服务器的 `system:///` 资源树。Skill 以 `SKILL.md` 为轻量入口，主题细节按当前任务加载子文档：审计流程见 `references/invocations.md`，重放的保真限制、授权要求与错误处理见 `references/replay.md`，不要一次加载全部内容。

**npm 包不内置 Skill，安装 CLI 也不会自动启用 Skill。** 以下以 [Codex 的项目级目录](https://developers.openai.com/codex/build-skills)为例；其他宿主请使用其自己的 Skill 导入功能，不假定自动兼容。

1. 先按上文全局安装 CLI，运行 `plasticwan-utils --help` 确认命令可用。
2. 在准备用 Agent 排障的项目根目录，从源码仓库复制整个 Skill 目录（仓库根的 `agents/skills/plasticwan-utils/`，`SKILL.md`、`references/` 与 `agents/openai.yaml` 都要保留）。若目标已存在，先比较内容再决定更新，不直接覆盖。未克隆仓库时，可从 GitHub 下载该目录；最终文件应位于 `.agents/skills/plasticwan-utils/SKILL.md`，不要多嵌套一层。

   克隆仓库后：

   ```powershell
   $source = '<仓库检出路径>\.agents\skills\plasticwan-utils'
   $target = '.agents/skills/plasticwan-utils'
   if (Test-Path $target) { throw 'Skill already exists; review it before updating.' }
   New-Item -ItemType Directory -Path '.agents/skills' -Force | Out-Null
   Copy-Item -LiteralPath $source -Destination $target -Recurse
   ```

   Bash / Zsh：

   ```bash
   test ! -e .agents/skills/plasticwan-utils &&
     mkdir -p .agents/skills &&
     cp -R /path/to/surowan/.agents/skills/plasticwan-utils .agents/skills/
   ```
3. 由操作员准备凭据：向 Agent 的命令执行环境安全注入 `PLASTICWAN_ENDPOINT` 与 `PLASTICWAN_API_KEY`，或由操作员在本机运行 `plasticwan-utils login` 保存到凭据文件。不要让 Agent 索取聊天中的明文 key，也不要让它读取或修改凭据。
4. 在 Agent 的 Skill 列表中确认 `plasticwan-utils`；未发现时重新打开会话。然后发出只读任务：

   > 使用 $plasticwan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

Skill 要求 Agent 每次任务先运行 `plasticwan-utils doctor --json`，使用同一凭据与 endpoint；只有退出码 `0` 且 `status` 为 `ok` 才继续读取对应指南并执行查询或重放。`doctor` 失败时 Agent 停止并报告错误，提醒操作员在本机用 `login` 修复，不循环重试、不自动登录或改动凭据，也不从聊天或存储直接读取 key；`--help` 只用于客户端缺失或命令不匹配时的诊断。

Skill 默认先报告审计证据；重放需要明确确认目标、次数和可选的 global/group prompt 覆盖，且不会自动重试。重放从源开场批次的冻结公开消息与当时可证明存在的历史重建场景，使用当前 Chat 的 prompt、模型与工具定义，不依赖 Developer 报文录制；global/group 两层可临时覆盖，固定协议不可覆盖。切片重放（`--before-send`）把输入收窄到某次成功 Bot 发言之前的窗口，需 `--confirm-paid` 显式确认计费。它不恢复私有推理；默认重放不加入后续热注入，切片模式只拍平可证明在目标发送前已注入的批次。合成发送成功不等于生产发送成功。查询结果（含搜索命中的 `matched_messages` 摘要）也可能包含私密消息和 prompt，不要直接公开完整输出。

Skill 是复制到宿主项目的本地副本，不随 CLI 升级自动更新；它随源码仓库更新，同步仓库时一并更新副本（升级 CLI 命令如 `npm install -g @tuuject/plasticwan-utils@latest`）。宿主仍须允许命令执行和访问相应 endpoint，安装 Skill 本身不会授予权限。
