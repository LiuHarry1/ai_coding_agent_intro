# 03-basic-chat-history

在 02-basic 基础上新增 **多轮对话** 和 **上下文管理**。

## 和 02-basic 对比：新增了什么？

```
02-basic/                          03-basic/
  agent.js                           agent.js           ← 改了 1 行
  tools.js                           tools.js           ← 复用 02-basic
  prompts.js                         prompts.js         ← 加了 1 条规则
                                     context.js         ← 新：上下文管理
                                     session.js         ← 新：会话持久化
                                     server.js          ← 新：带 session 的 HTTP 服务
```

## 解决两个问题

### 问题 1：用户发第二条消息时，agent 忘了之前说过什么

02-basic 每次请求都创建全新的 `messages = []`。用户说"创建 hello.py"然后说"运行它"，agent 不知道"它"是什么。

**解决：session.js + server.js**

```
用户第 1 条消息                       用户第 2 条消息
POST /chat { message: "创建 hello.py" }    POST /chat { message: "运行它", session_id: "abc" }
        │                                          │
        ▼                                          ▼
  创建新 session                             找到已有 session
  messages = []                              messages = [之前的历史...]
        │                                          │
        ▼                                          ▼
  runAgent(msg, { messages })                runAgent(msg, { messages })
        │                                          │
        ▼                                          ▼
  agent 完成，消息写入 JSONL                  agent 看到历史，知道"它"= hello.py
```

### 问题 2：agent loop 内调用十几次工具，上下文快速膨胀

工具输出（bash 返回的 200 行日志、read_file 读的整个文件）占了上下文 80% 以上的空间。不管理的话，几轮就满了。

**解决：context.js — 两层管理**

```
每轮 agent loop 开始前：

  ┌─ truncateToolOutputs() ──────────────────────────────┐
  │  便宜（字符串替换），每轮都跑                           │
  │                                                      │
  │  保留最近 4 次工具输出（hot tail）                      │
  │  旧的替换为: [truncated: 4827 chars from bash]        │
  └──────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌─ summarizeIfNeeded() ────────────────────────────────┐
  │  贵（调 LLM），仅当消息数 > 20 时触发                   │
  │                                                      │
  │  用便宜模型把旧消息压缩成结构化摘要                      │
  │  保留最近 6 条消息不压缩                                │
  └──────────────────────────────────────────────────────┘
                          │
                          ▼
                  streamText(messages)
```

## 新增文件说明

### context.js — 上下文管理

| 函数 | 做什么 | 为什么需要 |
|---|---|---|
| `truncateToolOutputs()` | 把旧工具输出替换为一行摘要 | 工具输出是最大的 token 消耗者 |
| `summarizeIfNeeded()` | 用 LLM 把旧消息压缩成摘要 | 消息数过多时整体瘦身 |

### session.js — 会话持久化

| 函数 | 做什么 | 为什么需要 |
|---|---|---|
| `createSession()` | 创建新会话，生成 UUID | 每个对话需要唯一标识 |
| `getSession(id)` | 获取会话（内存或从磁盘恢复） | 多轮对话需要找回历史 |
| `listSessions()` | 列出所有会话 | 让用户能恢复之前的对话 |
| `appendMessage()` | 追加消息到 JSONL 文件 | 进程重启后不丢历史 |

存储方式和 Claude Code 一样：每个 session 一个 `.jsonl` 文件，每行一条消息，append-only。

### server.js — 带 session 的 HTTP 服务

和 `shared/server.js` 相比新增的接口：

| 接口 | 用途 |
|---|---|
| `POST /sessions` | 创建新会话 |
| `GET /sessions` | 列出所有会话 |
| `POST /chat` 新增 `session_id` 参数 | 带上则续接对话，不带则自动创建 |

### agent.js — 仅改了 1 行

```diff
- export async function runAgent(userMessage, { tools, systemPrompt, sendSSE, maxSteps = 40 }) {
-   const messages = [{ role: "user", content: userMessage }];
+ export async function runAgent(userMessage, { tools, systemPrompt, sendSSE, messages = [], maxSteps = 40 }) {
+   messages.push({ role: "user", content: userMessage });
```

从"自己创建 messages"变成"接收外部 messages 并追加"。就这一行改动，agent 就从无状态变成了有状态。

## 启动

```bash
node start.js 03-basic-chat-history
```
