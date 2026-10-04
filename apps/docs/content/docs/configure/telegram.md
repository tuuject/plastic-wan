---
title: 接入 Telegram 群组与 Topic
description: 创建 Bot，配置允许的 Chat、群聊消息可见性和 Forum Topic 范围。
---

# 接入 Telegram 群组与 Topic

## 创建 Bot 并保护 Token

Telegram 官方 FAQ 指引开发者通过 [@BotFather](https://t.me/BotFather) 创建 Bot，再连接自己的后端。把获得的 Token 仅注入 `TELEGRAM_BOT_TOKEN` 等受控环境变量，绝不贴到配置、日志、截图或 Agent 对话。

## 让 Bot 能看见需要的消息

私聊消息对 Bot 可见。群中，Telegram 的隐私模式会限制 Bot 接收的消息；官方 FAQ 说明关闭隐私模式或将 Bot 设为管理员时，Bot 可收到除其他 Bot 消息外的群消息。按你的最小权限需求在 BotFather/群设置中调整，再测试一条普通成员消息。

即使 Telegram 已投递，Plastic Wan 仍只处理 `telegram.chats` allowlist 中的 Chat。它默认不处理其他 Bot 的消息。

## 配置一个私聊或群

在完整配置中添加 Chat ID：

```jsonc
{
  "telegram": {
    "chats": [
      { "id": 123456789 },
      { "id": -1001234567890, "topic_ids": [100, 200] }
    ]
  }
}
```

- Chat ID 必须唯一且非零；私聊为正数，群/Supergroup 通常为负数。
- 不写 `topic_ids` 时允许该 Chat 的普通消息和全部 Topic。
- 写入非空 `topic_ids` 时只允许列出的正整数 Topic ID。
- Forum Topic 的对话与记忆按 Chat + Topic 隔离；模型与参与策略仍是 Chat 级配置。

修改 allowlist、Topic 或增删 Chat 后运行 `check-config` 并重启服务。Chat 变更未重启前仍可能出现 `chat_not_allowed`。

## 管理员命令与验证

`telegram.admins` 中的 Telegram 用户可以使用 `/pause`、`/resume`、`/model`、`/cut_topic`。名单由 `config.jsonc` 的 `telegram.admins` 字段管理，修改后可热应用，无需重启。先在目标 Chat 发送一条测试消息，检查 `serve_started` 后的审计记录；“Bot 在线”不等于消息被允许，也不等于模型一定发言。

若需限制群内唤醒时段，参阅 [参与方式](../guides/participation.md)。
