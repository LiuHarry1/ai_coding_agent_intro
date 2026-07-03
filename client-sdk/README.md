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
