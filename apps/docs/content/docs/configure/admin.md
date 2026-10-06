---
title: 使用管理面板
description: 安全访问本地 Admin Panel，查看审计、管理模型与应用配置。
---

# 使用管理面板

Admin Panel 与 `serve` 同进程启动，用于本地审计和受控管理；它不是文档站，也不应直接暴露在公网。

## 启用与安全访问

配置：

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8787,
    "session_ttl_hours": 24
  }
}
```

`admin.*` 改动需要重启。Docker 中要从宿主机访问，容器应绑定 `0.0.0.0`，但端口发布必须限制为 `127.0.0.1:8787:8787`，再由你管理的 TLS 反向代理进行认证和访问控制。首次访问时创建管理员账号；密码长度为 12–200 字符，浏览器 Session 采用 HttpOnly 且 SameSite=Strict Cookie。

## 常用任务

- **Overview / Invocations / Messages / Contexts**：查看收到消息、运行窗口、Tool 调用和连续对话上下文；审计读取不修改数据。
- **Models**：维护 Provider、已启用模型和全局 Agent/Vision 选择。保存后查看是否成功应用。
- **Chats**：管理 Chat/Topic allowlist 与每群模型覆盖。新增 Chat 立即生效；删除 Chat 与 Topic 范围需重启；已有 Chat 的模型覆盖可热应用。
- **Memories**：查看、编辑或删除短期记忆；长 TTL 记忆应由人工审核，不要把它当永久知识库。
- **图片生成 / 生图记录 / 图片资产**：图片生成工作台（提交、解析预览、实时查看输出）、全部生成的审计与重试、提示词素材与参考图库管理，见[图片生成](../guides/images.md)。
- **图片设置**：图片功能的启用开关、生图凭据与模型配置。保存后立即应用，不需要重启；禁用会删除整个 `image` 段并清理不再引用的 key jar 条目。
- **Settings**：对手改配置使用 **Apply config file**，并查看 Saved 与 Running 状态及 `restart_required`。
- **Developer**：按需记录模型调用的调试报文，或在确认后清除已有报文。
- **API keys**（Manage 组）：创建、查看与撤销供 CLI 与评估工具使用的密钥，明文只在创建弹窗中出现一次，见下文。
- **Invocation 重放**：仍只有携带 API 密钥的 CLI/API 入口，没有页面入口；只读的配置/prompt 检查、场景 prompt、Invocation 搜索、重放预检与媒体导出同样在 CLI/API 层提供，见下文。

## 查看和复制 Telegram ID

在 **Messages** 的发送者姓名旁，可查看并复制 `Telegram user ID`；打开消息详情后，每条 Revision 也有相同入口。匿名或频道身份显示的是 `Telegram chat ID`，不能作为用户 ID 填入忽略名单。消息本身的 `Telegram message ID` 是另一项字段。

在 Invocation 详情的 **Overview** 消息卡和 **Frozen context** 的 Sender 列，复制 `Telegram sender ID` 可取得当时冻结的发送者 ID。旧记录缺少 ID 时显示 `—`，不会猜测或填入当前资料。

复制按钮只把数字 ID 放入剪贴板。浏览器拒绝剪贴板访问时，可以选中 ID 手动复制；复制不会修改 Bot 配置。用户 ID 可用于维护 `telegram.admins` 或 `ignored_user_ids`，成员自助忽略与恢复见 [Telegram 接入](telegram.md#自助忽略与恢复)。

## 界面语言

界面支持英文与简体中文。顶栏右侧的语言切换按钮在两种语言间切换，立即生效并写入浏览器 `localStorage`（`admin-language`）；未手动选择时跟随浏览器语言（`zh` 开头解析为中文，否则英文）。技术名词（Invocation、Context、Prompt、Token 等）在中文界面中保留英文原文；后端返回的错误消息始终按服务端原文显示（错误码 + 消息）。

## 开发者调试报文

Developer 页的「记录原始请求报文以便调试」开关写回 `config.jsonc`，保存成功后立即应用到后续模型调用：

```jsonc
{
  "developer": {
    "record_model_payloads": false
  }
}
```

整个 `developer` 节和其中的字段均可省略，缺省为 `false`。关闭后仍记录 Invocation、模型与工具调用、Token/缓存用量、费用、状态和错误；已保存的历史报文不会自动删除。开启会增加数据库占用，建议只在排查问题时启用。现有调试快照包含模型请求（内联图片正文替换为摘要）与 HTTP 响应状态，不保存完整响应流。

「清除此前记录的原始请求报文」需要二次确认，只清除模型调用的请求/响应调试快照，不影响基于公开消息的场景重放。调用记录、关联关系和统计保留；详情页会显示报文未记录或已清除。记录开关仍开启时，新报文会继续保存。清除按批执行；若中途失败，已完成的批次不会恢复，可重试清除。

SQLite 释放的页可供后续写入复用，但数据库文件不一定立即缩小。此操作不会执行 `VACUUM`，也不清理已有备份；备份与恢复仍遵循[原有维护流程](../operations/backup-restore.md)。

## API 密钥

在面板的 **Manage → API keys**（`/api-keys`）页面创建、查看与撤销密钥；操作需要管理员登录 Session，API 密钥本身不能管理密钥。密钥用于 CLI 与评估工具，安装与用法见 [CLI 参考](../reference/cli.md)。

- 列表显示 **Name**、**Prefix**、**Created**、**Last used**、**Status**（**Active** / **Revoked**）与 **Actions**，任何时刻都不回显明文；从未使用过的密钥在 **Last used** 显示 **Never used**。
- 点 **Create API key** 只需填写 **Name**（1–80 字符），再点 **Create key**。成功后 **Save your API key** 弹窗显示一次完整明文，可点 **Copy API key** 复制；点 **Done** 或关闭弹窗、切换页面、刷新后都无法再查看，请立即存进密码管理器或部署环境变量。
- 页面不把明文写入浏览器 `localStorage`/`sessionStorage` 或查询缓存，列表接口也不返回它。复制失败时弹窗保留文字并提示手动复制。
- 点行内 **Revoke** 后需在确认框点 **Revoke key**；撤销立即生效且不可恢复，密钥行与元数据保留，**Status** 变为 **Revoked**，不再提供撤销操作。

密钥的能力范围是只读检查与 Invocation 读/重放：允许查看当前配置与 global/group prompt 的脱敏视图、比较磁盘配置、读取 Invocation 场景将使用的当前两层 prompt、运行免费的重放预检、下载该 Invocation 快照授权的媒体，以及读取 Invocation 列表/详情并发起重放；它不能读取其它审计（Overview、Messages、Contexts、记忆等）、不能修改配置，也不能管理密钥。请求带密钥时服务器不再使用浏览器 Cookie，因此用密钥访问其它接口不会因为面板已登录而放行。列表里的 `last_used_at` 在每次密钥通过校验时更新；撤销后立即失效。明文遗失只能撤销后重建。请把密钥当密码对待，不要粘贴进聊天、日志或提交到仓库。

## Invocation 重放

重放从已经结束的 Invocation 重建一段历史公开聊天场景，用当前 Prompt、模型与工具定义观察它会怎样回复。入口是携带 API 密钥的 CLI/API，面板登录会话不能直接重放；免费的预检、场景 prompt 查看与媒体导出也没有页面入口。它不会发送 Telegram 消息、不修改生产会话与业务数据（鉴权仍更新密钥使用时间），但会**真实调用模型并计费**，不计入生产用量预算。交给 Agent 时，明确授权目标 ID、次数与可选覆盖，不把查询授权当重放授权。

不需要开启 Developer 报文录制；关闭录制或清除调试报文不影响场景重建，也不要求源 Invocation 曾调用模型。需要仍在保留期内的开场公开消息；尚未结束、开场缺失或损坏、Chat/Topic 已不允许或当前模型不可用时会明确拒绝，先用免费预检确认。

```bash
# 免费预检：能否重放、能否覆盖 prompt；不调用模型
plasticwan-utils invocation preflight 12345 --json
# 查看该场景使用的当前两层 prompt（source: active，不是历史记录）
plasticwan-utils invocation prompts 12345 --json

plasticwan-utils invocation replay 12345 --json
# 临时替换 global / group 层（每层最多 64Ki 字符；不写回配置）
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
plasticwan-utils invocation replay 12345 --group-prompt group.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json

# 切片重放：只重放某次成功 Bot 发言之前的一小段公开输入，需确认计费
plasticwan-utils invocation preflight 12345 --before-send 678 --json
plasticwan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
```

### 切片重放

给出 `--before-send <telegram_sends 内部 ID>` 时，重放不再从整个开场批次重建场景，而是只取该次成功 Bot 发言之前的一小段公开输入：

- 窗口严格位于上一条 Bot 发言之后、目标发言之前（两端不含），目标必须是本 Invocation 的成功发送；上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation。没有上一条 Bot 发言时，从保留输入的开头开始。
- 只包含冻结且已注入的公开消息：目标发言之前已注入的批次会被拍平后一次性灌入，不按 Bucket 或历史节奏等待（模型并发与网络延迟仍可能造成等待）；附加批次的注入时间必须严格早于发送请求开始，同毫秒无法证明先后时保守省略。没有更早历史，也不读取历史的 reasoning、工具结果或 system prompt。
- 原 Bot 回答不进入模型，只保留在审计里作为对照；回复引用不能跨出该窗口。返回的 `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 取该次发送请求的开始时间（不是交付完成时间）。
- 窗口内没有新的公开消息返回 `replay_slice_empty`，目标不是本 Invocation 的成功发送返回 `replay_slice_target_invalid`。切片重放同样真实调用模型并计费，需要显式 `--confirm-paid`；缺失时 CLI 以 `confirm_paid_required`、退出码 2 拒绝，不读取 prompt 或 stdin，也不发预检或 POST。免费预检不接受该确认参数；预检与重放必须使用同一个 `--before-send`。
- 目标发言 ID 可以先搜索：`plasticwan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json`，命中项里的 bot 条目带 `telegram_send_id`，可作为 `--before-send` 候选，再用同一 ID 预检。搜索也保留该 Invocation 向其他 Conversation 的真实发送；这类发送不能作为该 Invocation 的切片目标。

限制与取舍：

- 默认输入是开场批次的冻结公开消息与当时可证明存在的历史，不加入后续批次与热注入；切片重放只取 `--before-send` 窗口内的冻结输入，并拍平可证明在发送前已注入的批次。两种模式都不加入后来编辑，当前上下文预算、Topic 范围与话题切点仍可能收窄场景；默认模式还受当前历史长度限制。不是恢复历史私有推理、工具结果或完整 Conversation Context。
- prompt、模板变量、模型、思考强度与工具定义都取**当前**该 Chat 的配置；`invocation prompts` 返回 `source: active`，不能当历史记录。只允许覆盖 global/group，固定协议和整体 system prompt **不能**覆盖；global 不能清空，group 可以清空，模板按当前白名单校验。
- `send` 只收集到 `outputs`，校验当前参数、文字限制与场景内的回复目标，不执行真实发送限流或 Sticker/生成资产的世界状态检查。记忆和 Alarm 从空内存开始，typing、生图、`zzz` 只合成；`read` 读取当前系统文档。
- 当前模型支持图片时，可按需读取本次场景授权且仍保留的 Photo、Sticker 与图片 Document，引用不跨场景；读图只下载/规范化图片给当前模型，不调用生产 Vision 或写分析缓存。缺失、不支持或下载失败会明确省略/报错，`omitted_images` 不代表之后下载成功的保证。网页抓取、Sticker 搜索、MCP 和未支持能力被拒绝。
- 场景时间默认为开场冻结时间，切片模式取目标发送请求的开始时间（不是交付完成时间）；不恢复当时记忆/回执，不模拟全局睡眠、发送提醒或新消息发送屏障。当前低预算可暴露 `zzz`，但执行不写睡眠状态。
- 返回的 `fidelity` 与 `overrides` 字段列出这些边界；`dispatches` 里的 `mode`（`synthetic`/`live_read`/`blocked`）只是调用走的分派路线，不代表调用成功，成功与否看 `tool_calls`。`error` 非空表示重放没有正常完成，完整结构仍会返回。
- 同时只允许一个重放；轮次、时长、工具尝试次数与 `trace` 记录有上限，超限会明确报错结束。`trace` 的 1 MiB 预算不等于整个响应体的大小上限；CLI 另行拒绝超过 4 MiB 的响应。重放中的模型请求不自动重试。模型选择不发言（输出里没有 `send`）也是正常结果。
- CLI 在重放前先跑预检，不可重放或不允许覆盖时不会发送 POST。媒体导出（`invocation media`）只读下载 Invocation 快照授权的媒体，不是视觉保真修复，也不改变重放输入。

## 验证与风险

启动日志需要有 `admin_started`。设置页面显示“已保存”不一定等于运行中已使用：若有待重启字段，确认外部监督器已重启服务后再检查配置哈希。不要共享面板密码、Cookie 或从浏览器导出的请求。

面板打不开时，请看 [排查问题](../operations/troubleshooting.md)。
