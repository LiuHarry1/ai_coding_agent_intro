# agent-client (Python)

A small, reusable Python client for the coding-agent backend's HTTP API.
Use it from any internal project / script / CI job to:

- **Discover** the skills & subagents a deployment knows about
- **Invoke a skill directly** (no LLM round-trip for `inline` skills)
- **Run a free-form chat turn** and either stream events or wait for the text

It also **mints its own JWT locally** from the shared secret, so it works
against an SSO-mode deployment (`AUTH_ENABLED=true`) without any browser
login. Only dependency: `requests`.

This is the Python counterpart of the TypeScript `client-sdk/`.

## Install

```bash
conda activate py311
cd client-sdk-py
pip install -e .
```

## Auth model (read this once)

The deployment in `deploy/docker-compose.sso.yml` runs with `AUTH_ENABLED=true`,
so every request (except `GET /health`) must carry `Authorization: Bearer <JWT>`.

- The token is **HS256**, signed with the shared `JWT_SECRET` the agent was
  deployed with.
- The token's `sub` (an email) **decides which workspace** the server pins you
  to: `/workspace/users/<slug(email)>`. The `workspace` argument you pass is
  *ignored* in SSO mode. Pick a **stable email per service** so it always lands
  in the same workspace (and gets the same seeded skills).

Because you own the secret, the cleanest programmatic approach is to let the
client mint the token for you:

```python
from agent_client import AgentClient

agent = AgentClient(
    base_url="http://10.150.115.69:4567",
    jwt_secret="<JWT_SECRET>",   # the shared secret from your deploy
    email="service@bot",          # stable identity → stable workspace
)
```

If you'd rather supply a token from elsewhere, pass `token="..."` instead of
`jwt_secret`/`email`. If the backend has auth off, omit both.

## Usage

### Discover

```python
skills = agent.list_skills()["skills"]
# [{ "name": "SWR-content-generator", "context": "fork", "description": "...", ... }, ...]

agents = agent.list_agents()["agents"]
```

### Invoke an inline skill (instant, no model call)

```python
out = agent.invoke_skill("some-inline-skill", {"audience": "eng-team"})
print(out["result"])   # expanded SKILL.md body
```

Arguments may be a dict (flattened to `key=value` server-side) or a raw
string (`"audience=eng-team --strict"`).

### Invoke a fork skill and wait for the final text

```python
out = agent.invoke_skill("SWR-content-generator", {"topic": "release notes"})
print(out["result"])   # subagent's final answer
```

### Stream a fork skill (watch progress)

```python
for ev in agent.invoke_skill_stream("SWR-content-generator", {"topic": "x"}):
    if ev["type"] == "text_delta":
        print(ev["delta"], end="", flush=True)
    elif ev["type"] == "tool_call":
        print("\n[tool]", ev.get("name"))
    elif ev["type"] == "finish":
        break
```

### Free-form chat

```python
res = agent.chat_complete("review the staged diff and find bugs")
print(res["text"])

# or stream:
for ev in agent.chat("find all TODOs and group by priority"):
    if ev["type"] == "text_delta":
        print(ev["delta"], end="", flush=True)
```

### Drain a stream into one string

```python
from agent_client import collect_text

text = collect_text(agent.invoke_skill_stream("SWR-content-generator"))
```

## API surface this maps to

| Method | Backend endpoint |
|---|---|
| `list_skills()` | `GET /skills` |
| `list_agents()` | `GET /agents` |
| `invoke_skill()` / `invoke_skill_stream()` | `POST /skills/:name/invoke` |
| `chat_complete()` / `chat()` | `POST /chat` |
| `health()` | `GET /health` |

## Errors

```python
from agent_client import AgentClientError

try:
    agent.invoke_skill("nope")
except AgentClientError as e:
    print(e.status, e.body)   # e.g. 404 {"error": "Unknown skill 'nope'", ...}
```

Streaming errors arrive as `{"type": "error", "message": ...}` events in the
iterator (the iterator does not raise), except `collect_text`, which raises.
