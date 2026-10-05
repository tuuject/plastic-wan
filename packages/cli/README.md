# @plasticwan/cli

Plastic Wan Admin API 的调试客户端，包内命令为 `plasticwan-debug`。目前是 monorepo 工作区包，**尚未发布**；只做 invocation 查询与重放，不包含 SDK、密钥管理或 Eval 能力。

## 构建

```bash
pnpm --filter @plasticwan/cli build   # tsc 输出到 packages/cli/dist
pnpm --filter @plasticwan/cli pack    # prepack 会先构建；产物含 dist 与 README
```

包以编译后的 ESM JavaScript 发布，Node.js ≥ 24；不新增任何运行时依赖（只用标准库 `node:util` parseArgs 与全局 `fetch`）。源码内的相对导入带 `.ts` 后缀，由 `rewriteRelativeImportExtensions` 在编译产物中改写为 `.js`，因此 `node_modules` 内不会出现 Node type stripping 拒绝的 `.ts` 文件。

## 用法

```bash
# endpoint 必须显式给出：admin.port 在配置里没有默认值，不猜端口
export PLASTICWAN_ENDPOINT=https://admin.example.com
export PLASTICWAN_API_KEY=...          # 推荐用环境变量，避免进入 shell 历史

plasticwan-debug invocation list --limit 20 --state completed --chat -1001234567890 --json
plasticwan-debug invocation list --cursor 12345 --json
plasticwan-debug invocation get 12345 --json
plasticwan-debug invocation replay 12345 --json
plasticwan-debug invocation replay 12345 --system-prompt prompt.txt --json
printf '%s' '临时替换的 system prompt' | plasticwan-debug invocation replay 12345 --system-prompt - --json
```

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `PLASTICWAN_ENDPOINT` | Admin Panel 基地址，必填。明文 `http` 仅允许 loopback（`127.0.0.0/8`、`::1`、`localhost`）；远端必须 `https`；禁止 URL 内凭据、query 与 fragment |
| `--api-key <key>` / `PLASTICWAN_API_KEY` | API key，必填；以 `Authorization: Bearer <key>` 发送。命令行参数优先级高于环境变量 |
| `--timeout-ms <ms>` | 请求超时；默认 list/get 30s，replay 300s。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时会中止请求，均**不自动重试** |
| `--json` | 稳定 JSON 输出；成功时 stdout 恰好一个 JSON 文档 |
| `--limit` / `--cursor` / `--state` / `--chat` | 透传给 `GET /api/invocations` 的过滤参数，本地先做形状校验（limit 1–100，id 为有符号 64 位十进制） |
| `--system-prompt <file\|->` | 仅 replay：`-` 表示从 stdin 读取；最多 64Ki 字符 |

## API 契约

| 命令 | 请求 | 成功响应形状 |
| --- | --- | --- |
| `invocation list` | `GET /api/invocations?limit&cursor&state&chat` | `{ items: [...], next_cursor: string \| null }` |
| `invocation get <id>` | `GET /api/invocations/<id>` | invocation 详情对象（含 `id: string`），原样输出 |
| `invocation replay <id>` | `POST /api/invocations/<id>/replay`，body `{}` 或 `{ "system_prompt": "..." }` | 对象；`error` 非 null 表示 replay 未完成 |

响应边界只做最小校验：必须是 JSON 对象，且 list 的 `items` 为数组、`next_cursor` 为字符串或 null；get 必须含字符串 `id`。响应体超过 4 MiB 会被拒绝。

## 输出与退出码

- 成功：stdout 一个 JSON 文档（`--json`）或简洁的人类可读输出。
- 失败：stderr 一个 JSON 文档 `{"error": "<code>", "message": "<message>"}`；错误信息经 key 脱敏，key 不会出现在任何输出中。
- replay 的响应即使 `error` 非 null 也会完整保留结构并写在 stdout，同时以非零退出码结束；stderr 仍是 JSON，`error` 为 `replay_failed`，`message` 以 `replay did not complete: ...` 开头。
- 退出码：`0` 成功，`1` 请求/服务端/replay 失败，`2` 参数或输入不合法。
- 请求不跟随重定向（`redirect: "error"`），只允许 `http(s)`，未知参数会直接报错而不是忽略。
