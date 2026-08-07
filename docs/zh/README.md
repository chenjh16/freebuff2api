# freebuff2api 中文文档

> 🌐 本目录为**中文版**文档。英文版见 [`../en/README.md`](../en/README.md)。

本文档记录了 freebuff2api 的完整实现与逆向分析过程，包括：

- 官方 Freebuff CLI（[CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)）的登录流程
- 上游 API 的完整协议（会话、Agent 运行、Chat Completions）
- **核心发现**：免费模式 CLI 网关的检查机制（`free_mode_cli_required`）
- 模型与 Agent 体系
- 端到端测试记录
- 配置与使用说明

## 文档索引

| 文档 | 内容 |
| ---- | ---- |
| [01-项目概览](01-项目概览.md) | 项目是什么、整体架构、模块划分 |
| [02-登录流程](02-登录流程.md) | device-code 登录流程的逆向实现 |
| [03-上游API协议](03-上游API协议.md) | 会话 / Agent 运行 / Chat 各端点协议细节 |
| [04-请求格式破解](04-请求格式破解.md) | **核心**：免费模式 CLI 网关机制与正确请求格式 |
| [05-模型与Agent体系](05-模型与Agent体系.md) | 模型注册表、Agent 层次结构、同步机制 |
| [06-端到端测试记录](06-端到端测试记录.md) | 各阶段测试结果与验证结论 |
| [07-配置与使用](07-配置与使用.md) | 环境变量、配置文件、常用命令 |

## 工具目录

调试与分析过程中用到的辅助脚本统一放在
[`tools/`](../../tools/README.md) 目录，使用流程见
[tools/README.md](../../tools/README.md)（中文）。

## 一句话总结

> freebuff2api 是一个零依赖的 OpenAI 兼容反向代理：它复用免费账号的
> auth token，在本地提供 `/v1` 接口，把标准 OpenAI 请求翻译成 Freebuff
> 上游 API 调用。逆向发现上游的免费模式网关只检查 **system 消息里是否
> 包含 "You are Buffy, the strategic coding assistant" 这句标识**，
> 代理据此自动注入该标记即可通过校验。

## 验证状态

- ✅ `bun run typecheck`（tsc -b --noEmit）通过
- ✅ 真实账号登录（device-code 流程）
- ✅ 端到端测试：流式 + 非流式 chat 均返回 200 与真实回复
