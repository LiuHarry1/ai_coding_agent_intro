# Coding Agent 教学笔记

逐步构建一个 AI Coding Agent，每节课添加一个关键能力。

---

## Lesson 01 — Agent Loop + Bash Tool

**目录：** `01-basic/`

**核心概念：** Agent 的本质就是一个循环——调用模型、执行工具、把结果喂回去、再调用模型，直到模型不再需要工具。

**关键文件：**

| 文件 | 内容 |
|---|---|
| `agent.js` | Agent Loop：streamText → 收集 tool_calls → 执行 → 追加结果 → 重复 |
| `tools.js` | 唯一工具 `bash`：spawn 子进程、超时处理、输出截断 |
| `prompts.js` | 极简系统提示：角色 + CWD + 两条行为规则 |

**教学要点：**

1. Agent ≠ Chatbot —— Chatbot 调用一次模型，Agent **循环**调用
2. 工具的本质：一个 JSON Schema（告诉模型有什么参数）+ 一个执行函数
3. 只有一个 bash 工具就能完成绝大多数任务 —— 这就是最小可用 Agent

**演示建议：**

```
You > 创建一个 hello.py 打印 hello world，然后运行它
You > 读一下 package.json，告诉我用了什么依赖
You > 写一个 Node.js 脚本计算斐波那契前 20 项，运行并验证
```

**引出下一课：** "bash 能做一切，但模型要为每个操作生成 shell 命令——读文件要写 `cat -n`，搜索要写 `grep -rn`。有没有更好的方式？"

---

## Lesson 02 — 结构化工具（Structured Tools）

**目录：** `02-basic/`

**核心概念：** 为高频操作提供专用工具，让模型用结构化参数替代手写 shell 命令。

### 为什么不只用 bash？

以"读取文件第 50-80 行"为例：

| | bash + cat/sed | read_file |
|---|---|---|
| 模型生成 | `sed -n '50,80p' src/index.js` | `{ "file_path": "src/index.js", "offset": 50, "limit": 30 }` |
| Token 开销 | 需要生成 shell 语法 | 只需 JSON 字段 |
| 可靠性 | 引号/转义/路径空格可能出错 | 参数由框架校验 |
| 错误信息 | stderr 文本，模型要自己解析 | 结构化的 `Error: file not found` |
| 输出格式 | 取决于命令和参数 | 统一的行号格式 `  1│...` |

### read_file 设计决策

```javascript
read_file: tool({
  inputSchema: z.object({
    file_path: z.string(),
    offset: z.number().optional(),   // ← 为什么要 offset/limit？
    limit: z.number().optional(),
  }),
})
```

**三个设计点：**

1. **`offset` / `limit`** —— 大文件不需要全读。10000 行的文件全塞进 context 是浪费 token，模型可以先读前 50 行了解结构，再定向读感兴趣的部分
2. **行号前缀** (`  42│code here`) —— 模型看到行号后可以精确引用位置，配合后续的 write_file/edit 工具会非常有用
3. **复用 `truncate`** —— 和 bash 共享截断逻辑，防止超大文件撑爆上下文

### bash 仍然保留

结构化工具是**补充**不是替代。以下场景 bash 仍然更合适：

- 安装依赖：`npm install express`
- 运行测试：`pytest -v`
- Git 操作：`git diff HEAD~1`
- 启动服务：`python server.py & sleep 2`

**原则：高频文件操作 → 结构化工具，其他一切 → bash**

**演示建议：**

```
# 对比：同一个任务，观察模型行为差异
You > 读一下 package.json 的内容

# 01-basic 的模型会生成：bash cat package.json
# 02-basic 的模型会生成：read_file { "file_path": "package.json" }
```

**引出下一课：** "现在能读了，但写文件还是要用 bash heredoc——加一个 write_file？"

### write_file：各家怎么做的？

生产级 agent 不只有一个"写文件"工具，而是分两个操作：

| 操作 | Claude Code | Cursor | OpenCode |
|---|---|---|---|
| 创建新文件 / 全量覆写 | `create` 命令 | `Write` 工具 | `write` 工具 |
| 局部修改（改几行） | `str_replace`（old→new） | `StrReplace`（old→new） | `edit`（old→new） |

**为什么分开？** 改一个 500 行文件里的 2 行，如果全量重写，模型要重新输出 498 行没变的代码——浪费 token 且容易丢行。

当前课程先实现 `write_file`（全量写入），`edit_file`（局部替换）留到后续课程。

### write_file vs bash heredoc

以"创建一个配置文件"为例：

| | bash heredoc | write_file |
|---|---|---|
| 模型生成 | `cat > src/config.js << 'EOF'\nexport const config = {\n  port: 3000,\n};\nEOF` | `{ "file_path": "src/config.js", "content": "export const config = {\n  port: 3000,\n};\n" }` |
| 目录不存在时 | 需要先 `mkdir -p src/` | 自动创建父目录 |
| 内容含特殊字符 | `EOF`、`$`、反引号都会出问题 | JSON 字符串，无冲突 |
| 反馈信息 | `(no output)` | `Created src/config.js (4 lines)` 或 `Overwrote (38 → 42 lines)` |
| 内容没变时 | 照写一遍，无感知 | 返回 `No changes` |
| 路径安全 | 无限制 | 沙箱：不能写到项目外 |

### write_file 设计决策

**四个设计点：**

1. **区分创建 vs 覆写** —— 返回不同的消息（`Created` vs `Overwrote`），模型知道自己做了什么
2. **自动建目录** —— `mkdirSync(dirname, { recursive: true })`，模型不需要先 `mkdir -p`
3. **内容不变检测** —— 写入内容和现有完全一样时返回 `No changes`，避免无意义操作
4. **description 里引导模型** —— 写了"For small edits, prefer edit_file"，为后续加 edit_file 埋钩子

---

## Lesson 03 — 上下文管理（Context Management）

**目录：** `03-basic/`

**核心概念：** 长对话中 messages 数量不断增长。上下文管理的核心是**在模型需要继续工作时，让它拥有足够的信息，但不把整段历史都塞进去**。

**关键文件：**

| 文件 | 内容 |
|---|---|
| `context.js` | `summarizeIfNeeded()`——当消息过多时压缩为结构化工作状态摘要 |
| `agent.js` | 在 agent loop 里集成（每轮 LLM 调用前检查） |
| `session.js` | Session 持久化——多轮对话基础 |
| `prompts.js` | 系统提示增加对摘要上下文的说明 |

**引出问题：** 02-basic 的 agent 每次 `/chat` 是新对话。如果我们加了 session 让它支持多轮，跑 20+ 步后 messages 数组就有 40+ 条消息——大量旧的 tool_call 和 tool_result 堆积在上下文里。

### 常见误区：逐个截断工具输出（Truncation）

最直觉的方案是截断旧的工具输出——保留最近 N 个，旧的替换成 `[truncated: 4827 chars]`。

**但这在实践中问题很大：**

| 被截断的工具 | 实际效果 |
|---|---|
| `read_file` | 模型忘了文件内容 → 只好重新 `read_file`。但原文件还在，直接重读就好，**截断毫无意义** |
| `bash` | 模型忘了命令输出 → 大多数命令（`ls`, `grep`）重跑也就几毫秒，成本极低 |
| `write_file` / `edit_file` | 返回值本身就短（`"Created file.js (42 lines)"`），不需要截断 |

**核心洞察：** 截断的前提是"数据丢了模型拿不回来"。但 coding agent 的工具输出天然是**可重新获取的**——文件可以重读，命令可以重跑。所以逐个截断工具输出不如直接解决根本问题：**消息数量太多。**

### 各家怎么做的？

| 策略 | 做法 | 谁在用 |
|---|---|---|
| 长输出写成文件 | 工具输出超过阈值 → 写到磁盘 → 上下文只留引用路径 | Cursor |
| 工具输出存磁盘 + hot tail | 旧工具输出存磁盘，最近几个保留在上下文 | Claude Code（microcompaction） |
| LLM 摘要（compaction） | 用便宜模型把旧消息压缩为结构化摘要 | Claude Code、OpenCode |
| RL 训练自我摘要 | 模型自己学会在上下文快满时保留关键信息 | Cursor（Composer） |

Cursor 的做法最简单：长工具输出直接写文件，不做截断。但上下文最终还是会满——这时所有人都得做 **summarization**。

### 我们的方案：Summarization

**不做 truncation，只做 summarization。** 当 `messages.length >= 16` 时：

```
之前（40+ 条 messages）：
  [user] 创建 todo app...
  [assistant] [tool-call: read_file]
  [tool] package.json 内容...
  [assistant] [tool-call: write_file]
  [tool] Created server.js
  ... (30+ 条更多) ...

之后（2 + 最近 4 条）：
  [user/summary]
    ## Task
    创建 todo app with Express + tests.
    ## Completed Work
    - Created src/server.js — Express CRUD for /api/todos
    - Created tests/api.test.js — 4 tests, all passing
    ## Current State
    npm test: 4/4 passing
    ## Key Files
    - src/server.js — Express app, port 3000
    - tests/api.test.js — supertest-based tests

  [assistant] 理解了，继续。

  [最近 4 条原始消息]
```

### 关键设计决策

**1. 总结"工作状态"而不是"对话历史"**

差的摘要（对话流水账）：
```
"用户要求创建 todo app。先读了 package.json，然后创建了 server.js，
然后跑 npm test 失败了，然后装了 express，再跑测试通过了..."
```

好的摘要（工作状态快照）：
```
## Task: 创建 todo app
## Completed: server.js (CRUD), tests (4/4 pass)
## Key Files: src/server.js, tests/api.test.js
```

模型不需要知道"之前失败过然后修好了"——它需要知道**现在是什么状态**。

**2. 用便宜模型做摘要**

Summarization 不需要写代码，只需要理解和压缩。用 `gpt-4o-mini` 而不是主模型，既快又省钱。

**3. 给 summarizer 的输入也要截断**

发给 summarizer 的工具输出限制在 500 字符。summarizer 只需知道"创建了 server.js，85 行"，不需要看完整文件内容。

**4. 摘要后模型可以自行重读文件**

系统提示告诉模型："如果看到 summary，可以用 read_file 重新读取任何需要的文件。" 模型自己会判断是否需要重读。

### 代码集成

```javascript
// agent.js 的 loop 里，在 streamText 之前
const managed = await summarizeIfNeeded(messages, sendSSE);
if (managed !== messages) {
  messages.length = 0;
  messages.push(...managed);
}
```

`summarizeIfNeeded` 在消息数低于阈值时直接返回原数组（引用相同），不做任何工作。

### 演示建议

```
# 给 agent 一个多步任务，触发 summarization
You > 创建一个 Node.js 项目，包含 express 服务器、3 个 CRUD 路由、
      用 Jest 写单元测试，然后运行测试

# 在 SSE 事件中观察：
# - step 8+ 时看到 compaction_start 事件
# - 之后 messages 数量骤降
# - 模型继续工作，可能会 read_file 重读关键文件
```

**教学要点：**

1. **上下文的核心问题是消息数量累积，不是单个输出太大** —— 单个输出已经被 `utils.js` 的 `truncate()` 限制在 30KB
2. **Coding agent 的工具输出天然可重新获取** —— 文件可以重读，命令可以重跑。逐个截断工具输出意义不大
3. **Summarization 是所有生产级 agent 的共同选择** —— Claude Code、Cursor、OpenCode 都做 compaction
4. **Summary 的质量取决于 prompt** —— 结构化的"工作状态"比流水账式的"对话总结"好得多

**引出下一课：** "现在单个 agent 能跑长任务了。但有些操作（比如探索代码库）会产生大量中间输出、占用主 agent 的上下文——能不能把它们分到独立的 agent 里？"

---

## Lesson 04 — Subagents

**目录：** `04-basic/`

> TODO: 补充教学笔记。核心内容：
>
> - Subagent 的粒度应该是"任务"而非"工具"
> - Bash subagent（当前实现）的问题：每个 shell 命令多一次 LLM 调用，且主 agent 经常要读回完整输出
> - 更好的例子：Explore subagent（探索代码库，多步搜索 + 分析，返回结构化报告）
> - Subagent 设计三原则：任务完整性、结果自足性、上下文收益

---

## Lesson 05 — 安全护栏（Guardrails）

> TODO: 危险命令拦截、human-in-the-loop 确认、沙箱

---

## Lesson 06 — 多步规划（Planning）

> TODO: Plan → Execute 两阶段、任务拆解

---

## 工具设计原则（贯穿所有课程）

给学生的总结：

1. **原子化** —— 每个工具做一件事，做好它
2. **参数有 description** —— 这就是工具的"使用说明书"，模型靠它决定传什么参数
3. **返回值清晰** —— 成功返回数据，失败返回 `Error: ...` 开头的字符串
4. **防御性设计** —— 检查文件存在、区分文件/目录、截断超大输出
5. **不要重复** —— 如果 bash 能很好地完成，就不需要专门的工具
