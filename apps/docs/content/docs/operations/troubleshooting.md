---
title: 排查问题
description: 按症状检查无法启动、Bot 不回复、模型或管理面板错误。
---

# 排查问题

先保存脱敏日志、配置哈希和发生时间。不要为了排障删除数据库、媒体缓存或 `serve.lock`。

## 无法启动

1. 运行 `check-config`，先修复 Schema、模型引用或路径错误。
2. 确认容器/服务能读取配置、Prompt 与环境变量；不要打印它们的值。
3. 检查 Node/媒体依赖，或用有授权凭据的 `doctor` 做真实探针。
4. 同一 `data_dir` 已在运行时，不要启动第二个 `serve`。本地替换实例才使用 `--takeover`。

## Bot 没有回复

沉默可能是正常行为。依次检查：

1. Telegram 是否把普通消息投递给 Bot，群隐私模式是否符合预期。
2. Chat/Topic 是否在 allowlist；新增 Chat 是否已热应用，删除/Topic 变更后是否已重启。
3. 是否还在 Bucket 窗口，或同群前一个 Invocation 正在运行。
4. participation、暂停状态和全局预算是否拦截了触发。
5. Invocation 是否 completed；`sends_used = 0` 表示模型选择不发言。
6. 若为 `model_error`，检查 Provider、模型能力与脱敏错误；`invocation_error` 则检查运行时日志。

使用 Admin 的 Invocations、Messages、Usage 和 Contexts 审计定位，不要只凭 stdout 安静判断未处理。

## 图片或 Sticker 失败

检查 Vision 模型是否支持 image、日预算是否足够，以及 FFmpeg/FFprobe/Python/Lottie 是否可用。普通图片可能由 image-capable 主模型直接处理；Sticker 与文本模型图片则需要视觉分析记录。

## 管理面板打不开

确认 `admin.enabled`、服务已重启、日志含 `admin_started`。若返回 `admin_bundle_missing`，在源码目录执行 `pnpm run admin:build` 后重新启动。登录连续失败会触发临时限流；不要通过清库绕过认证。

仍无法定位时，准备脱敏后的 `check-config` 输出、事件名、时间范围和配置哈希，再请管理员或 Agent 协助。
