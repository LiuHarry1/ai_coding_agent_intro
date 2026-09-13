# Source Map

Start here when documentation describes a behavior and you need the code that
implements it.

| Subsystem | Authoritative entry points |
|---|---|
| Process entrypoints | `start.js`, `src/entrypoints/cli.ts` |
| HTTP turn route | `src/server/routes/chat.ts` |
| Transport-neutral turn host | `src/turn/run-chat-turn.ts` |
| Turn preparation | `src/utils/processUserInput/prepare_chat_turn.ts` |
| Agent loop | `src/core/query.ts`, `src/core/query/` |
| LLM profiles/providers | `src/core/llm/` |
| Tool assembly | `src/tools.ts`, `src/tools/assembleToolPool.ts` |
| Tool execution | `src/services/tools/tool_execution.ts` |
| Permissions and HITL | `src/core/can-use-tool.ts`, `src/utils/permissions/` |
| Wire/control protocol | `protocol/src/wire.ts`, `protocol/src/control.ts` |
| HTTP/SSE, stdio, ACP | `src/server/`, `src/cli/`, `src/acp/` |
| Execution plane | `src/execution/bootstrap.ts`, `src/execution/runtime-broker.ts` |
| Local/SSH workers | `src/execution/providers/`, `src/worker/` |
| Project Rules | `src/utils/rules-loader.ts` |
| Auto Memory | `src/services/auto-memory/` |
| Session Memory | `src/services/session-memory/` |
| Compaction | `src/services/compact/` |
| Primary/subagents | `src/core/agent-picker.ts`, `src/tools/AgentTool/` |
| Skills | `src/skills/` |
| MCP lifecycle | `src/core/mcp-lifecycle.ts` |
| Plugins | `src/core/plugins/`, `src/core/plugin-manager.ts` |
| Browser automation | `src/browser/`, `src/tools/BrowserTool/` |
| LSP | `src/services/lsp/`, `src/tools/LSPTool/` |
| Scheduled tasks | `src/services/cron/`, `src/tools/ScheduleCronTool/` |
| Attachments/uploads | `src/utils/attachments/`, `src/server/routes/chat-uploads.ts` |
| Session storage | `src/session/`, `src/core/session-paths.ts` |
| Analytics/quota | `src/server/telemetry.ts`, `src/server/quota.ts`, `analytics/` |

## High-value tests

| Area | Command |
|---|---|
| TypeScript contracts | `npm run typecheck` |
| Memory lifecycle | `npm run test:memory` |
| Compaction | `npm run test:compact` |
| Browser | `npm run test:browser` |
| Documentation build | `npm run docs:build` |

For the larger annotated source index, see
[`presentation/architecture.md`](../presentation/architecture.md).

**Last verified:** 2026-09-13
