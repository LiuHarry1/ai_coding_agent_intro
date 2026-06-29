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

## Bridging the current backend

The engine in `examples/08-basic` still emits loose `(name, data)` events on
its `eventBus`. `mapLegacyEvent(name, data, ctx)` translates those into
`ServerMessage`s so a transport can speak this protocol today, before the
core is refactored to emit protocol messages natively. Events that aren't
part of the stable contract (compaction, usage, tool-input previews) map to
`null` and stay internal.

## Roadmap

1. **Now** — schema + legacy bridge (this package).
2. Wire the SSE transport to validate/emit `ServerMessage`s; point the web
   frontend at `import.meta.env.VITE_API_BASE`.
3. Add a stdio **NDJSON** transport for headless CLI / SDK usage.
4. Add an **ACP** adapter (JSON-RPC 2.0) translating this protocol to
   `session/prompt` + `session/update` for Zed / JetBrains / any ACP editor.
