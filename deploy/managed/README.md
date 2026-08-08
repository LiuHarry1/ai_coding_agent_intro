# `deploy/managed/` — enterprise / policy bake (CC `getManagedFilePath`)

Contents are copied into the tenant image at **`/etc/ai-agent/`**.

```
deploy/managed/
  AGENTS.md                 → /etc/ai-agent/AGENTS.md
  .ai-agent/
    skills/ agents/ commands/ rules/
```

`managed-settings.json` is **not** stored here by default: the Dockerfile still
bakes repo `.ai-agent/settings.json` → `/etc/ai-agent/managed-settings.json`
so tenant model/MCP config stays in one place.

Put **only** platform-wide skills/agents/commands/rules under this tree.
User-visible templates belong in `deploy/workspace-seed/`.
