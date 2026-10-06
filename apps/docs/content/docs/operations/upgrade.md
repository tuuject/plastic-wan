---
title: 升级与数据库迁移
description: 安全升级 Plastic Wan，并区分代码、配置和数据库变更。
---

# 升级与数据库迁移

升级前先记录当前源码提交、镜像标签、配置哈希和数据目录。数据库迁移、配置格式变化与镜像变更是不同步骤；迁移成功不表示可安全降级。

## 镜像标签

CI 在每次 push 时自动发布镜像到 `ghcr.io/tuuject/plastic-wan`，标签按来源区分：

| 标签 | 何时更新 |
| --- | --- |
| `latest` | 推送 `v*` 稳定版本 tag 时，同时发布 `<version>`（如 `1.2.3`）与 `<major>.<minor>`（如 `1.2`） |
| `<version>` / `<major>.<minor>` | 同上；固定具体版本可获得可复现部署 |
| `main` | 每次推送 `main` 分支，开发滚动版 |
| `0.0.0-next-<timestamp>` | 每次推送 `main` 时固定某次构建，并创建 GitHub pre-release |
| `develop` / `nightly` | 推送 `develop` 分支 |

`latest` 只跟随 `v*` 稳定 tag，不跟随 `main`；正式版本对应 GitHub Releases 中的非 pre-release 条目。本地镜像的实际版本可查：

```bash
docker image inspect ghcr.io/tuuject/plastic-wan:latest \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
```

## 推荐流程

1. 停止或维护窗口前，运行 [备份](backup-restore.md) 并将配置、Prompt 与密钥备份策略一并确认。
2. 拉取目标镜像（标签选择见上节）：

   ```bash
   docker compose pull
   ```

   从源码自行构建的用户改为 `docker build -t plasticwan:local .` 并让 compose 指向该镜像，其余步骤相同。
3. 对现有配置运行目标版本的校验：

   ```bash
   docker compose run --rm plasticwan check-config --config /config/config.jsonc
   ```

4. 替换正在运行的服务。Compose 可执行 `docker compose up -d`；确保不会并发启动第二个相同 `/data` 的 `serve`。
5. 跟踪日志，确认数据库迁移、`startup_catch_up_completed` 与 `serve_started`。检查新的配置哈希。
6. 向允许的 Chat 发一条受控测试消息，并在 Admin 审计中确认 Invocation 状态。

## 配置变化

先读取目标版本的配置参考和报错信息；不要为通过校验而盲目删字段。字段可能需要重启，热应用只处理白名单，详见 [配置文件与密钥](../configure/config-file.md)。

## 风险与恢复

升级前备份不是降级保证。若启动或迁移失败，保留失败日志和原数据副本，在隔离目录演练 [恢复](backup-restore.md)，而不是删除 SQLite、缓存或锁文件。具体旧版本迁移路径尚未在本指南环境中演练。

回滚镜像本身是安全的：把 compose 的 `image:` 指回上一个标签（或 pin 的 `0.0.0-next-*`）后 `docker compose up -d`。但数据库迁移不可自动降级——迁移后的 SQLite 需要用升级前备份恢复，这也是升级前先备份的原因。
