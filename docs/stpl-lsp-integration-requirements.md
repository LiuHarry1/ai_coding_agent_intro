# STPL Language Server 对接需求

本文档描述：如何让本 coding agent（`ai_coding_agent_intro`）接入 **宿主 IDE（SWC）启动后提供的 STPL DSL Language Server**，以便 agent 对 `.spec` / `.flow` / `.dbd` / `.prog` / `.seq` 等文件使用 hover、definition、references、diagnostics 等语义能力。

---

## 1. 目标

- Agent 能对 STPL test program DSL 发起标准 LSP 请求（至少：hover / go_to_definition / find_references / document_symbol / diagnostics）。
- 配置方式与现有 `lspServers` 一致：用户在 `.ai-agent/settings.json` 中声明 server。
- **不**通过 URL 直连；STPL LS 不是 HTTP/WebSocket LSP endpoint。

---

## 2. 背景对照

### 2.1 本 agent 现有 LSP 能力

| 项 | 现状 |
|----|------|
| 配置位置 | `.ai-agent/settings.json` → `lspServers` |
| 配置形态 | `{ command, args?, extensionToLanguage, env?, ... }` |
| 传输 | **仅 stdio**（`spawn` + stdin/stdout JSON-RPC） |
| 客户端 | `src/services/lsp/client.ts` |
| 工具入口 | `src/tools/LSPTool/LSPTool.ts`（deferred） |
| 明确限制 | 文档写明：**没有 socket transport** |

现有配置示例：

```json
"lspServers": {
  "typescript": {
    "command": "npx",
    "args": ["--yes", "typescript-language-server", "--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact"
    },
    "startupTimeout": 30000
  }
}
```

### 2.2 STPL Language Server

宿主 IDE 有两种 LS 启动方式；**本 agent 只对接方式 1**。

| 方式 | 说明 | Agent |
|------|------|-------|
| **1. SWC 内嵌 + JMX** | LS 跑在已启动的 SWC JVM；`LanguageServerJMXConsole` 注册 MBean | **使用**（`stpl-lsp-bridge`） |
| **2. Standalone** | `stplls_start.sh` / headless `StplLanguageServerApplication` | 不对接 |

| 项 | 现状 |
|----|------|
| 实现位置（宿主侧源码） | `com.advantest.itee.lsp.stpl` / `.ui`（已在 `code_index` 等主干树中） |
| 运行位置（方式 1） | **已启动的 SWC JVM 内**（扩展自 JDT LS） |
| 传输 | **TCP socket**：客户端先 `listen`，LS **反向 connect** |
| 启动控制 | `IStplLanguageServerControl.start(port, noExit)`；经 **JMX** `start(String port)` 触发 |
| JMX MBean | `com.advantest.stpl:type=basic,name=console`（`start`, `serverInfo`；**无 stop**） |
| 官方客户端 | patched `vscode-java` + External IDE；agent 用内置 `jmx-helper/StplJmxHelper.java` |
| 不是 | MCP Hub；不是 `https://...` / `ws://...` LSP URL |

握手（与 vscode-java / External IDE 一致）：

```
Coding Agent (或 bridge)
  1. ServerSocket(0) → port
  2. JMX serverInfo → 校验用户 / workspace / 是否已在跑
  3. JMX start(port)
  4. accept() 得到 socket
  5. 在该 socket 上跑 LSP JSON-RPC

host JVM 内 StplLanguageServer
  → connect 到 CLIENT_PORT
```

关键环境变量 / 常量（来自 `IStplLanguageServerControl`）：

| 名称 | 含义 |
|------|------|
| `JDTLS_SERVER_PORT` | 客户端 listen 的端口；LS 连过来 |
| `CLIENT_PORT` | LS 侧使用的同一端口属性（system property / env） |
| `JDTLS_WORKSPACE_PATH` | Eclipse workspace 根路径 |
| `STPLLS_PID` | host JVM PID；JMX attach 目标 |
| `watchParentProcess` | 设为 `false` 时，客户端短暂消失不杀 SWC |
| `JDT_LS_NO_EXIT` | 设为 true 时，LSP `exit` 不退出整个 JVM |

JMX helper（本仓库内置）：

```text
java integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java <pid> serverInfo
java integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java <pid> start <port>
# MBean: com.advantest.stpl:type=basic,name=console
```

---

## 3. 差距（为什么不能直接配 URL / 直接配 command）

```
本 agent LSP client          STPL LS
─────────────────          ─────────────────
spawn(command) + stdio  ≠  已有 JVM + TCP reverse-connect
config: command/args    ≠  需要 PID + workspace + listen port
无 socket transport     ≠  必须 socket
```

因此：

- **不能**在 `lspServers` 里写 `url: "http://..."` / `ws://...`。
- **不能**指望写一个普通 `jdtls`/`stpl` 命令就连上已运行的 STPL LS（除非该命令本身是 bridge）。

---

## 4. 推荐方案：stdio Bridge（最小改动）

不改 agent 核心 LSP client，先做一个 **stdio ↔ STPL socket** 的桥接进程。

```
Agent lspServers
  command: node bridge
  args: integrations/stpl-lsp-bridge/index.js
  env: STPLLS_PID, ...
        │
        │  stdio (JSON-RPC LSP)
        ▼
   stpl-lsp-bridge
        │
        │  1) listen(port) + arm accept
        │  2) JMX serverInfo (preflight)
        │  3) JMX start(pid, port)
        │  4) accept socket
        │  5) 双向转发 LSP 帧
        ▼
   host JVM 内 StplLanguageServer
```

### 4.1 Agent 侧配置目标形态

在 `.ai-agent/settings.json`：

```json
"lspServers": {
  "stpl": {
    "command": "node",
    "args": ["integrations/stpl-lsp-bridge/index.js"],
    "env": {
      "STPL_START_MODE": "jmx",
      "STPLLS_PID": "12345",
      "STPL_JMX_HELPER": "integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java",
      "STPL_JMX_JAVA": "/usr/lib/jvm/java-25/bin/java"
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
}
```

说明：

- Agent `cwd` / `rootUri` 必须等于 SWC Eclipse workspace（bridge 会与 `serverInfo` 比对，不一致则失败）。
- `startupTimeout` 建议 ≥ 60–120s。
- `STPLLS_PID` 可用 `STPL_STATUS_FILE` JSON 注入。

### 4.2 Bridge 职责清单

1. **Listen**：`ServerSocket(0)`（或固定端口，由 env 指定）；**先 arm accept** 再 JMX start。
2. **Preflight**：JMX `serverInfo` — 空结果 / 已在跑 / workspace 不匹配则失败。
3. **Start LS**：JMX `start(port)`（内置 `StplJmxHelper.java`）。
4. **Accept**：等待 LS 连入；超时则失败并写 stderr。
5. **Pipe**：stdio ↔ socket 双向透明转发。
6. **Shutdown**：关 socket；**不**调 JMX stop（MBean 无 stop）；依赖 LSP `exit`。
7. **日志**：仅写 stderr；stdout 必须只承载 LSP 帧。

### 4.3 Bridge CLI / Env 约定

| Env | 必需 | 说明 |
|-----|------|------|
| `STPLLS_PID` | 是* | host JVM PID（JMX 模式） |
| `JDTLS_WORKSPACE_PATH` | 建议 | workspace 根；默认 `cwd`；须与 SWC 一致 |
| `STPL_LSP_PORT` | 否* | wait-for-connect 时必需；jmx 默认 `0` |
| `STPL_CONNECT_TIMEOUT_MS` | 否 | accept 超时，默认 `60000` |
| `STPL_JMX_HELPER` | 否 | 默认内置 `jmx-helper/StplJmxHelper.java` |
| `STPL_START_MODE` | 否 | `jmx`（默认） / `wait-for-connect`（aliases: `already-running`, `no-jmx`） |

\* `wait-for-connect` 不要求 PID，但需外部已完成 `start(port)`（调试用，不是 standalone）。

---

## 5. 备选方案：Agent 原生 socket transport

在 `src/services/lsp/client.ts` / `types.ts` 扩展：

```ts
// 示意
export interface LspServerConfig {
  command?: string
  args?: string[]
  transport?: 'stdio' | 'socket'
  // socket 模式：
  // listen: agent listen，LS connect（匹配 STPL）
  // connect: agent connect 到已有 server（若未来 STPL 支持）
  socket?: {
    mode: 'listen' | 'connect'
    host?: string
    port?: number
    startCommand?: string   // 例如 JMX helper
    startArgs?: string[]
  }
  extensionToLanguage: Record<string, string>
  env?: Record<string, string>
  // ...
}
```

**建议优先级：** 先做 **stdio bridge**（不碰 agent 核心），验证 STPL 语义能力后再考虑原生 socket。

---

## 6. 非目标（本期不做）

- 把 STPL LS 配成 MCP server / 用 MCP URL 访问。
- 实现完整 IDE（只做 agent 工具级 LSP：hover / definition / references / symbols / diagnostics）。
- 替换宿主 IDE 内嵌编辑器；也不要求网页编辑器 hover UI。
- 在未启动宿主 IDE 时独立跑完整 STPL LS（standalone `StplLanguageServerApplication` 是另一条路径，本期以「宿主 IDE 已启动」为主）。

---

## 7. 实现任务拆分（建议在本仓库落地）

### P0 — Bridge MVP

1. 新增目录：`tools/stpl-lsp-bridge/`（或 `src/services/lsp/bridges/stpl/`）。
2. 实现 listen →（可选 JMX start）→ accept → stdio↔socket 转发。
3. README：如何从运行中的宿主 IDE 取 PID / workspace。
4. 本地手动验证：用 bridge 对某个 `.spec` 发 `initialize` + `textDocument/hover`。

### P1 — Agent 配置与工具验证

1. 在 `.ai-agent/settings.json` 增加 `stpl` `lspServers` 条目（可用 env 占位）。
2. 确认 `LSPTool` 能对 `.spec` 路由到 `stpl` server。
3. 验证：`hover` / `go_to_definition` / `find_references`；编辑后是否收到 `publishDiagnostics`。
4. `startupTimeout` / 失败信息可读（宿主 IDE 未启动、PID 错误、accept 超时）。

### P2 — 体验

1. PID / workspace 自动发现（例如读宿主 IDE 写出的状态文件；若暂无则文档化手工步骤）。
2. `maxRestarts: 1` 与「宿主 IDE 只允许一个 External IDE / LS client」的行为对齐。
3. Windows / Linux 路径与 JMX helper 可移植。

---

## 8. 验收标准

- [ ] 宿主 IDE 已启动且 workspace 打开时，agent 配置 `stpl` server 后，对 `.spec` 调用 `LSP` 工具 `hover` 返回非空语义结果（或明确的 server capability 限制说明）。
- [ ] `go_to_definition` / `find_references` 至少有一项在样例工程上可用。
- [ ] 宿主 IDE 未启动或 PID 错误时，agent 得到明确错误（stderr / tool error），不无限挂死。
- [ ] 不破坏现有 typescript/python 等 stdio LSP server。
- [ ] 配置文档说明：**不是 URL**；需要宿主 IDE 进程 + bridge/JMX。

---

## 9. 参考（宿主侧）

| 资源 | 说明 |
|------|------|
| `com.advantest.itee.lsp.stpl` | LS 实现；`StplLanguageServer` / `StplLanguageServerControl` / `StplLanguageServerApplication` |
| `com.advantest.itee.services.IStplLanguageServerControl` | `CLIENT_PORT`、`JDTLS_SERVER_PORT`、`STPLLS_PID` 等常量与 `start/stop` |
| `com.advantest.itee.lsp.stpl.ui` | External IDE：`LaunchExternalIDEJob` 注入 env |
| `com.verigy.itee.ui.internal.LanguageServerJMXConsole` | MBean `com.advantest.stpl:type=basic,name=console` |
| `integrations/stpl-lsp-bridge/jmx-helper/StplJmxHelper.java` | Agent 侧内置 JMX attach helper |
| `packages/stplls_start.sh` | Standalone 启动（方式 2；agent 不对接） |


---

## 10. 一句话结论

本 agent 的 LSP 配置是 **stdio command**，不是 URL；STPL LS 是 **进程内 + TCP reverse-connect（常配合 JMX）**。要在本仓库落地，优先实现一个 **stdio bridge**，再在 `lspServers.stpl` 里用现有配置模型接入。
