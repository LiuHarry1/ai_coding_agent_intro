# Deployment

Last verified: 2026-09-13

## Overview

The repository supports local Node/Web development, Electron packaging, and containerized Web deployment. Docker uses separate web and agent images, plus an optional analytics image. Two Compose modes are maintained: admin and SSO.

## How it works

The web container serves the built SPA through nginx. The agent container serves the headless API on port 4567 and persists workspaces, sessions, and process data through mounted volumes. The tenant image layers managed policy and a workspace seed over the reusable agent base image.

Admin mode applies Basic Auth only to the web origin and leaves the agent API unauthenticated. SSO mode verifies HS256 bearer JWTs using the shared `JWT_SECRET`, pins each regular user to `/workspace/users/<slug>`, seeds that directory on first use, and can depend on analytics for quota checks. Desktop builds bundle the web UI, worker, agent runtime, and native agent artifact before Electron packaging.

## Configuration

Build the container images:

```bash
docker build -f deploy/Dockerfile.agent-base -t ai-agent-base:latest .
docker build -f deploy/Dockerfile.agent-tenant --build-arg BASE_TAG=latest -t ai-agent-tenant:latest .
docker build -f deploy/Dockerfile.web -t ai-agent-web:latest .
```

Start one mode:

```bash
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.sso.yml --env-file deploy/.env up -d
```

Important values include `FRONTEND_ORIGIN`, `AGENT_PUBLIC_URL`, ports, provider keys, and workspace mounts. Admin adds `WEB_USERNAME` and `WEB_PASSWORD`. SSO requires `JWT_SECRET`, `AUTH_PUBLIC_URL`/`AUTH_BASE`, and correct return/CORS origins in the external auth service. Managed settings and extensions are installed below `/etc/ai-agent` by default; secrets belong in environment variables, not images or workspace seeds.

For desktop:

```bash
npm run desktop:dev
npm run desktop:pack
```

## Failure modes and security notes

- Never expose the admin-mode agent port directly to the public Internet; the web password does not protect that API.
- Use HTTPS for production origins, and keep `FRONTEND_ORIGIN`, agent CORS, API base, and auth return origins consistent.
- SSO pinning and File-tool checks are application-layer controls; Bash is not OS-isolated. Use container/host controls for strong tenant isolation.
- Persist both workspace data and `/app/.ai-agent` process data when scheduled tasks must survive container recreation.
- Existing seeded user directories are not automatically rewritten when the image's workspace seed changes.
- Health checks cover HTTP liveness, not provider credentials, model reachability, or correctness of external SSO configuration.

## Source map

- `deploy/README.md` — image build, admin/SSO setup, mounts, and troubleshooting.
- `deploy/docker-compose.admin.yml` — admin services and environment.
- `deploy/docker-compose.sso.yml` — SSO, analytics, and tenant workspace setup.
- `deploy/Dockerfile.agent-base` — reusable agent runtime image.
- `deploy/Dockerfile.agent-tenant` — managed policy and seed layer.
- `deploy/Dockerfile.web` — static web image.
- `electron/agent-launch.mjs` — desktop runtime and seed lookup.
- `package.json` — desktop build and packaging pipeline.
