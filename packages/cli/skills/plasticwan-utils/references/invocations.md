# Invocation 查询与审计

## 定位并读取 Invocation

用户给出精确 ID 时直接 `get`；否则先以 Chat、时间线索查小页，再按返回的游标查下一页。以下 ID 仅为示例，执行前替换为实际目标：

```bash
plasticwan-utils invocation list --limit 20 --chat -1001234567890 --json
plasticwan-utils invocation list --limit 20 --chat -1001234567890 --cursor 12345 --json
plasticwan-utils invocation get 12345 --json
```

- list 返回 `{ items, next_cursor }`，按 ID 倒序；仅在 `next_cursor` 非 null 且确有需要时继续，保留原过滤条件。可加 `--state failed`；不要为排查未回复只筛 `completed`。
- Chat ID 是 Telegram Chat ID，不是内部数据库 ID。把 Invocation、Chat、游标等十进制 ID 当精确字符串处理，不经过 JavaScript `Number` 转换。
- 不存在按时间或 Topic 的 CLI 过滤参数；在返回项的时间戳、`chat.message_thread_id` 中核对。多个候选不能区分时先确认目标，不批量导出所有详情。
- `get` 返回 Invocation 详情对象。空列表、404 或缺失记录不等于模型选择沉默；说明查询范围、过滤条件和留存限制。
- list/get 默认超时 30 秒；`--timeout-ms` 只改客户端等待上限。遇到 `unauthenticated` / `forbidden` 请操作员检查 key、撤销状态和授权范围；不换接口绕过认证。`response_too_large` 表示超过 4 MiB 客户端上限，不能把不可读取写成无记录，也不绕过限制批量抓取。

## 建立审计证据链

按顺序检查下列字段，区分“模型没发送”“尝试发送但失败”“已真实发送”：

| 证据 | 检查内容 |
| --- | --- |
| Invocation 状态 | `id`、`chat`、时间戳、`state`、`completion_reason`、`error_code`；预算计数 `turns_used/tool_calls_used/sends_used` 仅作辅助 |
| 模型调用 | `model_calls[]` 的 `id/role/provider/model/attempt/state/error_code/error_detail`；查看失败或重试是否发生在 agent 调用，勿混入视觉调用 |
| 可用工具与输入 | `model_calls[].tools`、`tool_registry`、`context_messages[]`；按需解析 `request_json/response_json/snapshot_json`，缺失或 null 就标记无法核对 |
| 工具执行 | `tool_calls[]` 的 `id/tool_call_id/tool_name/state/error_code`；按需检查 `arguments_json/result_text`，不要只看到调用就判成功 |
| Telegram 发送 | `telegram_sends[]` 的 `tool_call_id/state/telegram_message_id/error_code`，关联同一工具调用；`agent_messages[]` 不是发送记录，普通 Assistant 文本不会直接发布 |
| 发送提醒与阻拦 | 检查 `agent_messages[].role = harness_nudge` 及其后调用和发送状态，可报告“提醒后仍未成功发送”，不猜测模型意图；`tool_calls[].error_code = send_barrier` 表示生产发送被新消息闸门拦下，不是 Telegram 故障 |
| 用量 | `total_tokens/total_cost` 与逐次 `model_calls[]`，注明缺失成本是未知而非零；不重复加总已含缓存计数的 token 总量 |

引用具体 ID、字段路径和状态支撑结论。`request_json/response_json` 可能因未开启录制或后续清理而为空；不能据此捏造模型看到了什么，也不能仅凭它们判断 replay 快照是否存在。

## 报告后停止

报告采用：**目标 → 观察到的事实 → 推断及置信度 → 缺失证据 → 最小下一步**。仅有“没有成功发送”证据时，不把它写成“模型主动沉默”。

审计完成后默认停止，不为补充证据自动调用 replay。用户明确请求重放时，先按 Skill 入口加载重放指南并核对授权范围；查询授权不包含计费模型调用。
