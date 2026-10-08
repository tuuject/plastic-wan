# Plastic Wan - 20261009 模型健康检查与批量取消

## 背景

Models 页已有的连接测试用于拉取模型列表，不能证明某个已配置模型能够完成一次文本生成。完整的 CLI Doctor 还会检查媒体依赖、工具调用、视觉、Telegram 和 MCP，不适合作为面板内逐个比较模型连通性与耗时的入口。

本次增加独立的模型健康检查：使用已生效的 Provider 连接和模型注册表，发送固定的最小请求，不切换当前 Agent/Vision 模型，也不借用聊天上下文。它是真实、可能计费的模型调用，因此必须限制并发、超时和重试，并在离开页面时停止尚未发出的批量任务。

## 主要变更

### 1. 诊断端点复用已应用配置，不接受临时连接

[src/ingress/admin/server.ts:897](../../src/ingress/admin/server.ts#L897) 新增 `POST /api/providers/health-check`。它只对面板 Session 开放，沿用 POST 的 Origin 校验；不属于 API key 的程序化接口，也不修改配置，因此不要求 `If-Match`。

请求体只接受 `{ provider, model }`，不能附带任意 URL、凭据或 Prompt。[src/ingress/admin/model-health.ts:51](../../src/ingress/admin/model-health.ts#L51) 在调用前检查：

- Provider 与模型必须存在于保存的配置中。
- Provider 连接与模型定义必须和运行中的快照一致，待应用的修改不能被悄悄忽略。
- 模型必须已注册且支持 text 输入。

不通过预检时返回对应的 4xx，不调用上游，也不新增模型诊断审计。通过后直接使用 active registry 和已经解析的凭据，不重新解析 SecretRef，不执行额外的 command SecretRef。

### 2. 固定请求、明确结果分类，区分 TTFB 与总耗时

[src/ingress/admin/model-health.ts:115](../../src/ingress/admin/model-health.ts#L115) 只发送一条 user 消息，内容原样固定为：

```text
reply with extract content: ok
```

请求没有 system Prompt、聊天历史或工具；输出上限为 `min(128, model.maxTokens)`，不覆盖适配器默认 reasoning 行为。每次检查最长 30 秒，禁用自动重试；本地取消 Promise 与模型调用竞速，即使适配器忽略取消，也能让诊断请求和审计按时落定。这不代表能够强制撤销供应商已经接收的调用或费用。

结果分为三类：

- `ok`：正常结束、没有 Tool Call，文本 trim 后精确为小写 `ok`。
- `unexpected_response`：正常返回非空文本，但内容不同；它不等于连接失败。
- `error`：空输出、非正常停止、Tool Call、超时或异常。

已进入模型调用的上游失败通过 HTTP 200 加 `status: 'error'` 返回，与参数、权限或配置错误的 HTTP 状态分开。TTFB 记录适配器首次报告 HTTP 响应头的时间，不是首个生成 Token；适配器没有报告时为 `null`，总耗时独立测量。

响应文本与错误先经过 `SecretStore.redact`，再各截断到 4096 字符。通过预检的检查写入一条 `model_calls.role = doctor` 记录，从 pending 推进到终态，记录可得的用量、费用、耗时及错误码，不保存原始请求/响应报文；`unexpected_response` 在审计中属于未达到诊断预期的 error。落盘逻辑见 [src/ingress/admin/model-health.ts:152](../../src/ingress/admin/model-health.ts#L152)。复用既有表和角色，没有新增数据库迁移或配置字段。

### 3. 单项、跨 Provider 批量与离页取消

[apps/admin-next/src/pages/models.tsx:110](../../apps/admin-next/src/pages/models.tsx#L110) 用页面内存保存勾选项和检查结果，支持行内检查、当前 Provider 全选以及切换 Provider 后继续选择。最多三个 worker 并行处理，完成一项就显示该项结果；单项错误不会终止整批，运行期间禁用重复检查和勾选操作。

状态、TTFB 与总耗时显示在模型行内，响应或错误可展开查看，长文本区域限制高度并允许滚动。结果不会持久化到浏览器，刷新或离开页面后清空；诊断审计仍保留在数据库中。

前端为整批请求共用一个 AbortController：卸载 Models 页时取消在途 fetch，worker 检查 signal 后停止取下一项，也不再向已卸载的页面回填结果。服务端同时限制最多三项诊断在途，超额返回 429；客户端断开与 Admin 关闭信号向模型调用传播，关闭时等待已登记的诊断审计落定。后端槽位与取消连接见 [src/ingress/admin/server.ts:908](../../src/ingress/admin/server.ts#L908)。

离页取消只阻止继续派发并请求中止在途调用，不保证供应商停止计算或免于计费。检查本身不改变 Agent/Vision 选择、配置 revision 或 Conversation Context。

### 4. 在注册表层修复 Provider Headers 传递

接入真实 SDK 链路时发现，Pi 的 completion 路径从 `Model.headers` 读取连接头，仅把已解析的 headers 挂在 Provider 上不足以让模型请求携带它们。

[src/platform/providers.ts:215](../../src/platform/providers.ts#L215) 统一将 Provider 的已解析字符串 header 映射到每个 Model，覆盖自定义 Provider、内置别名和只更新模型列表的注册表重建。null 条目被省略，不表示抑制适配器默认头；连接未变时继续复用已解析连接与 auth，而不是重新解析 SecretRef。这样在共享映射处修复请求链路，不为健康检查建立另一套 Provider 或鉴权逻辑。

Provider 回归检查 header 随模型列表更新保留且不重复解析。另对受影响的面板模型投影、runtime 请求/响应审计和错误脱敏链路做了只读复核，未发现此次增加 Model.headers 引出的新泄漏路径；该结论不等于全面安全审计。

### 5. 用显式门闩验证取消，避免自然完成造成假阳性

新增 [apps/admin-next/e2e/16-model-health.e2e.ts](../../apps/admin-next/e2e/16-model-health.e2e.ts#L1)，通过真实 AdminServer、生产 Admin bundle 和本地 SSE 上游检查单项、混合结果批量、并发限制、配置不变、刷新清空与窄屏布局。上游同时核对固定提示词、单条 user 消息、无 system/tools、流式请求及输出上限。

早期「等待 in-flight 归零」的断言不足以证明取消：本地上游也可能只是自然完成。最终夹具加入显式 hold/release 门闩，且 HTTP 错误请求与 SSE 请求都计入在途统计：

1. 增量结果测试先 hold 慢项，等快项结果和耗时已渲染、慢项仍显示 Checking，再显式 release，避免依赖两段固定延迟的相对速度。
2. 取消测试先 hold 全部响应，确认三项在途、第四项仍排队，再通过侧边栏 SPA 导航卸载 Models 页。
3. 在尚未 release、上游不可能自然完成时，断言三个请求都实际观察到客户端 abort、在途归零、第四项从未到达上游。
4. 回到 Models 页发起新检查，确认后端槽位已释放且新调用正常完成。

门闩见 [apps/admin-next/e2e/server.ts:140](../../apps/admin-next/e2e/server.ts#L140)，取消断言见 [apps/admin-next/e2e/16-model-health.e2e.ts:374](../../apps/admin-next/e2e/16-model-health.e2e.ts#L374)。这验证的是本地真实 HTTP 链路在响应前的取消传播，不把它扩大为所有 Provider 的中途流式取消保证。

Admin 写端点白名单、agent 文档入口、验证矩阵与[模型用户指南](../../apps/docs/content/docs/configure/models.md#L31) 同步说明实际计费、结果语义、TTFB 口径和取消边界。

## 验证

以下为代码提交前本次开发实际运行的验证，不是撰写日志时重新执行的全量测试。环境为 Windows、Node.js v24.18.0；本机全局 pnpm shim 指向缺失的 Node 版本，因此使用 `npx --yes pnpm@12.4.2`，没有为此修改项目包管理器配置。

```bash
npx --yes pnpm@12.4.2 test
# 94 个测试文件全部通过；1229 passed，6 skipped（共 1235 项）
# Duration: 312.80s

npx --yes pnpm@12.4.2 run check
# runtime / CLI / Admin / docs TypeScript 检查通过

npx --yes pnpm@12.4.2 run lint
# lint / format 通过；保留 3 条既有字符串拼接提示和临时研究 JSON 超出大小阈值的警告

npx --yes pnpm@12.4.2 run admin:build
npx --yes pnpm@12.4.2 run admin:test:e2e 00-auth 08-models 16-model-health
# 生产构建通过；22/22 浏览器测试通过
# 含最终门闩版增量结果与真实 SPA 离页取消断言；该组合重复运行通过

npx --yes pnpm@12.4.2 run docs:build
npx --yes pnpm@12.4.2 run docs:verify
# 文档生产构建通过；22 个 HTML/Markdown 页面、79 个 HTTP 资源通过（base /）

git diff --check
git diff --cached --check
# 代码提交前通过
```

独立后端复核另运行 Provider 管理与注册表两个测试文件，共 36 项通过；这是全量套件的定向重复验证，不与 1229 项相加。测试覆盖请求结构、真实本地 SSE、TTFB 与总耗时分离、无 hook 返回 null、权限与未应用配置拒绝、响应分类与脱敏、零重试、超时、取消、并发和终态审计。全量单测之后的追加改动仅涉及 E2E 夹具/断言与文档，最终版本再次通过相关浏览器测试、类型检查及 lint。

单独运行 `16-model-health` 的尝试未通过：新后端使用全新临时数据库，但浏览器复用了上一轮 Session 存储，未先运行 `00-auth` 时停在登录流程，后续模型选择超时。没有把该次运行计为通过，也没有顺带修改认证测试框架；最终采用上面的含 `00-auth` 组合通过。未运行完整 Admin E2E 集合。

所有模型验证使用 Faux/fixture、合成凭据与隔离临时数据库，没有调用真实 Provider 或 Telegram，没有启动真实 `serve`/`doctor`，也没有部署、接管或重启运行中的 Bot。文档 HTTP 验证仅针对本地构建产物，不代表公网托管环境验收。

撰写日志时再次运行 `npx --yes pnpm@12.4.2 run check` 与 `npx --yes pnpm@12.4.2 run lint`，均通过，既有提示不变；另核对了文内 11 个本地链接及行号范围，没有重跑全量单测或浏览器测试。

## 提交

```txt
f581a7bb33f9a98279cf8d31210c9c64706245ba Add model health checks to Admin Models page
```
