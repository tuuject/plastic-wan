# @tuuject/plasticwan-utils

Plastic Wan Admin API 工具客户端，包内命令为 `plasticwan-utils`。它是 monorepo 工作区包（仓库根与其它 workspace 仍为 private），已配置为可公开发布到 npm；除 Invocation 的 `list`/`get`/`prompts`/`preflight`/`media`/`replay` 六个子命令外，还提供 `models list`（只读列出当前 active 配置中可接受文本输入的已配置模型）、`config show`、`prompt get global|group`、`login`（把 endpoint 与 API key 成对保存到本机）与 `doctor`（一次只读请求验证连通与鉴权）；`invocation preflight`/`replay` 支持临时模型/thinking 覆盖（`--provider`/`--model`/`--thinking-level`）。群聊管理等其它能力尚未实现，也不包含 SDK 或 Eval 能力；`login` 只保存本机凭据，不能创建、查看或撤销服务端密钥（密钥管理仍只在 Admin Panel 进行）。API key 的权限面是 Invocation 读/重放加只读 inspection：配置与 prompt 视图、可用模型列表、场景所用的当前 prompt 与重放预检、Invocation 媒体导出；其余接口（含面板写端点与密钥管理）仍返回 403。

它与服务端入口 `plasticwan`（`node src/cli.ts`）不是同一个程序：本客户端只通过 Admin API 做只读检查、查询、媒体导出与重放，不包含 `serve`、`check-config`、`backup`、`configure` 等服务命令；客户端自己的 `doctor` 也不执行服务端 Doctor 的 SQLite、媒体、Telegram、Provider 与 MCP 探针，只检查 Admin API 连通与鉴权。

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

## 配套 Agent Skill

源码仓库根目录的 [`agents/skills/plasticwan-utils/SKILL.md`](../../.agents/skills/plasticwan-utils/SKILL.md) 给外部 Agent 使用：每次任务先运行 `plasticwan-utils doctor --json` 验证凭据与连通，再定位 Invocation、关联模型/工具/真实发送证据（只读核对可用 `config show`、`prompt get`、`models list`、`invocation prompts` 与 `invocation preflight`），最后在明确授权后重放（可带临时模型/thinking 覆盖）或分层比较 global/group prompt。它不是 Bot 的 `system:///` Skill，不需要服务器源码或数据库，也不增加 CLI 命令。

Skill 采用渐进披露：`SKILL.md` 是轻量入口，主题细节按当前任务加载子文档——审计流程在 `references/invocations.md`，重放的保真限制、授权要求与错误处理在 `references/replay.md`——不要一次加载全部内容。入口要求只有 `doctor` 以退出码 `0` 返回 `status: "ok"` 时才继续；失败即停止并请操作员用 `login` 修复（Agent 不代为执行、不重试、不读取或索取密钥），`--help` 只用于诊断 CLI 缺失或命令不匹配。

npm 包 **不再内置这个 Skill**；它随源码仓库根目录的 `.agents/skills/plasticwan-utils/` 分发。要给外部 Agent 使用，从源码仓库把整个目录复制到目标项目的根目录（以 [Codex 的项目级 Skill 目录](https://developers.openai.com/codex/build-skills) 为例）；如果目标已存在，先比较版本，不直接覆盖。未克隆仓库时，可从 GitHub 下载该目录（`SKILL.md`、`references/invocations.md`、`references/replay.md` 与 `agents/openai.yaml` 都要保留）。最终布局应为 `.agents/skills/plasticwan-utils/SKILL.md`，不要多嵌套一层目录。其他 Agent 按其自身 Skill 导入机制注册，不假定兼容 Codex 的目录。

重新打开 Agent 会话，确认发现 `plasticwan-utils` 后可请求：

> 使用 $plasticwan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

由操作员准备凭据：向 Agent 的命令执行环境安全注入 `PLASTICWAN_ENDPOINT` 与 `PLASTICWAN_API_KEY`，或由操作员在本机运行 `plasticwan-utils login` 保存到凭据文件。Agent 只运行 `doctor` 与查询命令，不自己读取、打印或修改凭据，也不要把 key 放入 Skill 或聊天。Skill 副本不随 CLI 升级自动更新；同步仓库更新时一并检查 Skill 版本。是否允许注册、执行命令及访问网络，仍取决于宿主权限。

## 用法

先在 Admin Panel 的 **Manage → API keys** 创建密钥（明文只在创建弹窗出现一次，关闭后无法再取回），再在本机保存凭据并验证连通。推荐顺序：

```bash
# 1. 交互式登录：逐项提示 endpoint 与 API key（key 隐藏输入、不回显），无须参数或环境变量
plasticwan-utils login

# 2. 验证连通与鉴权；只有退出码 0 才继续
plasticwan-utils doctor --json

# 3. 只读检查：运行中/文件配置、全局与按群 prompt、可用模型、场景所用的当前 prompt 与重放预检
plasticwan-utils config show --json
plasticwan-utils config show --source file --json
plasticwan-utils prompt get global --json
plasticwan-utils prompt get group --chat -1001234567890 --source file --json
plasticwan-utils models list --json
plasticwan-utils invocation prompts 12345 --json
plasticwan-utils invocation preflight 12345 --json

# 4. 查询、导出媒体与重放
plasticwan-utils invocation list --limit 20 --state completed --chat -1001234567890 --json
plasticwan-utils invocation list --cursor 12345 --json
# 按关键词与公开消息时间定位 Invocation；--at 与 --from/--to 互斥
plasticwan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
plasticwan-utils invocation list --search '关键词' --from '2026-09-10 07:00' --to '2026-09-10 08:00' --json
plasticwan-utils invocation get 12345 --json
plasticwan-utils invocation media 12345 --json
plasticwan-utils invocation replay 12345 --json
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json
plasticwan-utils invocation replay 12345 --group-prompt group.txt --json
# 切片重放：以某次成功 Bot 发言为边界重建输入窗口，需显式确认计费
plasticwan-utils invocation preflight 12345 --before-send 678 --json
plasticwan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
# 临时模型/thinking 覆盖：--provider 与 --model 必须成对，预检与重放必须使用同一选择
plasticwan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
plasticwan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
```

无人值守或 CI 环境改用已注入的环境变量，或让 key 只经标准输入进入（示例中的变量都由安全渠道注入，不含明文 key）：

```bash
# endpoint 与 key 已在环境变量里；login 读取它们并写入凭据文件
plasticwan-utils login --json

# 或让 key 只经标准输入进入：读到 EOF 才停（不是读完一行就停），累计不超过 4098 字节，
# 读取结束后只去掉一个尾部 LF/CRLF，其余换行/空白/控制字符非法（受 --timeout-ms 约束；不是 --api-key -）
# SECRET_KEY 由安全渠道注入；它不是 CLI 读取的环境变量，CLI 只从 stdin 收下这段内容
printf '%s' "$SECRET_KEY" | plasticwan-utils login --endpoint "$PLASTICWAN_ENDPOINT" --api-key-stdin --json
```

不要手动 `export` 明文 key：含明文 key 的 `export` 会进入 shell 历史，真实凭据应由安全渠道注入。

`login` 把 endpoint 与 key 成对保存到固定路径 `~/.config/plasticwan-utils/credentials.json`（所有平台一致；与 Bot 的 `config.jsonc`、`key.json` 无关，同一时间只保留最近一次 `login` 的一对）。文件是 JSON 对象，字段为 `endpoint` 与 `apiKey`，**未加密**；POSIX 上目录 `0700`、文件 `0600`（更窄的权限同样接受），Windows 不做 POSIX mode 检查、权限由用户目录 ACL 继承（工具不承诺 `chmod` 级别的保护）。既有文件是符号链接、不是普通文件或权限不安全时，读写都拒绝且**不自动修复或替换**，需人工处理。`login` 不访问服务器，也不读取旧凭据内容；保存成功不代表在线鉴权通过，请接着运行 `doctor`。序列化后的凭据超过 16384 字节会被拒绝（`credentials_too_large`，退出码 2）且不触碰旧文件；写入经同目录临时文件 `rename` 落地，任何失败都不会覆盖旧文件。

凭据解析顺序（`doctor`、`config show`、`prompt get`、`models list` 与 `invocation list/get/prompts/preflight/media/replay` 相同）：命令行参数 > 环境变量 > 保存文件。参数或环境变量显式给出的空串（含只含空白的 endpoint）按缺失/非法处理，**不会回退**到下一来源或改为提示（解析命令报 `missing_endpoint`/`missing_api_key`，`login` 报 `invalid_endpoint`/`invalid_api_key`）。endpoint 与 key 都由参数或环境变量明确给出时完全不读取凭据文件，文件损坏、是符号链接或权限不安全都不影响这次调用；只给其一才读文件，此时文件本身的问题以 `invalid_credentials` 失败（退出码 1）。保存的 key 只属于它保存时的规范化 endpoint：当前 endpoint 与文件中的 endpoint 在 `parseEndpoint` 规范化后不一致（例如换了主机）就不会使用该 key，缺少显式 key 会以 `missing_api_key` 失败（退出码 2），更换服务必须同时显式提供 key 或重新 `login`；规范化后相同（如仅尾斜杠差异）则仍可使用。参数与环境变量不会被写回文件（只有 `login` 写文件）。`login --json` 输出 `{"status":"saved","endpoint":…,"credentials_file":…}`，不含 key；`endpoint` 是规范化后的基地址。

`doctor` 按同一顺序解析凭据后恰好发起一次 `GET /api/invocations?limit=1`——没有 replay、没有模型/Provider 调用，也不发送 Telegram 消息；`--json` 成功时 stdout 为 `{"status":"ok","endpoint":…,"credential_sources":{"endpoint":"argument|environment|file","api_key":…}}`，不输出 Invocation 正文，失败不自动重试；鉴权仍会在服务端更新该密钥的 `last_used_at`。失败时 stderr 为 `{"error","message"}`：参数/环境变量给出的凭据缺失或不合法（`missing_endpoint`、`missing_api_key`、`invalid_api_key` 等）退出码 `2`，保存文件无效（`invalid_credentials`）或请求失败退出码 `1`。

### 选项

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `PLASTICWAN_ENDPOINT` | Admin Panel 基地址；解析顺序为参数 > 环境变量 > `login` 保存的凭据文件，三处都没有时按缺失报错，显式空串或纯空白按缺失报错（`missing_endpoint`）、不回退。明文 `http` 仅允许 loopback（`127.0.0.0/8`、`::1`、`localhost`）；远端必须 `https`；禁止 URL 内凭据、query 与 fragment；保存与比较都用 `parseEndpoint` 规范化后的 URL（trim、补尾斜杠、去默认端口） |
| `--api-key <key>` / `PLASTICWAN_API_KEY` | API key：1–4096 字符，不得含空白或控制字符（参数/环境变量报 `invalid_api_key`，保存文件内的非法值报 `invalid_credentials`）；与 endpoint 同一解析顺序，命令行参数优先于环境变量，显式空串不回退。仅当解析出的 endpoint 与文件 endpoint 规范化后相同才使用文件中的 key，否则缺少显式 key 报 `missing_api_key` |
| `--api-key-stdin` | 仅 `login`：把标准输入读到 EOF（不是读完一行就停），累计不超过 4098 字节，读取结束后只去掉一个尾部 LF/CRLF，剩余换行、空白或控制字符整体非法（`invalid_api_key`，退出码 2）；TTY 上拒绝；整次读取受 `--timeout-ms` 约束，超时 `timeout`（退出码 1）且不保存；不能与 `--api-key` 或 `PLASTICWAN_API_KEY` 同时给出；不是 `--api-key -`，其它子命令不从标准输入读取 key |
| `--source <active\|file>` | 仅 `config show` 与 `prompt get`：`active`（默认）读运行中的配置快照，`file` 读磁盘上的配置文件并可与 active 对比；其它子命令带 `--source` 报 `unexpected_option`。两者不会互相替代，`file` 需要服务端已接线配置加载 |
| `--variant <original\|preview>` | 仅 `invocation media`：下载原始文件（默认）或服务端规范化预览；preview 只对 photo/sticker 可用，单文件与总量上限见下文 |
| `--timeout-ms <ms>` | 请求/输入超时；默认除 replay（300s）外都是 30s。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时会中止请求，均**不自动重试** |
| `--json` | 稳定 JSON 输出；成功时 stdout 恰好一个 JSON 文档 |
| `--limit` / `--cursor` / `--state` | 透传给 `GET /api/invocations` 的过滤参数，本地先做形状校验（limit 1–100；Invocation ID/cursor 为非负十进制，限制在有符号 64 位范围） |
| `--chat <id>` | `invocation list` 的 Chat 过滤，或 `prompt get group` 必填的群 ID；必须是可带负号的有符号 64 位十进制，缺失时 `prompt get group` 报 `missing_argument` |
| `--search <keyword>` | 仅 `invocation list`：按字面关键词匹配公开消息（1–100 字符；`%`、`_` 按字面处理）。候选是冻结 `invocation_messages`（`section=new`）的群友消息 text/caption，或同 Invocation 成功 `telegram_sends` 的 text/caption；与时间过滤同用时关键词与时间必须命中同一条消息。带搜索或时间过滤时每个 item 追加 `matched_messages`，不带时维持原形状 |
| `--at <time>` / `--from <time>` / `--to <time>` | 仅 `invocation list`：公开消息时间过滤。`--at` 命中写出的整个精度窗口（`HH:mm` 为整分钟、`HH:mm:ss` 为整秒、小数 1/2/3 位分别对应 100/10/1 毫秒窗口），`--from`/`--to` 组成半开区间 `[from, to)`；`--at` 不能与 `--from`/`--to` 同用。格式 `YYYY-MM-DD[空格或T]HH:mm[:ss[.1-3位]][Z\|±HH:mm]`；不带 offset 的时间在服务端按 `--chat` 对应 Chat 的时区解析、否则用全局时区，非法日历与 DST 不存在/重复时间被拒绝 |
| `--before-send <send-id>` | 仅 `invocation preflight` 与 `invocation replay`：以该 `telegram_sends` 内部 ID（必须是本 Invocation 的成功发送）作为切片边界；preflight 与 replay 必须使用同一选择 |
| `--confirm-paid` | 仅 `invocation replay`：切片重放（`--before-send`）需显式确认真实模型计费；缺失时以 `confirm_paid_required`、退出码 2 拒绝，不读 prompt 或 stdin，也不发预检或 POST。未切片重放不要求该 flag |
| `--global-prompt <file\|->` | 仅 replay：临时替换 global prompt 层；`-` 从非终端标准输入读取，去空白后不能为空、最多 65,536 字符，否则在发请求前以退出码 2 失败 |
| `--group-prompt <file\|->` | 仅 replay：临时替换 group 层；允许空内容以显式清空该层，最多 65,536 字符；与 `--global-prompt -` 不能同时从 stdin 读取（`conflicting_prompt_input`）。标准输入只用于 `login` 的 key 与 replay 的 prompt |
| `--provider <alias>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的 Provider alias；必须与 `--model` 成对（`invalid_model_override`，退出码 2），1–256 字符、不含控制字符 |
| `--model <id>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的模型 ID；必须与 `--provider` 成对，规则同上 |
| `--thinking-level <level>` | 仅 `invocation preflight` 与 `invocation replay`：临时 thinking 覆盖，取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（`invalid_thinking_level`，退出码 2）。可单独使用（只临时改 thinking，模型沿用当前 Chat 配置）；与模型对同给时按该模型校验级别，给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`），模型不支持的级别由服务端拒绝。预检与重放必须使用同一选择 |

## API 契约

| 命令 | 请求 | 成功响应形状 |
| --- | --- | --- |
| `login` | 不访问服务器，只写凭据文件 | `{ status: "saved", endpoint, credentials_file }`（不含 key） |
| `doctor` | `GET /api/invocations?limit=1`（只验证连通与鉴权） | `{ status: "ok", endpoint, credential_sources: { endpoint, api_key } }`，来源取值为 `argument` / `environment` / `file` |
| `config show` | `GET /api/config/view?source` | `{ source, generation, active_hash, file_hash, restart_required, config }`；`config` 是服务端脱敏投影（不含 key、SecretRef 内容与 prompt 正文） |
| `models list` | `GET /api/models`（无查询参数） | `{ source: "active", generation, models: [{ provider, model, name, context_window, max_tokens, input, reasoning, thinking_levels }] }`；只含 active 配置中接受 `text` 输入的已配置模型，不发起 Provider 请求，不代表上游完整目录或连通保证 |
| `prompt get global` | `GET /api/prompts/global?source` | `{ source, scope: "global", chat_id: null, prompt, core_read_only: true, generation, active_hash, file_hash, restart_required }` |
| `prompt get group --chat <id>` | `GET /api/prompts/group?source&chat` | 同上，`scope: "group"`，另有 `configured_chat_id`（Chat 迁移后可分辨配置 ID） |
| `invocation list` | `GET /api/invocations?limit&cursor&state&chat&search&at&from&to` | `{ items: [...], next_cursor: string \| null }`；带搜索或时间过滤时每个 item 追加 `matched_messages`（最新 5 条命中，按时间从新到旧；`{ source: "incoming"\|"bot", telegram_message_id, telegram_send_id, at, text }`，`text` 是截断预览，bot 条目的 `telegram_send_id` 是 `--before-send` 候选，仍须用同一 ID 预检；跨 Conversation 的发送不能作为切片目标） |
| `invocation get <id>` | `GET /api/invocations/<id>` | invocation 详情对象（含 `id: string`），原样输出 |
| `invocation prompts <id>` | `GET /api/invocations/<id>/prompts` | `{ source: "active", source_invocation_id, global_prompt, group_prompt, template_values, core_read_only: true }`；当前场景所用模板与变量，不是历史 prompt |
| `invocation preflight <id>` | `GET /api/invocations/<id>/replay-preflight[?before_send_id][&provider&model&thinking_level]` | `{ available, reason, message, prompt_overrides_available, omitted_images, scene?, model?, fidelity }`；基于保留的公开场景，不依赖报文录制；切片选择时 `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`；带临时模型/thinking 选择时 `model` 为将使用的 `{ provider, id, thinking_level }`，`fidelity.model_selection` 为 `current_chat_config` 或 `temporary_override`；不调用模型、不写生产业务状态 |
| `invocation media <id>` | `GET /api/invocations/<id>/media`，再对每项逐个 `GET /api/invocations/<id>/media/<media_id>/content?variant=` | 二进制逐项落盘；stdout 为 manifest 文档（见「输出与退出码」） |
| `invocation replay <id>` | 先 `GET /api/invocations/<id>/replay-preflight[?before_send_id][&provider&model&thinking_level]`；随后 `POST /api/invocations/<id>/replay`，body `{}`、`{ "global_prompt": "...", "group_prompt": "..." }`、`{ "before_send_id": "<十进制字符串>" }` 或带 `provider`/`model`/`thinking_level` 的任意组合（模型对与 thinking 同预检） | 对象；`error` 非 null 表示 replay 未完成，`model` 为实际使用的 `{ provider, id, thinking_level }`，`overrides` 报告哪两层被替换以及临时覆盖的 `provider`/`model`/`thinking_level` 布尔，`fidelity.model_selection` 区分 `current_chat_config`/`temporary_override`；切片重放另在 `scene.slice` 报告边界 |

响应边界只做最小校验：必须是 JSON 对象，且 list 的 `items` 为数组、`next_cursor` 为字符串或 null，get 必须含字符串 `id`，`config show` / `prompt get` / `invocation prompts` / `invocation preflight` 各自校验顶层字段，`models list` 校验 `source`/`generation` 与每个模型的字段形状（provider/model/name、`input` 含 text、thinking 级别在枚举内等），媒体列表校验每项的 ID、变体与大小形状；校验失败以 `invalid_response`（退出码 1）结束且不重试。JSON 响应体不设客户端大小上限，完整读取后解析，仍受请求超时约束；媒体内容单独按每文件 20 MiB、单次运行 100 MiB 设限。`doctor` 不输出 Invocation 正文，不调用模型、不发送 Telegram 消息、不重试；鉴权仍会更新密钥的 `last_used_at`。

## 输出与退出码

- 成功：stdout 一个 JSON 文档（`--json`）或简洁的人类可读输出；`login` 与 `doctor` 的成功文档不含 key。
- 失败：stderr 一个 JSON 文档 `{"error": "<code>", "message": "<message>"}`；错误信息经 key 脱敏，key 不会出现在任何输出中。
- replay 的响应即使 `error` 非 null 也会完整保留结构并写在 stdout，同时以非零退出码结束；stderr 仍是 JSON，`error` 为 `replay_failed`，`message` 以 `replay did not complete: ...` 开头。
- `invocation replay` 在 POST 前先调用一次免费的 `GET /api/invocations/<id>/replay-preflight`（切片重放带同一 `before_send_id`，临时模型/thinking 选择也带同一 `provider`/`model`/`thinking_level`）：不可重放时直接用引擎的稳定错误码失败（不发送 replay）；请求了 prompt 覆盖而预检的 `prompt_overrides_available` 为 false 时以 `replay_prompt_parts_unavailable` 失败，同样不 POST。覆盖内容在预检前读取并本地校验（global 为空或超过 65,536 字符等以退出码 2 失败）；`before_send_id` 是重放边界而不是 prompt 覆盖，不要求该权限；模型选择也不是 prompt 覆盖，但选中模型/级别在预检不可用时按预检原因码失败。切片重放还需显式 `--confirm-paid` 确认本次真实计费。
- `invocation media` 顺序下载到一个新建的私有临时目录（创建失败即失败；目录绝对路径写在 manifest 的 `directory` 字段），每个文件与 `manifest.json` 在 POSIX 上以 `0600` 创建（Windows 沿用用户目录 ACL，不做 POSIX mode 保证）。stdout 输出 manifest `{ invocation_id, variant, directory, items[] }`，每项为 `{ id, message_id, revision_id, kind, status, path, mime_type, bytes, sha256, error }`（`message_id` 为内部消息 ID）；`--json` 是单行 JSON，默认是缩进 JSON。全部成功退出码 0；部分失败保留已下载文件、写 `manifest.json` 并输出 manifest，以 `media_download_failed`（退出码 1）结束；全部失败先尝试删除整个目录，删除成功后把 manifest 输出到 stdout 并以 `media_download_failed` 失败；若文件系统拒绝清理，命令失败、目录可能残留，stdout 不保证含 manifest。下载前先拒绝超过 32 项或声明总量超过 100 MiB 的列表（`media_too_many_items` / `media_total_too_large`，不发生任何下载）；单项超过 20 MiB、变体不存在、超时、重定向与写入失败只记录为该条的 `error` 并继续下一项；manifest 写入失败先尝试删除目录，清理成功后以 `media_manifest_write_failed` 失败；清理受阻时同样不保证目录已删除。manifest 等文本输出与落盘元数据经 API key 脱敏；媒体二进制保留响应原字节，不做文本脱敏，`bytes` 与 `sha256` 对应实际保存的文件。
- 退出码：`0` 成功；`1` 请求/服务端/replay/媒体下载失败，保存文件无效（`invalid_credentials`：JSON 损坏、符号链接、权限不安全等）与写入失败（`credentials_write_failed`）也走 `1`；`2` 参数、输入或凭据不合法（`missing_endpoint`、`missing_api_key`、`invalid_api_key`、`credentials_too_large`、模型选择的 `invalid_model_override`/`invalid_thinking_level`、prompt 覆盖的 `*_prompt_empty`/`*_prompt_too_large` 等）。`login` 写入失败不覆盖旧凭据。
- `doctor` 成功只说明当前凭据能连通并通过鉴权，不代表后续查询的数据仍在保留期内；它不输出 Invocation 正文，也不重试。
- 标准输入只用于 `login` 的 `--api-key-stdin` 与 replay 的 `--global-prompt -` / `--group-prompt -`（两者不能同时）。
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
