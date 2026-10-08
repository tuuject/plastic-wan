# Plastic Wan - 20261008 显式回复去重与可配置重复回复

## 背景

图片 generation/asset 的交付去重只能防止同一成品重复发送，不能阻止模型换一段文字、改发贴纸或跨 Invocation 再次回复同一条消息。发送限流控制的是 Chat 内的尝试频率，也不能代替按回复目标去重。仅靠工具描述提醒，不足以保证重启或 Context 重建后仍遵守一次回复的约束。

本次把默认的「同一消息只回复一次」落实到发送边界，同时提供明确的配置开关，让需要多次回复的场景可以主动放开限制。开关只控制显式 `reply_to_message_id` 的去重，不改变授权、预算、限流、发送屏障或图片交付保护；不对未引用的独立发言做语义推断或文本相似度判断。

## 主要变更

### 1. 可选 boolean 开关贯通配置、工具描述和运行快照

[src/platform/config.ts:320](../../src/platform/config.ts#L320) 新增全局字段 `agent.allow_reply_message_multiple_times`，没有 per-Chat 覆盖：

- 省略或 `false`：启用按回复目标的去重。
- 显式 `true`：允许对同一显式目标多次发送，但每次发送仍须遵守其他工具约束。
- Schema 的 `default: false` 是默认行为注解；配置加载器不把省略值写成显式 `false`，FileConfig、RawConfig 与 Admin JSON 投影均保留省略语义，非 boolean 值被拒绝。

该字段进入 [src/platform/config-diff.ts:52](../../src/platform/config-diff.ts#L52) 的热更新白名单，Admin 的 active/file 配置检查视图同步回显。显式应用配置后，下一次 Invocation 使用新值；运行中的 Invocation 保留启动时的配置快照。[src/orchestration/agent-runtime.ts:217](../../src/orchestration/agent-runtime.ts#L217) 与 [src/orchestration/agent-runtime.ts:288](../../src/orchestration/agent-runtime.ts#L288) 同时传递该值，避免展示给模型的工具定义与实际执行策略不一致。

[src/capabilities/send-tool.ts:228](../../src/capabilities/send-tool.ts#L228) 按快照生成 `send` 的描述：默认说明跨文字、贴纸、图片只回复一次，且禁止删掉或改换目标绕过拒绝；允许重复回复时改为说明配置已放开，但并不鼓励无依据的多次发送。

### 2. 直接用发送审计判断已回复与未决尝试

[src/capabilities/send-tool.ts:376](../../src/capabilities/send-tool.ts#L376) 查询既有 `telegram_sends`，键为目标 Conversation 与显式 `reply_to_message_id`，不按发送种类、内容或 Invocation 划分：

- 存在 `success`：拒绝为 `reply_already_sent`。
- 存在 `pending` 或 `outcome_unknown`：保守拒绝为 `reply_delivery_unknown`；未决尝试优先于另一条成功记录，不能用成功抵消不确定性。
- 只有明确 `error` 不占回复机会，允许后续重试。

命中只写 `tool_calls` 错误审计，不调用 Telegram、不新增发送行、不增加发送计数。记录来自持久化审计，跨 Invocation、Context 重建与进程重启生效；进程崩溃遗留的 pending 不会因等待或重启自动视为未送达。保证只覆盖在线审计保留窗口，不承诺清理记录后的永久去重。

未引用消息的独立发送仍可用，runtime 不推断它是否在语义上重复回答；禁止通过删改引用绕过拒绝属于模型必须遵守的工具契约，并不是额外的自然语言识别机制。

### 3. 先预检、独立提交屏障，再原子复检并写 pending

发送顺序见 [src/capabilities/send-tool.ts:405](../../src/capabilities/send-tool.ts#L405)：

1. 先拒绝已经可知的重复回复，不消耗发送屏障。
2. 在发送事务之外运行屏障；屏障可能挂载新 Bucket 并把它排入内存注入队列，其数据库事务必须独立提交。
3. 进入 IMMEDIATE 写事务后再次查重，与 pending 发送记录一并完成，避免两个并发发送都通过预检。

事务内的重复拒绝先返回错误结果，让拒绝审计随事务提交，随后再向调用方抛错。不能把屏障也包进这个事务：如果后续 Tool 审计写入失败，外层回滚会造成「内存已经排队、数据库却没有挂载」的分叉。[test/reply-dedup.test.ts:782](../../test/reply-dedup.test.ts#L782) 用拒绝审计写入失败覆盖该边界，检查 Bucket 挂载不会被回滚。

[迁移 032](../../src/store/migrations/032_reply_delivery_index.sql#L1) 为查询新增按 Conversation 与 JSON reply ID 的部分表达式索引，只覆盖 `success`、`pending`、`outcome_unknown`。索引刻意不设唯一约束：旧库可能已有重复回复审计，开启重复回复后也允许产生多行；不能以建索引为由丢弃历史或使升级失败。[src/store/schema.ts:417](../../src/store/schema.ts#L417) 同步定义，迁移测试检查新库、已有重复记录的升级和实际查询计划。

### 4. 图片交付保护与 Reply 限制保持独立

图片授权、显式重发资格、generation/asset 交付去重和未知结果保护不受新开关影响。[src/capabilities/send-tool.ts:329](../../src/capabilities/send-tool.ts#L329) 仍先检查图片交付：全部已交付时返回 `replayed:true`，只报告旧 Telegram message ID，不再发送，也不算第二次回复，因此该 no-op 先于 Reply 查重返回。

确实要发送剩余成品或显式重发时，默认仍受目标消息只能回复一次的限制；`resend:true` 不能绕过它。开启 `allow_reply_message_multiple_times` 只放开这层 Reply 检查，不能据此盲重试结果未知的图片，也不会自动重新发送已交付资产。

[图片 Skill](../../src/plugins/image/skills/image-generation/SKILL.md#L24) 不再要求生成刚提交就立即发送确认回复：如果成品要引用用户原消息，优先把该消息的回复机会留给最终结果，可用 `typing` 表示临时状态。新的明确重发请求应回复新消息，而不是再次引用已回答的原消息。

### 5. Replay 使用当前策略，但不查询生产交付台账

[src/orchestration/replay.ts:321](../../src/orchestration/replay.ts#L321) 将当前配置传给合成工具，生成工具描述时也使用同一策略。[src/orchestration/replay-tools.ts:276](../../src/orchestration/replay-tools.ts#L276) 默认拒绝同一重放场景内第二次引用同一目标；显式开启后允许重复，但仍检查场景可见性。

这仍是隔离的重放实验，不读取生产 `telegram_sends` 来预测线上是否拒绝：不同重放场景各自计数，不发送 Telegram 消息，也不改生产表。该边界不能被表述成完整模拟线上交付状态。

配置示例、Telegram/图片用户指南及主题文档同步说明默认行为、热更新、审计保留期和图片例外。回归测试除返回值外还检查 Tool/发送审计、发送额度、Bucket 挂载与 Context 重建后的行为，覆盖开启/关闭/省略、并发 pending、未知结果、明确失败重试、跨运行/重启和配置快照切换。

## 验证

以下是代码提交前本次实际运行的验证，不是撰写日志时重新执行的全量测试。主验证环境为 Windows、Node.js v24.18.0；命令通过 Corepack 调用 pnpm。由于本机 pnpm shim 的解析问题，含嵌套 pnpm 的检查临时调整了命令进程的 PATH，没有修改项目配置或持久化环境设置。

```bash
corepack pnpm test
# 94 个测试文件全部通过；1219 passed，6 skipped（共 1225 项）
# Duration: 312.26s

corepack pnpm run check
# runtime / CLI / Admin / docs TypeScript 检查通过

corepack pnpm run lint
# lint / format 通过；保留 3 条既存字符串拼接提示，及临时研究 JSON 超出 1 MiB 的警告

git diff --check
git diff --cached --check
# 代码提交前通过
```

首轮全量运行达到 5 分钟命令超时，没有最终汇总，不计为通过；延长时限后的完整重跑才得到上面的最终结果。独立只读审查另通过 191 项定向测试，并复跑得到同样的全量通过数；这些是重复验证，不与主验证结果相加。

协作验证还完成：

- Admin 生产构建，以及 `00-auth`、`01-routes`、`09-chats` 三个 E2E 套件，共 **43 项通过**，包含 Settings 路由；未运行完整 16 套件集合。
- 文档生产构建与验证：**22 个 HTML/Markdown 页面、79 个 HTTP 资源通过**，含搜索、示例、Schema 与来源信息；HTTP 验证使用本地回环地址和 `/` 基础路径，不代表真实托管环境的深链接或 MIME 验收。
- 独立审查未发现实际 bug，重点核对已交付图片 no-op 的顺序、屏障事务独立提交、Reply 原子复检及开关开启后的安全边界。

测试使用 Faux/fixture 与临时数据库，没有进行真实 Telegram/Provider 验收、生产库迁移或大表建索引耗时测试，也没有部署、接管或重启线上实例。同 Chat 不同 Topic 的 Reply 去重隔离没有新增独立用例；实现按 Conversation ID 限定，跨 Conversation 的显式测试使用不同 Chat。

## 提交

```txt
8aed0907626f076e438b190d1ecd23e4c753be6e Add configurable reply deduplication
```
