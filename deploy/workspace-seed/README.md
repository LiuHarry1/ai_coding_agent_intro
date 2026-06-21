# Per-user workspace seed (SSO mode)

Contents here are copied into each user's pinned workspace the **first time**
they log in (`/workspace/users/<slug>/`). Edit this tree before building the
tenant image to control what every new user starts with.

Typical layout:

```
deploy/workspace-seed/
└── .ai-agent/
    ├── skills/          # starter skills (folders with SKILL.md)
    ├── agents/          # starter subagent .md files
    ├── commands/        # optional slash commands
    └── config.json      # optional per-user defaults (MCP, tools, …)
```

## Build

The tenant Dockerfile copies this directory into the image:

```dockerfile
COPY deploy/workspace-seed/ /opt/workspace-seed/
```

Rebuild `ai-agent-tenant:latest` after changing files here.

## Runtime

| Env | Default | Meaning |
|-----|---------|---------|
| `WORKSPACE_SEED_DIR` | `/opt/workspace-seed` | Template root copied on first login |
| `WORKSPACE_SEED_DIR=""` | — | Disable seeding entirely |

Seeding is idempotent: a `.workspace-seeded` marker in the user's workspace
prevents re-copying. Existing files are never overwritten.

## Customize

- **Add** skills/agents under `.ai-agent/` — only include what new users need.
- **Remove** entries you do not want (e.g. drop `skills/loop/`).
- **Platform-wide** defaults that stay shared across users (not copied per user)
  still belong in the tenant image's `/root/.ai-agent/` via the main
  `COPY .ai-agent/` line in `Dockerfile.agent.example`.

For SSO deployments, prefer putting user-owned extensions in this seed (they
land in each user's private workspace) rather than `/root/.ai-agent/`.
