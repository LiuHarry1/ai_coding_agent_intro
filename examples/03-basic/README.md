# 03-basic — 02-basic + Context Management (Summarization)

**02-basic** plus:

- **Session support**: Multi-turn conversations persisted to `.sessions/`
- **Context management**: When messages exceed a threshold, older conversation is compressed into a structured working-state summary using a cheap LLM call

## What's new vs 02-basic?

```
02-basic/                          03-basic/
  agent.js    ← single-turn         agent.js    ← multi-turn + summarizeIfNeeded
  tools.js                          tools.js
  prompts.js                        prompts.js  ← mentions summary context
  tools/      ← same tools          tools/      ← same tools
                                    context.js  ← NEW: summarizeIfNeeded()
                                    session.js  ← NEW: session persistence
                                    server.js   ← NEW: session-aware server
```

## How summarization works

When `messages.length >= 16`, before the next LLM call:

1. Split messages into `toSummarize` (older) and `toKeep` (last 4)
2. Send `toSummarize` to a cheap model with a structured prompt
3. Replace older messages with `[summary] + [assistant ack] + toKeep`

The summary is a **working-state snapshot**, not conversation history:

```
## Task
Build a todo API with Express and tests.

## Completed Work
- Created src/server.js (Express CRUD for /api/todos)
- Created tests/api.test.js (4 tests, all passing)

## Current State
npm test: 4/4 passing. Server on port 3000.

## Key Files
- src/server.js — Express app with in-memory todos
- tests/api.test.js — supertest-based API tests
```

The agent can always `read_file` to recover any details the summary omitted.

## Run

```bash
node start.js 03-basic
```
