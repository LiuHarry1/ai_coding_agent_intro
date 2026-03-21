# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is an AI Coding Agent demo/teaching project (Node.js, ES Modules). It has a single HTTP server that serves both a REST+SSE API and a static web UI.

### Services

| Service | Port | How to start |
|---|---|---|
| Agent Server (includes web UI) | 4567 | `npm start` (runs `node start.js`, defaults to example `03-basic`) |

The server requires an **external** OpenAI-compatible LLM proxy called `copilot-proxy` at `http://localhost:4141`. Without it, the server starts and serves the web UI, but `/chat` requests fail with `ECONNREFUSED`. The API key is hardcoded to `"not-needed"` in `shared/provider.js`.

### Running

- `npm start` — starts the agent server on port 4567 (default example: `03-basic`)
- `node start.js <example-name>` — start with a specific example (`00-basic`, `01-basic`, `02-basic`, `03-basic`, `04-basic`)
- Web UI available at `http://localhost:4567/`
- Health check: `curl http://localhost:4567/health`

### Key caveats

- **No lint, test, or build tooling is configured.** There are no ESLint, Prettier, Jest, Vitest, or TypeScript configs.
- **No `.nvmrc` or `.node-version` file.** The project works with Node.js v22+.
- The `requirements.txt` in the repo root references Python packages (`fastapi`, `openai`, etc.) but there are **no Python source files** — it is unused.
- If port 4567 is busy, run `npm run server:stop` to kill the previous process before restarting.
- Sessions are persisted as `.jsonl` files in `.sessions/` directory (no database needed).
