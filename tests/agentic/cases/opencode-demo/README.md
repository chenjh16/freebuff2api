# opencode-demo — opencode 端到端验收示例

> 这是用 **opencode**（OpenAI 兼容客户端）连接 **freebuff2api** 代理完成的
> 最小示例项目，作为**端到端验收标准**：证明任意 OpenAI 兼容客户端都可以
> 通过 freebuff2api 暴露的 `/v1` 接口驱动 Freebuff 免费模型，完成一次真实
> 的编码任务。

> This is a minimal project produced by **opencode** talking to the
> **freebuff2api** proxy — the end-to-end acceptance test proving any
> OpenAI-compatible client can drive Freebuff's free models through the
> proxy's `/v1` surface.

## 验收标准 / Acceptance criteria

1. ✅ opencode 通过 `http://127.0.0.1:18080/v1`（freebuff2api 代理）完成一次
   真实对话 / opencode completes a real conversation via the proxy
2. ✅ opencode 在本目录生成 `fib.js` 与 `fib.test.js` /
   opencode creates `fib.js` and `fib.test.js` here
3. ✅ `node fib.test.js` 运行通过（0 断言失败）/
   `node fib.test.js` passes (0 failed assertions)

> 实测记录（2026-08-07）：opencode 首轮生成的测试因父级 `type: module`
> 报 `require is not defined`，它重读 `package.json` 改为 ESM 重写后
> 重跑通过；代理日志显示 4 次上游 chat 全部 `status 200`。
> Actual run: opencode hit `require is not defined` (parent `type: module`),
> re-read `package.json`, rewrote with ESM, and re-ran green; the proxy log
> shows 4 upstream chat calls, all `status 200`.

## 产物 / Artifacts

- `fib.js` — `fibonacci(n)` 实现（由 opencode 生成）
- `fib.test.js` — `node:assert` 单元测试（由 opencode 生成）

生成时间 / Generated: 2026-08-07
模型 / Model: `deepseek/deepseek-v4-flash`（免费档）
