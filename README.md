# AI Coding Agent 示例

从零开始构建 AI Coding Agent，从单文件到前后端分离架构。使用 OpenAI 兼容接口，无需 API Key。

## 前置准备

```bash
npm install
```

确保 copilot-proxy 已在 `http://localhost:4141` 运行。

---

## 阶段 1：手写版 — 理解原理

`01-raw-openai.js` 是自包含的单文件 Agent，没有框架，所有逻辑透明可见。

**核心概念：**
- Tool calling：用 JSON Schema 告诉 LLM 有哪些工具
- Agent loop：while 循环 + 手动管理 messages 数组
- 工具执行：switch/case 分发

**适合场景：** 内部技术分享、新人培训、对 Agent 零基础的听众

```bash
node 01-raw-openai.js
```

**演示建议：**

```
# 1. 单工具调用
You > 帮我看一下当前目录有什么文件

# 2. 多步任务 — Agent Loop 多轮
You > 创建一个 hello.py，内容是打印 hello world，然后运行它

# 3. LLM 推理 + 工具配合
You > 读一下 package.json，告诉我这个项目用了什么技术栈

# 4. 出错处理
You > 读一下 not_exist.txt 的内容

# 5. 写代码 → 运行 → 修复
You > 写一个 Node.js 脚本计算 1 到 100 的和，保存为 sum.js 并运行
```

**教学引导：** "这个 while 循环和 switch/case 每次都写，能不能更简洁？" → 引出阶段 2

---

## 阶段 2-3：单文件版（耦合版，历史参考）

这些文件将 Agent 逻辑和 UI 写在同一个文件里，作为历史参考保留：

| 文件 | 说明 |
|---|---|
| `02-ai-sdk-basic.js` | AI SDK + console 输出 |
| `02-ai-sdk-ink.js` | AI SDK + Ink UI |
| `03-refactor-agent.js` | 实战 refactor + console |
| `03-refactor-ink.js` | 实战 refactor + Ink UI |

---

## 阶段 4：前后端分离（Client-Server 架构）

将 Agent 核心逻辑（后端）和 UI（前端）拆分为独立进程，通过 WebSocket 通信。

### 架构

```
┌─────────────────────┐        WebSocket        ┌──────────────────────┐
│   Client (UI)       │◄──── JSON 事件流 ───────►│   Server (Agent)     │
│                     │                          │                      │
│  console.js (chalk) │   { type: "thinking" }   │  core/provider.js    │
│  ink.js     (React) │   { type: "tool_call" }  │  core/tools.js       │
│                     │   { type: "response" }   │  core/agent.js       │
│  lib/connection.js  │                          │  core/prompts.js     │
└─────────────────────┘                          └──────────────────────┘
```

### 启动方式

```bash
# 终端 1：启动 Agent 服务
node server/index.js

# 终端 2：启动 UI 客户端（选一个）
node client/console.js                            # basic 模式，console UI
node client/ink.js                                # basic 模式，Ink UI
node client/console.js --project /path/to/proj    # refactor 模式
node client/ink.js --project /path/to/proj        # refactor 模式 + Ink
```

### 通信协议

**Client -> Server：**

```json
{ "type": "chat", "message": "读一下 package.json" }
{ "type": "config", "mode": "refactor", "projectDir": "/path" }
```

**Server -> Client（事件流）：**

```json
{ "type": "thinking" }
{ "type": "tool_call", "name": "read_file", "args": { "path": "src/index.js" } }
{ "type": "tool_result", "name": "read_file", "result": "..." }
{ "type": "response", "text": "这是一个...", "stepCount": 3 }
{ "type": "error", "message": "..." }
```

### Server 目录

| 文件 | 说明 |
|---|---|
| `server/index.js` | WebSocket 服务入口（端口 4567） |
| `server/core/provider.js` | LLM Provider 配置 |
| `server/core/tools.js` | 工具定义工厂：`createBasicTools(cwd)` / `createRefactorTools(projectDir)` |
| `server/core/agent.js` | Agent 执行器：`runAgent(message, { tools, systemPrompt, onEvent })` |
| `server/core/prompts.js` | System Prompt 模板 |

### Client 目录

| 文件 | 说明 |
|---|---|
| `client/console.js` | Console UI 客户端（chalk + ora） |
| `client/ink.js` | Ink UI 客户端（React for CLI） |
| `client/lib/connection.js` | WebSocket 连接封装 |
| `client/ui/display.js` | Console 显示函数 |
| `client/ui/components.js` | Ink 组件（Welcome, StepView, AgentResponse 等） |

### 演示建议

```
# basic 模式
You > 读一下 package.json，告诉我装了哪些依赖
You > 创建一个 fibonacci.js，打印前 10 项，然后运行它

# refactor 模式（需要 --project 参数）
You > 看一下项目结构，给我一个概览
You > 找到所有 console.log
You > review 一下 src/ 目录的代码，指出潜在问题
You > 把所有 console.log 替换成一个统一的 logger
```

### 教学引导

这个重构本身就是一个教学点：
- **为什么要前后端分离？** 复用 Agent 逻辑、可替换 UI、可独立测试
- **为什么用 WebSocket？** Agent 场景需要实时事件流（thinking → tool_call → result → response）
- **工厂模式的价值？** 同一套工具定义，传入不同的 `projectDir` 就能操作不同项目

---

## 完整文件结构

```
├── 01-raw-openai.js              # 阶段 1：手写版（自包含）
├── 02-ai-sdk-basic.js            # 阶段 2：耦合版（历史参考）
├── 02-ai-sdk-ink.js
├── 03-refactor-agent.js          # 阶段 3：耦合版（历史参考）
├── 03-refactor-ink.js
├── display.js                    # 旧 console UI（01 使用）
├── ui/components.js              # 旧 Ink 组件（耦合版使用）
├── server/                       # 阶段 4：Agent 后端
│   ├── index.js
│   └── core/
│       ├── provider.js
│       ├── tools.js
│       ├── agent.js
│       └── prompts.js
└── client/                       # 阶段 4：UI 前端
    ├── console.js
    ├── ink.js
    ├── lib/
    │   └── connection.js
    └── ui/
        ├── display.js
        └── components.js
```
