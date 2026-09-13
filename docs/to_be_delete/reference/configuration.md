# Configuration

Coding Agent reads `.ai-agent/settings.json` files and validates them with
`src/core/settings-schema.ts`.

## Scope order

Settings are applied in this order:

1. **User** — `~/.ai-agent/settings.json`
2. **Project** — `<workspace>/.ai-agent/settings.json`
3. **Local** — `<workspace>/.ai-agent/settings.local.json`
4. **Managed** — platform policy; applied last

Later layers override earlier layers. Managed policy paths are platform-specific
and can be overridden with `AI_AGENT_MANAGED_DIR`.

::: warning Trusted directory overrides
`autoMemoryDirectory` and `autoMemory.directory` are stripped from project and
local settings. Only user or managed configuration may turn an arbitrary path
into an Auto Memory read/write root.
:::

## Major groups

| Group | Purpose |
|---|---|
| `models` | Large, medium, and small model profiles |
| `permissions` | Default mode, allow/deny rules, additional directories |
| `sessionMemory` | Per-session extraction and compact thresholds |
| `autoMemory` / `autoMemoryEnabled` | Cross-session extraction and recall |
| `compaction` | Context window and Micro/Full behavior |
| `browser` | Isolated or extension backend |
| `agents` | Primary agent picker and default profile |
| `mcpServers` | stdio or HTTP MCP connections |
| `lspServers` | Language-server commands and file mappings |
| `scheduledTasks` | Scheduled-task feature gate |
| `environments.ssh` | Remote execution targets |

## Runtime environment variables

Environment variables handle secrets and deployment-wide behavior. Common
examples include provider API keys, `AUTH_ENABLED`, `JWT_SECRET`,
`FRONTEND_ORIGIN`, `ANALYTICS_URL`, `QUOTA_ENABLED`, and the
`COMPACT_*` / `DISABLE_*COMPACT` overrides.

Keep provider keys and signing secrets out of settings committed to the
repository.

## Source map

- Schema: `src/core/settings-schema.ts`
- Resolution and scoped writes: `src/core/settings-manager.ts`
- Managed paths: `src/utils/managed-path.ts`
- Request-scoped home directory: `src/utils/request-scope.ts`
- Deployment examples: `deploy/README.md`

**Last verified:** 2026-09-13
