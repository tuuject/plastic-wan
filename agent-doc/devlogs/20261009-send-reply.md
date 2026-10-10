# Plastic Wan - 20261009 send_reply：一次回复按顺序连发几条

## 背景

`send` 一次只发一条消息，工具描述还要求「单个回答不拆成多条」。于是先发一张 Sticker 再接一句话、先发生成的图再讲解，或者把一段中等长度的回答拆成几句短消息，都只能靠模型连续调用多次 `send`。这样做有三个问题：

- 每次 `send` 之间要多一轮模型调用。
- 发送屏障可能在第一条发出后拦下第二条，一次回复被切成两半。
- 后面某条的参数如果有错，要等前面几条已经发出去才会暴露。

本次新增原语 `send_reply`：模型一次给出按顺序排列的 2–4 条消息，由 runtime 统一检查后依次发出。它不是第二条发送通道，每一条都走原有的 `send` 管线。

## 主要变更

### 1. 一条发送管线，两个工具

[src/capabilities/send-tool.ts:263](../../src/capabilities/send-tool.ts#L263) 的 `createSendTools` 把原来 `send` 的执行体提成内部的 `deliver`（[:280](../../src/capabilities/send-tool.ts#L280)），并同时返回 `send` 与 `send_reply`。两个工具共用同一份完成回执 @ 提及状态，所以无论哪个工具先发文字，同一任务都只提及一次。

`createSendTool` 保留为只取 `send` 的薄包装，供只需要 `send` 的调用方使用。

`deliver` 新增 `barrier` 选项，控制本次发送是否检查发送屏障（[:446](../../src/capabilities/send-tool.ts#L446)、[:590](../../src/capabilities/send-tool.ts#L590)）：

- `send` 每次都检查。
- `send_reply` 只在第一条检查。

### 2. send_reply：先全部检查，再逐条发送

Schema 见 [src/capabilities/send-tool.ts:44](../../src/capabilities/send-tool.ts#L44)：

- `parts` 的每一项使用与 `send` 相同的内容字段，但不能带 `reply_to_message_id`。
- 顶层 `reply_to_message_id` 只挂在第一条上。
- 条数为 2–4（`SEND_REPLY_MAX_PARTS`）。工具 Schema 的 `minimal` 关键字模式会去掉 `minItems`/`maxItems`，所以执行时再检查一次条数。

[createSendReplyTool](../../src/capabilities/send-tool.ts#L702) 在发出第一条之前检查以下各项：

- 每条的 kind 与字段是否匹配。
- Reply 目标是否可见。
- 文本长度与空行配置。
- Sticker 引用是否授权。
- 图片 generation 是否属于本 Conversation 且有成品，图片说明长度是否合规。
- 运行是否已 abort 或超过 deadline。
- 本 Chat 滑动窗口的剩余额度是否容得下全部条数。

任一项不通过，只写一条 `tool_name = 'send_reply'` 的错误审计，不写 `telegram_sends`、不调用 Telegram、不消耗额度。

检查通过后，第 n 条以 `<tool_call_id>:<n>` 调用 `deliver`。因此每条消息照常有自己的 `send` 审计行、`telegram_sends` 行和可见历史，也照常经过限流计数、429 重试和同一消息只回复一次的守卫。外层 `send_reply` 行记录整次调用的结果：

- 成功时，`result_text` 为 `telegram_message_ids=…`。
- 中途失败时：
  - 停在失败的那一条，后面的条目不再尝试，前面已发出的消息保留。
  - 外层行的错误码取自失败那条的审计行，并记下已发出的 message ID。
  - Tool 结果向模型列出已发出的消息，要求不要重发。

### 3. Runtime 把 send_reply 当作发送工具

[src/capabilities/send-tool.ts:39](../../src/capabilities/send-tool.ts#L39) 的 `SEND_TOOL_NAMES` 在 [src/orchestration/agent-runtime.ts](../../src/orchestration/agent-runtime.ts) 的三处使用：

- **收尾轮工具**：context 接近上限时，收尾轮除 `zzz` 外同时保留 `send` 与 `send_reply`（[:794](../../src/orchestration/agent-runtime.ts#L794)）。
- **send nudge**：调用过 `send_reply` 也算已发言，不会再触发提醒（[:937](../../src/orchestration/agent-runtime.ts#L937)）。
- **Context 计数**：成功的 `send_reply` 在 canonical history 中算一次发送，它的 toolResult 带 `send_seq`（[:1147](../../src/orchestration/agent-runtime.ts#L1147)）。GC 的保留窗口仍按「回复次数」计算，不会因为一次回复拆成几条就更快丢弃历史。

`execute` 也把 `send_reply` 列为原语和有副作用的工具，不能经 `execute.call` 间接调用。

### 4. Prompt 与 Tool 描述

- [src/platform/agent-protocol.ts:15](../../src/platform/agent-protocol.ts#L15) 说明：适合连发几条时用一次 `send_reply`。
- `send` 的描述从「不要把一个回答拆成多条」改为「不要拆成多次 `send`，需要连发时用 `send_reply`」。
- 「一个话题一条消息、不同话题各自 `send`」的规则不变。`send_reply` 的描述明确禁止用它合并不同话题。

### 5. Scene 重放

[src/orchestration/replay-tools.ts:274](../../src/orchestration/replay-tools.ts#L274) 为 `send_reply` 提供合成执行器，规则与生产环境一致：

- 先按当前配置检查全部条目。
- 每条生成一个 `send` 输出（`<id>:<n>`）。
- 第一条受场景内同一消息只回复一次的约束。

默认注册表同时展示 `send_reply` 的定义，不再按未知工具拦截。

## 数据库与配置

- 没有迁移。`tool_calls` 多了一种 `tool_name = 'send_reply'` 的外层行；每一条消息仍以 `tool_name = 'send'` 记录，`telegram_sends.kind` 的取值不变。
- 没有新配置项。`send_reply` 对所有部署默认开启，条数上限是代码常量；现有的 `send_max_text_length`、`send_disallow_blank_lines`、`allow_reply_message_multiple_times` 与 `rate_limits` 照常作用于每一条。
- 工具注册表新增一项，`tool_registry_hash` 会随之变化。

## 验证

- `test/send-reply.test.ts` 覆盖以下行为：
  - 按顺序发送，只有第一条带 Reply。
  - 外层与每条消息的审计行、`telegram_sends`、`sends_used` 与 bot 消息记录。
  - 后面某条无效时整次不发：Sticker 引用未授权、字段与 kind 不匹配、generation 不可用。
  - 限流额度不足时整次拒绝。
  - 发送屏障只检查第一条。
  - 中途 Telegram 400：保留已发出的消息，后面的条目不再尝试。
  - 同一消息只回复一次的守卫作用于第一条。
- `test/agent-runtime.test.ts` 用 faux 模型调用 `send_reply`，验证以下结果：
  - 两条消息按顺序发出。
  - 调用 `send_reply` 后不触发 send nudge。
  - `conversation_contexts.send_count_total = 1`，只有一行 toolResult 带 `send_seq`。
- `test/replay-tools.test.ts` 覆盖重放合成、提前拒绝与场景内的 Reply 去重。
- 其他断言工具列表的测试已同步加入 `send_reply`。
