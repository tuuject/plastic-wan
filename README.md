<div align="center">
  <img src="assets/readme/logo.jpg" width="128" height="128" alt="塑料碗 Logo" />

  <h1>塑料碗（Plastic Wan）</h1>

  <p><strong>收到消息以后，由模型决定接话还是保持安静。</strong></p>
  <p>可以自行部署、使用自己的 API Key 的 Telegram Agent Bot。<br />为私聊、群组与 Forum Topic 配置人格、记忆和参与边界。</p>

  <p>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2024-417e38?logo=nodedotjs&logoColor=white" alt="Node.js ≥ 24" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-ESM-3178c6?logo=typescript&logoColor=white" alt="TypeScript ESM" /></a>
    <a href="https://core.telegram.org/bots"><img src="https://img.shields.io/badge/Telegram-Agent%20Bot-26a5e4?logo=telegram&logoColor=white" alt="Telegram Agent Bot" /></a>
    <a href="https://github.com/tuuject/plastic-wan/pkgs/container/plastic-wan"><img src="https://img.shields.io/badge/Docker-GHCR-2496ed?logo=docker&logoColor=white" alt="Docker image on GHCR" /></a>
  </p>

  <p>
    <a href="#快速开始">快速开始</a>
    <a href="apps/docs/content/docs/index.md">使用文档</a>
    <a href="#关于-byok成本与-coding-plan">作者的话</a>
    <a href="https://github.com/tuuject/plastic-wan/issues">反馈问题</a>
  </p>

  <img src="assets/readme/cover.jpg" width="900" alt="塑料碗主题插画：紫色调的角色、工作台与聊天屏幕" />
  <p><sub>主题插画，用来表达塑料碗的氛围；不是实际管理面板截图。</sub></p>
</div>

---

## 塑料碗是什么？

塑料碗是一个运行在 Telegram 日常对话里的 Agent Bot，可以根据对话内容决定什么时候参与，不必逐条回答消息。

它会把配置允许的会话中短时间内收到的消息放在一起，再由模型结合连续上下文决定是否参与。人格和表达方式通过 Prompt 配置；模型要把内容发到 Telegram 时，必须调用 `send` 工具，普通模型文本不会自动发布。

塑料碗采用 BYOK（Bring Your Own Key）的方式，需要你提供模型服务的 API Key，自行部署 Bot、选择模型并承担 API 费用（项目不提供 SaaS 服务或模型额度）。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 私聊与群聊 | 支持私聊、群组、Supergroup 和 Forum Topic；通过 Chat/Topic 白名单限定范围，按时间窗口聚合消息。 |
| 人格配置 | 用人格 Prompt 定义说话方式；可为不同 Chat 配置指令、模型与 thinking level。 |
| 群聊参与 | 可配置活跃时段、触发关键词和注意力窗口；时段外也可由直接 @ 或回复 Bot 唤醒。 |
| 连续上下文与记忆 | 会话上下文跨运行窗口持久化；短期记忆按会话隔离并支持 TTL，长期知识通过人工审核后的 `agents.md` 提供。 |
| 图片与 Sticker | 图片理解、Sticker 视觉索引；可选图片生成与编辑能力，生成结果可发送到当前会话。 |
| 工具与扩展 | 只读 System Skills、网页获取、Alarm 插件与受限 MCP 工具；不向模型暴露任意 Shell 或代码执行。 |
| 本地管理面板 | 审计消息、模型调用、工具执行、上下文与预算，管理记忆、模型及图片任务；部分配置支持热应用。 |
| 数据与运维 | SQLite 持久化，在线数据保留、备份与恢复流程，配置检查和真实依赖诊断。 |

使用指南：[人格](apps/docs/content/docs/guides/personality.md)、[群聊参与](apps/docs/content/docs/guides/participation.md)、[记忆](apps/docs/content/docs/guides/memory.md)、[图片能力](apps/docs/content/docs/guides/images.md)、[扩展](apps/docs/content/docs/guides/extensions.md)

## 关于 BYOK、成本与 Coding Plan

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

## 工作方式与安全边界

```text
Telegram 消息
  → Chat / Topic 白名单与参与规则
  → 消息入库与时间窗口聚合
  → 会话上下文 + 人格 Prompt + 受限工具
  → 模型决定参与或沉默
  → 显式 send 工具
  → Telegram
```

- 模型没有任意文件系统或 Shell 权限；媒体引用按会话授权并会过期，MCP 工具受配置与运行时策略约束。
- 即使自行部署，消息、上下文或图片仍会按配置发送给所选模型与外部工具服务，所以接入前需要告知参与者并核对数据政策。
- 在线数据按 `retention.online_days` 保留；备份和模型服务商保存的数据需要由部署者分别管理。
- **同一个数据目录只能有一个 `serve` 实例**，不要绕过锁或让多个进程争用 Telegram long polling。

架构细节见 [architecture.md](agent-doc/architecture.md)，管理面板边界见[管理面板指南](apps/docs/content/docs/configure/admin.md)。

## 开发

运行时使用 **Node.js 24+、TypeScript ESM、pnpm**；Node 直接执行 `.ts`。宿主机运行 Bot 还需 FFmpeg、FFprobe、Python 和 `lottie_convert.py`，详见[环境要求](apps/docs/content/docs/start/installation.md)。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test

# 两个独立的前端开发入口
pnpm run admin:dev
pnpm run docs:dev
```

Admin 开发服务默认监听 `127.0.0.1:5273`，需配合运行中的 Bot/Admin 后端；文档开发服务监听 `127.0.0.1:5274`。生产管理面板通过 `pnpm run admin:build` 构建，由 Bot 服务托管。

```text
src/                    Bot 运行时、调度、上下文、工具与 SQLite
apps/admin-next/        React 管理面板
apps/docs/              中文使用文档与安全配置示例
packages/image-service/ 图片生成核心包
agent-doc/              架构、配置、运维与维护者文档
scripts/                维护及验证脚本
test/                   行为测试
```

## 文档与参与

| 想做什么 | 从这里开始 |
| --- | --- |
| 部署自己的碗 | [快速开始](apps/docs/content/docs/start/quick-start.md) |
| 选择模型、配置不同会话 | [模型配置](apps/docs/content/docs/configure/models.md)、[按 Chat 配置](apps/docs/content/docs/guides/per-chat.md) |
| 调整人格、参与时机与预算 | [人格](apps/docs/content/docs/guides/personality.md)、[参与规则](apps/docs/content/docs/guides/participation.md)、[预算](apps/docs/content/docs/guides/budgets.md) |
| 升级、备份与恢复 | [升级](apps/docs/content/docs/operations/upgrade.md)、[备份与恢复](apps/docs/content/docs/operations/backup-restore.md) |
| 理解实现或贡献代码 | [维护者文档](agent-doc/README.md)、[仓库约定](AGENTS.md) |
| 本地浏览完整文档站 | [文档站开发说明](apps/docs/README.md) |

欢迎提交 Issue 或 Pull Request。报告问题时请提供源码提交或镜像版本、复现步骤、期望与实际行为，以及脱敏日志；**不要附上 Bot Token、API Key、真实 `key.json`、数据库或私聊记录**。

项目采用 [Apache License 2.0](LICENSE)。管理面板的独立许可证为 [MIT License](apps/admin-next/LICENSE)。本页使用的 Logo、主题插画与心得截图均由我提供。

## 快速开始

首次部署建议从当前源码构建 Docker 镜像，因为 Dockerfile 已经包含媒体转换依赖，这样也能避免远端镜像版本与当前文档不一致。

### 1. 拉取源码，准备配置

需要 Docker Compose、Telegram Bot Token，以及支持所配置 API 协议和文本/图片输入的模型服务。Bot 可通过 [@BotFather](https://t.me/BotFather) 创建。

```bash
git clone https://github.com/tuuject/plastic-wan.git
cd plastic-wan

mkdir -p config data
cp apps/docs/examples/config.example.jsonc config/config.jsonc
cp apps/docs/examples/system-prompt.example.md config/system-prompt.md
cp apps/docs/examples/compose.yml compose.yml
```

编辑 `config/config.jsonc`，至少完成以下几项：

- 把 `telegram.chats[0].id` 改为允许的 Chat ID；私聊通常为正数，群/Supergroup 通常为负数。
- 替换 Provider 的 `base_url`、`api` 和模型信息，并同步修改 `agent.model`、`vision.model`。示例中的模型 ID 和地址是占位符，不能直接运行。
- 保留容器内的 `/data` 路径；Prompt 文件放在 `config/` 中，按自己的需求修改人格。
- **首次不使用图片生成时，删除可选的整个 `image` 段。** 文本模型的图片理解与图片生成是不同能力；启用生成时另按[图片指南](apps/docs/content/docs/guides/images.md)配置凭据和模型，并将所需环境变量传入容器。

群聊还需确认 Bot 能收到目标消息，见 [Telegram 接入](apps/docs/content/docs/configure/telegram.md)。

### 2. 提供自己的密钥

在部署环境中设置下面两个变量，示例 Compose 会把它们传入容器。不要把真实密钥提交到仓库或发到聊天里。

```bash
export TELEGRAM_BOT_TOKEN='替换为自己的 Bot Token'
export PLASTICWAN_API_KEY='替换为自己的模型 API Key'
```

也可使用配置同目录的 `key.json` 和 SecretRef；详见[配置文件与密钥](apps/docs/content/docs/configure/config-file.md)。`config.jsonc` 本身不接受明文 Secret。

### 3. 构建、检查、启动

```bash
docker build -t plasticwan:local .
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose up -d
docker compose logs -f plasticwan
```

`check-config` 成功以后再启动。它只校验配置；如果需要检查实际依赖和外部连接，可以运行 `doctor`（会调用模型并消耗少量 Token）。

日志出现 **`serve_started`** 后，向允许的 Chat 发消息，等待配置的消息聚合窗口。**没有回复不一定是故障**：模型可以主动选择沉默，排查方法见[故障处理](apps/docs/content/docs/operations/troubleshooting.md)。

示例 Compose 将管理面板发布在 **[http://127.0.0.1:8787](http://127.0.0.1:8787)**，首次访问创建管理员账号。不要直接把管理端口公开到互联网；远程访问需使用 SSH 隧道或受控反向代理。

> 上面使用的是 `apps/docs/examples/compose.yml` 的本地构建方案。仓库根目录的 `docker-compose.yml` 则使用 `ghcr.io/tuuject/plastic-wan:latest`；使用预构建镜像时，应核对对应版本、配置及密钥注入方式，不要混用两套模板。

完整步骤：[第一次运行](apps/docs/content/docs/start/quick-start.md)、[环境要求与宿主机部署](apps/docs/content/docs/start/installation.md)

---

<div align="center">
  <sub>Plastic Wan 是可自行部署的 Telegram Agent Bot</sub>
</div>
