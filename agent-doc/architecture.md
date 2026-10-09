# Plastic Wan 架构

## 进程组成

Plastic Wan 是单进程 Node.js 服务。`src/application.ts` 负责装配以下组件：

```text
Config + SecretStore
        │
        ├─ ServeLock + SqliteStore
        ├─ grammY Bot / Telegram API
        ├─ Pi AI Model Registry（随配置快照发布）
        ├─ TelegramIngestion
        ├─ MediaService ── FFmpeg / FFprobe / python-lottie / Sharp
        ├─ StickerService
        ├─ McpManager
        ├─ AgentRuntime
        ├─ BucketScheduler
        ├─ BotCommandService / AgentModelSwitcher / ConfigReloader
        ├─ AdminServer（仅 admin.enabled = true）
        ├─ LongTaskService（long_tasks / task_receipts）
        ├─ 内置 Plugin（含 alarm）
        └─ ImageService（packages/image-service 核心；单 Worker 图片生成，原文件存 <data_dir>/images）
```

启动顺序有语义：先加载并校验配置与权限，再取得单实例锁、迁移数据库、连接 Telegram、同步 Sticker Set；随后排空 Telegram pending updates，按 Conversation 创建 startup catch-up Invocation；最后启动 MCP、Scheduler、Admin Panel 和常规 long polling。启动时加载的配置是 active 配置的起点：运行期只有白名单字段可以被 `ConfigReloader` 应用到当前进程，其余字段仍要重启，见 [配置：运行时配置热更新](configuration.md#运行时配置热更新)。关闭时停止 Bot，先停 Admin Panel 再等待 Scheduler（最多 30 秒），随后停止 Image worker（在数据库连接关闭之前落地中断标记），停止 Sticker/MCP 服务，关闭数据库并释放锁。

## 主数据流

```text
Telegram Update
  │
  ▼
TelegramIngestion
  ├─ allowlist / Topic / bot-message 校验
  ├─ Chat 迁移归一化
  ├─ Message + Revision + Media 持久化
  └─ 收集进配置长度的 Bucket
        │
        ▼
BucketScheduler / ConversationRuntime
  ├─ 冻结 history/new 消息快照
  ├─ Conversation 无 running Invocation：创建 Invocation
  ├─ Conversation 已有 running Invocation：attach 并注入该 Invocation
  ├─ 恢复、节拍判定
  └─ 调用 AgentRuntime
        │
        ▼
ContextBuilder（稳定 system prompt + 本批注入块）
  ├─ 稳定段：Core Agent Protocol、System Skill 索引、人格与 Chat 指令、能力说明
  ├─ 注入段：当前时间、睡眠状态、完成回执、Memory + 本批新消息
  ├─ 历史来自 canonical Conversation Context，不重新渲染
  ├─ Reply 可见集合来自 context_refs
  ├─ 模型支持 image：本批 Photo/图片 Document 多模态载荷
  └─ 模型不支持 image：图片 capability 引用
        │
        ▼
Pi Agent（按 Conversation 缓存，播种自 canonical history）
  ├─ runtime 原语（直接暴露）
  ├─ execute → runtime 内部能力（按需发现与调用）
  └─ allowlisted MCP tools（直接暴露）
        │
        ▼
send Tool → Telegram API → 审计
```

每个 Conversation 持有一份持久化的 **Conversation Context**（`conversation_contexts` + `context_messages`）：它是 canonical history，进程重启与 Agent 缓存驱逐都不影响它。Pi Agent 实例按 Conversation 缓存在 `ConversationRuntime` 里，启动时从 canonical history 播种，是**可丢弃的缓存**而不是事实源。一次 Invocation 是一个运行窗口——期间可以注入多批新消息、多次调用模型与 Tool、多次 `send`——但 Invocation 最终仍会结束，Context 保留到下一次。Context 的增长由 checkpoint + 丢弃式 GC 控制（见 [Context 生命周期](telegram-agent-flow.md#context-生命周期)），没有 summarization 或 compaction。Conversation 级短期记忆（`memories`）随每一批注入，按创建时间升序排列在注入块内，TTL 到期或 Agent 主动删除后消失。

## 隔离的历史场景重建

Admin 的 Invocation 重放是新的内存 Agent 循环，不是生产 Conversation Context 的续跑。默认重建源开场 Bucket 的公开消息与当时可证明存在的历史；切片模式只取目标 Bot 发送前的公开窗口，拍平可证明在发送前已注入的批次。两者都使用当前配置的 prompt、模型、只读 System Skills 和工具定义，不恢复私有推理或旧工具结果，默认模式不加入后续热注入。生产执行器与 Context 写者不接入；媒体/reply 引用仅在本次场景有效，发送及记忆等副作用合成，模型调用仍真实计费并共享并发闸门。它不依赖开发报文录制，不新增跨 Invocation 的 Context 副本；契约与保真限制见 [Admin Panel：Invocation 重放](admin-panel.md#invocation-重放)。

## 模块职责

代码按层组织，依赖只允许自上而下：`ingress/` → `orchestration/` → `capabilities/` → `context/` → `store/` → `platform/`；`plugins/` 只被组合根引用，可依赖 `capabilities/` 及以下各层；组合根（`application.ts`、`cli.ts`、`doctor.ts`、`startup-catch-up.ts`、`tui/`）位于 `src` 根，可以引用所有层。

| 层 | 职责 |
| --- | --- |
| 组合根（`src/` 根文件与 `tui/`） | 进程装配、CLI、诊断、启动追赶、配置向导 |
| `ingress/` | 外部输入边界：Telegram Update 入库、Admin Panel HTTP、认证与审计查询 |
| `orchestration/` | Bucket → Invocation 状态转换、调度与并发、Agent 运行循环、Bot 命令 |
| `plugins/` | 内置 Agent 插件：`definePlugin` 定义、`loadPlugins` 校验与装配、`builtin.ts` 清单；包含 `web-fetch` 与 `alarm`。插件只获得 invocation scope、审计和绑定任务服务，不直接持有 Store 或 Runtime |
| `capabilities/` | 模型可调用的 Tool 与外部能力（原语、媒体、Sticker、MCP） |
| `context/` | Conversation Context：canonical history 存储、GC、引用、编解码、模型输入组装、记忆与完成回执注入 |
| `store/` | SQLite 连接、schema 与迁移、通用 `long-tasks` 服务及跨层共享的持久化状态 |
| `image/` | 图片生成核心的进程级装配：借出宿主 SQLite 连接、`<data_dir>/images` 文件存储与优雅停止；领域实现与领域测试在私有包 `packages/image-service`（provider adapter 边界见包内 `provider.ts`） |
| `platform/` | 无业务依赖的基础模块：配置、Secret、Provider、并发、子进程、Prompt 模板等 |
| `system-resources/` | 随 runtime 发布的 `system:///` 只读资源树（System Skills） |

逐文件导航见 [AGENTS.md 的 Project Structure](../AGENTS.md#project-structure--module-organization)，本页不维护文件清单副本；模块职责基本能从层级和文件名推出，源码是唯一事实源。只有几处放置位置和名字不直观，需要单独记住：

- `application.ts` 装配的 AgentRuntime 与 Scheduler 共享一个 `ConversationRuntime`；`orchestration/conversation-runtime.ts` 拥有 Agent 实例 LRU 缓存与「已 attach 待注入的 Bucket」队列，是 runtime 与调度之间的唯一握手点。
- `platform/agent-protocol.ts` 是代码固化的 **Core Agent Protocol**——消息分区、Tool 选择原则与副作用成功判定都在这里，不在人格 Prompt 文件里。它属于稳定段：改动它等于重建所有 Conversation Context。稳定段不写参与时机：是否发言由模型按当前批次自行判断；群聊的消息准入由运行期 participation 闸门决定（配置了才生效）。
- [platform/system-resources.ts](../src/platform/system-resources.ts) 加载只读 **System Skills**；索引注入、按需读取和调用契约统一见 [Skills 与受控能力调用](telegram-agent-flow.md#skills-与受控能力调用)。Skill 提供操作知识而不授予权限，能力是否注册仍由组合根决定。
- 不是所有 Agent Tool 都在 `capabilities/`：`zzz` 定义在 `store/sleep.ts`，`add_memory`/`delete_memory` 定义在 `context/memory.ts`，`web_fetch` 在 `plugins/web-fetch/`，Alarm 在 `plugins/alarm/`，各自与所属状态放在一起。找某个 Tool 的实现时按名字 grep，别只翻 `capabilities/`。
- `store/long-tasks.ts` 持久化 plugin/Conversation 绑定的任务及唯一完成回执；timer 任务和外部 `complete`/`fail` 都写入同一套终态/receipt，未实现通用后台 executor、running/progress 或 retry。`store/invocation-snapshot.ts` 是 Invocation 消息快照的冻结边界；`orchestration/invocation-queue.ts` 负责 Bucket/receipt → Invocation 的同步状态转换、attach、恢复与 Startup Catch-up。这两个名字容易和 `scheduler.ts` 混淆——Scheduler 是唯一的 timer、回执投递、事件循环与并发驱动。
- `platform/invocation-context.ts` 是无依赖的叶子类型模块，存在的唯一目的是打断 import 环，不要往里加逻辑；它同时定义 `CapabilityRefResolver`（引用解析边界）与 `InvocationContextState`（一次运行中可被新批次刷新的可变上下文）。
- `platform/config-reload.ts` 的 `ConfigReloader` 是配置热更新的唯一入口：`reloadFromFile()`、`setAgentModel()`（全局默认）与 `setChatModel()`/`resetChatModel()`（单个 Chat 的模型覆盖写入与清除）把 `config.jsonc` 中白名单字段的变化发布到 `RuntimeConfigurationStore`（generation + 1），其余字段只报告为待重启。每次发布都带着这一代的模型注册表（`platform/providers.ts` 的 `buildModelRegistry`）：连接字段没变的 Provider 沿用进程里已有的对象，新增或连接变化的 Provider 重新解析 SecretRef，所以一次 reload 会重建注册表并把注册表与配置一起发布。白名单只定义在 `platform/config-diff.ts`；写配置文件走 `platform/config-file.ts`（保留注释，先写同目录临时文件并校验再 rename；带 Secret 的写入把明文放进同目录的 key jar `key.json`，见 `platform/key-jar.ts`）。语义见 [配置：运行时配置热更新](configuration.md#运行时配置热更新)。

## 并发模型

- Scheduler 最多并行运行 `agent.max_concurrency` 个 Invocation。
- 同一 Conversation 只允许一个 running Invocation；长活 Invocation 依赖这条不变量接收 attach。
- 同一 Chat 的 Invocation 仍然串行：另一个 Forum Topic 到期的 Bucket 不会 attach 到当前 Invocation，它属于另一个 Conversation Context。
- `KeyedSemaphore` 避免同一 Chat 的 Agent 与 `read_image` Vision 并发占用模型。
- Vision 总并发由 `vision.max_concurrency` 限制；后台 Sticker 索引固定单并发，且优先级低于前台 `read_image`。
- MCP 每个 Server 有独立的调用 semaphore、重连状态和审计。连接、发现 Tool 或注册表校验任一步失败时都会关闭这次新建的 client（stdio 子进程 / HTTP 会话），不留下无人持有的连接；`stop()` 与连接过程并发时，连接完成后发现已停止或已被更新的连接取代，就关闭自己而不发布为 `ready`。旧 client 的 `tools/list_changed` 通知与过期的刷新结果同样丢弃。

## 恢复与节拍

- 进程启动时恢复未完成 Bucket/Invocation。
- 小于 5 分钟的工作可重新排队；更旧工作标记为过期或恢复失败，避免无限重放。
- Scheduler 先完成到期 timer 任务，再原子 claim pending 完成回执并创建独立 Bucket，按会话状态附加到运行中的 Invocation 或排队新 Invocation；任务完成不等于聊天已处理。进程恢复时所有 claimed receipt 都关闭为 handled/`outcome_unknown`，绝不退回 pending 或重放。
- 同一 Chat 最多一个 running Invocation；完成回执可与普通 Invocation 同时 queued，启动时回执优先，但不会并行执行。若同一 Conversation 的运行仍接受注入，回执使用自己的空 Bucket attach 到该 Invocation；同一 Invocation 可有多个 receipt，跨 Topic 仍维持 Chat 级串行。Bucket deadline 只会被往后推、从不提前裁剪，完整节拍规则见 [会话节拍与 Bucket](telegram-agent-flow.md#会话节拍与-bucket)。
- attach 到运行中 Invocation 但从未注入的 Bucket 在运行结束时重新排队成新 Invocation，不会被静默丢弃。
- 一旦 Tool 产生不可逆副作用，未知结果不得盲目重试；状态进入 `outcome_unknown` 供审计处理。

## 信任边界

以下内容全部是不可信数据：Telegram 文本与媒体、Reply/Forward 元数据、MCP Tool 描述、MCP 结果、模型生成的 Tool 参数。

Memory 内容是模型自己写入的持久化数据，按 Conversation 隔离，每条由 `add_memory` 写入时限 150 字符；注入前不做额外校验。它不构成任何授权来源，管理员可在面板中人工审核或删除。

Conversation Context 是运行时自己写下的历史，但它由模型输出与 Telegram 输入拼装而成，因此其中的文本、Tool 参数与 Tool 结果仍然只是数据：恢复旧 transcript 不等于恢复旧授权。

代码而不是 Prompt 执行授权：

- Chat/Topic allowlist 在入库边界校验。
- Reply Message ID、媒体引用（`img_`）、Sticker 引用（`stk_`）必须来自**当前 Conversation Context** 的 capability 且未过期：引用按 context 隔离，永不跨 Conversation 解析，被 GC 淘汰的消息携带的引用立即失效。
- 普通 Assistant 文本不会发往 Telegram；模型驱动的 Telegram 输出只能经过 `send`（`send_reply` 把一次回复的每一条都交给同一条 `send` 管线依次发出）。确定性的 Bot 命令回复直接调用 Bot API，不经过模型，见 [Bot Commands](telegram-agent-flow.md#bot-commands)。
- `read` 只能读取 `system:///` 树内的 Markdown 文档：URI 段校验拒绝 `..`、反斜杠、百分号转义与非 Markdown 资源；Skill 内容是 runtime 文档，不是授权来源。
- `execute` 只 dispatch 组合根注册的内部能力；`read`/`send`/`send_reply`/`execute`/`zzz` 原语与 MCP Tool 不在注册表内，无法被间接调用。`execute.call` 返回 `{text, refs}` 封套：文本截断到 32 KiB，引用只能是以 Context 级 token 形式返回的 capability 引用（如 `sticker_ref`），由 `send` 在边界处校验后消费。
- MCP Tool 必须通过配置 allowlist、策略、超时和大小限制。
- `web_fetch` 只允许默认端口的公网 HTTP(S) GET；每次 DNS 与跳转目标都重新校验，连接固定到已校验地址，且不发送 Cookie 或认证信息。
- 模型不能取得 Bash、任意进程、任意文件或原始 Telegram file ID 能力；模型也永远不能创建、修改或删除 Skill。

## 外部依赖

| 依赖 | 用途 |
| --- | --- |
| grammY | Telegram long polling 与 API |
| Pi Agent Core / Pi AI | Agent 循环、模型和 Provider 抽象 |
| better-sqlite3 + Drizzle ORM | 持久化、状态机与审计（连接层 better-sqlite3，业务查询 Drizzle；见 data-layer.md） |
| Sharp | 图片解码、缩放和格式转换 |
| FFmpeg / FFprobe | 视频 Sticker 中间帧提取 |
| python-lottie | TGS 代表帧先导出 SVG，再由 Sharp 转 PNG/JPEG |
| MCP SDK | stdio 与 Streamable HTTP Server |
