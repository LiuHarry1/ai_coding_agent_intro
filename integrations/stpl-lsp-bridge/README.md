# stpl-lsp-bridge

stdio ↔ TCP reverse-connect bridge for the STPL language server (SmarTest SWC-embedded path).

The agent LSP client only speaks **stdio** (`spawn` + JSON-RPC). The STPL LS runs inside an already-running SWC JVM and connects over **TCP reverse-connect** (this process listens; the LS connects), started via **JMX**. This bridge presents a normal `command` to the agent and performs that handshake.

```
Agent lspServers.stpl
  → node integrations/stpl-lsp-bridge/index.js   (stdio LSP)
    → listen 127.0.0.1:port
    → arm accept listener
    → JMX serverInfo (preflight)
    → JMX start(pid, port)
    → accept one socket
    → bidirectional byte pipe
    → SWC JVM language server
```

## Two SmarTest LS startup modes (context)

| Mode | What | Agent uses? |
|------|------|-------------|
| **1. SWC-embedded + JMX** | LS in the running SWC JVM; MBean `com.advantest.stpl:type=basic,name=console` | **Yes** — `STPL_START_MODE=jmx` |
| **2. Standalone** | `stplls_start.sh` / headless `StplLanguageServerApplication` | **No** (out of scope for this bridge) |

`wait-for-connect` is only for debug/smoke when something else already triggers `start(port)` — it is **not** standalone one-click launch.

## Requirements

- Node.js 18+
- JDK 11+ (for bundled `StplJmxHelper.java`; JDK 17/21/25 fine)
- SWC started from a build that includes `com.advantest.itee.lsp.stpl` and registers the JMX console at startup
- Agent workspace path must be the **same absolute path** as the SWC Eclipse workspace

## Environment variables

| Env | Required | Default | Description |
|-----|----------|---------|-------------|
| `STPL_START_MODE` | no | `jmx` | `jmx` or `wait-for-connect` (aliases: `already-running`, `no-jmx`) |
| `STPLLS_PID` | no | auto | SWC JVM PID; optional when `STPL_AUTO_DISCOVER=true` |
| `STPL_AUTO_DISCOVER` | no | `true` | Scan local JVMs for STPL JMX MBean; refresh pid/workspace |
| `JDTLS_WORKSPACE_PATH` | no | `process.cwd()` / discovered | If set in env, must match SWC; otherwise bridge adopts SWC workspace |
| `STPL_LSP_PORT` | wait-for-connect: yes | `0` (ephemeral) | Listen port |
| `STPL_CONNECT_TIMEOUT_MS` | no | `60000` | Accept timeout |
| `STPL_JMX_HELPER` | no | bundled `jmx-helper/StplJmxHelper.java` | Helper path |
| `STPL_JMX_JAVA` | no | `java` | Java executable |
| `STPL_JMX_USER` | no | `$USER` | Passed to MBean `serverInfo` (must match SWC user) |
| `STPL_EXTENSION_VERSION` | no | `0.1.0` | Debug default accepted by any SWC (see `LanguageServerJMXConsole`) |
| `STPL_STATUS_FILE` | no | — | Cache `{ "pid", "workspace?" }`; supports `~/...` or cwd-relative paths; written on discover |
| `STPL_BRIDGE_DEBUG` | no | false | Log frame byte lengths to stderr |

`STPL_CALL_JMX_STOP_ON_EXIT` is **ignored**: the SWC MBean has **no** `stop()`; shutdown relies on LSP `exit`.

Do **not** put `JDT_LS_NO_EXIT` / `watchParentProcess` in bridge `env`: those are SWC JVM system properties set inside `IStplLanguageServerControl.start()`.

## Agent settings

```json
"stpl": {
  "command": "node",
  "args": ["integrations/stpl-lsp-bridge/index.js"],
  "env": {
    "STPL_START_MODE": "jmx",
    "STPL_AUTO_DISCOVER": "true",
    "STPL_STATUS_FILE": ".ai-agent/stpl-status.json",
    "STPL_JMX_HELPER": "integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java",
    "STPL_JMX_JAVA": "/usr/lib/jvm/java-25/bin/java",
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

No need to hand-edit `STPLLS_PID` after each SWC restart: discover finds the JVM that registered `com.advantest.stpl:type=basic,name=console`, then caches pid/workspace in `STPL_STATUS_FILE`.

Notes:

- Relative helper / args paths resolve against the **bridge package** (and agent package root for `args`).
- Prefer opening the agent on the **same** Eclipse workspace path as SWC. If cwd differs and `JDTLS_WORKSPACE_PATH` is unset, the bridge adopts the SWC workspace from `serverInfo`.
- If several SWC instances are up, discover picks by workspace match / idle LS / displayName; otherwise set `STPLLS_PID`.
- `maxRestarts: 1` — SWC allows one LS client at a time.
- Do **not** configure a URL; this is not an HTTP/WebSocket LSP.

## Bundled JMX helper

[`jmx-helper/StplJmxHelper.java`](jmx-helper/StplJmxHelper.java) attaches to the SWC PID and invokes:

- ObjectName: `com.advantest.stpl:type=basic,name=console`
- `serverInfo(user, extensionVersion)` → `running:swcVersion:workspacePath` or empty
- `start(port)`

```bash
java integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java discover
java integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java <pid> serverInfo
java integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java <pid> start <port>
```

## Modes

### jmx (production — SWC-embedded)

1. Listen on ephemeral (or fixed) port; arm accept.
2. `serverInfo` — fail if empty / LS already running / workspace mismatch.
3. `start(port)`.
4. Accept LS connection; pipe stdio ↔ socket.

### wait-for-connect (debug / mock)

Aliases: `already-running`, `no-jmx`.

1. Listen on `STPL_LSP_PORT`.
2. An **external** process must start the LS so it connects (bridge does not call JMX).
3. Not “LS already connected”; the LS must connect **after** the bridge is listening.

## Local smoke test (no SWC)

```bash
# Terminal 1
export STPL_START_MODE=wait-for-connect
export STPL_LSP_PORT=51234
export STPL_CONNECT_TIMEOUT_MS=30000
node integrations/stpl-lsp-bridge/scripts/smoke-hover.mjs

# Terminal 2 (within 30s)
node integrations/stpl-lsp-bridge/scripts/mock-stpl-ls.mjs 51234
```

Expect `[smoke] PASS`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean shutdown |
| 1 | Config / listen / JMX failure |
| 2 | Accept timeout |
| 3 | Socket dropped during pipe |

Logs go to **stderr**. stdout is LSP frames only.

## Constraints

- Listens on **127.0.0.1** only.
- One inbound connection.
- Do not attach a second LS client to the same SWC while this bridge is connected.
- Agent and SWC must share localhost.
