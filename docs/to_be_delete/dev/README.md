# Developer Documentation

Detailed architecture and subsystem implementation notes for Coding Agent
maintainers. User-facing material lives in [`readme/`](../readme/).

## Memory and context

| Document | Purpose |
|---|---|
| [Memory system guide](memory/agent-memory-guide.md) | Canonical Auto Memory, Session Memory, Rules, and Compaction behavior |
| [One-message memory flow](memory/memory-flow-simplified.md) | Beginner-friendly diagram and recall-lane decisions |

## Remote execution

| Document | Purpose |
|---|---|
| [Execution architecture](remote/execution-architecture.md) | Current remote execution-plane architecture |
| [SSH architecture](remote/ssh-architecture.md) | Superseded design note; retained for history |
| [Execution visual guide](html/agent-remote-execution-architecture.html) | Standalone HTML diagrams |
| [SSH visual guide](html/agent-remote-ssh-architecture.html) | Standalone HTML diagrams |

## Browser automation

| Document | Purpose |
|---|---|
| [Automation comparison](browser/automation-comparison.md) | Comparison of browser automation approaches |

## Shell and tasks

| Document | Purpose |
|---|---|
| [Background task system](shell/bash-task-system.md) | Long-running Bash task lifecycle |
| [Tool execution](shell/tool-execution.md) | Shell execution path |
| [Output file descriptor](shell/output-file-fd.md) | File-FD output design |
| [Task visual guide](html/bash-task-system.html) | Standalone HTML diagrams |

## Worker

- [Phase B Worker](worker/phase-b-worker.md)

## Standalone visual guides

The HTML guides can be opened directly in a browser:

- [System architecture](html/coding-agent-architecture-guide.html)
- [Three-tier model architecture](html/three-tier-model-architecture.html)
- [Deferred MCP/tools/skills](html/deferred-mcp-tools-skills-guide.html)
- [Session compaction](html/session-compacting-guide.html)
- [Skill loading](html/skill-loading-guide.html)
- [Subagent loading](html/subagent-loading-guide.html)
- [LSP architecture](html/lsp-architecture-guide.html)
- [LLM message mapping](html/llm-message-mapping-guide.html)
- [Web search](html/web-search-guide.html)
- [Runtime landscape](html/runtime-landscape.html)

## Related material

- [Consolidated architecture](../architecture/)
- [Source map](../reference/source-map.md)
- [Upstream comparisons](../reference/)
- [Architecture presentation](../presentation/index.html)
