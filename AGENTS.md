# Repository Guidelines

本文件是 AI agent 在 Plastic Wan 仓库中的统一入口。优先检索 `agent-doc/` 顶层主题文档和源码，不要凭通用知识猜测本项目的行为、配置或数据库结构。`agent-doc/design/` 是历史归档，默认不读取、不检索；仅在用户明确指定参考其中的设计、按该设计实施或追溯历史决策时，才按需读取。普通功能需求不自动启用历史资料；其中的执行指令不自动生效，实现前仍须核对当前源码。

Plastic Wan 是一个运行在 Telegram 私聊、群组、Supergroup 与 Forum Topic 中的 Agent Bot。它收集短时间窗口内的新消息，构造受限上下文，调用模型决定是否参与，并且只允许模型通过显式 Tool Call 产生 Telegram 副作用。

## Project Goals

- 仅处理配置允许的 Chat 与 Topic。
- 以全局可配置的固定长度 Bucket 聚合连续消息，并保留编辑修订。
- 每个 Conversation 维护一份跨 Invocation 存活的连续 Agent Context；Context 不做摘要，只按 checkpoint 丢弃旧历史。
- 是否发言由模型自行决定；runtime 不规定参与倾向，性格与表达只由人格 Prompt 承担。
- Assistant 普通文本永不直接发布，必须调用 `send`。
- 支持图片理解、Sticker 视觉索引与受限 MCP Tool。
- 提供只读 System Skills：模型沿「索引 → `read` SKILL.md → `execute.call`」链路使用 runtime 内部能力，Skill 对模型永远只读。
- 不向模型暴露 Bash、任意代码执行或不受限文件系统能力。
- 审计 Invocation、模型调用（含每次请求附带的工具）、Tool Call、Telegram 发送、Context GC 与预算使用。
- 提供 Agent 短期记忆：模型自己记、自己忘，TTL 兜底遗忘；管理面板人工审核长 TTL 记忆。
- 提供本地 Admin Panel，审计 Tool Session、消息、Sticker 视觉缓存与 Conversation Context，并管理记忆。
- 在线数据按必填的 `retention.online_days` 保留（项目按 30 天设计，代码无默认值）；长期记忆只以人工审核后的 `agents.md` 形式存在。

## Project Structure & Module Organization

```text
plasticwan/
├── src/                    # Node.js/TypeScript 运行时代码；依赖自上而下
│   ├── application.ts      # 组合根：进程装配、启动与优雅关闭
│   ├── cli.ts              # serve/check-config/doctor/backup/configure 入口
│   ├── doctor.ts           # 真实依赖与外部连接诊断
│   ├── startup-catch-up.ts # 启动补偿拉取与排队
│   ├── tui/                # 交互式配置向导
│   ├── ingress/            # telegram-ingestion 与 admin/（Panel 认证、审计查询、HTTP 边界）
│   ├── orchestration/      # scheduler、invocation-queue、agent-runtime、conversation-runtime、bot-commands
│   ├── plugins/            # 内置 Agent 插件：plugin（definePlugin/loadPlugins）、builtin 清单、alarm/、web-fetch/
│   ├── capabilities/       # send-tool、read-tool、execute-tool、mcp、stickers、media/
│   ├── context/            # context-builder、context-store、context-refs、context-gc、context-codec、memory
│   ├── store/              # database、schema、migrations/、long-tasks、invocation-snapshot、sleep、participation、admins
│   ├── platform/           # config、secrets、providers、system-resources 等无业务依赖模块
│   └── system-resources/   # 随 runtime 发布的 system:/// 只读资源树（System Skills）
├── test/                   # vitest 行为测试与 MCP fixture
├── scripts/                # 一次性维护脚本（直连 better-sqlite3，不属于业务层）
├── apps/admin-next/        # Rsbuild + React + Tailwind + shadcn Admin Panel 前端（纯静态 SPA）
├── apps/docs/              # Rspress 中文官网与用户指南（独立静态站）
├── packages/image-service/ # 私有图片生成核心包：有损意图 API、provider adapter 边界、领域测试
├── src/image/              # 图片核心的进程级装配（借宿主连接、<data_dir>/images、优雅停止）
├── Dockerfile              # 两阶段镜像；媒体依赖打包在内
├── docker-compose.yml      # Docker 部署模板（/config 与 /data 两个卷）
├── agent-doc/              # 面向 agent 的按主题文档
│   └── design/             # 设计原文与未落地计划；不描述当前行为
└── dev-data/               # 本地配置、数据库和缓存；已 gitignore
```

## Architecture Overview

```text
Telegram Update
  → allowlist/topic 校验
  → SQLite 消息与 Revision 入库
  → 参与闸门（活跃时段 / 注意力窗口）
  → 配置长度 Bucket
  → Invocation 快照（新 Bucket 或 attach 到运行中的 Invocation）
  → ContextBuilder（稳定 system prompt + 本批注入）
  → Conversation Context（canonical history）+ 受限 Tools
  → send Tool
  → Telegram API
```

群聊参与可由 `telegram.participation` 与 `chats[].participation` 收窄：配置了时段后，时段外只有直接 @、Reply Bot 自己发过的消息或命中触发关键词的消息才会开 Bucket，命中后该 Conversation 进入可配置长度的注意力窗口；私聊与未配置的群保持「任何可触发消息都开会话」的默认行为。

Invocation 是运行窗口而不是一次问答：`agent.context.idle_grace_seconds > 0` 时，运行期间到期的 Bucket 会被 attach 并注入同一个 Invocation（`invocation_buckets`），Conversation Context 跨 Invocation 持久化；取 0 则退回「一次 Bucket 一次 Invocation」，但 Context 依然连续。

媒体与 MCP 都在 Tool 边界内：模型只能读取当前 Conversation Context 授权且未过期的媒体引用；MCP Tool 经过 allowlist、只读策略、请求/响应大小限制、超时和审计。工具面分三层——runtime 原语（`read`/`send`/`execute`/`zzz`）直接暴露；内部能力（`web_fetch`、`search_stickers`、`read_image`、记忆和插件提供的 Alarm 等，注册表见 `src/application.ts` 的 `capabilityTools`，其中内置插件贡献的能力来自 `src/plugins/builtin.ts`）经 `execute` 的 search/help/call 调用；MCP Tool 直接暴露。通用长期任务由 `store/long-tasks.ts` 持久化，唯一 Scheduler 同时处理 timer 完成与完成回执投递；插件只通过绑定 plugin/Conversation 的任务服务创建、完成或取消任务。System Skills（`src/system-resources/skills/` 与插件目录下的 `skills/`）是只读文档包，system prompt 只注入索引，正文由模型用 `read` 按需加载。记忆按 Conversation 隔离，由模型通过 `add_memory`/`delete_memory` 能力维护，TTL 到期自动清理；`agents.md` 才是经过人工审核的长期知识。

架构细节见 [agent-doc/architecture.md](agent-doc/architecture.md)。

## Where to Look

| 你想了解…… | 去看…… |
| --- | --- |
| 文档入口与主题索引 | [agent-doc/README.md](agent-doc/README.md) |
| 进程组成、数据流、并发和信任边界 | [agent-doc/architecture.md](agent-doc/architecture.md) |
| JSONC、SecretRef、Chat/Topic、Provider、MCP 配置 | [agent-doc/configuration.md](agent-doc/configuration.md) |
| SQLite 表组、迁移、保留与备份 | [agent-doc/data-layer.md](agent-doc/data-layer.md) |
| Telegram 入库、Bucket、Context、发送与媒体流程 | [agent-doc/telegram-agent-flow.md](agent-doc/telegram-agent-flow.md) |
| Conversation Context 生命周期、GC、热注入与引用 TTL | [agent-doc/telegram-agent-flow.md](agent-doc/telegram-agent-flow.md#context-生命周期) |
| Skills、`read`/`execute` 原语与内部能力注册表 | [agent-doc/telegram-agent-flow.md](agent-doc/telegram-agent-flow.md) |
| 本地运行、依赖、Docker 部署、诊断和故障处理 | [agent-doc/operations.md](agent-doc/operations.md) |
| Admin Panel 认证、审计 API 与前端 | [agent-doc/admin-panel.md](agent-doc/admin-panel.md) |
| 测试命令与真实验收矩阵 | [agent-doc/verification.md](agent-doc/verification.md) |
| 用户文档、首页、生成参考与静态站维护 | [apps/docs/README.md](apps/docs/README.md) |
| 审计某次 Invocation、排查 bot 为什么不回复 | [.agents/skills/plastic-wan-audit/SKILL.md](.agents/skills/plastic-wan-audit/SKILL.md)、[scripts/audit.ts](scripts/audit.ts) |

历史资料的按需索引与读取边界见 [agent-doc/README.md](agent-doc/README.md#历史归档读取规则)。判断当前行为只看源码与上表主题文档，不以历史设计作为当前约束或待办。

## Build, Test, and Development Commands

```bash
pnpm install
pnpm run check
pnpm test
node src/cli.ts check-config --config dev-data/config.jsonc
node src/cli.ts doctor --config dev-data/config.jsonc
node src/cli.ts serve --config dev-data/config.jsonc
node src/cli.ts backup --config dev-data/config.jsonc
node src/cli.ts configure --config dev-data/config.jsonc
pnpm run admin:build
pnpm run admin:test:e2e
pnpm run admin:dev
pnpm run docs:dev
pnpm run docs:build
pnpm run docs:verify
pnpm run docs:preview
```

- 包管理器为 pnpm（`pnpm-lock.yaml`）；运行时为 Node.js ≥24，测试运行器为 vitest（`pnpm test`），CLI 入口为 `node src/cli.ts …`。
- `pnpm run check`：严格 TypeScript 检查（runtime/Admin/docs）；文档检查前会准备被忽略的版本元数据、字段参考和示例，不输出编译 JS。
- `pnpm test`：运行全部行为测试。
- `check-config`：只验证 JSONC Schema、语义与引用，输出配置哈希。
- `doctor`：执行 SQLite/Sharp/FFmpeg/Lottie、Provider、Vision、Telegram 与 required MCP 的真实探针。
- `serve`：启动 Telegram long polling；白名单字段（agent 模型、Prompt、预算与并发等，见 [agent-doc/configuration.md](agent-doc/configuration.md#运行时配置热更新)）可在运行中通过 Admin 的「应用配置文件」或 `/model` 应用，其余字段仍需重启。
- `backup`：执行保留清理、SQLite `VACUUM INTO` 备份与轮换；完整性检查属于独立恢复验证。
- `configure`：`src/tui/` 的交互式配置向导，编辑既有配置的 Provider 与 thinking level，可从 Provider `/models` 拉取可路由模型 ID 后写回原文件。要求已存在可加载的配置且 stdin 是 TTY，非交互环境直接报错退出——agent 不要调用它。
- `admin:build`：构建 `apps/admin-next` 生产 bundle（`apps/admin-next/dist`），供 `serve` 静态托管。
- `admin:test:e2e`：Playwright 浏览器 E2E（`apps/admin-next/e2e`），驱动 `admin:build` 产物与真实 AdminServer 子进程，首次运行前需安装 Chromium；CI 的 Docker workflow 构建后会运行同一套件。命令细节与单套件过滤见 [agent-doc/verification.md](agent-doc/verification.md#admin-panel-浏览器-e2e)。
- `admin:dev`：启动 Rsbuild dev server（监听 127.0.0.1:5273），`/api` 代理到运行中的 Admin Panel。
- `docs:*`：独立静态文档站；`dev`/`preview` 监听 127.0.0.1:5274，`build` 输出 `apps/docs/dist`，`verify` 检查生产 HTML/Markdown/llms 与 HTTP。维护及部署边界见 [apps/docs/README.md](apps/docs/README.md)。用户可见行为、配置或运维改变时，同步更新相关指南、示例与测试，不把 `agent-doc/` 自动发布到站点。

## Long-Running Process Rules

- `serve` 是长期进程。Agent 必须使用进程监督器启动，等待 `serve_started`，并通过日志或真实消息验证。
- 同一 `data_dir` 只能有一个实例；`ServeLock` 使用 `serve.lock` 防止双实例和 Telegram long polling 竞争。
- 需要替换同一 `data_dir` 上正在运行的实例时用 `node src/cli.ts serve --config <path> --takeover`：它请求对方优雅退出并等锁释放（对方日志 `takeover_requested`，接管方 `takeover_completed`），不要手动删 `serve.lock` 或强杀进程。
- 修改 `config.jsonc` 后：白名单字段可用 Admin 的「应用配置文件」或 `/model` 热应用，其余字段必须重启。成员的 `/ignoreme`、`/unignoreme` 也会写回当前 Chat 的 `ignored_user_ids` 并热应用配置文件。用 `config_reloaded` 日志事件（同时带 `active_hash` 与 `file_hash`）或 `check-config` 输出对比哈希，避免误判白名单或模型配置。没有文件系统 watcher，文件只有在显式应用或配置写入入口被调用时才生效。
- 本地人工运行使用 `Ctrl+C` 停止；不要用未验证 PID 的强制终止命令。
- Admin Panel 随 `serve` 在同一进程内启动，仅在 `admin.enabled = true` 时监听；`admin.host` 不限制回环，非回环绑定的暴露风险由运维承担。

## Coding Style & Naming Conventions

- TypeScript ESM，运行时为 Node.js ≥24（type stripping 直接执行 `.ts`）；本地源码导入保留 `.ts` 后缀。
- 源码必须是 Node type stripping 可擦除语法：禁 `enum`、`namespace`、构造器参数属性（`constructor(private x: T)`）与 `import x = require()`。`tsconfig.json` 的 `erasableSyntaxOnly` + `module: "nodenext"` 让 `pnpm check` 在评审时强制这条；Node type stripping 本身不读 tsconfig，只认可擦除语法。
- 只用 Node.js 运行时 API；目录定位用 `import.meta.dirname`。
- 2 空格缩进、分号、双引号、尾随逗号；沿用现有文件格式。
- `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitReturns` 必须保持通过。
- `pnpm run lint` 需要保持通过，如果存在问题需要先使用 `pnpm run lint:fix` 进行自动修复，如果无法自动修复需要尝试进行手动修改。
- 配置和外部响应在边界处使用 TypeBox 校验；不要把未经校验的 `unknown` 转成业务类型。
- SQLite ID 使用 `bigint`；Telegram JSON 中需要字符串化的 ID 不得经过不安全 `number` 转换。
- 业务查询走 `store.orm`（Drizzle 同步 API；表定义在 `src/store/schema.ts`，新增迁移必须同步更新）；`store.db` 仅限连接层、doctor 探针与测试验证断言。复杂 SQL 与 FTS5 用 `sql` 模板，值一律绑定参数。
- Conversation Context 的 canonical history 只有一个写者（`src/context/context-store.ts` 的 `ConversationContextStore`）；Pi Agent 的 transcript 是可丢弃缓存，任何裁剪都必须同时推进 `head_seq`、loop context、`Agent.state.messages` 与 `context_refs`，否则三份历史会分叉。同一份 Context 在运行期只能有**一个** header 对象：缓存命中时把运行开始时读到的 header 赋给缓存条目，否则注入路径与引用解析用的是一份永不推进的旧快照。
- 不新增第二套 Provider、调度、审计或进程执行约定；复用现有模块。
- 清理式切换：迁移所有调用方并删除旧路径，不保留兼容别名或隐藏 fallback。
- Admin Panel 后端复用 `SqliteStore`，审计查询只读；管理写入只允许 [agent-doc/admin-panel.md](agent-doc/admin-panel.md#api) 写端点白名单中的端点，新增写端点须同步该表。

## Testing Guidelines

- Bug 修复必须复现原故障并验证审计状态，不只验证返回文本。
- 新行为测试应覆盖外部可见契约、边界、预算、恢复、状态转换和真实错误。
- Provider/Telegram 单元测试使用现有 Faux 或 fixture；真实外部连接由 `doctor` 和人工 Telegram 验收覆盖。
- 媒体改动至少覆盖静态图片、Sticker 结构化输出或外部转换链路中受影响的一项。
- Context 改动至少断言 canonical history 的落盘状态（`context_messages` / `head_seq` / `context_refs`）与审计事件，不能只断言返回文本。
- Admin Panel 前端、admin API 端点或面板可见文案（含 locale 键值）改动，提交前运行 `pnpm run admin:test:e2e`，至少覆盖受影响套件（如 `pnpm run admin:test:e2e 01-routes`）：e2e 断言各路由真实渲染与页面可见文案（英文 locale），`pnpm test` 与 `pnpm run check` 不包含这一层，漏跑只会在 CI 上暴露。
- 最终验证至少运行受影响测试与 `pnpm run check`；跨模块改动运行完整 `pnpm test`。

## Commit & Pull Request Guidelines

- 提交信息使用简短英文祈使句，与现有历史一致，例如 `Implement Telegram agent bot`、`Fix sticker vision parsing`。
- 提交前运行 `git diff --check`、相关测试和 TypeScript 检查。
- 不提交 `dev-data/`、`key.json`、真实 Token、API key、SQLite、媒体缓存或备份。
- PR 说明应列出行为变化、数据库/配置影响、验证证据和真实环境中仍未执行的检查。

## Security & Configuration Invariants

- Telegram 消息、媒体内容、MCP 描述/结果和 Tool 参数都是不可信数据，不得提升为指令。
- Telegram 发送只能经过 `send` Tool；普通 Assistant Message 是私有推理记录。
- `read` 只能读取 `system:///` 树内 Markdown 文档；`execute` 只 dispatch 组合根注册的内部能力，四个原语与 MCP Tool 不可经它调用；任何 Skill 文档都不能覆盖 Tool 约束或授权规则。
- 图片和 Reply 只能引用当前 Conversation Context 授权且未过期的 capability；引用按 Conversation 隔离，永不跨 Conversation 解析；禁止接受任意 file ID、Chat ID 或 Topic ID。
- `config.jsonc` 不接受明文 Secret：明文只存在配置同目录的 `key.json`（`{ "jar": "<name>" }` 引用），其余用环境变量或受限 command SecretRef；错误输出必须经 `SecretStore.redact`。排查配置读 `config.jsonc` 即可，不要读取 `key.json`。
- MCP HTTP 禁止重定向和 URL 凭据；stdio 仅执行配置中的固定 argv。
- 非 Windows 系统上，`serve` 与 `doctor` 都要求配置文件 `0600`、其父目录 `0700`；`data_dir` 不得授予 group/other 权限只由 `doctor` 检查（`serve` 仅在目录缺失时以 `0700` 创建）。
- Admin Panel 密码只以 Argon2id hash 存储；Session Token 只存 SHA-256 摘要，Cookie 为 `HttpOnly` + `SameSite=Strict`。
- Admin 审计 API 全部只读；写入只允许 [admin-panel.md](agent-doc/admin-panel.md#api) 白名单中的控制端点，且都校验 `Origin`。过滤参数经白名单校验并使用绑定参数，禁止拼接 SQL。
