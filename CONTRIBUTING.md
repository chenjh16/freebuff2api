# 贡献指南

感谢你愿意为 freebuff2api 贡献代码！请花几分钟阅读以下约定。

## 项目概览

- 技术栈：TypeScript + Bun（零运行时依赖）
- 入口：`src/index.ts`
- 文档：`docs/`（中文），工具：`tools/`（调试脚本）
- 逆向依据：官方 [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)

## 开发流程

```bash
bun install
bun run typecheck    # 类型检查
bun run dev          # 开发模式启动
bun run login        # 登录（首次需要）
bun run build        # 打包到 dist/
```

### 提交前检查

```bash
bun run check        # typecheck + build
node --check tools/*.mjs   # 若改了 tools/ 下脚本
```

## 代码约定

- 保持零运行时依赖；如需新能力优先用 Node/Bun 内置 API
- 修改导出的函数/类时，同步更新所有引用（可用 code-searcher 找引用）
- 涉及上游协议的行为，请在 `docs/` 中同步更新说明
- 提交信息遵循
  [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
  `feat:` / `fix:` / `docs:` / `chore:` 等

## 分支与 PR

1. 从 `main` 切出功能分支：`git checkout -b feat/xxx`
2. 完成开发并跑通 `bun run check`
3. 推送分支并创建 Pull Request，描述改动与验证情况

## 报告问题

使用 GitHub Issues，模板要点：

- 复现步骤（含请求/响应、`DEBUG_UPSTREAM=1` 日志）
- 环境：OS、Bun/Node 版本、freebuff2api 版本
- 涉及上游协议变化时，附上官方 CLI 抓包对照（可选）
