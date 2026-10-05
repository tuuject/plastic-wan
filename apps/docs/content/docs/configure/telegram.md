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

修改 allowlist 后运行 `check-config`。新增 Chat 立即生效，无需重启；删除 Chat 与修改 Topic 范围后需要重启服务，变更未重启前仍可能出现 `chat_not_allowed`。

## 管理员命令与验证

`telegram.admins` 中的 Telegram 用户可以使用 `/pause`、`/resume`、`/model`、`/cut_topic`、`/allowlist`。名单由 `config.jsonc` 的 `telegram.admins` 字段管理，修改后可热应用，无需重启。先在目标 Chat 发送一条测试消息，检查 `serve_started` 后的审计记录；“Bot 在线”不等于消息被允许，也不等于模型一定发言。

`/allowlist` 把 Bot 当前所在的 Chat（通常是刚把它拉进的新群）追加进 `telegram.chats` 并立即生效，无需重启。它是唯一能在未列入 allowlist 的 Chat 里使用的命令，且仅限 `telegram.admins` 中的用户：非管理员的 `/allowlist` 会被静默忽略。

服务启动时会先处理停机期间 Telegram 积压的消息：其中 `/pause`、`/resume` 按消息顺序执行，仍需通过同样的管理员、Chat/Topic 与发送者校验，不补发旧命令回复。其他已识别命令（包括 `/allowlist`、`/model` 和自助忽略命令）只保留审计，不重放操作，也不会作为聊天内容交给模型；启动后需要重新发送这些命令。

任何成员都可以发送 `/whoami`，Bot 会回复发送者的 Telegram 数字 ID，可直接用于填写 `telegram.admins`。

## 自助忽略与恢复

在已允许的 Chat/Topic 中，用个人账号发送：

| 命令 | 效果 |
| --- | --- |
| `/ignoreme` | 将自己的 Telegram User ID 加入当前 Chat 的 `ignored_user_ids`，立即忽略之后的消息。 |
| `/unignoreme` | 将自己的 ID 从列表移除，立即恢复接收。被忽略时也可以使用。 |

不需要管理员权限；命令只修改发送者自己，作用于该 Chat 的全部 Forum Topic，不影响其他 Chat。可加 `@Bot用户名` 指明目标 Bot。结果写回 `config.jsonc`，重启后仍保留；重复发送同一命令不会重复加入 ID。匿名身份不能使用。

管理员也可以直接编辑 `telegram.chats[].ignored_user_ids`（唯一的正安全整数数组），然后在面板点击 **Apply config file** 热应用。被忽略后的普通消息、编辑和其他命令不进入模型；已有消息与 Context 不会追溯删除，Update 审计仍保留。若命令提示“已写入，但应用失败”，运行中仍使用旧配置，修复配置后重新发送命令或在面板应用。

若需限制群内唤醒时段，参阅 [参与方式](../guides/participation.md)。
