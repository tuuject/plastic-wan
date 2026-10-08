# 数据层

Plastic Wan 使用单个 SQLite 数据库保存消息、调度状态、能力索引、预算与审计。数据库不是长期记忆；在线保留窗口由必填的 `retention.online_days` 指定。

## 打开与迁移

`SqliteStore.open` 使用 better-sqlite3，并启用：

- `defaultSafeIntegers(true)`：整数列读成 `bigint`
- WAL journal
- `synchronous = FULL`
- foreign keys
- 5 秒 busy timeout

表级的 `STRICT` 由迁移 DDL 声明，不是连接选项。

迁移文件位于 `src/store/migrations/`，文件名为 `NNN_name.sql`，按编号排序。每个迁移在 IMMEDIATE transaction 中执行并记录到 `schema_migrations`。已有数据库存在待执行迁移时，先在备份目录创建 `pre-migration-*.sqlite`。

迁移 `021` 删除旧 `internal_contexts` 旁路观察，不向 canonical history 回填，也不删任务、回执或正常审计。工具结果只随 `context_messages` 保留；本次移除旧提示词也会改变稳定 prompt hash，升级后首次打开 Conversation 时仍按既有规则重建 Context，不为旧外挂保留兼容通道。迁移 `022` 为既有回执回填其所属 Invocation 的 Bucket，并把唯一性从 Invocation 转为非空 `bucket_id`；因此同一 Invocation 可保留多个 receipt。

迁移 `027` 为图片发送去重添加发送审计查询索引，并给旧 `telegram_sends.request_json` 回填发送当时已存在的 `asset_ids`（标记 `asset_ids_inferred`）。数量与旧 `pictures` 不一致时标记 `asset_ids_unknown`，阻止把不确定的旧投递当成可重发；后续生成的资产不会回填成旧发送的输出。发送审计本身就是交付台账，不引入第二套 outbox，去重范围也受在线保留窗口约束。

新增迁移时：

1. 创建下一个连续编号文件。
2. 使用 SQLite STRICT 表和显式 CHECK/FOREIGN KEY。
3. 不修改已发布迁移。
4. 更新依赖新字段的查询与测试。
5. 验证从空数据库和旧版本数据库升级。

## 查询层（Drizzle）

业务查询统一走 `SqliteStore.orm`（Drizzle `better-sqlite3` 驱动的同步 API；依赖版本见 [package.json](../package.json) 与 [pnpm-lock.yaml](../pnpm-lock.yaml)）；`store.db` 仅供连接层自身（迁移、备份、`VACUUM INTO`）、`doctor.ts` 探针与测试验证断言使用。表定义在 [src/store/schema.ts](../src/store/schema.ts)，是迁移终态的类型化映射——新增迁移必须同步更新它。

约定：

- 只用同步方法 `.all()/.get()/.run()/.values()`；禁止 `await orm...`（better-sqlite3 事务回调是同步的）。
- 事务：模块持有 `SqliteStore` 时用 `store.transaction(fn)`（IMMEDIATE）；仅持有 `Orm` 时用 `orm.transaction(fn, { behavior: 'immediate' })`。
- SQLite dialect 没有 bigint 列模式：ID/计数值列用 `sqliteBigInt`（customType，读写 `bigint`），自增主键用 `sqliteBigIntId`（insert 可省略 id，新 id 用 `.returning({ id }).get()`）；0/1 标志列用 `integer(..., { mode: 'boolean' })`。
- `.run()` 的类型就是 better-sqlite3 的 `RunResult`，可以直接读 `changes`/`lastInsertRowid`。`database.ts` 里的 `asRunResult` 是旧驱动留下的类型转换，现有调用仍然有效，新代码不需要它。
- 复杂 SQL（多表 JOIN、子查询、`NOT EXISTS`、`COALESCE`、FTS5 `MATCH`/`bm25()`、动态拼列）保留 `sql` 模板：`orm.all<Row>(sql\`...\`)`；`${}` 一律是绑定参数（禁止拼 SQL 字符串；受控常量片段用 `sql.raw`）。FTS5 虚拟表 `sticker_search` 不进 schema，只能走 `sql` 模板。
- 单行裸 SQL 的仓库惯例是 `.all<Row>(sql\`...\`).at(0)` 再判 `undefined`；在该驱动下 `orm.get(sql\`...\`)` 同样返回行对象或 `undefined`。
- `SqliteStore.close()` 先执行 `PRAGMA wal_checkpoint(TRUNCATE)`，再调用 `close()`；初始化失败与备份连接直接 `close()`。关闭后不得继续使用已创建的 ORM 查询。
- 测试中的裸 SQL 审计断言保留原样：验证层独立于被验证的实现是本仓库的测试惯例。

## 表组

表与列定义见 [src/store/schema.ts](../src/store/schema.ts) 和 [迁移目录](../src/store/migrations/)，不在文档维护表数量或字段类型副本；类型、可空性与 CHECK 约束以 schema、迁移与源码为准。下面只记录 schema 读不出来的语义。

### 冻结与重放边界

`invocation_messages` 是可重放边界，保存 `history`/`new` 两个区段的 Message Revision 快照；长生命周期 Invocation 的多个批次按 `source_bucket_id` 追加进同一个 Invocation（`sequence_no` 在 Invocation 内保持单调）。消息在 Invocation 创建后被编辑只影响未来 Context，不改写已经冻结的快照。`buckets` 区分 `realtime`（配置长度窗口）与 `startup_catch_up`（启动追赶）两种来源，状态机相同。`agent_messages` 是**按 Invocation 展开的扁平审计轨迹**（人类可读的 `assistant`/`tool_result`/`harness_nudge` 文本行），完整可重放的 transcript 属于 Conversation，见下一节——**Assistant 文本不等于 Telegram 发送**，真正发出去的只有 `telegram_sends` 里的行。

### Conversation Context（长期会话 transcript）

`conversation_contexts` + `context_messages` 是 Agent 的**规范 transcript**：粒度是 Conversation（Chat + Forum Topic），跨 Invocation、跨进程重启长期存在。内存里的 Pi agent 只是可丢弃的缓存，缓存被 LRU 逐出或进程重启后都从这里重新播种。

- `conversation_contexts.conversation_id` 带 UNIQUE 约束：**每个 Conversation 至多一行 context**。
- 保留窗口是半开区间 `[head_seq, next_seq)`：`next_seq` 是下一个空位，`head_seq` 是第一条保留行；`context_messages` 以 `(context_id, seq)` 为主键，`seq` 只增不减，被丢弃的行不从编号里移除。
- `send_count_total` 是该 context 累计的成功实发 `send` 次数，跨 Invocation 累计，`head_seq` 前移时不清零；图片去重返回的 `replayed:true` 只落 toolResult，不增加该计数。
- `system_prompt_hash` 是稳定系统提示的 SHA-256。打开 context 时 hash 不一致按「重建」处理：删除该 context 的全部 `context_messages` 与 `context_refs`，`head_seq`/`next_seq` 复位为 1、`send_count_total` 归零、`active_invocation_id` 清空。
- `active_invocation_id` 指向当前拥有该 context 的 running Invocation，运行结束时清空；Invocation 行本身被清理时置 `NULL`。
- `last_active_at` 在每次追加行与 `touch`（Invocation 开始/结束）时刷新，是保留清理判定「空闲 Conversation」的依据；`last_gc_at` 记录最近一次 GC 时间。
- `context_messages.payload_json` 保存**完整 AgentMessage JSON**（含 thinking 与 tool call 结构），可以直接解码重放，而不是从文本反推；`role` 只有 `user`/`assistant`/`toolResult`。
- `agent_messages` 与 `context_messages` 的分工：前者是审计轨迹（每 Invocation 扁平展开、人可读、把 harness 提醒单独标成 `harness_nudge`），后者是生产 Agent 跨 Invocation 续跑的来源（完整结构与 thinking、按 Conversation 保留），不是 Admin 场景重放输入；两者都由 `agent-runtime` 写入，互不替代。
- `is_checkpoint` 标记一条注入批次的首条 user 消息；GC 只会把 `head_seq` 推到 checkpoint 行上。
- `send_seq` 只在「成功实发 `send` 的 toolResult」行上非空（排除图片去重返回），值等于写入时的 `send_count_total + 1`；GC 用它统计保留窗内还剩几次发送。
- `est_tokens` 是逐行 Token 估算，供 GC 与收尾判定使用，不是精确计数。
- `evicted_at` 是软删除标记：GC 不立即物理删除行，只打标记；行保留到在线窗口之后才由 `purgeExpiredData` 真正删除（见「保留清理」）。
- `invocation_id` 记录写入该行的 Invocation，Invocation 被清理时置 `NULL`，历史行本身不随之删除。

写路径只有一处：`advanceHead` 把 `head_seq` 前移时，在同一事务里软标记被丢弃的行、删除这些行携带的 `context_refs`、更新 `head_seq` 与 `last_gc_at`。GC 是**纯丢弃，从不做摘要**：`planContextGc` 决定新起点（默认跳到「仍保留至少 `retained_sends_target` 次发送」的最新 checkpoint，发送稀疏但 Token 压力大的历史退回 Token 预算判定），保留段还必须通过 `isRenderable` 结构检查（不得以 `toolResult` 开头，每个 tool result 都要有对应的 assistant tool call），否则这一轮不裁剪。

`context_refs` 是**按 Conversation Context 记账的能力引用**，取代了原来按 Invocation 记账的引用：

- `kind` 为 `media`/`sticker`/`reply`，`ref` 分别是 `img_<uuid>`、`stk_<uuid>`、`reply:<telegram_message_id>`；对应 payload 落在 `media_id` / `sticker_file_id` / `target_conversation_id` + `target_thread_id`。
- 授权规则只有一条：`source_seq >= head_seq` 且 `expires_at > now`。`source_seq` 是携带该引用的 context 行，该行被 GC 逐出后引用立即失效，不需要额外的撤销步骤。
- 查询始终带 `context_id`，因此**引用永不跨 Conversation 解析**：另一个 Chat/Topic 的引用即使格式相同也解析不出来。
- `expires_at = 写入时刻 + agent.context.ref_ttl_hours`（reply 引用每次重新注册都会续期）；同一 (context, media) 在未过期时复用同一条 `ref`，避免前缀抖动。

`invocation_buckets` 是 Bucket 到 Invocation 的 join 表：长生命周期的 Invocation 会消费多个 Bucket，`invocations.bucket_id` 只保留「开场 Bucket」这一历史字段。完成回执在 claim 时各自创建一个无消息的 Bucket，以唯一的非空 `task_receipts.bucket_id` 关联；尚未 claim 的 receipt 仍可没有 Bucket。同一 Invocation 可通过多个 join 行消费多个 receipt。receipt 的 Bucket 不含 `bucket_messages`，但仍参与注入、终态、重排与过期处理。

- 主键 `(invocation_id, bucket_id)`，`attached_at` 是挂载时间。
- `injected_at` 为 `NULL` 表示「已挂到该 Invocation，但还没进入模型 transcript」。Invocation 结束时 `releaseUninjectedBuckets` 把这些 Bucket（开场 Bucket 除外）重新排队成新的 Invocation，批次不会被静默丢弃。
- Bucket 终态与重启恢复按 join 表判断：Invocation 结束时把它名下的所有 running Bucket 一起置为同一终态，进程重启时也只把这些 Bucket 标成 `aborted`/`outcome_unknown`。

`/status` 命令与 Admin Panel 的 `contexts` 接口只读展示 `head_seq`/`next_seq`/`send_count_total`、保留消息数与最近 GC 时间，不写入该表组。

### 长程任务与完成回执

`long_tasks` 是任务状态唯一事实源：任务归属 plugin 与 Conversation，创建 Invocation 在删除后置 `NULL`；它保存有界 JSON payload、可选 timer deadline/result、创建时冻结的 delivery policy，以及 `waiting`、`completed`、`failed`、`cancelled` 四态。`task_receipts` 是每个终态任务至多一份的投递状态唯一事实源：`pending`、`claimed`、`handled`、`suppressed` 与结果/错误、关联 Invocation（删除后置 `NULL`）、取消和结算审计分离保存。

- payload、timer result、result 各不超过 16 KiB UTF-8；error 不超过 8 KiB，delivery 不超过 4 KiB。服务层拒绝非 JSON 值、非有限数、循环、稀疏数组、访问器和非 plain object；DDL 同时以 `json_valid` 与字节长度 CHECK 兜底。
- 到期 timer 从 `waiting` 原子转为 `completed` 并生成 pending receipt；插件也可在以后通过绑定 plugin/Conversation 的 completion handle 完成或失败无 timer 的任务。本期不提供通用 executor、running/progress 或 retry。
- 取消 waiting 任务会生成 suppressed cancelled receipt；已完成但 pending 的 receipt 可以被取消投递，任务本身仍保持完成。claimed 不可单独取消。重启时 claimed receipt 结算为 handled/`outcome_unknown`，绝不重放。
- `delivery_json` 只在创建时由可信插件代码写入；默认普通预算且不 mention。可信 `bypassDailyBudget` 会令该 receipt 投递跳过 sleep 与每日 token gate，但不绕过 Chat/Topic 配置、pause、串行、并发、wall-clock、发送限流或失败处理。外部完成默认仍走普通预算。
- retention 不删除 waiting 任务或 pending/claimed receipt。无 timer 的任务依赖插件显式完成、失败或取消；创建 Invocation 结束或删除不表示任务已失效，不能据此清理。只有任务已终态且 receipt 已 handled/suppressed 才按在线窗口一起删除；不单独删 receipt，以免留下孤立任务。删除 Conversation 级联两表。

### Alarm owner

Alarm 是 `plugin_id = 'alarm'` 的任务投影。`long_tasks.created_by_user_id` 是可信 owner：新建时由当前 Invocation 的可靠 caller 写入；迁移历史行允许为 `NULL`，这些旧行不会被用户 list/delete，也不会把 target 冒充 creator 回填。

### 短期记忆

`memories` 由 Agent 通过 `add_memory`/`delete_memory` 维护，也可在 Admin Panel 手工增删改查：

- 每条记忆归属一个 `conversations` 行（Chat + Forum Topic 隔离，互不可见）。
- `content` 硬限制 150 字符（SQLite `CHECK` 兜底；Tool Schema 与 Admin API 先校验）。
- `expires_at` 由 `created_at + ttl_seconds` 决定，默认 TTL 1 天；过期行在每次写操作机会性清除，`purgeExpiredData` 也会清除。
- 系统不禁止长 TTL；剩余寿命超过 `agent.memory_ttl_warning_days`（默认 30 天）的记忆在 Admin Panel 显示 warning，由管理员决定保留、删除或提升进 `agents.md`。

### 注意力窗口

`conversation_attention` 每个 Conversation 至多一行，记录 `expires_at`、命中的 `trigger_kind`（`mention`/`reply_to_bot`/`keyword`）与触发消息的 Telegram message ID。它只回答「这个会话现在算不算活跃」：行过期即无意义，读路径只比较 `expires_at > now` 且从不惰性删除，清理交给 `purgeExpiredData`。窗口要跨进程重启保持，因此放在 SQLite 而不是内存。

### 工具可见性审计

`invocations.tool_registry_hash` 之外还有 `tool_registry_json`：本次 Invocation 实际展示给模型的完整工具快照（`name`/`label`/`description`）；hash 覆盖名称、描述和参数 Schema，Tool 使用策略变化也会产生新 hash。`model_calls.tools_json` 记录该次请求真正附带的工具名数组——Agent 循环在 context 接近上限时会把工具裁剪到 `send` 和当时可用的 `zzz`，因此同一 Invocation 内不同请求的工具列表可能不同；这两列共同回答“模型当时能看到哪些工具”。

仅在 `developer.record_model_payloads = true` 时保存模型调用的原始报文快照，缺省关闭。`model_calls.request_json` 不复制 `data:image/*;base64,...` 图片正文；对应字符串替换为包含 MIME、Base64 字符数、解码字节数与 SHA-256 的结构化摘要，真实 Provider 请求不受影响。现有 `response_json` 捕获的是 HTTP status 快照，并非完整流式响应体。关闭仅跳过这些调试快照，正常模型调用、工具、usage、费用、状态与错误审计照常记录；旧快照不自动删除。

Invocation 重放不录制或读取模型请求副本：它从 `invocation_messages` 的开场 Bucket 冻结快照与可证明在当时已入库的公开历史重建场景，使用当前配置的 prompt、模型与工具定义；不读取 `context_messages` 的私有推理或工具历史，也不复制跨 Invocation 的完整 Context。具体边界见 [admin-panel.md](admin-panel.md#invocation-重放) 与 [`scene-context.ts`](../src/context/scene-context.ts)。因此关闭调试录制或清除报文不影响场景重建，在线留存清理仍会使来源或媒体不可用。

迁移 `030` 删除迁移 `029` 引入的旧 `model_calls.replay_input_json` 列及其历史内容，不转换为新快照；其余调用审计、工具/发送记录、用量与公开消息快照保留。沿用现有迁移前备份与事务，不启用新的常驻数据录制。Developer 清除端点只分批把 `model_calls.request_json` / `response_json` 置为 `NULL`，不删除行、不改变关联或 retention，也不触碰 `telegram_sends` 的同名字段；不执行 `VACUUM`，不修改旧备份。

`side_effect_started` 和 `outcome_unknown` 用于阻止不可逆 Tool 的盲目重试。审计记录应保留稳定错误码；不要依赖解析自由文本错误。图片交付去重直接读这份发送台账：同一 Conversation 与 generation 下，只有 `success` 且带 `telegram_message_id` 的 `request_json.asset_ids` 算已交付；`pending`、`outcome_unknown` 按未决处理，已成功的旧发送若带 `asset_ids_unknown` 也不能证明具体交付集合，不能当作可重发。

Reply 去重也复用 `telegram_sends`：以 `conversation_id` + `request_json.reply_to_message_id` 为键，`success`、`pending`、`outcome_unknown` 均阻止新的 Reply，明确 `error` 可再尝试。迁移 `032` 只为这三种状态建立非唯一表达式索引，不删除或改写既有重复发送；查重与 pending 占位在同一 IMMEDIATE 事务内完成，不新增独立台账。去重随发送审计的在线保留窗口清理，不受 Context GC/重建影响。`agent.allow_reply_message_multiple_times: true` 时整体跳过这一查重（不做查询、不拒绝，也不新增独立记录）；它只放开按消息的 Reply 去重，图片 generation/asset 交付去重与结果未知保护仍以 `request_json.asset_ids` / `asset_ids_unknown` 在 `telegram_sends` 上照常执行。

### 媒体与 Sticker 缓存

`media_analyses` 按 `file_unique_id + analysis_version` 缓存视觉结果。Sticker 分析在 Set 仍受配置允许时可长期保留；普通图片分析按在线保留窗口清理。`vision.prompt_version`、Provider 和 Model 都参与分析版本，避免不同规则错误复用缓存。FTS5 虚拟表 `sticker_search` 不进 Drizzle schema，只能走 `sql` 模板。

### 每日用量

`daily_usage` 只保留 Token 计量：`scope = 'chat'` / `metric = 'model_tokens'` 按 Chat 归属记录 Agent 与聊天触发 `read_image` 的 Token（全局求和后与 `agent.daily_budget.max_tokens` 比较），`scope = 'system'` / `resource = 'sticker_index'` 的 `vision_images`、`vision_tokens` 服务于后台 Sticker 索引的 `vision.daily_budget`。Token 计量口径为 `input_tokens + output_tokens + cache_read_tokens + cache_write_tokens`（`meteredTokens`），缓存读写同时在 `model_calls` 与 Admin Panel 的 Model call 明细里单列；`model_calls.total_tokens` 是 Provider 原始总数，只作审计。迁移 `018` 曾按不含缓存的口径重建历史行，现已退役为空迁移；已跑过它的开发库用 `scripts/reconcile-daily-token-usage.ts` 从 `model_calls` 重新对账（默认 dry-run，`--apply` 写入；审计行已被保留期清掉的日期只报告、不猜）。Chat 每日 Invocation 数与 MCP 每日调用数已经取消，不再有对应的 metric；Admin Panel 的 Invocation 与 Tool call 曲线直接 `COUNT` `invocations` 与 `tool_calls`，因此覆盖全部 Tool 而不只是 MCP。

### Prompt 版本（迁移 031）

`prompt_versions` 保存两层可编辑 Prompt（全局 `agent.system_prompt_file` 与每个配置 Chat 的 `instructions_file`）的内容历史，每行是一次记录：面板保存（`panel`）、恢复（`rollback`）、启动加载或显式配置应用拾取的手改文件（`external`）。`content` 是去 HTML 注释后的模板（模型看到的那份），`content_hash` 是它的 SHA-256；`chat_id` 全局为 `0`、群级为配置 Chat ID，CHECK 保证两者一致，唯一索引 `(scope, chat_id, seq)` 因此对全局也成立，`seq` 在每个 scope 内单调递增。内容与上一条版本相同则不记录；恢复不删历史，而是追加一条 `rollback`。每个 scope 只保留最近 100 条，按 `seq` 修剪（`PROMPT_VERSIONS_RETAINED`，见 [src/store/prompt-versions.ts](../src/store/prompt-versions.ts)），且**不**随 `retention.online_days` 清理——Prompt 历史是配置，不是会话数据。写端点与版本语义见 [admin-panel.md](admin-panel.md#prompts-页端点)。

### MCP 与 Admin

MCP 只有 `mcp_server_state` 一张自己的表（Server 状态、Tool registry hash、重连次数、错误码）；Tool 调用复用 `tool_calls`，没有自己的调用配额。

Admin 侧的 `admin_users`/`admin_sessions` 语义见 [admin-panel.md](admin-panel.md#数据表)。密码明文和 Session Token 原文都不入库；`admin_users` 与 `admin_sessions` 不参与在线保留清理（管理员账号不是会话数据），过期 Session 由 `AdminAuth` 在认证、新建 Session 和服务启动时删除。`admin_api_keys`（迁移 `028`）保存程序化 API key 的 SHA-256 摘要与生命周期（`prefix`/`created_at`/`last_used_at`/`revoked_at`），明文只在创建响应中出现一次；该表同样不参与在线保留清理。`admin_passkeys`（迁移 `032`，并给 `admin_users` 补 `webauthn_user_id`）保存 WebAuthn 凭据：`credential_id` 全局唯一，`public_key`/`counter` 用于验证与防重放（登录以乐观锁更新 `counter`），`rp_id` 记录注册时的依赖方——key 只对注册它的 `rpId` 生效，换域名后旧 key 不可用；`name` 1–80 字符（CHECK 约束），随 `admin_users` 级联删除。`recoverCredentials`（`admin-reset` CLI 的落点）删除该账号全部 passkey 与 Session、替换密码 hash，但不触碰 `admin_api_keys`，也不会重开 setup；该表不参与在线保留清理，语义见 [admin-panel.md](admin-panel.md#passkey-登录与凭据)。`chat_pause` 记录 `/pause` 暂停的 Chat，`conversation_context_cutoffs` 记录 `/cut_topic` 的每 Conversation 上下文切点（Telegram message ID，迁移 `019` 前为按 Chat 的 `chat_context_cutoffs`，迁移时复制到该 Chat 的每个 Conversation）：切点同时决定新批次 history 的下界，并在同一步中断该 Conversation 正在运行的 Invocation、清空被切 Topic 的 Conversation Context（保留行打上 `evicted_at`、删除其 `context_refs`、`head_seq` 推到 `next_seq`），否则切点只会裁掉渲染用的 history，模型仍然能从 transcript 里看到全部旧消息。`evicted_at` 是保留窗口的权威条件之一：读取一律附带 `evicted_at IS NULL`，这样运行中的 Invocation 持有的陈旧 `head_seq` 也无法把淘汰行读回来。

## ID 与 JSON 规则

- SQLite 整数 ID 在 TypeScript 中使用 `bigint`。
- Telegram Chat/Message ID 进入 JSON 快照时字符串化，避免超出 JavaScript 安全整数。
- 原始 Update 不整体永久保存；只保存需要审计和重放的受限片段。
- 读取 `snapshot_json`、`telegram_json`、`metadata_json` 时必须在使用前校验结构。

## 图片生成域（迁移 024）

迁移 `024` 建立图片生成域的五张表（`image_prompts`、`image_assets`、`image_generations`、`image_generation_attempts`、`image_idempotency_keys`），Drizzle 定义在私有包 [packages/image-service](../packages/image-service) 内并由 [src/store/schema.ts](../src/store/schema.ts) 聚合 re-export；该包同时拥有图片域的查询服务与 worker，宿主借出 SQLite 连接（同一句柄上的第二个 Drizzle 视图）而不移交所有权。与宿主表不同的语义：

- 图片域主键是应用生成的 text UUID，不是 `sqliteBigInt` 行 ID；计数与尺寸列使用包内 `safeInteger` 列（`fromDriver` 强制 `number`），保证宿主 `defaultSafeIntegers(true)` 连接下这些值可安全 JSON 序列化。
- 素材删除是软删除（`deleted_at`），原始图片文件按内容寻址存放于 `<data_dir>/images`，删除素材不删文件；文件不在 SQLite 内，`backup` 以旁路 `.images/` 快照携带（见[备份](#备份)）。
- `image_assets.source = 'generation'` 的行通过 `generation_id + output_index` 关联产出它的生成轮次；输出项级审计在 `image_generation_attempts`（唯一键 `generation_id + round + item_index`）。

## 保留清理

`backup` 在备份前调用 `purgeExpiredData`。清理仅删除已完成终态和不再被活跃引用的数据：

- 已过期的 `memories`（按自身 TTL，不参与在线保留窗口）。
- 已过期的 `conversation_attention` 注意力窗口行（窗口过期即无意义，不参与在线保留窗口）。
- 过期 Telegram Update 与终态 Invocation/Send/Bucket。
- 不再被 Invocation/Bucket 引用的旧 Message。
- 仍被快照引用的旧 Message 保留身份，但匿名化 Revision 文本、Sender、Reply/Forward 和 Service 内容。
- 删除无引用 Sender、过期普通图片分析、独立 Doctor 模型调用与旧 `daily_usage` 日期。
- Sticker 长期视觉索引不按普通图片策略删除。
- `long_tasks` 的 waiting 行及 pending/claimed `task_receipts` 永不因 online cutoff 删除；任务终态且 receipt 已 handled/suppressed 后才随在线窗口一起清理。
- `context_refs` 中 `expires_at <= now` 的行（TTL 到期即删，与在线保留窗口无关）。
- `context_messages` 中已软标记 `evicted_at` 且早于在线窗口的行；软标记本身保留一个在线窗口，便于审计 GC 丢掉了什么。
- `last_active_at` 早于在线窗口的 `conversation_contexts`，连带级联删除其 `context_messages` 与 `context_refs`；空闲 Conversation 的长期 transcript 因此不会无限增长。
- `invocation_buckets` 没有独立清理规则，随 `invocations`/`buckets` 的删除级联消失。

不要把 `DELETE FROM messages WHERE received_at < ...` 当作等价实现；外键和冻结快照要求分阶段清理。

## 备份

```bash
node src/cli.ts backup --config dev-data/config.jsonc
```

流程：

1. 打开现有 SQLite 并启用与服务一致的 PRAGMA。
2. 执行保留清理。
3. 使用 `VACUUM INTO` 写入同目录临时文件。
4. 非 Windows 系统将临时文件设为 `0600`。
5. 原子 rename 为 `plasticwan-<timestamp>-<uuid>.sqlite`。
6. `<data_dir>/images` 存在时，整目录复制为旁路快照 `plasticwan-<timestamp>-<uuid>.images/`。原图是归档数据而非媒体缓存，不进 SQLite，因此备份必须成对携带；SQLite 快照与目录复制之间没有跨存储原子性，快照点之后提交的行可能引用晚于复制点的文件。
7. 按修改时间保留 `retention.backup_copies` 份，SQLite 副本与其 `.images/` 快照成对轮换删除。

仓库不自带定时调度；定期备份由宿主机 cron 等外部调度运行，见[运维：Docker 部署](operations.md#docker-部署)。恢复或复制前应额外运行 `PRAGMA integrity_check`；当前备份命令不替代恢复演练。

## 本地路径

开发配置通常使用：

```text
dev-data/
├── config.jsonc
└── data/
    ├── plasticwan.sqlite
    ├── plasticwan.sqlite-wal
    ├── plasticwan.sqlite-shm
    ├── media/
    ├── images/
    └── backups/
```

`dev-data/` 已 gitignore。不得提交数据库、WAL/SHM、媒体缓存、备份或真实配置。
