<div align="center">
  <img src="assets/readme/logo.jpg" width="128" height="128" alt="塑料碗 Logo" />

  <h1>塑料碗（Plastic Wan）</h1>

  <p>让你的赛博 OC 出门玩！</p>
  <p>可以自行部署、使用自己的 API Key 的 Telegram Agent Bot。<br />为私聊、群组与 Forum Topic 配置人格、记忆和参与边界。</p>

  <p>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2024-417e38?logo=nodedotjs&logoColor=white" alt="Node.js ≥ 24" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-ESM-3178c6?logo=typescript&logoColor=white" alt="TypeScript ESM" /></a>
    <a href="https://core.telegram.org/bots"><img src="https://img.shields.io/badge/Telegram-Agent%20Bot-26a5e4?logo=telegram&logoColor=white" alt="Telegram Agent Bot" /></a>
    <a href="https://github.com/tuuject/plastic-wan/pkgs/container/plastic-wan"><img src="https://img.shields.io/badge/Docker-GHCR-2496ed?logo=docker&logoColor=white" alt="Docker image on GHCR" /></a>
  </p>

  <p>
    <a href="#使用前须知">使用前须知</a> |
    <a href="#快速开始">快速开始</a> |
    <a href="apps/docs/content/docs/index.md">使用文档</a> |
    <a href="https://github.com/tuuject/plastic-wan/issues">反馈问题</a>
  </p>

  <img src="assets/readme/cover.jpg" width="900" alt="塑料碗主题插画：紫色调的角色、工作台与聊天屏幕" />
  <p><sub>主题插画，用来表达塑料碗的氛围；不是实际管理面板截图。</sub></p>
</div>

---

## 塑料碗是什么？

塑料碗是一个运行在 Telegram 日常对话里的 Agent Bot，可以根据对话内容自主决定是否参与互动。

它不是「一问一答」的机器人：Bot 会把短时间内的几条消息攒成一批，连同之前的聊天上下文交给模型，由模型判断要不要接话、怎么接。人格和说话方式写在 Prompt 里。

塑料碗采用 BYOK（Bring Your Own Key）方式：你需要自行部署 Bot、选择模型并承担 API 费用。项目不提供 SaaS 服务或模型额度。

## 用起来是什么样

把 Bot 拉进群、加入白名单以后，大家照常聊天就行。下面是一段真实群聊记录（群友已匿名；Bot 的口吻来自它的人格 Prompt）：

```text
> 群友 A 🐺:
大碗深夜还在Approve
顺便暴露了我也没睡

> 塑料碗:
凌晨两点半了诶，谁都别说谁捏……快去睡啦喵🥺

> 群友 B:
🐺大晚上不睡觉

> 群友 C:
gpt 这玩意真喜欢过度设计过度防御

> 群友 D:
gpt 是这样的
（⬆️ 这一批消息模型认为不用接，保持沉默）

> tcdw (aka. 碗):
其实我感觉 GPT 的性格有点像我（悲

> tcdw (aka. 碗):
虽然我现在开始感觉我的一些性格不一定是好东西了
（⬆️ 聚合窗口结束，这两条一起交给模型）

> 塑料碗:
咱也说不出什么大道理，就……在这儿陪你待一会儿吧喵🥺
```

所以 **Bot 没回复不一定是故障**，可能只是模型选择了沉默。整个流程是这样的：

```text
Telegram 消息
  → Chat / Topic 白名单与参与规则
  → 消息入库与时间窗口聚合
  → 会话上下文 + 人格 Prompt + 受限工具
  → 模型决定参与或沉默
  → 模型调用 send 工具（普通模型文本不会自动发出）
  → Telegram
```

群里还可以用这些命令：

| 命令 | 谁能用 | 作用 |
| --- | --- | --- |
| `/status` | 所有人 | 查看当前模型、thinking effort 和今日 token 用量 |
| `/ignoreme`、`/unignoreme` | 所有人 | 让 Bot 忽略或恢复接收自己在本 Chat 的消息 |
| `/whoami` | 所有人 | 查看自己的 Telegram 数字 ID |
| `/pause`、`/resume` | Bot 管理员 | 暂停或恢复本群互动 |
| `/model` | Bot 管理员 | 查看或切换模型 |

完整命令与管理员配置见 [Telegram 接入](apps/docs/content/docs/configure/telegram.md#管理员命令与验证)。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 私聊与群聊 | 支持私聊、群组和带话题（Topic）的论坛群；只在你允许的 Chat 和话题里工作。 |
| 人格配置 | 用 Prompt 定义说话方式；不同 Chat 可以用不同的指令和模型。 |
| 群聊参与 | 可设置活跃时段、触发关键词；时段外也能被 @ 或回复唤醒。 |
| 连续上下文与记忆 | 会话上下文跨重启保留；Bot 能自己记下短期记忆，到期自动遗忘；长期知识由你审核后写入。 |
| 图片与 Sticker | 看懂图片和 Sticker；可选接入图片生成与编辑。 |
| 工具与扩展 | 网页读取、定时提醒，以及受限的 MCP 工具；不向模型开放 Shell 或任意代码执行。 |
| 本地管理面板 | 查看消息、模型调用、工具执行与用量，管理记忆和模型；部分配置可以不重启直接生效。 |
| 数据与运维 | SQLite 存储；`backup` 命令按保留期清理旧数据并生成备份；提供配置检查和依赖诊断。 |

使用指南：[人格](apps/docs/content/docs/guides/personality.md)、[群聊参与](apps/docs/content/docs/guides/participation.md)、[记忆](apps/docs/content/docs/guides/memory.md)、[图片能力](apps/docs/content/docs/guides/images.md)、[扩展](apps/docs/content/docs/guides/extensions.md)

## 使用前须知

### 费用：BYOK 与 Coding Plan

模型费用是塑料碗最大的使用门槛之一。即使选择单价较低的模型，持续运行的费用也可能超过一些人的承受范围。

至于为什么不直接用 Coding Plan，我考虑的是这类订阅套餐面向交互式编程任务，而塑料碗由群消息唤起，可能全天运行。两种用法的数据用途、自动化权限和配额机制都可能不同，所以即使技术上能接入，也需要先确认服务商的条款允许这种使用方式。

- 自动化调用、非编程任务、数据使用和额度限制，都要以所选服务商当前的条款为准，需要分别核对。
- 加入的群数量、群内消息频率、模型选择、上下文和工具使用情况都会影响实际消耗，所以没法给出统一的月费。
- 消息聚合、参与时段、上下文裁剪和预算限制可以约束用量，但不能保证零成本；服务商侧的余额和账单也需要单独检查。

可以先从一个 Chat、明确的参与时段和可接受的预算开始，再根据审计记录里的实际用量调整。具体配置见[预算与限流](apps/docs/content/docs/guides/budgets.md)。

<details>
<summary>查看作者心得原文</summary>

<img src="assets/readme/author-notes.png" width="720" alt="作者关于 BYOK 模型成本、Coding Plan 使用边界和群聊自动化用量的心得截图" />

</details>

### 数据与安全边界

- 即使自行部署，消息、上下文和图片仍会按配置发送给你选择的模型和外部工具服务。**接入群聊前，请告知参与者并核对服务商的数据政策。**
- 在线数据按 `retention.online_days` 保留，过期数据在运行 `backup` 时清理（见 [备份与恢复](apps/docs/content/docs/operations/backup-restore.md)）；备份文件和模型服务商那边保存的数据需要你分别管理。
- 模型没有任意文件系统或 Shell 权限；图片等媒体只能在所属会话内引用，并会过期；MCP 工具受配置与运行时策略约束。

管理面板的访问边界见 [管理面板指南](apps/docs/content/docs/configure/admin.md)。

## 快速开始

推荐使用 GHCR 上的 Docker 镜像部署。镜像已经包含 Node.js、媒体转换依赖和管理面板，本机只需要 Docker Compose。想直接用 Node.js 在本机运行，见 [部署方式与环境要求](apps/docs/content/docs/start/installation.md#宿主机运行)。

开始前还需要：

- 一个 Telegram Bot：通过 [@BotFather](https://t.me/BotFather) 创建；群聊中要确认它能收到目标消息（见 [Telegram 接入](apps/docs/content/docs/configure/telegram.md)）。
- 一个模型服务的 API Key。

### 1. 准备配置

创建部署目录：

```bash
mkdir -p plastic-wan/config plastic-wan/data
cd plastic-wan
```

从仓库下载下面三个文件，按表中的位置保存：

| 文件 | 保存位置 |
| --- | --- |
| [Compose 模板](docker-compose.yml) | `docker-compose.yml` |
| [配置示例](apps/docs/examples/config.example.jsonc) | `config/config.jsonc` |
| [人格 Prompt 示例](apps/docs/examples/system-prompt.example.md) | `config/system-prompt.md` |

Compose 模板默认使用 `ghcr.io/tuuject/plastic-wan:latest`。如果要固定版本，把 `image` 改成对应的发布标签，并使用同一版本的配置示例。

然后编辑 `config/config.jsonc`：

- 把 `telegram.chats[0].id` 改为允许的 Chat ID；私聊通常为正数，群/Supergroup 通常为负数。
- 填入 Provider 的 `base_url`、`api` 和模型信息，并同步修改 `agent.model`、`vision.model`。示例中的模型 ID 和地址是占位符，需要换成服务商实际提供的值。
- 保留容器内的 `/data` 路径；人格写在 `config/system-prompt.md` 中。
- **首次不使用图片生成时，删除整个可选的 `image` 段。** 图片理解与图片生成是不同能力；需要生成图片时，再按[图片指南](apps/docs/content/docs/guides/images.md)配置。

如果需要在浏览器中访问管理面板，取消 `docker-compose.yml` 中 `ports` 段的注释；配置示例里的 `admin.host` 已经是容器所需的 `0.0.0.0`。端口只会发布到本机的 `127.0.0.1:8787`。

### 2. 提供密钥

配置示例通过环境变量读取密钥。取消 `docker-compose.yml` 中 `TELEGRAM_BOT_TOKEN` 和 `PLASTICWAN_API_KEY` 两行的注释，然后在运行 Compose 的终端中设置它们，或由部署系统注入：

```bash
export TELEGRAM_BOT_TOKEN='替换为自己的 Bot Token'
export PLASTICWAN_API_KEY='替换为自己的模型 API Key'
```

真实密钥不要写进 Compose 或 `config.jsonc`，也不要提交到仓库或发到聊天里。也可以改用配置同目录的 `key.json`，详见 [配置文件与密钥](apps/docs/content/docs/configure/config-file.md)。

### 3. 检查配置并启动

```bash
docker compose pull
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose up -d
docker compose logs -f plasticwan
```

`check-config` 只校验配置，成功以后再启动。如果需要检查实际依赖和外部连接，可以运行 `docker compose run --rm plasticwan doctor --config /config/config.jsonc`（会调用模型，消耗少量 Token）。

日志出现 **`serve_started`** 后，向允许的 Chat 发消息，等待消息聚合窗口（示例配置为 15 秒）。没有回复时，排查方法见 [故障处理](apps/docs/content/docs/operations/troubleshooting.md)。

启用端口发布后，访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)，首次访问时创建管理员账号。远程访问可以使用 SSH 隧道，或配置好 TLS 与访问控制的反向代理。

> [!WARNING]
> **同一个数据目录只能运行一个实例。** 不要绕过 `serve.lock`，也不要让多个进程同时轮询同一个 Bot。

## 文档

| 想做什么 | 从这里开始 |
| --- | --- |
| 选择模型、配置不同会话 | [模型配置](apps/docs/content/docs/configure/models.md)、[按 Chat 配置](apps/docs/content/docs/guides/per-chat.md) |
| 调整人格、参与时机与预算 | [人格](apps/docs/content/docs/guides/personality.md)、[参与规则](apps/docs/content/docs/guides/participation.md)、[预算](apps/docs/content/docs/guides/budgets.md) |
| 升级、备份与恢复 | [升级](apps/docs/content/docs/operations/upgrade.md)、[备份与恢复](apps/docs/content/docs/operations/backup-restore.md) |
| 浏览完整文档 | [使用文档首页](apps/docs/content/docs/index.md) |

## 参与贡献

欢迎提交 Issue 或 Pull Request。报告问题时请提供源码提交或镜像版本、复现步骤、期望与实际行为，以及脱敏日志；**不要附上 Bot Token、API Key、真实 `key.json`、数据库或私聊记录**。

修改代码前请先看 [CONTRIBUTING.md](CONTRIBUTING.md)，里面有开发环境、检查命令和仓库结构。

## 许可证

项目采用 [Apache License 2.0](LICENSE)，管理面板单独采用 [MIT License](apps/admin-next/LICENSE)。本页使用的 Logo、主题插画与心得截图均由我提供。
