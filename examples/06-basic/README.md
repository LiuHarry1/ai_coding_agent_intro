# 05-basic — Modular Agent Architecture

A production-oriented coding agent architecture with clean separation of concerns,
extensibility via plugins/middleware, and a modern React UI.

## Architecture Overview

```
05-basic/
├── core/                    # Framework layer
│   ├── event-bus.js         # Typed EventEmitter (decouples agent from transport)
│   ├── tool-registry.js     # Self-describing tool catalog with auto-registration
│   ├── middleware.js         # Before/after tool execution hooks (timing, logging, etc.)
│   ├── provider-manager.js  # Multi-LLM provider support (future: Claude, Gemini, etc.)
│   ├── plugin-manager.js    # Plugin lifecycle (register tools, events, middleware)
│   ├── context.js           # Conversation compaction
│   └── agent.js             # Agent loop (streamText → tools → loop)
├── tools/                   # Built-in tools
│   ├── bash.js              # Shell execution
│   ├── read_file.js         # File reading with line numbers
│   ├── write_file.js        # File creation/overwrite
│   ├── edit_file.js         # Targeted text replacement
│   ├── utils.js             # truncate(), resolvePath()
│   └── index.js             # Auto-registers all tools
├── subagents/               # Subagent definitions
│   ├── base.js              # createSubagentDefinition() factory
│   └── explore.js           # Codebase exploration subagent
├── server/                  # HTTP layer
│   ├── router.js            # Route handlers (sessions, chat, workspace)
│   ├── sse-transport.js     # EventBus → Server-Sent Events bridge
│   ├── session.js           # Session persistence (JSONL)
│   └── index.js             # Server startup
├── prompts/
│   └── system.js            # System prompt with auto-discovered tool list
├── agent.js                 # Entry: exports runAgent
├── tools.js                 # Entry: exports createTools
├── prompts.js               # Entry: exports systemPrompt
└── server.js                # Entry: exports startServer
```

## Key Improvements over 04-basic

| Feature | 04-basic | 05-basic |
|---------|----------|----------|
| Event system | Direct `sendSSE` function passing | EventBus with wildcard + scoped listeners |
| Tool registration | Manual factory calls | Self-describing ToolRegistry with auto-registration |
| Middleware | None | Before/after tool hooks (timing, logging, etc.) |
| Provider | Hardcoded single provider | ProviderManager (multi-provider ready) |
| Plugins | None | PluginManager (register tools, events, middleware) |
| Subagents | Ad-hoc factory function | `createSubagentDefinition()` base pattern |
| Server | Monolithic request handler | Separated router + SSE transport + session |
| UI | Vanilla JS (693-line single file) | React + Vite component architecture |
| Theme | Dark only | Dark/Light theme toggle |
| Sessions | Clear button only | Full sidebar with session list, switch, delete |
| Stop button | None | Abort streaming mid-response |
| Tool timing | Not tracked | Middleware-powered duration display |
| Responsive | Fixed 860px | Mobile-friendly responsive layout |

## Running

### Quick Start (production mode)

```bash
# Build the React UI
cd client2/web
npm install
npm run build
cd ../..

# Start the server
npm start -- 05-basic
```

### Development Mode

Terminal 1 — Backend:
```bash
npm start -- 05-basic
```

Terminal 2 — Frontend (with hot reload):
```bash
cd client2/web
npm run dev
```

Open http://localhost:5173 (Vite proxies API requests to port 4567).

## Extending

### Add a new tool

Create `tools/my_tool.js`:

```javascript
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

Register in `tools/index.js`:
```javascript
import { definition as myTool } from "./my_tool.js";
// add to the registration array
```

### Add a new subagent

```javascript
import { createSubagentDefinition } from "./base.js";

export const definition = createSubagentDefinition({
  name: "code_review",
  description: "Review code changes for issues",
  systemPrompt: "You are a code review subagent...",
  tools: ["read_file", "bash"],
  maxSteps: 15,
});
```

### Add middleware

```javascript
middleware.use("beforeTool", async (ctx) => {
  console.log(`[audit] ${ctx.name} called with`, ctx.args);
});

middleware.use("afterTool", async (ctx) => {
  console.log(`[audit] ${ctx.name} completed in ${ctx.duration}ms`);
});
```

### Register a plugin

```javascript
pluginManager.register({
  name: "git-tools",
  version: "1.0.0",
  init(context) {
    context.tools.register(gitStatusDef);
    context.tools.register(gitDiffDef);
    context.events.on("tool_call", (data) => { ... });
  },
});
```
