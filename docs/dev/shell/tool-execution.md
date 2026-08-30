# Shell 工具执行原理（Bash / PowerShell）

> 面向还不熟悉本仓库 Shell 工具的读者：模型调用一次 `Bash` / `PowerShell` 时，背后发生了什么。  
> 后台长任务（`run_in_background`）的细节见 [bash-task-system.md](./bash-task-system.md)。

---

## 1. 它是什么

Agent 没有「一直开着的终端窗口」。  
`Bash` / `PowerShell` 是**两个工具**：模型填 `command`（以及可选的 timeout、后台等），我们在服务器上**起一个 shell 子进程**跑完，把 stdout/stderr 交回模型和 UI。

| 工具名 | 实际 shell | 入口 |
|--------|------------|------|
| `Bash` | bash | `src/tools/BashTool/` |
| `PowerShell` | powershell | `src/tools/PowerShellTool/` |

两者共用同一套执行逻辑：`src/tools/shell-runner.ts`（`createShellTool`）。

---

## 2. 一次前台调用长什么样

模型大致发出：

```json
{ "command": "cd src && ls", "description": "List source files" }
```

简化时序：

```
模型 → Bash / PowerShell 工具
        → shell-runner.execute
            →（有 Worker）execution.exec(command, { cwd })
            →（无 Worker）prepareShellSpawn + spawn(...)
        → 读输出、更新「当前目录」记忆
        → 返回给模型（text）和 UI（stdout / stderr）
```

要点：

1. **每次工具调用 ≈ 新起一个 shell 进程**，跑完就退出（不是同一个 bash 一直活着）。
2. **工作目录会跨命令接上**：靠内存里的 `cwdRef` + 命令结束时写的临时 cwd 文件（见第 4 节）。
3. **环境变量可被改写**：例如 SSO 下会给子进程设置逻辑 `HOME`（见第 5 节），这不等于改你本机系统环境。
4. **输出默认走文件 fd**（对齐 CC）：stdout/stderr 接到同一文件，进程退出后再读；Windows 用 `'w'` 打开。细节见 [output-file-fd.md](./output-file-fd.md)。

---

## 3. 代码地图（先知道文件在哪）

```
src/tools/
  BashTool/ BashTool.ts          # 注册 Bash 工具（薄封装）
  PowerShellTool/                # 注册 PowerShell（同样薄封装）
  shell-runner.ts                # ★ 工具编排：schema、前台/后台、cwdRef、调 Worker 或本机 spawn

src/core/shell/
  spawn-shell.ts                 # ★ 底层：拼 argv、env（含 HOME）、cwd 临时文件 trailer
  shell-readonly.ts              # 只读命令判定（并发安全等）
  windows-paths.ts               # Windows / bash 路径互转

src/utils/ShellCommand.ts        # 无 Worker 时的本机后台 spawn
src/tasks/LocalShellTask/        # 后台任务：task_id、落盘、通知
src/execution/ + src/worker/     # Chat 场景：命令在 Worker 进程里执行
```

层次可以记成：

| 层 | 文件 | 职责 |
|----|------|------|
| 工具面 | `BashTool` / `PowerShellTool` + `shell-runner` | 对接模型工具协议、前台/后台分支 |
| 执行原语 | `core/shell/spawn-shell` | 怎么 `spawn`、env、cwd 文件 |
| 运行时 | Worker / 本机 | 命令实际跑在哪 |

`shell-runner` 放在 `tools/`（而不是 `BashTool/` 目录里），是因为它被 **Bash 和 PowerShell 共用**；若塞进 `BashTool/`，PowerShell 反向依赖 Bash 包会很别扭。

---

## 4. 「目录还在」：新进程 + 记忆 cwd

### 4.1 为什么看起来像同一个终端

连续两条：

1. `cd /tmp/demo`
2. `pwd` → 打印 `/tmp/demo`

中间并不是同一个 bash 没关，而是：

```
命令 1：新进程 A，从 cwdRef 记录的目录启动
        结束前：pwd 写入 /tmp/某文件
        Node 读文件 → cwdRef = /tmp/demo
        进程 A 退出

命令 2：新进程 B（不是 A）
        spawn 时 cwd = cwdRef（/tmp/demo）
        执行 pwd → /tmp/demo
        进程 B 退出
```

类比：每次叫一辆新出租车；下车前记下门牌，下一辆车直接开到那个门牌。

### 4.2 谁写临时文件、谁读

**写（bash 进程自己写）** —— `spawn-shell.ts` 在用户命令后追加 trailer：

```bash
# 用户命令
...
__ec=$?
pwd -P > '/tmp/agent-shell-cwd-....'   # 把当前目录落到临时文件
exit $__ec
```

临时路径由 `makeCwdFile` 生成（在 `os.tmpdir()` 下）。

**读并记住（Node）** —— `readCwdAfter` 读文件；`shell-runner` 里：

```ts
const cwdRef = { current: cwd }           // 会话级「当前目录」记忆
// 每次执行：
spawn(..., { cwd: cwdRef.current })       // 用记忆当启动目录
// 结束后：
cwdRef.current = readCwdAfter(...)        // 用本次 pwd 更新记忆
```

有 Worker 时：Worker / `runShellCommand` 同样读 cwd 文件，通过返回值里的 `cwdAfter` 回传，`shell-runner` 再写进 `cwdRef`。

临时文件只是**一次命令的交接条**；跨命令长期拿着的是 `cwdRef`，读完一般会删掉临时文件。

---

## 5. `$HOME` 从哪来（和系统 HOME 的关系）

`prepareShellSpawn` 在拼子进程环境时会覆盖：

```ts
env: {
  ...process.env,
  HOME: getShellHome(),           // 逻辑 HOME
  // Windows 还有 USERPROFILE
}
```

| 模式 | `getShellHome()` / `getAgentHome()` |
|------|-------------------------------------|
| 本地 / AUTH 关 | 通常等于本机 `os.homedir()`（如 `/Users/you`） |
| SSO / AUTH 开 | 当前请求的用户 workspace（ALS 里的逻辑 HOME） |

因此在 SSO 页面里 `echo $HOME` 可能是  
`.../deploy/workspaces/users/<slug>`，  
而你在系统终端里仍是 `/Users/you`——**只改了 agent 拉起的那次子进程 env，没有改操作系统账户配置**。

Per-request 逻辑 HOME 与 cwd 收在同一 ALS（`RequestScope`：`agentHome` + `cwd`），路由认证成功后一次 `runWithRequestScope` 绑定。AUTH 关时 HOME 仍是本机 `os.homedir()`，cwd 多半来自请求/默认 workspace，二者常不相等。

相关代码：`src/utils/request-scope.ts`、`src/core/shell/spawn-shell.ts`、本地 Worker 启动时钉 HOME：`src/execution/providers/local/local-provider.ts`。

---

## 6. 前台 vs 后台

| | 前台（默认） | 后台 `run_in_background: true` |
|--|--------------|--------------------------------|
| 行为 | 等命令结束（或超时）再返回 | **立刻**返回 `task_id` + 输出文件路径 |
| 进程 | 仍是新起的 shell | 同样新起，但由 task 系统托管 |
| 看输出 | 本次工具结果里的 stdout/stderr | 用 **Read** 读 `.sessions/.../tasks/{id}.output`，或 `TaskOutput` / `TaskStop` |

前台超时默认约 **120s**（可用参数覆盖）。  
后台完整链路见 [bash-task-system.md](./bash-task-system.md)。

---

## 7. 命令实际跑在哪：Worker 还是本机

`shell-runner` 里两条前台路径：

| 场景 | 路径 |
|------|------|
| Chat 且已有 `context.execution`（常见） | `execution.exec(...)` → Worker RPC → Worker 内再 `prepareShellSpawn` + `spawn` |
| 测试 / 无 Worker | 在 agent 进程内直接 `prepareShellSpawn` + `spawn` |

对模型来说都是「调了一次 Bash」；差别主要在进程隔离与部署形态。  
cwd 记忆（`cwdRef`）仍在 **agent 侧的这次工具实例**上维护，Worker 负责跑命令并回报 `cwdAfter`。

---

## 8. 结果怎么回到模型和 UI

Shell 工具使用「双通道」结果（与其它部分工具一致）：

- **给模型**：主要是整理后的 `text`（经 `mapToolResultToToolResultBlockParam`）
- **给 UI**：结构化字段如 `stdout` / `stderr` / `exitCode`，便于界面分区展示

大输出会截断，避免撑爆上下文。

---

## 9. 和「真·交互式终端」对比

| | 交互式 bash | 本仓库 Shell 工具 |
|--|-------------|-------------------|
| 进程 | 一个长期存活的 shell | **每次调用新进程** |
| `cd` 为何还在 | 还在同一个进程里 | 上次 pwd → `cwdRef` → 下次 `spawn({ cwd })` |
| 环境变量 | 你在 shell 里 export 会留下 | 每次按 `prepareShellSpawn` 的 env 重建（可带逻辑 HOME） |
| 变量 / 函数 | 可跨命令保留 | **默认不保留**（新进程；除非写进文件/环境由外层注入） |

若需要「长期跑着的服务」（如 `npm run dev`），应使用 **后台** 模式，而不是指望前台 Bash 一直占着一轮对话。

---

## 10. 相关文档

| 文档 | 内容 |
|------|------|
| [bash-task-system.md](./bash-task-system.md) | 后台 task_id、落盘、通知、TaskOutput / TaskStop |
| [output-file-fd.md](./output-file-fd.md) | 输出接文件 fd（相对 pipe）的设计与为何要用；Windows `'w'` |
| [deploy/README.md](../deploy/README.md) | SSO、逻辑 HOME、沙箱边界（bash 非 OS 隔离） |
| `src/README.md` | `tools/` 目录与工具约定 |

---

## 11. 一句话记住

**Shell 工具 = 按次租用的子进程**：每次调用新起 bash/powershell，用 `cwdRef` + 临时 pwd 文件接上工作目录，用 `env`（含可选逻辑 HOME）配置环境；前台阻塞等结果，后台立刻返回 task 与输出文件。
