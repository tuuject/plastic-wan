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

「清除此前记录的原始请求报文」需要二次确认，只清除模型调用的请求/响应快照。调用记录、关联关系和统计保留；详情页会显示报文未记录或已清除。记录开关仍开启时，新报文会继续保存。清除按批执行；若中途失败，已完成的批次不会恢复，可重试清除。

SQLite 释放的页可供后续写入复用，但数据库文件不一定立即缩小。此操作不会执行 `VACUUM`，也不清理已有备份；备份与恢复仍遵循[原有维护流程](../operations/backup-restore.md)。

## 验证与风险

启动日志需要有 `admin_started`。设置页面显示“已保存”不一定等于运行中已使用：若有待重启字段，确认外部监督器已重启服务后再检查配置哈希。不要共享面板密码、Cookie 或从浏览器导出的请求。

面板打不开时，请看 [排查问题](../operations/troubleshooting.md)。
