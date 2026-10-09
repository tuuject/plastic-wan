---
title: 第一次运行塑料碗
description: 用 GHCR 镜像和 Docker Compose 部署，配置 Telegram 和模型后启动 Bot。
---

# 第一次运行塑料碗

本路径使用 GHCR 上的预构建镜像，镜像已包含 Node.js、媒体转换依赖和管理面板。需要 Docker Compose、一个 Telegram Bot、可调用的文本和图片模型，以及你要允许的一个私聊或群聊。想从源码构建镜像或直接在宿主机运行，见 [部署方式与环境要求](installation.md)。

## 1. 准备目录与文件

创建部署目录：

```bash
mkdir -p plastic-wan/config plastic-wan/data
cd plastic-wan
```

下载下面三个文件，按表中的位置保存：

| 文件 | 保存位置 |
| --- | --- |
| [Compose 模板](__DOCS_BASE__/examples/docker-compose.yml) | `docker-compose.yml` |
| [配置示例](__DOCS_BASE__/examples/config.example.jsonc) | `config/config.jsonc` |
| [人格 Prompt 示例](__DOCS_BASE__/examples/system-prompt.example.md) | `config/system-prompt.md` |

Compose 模板使用 `ghcr.io/tuuject/plastic-wan:latest`，它只跟随稳定版本。本站描述的是构建时的源码提交，如果与稳定版不一致，把 `image` 改为对应的版本标签，标签说明见 [升级](../operations/upgrade.md#镜像标签)。

编辑 `config/config.jsonc`：

- 将 `telegram.chats[0].id` 改为允许使用 Bot 的 Chat ID；私聊 ID 为正数，群/Supergroup 通常为负数。
- 替换 Provider 的 `base_url`、模型 `id` 与显示名，并同步修改 `agent.model`、`vision.model`。模型必须真实存在，且同时支持 `text` 与 `image`；示例中的占位模型不可直接运行。
- 保留容器路径 `/data`，Prompt 文件与配置放在同一 `config/` 目录。
- 首次不使用图片生成时，删除整个可选的 `image` 段；需要时再按 [图片能力](../guides/images.md) 配置。

## 2. 安全提供密钥

配置示例通过环境变量读取密钥。取消 `docker-compose.yml` 中 `TELEGRAM_BOT_TOKEN` 和 `PLASTICWAN_API_KEY` 两行的注释，然后为当前 shell 设置它们，或由部署系统注入：

```bash
export TELEGRAM_BOT_TOKEN='…'
export PLASTICWAN_API_KEY='…'
```

不要把 Token 或 API key 写入配置、Compose 文件或聊天。Telegram 官方说明 Bot 由 [@BotFather](https://t.me/BotFather) 创建；不要将它返回的 Token 发给协助部署的 Agent。群聊需要 Bot 能收到你希望它处理的消息，见 [接入 Telegram](../configure/telegram.md)。

## 3. 拉取镜像并检查配置

```bash
docker compose pull
docker compose run --rm plasticwan check-config --config /config/config.jsonc
```

`check-config` 成功后才继续。它不连接 Telegram 或模型；需要真实连通性检查时，在获准消耗少量 Token 的环境运行 `doctor`。

## 4. 启动并验证

```bash
docker compose up -d
docker compose logs -f plasticwan
```

日志出现 `serve_started` 表示服务已开始轮询。向允许的 Chat 发送一条消息，等待配置的 `bucket_window_seconds`。模型可以选择沉默；要区分未触发与主动不发言，请看 [排查问题](../operations/troubleshooting.md)。

要从浏览器访问管理面板，取消 `docker-compose.yml` 中 `ports` 段的注释后重新 `docker compose up -d`；配置示例的 `admin.host` 已是容器所需的 `0.0.0.0`，端口只发布到 `127.0.0.1:8787`。首次访问创建本地管理员账号。不要把该端口直接公开到互联网，见 [管理面板](../configure/admin.md)。

## 下一步

- 调整 Prompt：[配置文件与密钥](../configure/config-file.md)
- 为群或 Topic 设置边界：[Telegram 接入](../configure/telegram.md)
- 了解模型和预算：[模型](../configure/models.md) 与 [配置参考](../reference/config.md)
