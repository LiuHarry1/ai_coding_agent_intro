# `deploy/managed/` — enterprise / policy bake (CC `getManagedFilePath`)

Contents are copied into the tenant image at **`/etc/ai-agent/`**.

```
deploy/managed/
  managed-settings.json     → /etc/ai-agent/managed-settings.json
  AGENTS.md                 → /etc/ai-agent/AGENTS.md
  .ai-agent/
    skills/ agents/ commands/ rules/
```

Put **only** platform-wide policy here. Local/dev config stays in repo
`.ai-agent/settings.json` and is **not** baked into the tenant image.

User-visible templates belong in `deploy/workspace-seed/`.
