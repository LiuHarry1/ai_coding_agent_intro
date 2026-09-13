# Permissions

Last verified: 2026-09-13

## Overview

Filesystem permissions protect FileRead, Grep, Glob, LSP, FileEdit, and FileWrite operations. They are separate from the session's Agent, Ask, and Plan interaction modes.

## How it works

Every candidate path is checked both lexically and through its real path, or the nearest existing real ancestor for a new file. Deny rules run first. The workspace, session “Always allow” directories, and selected internal read/write roots are then allowed. Remaining paths may match an allow rule, prompt the desktop user, or be denied according to `defaultMode`.

`default` asks for out-of-workspace access and supports Allow, Always allow, or Reject. `dontAsk` turns unresolved prompts into denials. `bypassPermissions` allows outside paths, but explicit deny rules still win. An unanswered prompt times out after five minutes.

## Configuration

```json
{
  "permissions": {
    "defaultMode": "default",
    "additionalDirectories": ["../shared"],
    "allow": ["Read(docs/**)", "Edit(src/generated/**)"],
    "deny": ["Read(.env)", "Edit(.env)", "Write(.env)"]
  }
}
```

Rules use `Tool` or `Tool(pattern)`. `Read` rules also apply to Grep, Glob, and LSP; Edit and Write rules apply across both write tools. A single leading slash is project-relative; `~/`, drive-letter, and UNC patterns are filesystem-absolute. `PERMISSION_EXTRA_READ_ROOTS` adds comma-separated read roots; deprecated `SANDBOX_EXTRA_READ_ROOTS` is the fallback.

When `AUTH_ENABLED=true`, the effective mode is always `dontAsk`; `allow` and `additionalDirectories` are ignored, while `deny` remains active.

## Failure modes and security notes

- “Always allow” persists a directory to user settings when possible and also updates the current session. Persistence failure is logged, but the current decision still succeeds.
- Symlink targets are checked to prevent an allowed-looking path from escaping the boundary.
- Legacy `acceptEdits` and `plan` values are accepted with a warning and treated as `default`.
- This is application-level enforcement for filesystem tools and workspace HTTP operations. Bash or PowerShell can still access absolute paths unless separately sandboxed; do not treat these rules as tenant isolation.
- Only tools that implement `checkPermissions` pass through this gate.

## Source map

- `src/utils/permissions/filesystem.ts` — path resolution and allow/ask/deny policy.
- `src/utils/permissions/permission-rules.ts` — rule parsing and pattern matching.
- `src/core/can-use-tool.ts` — prompts, timeout, and Always allow handling.
- `src/core/settings-schema.ts` — validated settings.
- `src/core/permission-mode.ts` — Agent, Ask, and Plan session modes.
- `deploy/README.md` — deployment-specific SSO boundary and limitations.
