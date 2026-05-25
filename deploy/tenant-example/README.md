# `deploy/tenant-example/` — sample tenant build context

This directory is a **starter** for the tenant Docker image. Copy it to
your own deployment repo (or just edit in place) and customize the
`.ai-agent/` contents for your project, then build with:

```bash
# from the repo root
docker build -f deploy/Dockerfile.agent.example \
  --build-arg BASE_TAG=latest \
  -t ai-agent-tenant:latest \
  deploy/tenant-example
```

## What goes in `.ai-agent/`

| Path | Purpose |
|------|---------|
| `config.json` | Provider, MCP servers, compaction tuning, disabled tools. **No API keys.** |
| `agents/*.md` | Project-specific subagent definitions (markdown frontmatter + system prompt). |
| `skills/*.md` | Slash-command-invocable skills (`/skill-name`). |
| `commands/*.md` | Plain slash-command templates. |

Anything missing falls back to the agent's built-in defaults. Empty
directories are fine.

## What does NOT go here

- **API keys / OAuth tokens / bearer tokens.** Reference them by env-var
  name in `config.json` and pass them via `docker run -e ...` or compose
  `environment:` — see the top-level `deploy/README.md` for the pattern.
- **Workspace files / project source code.** Bind-mount those at
  runtime onto `/workspace` (see `deploy/docker-compose.yml`).
