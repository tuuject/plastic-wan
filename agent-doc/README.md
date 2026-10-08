# Agent Documentation

本目录存放面向 AI agent 的 Plastic Wan 项目知识。根目录 [`../AGENTS.md`](../AGENTS.md) 是统一入口；这里的文档按任务主题拆分，避免每次加载完整技术设计。

## 使用方式

1. 先读 [`../AGENTS.md`](../AGENTS.md) 的项目约束与「Where to Look」。
2. 根据任务只读取相关主题文档。
3. 以当前源码、迁移和配置 Schema 为最终事实；默认排除 `design/`，读取条件见下节。
4. 行为或运维契约改变时，同步更新对应主题文档和本索引。

## 历史归档读取规则

`design/` 下的文档全部作为历史资料归档，包括需求原文、设计记录和未落地计划。默认不读取、不检索，也不作为当前行为、约束或待办的依据。

仅当用户明确指定参考其中某篇设计、按该设计实施，或要求追溯历史决策时，才按需读取。用户仅提出功能需求，不视为要求参考历史设计。文中的「请实现」「完成后」等执行指令不自动生效；实施前必须核对当前源码。该规则统一在父级入口维护，不在各篇历史文档重复声明。

## 快速入口

| 任务 | 文档 |
| --- | --- |
| 理解整体进程、模块和信任边界 | [architecture.md](architecture.md) |
| 修改 JSONC、Provider、Chat/Topic、Sticker Set 或 MCP | [configuration.md](configuration.md) |
| 修改 SQLite、迁移、保留、备份或审计 | [data-layer.md](data-layer.md) |
| 修改 Telegram 入库、调度、Context、Tool 或媒体 | [telegram-agent-flow.md](telegram-agent-flow.md) |
| 修改 Bot 命令、自助忽略与恢复 | [telegram-agent-flow.md](telegram-agent-flow.md#bot-commands)、[configuration.md](configuration.md#运行时配置热更新) |
| 修改 Conversation Context、GC、热注入或引用 TTL | [telegram-agent-flow.md](telegram-agent-flow.md#context-生命周期) |
| 实现/排查 Skills、`read`/`execute` 原语与内部能力注册表 | [telegram-agent-flow.md](telegram-agent-flow.md#skills-与受控能力调用) |
| 实现/排查 Alarm 与 Deferred Invocation | [telegram-agent-flow.md](telegram-agent-flow.md#alarm--deferred-invocation) |
| 本地启动、安装媒体依赖、部署或排障 | [operations.md](operations.md) |
| 修改 Admin Panel 认证、审计 API 或前端 | [admin-panel.md](admin-panel.md) |
| 修改 Models 页模型健康检查、诊断审计或批量取消 | [admin-panel.md](admin-panel.md#models-页写端点)、[verification.md](verification.md#admin-panel-浏览器-e2e) |
| 修改 `plasticwan-utils` 模型列表、临时模型重放或配套 Skill | [admin-panel.md](admin-panel.md)、[CLI 使用说明](../packages/cli/README.md)、[客户端 Skill](../.agents/skills/plasticwan-utils/SKILL.md) |
| 决定该运行哪些验证 | [verification.md](verification.md) |
| 维护公开用户文档、首页、生成参考与静态构建 | [文档站维护](../apps/docs/README.md) |

## 历史资料索引（仅按明确请求读取）

以下索引仅供满足上述读取条件时定位资料；阶段状态不构成执行授权，也不能替代当前源码与主题文档。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [20260815 设计方案](design/20260815%20塑料碗%20Telegram%20Bot%20设计方案.md) | Phase 1 产品范围与验收 | 已实现 |
| [20260815 技术设计](design/20260815%20塑料碗%20Telegram%20Bot%20技术设计.md) | 原始技术设计、安全边界与状态机 | 已实现，见 [architecture.md](architecture.md) |
| [20260819 记忆系统](design/20260819%20记忆系统.md) | Conversation 级短期记忆与 TTL | 已实现，见 [data-layer.md](data-layer.md) |
| [20260823 睡眠系统](design/20260823%20睡眠系统.md) | 预算耗尽后的 `zzz` 与全局睡眠 | 已实现，见 [telegram-agent-flow.md](telegram-agent-flow.md) |
| [20260828 闹钟系统](design/20260828%20闹钟系统.md) | Alarm / Deferred Invocation | 已实现，见 [telegram-agent-flow.md](telegram-agent-flow.md) |
| [20260901 Bun 到 Node 迁移 Epic](design/20260901%20Bun%20到%20Node%20迁移%20Epic.md) | 运行时迁移分阶段计划与决策记录 | 已完成（2026-09-18 全阶段收尾）；运行时与命令事实见 [operations.md](operations.md) |
| [20260903 Skills 机制设计计划](design/20260903%20塑料碗%20Skills%20机制设计计划.md) | Skills 机制 | **Phase 1 已实现**（System Skills、`read`/`execute` 原语、内部能力迁入 execute），见 [telegram-agent-flow.md](telegram-agent-flow.md)；Phase 2（Admin Skills、容器脚本）未开始 |
| [20260911 定时活跃模式设计计划](design/20260911%20定时活跃模式设计计划.md) | 活跃时段、触发关键词与注意力窗口 | 已实现，见 [configuration.md](configuration.md)、[telegram-agent-flow.md](telegram-agent-flow.md) |
| [20260913 连续 Context 与长活 Invocation 设计计划](design/20260913%20连续%20Context%20与长活%20Invocation%20设计计划.md) | Conversation Context、checkpoint 丢弃式 GC、Invocation 内消息热注入 | 已实现，见 [telegram-agent-flow.md](telegram-agent-flow.md#context-生命周期)、[configuration.md](configuration.md)、[data-layer.md](data-layer.md) |
| [20260918 内置 Agent 插件化计划与结论](design/20260918%20内置能力插件化计划与结论.md) | 区分 IM 接入与 Agent 两条插件渠道；仅计划 Agent 插件的 ESM / definePlugin、三个 Epic、存储与固定前端边界 | 部分已实现：Epic 1（`web_fetch`）与 Epic 3（alarm）已落地，见 [telegram-agent-flow.md](telegram-agent-flow.md#skills-与受控能力调用)；Epic 2（memory）未开始；`setup(host)` 实例形态与功能开关未引入。IM 接入插件仅为远期方向，暂不做用户插件平台、独立 migration 或前端插件机制 |
| [20260920 Admin 模型管理器设计计划](design/20260920%20Admin%20模型管理器设计计划.md) | Admin「模型服务」页：屏蔽 Pi 模型目录改由配置 `models[]` 启用、元数据来源、compat 高级设置、SecretRef 只写不读 | 已实现（见 [交付报告](design/20260920%20Admin%20模型管理器交付报告.md)、[admin-panel.md](admin-panel.md)）；「改完要重启」部分由下一行取代 |
| [20260921 Models 页全量热切换设计计划](design/20260921%20Models%20页全量热切换设计计划.md) | Models 页全部操作热切换：模型注册表进入配置快照、每个 Invocation 钉住模型与 Provider 连接 | 已实现（2026-09-21），见 [交付报告](design/20260921%20Models%20页全量热切换交付报告.md)、[configuration.md](configuration.md#运行时配置热更新)、[admin-panel.md](admin-panel.md) |
| [20260927 动图分析设计](design/20260927%20动图分析设计.md) | GIF / Telegram MP4 animation、每张最多 12 帧 storyboard、按时间补帧、观察缓存与现有媒体链路接入 | 初步认可方向，未实施；补帧总量、轮数、资源预算和时间/缓存策略待定 |
| [20260928 Core 与 Telegram Adapter 分离 Epic](design/20260928%20Plaswan%20Core%20与%20Telegram%20Adapter%20分离%20Epic.md) | 保持 Telegram Bot 定位，分离 Harness 与 Host 的工具、输入、授权、调度、存储及 Admin 后端边界；前端保持 Telegram 一体化 | 规划完成，未实施；3 个交付里程碑、11 个任务，第一刀为注入 Telegram 输出工具；不实施其他 IM Adapter |
| [20261001 sos_pro 专家求助设计计划](design/20261001%20sos_pro%20专家求助设计计划.md) | 便宜模型经直接暴露的 `sos_pro` 工具向强模型求助：插件形态与插件依赖、长程任务与回执、只管专家的每日金额预算、自动 @ 提问者 | Phase 1 范围与决定已确认，未实施；超时、Token 与金额上限等为暂定值，上线后调整；「仅在用户明确要求时」一态留待以后 |
| [20261002 生图核心迁移与系统插件 Phase 1 设计计划](design/20261002%20生图核心迁移与系统插件%20Phase%201%20设计计划.md) | 提取独立生图核心为内置插件；Admin 工作台、生图审计、资产管理沿用原交互并适配宿主组件；供应商配置热加载与图片交付 | Phase 1 实施中：M1 核心包提取、M2 主库/装配/备份与 Provider 有损意图抽象已落地；M3 热加载、M4 插件交付、M5 Admin 三页、M6 集成交付待做 |

## 文档边界

- `AGENTS.md`：稳定入口、仓库规则、命令和主题目录。
- `apps/docs/content/`：面向用户的公开任务指南，不复制本目录或历史设计；行为、配置和运维变化时，同步对应用户指南、示例和离线检查，维护约定见 [文档站维护](../apps/docs/README.md)。
- 本目录正文：保留源码难以表达的决策理由、跨模块契约、例外与故障处理；完整注册表、表结构和依赖版本链接到源码，不维护数量或本地运行状态的副本。
- 工具调用契约集中在 [telegram-agent-flow.md](telegram-agent-flow.md#skills-与受控能力调用)，架构页只解释分层与信任边界；逐文件清单只在 `AGENTS.md` 的 Project Structure 维护。
- Bucket 节拍、system prompt 稳定段/注入段拆分等跨模块行为只在 [telegram-agent-flow.md](telegram-agent-flow.md) 维护；[configuration.md](configuration.md) 只写字段语义、覆盖关系与 `check-config` 校验，行为细节用小节链接指过去。
- Admin 写端点白名单只在 [admin-panel.md](admin-panel.md#api) 维护，`AGENTS.md` 的相关约束链接到该表而不复述清单。
- [operations.md](operations.md) 负责运行步骤、前置条件与排障；[verification.md](verification.md) 负责验证范围和通过标准。必要命令可以就地保留，其余重复内容用小节链接连接。
- `design/`：历史资料，统一遵循上面的读取规则；不在各篇维护现状免责声明。
- 测试：可执行行为契约；文档与测试冲突时，先核对源码和最近迁移，再修正文档或实现。
