# 05 Models & Agents

> This document records how freebuff2api keeps its model list in sync with the
> official CLI and the free-tier agent hierarchy. Implementation lives in
> `src/models.ts`.

## Agent → model mapping

The official repo `CodebuffAI/freebuff`'s
`common/src/constants/free-agents.ts` declares which models each agent can
serve:

```ts
'base2-free': new Set([ FREEBUFF_MINIMAX_M3_MODEL_ID, … ]),
'base2-free-deepseek-flash': new Set([ DEEPSEEK_V4_FLASH_MODEL_ID ]),
```

On startup freebuff2api fetches that file (and the constant files it
imports) and parses the `Agent → [models]` mapping:

| Parsing capability | Example |
| -------- | ---- |
| String literals | `'deepseek/deepseek-v4-flash'` |
| Identifier constants | `DEEPSEEK_V4_FLASH_MODEL_ID` |
| Namespace aliases | `mimoModels.mimoV25` |
| Chained re-exports | `export const A = mimoModels.mimoV25` |

The registry refreshes every 6 hours; if the fetch fails, a built-in fallback
mapping (`FALLBACK_AGENT_MODELS`) keeps the proxy working.

## Model → agent (selection)

A model may be served by multiple agents. The proxy picks an agent with the
following priority (implemented by `agentForModel()`):

1. A dedicated free agent (`base2-free-*`, e.g.
   `base2-free-deepseek-flash`) gets the **highest weight**
2. The aggregate free agent (`base2-free`) next
3. Longer / more specific ids win
4. Remaining candidates as a fallback

> Why does the pick matter? The upstream validates that a run's `agentId`
> matches the session's `model`
> (`free_mode_invalid_agent_hierarchy`). So every model must map to the most
> specific free agent that can serve it.

## Free-tier agents (captured 2026-08-06)

| Agent | Model |
| ----- | ---- |
| `base2-free` | minimax-m3, gpt-5.6-luna, deepseek-v4-pro, deepseek-v4-flash, mimo-v2.5 etc. (aggregate) |
| `base2-free-deepseek` | `deepseek/deepseek-v4-pro` |
| `base2-free-deepseek-flash` | `deepseek/deepseek-v4-flash` |
| `base2-free-mimo` | `mimo/mimo-v2.5` |
| `base2-free-minimax-m3` | `minimax/minimax-m3` |
| `base2-free-luna` | `openai/gpt-5.6-luna` |
| `base2-free-glm` | `z-ai/glm-5.2` |
| `base2-free-fable` | `anthropic/claude-fable-5` |
| `file-picker` / `file-picker-max` / `file-lister` / `researcher-web` / `researcher-docs` / `basher` | `google/gemini-3.5-flash-lite` |
| `editor-lite` / `code-reviewer-lite` | `minimax/minimax-m3` |

## Anatomy of an agent definition (tools/captured/agentdefs-full.json)

The agent definitions reported by the official CLI contain (example:
`base2-free-deepseek-flash`):

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

> Note: an agent definition's `systemPrompt` is exactly where the free-tier
> gate's marker comes from ("You are Buffy, the strategic coding
> assistant…"). This also explains why the gate allows that phrase — it is the
> official agent's identity.

## The 24 tools in the official CLI's chat request

Packet captures show the official CLI's chat request carries 24 tool
definitions: `spawn_agents`, `read_files`, `read_subtree`, `write_todos`,
`suggest_followups`, `str_replace`, `write_file`, `ask_user`, `read_url`,
`skill`, `set_output`, `list_directory`, `glob`, `render_ui`,
`gravity_index`, plus sub-agent tools `file_picker`, `code_searcher`,
`researcher_web`, `researcher_docs`, `basher`, `tmux_cli`, `browser_use`,
`code_reviewer_deepseek_flash`, `context_pruner`.

> Verified: the tools array is **not required** by the gate (the NO-TOOLS
> variant passed), so the proxy doesn't need to replicate those 24 tool
> definitions.

## Supported models and availability probing

The curated fallback currently advertises and routes these model ids:

- `deepseek/deepseek-v4-pro`
- `deepseek/deepseek-v4-flash`
- `mimo/mimo-v2.5`
- `minimax/minimax-m3`
- `openai/gpt-5.6-luna`
- `z-ai/glm-5.2`
- `google/gemini-3.5-flash-lite`

When the official repository is reachable at startup, the remote mapping is
used instead. Therefore `/v1/models` means “known and routable”; it does not
guarantee that a live session or quota is available at that moment.

A full availability probe makes a real chat call for every advertised model
and can consume quota:

```bash
node tools/model-availability.mjs --help
node tools/model-availability.mjs --base-url http://127.0.0.1:23333/v1 --concurrency 3
node tools/model-availability.mjs --models freebuff/deepseek/deepseek-v4-flash,freebuff/openai/gpt-5.6-luna --json
```

There is also an opt-in automated probe:
`LIVE_MODEL_TEST=1 bun test tests/e2e/model-availability.test.ts --timeout 180000`.
Without `LIVE_MODEL_TEST=1`, it performs no upstream calls.
