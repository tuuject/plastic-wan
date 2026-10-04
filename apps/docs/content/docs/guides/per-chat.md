---
title: 为不同 Chat 设置模型与范围
description: 配置 Chat 或 Topic allowlist、每群模型覆盖，以及恢复全局默认。
---

# 为不同 Chat 设置模型与范围

全局 `agent` 是默认值；`telegram.chats[]` 可以限制 Chat/Topic，并为某个 Chat 覆盖 Provider、模型和 thinking level。覆盖属于 Chat，因此同一 Chat 下的所有 Forum Topic 共用它。

## 用 JSONC 配置 Chat

以下是局部片段（不是完整配置）：

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "topic_ids": [100, 200],
        "provider": "gateway",
        "model": "replace-with-your-text-and-image-model",
        "thinking_level": "off",
        "instructions_file": "prompts/group.md",
        "participation": { "active_windows": [] }
      },
      {
        "id": -1009876543210,
        "instructions_file": "prompts/social.md",
        "participation": {
          "active_windows": [{ "start": "18:00", "end": "23:00" }]
        }
      }
    ]
  }
}
```

模型引用沿用[完整示例](../configure/models.md)，请换成你已注册的真实模型。准备好两个附加指令文件。第一个群仅在被直接叫到或命中触发条件后打开注意力窗口；第二个群沿用全局模型，在晚间活跃。

不写 `topic_ids` 表示允许该 Chat 的普通消息和所有 Topic；写入后只允许列出的正整数 Topic。`provider` 与 `model` 必须成对出现，模型必须在该 Provider 的 `models` 中存在并支持 text。只写 `thinking_level` 则表示沿用全局模型、单独覆盖思考级别。

## 用 Admin Panel 编辑

1. 打开 **Chats**，确认当前配置文件 revision。
2. 新增或编辑 Chat，填写 Chat ID、Topic ID 列表和需要的模型设置。
3. 保存后查看反馈：模型/thinking 覆盖可热应用；新增/删除 Chat 或改变 Topic 范围需要重启。
4. 要恢复继承全局，清除该 Chat 的 Provider、模型和 thinking 覆盖。

全局模型请在 **Models** 页切换；全局切换不会覆盖已有 Chat 的局部模型。Admin 的全局 **Set as agent** 或模型切换仍只改 `agent.*`。

## 何时生效

已有 Chat 的 `provider`、`model`、`thinking_level` 覆盖属于热更新，下一次 Invocation 使用新值，正在运行的 Invocation 继续使用启动时快照。新增 Chat 同样热应用、立即生效；删除 Chat 与 Topic 范围修改后必须重启。配置文件没有 watcher，手改后要在 Settings 点击 **Apply config file**，再按面板提示重启。

## 如何确认

- 在 Admin **Chats** 查看 `Saved settings` 与 `Running settings` 是否一致。
- `/status` 显示当前 Chat 的生效模型。
- 在 Tool session 的 Model call 中确认 Provider、模型和 thinking level；不要只根据配置文件判断运行中的旧 Invocation。
- 运行 `check-config` 可提前发现 Chat 模型引用或 thinking level 不兼容。

## 常见误区

- Topic allowlist 只控制消息是否进入；Topic 不会获得独立的模型预算或 Chat 配置。
- Chat 覆盖按字段继承：没有覆盖的字段仍来自全局默认。
- 变更 Topic 范围不会删除旧消息、Context、记忆或审计历史。
- 不要把 Chat ID 转成浮点数；配置和管理面板都使用安全整数语义。

相关页面：[Telegram 与 Topic](../configure/telegram.md)、[模型](../configure/models.md)、[管理面板](../configure/admin.md)、[快速开始](../start/quick-start.md)。
