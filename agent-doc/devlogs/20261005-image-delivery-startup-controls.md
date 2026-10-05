# Plastic Wan - 20261005 图片交付去重、显式重发与启动控制命令回放

## 背景

图片生成与 Telegram 交付是两件事：`image_generate` 的提交幂等只能防止重复生成，不能证明成品已经发给用户。生成任务可能在当前工具链中完成并被 `send` 交付，而完成回执要等工具链结束后才进入 Conversation；如果模型把晚到回执当作新的发图请求，同一批成品就可能再次发送。仅修改 Prompt 无法保证跨 Invocation、进程重启后的去重。

另一处问题在启动追赶：停机期间积压的 Update 不创建实时 Bucket，但此前也因此跳过了控制命令识别，暂停/恢复状态没有按积压命令推进。修复需要复用实时命令的鉴权与状态转换，不能顺便重放所有旧管理操作。

本次只记录技术机制、边界与验证结果，不收录现场群聊原文、参与者身份或真实会话标识。

## 主要变更

### 1. 用既有发送审计作为图片交付台账

新增的 [src/store/image-delivery.ts:6](../../src/store/image-delivery.ts#L6) 直接查询 `telegram_sends`，按目标 Conversation、generation 与 asset ID 判断交付状态，不引入第二份 outbox，也不依赖进程内缓存。

- 新发送的 `request_json` 记录 `asset_ids` 与是否显式 `resend`，保留既有的 generation 和图片数量。
- 默认只发送尚未成功交付的成品；同一 generation 后续新增的输出仍能正常交付。
- 全部成品已交付时，`send` 返回成功的 `replayed:true`，结果文本列出相关投递批次的旧 Telegram message ID，并明确没有新发消息。
- 去重命中仍写成功的 `tool_calls` 与 canonical `toolResult`，但不创建新 `telegram_sends` 行，不增加 `sends_used`、限流用量或 Context 的 `send_count_total`/`send_seq`。

去重分支见 [src/capabilities/send-tool.ts:322](../../src/capabilities/send-tool.ts#L322)，canonical 发送计数排除重放结果的处理见 [src/orchestration/agent-runtime.ts:1062](../../src/orchestration/agent-runtime.ts#L1062)。这样既保留模型调用过工具的证据，也不会把无副作用的重放计入真实发送或推动发送次数驱动的 Context GC。

去重记录随在线发送审计保留，跨 Invocation 与进程重启有效，但不承诺超出在线保留窗口的永久幂等。

### 2. 显式重发与结果未知采用不同规则

`resend` 只适用于 `kind:"image"`。工具描述与图片 Skill 要求仅在新的用户消息明确要求重发时设置 `resend:true`；runtime 额外检查当前不是完成回执轮且存在 caller，否则以 `image_resend_requires_user` 拒绝。运行时不会独立判断自然语言是否表达了重发意图，这部分仍由模型遵守工具契约。

显式重发只绕过“已经成功交付”的默认过滤，不绕过 Conversation 授权、引用 TTL、限流、取消/截止时间或发送屏障，更不能绕过结果未知保护：

- 历史发送仍为 `pending` 或 `outcome_unknown` 时，不能把缺少成功记录当成可重试。
- 同一 asset 另有成功记录，也不能抵消未决尝试。
- 无法证明历史交付的具体资产集合时，保守拒绝该 generation 的再次交付。

默认发送和显式重发都会在这些情况下返回 `image_delivery_unknown`。本次没有新增人工裁定未知结果的管理入口，也没有添加隐藏的自动重试通道。

### 3. 回执在进入 Context 时补充交付状态

[src/context/context-builder.ts:516](../../src/context/context-builder.ts#L516) 在实际注入图片完成回执时查询最新发送台账，而不是在任务完成时提前冻结交付状态。合法的图片回执增加 `image_delivery`，其三类资产列表互斥：

- `delivered_asset_ids`：已交付且没有未决尝试。
- `pending_asset_ids`：尚未交付、也没有不确定尝试的成品；这里的 pending 表示待交付，不是发送审计中已开始的 `pending` 尝试。
- `unknown_asset_ids`：存在未决尝试，或历史交付集合无法证明；不确定性优先于成功记录。

这让工具链中已经发出的图片在晚到回执里显示为已交付。回执仍位于不可信数据边界内，也不是显式重发请求；普通非图片回执保持原有结构。图片 Skill 同步说明默认去重、只交付剩余输出及显式重发边界。

### 4. 旧审计迁移与缺失文件不再静默吞掉

[迁移 027](../../src/store/migrations/027_image_delivery_audit.sql#L1) 为交付查询增加按 Conversation 与 generation 的图片发送索引，并补齐旧 `request_json` 的资产信息：

- 只推断发送尝试发生时已经存在的资产，不能把后来生成的成品归到旧发送里。
- 回填记录标记 `asset_ids_inferred`；推断数量与旧 `pictures` 不一致时标记 `asset_ids_unknown`，保留无法证明具体交付集合的不确定性。
- Drizzle Schema 同步索引定义；新库和已有数据升级路径都由迁移测试覆盖。

另修复了输出读取失败被 `undefined`/`flatMap` 静默过滤的问题。[src/image/bridge.ts:288](../../src/image/bridge.ts#L288) 不再吞掉文件读取错误，组合根也不再缩小成品列表；`send` 将其审计为 `image_generation_unavailable`，在创建发送行前整体拒绝，不发出残缺相册，也不消耗发送预算。这里保障的是文件缺失或无法读取时失败，不额外宣称所有内容损坏都能被识别。

本次没有新增配置项，也没有对真实运行数据库执行迁移。

### 5. 启动只回放暂停/恢复，并修正追赶任务的恢复年龄

`TelegramIngestion` 现在把“识别出的命令”与“当前路径允许执行的命令”分开。启动追赶识别控制命令，但只把 `/pause`、`/resume` 交给同一个 `BotCommandService`，按 Update 顺序执行并丢弃旧命令回复；排空后的暂停状态决定是否排队追赶。

其他已识别命令只保留 Update 审计，不重放管理副作用，也不进入聊天消息或模型上下文；编辑消息仍按原有 Revision 规则处理。Chat/Topic allowlist、忽略用户与管理员校验保持原边界。共享的 [src/orchestration/bot-commands.ts:69](../../src/orchestration/bot-commands.ts#L69) 统一提取命令发送者，匿名 `sender_chat` 不能借此获得管理员权限；回放执行点见 [src/startup-catch-up.ts:83](../../src/startup-catch-up.ts#L83)。

追赶 Bucket 的 `firstReceivedAt` 改为排空完成、建立任务时的时间，见 [src/orchestration/invocation-queue.ts:254](../../src/orchestration/invocation-queue.ts#L254)。选取积压消息仍使用持久化的本轮 `startedAt`，因此慢排空或崩溃续跑不会让刚排队的追赶任务立刻超过恢复年龄；真正排队超过 5 分钟后再重启的任务，仍按既有 `recovery_age` 规则过期。

没有把命令回放包装成 exactly-once：Update 去重提交发生在命令执行之前，如果进程恰好在两者之间崩溃，该命令下次启动会被去重而不再执行。实时路径也有同样的窗口，本次如实保留并记录这一限制。

### 6. 回归测试与文档同步

新增 [test/image-delivery.test.ts](../../test/image-delivery.test.ts) 和 [test/image-delivery-runtime.test.ts](../../test/image-delivery-runtime.test.ts)，不仅检查工具返回文本，也断言发送行、Tool 审计、限流用量和 canonical history 的发送计数；覆盖跨 Invocation/重启、后增输出、显式重发、并发 pending、未知结果持久化、权限与过期引用，以及先交付后注入回执的 Faux 模型链路。

已有图片、迁移、启动追赶、命令与参与测试补充缺失文件、旧资产集合推断、慢排空恢复年龄、积压命令顺序及鉴权边界。主题文档和图片/Telegram 用户指南同步行为与限制，启动追赶的说明也明确不同 Forum Topic 不混入同一 Conversation。

## 验证

以下为代码提交前本次开发实际运行的离线验证，环境为 Windows、Node.js v24.18.0。测试用 Faux/fixture 代替真实 Telegram 与 Provider，不复制原始测试或现场日志。

```bash
pnpm test test/image-agent.test.ts test/image-delivery.test.ts test/startup-catch-up.test.ts test/scheduler.test.ts
# 4 个文件、50 项测试通过

pnpm test test/skills.test.ts test/system-resources.test.ts test/plugins.test.ts
# 3 个文件、13 项测试通过

pnpm run check
# runtime / Admin / docs TypeScript 检查通过

pnpm run lint
# lint / format 通过；同一临时研究 JSON 超出 1 MiB 检查阈值的警告仍存在

pnpm test
# Test Files: 9 failed | 63 passed (72)
# Tests: 36 failed | 794 passed (830)
# Duration: 233.88s

pnpm run docs:build
pnpm run docs:verify
# 文档生产构建通过；22 个 HTML/Markdown 页面与 79 个 HTTP 资源验证通过

git diff --check
git diff --cached --check
# 代码提交前通过
```

全量测试中的本次直接受影响 15 个测试文件合计 **292 项通过**；这不是一轮独立的 292 项命令，也不应与全量通过数重复相加。追加技能测试的 13 项同样是单独重跑结果。

全量 **36 项失败未被掩盖，也没有作为本次回归顺手修改**。独立复核在修改前的 `0f0566b` 归档源码上复现了相同两类基线问题：

- **27 项 Windows SQLite 清理失败**：既有图片测试在关闭连接前删除临时目录，另有核心执行测试遗漏关闭重新打开的客户端，触发文件占用相关的清理错误。
- **9 项语言断言失败**：本机 Node 的 `navigator.language` 仍为 `zh-CN`，既有英文预期与中文实际输出不一致；仅设置 `LANG`/`LC_ALL` 未使这些 Windows 测试确定为英文。

没有运行真实 `serve`/`doctor`、真实 Telegram 发图或 Provider 验收，也没有部署、接管或重启线上实例。本次不改 Admin 前端或 API，未运行浏览器 E2E；文档验证中的 HTTP 检查是本地构建产物检查，不代表线上验收。

## 提交

```txt
7b7ef53184b56130be40c0d6bd9250f5b117d2ba Deduplicate image deliveries and replay startup controls
```
