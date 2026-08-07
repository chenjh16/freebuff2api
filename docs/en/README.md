# freebuff2api Documentation (English)

This documentation records the complete implementation and reverse-engineering
process of freebuff2api, including:

- The login flow of the official Freebuff CLI
  ([CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff))
- The full upstream API protocol (sessions, agent runs, chat completions)
- **The core finding**: how the free-tier CLI gate works
  (`free_mode_cli_required`)
- The model and agent hierarchy
- End-to-end test records
- Configuration and usage

> 🇨🇳 中文版文档见 [`../zh/README.md`](../zh/README.md)。
>
> 🚀 **Usage-first**: the root [`README.md`](../../README.md) leads with the
> project purpose (**What it is**) and **Quick start** (hosted web console +
> standalone CLI) before the deep-dive sections below.

## Index

| Document | Contents |
| ---- | ---- |
| [01 - Project Overview](01-project-overview.md) | What the project is, architecture, module breakdown |
| [02 - Login Flow](02-login-flow.md) | The reverse-engineered device-code login flow |
| [03 - Upstream API Protocol](03-upstream-api-protocol.md) | Session / agent run / chat endpoint protocol details |
| [04 - Request Format & the CLI Gate](04-request-format-gate.md) | **Core**: the free-tier CLI gate mechanism and the correct request format |
| [05 - Models & Agents](05-models-and-agents.md) | Model registry, agent hierarchy, sync mechanism |
| [06 - E2E Test Records](06-e2e-test-records.md) | Test results and verification conclusions per stage |
| [07 - Configuration & Usage](07-configuration-and-usage.md) | Env vars, config files, common commands |
| [08 - Hosted Deployment](08-hosted-deployment.md) | Freebuff hosting: the Next.js app, deploy env vars, endpoint auth |

## Tools

The helper scripts used during reverse-engineering and verification live in
[`tools/`](../../tools/README.md) (usage guide in Chinese).

## One-line summary

> freebuff2api is a zero-dependency OpenAI-compatible reverse proxy: it reuses
> the auth token of a free account, exposes a local `/v1` surface, and
> translates standard OpenAI requests into Freebuff upstream API calls.
> Reverse-engineering showed that the upstream free-tier gate only checks
> whether the **system message contains the phrase "You are Buffy, the
> strategic coding assistant"**; the proxy auto-injects that marker to pass
> the check.

## Verification status

- ✅ `bun run typecheck` (tsc -b --noEmit) passes
- ✅ 82 unit tests pass (`bun test tests/unit`) covering config, models, runs,
  session admission (409/503/429 classification), and the server surface
- ✅ Real-account login (device-code flow)
- ✅ Hosted deployment shape: `bun run build:web` (Next.js) builds the app
  that Freebuff hosting deploys to `open.freebuff.app` — see
  [08 - Hosted Deployment](08-hosted-deployment.md)
- ✅ End-to-end tests: streaming and non-streaming chat both return 200 with
  real answers
- ✅ Dual-model re-verification (`openai/gpt-5.6-luna` + `deepseek/deepseek-v4-flash`)
  through the proxy and the official CLI (MITM-captured) — see
  [06 - E2E Test Records](06-e2e-test-records.md) stage 9
- 🔧 Debugging tools: [`tools/`](../../tools/README.md) (TLS MITM proxy,
  `probe-session.mjs` admission probe, `cli-probe.mjs` official-CLI driver,
  `model-availability.mjs` per-model probe)
