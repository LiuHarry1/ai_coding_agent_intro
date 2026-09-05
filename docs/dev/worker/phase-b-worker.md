# Baize：目标架构（Isomorphic Agent Worker）

> **立场**：要最好的架构，不要过渡方案、不要双轨、不考虑向后兼容。  
> 本文取代此前「Phase A / B1 务实切片」作为 **唯一目标形态**。  
> 平台骨架仍见 [`baize-agent-remote-execution-architecture.md`](./baize-agent-remote-execution-architecture.md)；本文把「执行面」钉死。

## 实现状态（2026-07-30）

**已落地（本仓）：**

- `src/worker/main.ts` + `npm run build:worker` → `dist/worker/baize-worker.cjs`
- Local：强制 spawn Worker（stdio NDJSON）
- SSH：`ensureRemoteWorker`（scp Worker + `integrations/stpl-lsp-bridge`）+ stdio Runtime
- `WorkerExecutionBackend`：`fs_op` + **`lsp_op`**（LSP 在 Worker 内 spawn）
- STPL：settings 用 `STPL_AUTO_DISCOVER`；远程 `AGENT_ROOT` 指向部署目录
- 冒烟：`npx tsx src/execution/smoke-stpl-worker.ts`（bridge + mock LS，hover OK）

**已落地（diagnostics）：** Worker `publishDiagnostics` → `lsp_event` → Control Plane `LSPDiagnosticRegistry` → 下轮 attachments（对齐 CC / VS Code 推送模型）

**尚未做：**

- 真机 SWC/JMX STPL（需远端 JVM 在跑）
- AuthProxy `ssh -R`
- IDE Fs 经 Worker / Problems UI

---

## 0. 结论（先读这段）

**最优解 = 同构 Agent Worker（Isomorphic Execution Plane）**

| 层 | 跑在哪 | 职责 |
|----|--------|------|
| **Control Plane** | 本机（或你们的中心服务） | UI、Session、**LLM / Agent loop**、权限 UI、CredentialBroker |
| **Execution Plane = Worker** | **始终**与 workspace 同机 | 全部工具、沙箱、**全部 LSP（含 STPL）**、面向工具的 FS |

不变式：

1. **Local 与 SSH 无特殊路径** —— 都是 `connect → ensureWorker → openRuntime`；Local 只是「本机 spawn 同一 Worker 二进制」。  
2. **Control Plane 禁止直接碰磁盘 / shell / LSP** —— 删掉 `SshExecutionBackend`、本机 in-process tool 捷径、`remote ? {}` 关 LSP 之类分支。  
3. **凭证永不落在 Worker 长期存储** —— LLM Key 只在 Control Plane；隧道只传短时票（若 Worker 偶发需要出网）。  
4. **工程源码不部署** —— 只部署 Worker；代码已在目标机目录里。  
5. **新远程形态只加 Provider** —— Bridge / Cloud / Direct 换 Connector，不换 Worker 协议、不换 Orchestrator。

**明确不选**：

| 候选 | 为何不是最优 |
|------|----------------|
| 本机 LLM + 每命令 `ssh`（现状） | 双轨、延迟、LSP/STPL 无法同机 |
| Phase A「只 SSH 起 LSP」 | 工具仍双轨，架构债继续长 |
| CC 式「整轮 Agent 下沉远端」 | 把编排+密钥边界绑死在不可信/多 Provider 机器上；Bridge/Cloud 难复用同一信任模型 |
| 完整 VS Code Extension Host | 产品是 Agent，不是 IDE；成本不对齐 |

> 「LLM 留在 Control Plane」**不是过渡**，而是平台最优切割：执行跟代码走，智能与凭证跟控制面走——对齐 VS Code（远端跑语言服务，不把账号体系塞进每台客户机），并严于 CC（CC 为 CLI 单机体验把整份 binary 推远端）。

---

## 1. 目标拓扑

```
┌──────────────────────────────── Control Plane ────────────────────────────────┐
│  Web / Electron UI                                                            │
│  SessionService · AgentOrchestrator (prompt + LLM + tool 选择)                │
│  EnvironmentRegistry · RuntimeBroker · WorkspaceService                       │
│  PermissionGateway · CredentialBroker (+ AuthProxy)                           │
└─────────────┬───────────────────────────────┬─────────────────────────────────┘
              │ RuntimePort (NDJSON)          │ 仅展示用亦可走同一通道
              │ tool_* / lsp_* / control_*    │ fs_* 
              ▼                               ▼
┌─────────────────────────── Execution Plane (Worker) ─────────────────────────┐
│  与 Workspace 同机的单一进程                                                   │
│  ToolRuntime · Sandbox(cwd) · LspHost · FsService                             │
│  无长期 API Key；只认 runtime-protocol                                         │
└──────────────────────────────────────────────────────────────────────────────┘
         ▲ LocalProvider: spawn(worker)          ▲ SshProvider: deploy + ssh stdio
         │                                       │ Bridge/Cloud: 同 Worker，换接入
```

**Local**：`node baize-worker --stdio` 子进程，cwd = 本地 workspace。  
**SSH**：`ensureWorker` 上传同版本包 → `ssh` 起进程 → stdio 帧 = 同一协议。  
对 Orchestrator 而言：**只有 `RuntimePort`，没有 `kind === 'ssh'`。**

---

## 2. 职责切割（钉死）

### 2.1 Control Plane（唯一智能面）

- 组上下文、调 LLM、决定调用哪个 tool / 是否结束  
- 持久化 Session、权限模式、WorkspaceHandle  
- 把 UI 的 allow/deny 写成 `control_response`  
- 签发 `RuntimeAuth`（短时）  

### 2.2 Worker（唯一执行面）

- 实现全部 tools（Bash、Read/Write/Edit、Grep、Glob、…）  
- 沙箱：以 `WorkspaceHandle.cwd` 为根  
- **LSP Host**：配置随 bind 下发；`spawn` 只发生在 Worker 机（STPL/JMX 同机）  
- FsService：供 IDE 树 / 打开文件（与 tool 共用一套 FS，消灭 `SshFsPort` shell 旁路长期并存）  
- 发出 `control_request`；**不自行放行危险操作**  

### 2.3 Provider（唯一差异点）

只负责：**发现环境、连通、部署/探测 Worker、把字节流适配成 `RuntimePort`**。  
禁止在 Provider 里实现业务 tool 语义。

---

## 3. 协议（一次设计对）

废弃「先假 `user` ping、再打补丁加 RPC」的演进思维。目标协议分三类，同一 NDJSON 通道：

### 3.1 会话绑定

```ts
// C → W
{ type: 'bind', workspace: WorkspaceHandle, lspServers?: LspConfigMap, permissionContext?: FilesystemPermissionContext }
// W → C
{ type: 'ready', workspace, workerVersion, capabilities }
```

### 3.2 工具（Orchestrator 驱动）

```ts
// C → W
{ type: 'tool_call', requestId, runId, toolName, input }
// W → C
{ type: 'control_request', requestId, runId, tool, input, description? }
// C → W
{ type: 'control_response', requestId, decision }
// W → C
{ type: 'tool_result', requestId, runId, toolName, result, isError? }
```

> Agent loop **留在 Control Plane**：LLM 产出 tool 调用 → 上列 RPC → 结果回灌模型。  
> Worker **不**跑「选下一个 tool」；那是编排，不是执行。

### 3.3 LSP

```ts
{ type: 'lsp_ensure' | 'lsp_request' | 'lsp_notify', ... }
// W → C: lsp_notification / diagnostics（供 IDE 或 tool 消费）
```

### 3.4 生命周期

```ts
interrupt · ping/pong · shutdown · error
```

**删除**：面向「Worker 内完整 chat turn」的 `user`→`assistant_delta` 作为主路径（那是 CC 全量下沉模型，与本切割冲突）。若将来要做「无 Control Plane 的 headless remote」，另开 **Worker 模式位**，默认关闭——不是主架构。

---

## 4. 部署与同构二进制

```
构建产物（一份）：
  dist/worker/baize-worker.cjs   # bundle，尽量零 native
  dist/worker/version.json
  （可选）bundled stpl-lsp-bridge + jmx helper

LocalProvider.ensureWorker:
  校验本机 dist 版本即可（或始终用当前 build）

SshProvider.ensureWorker(version):
  1. 远端 ~/.baize-agent-worker/<ver>/.installed 比对
  2. 否则 tar|ssh 或 scp 上传（默认 localServerDownload 语义：本机有包再传）
  3. node 冒烟
  4. openRuntime: ssh -R authSock · 起 worker --stdio · 帧适配 RuntimePort
```

版本矩阵：Worker semver 与 Control Plane **协商**；不兼容则强制 redeploy，不做多版本协议兼容层（你们允许大破大立）。

---

## 5. 对现有代码的硬切割（允许大改）

| 处置 | 对象 |
|------|------|
| **删除** | `SshExecutionBackend`、按环境切换的双 backend、tools 内直接 `fs`/`child_process`（改经 Worker 客户端） |
| **删除** | `prepare_chat_turn` 里 `lspServers: remote ? {}` |
| **降级/删除** | 长期依赖的 shell 版 `SshFsPort`（改为 Worker `fs_*`；过渡期最多留 debug flag） |
| **重写** | `SshRuntimePort`（真 stdio）、`ensureWorker`（真 deploy） |
| **新建** | `src/worker/**`（唯一执行实现）、`RuntimeClient`（Control Plane 侧） |
| **Local 同构** | `LocalProvider.openRuntime` = spawn 同一 worker，禁止「local 同步调 tool」优化入口（可日后加，但不得作为默认） |
| **LSP** | Manager 只活在 Worker；Control Plane 只发 LSP RPC |

Chat HTTP/SSE 适配器可留，但内部必须：`Orchestrator → RuntimePort`，不再 `→ ExecutionBackend(ssh|local)`。

---

## 6. STPL / LSP 在最优架构下如何自然成立

```
SWC JVM（远端） ←JMX/TCP← stpl-lsp-bridge ←spawn← Worker（远端）
                                                      ↑
                                              Runtime LSP RPC
                                                      ↑
                                              Control Plane / IDE
```

- workspace 绝对路径 = SWC workspace = Worker cwd  
- 无需「SSH 转发 LSP 端口」——LS 相对 Worker 即本机  
- 换 Bridge/Cloud：只要 Worker 与代码同机，STPL 同样成立  

---

## 7. 与 VS Code / CC 的对齐关系

| | VS Code | CC `ssh` | **本目标架构** |
|--|--|--|--|
| 远端部署 | vscode-server | 整份 Claude CLI | **仅 Worker** |
| 远端跑什么 | EH + LS + FS/终端 | 编排+工具+… | **工具 + LSP + FS** |
| 智能/账号 | 本地 / 云 | 隧回本地 auth | **Control Plane + Broker** |
| 扩展新环境 | 换 remote 类型 | 另套路径 | **加 Provider** |

你们要的是 **VS Code 的切割 + Agent 的编排位置 + CC 的 deploy/隧道手法**，而不是三者任一的克隆。

---

## 8. 改动量（按「一次做到位」估）

不再给「过渡省工期」数字；这是 **目标态一次落地** 的量级（1 名熟手）：

| 工作包 | 内容 | 粗估 |
|--------|------|------|
| Worker 内核 | stdio 协议、tool 迁入、sandbox、错误模型 | 8–12d |
| LSP Host in Worker | 迁现有 lsp manager；STPL bridge 打包 | 5–8d |
| Local 同构 | LocalProvider 只走 worker；删 in-process | 3–5d |
| SSH deploy + Runtime | ensureWorker、stdio 泵、重连、Auth -R | 6–10d |
| Orchestrator 重接 | 去 ExecutionBackend；RuntimeClient；权限回路 | 5–8d |
| IDE FS | 经 Worker；去 shell list 主路径 | 3–5d |
| 配置/构建/CI | `build:worker`、版本、冒烟、文档 | 2–4d |
| STPL 真机验收 | Device1 + SWC | 2–4d |

**合计约 34–56 人天（≈ 2–3 个月，1 人）**。  
可两人并行（Worker 内核 ∥ SSH 通道），墙钟约 **6–10 周**。

这比「B1 过渡」更重，但是 **终点**；做完不应再挖一层「真正的 Worker」。

---

## 9. 落地顺序（仍是同一架构，不是降级）

顺序只为降低集成风险，**每一步都不引入永久双轨**：

1. **Local Worker only** —— 本机强制子进程 Worker；删同步 tool 路径；协议与工具先在 Local 正确。  
2. **SSH = 同二进制 + stdio** —— deploy + RuntimePort；Orchestrator 零分支。  
3. **Fs / IDE 切 Worker** —— 删主路径 SshFsPort。  
4. **LSP in Worker** —— 含 STPL。  

若某步暂时保留旧路径，必须标 `FIXME: delete before merge to main`，不允许合入默认。

---

## 10. 决策锁定

- ✅ **要**：同构 Worker；Control Plane 编排+LLM；Provider 可插拔；大改删除双轨  
- ❌ **不要**：Phase A、SshExecutionBackend 长期共存、远端跑完整 Agent loop 作为默认、向后兼容旧 remote 行为  

**开工口令**：以本文为唯一目标架构；实现 PR 以「Local 是否已强制 Worker」为第一验收门。
