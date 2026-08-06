# 安全说明

## 报告漏洞

如发现安全漏洞（如 token 泄露、注入、越权等），请**不要**公开提交
Issue，直接发送邮件或私信项目维护者，并包含：

- 漏洞类型与影响范围
- 复现步骤（最小化）
- 建议的修复方向

## 已知风险与使用提示

- **token 即凭证**：`~/.config/freebuff2api/credentials.json` 中的
  `authToken` 等同于账号的 API 使用权，请勿提交到仓库、勿泄露给第三方
- **免费档条款**：上游可能禁止直接调用 API，违规使用可能导致账号受限
- **调试工具**：`tools/` 下的 MITM 代理只应用于分析自己的流量，
  请勿用于抓取他人数据
- 生产环境请通过托管环境变量（而非 `.env` 文件）注入 `AUTH_TOKENS`

## 依赖

本项目运行时零第三方依赖；开发依赖仅 `typescript` 与 `@types/bun`。
请关注上游（`CodebuffAI/freebuff`、freebuff.com）的安全公告。
