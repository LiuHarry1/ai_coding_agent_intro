# @ai-agent/protocol

Transport-agnostic wire protocol for the coding agent. This is the **single
source of truth** for every message that crosses the boundary between the
agent engine and a GUI. It is shared by:

- the **engine** (emits `ServerMessage`s),
- every **transport** adapter (SSE, stdio NDJSON, ACP) — they only serialize,
- every **GUI** (web, CLI, desktop, third-party).

The shape is deliberately modeled on Claude Code's SDK protocol so that an
ACP adapter is a thin translation rather than a rewrite.

## Design

| Concept | This package | Claude Code equivalent |
|---|---|---|
| Version pinned on handshake | `PROTOCOL_VERSION` + `system/init` | `system/init` |
| Correlation envelope | `session_id` + `uuid` on every message | same |
| Two-level discriminant | `type`, then `subtype` for `system` | same |
| Bidirectional RPC | `control_request` / `control_response` / `control_cancel_request` | same |
| Direction split | `OutgoingMessage` / `IncomingMessage` | `StdoutMessage` / `StdinMessage` |

## Message families

- **Engine → client** (`ServerMessage`): `system/init`, `stream_event`
  (text / reasoning deltas), `assistant`, `tool_call`, `tool_result`,
  `system/todo_update`, `system/skill_start`, `system/mode_changed`,
  `result` (success / error), plus engine-initiated `control_request`.
- **Client → engine** (`ClientMessage`): `user`, and the client side of the
  control sub-protocol.

## Native emission

The engine in `src` emits typed `ServerMessage`s at the
boundary via `WireEmitter` (CC: `QueryEngine` yielding `SDKMessage`).
Transports (SSE, stdio NDJSON) only serialize — no legacy adapter layer.

### Stdio CLI

```bash
npm run cli -- --workspace /path/to/project
echo '{"type":"user","text":"List files in src"}' | npm run cli
```

- **stdout**: one `OutgoingMessage` JSON object per line
- **stdin**: `ClientMessage` NDJSON (`user`, `control_response`, …)
- **stderr**: boot / turn logs (stdout stays pure protocol)

Respond to engine `control_request` messages on stdin:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"answers":{"Which approach?":"Option A"}}}}
```

## Roadmap

1. **Done** — schema + native engine emission (`WireEmitter`).
2. **Done** — SSE + stdio NDJSON transports; web frontend consumes protocol.
3. **Done** — ACP stdio adapter for JetBrains / VS Code / any ACP client:

```bash
npm run acp -- --workspace /path/to/project
```

Configure the IDE's ACP agent command to run the above. Stdout is JSON-RPC; stderr is boot logs only.
