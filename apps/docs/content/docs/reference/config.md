---
title: 配置参考
description: 按配置节理解 Plastic Wan 的必填项、覆盖关系与运行风险。
---

# 配置参考

下载机器可校验的 [JSON Schema](__DOCS_BASE__/config.schema.json) 和 [完整 JSONC 样例](__DOCS_BASE__/examples/config.example.jsonc)。Schema 是字段类型与范围的权威；本页解释任务中的组合关系，最终以目标版本的 `check-config` 为准。

## 顶层节

| 配置节 | 用途与要点 |
| --- | --- |
| `version` | 当前必须为 `1`。 |
| `data_dir`、`paths` | 运行锁、SQLite、媒体缓存与备份位置；Docker 使用 `/data/...`。修改需重启。 |
| `timezone` | 默认 IANA 时区；Chat 可单独覆盖。 |
| `telegram` | Token 引用、Bucket、allowlist、Topic、管理员与参与策略。 |
| `providers` | 已启用 Provider 与模型定义；凭据使用 SecretRef。 |
| `agent` | 主模型、Prompt、全局 Token 预算、并发、Context 和发送限流。 |
| `vision` | 图片/Sticker 模型、并发、独立 Token 与图片日预算。 |
| `admin` | 本地管理面板；修改后重启。 |
| `developer` | 可选调试设置；`record_model_payloads` 可省略，默认 `false`，可热应用。详见[Developer 页面](../configure/admin.md#开发者调试报文)。 |
| `mcp` | 受限 stdio 或 Streamable HTTP Tool；修改后重启。 |
| `retention` | 在线保留天数与备份份数，仅下次备份使用。 |

## 覆盖与隔离

全局 `agent.provider`、`model`、`thinking_level` 是默认值。Chat 同时指定 `provider` 和 `model` 时覆盖全局，`thinking_level` 可独立覆盖；Topic 使用所属 Chat 的模型设置。Chat 的 `participation.active_windows` 覆盖全局时段，关键词则追加到全局关键词。

Conversation、短期记忆和注意力窗口按 Chat + Topic 隔离；预算硬限制不是每群配额：主 Agent 日 Token 限制全局共享，Vision 有另一组全局限制。

## SecretRef 与安全

敏感字段只能用 `{ "env": "NAME" }`、`{ "jar": "name" }` 或固定 argv 的 `{ "command": [...] }`。HTTP MCP 禁止重定向和 URL 凭据；stdio MCP 仅运行配置里的固定 argv。Prompt 不会获得额外权限。

## 生效规则

配置只在显式启动或应用时读取。Provider、模型、Prompt、新增 Chat 与部分 Agent 字段可热应用；删除 allowlist Chat、MCP、Admin、路径和大多数结构变化要重启。详细操作见 [配置文件与密钥](../configure/config-file.md)，逐字段请下载 Schema。
