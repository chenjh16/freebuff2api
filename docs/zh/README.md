# freebuff2api 中文文档

> 🌐 本目录为**中文版**文档。英文版见 [`../en/README.md`](../en/README.md)。
>
> 🚀 **上手优先**：仓库根目录 [`README.md`](../../README.md) 开篇即项目作用
> （「项目作用」）与使用方法（「快速开始」：托管 Web 控制台 + 本地 CLI 两种
> 方式），再进入下面的深入章节。

本文档记录了 freebuff2api 的完整实现与逆向分析过程，包括：

- 官方 Freebuff CLI（[CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)）的登录流程
- 上游 API 的完整协议（会话、Agent 运行、Chat Completions）
- 默认开启的 OpenCode、Pollinations、Felo 固定公共上游聚合、`provider/model`
  前缀规范 ID（无裸别名）、凭证隔离、回退规则与隐私边界
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
| [08-托管部署](08-托管部署.md) | Freebuff 托管：Next.js 应用、部署环境变量、端点鉴权 |
| [09-模型目录](09-模型目录.md) | 统一模型目录：前缀规范 ID（无裸别名）、优先级路由与图片生成 |
| [10-公共上游渠道](10-公共上游渠道.md) | 渠道清单与实测行为、流式规范化、客户端兼容性（Cherry Studio 修复） |

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
- ✅ 158 个单元测试通过（`bun test tests/unit`），覆盖配置、公共上游安全
  （前缀路由、图片客户端、供应商优先级）、模型注册表（含 `freebuff/` 前缀）、
  run 管理、会话准入（409/503/429 分类）与服务器接口（含
  `/v1/images/generations`）
- ✅ 真实账号登录（device-code 流程）
- ✅ 托管部署形态：`bun run build:web`（Next.js）可构建出 Freebuff 托管
  部署到 `open.freebuff.app` 的应用——见
  [08-托管部署](08-托管部署.md)
- ✅ 端到端测试：认证链路的流式 + 非流式 chat 均返回 200 与真实回复；
  E2E 全部按真实凭证/环境变量门控（认证套件需 `CREDS_OK`，公共上游套件需
  `LIVE_PUBLIC_UPSTREAM_TEST=1`，模型可用性套件需 `LIVE_MODEL_TEST`）
- ✅ 公共上游实时 E2E（`LIVE_PUBLIC_UPSTREAM_TEST=1`，需要显式开启以避免
  普通测试依赖外部网络）：全部默认公共模型经代理验证——OpenCode chat（4）、
  Pollinations chat（8）、Felo chat（5）走 `/v1/chat/completions`，
  Pollinations 图片（3）走 `/v1/images/generations`；`/v1/models` 列出
  前缀 ID（无裸别名），每个 ID 在 `owned_by` 中标注所属供应商。供应商限流
  通过退避重试
  吸收；Pollinations 匿名 chat 对部分提示词形态返回 401（探针使用良性提示词）
- ✅ 双模型复测（`openai/gpt-5.6-luna` + `deepseek/deepseek-v4-flash`）：
  经代理与官方 CLI（MITM 抓包）全链路通过——见
  [06-端到端测试记录](06-端到端测试记录.md) 阶段 9
- 🔧 调试工具：[`tools/`](../../tools/README.md)（TLS MITM 代理、
  `probe-session.mjs` 准入探针、`cli-probe.mjs` 官方 CLI 驱动、
  `model-availability.mjs` 逐模型探测）
