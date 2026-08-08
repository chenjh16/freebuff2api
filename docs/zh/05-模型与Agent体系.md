# 05 模型与 Agent 体系

> 本文记录 freebuff2api 如何保持模型列表与官方 CLI 同步，以及免费档
> Agent 层次结构。实现见 `src/models.ts`。

## Agent → 模型映射

官方仓库 `CodebuffAI/freebuff` 的
`common/src/constants/free-agents.ts` 声明了每个 Agent 可用的模型集合：

```ts
'base2-free': new Set([ FREEBUFF_MINIMAX_M3_MODEL_ID, … ]),
'base2-free-deepseek-flash': new Set([ DEEPSEEK_V4_FLASH_MODEL_ID ]),
```

freebuff2api 启动时抓取该文件（及其 import 的常量文件），解析出
`Agent → [模型]` 映射：

| 解析能力 | 示例 |
| -------- | ---- |
| 字符串字面量 | `'deepseek/deepseek-v4-flash'` |
| 标识符常量 | `DEEPSEEK_V4_FLASH_MODEL_ID` |
| 命名空间别名 | `mimoModels.mimoV25` |
| 链式再导出 | `export const A = mimoModels.mimoV25` |

刷新间隔 6 小时；抓取失败时使用内置兜底映射（`FALLBACK_AGENT_MODELS`），
保证代理可用。

## 模型 → Agent（选择）

每个模型可能被多个 Agent 服务。代理按以下优先级挑选 Agent（对应
`agentForModel()`）：

1. 专属免费 Agent（`base2-free-*`，如 `base2-free-deepseek-flash`）
   **权重最高**
2. 聚合免费 Agent（`base2-free`）次之
3. id 更长 / 更具体的优先
4. 剩余候选兜底

> 为什么必须选对？上游会校验 run 的 `agentId` 与 session 的 `model` 匹配
> （`free_mode_invalid_agent_hierarchy`）。因此每个 model 都必须映射到
> 能服务它的、最具体的免费 Agent。

## 免费档 Agent（实测抓取，2026-08-06）

| Agent | 模型 |
| ----- | ---- |
| `base2-free` | minimax-m3、gpt-5.6-luna、deepseek-v4-pro、deepseek-v4-flash、mimo-v2.5 等（聚合） |
| `base2-free-deepseek` | `deepseek/deepseek-v4-pro` |
| `base2-free-deepseek-flash` | `deepseek/deepseek-v4-flash` |
| `base2-free-mimo` | `mimo/mimo-v2.5` |
| `base2-free-minimax-m3` | `minimax/minimax-m3` |
| `base2-free-luna` | `openai/gpt-5.6-luna` |
| `base2-free-glm` | `z-ai/glm-5.2` |
| `base2-free-fable` | `anthropic/claude-fable-5` |
| `file-picker` / `file-picker-max` / `file-lister` / `researcher-web` / `researcher-docs` / `basher` | `google/gemini-3.5-flash-lite` |
| `editor-lite` / `code-reviewer-lite` | `minimax/minimax-m3` |

> `base2-free-fable` → `anthropic/claude-fable-5` **仅远程可用**：离线兜底
> 映射不含 fable，只有成功从上游拉取目录后才可用。

## Agent 定义的组成（tools/captured/agentdefs-full.json）

官方 CLI 上报的 Agent 定义包含（以 `base2-free-deepseek-flash` 为例）：

```json
{
  "publisher": "codebuff",
  "model": "deepseek/deepseek-v4-flash",
  "displayName": "Buffy the DeepSeek Flash Free Orchestrator",
  "systemPrompt": "You are Buffy, the strategic coding assistant. …",
  "toolNames": ["spawn_agents", "read_files", "read_subtree", "write_todos", …],
  "spawnableAgents": ["file-picker", "code-searcher", "researcher-web", …],
  "inputSchema": { "prompt": { "type": "string", … } },
  "outputMode": "last_message",
  "includeMessageHistory": true,
  "providerOptions": { "data_collection": "deny" }
}
```

> 注意：Agent 定义的 `systemPrompt` 正是免费档网关检查的标记来源
> （"You are Buffy, the strategic coding assistant…"）。这也解释了为什么
> 网关按这个短语放行——它就是官方 agent 的身份标识。

## 官方 CLI 请求中的 tools（24 个）

抓包显示官方 CLI 的 chat 请求携带 24 个工具定义：`spawn_agents`、
`read_files`、`read_subtree`、`write_todos`、`suggest_followups`、
`str_replace`、`write_file`、`ask_user`、`read_url`、`skill`、
`set_output`、`list_directory`、`glob`、`render_ui`、`gravity_index`，
以及子 Agent 工具 `file_picker`、`code_searcher`、`researcher_web`、
`researcher_docs`、`basher`、`tmux_cli`、`browser_use`、
`code_reviewer_deepseek_flash`、`context_pruner`。

> 实测：tools 数组对网关 **不是必需** 的（NO-TOOLS 变体通过），
> 代理无需复制这 24 个工具定义。

## 当前支持与可用性探测

内置兜底列表当前覆盖以下 Freebuff **注册表**模型 ID：

- `deepseek/deepseek-v4-pro`
- `deepseek/deepseek-v4-flash`
- `mimo/mimo-v2.5`
- `minimax/minimax-m3`
- `openai/gpt-5.6-luna`
- `z-ai/glm-5.2`
- `google/gemini-3.5-flash-lite`

在代理表面上，每个模型只以带命名空间的形式 `freebuff/<model>`（如
`freebuff/deepseek/deepseek-v4-flash`）被广告与路由；裸注册表 ID 既不会被
列出也不可路由。启动时若能访问官方仓库，实际列表以远程解析结果为准；因此
`/v1/models` 表示“已知/可路由”，不保证当前会话额度或上游实例一定可用。

全面探测每个已广告模型会真实调用 chat 并消耗额度：

```bash
node tools/model-availability.mjs --help
node tools/model-availability.mjs --base-url http://127.0.0.1:23333/v1 --concurrency 3
node tools/model-availability.mjs --models freebuff/deepseek/deepseek-v4-flash,freebuff/openai/gpt-5.6-luna --json
```

模型探测也有对应的 opt-in 测试：
`LIVE_MODEL_TEST=1 bun test tests/e2e/model-availability.test.ts --timeout 180000`。
没有显式设置 `LIVE_MODEL_TEST=1` 时不会访问上游。
