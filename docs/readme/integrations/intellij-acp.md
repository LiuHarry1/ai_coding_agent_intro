# IntelliJ IDEA (ACP)

Connect a JetBrains IDE to Coding Agent through **ACP** (Agent Client Protocol). Communication uses stdio, so no HTTP service needs to run on `:4567`. The IDE starts the agent as a subprocess and exchanges JSON-RPC messages over stdin/stdout.

---

## Prerequisites

- IntelliJ IDEA **2025.3+**, or another JetBrains IDE with AI Assistant and ACP enabled
- AI Assistant enabled
- `npm install` run in this repository
- A terminal smoke test:

```bash
cd /path/to/coding-agent
npm run acp -- --workspace /path/to/your/project
```

You should see `[start] Loading agent from src/` and `[acp] workspace=...`, after which the process waits for input. This is expected.

> **Warning:** `--workspace` sets the default project root. Do not pass the workspace path as a bare positional argument; use `--workspace /abs/path`.

---

## Configure `acp.json`

The agent registry under Settings → AI Assistant → **Agents** → Install is **not** the entry point for custom agents. Add Coding Agent through **`~/.jetbrains/acp.json`**:

1. Open **AI Chat** → **⚙** in the upper-right corner → **Add Custom Agent**. This creates or opens `~/.jetbrains/acp.json`. Alternatively, edit the file manually:

```bash
mkdir -p ~/.jetbrains
```

2. Paste the following content and adjust the paths:

```json
{
  "default_mcp_settings": {
    "use_idea_mcp": true,
    "use_custom_mcp": true
  },
  "agent_servers": {
    "Coding Agent": {
      "command": "/opt/homebrew/opt/node@22/bin/npx",
      "args": [
        "tsx",
        "/Users/you/coding-agent/start.js",
        "--acp",
        "--workspace",
        "/Users/you/IdeaProjects/my-app"
      ],
      "env": {}
    }
  }
}
```

| Field     | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `command` | The **absolute path** to `npx` or `node` (`which npx`)                       |
| `args`    | `tsx`, the path to `start.js`, `--acp`, and optional `--workspace` arguments |
| `env`     | Optional; provide the API key here if the subprocess does not read `.env`    |

The API key is normally loaded from `.env` or `settings.json` in the repository root. If authentication fails when launched from the IDE, add the key to `env`, for example `"OPENAI_API_KEY": "sk-..."`.

3. Under **Settings → AI Assistant → Agents**, enable **Pass IntelliJ MCP server** and **Pass custom MCP servers**. These options correspond to `default_mcp_settings` above.

4. Restart the IDE.

---

## Use Coding Agent in AI Chat

1. Open your project in IntelliJ.
2. Open **AI Chat**.
3. Select **Coding Agent** from the agent menu, not Junie or Claude Agent.
4. Send a message such as `/help` or `List files in src`.

IntelliJ also passes the project directory (`cwd`) in ACP `session/new`. If you always open the target project first, you can omit `--workspace` from `args`. Keep `--workspace` if you need a fixed default directory.

---

## Troubleshooting

| Symptom                               | Resolution                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The agent is absent from the menu     | Check that `~/.jetbrains/acp.json` contains valid JSON, then restart the IDE                   |
| `Failed to load example "/Users/..."` | Use `--workspace /path`; do not place a bare path after the flag                               |
| The agent hangs or does not respond   | Run the same `npx tsx ... start.js --acp` command in a terminal to investigate                 |
| `command` not found                   | Use the absolute path to `npx`; the IDE does not inherit the shell's `PATH` or nvm environment |
| The IDE reports a JSON parsing error  | stdout must contain only the ACP protocol; in `--acp` mode, startup logs are written to stderr |

For more information, see the [JetBrains ACP documentation](https://www.jetbrains.com/help/ai-assistant/acp.html).

---

## Related documentation

- [VS Code / Cursor Integration](vscode-acp.md)
- [Local Development](../development.md)
- [Documentation home](../../index.md)
