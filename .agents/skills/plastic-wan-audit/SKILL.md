---
name: plastic-wan-audit
description: 审计 Plastic Wan 的 Invocation 与 Conversation 行为——解释 bot 为什么回复、为什么保持沉默、当时模型看到的 system prompt 是什么、私有推理文本写了什么，并排查 nudge、prompt_version、参与闸门与结束原因。Use when asked to audit an invocation, explain why the bot did not reply / stayed silent, inspect the model calls, tool calls, sends or nudges of a run, or verify which prompt version and system prompt text were actually live in this project.
---

# Plastic Wan Audit

## 工具

`scripts/audit.ts`：只读审计脚本（直连 SQLite，不属于业务层），在仓库根目录执行。默认数据库 `dev-data/data/plasticwan.sqlite`；其他部署用 `--db <path>`，路径按配置文件的 `paths.database`（相对路径按运行 `serve` 的工作目录解析，与运行时一致）。

```bash
node scripts/audit.ts invocation <id> [--json]              # 单次运行全貌 + 判读
node scripts/audit.ts conversation <id> [--limit n] [--json] # 会话趋势：沉默次数、nudge、上下文状态
node scripts/audit.ts prompt <invocationId> [--out <file>]   # 该次运行真实的 system prompt
node scripts/audit.ts search --text <关键词> [--since <iso>] [--limit n]  # 私有推理文本检索
```

`--json` 输出结构化结果，供下游脚本解析；默认输出人类可读文本。

## 判读顺序

1. 先读输出的「判读」段。`sends_used = 0` 且存在 `harness_nudge` 且存在私有文本 = **模型自己选择沉默**，harness 已尽责；只有 `telegram_sends.state != success` 才是发送故障。
2. 比对 `prompt_version` 与 `src/platform/agent-protocol.ts` 的 `AGENT_PROMPT_VERSION`。不一致说明该次运行用的是旧系统提示词，结论不能外推到当前代码。
3. `completion_reason` 不是 `completed` 时先排查结束原因（`budget` / `sleep` / `turn_budget` / `wall_clock` / `context_limit` / `process_restart` / `recovery_age`），再谈参与倾向。
4. 参与倾向问题必须看**当时**的 system prompt：用 `prompt` 子命令 dump 后 grep 具体句子，不要凭当前仓库文档或人格文件推断（`agent.system_prompt_file` 由运维维护，随时可能改）。
5. 想找出「模型被哪句话说服了」，先用 `search` 按私有文本模板检索（如「不回复」「没有@我求助」「Not directed at me」），再回到 dump 出的 system prompt 定位对应句子。

## 规则

- 只读：脚本以 `readonly: true` 打开数据库。不要写入审计表、不要修改历史记录、不要用 Admin Panel 的写端点代替审计。
- 审计行是唯一事实源：结论必须落在 `sends_used` / `tool_calls` / `telegram_sends` / `agent_messages` 的具体字段上，不能只给「模型不想回复」这种转述。
- 报告里给出 invocation id、时间戳与字段值，让读者能自己复核。

## 参考

- 表结构、字段语义与「症状 → 结论」速查：[references/audit-tables.md](references/audit-tables.md)
