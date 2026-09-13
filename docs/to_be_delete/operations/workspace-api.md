# Workspace IDE API

The Web UI uses a workspace HTTP surface for IDE-like operations that are
separate from the conversational tool protocol.

## Capabilities

- Browse directories and read files.
- Write, create, rename, and delete workspace entries.
- Inspect Git status and diffs.
- Preview supported files.
- Upload and download files.

These routes resolve the same session workspace and execution backend used by
the agent. A session bound to SSH therefore operates on the remote filesystem
rather than silently falling back to local disk.

## Security model

- Paths are resolved under the selected workspace.
- Session ownership and request authentication are enforced by the server.
- File operations use the execution backend, preserving local/remote
  isolation.
- Upload and download limits should be enforced at the HTTP boundary.

## Source map

- `src/server/workspace/router.ts`
- `src/server/workspace/fs-ops.ts`
- `src/server/workspace/git.ts`
- `src/server/workspace/preview.ts`
- `src/server/workspace/transfer.ts`
- `src/execution/resolve-backend.ts`

**Last verified:** 2026-09-13
