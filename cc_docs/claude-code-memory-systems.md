# Claude Code 记忆系统详解

> 基于源码目录：`/Users/harry/cursor_workspace/public_repo/claude-code-rev`  
> 核心代码位于 `src/memdir/`、`src/utils/claudemd.ts`、`src/tools/AgentTool/agentMemory*.ts`、`src/services/SessionMemory/`、`src/services/extractMemories/`、`src/services/autoDream/`  
> 文档生成日期：2026-07-26

---

## 1. 概述

Claude Code（以下简称 CC）的「记忆」不是单一模块，而是**多层、多生命周期**的持久化上下文系统。按职责可分成六大类：

| # | 系统 | 生命周期 | 主要用途 | 核心路径 |
|---|------|----------|----------|----------|
| 1 | **Instructions Memory（CLAUDE.md）** | 跨会话，人工维护 | 指令/规范，始终注入上下文 | `src/utils/claudemd.ts` |
| 2 | **Auto Memory（memdir）** | 跨会话，自动 + 手动写入 | 用户画像、反馈、项目事实、外部指针 | `src/memdir/` |
| 3 | **Team Memory** | 跨会话，团队同步 | 项目级共享记忆（Auto Memory 子目录） | `src/memdir/teamMemPaths.ts` |
| 4 | **Agent Memory** | 跨会话，按 agent 隔离 | 子 Agent 专属持久记忆 | `src/tools/AgentTool/agentMemory.ts` |
| 5 | **Session Memory** | 单会话 | 对话笔记，供 compact 续接 | `src/services/SessionMemory/` |
| 6 | **Recall / Extract / Dream** | 运行时流水线 | 检索、抽取、夜间整理 | `findRelevantMemories` / `extractMemories` / `autoDream` |

另外还有 **KAIROS daily log**（长会话 append-only 日志）作为 Auto Memory 的变体写入模式。

源码里 `MemoryType` 有两套含义，不要混淆：

1. **指令文件类型**（`src/utils/memory/types.ts`）：`User | Project | Local | Managed | AutoMem | TeamMem`
2. **Auto Memory 内容类型**（`src/memdir/memoryTypes.ts`）：`user | feedback | project | reference`

---

## 2. 架构总览

```
会话启动
  │
  ├─ getMemoryFiles()          ← CLAUDE.md 层级 + MEMORY.md 入口
  │     └─ getClaudeMds()      ← 注入 user context（指令）
  │
  ├─ loadMemoryPrompt()        ← 系统提示词中的「如何读写记忆」指南
  │
  └─ Agent spawn 时
        └─ loadAgentMemoryPrompt()  ← 子 agent 专属 MEMORY.md

每轮用户输入
  │
  └─ startRelevantMemoryPrefetch()
        └─ findRelevantMemories()   ← Sonnet 从 topic 文件选最多 5 条
              └─ relevant_memories attachment 注入对话

主 agent 回合结束（stop hooks）
  │
  ├─ extractMemories（若主 agent 本轮没直接写记忆）
  │     └─ forked agent → 写入 auto/team memory 目录
  │
  └─ Session Memory post-sampling hook（阈值满足时）
        └─ forked agent → Edit session-memory/summary.md

后台 / 定时
  └─ autoDream（时间 + 会话数门槛）
        └─ /dream 风格整理：日志 → topic 文件 + MEMORY.md

压缩（compact）
  └─ Session Memory Compact 优先用 summary.md 代替整段 LLM 总结
```

---

## 3. Instructions Memory（CLAUDE.md 体系）

这是用户最熟悉的「记忆」：人工编写的指令文件，**会话一开始就整文件注入**，优先级高于模型默认行为。

### 3.1 四级层级（由低到高优先级）

加载顺序见 `claudemd.ts` 文件头注释：先加载低优先级，后加载高优先级（模型更关注靠后的内容）。

| 类型 | 路径示例 | 作用域 | 是否进 VCS |
|------|----------|--------|------------|
| **Managed** | macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux: `/etc/claude-code/CLAUDE.md` | 全机策略 | 管理员部署 |
| **User** | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md` | 用户全局 | 否 |
| **Project** | `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`（从 CWD 向上遍历） | 仓库 / 目录 | 通常是 |
| **Local** | `CLAUDE.local.md`（从 CWD 向上遍历） | 本机项目私有 | 通常 gitignore |

路径解析：`src/utils/config.ts` → `getMemoryPath()`。

### 3.2 发现与合并规则

- 从当前工作目录向上走到文件系统根，收集 Project / Local。
- 离 CWD 越近的文件越晚加载 → 更高优先级。
- 嵌套 git worktree 会跳过主仓库重复的 Project 文件，避免同一份 `CLAUDE.md` 加载两次；`CLAUDE.local.md` 仍从主仓加载。
- 支持 `@path` / `@./rel` / `@~/...` / `@/abs` **include**；仅文本扩展名；防循环。
- 可用 `claudeMdExcludes` 排除 User/Project/Local 路径。
- `--add-dir` 目录下的 CLAUDE.md 需 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 开启。

### 3.3 注入方式

`getClaudeMds(memoryFiles)` 拼出：

> Codebase and user instructions are shown below... IMPORTANT: These instructions OVERRIDE any default behavior...

单文件建议上限：`MAX_MEMORY_CHARACTER_COUNT = 40000`（`/status` 会提示过大文件）。

用户通过 **`/memory`** 命令打开 `MemoryFileSelector`，用 `$EDITOR` / `$VISUAL` 编辑这些文件。

---

## 4. Auto Memory（自动记忆 / memdir）

跨会话的**结构化主题记忆**，与 CLAUDE.md 指令分离：只存「无法从当前代码/git 推导」的上下文。

### 4.1 存储路径

默认：

```
~/.claude/projects/<sanitized-canonical-git-root>/memory/
├── MEMORY.md          # 索引（入口，常驻上下文）
├── user_role.md       # 主题文件示例
├── feedback_*.md
├── project_*.md
├── reference_*.md
├── team/              # Team Memory（feature TEAMMEM）
│   └── MEMORY.md
└── logs/YYYY/MM/YYYY-MM-DD.md   # KAIROS 日日志模式
```

解析顺序（`getAutoMemPath()`）：

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`（全路径覆盖）
2. settings 中 `autoMemoryDirectory`（仅 policy/local/user；**禁止** projectSettings，防恶意仓库劫持）
3. `<memoryBase>/projects/<sanitized-git-root>/memory/`  
   - `memoryBase` = `CLAUDE_CODE_REMOTE_MEMORY_DIR` 或 `~/.claude`  
   - 同一 git 仓库的 worktree 共享同一目录（`findCanonicalGitRoot`）

### 4.2 开关

`isAutoMemoryEnabled()` 优先级：

1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY`（1/true → 关；0/false → 开）
2. `CLAUDE_CODE_SIMPLE` / `--bare` → 关
3. Remote 且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` → 关
4. `settings.autoMemoryEnabled`
5. 默认：**开**

### 4.3 四种内容类型（taxonomy）

定义于 `src/memdir/memoryTypes.ts`：

| type | 存什么 | 典型 scope（Team 开启时） |
|------|--------|---------------------------|
| **user** | 用户角色、目标、知识背景、协作偏好 | 永远 private |
| **feedback** | 用户纠正或确认的工作方式（含成功案例，不只失败） | 默认 private；项目级公约可 team |
| **project** | 无法从代码推导的进行中工作、动机、截止日期 | 强烈偏向 team |
| **reference** | 外部系统指针（Linear、Slack、Grafana…） | 通常 team |

**明确不要存**：代码模式、架构、文件结构、git 历史、调试配方、已在 CLAUDE.md 里的内容、仅当前对话有用的临时任务状态。

### 4.4 文件格式

主题文件 frontmatter：

```markdown
---
name: {{memory name}}
description: {{one-line description — 供未来检索相关性判断}}
type: {{user, feedback, project, reference}}
---

{{内容；feedback/project 建议含 Why / How to apply}}
```

保存两步（除非 feature `tengu_moth_copse` 跳过索引）：

1. 写独立 `.md` 主题文件  
2. 在同目录 `MEMORY.md` 加一行索引：`- [Title](file.md) — one-line hook`

`MEMORY.md` 限制：最多 **200 行** 且 **25KB**（`truncateEntrypointContent`）。

### 4.5 与 Plan / Task 的边界

系统提示明确区分：

- **Plan**：对齐实现方案 → 用 plan，不要写 memory  
- **Task**：当前对话步骤跟踪 → 用 tasks  
- **Memory**：跨会话仍有价值的信息

### 4.6 KAIROS（Assistant）日日志模式

`feature('KAIROS') && getKairosActive()` 时：

- 新记忆 **append** 到 `logs/YYYY/MM/YYYY-MM-DD.md`
- 不直接改 `MEMORY.md`；夜间 `/dream` / autoDream 再蒸馏成索引 + topic 文件
- 与 Team Memory 互斥（日日志范式与 team sync 不兼容）

---

## 5. Team Memory

- 路径：`<autoMemPath>/team/`
- 依赖：`isAutoMemoryEnabled()` **且** GrowthBook `tengu_herring_clock`
- 每个目录各自有 `MEMORY.md`
- 写入路径经 `validateTeamMemWritePath` / `validateTeamMemKey`：**realpath + 防 symlink 逃逸**
- UI / 折叠摘要通过 `teamMemoryOps.ts` 统计 recall / search / write
- 写入后可触发 team sync watcher（`sessionFileAccessHooks`）

---

## 6. Agent Memory（子 Agent 持久记忆）

### 6.1 Scope

`AgentMemoryScope = 'user' | 'project' | 'local'`（`agentMemory.ts`）：

| Scope | 目录 | 语义 |
|-------|------|------|
| **user** | `~/.claude/agent-memory/<agentType>/`（或 remote memory base） | 跨项目通用 |
| **project** | `<cwd>/.claude/agent-memory/<agentType>/` | 可进 VCS，团队共享 |
| **local** | `<cwd>/.claude/agent-memory-local/<agentType>/`（或 remote mount 下的 `agent-memory-local`） | 本机/本项目，不进 VCS |

入口文件同样是 `MEMORY.md`。创建 agent 时 `MemoryStep.tsx` 让用户选择 scope；启用后 `getSystemPrompt` 会拼接 `loadAgentMemoryPrompt()`。

### 6.2 Snapshot 同步

`agentMemorySnapshot.ts`：

- 项目可提交快照：`.claude/agent-memory-snapshots/<agentType>/`（含 `snapshot.json` 的 `updatedAt`）
- 本地用 `.snapshot-synced.json` 记录已同步版本
- 行为：`initialize`（本地空）/ `prompt-update`（快照更新）/ `replaceFromSnapshot` / `markSnapshotSynced`

### 6.3 召回隔离

`@agent-xxx` 提及时，`getRelevantMemoryAttachments` **只搜该 agent 的 memory 目录**，不搜主 auto-memory。

---

## 7. Session Memory（会话笔记）

**单会话**工作记忆，不是跨会话画像。

### 7.1 路径与模板

```
~/.claude/projects/<sanitized-cwd>/<sessionId>/session-memory/summary.md
```

默认章节（可被 `~/.claude/session-memory/config/template.md` 覆盖）：

- Session Title / Current State / Task specification  
- Files and Functions / Workflow / Errors & Corrections  
- Codebase and System Documentation / Learnings / Key results / Worklog  

更新 prompt 可自定义：`~/.claude/session-memory/config/prompt.md`。

### 7.2 触发

- Feature gate：`tengu_session_memory`
- 依赖 auto-compact 开启（`initSessionMemory`）
- 默认阈值（可被 `tengu_sm_config` 覆盖）：
  - 初始化：上下文 ≥ **10k** tokens
  - 更新：再增长 ≥ **5k** tokens，且（工具调用 ≥ **3** 次，或上一轮无 tool call）
- 实现：post-sampling hook → `runForkedAgent`，**只允许 Edit 该 summary 文件**
- 也可 `/summary` → `manuallyExtractSessionMemory`

### 7.3 与 Compact 的关系

`sessionMemoryCompact.ts`：在 auto/manual compact 时，若 summary 足够新且非空，可用 session memory **代替**完整 LLM 对话总结，保留尾部消息窗口（默认 minTokens 10k / maxTokens 40k / minTextBlockMessages 5）。

总 token 软上限约 **12k**（`MAX_TOTAL_SESSION_MEMORY_TOKENS`），单节约 **2k**。

---

## 8. 运行时流水线：Recall / Extract / Dream

### 8.1 Relevant Memory Recall（查询时检索）

`findRelevantMemories.ts` + `attachments.ts`：

1. `scanMemoryFiles`：递归扫 `.md`（排除 `MEMORY.md`），读 frontmatter，最多 200 个，按 mtime 新→旧  
2. 侧路 **Sonnet** `sideQuery`（`memdir_relevance`）根据用户 query + description 选最多 **5** 个文件  
3. 以 `relevant_memories` attachment 注入；带 **age / freshness** 警告（`memoryAge.ts`：>1 天提示可能过期）  
4. 已读过 / 已 surface 过的路径去重；compact 后自然可重新 surface  

当 `tengu_moth_copse` 开启时：`MEMORY.md` **不再**塞进 system prompt，改靠这条 attachment 路径按需加载（`filterInjectedMemoryFiles`）。

### 8.2 Extract Memories（回合结束抽取）

`extractMemories.ts`：

- 在 stop hooks 触发；仅主 agent；gate `tengu_passport_quail`
- 若本轮主 agent 已 Write/Edit 了 auto-mem 路径 → **跳过**（互斥）
- 否则 fork 子 agent（最多 5 turns），工具权限收紧到读 + 仅 memory 目录写
- 预注入现有 memory manifest，避免先 `ls`
- 节流：`tengu_bramble_lintel`（默认每 1 个 eligible turn）
- 成功写入后发 `createMemorySavedMessage` 系统消息

### 8.3 Auto Dream（后台整理）

`autoDream/`：

- 用户设置 `autoDreamEnabled` 或 GB `tengu_onyx_plover.enabled`
- 门槛默认：距上次整理 ≥ **24h** 且 ≥ **5** 个有更新的 session
- 跑 `/dream` 风格 consolidation prompt，整理 topic 文件与 `MEMORY.md`
- 与 KAIROS 日日志配套：白天 append log，夜间蒸馏

---

## 9. 权限与安全要点

| 机制 | 说明 |
|------|------|
| Auto-mem 写放行 | `filesystem.ts` 对 `isAutoMemPath` 有 carve-out（绕过部分危险目录限制）；**env path override 不给写 carve-out** |
| Team path | realpath 深度祖先校验，拒绝 null byte / URL 编码 / Unicode 归一化 / dangling symlink |
| Agent memory path | `isAgentMemoryPath` 用 `normalize` 防 `..` |
| Extract / Session fork | 严格 `canUseTool`：只能改指定 memory 文件 |
| projectSettings 禁设 autoMemoryDirectory | 防止恶意仓库把记忆目录指到 `~/.ssh` 等 |

---

## 10. 关键源码索引

| 主题 | 文件 |
|------|------|
| CLAUDE.md 加载 | `src/utils/claudemd.ts` |
| MemoryType（指令） | `src/utils/memory/types.ts` |
| 路径解析 | `src/utils/config.ts` (`getMemoryPath`) |
| Auto mem 路径 / 开关 | `src/memdir/paths.ts` |
| 提示词与 MEMORY.md | `src/memdir/memdir.ts` |
| 四类型 taxonomy | `src/memdir/memoryTypes.ts` |
| 扫描 / 清单 | `src/memdir/memoryScan.ts` |
| 相关性选择 | `src/memdir/findRelevantMemories.ts` |
| 新鲜度 | `src/memdir/memoryAge.ts` |
| Team 路径 | `src/memdir/teamMemPaths.ts` / `teamMemPrompts.ts` |
| Agent 记忆 | `src/tools/AgentTool/agentMemory.ts` |
| Agent 快照 | `src/tools/AgentTool/agentMemorySnapshot.ts` |
| Session 记忆 | `src/services/SessionMemory/sessionMemory.ts` |
| Session compact | `src/services/compact/sessionMemoryCompact.ts` |
| 抽取 | `src/services/extractMemories/extractMemories.ts` |
| Dream | `src/services/autoDream/autoDream.ts` |
| Attachment 注入 | `src/utils/attachments.ts` (`getRelevantMemoryAttachments`) |
| `/memory` UI | `src/commands/memory/memory.tsx` |
| 文件访问遥测 | `src/utils/sessionFileAccessHooks.ts` / `memoryFileDetection.ts` |

---

## 11. 一句话对照

| 你想记住… | 用哪个系统 |
|-----------|------------|
| 「这个仓库永远用 bun，PR 要这样写」 | **Project CLAUDE.md** / rules |
| 「我是前端新手，解释时多类比后端」 | **Auto Memory `user`** |
| 「别在每条回复末尾总结」 | **Auto Memory `feedback`（private）** |
| 「周四起 merge freeze」 | **Auto Memory `project`（team）** |
| 「流水线 bug 在 Linear INGEST」 | **Auto Memory `reference`** |
| 「这个 code-reviewer agent 的评审习惯」 | **Agent Memory** |
| 「当前会话做到哪一步了，compact 后接着干」 | **Session Memory** |
| 「组织强制安全策略」 | **Managed CLAUDE.md** |

---

## 12. Feature Gates 速查

| Gate / Setting | 作用 |
|----------------|------|
| `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Auto memory 总开关 |
| `tengu_passport_quail` | extractMemories |
| `tengu_bramble_lintel` | 抽取节流（每 N turn） |
| `tengu_herring_clock` | Team memory |
| `tengu_session_memory` / `tengu_sm_config` | Session memory |
| `tengu_sm_compact_config` | Session memory compact 阈值 |
| `tengu_moth_copse` | 跳过 MEMORY.md 常驻注入，改 attachment 召回 |
| `tengu_coral_fern` | 「Searching past context」提示段 |
| `tengu_onyx_plover` / `autoDreamEnabled` | Auto dream |
| `TEAMMEM` / `KAIROS` / `EXTRACT_MEMORIES` | 编译期 feature |
