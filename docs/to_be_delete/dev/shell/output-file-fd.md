# Shell 输出：文件 fd 设计（相对 Pipe）

> Claude Code 对齐：`stdout`/`stderr` → 同一文件 fd；进程退出后再读文件。  
> **已在本仓库落地**（`src/core/shell/spawn-shell.ts`）。整体工具流见 [tool-execution.md](./tool-execution.md)。

---

## 0. 实现状态

| 路径 | 行为 |
|------|------|
| `runShellCommand`（Worker `exec` / 本机前台） | 默认 **文件 fd**；`usePipeMode: true` 可切回 pipe |
| Worker `exec_bg_start` | 任务 `.output` 文件作 fd（不再 pipe append） |
| `spawnInProcessBackground` | 同上 |
| Windows 打开方式 | `'w'`（MSYS 不丢输出） |
| POSIX 打开方式 | `O_WRONLY \| O_CREAT \| O_APPEND`（+ `O_NOFOLLOW` 若可用） |

API：`openShellOutputHandle` / `openShellOutputFdSync`、`spawnPreparedShell({ outputFd })`、`runShellCommand`。

**测试：**

```bash
npx tsx src/scripts/test-shell-file-fd.ts
```

Windows 需已安装 Git Bash（或设置 `GIT_BASH_PATH`）。覆盖：echo、stdout/stderr 合并、`sleep 999 &` 不挂死、cwd trailer、超时、pipe 对照；Win 上额外跑 PowerShell。

---

## 1. 问题：输出接到哪里？

Shell 工具每次 `spawn` 一个 bash/powershell。子进程的 stdout / stderr 必须交给 Node，最终回到模型和 UI。

常见两种接法：

| 模式 | 做法 |
|------|------|
| **Pipe** | `stdio: ['pipe','pipe','pipe']`，Node 听 `data` 拼字符串 |
| **文件 fd**（默认） | 先打开一个输出文件，把子进程的 stdout/stderr **接到同一个文件描述符**；进程退出后再读文件 |

二者都不使用 PTY；结束信号都是 **shell 进程退出**，不是「猜文件写完了没有」。

文件模式下 stdout/stderr 合入同一流，返回值里 **`stderr` 为空**，内容在 **`stdout`**（与 CC file mode 一致）。

---

## 2. 文件 fd 是什么？

**fd（file descriptor）**：操作系统给「已打开的文件/管道」的整数编号。进程用这个编号读写。

```
磁盘文件:  …/tasks/<id>.output
                ↑
Node 打开后:   fd = 3   ← 只是一个编号
                ↑
spawn 时:      bash 的 stdout=3, stderr=3
               → 打印内容直接写进该文件
```

伪代码：

```ts
const fh = await fs.open(outputPath, process.platform === 'win32' ? 'w' : /* O_APPEND… */)
const child = spawn(bash, args, {
  stdio: ['pipe', fh.fd, fh.fd], // stdin 仍可 pipe；out/err → 同一文件
  windowsHide: true,
})
// 父进程可关掉自己的那份 fd；子进程已有 dup
child.on('exit', async (code) => {
  const text = await fs.readFile(outputPath, 'utf8')
  // 返回给工具层
})
```

跑着的时候若要给 UI 进度，可以 **轮询读文件尾巴**；那只表示「目前写到哪了」，**不表示结束**。结束只看 `exit` / `close`。

---

## 3. 完整时序

```
1. Node 创建/打开输出文件 → 得到 fd
2. spawn(shell)，stdout/stderr = 该 fd
3. 用户命令执行 → 输出写入文件
   （可选）轮询文件尾 → UI 进度
4. shell 进程退出                    ← 结束信号在这里
5. Node 读文件 → stdout 文本 + exitCode
6. 更新 cwd（cwd 临时文件侧信道，与输出文件无关）
7. 清理或保留输出文件（后台 task 常保留供 Read）
```

和「cwd trailer」不要混：

| 文件 | 用途 |
|------|------|
| **输出文件** | 接 stdout/stderr，给模型和 UI |
| **cwd 临时文件** | 命令末尾 `pwd -P` / `Get-Location` 写入，Node 更新 `cwdRef` |

---

## 4. 为什么要用文件 fd？

### 4.1 结束条件更干净（相对 pipe）

Pipe 模式下，Node 常要等管道 `close`。若用户命令拉起了**孙进程**且继承了 stdout（后台 `&`、daemon、部分 CLI helper），这些进程可能一直占着 pipe → 工具调用表现为**卡住或偶发很慢**，即使 bash 自己已经退出。

文件 fd 模式下：输出已经进文件；**以 shell 进程退出为主结束条件**，少被「管道还开着」绑架。

**例子：**

```bash
sleep 999 &
echo done
```

| | Pipe | 文件 fd |
|--|------|---------|
| bash | 很快退出 | 同样很快退出 |
| `sleep` | 可能仍占 stdout pipe | 仍活着，但不拖住「这次工具结束」 |
| 工具结果 | 可能一直等 | bash 一退出即可读到 `done` |

### 4.2 读写分离，和大输出 / 后台任务同构

- 执行中：轮询文件 → 进度  
- 结束后：读文件 → 最终结果  
- 后台 `run_in_background`：本来就要落盘；前台也用文件时，路径与 task 输出模型一致  

Node 不必把整段输出长期堆在 pipe 缓冲回调里。

### 4.3 不是「只有 Windows 才用文件 fd」

**文件 fd 是跨平台的默认策略**（macOS / Linux / Windows  alike）。  
Windows 额外要处理的是：**用什么 flags 打开这个文件**（下一节）。

---

## 5. 为什么 Windows 上要用 `'w'`？

POSIX 上常用 `O_APPEND`：stdout 与 stderr 写同一文件时，每次 append 原子，交错不错乱。

Windows + **Git Bash（MSYS2）** 下，若用 append 类打开方式，libuv 往往只授予 `FILE_APPEND_DATA`，缺少 `FILE_WRITE_DATA`。MSYS 会探测继承来的 handle：没有写数据权限就当成只读 → **输出被静默丢弃**（exit code 仍可能是 0）。

因此 CC 的做法是：

| 平台 | 打开方式 | 原因 |
|------|----------|------|
| POSIX | `O_WRONLY \| O_CREAT \| O_APPEND`（可加 `O_NOFOLLOW`） | append 原子交错 |
| Windows | 字符串 **`'w'`** | 授予完整写权限，Git Bash 才会真写；交错靠内核同步 I/O 保证 |

**例子：** `echo hello` 在 Git Bash 下  

- 文件以 `'a'` 打开再传 fd → 文件可能空，看起来像「命令没输出」  
- 文件以 `'w'` 打开再传 fd → 文件里正常有 `hello`

所以：

- **文件 fd** → 解决 pipe / 孙进程拖死  
- **`'w'`** → 只解决 Windows + Git Bash 的静默丢输出  

二者常一起提，但不是同一件事。

---

## 6. 和本仓库实现对照

| | 本仓库 | Claude Code |
|--|--------|-------------|
| 前台输出 | 默认文件 fd（`runShellCommand`） | 工具默认文件 fd；hooks 可 pipe |
| Windows 打开方式 | `'w'` | `'w'` |
| 结束信号 | shell `close` 后读文件 | 同 |
| 后台任务 | `.output` 直接作 spawn fd | TaskOutput 文件 fd |
| cwd | 临时文件 trailer（不变） | 同思路 |
| pipe 模式 | `usePipeMode: true` | `onStdout` 时 |

相关代码：

- `src/core/shell/spawn-shell.ts` — `openShellOutputHandle`、`runShellCommand`、`spawnPreparedShell`
- `src/tools/shell-runner.ts` — 前台编排
- `src/worker/main.ts` — `exec` / `exec_bg_start`
- `src/utils/ShellCommand.ts` — 无 Worker 后台

CC 参考：`utils/Shell.ts`、`utils/task/TaskOutput.ts`。
---

## 7. 代价与何时仍用 Pipe

| 代价 | 说明 |
|------|------|
| 实现更重 | 建文件、传 fd、退出后读、清理 |
| stdout/stderr 合并 | 同一 fd 时模型侧常看到交织流（可用前缀或分文件若需要） |
| 实时逐字节回调 | pipe + `onStdout` 更直接（CC 在 hooks 等场景仍用 pipe） |

建议策略（与 CC 一致）：

- **工具前台执行**：默认文件 fd  
- **需要实时 stdout 回调**：再开 pipe 模式  

---

## 8. 和 Agent 并发的关系

等 bash 退出是 **异步** 的，不阻塞 Node 事件循环；其它 I/O / 请求仍可进行。

但 **前台** Shell 工具在对话编排上仍会等这条工具结果，才进入下一轮模型推理。若要边跑边干别的，用 `run_in_background`（见 [bash-task-system.md](./bash-task-system.md)）。

文件 fd **不改变**「前台阻塞这一步工具」的产品语义，只改变输出承载与结束可靠性。

---

## 9. 一句话

**文件 fd = 把 shell 的屏幕输出接到一个磁盘文件上；用进程退出当结束铃，再读文件当结果。**  
跨平台为躲 pipe 被孙进程拖死；Windows 上再用 `'w'`，避免 Git Bash 把输出扔掉。

---

## 10. 相关文档

| 文档 | 内容 |
|------|------|
| [tool-execution.md](./tool-execution.md) | Shell 工具整体执行（cwd、Worker、现状 pipe） |
| [bash-task-system.md](./bash-task-system.md) | 后台 task 与输出落盘 |
| Claude Code `utils/Shell.ts` | 文件模式与 Windows `'w'` 注释来源 |
