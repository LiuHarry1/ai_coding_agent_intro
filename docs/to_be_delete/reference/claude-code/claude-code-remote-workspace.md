# Claude Code：远程连接与 Workspace 指定架构

> 源码基线：`C:\Users\harry.liu\cursor_workspace\public\claude-code-rev`  
> 聚焦问题：**如何远程连到某一台电脑，并指定该电脑上的 workspace（工作目录）**

---

## 1. 结论速览

Claude Code（CC）里「远程」不是单一实现，而是 **四条并行路径**。  
「指定远程 workspace」的方式也因路径而异：

| 路径 | 入口 | Agent 跑在哪 | Workspace 怎么指定 |
|------|------|--------------|-------------------|
| **CCR / Teleport** | `--remote` / `--teleport` | Anthropic 云 / BYOC 容器 | Git clone 或 git bundle 灌入环境；不传本机绝对路径 |
| **Remote Control (Bridge)** | `claude remote-control` / `/remote-control` / `--rc` | **本机**（子进程 CLI） | 注册 `directory = cwd`；spawn 时 `cwd: dir` / worktree |
| **SSH** | `claude ssh <host> [dir]` | SSH 远端主机 | 位置参数 `[dir]` 或 settings `sshConfigs[].startDirectory` |
| **Direct Connect** | `cc://` / `cc+unix://` | Peer server 进程 | `POST /sessions` 带 `{ cwd }`，服务端可回 `work_dir` |

**真正「连到某一台电脑 + 指定该机上某个目录」的，主要是 SSH 与 Bridge（本机充当环境）。**  
CCR 是「连到云端环境」，workspace 由 git source/bundle 物化，而不是本机路径透传。

---

## 2. 总体架构

```
┌──────────────────┐     OAuth      ┌─────────────────────────────┐
│  Local CLI / REPL │◄──────────────►│  api.anthropic.com          │
│  (Ink UI)         │               │  /v1/sessions               │
│                   │  WS subscribe │  /v1/environment_providers  │
│  useRemoteSession │◄──────────────►│  /v1/environments/bridge    │
│  useReplBridge    │  poll work    │  session_ingress WS/SSE     │
│  useSSHSession    │               └──────────────┬──────────────┘
│  useDirectConnect │                              │
└────────┬─────────┘                               │ schedule / clone
         │                                         ▼
         │ spawn / ssh / HTTP        ┌─────────────────────────────┐
         ▼                           │ CCR container / BYOC        │
┌──────────────────┐                 │ clone git OR seed bundle    │
│ Bridge child CLI │                 │ worker CLI (remote entry)   │
│ cwd = dir/worktree│                 └─────────────────────────────┘
└──────────────────┘
┌──────────────────┐   ssh -R auth  ┌─────────────────────────────┐
│ useSSHSession    │◄──────────────►│ Remote host Claude binary   │
│ (UI local)       │   stream-json  │ cwd = [dir]/startDirectory  │
└──────────────────┘               └─────────────────────────────┘
┌──────────────────┐   HTTP+WS      ┌─────────────────────────────┐
│ useDirectConnect │◄──────────────►│ Peer server (/sessions)     │
│                  │   cwd in POST  │ work_dir / child process    │
└──────────────────┘               └─────────────────────────────┘
```

**统一 UI 模式**：REPL / Ink 留在本地 → 经 WS/HTTP 收发 SDK stream-json → 权限用 `control_request` / `control_response` → Agent 进程在别处执行。

---

## 3. 路径一：SSH（指定远程电脑 + workspace）

### 3.1 用户入口

```bash
claude ssh <host> [dir]
# 例：
claude ssh my-devbox ~/projects/foo
claude ssh --permission-mode auto my-devbox /tmp/work
claude ssh --local /some/dir   # e2e：跳过真实 ssh，测 proxy/auth
```

解析位置：`src/main.tsx`（feature gate `SSH_REMOTE`）。  
可选位置参数 `[dir]` 即远程 working directory。

### 3.2 Settings 中的默认 workspace

`src/utils/settings/types.ts`：

```ts
sshConfigs?: Array<{
  id: string
  name: string
  sshHost: string
  sshPort?: number
  sshIdentityFile?: string
  startDirectory?: string  // 远端默认 cwd，支持 ~ 展开；可被 CLI [dir] 覆盖
}>
```

### 3.3 设计意图（源码注释）

`main.tsx` 中明确写出完整链路：

1. **probe** 远端是否已有可用 Claude binary  
2. 需要时 **deploy** binary  
3. `ssh` 带 **unix-socket `-R`**，转发到本机 **auth proxy**（鉴权不落远端明文）  
4. 交给 REPL 一个 `SSHSession`：**Tools 在远端跑，UI 在本地渲染**  
5. `setOriginalCwd(sshSession.remoteCwd)` / `setCwdState(...)` —— workspace 以远端返回的 `remoteCwd` 为准  

会话历史按远端路径落在：`~/.claude/projects/<cwd>/`。

### 3.4 本树还原缺口

| 文件 | 状态 |
|------|------|
| `src/ssh/createSSHSession.ts` | **stub**：`return {}` |
| `src/ssh/SSHSessionManager.ts` | 空类 |
| `src/hooks/useSSHSession.ts` | 完整生命周期期望存在，依赖真实 session API |

因此：**架构与 CLI/settings 契约齐全，但本 rev 中 SSH 运行时实现被剥空。**

---

## 4. 路径二：Remote Control / Bridge（把某台电脑注册成 Environment）

这是「远程连到某一台电脑」在产品上的主路径之一：  
**在目标机器上跑 `claude remote-control`**，该机器向 Anthropic 注册为 `bridge` 环境；用户从 claude.ai / 另一台 CLI 发起 session，工作派发回这台机器。

### 4.1 入口

| 入口 | 说明 |
|------|------|
| `claude remote-control`（别名 `rc` / `remote` / `sync` / `bridge`） | 独立 bridge server |
| `/remote-control` slash command | REPL 内开启 |
| `--remote-control` / `--rc` | 交互会话内启用 bridge |

核心目录：`src/bridge/`（`bridgeMain.ts`、`bridgeApi.ts`、`sessionRunner.ts`、`createSession.ts`、`workSecret.ts`、`replBridge.ts` 等）。

### 4.2 Workspace = 注册时的 `directory`

注册 API：`POST /v1/environments/bridge`

```ts
// src/bridge/bridgeApi.ts
{
  machine_name: config.machineName,  // hostname
  directory: config.dir,             // ← workspace（通常 getOriginalCwd()）
  branch: config.branch,
  git_repo_url: config.gitRepoUrl,
  max_sessions: config.maxSessions,
  metadata: { worker_type: config.workerType },
  ...(reuseEnvironmentId && { environment_id: reuseEnvironmentId }),
}
```

`BridgeConfig.dir` 就是这台电脑上被对外暴露的 workspace 根路径。

### 4.3 SpawnMode：多 session 时如何选目录

```ts
// src/bridge/types.ts
type SpawnMode = 'single-session' | 'worktree' | 'same-dir'
```

| 模式 | 行为 |
|------|------|
| `single-session` | 单个 session，cwd = 注册 directory；结束后 bridge 退出 |
| `same-dir` | 持久 server，多 session **共享**同一 cwd（可能互相踩） |
| `worktree` | 持久 server，每个 session 建独立 **git worktree** |

CLI：`--spawn same-dir|worktree|session`、`--capacity N`、`--create-session-in-dir` / `--no-…`、`--session-id` 恢复。

### 4.4 工作派发与子进程 cwd

```
registerBridgeEnvironment(directory=cwd)
  → runBridgeLoop
  → GET /v1/environments/{id}/work/poll
  → decode WorkSecret → sdkUrl + session_ingress_token
  → sessionRunner.spawn(..., dir)   // ChildProcess cwd = dir
       child: claude --print --sdk-url … 
       env: CLAUDE_CODE_ENVIRONMENT_KIND=bridge
            CLAUDE_CODE_SESSION_ACCESS_TOKEN=…
```

关键代码（`sessionRunner.ts`）：

```ts
const child = spawn(deps.execPath, args, {
  cwd: dir,   // ← 指定远程（本机）workspace
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
})
```

### 4.5 WorkSecret（派工载荷）

```ts
type WorkSecret = {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{ type: string; git_info?: {...} }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  use_code_sessions?: boolean  // CCR v2
}
```

---

## 5. 路径三：CCR / Teleport（云端远程 Session）

### 5.1 入口

```bash
claude --remote "fix login"     # 创建 CCR session
claude --teleport <sessionId>   # 恢复 / 附着
```

相关模块：

- `src/utils/teleport.tsx` — 创建/恢复、git checkout  
- `src/utils/teleport/api.ts` — Sessions API 类型  
- `src/utils/teleport/environments.ts` — 列环境  
- `src/remote/RemoteSessionManager.ts` + `SessionsWebSocket.ts` — 本地 UI ↔ CCR  
- `src/hooks/useRemoteSession.ts` — REPL 接线  

### 5.2 Workspace 不是本机路径

`SessionContext` 虽有 `cwd` 字段，但创建时通常 **不把本机绝对路径当 workspace**：

```ts
type SessionContext = {
  sources: SessionContextSource[]   // git_repository URL + revision
  cwd: string
  outcomes: Outcome[] | null
  seed_bundle_file_id?: string      // 非 GitHub 仓库：上传 .git bundle
  // ...
}
```

物化顺序（`teleportToRemote`）：

1. 探测本地 repo → 构造 `git_repository` source（URL + branch）  
2. 或上传 **git bundle** → `seed_bundle_file_id`  
3. 都没有 → **空 sandbox**  
4. 选 `environment_id`：`settings.remote.defaultEnvironmentId` → `anthropic_cloud` → 非 bridge → 第一个  

云侧 environment-manager **clone/checkout** 后，worker 在容器内跑；默认云环境 cwd 倾向 `/home/user`。

### 5.3 连接协议

| 步骤 | 机制 |
|------|------|
| Auth | Claude.ai OAuth（`Bearer` + `x-organization-uuid` + beta `ccr-byoc-2025-07-29`） |
| Create | `POST /v1/sessions` |
| Subscribe | `wss://…/v1/sessions/ws/{id}/subscribe?organization_uuid=…` |
| User input | `POST /v1/sessions/{id}/events` |
| 权限/中断 | 同 WS 上 `control_request` / `control_response` |

本地侧由 `RemoteSessionManager` 持有 WS，UI 不跑工具。

### 5.4 与 Bridge 的环境关系

`GET /v1/environment_providers` 返回环境 `kind`：

- `anthropic_cloud`  
- `byoc`  
- `bridge`（你的电脑）  

选默认环境时会 **优先避开 bridge**（除非显式 `defaultEnvironmentId`），避免 `--remote` 误派到本机。

---

## 6. 路径四：Direct Connect（Peer 直连）

### 6.1 入口

`cc://` / `cc+unix://` URL → `createDirectConnectSession`。

> 注意：本树中 `parseConnectUrl.js` **缺失**，URL 解析路径可能无法 import。

### 6.2 Workspace 手递

```ts
// src/server/createDirectConnectSession.ts
await fetch(`${serverUrl}/sessions`, {
  method: 'POST',
  body: JSON.stringify({
    cwd,                                    // 客户端指定
    ...(dangerouslySkipPermissions && { dangerously_skip_permissions: true }),
  }),
})
// 响应：{ session_id, ws_url, work_dir? }
```

客户端可用服务端返回的 `work_dir` 调用 `setOriginalCwd` / `setCwdState`。  
后续经 WebSocket NDJSON（SDK stream-json）通信；工具在 peer 侧执行。

---

## 7. 「指定远程 workspace」对照表

| 场景 | 谁决定路径 | 关键字段 / 参数 | 落地方式 |
|------|------------|-----------------|----------|
| SSH | 用户 CLI / settings | `[dir]` / `startDirectory` | 远端进程 `cwd` = `remoteCwd` |
| Bridge 注册 | 目标机当前目录 | `directory: config.dir` | 环境元数据 + spawn `cwd` |
| Bridge worktree | Bridge spawnMode | `createAgentWorktree` | 每 session 独立目录 |
| CCR | Git 源 / bundle | `sources[]` / `seed_bundle_file_id` | 容器内 clone |
| Direct Connect | 客户端 POST | `cwd` → 可选 `work_dir` | peer 子进程目录 |

---

## 8. 端到端时序

### 8.1 想连「某台开发机上的某个目录」——推荐理解：SSH

```
User: claude ssh devbox ~/src/app
  → parse host + dir
  → createSSHSession({ host, cwd })
  → probe/deploy + ssh -R auth proxy
  → remoteCwd 写回本地 state
  → launchRepl(sshSession)
  → useSSHSession：UI 本地，工具远端
```

### 8.2 让「某台电脑」可被云端/网页远程使用 —— Bridge

```
On target machine:
  cd /path/to/workspace
  claude remote-control --spawn worktree --capacity 4
    → POST /v1/environments/bridge { directory: /path/to/workspace, ... }
    → poll work → spawn child with cwd=dir|worktree

On phone / another laptop / claude.ai:
  open session targeting that environment
    → backend enqueue work
    → bridge picks up → agent runs on target machine workspace
```

### 8.3 云端沙箱写代码 —— CCR

```
claude --remote "fix the flaky test"
  → pick environment_id
  → POST /v1/sessions + git/bundle context
  → container clone → worker
  → local WS subscribe（或打印 resume URL）
```

---

## 9. 关键源码索引

| 主题 | 路径 |
|------|------|
| SSH CLI 解析与启动 | `src/main.tsx`（`SSH_REMOTE`、`_pendingSSH`） |
| SSH session 工厂（stub） | `src/ssh/createSSHSession.ts` |
| SSH REPL hook | `src/hooks/useSSHSession.ts` |
| SSH settings | `src/utils/settings/types.ts` → `sshConfigs` |
| Bridge 类型 / SpawnMode | `src/bridge/types.ts` |
| Bridge 注册 / poll | `src/bridge/bridgeApi.ts` |
| Bridge 主循环 | `src/bridge/bridgeMain.ts` |
| Bridge 子进程 cwd | `src/bridge/sessionRunner.ts` |
| Bridge slash command | `src/commands/bridge/bridge.tsx` |
| CCR 创建 session | `src/utils/teleport.tsx` → `teleportToRemote` |
| CCR API 类型 | `src/utils/teleport/api.ts` |
| CCR WS 客户端 | `src/remote/SessionsWebSocket.ts` / `RemoteSessionManager.ts` |
| Direct connect | `src/server/createDirectConnectSession.ts` |
| Direct connect manager | `src/server/directConnectManager.ts` |

---

## 10. 配置与开关摘要

### Settings

```ts
remote?: { defaultEnvironmentId?: string }
sshConfigs?: Array<{ id, name, sshHost, sshPort?, sshIdentityFile?, startDirectory? }>
```

### Policy / GrowthBook（节选）

- `allow_remote_sessions` — CCR / `--remote`  
- `allow_remote_control` — Bridge  
- `tengu_remote_backend`、`tengu_ccr_bundle_seed_enabled`、`tengu_ccr_bridge_multi_session` 等  

### 环境变量（worker / bridge）

- `CLAUDE_CODE_SESSION_ACCESS_TOKEN`  
- `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`  
- `CLAUDE_CODE_USE_CCR_V2`  
- `CLAUDE_CODE_WORKER_EPOCH`  
- `CLAUDE_BRIDGE_OAUTH_TOKEN` / `CLAUDE_BRIDGE_BASE_URL`（内部）  

---

## 11. 本还原树缺口

1. **SSH 实现 stub** —— 架构文档完整，运行时不可用  
2. **`parseConnectUrl.js` 缺失** —— `cc://` 路径可能断  
3. **`environment-runner` / `self-hosted-runner` 模块** —— CLI 入口有，实现目录不在树中  
4. 无独立 `packages/` / `electron/` remote 文档，设计主要靠源码注释  

---

## 12. 一句话总结

- **指定「某台电脑 + 某个目录」**：产品契约在 **`claude ssh <host> [dir]`**（`startDirectory`）与 **`claude remote-control` 的 `directory` / spawn cwd**。  
- **云端远程**：走 **CCR teleport**，workspace 由 **git/bundle + environment_id** 决定。  
- **本地 UI、远程执行** 是所有路径的共同分层；workspace 只是各路径在 create/register/spawn 时写入的不同字段。

