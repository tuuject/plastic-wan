# Invocation 重放

## 仅在明确授权后执行

入口的 `doctor` 门槛同样适用：`plasticwan-utils doctor --json` 必须以退出码 `0` 返回 `status: "ok"`（恰好一次 `GET /api/invocations?limit=1`，无 replay 或模型/Provider 调用），否则停止并报告，不进入重放，也不代为 `login`、不重试；doctor 通过也只证明连通与鉴权，不构成重放授权。

先说明 replay 会真实调用当前配置模型并产生费用，但不发送 Telegram 消息、不修改生产会话和业务数据（鉴权仍会更新 key 使用时间）。取得用户对目标 ID、次数和可选 prompt 覆盖的明确授权；用户仅说“看看为什么没回复”不构成重放授权。已有明确授权时按范围执行，不扩大到批量或自动重试，不尝试用 Session Cookie 重放。

免费、无模型调用的只读核对不需要重放授权：`plasticwan-utils invocation preflight <id> --json` 返回 `available`、稳定 `reason`、`prompt_overrides_available`、`omitted_images` 与 `recording_enabled`；`plasticwan-utils invocation prompts <id> --json` 给出源 Invocation 记录的两层模板（仅 v2 快照）；`config show` 与 `prompt get global|group` 给出**当前**配置里的 prompt，可与记录值对比，但不要把当前值当成历史记录。

```bash
# 只读预检与记录 prompt：不调用模型、免费
plasticwan-utils invocation preflight 12345 --json
plasticwan-utils invocation prompts 12345 --json

# 原快照 prompt：仅在本次重放已获授权后执行
plasticwan-utils invocation replay 12345 --json

# 分层替换：仅在该覆盖已获授权后执行
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
plasticwan-utils invocation replay 12345 --group-prompt group.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json
```

- CLI 在 POST 前先请求一次预检；预检不可用时直接用引擎的稳定原因码失败（不发送 replay）；请求了覆盖而 `prompt_overrides_available` 为 false（v1 旧快照）时以 `replay_prompt_parts_unavailable` 失败，同样不 POST。
- `--global-prompt` 是**完整替换 global 层**而非追加：去空白后不能为空、最多 65,536 字符，否则在发请求前以退出码 `2` 失败；`--group-prompt` 允许空内容以显式清空群指令。`-` 从非终端 stdin 读取，两层不能同时使用 `-`（`conflicting_prompt_input`）。HTML 注释会被剥离，模板只能引用记录中已有的变量，否则服务端返回 `replay_prompt_invalid`。固定 prefix/middle（核心协议、Skill 索引、媒体与 Sticker 说明、会话模式、记忆指引）永远不可覆盖；不存在整体替换 system prompt 的参数（`--system-prompt` 已删除，无别名）。
- 覆盖是暂时的：不写回 `config.jsonc` 与 key jar，也不改变运行中的配置。只使用用户指定或批准的文件，不把凭据放入 prompt。
- replay 默认超时 300 秒；`--timeout-ms` 只改客户端等待上限，不放宽服务端预算。不要设置短超时再循环重试；请求中断前仍可能发生模型费用。
- 比较原 prompt 与新 prompt 时，先确定评判点，再分别取得所需调用授权。先确认快照是 v2 且 `prompt_overrides_available` 为 true；v1 只能原样重放。将源 `telegram_sends[]` 与重放 `outputs[]`、源与重放的 `tool_calls[]`、完成原因、错误和用量分开比较。历史结果可作为观察基线，不冒充同条件实验；同条件原 prompt 基线还需要一次获授权的 replay。

## 披露保真限制

读取结果的 `model`、`overrides`、`fidelity`、`error`，不要把一次成功重放称为生产复现或生产已修复：

- 仅用源 Invocation **首个 agent 模型请求的归一化纯文本快照**；图片省略数见 `fidelity.omitted_images`，后续热注入不重放。缺少快照时停止，不用 `request_json`、后续模型请求或当前 Context 拼替代输入。
- system prompt 由快照记录的层重建：v2 保存了固定段、当时的 global/group 模板与渲染变量值，覆盖只替换模板、渲染变量保持历史值；v1 没有层信息，只能原样重放。分层读取或覆盖 v1 会得到 `replay_prompt_parts_unavailable`，不要用当前 prompt 拼一个替代。
- Provider、模型和 thinking level 来自**当前 Chat 配置**；`fidelity.historical_model` 只是历史信息。`read` 读取当前只读 `system:///` 资源，不是历史资源副本。
- `send` 只收集到 `outputs[]`；记忆与 Alarm 从空的内存状态开始；图片生成只返回合成回执，`zzz` 不持久化睡眠状态。MCP 和未支持能力被阻止；合成成功不证明生产世界中的引用授权或外部操作可成功。
- `fidelity.send_nudge = disabled`：不再注入生产可能启用的发送提醒，也不模拟新消息发送闸门（`send_barrier`）。重放无发送不等于生产无发送，反之亦然。
- `fidelity.dispatches[].mode` 表示执行路径，不代表工具成功；需同时检查 `tool_calls[].is_error`。生产预算不扣减不代表 Provider 免费。
- 服务端最多 20 轮、128 次工具调用、240 秒、1 MiB trace；当前配置可能进一步收窄轮数和时长，以 `fidelity.limits` 为准。一次只允许一个 replay，且与生产共享模型并发闸门；不要并行压测生产服务。
- 媒体导出（`invocation media`，见 [Invocation 查询与审计](invocations.md#导出授权媒体)）只读下载快照授权的原文件或服务端规范化预览；它不是重放输入的一部分，也不修复重放中被丢弃的内联图片。

## 处理失败并保留边界

分别读取退出码、stdout、stderr，不因非零退出码丢掉已有结果：

- `0`：命令成功；仍需检查工具错误与保真限制。
- `1`：网络、服务端或 replay 失败。若 stdout 有结构化 replay 结果且 stderr 为 `replay_failed`，检查 stdout 的 `error.code/message`、`completion_reason` 与已有输出，不把部分输出当完整成功。
- `2`：参数或输入无效（含 prompt 覆盖为空或过大）；更正参数，不重试原命令。

| 错误 | 下一步 |
| --- | --- |
| `unauthenticated` / `forbidden` | 请操作员检查 key、撤销状态和授权范围，并在本机用 `plasticwan-utils login` 重新保存正确凭据；不换接口绕过认证 |
| `missing_api_key` | 当前命令没有可用的 endpoint/key 组合（例如提供了新 endpoint 而没有显式 key，或显式给了空值不会回退到保存文件）；请操作员 `login` 重新保存或补全参数/环境变量，不自行混搭来源 |
| `invalid_credentials` | 保存的凭据文件损坏、是符号链接或权限不安全；仅内容损坏且文件/目录安全时操作员可在本机重新 `login`，符号链接、非普通文件或不安全权限仍被 `login` 拒绝，需人工处理。Agent 不代为登录、不自动改权限、不删除或重建凭据 |
| `replay_source_unfinished` / `replay_busy` | 源未结束或已有重放；报告并停止，不轮询、不自动重试计费请求 |
| `replay_input_unavailable` / `replay_input_invalid` | 缺失或损坏的起始快照；可能未录制、已清理或来自旧版本。只能让操作员为未来 Invocation 开启录制；不能补造旧快照 |
| `replay_prompt_parts_unavailable` | v1 旧快照没有分层信息：只能原样重放；不要用 `config show`/`prompt get` 的当前值冒充历史层 |
| `global_prompt_empty` / `global_prompt_too_large` / `group_prompt_too_large` / `*_prompt_read_failed` | 覆盖内容在本地被拒（退出码 `2`）；按提示修正文件或 stdin 后重新取得确认，不重试原命令 |
| `replay_prompt_empty` / `replay_prompt_invalid` / `replay_prompt_too_large` | 服务端拒绝了覆盖模板（global 清空、NUL/BOM、未知变量、超限）；修正后用同一授权重试一次或报告，不绕过校验 |
| `replay_chat_unconfigured` / `replay_model_unavailable` / `replay_unavailable` | 请操作员核对当前 Chat、模型或服务装配；不擅改配置 |
| `timeout` / `network_error` / `redirect_not_allowed` | 核对地址、服务状态和连接；不降级 HTTPS、不自动重放，结果与费用可能不确定 |
| `response_too_large` | 超过客户端 4 MiB 上限；报告不可读取，勿绕过限制批量抓取或假装无记录 |
| `body_too_large` | 超过服务端 1 MiB JSON 请求体上限；即使每层字符数合格也可能触发，缩短内容后重新确认，不绕过限制 |

结束时交代：目标 ID、实际执行次数、使用的模型与 prompt 覆盖（`overrides`）、关键证据、保真限制和仍未验证的事项。只保存用户需要且已脱敏的最小结果，不自动落盘完整对话或 trace。
