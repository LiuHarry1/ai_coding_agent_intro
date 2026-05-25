# `deploy/` — Three-image deployment (agent-base + agent-tenant + web)

The backend is split into **two layered images**:

- `ai-agent-base:<tag>` — Node + Python + agent code + deps. Slow to
  build (~minutes), rarely changes. Published once per agent-code
  release.
- `ai-agent-tenant:<tag>` — `FROM ai-agent-base`, with a single project's
  `.ai-agent/` (`config.json`, agents, skills, slash commands) baked in.
  Trivially small layer on top, rebuilds in seconds whenever the config
  changes.

Plus the frontend, which is a separate image:

- `ai-agent-web:<tag>` — `nginx:alpine` with the vite-built UI dist and
  a reverse proxy to the agent service.

```
                ┌──────────────────────────────────────────┐
   browser ────▶│  nginx :80  →  agent :4567               │
   curl    ────▶│  (UI dist + reverse proxy)               │
   project ────▶│         ai-agent-tenant                  │
                │     └─ FROM ai-agent-base                │
                └──────────────────────────────────────────┘
                            │
                  /workspace/...   ← bind-mounted host project tree
```

Only port `8080` is published. The agent's `4567` is internal-only.

## Files

| File | Role |
|------|------|
| `Dockerfile.agent-base` | Slow-changing base image (agent runtime + code, no config). |
| `Dockerfile.agent.example` | Tenant template — `FROM ai-agent-base` + `COPY .ai-agent/`. |
| `tenant-example/` | Sample tenant build context (`.ai-agent/config.json` skeleton + README). |
| `Dockerfile.web` | Multi-stage: vite build → `nginx:alpine`. |
| `docker-compose.yml` | Image-only deploy (`ai-agent-tenant:latest` + `ai-agent-web:latest`). |
| `nginx.conf` | Reverse proxy with SSE-friendly settings + SPA fallback. |

## Workflow

### Step 1 — build the base image (slow, only when agent code changes)

```bash
docker build -f deploy/Dockerfile.agent-base -t ai-agent-base:latest .
```

Tag with a real version (`ai-agent-base:1.2.3`) and push to your
registry so tenant images can pin to it. The downstream
`Dockerfile.agent.example` accepts a `BASE_TAG` build arg for exactly
this reason.

### Step 2 — build the tenant image (fast, on every config change)

Edit `deploy/tenant-example/.ai-agent/` (or your own copy of it) to taste,
then:

```bash
docker build -f deploy/Dockerfile.agent.example \
  --build-arg BASE_TAG=latest \
  -t ai-agent-tenant:latest \
  deploy/tenant-example
```

Rebuilds are ~seconds because `npm ci` / `pip install` / `apt-get` all
live in the base layer.

### Step 3 — build the frontend

```bash
docker build -f deploy/Dockerfile.web -t ai-agent-web:latest .
```

### Step 4 — bring the stack up

```bash
docker compose -f deploy/docker-compose.yml up -d
open http://localhost:8080
```

After re-running any of the build steps above, run `up -d` again —
compose recreates only the container whose image digest changed.

### Logs / shell / stop

```bash
docker compose -f deploy/docker-compose.yml logs -f agent
docker compose -f deploy/docker-compose.yml exec agent bash
docker compose -f deploy/docker-compose.yml down
```

## Secrets — keep them OUT of the tenant image

`docker history` makes COPY layers recoverable, so **never bake API
keys into `.ai-agent/config.json`**. The pattern is:

1. `config.json` in the tenant image contains only non-secret fields
   (provider id, baseURL, model name, MCP server URLs, skills,
   compaction tuning).
2. Secrets travel through the container env. `docker-compose.yml`
   already forwards `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
   `DEEPSEEK_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` from the host
   (typically out of a `.env` file beside the compose file).
3. The agent reads them directly from `process.env` (the AI SDK
   provider clients pick them up automatically when no explicit
   `apiKey` is set in config).

For Docker Swarm / Kubernetes, prefer Docker secrets / K8s secrets
mounted as env or files — same idea, just a different transport.

## Workspace mounting

The agent has a configurable **default workspace** plus optional
per-request overrides. Resolution at boot:

1. CLI flag: `node start.js 08-basic --workspace=/abs/path`
2. Env var: `WORKSPACE=/abs/path` (this is how the container is wired —
   set in `Dockerfile.agent-base` to `/workspace`).
3. Fallback: the directory the server was started from.

`docker-compose.yml` bind-mounts `../workspaces` (host) → `/workspace`
(container). Put your projects under `./workspaces/<name>` and call
the API with `"workspace": "/workspace/<name>"`, or omit `workspace`
to use the container's default.

To point at a different host directory, edit the `agent.volumes`
line:

```yaml
volumes:
  - /data/projects:/workspace:rw   # ← your path here
```

### Read/write boundary

| Tool | In workspace | Outside workspace |
|------|--------------|-------------------|
| `read_file`, `glob`, `grep` | yes | yes |
| `bash` (read-only commands: `ls`, `cat`, `git log`, …) | yes | yes |
| `bash` (writes / `>` / `rm` / `mv`) | yes | **not enforced at app layer — rely on the Docker mount being the only writable host path** |
| `write_file`, `edit_file` | yes | rejected with a clear error |

If you need stronger isolation for `bash` writes than "Docker mount =
sandbox", see the TODO in `examples/08-basic/tools/bash.ts` for the
shell-AST analyzer approach (port of cc's `pathValidation.ts`).

## Calling from "other internal projects"

Everything lives under one origin (`http://localhost:8080`), no CORS.

### Discover skills

```bash
curl http://localhost:8080/skills?workspace=/workspace/projectA
```

### Invoke an inline skill (no LLM round-trip)

```bash
curl -X POST http://localhost:8080/skills/pr-author/invoke \
  -H 'Content-Type: application/json' \
  -d '{
    "workspace": "/workspace/projectA",
    "arguments": { "audience": "eng-team" }
  }'
# → { "skill": "pr-author", "context": "inline", "result": "..." }
```

### Run a free-form task — streaming or buffered

```bash
# Streaming (SSE)
curl -N http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{ "message": "review the diff", "workspace": "/workspace/projectA" }'

# Final JSON only
curl http://localhost:8080/chat?stream=false \
  -H 'Content-Type: application/json' \
  -d '{ "message": "summarize what changed", "workspace": "/workspace/projectA" }'
```

For TypeScript projects, use `client-sdk/` — wraps all of the above with
proper types and an `AsyncIterable<AgentEvent>` for streaming.

## Auth — currently OFF

Both containers assume a trusted boundary. The agent's `bash` tool runs
arbitrary shell as the container user — **don't expose port 8080 to the
internet** without first:

1. Adding API-key middleware in `examples/08-basic/server/router.ts` (or
   delegating to nginx via `if ($http_x_api_key != $expected) { return 401; }`).
2. Putting the `bash` / `edit_file` / `write_file` tools on the
   `disabledTools` list in your tenant's `.ai-agent/config.json` if
   callers don't need filesystem mutation.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|---------------------|
| `Unable to find image 'ai-agent-base:latest'` | Step 1 was skipped — base image must be built before any tenant image. |
| `Unable to find image 'ai-agent-tenant:latest'` | Step 2 was skipped — run the tenant build after editing `.ai-agent/`. |
| 502 Bad Gateway on `/chat` | `agent` container failed to start: `docker compose logs agent`. |
| SSE stream feels chunky / delayed | `proxy_buffering off` got removed from `nginx.conf`. |
| `workspace not found, falling back to ...` | The path passed in the request body doesn't exist *inside* the container — re-check the `../workspaces` bind mount and the `"workspace"` value. |
| Provider returns 401 / "missing API key" | Host env var not forwarded — check `OPENAI_API_KEY` (or equivalent) is set in your shell / `.env` beside the compose file. |
| Browser shows blank page | `Dockerfile.web` build failed before `npm run build`; rerun with `docker build --no-cache -f deploy/Dockerfile.web -t ai-agent-web:latest .` |
