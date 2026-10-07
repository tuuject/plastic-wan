# Admin Panel

Admin Panel 是随 `serve` 启动的本地审计与管理界面，覆盖 Tool Session（Invocation）、收到的 Telegram 消息、媒体视觉分析、已配置 Sticker Set 的可搜索索引、Agent 短期记忆（`memories`）、Alarm（通用长程任务的闹钟投影）以及两层可编辑 Prompt 的版本历史（`prompt_versions`）。后端在 `src/ingress/admin/`，前端在 `apps/admin-next/`（Rsbuild + React + Tailwind 4 + shadcn/Base UI + TanStack Query + TanStack Router），构建产物是**纯静态 SPA**，由 `AdminServer` 同源托管，不依赖任何 Node/Nitro 运行时。

审计查询只读；Developer 调试配置与历史报文清除、记忆管理、Bot 管理员列表管理、Chat/Topic 白名单与按群模型管理（Chats 页）、模型与 Provider 管理（Models 页）、两层可编辑 Prompt 的编辑与版本管理（全局人格与按群指令：版本历史、恢复，以及只取消仍按旧 Prompt 运行的 Invocation）、配置文件应用、立即重启、解除睡眠、取消挂起会话与取消 pending Alarm 是受控的控制端点。管理员可以增删改查记忆、按群聊过滤，并对长 TTL 记忆做人工判断（保留 / 删除 / 提升进 `agents.md`），也可以指派/移除能执行 `/pause`、`/resume`、`/cut_topic` 等 Bot 管理员命令的 Telegram 用户（写回 `telegram.admins` 并热应用），在 Models 页维护 Provider 与模型列表（写回 `config.jsonc` 并重新加载）、切换全局 agent 与 vision 模型并设置全局 thinking 级别（Models 页端点仍是全局语义）；在 Chats 页增删 Chat、编辑 Topic 白名单与 Chat 范围的模型/thinking 覆盖（同群所有 Topic 共用，支持恢复继承全局），唤醒/取消挂起会话，取消尚未触发的 Alarm，把配置文件中的热更新白名单字段应用到运行中的进程，或在有待重启字段时直接重启 `serve`。写入只发生在 [API](#api) 白名单里的端点。配置修改经 `writeConfigEdits` 校验并原子写入后，再由 `ConfigReloader` 尝试应用；应用失败时文件保留已写入内容，运行中的配置不变。

`admin` section 的字段语义见 [configuration.md](configuration.md#admin-panel)；`admin.host` 不限制取值，绑定地址与暴露风险由运维负责（推荐回环 + 反向代理）。`admin.*` 不在热更新白名单里：改动后进入待重启列表，重启 `serve` 才生效。热更新白名单与语义见 [configuration.md](configuration.md#运行时配置热更新)。

## 生命周期

`src/application.ts` 在 Scheduler 启动后、Telegram long polling 之前创建 `AdminServer`，日志输出：

```json
{"event":"admin_started","host":"127.0.0.1","port":8787,"at":"..."}
```

关闭顺序中 `admin?.stop()` 先于 Scheduler，避免请求持有已关闭的数据库。Admin Panel 与 Bot 共享同一个 `SqliteStore`，因此受 `ServeLock` 单实例约束保护。

## 认证

`src/ingress/admin/auth.ts`：

- 首次访问时 `GET /api/auth/session` 返回 `setup_required = true`，前端渲染创建管理员表单。
- `POST /api/auth/setup` 在 hash 之前先检查是否已有用户（已完成时直接 409 `setup_complete`，不消耗 Argon2），再在事务内确认一次后写入 `admin_users`。
- 密码 12–200 字符，用户名 `^[A-Za-z0-9._-]{3,32}$`。
- 密码只以 `argon2id` hash（`@node-rs/argon2`）存储，明文不落库、不进日志。
- Session Token 为 32 字节随机值，返回给 Cookie，数据库只存 SHA-256 摘要。
- Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，`Max-Age` 等于 `session_ttl_hours`。浏览器在 HTTPS 页面上时（请求本身是 `https:`，或 TLS 在反向代理终止时请求的 `Origin` 是 `https://…`）额外带 `Secure`，登出清除 Cookie 时同样。纯 HTTP 的回环面板不带 `Secure`，浏览器才会保存它。
- 用户名不存在时仍执行一次 hash 运算，避免枚举时间差。
- 同一客户端连续 10 次失败后锁定 15 分钟，返回 429 `too_many_attempts`；计数只在内存中，重启 `serve` 清空。客户端按 TCP 连接的对端地址区分，不读 `X-Forwarded-For`（客户端可以随意伪造它），也不区分用户名，所以换用户名或换请求头都绕不过锁定。反向代理之后所有请求共用代理的地址、共用一个计数，这是有意的取舍：没有可信代理配置时无法安全地取真实地址。
- 失败在 Argon2 校验**之前**计数，并发的失败尝试都会被计入；锁定过期后计数从零开始。失败记录超过一个锁定窗口会被清除，最多记录 1000 个客户端。
- 用户名不符合格式或密码超过 200 字符的登录直接失败（计入失败），不做 hash。login 与 setup 同时最多运行 2 个 Argon2 运算，超出的请求直接返回 429，不排队。
- 登录校验通过后在 immediate 事务里重新读取密码 hash，与校验时的不一致（期间改过密码）就按失败处理，不签发 Session。
- 所有带 body 的请求边读边按字节计数，超过上限（登录等 8 KiB，Models 页写端点单独设上限）立即取消读取并返回 413 `body_too_large`，不会先把整个 body 读进内存。
- 过期 Session 在认证时删除，并在新建 Session 与服务启动时批量清理。
- `POST /api/auth/logout` 按 Token 摘要删除 Session。
- `POST /api/auth/credentials` 修改当前管理员用户名和密码，撤销该用户全部 Session（含当前）并签发新的 Cookie。

跨站防护：所有写方法（`POST`/`PUT`/`DELETE`）校验 `Origin`——缺失（CLI、非浏览器客户端）放行，解析失败返回 400 `bad_origin`，主机不匹配返回 403 `bad_origin`；`Origin` 不参与读方法校验，`GET` 携带任意 `Origin` 仍正常处理。审计路由只接受 `GET`，其它方法返回 405。

## 程序化 API 密钥

`src/ingress/admin/api-keys.ts` 提供供 CLI 与评估工具使用的 API 密钥。密钥管理是 **Session-only** 的：只有面板登录会话能创建、列出与撤销密钥，密钥自身不能管理密钥。前端入口是 **Manage → API keys** 独立页（`/api-keys`），复用下述现有接口，没有新增 API、迁移或配置项：表格列为 Name/Prefix/Created/Last used/Status/Actions（Active/Revoked，未使用时显示 Never used）；**Create API key** 只填 `name`（1–80 字符），明文只在随后 **Save your API key** 一次性弹窗中出现，Done/关闭/导航/刷新后不可再取回，也不写入 `localStorage`/`sessionStorage` 或查询缓存；**Copy API key** 失败时保留文字并提示手动复制；行内 **Revoke** 需确认、立即生效且保留元数据。列表失败提供 Retry，创建失败在弹窗内联显示且进行中禁止重复提交，撤销失败留在确认框。界面操作说明见[用户指南](../apps/docs/content/docs/configure/admin.md#api-密钥)。

| 路由 | 语义 |
| --- | --- |
| `GET /api/api-keys` | 返回 `{ items }`，每项为 `id`/`name`/`prefix`/`created_at`/`last_used_at`/`revoked_at`，**永不返回明文** |
| `POST /api/api-keys` | body 严格为 `{ name }`（1–80 字符，TypeBox 拒绝多余字段）；返回 `{ key, item }`，`key` 是 `pwk_` 加 32 字节随机值的 base64url（共 47 字符），**只在这一次响应里出现**，随后注册进 `SecretStore` 供日志与错误脱敏 |
| `DELETE /api/api-keys/:id` | 置 `revoked_at` 永久禁用（保留行与元数据以便审计）；重复撤销或不存在返回 404 `not_found`，`:id` 非法返回 400 `invalid_id` |

- 数据库只存 SHA-256 摘要与展示用 `prefix`（`pwk_` 加上前 8 个 base64url 字符），明文不可恢复；遗失只能撤销后重建。
- 撤销立即生效（下一次鉴权即 401）。`last_used_at` 在密钥通过校验时更新——**包括随后因权限面被拒绝（403）的请求**；未通过校验（401）不更新。
- 请求带 `Authorization` 头时**完全不读取面板 Cookie**：非 `Bearer` 前缀、空值、未知或已撤销的密钥统一返回 401 `unauthenticated`（固定消息，不区分原因），Bearer 前缀大小写不敏感；无效密钥也不会回退成有效 Session，有效 Session 也不能把密钥权限升级成完整面板权限。
- 密钥的权限面固定为 Invocation 读/重放与只读 inspection：`GET /api/invocations`、`GET /api/invocations/:id`、`GET /api/invocations/:id/prompts`、`GET /api/invocations/:id/replay-preflight`、`GET /api/invocations/:id/media`、`GET /api/invocations/:id/media/:media_id/content`、`GET /api/config/view`、`GET /api/prompts/global`、`GET /api/prompts/group` 与 `POST /api/invocations/:id/replay`；其余一切——包括密钥管理自身、Prompt 版本历史与 diff 读取、全部 Prompt 写端点、其它审计读端点、全部面板写端点与未知路由——都返回 403 `forbidden`（未知路由不泄露 404 差异）。这些 GET 与面板 Session 共用同一条只读检查路径（见「Inspection 只读视图」）；`POST .../replay` 仍只接受 Bearer key，Session 请求落到审计分支返回 405 `method_not_allowed`。

## API

前缀 `/api`，全部返回 JSON，`cache-control: no-store`。

完整路由表以 `src/ingress/admin/server.ts` 的分发为准。这里只记录路由签名看不出来的约束。

**审计读端点**（`GET /auth/session`、`/overview`、`/usage`、`/invocations[/:id]`、`/invocations/:id/prompts`、`/invocations/:id/replay-preflight`、`/invocations/:id/media[/:media_id/content]`、`/config/view`、`/prompts/global`、`/prompts/group`、`/prompts/versions[/:id]`、`/prompts/diff`、`/contexts[/:conversation_id]`、`/messages[/:id]`、`/sticker-sets`、`/stickers`、`/alarms`、`/memories`、`/memories/chats`、`/admins`、`/provider-presets`、`/config/status`、`/image/status`、`/image/config`、`/image/models`、`/image/models/endpoints?model=:id`、`/image/prompts[/:id]`、`/image/images[/:id[/:content]]`、`/image/generations[/:id]`）一律只读；落到审计分支的非 `GET` 请求返回 405 `method_not_allowed`。其中 `/config/view`、`/prompts/global`、`/prompts/group` 与 `/invocations/:id/{prompts,replay-preflight,media}` 是 Session 与 Bearer key 共用的只读检查路由，查询校验与投影见「Inspection 只读视图」；`/prompts/versions`、`/prompts/versions/:id` 与 `/prompts/diff` 只在面板 Session 下提供（Bearer key 请求返回 403），语义见「Prompts 页端点」；密钥请求的非 `GET` 落在密钥权限面之外，返回 403。`GET /providers` 与 `GET /chats` 只读，但这两个路径同时是写端点前缀，不落到审计分支。`/usage` 额外接受 `days`（1–90，默认 7），越界返回 400 `invalid_days`；Token 序列来自 `daily_usage`，Invocation 与 Tool call 序列直接按 UTC 日期 `COUNT` `invocations` 与 `tool_calls`。`/contexts` 是按 Conversation（chat + Forum Topic）维度只读投影 Conversation Context；`:conversation_id` 是 `conversations.id` 而不是 `conversation_contexts.id`，不存在返回 404。`GET /config/status` 返回 `generation`、`active_hash`、`file_hash`、`restart_required` 与 `last_error`（`{ code, message, at }` 或 `null`）。`ConfigReloader` 未接线时，`GET /config/status` 返回 503 `config_reload_unavailable`，`PUT /model` 返回 503 `model_switch_unavailable`，`/providers` 与 `PUT /vision` 返回 503 `providers_unavailable`，`/chats` 返回 503 `chats_unavailable`。

`GET /providers` 是 Models 页的主读端点，读的是**磁盘上的 `config.jsonc`**（不是运行中的 active 配置），因此待重启字段以文件为准：

```jsonc
{
  "revision": "<config.jsonc 原始字节的 SHA-256>",
  "supervised": false,                       // PLASTICWAN_SUPERVISED=1 时为 true
  "agent": { "provider": "openrouter", "model": "deepseek/deepseek-v4-flash-0731", "thinking_level": "off" },
  "vision": { "provider": "google", "model": "gemini-3.7-flash" },
  "restart_required": ["vision.max_concurrency"],
  "providers": [
    {
      "alias": "openrouter",
      "kind": "builtin",
      "provider": "openrouter",              // builtin 才有；Pi 供应商 id
      "api": "openai-completions",           // builtin 由 Pi 目录推导
      "base_url": "https://openrouter.ai/api/v1",
      "header_names": [],                    // 只有名称，永远没有值
      "models": [ /* 完整模型配置，含 compat */ ]
    }
  ]
}
```

响应里不出现 `api_key`，也不出现任何 header 值，也不说明已保存的 SecretRef 是明文、`env` 还是 `command`。文件无效时返回 422 `config_invalid`（错误经过密钥脱敏）。`GET /provider-presets` 列出可配置的 builtin Provider（`id`、`name`、`api`、`base_url`），过滤规则见 [configuration.md](configuration.md#provider)。

**写端点是白名单例外**，只有这些：

| 路由 | 非显然的语义 |
| --- | --- |
| `POST /auth/setup` / `POST /auth/login` | 首次建号与登录，约束见「认证」 |
| `POST /auth/logout` / `POST /auth/credentials` | 改凭据会撤销该用户**全部** Session（含当前）并签发新 Cookie |
| `PUT /developer` | 保存并热应用 `developer.record_model_payloads`，沿用配置 revision、校验与原子写入机制，见「Developer 页」 |
| `DELETE /developer/model-payloads` | 分批置空历史 `model_calls.request_json` / `response_json`，保留所有审计行与关联；不执行 `VACUUM`，见「Developer 页」 |
| `POST /api-keys` / `DELETE /api-keys/:id` | 仅面板 Session 可创建或撤销程序化密钥，见「程序化 API 密钥」 |
| `POST /wake` | 删除持久化睡眠状态并唤醒 Scheduler；幂等，重复调用保持 `awake` |
| `POST /cancel-ongoing-sessions` | 中断所有 running Invocation（经 Scheduler abort），同时 abort queued Invocation、过期 `collecting`/`queued` Bucket 与已 attach 未注入的 Bucket，被中断的运行不会把批次重新排队；已发出的 Telegram 消息不撤回 |
| `POST` / `PUT` / `DELETE /memories[/:id]` | 创建时若 `(chat_id, message_thread_id)` 的 Conversation 不存在会自动建；`PUT` 至少要提供 `content` 或 `ttl_seconds` 之一 |
| `POST` / `DELETE /admins[/:id]` | 增删 `telegram.admins` 白名单并热应用；`:id` 是 Telegram 用户 ID 不是行 ID；添加幂等，删除不存在的 ID 返回 404 `not_found`；If-Match revision 规则同其它配置写端点 |
| `PUT /model` | 切换全局 agent 模型：把 `agent.provider` / `agent.model` 写入 `config.jsonc`，同时把 `agent.thinking_level` 重置为新模型接受的最弱级别，然后重新加载，重启后仍然生效，只影响后续 Invocation。该端点仍是**全局**语义：只写 `agent.*`，不改动任何 `telegram.chats[]` 的按群覆盖（每群覆盖通过 Chats 页、配置文件或 Telegram `/model` 维护）。响应的 `current.thinking_level` 是重置后的级别。必须带 `If-Match`（revision 来自 `GET /providers`），缺失返回 400 `revision_required`，过期返回 409 `config_conflict`。未知 provider/model、模型无 text 能力或模型不可用返回 400（`unknown_provider`/`unknown_model`/`not_text_capable`/`model_unusable`），新增或连接字段变化的 Provider 无法解析 SecretRef 返回 422 `secret_unresolved`，其它失败（配置权限、文件校验、candidate 校验等）返回 409；body 为 `{ error, message }`，文件已写入但应用失败时 message 以 `config.jsonc was updated but not applied: ` 开头。`GET /model` 与 `DELETE /model` 已删除，落到 405 `method_not_allowed` |
| `POST /chats` / `PUT /chats/:id` / `DELETE /chats/:id` | Chat/Topic 白名单与按 Chat 的模型/thinking 覆盖，见「Chats 页端点」；新增 Chat 热应用，删除与 Topic 范围等待重启，已有 active Chat 的模型覆盖热应用，删除不清除历史 |
| `POST` / `PUT` / `DELETE /providers[...]` | Provider 与模型管理，见「Models 页写端点」 |
| `PUT /thinking-level` | body `{ thinking_level }`，设置全局 `agent.thinking_level`，热应用，响应同「Models 页写端点」。只写全局默认并保留 Chat 覆盖：有 `thinking_level` 覆盖的 Chat 保持自己的值；没有覆盖的 Chat 继承新值，若与文件中该 Chat 选用的模型不兼容则在写入前返回 422 `config_invalid`。覆盖可经 Chats 页或配置文件调整，也可用 Telegram `/model default` 连同模型覆盖一起清除。取值不是 Pi 级别返回 400 `invalid_body`；文件里的 agent 模型不接受该级别返回 422 `unsupported_thinking_level`，message 列出可选级别（规则见 [configuration.md](configuration.md#模型-thinking-级别)）；`If-Match` 规则同其它写端点 |
| `PUT /vision` | 切换 vision 模型。写入前预检：模型在文件的该 Provider 下存在、支持 image 输入、且 `vision.max_output_tokens ≤ 该模型的 max_tokens`，不满足返回 400（`unknown_provider`/`unknown_model`/`not_image_capable`/`max_output_tokens_exceeded`）。`vision.provider`、`vision.model` 与 `vision.max_output_tokens` 热应用：下一次 vision 分析就用新模型，旧模型写的 `media_analyses` 行不会被命中；`vision` 的其它字段仍是 restart 字段 |
| `POST /image/prompts` / `PUT` / `DELETE /image/prompts/:id` | 生图 Prompt 素材管理（创建/更新/归档）；归档的素材读取返回 404 |
| `POST /image/images` / `PUT` / `DELETE /image/images/:id` | 参考图上传（base64，≤20 MB 原始体积）/ 元数据编辑 / 归档；`GET /image/images/:id/content` 返回二进制（带认证） |
| `POST /image/generations` / `POST /image/generations/:id/retry` | 以 `admin:<username>` actor 提交生成（body 含 `idempotency_key`，同键同内容重放不重新计费，同键不同内容 409）或重试已有 generation |
| `PUT /image/config` | 图片功能启停与模型/凭据配置，`If-Match` revision 规则同其它配置写端点。`enabled: true` 时 body 必须带 `credentials`（名称 → 新明文；空对象保留已有 SecretRef，明文写入 key jar，`config.jsonc` 只保留 `{jar}` 引用）与 `models` 数组；可带 `credential_sources`（图片凭据名称 → 已配置的内置 OpenRouter Provider alias，服务端复用其 SecretRef，不返回密钥）。重复模型 ID 或缺失凭据引用在写入前拒绝（结构按 image 段 schema 校验，不合法返回 400 `invalid_body`）；`enabled: false` 删除整个 `image` 段并回收不再被引用的 jar 条目。写入经 reloader 原子应用，无需重启；响应 `{ enabled, apply }` |
| `POST /restart` | 界面上的 “Restart now”。部署方未声明 `PLASTICWAN_SUPERVISED=1` 时返回 409 `restart_unsupported`；磁盘配置权限或内容校验失败时返回 422 `config_invalid` 且不退出；成功返回 202 `{ status: 'restarting' }`，随后走优雅关闭并以退出码 75（`EX_TEMPFAIL`）退出，由外部监督重新拉起 |
| `POST /config/apply` | 重新读取 `config.jsonc` 并把热更新白名单字段应用到运行中的进程。成功返回 200 `{ status: 'applied', applied, restart_required, outside_serve, generation, active_hash, file_hash }`；失败返回 422 `{ error, message }`，此时 active 配置不变，错误记录在 `GET /config/status` 的 `last_error` |
| `DELETE /alarms/:id` | 只取消 Alarm 投影为 `pending` 的项目：waiting 任务变为 cancelled；completed+pending receipt 则只 suppress 投递、保留完成结果。`firing`（claimed）与其它终态返回 409 `alarm_not_pending`，不存在返回 404 `not_found`。取消记录当前面板管理员与 `admin_cancelled` 原因并唤醒 Scheduler |
| `POST /invocations/:id/replay` | 用当前配置重放一次已结束的 Invocation；body 只接受 `global_prompt` / `group_prompt` 两个可替换层（每层 65536 字符上限，global 不能清空）与切片边界 `before_send_id`（正整数十进制字符串，指向本 Invocation 的成功 `telegram_sends`；body 上限 1 MiB），不接受 `system_prompt` 覆盖，见「Invocation 重放」。仅 Bearer API key 可调用（Session 请求返回 405） |
| `PUT /prompts/global` / `PUT /prompts/group?chat=` | 编辑全局人格 / 按群指令：写 Prompt 文件（去 HTML 注释后的正文，原子临时文件 + rename，`0600`）、记录一个版本，再经既有热应用发布给**下一次**开始的 Invocation。`If-Match` 是 Prompt 内容（去注释后）的 SHA-256，**不是** `config.jsonc` revision——config revision 按设计不含 Prompt 文件：缺失返回 400 `revision_required`，文件被并发修改返回 409 `prompt_conflict`。群级在 Chat 尚无 `instructions_file` 时写 `prompts/chat-<id>.md` 并经配置写入器补上该字段，目标路径已有未被引用的文件返回 409 `prompt_file_exists`。仅面板 Session，见「Prompts 页端点」 |
| `POST /prompts/versions/:id/restore` | 把该版本内容写回为新版本（`source: 'rollback'`，默认 note `Restored from version N`，历史不删除），`If-Match` 与并发规则同 Prompt 写端点 |
| `POST /prompts/cancel-running` | 只取消仍按旧 Prompt 运行的 Invocation：过期它们已 attach 未注入的 Bucket（`error_code = admin_cancel`）并 abort 运行；正在收集与已排队的 Bucket 不受影响（它们是未来的 Invocation，以新 Prompt 开始）；已发出的消息不撤回。body `{ scope: 'global' }` 或 `{ scope: 'group', chat_id }`（十进制字符串） |

列表过滤同样只在少数端点上有效：`/alarms` 按 `state`(`pending`/`firing`/`fired`/`cancelled`)/`chat`/`target`，`/memories` 按 `chat`/`state`(`active`/`expired`/`long_ttl`)，`/stickers` 按 `set`/`state`，`/contexts` 只按 `chat`。记忆列表项带 `expired` 与 `long_ttl` 布尔标记，`long_ttl` 表示剩余寿命超过 `agent.memory_ttl_warning_days`。Alarm 列表把 `pending` 按 `scheduled_at, id` 升序置顶，非 pending 历史按最近状态时间/id 倒序。

Invocation 列表与详情的统计按 `invocation_id` 查询 `model_calls` / `tool_calls`，依赖迁移 `023` 添加的关联索引。模型调用行包含大型请求/响应快照；缺少索引时，一页的多个统计子查询会反复扫描整张审计表，显著增加 TTFB，并阻塞与面板共用进程的 Bot。性能回归测试检查实际列表 SQL 的查询计划，避免用依赖机器速度的耗时阈值。

`GET /api/invocations` 还接受公开消息搜索：`search`（1–100 字符的字面关键词，`%`/`_` 不作为通配符）与 `at` 或 `from`/`to`（`at` 不能与 `from`/`to` 同用）。候选只有冻结 `invocation_messages`（`section = 'new'`）的群友消息，以及同 Invocation 成功 `telegram_sends` 的 text/caption——私有的 Assistant 文本与工具结果不是候选，失败的发送也不计入；同用时关键词与时间必须命中同一条消息，Invocation 只有每一项条件都命中才会出现在列表里。`at` 命中写出的整个精度窗口（`YYYY-MM-DD[T 或空格]HH:mm[:ss[.1-3 位小数]][Z|±HH:mm]`；`HH:mm` 为整分钟、`HH:mm:ss` 为整秒、小数精确到毫秒），`from`/`to` 是半开区间 `[from, to)` 并要求 `from` 早于 `to`；不带 offset 的时间按 `chat` 指定 Chat 的配置时区解析，没有 `chat` 或该 Chat 未配置时区时用全局时区，主机时区永不参与。非法日历、DST 跳变造成的不存在或重复时间、未知时区、非法区间分别返回 400 `invalid_at` / `invalid_from` / `invalid_to` / `invalid_time_range`。带任一过滤时每个 item 追加 `matched_messages`（最多 5 条，按时间从新到旧；`source` 为 `incoming`/`bot`，`telegram_message_id`/`telegram_send_id` 为十进制字符串且仅 bot 条目有 send id，`text` 是截断到 2000 字符的预览），不带过滤时维持原响应形状。

`GET /messages` 的 `sender` 和 `GET /messages/:id` 的各条 Revision `sender` 包含 `telegram_id`（十进制字符串）与 `telegram_type`（`user` / `sender_chat`），身份不存在时整个 `sender` 为 `null`。这些 ID 来自 `senders.telegram_id`，不能用内部 sender 主键、Telegram message ID 或 username 替代；不经过 `Number` 转换。不新增数据库迁移或写端点。

## Chats 页端点

`GET /chats` 返回配置管理视图，不是数据库中所有 Chat 的历史列表：

- `revision` 是读取视图时磁盘 `config.jsonc` 原始字节的 SHA-256；`supervised` 与 `restart_required` 沿用 Models 页的含义。
- `defaults` 是文件里的全局 agent 设置。`models` 只列文件中有 text 输入能力的模型，包含 `provider`、`model`、`name` 与按强度从低到高排列的 `thinking_levels`。
- `items` 是文件与运行态 Chat ID 的并集。每项有字符串 `id`（配置 ID）、`runtime_chat_id`（迁移后的 ID）、`title`、`type`、`saved` 与 `active`。名称/类型来自已有 SQLite 数据，未知时为 `null`；不会向 Telegram 探测。编辑始终按配置 ID 定位，不擅自把旧群 ID 替换成迁移后的 ID。
- `saved` / `active` 分别按文件与运行配置解析，含 `topic_ids`、`provider`、`model`、`thinking_level` 与解析继承后的 `effective`。某侧不存在该 Chat 时整个值为 `null`，因此可区分待新增、待删除与设置不一致；不会回传 instructions、参与策略或凭据。

| 端点 | Body / 语义 |
| --- | --- |
| `POST /chats` | `{ id, topic_ids, provider, model, thinking_level }`，追加一个白名单 Chat（热应用，立即生效）；配置 ID 已存在返回 409 `chat_exists` |
| `PUT /chats/:id` | `{ topic_ids, provider, model, thinking_level }`，四字段必填，仅替换这些字段；保留 `instructions_file`、参与策略、忽略用户等其它设置与 JSONC 注释。ID 不可改名，body 不接受 `id` 或其它字段 |
| `DELETE /chats/:id` | 从文件删除整项 Chat（含该项的其它设置），不删除消息、Context、记忆或审计；删除最后一个配置 Chat 返回 409 `last_chat_required` |

Chat/Topic ID 在 HTTP 中必须是十进制字符串：不接受 0、前导零、指数记法或超出 JS 安全整数范围的值；Chat 允许负数，Topic 只允许正数。`topic_ids: null` 表示不限制 Topic，否则须为非空、无重复的 ID 数组。`provider` 与 `model` 必须同时为字符串或同时为 `null`；`null` 删除相应覆盖并继承全局。设置模型覆盖时 `thinking_level` 必须同时给出，否则返回 400 `thinking_level_required`——继承的 thinking 会把全局默认绑到该 Chat 的模型上，之后调整全局设置可能被这个 Chat 拒绝；不覆盖模型时 `thinking_level` 可独立覆盖或为 `null`。模型存在性、text 能力与最终继承后的 thinking 兼容性由完整配置校验保证，不兼容不落盘。缺少配置项返回 404 `chat_not_found`。

写入需认证与同源 Origin，并携带 `If-Match: <revision>`：缺失返回 400 `revision_required`，过期返回 409 `config_conflict`。revision 检查先于 body 解析；读文件前后核对 revision，在 `writeAndApply` 锁内再次核对，避免其它写者重排数组后编辑错项。请求体上限 8 KiB。成功响应为完整 Chats 视图加 `apply: { applied, restart_required, outside_serve }`；新增 Chat 热应用并立即进入运行中的 ingestion 白名单，删除 Chat 与 Topic 范围等 restart 字段仍保留旧运行值，已有 active Chat 的模型/thinking 供下一次 Invocation 使用。

校验失败返回 400 `invalid_body` / `invalid_chat_id` / `invalid_topic_id` / `invalid_model_reference` 或 422 `config_invalid`；其它写入与应用错误沿用 Models 页的错误码。文件已写入但应用失败时，message 以 `config.jsonc was updated but not applied: ` 开头，active 不变且 `GET /config/status.last_error` 记录错误，不把失败伪装成回滚。

Chats 的编辑与删除确认在打开时冻结数据与 revision，后台刷新不得升级草稿。409 冲突关闭旧对话框并要求重新打开；其它错误内联展示。Models / Chats 的写入以及 Settings 的应用，无论成功或失败都刷新 providers、chats 与 config-status，确保保存后应用失败也显示真实状态。待重启横幅复用 Models 页控件，只有部署声明 supervisor 时提供 Restart now；未声明时提示人工重启。

## Prompts 页端点

Prompts 管理两层可编辑 Prompt：全局人格（`agent.system_prompt_file`）与每个配置 Chat 的按群指令（`telegram.chats[].instructions_file`）。面板编辑的就是配置引用的那两个文件；写入需面板 Session 与同源 Origin，且面板前端在保存或恢复后先询问是否取消仍在旧 Prompt 上运行的 Invocation（保存本身从不自动取消）。界面操作说明见[用户指南](../apps/docs/content/docs/configure/admin.md#编辑-prompt-与版本历史)。

- `PUT /prompts/global` 与 `PUT /prompts/group?chat=`：body 为 `{ prompt, note? }`（prompt ≤ 65536 字符，note ≤ 200）。写入的是去 HTML 注释后的模板，走与重放覆盖相同的校验边界（NUL/BOM、模板变量白名单；global 不可为空），原子替换（同目录临时文件 + rename、`0600`）后记录版本，再经既有热应用发布：**下一次**开始的 Invocation 使用新 Prompt，正在运行的 Invocation 继续用它启动时的快照。群级 Chat 未配置返回 404 `chat_unconfigured`；创建时内容为空返回 400 `prompt_empty`。
- `If-Match` 是 Prompt 内容哈希：GET 视图的 `content_hash` 是去 HTML 注释后内容的 SHA-256，写端点要求携带同一个值，缺失返回 400 `revision_required`，不一致返回 409 `prompt_conflict`。它**不是** `config.jsonc` revision（config revision 按设计排除 Prompt 文件），因此纯注释手改既不改变哈希也不产生版本。
- 创建按群指令：Chat 还没有 `instructions_file` 时，保存写配置文件旁的 `prompts/chat-<id>.md` 并通过配置写入器补上 `instructions_file`（热应用）；目标路径已存在未被引用的文件时返回 409 `prompt_file_exists`，绝不覆盖。
- 版本历史：`GET /prompts/versions?scope=global` 与 `?scope=group&chat=` 返回 `{ scope, chat_id, retained, current, items }`（item 不含正文，含 `id`、`seq`、`content_hash`、`content_chars`、`source`、`note`、`created_by`、`created_at`）；`GET /prompts/versions/:id` 额外含完整 `content`；`GET /prompts/diff?from=&to=` 返回同一 scope 两个版本的 unified 风格 hunks（context/removed/added 行与两侧 1-based 行号、3 行上下文），跨 scope 返回 400 `diff_scope_mismatch`，版本不存在返回 404 `version_not_found`。这三个读端点与写端点一样仅限面板 Session。
- 恢复：`POST /prompts/versions/:id/restore`（body `{ note? }`）把该版本内容写回并**追加**一个 `rollback` 版本（默认 note `Restored from version N`）；历史从不删除。每个 scope 只保留最近 100 条（按 `seq` 修剪），且不随 `retention.online_days` 清理——Prompt 历史是配置，不是会话数据；见 [data-layer.md](data-layer.md#prompt-版本迁移-031)。
- 运行中的 Invocation：保存与恢复的响应带 `affected_running`，统计 `config_hash` 与新 active hash 不同、仍在运行的 Invocation（群级只统计该 Chat 的 Conversation，同时覆盖群迁移前后的 Telegram Chat ID）与 `context_rebuild: true`（Prompt 变化在下一轮运行时重建受影响的 Conversation Context）。`POST /prompts/cancel-running`（body `{ scope: 'global' }` 或 `{ scope: 'group', chat_id }`）只取消这些运行：过期它们已 attach 未注入的 Bucket（`error_code = admin_cancel`）并 abort 运行；正在收集与已排队的 Bucket 不受影响，因为它们是未来的 Invocation、会以新 Prompt 开始；已发出的消息与已完成的副作用不撤销。响应 `{ expired_buckets, canceled_invocations }`，没有受影响运行时为 0。
- 响应：成功为 `{ status: 'saved', version, applied, restart_required, outside_serve, active_hash, file_hash, affected_running, context_rebuild }`；内容与文件当前值（去注释后）一致时返回 `{ status: 'unchanged', version }`，不写文件、不记版本；文件已写入且版本已记录但配置没应用时返回对应配置错误码，message 以 `The prompt file was written and the version recorded, but the configuration was not applied: ` 开头并附 `version`。

## Models 页写端点

所有写端点：路径在 `/api` 下；必须带 `If-Match: <revision>`（缺失返回 400 `revision_required`，过期返回 409 `config_conflict` 且文件不变）；在 `ConfigReloader` 的锁里「写文件 → 应用」；响应是 `GET /providers` 的完整视图加上 `apply: { applied, restart_required, outside_serve }`。模型 id 可能含 `/`，路径里必须 `encodeURIComponent` 编码：服务端先按 `/` 切分再逐段解码，未编码的 id 不会匹配到路由。

前端的 `If-Match` 必须是编辑表单**起步时**那份数据的 revision，而不是最新查询结果的 revision，否则后台刷新之后，用旧快照填的表单也能通过并发检查，覆盖掉别人的修改。模型编辑对话框在打开时记下 revision，保存遇到 409 会关闭对话框，提示重新打开编辑最新版本。Provider 连接卡片记住草稿所基于的 provider 与 revision，比较（含「哪些已保存的 header 被删掉了」）和提交都用这份基线；服务端数据变化后，没有改动的草稿自动跟上，有改动的草稿禁用 Save 并显示 Reload，重新加载前不能再次提交。Header 行用稳定 id 作为 React key，不用可编辑的名字。

| 端点 | 语义 |
| --- | --- |
| `POST /providers` | 新建 Provider。body：`alias`、`kind`、builtin 的 `provider` 或 custom 的 `base_url` + `api`、`api_key`（必填明文，存入 `key.json`）、`headers?`、`models`（至少 1 个）。alias 已存在返回 409 `provider_exists`；builtin 不满足收录规则返回 400 `unknown_builtin_provider` / `unsupported_builtin_provider`；模型违反 `max_tokens ≤ context_window` 或 compat 适用性返回 400 `invalid_model`。新增 Provider 热应用：注册表随配置重建，新 Provider 立即可用于 `POST /providers/discover` 的 saved 模式与 `PUT /model` |
| `PUT /providers/:alias` | 修改连接字段。`api_key` 省略表示保持；`headers` 按名称逐项处理（省略保持、字符串替换、`null` 删除）。**修改 `base_url` 时必须在同一次请求里重新提交 `api_key` 与全部已有 header 值**，否则返回 400 `credentials_required`——面板被盗用时改地址即可把已保存的凭据引向攻击者的服务器。builtin 只接受 `api_key`，其它字段返回 400 `immutable_field`；`kind`、`alias`、builtin 的 `provider` 都不可改。没有任何字段变化返回 400 `no_changes` |
| `DELETE /providers/:alias` | 删除。文件里的全局 agent、任一 Chat 覆盖或 vision 指向它，或文件里已移除但运行中等待重启移除的 Chat 仍引用它时，写入前返回 409 `provider_in_use` |
| `POST /providers/:alias/models` | 批量追加模型（`models`，1–200 个）。id 重复返回 409 `model_exists`。热更新 |
| `PUT /providers/:alias/models/:id` | 替换单个模型定义，body 的 `id` 必须等于 `:id`（否则 400 `invalid_model_id`）。热更新：candidate 取文件里的新定义，注册表随之重建；运行中的 Invocation 继续用它启动时的快照 |
| `DELETE /providers/:alias/models/:id` | 删除模型。文件里的全局 agent、任一 Chat 覆盖或 vision 使用它，或待重启移除的运行中 Chat 仍使用它时，写入前返回 409 `model_in_use` |
| `POST /providers/discover` | 拉取模型列表并解析元数据，同时充当连接自检（界面上的 “Test”）。两种模式二选一：`{ alias }` 用运行中快照的 baseUrl 与凭据（不重新解析文件里的 SecretRef，`env`/`command` 不会执行；文件里的连接字段与运行中的 active 配置不一致时返回 409 `connection_not_applied`，文件里有、运行中没有的 Provider 返回 409 `provider_not_registered`），或临时模式 `{ kind, provider \| base_url+api, api_key, headers? }` 用请求体里的完整连接。响应 `{ endpoint, models: [draft], metadata_source_error }`，每个 draft 带元数据、来源标记与 `configured`。上游错误经脱敏后以 502 `provider_discovery_failed` 返回 |
| `POST /providers/lookup-metadata` | 给定手动输入的模型 id 列表（1–100）只做元数据解析，不访问供应商端点。响应 `{ models: [draft], metadata_source_error }` |

`metadata_source_error` 只在 models.dev 目录拉取失败时非空：目录只是元数据来源之一，列表本身仍然可用，拿不到的字段一律标成「缺失」并要求管理员确认，而不是让整个请求失败。

草稿字段：`id`、`name`、`reasoning`、`thinking_levels`、`input`、`context_window`、`max_tokens`、`cost`、`requires_reasoning_content`、`sources`（逐字段来源：`openrouter`/`vercel`/`gemini`/`models.dev`/`models.dev-cross-provider`/`models.dev-fuzzy`/`missing`）、`requires_reasoning_content_source`、`match`、`candidates`、`needs_confirmation`。字段为空、只由「猜出来的」来源支撑、或列为 `needs_confirmation` 时，面板必须让管理员确认或手填后才能保存；服务端不填任何默认值。

`match.confidence` 说明这份元数据是怎么找到的，也决定了要不要确认：

| confidence | 含义 | 来源标记 | 是否需确认 |
| --- | --- | --- | --- |
| `exact` | 就在该 Provider 对应的 models.dev 条目下（builtin 按映射表，custom 按 base_url 主机） | `models.dev` | 否 |
| `cross-provider` | 模型 id 精确命中，但命中的是**别的** provider——不知名中转站的常态 | `models.dev-cross-provider` | 是 |
| `fuzzy` | 去掉 `~` 前缀、`:free` 之类后缀和 vendor 前缀之后才匹配上 | `models.dev-fuzzy` | 是 |

`cross-provider` 也要确认，是因为同一个模型 id 在不同 provider 下是不同的部署，价格、上下文、输出上限与可选的 thinking 级别都可能不一样（同一个 DeepSeek 模型，DeepSeek 官方给 `high`/`max`，OpenRouter 给 `high`/`xhigh`）。`thinking_levels` 只在最终 `reasoning` 为 `true` 时才有值；拿不到时为 `null`、来源 `missing`，但**不**列入 `needs_confirmation`——配置里省略它就是沿用 Pi 默认。`requires_reasoning_content_source` 只在真的映射出 `true`（models.dev 的 `interleaved.field === "reasoning_content"`）时才指向 models.dev；`interleaved` 缺失、是裸 `true` 或写的是别的字段名时一律是 `missing`——值留在「自动」，没有来源填过它。

**SecretRef 只写不读**：面板只接受明文 `api_key` / header 值，并把它存进配置文件同目录的 `key.json`，`config.jsonc` 里只写 `{ "jar": "<name>" }`（每次提交都生成新条目名，被替换或随 Provider 删除的旧条目随后清掉，见 [configuration.md](configuration.md#secretref)）。面板不能写 `{ env }` 或 `{ command }`（`command` 等于让面板在宿主机上执行命令；`env` 配合可编辑的 `base_url` 等于能外泄进程里任意环境变量）。输入框固定提示 “Set - leave empty to keep it”：留空表示保持，非空表示替换成 key jar 条目。代价是：原来用 `env` 的 Provider 在面板里被替换后，环境变量不再生效，页面上也看不出这一点——要继续用 `env` 管理 key 的人只能手改配置文件；又因为 `base_url` 改动强制重填凭据，改地址会把 `env` / `command` 引用一并换成 key jar 条目。服务端收到明文后先 `secrets.remember(value)` 注册进 `SecretStore`，再写文件或发请求，这样日志、reload 错误与上游报错都能脱敏。请求提交的明文走单独一条有上限的队列（最旧的会被挤掉），不会像配置里解析出来的 Secret 那样永久累积；面板路径也从不调用 `secrets.resolve`，因此请求体里的字符串不会进入进程级的永久集合。

`/contexts` 按 `last_active_at` 倒序，游标是 `last_active_at|id` 复合值（`invalid_cursor` 由解析失败给出）。`GET /contexts/:conversation_id` 返回 Context Header 加上保留窗口（`seq >= head_seq`）内的 `context_messages` 与存活 `context_refs`；`payload_preview` 截断到 2000 字符并附 `payload_truncated`，被 GC 软删的行不出现在响应里。两个端点都是 `GET`，前端页面不发任何写请求。

`GET /stickers` 不列出群聊中收到的任意 Sticker。只有 `telegram.sticker_sets` 中配置的 Set 才会同步到该索引并获准供 Bot 搜索和发送；聊天媒体的按需视觉分析属于 `media_analyses`，在消息详情中展示。

列表参数：`limit`（1–100，默认 25）、`cursor`（上一页 `next_cursor`）、`state`、`chat`、`set`、`search`；Invocation 列表另支持 `at` / `from` / `to`。分页为 ID 倒序 keyset：请求 `limit + 1` 行，多出一行则返回 `next_cursor`。

Invocation 的关键词与时间只匹配冻结 `section=new` 的公开 text/caption（含追加批次）与同 Invocation 的成功 Bot 发送，不匹配私有 Assistant 文本、工具结果或失败发送；关键词与时间必须命中同一条消息，其余过滤条件继续取交集。Bot 文本优先使用出站消息当前修订的 text/caption，缺失时回退已接受的 send 参数；时间优先出站消息 `telegram_date`，缺失时回退发送 `finished_at`。带关键词或时间过滤时列表项追加 `matched_messages`（最新 5 条、时间倒序，同时间按精确 Telegram message ID、内部发送 ID 与来源稳定排序；预览截断 2000 字符），不带过滤维持原响应形状。Bot 条目的 `telegram_send_id` 是切片重放的候选内部发送 ID，必须再用同一 ID 预检：搜索保留该 Invocation 向其他 Conversation 的真实发送，但跨 Conversation 的发送不能作为该 Invocation 的切片目标。

时间格式为 `YYYY-MM-DD[空格或T]HH:mm[:ss[.1-3位]][Z|±HH:mm]`；`at` 命中所写精度窗口（分钟、秒、小数 1/2/3 位对应 100/10/1 毫秒），不可与 `from` / `to` 同用；区间为 `[from, to)`。显式 offset 优先，无 offset 时仅使用指定 Chat 的配置时区或全局时区，不回退主机时区；DST 不存在或重复的本地时间拒绝，需明确 offset。非法时间或区间返回 400 `invalid_at` / `invalid_from` / `invalid_to` / `invalid_time_range`。

输入校验在 `src/ingress/admin/audit.ts`：`state`/`set` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`，`chat`/`cursor` 必须是整数，`search` 最长 100 字符且 `LIKE` 通配符经过转义。非法输入返回 400 与稳定错误码（`invalid_limit`、`invalid_state`、`invalid_cursor`…）。所有查询使用绑定参数。

SQLite `bigint` ID 在 JSON 中字符串化，Token/计数等小整数转 `number`。Alarm 列表是 `plugin_id = "alarm"` 对 `long_tasks`/`task_receipts` 的兼容投影：waiting 或 completed+pending 为 `pending`，claimed 为 `firing`，handled 为 `fired`，取消任务或 suppressed 投递为 `cancelled`。列表项把 `message_thread_id`、目标 User ID、conversation ID 与关联 Invocation ID 全部字符串化，展开详情展示完整 summary、原始 UTC 计划时间、conversation ID、Telegram Chat ID、thread ID、目标 User ID、创建/触发/取消时间、取消者、取消原因、Invocation 结果、`admin_cancelled` 标记与 `updated_at`。

## Developer 页

Manage → Developer 独立管理调试选项。`GET /developer` 返回 `revision`、文件值 `record_model_payloads` 和运行值 `active_record_model_payloads`；缺少整个 `developer` 节或其中的字段都等价于 `false`。读取与修改配置需要 `ConfigReloader`，不可用时返回 503 `developer_unavailable`。

`PUT /developer` 接受严格的 `{ record_model_payloads: boolean }`，必须带上述 revision 的 `If-Match`。通过 `ConfigReloader.writeAndApply` 保留 JSONC 注释、校验并原子写入，再热应用；revision、失败后文件/运行态分离等契约与其它配置端点一致。成功返回更新后的视图与 `apply`。页面立即保存开关，成功或失败后都刷新配置相关视图；应用失败时展示当前运行状态。

`DELETE /developer/model-payloads` 需要登录和与其它写端点相同的 Origin 校验，但不依赖配置文件有效。页面必须先通过 `ConfirmDialog` 确认。后端固定清理开始时最大的 model call ID，按主键范围每批最多 100 行做集合更新，批次之间释放写锁并让出事件循环；不会把报文加载进 JS。仅将两列（`request_json` 与 `response_json`）置为 `NULL`，不删除 Invocation、model/tool call、Telegram 发送、关联、Token/cache usage、费用、状态或错误。成功返回 `{ cleared_model_calls }`，没有报文时为 0；同一进程已有清除操作时返回 409 `clear_in_progress`。中途失败时已完成的批次保留，可安全重试。

开关不删除历史报文，清除也不关闭记录：开启记录时，新调试报文仍可继续写入。清除不影响基于公开消息的场景重建，详情对空报文显示未记录或已清除。旧重放输入列由迁移 `030` 删除；清除端点本身不需要新增迁移，不自动清理历史，原有 retention 不变。清理只影响在线数据库，不修改既有备份；SQLite 释放的页可供复用，文件未必立即变小，端点不执行 `VACUUM`。

## Inspection 只读视图

`GET /api/config/view`、`GET /api/prompts/global`、`GET /api/prompts/group` 与 `/api/invocations/:id/{prompts,replay-preflight,media}`（含 `media/:media_id/content`）是 Session 与 Bearer API key 共用的只读检查路由：不调用模型、不写审计与配置、不发送 Telegram 消息（密钥鉴权仍刷新自身 `last_used_at`；媒体内容读取会经 Bot 的 Telegram 客户端下载被授权的文件字节）。面板前端目前没有对应页面，接口供 CLI 与评估工具使用。配置与 prompt 路由只允许 `source`（`active` 或 `file`，默认 `active`）以及 `prompts/group` 必需的 `chat`：未知或重复参数返回 400 `invalid_query`，非法 source 返回 400 `invalid_source`，缺少或非法 chat 返回 400 `invalid_chat`（有符号 64 位十进制），chat 未配置返回 404 `chat_unconfigured`；`invocations/:id/prompts` 与媒体列表不接受查询参数，`replay-preflight` 只接受一个 `before_send_id`（正整数十进制字符串；0 或溢出返回 400 `invalid_before_send_id`，重复或未知参数返回 400 `invalid_query`），媒体内容只接受一个 `variant`。JSON 响应经 `SecretStore` 与调用方密钥脱敏并带 `cache-control: no-store`；媒体二进制保留响应原字节，不做文本脱敏。

- `config/view` 返回 `{ source, generation, active_hash, file_hash, restart_required, config }`。`config` 是**显式脱敏投影**，不是原始配置文件：Provider 只有 alias/kind/base_url/header_names（永不含值）与模型定义，`telegram.chats[]` 只报告 `group_prompt_configured` 布尔值而不返回 instructions 正文，MCP 只报告 header/env 名称，图片只报告模型能力，`agent` 只列预算/并发/上下文等运行字段——任何 `api_key`、SecretRef 与 prompt 正文都不会出现。`source=active` 读运行中的快照；`source=file` 需要 `ConfigReloader`（未接线返回 503 `config_read_unavailable`），重新从磁盘加载，权限或内容校验失败返回 422 `config_invalid`（不回声文件内容）。
- `prompts/global` 返回配置中的全局 `agent.system_prompt`；`prompts/group?chat=` 返回该 Chat 的 `instructions`，`chat_id` 是请求的 Telegram Chat ID，`configured_chat_id` 是配置项 ID（Chat 迁移后可分辨两者）。两者都带 `scope`、`prompt`、`content_hash` 与 `core_read_only: true`；`content_hash` 是 Prompt 去 HTML 注释后内容的 SHA-256，也是 Prompt 写端点 `If-Match` 要求的值（见「Prompts 页端点」）；`core_read_only` 指运行时拥有的固定 prompt 段永远不可覆盖，replay 可替换的只有 global/group 两层。`source=file` 与 active 的差异同 `config/view`，两者不会互相替代。
- `invocations/:id/prompts` 返回场景重放将使用的**当前 active 配置**两层模板：`{ source: 'active', source_invocation_id, global_prompt, group_prompt, template_values, core_read_only: true }`；`template_values` 同样是当前 agent/vision 模型引用与 timezone，不是历史记录。它与重放共用场景守卫，不从旧报文或私有 Context 反推 prompt。
- `invocations/:id/replay-preflight` 不发起模型请求，返回 `{ available, reason, message, prompt_overrides_available, omitted_images, scene?, fidelity }`；`scene` 给出 cutoff、开场 Bucket 与消息/历史/省略数量，带 `?before_send_id=` 时改为切片选择，`scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }` 且 `history_count` 为 0。场景可用时支持两层覆盖；不可用时 `reason` 为稳定错误码（如 `replay_source_unfinished`、`replay_scene_unavailable`、`replay_scene_invalid`、`replay_slice_empty`、`replay_slice_target_invalid`、`replay_chat_unconfigured`、`replay_topic_unconfigured`、`replay_model_unavailable`）。Invocation 不存在仍是 404 `not_found`。不返回录制开关或历史模型请求 ID，读取免费，不写生产业务状态。
- `invocations/:id/media` 列出该 Invocation 冻结快照**显式授权**的媒体：条目只来自 `invocation_messages.snapshot_json` 列出的媒体 ID，且仍指向快照时的 revision、属于同一 Conversation。每项为 `{ id, message_id, revision_id, kind, mime_type, file_size, variants }`，其中 `message_id` 是内部消息 ID；不返回 Telegram file ID、Telegram message ID、文件路径或原始 Telegram JSON。快照无法证明其媒体列表时返回 409 `snapshot_invalid`，未知 Invocation 返回 404 `not_found`。
- `invocations/:id/media/:media_id/content?variant=original|preview` 返回二进制附件（`content-disposition: attachment`、`cache-control: private, no-store`、`x-plasticwan-media-variant`）。默认 original；preview 只对 photo/sticker 可用，走与 Bot 相同的规范化管线输出 JPEG/PNG，其余类型返回 400 `invalid_variant`。original 只透传白名单 MIME（jpeg/png/webp/gif/webm/tgs），其余与未知类型以 `application/octet-stream` 提供。读取复用共享 `MediaDownloader`，每次使用一个新的私有临时目录，退出时以递归 `rm` 尝试删除（最多重试 3 次，递增等待基数 100 ms）；持续清理失败返回 500 `media_cleanup_failed`，不返回文件字节、不泄露原始文件系统错误或路径，且仍释放单飞槽位；清理失败可能留下目录，该错误优先于读取结果或读取错误。单文件上限 20 MiB；60 秒是覆盖整次读取（下载、preview 规范化到最终读回）的**信号预算**，不是对底层操作的强制中断承诺：`getFile` 没有 signal，请求中止时客户端竞速会立即拒绝，清理尝试结束后释放单飞槽位，但底层 Telegram API 请求仍继续到响应为止（迟到结果被丢弃、不写文件）；原生 Sharp 解码/编码不可中断，读取只能在完成后的检查点拒绝返回字节，所以 preview 可能晚于 60 秒才以 504 `media_timeout` 收尾。同一进程同时只允许一个媒体下载（第二次返回 429 `media_busy`，元数据列表不占该槽位）；超限返回 413 `media_too_large`，请求中止 499 `media_aborted`，上游失败 502 `media_download_failed`（消息不携带上游细节），未接线返回 503 `media_unavailable`。未授权、跨 Conversation 与不存在的媒体统一 404，不提供存在性探测。

## Invocation 重放

`POST /api/invocations/:id/replay` 仅接受 Bearer API key，用**当前**配置重放一次已结束的 Invocation，由 `src/orchestration/replay.ts` 执行、`AdminServer` 只做转发（引擎未接线时 503 `replay_unavailable`）。请求体严格为 `{ global_prompt?, group_prompt?, before_send_id? }`，前两者只允许替换 prompt 的两个可编辑层：省略某层表示沿用当前 active 配置值；`global_prompt` 不能为空（空串在边界返回 400 `invalid_body`，去注释后为空由引擎返回 400 `replay_prompt_empty`；含 NUL/BOM 或未知模板变量返回 400 `replay_prompt_invalid`；每层超过 65536 字符在边界返回 400 `invalid_body`），`group_prompt` 允许空串以显式丢掉群指令。`before_send_id` 是正整数十进制字符串（0、溢出或非十进制返回 400 `invalid_before_send_id`），选择切片边界；预检与重放必须使用同一值，它不是 prompt 覆盖。body 上限 1 MiB（超出 413 `body_too_large`），其它字段返回 400 `invalid_body`；`system_prompt` 已从契约删除且无别名，固定段与协议字段同样不可覆盖。请求的 `AbortSignal` 直接传给引擎，客户端断开或进程关停都会中止重放。

引擎行为（也是响应 `fidelity` 字段承诺的边界）：

- **输入是历史公开聊天场景**（`fidelity.input: "historical_public_chat"`）：以 `invocations.created_at` 为 cutoff，读取开场 Bucket 的冻结 `new` 消息，优先用冻结 `history`，其余历史只选当时已到达、修订时间可证明且早于开场末条的消息。后续 attach、后续编辑与本次运行后来发出的 Bot 回复不加入；当前 history/上下文预算、Topic allowlist 与 `/cut_topic` 切点继续生效，ignored-user 设置不追溯过滤。冻结身份损坏拒绝，缺失媒体/历史修订显式降级或省略。开场无保留消息返回 `replay_scene_unavailable`，损坏返回 `replay_scene_invalid`；不读 `request_json`、私有 canonical transcript 或旧 replay payload。不要求源调用过模型，不依赖 `developer.record_model_payloads`。
- **切片重放（`before_send_id`）**：输入改为只取该次成功 `telegram_sends` 之前的一小段公开窗口——严格位于上一条 Bot 发言之后、目标发言之前（两端不含），上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation，没有上一条时从保留输入开头开始；目标是失败的、别的 Conversation 的或不存在的发送返回 `replay_slice_target_invalid`，窗口内没有新的公开消息返回 `replay_slice_empty`（均 409）。输入只含冻结且已注入的公开消息（目标之前已注入的批次拍平后一次性灌入，不按 Bucket 或历史节奏等待；模型并发与网络延迟仍可能造成等待），不读更早历史、历史 reasoning、工具结果或 system prompt；原 Bot 回答不进入模型，只留在审计中对照，回复引用不能跨出窗口。`scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 取该次发送的 `created_at`（请求开始，不是投递完成；`hot_injections: "flattened_before_send"`）。
- **prompt、模型与工具定义都用当前配置**：global/group 模板、渲染变量、固定协议、可见 Skill 索引来自当前 active 配置，覆盖只替换可编辑层。当前 Provider/model/thinking level 按源 Chat 解析；Chat/Topic 不再允许或模型不可用即拒绝。生产注册表只提供定义，不把生产执行器接入循环；`zzz` 可见性遵循当前低于 5% 剩余预算规则，但执行不写睡眠、不扣预算。
- **工具副作用隔离**：`send` 只收集 `outputs`，按当前 Schema、文字长度/空行限制与本场景 reply 可见性校验；不执行真实发送、速率闸门或图片/Sticker 世界状态验证。记忆与 Alarm 从空内存起步，typing 与生图只返回合成回执，`zzz` 不持久化。`read` 只读当前 `system:///`；MCP、网页抓取、Sticker 搜索与未支持能力 blocked。
- **图片按场景授权后按需读取**：当前模型支持图片且接线 image loader 时，保留的 Photo、Sticker、图片 Document 获得一次性 `img_` 引用；`execute.call read_image` 只下载/规范化该引用的媒体并给当前模型返回图片，不调用生产 Vision 或写分析缓存。引用不跨场景，不接受任意 file ID；媒体缺失、不支持或下载失败有明确省略/错误，`omitted_images` 是渲染时没有授权引用的媒体数量，不是之后读取成功的保证。
- **不是历史私有 Agent 状态复现**：不恢复 thinking、工具结果或记忆/任务回执；默认模式不加入后续热注入，切片模式仅拍平可证明在目标发送前已注入的公开批次。渲染时间默认是场景 cutoff，System Resources 是当前版本。发送提醒关闭，不模拟 send barrier、真实限流与全局睡眠阻断。模型请求是真实调用并**按 Provider 计费**，共享生产模型并发闸门，但不写生产审计、Conversation Context、引用或 `daily_usage`（`fidelity.production_budgets: "not_charged"`），关闭自动重试（`maxRetries: 0`）。
- **限流与预算**：同一进程同时只允许一个重放，运行中再次请求返回 429 `replay_busy`；轮次取 `min(20, agent.rate_limits.turns_per_injection)`，wall clock 取 `min(240s, agent.context.max_wall_clock_seconds)`；工具调用尝试固定上限 128（含未知工具名与非法参数，在 `tool_execution_start` 即计数）；trace 投影累计上限 1 MiB。超限以 `turn_budget`/`timeout`/`tool_budget`/`trace_limit` 等 `error` 结束，结构照常返回。

响应（`version: 2`）包含 `replay_id`、来源 ID（invocation/conversation/chat/thread）、`scene`（cutoff、开场 Bucket、消息/历史/省略数量，切片时另含 `slice` 三元组与 `history_count: 0`）、实际使用的当前模型、`overrides`（两层各自是否被替换）、`started_at`/`finished_at`/`latency_ms`、`completion_reason`、`responded`/`send_count`/`outputs`、`tool_calls`（含结果与 `is_error`）、`usage`（`model_calls` 是实际模型请求次数）、`trace`、`error` 与 `fidelity`。`fidelity.dispatches[].mode`（`synthetic`/`live_read`/`blocked`）是**调用走的分派路线，不是执行结果**：`blocked` 在拒绝抛出之前记录、`live_read` 在读取尝试之前记录，成功与否看 `tool_calls`。`trace` 是循环内每条消息的脱敏 JSON 投影（同一内容可能重复出现），1 MiB 上限约束的是投影总量，不代表完整 Provider 响应被完整封顶保留。模型决定不发言（0 个 `send`）是正常成功结果。

## 静态资源

非 `/api` 路径由 `AdminServer` 从 `static_dir` 提供：

- 路径解析后必须仍在 `static_dir` 内，否则 404，避免穿越。
- 命中文件按扩展名设置 Content-Type，非 HTML 资源 `max-age=3600`。
- 未命中时回退 `index.html`，支持前端路由深链接。
- 所有响应带 `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options: DENY`；HTML 额外带 CSP（`default-src 'none'`，脚本仅 `'self'`）。

## 前端

```bash
pnpm run admin:build   # 生成 apps/admin-next/dist，供 serve 托管
pnpm run admin:dev     # Rsbuild dev server，监听 127.0.0.1:5273，/api 代理到 ADMIN_API_TARGET
pnpm run admin:test:e2e  # Playwright 浏览器 E2E（真实 AdminServer + 临时 SQLite + 合成数据）
```

`ADMIN_API_TARGET` 默认 `http://127.0.0.1:8787`。开发代理只把 Origin 精确等于
`http://localhost:5273` / `http://127.0.0.1:5273` 的请求改写为目标的 origin，
其它 Origin 原样转发、由后端跨站校验拒绝（人工验证脚本见
`scripts/admin-dev-proxy-probe.ts`）。生产环境不需要该变量：`serve` 同源托管静态文件与 `/api`。

结构：

| 文件 | 职责 |
| --- | --- |
| `src/routes/**` | 文件路由（TanStack Router 官方 Rsbuild 插件）：`__root.tsx` 是认证门（setup/login gate）与 Layout，其余文件对应一级页面与详情页；新增页面在这里加文件，`src/routeTree.gen.ts` 由构建自动生成 |
| `src/lib/api.ts` | 类型化 fetch 封装与 `ApiError` |
| `src/lib/queries.ts` | TanStack Query option 工厂（列表用 infinite query，keyset cursor 透传） |
| `src/lib/format.ts` | 格式化与状态色映射 |
| `src/lib/errors.ts` | `errorMessage()`：统一错误文本（`ApiError.code: message`） |
| `src/lib/memory-ttl.ts` | 记忆 TTL 边界纯函数 |
| `src/lib/timeline.ts` | Invocation 时间线纯模型（同时间排序、send 参数解析） |
| `src/components/business/**` | 共享业务组件（CursorList / FilterToolbar / StateBadge / TableShell / JsonViewer / KvList / ConfirmDialog / ChartCard / PrivateReasoning / DetailState 等），契约见 `apps/admin-next/README.md` |
| `src/pages/*.tsx` | Overview、Tool sessions、Contexts、Alarms、Messages、Memories、Bot admins、Sticker Set 索引、Models、Chats、Settings |

前端约定：

- 替换列表内容的详情页使用非嵌套路由文件（如 `image-generations_.$generationId.tsx`），与列表并列挂到根布局；URL 仍是 `/image-generations/:generationId`。只有需要在父页 `Outlet` 中显示的内容才使用嵌套文件，避免详情匹配成功却只渲染列表。
- 业务页面一律 `useQuery` / `useInfiniteQuery` 并显式渲染 loading / error / data
  三态，**禁止 `useSuspenseQuery`**（401 会在渲染期抛出并落进路由错误边界，
  产生无法恢复的死屏；显式状态分支把错误留在页面内展示）。
- 受保护请求的 401（`unauthenticated`）由 `src/lib/query-client.ts` 的全局
  cache `onError` 统一处理：失效 session query，让认证 gate 回登录页；登录 /
  setup / 改凭据的 `invalid_credentials` 等 401 属于表单错误，必须留在表单内，
  判定按错误 code 而不是 status。
- 详情页 loading/error 复用 `components/business/detail-state.tsx` 的
  `DetailSkeleton` / `DetailError`，错误行显示 `ApiError.code: message`。

Overview 的 Bot status 卡片显示当前 `sleeping`/`awake`、`sleep_until`，睡眠时提供带确认的 `Wake now` 操作，并显示所有 `chat_pause` Chat 的名称或 Telegram ID 与暂停时间。

Settings 页有一张 `Configuration file` 卡片：显示 generation、active hash 与 file hash、待重启字段列表与 last error，并提供 `Apply config file` 按钮（调用 `POST /config/apply`），成功或失败后都刷新配置状态。

Models 页是 Provider 与模型的管理器：顶部 “In use” 面板显示文件里的 agent 模型、vision 模型与 “Thinking effort” 下拉框（只列 agent 模型接受的级别，改动走 `PUT /thinking-level` 热应用；切换 agent 模型后提示 “Thinking effort reset to …”）；下方左栏 Provider 列表（搜索、Agent/Vision 在用徽章），右栏连接字段与模型列表。四个区域都是 `Panel`（In use、左栏、Connection、Models），列表项与表格都不再套自己的边框，保持「一个区域一个边框」。连接区里 builtin 只读展示 Pi 的供应商名与 baseUrl，custom 可编辑 `base_url` 与 `api`；API Key 与 header 值一律 `type="password"` 且没有查看按钮，提示 “Set - leave empty to keep it”；`base_url` 一改动，key 与所有 header 值立刻变成必填。模型区是一个 flush 面板：表格贴边、只保留标题下那条线，行内用图标标出 image / reasoning 能力（带 sr-only 文本），并显示 context / max output 与在用徽章，行末是 “Set as agent” “Set as vision” 与编辑 / 删除图标按钮。面板标题栏放 “Fetch models”（发现 + 元数据预览；连接字段还没应用时改用临时模式并要求再填一次 key）与 “Add by id”；编辑弹窗里元数据字段带来源标签与匹配来源；勾选 reasoning 后出现 thinking levels 复选框，全部不勾即沿用 Pi 默认；compat 三态放在折叠的 “Advanced” 区，只显示当前 API 适用的字段；`tool_schema_keywords` 三态（`Automatic` / `minimal`）放在 thinking levels 之后，对所有 API 都显示——它由运行时读取，不是 Pi 的 compat。草稿行对推理模型多显示一项 “thinking”（级别列表或 “Pi default”）。带 “N to confirm” 的草稿不能直接提交：字段齐全的可以用 “Accept listed values (N)” 一次接受列表里显示的值，有空缺的必须进编辑弹窗填写。Models 页的写入全部热应用，模型行不再出现待重启徽标；顶部横幅与 “Restart now” 按钮仍服务于其它 restart 字段（部署方未声明进程监督时隐藏），点击后界面会断开并轮询等待服务恢复。保存反馈在没有待重启字段时为 “Applied”；已有其它待重启字段时为 “Saved, restart required”。界面文案全部是英文，与面板其它页面一致。

Tool session 详情默认打开 Overview 时间线：按时间合并冻结消息、Invocation 生命周期、Model Call、Tool Call 与 Agent transcript；消息正文和 `send` 参数中的发送内容直接展示，Tool 结果与完整参数按需展开。失败的 Model Call 同时展示稳定错误码，并可展开查看经密钥脱敏的完整 Provider 错误详情。Assistant 文本显式标注为私有推理，只有 `send` Tool 会发往 Telegram。

Messages 列表与消息详情的 Revision 在发送者姓名旁显示可复制的 Telegram ID；个人账号标为 `Telegram user ID`，匿名/频道身份标为 `Telegram chat ID`。消息自己的那列明确标为 `Telegram message ID`。Invocation 的 Overview 消息卡与 Frozen context 的 Sender 列从冻结快照 `sender.id` 显示 `Telegram sender ID`，不拿当前用户资料替换历史快照；旧快照缺少 ID 时显示 `—` 并隐藏复制按钮。`CopyableValue` 共用剪贴板交互：复制成功/失败显示 toast；浏览器拒绝或不提供剪贴板时提示选中 ID 手动复制，复制不产生 Admin API 写请求。中英文文案保持同步。

## 数据表

迁移 `src/store/migrations/003_admin.sql`：

| 表 | 用途 |
| --- | --- |
| `admin_users` | 用户名、Argon2id hash、创建/更新/最近登录时间 |
| `admin_sessions` | Token SHA-256 摘要、所属用户、创建/过期/最近活动时间 |

`admin_sessions.user_id` 级联删除；`admin_sessions_expiry_idx` 支撑过期清理。两张表不参与 `purgeExpiredData` 的在线保留窗口（`retention.online_days`）——管理员账号不是会话数据。

迁移 `src/store/migrations/028_admin_api_keys.sql` 建立 `admin_api_keys`：每行一个程序化 API key，`token_hash` 只存明文的 SHA-256 摘要（UNIQUE），`prefix` 是展示用前缀，`created_at`/`last_used_at`/`revoked_at` 记录生命周期；撤销设置 `revoked_at` 而不删除行，`last_used_at` 在每次通过鉴权时刷新（包括随后被权限面拒绝的请求）。该表与 `admin_users`/`admin_sessions` 一样不参与在线保留清理。语义见「程序化 API 密钥」。

Bot 管理员白名单不再是数据库表：迁移 `src/store/migrations/026_drop_bot_admins.sql` 删除了旧表 `bot_admins`（迁移 `008` 引入），唯一事实源是配置文件里的 `telegram.admins`，旧表内容用 `scripts/migrate-admins.ts` 搬迁。Admin Panel「Bot admins」页面经配置写端点增删该列表并热应用。Bot 管理员决定谁能执行 `/pause`、`/resume`、`/model` 与 `/cut_topic`，与面板登录账号无关。

## 验证

测试命令、覆盖契约与浏览器冒烟清单见 [verification.md](verification.md) 的「静态与单元验证」「Admin Panel 冒烟」与「Admin Panel 浏览器 E2E」三节。

## 图片设置与模型目录

`GET /image/config` 读取文件中的启用状态、模型完整定义、凭据名称、可复用的内置 OpenRouter Provider alias 列表 `credential_providers` 与文件 `revision`，不返回密钥或 SecretRef 内容。页面据此初始化草稿；保存携带该修订，缺失返回 400 `revision_required`，过期返回 409 `config_conflict`。新增模型或修改模型时可省略已保存的凭据明文，原有 jar/env/command 引用保持不变。

`GET /image/models` 从 OpenRouter 的公开 `GET /api/v1/images/models` 获取图片输出模型；`GET /image/models/endpoints?model=:id` 获取所选模型的真实供应商 `provider_tag` 与 `supported_parameters`。两者需要 Admin Session，图片禁用时仍可访问，不需要发送密钥，不写配置、不发起付费生成。固定上游地址，禁止重定向，超时 10 秒，响应流上限 8 MiB，外部响应经 TypeBox 校验，失败返回 502 `image_discovery_failed`。

`src/platform/image-models.ts` 把供应商元数据转换为可保存草稿：比例、质量取核心支持的枚举交集；图片输入/输出上限限制在核心范围内；未声明的能力保守保留自动档与单张输出。必填参考图、仅矢量输出或不接受单张生成的供应商会带 `unavailableReason`，页面禁止添加。质量仍映射到 `quality`，不会把像素 `resolution` 推断成质量档。OpenRouter adapter v2 直接发送 `aspect_ratio`，避免用固定像素 `size` 错误限制目录中的横竖比例。

图片设置仅在提交进行中禁用保存按钮；其它缺项在按钮旁显示并在点击时提示，拦截非法请求。完全相同的旧模型定义在前端草稿中合并，空白的新增凭据行不参与校验；保存才会修改文件。
