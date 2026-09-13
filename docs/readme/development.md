# Local Development

This guide is for developers who need to **modify the frontend interface** or **debug the Coding Agent backend**. If you only want to try the product, start with the desktop app instructions in the [Quick Start](getting-started.md).

---

## Install dependencies

```bash
npm install
cd client/web && npm install && cd ../..
```

---

## Configuration

### LLM and MCP

User-level configuration: `~/.ai-agent/settings.json` (`models`, MCP, and related settings).

Project-level configuration: `<workspace>/.ai-agent/settings.json`, which takes precedence over user-level configuration.

Copy the example file to get started:

```bash
cp .ai-agent/settings.example.json .ai-agent/settings.json
```

### Environment variables (optional)

```bash
cp .env.example .env
```

`.env` contains runtime options such as ports, workspace paths, and `dump-prompts`; **LLM API configuration belongs primarily in `settings.json`**.

| Configuration                                | Location                                           |
| -------------------------------------------- | -------------------------------------------------- |
| LLM API (`baseURL`, `apiKey`, and `model`)   | `.ai-agent/settings.json`                          |
| Ports, workspace paths, and related settings | `.env` (optional)                                  |
| Browser mode                                 | The `browser` section of `.ai-agent/settings.json` |

---

## Web UI development (two terminals)

Run the frontend and backend separately in **two terminals**:

### Terminal A — Start the backend

```bash
npm start              # Load src/ and listen on http://localhost:4567
```

### Terminal B — Start the Web UI (hot reload)

```bash
npm run dev:web        # http://localhost:5173
```

Open **http://localhost:5173** in a browser. The frontend development server proxies APIs such as `/chat` and `/workspace` to the backend on port 4567, avoiding local cross-origin issues. The proxy configuration is in `client/web/vite.config.js`.

---

## Debug LLM prompt and tool traces

Enable CC-style prompt dumps:

```bash
DUMP_PROMPTS=1 npm start
# or
DUMP_PROMPTS=1 DUMP_PROMPTS_DIR=/tmp/dump-prompts-live npm start
```

By default, output is written to `~/.ai-agent/dump-prompts/{sessionId}.jsonl`. Set `DUMP_PROMPTS_DIR` to override the output directory.

---

## Desktop app

```bash
npm run desktop:dev      # Build the frontend and open the Electron window
npm run desktop:start    # Start directly when dist already exists
npm run desktop:pack     # Package an installer for the current platform (macOS → dmg, etc.)
npm run desktop:pack:win # Package a Windows installer
```

Electron starts the Coding Agent subprocess automatically and loads `http://127.0.0.1:4567` in the window.

---

## Common development commands

| Command                                       | Description                                                        |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `npm start`                                   | Start the Coding Agent backend                                     |
| `npm run dev:web`                             | Start the Web UI development server with hot reload                |
| `npm run build:web`                           | Build the frontend into `client/web/dist`                          |
| `npm run desktop:dev`                         | Start the desktop app                                              |
| `npm run typecheck`                           | Run TypeScript type checks for `src`, `protocol`, and `client-sdk` |
| `npm run format`                              | Format code using the project's Prettier rules                     |
| `npm run acp -- --workspace /path/to/project` | Verify ACP mode from the terminal                                  |

---

## Related documentation

- [Architecture overview](../architecture/)
- [Browser Automation](browser.md)
- [VS Code / Cursor Integration](integrations/vscode-acp.md)
- [IntelliJ Integration](integrations/intellij-acp.md)
