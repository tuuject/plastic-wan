# 运行与运维

## 运行时依赖

必需：

- Node.js ≥24.0（type stripping 默认开启，直接执行 `.ts`）
- FFmpeg 与 FFprobe
- Python
- `lottie` Python package，提供 `lottie_convert.py`
- Provider API key
- Telegram Bot Token

数据层使用 `better-sqlite3`（原生模块，随 `pnpm install` 安装）。官方为 Node LTS 提供预编译二进制；没有匹配的预编译包时会回退到本地源码编译，此时需要 `python3`、`make` 与 C++ 工具链（Docker 镜像已在 builder 阶段预置）。

macOS（Homebrew）：

```bash
brew install ffmpeg python
python3 -m pip install --user lottie
```

Debian/Ubuntu：

```bash
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --user lottie
```

Linux/macOS 要求 `lottie_convert.py` 本身在服务 PATH 中（`pip --user` 装到 `~/.local/bin`，确认它在 PATH 里）。Windows 是次要开发环境：`scoop install ffmpeg-essentials python` 后 `python -m pip install lottie`，运行时通过 Python 执行 `lottie_convert.py`。

安装后确认 `ffmpeg`、`ffprobe`、`lottie_convert.py` 都能解析。TGS 流程先导出 SVG 再交给 Sharp，因此不需要 CairoSVG、Pillow 或 Glaxnimate。

## 初始化开发环境

```bash
cd ~/Projects/plasticwan
pnpm install

# 本地 Secret 写进仓库根目录的 .env.local（已 gitignore；CLI 启动时自动加载
# .env.local 与 .env，真实环境变量优先、.env.local 压过 .env），或在 shell 里 export。
node src/cli.ts check-config --config dev-data/config.jsonc
node src/cli.ts doctor --config dev-data/config.jsonc
```

`dev-data/config.jsonc`、`dev-data/key.json`、数据库、媒体和备份已由 `.gitignore` 排除（任意位置的 `key.json` 也被排除）。`config.jsonc` 不含 Secret，排查配置时读它即可；Secret 值只在 `key.json`、环境变量或外部命令里，不要读取或复制到受版本控制的示例或文档。

## 启动与停止

```bash
node src/cli.ts serve --config dev-data/config.jsonc
```

成功标志依次包含启动追赶完成与常规轮询启动：

```json
{"event":"startup_catch_up_completed","updates":0,"stored_messages":0,"invocations":0,"at":"..."}
{"event":"serve_started","bot_id":"...","config_hash":"...","at":"..."}
```

人工前台运行使用 `Ctrl+C`。服务会：

1. 停止 Telegram long polling。
2. 停止 Admin Panel HTTP server。
3. 最多等待 Scheduler 30 秒。
4. 停止 Sticker worker 与 MCP。
5. 关闭 SQLite。
6. 释放 `serve.lock`。

不要启动第二份实例。同一 `data_dir` 的 `serve.lock` 会拒绝双实例；绕过锁会造成 Telegram long polling 竞争和未知副作用。需要替换运行中的实例时用下面的 `--takeover`。

### 接管已运行的实例

```bash
node src/cli.ts serve --config dev-data/config.jsonc --takeover
```

`--takeover` 用于本地调试时替换同一个 `data_dir` 上的实例。它先完成启动流程中不需要锁的那部分校验（配置权限、完整 `loadConfig`、Telegram token 解析），通过后向 `data_dir` 写一个 `serve.stop` 请求文件，再等待对方释放 `serve.lock`，日志 `takeover_completed` 带被停实例的 PID。被接管的实例在轮询中看到请求后先记录 `takeover_requested`，然后走上面同一套优雅关闭流程（随后出现 `shutdown_requested`）。

请求是文件而不是信号：Windows 没有可捕获的 `SIGTERM`，只有目标进程自己能跑关闭流程。对方 60 秒内没有释放锁（PID 被复用、进程卡住）时接管方报错退出，不会强杀；这一步也不会误伤其它进程——写下的请求文件只有持有该 `data_dir` 锁的进程会读，接管方在返回前把它清掉，下次启动时残留的请求文件会被丢弃而不是照做。

两点边界：

- 被接管的进程按正常退出结束（退出码 0，不是重启码 75）。有 supervisor 的部署不要用 `--takeover`：supervisor 会把退出的进程重新拉起，与新实例抢锁。
- 只处理持有**同一 `data_dir` 锁**的实例。用其它 `data_dir`（例如另写一份配置）启动的实例不会被发现，它与新实例的冲突表现为 Telegram long polling 的 409。

### 立即重启与进程监督

Admin Panel 的 Models / Chats 页在有字段等待重启时提供「立即重启」（`POST /api/restart`）。它不是 supervisor，只是请求当前进程优雅退出：走上面同一套关闭流程，然后以退出码 **75**（`EX_TEMPFAIL`，与崩溃区分）退出，由外部把进程重新拉起。重启期间 Admin 页面会断开，界面轮询等待服务恢复；这段时间收到的 Telegram 消息由启动补偿拉取。

只有部署方声明了监督时这个端点才可用：环境变量 `PLASTICWAN_SUPERVISED=1` 未设置时端点返回 409 `restart_unsupported`，界面也不显示按钮。**声明的位置是部署，不是镜像**：`Dockerfile` 故意不设这个变量（镜像无法知道自己会不会带着重启策略跑），`docker-compose.yml` 模板在 `restart: unless-stopped` 旁边设好了；用 `docker run` 的话要自己同时给出 `--restart` 和 `-e PLASTICWAN_SUPERVISED=1`，systemd 则配合 `Restart=always`。Electron 版由主进程重启 server。裸机前台运行时不要设置它，否则退出后不会有人把 bot 拉起来。

执行前会按启动流程校验磁盘上的配置（权限检查与完整 `loadConfig`）：配置无效时拒绝重启并返回 422，否则进程退出后起不来，bot 就停了。本期没有「上次可用配置」回退，启动期才失败的情况（SecretRef 解析失败、Pi 升级导致 builtin 模型消失等）仍然需要人工修复。

## 配置变更

白名单字段可以热应用，其余字段不热重载。白名单（agent 模型、Provider 的全部字段——连接字段、模型列表与增删、vision 模型、Prompt、已有 Chat 的 `provider`/`model`/`thinking_level` 覆盖和 `ignored_user_ids`、预算与并发等）在改完文件后，用 Admin Panel 的「Apply config file」、Models / Chats 页的保存操作或 Telegram 的 `/model` 触发一次应用，不必重启；成员的 `/ignoreme`、`/unignoreme` 会写回自己的忽略设置并热应用同一配置文件。清单与语义见 [configuration.md](configuration.md#运行时配置热更新)。其它字段（allowlist 的删除与 Topic 范围、MCP、`admin.*`、`vision.max_concurrency` 等）变更后：

```bash
node src/cli.ts check-config --config dev-data/config.jsonc
# 停止旧进程
node src/cli.ts serve --config dev-data/config.jsonc
```

必须确认新 `serve_started.config_hash` 与 `check-config.config_hash` 一致；热应用后则看 `config_reloaded` 日志事件里的 `active_hash` / `file_hash`。Chat 已写入文件但仍出现 `chat_not_allowed` 时，首先检查旧进程是否仍使用旧哈希。

## Doctor

```bash
node src/cli.ts doctor --config dev-data/config.jsonc
```

Doctor 是对已配置运行环境执行的真实依赖检查，不是静态 lint；完整检查范围与何时可判定通过见[验证：Doctor](verification.md#doctor)。它会产生 `role = 'doctor'` 的模型调用审计并消耗少量 Provider Token。探针按全局默认与每个 Chat 实际选用的 provider/model/thinking 组合**去重后**逐一执行：同一组合只探测一次，新增 Chat 覆盖会引入新的探针并消耗相应 Token。

如需查看配置中 Agent 系统 Prompt 的模板渲染结果：

```bash
node src/cli.ts doctor --config dev-data/config.jsonc --output-agent-prompt
```

该选项仍会执行完整 Doctor 检查；成功 JSON 中增加 `agent_prompt` 字段。输出包含 Prompt 正文，但不会包含 Secret、Chat 记忆或 Chat-specific instructions。不要在共享日志中使用该选项。

## Admin API 工具客户端（Invocation 查询与重放）

[`packages/cli`](../packages/cli/README.md) 提供访问 Admin API 的工具客户端 `plasticwan-utils`（npm 包 `@tuuject/plasticwan-utils`；仓库根与其它工作区仍为 private），覆盖只读检查、当前模型目录、Invocation 查询/媒体导出/重放（含临时模型与 thinking 覆盖）。完整命令与选项以该包 README 为准。`login` 把 endpoint 与 API key 成对保存到本机凭据文件，不提供服务端密钥管理；客户端 `doctor` 只发一次只读请求检查 Admin API 连通与鉴权，不做服务端 Doctor 的 SQLite、媒体、Telegram、Provider 与 MCP 探针。Node.js ≥ 24，无运行时依赖；它与服务端入口 `plasticwan`（`node src/cli.ts`）不同，不含 serve/check-config/backup/configure 等服务命令，也不包含 SDK 或 Eval 能力。

```bash
npm install -g @tuuject/plasticwan-utils           # 稳定版（严格 vMAJOR.MINOR.PATCH tag，dist-tag latest）
npm install -g @tuuject/plasticwan-utils@canary    # main 每次 push 的 canary
```

发布尚未可用（`npm install` 报 404）时改用本地 tarball；也可以直接在源码检出中构建运行：

```bash
pnpm cli:build                         # 等价 pnpm --filter @tuuject/plasticwan-utils build，输出 packages/cli/dist
pnpm cli:check                         # 对 packages/cli 做 TypeScript 检查（不产出 JS）
pnpm --filter @tuuject/plasticwan-utils pack --pack-destination "$PWD/dist/npm"   # prepack 先构建，tarball 含 dist 与 README
npm install -g ./dist/npm/tuuject-plasticwan-utils-0.1.0.tgz                      # 文件名以实际输出为准
```

```bash
# 首次使用：面板 Manage → API keys 创建密钥，操作员在本机保存凭据并验证连通
plasticwan-utils login                 # 交互式逐项提示 endpoint 与隐藏输入的 API key
plasticwan-utils doctor --json         # 一次 GET /api/invocations?limit=1；退出码 0 且 status=ok 才继续

node packages/cli/dist/bin.js invocation list --limit 20 --state completed --chat -1001234567890 --json
plasticwan-utils invocation get 12345 --json                       # 全局安装后
plasticwan-utils invocation replay 12345 --json
plasticwan-utils invocation preflight 12345 --json
plasticwan-utils invocation prompts 12345 --json
plasticwan-utils invocation replay 12345 --global-prompt prompt.txt --json
printf '%s' '临时替换的 global prompt' | plasticwan-utils invocation replay 12345 --global-prompt - --json
```

- 凭据：`login` 把 endpoint 与 key 成对保存到固定路径 `~/.config/plasticwan-utils/credentials.json`（所有平台一致，与 Bot 的 `config.jsonc`/`key.json` 无关），文件未加密；POSIX 上目录 `0700`、文件 `0600`（更窄权限亦可），拒绝符号链接与不安全权限且不自动修复，Windows 不做 POSIX mode 检查、沿用用户目录 ACL（不承诺 `chmod` 级别的保护）；key 全来源统一为 1–4096 字符且禁空白/控制字符，序列化凭据超过 16384 字节拒绝，写入失败不覆盖旧凭据。`login` 不访问服务器，保存后必须跑 `doctor`。非交互时可用 `--endpoint` 加 `--api-key`/环境变量，或用 `--api-key-stdin`：login 把 stdin 读到 EOF（不是读完一行就停），累计不超过 4098 字节，读取结束后只去掉一个尾部 LF/CRLF，剩余换行/空白/控制字符非法（`invalid_api_key`，退出码 2；受 `--timeout-ms` 约束，超时 `timeout` 退出码 1，不保存），不能与 `--api-key`/环境变量 key 同时给出，不是 `--api-key -`；stdin 读取只限 login 的 key 与 replay 的 `--global-prompt -` / `--group-prompt -`。
- 凭据解析顺序（doctor 与 invocation list/get/replay 相同）：明确参数 > 环境变量 > 保存文件。参数或环境变量显式给出的空串按缺失/非法处理，不回退到下一来源或改为交互提示；endpoint 与 key 都明确给出时完全不读凭据文件（文件损坏或不安全也不影响），只给其一才读文件、文件问题以 `invalid_credentials`（退出码 1）失败。保存的 key 只用于与其规范化 endpoint 一致的地址：endpoint 经 `parseEndpoint` 规范化后不同且未显式给 key 时报 `missing_api_key`（不把文件 key 发往别的服务），规范化后一致时仍可复用；参数与环境变量不写回文件。
- `doctor --json` 按同一顺序解析凭据后恰好一次 `GET /api/invocations?limit=1`：没有 replay、没有模型/Provider 调用；成功输出 `{status:"ok",endpoint,credential_sources:{endpoint,api_key}}`，来源取值为 `argument`/`environment`/`file`；不输出 Invocation 正文，不发送 Telegram、不重试，鉴权仍会更新 key 的 `last_used_at`。失败走既有 JSON stderr 路径：参数/环境变量凭据缺失或不合法退出码 `2`，保存文件无效（`invalid_credentials`）或请求失败退出码 `1`。
- 发布由 `.github/workflows/npm.yml` 承担，独立于 Docker workflow：只有 `tuuject/surowan` 的 push 会发布，`main` 产出 canary（`0.0.0-canary.<run>.<attempt>.g<sha12>`，dist-tag `canary`），严格 `vMAJOR.MINOR.PATCH` tag 产出稳定版（dist-tag `latest`）；版本只在 CI checkout 内改写、不回写源码，用 OIDC 且没有 `NPM_TOKEN`；trusted publisher 只允许 `npm stage publish`，CI 产物进入待审批区，维护者 `npm stage approve`（2FA）后才对外发布。首次发布 bootstrap 与 trusted publisher 配置见 [packages/cli/README.md](../packages/cli/README.md#首次发布-bootstrap)：包必须先在 npm 上存在，之后手工打稳定 tag 才走 CI。Docker workflow 用 `GITHUB_TOKEN` 推送的 `v0.0.0-next-*` tag 不会触发它，手推 prerelease tag 会被版本 guard 拒绝。
- API key 只能在面板 Session 下创建：在面板 **Manage → API keys** 页（`/api-keys`）创建并取得唯一一次明文，也在同一页撤销（Bearer 密钥不能管理密钥，见 [admin-panel.md](admin-panel.md#程序化-api-密钥)）。本地 tarball 或 registry 全局安装后，直接用 `plasticwan-utils` 调用。
- endpoint 来自明确参数、环境变量或 `login` 保存的凭据文件；明文 `http` 仅允许 loopback（`127.0.0.0/8`、`::1`、`localhost`），远端必须 `https`，URL 不得带凭据、query 或 fragment。
- 请求不跟随重定向、不自动重试；默认超时 login/doctor/list/get 30 秒、replay 300 秒；stdin 读取单独使用同一 `--timeout-ms` 上限，超时返回 `timeout`（退出码 1）且不发送 HTTP 请求；JSON 响应体不设客户端大小上限，完整读取后解析，仍受请求超时约束。
- `--json` 时 stdout 恰好一个 JSON 文档；失败时 stderr 为 `{"error","message"}`（经 key 脱敏）。退出码 `0` 成功、`1` 请求/服务端/replay 失败或保存的凭据文件无效（`invalid_credentials`）、`2` 参数、输入或凭据缺失/不合法。replay 即使返回的 `error` 非空也会把完整结构写在 stdout。
- replay 的行为边界（合成工具、不写生产数据、按 Provider 计费）见 [admin-panel.md](admin-panel.md#invocation-重放)；选项全集与响应形状以 [packages/cli/README.md](../packages/cli/README.md) 与源码为准。
- 源码仓库根目录的 [`plasticwan-utils` Skill](../.agents/skills/plasticwan-utils/SKILL.md) 面向通过 CLI 访问 Admin API 的外部 Agent：每次任务先运行 `plasticwan-utils doctor --json`（恰好一次只读请求），只有退出码 `0` 且 `status` 为 `ok` 才读取对应指南并查询或重放；doctor 失败即停止并请操作员用 `login` 修复，不循环重试、不代为执行 `login` 或改动凭据、不直接读取聊天或存储中的 key，`--help` 只用于客户端缺失或命令不匹配时的诊断。`SKILL.md` 是轻量入口，审计与重放细节分列 `references/invocations.md`、`references/replay.md`，按当前任务加载子文档而不是一次全读。它不是 Bot 的 System Skill。npm 包不内置该 Skill，须按 [CLI README](../packages/cli/README.md#配套-agent-skill) 从源码仓库将整个目录（含 `references/` 与 `agents/openai.yaml`）复制/导入宿主并随仓库同步更新。不把服务端源码或 SQLite 访问作为前提。

## 管理员凭据与 Passkey 恢复（admin-reset）

`admin-reset` 是**服务端内置 CLI** 的本地恢复命令，与 `plasticwan-utils` 不是一回事——后者只通过 Admin API 做只读检查与 Invocation 重放，不能恢复凭据。

```bash
node src/cli.ts admin-reset --config <path> --username <name> [--password-stdin]
```

- **前置条件**：先停止**同一 `data_dir`** 的 `serve`。命令经 `ServeLock` 拒绝在运行中的实例上执行（锁被活动进程持有时报错退出，没有 `--takeover`），保证恢复期间的数据库不与运行中的 Bot 竞争。
- **交互模式**：stdin 是 TTY 时隐藏输入新密码并要求重复确认，两遍不一致则报错退出；密码不 echo。
- **非交互模式**：stdin 不是 TTY 时必须显式给 `--password-stdin`，密码从 stdin 管道读取（最多 800 字节、10 秒超时、只去掉一个尾部换行）。**不要把明文密码写进命令行参数**——会进 shell history 与进程列表；请从密码管理器或受限权限文件等安全来源经管道传入。
- **效果**：把该账号密码替换为新 Argon2id hash，删除该账号**全部 Passkey 与全部登录 Session**；`admin_api_keys` 保留，`setup` 不会重开（账号仍存在）。成功后 stdout 输出 `{ "status": "ok", "username": ... }`。
- **使用场景**：遗失全部 Passkey、移除 `admin.public_url` 后关闭了 Passkey，或更换域名导致旧凭据无法用于新域名时，用它恢复密码登录。删除或更换公开 URL 之前，应先恢复或设置密码。

## 日志

用户可见日志写 stdout，格式为单行 JSON；框架 trace 可能写 stderr。至少监控：

- `serve_started`
- `admin_started`（仅在 `admin.enabled = true` 时出现）
- 进程退出与重启次数
- required MCP 初始化失败
- 未脱敏前的错误不得直接输出

消息、Tool 和模型的细节以 SQLite 审计为准，stdout 不为每条 Update 打日志。不要因日志安静就判断 Bot 没有处理消息。

## 本地排障

### Chat not allowed

1. 确认 Chat ID 符号和完整值，Supergroup 通常为负数。
2. 运行 `check-config`。
3. 重启进程。
4. 对比启动配置哈希。
5. 查询 `telegram_updates.allowed` 与 `rejection_reason`。

### Bot 没有回复

沉默可能是成功行为。检查：

1. Update 是否 allowed。
2. Bucket 是否到达 `telegram.bucket_window_seconds` 节拍；同一群内前一个 Invocation 仍在运行时，需等待它结束。
3. Invocation 是否 completed。
4. `sends_used = 0`：Agent 主动不发言。
5. 有 `tool_calls` 时继续检查 `send`/`read_image`/MCP 状态；image-capable Agent 的图片直传失败时检查 Invocation 的 `completion_reason`。
6. 看到成片 `state = failed` 且快速失败：`completion_reason = invocation_error` 表示运行时异常，到日志里搜 `agent_invocation_error` 拿消息与堆栈；`model_error` 才是 Provider 侧问题。若是解不开的 `context_messages`（日志里报 `does not match its schema`），`/cut_topic` 或清空该 Conversation 的 canonical history 能让对话先恢复。

### 图片或 Sticker 理解失败

- text-only Agent 的普通图片与全部 Sticker：检查 `media_analyses.state/error/failure_count` 和对应 Vision `model_calls`。
- image-capable Agent 的普通图片：检查 Invocation/Agent `model_calls`，不会产生 `read_image`。
- 视频/动画 Sticker 检查 FFmpeg/FFprobe 或 python-lottie 是否在 PATH。
- Sticker 模型是否返回 `report_sticker_analysis` Tool Call。
- 重试成功后确认分析状态和 `read_image` Tool Call 都为 success。

### Serve lock

- 正常停止后锁自动删除。
- 服务启动会识别并修复已退出 PID 的 stale lock。
- 锁存在时先确认 PID 与进程归属；不要在活动进程期间手动删除。

### Admin Panel 打不开

1. 确认 `admin.enabled = true` 且已重启 `serve`。
2. 启动日志中应有一条 `admin_started`，`host`/`port` 与配置一致。
3. 页面返回 503 `admin_bundle_missing`：先 `pnpm run admin:build`（产出 `apps/admin-next/dist`），或修正 `static_dir`；503 响应的 `message` 里带有实际查找的目录绝对路径（`admin_started` 日志只有 host/port）。
4. 忘记密码或遗失 Passkey 时使用内置 CLI 本地重置，见「[管理员凭据与 Passkey 恢复](#管理员凭据与-passkey-恢复admin-reset)」。不要删除 `admin_users` 来重新开放首次设置入口。
5. 登录返回 429 `too_many_attempts`：同一失败键连续 10 次失败后锁定 15 分钟，重启 `serve` 会清空内存计数；失败键的构成见[Admin Panel：认证](admin-panel.md#认证)。

## 备份

手动：

```bash
node src/cli.ts backup --config dev-data/config.jsonc
```

备份前会执行保留清理，完成后按 `backup_copies` 轮换。备份文件的完整性和可恢复性验收见[验证：备份与恢复验证](verification.md#备份与恢复验证)；“命令成功”不等于恢复路径已验证。

## 部署方式

推荐使用 Docker 部署：`Dockerfile` + `docker-compose.yml`，镜像由 CI 推到 GHCR，媒体依赖已打进镜像。

也可以像本地开发一样直接在宿主机运行 `node src/cli.ts serve`。仓库不提供对应的服务单元；进程监督、FFmpeg/python-lottie 依赖和定期备份都需要自行准备。

## Docker 部署

`.github/workflows/docker.yml` 在推送 `main`、`develop` 分支和 `v*` tag 时都运行 `verify` job，但只有 `main` 与 `v*` tag 构建 `linux/amd64` 与 `linux/arm64` 镜像并推送到 `ghcr.io/tuuject/surowan`：`main` 产出 `main` 与 `0.0.0-next-<UTC 时间戳>` tag，镜像推送成功后创建 `v0.0.0-next-<UTC 时间戳>` tag 与 GitHub Pre-release（`GITHUB_TOKEN` 推送的 tag 不会再触发 workflow）；`develop` 只做验证、不构建镜像，`v*` 产出 `latest` 与 semver tag。

镜像结构（`Dockerfile`，builder 与 runtime 均为 `node:24-bookworm-slim` 两阶段）：

- builder 阶段 `pnpm install --frozen-lockfile` → `pnpm run admin:build` → 再以 `pnpm install --prod --frozen-lockfile` 剪掉 devDependencies。
- runtime 阶段用 apt 装 `ffmpeg`（含 `ffprobe`）、`python3` 与 `gosu`，再 pip 装 `lottie`；因此**不需要**在宿主机准备任何媒体依赖。
- 只复制 `src/`、`node_modules/`、`apps/admin-next/dist/`、`apps/admin-next/LICENSE`、`apps/admin-next/NOTICE` 和 `package.json`。`test/`、`agent-doc/`、`dev-data/` 被 `.dockerignore` 排除，镜像里没有这些目录。
- Admin 前端已经构建进 `/app/apps/admin-next/dist`，与 `static_dir` 默认值一致，无需额外配置。前端模板许可（MIT，© Kiranism）随 `LICENSE` 保留，字体（@fontsource，SIL OFL 1.1）说明在 `NOTICE`。
- CI（`.github/workflows/docker.yml`）在构建镜像前先跑 `verify` job：`pnpm install --frozen-lockfile` → `pnpm run lint` → `pnpm run check` → `pnpm test` → `pnpm run admin:build` → `pnpm --filter plasticwan-admin-next exec playwright install --with-deps chromium` → `pnpm run admin:test:e2e`，通过后 `build` job 才推送 `linux/amd64` 与 `linux/arm64`。

运行约定：

| 容器路径 | 用途 |
| --- | --- |
| `/config/config.jsonc` | 配置文件（bind mount） |
| `/config/key.json` | key jar：配置里 `{ "jar": "<name>" }` 引用的 Secret，面板写入的 key 也在这里；见[配置：SecretRef](configuration.md#secretref) |
| `/config/*.md` | Prompt 文件；`system_prompt_file`、`instructions_file` 相对配置文件解析，必须和 `config.jsonc` 放在一起 |
| `/data` | `data_dir`、SQLite、媒体缓存与备份 |

Secret 建议用 compose `environment:`/`env_file:` 注入；挂载到 `/app/.env`（容器工作目录）也会被 CLI 加载，但真实环境变量优先，见[配置：`.env` 加载](configuration.md#secretref)。

配置里必须使用容器内路径，而不是宿主机路径：

```jsonc
{
  "data_dir": "/data",
  "paths": {
    "database": "/data/plasticwan.sqlite",
    "media_cache": "/data/media-cache",
    "backups": "/data/backups",
  },
}
```

启动：

```bash
mkdir -p config data
# 把 config.jsonc 和 prompt 文件放进 ./config/
docker compose up -d
docker compose logs -f          # 确认 serve_started 与 config_hash
```

`docker-entrypoint.sh` 以 root 启动，做三件事后才降权：

1. 按 `PUID`/`PGID`（默认 `1000`）重映射容器内 `plasticwan` 用户，避免 bind mount 的属主冲突。
2. `chown -R` 挂载卷，并把 `/config`、`/data` 设为 `0700`、`/config/config.jsonc` 与 `/config/key.json` 设为 `0600` —— 这是为了满足 `assertConfigPermissions` 与 key jar 的权限检查，宿主机上不必手动 chmod。
3. `exec gosu plasticwan node /app/src/cli.ts "$@"`。

因为最后一步把参数原样传给 CLI，其它子命令都能用同一镜像跑：

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

注意：`serve` 是长期进程且受 `ServeLock` 约束，同一 `data_dir` 只能有一个实例。上面的一次性命令（`check-config`/`doctor`/`backup`）都不启动 `serve`，可以与运行中的容器共存；但**不要**用 `docker compose run` 再起一个 `serve`。例外是 `admin-reset`：它要独占数据库，运行前必须先停止同 `data_dir` 的 Bot 容器（`docker compose stop plasticwan`），否则 `ServeLock` 会拒绝执行，见「[管理员凭据与 Passkey 恢复](#管理员凭据与-passkey-恢复admin-reset)」。

镜像不自带定时备份。需要定期备份时，用宿主机 cron 等调度器定期执行上面的 `backup` 命令，例如每天一次。

`admin.host` 不再限制回环。容器内绑定 `127.0.0.1` 时，Docker 的端口发布转发到容器在 bridge 网络上的地址、够不到 loopback，所以 `docker-compose.yml` 里的 `ports:` 默认是注释掉的；要在容器外直接访问面板，需把 `admin.host` 显式改为 `0.0.0.0` 再取消 `ports:` 注释——这会把面板暴露给宿主网络，TLS 与访问控制由运维承担。更稳妥的访问方式：

- `docker compose exec plasticwan <客户端> http://127.0.0.1:8787/...`（镜像未显式安装 curl，先确认基础镜像里有没有）；
- 让反向代理与容器共享网络命名空间（`network_mode: "service:plasticwan"`），由它承担 TLS 与对外暴露。

配置变更同样按白名单区分：白名单字段可在面板上应用，其余字段改完 `./config/config.jsonc` 后 `docker compose restart`，并比对新日志里的 `config_hash`（热应用则比对 `config_reloaded` 的 `active_hash`）。
