# `deploy/` — Two-image deployment (agent + web)

Backend and frontend are **separate Docker images**, built manually,
deployed together via compose.

```
                ┌─────────────────────────────┐
   browser ────▶│  nginx :80  →  agent :4567  │
   curl    ────▶│   (UI dist + reverse proxy) │
   project ────▶│                             │
                └─────────────────────────────┘
                            │
                  /workspaces/{name}/...
```

Only port `8080` is published to the host. The agent's `4567` is
internal-only (compose network) — all external traffic goes through nginx.

## Files

| File | Role |
|------|------|
| `Dockerfile.agent` | Backend Node image, no UI assets |
| `Dockerfile.web` | Multi-stage: Vite build → `nginx:alpine` |
| `docker-compose.yml` | Image-only deploy (`ai-agent:latest` + `ai-agent-web:latest`) |
| `nginx.conf` | Reverse proxy with SSE-friendly settings + SPA fallback |

## Workflow

### Step 1 — build the two images (manually, from repo root)

```bash
# Backend
docker build -f deploy/Dockerfile.agent -t ai-agent:latest .

# Frontend (vite build inside, output served by nginx)
docker build -f deploy/Dockerfile.web -t ai-agent-web:latest .
```

Re-run whichever side you changed. Compose looks for `ai-agent:latest`
and `ai-agent-web:latest` by default — keep those tags and you don't
have to edit the compose file.

### Step 2 — bring the stack up

```bash
docker compose -f deploy/docker-compose.yml up -d
open http://localhost:8080
```

After a rebuild, run the same `up -d` again — compose will recreate
only the container whose image digest changed.

### Logs / shell / stop

```bash
docker compose -f deploy/docker-compose.yml logs -f agent
docker compose -f deploy/docker-compose.yml exec agent bash
docker compose -f deploy/docker-compose.yml down
```

## Calling from "other internal projects"

Everything lives under one origin (`http://localhost:8080`), no CORS.

### Discover skills

```bash
curl http://localhost:8080/skills?workspace=/workspaces/projectA
```

### Invoke an inline skill (no LLM round-trip)

```bash
curl -X POST http://localhost:8080/skills/pr-author/invoke \
  -H 'Content-Type: application/json' \
  -d '{
    "workspace": "/workspaces/projectA",
    "arguments": { "audience": "eng-team" }
  }'
# → { "skill": "pr-author", "context": "inline", "result": "..." }
```

### Run a free-form task — streaming or buffered

```bash
# Streaming (SSE)
curl -N http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{ "message": "review the diff", "workspace": "/workspaces/projectA" }'

# Final JSON only
curl http://localhost:8080/chat?stream=false \
  -H 'Content-Type: application/json' \
  -d '{ "message": "summarize what changed", "workspace": "/workspaces/projectA" }'
```

For TypeScript projects, use `client-sdk/` — wraps all of the above with
proper types and an `AsyncIterable<AgentEvent>` for streaming.

## Workspace mounting

`docker-compose.yml` bind-mounts `../workspaces` into `/workspaces` inside
the agent container. Put your projects under `./workspaces/<name>` and
call the API with `"workspace": "/workspaces/<name>"`.

To point at a different host directory, edit the `agent.volumes` line:

```yaml
volumes:
  - /data/projects:/workspaces:rw   # ← your path here
```

## Config

The compose file mounts your local `~/.ai-agent` (with `config.json` —
provider keys, MCP servers, etc.) **read-only** into `/root/.ai-agent`.
If you'd rather the container ship its own config, comment out that
volume — the agent image already bakes `config.example.json` in.

## Auth — currently OFF

Both containers assume a trusted boundary. The agent's `bash` tool runs
arbitrary shell as the container user — **don't expose port 8080 to the
internet** without first:

1. Adding API-key middleware in `examples/08-basic/server/router.ts` (or
   delegating to nginx via `if ($http_x_api_key != $expected) { return 401; }`).
2. Putting the `bash` / `edit_file` / `write_file` tools on the
   `disabledTools` list in `~/.ai-agent/config.json` if callers don't
   need filesystem mutation.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|---------------------|
| `Unable to find image 'ai-agent:latest'` | You skipped Step 1 — run the `docker build` commands first |
| 502 Bad Gateway on `/chat` | `agent` container failed to start: `docker compose logs agent` |
| SSE stream feels chunky / delayed | `proxy_buffering off` got removed from `nginx.conf` |
| `workspace not found, falling back to process.cwd()` | The path you passed doesn't exist *inside the agent container* — re-check the `../workspaces` bind mount and `"workspace"` value |
| Browser shows blank page | `Dockerfile.web` build failed before `npm run build`; rerun with `docker build --no-cache -f deploy/Dockerfile.web -t ai-agent-web:latest .` |
