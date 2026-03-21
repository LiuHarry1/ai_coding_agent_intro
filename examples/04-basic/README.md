# 04-basic: Subagents

03-basic + **Explore Subagent** for context-isolated codebase exploration.

## What's New

Building on 03-basic (structured tools + context management), this example adds:

- **Explore subagent** — a separate agent instance that searches and analyzes the codebase in its own isolated context, returning only a structured summary to the primary agent.

## Explore subagent: role & what it solves

In a **coding agent**, the main loop has limited context and should spend tokens on **deciding and editing**, not on **long chains of search-and-read**. Explore exists to:

| Problem | How Explore helps |
|--------|-------------------|
| **Context bloat** | `grep`, `find`, and multi-file reads produce huge output; the parent keeps a *summary* instead of every raw tool log. |
| **Wrong focus** | Broad tasks (“understand the architecture”, “find all auth code”) need many steps; Explore runs those steps in a **fresh message list** so the primary session stays clean. |
| **Safety while exploring** | Explore only gets **read-only** tools (`read_file`, `bash` for search/list); it won’t write or patch files while “looking around”. |
| **Same loop, different job** | It’s still `runAgent` — same loop as the primary agent — but **isolated context + narrow tool set + explore prompt**, so the model can “search like a junior dev” and return a **structured report** to the parent. |

**When to use it (conceptually):** multi-file or repo-wide understanding, locating patterns, mapping structure — **not** for editing a file you already know the path of (use `read_file` / `edit_file` directly).

## Architecture

Architecture **image**: [architecture.svg](./architecture.svg) · **Mermaid + details**: [ARCHITECTURE.md](./ARCHITECTURE.md).

```
Primary Agent (runAgent)
├── Direct tools: bash, read_file, write_file, edit_file
└── Subagent tool: explore
    └── Calls runAgent() with:
        - Fresh messages: []     ← context isolation
        - Limited tools: read_file, bash (read-only)
        - Explore-specific system prompt
        - Prefixed sendSSE for UI separation
        - Returns finalText as tool result
```

**Key insight**: The subagent uses the _same_ `runAgent` function as the primary agent, just with different configuration. A subagent is not a separate system — it's the same agent loop with isolated context.

## Files

| File | Description |
|------|-------------|
| `agent.js` | Shared agent loop (used by both primary and subagent), now returns `finalText` |
| `subagents/explore.js` | Explore subagent: creates the `explore` tool that delegates to `runAgent` |
| `tools/index.js` | Tool registry: direct tools + explore subagent |
| `context.js` | Context management (summarization) — inherited from 03-basic |
| `prompts.js` | System prompt mentioning explore usage |
| `server.js` | HTTP server — passes `runAgent` and `sendSSE` to `createTools` |
| `session.js` | Session persistence — inherited from 03-basic |

## Running

```bash
node start.js 04-basic
```

## Try It

- "帮我了解这个项目的结构和技术栈" → triggers explore subagent
- "找到所有和 session 相关的代码" → triggers explore subagent
- "读取 package.json" → direct read_file (no subagent needed)
- "创建一个 hello.js" → direct write_file + bash
