# `@ai-agent/client`

TypeScript client for the coding agent HTTP API — discover skills, invoke
skills directly, and run free-form chat (buffered or streaming).

Works in Node 18+, browsers, Bun, edge runtimes. No `EventSource` dependency.

## Install

```jsonc
// your project's package.json
{
  "dependencies": {
    "@ai-agent/client": "file:../ai_coding_agent_test/client-sdk"
  }
}
```

```bash
cd client-sdk && npm install && npm run build
```

## Quick start (SSO deploy)

```ts
import { AgentClient, collectText } from "@ai-agent/client";

const agent = new AgentClient({
  baseURL: "http://localhost:4567",
  jwtSecret: process.env.AGENT_JWT_SECRET!,
  email: "you@company.com",   // decides the pinned workspace
});

const { skills } = await agent.listSkills();
const { text } = await agent.chatComplete({ message: "Hello" });

for await (const ev of agent.chat({ message: "find TODOs" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.delta);
}
```

Or pass a ready-made token: `{ baseURL, token: "eyJ..." }`.

## IntelliJ IDEA (ACP)

Connect JetBrains IDEs to the coding agent over **ACP** (Agent Client Protocol)
via stdio — no HTTP server on `:4567` required. The IDE spawns the agent as a
subprocess and talks JSON-RPC on stdin/stdout.

### Prerequisites

- IntelliJ IDEA **2025.3+** (or another JetBrains IDE with AI Assistant + ACP)
- AI Assistant enabled
- Agent repo built: `npm install` at the repo root
- Terminal smoke test:

```bash
cd /path/to/ai_coding_agent_test
npm run acp -- --workspace /path/to/your/project
```

You should see `[start] Loading example: 08-basic` and
`[acp] workspace=...`, then the process waits for input (normal).

> **Note:** `--workspace` sets the default project root. Do not pass the
> workspace path as a bare positional argument — use `--workspace /abs/path`.

### Configure `acp.json`

Registry agents (Settings → AI Assistant → **Agents** → Install) are **not**
where custom agents go. Add yours via **`~/.jetbrains/acp.json`**:

1. Open **AI Chat** → upper-right **⚙** → **Add Custom Agent**  
   (creates/opens `~/.jetbrains/acp.json`), **or** edit the file manually:

```bash
mkdir -p ~/.jetbrains
```

2. Paste (adjust paths):

```json
{
  "default_mcp_settings": {
    "use_idea_mcp": true,
    "use_custom_mcp": true
  },
  "agent_servers": {
    "Baize Agent": {
      "command": "/opt/homebrew/opt/node@22/bin/npx",
      "args": [
        "tsx",
        "/Users/you/ai_coding_agent_test/start.js",
        "--acp",
        "--workspace",
        "/Users/you/IdeaProjects/my-app"
      ],
      "env": {}
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `command` | **Absolute** path to `npx` or `node` (`which npx`) |
| `args` | `tsx`, path to `start.js`, `--acp`, optional `--workspace` |
| `env` | Optional; API keys if `.env` is not picked up by the subprocess |

API keys normally load from `ai_coding_agent_test/.env`. If auth fails from
the IDE, add vars to `env`, e.g. `"OPENAI_API_KEY": "sk-..."`.

3. In **Settings → AI Assistant → Agents**, enable **Pass IntelliJ MCP server**
   and **Pass custom MCP servers** (matches `default_mcp_settings` above).

4. Restart the IDE.

### Use in AI Chat

1. Open your project in IntelliJ.
2. Open **AI Chat**.
3. Select **Baize Agent** in the agent dropdown (not Junie / Claude Agent).
4. Send a message, e.g. `/help` or `List files in src`.

IntelliJ also passes the project directory in ACP `session/new` (`cwd`), so
you can omit `--workspace` in `args` when you always open the target project
first; keep `--workspace` if you want a fixed default.

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agent missing from dropdown | Validate JSON in `~/.jetbrains/acp.json`; restart IDE |
| `Failed to load example "/Users/..."` | Use `--workspace /path`, not a bare path after flags |
| Agent hangs / no reply | Run the same `npx tsx ... start.js --acp` command in a terminal |
| `command` not found | Use absolute `npx` path; IDE does not inherit shell `PATH` / nvm |
| JSON parse errors in IDE | stdout must be ACP-only; boot logs go to stderr (`--acp` mode) |

See also [JetBrains ACP docs](https://www.jetbrains.com/help/ai-assistant/acp.html).

## API overview

| Layer | Methods |
|-------|---------|
| Discovery | `health()`, `listSkills()`, `listAgents()` |
| Skills | `invokeSkill()` (buffered), `invokeSkillStream()` (SSE) |
| Chat | `chatComplete()` (buffered), `chat()` (SSE) |
| Helpers | `collectText(events)`, `mintJwt()` (Node only) |

## Three use cases (examples + tests)

```bash
npm run example              # all three
npm run example -- skills    # list all skills
npm run example -- chat      # multi-turn same session
npm run example -- wetrack    # wetrack skill (streaming)

npm test                     # integration tests (same 3 cases)
```

Env vars: `AGENT_BASE_URL`, `AGENT_JWT_SECRET`, `AGENT_EMAIL`.
Set `AGENT_SKIP_LIVE=1` to skip integration tests.

## Cancellation

Streaming methods accept an optional `AbortSignal`:

```ts
const ac = new AbortController();
for await (const ev of agent.chat({ message: "..." }, ac.signal)) { /* … */ }
ac.abort();
```

## Errors

```ts
try {
  await agent.invokeSkill("nope");
} catch (e) {
  if (e instanceof AgentClientError) {
    console.error(e.message, e.status, e.body);
  }
}
```

HTTP errors throw `AgentClientError`. SSE `{ type: "error" }` events are
yielded in the stream (or thrown by `collectText()`).

## Type exports

```ts
import type { AgentEvent, SkillSummary, ChatRequest } from "@ai-agent/client";
```
