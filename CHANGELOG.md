# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-06

### Added（首次发布）

- OpenAI 兼容 `/v1` 代理：`/healthz`、`/v1/models`、`/v1/chat/completions`
  （支持流式与非流式）
- 设备码登录：`freebuff2api login`（含 `--resume` / `--force`），
  凭证存 `~/.config/freebuff2api/credentials.json`
- 免费会话管理：等待室轮询、令牌轮换、401 令牌冷却 30 分钟
- Agent 运行管理：run 复用、定时轮换、优雅关闭时 FINISH
- 模型注册表：从 CodebuffAI/freebuff 同步 Agent→模型映射（6h 刷新），
  内置兜底映射
- **免费模式 CLI 网关破解**：自动注入 system 标记
  （`You are Buffy, the strategic coding assistant`），解决
  `403 free_mode_cli_required`
- 中英双语文档（`docs/zh/` 与 `docs/en/`）与调试工具集（`tools/`，含 TLS MITM 抓包工具）

### Fixed

- 上游 chat 请求 403 `free_mode_cli_required`：system 消息必须携带
  官方 CLI 身份短语
- `agent-runs` START body 对齐官方 CLI（`ancestorRunIds: []`）

[0.1.0]: https://github.com/chenjh16/freebuff2api/releases/tag/v0.1.0
