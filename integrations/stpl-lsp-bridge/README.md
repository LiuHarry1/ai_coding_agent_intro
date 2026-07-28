# stpl-lsp-bridge

stdio ↔ TCP reverse-connect bridge for the STPL language server.

The agent LSP client only speaks **stdio** (`spawn` + JSON-RPC). The STPL LS runs inside an already-running host JVM and connects over **TCP reverse-connect** (this process listens; the LS connects), usually started via a **JMX helper**. This bridge presents a normal `command` to the agent and performs that handshake.

```
Agent lspServers.stpl
  → node integrations/stpl-lsp-bridge/index.js   (stdio LSP)
  → listen 127.0.0.1:port
  → JMX start(pid, port)   or already-running
  → accept one socket
  → bidirectional byte pipe
  → host JVM language server
```

## Requirements

- Node.js 18+
- Host JVM with STPL LS available (for real use)
- For JMX mode: `STPLLS_PID`, `STPL_JMX_HELPER` (path to the JMX helper or a wrapper script)

## Environment variables

| Env | Required | Default | Description |
|-----|----------|---------|-------------|
| `STPL_START_MODE` | no | `jmx` | `jmx` or `already-running` |
| `STPLLS_PID` | jmx | — | Host JVM PID |
| `JDTLS_WORKSPACE_PATH` | no | `process.cwd()` | Optional override. Agent already spawns the bridge with `cwd` = workspace and sends `rootUri` in `initialize`. If unset, bridge uses `process.cwd()`. |
| `STPL_LSP_PORT` | already-running: yes | `0` (ephemeral) | Listen port |
| `STPL_CONNECT_TIMEOUT_MS` | no | `60000` | Accept timeout |
| `STPL_JMX_HELPER` | jmx | — | Helper path (see below) |
| `STPL_JMX_JAVA` | no | `java` | Java executable |
| `STPL_STATUS_FILE` | no | — | JSON with `{ "pid", "workspace", "port"? }` if env unset |
| `STPL_CALL_JMX_STOP_ON_EXIT` | no | false | Call JMX `stop` on shutdown |
| `STPL_BRIDGE_DEBUG` | no | false | Log frame byte lengths to stderr |

`${VAR}` placeholders in settings are **not** expanded — export real values, put literals in `env`, or use `STPL_STATUS_FILE`.

## Agent settings

In `.ai-agent/settings.json`:

```json
"stpl": {
  "command": "node",
  "args": ["integrations/stpl-lsp-bridge/index.js"],
  "env": {
    "STPL_START_MODE": "jmx",
    "STPLLS_PID": "12345",
    "STPL_JMX_HELPER": "D:/path/to/jmx-helper",
    "STPL_CONNECT_TIMEOUT_MS": "60000"
  },
  "extensionToLanguage": {
    ".spec": "stpl",
    ".flow": "stpl",
    ".dbd": "stpl",
    ".prog": "stpl",
    ".seq": "stpl",
    ".pat": "stpl"
  },
  "startupTimeout": 120000,
  "maxRestarts": 1
}
```

Notes:

- **Workspace follows the agent like other LSP servers** (same as CC): omit `workspaceFolder` → agent uses current cwd as spawn `cwd` and `initialize` `rootUri`. Do not hardcode it unless you need a different root.
- **Do not set `JDTLS_WORKSPACE_PATH` for normal use** — bridge reads `process.cwd()` (the spawn cwd). Only set it to override.
- When the agent workspace changes, a new LSP manager starts with the new cwd/`rootUri`.
- `startupTimeout` should be ≥ 60–120s (accept + LS init).
- `maxRestarts: 1` — the host typically allows one LS client at a time.
- Do **not** configure a URL; this is not an HTTP/WebSocket LSP.

## How to get PID

1. Start the host IDE/runtime and open the **same** workspace the agent is using.
2. PID: Task Manager / `jps -l` / process list for the host JVM.
3. Optional status file (PID only is enough; workspace comes from agent cwd):

```json
{
  "pid": 12345
}
```

Then set `STPL_STATUS_FILE` to that path (`STPLLS_PID` can be omitted). If the file also contains `"workspace"`, it is used only when `JDTLS_WORKSPACE_PATH` is unset.

## JMX helper

`STPL_JMX_HELPER` is a local path to a helper that tells the host JVM to start (or stop) the language server on a given port.

**CLI contract** (what this bridge invokes):

```text
# If helper ends with .java:
java <helper> <pid> start <port>
java <helper> <pid> stop <port>

# Otherwise (script / binary wrapper):
<helper> <pid> start <port>
<helper> <pid> stop <port>
```

Obtain the helper from your STPL / host tooling package (do not commit proprietary helpers into this repo). Point `STPL_JMX_HELPER` at that file, or wrap it so the arguments above are accepted.

## Modes

### jmx (production)

1. Bridge listens on an ephemeral (or fixed) port.
2. Calls JMX helper `start` with that port.
3. Waits for the LS to connect.
4. Pipes stdio ↔ socket.

### already-running (debug)

1. The LS was already started against a known port by an external process.
2. Set `STPL_LSP_PORT` to that port, `STPL_START_MODE=already-running`.
3. Bridge listens and accepts only (no JMX).

## Local smoke test (no host JVM)

Use two terminals (or start the mock shortly after smoke begins):

```bash
# Terminal 1 — start smoke (bridge listens, then waits for connect)
$env:STPL_START_MODE = "already-running"
$env:STPL_LSP_PORT = "51234"
$env:STPL_CONNECT_TIMEOUT_MS = "30000"
node integrations/stpl-lsp-bridge/scripts/smoke-hover.mjs

# Terminal 2 — within 30s, connect mock LS
node integrations/stpl-lsp-bridge/scripts/mock-stpl-ls.mjs 51234
```

Expect `[smoke] PASS` and a mock hover payload.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean shutdown |
| 1 | Config / listen / JMX failure |
| 2 | Accept timeout |
| 3 | Socket dropped during pipe |

All logs go to **stderr**. stdout is LSP frames only.

## Constraints

- Listens on **127.0.0.1** only.
- One inbound connection; further connects are not accepted (server closed after first).
- Do not attach a second LS client to the same host JVM instance while this bridge is connected.
- Agent and host JVM must share localhost (same machine / loopback) for this design.
