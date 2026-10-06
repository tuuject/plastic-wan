# 验证

本页记录 Plastic Wan 的验证层级。不要用单一 `pnpm test` 代替真实 Provider、Telegram 或媒体工具链验证，也不要把自然语言回复当作内部 Tool 成功证据。

## 静态与单元验证

```bash
pnpm run check
pnpm test
```

npm 发布 workflow 可另用 `actionlint .github/workflows/npm.yml` 静态检查。actionlint 1.7.12 尚不识别 GitHub 已支持的 [`concurrency.queue: max`](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)；该版本须人工核对 queue，并用 `-ignore 'unexpected key "queue" for "concurrency" section'` 仅忽略这一条旧 Schema 误报。dry-run 不能替代真实 OIDC、npm 权限与版本冲突验证。

按改动范围可先运行目标测试：

```bash
pnpm test test/telegram-ingestion.test.ts test/startup-catch-up.test.ts test/participation.test.ts
pnpm test test/scheduler.test.ts test/sleep.test.ts
pnpm test test/context-store.test.ts test/context-gc.test.ts test/context-hot-inject.test.ts
pnpm test test/context-send.test.ts test/cut-topic.test.ts
pnpm test test/image-agent.test.ts test/image-delivery.test.ts test/image-delivery-runtime.test.ts
pnpm test test/agent-runtime.test.ts test/model-request-audit.test.ts
pnpm test test/admin-developer.test.ts
pnpm test test/admin-api-keys.test.ts test/invocation-cli.test.ts
pnpm test test/npm-release.test.ts
pnpm test test/replay.test.ts test/replay-input.test.ts test/replay-tools.test.ts test/replay-http.test.ts
pnpm test test/skills.test.ts test/system-resources.test.ts test/plugins.test.ts
pnpm test test/media.test.ts test/stickers.test.ts
pnpm test test/mcp.test.ts test/web-fetch.test.ts
pnpm test test/operations.test.ts test/foundation.test.ts test/schema.test.ts test/load-env.test.ts
pnpm test packages/image-service/test test/image-service-store.test.ts test/image-models.test.ts test/image-admin-server.test.ts
pnpm test test/admin.test.ts test/admin-providers.test.ts test/admin-chats.test.ts test/model-switch.test.ts
pnpm test test/bot-commands.test.ts
pnpm test test/config-diff.test.ts test/config-reload.test.ts test/chat-model-runtime.test.ts
pnpm test test/memory.test.ts
pnpm test test/long-tasks.test.ts test/long-tasks-migration.test.ts test/task-delivery.test.ts test/task-runtime.test.ts test/task-context.test.ts test/task-hot-injection.test.ts
pnpm test test/alarm.test.ts test/alarm-context.test.ts
pnpm test test/prompt-template.test.ts test/prompt-markdown.test.ts test/tui-configure.test.ts
```

上面的命令按改动范围组织；新增测试文件时同步补充对应命令与下表契约。`pnpm test` 运行 `vitest.config.ts` 的 `include` 覆盖的全部测试（`test/**/*.test.ts`、`apps/admin-next/src/**/*.test.ts` 与 `packages/image-service/test/**/*.test.ts`），文件间串行（`fileParallelism: false`）。

| 测试 | 主要契约 |
| --- | --- |
| `foundation.test.ts` | 严格配置（含 `agent.context` 与 `agent.rate_limits`）、Secret 脱敏（含前缀与重叠值）、迁移与备份 |
| `packages/image-service/test/*.test.ts` | 图片域核心（包内测试自带连接）：意图档位/能力校验、引用展开与去重、幂等重放/冲突、retry 全轮、透明像素校验由 adapter 决定、部分成功与未知上游结果不自动重试、崩溃恢复、关停缺项、并发上限、单 Worker 串行化 |
| `test/image-models.test.ts` / `test/image-admin-server.test.ts` | 图片模型目录鉴权、禁用时发现、真实路由标签、能力映射、非法/超大/错误响应、自动配置到 adapter 的参数契约、配置回显与凭据保留、复用 OpenRouter SecretRef 修复旧空凭据、重复模型/未知凭据/错误来源在写入前拒绝、修订冲突拒绝及 Origin 边界 |
| `test/image-service-store.test.ts` | 宿主借入连接下的图片域：safe-integer 列返回 number 且 JSON 无 BigInt、迁移 024 在有数据的既有库重放、宿主事务回滚核心写入、启动对账（claimed→interrupted、queued→恢复）、优雅关停中断落盘、备份图片快照成对轮换与恢复字节一致 |
| `test/image-startup.test.ts` | 真实 `serve` 本地启动流程在首次 Telegram 调用前发布已保存图片配置，第二次启动自动恢复；缺失/结构错误/无法解析凭据仅禁用图片能力，启动日志与实际快照一致且不泄露凭据。Telegram 边界使用 mock，无外部连接 |
| `test/image-agent.test.ts` | 图片插件桥：生成落定推进 long task 与回执、`send kind:image` 交付本 Conversation 已落定输出并审计 bot 消息与 `media`、跨 Conversation 拒绝、失败生成仍回执、重启后 `reconcile` 对账、能力开关、输入引用授权；声明输出文件缺失时发送以 `image_generation_unavailable` 拒绝且不新增发送行 |
| `load-env.test.ts` | CLI `.env.local`/`.env` 加载语义：缺失跳过、dotenv 解析（含 BOM）、真实环境变量 > `.env.local` > `.env` 优先级 |
| `schema.test.ts` | Drizzle 层 bigint/boolean 往返、STRICT 与 CHECK 约束、better-sqlite3 IMMEDIATE 事务回滚、`sql` 模板绑定与 FTS5 查询；Invocation 审计索引的新建/升级、分页统计与查询计划；图片交付台账旧库升级、已知/未知资产回填与查询索引 |
| `telegram-ingestion.test.ts` | allowlist、Revision、Bot/Service、Topic 隔离、先到的 `migrate_from_chat_id` 授权新 Supergroup、匿名管理员（占位 Bot + `sender_chat`）按真人处理 |
| `participation.test.ts` | 全局/每 Chat 规则合并、私聊配置拒绝、跨午夜时段、触发与注意力窗口、暂停/编辑边界、启动追赶与清理 |
| `startup-catch-up.test.ts` | 每 Conversation 一个追赶 Invocation（同群不同 Topic 分开）、`history_messages` 上限、`ignored_user_ids` 与 `sticker_trigger_enabled` 生效、排空后切换实时 Bucket、各 Topic 发送落回自己的 Topic；积压 `/pause`/`/resume` 顺序执行与鉴权、其他命令只审计不入上下文、重复 Update 不重放；慢排空或崩溃续跑后刚排队的追赶不被启动恢复判为过期，真正排队超过 recovery 年龄的仍以 `recovery_age` 过期 |
| `scheduler.test.ts` | 配置 deadline、冻结快照、恢复和并发串行 |
| `sleep.test.ts` | 5% 阈值边界与 `zzz` 可见性、跨轮次工具注册表、睡眠状态只随注入批次下发而不进入 system prompt、睡眠跳过 due/queued 会话、跨进程持久化、UTC 预算重置唤醒、并发 `zzz` 幂等 |
| `context-store.test.ts` | 淘汰行不会因为陈旧 header 的低 `head_seq` 复活、`AgentMessage` 编解码往返与过滤、保留段结构守卫、canonical history 追加与 checkpoint/send 计数、system prompt 变化触发重建、`advanceHead` 淘汰行并回收其引用、整段清空、capability 引用按 Context 隔离与 TTL |
| `context-gc.test.ts` | 丢弃式 GC 计划：send 数未超上限且无 token 压力时不动、滑到仍保留 `retained_sends_target` 次 send 的最新 checkpoint、没有可用 checkpoint 时不裁剪、Tool 多 send 少时退回 token 判据、token 压力下按 send 数选出的候选超预算时改用 token 判据、保留段会以 `toolResult` 开头时放弃 |
| `context-hot-inject.test.ts` | 空闲等待期间到期的 Bucket 注入同一 Invocation（`invocation_buckets` 两行、一次运行两次模型调用）、`/pause` 立即打断空闲等待、`idle_grace_seconds = 0` 退回一 Bucket 一 Invocation 但 transcript 仍连续、同 Chat 另一个 Topic 不 attach、attach 未注入的 Bucket 重新排队（且不会被下一次运行重复注入）、已 closing 的运行不再接收 attach、睡眠期间到期的 Bucket 跳过而不 attach、GC 缓解 token 压力后不进入收尾、steer 的批次落库失败时重新排队、抛异常的运行驱逐 Agent 缓存、输入估算不随模型调用次数增长、复用缓存的运行里每一批注入各自锚定自己的行（`context_injected.seq` 递增，`context_refs.source_seq` 等于承载该批的 user 行）、保留窗口首行不是 `user` 时播种前先对齐到 turn 边界或整段丢弃 |
| `context-send.test.ts` | Context 可见性、Reply capability、滑动窗口内的 `send` 速率限制与 `send_rate_limited` 审计、未知网络结果不重试、abort/过期不发送、429 等待后命中屏障不重试、已接受的发送在落库失败时仍为成功 |
| `image-delivery.test.ts` / `image-delivery-runtime.test.ts` | 图片按 Conversation/generation/asset 去重、跨 Invocation/重启有效、已送成功 no-op 的审计/限流/屏障与 canonical send 计数、后续新增输出、显式重发与完成轮限制、并发 pending/未知结果保护、回执 `image_delivery` 三类互斥且未知优先、无法证明集合的旧发送整代保守拒绝、权限与过期引用；工具链先发送后注入回执的真实 Faux 回归及普通回执不受影响 |
| `cut-topic.test.ts` | `/cut_topic` 切点排除命令消息及更早历史、切点只前移、按 Chat 与 Forum Topic 隔离、非管理员拒绝、重建服务后仍生效、同时清空该 Conversation 的 Conversation Context、中断仍持有切点前 transcript 的运行 |
| `agent-runtime.test.ts` | 按 Conversation 播种的 Agent、Tool 循环、每批注入的 turn 预算、transcript 隔离与工具可见性审计 |
| `chat-model-runtime.test.ts` | 按 Chat 解析模型覆盖（覆盖生效、缺省逐项继承全局、仅 `thinking_level` 覆盖时重绑缓存 Agent）、Topic 共用 Chat 设置、群迁移解析迁移前 Chat 配置且直接配置的新 ID 优先、跨 Provider 切换保留未变的 Context 与模型审计、queued→running 用当前快照而下一次 Invocation 才用新值、Chat 选用的 Agent 模型具备 image 能力时启用对应图片提示 |
| `skills.test.ts` | Skill 索引注入 system prompt、原语不经 execute、`execute` search/help/call、`{text, refs}` 封套驱动 `search_stickers → send` 贴纸链路、记忆经 execute 写入、原语/未知能力拒绝的审计、已 abort 的运行不 dispatch 能力 |
| `system-resources.test.ts` | Skill manifest 校验与启动失败、插件 Skill 目录挂载与重名拒绝、`system:///` 绝对/相对 URI 解析、越界与非 Markdown 拒绝、32 KiB 截断、progressive disclosure fixture |
| `plugins.test.ts` | 插件 id 校验与重名拒绝、内置插件清单装配 |
| `model-request-audit.test.ts` | `request_json` 中 inline base64 图片被结构化摘要替换、其余请求数据保留、重复清洗幂等 |
| `admin-developer.test.ts` | 旧配置缺省关闭、显式开关与 JSONC 持久化/热应用、权限/Origin/revision/类型校验、应用失败后文件与运行态分离、分批清除只置空报文（含 replay 快照）且保留审计/关联/统计、重复清除与并发写入 |
| `admin-api-keys.test.ts` | 一次性 `pwk_` 明文与 SHA-256 存储、Session-only 管理边界（TypeBox、Bearer 不能管理密钥）、撤销立即生效且保留元数据、Bearer 只覆盖 invocation list/get/replay（其它审计、写端点与未知路由 403）、Authorization 存在时不回退 Cookie、replay 端点只接受 `system_prompt`（空串合法、64Ki 字符与 256 KiB body 上限）、engine 错误映射与失败脱敏、malformed Origin 返回 400 而非 500 且 Origin 只守写 |
| `invocation-cli.test.ts` | `plasticwan-utils` 的 list/get/replay 请求形状与输出契约、`--api-key` 覆盖环境变量、replay 失败仍保留 stdout 文档、退出码、重定向/超时/超大响应拒绝、stdin 无 EOF（空流或部分输入）超时后非零退出且无 HTTP 请求、参数与端点校验、任何输出（含服务端回显与 JSON 转义形式）都不泄露 key |
| `npm-release.test.ts` | main canary 版本含 run/attempt/SHA、仅精确稳定 tag 进入 latest、拒绝非 push/其它仓库与非法 ref、GitHub 输出不改源码 manifest、仅独立 CLI 包公开、Skill 分发清单与入口/子文档/元数据结构 |
| `replay-input.test.ts` | 快照编解码往返（含 tool call 与 tool result）、内联图片丢弃与计数、版本与重复定义拒绝、快照随 Invocation 级联与无 Invocation model call 的保留窗口一起删除 |
| `replay-tools.test.ts` | 合成 send（text/image/sticker）与参数保留、内存记忆/闹钟（空起步）、`image_generate` 假回执、`zzz` 不写全局状态、`read` 只读当前 `system:///` 并拒绝越界、未知顶层工具与 MCP 全部 blocked、`execute` 拒绝原语与无生产执行器、search/help 限快照注册表、abort 后不再 dispatch、工具层不引入生产接线 |
| `replay.test.ts` | 首个请求的历史输入 + 当前模型、无生产写入、空 system prompt 覆盖与无 send 成功、来源守卫（未完成/缺快照/非法历史/不回退后续调用）、从 toolResult 尾部续跑、共享模型闸门与并发 429、关停与取消释放、context/turn/tool/trace/wall-clock 预算、脱敏覆盖任意参数键名与 dispatch 元数据 |
| `replay-http.test.ts` | CLI 子进程 → 回环 AdminServer → ReplayRunner → Faux Provider 的真实 HTTP 链路，覆盖 Prompt 覆盖、当前模型、合成 send/记忆/Alarm、MCP 阻断、生产表不变（密钥使用时间除外）、缺失快照的 409/非零退出与撤销密钥的 401 |
| `media.test.ts` | 图片标准化、缓存和 Vision reasoning、换 vision 模型后按新 `analysis_version` 重新分析 |
| `stickers.test.ts` | Set 同步、结构化视觉 Tool Call、索引、搜索、发送 |
| `media-image.test.ts` | 视频 Sticker 只按 WebM 解码（其他容器冒充时拒绝）、真实 WebM 仍能取帧、解压超过 8 MiB 的 TGS 在转换前拒绝；本机没有 ffmpeg/ffprobe 时整组跳过 |
| `mcp.test.ts` | stdio/HTTP transport、策略、Header、重定向和审计、发现 Tool 失败时关闭 stdio 子进程、连接中 `stop()` 后保持 stopped 且关闭子进程 |
| `web-fetch.test.ts` | 有界不可信文本结果与审计、公网 IPv4 放行与 IPv4 映射字面量拒绝、私网/合成地址拒绝（含跳转目标）、fake-ip 网段默认拒绝且需 `allow_proxy_synthetic_addresses` 开启、6to4/Teredo 过渡地址拒绝、`dangerously_allow_all_ip_addresses` 从配置到插件生效并放行私网/环回/跳转目标但仍拒绝非默认端口、默认 `Accept` 优先 `text/markdown` 且站点 Markdown 原样返回、`raw` 与 `accept_markdown: false` 不声明 Markdown、HTML 默认转 Markdown（正文在 32 KiB 之后仍保留、去导航/脚本/图片）、`raw` 返回原始 HTML、Markdown 按 UTF-8 边界截断、转换不发任何网络请求 |
| `operations.test.ts` | Retention、备份轮换、Scheduler 关闭 |
| `admin.test.ts` | Admin 首次设置、登录、登录锁定（不受 `X-Forwarded-For` 与用户名轮换影响、并发失败计数、过期后重新计数）、请求体按字节流式限长、HTTPS 下 Cookie 带 `Secure`、Session、只读审计 API（含 Conversation Context 列表/详情与写入尝试被拒）、静态托管 |
| `admin-providers.test.ts` | Provider/模型管理、SecretRef 只写不读、修订冲突、全局模型端点保留 Chat 覆盖、阻止删除 Chat 引用（含待重启移除的运行中 Chat）的 Provider/模型且不落盘 |
| `admin-chats.test.ts` | Chat 管理鉴权与 Origin、字符串 ID 与安全整数边界、Topic/模型严格校验、模型覆盖必须显式带 thinking、revision 先于 body 解析与并发写入保护、JSONC 注释及未管理字段保留、新增 Chat 热应用而删除/Topic 待重启与历史保留、模型热应用/恢复继承、迁移 ID、保存后应用失败的状态与脱敏审计 |
| `model-switch.test.ts` | 可切换模型仅列 text 能力、当前模型取配置值、`option()` 只校验不应用（未知 provider/model 与 image-only 拒绝）、`current()` 跟随 `store.publish` 变化 |
| `bot-commands.test.ts` | 命令解析与 mention 匹配、`setMyCommands` 注册一致性、`/pause` 中止与阻断、`/resume` 恢复、`/status` 用量与 Context 行口径、`/model` 分页与切换（写配置文件并 reload）、管理员鉴权与匿名拒绝、`/whoami` 回显发送者 ID 且不限管理员、`/allowlist` 仅管理员且在未允许 Chat 由 ingestion 放行并热应用、`/ignoreme` 与 `/unignoreme` 解析/身份校验且不越过 Chat/Topic 白名单、命令只审计不入库 |
| `config-diff.test.ts` | 热更新白名单分类（hot/restart/outside_serve）、candidate 构造、Provider 的增删/改 kind/连接字段/模型定义全部取文件值、custom Provider `models[]` 对齐、新增 Chat 热应用与删除仍 restart、Prompt 内容比较 |
| `config-reload.test.ts` | `ConfigReloader` 外部契约：generation 与两个 hash、`config_reloaded`/`config_reload_failed`/`model_switch_failed` 日志、待重启字段撤销与只改注释后 active hash 跟上文件 hash、两遍校验与 `candidate_invalid`、`secret_unresolved` 的整次拒绝、待重启列表、运行中 Invocation 钉住模型与 Provider 连接（两个本地端点验证换地址后的下一轮仍走旧地址）、`/model` 写入文件（保留注释、`0600`、符号链接拒绝）、`invocations.config_hash` 在 `queued → running` 写入、Admin `POST /config/apply` 与 `PUT /model` 的响应体；Chat 覆盖切换按文件 ID 定位（reorder 后仍解析正确、保留其它 Chat 与全局默认、文件里缺该 Chat 时拒绝写入不落盘）、并发 Chat 切换互不覆盖、发布前对全局与每个选中 Chat 模型逐一校验（删除在用 Chat 模型被拒、全局换模型拒绝继承不兼容的 thinking）；自助忽略持久化/恢复、重复与并发增删、跨 Chat 隔离、迁移 Forum Chat、实时/追赶名单热应用、失败后的文件/运行态与重试审计 |
| `memory.test.ts` | 记忆持久化与 TTL、Conversation 隔离、Tool 审计、注入批次内 `<memory_list>` 的顺序与作用域、Admin 记忆 CRUD |
| `long-tasks.test.ts` | 任务/receipt 的 JSON 边界、终态 CAS 与唯一 receipt、plugin/Conversation/caller scope、quota（含取消记录）及外部 completion handle |
| `long-tasks-migration.test.ts` | 使用历史迁移建立 019/020 测试库再升级至 022：ID、owner、取消后 Invocation 关联、四态迁移、NULL 创建者、丢弃旧旁路观察（含非法 payload）、canonical history/refs/正常审计与任务回执整行保留，并验证 022 为每个 receipt 建立唯一 `bucket_id`、重复打开及新库无旧表、Drizzle CHECK/partial index 与 SQLite 一致性 |
| `task-delivery.test.ts` | 创建 Invocation 删除后的外部 complete/fail 真实内部链路、普通 assistant 不直发、目的地移除、queued 管理取消与 running AbortSignal 审计结算 |
| `task-runtime.test.ts` | Scheduler 单一循环、Chat 串行/全局并发、同一 Conversation 运行中 attach 多个独立 receipt、closing 保持 pending、跨 Topic 串行、receipt 优先级、sleep 交界、busy timer 完成不空转、pending/claimed 的重启恢复、未消费 receipt 转移归属、Admin 取消当前会话仍保留未 claim 的 pending receipt |
| `task-context.test.ts` | receipt opening 与后续普通注入的 canonical history/context refs/model audit、不可信数据边界、caller 清空、mention/bypass 不泄漏到普通批次、mention 仅首次成功文本发送、冻结预算豁免及 turn/send/context/wall-clock 限制 |
| `task-hot-injection.test.ts` | 同一运行的多 receipt 等工具链结束后逐条独立注入、receipt 不触发 send barrier、独立 checkpoint/mention、idle grace 唤醒并正常完成、模型失败时未消费回执重排、`/pause`/Admin cancel 防止回执复活、跨回执与普通批次的 caller/budget/zzz 恢复 |
| `alarm.test.ts` / `alarm-context.test.ts` | Alarm 输入与 ownership、列表/取消四态、canonical context_messages 保存与跨 Invocation/重启复用、checkpoint GC/话题清空遗忘、send 不泄漏、Admin 投影、pending/claimed 保留与终态 retention |
| `prompt-template.test.ts` | Prompt 模板白名单变量渲染、未知与格式错误表达式拒绝 |
| `prompt-markdown.test.ts` | HTML 注释剔除、纯注释行移除、跨行注释与未闭合注释保留 |
| `tui-configure.test.ts` | `configure` 向导输出可被 `loadConfig` 接受、非法配置不落盘、会话期间被改过的文件不被覆盖、models.dev 能力/费用映射、Provider `/models` 拉取与去重、CLI 参数与 `--output-agent-prompt` 解析 |
| `apps/admin-next/src/lib/*.test.ts` | Admin 前端纯函数：错误文本、记忆 TTL 边界、Invocation 时间线排序与 send 参数解析 |

跨模块改动完成后运行全部测试与 TypeScript 检查。

## 配置验证

```bash
node src/cli.ts check-config --config dev-data/config.jsonc
```

检查：

- 输出 `status = ok`。
- `config_hash` 与预期文件一致。
- Chat ID、Topic、Provider alias、Model ID 和 MCP Tool policy 未被错误引用；Chat 的 `provider`/`model` 必须成对出现且引用存在，`thinking_level` 必须被该 Chat 解析后的生效模型接受，不成对或组合不合法会被严格拒绝。
- `agent.context` 与 `agent.rate_limits` 的越界值被拒绝；已删除的 `agent.max_turns`/`agent.max_sends`/`agent.timeout_seconds` 会被严格对象模式拒绝，旧配置必须一起改。
- 配置改变后，不要继续使用旧进程的哈希。
- 热更新白名单字段改完后，用 Admin「Apply config file」（或 `/model`）应用：日志出现 `config_reloaded`，`active_hash` 反映新配置；没有待重启字段时它与 `check-config` 的文件哈希一致，有待重启字段时两者不同，且这些路径出现在 `restart_required` 里。

## Doctor

按 [运行与运维：Doctor](operations.md#doctor) 执行检查；需要核对 Prompt 模板时使用该节的 `--output-agent-prompt` 命令，避免把 Prompt 正文转发到共享日志。

通过标准：命令成功退出、JSON 中 `status = ok`，以下依赖探针均成功；启用 Prompt 输出时还应核对 `agent_prompt` 的渲染结果。

检查覆盖：

- SQLite/FTS/磁盘。
- Sharp、FFmpeg、FFprobe、python-lottie。
- Agent Provider 文本与严格 Tool Call（按全局默认与每个 Chat 实际选用的模型/思考组合去重探测，同一组合只探一次）。
- Vision 图片请求。
- Telegram Bot Token。
- required MCP。

Doctor 成功只证明连接与最小能力，不证明真实群聊调度、Reply、Sticker capability 或“不回复”行为。

## 本地服务冒烟

按[运行与运维：启动与停止](operations.md#启动与停止)启动服务。以下是通过标准；运行方式、停止步骤与 lock 排障以该页为准：

1. 出现一次 `startup_catch_up_completed`，随后出现一次 `serve_started`。
2. `bot_id` 与预期 Bot 一致，`config_hash` 与 `check-config` 一致。
3. 运行 30 秒以上没有退出/重启。
4. `serve.lock` 阻止第二实例；带 `--takeover` 启动会停掉它并在同一 `data_dir` 上接管（旧进程 `takeover_requested`、新进程 `takeover_completed`）。
5. `Ctrl+C` 后 Scheduler、数据库和 lock 正常收尾。

长期进程必须用进程监督器或人工前台运行；不要让测试命令无限阻塞。

## Admin Panel 冒烟

```bash
pnpm run admin:build   # 产出 apps/admin-next/dist
node src/cli.ts serve --config dev-data/config.jsonc
```

验证：

1. 出现一次 `admin_started`，host/port 与配置一致。
2. 首次打开 `http://127.0.0.1:<port>/` 渲染 “Create the administrator account” 表单（按钮 “Create account”），`GET /api/auth/session` 返回 `setup_required = true`。
3. 创建账号后 Overview 显示 Invocations / Stored messages / Cached media analyses 统计卡，以及 Invocation states、Configured sticker index states、Top tools 表和 7d/30d Usage 图表。
4. Tool session 详情六个 Tab（Overview / Tool calls / Model calls / Telegram sends / Agent transcript / Frozen context）各自渲染；默认落在 Overview 时间线。
5. 消息搜索命中当前 Chat 的文本，详情展示全部 Revision；列表与 Revision 显示并复制发送者的 Telegram User ID（频道身份明确标为 Chat ID）。Invocation Overview 与 Frozen context 复制冻结快照的 sender ID，缺失 ID 不提供复制按钮；剪贴板失败明确提示手动复制。
6. Bot sticker sets 页面明确说明只包含 `telegram.sticker_sets` 中配置的 Set，并按 Set 与 `index_state` 过滤后行数变化。
7. Memories 页面按群聊与状态过滤，新建/编辑/删除记忆后列表刷新；剩余寿命超过 `memory_ttl_warning_days` 的记忆带 warning 标记。
8. Overview 的 Bot status 卡片显示 `sleeping`/`awake` 与 `sleep_until`，睡眠时 `Wake now` 带二次确认；同时列出所有 `chat_pause` Chat 与暂停时间。
9. Alarms 页面按 state/Chat/Target 过滤，pending 优先置顶，展开显示完整诊断并链接到对应 Tool session；取消只对 pending 开放且需二次确认，对非 pending 给出 409 冲突提示。
10. Bot admins 页面能添加/移除管理员：写回 `telegram.admins` 并热应用，命令权限无需重启即更新；列表在下次进入页面时反映文件值。
11. Models 页面列出 Provider 与模型；切换 agent / vision 模型后 `config.jsonc` 的 `agent.provider` / `agent.model`（或 `vision.*`）被改写，页面立即反映新模型，后续 Invocation / vision 分析使用新模型，重启 `serve` 后仍然生效；Provider 增删、连接字段与模型列表的修改均热应用（在用引用仍受校验保护）。Models 页的 `PUT /api/model` 与 `PUT /api/thinking-level` 只写全局默认，保留 `telegram.chats[]` 的覆盖；未覆盖的 Chat 在 `/status` 中显示新的全局值，已覆盖的 Chat 保持自己的设置。Chat 覆盖通过 Chats 页、配置文件或 Telegram `/model` 维护。Settings 页的 `Configuration file` 卡片显示 generation、active hash 与 file hash；改一个白名单字段后点 `Apply config file`，应用列表出现该路径，改一个 restart 字段则出现在待重启列表。
12. Conversation Contexts 页面按 chat 过滤，列表按最近活跃倒序并可用 Load more 翻页；详情显示 head/next seq、保留消息数与 capability refs，展开消息看到 `payload_preview` 与截断标记，且不出现已 GC 的行。
13. 登出后访问深链接回落登录页；重新登录恢复访问。
14. `admin_users.password_hash` 使用 Argon2id 格式，`admin_sessions` 只有 64 位十六进制摘要。
15. Manage → Chats 并排显示 Saved settings 与 Running settings：新增 Chat 后文件保存且运行态立即生效（状态为 Active，无待重启项）；删除 Chat、修改 Topic 白名单后文件已保存但运行态不变；已有 active Chat 切换模型/thinking 后运行列同步，恢复 Global default 清除两种覆盖。删除需确认且保留历史，最后一个配置 Chat 禁止删除。并发编辑/删除冲突不能覆盖新文件；保存后应用失败要显示两种状态，Settings 应用成功后刷新 Chats。待重启横幅列出字段，只在有 supervisor 时提供 Restart now。

未构建 bundle 时静态路由返回 503 `admin_bundle_missing`，API 仍可用；这不是启动失败。

### Admin Panel 浏览器 E2E

```bash
pnpm run admin:build        # 前置：E2E 驱动已构建的 dist（真实静态托管）
pnpm --filter plasticwan-admin-next exec playwright install chromium   # 首次运行前安装 Chromium（Linux CI 用 --with-deps）
pnpm run admin:test:e2e     # Playwright 套件（apps/admin-next/e2e/**/*.e2e.ts）
```

- **真实后端夹具**：`globalSetup` 派生一个 Node 子进程运行 `apps/admin-next/e2e/server.ts`，
  它创建临时目录 + 临时 SQLite，加载 `test/fixtures/admin-seed.ts`（基础行 +
  `seedAdminBulkRows` 的批量分页数据），构造 `SqliteStore` / `AgentModelSwitcher` /
  `ConfigReloader` / `AdminServer`，在回环地址随机端口启动，并同端口暴露仅测试使用的
  `/__e2e/**` 状态与控制钩子（含单次 apply 失败注入，验证先保存后应用失败的真实路径）；
  `globalTeardown` 优雅关闭并清理临时目录。**不读 `dev-data/`、不启动 `serve`、
  不触碰 8787 或任何用户进程。**
- 每轮运行是全新数据库：认证从真实 `setup_required` 首次创建管理员开始，后续用例
  复用同一 session（storageState），会话撤销用例直接删除 `admin_sessions` 行后断言
  401 回落登录页并重新登录。
- 用例文件名以 `.e2e.ts` 结尾、目录独立，Playwright `testMatch` 单独声明，**不会**被
  vitest 与 `pnpm test` 发现；`workers: 1` 串行执行，端口随机，不与固定端口冲突。
- `01-routes.e2e.ts` 与多个套件按路由断言可见文案（英文 locale）：修改面板文案或
  locale 键值时必须同步这些断言，并运行受影响套件（如 `pnpm run admin:test:e2e 00-auth 01-routes`）——
  `pnpm test` 与 `pnpm run check` 都不覆盖浏览器层。筛选依赖共享 Session 的套件时必须同时包含 `00-auth`：每轮夹具都是全新数据库，跳过建号与登录会停在首次设置页；旧 storageState 不能复用。
- 覆盖契约（全部断言真实 UI 状态，非仅文案）：
  1. 认证：setup → shell；错误密码表单内显示 `invalid_credentials` 且 URL 不变；
     登出回登录页；会话撤销后受保护请求 401 → 登录页且无错误屏。
  2. `src/routes/**` 声明的全部路由与深链接直接访问渲染真实内容（非错误边界、非空白）。
  3. 列表过滤与游标分页：Invocations、Messages、Contexts、Alarms、Memories、Stickers
     的过滤器真正改变结果集（各页可用过滤器以页面与 `02-lists-filters.e2e.ts` 为准）；
     `seedAdminBulkRows`（`test/fixtures/admin-seed.ts`）让每张列表的种子行数都超过
     默认每页 25 行，因此都会出现 `Load more` 并加载下一页；无跳页/总页数控件。
     `13-sender-ids.e2e.ts` 验证 Messages、Revision、Invocation Overview/Frozen context 的发送者 ID 与真实剪贴板内容，覆盖无 username、匿名频道、缺失/旧快照、复制失败与窄屏暗色布局，确认复制不发写请求。
  4. Invocation 详情六个 Tab（Overview / Tool calls / Model calls / Telegram sends /
     Agent transcript / Frozen context）切换并渲染期望字段；失败调用显示稳定错误码
     （`provider_timeout`）且可展开脱敏详情（`sk-***`，无活密钥模式）；assistant 文本
     带 `Private reasoning` 标记。
  5. 写操作（请求真实发出 + UI/数据变化）：记忆新建与删除（含 API 复核）、Bot admin
     添加与移除（写回 `telegram.admins`）、模型切换（写回 `config.jsonc`）、Settings 页的 `Apply config file`、
     Alarm 取消成功与 409 冲突路径（`alarm_not_pending` + 列表刷新到新状态）、
     Overview 的 Cancel ongoing 与睡眠态 Wake now；Models 页并发编辑（模型编辑输掉 revision 竞争后关闭而不覆盖、
     连接卡片的旧草稿不能删掉期间新增的 header、header 名可逐键输入不丢焦点）。
     Developer 页默认关闭、开关持久化、应用失败与恢复、取消/确认清除、清除前后其它审计不变，以及移动端暗色布局。
  6. 只读保证：浏览全部审计页面时记录网络请求，断言没有任何 POST/PUT/DELETE 打到
     `/api/**`。
  7. 安全：生产静态托管（非 dev server）下断言 CSP 头（`default-src 'none'` /
     `script-src 'self'` / `connect-src 'self'`）、无 console error / pageerror /
     CSP violation，且全部请求同源（有外部请求即失败）。
  8. 信任边界（直接发 API 请求）：无 Session 访问受保护路由返回 401
     `unauthenticated`；对只读审计路由发 POST/PUT 返回 405 `method_not_allowed`；
     跨站 Origin 的写请求返回 403 `bad_origin`。
  9. Chats：字符串 ID 安全整数边界、新增 Chat 热应用、删除与 Topic 范围的保存/运行态分离、模型/thinking 热切与恢复继承、
     后台 refetch 不升级编辑和删除确认的原始 revision、保存后应用失败的双视图刷新与 Settings 恢复、移动端暗色布局。
  10. API key（`14-api-keys.e2e.ts` 的 API 用例，API-only、自带登录，可单独运行）：Session 创建只返回一次明文与 `prefix`，列表不回显明文；Bearer 覆盖 invocation list 与详情，其它路由（即使同时带 Cookie）403；撤销立即 401 且列表保留 `revoked_at`；`Authorization` 存在时不回退 Cookie；未接线的 replay 返回 503 `replay_unavailable`。
  11. API keys 页面：`01-routes.e2e.ts`（共享 Session，筛选运行时需同时包含 `00-auth`）断言 `/api-keys` 深链接渲染标题、`Create API key` 与 Name/Prefix/Created/Last used/Status/Actions 列头；`14-api-keys.e2e.ts` 的 `API key management UI`（注入上方 API 登录的 Session Cookie，可单独运行）断言：侧栏 Manage → API keys 进入页面；创建弹窗 Name `maxlength=80`，成功后一次性 **Save your API key** 弹窗显示可复制的明文，`Copy API key` 的复制值正确（拦截 clipboard，不写系统剪贴板），Web Storage 无 `pwk_` 明文；Done/Escape、刷新、历史导航与会话过期后 DOM 和表单 value 均无明文，刷新后行内只保留元数据（前缀、Active、Never used）；Revoke 确认框取消不发 DELETE、确认后同一 key 立即 401 且状态 Revoked、按钮消失；列表失败显示错误与 Retry 且不伪造行，空白名称不发请求，创建失败在弹窗内联显示并禁止进行中重复提交，撤销失败留在确认框（Working… 禁用两端按钮）；窄屏暗色无整页横向溢出。该套件关闭 trace、截图、视频与失败时的 ARIA 页面快照，所有密钥值断言只输出布尔结果，避免失败产物泄漏明文。

- 首次运行 E2E 前需要 `pnpm --filter plasticwan-admin-next exec playwright install chromium`；浏览器安装失败时套件无法
  执行，属于环境前置问题而非代码缺陷。

## Invocation 重放与 API 密钥冒烟

密钥在面板的 **Manage → API keys** 页创建与撤销；重放仍只有携带密钥的 CLI/API 入口。以下检查不需要 Telegram：

1. 在 Manage → API keys 点 **Create API key**（名称 1–80 字符）→ **Create key**：**Save your API key** 弹窗是明文唯一一次出现，**Copy API key** 可复制，Done/关闭/刷新后不可再取回，`localStorage`/`sessionStorage` 里不出现 `pwk_` 明文；列表只显示 Name/Prefix/Created/Last used/Status 与操作，未使用时显示 Never used；**Revoke** 需在确认框确认，撤销后同一 key 的下一次请求立即 401，行保留并显示 Revoked。接口契约见 [admin-panel.md](admin-panel.md#程序化-api-密钥)。
2. 用该 key 与 `plasticwan-utils invocation list/get` 能读到 Invocation；访问 `/api/overview`、`/api/memories`、`/api/api-keys` 等返回 403，同时带有效 Session Cookie 也不改变结果与权限面。
3. 对一条已开启 `developer.record_model_payloads` 且仍保留快照的已完成 Invocation 执行 `plasticwan-utils invocation replay <id> --json`（真实调用模型、按 Provider 计费）：返回 `version: 1`、来源 ID、当前 Chat 模型与 `fidelity.limits`/`dispatches`；`send` 只出现在 `outputs`，不产生 `telegram_sends`；不新增 tool call、发送或预算行，后续 `daily_usage` 不含这次调用。
4. 对未开启记录、快照已清除或未完成的 Invocation 重放：分别得到 409（`replay_input_unavailable`、`replay_source_unfinished`）或 CLI 退出码 1；确认没有回退读取 `request_json`、后续 model call 或当前 Context。
5. 重放运行期间再次发起重放得到 429 `replay_busy`；模型请求失败或超限时响应仍带完整结构，`error` 非空。

这些检查替代不了真实 Telegram 验收：重放不会发送消息，也不覆盖调度、引用与配额路径。

## 真实 Telegram 验收

### Chat 与参与策略

- 在允许 Chat 使用 `/ignoreme`：`config_reloaded.applied` 包含该 Chat 的 `ignored_user_ids`，后续消息只有 Update 审计、不入库；再发 `/unignoreme` 能恢复入库。重启后名单保持，其它 Chat 不受影响；命令自身不写 Message 或 Bucket。
- 私聊发送普通消息：无需 mention，Bot 能观察到该消息。
- 群聊发送普通消息：无需 mention，Bot 能观察到该消息。
- 群聊 mention Bot：仍通过相同配置窗口的 Bucket，不走特殊旁路。
- 未允许 Chat：`telegram_updates.allowed = 0`，原因是 `chat_not_allowed`。
- 新增 Chat 后未重启：旧进程仍拒绝；重启且哈希变化后允许。

### 时间窗口与 Revision

- 空闲 Chat 的第一条消息等待 `telegram.bucket_window_seconds` 后启动 Invocation。
- `agent.context.idle_grace_seconds` 大于 0 时，Invocation 是运行窗口：运行期间到期的 Bucket 通过 `agent.steer()` 注入**同一个** Invocation，不新开会话；日志出现 `bucket_attached`，随后是同 Invocation 的第二次 `context_injected`。
- 注入粒度是 Bucket：运行期间连续发送多条消息，仍先进入各自 Topic 的 `collecting` Bucket，窗口从该轮结束起算，等满一个窗口才成为一批；`steer` 在 turn 边界可见，长 Tool 批次期间到达的消息要等该批次结束才进入上下文。
- 运行期间到达的消息在下一轮开始时被回答，不额外等待 grace：同一轮里连续两次 `send` 之间不应出现等于 `idle_grace_seconds` 的停顿。
- 同一 Chat 的 Invocation 仍串行：运行期间另一个 Forum Topic 到期的 Bucket 不 attach，等该 Chat 空闲后才开新 Invocation。
- attach 但从未注入的 Bucket 在运行结束时重新排队（`invocation_buckets.injected_at` 为 NULL，日志 `bucket_requeued`），不会被静默丢弃。
- Forum Topic 消息各自收集；一个 Topic 的会话不会让另一个 Topic 的消息混入 Context。
- 前一个 Invocation 短于窗口：下一 Bucket 仍等满自己的窗口（`first_received_at + bucket_window_seconds`）才启动，不因上一轮提前结束而缩短。
- 前一个 Invocation 长于窗口：运行期间到达的消息不会被注入到该轮中途，它们留在 `collecting`，deadline 被推到 `本轮结束 + bucket_window_seconds`，等满一个完整窗口才作为一批 attach。
- 前一个 Invocation 结束且没有新消息：不创建新的 Invocation。
- 消息在某一轮**运行期间**到达（无论该轮跑了多久）：它只在一个完整窗口后注入，且 `injected_at - 本轮结束时刻 >= bucket_window_seconds`；连续快速发多条也只成为同一批，不出现「上一轮一结束就注入」或几毫秒就注入的「秒回」（回归：吸附到运行起点网格时实测 805 ms）。
- 消息在某一轮**结束之后**到达：窗口从消息自身起算（`deadline_at - first_received_at >= bucket_window_seconds`），不因上一轮存在而额外延长。
- `idle_grace_seconds = 0` 是唯一受支持的降级：到期 Bucket 不再 attach，退回“一次 Bucket 一次 Invocation”，Context 依然持久；运行期间到达的批次仍从本轮结束起算窗口。
- 锚点自动化用例：`test/context-hot-inject.test.ts`「a batch that collects during a round is injected one window after that round ends」——`bucket_window_seconds = 1` 且一轮耗时约 1.5 秒，断言注入发生在该轮结束之后至少一个窗口（而不是轮一结束就注入）；同文件「keeps a batch collecting while the round runs instead of attaching it mid-round」断言轮中途不会 attach。
- 不同 Chat 的 Invocation 可以并发。
- Bucket 冻结前编辑：使用新 Revision；冻结后编辑：已注入的批次不变，之后的 history 使用新 Revision。

### 长活 Invocation 与 Conversation Context

这一节的检查在真实群里只能靠日志与数据库对照，不能只看 Telegram 上的回复：

- 同一次运行里连续回答两条消息：`invocations` 只有一行、`invocation_buckets` 有两行，两次 `context_injected` 的 `invocation_id` 相同而 `seq` 递增，`buckets` 两行都以 `completed` 收尾。
- 在 Developer 开启调试报文记录后，重启进程并继续同一 Conversation：新 Invocation 的 `model_calls.request_json` 仍带着重启前的 transcript（含上次的 assistant 文本与 `send` 结果），`conversation_contexts.head_seq` 保持不变；`context_rebuilt` 只在 system prompt 或 Chat instructions 变化时出现，出现即表示整段上下文已重建。
- 连续对话直到保留段超过 `retained_sends_max`：日志出现 `context_gc`，`target_seq` 落在 checkpoint 上、`previous_head_seq` 小于 `target_seq`、保留段仍含至少 `retained_sends_target` 次 `send`；之后请求里不再出现被淘汰的那几轮，`head_seq` 与日志一致。
- 被 GC 淘汰的消息携带的引用立即失效：引用旧 `img_`/`stk_`/reply 的 `send` 必须被拒绝，而不是照旧发出。
- 睡眠状态只随注入批次下发：`zzz` 暴露前后两次请求的 system prompt 逐字节相同，睡眠状态出现在注入批次的 `<runtime_state>` 里；`zzz` 结束时 Invocation 的 `completion_reason` 是 `sleep`。
- `send_nudge_enabled = true` 且模型持续只写私文本：每个批次的提醒紧跟该批次（`agent_messages` 里 `harness_nudge` 排在下一次注入的 batch 之前，`telegram_sends` 逐批出现），而不是整段运行只提醒一次、其余批次的回复全部丢掉。
- `send_barrier_enabled = true` 且模型回复期间同一人补了一句：`tool_calls` 先出现一条 `error` / `send_barrier`，随后才有一条 `success`；`invocation_buckets` 里补话那批与开场批次属于同一 `invocation_id` 且 `injected_at` 非空；Telegram 上只有一条合并后的回复。自动化用例见 `test/context-hot-inject.test.ts` 的「send barrier」组（含每轮只拦一次、同一 turn 的第二次 `send` 也被拦、关闭时行为不变）。
- `/cut_topic`：日志出现 `context_cleared`，`conversation_contexts.head_seq = next_seq` 且 `context_refs` 清空，下一条消息不再看到切点前的 transcript（Telegram 上切了历史、模型仍记得的旧故障形态不应再出现）。该 Conversation 正在运行的 Invocation 会以 `aborted` / `context_cut` 收尾；切点落在某一轮中途时，下一次运行日志出现 `context_realigned` 而不是 provider 400。
- `/status` 的 Context 行显示该 Conversation 的保留消息数、保留 send 数与 `head_seq`，以及 `未 GC` 或上次 GC 时间；尚未建立 Context 时显示 `Context: 尚未建立`。

### 输出与 Reply

- Bot 回复必须对应 `send` Tool Call 和 `telegram_sends` success。
- 普通 Assistant Message 不应直接出现在 Telegram。
- Reply 只能指向当前 Conversation Context 授权且未过期的 Message；被 GC 淘汰的消息携带的 reply 引用立即失效。
- Agent 可以 completed 且 `sends_used = 0`，这是正常静默。

### 图片与 Sticker

- 使用 image-capable Agent 发送 Photo/图片 Document：首轮 User Message 直接包含标准化图片，不产生 `read_image` 或 `vision_chat`。
- 使用 text-only Agent 发送 Photo/图片 Document：Context 提供 `image_ref`（`img_` token），`read_image` 成功且产生 `vision_chat` 审计。
- 同一 Telegram Photo 的多尺寸数组只保留最高分辨率变体。
- 发送从未分析的静态/视频/TGS Sticker：`read_image` 或后台索引触发视觉分析并写结构化元数据。
- 普通图片与 Sticker 再次读取：命中各自的 `file_unique_id + analysis_version` 缓存。
- Sticker 分析必须产生 `report_sticker_analysis` Tool Call；文本 JSON/code fence 不算成功。
- `search_stickers` 只返回允许 Set 中已索引 Sticker。
- `send` 不能使用模型虚构的 file ID。
- 重复发送已交付的同一 generation：Tool 结果返回 `replayed:true` 并列出相关投递批次的旧 Telegram message ID，没有新 Telegram 消息、不新增 `telegram_sends` 行、不增加 `sends_used` 或限流用量；只有普通用户轮的显式 `resend:true` 才重发。完成回执轮拒绝 `resend:true`，但默认发送仍可返回去重结果；pending/未知结果阻止默认发送与显式重发。

### Forum Topic

- 允许 Topic：正常入库。
- 未允许 Topic：`topic_not_allowed`。
- 两个 Topic 的 Conversation、history、Bucket、Reply 和媒体 capability 不混合。

### Skills 与 execute

- system prompt 包含完整 Skill 索引；模型未读取任何 Skill 也能直接调用 `send`。
- 让模型处理匹配某个 Skill 的任务：审计出现 `read` 的 `system:///skills/...` 成功行，随后是 `execute` 调用行。
- 贴纸请求走「`execute.call search_stickers` → 封套 `refs.sticker_ref` → `send kind=sticker`」链路；`tool_calls` 中 `execute` 与 `search_stickers` 各自成功。
- 模型尝试 `execute.call send/zzz/read/execute`：审计记录 `execute_primitive_rejected`，消息未发出。
- 上下文收尾轮次仍可直接 `send`；`zzz` 暴露与休眠终止不受 Skill 加载影响。

### MCP

仅在配置 MCP 时执行：

- required Server 失败会阻止启动。
- optional Server 失败进入 degraded，不伪装 ready。
- allowlisted Tool 可调用并审计。
- 未配置策略/超时/超大小结果被拒绝。
- Streamable HTTP 重定向被拒绝；静态 Header 生效且不进入日志。

## 审计验收

对一次真实交互至少核对：

```text
telegram_updates
  → messages/message_revisions/media
  → buckets/bucket_messages + invocation_buckets
  → invocations/invocation_messages
  → model_calls
  → tool_calls
  → telegram_sends 或 media_analyses
```

`invocations` 不再与 Bucket 一一对应：`invocation_buckets` 记录哪些 Bucket 进入过哪次运行，只有 `injected_at` 非 NULL 的批次才真正送达模型。模型实际保留的输入不在这条链上，而在 `conversation_contexts`/`context_messages`/`context_refs`：判断“模型现在还看得见什么、还能用哪些引用”要看这里，不要从 `invocation_messages` 推断。

结论必须区分：

- Telegram 表面回复成功。
- Invocation 成功。
- 具体 Tool 成功。
- Vision/MCP 子调用成功。

曾出现“Bot 对 Sticker 给出自然回复，但 `read_image` 实际失败”的情况；只有审计链能识别这种降级。

## 备份与恢复验证

按[运行与运维：备份](operations.md#备份)执行备份命令。检查：

1. 生成新 `.sqlite`。
2. 数量不超过 `backup_copies`。
3. 对复制文件执行 `PRAGMA integrity_check` 返回 `ok`。
4. 在隔离目录使用备份启动或打开数据库。
5. 当前生产数据库、WAL、SHM 不被测试覆盖。

## 提交前检查

```bash
git diff --check
pnpm run check
pnpm cli:check
pnpm test
```

最终报告应精确写明：

- 哪些命令通过。
- 哪些真实场景执行过。
- 哪些外部场景因 Token、Chat、Provider 或 MCP 不可用而未执行。
- 观察到的审计状态，而不是推测状态。

图片设置浏览器回归：`pnpm run admin:build` 后执行 `pnpm run admin:test:e2e 00-auth 11-image-settings`，覆盖搜索与下拉选型、自动能力、保存与回显、空密钥沿用、旧配置凭据复用与重复项合并、缺项提示但按钮可点击且不发送非法写入、目录/供应商失败重试和窄屏无横向溢出；模型目录使用固定响应，真实 OpenRouter 目录需另行只读验收。

生图审计详情浏览器回归：`pnpm run admin:build` 后执行 `pnpm run admin:test:e2e 00-auth 12-image-generations`，使用固定生成记录验证详情深链接、刷新、列表进入与返回；断言生成状态、Attempt 错误、上游请求编号、用量、最终 Prompt、参考图快照顺序与原图链接、无参考图及原图加载失败状态，并保证浏览过程不发起写请求或真实生图。
