# VS Code / Cursor (ACP)

Use Coding Agent from the VS Code or Cursor sidebar through **ACP** (Agent Client Protocol).

---

## Prerequisites

- `npm install` has been run in this repository.
- `.ai-agent/settings.json` has been configured with the LLM API.

---

## Install the ACP Client extension

Install [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client).

---

## Configuration

Add the following to User Settings (JSON):

```json
{
  "acp.agents": {
    "Coding Agent": {
      "command": "npx",
      "args": ["tsx", "/path/to/coding-agent/start.js", "--acp"],
      "env": {}
    }
  }
}
```

Use double backslashes in Windows paths, for example
`C:\\Users\\you\\coding-agent\\start.js`.

> **`args` must contain `tsx` first**, followed by the absolute path to `start.js`. Omitting `tsx` prevents the agent from starting and causes the sidebar to display **Failed to load sessions**.

---

## Usage

1. Open the **ACP** panel from the Activity Bar.
2. Click **Coding Agent** to connect.

Optional: append `"--workspace", "/path/to/project"` to `args` to set a fixed default workspace.

The API key is normally read from the repository's `.env` or `settings.json`. If authentication fails when launched from the IDE, add the key to `env`.

---

## Verify from the terminal

```bash
npm run acp -- --workspace /path/to/project
```

The integration is working when `[acp] workspace=...` appears and the process waits for input.

---

## Related documentation

- [Local Development](../development.md)
- [Documentation home](../../index.md)
