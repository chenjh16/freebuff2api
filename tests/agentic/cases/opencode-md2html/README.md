# opencode-md2html — opencode 复杂任务端到端验收

> 这是用 **opencode** 连接 **freebuff2api** 代理完成的**复杂任务**端到端
> 验收：要求 opencode 充分使用其内置工具（读文件、写多个文件、运行 bash、
> 修改代码、grep、webfetch 等）完成一个多文件小项目。
>
> This is a **complex-task** end-to-end acceptance run: opencode must use its
> built-in tools (read files, write multiple files, run bash, edit code,
> grep, webfetch, …) to build a small multi-file project through the
> freebuff2api proxy.

## 任务 / Task

在本目录实现一个零依赖的 Markdown → HTML 转换器（供 `node` 使用）：

1. `md2html.js` — 导出 `md2html(src)` 函数，至少支持：
   - 标题：`# ` / `## ` / `### `
   - 段落
   - 无序列表 `- item`
   - 行内代码 `` `code` `` 与代码块 ```` ``` ````
   - 链接 `[text](url)`
2. `cli.js` — 命令行入口：`node cli.js <file>` 把文件读入并输出 HTML
3. `test.js` — 用 `node:assert` 写单元测试，覆盖上面每种语法
   （至少 8 个断言）
4. **禁止任何第三方依赖**（只用 Node 内置模块）
5. 用 `node cli.js sample.md` 实际转换本目录的 `sample.md`，确认输出里包含
   `<h1>`、`<ul>`、`<pre>`、`<a href="…">`
6. 用 **webfetch** 工具抓取 `https://example.com`，确认网络可用并报告页面标题
7. 运行 `node test.js` 全部通过，然后简要总结

## 验收标准 / Acceptance criteria

1. ✅ `node test.js` 全部断言通过（10 个断言）
2. ✅ `node cli.js sample.md` 输出包含 `<h1>` `<ul>` `<pre>` `<a href`
3. ✅ 无第三方依赖（`package.json` 不新增依赖）
4. ✅ webfetch 步骤完成并报告（"Example Domain"）

> 实测记录（2026-08-07）：opencode 完成 13 条消息 / 12 次上游 chat 调用，
> 使用内置工具 `read`×2、`write`×5、`edit`×2、`bash`×6、`webfetch`×2；
> 全部通过，代理日志均 status 200。
> Actual run: 13 messages / 12 upstream chat calls; tools used
> `read`×2, `write`×5, `edit`×2, `bash`×6, `webfetch`×2; all green, proxy
> log all status 200.
