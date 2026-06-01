# 07-basic — Multi-Provider LLM、统一 Task 子代理、Web 工具与 Workspace API

在 06-basic（MCP、项目规则、跨平台 shell、多模态输入、统一配置）基础上，重构 LLM 提供层、子代理调度方式，并新增待办、联网搜索/抓取、工具开关与独立 Workspace HTTP 模块。

## 与 06-basic 对比

| 能力 | 06-basic | 07-basic |
|------|----------|----------|
| LLM Provider | 仅 OpenAI 兼容（`@ai-sdk/openai` 直连） | **策略模式**：`openai` / `anthropic` / `openai-compatible`，由 `core/llm/` 统一构建 |
| 配置中的 provider | `name` + `baseURL` + `apiKey` + `model` | 增加 **`provider`** 字段与 **`thinking`**（off / auto / low / medium / high / budget） |
| 推理 / Thinking | 无 | OpenAI Responses `reasoning*`、Anthropic `thinking.type`；消息里保留 `reasoning` part 并在多轮 tool 间回放 |
| 子代理 | 每个子代理一个独立 tool（如 `explore`） | **单一 `task` tool**，通过 `subagent_type` 分发 |
| 内置子代理 | `explore`（只读探索） | `explore` + **`plan`**（只读架构规划）+ **`general_purpose`**（完整工具集执行） |
| Shell 工具 | 跨平台 `bash`（Windows 也走 bash 名） | Unix 注册 **`bash`**，Windows 注册 **`powershell`**（模型只见其一） |
| Shell 实现 | 逻辑在 `bash.ts` | 抽到 **`shell-runner.ts`**，bash/powershell 各 ~50 行包装 |
| 内置工具 | bash, read/write/edit, list_dir | 上述 + **`todo_write`**、**`web_search`**、**`web_fetch`** |
| 工具开关 | 无 | `disabledTools` 配置 + `core/tool-enablement.ts` |
| Agent 实现 | 单文件 `core/agent.ts` | 拆分为 `core/agent/`（流消费、消息清洗、预览流、工具错误格式化） |
| Workspace HTTP | 合并在 `server/router.ts` | 独立模块 **`server/workspace/`**（list / read / write / mkdir / delete） |
| 系统提示词 | 较短，含 explore 子代理说明 | 更完整的 tone / task / tool 规范；按平台区分 bash vs PowerShell 语法 |

## What's New (vs 06-basic)

### 1. 多 Provider LLM 层（`core/llm/`）

06 在 `provider-manager.ts` 里硬编码 `createOpenAI`。07 引入可插拔策略：

```
core/llm/
├── types.ts              # LlmProfile, ThinkingConfig, IProvider
├── resolve.ts            # 从 config.json 解析 / 校验 profile
├── index.ts              # buildProvider(profile)
└── strategies/
    ├── openai.ts         # OpenAI Responses API + reasoningEffort
    ├── anthropic.ts      # Claude extended thinking（adaptive / budget）
    └── openai-compatible.ts  # 任意 OpenAI 兼容网关（忽略 thinking）
```

切换模型只需改配置中的 `provider` 一行，无需改 agent 代码。

### 2. 统一 `task` 子代理调度

06 把 `explore` 注册成与普通 tool 并列的独立工具。07 改为 **单一 `task` tool**：

- 描述里内嵌所有子代理目录（`whenToUse` 段落），便于模型横向对比选型
- 参数 `subagent_type`：`explore` | `plan` | `general_purpose`
- 新增子代理不会增加主 agent 的 tool 数量
- 子代理禁止递归调用 `task`（`disallowedTools`）

| 子代理 | 模式 | 用途 |
|--------|------|------|
| `explore` | 只读 | 快速并行搜索、读文件、结构化汇报 |
| `plan` | 只读 | 探索代码库后输出分步实现计划 + 关键文件列表 |
| `general_purpose` | 读写 + shell + web | 开放式多步任务，继承父级几乎全部工具 |

注册入口：`subagents/index.ts` → `registerBuiltinSubagents()`。

### 3. 新内置工具

| Tool | 说明 |
|------|------|
| `todo_write` | 结构化待办清单；支持 merge 更新；agent 结束时自动将未完成项标为 completed |
| `web_search` | 对接本地 SearXNG（默认 `http://localhost:8888`），返回标题/摘要/链接 |
| `web_fetch` | 抓取 URL，用 `@mozilla/readability` + `linkedom` 提取正文 |
| `powershell` | Windows 专用 shell（与 `bash` 二选一注册，避免模型混用语法） |

共享 HTTP 工具函数：`tools/http-utils.ts`。

### 4. 工具启用 / 禁用

`~/.ai-agent/config.json` 支持：

```json
{
  "disabledTools": ["web_search", "web_fetch"]
}
```

`filterToolsByEnablement()` 在暴露给模型前过滤；`ToolDefinition.enabled === false` 也可关闭单个工具。

### 5. Agent 内部重构

`core/agent.ts` 保留主循环；以下逻辑拆到子模块：

| 模块 | 职责 |
|------|------|
| `stream-consumer.ts` | 消费 AI SDK 流；推理/文本/tool 事件；子代理卡片 UI 标记 |
| `message-sanitize.ts` | tool-result 配对；reasoning part 清洗与 `<thinking>` 内联 |
| `preview-stream.ts` | `edit_file` / `write_file` 参数的流式预览 |
| `tool-errors.ts` | 统一格式化工具错误返回给模型 |

支持 **reasoning 模型** 在多轮 tool call 间保留思维链（通过 `providerOptions` 回放）。

### 6. Workspace HTTP 模块

`server/workspace/` 自包含，主 router 仅组合调用：

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/workspace` | 返回当前 workspace 根路径 |
| `GET` | `/workspace/list?dir=` | 列目录 |
| `GET` | `/workspace/file?path=` | 读文件 |
| `POST` | `/workspace/file` | 创建文件 |
| `PUT` | `/workspace/file` | 保存文件（可选 mtime 校验） |
| `POST` | `/workspace/mkdir` | 创建目录 |
| `DELETE` | `/workspace/entry?path=` | 删除文件或目录 |

路径解析与 FS 操作分别在 `path-safety.ts`、`fs-ops.ts`。

### 7. Shell 与跨平台增强

- `tools/shell-runner.ts`：后台进程跟踪、输出截断、进度事件、超时 kill
- `core/powershell-edition.ts`：检测 Windows PowerShell 版本
- 系统提示词按平台提示：bash 可用 `&&`；PowerShell 5.1+ 需用 `;` 链接

## Architecture Overview

```
07-basic/
├── core/
│   ├── llm/                     # 多 Provider 策略层
│   │   ├── resolve.ts
│   │   ├── index.ts
│   │   └── strategies/
│   ├── agent/                   # Agent 流处理子模块
│   │   ├── stream-consumer.ts
│   │   ├── message-sanitize.ts
│   │   ├── preview-stream.ts
│   │   └── tool-errors.ts
│   ├── agent.ts                 # Agent 主循环
│   ├── tool-enablement.ts       # disabledTools 过滤
│   ├── powershell-edition.ts
│   ├── config-manager.ts        # + disabledTools, LlmProfile
│   ├── provider-manager.ts      # → buildProvider()
│   └── …（同 06：mcp, rules, platform, event-bus, …）
├── tools/
│   ├── bash.ts / powershell.ts  # 薄包装 → shell-runner.ts
│   ├── shell-runner.ts
│   ├── todo_write.ts
│   ├── web_search.ts
│   ├── web_fetch.ts
│   ├── http-utils.ts
│   ├── tool-names.ts
│   └── task.ts                  # 子代理统一入口
├── subagents/
│   ├── index.ts                 # BUILTIN_AGENTS + registerBuiltinSubagents
│   ├── explore.ts
│   ├── plan.ts
│   ├── general_purpose.ts
│   ├── prompt-fragments.ts
│   └── base.ts                  # createAgentDefinition()
├── server/
│   ├── workspace/               # 独立 Workspace HTTP
│   │   ├── router.ts
│   │   ├── fs-ops.ts
│   │   └── path-safety.ts
│   ├── router.ts
│   └── …
└── prompts/system.ts            # 增强版系统提示词
```

## Configuration

配置仍位于 `~/.ai-agent/config.json`，在 06 的 provider / MCP / compaction 基础上扩展。

### Provider（LlmProfile）

```json
{
  "provider": {
    "provider": "anthropic",
    "baseURL": "https://api.anthropic.com/v1",
    "apiKey": "sk-…",
    "model": "claude-sonnet-4-20250514",
    "thinking": { "mode": "auto" }
  }
}
```

`thinking.mode` 可选：`off` | `auto` | `low` | `medium` | `high` | `budget`（budget 需配 `tokens`）。

兼容旧配置：若使用 `"kind": "anthropic"` 会自动映射为 `"provider": "anthropic"`。

### 禁用工具

```json
{
  "disabledTools": ["web_search"]
}
```

### MCP（同 06）

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

### Settings REST API（同 06）

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/settings` | 完整配置（apiKey 脱敏）+ MCP 连接状态 |
| `PATCH` | `/settings/provider` | 更新 provider 任意字段 |
| `PATCH` | `/settings/mcp` | 添加或移除 MCP server |

## Running

### Quick Start (production mode)

```bash
# Build the React UI
cd client/web
npm install
npm run build
cd ../..

# Start the server
npm start -- 07-basic
```

### Development Mode

Terminal 1 — Backend:
```bash
npm start -- 07-basic
```

Terminal 2 — Frontend (with hot reload):
```bash
cd client/web
npm run dev
```

Open http://localhost:5173 (Vite proxies API requests to port 4567).

### 可选：本地 Web 搜索

`web_search` 默认连接 `http://localhost:8888`（SearXNG）。未启动时该工具会报错；可在配置中 `disabledTools` 关闭，或先启动 SearXNG 实例。

## Extending

### 添加新子代理

1. 在 `subagents/` 新建定义文件，使用 `createAgentDefinition()`。
2. 将 `definition` 加入 `subagents/index.ts` 的 `BUILTIN_AGENTS` 数组。

`task` tool 的描述、`subagent_type` 枚举和分发表会自动更新。

### 添加新工具

与 06 相同：在 `tools/` 新建 `my_tool.ts`，在 `tools/index.ts` 注册。

若仅应在子代理中可用，在对应 `AgentDefinition` 的 `disallowedTools` / 继承策略中配置。

### 添加新 LLM Provider

1. 在 `core/llm/strategies/` 实现 `ProviderStrategy`。
2. 在 `core/llm/index.ts` 的 `STRATEGIES` 中注册。
3. 在 `core/llm/types.ts` 的 `ProviderId` 联合类型中加入新 id。

### 添加项目规则（同 06）

在项目根目录创建 `AGENTS.md`，从 git root 到 cwd 向上合并，越近的文件优先级越高。
