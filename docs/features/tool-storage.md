# Large Tool Outputs

Large tool results should remain available without occupying the model context
on every later step. Coding Agent uses a claim-check pattern: keep a compact
reference in the conversation and persist the full payload in tool storage.

## Data flow

1. A tool produces a result.
2. The execution layer measures the payload.
3. Large content is written to session-scoped tool storage.
4. The model receives a bounded preview and a persisted-output reference.
5. A later read can recover the full output when it is actually needed.

Micro-compaction can also offload large results before clearing them. This
preserves recoverability while reducing the active model projection.

## Why it matters

- Prompt-cache prefixes remain stable.
- One verbose command does not dominate every following request.
- The UI and persisted session can retain access to details independently of
  what the model sees.

## Failure modes

- Persisted output is session data; references should not be treated as
  portable paths.
- Storage cleanup and session ownership rules still apply.
- A model should read the full payload only when the preview is insufficient.

## Source map

- `src/services/tool-storage/index.ts`
- `src/services/tools/tool_execution.ts`
- `src/services/compact/microCompact.ts`
- `src/utils/task/diskOutput.ts`

**Last verified:** 2026-09-13
