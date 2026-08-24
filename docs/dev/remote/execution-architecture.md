# Baize Agent：可扩展远程执行架构（修订版）

> 目标：第一期落地 VS Code 式「连某台机器 + 打开远端目录」，同时让 Bridge / 云环境 / Direct Connect 等后续需求 **只加 Provider，不改主干**。  
> 约束：**不考虑向后兼容**；优先干净抽象。  
> 参考：VS Code Remote 分层、CC 的 Environment/Session 模型、上一版设计的复盘。

配套 HTML：[`baize-agent-remote-execution-architecture.html`](./baize-agent-remote-execution-architecture.html)

---

## 0. 对上一版设计的复盘（问题）

上一版（`baize-agent-remote-ssh-architecture` 初稿）能做 SSH MVP，但作为长期架构有几个硬伤：

| 问题 | 表现 | 后果 |
|------|------|------|
| **SSH 渗入核心模型** | `RemoteBinding.hostId`、`SshHostRegistry`、`transport: local\|ssh` | 加 Bridge/云环境要改 Session、Workspace API、UI 分支 |
| **Local 被当成特例** | 「有 remote 才转发，否则本地 cwd」 | Local 不是一等公民；到处 `if (remote)` |
| **把「连接方式」和「执行面」绑死** | SSH tunnel ≈ Worker | Direct Connect（已有常驻进程）、Bridge（反向 poll）塞不进同一生命周期 |
| **Controller 职责过载** | 编排 + 工具执行 + SSH deploy + 鉴权 | 难测、难替换 Worker |
| **协议双轨且未定义边界** | 「前端少改」驱动架构 | 核心被现有 HTTP 形状绑架 |
| **Workspace 仍是「字符串路径」思维** | `remoteCwd` 挂在 Session 上 | 无法表达「同一会话换环境」或「环境内多 worktree」 |

修订原则：**先定不变式与端口，SSH 只是第一个 Environment Provider。**

---

## 1. 核心不变式（所有远程形态必须遵守）

1. **UI 与执行面分离**  
   Chat / 权限弹窗 / 设置 UI 永远在 **Control Plane**；文件与工具永远在 **Execution Plane**。

2. **Local 也是一种 Environment**  
   不存在「本地模式 vs 远程模式」两套代码路径；只有 `EnvironmentKind` 不同。

3. **Session 绑定的是 WorkspaceHandle，不是裸路径**  
   ```
   WorkspaceHandle = { environmentId, cwd }
   ```
   显示名、沙箱根、工具执行都从 Handle 推导。

4. **凭证不进 Execution Plane 长期存储**  
   LLM Key / SSO token 只在 Control Plane（或 Credential Broker）；Worker 只持短时票据或经反向隧道访问 Broker。

5. **控制消息与数据消息同通道、类型正交**  
   `control_request` / `control_response`（权限、中断）与 agent stream 共用 Runtime 通道，与 SSH/WS/stdio 无关。

6. **Provider 可插拔**  
   新增远程形态 = 实现 `EnvironmentProvider` + 可选 `Connector`；不改 Session / Agent Loop / Tool 语义。

---

## 2. 概念模型（对齐 CC，但更干净）

CC 实际有三层，但命名混在 CLI 里。我们显式拆开：

```
Environment  ── 计算落点（哪台机器 / 哪个容器 / 本机）
Workspace    ── 环境内的工作目录（cwd）
Runtime      ── 在该 Workspace 上跑着的 Agent Worker 会话通道
Session      ── 产品会话（消息历史、权限模式、绑定的 WorkspaceHandle）
```

| 概念 | 回答的问题 | 例子 |
|------|------------|------|
| **Environment** | Agent **在哪台电脑/沙箱**跑？ | `local`、`ssh:atsrws0049`、`bridge:machine-uuid`、`cloud:env-xxx` |
| **Workspace** | 在那台电脑的**哪个目录**？ | `/home/u/ws-code_index` |
| **Runtime** | 怎么跟 Worker **说话**？ | stdio / unix-socket / WS over SSH / 公网 session ingress |
| **Connector** | 环境如何 **变成可达**？ | 本机 noop、SSH deploy+tunnel、Bridge register+poll、云 API create |

**第一期产品路径**只是：

```
Environment(ssh) + Workspace(dir) + Runtime(stream) + Connector(ssh)
```

后续 Bridge = 换 Connector/EnvironmentKind；云环境再换一套；**Session / Agent Loop 不动**。

---

## 3. 推荐分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Clients（Web / Electron / CLI）                                  │
│  EnvironmentPicker · WorkspacePicker · Chat · Permission UI      │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Control API（HTTP/WS）
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE                                                    │
│                                                                   │
│  SessionService          消息历史、权限模式、绑定 WorkspaceHandle   │
│  AgentOrchestrator       组 prompt、跑 loop、收 tool/stream 事件    │
│  EnvironmentRegistry     列出/解析 Environment（含 local）         │
│  WorkspaceService        对「当前 Environment」做 list/stat/read   │
│  RuntimeBroker           按 Handle 取得或创建 Runtime               │
│  CredentialBroker        LLM/凭据；短时票；AuthProxy 挂载点         │
│  PermissionGateway       control_request ↔ 用户决策                │
└───────────────┬───────────────────────────────┬──────────────────┘
                │ RuntimePort（与传输无关的接口） │ FsPort
                ▼                               ▼
┌────────────────────────────┐    ┌────────────────────────────────┐
│  ENVIRONMENT PROVIDERS     │    │  每个 Provider 实现：            │
│  (插件)                     │    │  - connect / disconnect         │
│  · LocalProvider           │    │  - ensureWorker                 │
│  · SshProvider             │    │  - openRuntime(cwd) → RuntimePort│
│  · BridgeProvider (后)     │    │  - openFs() → FsPort             │
│  · CloudProvider  (后)     │    │  - capabilities                 │
│  · DirectProvider (后)     │    └────────────────────────────────┘
└────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  EXECUTION PLANE = Agent Worker                                   │
│  cwd = Workspace.cwd · Tools · Sandbox · 无长期 API Key            │
│  只认 Runtime 协议，不认自己是被 SSH 还是 Bridge 拉起来的            │
└──────────────────────────────────────────────────────────────────┘
```

**关键点**：Control Plane **从不** `import ssh`。它只依赖 `EnvironmentProvider` 接口。SSH 细节关在 `SshProvider` 里。

---

## 4. 核心接口（设计中心）

```ts
/** 环境身份：稳定 ID，可序列化进 Session */
type EnvironmentId = string  // e.g. "local" | "ssh:atsrws0049" | "bridge:env_abc"

type EnvironmentKind = 'local' | 'ssh' | 'bridge' | 'cloud' | 'direct'

type EnvironmentDescriptor = {
  id: EnvironmentId
  kind: EnvironmentKind
  displayName: string          // UI: "atsrws0049" / "This machine"
  /** 该环境默认建议打开的目录；可空 */
  defaultCwd?: string
  capabilities: EnvironmentCapabilities
  /** Provider 私有连接参数；Control Plane 当 opaque 存储 */
  endpoint: unknown
}

type EnvironmentCapabilities = {
  canBrowseFs: boolean
  canDeployWorker: boolean
  canForwardPorts: boolean
  requiresOnlineConnector: boolean  // bridge/cloud 可能先注册再派活
  credentialMode: 'broker-tunnel' | 'broker-http' | 'none'
}

/** Session 唯一绑定的工作区句柄 */
type WorkspaceHandle = {
  environmentId: EnvironmentId
  cwd: string                  // 环境内绝对路径（经 realpath 规范化后）
}

type Session = {
  id: string
  workspace: WorkspaceHandle   // 必有；local 也是 Handle，不是 optional remote?
  // messages, permissionMode, owner, ...
}
```

### 4.1 Provider 端口

```ts
interface EnvironmentProvider {
  readonly kind: EnvironmentKind

  /** 发现/枚举可用环境（SSH 读 config；Bridge 调 API；Local 返回单例） */
  list(): Promise<EnvironmentDescriptor[]>

  /** 解析用户输入（named host / user@host / environment id） */
  resolve(input: string): Promise<EnvironmentDescriptor>

  /** 建立到该环境的连接（SSH 握手、云 session create…） */
  connect(env: EnvironmentDescriptor, opts?: ConnectOptions): Promise<EnvironmentConnection>

  disconnect(connectionId: string): Promise<void>
}

interface EnvironmentConnection {
  id: string
  env: EnvironmentDescriptor
  status: 'connected' | 'degraded' | 'disconnected'

  /** 确保 Worker 二进制存在且版本匹配 */
  ensureWorker(desiredVersion: string): Promise<WorkerInstallInfo>

  /** 在指定 cwd 打开执行通道 */
  openRuntime(cwd: string, auth: RuntimeAuth): Promise<RuntimePort>

  /** 文件系统浏览（Open Folder / Header 目录树） */
  openFs(): FsPort

  /** 可选：端口转发 */
  forwardPort?(remotePort: number): Promise<LocalPortMapping>
}
```

### 4.2 Runtime / FS 端口（与 SSH 无关）

```ts
/** Agent Worker 双向通道 —— CC stream-json 的干净版 */
interface RuntimePort {
  readonly workspace: WorkspaceHandle
  send(msg: RuntimeClientMessage): void
  onMessage(handler: (msg: RuntimeServerMessage) => void): () => void
  interrupt(): void
  close(): Promise<void>
  health(): Promise<'ok' | 'dead'>
}

interface FsPort {
  list(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat>
  read(path: string, opts?: ReadOpts): Promise<Uint8Array | string>
  // write 一般只通过 Agent tools；若 UI 要保存文件可后加
  realpath(path: string): Promise<string>
  close(): Promise<void>
}
```

### 4.3 Runtime 消息（单一协议）

不要「HTTP chat 一套 + Worker 一套」长期并存。Control Plane 对内统一：

```ts
type RuntimeClientMessage =
  | { type: 'user'; content: UserContent; runId: string }
  | { type: 'control_response'; requestId: string; decision: PermissionDecision }
  | { type: 'interrupt'; runId: string }

type RuntimeServerMessage =
  | { type: 'assistant_delta' | 'assistant'; ... }
  | { type: 'tool_call' | 'tool_result'; ... }
  | { type: 'control_request'; requestId: string; tool: string; input: unknown }
  | { type: 'run_finished'; runId: string; status: 'ok' | 'error' | 'cancelled' }
  | { type: 'error'; message: string }
```

对浏览器仍可包一层 HTTP/SSE **适配器**，但那是 Client Gateway，不是核心。

---

## 5. 数据流（与 Provider 无关的主路径）

```
User 选 Environment + Folder
  → EnvironmentRegistry.resolve / connect
  → connection.ensureWorker()
  → connection.openFs().realpath(folder) → WorkspaceHandle
  → SessionService.bind(sessionId, handle)
  → RuntimeBroker.getOrCreate(handle) → RuntimePort
  → CredentialBroker.issue(runtime)     → 短时票 / AuthProxy 挂载

Chat turn:
  Client → AgentOrchestrator
        → RuntimePort.send(user)
        → Worker 跑 tools（sandbox 在 Worker 内）
        → control_request → PermissionGateway → Client UI
        → control_response → RuntimePort
        → stream 事件 → Client
```

换 Provider **不改这条主路径**。

---

## 6. 各 Provider 如何挂接（扩展点说明）

### 6.1 LocalProvider（一等公民）

- `list()` → `[{ id: 'local', kind: 'local', displayName: 'This machine' }]`
- `connect` → noop  
- `openRuntime(cwd)` → 同进程或本机 child worker（推荐 **始终 child worker**，与远程同构，消灭特殊路径）  
- `openFs()` → Node `fs`

> 架构建议：**连 Local 也走 RuntimePort**。同进程直接调 tools 可作为优化，但默认同构更易测。

### 6.2 SshProvider（第一期交付，对标 VS Code）

关在 `providers/ssh/`：

| 步骤 | 实现 |
|------|------|
| list/resolve | `~/.ssh/config` + settings `environments.ssh[]` |
| connect | `ssh` 连通；保存 Connection |
| ensureWorker | probe `~/.baize-agent-worker/<ver>`；缺则 scp 上传 |
| openRuntime | `ssh -R` → CredentialBroker AuthProxy；远端起 worker；封装为 RuntimePort |
| openFs | sftp 或 worker 旁路 fs RPC |
| forwardPort | `LocalForward` / 动态转发 |

UI：「Connect to Host…」只是 EnvironmentPicker 在 `kind=ssh` 时的皮肤。

### 6.3 BridgeProvider（后续）

- Environment = 别人机器上已注册的 bridge env（`directory` 已在注册时固定或可改）  
- Connector = 云 API poll work / 或本机作为 **被连方** 跑 `bridge daemon`  
- Runtime = session ingress WS（与 CC Bridge 同构）  
- **不需要** SSH；Provider 内部完全不同，外部仍是 `WorkspaceHandle`

两种角色都用同一 Provider 接口表达：

- **Outbound bridge client**（网页派活到已注册机器）  
- **Inbound bridge daemon**（本机 `baize remote-control`）——可作为单独二进制，向 Registry 注册 Environment

### 6.4 CloudProvider（后续，对标 CCR/Codespaces）

- `connect` = `POST /environments` 或 `POST /sessions` + git/bundle 物化 workspace  
- cwd 由云侧 checkout 决定；Handle 里仍是 `{ environmentId, cwd }`  
- Runtime = 云 session WS  

### 6.5 DirectProvider（后续）

- 目标机已有常驻 Worker（`cc://` / 内网 URL）  
- `connect` = HTTP create session + WS  
- 无 deploy；`ensureWorker` 变版本协商  

---

## 7. Workspace / Sandbox 语义（修正）

废除「本地 path 字符串到处传」。

| API | 行为 |
|-----|------|
| `WorkspaceService.list(handle, path)` | 委派 `connection.openFs()` |
| Tool 执行 | **只在 Worker 内**见 `cwd`；Orchestrator 不传本机绝对路径去校验远端 |
| Sandbox | Worker 启动参数 `sandboxRoot=cwd`；策略随 Handle 下发 |
| 切换文件夹 | 新 `WorkspaceHandle` → RuntimeBroker 关闭旧 Runtime → `openRuntime(newCwd)`（可配置是否复用 connection） |
| Session 历史 | 存 Control Plane；消息里的路径是 **环境内路径**；迁移环境不自动改写历史 |

显示：

```
label = `${env.displayName}:${handle.cwd}`
// atsrws0049:/home/u/ws-code_index
// This machine:C:\Users\...\proj
```

---

## 8. CredentialBroker（从 SSH 细节提升为平台能力）

所有非 local（以及推荐 local child worker）共用：

```
CredentialBroker
  ├─ issueRuntimeAuth(sessionId, envId) → { token, expiresAt, brokerUrl }
  ├─ AuthProxy (本地监听)  ← SshProvider -R 打到这里
  └─ HTTP mint endpoint    ← Bridge/Cloud/Direct Worker 来换票
```

规则：

- Worker 环境变量只有 `RUNTIME_TOKEN` + `BROKER_URL`（经隧道可达）  
- 禁止把长期 LLM Key 写入远端磁盘 / 远端 env  
- Token 绑定 `sessionId + environmentId`，可吊销  

这是 CC AuthProxy 的泛化：**隧道只是一种到达 Broker 的方式**。

---

## 9. 模块目录（按边界，而不是按 SSH）

```
src/execution/                    # 平台核心（无 ssh import）
  types.ts                        # Environment*, WorkspaceHandle, ports
  environment-registry.ts
  runtime-broker.ts
  workspace-service.ts
  credential-broker.ts
  permission-gateway.ts
  agent-orchestrator.ts           # 现有 agent loop 迁入/适配
  runtime-protocol.ts             # 消息 schema

src/execution/providers/
  local/
    local-provider.ts
  ssh/                            # 第一期
    ssh-provider.ts
    ssh-config.ts
    ssh-deploy.ts
    ssh-runtime.ts                # RuntimePort over SSH
    ssh-fs.ts
  bridge/                         # 占位或空实现
  cloud/
  direct/

src/worker/                       # Execution Plane 入口（可同仓）
  main.ts                         # --worker；只依赖 runtime-protocol + tools
  ...

src/server/                       # Control API：薄适配 HTTP/WS → 上述服务
client/.../environment-picker.*   # 按 kind 渲染，不写死 SSH
```

**禁止**：在 `session/store`、`router`、`tools/*` 里出现 `sshHost` / `hostId` 字段。  
Session 只存 `WorkspaceHandle`；SSH 细节进 `EnvironmentDescriptor.endpoint`（由 SshProvider 读写）。

---

## 10. 第一期交付范围（在好架构上做 SSH）

在上述骨架上，**只实现**：

1. `LocalProvider`（child worker 同构）  
2. `SshProvider`（Connect Host + Open Folder）  
3. `CredentialBroker` + AuthProxy  
4. Electron/CLI 的 Environment / Folder picker  
5. Control API：创建 session 时提交 `WorkspaceHandle`  

**明确不做**（但接口留好）：

- Bridge / Cloud / Direct 的完整实现  
- 完整 IDE Remote Extension Host  
- Web SSO 代持用户 SSH（可后加 Gateway Provider）  

验收仍用 VS Code 场景，但验收的是 **平台**：`kind=ssh` 的一条 Provider 路径。

---

## 11. 扩展新远程需求的检查清单

以后加需求时，按序问：

1. 这是新的 **EnvironmentKind**，还是现有 kind 的能力开关？  
2. 能否只实现/扩展一个 `EnvironmentProvider`？  
3. Workspace 是否仍是 `{ environmentId, cwd }`？  
4. Runtime 是否仍走同一 `RuntimePort` 消息？  
5. 凭证是否仍只经 `CredentialBroker`？  
6. Session / Orchestrator / Client Chat 是否 **零改或只加展示字段**？  

若 2–6 任一条要改主干 → 设计有问题，先改 Provider 边界，不要在 Session 上打补丁。

### 举例

| 需求 | 做法 |
|------|------|
| 连 atsrws0049 打开目录 | SshProvider |
| 机器常驻等人从网页派活 | BridgeProvider + inbound daemon |
| 云端 git 沙箱 | CloudProvider（create env + clone） |
| 内网已有 Worker URL | DirectProvider |
| 跳板机 / ProxyJump | SshProvider.endpoint 字段，不改 Session |
| 每任务独立 worktree | RuntimeBroker 策略或 WorkspaceService 派生 cwd，Environment 不变 |
| 多用户 SSO 钉盘 | LocalProvider + 不同默认 cwd（仍是 local env） |

---

## 12. 与上一版文档的关系

| 上一版有价值的部分 | 修订后落点 |
|--------------------|------------|
| SSH probe/deploy/`-R`/AuthProxy | `SshProvider` 内部 |
| Host/Folder picker UX | Client 对 `kind=ssh` 的呈现 |
| 权限回本地 UI | `PermissionGateway` + Runtime control_* |
| `--remote-local` e2e | `LocalProvider` child worker；或 SshProvider 的 fake connector |
| 分阶段落地 | 先骨架 + Local + SSH；再 Bridge/Cloud |

| 上一版应废弃的部分 | 原因 |
|--------------------|------|
| Session.`remote?: { hostId, ... }` | 换成必填 `workspace: WorkspaceHandle` |
| `transport: local \| ssh` | 换成 Provider；API 不暴露 transport 枚举 |
| 以「少改现有 HTTP」为架构中心 | 改为 Runtime 协议中心 + HTTP 适配器 |
| 文档标题/目录以 Remote-SSH 为根 | 根是 **Execution Environments**；SSH 是 Provider |

初稿保留作 SSH 细节备忘：[`baize-agent-remote-ssh-architecture.md`](./baize-agent-remote-ssh-architecture.md)

---

## 13. 总结

**好架构的中心不是 SSH，而是：**

> Environment（在哪跑）× Workspace（哪个目录）× Runtime（怎么说话）× CredentialBroker（凭证）  
> Provider 可插拔；Local 一等公民；Session 只绑 WorkspaceHandle。

第一期用 **SshProvider** 满足 VS Code 式体验；之后任何远程需求优先加 Provider，而不是在 Session/Router 上长 `if (remoteXxx)`。

这才是「后面其它远程需求更好加」的结构。
