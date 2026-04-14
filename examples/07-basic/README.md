# 06-basic — MCP, Project Rules, Cross-Platform, Multimodal & Unified Config

在 05-basic 模块化架构基础上，新增 MCP 集成、项目规则加载、跨平台 shell 支持、图片输入能力和统一配置管理。

## What's New (vs 05-basic)

| Feature | 05-basic | 06-basic |
|---------|----------|----------|
| Unified config | None | `~/.ai-agent/config.json` 统一管理 provider 和 MCP，REST API 动态修改 |
| Provider | 硬编码 baseURL 和 model，依赖外部 `shared/provider.js` | 配置驱动，自包含，运行时可通过 UI/API 切换 |
| MCP (Model Context Protocol) | None | stdio/HTTP 连接，tools 自动合并，配置变更自动重连 |
| Project rules | None | 自动加载 `AGENTS.md` / `CLAUDE.md`，从 cwd 向上遍历至 git root |
| Cross-platform shell | Hardcoded `bash` | `platform.ts` 统一管理：macOS/Linux → bash, Windows → PowerShell |
| Path handling | Unix only | Windows 大小写不敏感路径比较，git 路径归一化 |
| Process management | Unix signals only | Windows `taskkill` 支持 |
| Image input | Text only | 支持 base64 图片作为多模态用户消息 |
| `list_dir` tool | None | Git-aware 目录树浏览（自动 .gitignore 过滤） |

## Architecture Overview

```
06-basic/
├── core/                    # Framework layer
│   ├── config-manager.ts    # Unified config: defaults + ~/.ai-agent/config.json
│   ├── platform.ts          # Cross-platform: shell, process, path
│   ├── provider-manager.ts  # Provider lifecycle, config-driven, hot-reload
│   ├── mcp-manager.ts       # MCP server connections & tool merging
│   ├── rules-loader.ts      # AGENTS.md / CLAUDE.md discovery & merge
│   ├── event-bus.ts         # Typed EventEmitter
│   ├── tool-registry.ts     # Self-describing tool catalog
│   ├── middleware.ts        # Before/after tool execution hooks
│   ├── plugin-manager.ts    # Plugin lifecycle
│   ├── context.ts           # Conversation compaction
│   ├── types.ts             # Shared type definitions
│   └── agent.ts             # Agent loop (streamText → tools → loop)
├── tools/                   # Built-in tools
│   ├── bash.ts              # Platform-aware shell execution
│   ├── list_dir.ts          # Git-aware directory listing
│   ├── read_file.ts         # File reading with line numbers
│   ├── write_file.ts        # File creation/overwrite
│   ├── edit_file.ts         # Targeted text replacement
│   ├── utils.ts             # truncate(), resolvePath()
│   └── index.ts             # Auto-registers all tools
├── subagents/               # Subagent definitions
│   ├── base.ts              # createSubagentDefinition() factory
│   └── explore.ts           # Platform-aware codebase exploration
├── server/                  # HTTP layer
│   ├── router.ts            # Routes: sessions, chat, workspace, settings
│   ├── sse-transport.ts     # EventBus → Server-Sent Events bridge
│   ├── session.ts           # Session persistence (JSONL)
│   └── index.ts             # Server startup
├── prompts/
│   └── system.ts            # System prompt with platform + project rules
├── config.example.json      # Example config file
├── agent.ts                 # Entry: exports runAgent
├── tools.ts                 # Entry: exports createTools
├── prompts.ts               # Entry: exports systemPrompt
└── server.ts                # Entry: exports startServer
```

## Configuration

All settings live in `~/.ai-agent/config.json` (auto-created on first change via UI or API).

Package ships with built-in defaults; the user config file only needs to contain fields you want to override. See `config.example.json` for full format.

```
┌──────────────────────────┐
│ Built-in DEFAULTS        │  (in config-manager.ts, read-only)
│ provider: localhost:4141  │
│ model: gpt-5.2           │
│ mcpServers: {}           │
└────────────┬─────────────┘
             │  merge (defaults ← user)
             ▼
┌──────────────────────────┐
│ ~/.ai-agent/config.json  │  (read-write, UI/API changes go here)
└────────────┬─────────────┘
             │  onChange callbacks
     ┌───────┴───────┐
     ▼               ▼
ProviderManager   MCPManager
(invalidate →     (closeAll →
 rebuild)          reconnect)
```

Example minimal config (only overrides model):

```json
{
  "provider": {
    "model": "claude-sonnet-4-20250514"
  }
}
```

Example full config:

```json
{
  "provider": {
    "name": "copilot-proxy",
    "baseURL": "http://localhost:4141/v1",
    "apiKey": "not-needed",
    "model": "gpt-5.2"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

### Settings REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/settings` | Get full config (apiKey masked) + MCP connection status |
| `PATCH` | `/settings/provider` | Update provider — any subset of `{ baseURL, model, apiKey, name }` |
| `PATCH` | `/settings/mcp` | `{ action: "add", name, config }` or `{ action: "remove", name }` |

Changes take effect immediately: provider rebuilds on next request, MCP servers reconnect automatically.

## Running

### Quick Start (production mode)

```bash
# Build the React UI
cd client2/web
npm install
npm run build
cd ../..

# Start the server
npm start -- 06-basic
```

### Development Mode

Terminal 1 — Backend:
```bash
npm start -- 06-basic
```

Terminal 2 — Frontend (with hot reload):
```bash
cd client2/web
npm run dev
```

Open http://localhost:5173 (Vite proxies API requests to port 4567).

## Extending

### Add a new tool

Create `tools/my_tool.ts`:

```typescript
import { tool } from "ai";
import { z } from "zod";

export const definition = {
  name: "my_tool",
  description: "What it does",
  create(cwd, context) {
    return tool({
      description: "Detailed description for the AI",
      inputSchema: z.object({ ... }),
      execute: async (args) => { ... },
    });
  },
};
```

Register in `tools/index.ts`:
```typescript
import { definition as myTool } from "./my_tool.js";
// add to the registration array
```

### Add project rules

Create `AGENTS.md` in the project root (auto-discovered):

```markdown
# Project Rules
- Use pnpm, not npm
- Run tests with `pnpm vitest`
- API routes live in src/routes/
```

Rules files are merged from git root down to cwd, with closer files taking higher priority.
