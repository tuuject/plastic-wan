---
title: CLI 参考
description: Plastic Wan 的服务、配置校验、诊断、备份命令，以及 Invocation 调试客户端。
---

# CLI 参考

服务命令显式指定配置路径；下文的调试客户端改用 endpoint 与 API key。配置和密钥错误信息会尝试脱敏，但仍不要将完整日志公开。

## 服务与校验

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc --takeover
```

`check-config` 仅验证 JSONC、语义和引用，输出配置哈希，不连接外部服务。`serve` 启动 Telegram long polling；成功日志包含 `serve_started`。`--takeover` 仅用于替换持有同一数据目录锁的本地实例，会请求旧实例优雅退出，不能作为生产 supervisor 的替代。

## 真实诊断与备份

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
node src/cli.ts backup --config /path/to/config.jsonc
```

`doctor` 会探测 SQLite、媒体依赖、Telegram、Provider、Vision 与 required MCP，并可能消耗 Provider Token；不要把它当离线检查。`backup` 执行保留清理、SQLite 备份与轮换；之后仍应在隔离环境验证恢复。

## 交互式配置

```bash
node src/cli.ts configure --config /path/to/config.jsonc
```

`configure` 只能在 TTY 中编辑已有、可加载的配置；它不是无人值守初始化器，也不适合让部署 Agent 自动调用。

## Docker 等价命令

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

这些一次性命令不启动 `serve`，可与正在运行的服务共存；不要用 `docker compose run` 再启动一个 `serve`。

## Invocation 调试客户端（plasticwan-debug）

`packages/cli` 提供一个私有、尚未发布到 npm 的调试客户端 `plasticwan-debug`，用于查询与重放 Invocation。它只覆盖 `invocation list` / `get` / `replay` 三个子命令，不包含 SDK、密钥管理或完整 Eval 能力。

从源码检出构建与安装（Node.js ≥ 24，无额外运行时依赖）：

```bash
pnpm cli:build                        # 输出 packages/cli/dist
pnpm --filter @plasticwan/cli pack    # 生成可安装的 tarball（会先自动构建）
npm install -g <打包生成的 tarball 路径>
```

不想全局安装时，也可以直接运行构建产物：`node packages/cli/dist/bin.js …`。

客户端用 API key 认证。面板目前没有密钥管理界面，需要在已登录的浏览器控制台创建，见[使用管理面板](../configure/admin.md#api-密钥)；密钥只覆盖 Invocation 查询与重放。

```bash
export PLASTICWAN_ENDPOINT=https://admin.example.com   # 必填；明文 http 只允许本机
export PLASTICWAN_API_KEY=pwk_...                      # 推荐环境变量，避免进入 shell 历史

plasticwan-debug invocation list --limit 20 --state completed --chat -1001234567890 --json
plasticwan-debug invocation list --cursor 12345 --json
plasticwan-debug invocation get 12345 --json
plasticwan-debug invocation replay 12345 --json
plasticwan-debug invocation replay 12345 --system-prompt prompt.txt --json
printf '%s' '临时替换的 system prompt' | plasticwan-debug invocation replay 12345 --system-prompt - --json
```

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `PLASTICWAN_ENDPOINT` | Admin Panel 基地址，必填；明文 `http` 只允许 loopback（`127.0.0.0/8`、`::1`、`localhost`），远端必须 `https`；URL 不能带凭据、query 或 fragment |
| `--api-key <key>` / `PLASTICWAN_API_KEY` | API key，必填；命令行参数优先于环境变量 |
| `--timeout-ms <ms>` | 请求超时；默认 list/get 30 秒、replay 300 秒。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时中止请求，均不自动重试 |
| `--json` | stdout 恰好一个 JSON 文档；人类模式输出列表摘要或缩进 JSON |
| `--limit`（1–100）/ `--cursor` / `--state` / `--chat` | `invocation list` 的过滤参数，发出前先做形状校验 |
| `--system-prompt <file\|->` | 仅 `invocation replay`；`-` 表示从标准输入读取（标准输入是终端时会拒绝），内容不能为空、最多 64Ki 字符 |

失败时 stderr 输出 `{"error":"<code>","message":"<message>"}`，错误信息经 key 脱敏，密钥不会出现在任何输出中；退出码 `0` 表示成功、`1` 表示请求/服务端/replay 失败、`2` 表示参数或输入不合法。请求不跟随重定向；响应体超过 4 MiB 会被拒绝。重放不会发送 Telegram 消息，也不修改生产会话与业务数据（鉴权仍会更新密钥使用时间），但它会真实调用模型并计费，限制与注意事项见[使用管理面板](../configure/admin.md#invocation-重放)。
