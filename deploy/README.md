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

Edit the repo's `.ai-agent/` (or your own deployment copy) to taste,
then build from the repo root (the build context must contain `.ai-agent/`):

```bash
docker build -f deploy/Dockerfile.agent.example \
  --build-arg BASE_TAG=latest \
  -t ai-agent-tenant:latest \
  .
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

## Web preview (generated apps)

When deployed via Docker Compose, the stack exposes dev servers that the
agent starts inside the `agent` container. Users test them through the
same origin as the UI — no extra host ports.

```
https://your-domain.com/preview/5173/   →  Vite frontend (agent:5173)
https://your-domain.com/preview/3000/   →  API server   (agent:3000)
```

### Configuration

Set in a `.env` file beside `docker-compose.yml` (or export in your shell):

```bash
PUBLIC_BASE_URL=https://your-domain.com
```

`PREVIEW_ENABLED=1` is already set in `docker-compose.yml` for the
`agent` service. The agent registers a `PublishPreview` tool and adds
cloud-only prompt rules. **Local `npm start` does not set these vars** —
preview stays off.

Optional tuning on the `agent` service:

| Variable | Default | Role |
|----------|---------|------|
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Origin users open in the browser |
| `PREVIEW_PATH_PREFIX` | `/preview` | URL path prefix before the port |
| `PREVIEW_PORT_MIN` / `MAX` | `3000` / `9999` | Allowed preview port range |
| `PREVIEW_BLOCKED_PORTS` | (4567) | Extra blocked ports, comma-separated |

### Agent workflow

1. Start a dev server with `Bash` (`background: true`), binding `0.0.0.0`.
2. Call `PublishPreview` with the port number.
3. Give the returned URL to the user (never `localhost`).

Rebuild the **web** image after changing `nginx.conf`; rebuild the
**tenant** image after agent code changes.

## Deployment modes

Pick a compose file per mode — all share the same agent/web images; behavior
is toggled by env, so no rebuild is needed to switch.

| Mode | Compose file | Auth | Workspace |
|------|--------------|------|-----------|
| **1. Shared password** | `docker-compose.password.yml` | One Basic-Auth password (nginx) | Free switching |
| **2. Local / no auth** | *(none — run `npm start`)* | None | Free switching |
| **3. SSO + pinned** | `docker-compose.sso.yml` | Per-user login via auth-service (JWT) | Pinned per user, no switching |

```bash
# Mode 1
docker compose -f deploy/docker-compose.password.yml up -d
# Mode 3
docker compose -f deploy/docker-compose.sso.yml --env-file deploy/.env up -d
```

### Mode 3 — SSO + per-user workspace (how it works)

The auth-service is deployed **separately** (you already run one). This stack
is just agent + web; nginx reverse-proxies the auth routes to it.

```
browser ─▶ nginx ─┬─ /              SPA (RequireAuth → /sso/authorize)
                  ├─ /sso/* /api/auth/*  → AUTH_SERVICE_URL (external auth-service)
                  └─ /chat /workspace/* → agent (verifies JWT, pins cwd)
```

1. The SPA (auth on via `AUTH_ENABLED=true` → `app-config.js`) has no token,
   so it redirects to `/sso/authorize`. The auth-service logs the user in and
   bounces back with `#token=<jwt>`.
2. The SPA stores the JWT and sends `Authorization: Bearer <jwt>` on every
   agent call.
3. The agent (`server/auth/identity.ts`) **verifies** the token with the
   shared `JWT_SECRET` (no DB, no network), then derives a fixed workspace
   `${USERS_ROOT}/<slug(email)>`, creating it on first use. The client's
   `workspace` field is ignored, and `/workspace/*` is sandboxed to that
   directory.

Required env (put in `deploy/.env`):

| Variable | Where | Notes |
|----------|-------|-------|
| `JWT_SECRET` | agent | **Must equal your auth-service's signing secret** — the trust anchor |
| `AUTH_SERVICE_URL` | web | Your external auth-service, e.g. `http://10.150.115.69:52320` |
| `PUBLIC_ORIGIN` | web/agent | Origin users open, e.g. `http://10.150.117.195:9999` (default `http://localhost:8080`) |
| `WEB_PORT` | web | Host port to publish (default `8080`) |

On the **external auth-service**, add `PUBLIC_ORIGIN` to both
`SSO_ALLOWED_RETURN_ORIGINS` and `CORS_ALLOWED_ORIGINS`, otherwise the SSO
redirect back to the UI is rejected (400). Email-domain / admin settings
(`ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`) are configured there too.

> **Isolation note (L1):** pinning is enforced for the UI and the workspace
> API, but the `bash`/`powershell` tools can still read/write elsewhere in
> the container. This suits mutually-trusting users who just want their own
> working directory. For untrusted multi-tenant use, run one agent container
> per user or disable the shell tools.

## Auth — optional password gate (HTTP Basic Auth)

The `web` image ships an **optional password gate** enforced by nginx. It
sits in front of *everything* the browser can reach — the UI, the agent
API proxy (`/chat`, `/sessions`, …) and the `/preview/*` routes — so no
request reaches the coding agent until the visitor authenticates.

### Enable it

Set `WEB_PASSWORD` (and optionally `WEB_USERNAME`) when bringing the stack
up. The simplest way is a `.env` file beside `docker-compose.yml`:

```bash
WEB_USERNAME=admin        # optional, defaults to "admin"
WEB_PASSWORD=super-secret # set this → login required; leave empty → open
```

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Open `http://localhost:9999` and the browser prompts for the
username/password before the app loads. Enter them once and the browser
replays the credentials on every subsequent request (page loads, `/chat`
fetches, the SSE stream, previews) — all same-origin, so it "just works".

### How it works

- It's a **runtime** setting, not a build arg: the password is read from
  the container env on startup by `deploy/web-auth.sh` (installed at
  `/docker-entrypoint.d/40-web-auth.sh`), which hashes it with `htpasswd`
  (bcrypt) into `/etc/nginx/.htpasswd` and writes the `auth_basic`
  directives into `auth.inc`. nginx then includes that snippet at server
  scope (see `nginx.conf`).
- **Rotate the password** by changing `WEB_PASSWORD` and re-running
  `docker compose up -d` — no image rebuild, and the secret never lands in
  `docker history` (build args would).
- Leaving `WEB_PASSWORD` empty produces an empty `auth.inc`, so local dev
  stays open exactly as before.
- `/healthz` is explicitly exempt (`auth_basic off;`) so the Docker
  HEALTHCHECK keeps passing once a password is set.

> Basic Auth protects *access*, but credentials are only base64-encoded on
> the wire. **Always pair it with HTTPS** (terminate TLS in a
> traefik/caddy/cloud-LB sidecar in front of nginx) when exposing the
> stack beyond a trusted network.

### Defense in depth (still recommended for internet exposure)

The agent's `bash` tool runs arbitrary shell as the container user, so the
password gate is a perimeter, not a sandbox. For anything internet-facing,
also consider:

1. A second auth layer on the API (API-key middleware in
   `examples/08-basic/server/router.ts`, or an nginx
   `if ($http_x_api_key != $expected) { return 401; }`).
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
| Preview URL 502 / connection refused | Dev server not listening on `0.0.0.0`, or wrong port — check `docker compose logs agent` and re-run `PublishPreview`. |
| Preview URL 403 | Port is blocked (e.g. 4567) — use a port in 3000–9999 outside the blocklist. |
| Agent suggests localhost | `PUBLIC_BASE_URL` unset or `PREVIEW_ENABLED` not `1` — verify agent container env. |
