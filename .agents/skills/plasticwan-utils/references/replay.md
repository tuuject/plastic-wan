# Invocation 重放

## 仅在明确授权后执行

入口的 `doctor` 门槛同样适用：`plasticwan-utils doctor --json` 必须以退出码 `0` 返回 `status: "ok"`（恰好一次 `GET /api/invocations?limit=1`，无 replay 或模型/Provider 调用），否则停止并报告，不进入重放，也不代为 `login`、不重试；doctor 通过也只证明连通与鉴权，不构成重放授权。

先说明 replay 会真实调用所选模型（默认当前 Chat 配置，可显式临时覆盖）并产生费用，但不发送 Telegram 消息、不修改生产会话和业务数据（鉴权仍会更新 key 使用时间）。取得用户对目标 ID、次数、可选 prompt 覆盖和可选模型/thinking 覆盖的明确授权；用户仅说“看看为什么没回复”不构成重放授权。临时模型/thinking 覆盖（`--provider`/`--model`/`--thinking-level`）只影响这一次重放：不写回配置、不修改生产 Context/审计/预算，但会改变 prompt 变量、图片能力、context budget、Schema、Provider 连接与真实费用。已有明确授权时按范围执行，不扩大到批量或自动重试，不尝试用 Session Cookie 重放。切片重放还需 `--confirm-paid` 显式确认计费。

免费、无模型调用的只读核对不需要重放授权：`invocation preflight <id> --json`（切片选择加 `--before-send`）返回 `available`、稳定 `reason`、`prompt_overrides_available`、`omitted_images` 与可用时的 `scene`；`invocation prompts <id> --json` 给出该场景将使用的当前两层模板与变量，`source` 为 `active`；`models list --json` 只读列出当前 active 配置中可接受 text 输入的已配置模型（免费、不探测 Provider，列表不是授权，不能拿它当“可尝试清单”）。这些不是历史 prompt 或历史模型请求；`config show` 与 `prompt get global|group` 也只是当前配置。重放不依赖 Developer 报文录制，不要求源 Invocation 曾调用模型。

```bash
# 免费只读预检与当前场景 prompt
plasticwan-utils invocation preflight 12345 --json
plasticwan-utils invocation prompts 12345 --json

# 当前配置基线：仅在本次重放已获授权后执行
plasticwan-utils invocation replay 12345 --json

# 分层替换：仅在该覆盖已获授权后执行
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
plasticwan-utils invocation replay 12345 --group-prompt group.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json

# 临时模型/thinking 覆盖：--provider 与 --model 必须成对；--thinking-level 可单独使用；
# 预检与重放必须传同一选择，可与切片（--before-send）和 prompt 覆盖组合
plasticwan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
plasticwan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
plasticwan-utils invocation replay 12345 --thinking-level low --json

# 切片重放：收窄到某次成功 Bot 发言之前的窗口，需显式确认计费
plasticwan-utils invocation preflight 12345 --before-send 678 --json
plasticwan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
```

- 切片 replay 缺少 `--confirm-paid` 时，在参数解析阶段以退出码 `2` 和 `confirm_paid_required` 拒绝，不读取 prompt 文件或 stdin，也不发预检或 POST。未切片 replay 不要求该 flag；免费 `preflight` 不接受该 flag。
- 通过本地校验后，CLI 在 POST 前请求一次预检（切片重放带同一 `--before-send`）；不可用时按引擎原因码失败，不发送 replay。若请求覆盖而 `prompt_overrides_available` 为 false，同样不 POST；`--before-send` 是重放边界而不是 prompt 覆盖，不要求该权限；不要把此字段解释成旧 v1/v2 模型快照版本。
- `--global-prompt` 是完整替换 global 层：去空白后不能为空、最多 65,536 字符，否则本地以退出码 `2` 失败；`--group-prompt` 可为空以显式清空群指令。`-` 从非终端 stdin 读取，两层不能同时使用 `-`（`conflicting_prompt_input`）。HTML 注释会被剥离；模板按当前变量白名单校验，未知变量返回 `replay_prompt_invalid`。当前固定协议、Skill 索引与能力说明不可覆盖；没有整体 `--system-prompt` 参数或别名。
- 覆盖不写回配置或 key jar。只使用用户指定或批准的文件，不把凭据放入 prompt。
- 临时模型/thinking 选择：`--provider <alias>` 与 `--model <id>` 必须成对（本地 `invalid_model_override`、退出码 2；1–256 字符、不含控制字符），`--thinking-level` 取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（本地 `invalid_thinking_level`、退出码 2）、可单独给出（只临时改 thinking，模型仍按当前 Chat 配置）。给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`）；请求模型不支持的级别会被拒绝；不给任何选择时按当前 Chat 配置。CLI 把相同的 `provider`/`model`/`thinking_level` 放进预检查询与 POST body，预检与重放必须使用同一选择；模型选择不是 prompt 覆盖，不要求 `prompt_overrides_available`。
- 模型/thinking 覆盖只影响这一次重放：不写回配置、不修改生产 Context/审计/预算，但选中模型决定 prompt 变量、图片能力、context budget、Schema、Provider 连接与真实费用。核对响应的实际 `model`（`{ provider, id, thinking_level }`）、`fidelity.model_selection`（`current_chat_config`/`temporary_override`）与 `overrides` 的 `provider`/`model`/`thinking_level` 布尔，报告实际模型与保真差异；严禁自动尝试 `models list` 里的每个模型。
- replay 默认超时 300 秒；`--timeout-ms` 只改客户端等待上限，不放宽服务端预算。不要设置短超时再循环重试；请求中断前仍可能发生模型费用。
- 比较 prompt 前先确定评判点，并取得基线和覆盖各自所需的调用授权。基线是当前配置在同一公开场景的重新运行，不是恢复旧 prompt；源 `telegram_sends[]` 与 replay `outputs[]`、各自工具错误、完成原因和用量分开比较。历史结果只作观察基线，不冒充同条件实验。跨两次请求的 active 配置可能变化，核对实际模型与模板来源。

## 切片重放

`--before-send <telegram_sends 内部 id>` 把输入收窄到该次成功 Bot 发言之前的一小段公开窗口；`preflight` 与 `replay` 必须使用同一选择，切片重放需要 `--confirm-paid` 显式确认计费：

- 窗口严格位于上一条 Bot 发言之后、目标发言之前（两端不含），没有更早历史；上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation。没有上一条 Bot 发言时，从保留输入的开头开始。
- 目标必须是本 Invocation 的成功 `telegram_sends`：失败的、别的 Conversation 的或不存在的目标返回 `replay_slice_target_invalid`；窗口内没有新的公开消息返回 `replay_slice_empty`。两者都在任何模型请求之前拒绝。
- 输入只包含冻结且已注入的公开消息：目标发言之前已注入的批次会被拍平后一次性灌入，不按 Bucket 或历史节奏等待（模型并发与网络延迟仍可能造成等待）。附加批次的注入时间必须严格早于发送请求开始；同毫秒无法证明先后时保守省略。原 Bot 回答不进入模型，只留在审计里作为对照；不读取历史的 reasoning、工具结果或 system prompt。
- `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 取该次发送请求的开始时间（不是交付完成时间）；回复引用不能跨出该窗口。比较原回答与切片结果时分别引用审计里的 `telegram_sends` 与 replay `outputs`，说明它们不是同条件复现。
- 目标 ID 可以先搜索：`plasticwan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json`，命中项里 bot 条目的 `telegram_send_id` 是 `--before-send` 候选，仍须用同一 ID 预检。Invocation 可能向另一 Conversation 回复；搜索保留这些真实发送，但跨 Conversation 的发送不能用作该 Invocation 的切片目标。

## 披露保真限制

读取 `scene`、`model`、`overrides`、`fidelity` 和 `error`，不要把成功重放称为生产复现或生产已修复：

- 默认输入是源 Invocation 开场 Bucket 的冻结公开消息与 cutoff 时可证明存在的历史，冻结 history 优先，不加入后续 attach；切片重放只取 `--before-send` 窗口内的冻结公开消息，并拍平可证明在发送前已注入的批次，`history_count` 为 0。两种模式都不加入后来修订或迟到消息，当前上下文预算、Topic allowlist 与 `/cut_topic` 仍会收窄输入；默认模式还受当前 history 长度限制。缺失历史或媒体会省略/降级，缺失或损坏开场则拒绝；不以当前私有 Context、`request_json` 或后来请求拼替代输入。
- system prompt 的 global/group、模板变量、固定段与可见 Skill 索引，以及 Provider/model/thinking level 和工具定义，默认都来自当前配置；带临时模型/thinking 覆盖时按覆盖选择，`fidelity.model_selection` 为 `current_chat_config` 或 `temporary_override`。`invocation prompts` 的 `source: active` 必须明确披露，不能当历史记录；`read` 读取当前只读 `system:///` 资源。
- 不恢复历史 thinking、工具结果或记忆/任务回执。默认模式不加入后续热注入，切片模式仅拍平可证明在目标发送前已注入的公开批次。记忆与 Alarm 从空内存起步，typing/生图/zzz 只产生合成结果；生产全局睡眠与每日预算不阻断 replay，但 zzz 可见性遵循当前低预算门槛，执行不写睡眠、不扣生产预算。
- `send` 只收集到 `outputs[]`；校验当前 Schema、文本长度/空行限制和本次场景可见的 reply 目标，不发送 Telegram、不复验 Sticker/生成资产的世界状态或真实发送限流。合成成功不证明生产操作可成功。
- 当前模型支持图片且服务接线时，保留的 Photo、Sticker、图片 Document 获得一次性场景引用，`execute.call read_image` 可按需下载并规范化图片给当前模型；不调用生产 Vision、不写分析缓存，引用不能跨场景。`fidelity.omitted_images` 是渲染时没有可读引用的媒体数量，不保证之后下载成功。文本模型、缺失媒体或下载错误会明确降级/报错；网页抓取、Sticker 搜索、MCP 与未支持工具被阻止。
- `fidelity.send_nudge = disabled`；不模拟新消息发送闸门（send barrier），重放无发送不等于生产无发送，反之亦然。场景 `current_time` 默认为 cutoff，而不是完整历史运行时钟。
- `fidelity.dispatches[].mode` 表示执行路径，不代表成功；同时检查 `tool_calls[].is_error`。生产预算不扣减不代表 Provider 免费。模型请求关闭自动重试。
- 最多 20 轮、128 次工具调用、240 秒、1 MiB trace；当前配置可能进一步收窄轮数和时长，以 `fidelity.limits` 为准。一次只允许一个 replay，并与生产共享模型并发闸门，不并行压测生产。响应 `version: 2` 是场景结果格式，不是旧模型快照版本。
- 媒体导出（见 [Invocation 查询与审计](invocations.md#导出授权媒体)）仍只下载 Invocation 冻结快照显式授权的媒体，是独立命令；导出文件不会自动注入 replay，也不能扩展场景的引用权限。

## 处理失败并保留边界

分别读取退出码、stdout、stderr，不因非零退出码丢掉已有结果：

- `0`：命令成功；仍需检查工具错误与保真限制。
- `1`：网络、服务端或 replay 失败。若 stdout 有结构化结果且 stderr 为 `replay_failed`，检查 `error.code/message`、`completion_reason` 与已有输出，不把部分输出当完整成功。
- `2`：参数或输入无效；更正参数，不重试原命令。

| 错误 | 下一步 |
| --- | --- |
| `unauthenticated` / `forbidden` | 请操作员核对密钥、撤销状态和授权范围，在本机用 `login` 保存正确凭据；不换接口绕过认证 |
| `missing_api_key` | 当前没有可用的 endpoint/key 组合；请操作员补全参数/环境变量或 `login`，不自行混搭来源 |
| `invalid_credentials` | 凭据文件损坏、符号链接或权限不安全；需操作员处理，Agent 不代登录、不改权限或删除/重建凭据 |
| `confirm_paid_required` | 切片 replay 缺少 `--confirm-paid`，退出码 2；尚未读取 prompt 或发出任何请求。先取得目标、次数和覆盖的计费授权，再显式确认；不自行补 flag 或改成整场重放绕过 |
| `replay_source_unfinished` / `replay_busy` | 源未结束或已有 replay；报告并停止，不轮询或自动重试计费请求 |
| `replay_scene_unavailable` / `replay_scene_invalid` | 保留的开场公开消息缺失或场景损坏；报告证据，不补造快照、不用私有 Context/开发报文替代。开启报文录制不能修复此错误 |
| `replay_slice_empty` / `replay_slice_target_invalid` | 切片窗口内没有新的公开消息，或目标不是本 Invocation 的成功发送（失败的、别的 Conversation 的、不存在的）；核对 `matched_messages` 与 `telegram_sends`，不补造输入、不改成整场重放绕过 |
| `invalid_before_send` / `invalid_before_send_id` / `invalid_search` / `invalid_at` / `invalid_from` / `invalid_to` / `invalid_time_range` | 新参数校验失败（本地退出码 2；时间与时区语义由服务端判定，400 时退出码 1）；修正时间格式、搜索词或 `--before-send` 并核对授权范围，不重试原命令 |
| `invalid_model_override` / `invalid_thinking_level` | 本地参数校验失败（退出码 2）：`--provider` 与 `--model` 必须成对、1–256 字符且不含控制字符，thinking 级别必须在 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 内；修正参数并核对授权，不自动改选模型 |
| `invalid_query` / `invalid_body` | 服务端拒绝参数形状（CLI 退出码 1）：检查模型对、thinking 枚举、重复或未知参数；不绕过预检 |
| `unknown_provider` / `unknown_model` / `not_text_capable` / `replay_thinking_level_unsupported` | 当前配置没有该文本模型，或模型不支持指定 thinking（CLI 退出码 1）；用 `models list` 核对 `provider`/`model`/`thinking_levels`，请用户批准新的选择后再执行，不自动回退或逐一尝试 |
| `replay_prompt_parts_unavailable` | CLI 的预检覆盖守卫失败；核对服务版本与预检结果，不据此推断旧快照或绕过预检 |
| `global_prompt_empty` / `global_prompt_too_large` / `group_prompt_too_large` / `*_prompt_read_failed` | 本地拒绝覆盖内容；按提示修正文件或 stdin 并核对授权范围 |
| `replay_prompt_empty` / `replay_prompt_invalid` / `replay_prompt_too_large` | 服务端拒绝模板；修正并核对授权，不绕过校验或自动重试 |
| `replay_chat_unconfigured` / `replay_topic_unconfigured` / `replay_model_unavailable` / `replay_unavailable` | 请操作员核对当前 allowlist、模型或服务装配，不擅改配置 |
| `timeout` / `network_error` / `redirect_not_allowed` | 核对地址与服务，不降级 HTTPS、不自动重放；结果与费用可能不确定 |
| `response_too_large` | 超过客户端 4 MiB 上限；报告不可读取，不绕过限制或假装无记录 |
| `body_too_large` | 超过服务端 1 MiB JSON body 上限；缩短内容并核对授权，不绕过限制 |

结束时交代目标 ID、实际执行次数、实际使用的模型（含临时覆盖与 `fidelity.model_selection`）、prompt 来源与覆盖、关键证据、保真限制及未验证事项。只保存用户需要且已脱敏的最小结果，不自动落盘完整对话或 trace。
