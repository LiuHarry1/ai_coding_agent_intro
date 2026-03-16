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

**目录：** `03-basic-chat-history/`

**核心概念：** Context window 是 agent 最稀缺的资源。工具输出占 80%+ 的上下文空间——不管理它，几轮对话就满了。

**关键文件：**

| 文件 | 内容 |
|---|---|
| `context.js` | 两个上下文管理函数：truncateToolOutputs + summarizeIfNeeded |
| `agent.js` | 在 agent loop 里集成上下文管理（每轮 LLM 调用前执行） |
| `tools.js` | 复用 02-basic 的工具 |
| `prompts.js` | 系统提示增加 "[truncated]" 提示 |

### 各家怎么做的？

| 策略 | 复杂度 | 谁在用 |
|---|---|---|
| 截断旧消息 | 最低 | 基础实现 |
| 工具输出裁剪（microcompaction） | 低 | Claude Code、OpenCode |
| LLM 摘要（compaction） | 中 | Claude Code、Aider、OpenCode |
| 结构化压缩 + 文件恢复（rehydration） | 高 | Claude Code |
| 按需拉取（不存上下文，需要时搜） | 高 | Cursor |

### Feature 1：工具输出截断（Microcompaction）

**问题：** Agent 跑 10 次 bash，每次返回几百行。全部留在上下文里，很快就满了。

**做法：** 保留最近 N 次工具输出（"hot tail"），旧的替换成一行摘要。

```
之前（占上下文）：
[tool:bash] src/auth.js:42: // TODO: add rate limiting
             src/db.js:18: // TODO: add connection pooling
             ... (200 行)

之后（1 行）：
[tool:bash] [truncated: 4827 chars from bash]
```

**类比：** 这就是 LRU 缓存——最近的保留，旧的换出。

**模型能"重新获取"吗？** 能。模型看到 `[truncated]` 后，如果需要那个信息，可以再跑一次命令。系统提示里也告诉了它这一点。

**关键参数：**

| 参数 | 含义 | 默认值 |
|---|---|---|
| `HOT_TAIL` | 保留最近几次工具输出 | 4 |
| `MAX_TOOL_OUTPUT_CHARS` | 低于此长度的输出不截断 | 200 |

### Feature 2：对话摘要（Compaction）

**问题：** 即使截断了工具输出，消息数也会越来越多（assistant 的思考、多轮 tool_call/tool_result 对）。

**做法：** 当消息数超过阈值，用一个便宜的模型把旧消息压缩成结构化摘要。

```
之前：20+ 条消息

之后：
  [summary message]    ← 压缩后的工作状态
  [assistant ack]      ← "我理解了，继续"
  [最近 6 条消息]      ← 保留完整细节
```

**摘要 prompt 要求包含：** 用户意图、已完成的工作、当前状态、关键决策、遇到的错误。这不是"随便总结一下"，而是有结构化要求的，确保压缩后模型能继续工作。

**关键参数：**

| 参数 | 含义 | 默认值 |
|---|---|---|
| `SUMMARIZE_THRESHOLD` | 消息数超过此值触发摘要 | 20 |
| `KEEP_RECENT` | 保留最近几条消息不压缩 | 6 |

### 两个 feature 的关系

```
每轮 loop:
  1. truncateToolOutputs()    ← 便宜，每轮都跑
  2. summarizeIfNeeded()      ← 贵（调 LLM），偶尔触发
  3. streamText(messages)     ← 正常调用模型
```

截断是"治标"（减小单条消息体积），摘要是"治本"（减少消息数量）。两者配合使用。

**演示建议：**

```
# 给 agent 一个多步任务，观察上下文管理
You > 创建一个 Node.js 项目，包含 express 服务器、3 个路由、单元测试，然后运行测试

# 在日志中观察：
# - step 5+ 时开始看到 [truncated] 的工具输出
# - step 10+ 时可能触发摘要
```

**教学要点：**

1. Token 是最稀缺的资源——比 CPU、内存都贵
2. 工具输出是最大的 token 消耗者（81%），优先处理
3. 用 AI 管理 AI 的记忆——摘要本身也是一次 LLM 调用
4. 所有策略都是信息和空间的 trade-off——没有完美方案

---

## Lesson 04 — edit_file + list_directory + search

> TODO: 补充 edit_file（str_replace 模式）、list_directory、search 工具的实现和教学笔记

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
