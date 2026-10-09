---
title: 部署方式与环境要求
description: 选择 Docker 或宿主机运行塑料碗，并准备运行环境。
---

# 部署方式与环境要求

## 推荐：Docker 镜像

CI 把镜像发布到 `ghcr.io/tuuject/plastic-wan`，已包含 FFmpeg、FFprobe、Python 与 Lottie 转换依赖。部署步骤见 [快速开始](quick-start.md)，标签选择见 [升级](../operations/upgrade.md#镜像标签)。

需要运行未发布的提交或自行审计镜像时，可以在检出的仓库根目录构建，再把 `docker-compose.yml` 的 `image` 改为 `plasticwan:local`，其余步骤相同：

```bash
docker build -t plasticwan:local .
```

Compose 会把 `./config` 映射到 `/config`、`./data` 映射到 `/data`；配置中必须使用容器内绝对路径。Admin 端口应仅发布到 `127.0.0.1`，再通过受控反向代理提供远程访问。

容器以非特权用户运行，并会整理挂载目录权限。不要同时对相同 `/data` 启动第二个 `serve`；同一数据目录只能有一个轮询实例。

## 宿主机运行

宿主机路径适合开发或已有进程监督器的部署。前置条件：

- Node.js 24 或更高版本；
- FFmpeg、FFprobe、Python 与 `lottie_convert.py` 位于服务的 `PATH`；
- 可写的数据目录、Telegram Token、Provider API key。

拉取源码，安装依赖并构建图片核心包与管理面板，再复制配置示例：

```bash
git clone https://github.com/tuuject/plastic-wan.git
cd plastic-wan
pnpm install --frozen-lockfile
pnpm --filter @plasticwan/image-service build
pnpm run admin:build
mkdir -p config data
cp apps/docs/examples/config.example.jsonc config/config.jsonc
cp apps/docs/examples/system-prompt.example.md config/system-prompt.md
```

示例配置使用容器路径，需要改为本机路径：`data_dir` 设为 `./data`，`paths.database`、`paths.media_cache`、`paths.backups` 分别设为 `./data/plasticwan.sqlite`、`./data/media-cache`、`./data/backups`。Prompt 路径相对于配置文件目录，不用改。只在本机访问管理面板时，把 `admin.host` 改为 `127.0.0.1`。

在当前终端设置 `TELEGRAM_BOT_TOKEN` 和 `PLASTICWAN_API_KEY`。非 Windows 主机要求配置文件为 `0600`、其父目录为 `0700`：

```bash
chmod 700 config data
chmod 600 config/config.jsonc
```

验证配置后运行：

```bash
node src/cli.ts check-config --config config/config.jsonc
node src/cli.ts serve --config config/config.jsonc
```

生产环境应由 supervisor、容器平台或 systemd 等外部机制负责重启；仓库不提供服务单元。

## 生效与停止

启动完成以日志 `serve_started` 为准。前台运行时使用 `Ctrl+C` 正常停止；替换同一数据目录上的本地实例时使用 `serve --takeover`，不要手删 `serve.lock` 或强杀未知进程。

下一步：完成 [配置文件](../configure/config-file.md)，或查看 [升级](../operations/upgrade.md) 的安全流程。
