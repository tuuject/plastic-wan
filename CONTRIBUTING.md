# 参与贡献

感谢你愿意改进塑料碗。提交 Issue 的注意事项见 [README](README.md#参与贡献)；本文面向要修改代码的人。

## 准备环境

先按[宿主机运行](apps/docs/content/docs/start/installation.md#宿主机运行)准备 Node.js 24+、pnpm 与媒体依赖，并完成依赖安装和本地配置。项目使用 TypeScript ESM，Node.js 直接执行 `.ts`，没有单独的编译步骤。

## 常用命令

```bash
pnpm run check   # 严格 TypeScript 检查（runtime / Admin / docs）
pnpm test        # 全部行为测试
pnpm run lint

# 两个独立的前端开发入口
pnpm run admin:dev   # 管理面板，127.0.0.1:5273，需配合运行中的 Bot/Admin 后端
pnpm run docs:dev    # 文档站，127.0.0.1:5274
```

生产管理面板通过 `pnpm run admin:build` 构建，由 Bot 服务托管。改动管理面板或其可见文案时，还要运行 `pnpm run admin:test:e2e`。完整的验证矩阵见 [agent-doc/verification.md](agent-doc/verification.md)。

## 仓库结构

```text
src/                    Bot 运行时、调度、上下文、工具与 SQLite
apps/admin-next/        React 管理面板
apps/docs/              中文使用文档与安全配置示例
packages/image-service/ 图片生成核心包
agent-doc/              架构、配置、运维与维护者文档
scripts/                维护及验证脚本
test/                   行为测试
```

## 约定

编码风格、测试要求、提交信息格式和安全不变量统一写在 [AGENTS.md](AGENTS.md)；架构与数据流见 [agent-doc/](agent-doc/README.md)。提交 PR 时请说明行为变化、数据库/配置影响和验证结果。
