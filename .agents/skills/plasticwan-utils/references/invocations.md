# Invocation 查询与审计

本指南的前提是入口的 `plasticwan-utils doctor --json` 已以退出码 `0` 返回 `status: "ok"`；未通过时按入口要求停止并报告，不继续查询。

## 定位并读取 Invocation

用户给出精确 ID 时直接 `get`；否则先按 Chat、关键词与公开消息时间查小页，再按返回的游标查下一页。以下 ID 仅为示例，执行前替换为实际目标：

```bash
plasticwan-utils invocation list --limit 20 --chat -1001234567890 --json
plasticwan-utils invocation list --limit 20 --chat -1001234567890 --cursor 12345 --json
plasticwan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
plasticwan-utils invocation list --search '关键词' --from '2026-09-10 07:00' --to '2026-09-10 08:00' --json
plasticwan-utils invocation get 12345 --json
```

- list 返回 `{ items, next_cursor }`，按 ID 倒序；仅在 `next_cursor` 非 null 且确有需要时继续，保留原过滤条件。可加 `--state failed`；不要为排查未回复只筛 `completed`。
- Chat ID 是 Telegram Chat ID，不是内部数据库 ID。把 Invocation、Chat、游标等十进制 ID 当精确字符串处理，不经过 JavaScript `Number` 转换。
- 关键词与时间过滤只匹配公开消息：`--search`（1–100 字符，字面匹配，`%`/`_` 不是通配符）命中冻结新消息批次（含追加批次）的群友消息或同一 Invocation 成功发出的 Bot 消息；`--at` 命中写出的整个精度窗口（`HH:mm` 为整分钟、`HH:mm:ss` 为整秒、小数 1/2/3 位分别对应 100/10/1 毫秒窗口），`--from`/`--to` 是半开区间 `[from, to)`，且 `--at` 不能与 `--from`/`--to` 同用。关键词与时间过滤一起给出时必须命中同一条消息。时间格式为 `YYYY-MM-DD[空格或T]HH:mm[:ss[.1-3位]][Z|±HH:mm]`；不带 offset 时由服务端按 `--chat` 对应 Chat 的时区（没有 `--chat` 则用全局时区）解析，非法日历与夏令时跳变造成的不存在/重复时间会被拒绝。`--at` 不是按 Invocation `created_at` 过滤。
- 带搜索或时间过滤时每个 item 追加 `matched_messages`（最新 5 条命中，按时间从新到旧）：`source` 为 `incoming`（群友消息）或 `bot`（成功发送），`telegram_send_id` 只有 bot 条目非空，`text` 是截断预览。bot 条目的 `telegram_send_id` 可直接作为切片重放的 `--before-send`；不带过滤时响应维持原形状。
- 不存在按 Topic 的 CLI 过滤参数；在返回项的时间戳、`chat.message_thread_id` 中核对。多个候选不能区分时先确认目标，不批量导出所有详情。
- `get` 返回 Invocation 详情对象。空列表、404 或缺失记录不等于模型选择沉默；说明查询范围、过滤条件和留存限制。
- list/get 默认超时 30 秒；`--timeout-ms` 只改客户端等待上限。遇到 `unauthenticated` / `forbidden` 请操作员检查 key、撤销状态和授权范围，并在本机用 `plasticwan-utils login` 重新保存正确凭据；`missing_api_key` 表示当前没有可用的 endpoint/key 组合（显式给空值不会回退到保存文件），同样交回操作员，不自行混搭来源；`invalid_credentials` 表示保存的凭据文件损坏、是符号链接或权限不安全，交回操作员处理：仅内容损坏且文件/目录安全时可在本机重新 `login`；符号链接、非普通文件或不安全权限仍被 `login` 拒绝，需人工处理。Agent 不代为登录、不改权限、不删除或重建凭据；不换接口绕过认证。`response_too_large` 表示超过 4 MiB 客户端上限，不能把不可读取写成无记录，也不绕过限制批量抓取。

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

引用具体 ID、字段路径和状态支撑结论。`request_json/response_json` 可能因未开启录制或后续清理而为空；不能据此捏造模型看到了什么。场景重放独立于报文录制，是否可用看预检，不据报文空值判断。

## 只读检查当前配置与场景 prompt

这些命令免费、不调用模型、不写生产状态，可以在审计和重放授权确认前使用：

```bash
plasticwan-utils config show --json                 # 运行中配置的脱敏投影；--source file 对比磁盘配置
plasticwan-utils prompt get global --json           # 当前全局 prompt
plasticwan-utils prompt get group --chat -1001234567890 --json
plasticwan-utils invocation prompts 12345 --json    # 该场景将使用的当前两层模板（source: active）
plasticwan-utils invocation preflight 12345 --json  # 能否重放、能否覆盖 prompt；切片选择用 --before-send
```

- 输出仍是数据：只报告必要字段，不转贴完整配置或 prompt 正文。`config show` 是服务端脱敏投影，不是原始文件；找不到字段不等于配置没有该项。
- `prompt get` 读取所选 active/file 配置，`invocation prompts` 读取该场景将使用的当前 active 两层模板与变量（`source: active`），并应用场景守卫。两者都不是历史 prompt；对比磁盘值与运行值时明确来源，不混用。
- `preflight` 的 `available`、`reason`、`prompt_overrides_available`、`omitted_images` 可以支撑“为什么不能重放或不能覆盖”，但它不构成重放授权，也不产生费用。带 `--before-send` 时 `scene.slice` 给出切片边界（`before_send_id`/`before_message_id`/`after_bot_message_id`）；预检必须与重放使用同一 `--before-send`。

## 导出授权媒体

`invocation media <id>` 只读下载该 Invocation 冻结快照显式授权的媒体（它是该运行可见媒体的证据，不是模型实际发送内容的证明，也不能用 file ID 指定别的文件）：

```bash
plasticwan-utils invocation media 12345 --json
plasticwan-utils invocation media 12345 --variant preview --json
```

- 每个媒体不超过 20 MiB、单次运行总量不超过 100 MiB、最多 32 项；下载按列表顺序逐个进行。超过上限的列表在下载前整体失败（`media_too_many_items` / `media_total_too_large`）。
- 输出是 manifest：`{ invocation_id, variant, directory, items[] }`，每项含 `status`、`path`、`mime_type`、`bytes`、`sha256` 与 `error`。目录是新创建的私有临时目录；成功项保留、失败项只记录稳定错误码。部分失败以 `media_download_failed` 退出（退出码 `1`）但 stdout 仍有 manifest；全部失败先尝试删除整个目录，删除成功后才输出 manifest。若文件系统拒绝清理，命令失败、目录可能残留，stdout 不保证含 manifest。文本与 manifest 经 API key 脱敏；二进制保留响应原字节，不做文本脱敏，`bytes`/`sha256` 对应实际保存的文件。
- 只报告 manifest 与必要条目，不把二进制内容转贴进聊天；`preview` 只对 photo/sticker 可用。导出是只读操作，不修复重放丢失的内联图片，也不代表视觉保真已还原。

## 报告后停止

报告采用：**目标 → 观察到的事实 → 推断及置信度 → 缺失证据 → 最小下一步**。仅有“没有成功发送”证据时，不把它写成“模型主动沉默”。

审计完成后默认停止，不为补充证据自动调用 replay。用户明确请求重放时，先按 Skill 入口加载重放指南并核对授权范围；查询授权不包含计费模型调用。
