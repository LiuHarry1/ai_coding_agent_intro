# Glossary

**Coding Agent**  
The product and repository described by this site. “Baize” and “白泽” are
legacy names that still appear in older documents and paths.

**Turn**  
One user request and all agent steps required to finish it.

**Step**  
One model inference followed by any requested tool execution. A turn may have
many steps.

**Primary Agent**  
The profile driving the main turn, such as the general coding profile or the
Browser specialist.

**Subagent**  
A forked agent with a focused prompt and tool set. It reports its result to the
primary agent.

**Project Rules**  
Managed, user, project, and local instruction files. `AGENTS.md` is the main
entry filename. Conditional rules use `paths:` frontmatter.

**Auto Memory**  
Project-scoped, cross-session topic files recalled by fast and semantic lanes
and updated at successful turn end.

**Session Memory**  
`summary.md` and state for one session. It is an incremental work ledger used
mainly by Session Memory compaction.

**Compaction**  
Reduction of the active model context. Coding Agent tries Micro-compaction,
then Session Memory compact, then Full LLM compact.

**Active model projection**  
The messages the model sees after the latest compact boundary and in-process
Micro-compaction are applied. The persisted transcript remains append-only.

**Wire protocol**  
The transport-neutral message contract in `protocol/`, shared by HTTP/SSE,
stdio, and ACP adapters.

**Execution plane**  
The runtime broker, providers, and workers that execute filesystem, shell, and
LSP operations locally or over SSH.

**HITL**  
Human in the loop. A control request that asks the user to approve a tool,
answer a question, approve a plan, or change mode.

**MCP**  
Model Context Protocol. External tools may be connected through stdio or HTTP
and exposed to the agent eagerly or through deferred discovery.

**Last verified:** 2026-09-13
