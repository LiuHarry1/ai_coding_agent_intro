# 开发文档

面向维护 Baize agent 的开发者：架构、子系统实现、图解说明。

用户安装与使用文档见 [guide/](../guide/)。

---

## 按主题

### 记忆

| 文档 | 说明 |
|------|------|
| [agent-memory-guide.md](memory/agent-memory-guide.md) | Session / Auto memory 入门与代码地图 |

### 远程执行

| 文档 | 说明 |
|------|------|
| [ssh-architecture.md](remote/ssh-architecture.md) | 远程 SSH workspace 架构 |
| [execution-architecture.md](remote/execution-architecture.md) | 远程执行平面架构 |
| [html/agent-remote-ssh-architecture.html](html/agent-remote-ssh-architecture.html) | SSH 架构图解 |
| [html/agent-remote-execution-architecture.html](html/agent-remote-execution-architecture.html) | 远程执行图解 |

### 浏览器

| 文档 | 说明 |
|------|------|
| [automation-comparison.md](browser/automation-comparison.md) | 各家浏览器自动化方案对比 |

### Shell / 任务

| 文档 | 说明 |
|------|------|
| [bash-task-system.md](shell/bash-task-system.md) | Bash 后台任务系统 |
| [tool-execution.md](shell/tool-execution.md) | Shell 工具执行 |
| [html/bash-task-system.html](html/bash-task-system.html) | 任务系统图解 |

### Worker

| 文档 | 说明 |
|------|------|
| [phase-b-worker.md](worker/phase-b-worker.md) | Phase B Worker 设计 |

---

## 图解 HTML（html/）

在浏览器中直接打开阅读：

| 文件 | 主题 |
|------|------|
| [coding-agent-architecture-guide.html](html/coding-agent-architecture-guide.html) | 整体架构 SVG |
| [three-tier-model-architecture.html](html/three-tier-model-architecture.html) | 三档模型 |
| [deferred-mcp-tools-skills-guide.html](html/deferred-mcp-tools-skills-guide.html) | Deferred / ToolSearch |
| [session-compacting-guide.html](html/session-compacting-guide.html) | 上下文压缩 |
| [skill-loading-guide.html](html/skill-loading-guide.html) | Skill 加载 |
| [subagent-loading-guide.html](html/subagent-loading-guide.html) | Subagent 加载 |
| [lsp-architecture-guide.html](html/lsp-architecture-guide.html) | LSP 架构 |
| [llm-message-mapping-guide.html](html/llm-message-mapping-guide.html) | LLM 消息映射 |
| [web-search-guide.html](html/web-search-guide.html) | Web 搜索 |
| [runtime-landscape.html](html/runtime-landscape.html) | 运行时全景 |

---

## 参考与演示

- Claude Code 对标：[reference/claude-code/](../reference/claude-code/)
- 架构演示：[presentation/](../presentation/)
- Agent 源码入口：[src/README.md](../../src/README.md)
