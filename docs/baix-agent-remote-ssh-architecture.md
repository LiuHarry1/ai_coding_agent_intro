# BaiX Agent：Remote-SSH 架构设计（初稿 · SSH 细节备忘）

> **已修订**：长期架构请看 [`baix-agent-remote-execution-architecture.md`](./baix-agent-remote-execution-architecture.md)。  
> 本文保留为 **SshProvider 实现细节** 备忘（probe/deploy/`-R`/AuthProxy/时序），不再作为平台根设计。

> 目标：实现类似 VS Code Remote-SSH 的体验——**选一台电脑 → 指定远程目录为 workspace → UI 本地、工具/文件在远端执行**。  
> 参考：VS Code / GitHub Codespaces 公开架构 + Claude Code（CC）`claude ssh` 路径 + 本仓库现状。

---

## 1. 问题定义

### 1.1 要对齐的产品体验（VS Code）

```
Connect to Host… → 选 atsrws0049（或 user@host）
                 → Open Folder… → /home/…/ws-code_index
                 → 标题栏显示 [SSH: atsrws0049]
                 → 读写文件 / 终端 / 语言服务都在远端
```

### 1.2 本仓库现状

| 能力 | 现状 |
|------|------|
| Workspace | 本机（或 Docker 挂载）路径：`WORKSPACE` / `--workspace` / 请求体 `workspace` |
| Agent 进程 | 与 HTTP API **同机** Node 进程；工具直接碰本地盘 |
| 客户端 | Web SPA、Electron（本地起 agent）、CLI/ACP |
| 多用户 | SSO 钉死 `/USERS_ROOT/<email>`，不是多机 |
| Remote-SSH | **无运行时**；仅有 `cc_docs` 对 CC 的逆向笔记 |

### 1.3 设计原则（对齐 CC，而不是照搬完整 VS Code IDE）

Coding Agent ≠ IDE。我们要的是 **Agent Runtime 远端化**，不是把整个语言服务/扩展宿主搬过去。

| 层 | VS Code | CC `claude ssh` | 我们建议 |
|----|---------|-----------------|----------|
| UI | 本地 Workbench | 本地 Ink REPL | 本地 Web / Electron |
| 执行面 | VS Code Server + Extension Host | 远端 Claude CLI（tools） | **远端 Agent Worker**（tools + cwd） |
| 传输 | SSH 隧道多路复用 | SSH + unix-socket `-R` auth proxy + stream-json | SSH 隧道 + **NDJSON / WebSocket 会话流** |
| Workspace | Open Folder on remote | `[dir]` / `startDirectory` → `remoteCwd` | `host + remotePath` 绑定到 Session |
| 鉴权 | 系统 SSH keys | 本地 auth proxy 反代，密钥不落远端 | **复用系统 SSH + 本地 Auth Proxy**（抄 CC） |

---

## 2. 业界怎么做（简要）

### 2.1 VS Code Remote-SSH

```
Local VS Code (thin UI)
        │  SSH (authenticated tunnel)
        ▼
Remote: ~/.vscode-server/  ← 自动 probe / download / install / start
        │
        ├─ File I/O, Terminal, Debug
        └─ Remote Extension Host（workspace extensions）
```

要点：

1. **UI / Workspace 分离**：主题等 UI 扩展留本地；语言服务等跑远端。  
2. **Server 生命周期托管**：首次连接安装，版本与客户端匹配，断线重连。  
3. **单隧道多路**：文件、终端、端口转发都走同一 SSH 连接。  
4. **Host 配置**：读 `~/.ssh/config`，支持 named host / `user@host` / ProxyJump。

官方文档：[Remote Development using SSH](https://code.visualstudio.com/docs/remote/ssh)、[Remote Extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)。

### 2.2 GitHub Codespaces（对照，不做第一期）

同一套「本地 UI + 远端 VS Code Server」，但环境是 **云端托管容器**，生命周期由 GitHub 管，不是你自己的 `atsrws0049`。  
对应 CC 里更像 **CCR / Teleport**，不是 SSH。我们第一期 **不走这条**。

### 2.3 Claude Code SSH（本仓库应对齐的契约）

```
claude ssh <host> [dir]
  → createSSHSession({ host, cwd })
  → probe 远端 binary → 需要则 deploy
  → ssh -R unix-socket → 本地 Auth Proxy（鉴权留本地）
  → setOriginalCwd(remoteCwd)
  → REPL 本地；tools 远端；权限 control_request 回本地 UI
```

关键不变量（我们应保留）：

- **UI 本地、工具远端**  
- **Workspace = 远端绝对路径**（`remoteCwd`），本地会话状态只存引用  
- **Auth Proxy**：模型 API Key / OAuth 不抄到远端环境变量里裸奔  
- **`--local` e2e**：跳过真实 SSH，验证 proxy / 协议  

本树 CC 源码中 `createSSHSession` 是 stub，但 `main.tsx` + `useSSHSession` 契约完整，可直接当设计说明书。

---

## 3. 推荐架构（BaiX Remote-SSH）

### 3.1 一句话

> **本地 Controller（Web/Electron/API 门面）通过 SSH 在目标机拉起 Agent Worker；  
> Session 绑定 `{ hostId, remoteCwd }`；聊天与工具流经隧道；权限弹窗回本地。**

不要让浏览器直连远端 SSH；也不要在远端裸跑带全量密钥的 agent。

### 3.2 逻辑分层

```
┌─────────────────────────────────────────────────────────────┐
│  Client: Web / Electron                                      │
│  - Host picker（读 sshConfigs / ~/.ssh/config）              │
│  - Folder picker（连上后列远端目录）                          │
│  - Chat UI + Permission modal                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / WS (localhost 或 SSO 入口)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Local Controller (= 现有 agent 进程的「编排侧」扩展)         │
│  - SessionStore（已有）+ RemoteBinding                       │
│  - SshHostRegistry                                           │
│  - RemoteSessionManager（生命周期）                          │
│  - AuthProxy（本地：注入 LLM credentials）                   │
│  - Workspace API：local | remote 双后端                      │
└───────────────────────────┬─────────────────────────────────┘
                            │ SSH: exec + RemoteForward(-R)
                            │   + 可选 LocalForward 预览端口
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Remote Agent Worker（目标机）                               │
│  - 安装于 ~/.baix-agent-server/<version>/                    │
│  - cwd = remoteCwd                                           │
│  - 执行 Read/Edit/Bash/Grep…（现有 tools，cwd 相对远端）      │
│  - 会话流：stream-json / NDJSON over unix socket → SSH -R    │
│  - 无长期明文 API Key：经 AuthProxy 反代或短时 token         │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 与现有代码的映射

| 现有模块 | Remote 模式下的变化 |
|----------|---------------------|
| `src/core/workspace.ts` | 仍解析 **默认本地** workspace；Remote Session 用 `RemoteBinding.remoteCwd` 覆盖 |
| `src/server/request-cwd.ts` | 增加：若 session 有 remote binding → tools 不走本地 `resolveRequestCwd`，改走 RemoteSessionManager 转发 |
| `src/session/store.ts` | Session 增加可选字段 `remote?: { hostId, remoteCwd, workerVersion }` |
| `src/server/workspace/router.ts` | `list/stat/read` 增加 `transport: local \| ssh` |
| `client/web` Header | 仿 VS Code：Connect Host → Open Remote Folder；标题显示 `[SSH: host]` |
| Electron | 可优先落地（本机有 SSH agent / keys）；Web SSO 第二期再做（需网关代持 SSH） |
| Docker SSO 钉目录 | **互斥或降级**：Remote-SSH 面向「开发者连自己的机」；企业钉用户盘仍走本地挂载方案 |

### 3.4 核心类型（建议）

```ts
/** 与 CC sshConfigs 对齐，并兼容解析 ~/.ssh/config */
type SshHostConfig = {
  id: string
  name: string                 // UI 显示名，如 atsrws0049
  sshHost: string              // HostName 或别名
  sshUser?: string
  sshPort?: number
  sshIdentityFile?: string
  proxyJump?: string
  startDirectory?: string      // 默认远端 cwd，~ 可展开
}

type RemoteBinding = {
  hostId: string
  remoteCwd: string            // 远端绝对路径（展开后）
  workerPid?: number
  workerVersion: string
  connectedAt: string
}

type Session = {
  id: string
  // ...existing fields
  remote?: RemoteBinding | null
}
```

Settings 建议放在 `.ai-agent/settings.json`：

```json
{
  "sshConfigs": [
    {
      "id": "atsrws0049",
      "name": "atsrws0049",
      "sshHost": "atsrws0049",
      "startDirectory": "~/ws-code_index"
    }
  ]
}
```

同时提供 **Import from `~/.ssh/config`**，贴近 VS Code 选 host 体验。

---

## 4. 连接时序（对齐 VS Code + CC）

```
1. User: Connect to Host → atsrws0049
2. Controller: 解析 SshHostConfig / ssh config
3. ssh 连通性探测（BatchMode / 超时）
4. Probe: 远端是否已有兼容 Agent Worker
     无 → 本地打包/下载 worker → scp/sftp 到 ~/.baix-agent-server/<ver>/
5. 本地启动 AuthProxy（监听 unix socket 或 127.0.0.1 高位端口）
6. ssh -R <remote_sock>:<local_auth_proxy>
     + 远端启动: baix-agent-worker --cwd <dir> --sdk-url unix://... --print
7. Handshake：协商 protocol version、返回 remoteCwd（realpath）
8. UI: Open Folder（若未指定 dir）→ 远端 list_dir → 用户确认
9. Session.remote = { hostId, remoteCwd, workerVersion }
10. 之后每条 chat：
      Client → Controller → SSH stream → Worker tools(cwd=remoteCwd)
      permission ask → 回 Controller → 弹本地 UI → control_response
```

失败回退：

- SSH 失败 → 明确错误（host/key/proxyjump）  
- Deploy 失败 → 提示无外网时可「本机下载再上传」（抄 VS Code `localServerDownload`）  
- Worker crash → 自动重启一次；仍失败则断开 binding  

---

## 5. 协议选择（参考 CC，贴合本仓库）

CC 远端 CLI 用 **stream-json**；本仓库已是 **HTTP + SSE/WS 聊天**。建议双层：

| 段 | 协议 | 说明 |
|----|------|------|
| Browser ↔ Controller | 保持现有 REST + 流式（少改前端） | Session 带 `remote` 元数据即可 |
| Controller ↔ Worker | **NDJSON stream-json 子集**（抄 CC） | 经 SSH 转发的 socket；消息类型：`assistant` / `tool_use` / `tool_result` / `control_request` / `control_response` / `result` |

Controller 做 **协议适配器**：对内像「又一个本地 agent 后端」，对外是 SSH Worker。这样 Web UI 几乎不用重写工具渲染。

---

## 6. Workspace 语义（关键）

今天：`resolveRequestCwd` = 本机路径。  
Remote 后必须拆成两个概念：

| 概念 | 含义 |
|------|------|
| `uiWorkspaceLabel` | 展示用：`atsrws0049:/home/…/ws-code_index` |
| `executionCwd` | Worker 进程 `cwd`；所有相对路径相对它 |
| `sandbox root` | 远端 `remoteCwd`；sandbox 校验在 **Worker 内**做（不能在本地用本机 realpath 校验远端路径） |

规则：

1. 进入 Remote Session 后，**忽略**客户端乱传的本地 `workspace`（防越权）。  
2. 切换远端文件夹 = 新 binding 或重启 Worker（简单起见 **重启 Worker**，对齐 VS Code「换文件夹常重载窗口」）。  
3. Session 历史仍存 Controller 侧 `.sessions/`；tool 产物路径写成远端路径字符串。

---

## 7. 安全设计（必须抄 CC 的意图）

1. **AuthProxy 本地化**：LLM API Key / SSO token 只在 Controller/AuthProxy；Worker 只拿 session 短时凭证或经 `-R` 反代。  
2. **SSH 仍走用户自己的密钥 / ssh-agent**；产品不自建一套 SSH 密码库（可后续加密存 passphrase，非第一期）。  
3. **权限模型不变**：危险工具仍 `control_request` 回本地确认（CC `useSSHSession` 同款）。  
4. **SSO 场景**：浏览器用户一般没有到内网机的 SSH——第一期 **仅 Electron / 本机 CLI** 开 Remote-SSH；Web SSO 继续用「agent 跑在服务器 + 钉用户盘」。  
5. **审计**：Session 记录 `hostId + remoteCwd + user`，便于追溯「在哪台机器改了什么」。

---

## 8. 分阶段落地（建议）

### Phase 0 — 契约与假远端（1 周量级）

- 增加 `SshHostConfig` / `RemoteBinding` 类型与 settings  
- `--remote-local`（对齐 CC `--local`）：本机再 spawn 一个 worker 子进程 + AuthProxy，**不走 SSH**  
- UI：显示「伪远程」标签，跑通权限回传与 cwd 绑定  

### Phase 1 — 真 SSH MVP（对齐 VS Code Connect + Open Folder）

- 解析 `~/.ssh/config` + settings `sshConfigs`  
- Host picker + 连通探测  
- scp 部署静态 worker 二进制/目录  
- `ssh -R` + AuthProxy  
- Electron Header：`[SSH: host]` + 远端目录浏览  
- Chat 全走 Remote Worker  

### Phase 2 — 体验打磨

- 断线重连 / Worker 保活  
- 端口转发（预览 `preview.ts` 场景）  
- Host 级 settings（远端 CLAUDE.md / `.ai-agent` 读策略）  
- IdentityFile / ProxyJump / 跳板机  

### Phase 3 — 可选扩展（先不做）

- **Bridge 反向注册**（CC Remote Control）：机器在线等人派活——适合「网页点一下用同事的编译机」  
- **CCR 式云环境**：自建容器池——对应 Codespaces，另立项  

---

## 9. 模块目录建议

```
src/remote/
  types.ts                 # SshHostConfig, RemoteBinding, protocol msgs
  ssh-config-parse.ts      # ~/.ssh/config
  host-registry.ts
  auth-proxy.ts            # 本地凭证反代
  worker-deploy.ts         # probe / upload / version
  ssh-session.ts           # createSSHSession 真实现（对标 CC）
  remote-session-manager.ts
  protocol-adapter.ts      # Worker NDJSON ↔ 现有 chat stream
  local-fake-session.ts    # Phase 0 --remote-local

client/web/src/components/
  RemoteHostPicker.jsx     # 对标图中 Select SSH host
  RemoteFolderPicker.jsx
```

Worker 可先 **复用同一份 agent 代码**，用入口 flag：

```
node dist/start.js --worker --stdio-sdk --workspace <remoteCwd>
```

避免维护第二套 tools。

---

## 10. 与 CC 四条路径的取舍

| CC 路径 | 是否采用 | 原因 |
|---------|----------|------|
| **SSH** | **第一优先** | 直接对应 VS Code Remote-SSH 截图场景 |
| Bridge | 第二期可选 | 「机器主动上线」；不解决「我连 atsrws0049」 |
| CCR/Teleport | 远期 | 云沙箱，非内网机房机器 |
| Direct Connect `cc://` | 可作 Worker 协议灵感 | 内网已有 agent 常驻时可用；SSH 自动 deploy 更贴近 VS Code |

---

## 11. 成功标准（验收）

1. Electron 中选 `atsrws0049`，打开远端 `~/ws-code_index`，标题显示 `[SSH: atsrws0049]`。  
2. Agent 创建/修改的文件出现在 **远端**该目录，本机无副本。  
3. Bash 工具 `hostname` / `pwd` 显示远端主机与 `remoteCwd`。  
4. 权限弹窗在 **本地 UI**；Deny 后远端不执行。  
5. 远端进程环境 **看不到** 完整 LLM API Key。  
6. `--remote-local` e2e 不依赖真实 SSH 即可回归协议。

---

## 12. 总结

- **业界范式**：VS Code = 本地 UI + 远端 Server + SSH 隧道；Codespaces = 同一范式的云托管版。  
- **CC 范式**：同一不变量，但远端跑的是 **Agent CLI**，用 AuthProxy 护凭证——更适合我们。  
- **我们的架构**：在现有 Controller（HTTP agent）上增加 **RemoteSessionManager + AuthProxy + Worker deploy**；Session 绑定 `host + remoteCwd`；UI 做 Host/Folder picker。  
- **不要**第一期做完整 Remote Extension Host；**不要**让 Web SSO 用户直连 SSH。  

这样既贴近图中 VS Code 体验，又最大复用本仓库现有 Chat/Session/Tools，并与已逆向的 CC SSH 设计同构，后续若要对齐 CC 行为也成本最低。
