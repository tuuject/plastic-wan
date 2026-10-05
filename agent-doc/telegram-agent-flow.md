# Telegram 与 Agent 流程

## 接收边界

服务使用 grammY long polling，只订阅：

- `message`
- `edited_message`
- `my_chat_member`

群聊不要求 mention Bot。是否处理消息只由配置和代码决定，不由 Prompt 决定。

`TelegramIngestion` 对每个 Update 先写 `telegram_updates` 审计，再判定：

1. Chat 类型是否支持。
2. Chat ID 是否在 `telegram.chats`。
3. Forum Topic 是否在可选 `topic_ids`。
4. 消息的 `message.from.id` 是否命中当前 Chat 的 `ignored_user_ids`。
5. 消息是否来自 Bot/Service，以及 `process_bot_messages` 是否允许；允许的其他 Bot 消息只能随真人消息进入 Bucket，见配置文档。
6. 单独的人类 Sticker 是否允许按 `sticker_trigger_enabled` 创建 Bucket；该开关默认关闭。
7. Message/Edited Message 结构是否可归一化。
8. 配置了 `participation` 的 Chat 在活跃时段外是否被这类消息命中触发，见「定时活跃与注意力窗口」。

拒绝的 Update 不进入 Bucket，但保留稳定 `rejection_reason`，例如 `chat_not_allowed`、`topic_not_allowed`。唯一例外是管理员在未允许 Chat 发送的 `/allowlist`：它按已允许入库审计并直接作为命令处理（见 [Bot Commands](#bot-commands)）。允许 Chat 内被 `ignored_user_ids` 命中的用户消息仍保留 Update 审计，但在 Message 和 Bucket 边界之前直接丢弃；命令也被丢弃，只有实时新消息中的 `/ignoreme`、`/unignoreme` 放行，以便成员恢复接收。其文本、媒体及后续编辑不会进入实时或启动追赶 Context，其他成员回复该用户时也不保存对应 Reply 快照。该过滤只匹配 Telegram user，不匹配 `sender_chat`，且不追溯删除配置生效前已入库的历史。排查 allowlist 时同时比较配置哈希；删除 Chat 与非热字段的修改仍需重启（新增 Chat 与已有 Chat 的 `instructions_file`、模型覆盖、`ignored_user_ids` 属于热更新白名单，见 [configuration.md](configuration.md#运行时配置热更新)）。

## Chat、Conversation 与 Topic

- Telegram Chat 归一化到 `chats`。
- Supergroup 迁移通过 `chat_migrations` 把旧 ID 指向 canonical Chat。迁移通知（`migrate_to_chat_id` / `migrate_from_chat_id`）在 allowlist 与 Topic 校验之前记录，因为新 Supergroup 的 ID 正是靠这条通知获得授权；只有旧 ID 本身被允许时才记录。
- Conversation 由 Chat 与真正的 Forum Topic 组成。仅当 Supergroup 的 `chat.is_forum = true` 且消息的 `is_topic_message = true` 时，才使用 `message_thread_id` 隔离 Conversation。
- 私聊、普通群消息及非 Forum Supergroup 的普通回复线程统一使用 thread ID `0`；Telegram 在普通回复中提供的 `message_thread_id` 不作为 Topic。
- 不同 Forum Topic 的 Bucket、Context、Reply 和预算相互隔离；启动追赶是显式的 Chat 级例外。

## Message Revision

`messages` 保存 Telegram Message 的稳定身份；每次首次接收或编辑产生一条 `message_revisions`：

- Text/Caption
- Sender user 或 sender_chat
- Reply 快照
- Forward origin
- Media group ID
- Service 片段
- 受限原始 JSON 片段
- 关联 Media

相同内容的重复 Update 不创建无意义 Revision。截止时间到达时，Scheduler 冻结当时最新 Revision；截止后的编辑只进入未来 Invocation 的 history。

## 启动追赶

普通重启在启动 Scheduler 和常规 long polling 前，以非阻塞 `getUpdates` 排空 Telegram pending updates：

1. Update 仍经过 allowlist、去重、Revision 与媒体持久化，但不创建常规实时 Bucket。
2. `app_state.telegram_startup_catch_up` 保存本轮起点；进程在排空或建任务时崩溃，下一次启动从同一起点完成，不丢失已确认 Update。
3. 每个有可触发消息的 Conversation（Chat + Forum Topic）只创建一个 `startup_catch_up` Bucket，取该 Conversation 最新的 `agent.history_messages` 条消息，参与闸门也按该 Conversation 判断；同一 Chat 的多个 Topic 各自排队，由 Scheduler 按 Chat 串行启动；单独的人类 Sticker 仍受 `sticker_trigger_enabled` 限制。
4. Bucket 仅包含该 Chat 按 Telegram 时间排序的最新 `agent.history_messages` 条本轮消息；Forum Topic 可以混合。
5. Snapshot 携带 `message_thread_id`。回复可见消息时，`send` 路由到该消息所属 Topic；不带 Reply 时路由到最新消息所属 Topic。
6. 排空完成并原子清除启动状态后，才切换到常规按 Conversation 收集。

## 会话节拍与 Bucket

Chat（群）空闲时，第一条可触发消息创建该 Conversation 的 `collecting` Bucket，并先等待一个完整节拍：

```text
anchor   = max(first_received_at, 该 Conversation 上一轮结束时刻)
deadline = anchor + telegram.bucket_window_seconds
```

「上一轮结束」指 Agent 空下来的那一刻：该轮的 turn 没有 Tool Call、队列里也没有待注入批次。Agent 本来就空闲时，anchor 就是第一条消息自己。

`telegram.bucket_window_seconds` 是全局配置，接受 0–300 的整数秒；`0` 表示新消息可以立即触发，不表示持续轮询。**Agent 会话按 Chat 串行**，消息收集仍按 Conversation 隔离：

1. 不同 Forum Topic 的消息各自进入自己的 `collecting` Bucket；Context 与 Reply 只包含本 Topic 内容，互不混入。
2. 同一 Chat 同时最多一个 queued/running Invocation；运行期间任何 Topic 的新消息只进入自己的 Bucket，不修改当前 Invocation。
3. 每个 Bucket 的 deadline 是 **`max(第一条消息时刻, 该 Conversation 上一轮结束时刻) + bucket_window_seconds`**，按 Conversation 计算。Agent 空闲时它退化成 `first_received_at + bucket_window_seconds`；若第一条消息到达时上一轮还在跑，这批的窗口从该轮结束才开始，因此至少收集满一个窗口。deadline 与 Invocation 的 `started_at`/`finished_at`、queued/running 状态无关，也不会提前。
4. 没有新的可触发消息时不创建 Bucket，也不启动空会话。`sticker_trigger_enabled` 默认为 `false`：单独的人类 Sticker 不开 Bucket，但可以加入已有 collecting Bucket；设为 `true` 后可以单独触发。
5. 到达 deadline 后，Scheduler 冻结 `history` 与 `new` 快照并创建 Invocation；若该 **Conversation** 已有 running Invocation，则改为 attach，见「长活 Invocation 与热注入」。
6. 每一轮结束时，该 Conversation 仍 `collecting` 的 Bucket 会把 deadline 推到至少 `本轮结束 + bucket_window_seconds`（只往后推，已有更晚的 deadline 不动）；Invocation 结束时，已到期的 collecting Bucket 立刻被处理，尚未到期的保持自己的窗口。deadline 从不被提前裁剪，已建立的批次也不会被打断。

因此，只要 Agent 每轮都很快结束，会话开始时间仍大致相隔 `bucket_window_seconds`；某一轮超过一个窗口时，该轮期间到达的消息统一从该轮结束起算，这批会比固定网格晚一些，与该群有多少活跃 Topic 无关。Bot 自己通过 `send` 产生的消息写入可见历史，但不会触发下一 Bucket。

deadline 不看「前一次运行是否仍在 queued/running」，但**运行中的批次不会在轮中途被交出去**：该轮还没结束时，该 Conversation 已到期的 collecting Bucket 只会留在 `collecting`（Scheduler 会把它的 deadline 至少推到 `now + bucket_window_seconds`，轮结束时再由运行时精确锚到轮结束），不会注入。若把「运行中」当成「立刻到期」，运行超过一个窗口后每条消息都会各自变成零长度 Bucket 并各自注入一批（实测：1.4 秒内 6 条消息 → 6 次注入），节拍就没有了。同理不把 deadline 吸附到 `前一次运行 started_at + bucket_window_seconds` 的网格点：那会让运行开始后一个窗口内到达的消息只收集几毫秒（实测 805 ms）就到期，表现为偶尔秒回。

代价是明确接受的：一轮很长（例如 40 秒）时，该轮期间到达的**所有**消息会被并成一批，在该轮结束后满一个窗口才注入——活跃对话因此可能多等一个窗口，换来的是「一轮期间的消息不会把上下文切成若干碎片批次」。唯一的例外是开启 `agent.send_barrier_enabled` 时的 [send 屏障](#send-屏障)：它只在该轮第一次真正发送之前、由 `send` 自己把这批提前取走。

配置了 `participation` 时，「可触发消息」还要先通过下一节的闸门。

## 长活 Invocation 与热注入

`agent.context.idle_grace_seconds` 大于 0 时，Invocation 变成一个运行窗口：它可以跨多个 Bucket，在运行期间接收新注入的消息。

```text
Bucket 到期
  ├─ 该 Conversation 有 running Invocation：attach（写 invocation_buckets + 冻结快照）→ steer 注入
  └─ 否则：创建新 Invocation（既有行为）
```

规则：

- **注入粒度是 Bucket，不是单条消息。** 运行期间到达的消息进入下一个 `collecting` Bucket（同一 Conversation 同时只有一个 collecting Bucket），窗口从该轮结束起算，等满一个窗口才成为一批。

一轮完整循环（`bucket_window_seconds = 15`、`idle_grace_seconds = 60`，假设 Agent 每轮耗时 2 秒）：

```text
T+0    消息 A 到达 → 创建 collecting Bucket 1，deadline = T+15
T+3    消息 B、C 到达 → 进入 Bucket 1（同一个 Bucket）
T+15   Bucket 1 到期 → 该 Conversation 无 running Invocation → 创建 Invocation I 注入，本轮开始
T+16   消息 D 到达（I 还在跑本轮）→ 创建 collecting Bucket 2；它还没等到 Agent 空下来
T+17   I 完成本轮 send → 本轮结束 → Bucket 2 的 deadline 推到 T+17+15 = T+32
T+32   Bucket 2 到期 → attach 到 I 并注入同一 invocation_id，本轮开始
T+34   本轮结束；消息 E 到达 → 新建 Bucket 3，deadline = T+34+15 = T+49 …循环
T+94   若期间再没有新 Bucket 到期，空闲等待耗尽，I 结束
```

要点：**窗口从 `max(第一条消息时刻, 上一轮结束时刻)` 起算**，所以每一批都至少收集满一个窗口；运行期间到达的消息统一归入一批，在该轮结束满一个窗口后注入——既不在一轮中途被切开，也不会在轮结束的瞬间就注入。空闲等待耗尽的时刻若还有未到期的 collecting Bucket，I 正常结束，那批到期时按「无 running Invocation」开新的 Invocation。
- attach 只发生在**同一个 Conversation**。同一 Chat 另一个 Forum Topic 到期的 Bucket 不会 attach，它属于另一个 Conversation Context，等该 Chat 空闲后开新的 Invocation。
- attach 时对该 Bucket 调用 `snapshotInvocation(..., includeHistory: false)`，按 `sequence_no` 续写到 `invocation_messages`，因此「冻结模型输入」的不变量不变：之后编辑已注入的消息不会改动已注入的批次。
- 一批注入即是一个 checkpoint（见「Context 生命周期」），注入方式是 `agent.steer()`；`steer` 的可见点是 turn 边界，长 Tool 批次期间到达的消息会延迟到该批次结束，并且**不等 grace**：待注入的批次会先被注入，再回答它。
- **空闲等待发生在每一轮结束时，不在每个 turn 上**：该 turn 没有 Tool Call、且队列里没有待注入批次时，才等待至多 `idle_grace_seconds`。回合内的工具步骤、以及刚注入一批还没回答的 turn 都不等待，否则一轮里的每一步都要白等一个 grace（回归：一轮内两次 `send` 曾各等满 3 秒）。
- 结束判定顺序：睡眠/暂停/每日预算触顶 → 结束；有已 attach 未注入的 Bucket → 注入后继续；一轮结束时先标记 Agent 空闲并把 collecting Bucket 的 deadline 推到至少 `本轮结束 + bucket_window_seconds`，再空闲等待至多 `idle_grace_seconds`，期间有 Bucket 到期 → 注入后继续；超过 `max_wall_clock_seconds` → 结束；其余结束。
- **`idle_grace_seconds = 0` 是关闭开关**：不空闲等待、到期 Bucket 不 attach，退回「一次 Bucket 一次 Invocation」，但 Conversation Context 依然持久，且运行期间到达的批次仍从本轮结束起算窗口（比从消息自身起算可能晚一个窗口）。这是唯一受支持的降级方式，代码里没有第二套模式或 mode 分支。
- 防失控靠 `agent.rate_limits`：`turns_per_injection` 限制每批注入后最多跑多少轮（注入即重置），`sends_per_window`/`window_seconds` 限制同一 Chat 滑动窗口内的 `send` 次数，`max_wall_clock_seconds` 限制单次运行总时长。per-Invocation 的 `max_turns`/`max_sends`/`timeout_seconds` 已删除。
- attach 但从未注入的 Bucket 在运行结束时重新排队成新 Invocation（`invocation_buckets.injected_at` 为 NULL），不会被丢弃。`injected_at` 在该批的 user 消息写进 canonical history（`message_end`）之后才写入，而不是 `steer` 排队时：`steer` 只是把消息放进 Agent 队列，这条消息落库失败导致运行失败时，这批仍按未注入重新排队。
- `/pause` 会中断处于空闲等待中的 Invocation。

## Context 生命周期

每个 Conversation 持有一份 **Conversation Context**：canonical history 是 `context_messages` 的 `[head_seq, next_seq)` 区间**且 `evicted_at IS NULL`**，按 `seq` 严格有序，跨 Invocation 与进程重启存活。运行中的 Pi Agent 从这份历史播种，写回也以它为准；`ConversationRuntime` 里的 Agent 实例只是 LRU 缓存（`agent.context.agent_cache_size`），驱逐后能从数据库重建等价 transcript。

保留窗口有两道守卫，都是为了「淘汰过的行不会以任何方式回到模型面前」：

- **淘汰本身就是权威，不只靠 `head_seq`。** 读取保留窗口一律附带 `evicted_at IS NULL`。因为运行中的 Invocation 持有一份运行开始时的 header 快照，`/cut_topic` 之后它的 `head_seq` 比数据库更旧；纯区间读会把切掉的历史读回来，甚至把这个更旧的值写回去。
- **播种只从 turn 边界开始。** 保留窗口首行不是 `user` 时（例如切点正好落在某一轮中途，被中断的运行还落了一条 `toolResult`），播种前先往前推到第一个 `user` 行；找不到就整段丢弃。两种情况都记 `context_realigned` 日志。这道守卫是必需的：`pi-ai` 只补缺失的 tool result，孤儿 `toolResult` 会原样发给 provider 并被拒绝，该 Conversation 会一直失败到有人再切一次。

写入规则：

- 只有 `user`、`assistant`、`toolResult` 三种 role 进入 canonical history，写入时机是 `message_end`；每条记录产出它的 `invocation_id`。
- 过滤：`stopReason` 为 `error`/`aborted` 的 assistant 消息不写入，内容全空的 assistant 消息不写入（Pi 的 provider 层会静默丢弃它们或在失败时 push 一条空 assistant）。
- 完整 `AgentMessage` JSON 入库（含 `toolCallId`、`toolName`、`arguments`、thinking signature），因此可原样回放；内联图片块不入库，历史图片靠 `img_` 引用按需 `read_image`。
- 编解码必须对 Provider 能产出的任何消息成对成立：`usage` 是原样抄写 Provider 的报告，因此宽松接受未知计数（OpenRouter 的 `reasoning`、Anthropic 的 `cacheWrite1h` 拆分）；`content` 块与消息信封是逐字段投影，仍严格校验。**一行解不开不只是坏行**：它的整段保留窗口都无法播种，该 Conversation 之后每次 Invocation 都会在第一次模型调用之前失败，直到有人手动清历史——因此解码器只在真正缺字段时报错，运行时的异常也必须落日志（见下）。
- `agent_messages` 表继续保存摊平的文本审计，供面板阅读；`context_messages` 才是可回放的 canonical history。

system prompt 拆分（文档中只在此处维护；`ContextBuilder.buildSystemPrompt` 产出稳定段，`renderInjection` 产出注入段）：

- **稳定段**只包含不随 Invocation 变化的内容：Core Agent Protocol、System Skill 索引、图片/Sticker 说明、人格 Prompt、私聊/群聊模式、Chat instructions、记忆的使用说明。Core Protocol 规定消息分区、Tool 选择原则与副作用成功判定；人格 Prompt 只负责身份和表达风格；稳定段不写「什么时候该参与」——是否发言由模型按当前批次判断；群聊的消息准入由运行期 participation 闸门决定（配置了才生效）。它对一个 Conversation Context 保持逐字节稳定，这样每次请求的前缀能被 provider prefix cache 命中。Sticker 目录（`sticker_id:emoji`）是**不可信数据**，因此随批次注入，不进入稳定段；它只在与保留 transcript 里最新一份不同时才重新附带（被 GC 淘汰后也会重新附带），不是每批都带一份。
- **注入段**是一条 `user` 消息，依次为：可信的 `<runtime_state>`（当前时间、睡眠状态、完成事件说明、Startup catch-up 说明、`<memory_list>`）、可选的 `<untrusted_task_receipt>`、可选的 `<untrusted_sticker_catalog>`、可选的 `<untrusted_telegram_history>`（见下一条）、`<untrusted_new_messages>`（本批 Telegram 快照）。完成回执的结构化内容与其它 `<untrusted_*>` 一样只是数据，不是指令或待发送消息。
- 消息不以 `invocation_messages` 的快照 JSON 发给模型，而由 `formatSnapshot` 渲染成省 Token 的紧凑文本：一行 `[message_id 本地时间 topic:N you re:N uid:N @username] 显示名` 头部，下面是两格缩进的正文（转发来源、回复引用、text/caption 各行、`[kind ref WxH]` 媒体行）；空字段、`revision`、`media_group_id`、mime 等不渲染，日期只在与本批 `current_time` 不同时显示，回复目标就在同一批时省略引用。头部方括号内只有 runtime 生成的 token，所有 Telegram 可控内容都在缩进行上，因此无法伪造头部或区块标签；`collectVisibleSenders`/`collectInjectedMessageIds` 只回读最后一个 `</runtime_state>` 之后的头部行。改动这个格式要同步改 `CORE_AGENT_PROTOCOL` 中的格式说明（system prompt 哈希变化会让所有 Context 重建）。
- 历史不再被重新渲染成 `<untrusted_telegram_history>`；它由 transcript 本身承载。只有两种情况例外：该 Conversation Context 尚无历史（冷启动），以及历史区段里那些**从未进入 transcript 的消息**（例如被 participation 闸门拦下的消息）——它们仍然必须渲染，否则模型永远看不到。
- 随 Invocation 变化的内容（当前时间、记忆、睡眠状态、完成回执）都必须待在注入段：放进 system prompt 会让每次请求的前缀都不同，既失去前缀缓存，又违反「Context 可以稳定保留」的前提。每个 receipt 只在自己的回执轮次注入一次：新 Invocation 通过 opening Bucket，附加到运行中的 Invocation 则在该回合的热注入中单独消费；后续批次不重新附带该 receipt，canonical history 已保存这次事件，其它 receipt 仍各自独立注入。
- system prompt 变化（`system_prompt_hash` 不同）意味着 Context 重建：丢弃全部 canonical history 重新开始。Prompt 与 Chat `instructions_file` 属于配置热更新白名单：改完文件并在 Admin「Apply config file」或 `/model` 应用之后，该 Conversation 下一次运行就按新哈希重建；运行时切换模型若改变了模板渲染结果或图片说明，同样会重建。清单见 [configuration.md](configuration.md#运行时配置热更新)。

垃圾回收（GC）是**只删不摘要**的 checkpoint 滑动窗口，挂点只有一个：`prepareNextTurnWithContext`（位于流式输出之后、Tool 批次闭合之后，是唯一安全的裁剪点）。

- checkpoint 是纯 metadata（`context_messages.is_checkpoint`），不是消息；每批注入的 `user` 消息打上该标志。`assistant`/`toolResult` 永远不是 checkpoint。
- 触发条件：保留区间的 `send` 数超过 `agent.context.retained_sends_max`，或估算输入 + `maxTokens` 达到 `contextWindow * hard_token_ratio`。
- 目标 checkpoint：从最新往回找第一个仍保留至少 `retained_sends_target` 次 `send` 的 checkpoint（`send` 少而 Tool 多的历史退回 token 判据），一次跨过多个 `send`，形成 sliding window。有 token 压力时，按 `send` 数选出的候选还必须让保留段落到 token 软预算（`contextWindow × hard_token_ratio × 0.8`）以内，否则改用 token 判据，哪怕保留的 `send` 少于目标。
- GC 之后按保留行与当前 Tool 注册表重新估算输入 Token，再判断是否进入 `context_stop_ratio` 收尾；否则估算仍停在 GC 之前的高水位，刚被 GC 缓解的运行会直接进入收尾。
- 安全校验：目标必须是 checkpoint 的 `user` 消息、必须前进、保留段头部不能是 `toolResult`、保留段内每个 `toolResult` 都要有对应的 assistant toolCall。任一不过就放弃本次 GC，等下一个 turn 边界（最高优先级守卫：provider 不会修孤儿 `toolResult`）。
- GC 后必须同步四处：`head_seq` 前移（旧行软标记 `evicted_at`）、loop context 的 `messages`、`Agent.state.messages`、被淘汰消息携带的 `context_refs`。缺任何一处都会让三份历史分叉。
- 一份 Context 在运行期只允许一个 `ContextHeader` 对象。`ConversationContextStore` 会就地推进传入的 header，而写入方（`#persistMessage`、`#maybeCollect`）走 `entry.header`、注入与引用解析走 `open()` 的句柄，所以缓存命中时必须把新句柄赋给缓存条目。留成两个对象时后者永不推进：复用缓存的运行里，第一批之后的每一批都会把「本次运行开始时的 `next_seq`」写成自己 `img_`/reply 引用的 `source_seq`，于是这些引用会比应有的时间早一次 GC 失效；同时引用解析比对的 `head_seq` 也看不到运行中途的 GC。
- `context_gc` 日志的 `previous_head_seq` 是裁剪前的 head，`head_seq` 与 `target_seq` 是裁剪后的位置；只看后两者无法判断这次丢了多少。
- 一个 checkpoint 都没有（冷启动首轮）时不 GC，只能靠收尾模式处理。

## 引用（capability）生命周期

`img_`（媒体）、`stk_`（Sticker）、`reply:<telegram_message_id>`（Reply 目标）三类引用存在 `context_refs`，按 Conversation Context 隔离并带 `expires_at`（`agent.context.ref_ttl_hours`）：

- 同一媒体在 TTL 内复用同一个引用，历史文本因此不会每轮变化。
- `send` 的校验从「当前 Invocation 授权」放宽到「**当前 Conversation Context 授权且未过期**」；`read_image` 同理。
- 跨 Conversation 的引用永远不解析。引用被 GC 淘汰（其来源消息已不在保留段）后立即失效。
- `/cut_topic` 会同时清空该 Conversation Context，否则命令名义上切了历史、模型仍能从 transcript 看得见。

## 定时活跃与注意力窗口

配置了 `telegram.participation` 或 `chats[].participation` 的群聊不再无条件开 Bucket。先在活跃时段外处理有触发资格的新消息、更新注意力窗口，再判断 participation 闸门；allowlist、暂停状态和消息触发资格仍独立生效：

```text
participation 放行 = 未配置 participation || 处于活跃时段 || 更新后的注意力窗口未过期
```

- **活跃时段**（`active_windows`）按 Chat 时区解释，是半开区间 `[start, end)`；`end < start` 表示跨午夜并归属开始日，`end = "24:00"` 表示到当日结束。时段内行为与未配置时完全一致。
- **触发**只有三类：直接 @ Bot、Reply Bot 自己发过的消息（判定原始 Update 的 `reply_to_message.from.id`）、命中 `trigger_keywords`（`text` 与 `caption`，大小写不敏感）。优先级是 mention → reply → keyword，只影响记录下来的 `trigger_kind`，不影响是否放行。
- 仅在活跃时段外，有触发资格且命中的新消息才先写入或刷新 `conversation_attention`（`expires_at = receivedAt + attention_window_seconds`）再判定，因此命中消息自身会通过 participation 闸门。活跃时段内直接放行，不创建或刷新注意力窗口；实时入库与启动追赶复用这一判断。
- 窗口按 Conversation（Chat + Forum Topic）隔离；时段按 Chat 生效，时段内该群所有 Topic 都活跃。
- 只有能开 Bucket 的消息才能开窗口：`sticker_trigger_enabled = false` 时的单独 Sticker 既不开 Bucket 也不刷新窗口。
- 编辑消息不触发、不刷新窗口、不开 Bucket，但仍写入 Revision，并在后续 Invocation 中作为 history 出现。
- 闸门只阻止**创建** Bucket：已有 `collecting` Bucket 时，被抑制的消息仍按原逻辑追加进去。被拦下的消息照常写入 `messages`、`message_revisions` 与 `media`。
- 命中时打印 `agent_attention_triggered`（`chat_id`、`conversation_id`、`trigger_kind`、`telegram_message_id`、`expires_at`）；被抑制的消息不打印，避免静默期每条消息一行。
- 私聊永不受闸门影响；`/pause` 优先（暂停期间既不建 Bucket 也不记窗口）；任务 timer 仍可完成，但回执投递会在 pause/目的地无效时结算为 suppressed。
- 启动追赶同样过闸门：追赶 Bucket 只在处于时段内或窗口未过期时创建，否则记为 `skipped_budget`/`participation_gated`。追赶期间收到的命中消息同样会刷新窗口，因此停机期间被 @ 不会丢。

## Context

一次 Invocation 的模型输入由 `ContextBuilder` 的两半拼成：稳定的 `systemPrompt` 与一批注入消息，两者各含什么见 [Context 生命周期：system prompt 拆分](#context-生命周期)。项目里不再有「每次重新渲染全部历史」的 `userPrompt`——历史由 Conversation Context 的 transcript 承载。本节只记录拆分之外的组装产物与规则：

- `directImages`：当 `agent` 模型支持 image 时，**本批**消息里的 Photo/图片 Document 经标准化后成为同一 User Message 的多模态内容，并按 `figure_N` 与消息媒体行中的引用对应。媒体行同时带稳定的 `img_` 引用（`[photo figure_1 img_xxx WxH]`）：codec 落盘时丢弃内联图片块，重启或缓存丢弃后 replay 的 transcript 只剩文本，模型要靠这个 `img_` 用 `read_image` 再看；`read_image` 不接受 `figure_N`。
- `visibleSenders`：本批及保留历史中可见的 Telegram user sender，供 Alarm 插件校验目标。
- `imageCapabilities`：Sticker 始终可用；Photo/图片 Document 在 `agent` 模型不支持 image 时全部可用，支持 image 时历史图片通过 `img_` 引用可用，供 `read_image` 使用。
- `omittedNewMessages`：因 Context 上限省略的新消息数量。

当前 Conversation 全部有效记忆按创建时间升序出现在注入块的 `<memory_list>` 内。新增记忆等价于列表末尾 append，不重排已有项；TTL 到期与 `delete_memory` 只破坏删除位置之后的缓存前缀。

`list_alarm` 的 `items` JSON 经 `execute.call` 的 `text` 封套作为普通工具结果，由既有的 canonical `context_messages` 保存，跨 Invocation、Agent 缓存与进程重启复用，随 checkpoint GC 或话题清空自然遗忘。列表同样受通用结果长度限制，不保证超长列表完整。若历史缺失或不能唯一解析目标，模型应重新调用 `list_alarm`；仍无法确定时应澄清，不能猜 ID。`delete_alarm` 仍按 live caller、plugin、Conversation 与 pending 状态鉴权，不依赖任何旁路存储。

Context 受模型窗口限制：为系统提示、完整 Tool 定义（名称、描述与参数 Schema）、历史、新消息和输出保留空间。Tool description 不只是能力清单，还应说明何时使用、何时不用、必要调用顺序和成功判定。估算输入达到 `context_window × context_stop_ratio` 后进入收尾模式：下一次模型调用只带 `send` 和当时可用的 `zzz`，模型用这一轮把话说完，这一轮结束后运行以 `context_limit` 结束。Pi 在同一个 turn 边界先调 `prepareNextTurnWithContext` 再调 `shouldStopAfterTurn`，所以「进入收尾」和「停止」必须隔开一轮，否则收尾轮根本不会发生。

## Agent 循环

```text
Context（稳定 system prompt + 本批注入）
  → model turn
  → zero or more Tool Calls
  → Tool Results
  → next model turn
  → completed / failed / aborted / outcome_unknown
```

Invocation 结束时 Agent 实例可以留在 `ConversationRuntime` 缓存里供下一次复用；canonical history 才是唯一真相，缓存被驱逐或进程重启都不影响连续性。失败运行（`model_error`）和抛出异常的运行都会主动驱逐该 Conversation 的缓存，避免把半截 transcript 带进下一次：Pi 先把消息推进 `state.messages` 再调用监听器，落库失败时内存里的 transcript 已经和 `transcriptSeqs` 分叉。

运行时抛出的异常（播种 canonical history 失败等）由 Scheduler 记为 `state = failed`、`completion_reason = invocation_error`，异常消息与堆栈以 `agent_invocation_error` 日志落盘——`completion_reason` 是 outcome 词表而不是错误类名，只有日志里才有“为什么”。同一条异常会把该 Invocation 消费的 Bucket 一起置为 `failed`，不会留下悬空的运行中 Bucket。`invocation_error` 意味着代码或存储层出问题，`model_error` 才是 Provider 侧问题。

限制来自配置：全局每日 Token 预算、`agent.rate_limits`（`turns_per_injection`、`sends_per_window`/`window_seconds`）、`agent.context.max_wall_clock_seconds` 与全局并发（`tool_calls_used` 仅作审计统计，不再按次数终止）。除该全局 Token 预算外没有其它每日配额：Chat 不限每日 Invocation 数，MCP Tool 不限每日调用数。模型调用与 Tool Call 分别写入审计；`execute` 每次调用有自己的 `tool_calls` 行，dispatch 到的内部能力还会各自再写一行，因此一次 `execute.call` 在审计里是两条可关联记录（外层 `tool_call_id` 与内层 `<id>:<tool>`）。`add_memory`/`delete_memory` 是持久化副作用，按 Conversation 隔离；`send` 仍是模型驱动的 Telegram 输出的唯一边界。

## Skills 与受控能力调用

工具面分三层：runtime 原语直接暴露、内部能力经 `execute`、MCP Tool 直接暴露。内部能力按需发现，避免每轮请求携带全部定义；这不是放宽授权，Schema、引用和预算仍由 Tool 边界校验。修改能力时先查 [组合根的 `capabilityTools`](../src/application.ts)（按符号名检索）与 [原语装配](../src/orchestration/agent-runtime.ts)，行为验证见 [验证索引](verification.md#静态与单元验证)。

- **原语**：`read`、`send`、`execute`、`zzz`（条件暴露）。它们的定义、Schema 与约束完全由 runtime 提供，不依赖任何 Skill；未读取任何 Skill 也能直接调用。
- **内部能力注册表**：由 [application.ts](../src/application.ts) 的 `capabilityTools` 装配，完整清单以此为准，不在文档维护副本。其中内置 Agent 插件（[plugins/builtin.ts](../src/plugins/builtin.ts)，当前为 `web-fetch` 与 `alarm`）经 `loadPlugins` 校验 id 后按 Invocation 贡献能力；插件只拿到 `InvocationScope`（活的 Invocation 上下文、deadline、绑定本 Invocation 的 `ToolAudit` 与自身 plugin/Conversation 的 task scope），不持有 Store 或 Runtime。插件能力与其他内部能力走同一条 `execute` 注册、校验、分发与审计路径。模型经 `execute` 的 search/help/call 按需发现与调用；调用前按目标能力的参数 Schema 校验，input 超 32 KiB 拒绝。
- **MCP Tool**：按配置 allowlist 直接暴露，不进入 `execute` 注册表。

`execute.call` 的结果是 `{text, refs}` 封套：内层 `text` 上限 30 KiB，序列化后的整体上限 32 KiB，超限截断带 `[content truncated]` 标记；`refs` 是本次调用产生的 Conversation Context 级引用 token（目前只有 `search_stickers` 的 `sticker_ref`，带 TTL），只能交给对应消费 Tool 在边界校验后使用。`execute` 拒绝四个原语（`execute_primitive_rejected`）与未知能力（`unknown_capability`），也不会递归调用自己。运行已被 abort 时 `execute.call` 不再 dispatch：内部能力不一定理会 signal（例如 `alarm`），所以在调用之前检查，外层 `tool_calls` 记为 `error`/`aborted`，不产生内层记录。

System Skills 是随 runtime 发布的只读文档包，位于 `src/system-resources/skills/<name>/SKILL.md`，或由内置插件以 Skill 目录声明（如 `src/plugins/web-fetch/skills/web-fetch/`），统一挂载在 `system:///skills/<name>/` 下（Docker 镜像随 `src/` 打包）。`SKILL.md` 头部 frontmatter 声明 `name`（必须等于目录名）与 `description`；Skill 重名（包括插件与内置树之间）或加载失败即启动失败。system prompt 只注入索引（名称、描述、`system:///skills/<name>/SKILL.md` URI）；正文由模型用 `read` 按需读取，即 progressive disclosure。`read` 只接受 `system:///` 绝对 URI 或「相对引用 + base」，路径段校验拒绝 `..`、反斜杠、百分号转义，只允许 `.md`，结果 32 KiB 截断。Skill 是文档不是授权：不能覆盖 Tool 约束、协议或预算。

每次模型请求都会附带完整的工具注册表（名称、label、描述与参数 Schema）。请求发出前把该请求实际附带的工具名写入 `model_calls.tools_json`，Invocation 的可用注册表快照（`name`/`label`/`description`）写入 `invocations.tool_registry_json`——因此可以审计“模型在某一轮到底看到了哪些工具”。context 接近上限时，Agent 循环只保留 `send` 和已经可用的 `zzz` 继续收尾。开启 `developer.record_model_payloads` 时，首个 agent 请求还会把归一化文本输入写入 `model_calls.replay_input_json`，作为 Invocation 重放唯一的起点（见 [data-layer.md](data-layer.md#工具可见性审计)）。

普通 Assistant Message 永不自动发布。模型不调用 `send` 即表示保持沉默，这是正常成功结果。`agent.send_nudge_enabled` 开启时，若本轮没有 Tool Call、私有文本去除首尾空白后非空，且**本批注入**以来尚未调用 `send`，harness 会在会话自然结束前至多注入一次 `steer` 提醒；提醒后仍不调用则静默放行，文本不出 Telegram。提醒的判定必须**早于**注入下一个批次与空闲等待：后两者都会延长这次运行，而草稿只有在自己那批仍是最新批次时才可挽回——排在它们后面会让整段运行期间每个「有草稿又被下一批接上」的批次都静默丢回复（只有真正静默满一个 grace 才会被提醒）。

## 睡眠

全局当日 `model_tokens` 剩余比例严格低于 5% 时，当前 Agent 才会看到 `zzz`；恰好 5% 不可见。全局用量是所有 Chat 的主 Agent 与聊天触发 `read_image` 用量之和，同时保留各 Chat 的归属统计；计量口径包含缓存读写（见 [configuration.md](configuration.md#agent-与-vision)）。运行中的会话越过阈值后，在下一次 model turn 边界更新工具注册表，不为此额外创建会话。

`zzz` 可见性与注入块里的睡眠状态说明由同一个判断渲染：只要 `zzz` 可见，本批注入的 `<runtime_state>` 就带一段自然语义的状态说明（现在很困、该睡就睡、静默结束也应该直接睡），而不是只让模型从 tool description 推断自己的状态。状态放在注入块而不是 system prompt，是因为 system prompt 必须对一个 Conversation Context 保持稳定。会话中途越过阈值时，工具注册表立即更新，状态说明在下一次注入时出现；如果该批注入之后 `zzz` 才可见，模型仍可从 tool description 推断。`zzz` 的 description 同样只用自然语义描述睡意，不暴露 token、budget、quota 等实现细节。

`zzz` 把全局 `bot_sleep_until` 写入 `app_state`，取 `max(调用时间 + 8 小时, 下一次 UTC 日预算重置)`。写入使用 SQLite IMMEDIATE transaction，重复或并发调用保持同一状态。调用后当前会话停止下一轮模型请求，后续实际 Tool Call 被阻止。

睡眠期间 Telegram Update、Message、Revision 与 Bucket 仍照常保存；Scheduler 将到期 Bucket 和尚未启动的 queued Invocation 标记为 `skipped_budget`/`sleeping`，不创建新 Agent。本该 attach 到运行中 Invocation 的到期 Bucket 同样跳过、不注入，空闲等待中的运行不会因此被唤醒再跑一轮；Chat 已移出配置时同理记为 `chat_removed`。首次在 `sleep_until` 之后检查状态时原子删除该键并恢复调度，因此状态可跨进程重启且不会因预算提前重置而提前唤醒。

管理员调大预算后可在 Admin Overview 手动解除睡眠；`POST /api/wake` 原子删除该键并唤醒 Scheduler，重复调用幂等。已因睡眠跳过的 Bucket 不会重放，后续到期 Bucket 与新消息恢复正常调度。

## Alarm / Deferred Invocation

`LongTaskService` 保存脱离创建 Invocation 继续存活的通用任务。插件只能取得绑定自身 plugin 与当前 Conversation 的 scope：创建时由可信插件冻结 payload 与 delivery policy；以后可用同一绑定 scope 的 completion handle `complete`/`fail`，不依赖创建 Invocation 或其 `AbortSignal`。没有通用后台 worker、executor、running/progress 或 retry。

1. 任务先处于 `waiting`。有 timer 的任务由唯一 Scheduler 到期完成；无 timer 的任务等待插件的外部 completion handle。完成、失败或取消在同一事务写入唯一 receipt，任务状态与投递状态分别是真相。
2. Scheduler 先处理到期 timer，再按创建时间/ID 选择 pending receipt。目的地 allowlist、Topic 与 pause 仍在投递前检查；每次 claim 都创建一个独立的空 Bucket，不伪造 Telegram Update/Message/Revision。
   - 如果同一 Conversation 已有 running Invocation 且仍接受注入，receipt 的 Bucket 会 attach 到该 Invocation，不另开 Invocation；同一 Invocation 可以拥有多个 receipt。
   - 如果同 Chat 没有运行中的 Invocation，则创建 queued receipt Invocation，启动时优先于普通 Bucket，但仍受 Chat 串行与全局并发。
   - 如果同一 Conversation 的运行正在 closing，或同 Chat 另一 Topic 正在运行，receipt 保持 `pending`，等可接收时再 claim。
3. receipt 的 opening 或热注入都包含可信的“当前完成事件”说明及不可信结构化 receipt。运行中的注入在工具链结束后一次注入一条 receipt，和普通消息不混合为同一 round；若尚未开始回执轮，已 attach 的普通消息批次优先。receipt 不触发普通回复的 `send` barrier；已经开始的回执轮也不会被新消息拦下发送，普通批次等回执轮结束再注入。模型自行决定是否、如何回复；普通 assistant 文本仍不会发布，只有 `send` 能产生 Telegram 副作用。task 完成不等于模型已发言或 Telegram 已送达。
4. pending receipt 可在完成后被取消投递（任务结果不回退）；claimed 不可单独取消。未消费的 attached receipt 在运行失败或结束时重排给新 Invocation 并转移归属；已 claim 的进程恢复收为 handled/`outcome_unknown`，绝不重放。`/pause` 或 Admin cancel 会让尚未注入的 attached bucket 过期，避免之后复活。Admin「Cancel ongoing」只取消已排队或运行的会话工作，不取消尚未 claim 的 pending receipt；这些回执仍可在后续调度中投递。
5. delivery policy 默认走普通预算、也不自动 mention。可信代码创建时冻结 `bypassDailyBudget` 才可绕过 sleep 与每日 Token gate，且仍受目的地、pause、串行、并发、wall-clock、发送限流和失败处理约束；它不赋予其它豁免。`zzz` 与预算状态按当前回执轮动态恢复，caller 清空；mention/bypass 只对当前回执轮次有效，冻结 mention 只在该轮第一次成功文本发送时附加一次。

Alarm 是第一个 `plugin_id = "alarm"` 的 consumer，通过 `execute.call` 暴露 `alarm`、`list_alarm`、`delete_alarm`；它不直接发送 Telegram 文本：

1. `alarm` 要求 `target_user_id` 是当前 Invocation 可见的 Telegram **user** sender（sender_chat 与任意 ID 拒绝）、`summary` 为 1–500 字符、`datetime` 是带 `Z` 或显式 offset 的严格未来绝对时间且不超过 365 天；同一 Invocation 最多创建 3 个。
2. owner 是创建者而非 target。没有可靠 caller 时三个工具都 fail closed 为 `alarm_caller_not_available`；历史 `created_by_user_id IS NULL` 行不能被用户 list/delete，也不会把 target 回填为 owner。
3. Alarm 创建一个带 timer 的任务，冻结目标 mention 及预算豁免；到期结果是结构化 reminder 数据，不是预生成聊天文本。`list_alarm` 保留 waiting 或 completed+pending 的本人项目；`delete_alarm` 可取消 waiting Alarm 或尚未投递的 pending receipt。不存在、他人、已 claimed/已结算项目统一为 `alarm_not_found`。
4. Admin 继续以四态 Alarm 投影展示：waiting 或 completed+pending 为 pending、claimed 为 firing、handled 为 fired、取消任务或 suppressed 投递为 cancelled。completed+pending 仍可 list/cancel；claimed 不可单独取消。

## send Tool

`send` 是模型驱动的 Telegram 输出的唯一边界，支持以下形式；确定性的 Bot 命令回复不经过模型，见 [Bot Commands](#bot-commands)：

- 文本默认按纯文本发送；显式设置 `parse_mode: "MarkdownV2"` 时由 Telegram 按 MarkdownV2 解析。只提供 `text`（以及可选的 `reply_to_message_id`）时，`kind` 默认为 `text`。
- 配置允许且当前 Conversation Context 授权的 Sticker（`stk_` 引用）。
- 可选 Reply：模型传 `reply_to_message_id`，目标必须命中当前 Conversation Context 里仍在保留段内且未过期的 `reply:<telegram_message_id>` 引用。

发送前写 pending 审计并标记副作用边界。明确失败可按策略处理；网络中断后无法确认 Telegram 是否接收时记录 `outcome_unknown`，不能盲目重发。

- 运行已被 abort（`/pause`、`/cut_topic`、Admin 取消）或已过 Invocation deadline 时，`send` 在写 pending 审计之前直接拒绝：Tool Call 记为 `error`，错误码 `aborted` / `deadline_exceeded`，不写 `telegram_sends`、不调用 Telegram。
- Telegram 返回 429 时按 `retry_after` 等待后重试，等待超过 deadline 则不重试；等待期间 abort 记为 `error`/`aborted`。开启 send 屏障时，等待结束后会再判断一次屏障，命中则不重试，记为 `error`/`send_barrier`（此时已有 `telegram_sends` 行）。
- Telegram 已接受、但本地落库失败（例如写 `messages` 出错）时，Tool 仍向模型返回成功，避免模型重发；日志输出 `send_record_failed`（带 `telegram_message_id`），并尽量单独把 `tool_calls` / `telegram_sends` 标为 `success`。这种情况下该条外发消息可能不在 `messages` 里。

`agent.send_max_text_length` 配置了文本最大字符数（默认不限制）时，超长文本在进入发送前被拒绝：Tool Call 记为 `error`、错误码 `send_text_too_long`，不写 `telegram_sends`、不消耗窗口额度。

`agent.send_disallow_blank_lines` 开启（默认关闭）时，包含任何空行的文本同样在发送前被拒绝，错误码 `send_blank_lines`。

`agent.rate_limits.sends_per_window` / `window_seconds` 限制同一 Chat 在滑动窗口内的 `telegram_sends` 行数，不区分状态（失败的尝试同样消耗额度，否则失败重试的循环就没有刹车）；超出时 Tool Call 记为 `error`/`send_rate_limited`，不写 `telegram_sends`。这是长活 Invocation 取代 per-Invocation `max_sends` 的刹车。

### 一条消息对应一个话题

`send` 的 Tool 描述要求「一条消息对应一个话题」：同一批新消息里有多拨人在聊不相关的事情时，模型为每个它选择参与的话题各调用一次 `send`，并分别带上指向该话题内消息的 `reply_to_message_id`，而不是把不相关的内容合进一条消息。没话要说的话题可以不回；单个回答仍然不拆成多条。

这只是 Tool 描述层面的倾向，runtime 不做任何分线判断，也不强制 `reply_to_message_id`——话题归属完全由模型从消息头的 `re:N`、`uid:N` 与时间顺序自行推断，Forum Topic 隔离在这里不起作用（同一个 Topic 内部的多话题属于同一个 Conversation）。描述里原先有一句「repeated sends are rate limited per chat, so say what matters in one message instead of splitting it」，它反过来鼓励了合并，是群聊回复「串味」的成因之一，已经删掉：`sends_per_window` 本身足够宽松，不需要用它压制正常的分条回复。机制侧不需要改动，一轮内多次 `send` 本来就各自独立审计、独立计数、独立失败。

代价是群里会更容易连发若干条，从而更容易撞上 Telegram 自己的群聊发送速率限制；那只是多走一次既有的 429 `retry_after` 重试，不丢消息。

### send 屏障

`agent.send_barrier_enabled` 开启时，`send` 在所有输入校验都通过、即将写 pending 审计之前多做一次判断：模型组织回复期间，同一 Conversation 是否又开了 `collecting` Bucket。若有，就不发这条，而是：

1. 在同一事务里把这个 Bucket attach 进当前 Invocation（与到期 attach 同一个 `attachBucketToInvocation`：写 `invocation_buckets`、Bucket 置 `running`、按 `sequence_no` 续写 `invocation_messages` 快照），再 `queueInjection`。
2. 本次 Tool Call 记为 `error` / `send_barrier`，不写 `telegram_sends`、不消耗发送配额；Tool 结果告诉模型新消息紧随其后，请读完再决定发什么——两批延续同一个话题时可以一条消息同时回应，是不同话题则各发一条。
3. 该 turn 结束时，turn 边界上既有的 `injectPending` 把这批 steer 进去（它本身就是一个 checkpoint），模型在下一次调用里同时看到被拦的原因与新批次。

约束：

- **每轮至多拦一次**：`barrierSpent` 只在 Agent 空下来（`freeAgent`：该轮结束或运行结束）时重置，屏障自己触发的注入不重置它。所以群里一直有人说话时，第二次 `send` 照常发出，之后到达的消息按原规则等下一轮。
- 已排队、尚未注入的普通消息批次会拦下同一 turn 里之后的所有 `send`，直到模型读过它，不会出现「第一条被拦、第二条先发出去」。待注入的 receipt 不触发这个屏障；当前处于回执轮时也不因新用户消息拦下 `send`，避免把回执政策与普通批次混合。
- 运行处于收尾（`context_stop_ratio` 的 send-only 轮，或已 `beginClosing`）时屏障放行：收尾之后不再注入，拦下只会丢掉这次回复。已 attach 未注入的批次按原规则在运行结束时由 `releaseUninjectedBuckets` 重新排队。
- 只看已开 Bucket 的消息：被参与闸门拦下、其他 Bot 的消息、不开桶的单独 Sticker 都不会触发屏障。
- 触发时日志输出 `send_barrier`（`invocation_id`、`bucket_id`、`conversation_id`、`chat_id`）。

成功发送后：

- `tool_calls` 记为 success。
- `telegram_sends` 保存 Telegram 返回 ID/时间。
- 发送内容写入可见消息历史。
- Agent 的私有 Assistant 文本仍不进入 Telegram。

## `web_fetch`

`web_fetch` 是经 `execute.call` 调用的内部能力，接受模型生成的单个 URL，只执行无 Cookie、无认证 Header 的 HTTP(S) GET。它只允许协议默认端口，最多跟随 3 次跳转；每一跳都重新解析并校验目标，连接固定到已经校验的 IP，防止 DNS rebinding。

直接提交的环回、私网、链路本地、文档与保留地址会被拒绝；IPv4 映射地址（`::ffff:0:0/96`）靠「IPv6 只放行 `2000::/3`」拦截，不能写进 `BlockList`——Node 的 `BlockList` 会拿 IPv4 查询去匹配该 IPv6 规则，结果拒绝所有 IPv4 地址；嵌入 IPv4 目标的 IPv6 过渡地址（6to4 的 `2002::/16`、Teredo 的 `2001::/32`）同样拒绝，否则有对应隧道路由的主机会绕过 IPv4 黑名单。域名解析到 `198.18.0.0/15` 默认拒绝：任何人都能把自己的域名解析到这个网段，所在网络恰好路由它时就是 SSRF。只有使用 fake-ip 代理（Clash、Surge 等把所有域名解析到该网段）的部署才应设置 `web_fetch.allow_proxy_synthetic_addresses: true`，此时也只放行「域名解析结果」，模型直接提交该网段 IP 仍会被拒绝。`web_fetch.dangerously_allow_all_ip_addresses: true` 跳过以上全部地址校验（含 IP 字面量与跳转目标），Tool 描述随之告知模型可访问私网；端口、协议、凭据、跳转次数与响应类型限制不变。

Tool 只返回文本、JSON、XML 或 JavaScript 响应，拒绝压缩和二进制内容。默认 `Accept` 以 `text/markdown` 优先（`web_fetch.accept_markdown`，缺省开启；`raw: true` 时不声明），站点返回 `text/markdown` 时原样返回并加 `Format: Markdown served by the site` 行，`details.format` 记为 `markdown`。`text/html` 与 `application/xhtml+xml` 默认读取最多 2 MiB HTML，经 [Defuddle](https://github.com/kepano/defuddle) 抽取正文并转成 Markdown（去掉图片，Header 附 `Format` 与 `Title` 行）；模型传 `raw: true` 才返回原始 HTML，其他类型原样返回。转换固定 `useAsync: false` 并注入拒绝所有请求的 `fetch`：Defuddle 默认会为 YouTube、X、Bilibili 等页面调用第三方 API，那些请求绕过上面的地址校验与审计。转换是同步 CPU 工作，2 MiB 上限同时约束它阻塞事件循环的时长；转换失败返回 `conversion_failed`，不隐式回退原文。复杂解析（JS 渲染、登录页等）不在本 Tool 范围，交给用户自接的 MCP。单次调用最多 15 秒、结果最多 32 KiB；结果前缀明确标记网页为不可信数据。调用参数、结果、耗时和失败码写入 `tool_calls`，`side_effect = false`。

## 用户图片模型分流

当 `agent` 模型支持 image 时，`new` 区段的 Photo 与受支持的图片 Document 随冻结 Context 直接送入主模型，不经过 `read_image` 或独立 `vision` 模型；历史区段的图片只保留 `image_ref`，模型可用 `read_image` 按需查看，避免旧图占用输入或分散注意力。Telegram Photo 只保留最高分辨率变体，避免同一照片重复占用模型输入。

当 `agent` 模型只有 text 输入时，所有普通图片不附到主模型请求，而是在 Context 中保留按 Conversation Context 授权、带 TTL 的 `image_ref`（`img_`，见[引用生命周期](#引用capability生命周期)）。Agent 可按需调用 `read_image`，由独立 `vision` 模型返回文字描述。普通图片分析继续按 `file_unique_id + analysis_version` 缓存，随在线保留窗口（`retention.online_days`）清理。

直传图片在首次 Agent 请求前下载到 `paths.media_cache` 临时目录，并执行下载大小、真实格式、像素数、EXIF 移除、最大边长与标准化输出大小限制；请求载荷完成构造后立即删除临时文件。下载或校验失败会使 Invocation 失败，不会把缺失图片伪装成成功。

## Image 生成

图片生成把「Agent 提交意图 → 后台生成 → 回执注入 → `send` 交付」拆成两个模型回合，全部经由既有机制，没有第二条投递路径：

- **工具挂载**：`image_generate` 是内置插件（`src/plugins/image/`）经 `execute` 暴露的内部能力，不是 MCP，也不在四个 runtime 原语里。图片功能禁用（`image` 段缺失、被剥离或刚被删除）时该能力与 `image-generation` 技能都不会出现在 Agent 的工具注册表与 Skill 索引里——技能索引按 `skillVisibility` 过滤，模型不会看到「存在但不可用」的图片工具。
- **输入授权**：`input_image_refs` 只接受本 Conversation Context 授权的 `img_` 引用（经 `resolveMedia` 解析为真实 Media ID），任意 file ID、URL 或其它会话的引用在提交前就被拒绝并审计（`image_input_ref_unauthorized`）。
- **提交与幂等**：bridge 以 actor `agent:<conversationId>` 向 image core 提交生成意图（idempotency key 绑定 Conversation），同一 Conversation 内同内容重复提交返回既有 generation（`replayed: true`），不重复计费；每个 Invocation 最多 3 次提交。工具立即返回 `generation_id`，图片此时还不存在。
- **回执**：生成落定（成功、部分成功、失败、重启后由 `reconcile` 对账）时，bridge 经 long task 完成对应任务，Scheduler 把任务完成回执作为消息注入原 Conversation——回执是**不可信数据**（`generation_id`、status、输出清单），与 Alarm 回执同一通道。进程重启不影响未完成生成：启动时 reconcile 重建 core 状态，晚到的结果照常投递，不会重复回执。
- **交付**：模型回执后用 `send kind:"image"` + `image_generation_id` 交付。运行时按「该 generation 的 actor 是否就是本 Conversation」解析输出（`sendableOutputs`，跨 Conversation 引用拒绝），一次 send 把该 generation 的全部已完成输出作为一个相册发送（单图 sendPhoto，2 张以上 sendMediaGroup），并审计 `telegram_sends.kind='image'`、bot 消息与生成的 `media` 行，纳入 canonical history 与引用 TTL。模型不能发送它没有在本会话收到过 `generation_id` 的生成，也不能只发送部分输出。
- **失败语义**：失败/中断的轮次同样完成任务（回执带失败状态）；模型用自己的话解释失败，重试是新的 `image_generate` 提交，未送达的输出没有隐藏重发路径。

配置段（模型、凭据、能力契约、热更新、软降级）见 [configuration.md](configuration.md#image-生成)；Admin 三页与启用开关见 [admin-panel.md](admin-panel.md#api)。

## `read_image`

`read_image` 是经 `execute.call` 调用的内部能力。模型只能使用 Context 中展示的不透明 `image_ref`。多模态 Agent 获得 Sticker 与历史区段 Photo/图片 Document 的引用；新消息中的普通图片直传主模型，不再保留对应 `read_image` 引用。text-only Agent 获得所有可见区段中 Sticker、Photo 与图片 Document 的引用。Tool 不接受原始 Telegram file ID、任意 URL 或任意 Media ID。

处理流程：

1. 校验 capability、Invocation deadline 与全局 agent 每日 Token 预算。
2. 从 Telegram 下载到 `paths.media_cache` 下的临时目录。
3. 检查下载大小、图片格式、像素数和标准化输出大小。
4. 提取 Sticker 代表帧。
5. 调用 Vision 模型并审计 Token/图片预算。分析开始时取一次当前配置快照：这一份的 vision 模型与缓存版本在整次分析里不变，运行期间发布的换模型不会改变这次分析的结果。
6. 按 `file_unique_id + analysis_version` 缓存，`analysis_version = <provider>/<model>/prompt-<prompt_version>`：换 vision 模型或 prompt 版本后旧行不会被命中。
7. 删除临时文件。

Sticker 代表帧：

- Telegram thumbnail 优先。
- 静态 WEBP 直接标准化。
- 视频 WEBM 使用 FFprobe 获取时长、FFmpeg 提取中间帧。两者都固定 `-f matroska -protocol_whitelist file`：`is_video` 只是元数据，不能说明文件内容；如果放开格式探测，伪装成视频的播放列表（HLS）或 concat 文件会让 FFmpeg 以服务身份读取其他本地文件或访问网络。不是 Matroska/WebM 的内容直接失败。
- 动画 TGS 使用 python-lottie 导出指定中间帧 SVG，再由 Sharp 标准化。读取帧范围之前先在进程内解压，解压结果上限 8 MiB（`maxOutputLength`），超过即失败，不会调用转换器：20 MB 的下载上限挡不住 gzip 炸弹，而 `gunzipSync` 会在事件循环上同步展开它。

Sticker 视觉元数据通过严格 Tool Call 返回：中文描述、情绪、动作、中英文标签。不要改回“提示模型输出 JSON 后直接 `JSON.parse`”；Provider 可能返回 Markdown code fence，曾导致真实 `read_image` 失败。

## Sticker 搜索与后台索引

启动时 `StickerService.sync` 拉取配置中的完整 Set：

- Set/Sticker 元数据写入 SQLite。
- 新增或版本变化的 Sticker 进入索引队列。
- 后台固定单并发，前台 Sticker `read_image` 优先。
- 分析成功后更新 `sticker_search` FTS5 trigram 索引。
- 失败记录次数与 `next_retry_at`，避免热循环。

`search_stickers`（经 `execute.call` 调用）支持语义查询，也支持一次解析最多 5 个目录 `sticker_id`；两种方式都只返回已允许、已成功索引的 Sticker，并生成当前 Conversation Context 的 `sticker_ref`（带 TTL，历史里引用过也仍然有效）。目录 ID 与 Telegram file ID 都不能直接发送，`send` 只接受 `search_stickers` 返回的 capability；`execute.call` 的结果封套会在 `refs.sticker_ref` 中同时列出这些授权 token。

## Bot Commands

`/pause`、`/resume`、`/status` 与 `/model` 是 Chat 级控制命令，作用于发送命令的 Chat（含 Forum 全部 Topic），不按 Topic 隔离——`/model` 读写的就是该 Chat 的模型覆盖，Topic 共用 Chat 设置。`/cut_topic` 是 Conversation 级命令：切点与 Context 清空都只作用于命令所在的 Topic。`/allowlist` 把命令所在的 Chat 追加进 `telegram.chats` 白名单。

- 判定：`message.entities` 中 offset 为 0 的 `bot_command`；命令名大小写不敏感；带 `@用户名` 后缀时必须匹配当前 Bot；Bot 发送者的消息不触发命令。未知命令与非命令消息照常入库。
- 启动时（`getMe` 后）调用 `setMyCommands` 自动注册 `/pause`、`/resume`、`/status`、`/model`、`/cut_topic`、`/whoami`、`/allowlist`、`/ignoreme`、`/unignoreme` 及中文描述（`BOT_COMMANDS` 是唯一事实来源，注册前校验每个命令都能被 `parseBotCommand` 解析）；注册失败只记 `command_registration_failed`，不阻塞启动——命令菜单是便利设施，文本解析不依赖它。
- 命令消息只写 `telegram_updates` 审计，不写入 `messages`，因此不会创建 Bucket 或进入 Agent 历史。`parseBotCommand` 返回的命令附带 `messageId`（命令消息自身的 Telegram message ID）与 `threadId`（命令所在 Forum Topic），供 `/cut_topic` 记录切点并定位要清空的 Conversation Context。`threadId` 与入库共用 `conversationThreadId` 规则：只有 forum supergroup 的 topic 消息才取 `message_thread_id`，其余一律视为 thread 0，包括私聊（开启话题模式后消息会带 `message_thread_id`）和普通 supergroup 里 Reply 链自带的 `message_thread_id`。两边规则不一致时，带这类 thread id 的 `/cut_topic` 会找不到 Conversation、只写切点不清 Context，却仍回复「已清空」。
- 回复是确定性 Bot 输出（不经模型），直接通过 Bot API 发送并 Reply 原命令消息，不经过 `send` Tool；发送失败只记 `command_reply_failed` 事件，不重试。

`/pause` 与 `/resume` 仅对 Bot 管理员开放（`telegram.admins` 配置，见下文）；`/status` 对任何成员开放。`/whoami` 同样对任何成员开放：回复发送者的 Telegram 数字 ID，发送者身份无法识别（`message.from` 缺失）时回复「无法识别发送者。」。非管理员或匿名身份执行受限命令会收到拒绝回复，不产生任何状态变更。

`/ignoreme`、`/unignoreme` 对任何可识别的个人账号开放，无需管理员权限：在当前 Chat 的 `ignored_user_ids` 中加入/移除发送者自己的 `message.from.id`，参数和 Reply 不会指定其他用户。作用范围是整个 Chat（含全部 Forum Topic）；迁移群写回迁移前配置条目。两者写回 `config.jsonc` 并立即热应用，重启后仍保留；已忽略用户仍可使用这两个命令，其他命令继续被丢弃。Chat/Topic allowlist、Bot 发送者、编辑和启动追赶仍按原有边界处理，不会靠自助命令越过。匿名 `sender_chat` 或无法识别发送者时不能改名单。

自助命令与其它配置写入共用 `ConfigReloader` 锁：在锁内读最新文件、按 Chat ID 定位列表并只增删自己的 ID，并发成员不会覆盖彼此或其它 Chat；重复请求不重写文件，但仍重新应用文件，可恢复之前已保存但应用失败的变化。应用也会带上文件中其它热字段并报告待重启项。文件写入失败时配置保持不变；写入成功而应用失败时明确回复「已写入 config.jsonc，但应用失败: …」，进程继续使用旧配置。已有历史与运行中模型已收到的消息不会追溯删除。

`/allowlist` 同样仅限管理员，是唯一能在**未列入白名单的 Chat** 里生效的命令：ingestion 在按 allowlist 拒绝 Update 之前单独放行「管理员发送的 `/allowlist`」（其余命令与普通消息在未允许 Chat 一律照旧拒绝，Bot 不回复陌生人），因此管理员把 Bot 拉进新群后可以直接用它开白。命令把 `{ id }` 追加进 `config.jsonc` 的 `telegram.chats` 并热应用（新增 Chat 是热变更，ingestion 白名单与参与策略注册表按发布代数重建，无需重启）；已配置的 Chat 回复「本群已在白名单中」。命令消息本身不进入消息流，该 Chat 的正常入库从下一条普通消息开始。删除 Chat、修改 Topic 范围仍是 restart，见 [configuration.md](configuration.md#运行时配置热更新)。

`/model` 同样仅限管理员，在当前 Chat 上运行时切换 agent 模型（与 Admin Panel「Models」页共享同一 `AgentModelSwitcher` 与 `ConfigReloader`，但只写当前 Chat 的 `telegram.chats[<id>]` 覆盖，不碰全局 `agent.*`；全局切换仍走 Admin `PUT /api/model` 或配置文件）：`/model` 按每页 20 条列出该 Chat 生效的模型与思考强度（未覆盖的项标注「继承全局」）与第一页可切换序号；`/model page 页码` 翻页，所有页面保留全局序号；`/model 纯数字序号` 把序号对应的 `provider` / `model` 写入 `config.jsonc` 中该 Chat 的覆盖，同时把该 Chat 的 `thinking_level` 重置为目标模型接受的最弱级别，再重新加载配置，成功回复「已为本群切换: …，已写入 config.jsonc，将在下一次 agent session 生效。」与「思考强度已重置为该模型最弱的一档: <级别>」两行，因此重启后仍然生效。`/model default` 删除该 Chat 的 `provider`/`model`/`thinking_level` 三项覆盖，恢复继承全局；文件中已无覆盖时不重写文件，但仍应用文件里的其它热更新并报告待重启项。写入与加载共用同一把锁，两个并发切换不会交错；配置文件是符号链接、权限不允许或写后校验失败时回复错误，文件与当前配置都不变；文件已写入但应用失败时回复「已写入 config.jsonc，但应用失败: …」。越界页码、无效参数与 `/model reset` 都按无效序号处理。切换只对该 Chat 后续启动的 Invocation 生效，不影响进行中的会话；清单与语义见 [configuration.md](configuration.md#运行时配置热更新)。

`/pause` 立即生效（与 scheduler 同一事件循环，无竞态）：

1. 写入 `chat_pause`（chat_id 为内部 `chats.id`）。
2. 该 Chat 所有 `collecting`/`queued` Bucket 置为 `expired`、`error_code = chat_paused`；对应 `queued` Invocation 置为 `aborted`、`completion_reason = chat_paused`。
3. Scheduler 中止该 Chat 正在运行的 Invocation（`pauseChat`），包括正处于空闲等待（等待下一个 Bucket）的长活 Invocation；正在飞行中的 `send` 可能已经落盘，属正常结果。

暂停期间消息仍入库并保留 Revision，但不创建 Bucket、不启动会话；`processDue` 与启动追赶也会跳过暂停 Chat（追赶 Bucket 记 `skipped_budget`/`chat_paused`）。`/resume` 删除 `chat_pause` 行，恢复正常节拍。

`/status` 返回当前 Chat 生效的模型与思考强度（`本群模型: provider / model`、`思考强度: 级别`，未覆盖的项带「（继承全局）」标记；Admin Panel 的全局热切换与该 Chat 自己的 `/model` 覆盖都反映在生效值里）、本 Chat 的当日 `model_tokens` 用量，以及全局当日用量、`agent.daily_budget.max_tokens` 上限与四舍五入到两位小数的用量百分比；所有 token 数量使用千位分隔符。随后按该 Chat 的 Model Call 审计拆分显示 `读取`、`写入`、`缓存读取`、`缓存写入`，四项之和即上面的本群用量。日期口径均为 UTC；暂停中额外显示一行。每个 Conversation 再追加一行 Context 状态（保留消息数、保留窗口内的 `send` 数、`head_seq`、上次 GC 时间，尚未建立时显示 `Context: 尚未建立`）。配置了 `participation` 的 Chat 再多一行互动状态：`互动: 活跃时段内`、`互动: 注意力窗口至 <UTC ISO>` 或 `互动: 静默（仅 @、Reply 或关键词触发）`；暂停时只显示 `互动: 已暂停`。

`/cut_topic` 仅对 Bot 管理员开放，用于在群聊上下文被旧话题污染时手动切断历史：

1. 把命令消息自身的 Telegram message ID 写入 `conversation_context_cutoffs`（每 Conversation 一行，即 Chat + Forum Topic；重复执行只会前移切点，更旧的命令不会把切点往回挪）。Forum 中切一个 Topic 不影响同群其他 Topic 的 history。该 Topic 还没有任何入库消息时（没有 Conversation 行）不写切点，因为没有可切的历史。
2. 之后新建的 Invocation 在冻结 history 快照时排除 `telegram_message_id <= 切点` 的消息，命令消息本身也在切点上，因此不会进入下一个会话的上下文。
3. 先中断该 Conversation 正在运行的 Invocation（`BucketScheduler.abortConversation`，abort reason `context_cut`），再清空 canonical history（`head_seq` 推进到 `next_seq`、`context_refs` 全删），并驱逐进程内的 Agent 缓存。三步都必要：运行中的那次调用把切点前的 transcript 和一份运行开始时的 `head_seq` 快照都留在内存里，不中断它就会继续按被切掉的历史回答，还可能把这份更旧的 `head_seq` 写回去覆盖切点。
4. 不删除任何消息、Revision 或已淘汰的 Context 行（只软标记）；被切 Conversation 之外的已排队/运行中 Invocation 不受影响，启动追赶的 `new` 消息也不受影响。

## Bot 管理员列表

`/pause`、`/resume`、`/model`、`/cut_topic`、`/allowlist` 的白名单是配置文件里的 `telegram.admins`（Telegram User ID 数组），Bot 全局共享，它是唯一事实源：

- 旧版 `bot_admins` 表已删除（迁移 `026_drop_bot_admins.sql`）；旧表内容用 `scripts/migrate-admins.ts` 搬进配置（须在升级启动前运行）。
- 权限判定在 `BotCommandService`：命令发送者的 `message.from.id` 命中运行中配置的 `telegram.admins` 才放行；`sender_chat` 匿名身份一律拒绝。
- `telegram.admins` 在热更新白名单里（见 [configuration.md](configuration.md#运行时配置热更新)）：Admin「应用配置文件」或 Bot admins 页面的增删都会热应用，下一次命令执行就用新列表，无需重启；面板的增删是配置写端点（If-Match revision），写的就是这一字段。

## 常见排查顺序

1. `check-config` 输出是否为预期哈希。
2. `serve_started.config_hash` 是否一致。
3. `telegram_updates.allowed/rejection_reason`。
4. Bucket 与 Invocation 是否进入终态。
5. `model_calls` 是否 success，Token 是否计入。
6. `tool_calls` 与 `telegram_sends` 是否 success/outcome_unknown。
7. 媒体问题检查 `media_analyses` 和对应 Vision `model_calls`。

一次自然语言回复看似成功，不代表内部 Tool 都成功；必须以审计表为准。
