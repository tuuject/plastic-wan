# Plastic Wan Admin (Next)

Plastic Wan 的 Admin Panel 前端。构建产物是**静态 SPA**（Rsbuild + React + TanStack
Router/Query + Tailwind 4 + shadcn/Base UI），由后端 `AdminServer`（`serve` 进程内的
`src/ingress/admin/server.ts`）**同源托管**，不依赖任何 Node/Nitro 运行时。`dist/`
里的 `index.html` 由后端做深链接回退（未知路径回落到 SPA）。

## 命令

```bash
pnpm --filter plasticwan-admin-next run check   # TypeScript 严格检查（tsc --noEmit）
pnpm --filter plasticwan-admin-next run build   # 产出 dist/（静态 SPA）
pnpm --filter plasticwan-admin-next run dev     # Rsbuild dev server，监听 127.0.0.1:5273
pnpm --filter plasticwan-admin-next run test:e2e # Playwright 浏览器 E2E（见下文）
```

- `pnpm --filter plasticwan-admin-next run dev` 会把 `/api` 代理到 `ADMIN_API_TARGET`（默认
  `http://127.0.0.1:8787`），仅当浏览器 Origin 精确等于
  `http://localhost:5273` / `http://127.0.0.1:5273` 时才重写 Origin 为目标的
  origin；其它 Origin 原样转发，由后端拒绝。
- 生产环境不需要 `ADMIN_API_TARGET`：`serve` 在同源托管静态文件与 `/api`。
- Lint/格式检查走仓库根目录的 Biome（`pnpm exec biome check apps/admin-next`）。

## 路由与代码切分

路由是**文件路由**，由 TanStack Router 官方 Rsbuild 集成驱动（`rsbuild.config.ts`
里 `tools.rspack.plugins` 的 `tanstackRouter({ target: 'react', autoCodeSplitting: true })`）：

- `src/routes/**` 是路由文件（`__root.tsx` 是认证门与 Layout），`src/routeTree.gen.ts`
  由构建期自动生成：**已提交进仓库、被 Biome 忽略、不要手改**；新增页面 = 在
  `src/routes/` 加一个文件（组件本体仍放 `src/pages/`），然后在下次构建/`dev` 时
  让插件重写路由树。
- `autoCodeSplitting` 把每个路由的 `component` 切成独立 async chunk：首屏只加载
  shell 与当前路由，其余页面按需拉取。`src/main.tsx` 只从 `./routeTree.gen`
  取路由树，不要再手写 `createRoute` 路由表。
- 详情页与列表页是**平级**路由、不互相嵌套：文件名带 `_` 后缀
  （`invocations_.$invocationId.tsx` → `/invocations/$invocationId`，`createFileRoute`
  的 id 同样带 `_`）。漏掉这个后缀，详情页就会变成列表页的子路由并渲染进列表页的
  `<Outlet/>`——列表页没有 Outlet，页面会变成空白。

## 安全约定

- 主题初始化用同源 `public/theme-boot.js`（`localStorage` 键 `admin-theme`），
  不引入内联脚本、不写 cookie、不注入 HTML。
- 业务代码不引入 `dangerouslySetInnerHTML` / `document.cookie`；
  `src/components/ui/**`（shadcn vendor）是仅有的窄豁免目录。

## 许可与字体

本前端源自 Kiranism 的开源 dashboard 模板，MIT License 全文保留在
`LICENSE`（Copyright (c) 2025 Kiranism）。自托管字体来自 @fontsource 包
（Inter），按 SIL Open Font License 1.1 分发；随镜像发布的三方许可说明见
`NOTICE`。

## E2E 测试

```bash
pnpm run admin:build                       # 前置：E2E 驱动已构建的 dist
pnpm --filter plasticwan-admin-next exec playwright install chromium  # 首次运行前安装 Chromium
pnpm run admin:test:e2e                    # 或在本目录 pnpm --filter plasticwan-admin-next run test:e2e
```

Playwright 套件位于 `e2e/**/*.e2e.ts`（文件名不以 `.test.ts` 结尾，vitest
不会发现它们）。`globalSetup` 派生 Node 子进程 `e2e/server.ts`：临时目录 + 临时
SQLite + `test/fixtures/admin-seed.ts` 合成数据 + 真实 `AdminServer`
（`static_dir` 指向本包 `dist`），回环随机端口；`globalTeardown` 关闭并清理。
用例覆盖认证状态机、路由深链接、列表过滤与 Load more 游标分页、Invocation
六 Tab、记忆/管理员/模型/Chats/Developer/告警/Overview 写操作与冲突路径、只读保证与 CSP 同源
安全断言。真实命令与契约清单见
[agent-doc/verification.md](../../agent-doc/verification.md#admin-panel-浏览器-e2e)。

`e2e/server.ts` 另外为 Models 页准备离线夹具：一个回环 `/v1/models` 上游
（`e2e/models-fixture.ts` 定义模型 id 与密钥，`E2E_ACCEPTED_RELAY_KEYS` 决定
它接受哪些 Key），以及用 `loadModelsDevCatalog({ fetchImpl })` 预置的
models.dev 目录缓存——`GET /providers/discover` 与 `lookup-metadata` 因此
永远不访问外网。夹具配置里还有一个 builtin `openrouter` provider，用来覆盖
「只读连接卡 + 已启用模型列表」这条路径。

## 数据请求约定

- 业务页面一律使用 `useQuery` / `useInfiniteQuery` 并显式渲染
  loading / error / data 三态，**禁止 `useSuspenseQuery`**。查询被拒时
  promise rejection 会在渲染期抛出并落进路由错误边界，产生无法恢复的
  “Something went wrong” 死屏；显式状态分支把错误留在页面内展示
  （`ApiError.code: message`）。
- 受保护请求返回 401（code `unauthenticated`）由
  `src/lib/query-client.ts` 的全局 Query/MutationCache `onError` 集中处理：
  失效 session query，让 AuthGate 回到登录 gate。登录 / setup / 改凭据的
  `invalid_credentials` 等 401 属于表单错误，必须留在表单内展示，不得被
  全局处理吞掉（判定按错误 code，不是按 status）。

### Chats 页（`src/pages/chats.tsx`）

- Manage → Chats 管理配置里的 Chat 与 Topic 白名单，以及 Chat 范围的模型 / thinking；不提供 Topic 级模型。Chat ID 与 Topic ID 全程保持字符串，服务端校验安全整数后写入配置。
- `GET /api/chats` 同时返回 `saved` 与 `active`，页面并排显示 Saved settings / Running settings。增删 Chat、Topic 范围变化只有重启后生效；已有 active Chat 的模型设置热应用于下一次 Invocation。删除不清除审计历史，最后一个配置 Chat 不能删除。
- 空 Topic 输入表示不限制 Topic；Global default 恢复模型与 thinking 继承，也可只覆盖 thinking。选了 Chat 模型时 thinking 必须显式指定（不提供继承项）。可选模型与思考档取自服务端，换模型自动选最弱档。
- 表单与删除确认打开时冻结 revision 和数据快照。后台刷新不能升级草稿的 `If-Match`；`config_conflict` 关闭旧对话框并要求重新打开。写入成功或失败都刷新 Chats / Models / config-status，因为失败也可能已写文件但未应用；错误仍内联展示。Settings 应用配置也使这三个视图失效。
- `e2e/09-chats.e2e.ts` 覆盖增删、Topic 待重启、热切模型与恢复继承、并发修改/删除、真实保存后应用失败与恢复、移动端暗色表单。

### Developer 页（`src/pages/developer.tsx`）

- Manage → Developer 通过现有配置写入流程管理可选的 `developer.record_model_payloads`（默认关闭），保存后热应用，保留文件与运行态不一致时的反馈。
- 清除历史报文使用 `ConfirmDialog` 明确确认；成功展示清除调用数，并使 Invocation 详情缓存失效。仅清除请求/响应快照，正常审计不变；说明 SQLite 文件未必缩小。
- `e2e/10-developer.e2e.ts` 覆盖默认值、切换与刷新持久化、取消/确认清除、详情空报文状态。

### Models 页（`src/pages/models.tsx`）写入约定

- 每个写请求都带 `GET /api/providers` 返回的 `revision`（`If-Match`）。
  `409 config_conflict` 表示 config.jsonc 在编辑期间被改动：提示 “config.jsonc changed…”、
  重新拉取，再让用户重试（`lib/model-manager.ts` 的 `writeErrorMessage`）。
- 保存反馈区分 “Applied” 与 “Saved, restart required”：只要 `apply.restart_required` 非空，
  就不能显示成全部已应用（`applyFeedback`）。Models 页自己的写入全部热应用，但其它字段仍可能
  待重启，此时也显示 “Saved, restart required”。待重启横幅与 “Restart now” 按钮由全局
  `restart_required` + `supervised` 驱动（未声明 `PLASTICWAN_SUPERVISED=1` 时只列字段并提示手动重启）。
- 凭据只写不读：`api_key` 与 header 值永远是 `type="password"`、`autocomplete="new-password"`
  的空输入框，没有查看按钮；提交后用 `mutation.reset()` 立刻把带明文 key 的请求体
  从 mutation cache 里丢掉。页面不写 localStorage，也不把 key 放进任何持久结构。
- 元数据草稿（`ModelMetadataDraft`）带 `sources` 与 `needs_confirmation`：`null`、或只有
  猜出来的匹配（`models.dev-cross-provider` / `models.dev-fuzzy`，见 `match.confidence`）
  支撑的字段必须由管理员确认后才能保存——字段齐全的可以用 “Accept listed values (N)” 一次接受，
  有空缺的要进编辑弹窗填写。面板不替模型填默认值；“Advanced” 折叠区只显示当前 API 真正支持的
  compat 字段。
- thinking 级别：`thinking_levels` 缺失不算空缺（沿用 Pi 默认），猜出来的照样要确认。
  模型接受哪些级别由 `supportedThinkingLevels` 计算，与服务端
  `src/platform/thinking-levels.ts` 是同一条规则，改一边必须改另一边。

面板 UI 文案一律英文（与 Memories / Bot admins / Overview 一致）；本文档引用界面文案时用英文原文。

## 共享业务组件契约

页面必须复用 `src/components/business/` 下的公共层，不要复制各自的
加载/错误/空态实现，也不要发明跳页或全量排序。统一从 barrel 导入：

```ts
import {
  ChartPanel, ConfirmDialog, CursorList, FilterToolbar, JsonViewer, KvList,
  LazyDetails, MonoValue, PrivateReasoningNote, PrivateReasoningTag,
  SelectFilter, StateBadge, TableShell, TextValue, TimeSeriesChart, flatPages,
  FLUSH_TABLE_CLASS, LIST_TABLE_CLASS,
  type ColumnSpec, type CursorQueryFactory, type CursorQueryOptions,
} from '@/components/business';
```

页面区块统一用 `@/components/layout/panel` 的 `Panel`（卡片 + 标题 + 可选尾部操作，
`min-h-9` 让同一行的面板标题与首行内容对齐）。**一个区域一个边框**：面板里不再套第二层
边框——表格传 `flush` 并用 `FLUSH_TABLE_CLASS`（只保留标题下那条线、首尾单元格与标题同
inset），图表无边框，列表项不要自己的 border。`LIST_TABLE_CLASS` 只给不在面板里的独立表格。

### 游标列表容器 `cursor-list.tsx`

- `CursorList<T, TQueryKey>`：props 为 `factory`（`(filters: ListFilters) =>
  CursorQueryOptions<T>`，直接传 `lib/queries.ts` 的工厂如 `invocationsQuery`）、
  `filters`、`renderItems(items)`，可选 `empty` / `errorTitle` /
  `skeletonRows` / `loadMoreLabel` / `className`。
- 组件内部调用 `useInfiniteQuery`（每页 25 条，`next_cursor` 透传），自行渲染
  loading 骨架、错误态（`ApiError.code: message`）、空态和 “Load more” 按钮
  （仅当 `next_cursor` 非空）。
- **禁止**：跳页、总页数、对已加载数据的客户端排序、把 error 当空态。
- 过滤变化 = query key 变化 = 已加载分页自动重置，页面只需把过滤值放进
  `filters`。
- `flatPages(query.data)` 把分页拍平成数组，详情展开等场景可单独使用。

### 过滤工具栏 `filter-toolbar.tsx`

- `FilterToolbar`：flex-wrap 容器，子项自动换行。
- `TextFilter`：受控文本过滤，提交/清除语义。props：`value`（已应用的过滤值，
  `undefined` 表示未过滤）、`placeholder`、`onCommit(value)`（回车或搜索按钮，
  trim 后提交）、`onClear()`（清空输入并清除已应用过滤）。**清除按钮会立即
  重置过滤与分页**（这是相对旧面板非受控 `Input.Search` 的有意改进）。
- `SelectFilter<T extends string>`：下拉即时生效，`onChange(value | undefined)`
  立即回调；选项用 `FilterOption[]`（`{ value, label }`），列表里自带
  “All” 项表示无过滤。不要拿它做延迟提交。

### 状态徽章 `state-badge.tsx`

- `StateBadge({ state })`：state → `stateColor`（`lib/format.ts` 的状态色表）
  → 语义变体（success/info/warning/danger/neutral）。未知状态与未知颜色一律
  兜底 neutral；`null`/空串渲染为 `—`。
- `stateBadgeSemantic(state)`：纯函数，测试/样式复用。

### JSON 查看器 `json-viewer.tsx`

- `JsonViewer({ value, title?, defaultMode?, initiallyCollapsed?, collapseThresholdChars? })`：
  树/文本切换；畸形 JSON 自动降级为原文（文本模式）；payload 超过
  `collapseThresholdChars`（默认 2000）默认折叠并显示字符数；**只渲染文本，
  永不执行 HTML**；`value` 为 `null`/空串时显示 `—`。
- 文本内容不一定合法 JSON（如 `result_text`），直接传字符串即可。
- 折叠的大 payload 走 `LazyDetails`，展开前不构建 JSON 树。

### 懒挂载折叠区 `lazy-details.tsx`

- `LazyDetails({ summary, children, className?, summaryClassName?,
  contentClassName? })`：原生 `<details>` 语义 + **展开前不挂载 children**。
  原生 `<details>` 只是把子树隐藏起来，仍然会渲染 DOM——重内容（`JsonViewer`
  树、tool registry 表格、长文本）必须用它包一层。
- 首次展开后 children 常驻，折叠不清空查看器内部状态（树/文本模式、节点展开）。
- 需要多段内容的折叠区用 `contentClassName` 承担原先内层 `<div>` 的间距类。

### 键值明细与文本 `kv-list.tsx`

- `KvList({ items: { label, value }[] })`：详情页诊断字段网格，多列自适应。
- `TextValue({ value })`：可空文本，空值显示 `—`。
- `MonoValue({ value })`：可空等宽 ID（bigint 字符串字段保持字符串，不要
  转 `Number`）。

### 可复制值 `copyable-value.tsx`

- `CopyableValue({ label, value })`：显示标签与等宽字符串，通过图标按钮复制原始 `value`，不包含标签或其它修饰；`null` 显示 `—` 且不提供复制按钮。
- ID 始终保持字符串，不能转 `Number`；按钮有包含标签和值的可访问名称，成功/失败使用本地化 toast，剪贴板不可用时保留手动选择复制的入口。不调用任何 API。
- Messages / Revision 由页面按 `telegram_type` 区分用户与频道身份；Invocation 使用冻结快照的 `sender.id`，不回填当前资料。

### 二次确认弹窗 `confirm-dialog.tsx`

- `ConfirmDialog({ open, onOpenChange, title, description?, confirmText,
  cancelText?, destructive?, pending, error, onConfirm })`，供破坏性/控制
  操作使用。
- **确认按钮必须用 `onClick`（内部会 `preventDefault()`）**：Radix 的
  `AlertDialogAction` 按 `Dialog.Close` 语义渲染，点击默认关闭弹窗；
  `onSelect` 是 Select/DropdownMenu 的 API，AlertDialog Action 不消费它——
  挂 `onSelect` 会导致点击只关弹窗、`onConfirm` 永不执行。
  `preventDefault()` 抑制 Radix 隐式关闭，让 mutation 真正跑起来。
- **弹窗不自动关闭契约**：确认后由调用方在 mutation 成功/取消时设置
  `open=false`；`pending` 期间两个按钮禁用防重复提交，失败时弹窗保持打开
  并内联展示 `error`（`ApiError.code: message`）。调用方的 `onOpenChange`
  应在 mutation pending 时拒绝关闭（`!open && !pending` 才置 false）。
- **文案契约**：`confirmText` 必须描述具体动作（如 `Cancel alarm` /
  `Delete memory`），且必须与 dismiss 文案可区分——组件在渲染时校验
  `confirmText !== cancelText`，两者相同会直接抛错；默认 dismiss 文案为
  `Dismiss`，不要再把 dismiss 写成 `Cancel` 与确认动作混淆。

### 表格外壳 `table-shell.tsx`

- `TableShell<T>({ columns: ColumnSpec<T>[], data, rowKey, expandedRender?,
  isExpandable?, emptyText?, className? })`，基于 `ui/table`；横向滚动由
  Table 自带。行展开是本地 state（chevron 列）。
- `ColumnSpec<T>`：`{ key, title, align?, width?, className?, render(row) }`；
  长文本列记得加 `className: 'whitespace-normal min-w-… max-w-…'` 覆盖
  `TableCell` 的 `whitespace-nowrap`。
- 无跳页、无排序、无批量选择。

### 图表卡片 `chart-card.tsx`

- `ChartPanel({ title, children, className? })` + `TimeSeriesChart({ data,
  series, height? })`：基于 recharts 的时间序列折线封装，Overview/Usage
  使用。`ChartSeries = { dataKey, label, color }`，
  `ChartDatum` 的 `date` 字段作 x 轴。只画 API 真实返回的序列，不合成指标。

### 私有推理标记 `private-reasoning.tsx`

- `PrivateReasoningTag()`：金色徽章“Private reasoning”，用于 assistant 行。
- `PrivateReasoningNote()`：说明文案——assistant 文本是私有推理，只有成功的
  `send` tool call 才发往 Telegram。
- 任何展示 agent 消息的页面都必须把 assistant 普通文本标为私有推理。

### 详情页状态 `detail-state.tsx`

- `DetailSkeleton()`：详情页统一的 loading 骨架（两个大块占位）。
- `DetailError({ error, notFoundTitle, failedTitle, backTo, backLabel })`：
  详情页错误态——404 显示 `notFoundTitle`，其余失败显示 `failedTitle`，
  消息行用 `lib/errors.ts` 的 `errorMessage`（`ApiError.code: message`），
  底部是回到列表的链接。
- 三个详情页（invocation / context / message）共用这两个组件，页面自身只
  保留 `isPending / isError / data === undefined` 的控制流和第三态（数据）
  渲染；`useSuspenseQuery` 依旧禁用。

### 契约禁止事项

- 共享组件不内嵌任何具体页面的业务字段；页面通过 render 函数/ColumnSpec 提供。
- 不在共享组件里使用 `useSuspenseQuery`、不调用受保护接口、不做 mutation。
- 不引入遗留 UI 组件库依赖；样式用 Tailwind 语义类，暗色模式同时覆盖。
