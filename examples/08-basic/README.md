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

06 在旧版里硬编码 `createOpenAI`。07 引入可插拔策略：

```
core/llm/
├── types.ts              # LlmProfile, ThinkingConfig, IProvider
├── resolve.ts            # 从 settings.json 解析 / 校验 profile
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
| `web_search` | 默认 **Exa MCP**（`WEB_SEARCH_PROVIDER=exa`）；可切换 SearXNG（`SEARXNG_URL`，默认 `http://localhost:8888`） |
| `web_fetch` | 抓取 URL，用 `@mozilla/readability` + `linkedom` 提取正文 |
| `powershell` | Windows 专用 shell（与 `bash` 二选一注册，避免模型混用语法） |

共享 HTTP 工具函数：`tools/http-utils.ts`。

### 4. 工具启用 / 禁用

`~/.ai-agent/settings.json` 和 `<project>/.ai-agent/settings.json` 支持：

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
│   ├── settings-manager.ts      # layered settings (user/project/local)
│   ├── llm/                     # buildProvider() + strategies
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

配置位于 `~/.ai-agent/settings.json`（用户级）和 `<project>/.ai-agent/settings.json`（项目级），项目级优先级更高；`settings.local.json` 可作为项目本地私有覆盖。

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

`web_search` 默认走 **Exa MCP**（`.env` 中 `WEB_SEARCH_PROVIDER=exa`，可选 `EXA_API_KEY`）。切换 SearXNG 时设 `WEB_SEARCH_PROVIDER=searxng` 并启动本地实例（默认 `http://localhost:8888`）；未启动 SearXNG 时该模式会报错。

## Extending

### 添加新子代理

#### 方式 A：内置（代码注册）

1. 在 `subagents/` 新建定义文件，使用 `createAgentDefinition()`。
2. 将 `definition` 加入 `subagents/index.ts` 的 `BUILTIN_AGENTS` 数组。

`task` tool 的描述、`subagent_type` 枚举和分发表会自动更新。

#### 方式 B：Markdown + YAML frontmatter

在以下任一目录放 `<name>.md`，每次 chat 请求会重新扫描（编辑文件无需重启）：

| 优先级 | 目录 | 备注 |
|--------|------|------|
| 低 | `~/.ai-agent/agents/*.md` | 用户级（与 `settings.json` 同目录） |
| 高 | `<ancestor>/.ai-agent/agents/*.md` | 项目级，沿 `cwd` 向上；最深覆盖浅层、用户级、内置 |

文件格式：

```markdown
---
name: code-reviewer
description: Reviews staged diffs for bugs / style / missing tests. Use proactively after the user finishes a feature branch.
label: Reviewer
tools: read_file, grep, glob, bash     # 省略 = 继承全部；'*' 同义；可写成 YAML list
maxSteps: 25
model: openai/gpt-5                    # 可选 model 覆盖
omitProjectRules: true                 # 跳过 AGENTS.md / CLAUDE.md 注入
---

You are a senior code reviewer. Read the staged diff (`git diff --staged`),
then produce a concise review covering: bugs, missing tests, style drift
from project conventions, and risky edge cases.

Output format:
### Blockers
### Suggestions
### Nits
```

字段对应 `AgentDefinition`（见 `core/types.ts`）：
- `name` → `agentType`（必填，模型用作 `subagent_type` 值）
- `description` → `whenToUse`（必填，渲染到 `task` 工具描述）
- 正文 → `systemPrompt`（必填，空 body 会被拒绝）
- `tools` 与 `disallowedTools` 互斥；都不写时默认禁用 `task` + `ask_user_question`（防递归 / 防阻塞）；写了 allow-list 时也强制剔除 `task`

实现入口：`subagents/from-files.ts` → `parseAgentFromMarkdown` / `mergeAgents`；async 注册器 `subagents/index.ts` → `registerSubagents(registry, cwd)` 由 `server/router.ts` 每次 chat 请求调用。

### 添加 Slash Commands（与 Skills 合并）

把 `<name>.md` 放到 `<cwd>/.ai-agent/commands/` 或 `~/.ai-agent/commands/`，**skills** 放到 `<cwd>/.ai-agent/skills/<name>/SKILL.md` — 两者都通过 **`/<name> [args]`** 触发（同名时 **skill 优先于 command**）。

用户在聊天框输入 `/` 时，Web UI 会弹出 autocomplete（`GET /slash-commands`）；`/help` 列出 commands + skills。

**Server 在调 LLM 前**把 body 展开成用户消息（inline skill / command），`context: fork` 的 skill 则直接跑子 agent。

内置：`/help`、`/commands` 列出所有可用命令。

```markdown
---
description: Review the current uncommitted diff and flag bugs / style / missing tests.
argument-hint: "[optional: focus area]"
arguments: "focus"               # 启用 $focus 命名参数
---

Review the local diff. Focus area: **$focus**

Branch: !`git rev-parse --abbrev-ref HEAD`

Diff:

!`git diff`

For each issue, output one bullet: `[severity]` `file:line` — what / why / fix.
```

body 里支持的语法：
- `$ARGUMENTS` — `/cmd ` 后面的整段
- `$1`、`$2`、… 或 `$ARGUMENTS[0]` — 索引访问（空格/引号分词）
- `$name` — 命名参数（前提是 frontmatter 里声明 `arguments:`）
- `` !`shell cmd` `` — 跑 shell，把 stdout 替换进 prompt（15s 超时，200KB 上限）
- `@path/to/file` — 读文件内容塞进 prompt（100KB 上限，自动 fenced code block）

实现：`commands/argument-substitution.ts`（参数替换）、`commands/prompt-expansion.ts`（!-block + @-ref）、`commands/from-files.ts`（解析）、`commands/dispatcher.ts`（在 router 调 LLM 之前拦截 `/`）。

### 添加 Skills（文件夹形态）

Skill 由**模型而不是用户**触发——通过 `skill` dispatcher tool。和 command 共用一套
`$ARGUMENTS` / `!` / `@` 语法，但每个 skill 是一个**文件夹**而不是单文件 `.md`。

#### 目录布局

| 优先级 | 路径 | 备注 |
|--------|------|------|
| 低 | `~/.ai-agent/skills/<skill-name>/SKILL.md` | 用户级（和 `~/.ai-agent/settings.json` 同目录） |
| 中 | `<ancestor>/.ai-agent/skills/<skill-name>/SKILL.md` | 沿 `cwd` 向上每一级（monorepo 友好） |
| 高 | `<cwd>/.ai-agent/skills/<skill-name>/SKILL.md` | 最深一级，同名覆盖上面所有 |

每个 skill 文件夹**必须**包含 `SKILL.md`；同目录下**可以**放任意其它文件 / 子目录
（脚本、模板、示例数据）。skill 名 = 文件夹名（必须匹配 `[a-z0-9][a-z0-9_-]*`），
直接散落在 `.ai-agent/skills/` 根下的 `.md` 文件会被忽略。用户级 skill 目录为 `~/.ai-agent/skills/`。

#### `SKILL.md` 示例

```markdown
---
description: Draft a PR body (summary + test plan) from the current branch's diff.
context: inline                   # "inline"（默认）或 "fork"
arguments: "audience"
paths: "src/**, !vendor/**"       # 可选：gitignore-style 条件触发
---

You are writing a PR body. Audience: **$audience**.

Commits: !`git log --oneline origin/main..HEAD`
Diff stats: !`git diff --stat origin/main...HEAD`

参考清单：@${SKILL_DIR}/checklist.md
辅助脚本：!`bash ${SKILL_DIR}/scripts/collect.sh`
```

`${SKILL_DIR}` 会被替换成该 skill 文件夹的绝对路径，body 里可以借此引用同目录下
的其它文件 / 脚本（`${SKILL_DIR}` 占位符）。expand 之后还会自动在
prompt 顶部加一行 `Base directory for this skill: …`，让模型即使没显式引用也能
找到这些 bundled 资源。

#### 条件激活（`paths:` frontmatter）

写了 `paths:` 的 skill 是**条件性的**——只在用户当前消息提到的文件匹配其 pattern 时才暴露给模型。
没写 `paths:` 的 skill 永远活跃。Pattern 用 `ignore` 库做 gitignore-style 匹配：

| Frontmatter | 行为 |
|-------------|------|
| `paths: "**/*.py"` | 用户消息提到 `.py` 文件时才出现 |
| `paths: ["src/**", "!src/vendor/**"]` | YAML list，支持排除 |
| 不写 `paths:` | 永远活跃 |

候选文件列表由 `extractFilePathCandidates(effectiveMessage)`（router.ts）从用户消息抓取，支持
- 反引号包裹的路径：`` `src/foo.ts` ``
- 含 `/` 或扩展名的裸 token：`src/foo.ts`、`run.sh`

要换更准的信号（git 修改文件、最近编辑、`git ls-files`），改 `registerSkills` 的 `candidateFiles` 入参即可。我们在每个聊天回合做一次过滤，和 per-request register 的节奏匹配。

#### 两种 `context` 模式

- `inline`（默认）：body 展开后作为 **tool 结果**返回给主 agent，像"突然想起来该按这个流程办"
- `fork`：body 展开后作为**新子 agent 的 user prompt**跑（用 `agent:` 字段指定哪个 subagent_type，默认 `general_purpose`）。用于需要大量工具调用又不想污染主上下文的场景

#### 性能：lazy body load

扫描时只读 `SKILL.md` 前 16 KB 解析 frontmatter，**body 不进内存**——模型真调用了
才通过 `loadBody()` 重新读一次完整文件并 strip frontmatter，结果在 `SkillDefinition`
里缓存一份。对 100+ skill + 多 KB body 的项目，启动 IO 和 heap 都明显省。

#### 实现入口

- `skills/from-folders.ts` — 扫描 + frontmatter 解析 + `paths:` 过滤
- `skills/index.ts` → `registerSkills(registry, cwd, agents, { candidateFiles })`
- `tools/skill.ts` — dispatcher，调 `loadBody()` 拿 body、做 `${SKILL_DIR}` / `$ARGUMENTS` 替换、加 preamble
- `server/router.ts` — 每次聊天请求调用一次（编辑 `SKILL.md` 下条消息生效，无需重启）

### 共享底座

agents / commands / skills 三者共用：
- `core/app-dir.ts` — **唯一**配置目录名（默认 `.ai-agent`）；`AI_AGENT_DIR` 环境变量可覆盖
- `core/markdown-config-loader.ts` — 扫 user + project 两层目录、读文件、`gray-matter` 解析
- `core/frontmatter-helpers.ts` — `parseToolList` / `parseBool` / `parseArgumentNames` 等

目录布局（项目配置目录 `.ai-agent/`）：

```text
~/.ai-agent/
├── settings.json
├── agents/*.md
├── commands/*.md
└── skills/<name>/SKILL.md

<project>/.ai-agent/
├── settings.json
├── settings.local.json
├── agents/*.md
├── commands/*.md
└── skills/<name>/SKILL.md
```

改目录名：设环境变量 `AI_AGENT_DIR=.my-agent`（可带或不带前导点），或改 `core/app-dir.ts` 里的 `DEFAULT_APP_DIR_NAME`。

加一种新的 markdown 扩展类型（比如 `output-styles`、`workflows`）只需在 `MarkdownConfigKind` 加一项 + 写一个 `parseXxxFromMarkdown` + 一个 `mergeXxx`，约 100 行。

### 添加新工具

与 06 相同：在 `tools/` 新建 `my_tool.ts`，在 `tools/index.ts` 注册。

若仅应在子代理中可用，在对应 `AgentDefinition` 的 `disallowedTools` / 继承策略中配置。

### 添加新 LLM Provider

1. 在 `core/llm/strategies/` 实现 `ProviderStrategy`。
2. 在 `core/llm/index.ts` 的 `STRATEGIES` 中注册。
3. 在 `core/llm/types.ts` 的 `ProviderId` 联合类型中加入新 id。

### 添加项目规则（同 06）

在项目根目录创建 `AGENTS.md`，从 git root 到 cwd 向上合并，越近的文件优先级越高。
