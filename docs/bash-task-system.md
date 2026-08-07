# 后台 Shell Task 系统

> 本仓库「后台 shell 任务」：对齐 Claude Code 的 `LocalShellTask` + `TaskOutput` + `TaskStop`。  
> UI 上对应 Cursor Composer 的 background terminals / await 卡片，**工具名与协议仍是 CC 风格**（没有 `AwaitShell`）。

---

## 1. 是什么

把长驻 / 慢 shell 从「堵死一次 Bash」拆成：

1. `Bash|PowerShell(run_in_background: true)` → **立刻**返回稳定 `task_id` + 输出文件路径  
2. 进程继续跑，stdout/stderr **追加**到 `.sessions/{sessionId}/tasks/{taskId}.output`  
3. 自然结束 → 注入 `<task-notification>`（若尚未 `notified`）  
4. 模型用 **Read(输出文件)** / `TaskOutput` / `TaskStop` 跟进  

```
Bash(run_in_background: true)
  → spawnShellTask → registerTask(running)
  → Worker exec_bg_start  或  同进程 ShellCommand
  → 工具结果：ID + output path（不阻塞）
  → watchUntilDone(~400ms poll) → completed|failed|killed
  → enqueueShellNotification → getAttachments → <task-notification>
```

这不是 TodoWrite，也不是 Agent 子代理；**专指后台 shell 进程**。

---

## 2. 为什么需要

| 问题 | 做法 |
|------|------|
| 长驻命令卡死一轮 tool call | `run_in_background` 立刻返回 |
| OS PID 复用、跨会话不稳 | 逻辑 `task_id`（`local_bash` → `b` + 8 位） |
| 大日志撑爆上下文 | 落盘；给模型看时截断（默认约 32k，`TASK_MAX_OUTPUT_LENGTH`） |
| 查 / 停和「跑」混在一个工具 | `TaskOutput` / `TaskStop` 独立；**优先 Read 输出文件** |
| 模型不知道何时结束 | `<task-notification>` 走步间 attachments |
| Chat 必须进 Worker | `exec_bg_start` / `poll` / `kill`；无 Worker 时同进程路径 |

**已删除：** 旧 `background` / `pid` / `kill` 挤在 Bash 上的 API。

**刻意不做：** 沙盒开关、Ctrl+B 前台转后台、超时自动 background、Stall watchdog。

---

## 3. 模型侧 API

### 3.1 Bash / PowerShell

| 字段 | 含义 |
|------|------|
| `command` | 必填 |
| `description` | 可选；UI / 通知文案 |
| `timeout` | 前台默认 `120000` ms；**后台忽略** |
| `run_in_background` | `true` → 立刻返回 |
| `stdin` | 后台模式**不支持** |

工具结果文案（与代码一致）：

```text
Command running in background with ID: b3k9m2x1a. Output is being written to: …/.sessions/<session>/tasks/b3k9m2x1a.output
```

结构化字段：`backgroundTaskId`、`backgrounded: true`。

Prompt 约定（摘要）：

- 不需要立刻结果时才 background；**不要**在命令末尾加 `&`
- 完成后会有 `<task-notification>` → **不要轮询**
- 优先 **Read** 结果 / 通知里的 output-file（session 路径允许在 cwd 外）
- 长驻进程（dev server）：可 `TaskOutput(block: false)` 看一眼启动日志，**禁止** `block: true`；用户要停再用 `TaskStop`
- Ask / Plan 模式：Bash、PowerShell、TaskOutput、TaskStop 均不可用

### 3.2 TaskOutput（次选；文档标 DEPRECATED）

| 字段 | 默认 | 含义 |
|------|------|------|
| `task_id` | — | 后台任务 ID |
| `block` | `true`（`block !== false`） | 等到终态 |
| `timeout` | `30000`（最大 600000） | block 最长等待 |

- `block: false` → 非阻塞 peek（`retrieval_status: not_ready` 若仍在跑）
- 成功读到终态 → `markTaskNotified`，**抑制**后续 `<task-notification>` 重复
- 返回里带 `<retrieval_status>` / `<task_id>` / `<status>` / `<output>`

### 3.3 TaskStop

| 字段 | 含义 |
|------|------|
| `task_id` | 要停的任务 |
| `shell_id` | 兼容别名（等同 `task_id`） |

Kill 后 `status=killed` 且 **`notified: true`** → **不再**入队完成通知；以工具结果为准。

### 3.4 `<task-notification>`

```xml
<task-notification>
<task-id>b3k9m2x1a</task-id>
<output-file>/path/to/.sessions/sess/tasks/b3k9m2x1a.output</output-file>
<status>completed</status>
<summary>Background command "npm run dev" completed (exit code 0)</summary>
</task-notification>
```

`status`：`completed` | `failed` | `killed`（自然退出路径；TaskStop 主动杀通常不出这条）。

---

## 4. 运行时两条路径

| 场景 | 行为 |
|------|------|
| **Chat（有 `context.execution`）** | `spawnShellTask` → Worker `exec_bg_*`；输出写到约定 `outputPath` |
| **测试 / 无 Worker** | `utils/ShellCommand.ts` 同进程 spawn，同一套 registry / disk / 通知 |

共用：`task_id`、`framework` registry、`diskOutput`、TaskOutput / TaskStop、attachments。

控制面：`watchUntilDone` 约 **400ms** poll；TaskOutput block 约 **100ms** poll。

落盘：

- 目录：`.sessions/{sessionId}/tasks/`
- 文件：`{taskId}.output`（追加；磁盘硬顶约 5GB）
- `setTaskSessionId` 后再解析路径；`isReadableInternalPath` 允许 Read 会话内文件

---

## 5. 代码地图

```
src/
  Task.ts                          # generateTaskId / TaskStatus / Task 接口
  tasks.ts                         # getTaskByType → LocalShellTask
  tasks/
    stopTask.ts                    # TaskStop / HTTP stop 入口
    LocalShellTask/
      LocalShellTask.ts            # spawnShellTask + watchUntilDone + 通知
      guards.ts
      killShellTasks.ts            # killTask（设 notified）
  utils/
    ShellCommand.ts                # 无 Worker 同进程后台
    task/
      framework.ts                 # register / get / update / list / markNotified
      pendingNotifications.ts
      diskOutput.ts                # 路径与读写
      outputFormatting.ts          # 截断给模型
      TaskOutput.ts                # 薄封装（当前工具路径未用）
  tools/
    BashTool/  PowerShellTool/     # run_in_background（prompt 含用法）
    shell-runner.ts                # 共享执行 + 后台分支
    TaskOutputTool/
    TaskStopTool/
  execution/
    runtime-protocol.ts            # exec_bg_*
    worker-execution-backend.ts
  worker/main.ts                   # Worker 侧进程表 + 写文件
  server/router.ts                 # GET/POST …/tasks
  core/session-paths.ts            # .sessions + ReadableInternalPath

client/web/src/components/
  BackgroundTerminals.jsx          # 输入框上方「N background terminals」
  BashCard.jsx                     # 后台结果紧凑行
  TaskOutputCard.jsx               # Waiting / Waited
  TaskStopCard.jsx                 # Stopping / Stopped
```

| 本仓库 | Claude Code |
|--------|-------------|
| `Task.ts` / `utils/task/*` / `tasks/LocalShellTask/*` | 同名（CC 多为 `.tsx`） |
| `TaskOutputTool` / `TaskStopTool` | 同名 |
| BackgroundTerminals UI | ≈ Cursor Composer footer（非 CC 工具名） |

---

## 6. HTTP / Web UI

供前端面板，**不是**模型工具：

| 接口 | 作用 |
|------|------|
| `GET /sessions/:id/tasks` | 列表：id、type、status、description、起止时间、outputFile、command |
| `POST /sessions/:id/tasks/:taskId/stop` | 停任务（走 `stopTask`） |

**BackgroundTerminals**

- 只展示 `running` / `pending`
- 在 `isStreaming` **或** 仍有 running 任务时每 **1.5s** 刷新（避免中途 background 要等流结束才出现）
- Stop → 上述 POST

Transcript 卡片：后台 Bash 不展开 live terminal；TaskOutput / TaskStop 为独立行。

---

## 7. 和子代理的区别

| | 后台 Shell Task | Agent 子代理 |
|--|-----------------|--------------|
| 跑什么 | 长驻 **shell** | 另一路 **LLM 循环** |
| 句柄 | `task_id`（`b…`） | tool_use / 子会话 |
| 工具 | Bash + Read/TaskOutput + TaskStop | Agent 等 |

不要把 `task_id` 当成子代理 ID。

---

## 8. 推荐用法

**会结束的后台命令：**

```json
{ "command": "sleep 2 && echo done", "run_in_background": true, "description": "short sleep" }
```

完成后等 `<task-notification>`，再 **Read** `output-file`。若要主动等：

```json
{ "task_id": "b……", "block": true, "timeout": 10000 }
```
（TaskOutput；能 Read 则不必）

**长驻再停：**

```json
{ "command": "npm run dev", "run_in_background": true, "description": "dev server" }
```

```json
{ "task_id": "b……", "block": false }
```
（可选 peek）

```json
{ "task_id": "b……" }
```
（TaskStop，用户要求停时）

本地单测（无 LLM）：

```bash
npx tsx src/scripts/test-bash-tasks.ts
npx tsx src/scripts/test-bash-tasks-live.ts   # 需后端在跑
```

---

## 9. 设计取舍

| 选择 | 原因 |
|------|------|
| `task_id` 而非 PID | 稳定、可落盘、可通知、可跨工具引用 |
| 查停拆工具 + 优先 Read | 与 CC 一致；大日志不进上下文 |
| 完成通知走 attachments | 不改 agent 主循环 |
| TaskStop 设 `notified` | 避免「已 Stop」再刷一条 completion XML |
| 仅显式 `run_in_background` | 主路径清晰；自动转后台留以后 |

---

## 10. 相关文档

- LLM 标签（含 `task-notification`）：[`docs/cc_docs/llm-prompt-xml-tags.md`](./cc_docs/llm-prompt-xml-tags.md)
- HTML 版：[`docs/bash-task-system.html`](./bash-task-system.html)
