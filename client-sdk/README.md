# `@ai-agent/client`

TypeScript client for the coding agent's HTTP API. Use it from your other
internal projects to:

- **Discover** what skills/agents this backend knows about
- **Invoke a skill directly** (no LLM round-trip for inline skills)
- **Run a free-form chat turn** (code review, ad-hoc task, …) and either
  stream tokens or wait for the final string

Works in Node 18+, browsers, Bun, edge runtimes — anywhere `fetch` and
`ReadableStream` are available. No `EventSource` dependency.

## Install

This package is intended for internal use; reference it directly with
file-protocol until you publish it to a registry:

```jsonc
// your other project's package.json
{
  "dependencies": {
    "@ai-agent/client": "file:../ai_coding_agent_test/client-sdk"
  }
}
```

Then build it once:

```bash
cd client-sdk && npm install && npm run build
```

## Quick start

```ts
import { AgentClient } from "@ai-agent/client";

const agent = new AgentClient({
  baseURL: "http://localhost:8080",
  defaultWorkspace: "/workspaces/projectA",
});
```

### Discover

```ts
const { skills } = await agent.listSkills();
// → [{ name: "pr-author", context: "inline", description: "...", ... }, ...]

const { agents } = await agent.listAgents();
// → [{ agentType: "explore", whenToUse: "...", ... }, ...]
```

### Invoke an inline skill (no LLM round-trip)

```ts
const { result } = await agent.invokeSkill("pr-author", {
  arguments: { audience: "eng-team" },
});
console.log(result); // expanded SKILL.md body
```

You can also pass a raw string (same shape `$ARGUMENTS` would see):

```ts
await agent.invokeSkill("pr-author", { arguments: "audience=eng-team" });
```

### Invoke a fork skill and wait for the final text

```ts
const { result } = await agent.invokeSkill("deep-review", {
  arguments: { focus: "perf" },
});
console.log(result); // subagent's final assistant text
```

### Stream a fork skill

```ts
for await (const ev of agent.invokeSkillStream("deep-review", {
  arguments: { focus: "perf" },
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.delta);
  if (ev.type === "tool_call") console.log("\n[tool]", ev.name, ev.args);
  if (ev.type === "finish") break;
}
```

### Free-form chat — wait for completion

```ts
const { text } = await agent.chatComplete({
  message: "review the staged diff and find bugs",
});
console.log(text);
```

### Free-form chat — stream

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 60_000); // cancel after 1 minute

for await (const ev of agent.chat(
  { message: "find all TODOs and group by priority" },
  ac.signal,
)) {
  switch (ev.type) {
    case "text_delta":     process.stdout.write(ev.delta); break;
    case "tool_call":      console.log("[tool]", ev.name); break;
    case "tool_result":    /* hide noisy results from logs */ break;
    case "finish":         console.log("\n[done]", ev.reason); break;
    case "error":          console.error("[error]", ev.message); break;
  }
}
```

## Cancellation

Both streaming methods accept an `AbortSignal`. Aborting cancels the
upstream `fetch` and releases the SSE reader — the agent backend will
notice the client went away via its `req.on("close")` handler and stop
charging tokens.

```ts
const ac = new AbortController();
const iter = agent.chat({ message: "..." }, ac.signal);
// later
ac.abort();
```

`chatComplete` and `invokeSkill` (buffered) don't accept a signal yet
because they're effectively atomic from the client's perspective. If you
need server-side cancellation for those, switch to the streaming variants
and call `ac.abort()` mid-flight.

## Errors

```ts
import { AgentClient, AgentClientError } from "@ai-agent/client";

try {
  await agent.invokeSkill("nope");
} catch (e) {
  if (e instanceof AgentClientError) {
    console.error("server said", e.status, e.body);
  } else {
    throw e; // network failure, abort, …
  }
}
```

Server-side errors come back as `AgentClientError` with `status` and
`body` populated. Streaming errors arrive as `{ type: "error", message }`
events in the iterator — the iterator does NOT throw, so you don't lose
the prior events.

## Injecting auth / tracing / custom fetch

```ts
const agent = new AgentClient({
  baseURL: "http://localhost:8080",
  headers: { "X-API-Key": process.env.AGENT_KEY! }, // when you add auth later
  fetch: (url, init) => {
    console.time(`agent ${url}`);
    return fetch(url, init).finally(() => console.timeEnd(`agent ${url}`));
  },
});
```

## Type exports

All the wire types are exported so you can use them in your own
function signatures:

```ts
import type {
  AgentEvent,
  SkillSummary,
  ChatRequest,
  ChatJSONResult,
} from "@ai-agent/client";
```
