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

## Hosted deployment safeguards

- Hosted `/v1` access is fail-closed when `API_KEYS` is unset; provision a
  high-entropy key through the deployment secret manager rather than relying on
  a published default.
- The web device-code flow keeps the upstream `authToken` server-side in a
  short-lived transaction and only returns the derived `sk-fb-*` client key.
- Public `/healthz` is liveness-only and does not expose account ids, token
  fragments, queue state, or model registry details.
- API-key revocation is process-local. Set a stable `PROXY_SECRET` for key
  decryption across restarts, and use shared state if durable cross-instance
  revocation is required.

## Dependencies

The repository contains a Next.js hosted application and therefore has Next.js
and React runtime dependencies. The standalone proxy itself uses only built-in
Node/Bun APIs. Please follow security advisories for Next.js, React, the
`CodebuffAI/freebuff` upstream, and freebuff.com.
