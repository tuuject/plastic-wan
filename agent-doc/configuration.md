# 配置

Plastic Wan 使用严格 JSONC 配置。Schema 位于 `src/platform/config.ts`，未知字段会被拒绝；除类型校验外，还会验证时区、ID 唯一性、模型引用、URL 和预算关系。

本页只记录 Schema 表达不出来的语义。每个字段的类型、取值范围和必填性以 `src/platform/config.ts` 的 TypeBox Schema 为准——越界值由 `check-config` 直接报出，不要靠文档抄写的数字判断。

## 加载语义

- CLI 必须显式传入 `--config <path>`。
- 配置在 `serve` 启动时读取一次；只有[运行时配置热更新](#运行时配置热更新)列出的白名单字段可以在运行中应用，其余字段修改后必须重启。
- 配置哈希是原始 JSONC 文本与所有 Prompt 文件内容的 SHA-256，写入 Invocation 并打印在 `serve_started` 日志中。
- 修改 Bucket 窗口、Sticker Set 或 MCP 后必须重启；Prompt、Provider（含连接字段与模型列表）、agent 模型与 vision 模型、已有 Chat 的 `provider`/`model`/`thinking_level` 覆盖、**新增 Chat** 等白名单字段可用 Admin「Apply config file」或 `/model` 热应用；删除 Chat 与修改 Topic 范围仍需重启。
- 相对 `data_dir`/`paths` 按服务当前工作目录解释；Docker 镜像的工作目录是 `/app`。
- Prompt 文件路径（`system_prompt_file`、`instructions_file`）相对于配置文件所在目录解释；修改文件内容同样会改变 `config_hash`。
- Prompt 文件按原始字节参与哈希：剔除 HTML 注释只影响进入模型上下文的文本，纯注释改动仍然改变 `config_hash`。
- 非 Windows 系统要求配置文件 `0600`、父目录 `0700`。

验证命令：

```bash
node src/cli.ts check-config --config dev-data/config.jsonc
```

## 运行时配置热更新

`serve` 启动时读取一次配置，但白名单字段可以在运行中应用：Admin Panel 的「Apply config file」按钮（`POST /api/config/apply`）、Models / Chats 页保存，以及 Telegram `/model`、`/ignoreme`、`/unignoreme` 都会重新读取 `config.jsonc` 并把白名单字段的变化发布到当前进程。没有文件系统 watcher——手改文件后必须显式应用才生效。

热更新白名单（`src/platform/config-diff.ts` 是唯一定义处，未列出的字段一律按 restart 处理；新增字段默认 restart）：

| 路径 | 说明 |
| --- | --- |
| `agent.provider`、`agent.model` | 永远热更新：目标 Provider 可以是同一次修改里新增的，reload 会重建模型注册表并随配置一起发布 |
| `agent.system_prompt_file` | 路径或文件内容变化都算；内容变化会重建每个 Conversation 的 Context；可在面板编辑并保留版本历史 |
| `developer`、`developer.record_model_payloads` | 可选节/字段的增删都热应用，缺省为 `false`；每次模型调用读取当前开关，关闭时后续快照回调停止写入 |
| 其余 agent 字段：`thinking_level`、`context_stop_ratio`、`send_max_text_length`、`send_disallow_blank_lines`、`send_nudge_enabled`、`send_barrier_enabled`、`daily_budget.max_tokens`、`max_concurrency`、`history_messages`、`context.max_wall_clock_seconds`、`context.idle_grace_seconds`、`rate_limits.*` | 下一次 Invocation 使用新值；运行中的 Invocation 继续用它启动时的快照。唯一例外是 `daily_budget.max_tokens`：日预算在运行期实时读取，调低后下一次模型调用立即被拦截 |
| `telegram.chats`（**新增** Chat，整项 `{ id, … }`） | 立即生效：ingestion 白名单、参与策略注册表与 `resolveChatConfig` 都读发布后的配置并按代数重建/直读，无需重启。删除 Chat、已有 Chat 的其它字段修改与 Topic 范围仍是 restart |
| `telegram.chats[<id>].instructions_file` | 仅限两边都存在的 Chat；路径或内容变化都算；可在面板编辑并保留版本历史（Chat 尚无该字段时由面板创建） |
| `telegram.chats[<id>].provider` / `.model` / `.thinking_level` | 仅限两边都存在的 Chat 的按群模型覆盖（语义与校验见「Telegram Chat 与 Topic」）；删除 Chat 仍是 restart |
| `telegram.chats[<id>].ignored_user_ids` | 增删字段、替换或清空列表都热应用；下一条实时/启动追赶 Update 使用新名单，不追溯删除已有 Message 或 Context。成员可用 `/ignoreme`、`/unignoreme` 写入或移除自己的 ID |
| `telegram.admins` | Bot 管理员白名单（`/pause`、`/resume`、`/model`、`/cut_topic`、`/allowlist` 的唯一事实源）；运行期判定直接读运行中的配置，下一次命令执行就用新列表 |
| `providers.<alias>`（新增、删除、改 kind）与 `providers.<alias>.*`（连接字段、模型列表） | Provider 的每个字段都热更新：reload 按新定义重建注册表。模型列表变化只替换该 Provider 的模型；连接字段变化会重新解析它的 SecretRef |
| `vision.provider`、`vision.model`、`vision.max_output_tokens` | 下一次 vision 分析使用新模型；`max_output_tokens` 在构建注册表时与新模型的上限一起校验，并和模型一起在分析开始时从同一份快照取出，等待中发布的新值只影响之后的分析 |
| `image`（整段：存在性、`credentials`、`models` 及所有子字段） | 图片功能启停与配置都热应用：reload 重新解析 image SecretRef 并原子发布新的图片快照，下一次提交生效；进行中的生成继续用它开始时的凭据快照。段被剥离（结构不合法）或删除都等于禁用，Agent 与 Admin 同步失去图片工具与页面能力，不需要重启 |

`outside_serve` 字段（`serve` 从不读取，下一次 `backup` 生效，既不算已应用也不算待重启）：`paths.backups`、`retention.online_days`、`retention.backup_copies`。

其它所有路径都是 restart：改动会写进文件，但要重启才生效，包括 `telegram.token`、`data_dir`、`paths.database`、`admin.*`、`mcp.servers`、`telegram.sticker_sets`、Chat allowlist 的删除与已有 Chat 的修改（新增 Chat 是热变更），以及 `instructions_file`、`provider`、`model`、`thinking_level`、`ignored_user_ids` 以外的 Chat 字段，以及 `vision` 的 `max_concurrency`、`background_sticker_concurrency`、`prompt_version`、`daily_budget`。

应用流程与语义：

- 每次应用做两遍校验：先 `loadConfig` 校验文件本身（保证下次启动可用），再把文件的热字段与当前进程仍然生效的 restart 字段组合成 candidate，用 `validateSemantics` 校验 candidate（保证当前进程可用）。两遍都通过才发布。
- candidate 的 restart 字段保留当前进程的值，热字段与 outside_serve 字段取文件的值。因此组合可能不合法：文件本身合法但与待重启字段冲突时返回 `candidate_invalid`，错误信息会列出待重启路径；文件仍然留在磁盘上，重启后与那些字段一起生效。
- 待重启字段记录在 `ConfigReloader.status().restartRequired`；之后只改热字段再应用也不会清空它。
- 模型定义的修改或删除按热更新处理，但文件与 candidate 都必须保留有效引用（全局 agent、Chat 覆盖、vision）。例如删除待重启移除的 Chat 所引用的模型时，即使文件本身合法，candidate 仍会拒绝；先清除/切换该 Chat 覆盖或重启后再删除。运行中的 Invocation 继续用启动时的快照。
- Provider 的重建规则：连接字段（custom 的 `base_url`/`api`/`api_key`/`headers`，builtin 的 `provider`/`api_key`）没变的 Provider 沿用进程里已有的对象，只替换模型列表，不重新解析 SecretRef；新增或连接字段变化的 Provider 按启动时的路径完整构建，重新解析它的 SecretRef。`command` 引用因此会在 reload 时执行一次进程——与重启同效；reload 由显式应用或配置写入触发，包含成员的自助忽略命令。builtin 仍然用 Pi 的 provider id 发请求，只有注册键是 alias。
- 发布是原子的：新注册表在发布前没有任何人能看到，注册表与配置在同一个同步块里发布。已经开始的 Invocation 与运行中 attach 的 Bucket 继续用运行开始时冻结的快照（快照同时带着模型与 Provider 连接），下一次 Invocation 才用新配置；`invocations.config_hash` 在 `queued → running` 时写入该快照的 active hash。
- vision 分析钉住它开始时的快照：`read_image` 的聊天分析与后台 Sticker 索引在开始时取一次当前配置，用那一份的模型与缓存版本（`<provider>/<model>/prompt-<prompt_version>`）完成这次分析并写入 `media_analyses`。换 vision 模型后聊天图片按新版本重新分析；已经索引的 Sticker 不会重跑，见 [telegram-agent-flow.md](telegram-agent-flow.md)。
- Prompt 变化（`agent.system_prompt_file` 或 `instructions_file`）改变稳定系统提示的哈希，该 Conversation 的 Context 在下一次运行时重建，见「Conversation Context」。
- 两层 Prompt（`agent.system_prompt_file` 与 `instructions_file`）可在 Admin Panel 的 Prompts 端点编辑：保存写 Prompt 文件（去 HTML 注释后的正文）、记录一个版本，再走上述同一套热应用，**下一次**开始的 Invocation 使用新内容；运行中的 Invocation 继续用启动时的快照，要立刻停掉仍按旧 Prompt 运行的那些需在面板显式取消（见 [admin-panel.md](admin-panel.md#prompts-页端点)）。手改 Prompt 文件不会立即产生版本：启动加载与每一次成功应用会把文件当时的内容记成 `external` 版本（去 HTML 注释后与上一条版本相同则不记录），因此改完必须显式应用才进历史。Prompt 写端点的 `If-Match` 是去 HTML 注释后内容的 SHA-256（即 Prompt 视图的 `content_hash`），不是 `config.jsonc` revision——config revision 按设计不含 Prompt 文件。
- 每次成功应用输出 `config_reloaded` 日志事件，带 `generation`、`active_hash`、`file_hash`、`applied`、`restart_required`、`outside_serve`；失败输出 `config_reload_failed`（`code` 与脱敏后的 `error`）。失败时 active 配置与注册表都不变，错误记录在 `ConfigReloader.status().lastError`；`code` 为 `config_invalid`、`candidate_invalid`、`model_unusable`（注册模型缺失或不可用，含 vision 输出上限越界、MCP/Tool 注册表容量不足）或 `secret_unresolved`（新增或连接字段变化的 Provider 无法解析 SecretRef）。全局默认与每个 Chat 的生效组合都须通过校验；删除仍被引用的模型会在文件或 candidate 校验阶段被拒绝，任一失败都不会部分发布。
- `/model` 在写入文件之前就被拒绝时（模型不存在、不可用，或文件无法写入），没有发生 reload：只输出 `model_switch_failed` 日志并把错误返回给调用方，不改变 `lastError`。写入之后应用失败才按上一条处理。
- 没有任何待重启字段时 `active_hash` 等于文件哈希，可以直接与 `check-config` 的输出比对。只改注释或格式、或者把待重启字段改回原值后应用，都会发布一次内容相同的配置，让 `active_hash` 跟上新的文件哈希。有待重启字段时，`active_hash` 是 candidate RawConfig 的 JSON 序列化的 SHA-256；只有 restart 字段变化时它保持不变。
- 写入配置文件（如 `/model`、`/ignoreme`、`/unignoreme`）由 `src/platform/config-file.ts` 完成：只替换 JSONC 的值，保留注释与格式；先写同目录临时文件并完整校验，再 rename 覆盖，因此读者只会看到旧文件或完整合法的新文件。配置文件是符号链接时拒绝写入（`config_symlink`）。带 Secret 的写入（`secretEdit`）把明文写进 key jar，文件里只留条目名，见 [SecretRef](#secretref)。
- Admin「Chats」管理 Chat/Topic 白名单与按 Chat 的模型覆盖：列表分别显示磁盘 Saved settings 与进程 Running settings。新增/删除 Chat 和 Topic 范围修改保存后等待重启，已有 active Chat 的模型/thinking 覆盖热应用；删除不会清除消息、Context 或审计历史，最后一个配置 Chat 不允许删除。编辑只更新这四项管理字段，不覆盖 `instructions_file`、参与策略等其它设置。
- 端点、状态码与响应体见 [admin-panel.md](admin-panel.md#api)。

## SecretRef

Telegram Token、Provider API key、MCP Header/环境变量都使用同一 SecretRef：

```jsonc
[
  // key jar：值在配置文件同目录的 key.json 里，这里只写条目名
  { "jar": "3f9a2c1d8e7b6a50" },
  // 环境变量
  { "env": "GOOGLE_API_KEY" },
  // 固定 argv 的外部命令
  { "command": ["secret-tool", "lookup", "service", "plasticwan"] },
]
```

`config.jsonc` 不接受明文字符串形式的 SecretRef：这样配置文件可以被阅读、比对、贴给别人或交给 agent 检查，而不会带出任何 Secret。`loadConfig` 遇到明文时直接报错，并列出还是明文的字段路径（`telegram.token`、`providers.<alias>.api_key` / `headers.*`、`mcp.servers[].env.*` / `headers.*`）。仓库的 `.claude/settings.json` 用 `Read(**/key.json)` 拒绝 Claude Code 读取 key jar；它只是 Claude Code 这一侧的护栏，管不到其他 agent 和进程，所以 AGENTS.md 里「不要读取 `key.json`」的约定仍然有效。

key jar（`src/platform/key-jar.ts`）：

- 固定为配置文件同目录下的 `key.json`，一个值全为非空字符串的 JSON 对象：`{ "<name>": "<secret>" }`。条目名匹配 `^[A-Za-z0-9_-]{1,64}$`。一个目录里的 `key.json` 只属于这个目录里的 `config.jsonc`。
- 非 Windows 系统上文件必须是 `0600`，否则解析失败（与配置文件同一要求；Docker entrypoint 会顺手 `chmod`）。文件缺失、条目缺失、JSON 无效或权限不对都是 `SecretResolutionError`，reload 时报 `secret_unresolved`；错误信息只含路径和条目名，从不引用文件内容（JSON 解析错误本身会回显出错位置附近的文本）。
- 每次 `resolve` 都重新读文件，所以面板刚写进去的条目下一次 reload 就能解析到。
- 面板和 `configure` 录入的明文都进 key jar，名字是新生成的 16 位十六进制串；换 key 总是写**新条目**、换新名字，而不是覆盖旧条目的值。这是必须的：reload 按 SecretRef 判断连接是否变化，名字不变就不会重新解析。反过来，手工改 `key.json` 里某个现有条目的值不会被热应用识别，要么换一个新条目名再改配置，要么重启。`configure` 在输入时就写入条目（「获取模型列表」要能解析到它），退出时删掉本次新增或原文件用过、但最终留在磁盘上的文件不再引用的条目；磁盘上的文件解析出错时跳过这一步，避免按不完整的引用集合误删密钥。`configure` 保存与面板走同一个 `writeConfigEdits`：先写同目录临时文件、`loadConfig` 校验通过后再原子 rename，校验失败时原文件保持不变；它还带上会话开始时读到的 revision，期间文件被别人改过就拒绝保存，不会覆盖。因此保存同样要求配置文件 `0600`、目录 `0700` 且不是符号链接。
- 写入顺序由 `writeConfigEdits` 保证：新条目在配置文件 rename 之前加入，新文件因此从不引用不存在的条目；新文件不再引用的旧条目在 rename 之后删除（尽力而为，删不掉只会留下一个没人用的值，不算写入失败）。没被当前配置引用过的手工条目不会被清理。

command SecretRef：

- 不经过 shell，只执行配置中的 argv。
- 最长 5 秒。
- stdout 最大 4096 bytes，只移除一个末尾换行。
- 子进程只继承最小环境变量集合。
- 已解析 Secret 会在向用户报告错误前脱敏。短于 6 个字符的值不参与脱敏：这种长度的字符串会命中普通词句和数字，把输出整体打码却保护不了任何东西。所有已知值先在原文上找出全部命中位置，重叠或相邻的区间合并后一次性替换，所以一个 Secret 是另一个的前缀或两者部分重叠时，也不会留下半截明文。

`.env` / `.env.local` 加载：

- 所有 CLI 子命令（`serve`/`check-config`/`doctor`/`backup`/`configure`）启动时用 dotenv 加载当前工作目录下的 `.env.local` 与 `.env`；文件缺失时静默跳过。
- 只按 CWD 解析，不向上递归查找目录。
- 优先级：真实环境变量 > `.env.local` > `.env`；compose `environment:`/`env_file:` 等方式注入的值不会被覆盖。
- 两份文件均已被 `.gitignore` 排除，用于本地开发便利；生产部署仍应使用环境注入。

不要把真实 Token/API key 写进文档、测试、日志或提交。

## 顶层结构

| Section | 用途 |
| --- | --- |
| `version` | 当前只接受 `1` |
| `data_dir` | Serve lock 与运行数据根目录 |
| `timezone` | 默认 IANA 时区 |
| `telegram` | Token、Bucket 窗口、Chat/Topic allowlist、Sticker Set |
| `providers` | 内置或自定义 Provider 别名 |
| `agent` | 对话模型、Prompt、并发与限流、上下文保留策略、全局 Token 预算 |
| `vision` | Sticker 视觉模型、并发、Prompt 版本和预算 |
| `mcp` | 可选的 stdio/Streamable HTTP Server |
| `admin` | 可选的 Admin Panel（审计只读 + 受控管理写端点） |
| `developer` | 可选的开发者调试配置；`record_model_payloads` 缺省为 `false` |
| `retention` | 在线保留天数与备份份数 |
| `paths` | SQLite、媒体缓存和备份目录 |

## Telegram Chat 与 Topic

```jsonc
{
  "telegram": {
    "token": { "env": "TELEGRAM_BOT_TOKEN" },
    "process_bot_messages": false,
    "sticker_trigger_enabled": false,
    "bucket_window_seconds": 15,
    "chats": [
      {
        "id": -1001234567890,
        "instructions_file": "prompts/chat-1001234567890.md",
        "timezone": "Asia/Shanghai",
        "topic_ids": [100, 200],
        "ignored_user_ids": [123456789, 987654321],
        "provider": "google",
        "model": "gemini-3.7-flash",
        "thinking_level": "high",
      },
    ],
  },
}
```

规则：

- `bucket_window_seconds` 是全局 Agent 会话节拍，单位秒，示例值为 15。`0` 表示有新消息时不额外延迟，但不会创建空会话。deadline 锚点、按 Chat 串行、轮中途不交出批次与 attach 到运行中 Invocation 的规则统一见 [Telegram 与 Agent 流程：会话节拍与 Bucket](telegram-agent-flow.md#会话节拍与-bucket)；运行结束后是否继续等待下一个 Bucket 由 `agent.context.idle_grace_seconds` 决定，见「Conversation Context」。
- `process_bot_messages` 控制是否处理其他 Bot 的消息。`false` 时其他 Bot 的新消息与编辑只保留 Update 审计，完全不入库。`true` 时它们会入库，但永远不能创建 Bucket、命中 participation 触发或刷新注意力窗口：已有 collecting Bucket 时直接加入；否则暂存，等下一条真人消息创建 Bucket 时，按 Telegram 时间顺序排在该真人消息之前一并收入（仅收未进过任何 Bucket、晚于该 Conversation 上一个 Bucket 起点、且在 `/cut_topic` 截断之后的最新 `agent.history_messages` 条）。这样两个 Bot 无法互相唤醒形成死循环。自己发送的 Update 始终忽略。带 `sender_chat` 的消息（匿名管理员、以频道身份发言、关联频道自动转发）不算 Bot 消息：Telegram 为兼容会在 `from` 里放一个占位 Bot（如 GroupAnonymousBot），实际作者是 `sender_chat`，按真人消息处理。
- `sticker_trigger_enabled` 可选，默认 `false`。关闭时，单独收到的人类 Sticker 仍会持久化，但不会创建 Bucket 或触发 Invocation；已有 collecting Bucket 时仍会加入。设为 `true` 后，单独的 Sticker 可以创建 Bucket。
- Chat ID 必须是非零安全整数且不可重复。
- 未配置 `topic_ids`：允许该 Chat 的普通消息与所有 Topic。
- 配置 `topic_ids`：只允许列出的正整数 Topic ID；未列出的 Topic 被审计为拒绝。
- Forum Topic 按 `(chat_id, message_thread_id)` 隔离 Conversation。
- `participation`（可选）配置此 Chat 的定时活跃时段、触发关键词与注意力窗口，见「定时活跃（participation）」。
- `ignored_user_ids`（可选）是此 Chat 内要忽略的 Telegram User ID 数组；必须是唯一的正安全整数。匹配 `message.from.id` 的新消息和编辑只保留 Update 审计，不写入 Message、Revision、Media 或 Bucket，也不会进入实时或启动追赶 Invocation 的 Context。命令同样被丢弃，只有实时新消息中的 `/ignoreme`、`/unignoreme` 会放行，供成员自行加入或取消忽略；两者只改发送者自己的 ID，作用于当前 Chat 的全部 Topic。其他成员消息中若 Reply 快照指向被忽略用户，该引用同样不保存。该字段不匹配 `sender_chat` 身份，支持热应用；已入库的旧消息不会追溯删除。
- `instructions_file`（可选）指向该 Chat 的附加系统提示 Markdown 文件，缺省时为空；提示内容不提供额外授权。
- `provider` / `model` / `thinking_level`（可选）是此 Chat 的按群模型覆盖：全局 `agent.provider` / `agent.model` / `agent.thinking_level` 作为默认值，缺省逐项继承（`resolveAgentSettings`）。`provider` 与 `model` 必须成对出现，只写其一会被 `check-config` 直接拒绝；`thinking_level` 可独立覆盖，不必随模型一起写。生效模型按「Chat 覆盖 → 全局默认」逐项解析，该组合必须合法：覆盖模型必须在该 Provider 下存在、支持 text，`thinking_level` 必须被解析后的生效模型接受，否则严格报错。每次 Invocation 从运行快照按此解析模型与思考档；运行中的 Invocation（含 attach 的批次）沿用启动时冻结的快照，下一次 Invocation 才用新值。Topic 共用所在 Chat 的设置，私聊同理；群迁移按已有 `resolveChatConfig` 规则解析到迁移前 Chat 的配置。
- 删除 Chat、修改 Topic 或其它非热字段后必须重启，并比较 `check-config` 与 `serve_started` 的 `config_hash`；新增 Chat、已有 Chat 的 `instructions_file`、`provider`/`model`/`thinking_level` 与 `ignored_user_ids` 属于热更新白名单，见「运行时配置热更新」。
- Chat 没有每日 Invocation 次数上限，也不设 Token 硬上限；Token 只按 Chat 归属统计，唯一硬上限是全局 `agent.daily_budget.max_tokens`。
- `admins`（可选）是 Telegram User ID 数组，Bot 管理员白名单的唯一事实源；只有管理员能执行 `/pause`、`/resume`、`/model`、`/cut_topic`。属热更新白名单，见「运行时配置热更新」。

## 定时活跃（participation）

默认情况下，任何可触发消息都会开 Bucket 并启动 Agent 会话。`participation` 让管理员把群聊改成「按时间表活跃」：时段内行为与默认完全一致，时段外只有命中触发的消息才能唤醒会话。

```jsonc
{
  "telegram": {
    "participation": {
      "active_windows": [
        { "start": "09:00", "end": "12:00" },
        { "start": "20:00", "end": "01:00", "days": [5, 6, 7] },
      ],
      "trigger_keywords": ["塑料碗", "wan"],
      "attention_window_seconds": 300,
    },
    "chats": [
      {
        "id": -1001234567890,
        "participation": {
          "active_windows": [{ "start": "00:00", "end": "24:00" }],
          "trigger_keywords": ["运维"],
        },
      },
    ],
  },
}
```

判定分两步：仅在活跃时段外，为有触发资格且命中 @、Reply 或关键词的新消息创建或刷新注意力窗口；再用更新后的窗口判断 participation 闸门是否放行。该闸门不替代 allowlist、暂停状态和消息触发资格检查。

```text
participation 放行 = 未配置 participation || 处于活跃时段 || 更新后的注意力窗口未过期
```

- `participation` 可挂在 `telegram`（全局默认）与 `chats[]`（每 Chat）两处；两处都不配置时该 Chat 保持默认行为。
- `active_windows`（可选）：每天重复的活跃时段。`start` 与 `end` 是 `HH:MM` 本地时间，`end` 额外允许 `24:00`；`end` 小于 `start` 表示跨午夜并归属开始日（`23:00-01:00` 配 `days: [5]` 覆盖周五 23:00 到周六 01:00）；`days`（可选）为 ISO 星期 `1`–`7`，1 是周一，省略表示每天。判定是半开区间 `[start, end)`。
- 时段按 Chat 时区解释：`chats[].timezone`，缺省用顶层 `timezone`。
- **每群覆盖全局**：`chats[].participation.active_windows` 存在即整体替换全局值；`[]` 表示该 Chat 没有时段，只能靠触发唤醒。
- `trigger_keywords`（可选）：**每群追加**到全局列表；匹配消息的 `text` 与 `caption`，大小写不敏感。`[]` 表示没有关键词触发。
- `attention_window_seconds`（可选，默认 300）：命中后窗口的长度；同样每群覆盖全局。
- 时段外只有三类消息能开 Bucket：直接 @ Bot、Reply Bot 自己发过的消息、命中 `trigger_keywords`。任意一类命中都会把该 Conversation 推进注意力窗口，窗口内再次命中则重置计时，窗口内该 Conversation 与时段内一样始终触发。
- 窗口只在时段外维护：时段结束时立即回到静默，时段末尾的一次 @ 不会延续到时段之后。
- 粒度是 Conversation（Chat + Forum Topic）：时段是 Chat 级，窗口只覆盖命中发生的那个 Topic。
- 被闸门拦下的消息照常入库并保留 Revision，只是不开 Bucket；它们会在下一次触发时作为 history 进入 Context，因此静默期不会丢上下文。
- 私聊不受 `participation` 影响（即使配置了全局时段）；在正数 Chat ID（私聊）上显式写 `participation` 会被 `check-config` 拒绝。
- `/pause` 优先于 `participation`：暂停期间既不建 Bucket 也不记录窗口。
- `active_windows` 与 `trigger_keywords` **不设条数上限**。启动期会预编译时段、将关键词小写化，并复用时区 Formatter，减少重复解析；逐消息匹配仍遍历时段与关键词，成本随列表长度和消息文本长度增长。`attention_window_seconds` 有上界，表达「永久活跃」应写 `00:00-24:00`。
- 修改后必须重启；窗口状态存在数据库里，跨重启保持。

## Sticker Set

```jsonc
{
  "telegram": {
    "sticker_sets": [{ "alias": "cats", "name": "TelegramStickerSetName" }],
  },
}
```

- `alias` 是模型搜索/发送使用的稳定名称。
- `name` 是 Telegram Sticker Set 名称。
- 只允许发送配置中的 Set。
- Set 在启动时同步，后台以单并发建立视觉索引。

## Provider

内置 Provider 复用 Pi AI 的供应商目录：baseUrl、API 适配器、认证与供应商特有逻辑都由 Pi 提供，但**模型列表必须在配置里显式写出**。Pi 目录里有、配置里没写的模型，运行时不可用——`models[]` 同时充当「启用模型」子集，Telegram `/model` 的列表也只列配置里的模型。

```jsonc
{
  "providers": {
    "google": {
      "kind": "builtin",
      "provider": "google",
      "api_key": { "env": "GOOGLE_API_KEY" },
      "models": [
        {
          "id": "gemini-3.7-flash",
          "reasoning": true,
          "thinking_levels": ["low", "medium", "high"],
          "input": ["text", "image"],
          "context_window": 1048576,
          "max_tokens": 65536,
          "cost": { "input": 0.3, "output": 2.5, "cache_read": 0.075, "cache_write": 0.3 },
        },
      ],
    },
  },
  "agent": {
    "provider": "google",
    "model": "gemini-3.7-flash",
  },
}
```

`provider` 是 Pi 的供应商 id，必须同时满足：目录非空、目录内 API 唯一且属于受支持的四类、`baseUrl` 有具体取值、带 `auth.apiKey`。不满足时 `check-config` 直接拒绝（`mistral`、`xai`、`google-vertex`、`cloudflare-workers-ai` 等都不满足）。builtin 的 `api` 由 Pi 目录推导，`base_url` 取自 Pi，两者都不写进配置。

自定义 Provider 必须显式声明 API 兼容层和模型元数据：

```jsonc
{
  "providers": {
    "gateway": {
      "kind": "custom",
      "base_url": "https://example.invalid/v1",
      "api": "openai-responses",
      "api_key": { "env": "GATEWAY_API_KEY" },
      "models": [
        {
          "id": "model-id",
          "reasoning": true,
          "compat": { "supports_developer_role": false },
          "input": ["text", "image"],
          "context_window": 128000,
          "max_tokens": 8192,
          "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
        },
      ],
    },
  },
}
```

可用 `api`：`openai-responses`、`openai-completions`、`anthropic-messages`、`google-generative-ai`。`google-generative-ai` 的 `base_url` 必须已经包含版本路径（例如 `https://generativelanguage.googleapis.com/v1beta`），Pi 不会再追加版本号。

Provider alias 必须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`：它出现在 Admin API 的路径段和 reload 报告的 `providers.<alias>.*` 路径字符串里。

`agent` 模型必须支持 text；若同时支持 image，用户 Photo/图片 Document 直接作为多模态输入，否则保留为 `read_image` capability 并由独立 `vision` 模型按需解析。`vision` 模型必须支持 image，也负责 Sticker 的按需理解与后台索引；配置输出上限不能超过注册模型上限。

### 模型 thinking 级别

`thinking_levels`（可选）列出这个模型接受的 thinking 级别，取值是 Pi 的 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，按这个顺序从弱到强；列表至少一项、不能重复，写入顺序无所谓。只有 `reasoning: true` 的模型可以写，非推理模型写了直接拒绝。

| 模型 | 接受的级别 |
| --- | --- |
| `reasoning: false` | 只有 `off` |
| `reasoning: true`，没写 `thinking_levels` | Pi 的默认：`off` 到 `high`；`xhigh` 与 `max` 必须显式声明 |
| `reasoning: true`，写了 `thinking_levels` | 列表里的级别 |

注册模型时声明的列表转成 Pi 的 `thinkingLevelMap`（`src/platform/thinking-levels.ts`）：没列的级别映射为 `null`，`xhigh` / `max` 映射为同名值，其余列出的级别不写映射，由各 API 适配器发送自己的取值（例如 Gemini 的 `LOW`）。这样 Pi 的 `getSupportedThinkingLevels` 与配置校验得到的是同一张表。

`agent.thinking_level` 必须是 agent 模型接受的级别，否则 `validateSemantics` 拒绝（`agent.thinking_level … is not supported by … (supported: …)`）。因此把 agent 模型的级别列表改得不再包含当前级别，会在写入前被拒绝：要先调整 `thinking_level`，再改模型。Chat 的 `thinking_level` 覆盖按同样的规则对照该 Chat 解析后的生效模型校验（`chat <id>.thinking_level … is not supported by …`）。

Admin Panel 从 models.dev 的 `reasoning_options` 预填级别（`src/platform/models-dev.ts` 的 `extractThinkingLevels`）：`effort` 的取值直接对应 Pi 级别，其中 `none` 是 `off`；`toggle` 额外提供 `off`；只有 `budget_tokens` 时取 Pi 能换算成预算的 `minimal`–`high`，预算本身不代表能关闭。models.dev 没有给出可选级别时（没有 `reasoning_options`、空列表即始终推理、只有开关）不预填，模型沿用 Pi 默认。与其它元数据一样，跨 Provider 或模糊匹配得来的级别需要管理员确认；缺失的级别不需要确认。

**已知限制（暂缓修复）：Anthropic 原生接口没有 adaptive thinking。** Pi 的 `anthropic-messages` 适配器只在模型带 `compat.forceAdaptiveThinking === true` 时按 effort 发送 thinking（`low`–`max` 原样传给 API），否则走 token 预算：`clampReasoning` 把 `xhigh` / `max` 折成 `high`，预算固定为 16384。Pi 的模型目录给 Opus 4.6+、Sonnet 4.6+ 与 Fable 5 标了这个字段，但本项目不使用 Pi 的模型目录（模型只来自配置 `models[]`），而 `anthropic-messages` 的 compat 白名单是空的（`src/platform/config.ts` 的 `COMPAT_FIELDS_BY_API`），配置里也写不进这个字段。结果是：经 builtin `anthropic` 或 `api: "anthropic-messages"` 的 custom Provider 调用这些 Claude 模型时，即使声明并选了 `xhigh` / `max`，实际也只按 `high` 的预算思考；这些模型是否仍接受预算模式，尚未用真实 API 验证。经 OpenRouter 等 `openai-completions` 路径调用不受影响，effort 会原样发送。同一原因还让这些模型丢了 Pi 目录里的 `supportsTemperature: false` 与 `supportsStrictTools`。Claude API 价格高，项目暂不直连，需要时再修：给 `anthropic-messages` 开放 `force_adaptive_thinking` compat 字段并在 `mapCompat` 映射，或在注册 builtin `anthropic` 模型时继承 Pi 目录里同 id 模型的 compat。

### 模型 compat

「OpenAI 兼容接口」在细节上各有方言，`compat` 是 Pi 自动检测的覆盖开关。每个字段都可以省略，省略即「自动」（由 Pi 按 provider id 与 baseUrl 检测），因此升级 Pi 后检测改进会自动生效；写死一个值等于冻结它。

| 配置字段 | Pi 字段 | 适用 API | 取值（省略即「自动」） |
| --- | --- | --- | --- |
| `supports_developer_role` | `supportsDeveloperRole` | openai-completions、openai-responses | `true` / `false` |
| `thinking_format` | `thinkingFormat` | openai-completions | `openai`、`openrouter`、`deepseek`、`together`、`zai`、`qwen`、`string-thinking`（需要额外 kwargs 的取值不开放） |
| `max_tokens_field` | `maxTokensField` | openai-completions | `max_completion_tokens` / `max_tokens` |
| `requires_reasoning_content` | `requiresReasoningContentOnAssistantMessages` | openai-completions | `true` / `false` |
| `cache_control_format` | `cacheControlFormat` | openai-completions | `anthropic`（Pi 用 `??` 合并，无法强制关闭，因此是「自动 / anthropic」二态） |

模型的 API 不适用某个字段时 `validateSemantics` 直接拒绝；`anthropic-messages` 与 `google-generative-ai` 没有可开放的字段。Admin Panel 只显示当前 API 适用的字段，并能预填 `requires_reasoning_content`（models.dev 的 `interleaved.field === "reasoning_content"`），其余一律留在「自动」。

`configure` 向导与 Admin 的「获取模型列表」按 API 选择列表端点：OpenAI 系拼 `${base_url}/models`（Bearer）；Anthropic 系拼 `${base_url}/v1/models`（`x-api-key` + `anthropic-version`，按 `has_more`/`last_id` 翻页）；`google-generative-ai` 拼 `${base_url}/models`（`x-goog-api-key`，按 `nextPageToken` 翻页，只保留 `supportedGenerationMethods` 含 `generateContent` 的模型）；Vercel AI Gateway 是特例，拼 `${base_url}/v1/models`（Bearer，只保留 `type === "language"`）。该响应只用于发现可路由的模型 ID；`reasoning`、输入能力、上下文、输出上限与费用由供应商扩展字段、models.dev 或管理员确认后写入。

### 模型 tool schema 关键字

`tool_schema_keywords`（可选）决定这个模型的 Tool 定义里能带哪些 JSON Schema 关键字，由运行时而不是 Pi 读取（`src/platform/tool-schema.ts`）。省略即原样发送：Tool 参数按 TypeBox 写成什么样就发什么样。取值 `minimal` 时把 schema 收敛成「能折叠成解码文法的形状」：

- 丢掉只用于事后校验的注解：`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`、`multipleOf`、`minItems`、`maxItems`、`uniqueItems`、`minProperties`、`maxProperties`、`default`、`format`、`$schema`、`patternProperties`；
- `anyOf` / `oneOf` 收敛成第一个带 `type` 的变体的那个类型（联合里的 `enum`、`pattern` 不保留）——文法折叠器拒绝「同一个值有两种读法」，无类型的属性在它看来正是这种歧义；`allOf`、`not`、`if`/`then`/`else`、`contains`、`propertyNames`、`dependent*`、`unevaluated*` 一并丢掉。没有变体带 `type` 时只能整段丢掉，属性退化成只剩 `description` 的文档。

为什么需要它：把 Tool 参数折叠成解码文法的端点会拒绝不认识的写法，而且是整个请求 400，模型一个 token 都没生成：

```
failed to translate request: folding the request grammar: grammar rejected:
tool "read" parameter schema: parameter "uri": unsupported schema keyword "minLength"
```

同一个端点还会在联合类型上再拒一次（`tool "brave__brave_web_search" parameter schema: parameter "goggles": more than one JSON reading of the same emitted value`）。

一次这样的失败就让 Invocation 以 `model_error` 结束，对应的 Bucket 落 `failed`，那批消息不重试（实际案例见 OpenRouter 上 `qwen/qwen3.8-27b:free` 路由到的 ModelRun）。收敛不会放松运行时的边界：每个 Tool 在自己的边界上重新校验参数（MCP Tool 用服务端发布的原始 schema 编译自己的校验器，与发给模型的那份副本无关），这些关键字本来就只是给模型的提示，不是强制手段。

主 Agent 的 Tool 注册表（含 allowlist 的 MCP Tool）按 agent 模型声明的 profile 发送，Vision 的 Sticker 分析 Tool 按 vision 模型声明的 profile 发送；两者各自读自己那条模型配置。Admin Panel 的模型编辑弹窗把它放在 thinking levels 之后，三态为 `Automatic` / `minimal`。

## Agent 与 Vision

- `daily_budget.max_tokens`: 主 Agent 与聊天触发的 `read_image` 共享的全局每日 Token 上限；各 Chat 用量仍分别写入 `daily_usage`。它是防止循环、失控 Invocation 与 Tool loop 的安全熔断，不是成本预算，因此计的是一次模型调用涉及的全部 token：非缓存输入、缓存读取、缓存写入与生成（`meteredTokens`，`src/store/sleep.ts`）。模型是否收费、缓存是否便宜都不影响计量，免费模型同样受限。pi-ai 规范化后的 `input` 已扣除缓存读写，四项互不重叠，直接相加不会重复计数；Provider 原始 `total_tokens` 不参与计量。缓存读写仍在 `model_calls` 与 Admin Panel 的 Model call 明细里单列，`vision.daily_budget` 的 `vision_tokens` 同口径。
- `system_prompt_file`: 指向运维侧人格提示的 Markdown 文件，路径相对配置文件目录，内容必须非空（剔除 HTML 注释后仍需有正文）。消息分区、安全边界、Tool 选择原则和副作用成功判定由代码内 Core Agent Protocol 固化；具体 Tool 的触发条件、禁用情形、调用顺序与收尾规则由 Tool description 固化，不应重复塞入人格文件。人格提示和 Chat 的 `instructions_file` 支持 `{{ agent.provider }}`、`{{ agent.model }}`、`{{ vision.provider }}`、`{{ vision.model }}`、`{{ timezone }}` 模板变量；模板只执行严格白名单替换，未知或格式错误的表达式会拒绝配置。
- Prompt 注释：`system_prompt_file` 与 `instructions_file` 中的 `<!-- ... -->` HTML 注释在加载时被剔除，可以写给人看的说明而不占模型上下文；注释可跨行，整行只有注释时该行一并消失。未闭合的 `<!--` 不构成注释，按原文保留；模板校验在剔除之后进行，因此注释里可以出现任意 `{{ ... }}` 文本。提示文件含 NUL 字符时拒绝加载。
- 模板中的 `agent.provider` 与 `agent.model` 是当前 Invocation 实际使用的模型（按 Chat 解析后的生效值，未覆盖时即全局默认），因此 Admin Panel 或 `/model` 的运行时切换会反映到下一次会话；`vision.*` 始终来自配置。模板值只注入 Prompt，不会注入记忆；记忆内容按原文保留。
- `max_concurrency`: 全局并行 running Invocation 上限；`history_messages` 是每个新开 Invocation 冻结 history 快照的条数上限（attach 进运行中 Invocation 的批次不带 history）。渲染时会跳过保留 transcript 里已经有的消息，所以真正注入的只是 transcript 从没见过的那部分，例如被参与闸门挡住、从未注入过的消息；并不是只在冷启动时才生效。单次运行不再有 `max_turns`/`max_sends`/`timeout_seconds`（字段已删除，写进配置会被拒绝），运行边界见「Conversation Context」。
- `context_stop_ratio`: 估算输入 Token 达到 `context_window × context_stop_ratio` 后进入收尾模式：下一次模型调用只带 `send` 和当时可用的 `zzz`，模型用这一轮把话说完；这一轮结束后运行以 `completion_reason = context_limit` 结束。收尾轮只给一次，模型调用使用的是本次运行实际生效的模型（含 `/model` 热切换后的模型），GC 的 token 判据同理。
- `send_max_text_length`（可选，默认不限制）：`send` 工具文本消息的最大字符数。超出时 Tool Call 记为 `send_text_too_long` 错误，不消耗发送配额、不调用 Telegram；Sticker 不受影响。
- `send_disallow_blank_lines`（可选，默认 `false`）：开启后，文本包含任何空行（两个换行符之间只有空格/Tab 也算空行）时 Tool Call 记为 `send_blank_lines` 错误，不消耗发送配额、不调用 Telegram；段落只能用单个换行分隔。Sticker 不受影响。
- `memory_ttl_warning_days`（可选，默认 30）：Agent 记忆剩余寿命超过该天数时，Admin Panel 显示 warning，提示管理员判断保留、删除或提升进 `agents.md`。系统不禁止长 TTL。
- `send_nudge_enabled`（可选，默认 `false`）：开启后，当 agent 即将自然停止、本轮未调用任何工具且产生了去除首尾空白后非空的普通 Assistant 文本，又从未调用过 `send` 时，注入一条 harness 级 user 消息提醒其用 `send` 发送面向群聊的文本。判定排在「注入下一批」与空闲等待之前，因此该提醒按**注入批次**计数（每个批次至多触发一次），而不是按 Invocation 计数；触发与提醒文本记录在 `agent_messages` 中，role 为 `harness_nudge`。用于稳定性不足、偶尔把回复写成私文本却忘记调用 `send` 的模型。
- `send_barrier_enabled`（可选，默认 `false`）：开启后，一轮里第一次即将真正发出的 `send` 前，若同一 Conversation 已有 `collecting` Bucket（模型组织回复期间又来了可触发消息），这批立即 attach 进当前 Invocation，本次 `send` 以 `send_barrier` 拒绝，新批次在下一个 turn 边界注入，模型读完再决定发什么，从而把「一句话被窗口切成两批、各回一次」合并成一次回复。每轮至多拦一次，行为细节见 [Telegram 与 Agent 流程：send 屏障](telegram-agent-flow.md#send-屏障)。
- `thinking_level`: 全局默认的 thinking 级别，取值同上，必须是 agent 模型接受的级别（见「模型 thinking 级别」）；被 Chat 的 `thinking_level` 覆盖时只影响未覆盖的 Chat，语义见「Telegram Chat 与 Topic」。切换全局 agent 模型（Admin Panel 或全局路径）时一并重置为新模型接受的最弱级别；可在 Admin Panel「Models」页的 In use 面板单独修改，热应用。

Agent 不再配置 `max_output_tokens`：每次请求的输出上限直接使用目标模型在 provider 中声明的 `max_tokens`。Provider 注册的模型必须满足 `max_tokens ≤ context_window`，且 agent 模型必须支持 text。

运行时热切换分两层：**全局**沿用 Admin Panel「Models」页面（`GET /api/providers` 与 `PUT /api/model`），把 `agent.provider` / `agent.model` 写入 `config.jsonc`，同时把 `agent.thinking_level` 重置为新模型接受的最弱级别（各模型的级别不同，旧模型的级别新模型未必有），然后重新加载配置，因此重启 `serve` 后仍然生效；该端点仍只改全局默认，不改动任何 Chat 的覆盖。**按群**可在 Admin「Chats」页编辑覆盖，或由 Telegram `/model` 完成：只写当前 Chat 的 `telegram.chats[<id>]` 覆盖并重置该 Chat 的 thinking 为目标模型最弱档，`/model default` 删除该 Chat 的三项覆盖恢复继承全局；命令细节见 [telegram-agent-flow.md](telegram-agent-flow.md#bot-commands)。两层都只对后续启动的 agent session（Invocation）生效，不影响进行中的会话。若稳定系统提示的渲染结果因此变化（模板里出现 `{{ agent.provider }}`/`{{ agent.model }}`，或模型的图片能力改变了图片处理说明），该 Conversation 的 Context 会在下一次运行时重建——仅在稳定段内容实际变化时重建，渲染结果与图片说明都相同的切换不清空历史，见「Conversation Context」。`/status` 命令展示当前 Chat 的生效模型。

`vision` 约束：

- 独立 Provider/Model 与输出上限，用于 text-only Agent 的普通图片回退和 Sticker 分析。
- 前台 `read_image` 并发由 `max_concurrency` 控制。
- `background_sticker_concurrency` 当前必须为 `1`。
- `prompt_version` 参与视觉缓存版本；改变描述规则时递增。
- `daily_budget` 同时限制 Token 和图片数，但只作用于后台 Sticker 索引（`daily_usage` 的 `system`/`sticker_index`）；聊天触发的 `read_image` 计入全局 `agent.daily_budget.max_tokens`。

## Image 生成

`image` 段是**可选**段：没有该段就是「图片生成禁用」，bot 照常启动。段的增删与内部任何字段都属热更新（见热更新白名单，`image` 整段在 `HOT_PREFIXES` 里）：Admin「图片设置」页的启用开关写 `image` 段并立即重载，禁用→启用→再禁用全程不需要重启。

进程启动时会解析已保存的图片凭据并发布图片配置快照，因此有效配置在重启后自动恢复启用，不需要再次保存。若凭据解析或快照校验失败，仅禁用图片能力并记录脱敏的 `image_service_warning`；`image_service_started.enabled` 反映初始化后的真实状态。修复后可通过 Admin 应用配置恢复。

结构：

```jsonc
{
  "image": {
    "credentials": {
      "openrouter": { "env": "OPENROUTER_API_KEY" }
    },
    "models": [
      {
        "id": "gpt-image-1",
        "name": "GPT Image",
        "description": "示例偏好：日常插画优先选用；用自然语言描述主体、构图和光线",
        "provider": "openrouter",
        "upstreamModel": "openai/gpt-image-1",
        "credentialRef": "openrouter",
        "providerTag": "openrouter",
        "capabilities": {
          "imageInput": true,
          "maxInputImages": 4,
          "maxOutputs": 4,
          "aspectRatios": ["1:1", "3:4", "4:3", "9:16", "16:9"],
          "resolutionClasses": ["low", "medium", "high"]
        }
      }
    ]
  }
}
```

字段语义：

- `credentials`: 凭据名 → SecretRef，与 Provider 的 SecretRef 同一机制（明文只能进 key jar，文件里写 `{jar}` / `{env}` / `{command}` 引用）。Admin 设置页保存时，编辑请求里附带的明文凭据写入 jar，文件只留条目名；删除段后不再被任何 `credentialRef` 引用的 jar 条目会被回收。
- `models[]`: 可路由的生图模型，上限 64 个。`id` 是模型在 Admin 下拉与 Agent 工具参数里的标识；`credentialRef` 必须指向 `credentials` 里的条目；`provider`/`providerTag` 描述经哪个 Provider 连接与上游打标；`upstreamModel` 是上游真实模型 ID。`description` 可选（最长 1000 字符，可空）：该模型路由的独立备注，说明它适用的画风/任务与提示词风格。备注只作为 Agent 选型与编写提示词的指导——系统不自动拼接备注原文、不把它作为独立字段发送给生图上游、也不能覆盖任何工具授权；Agent 经只读的 `list_image_models` 能力读取（见 [telegram-agent-flow.md](telegram-agent-flow.md#image-生成)），Admin「图片设置」的模型卡片可直接编辑并随保存热应用。`capabilities` 由 image-service 包在准备快照时做能力契约校验（host schema 只做结构校验）：`imageInput` 决定能否携带参考图，`maxInputImages`/`maxOutputs` 约束参考图数量与单次输出数，`aspectRatios`/`resolutionClasses` 是参数白名单——模型接受的取值必须列在这里，否则该次提交在参数校验阶段就被拒绝。
- **软校验降级**：`loadConfig` 对 `image` 段单独校验，结构不合法的段被剥离（记录 warning），进程以「图片生成禁用」状态启动——坏掉的 image 段永远不会阻止 bot 上线，管理员随后经 Admin 面板修复或启用。剥离信息记录在 `LoadedConfig.warnings`，Admin 配置状态页可见。
- 图片快照随每次 reload 原子发布：reload 重新解析 `credentials` 的 SecretRef 并重建快照，同一轮生成的凭据在轮次开始时固定（轮次中途轮换密钥不影响进行中的生成）；运行中的生成不受 reload 影响，下一次提交才用新配置。
- 原始生成图与参考图存放在 `<data_dir>/images`，按 SQLite 中的资产行索引；`backup` 把该目录快照为备份文件旁的 `<备份名>.images/`（best-effort：目录缺失就跳过，拷贝失败只记日志不中断备份；SQLite 快照与目录拷贝之间没有跨库原子性）。
- 数据保留遵循 `retention.online_days`：图片生成记录与资产行随在线数据一起清理，原图文件随目录清理。

Agent 侧使用（`image_generate` 工具、图片技能、发送与审计链路）见 [telegram-agent-flow.md](telegram-agent-flow.md#image-生成)；Admin 三页与启用开关的端点语义见 [admin-panel.md](admin-panel.md#api)。

## Conversation Context

每个 Conversation（Chat + Forum Topic）只有一份持久 transcript，跨 Invocation 与进程重启存在；`agent.context` 控制这份历史如何保留与裁剪，`agent.rate_limits` 控制长生命周期运行的节流。表的语义见 [data-layer.md](data-layer.md#conversation-context长期会话-transcript)。

```jsonc
{
  "agent": {
    "context_stop_ratio": 0.75,
    "history_messages": 30,
    "context": {
      "retained_sends_target": 20,
      "retained_sends_max": 40,
      "hard_token_ratio": 0.7,
      "ref_ttl_hours": 72,
      "idle_grace_seconds": 60,
      "max_wall_clock_seconds": 900,
      "agent_cache_size": 32,
    },
    "rate_limits": {
      "sends_per_window": 3,
      "window_seconds": 120,
      "turns_per_injection": 24,
    },
  },
}
```

`agent.context` 与 `agent.rate_limits` 都是必填对象，新增字段会因 `Strict` 被拒绝；升级旧配置时漏写或残留旧键都会让 `check-config`/`serve` 直接失败，错误信息会点名缺失与多余的键。`agent.context`：

- `retained_sends_target` / `retained_sends_max`: 保留窗口的目标与上限，单位是成功 `send` 的次数。只有在保留窗内发送数超过 `retained_sends_max`（或触发 Token 压力）时才裁剪，裁剪把窗口起点跳到「仍保留至少 `retained_sends_target` 次发送」的最新 checkpoint，因此一次 GC 会跨过若干次发送，而不是逐条消息裁。
- `hard_token_ratio`: Token 安全阀，相对模型的 `context_window`。估算输入加预留输出达到 `context_window × hard_token_ratio` 就会触发 GC，用于发送稀疏但 Tool 链很长的历史；这类历史找不到满足发送目标的 checkpoint 时，退回「保留段估算 Token 不超过 `context_window × hard_token_ratio × 0.8`」的最新 checkpoint。
- `ref_ttl_hours`: 能力引用（`img_`/`stk_`/`reply:`）在 Conversation Context 内的有效期；引用一旦到期，或携带它的历史行被 GC 丢弃，就解析不出来了。
- `idle_grace_seconds`: 运行本该自然结束时，仍保持打开等待下一个 Bucket 的秒数；等待期间有新批次就继续这一轮，否则结束；`0` 表示关闭长生命周期运行（每批消息都会结束这次运行，下一次由新的调度启动）。
- `max_wall_clock_seconds`: 单次运行的墙上时钟上限，达到即结束这次运行。
- `agent_cache_size`: 内存中缓存 Pi agent 实例的 Conversation 数（LRU）。缓存只是加速——被逐出或进程重启后都从 SQLite 的 Conversation Context 重新播种，不丢历史。

`agent.rate_limits`：

- `sends_per_window` / `window_seconds`: 按 Telegram Chat 计算的滑动窗口发送上限，统计窗口内所有已发往 Telegram 的 `telegram_sends`（`success`/`pending`/`outcome_unknown`/`error` 都算，失败的尝试同样消耗额度）。命中时 Tool Call 记为 `send_rate_limited` 错误，不调用 Telegram；长生命周期运行可以发很多次，但循环不能刷屏。
- `turns_per_injection`: 自最近一次消息注入以来允许的最大 turn 数，达到即结束这次运行；注入新批次后计数清零。

`check-config` 另外校验这些关系（Schema 通过不代表组合合法）：

- `retained_sends_target < retained_sends_max`。
- `hard_token_ratio <= agent.context_stop_ratio`。
- `idle_grace_seconds` 为 `0`（关闭长生命周期运行）或不小于 `telegram.bucket_window_seconds`；比一个 Bucket 窗口还短的等待会在下一个 Bucket 到期前就结束运行，看似启用实则无效，因此在配置期直接拒绝。
- `max_wall_clock_seconds > idle_grace_seconds`。

稳定系统提示与重建：稳定段与每批注入段各含什么，见 [Telegram 与 Agent 流程：Context 生命周期](telegram-agent-flow.md#context-生命周期)。配置侧只需记住：人格提示、Chat `instructions` 及其模板变量渲染结果都属于稳定段，其 SHA-256 记在 `conversation_contexts.system_prompt_hash`。稳定段内容一变（改 Prompt 文件或 `instructions_file`、运行时切换模型导致模板或图片说明变化等——仅当实际变化时才重建，切模型本身不必然清空历史），该 Conversation 的整份 Context 会重建：已保留的 transcript 与能力引用全部丢弃，`head_seq`/`next_seq` 复位为 1。时间、记忆、睡眠状态等运行期状态随批次注入，改变它们不会触发重建。

## MCP

支持两种 transport：

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "search",
        "transport": "stdio",
        "command": ["node", "server.js"],
        "required": false,
        "tools": "*",
        "payload_max_bytes": 32768,
        "result_max_bytes": 32768,
        "default_tool_policy": {
          "read_only": true,
          "timeout_seconds": 20,
        },
      },
    ],
  },
}
```

Streamable HTTP 使用 `url` 与可选 SecretRef `headers`，且 `follow_redirects` 必须为 `false`。`url` 可以包含服务协议要求的查询参数，但禁止 URL userinfo 与 fragment；机密值应使用 SecretRef `headers`，不应写入查询参数。`tools` 为 `"*"` 时全部 Tool 共享 `default_tool_policy`；`tools` 为显式数组时，每个列出的 Tool 必须在 `tool_policies` 中提供对应策略，`default_tool_policy` 只服务于 `"*"`。策略只包含 `read_only` 与 `timeout_seconds`，没有每日调用次数上限。没有策略的 Tool 不会暴露给模型。`required = true` 的 Server 启动失败会阻止 `serve`/`doctor` 成功。

## web_fetch

```jsonc
{
  "web_fetch": {
    "allow_proxy_synthetic_addresses": false,
    "dangerously_allow_all_ip_addresses": false,
    "accept_markdown": true,
  },
}
```

- 整个 section 可省略。`allow_proxy_synthetic_addresses` 默认 `false`：域名解析到 `198.18.0.0/15` 时 `web_fetch` 拒绝访问，因为任何人都能把自己的域名解析到这个网段，所在网络恰好路由它时就成了 SSRF。
- 只有在 fake-ip 代理后运行（Clash、Surge 等把所有域名都解析到该网段）的部署才设为 `true`，否则 `web_fetch` 取不到任何网页。即使开启，模型直接提交该网段的 IP 仍会被拒绝。
- `dangerously_allow_all_ip_addresses` 默认 `false`。设为 `true` 后跳过全部目标地址校验：环回、私网、链路本地（含云厂商 `169.254.169.254` 元数据端点）、IP 字面量与跳转到这些地址的目标都会放行，此时 `allow_proxy_synthetic_addresses` 不再起作用。URL 规则不变：仍只允许 HTTP(S) 默认端口、禁止 URL 凭据与 fragment、最多 3 次跳转、不发 Cookie。群聊里任何人都能让模型访问内网，只应在信任所有可触发 bot 的人、且确实需要读取自有内网服务的部署中开启。开启后 Tool 描述会告知模型可以访问私网地址。
- `accept_markdown` 默认 `true`：请求的 `Accept` 以 `text/markdown` 优先（HTML 降为 `q=0.9`）。支持内容协商的站点（如开启 Cloudflare「Markdown for Agents」的站点）会直接返回自己的 Markdown，原样交给模型，不再经过本地 HTML 抽取。设为 `false` 时 `Accept` 恢复为不含 Markdown 的旧值；站点返回的 Markdown 质量不如本地抽取时可以关闭。模型传 `raw: true` 时无论开关如何都不声明 Markdown。
- 修改后需要重启（不在热更新白名单内）。

## Admin Panel

Developer 页使用可选的 `developer.record_model_payloads`（boolean，缺省 `false`）；整个 `developer` 节也可省略。文件层保留缺省状态，`assembleRawConfig` 将运行时值归一为 boolean。该设置可热应用，每个模型调用开始时读取当前值；关闭期间已在途调用的后续快照回调也停止写入。开启不会补录关闭时启动的调用。正常审计、错误与历史快照不受开关影响，历史报文必须通过 Developer 清除操作主动删除。

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8787,
    "session_ttl_hours": 168,
    "static_dir": "/opt/plasticwan/apps/admin-next/dist",
  },
}
```

- `enabled = false` 或省略整个 section 时 `serve` 不监听任何 HTTP 端口。
- `host` 是任意非空字符串，不做回环限制；绑定非回环地址（如 `0.0.0.0`）会把面板暴露给所在网络，TLS 与访问控制由运维负责。推荐保持回环并经反向代理对外。
- `session_ttl_hours` 同时决定 Session 过期与 Cookie `Max-Age`。
- `static_dir` 可选，默认 `apps/admin-next/dist`（相对仓库根解释）；目录缺失时审计 API 仍可用，静态路由返回 503 `admin_bundle_missing`。

详细认证、API 与前端约定见 [admin-panel.md](admin-panel.md)。
