# Claude Code 全部 Memory 实现总结

> 源码：`/Users/harry/cursor_workspace/public_repo/claude-code-rev`  
> 核心目录：`src/memdir/`、`src/utils/claudemd.ts`、`src/tools/AgentTool/agentMemory*.ts`、`src/services/SessionMemory/`、`src/services/extractMemories/`、`src/services/autoDream/`、`src/services/teamMemorySync/`  
> 文档日期：2026-08-08

本文面向：**想搞清 CC 有哪些「记忆」、各自干什么、代码在哪** 的读者。  
先读第 1–2 节建立心智模型，再按需深入各子系统。

---

## 1. 先建立心智模型（小白入口）

Claude Code 的「记忆」**不是一个模块**，而是多层、多生命周期的系统。可以粗分为两类：


| 大类                          | 存什么            | 谁维护             | 典型例子                             |
| --------------------------- | -------------- | --------------- | -------------------------------- |
| **指令记忆（Instructions）**      | 你规定的行为规范       | 人（或管理员）         | `CLAUDE.md`、`.claude/rules/*.md` |
| **学习记忆（Learned / Working）** | 对话里沉淀的事实、偏好、进度 | Agent 自动写 + 人可改 | Auto Memory、Session Memory、Dream |


再按「管多久」拆开：

```
跨会话（下次打开仓库还在）
  ├─ CLAUDE.md 体系（Managed / User / Project / Local）
  ├─ Auto Memory（memdir + MEMORY.md + 主题文件）
  ├─ Team Memory（auto-memory 下的 team/，可同步）
  └─ Agent Memory（某个子 agent 专属目录）

单会话（这次对话用）
  └─ Session Memory（summary.md，主要喂给 compact）

运行时流水线（不单独「存一类记忆」，但负责读写）
  ├─ findRelevantMemories（按需召回主题文件）
  ├─ extractMemories（回合结束补抽到 auto/team）
  └─ autoDream / KAIROS daily log（整理、蒸馏）
```

类比：

- **CLAUDE.md** = 贴在墙上的团队规范  
- **Auto Memory** = 个人/项目记事本（偏好、纠错、冷知识）  
- **Team Memory** = 共享白板（同步到团队）  
- **Agent Memory** = 某个专职助手自己的小本子  
- **Session Memory** = 今天这张草稿纸上的任务进度  
- **extract / dream / prefetch** = 秘书：帮你记、帮你整理、帮你翻到相关页

---



## 2. 两个叫 `MemoryType` 的东西（别混）

源码里有两套同名概念：


| 定义位置                        | 取值                                                                  | 含义                             |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| `src/utils/memory/types.ts` | `User` / `Project` / `Local` / `Managed` / `AutoMem` /（可选）`TeamMem` | **指令文件来源层级**（从哪加载的）            |
| `src/memdir/memoryTypes.ts` | `user` / `feedback` / `project` / `reference`                       | **Auto Memory 主题内容分类**（记的是哪类事） |


下文「Instructions 的 MemoryType」指前者；「taxonomy type」指后者。

---



## 3. 端到端时序：一次会话里发生什么

```
会话启动（setup）
  │
  ├─ getMemoryFiles() / getClaudeMds()
  │     ← Managed → User → Project → Local →（可选）AutoMem/TeamMem 的 MEMORY.md
  │     → 注入 userContext.claudeMd
  │
  ├─ loadMemoryPrompt()
  │     → system prompt 里的「如何读写 memory」指南
  │
  ├─ initSessionMemory()          （若 gate + autocompact 开）
  ├─ initExtractMemories()
  └─ startTeamMemoryWatcher()     （若 TEAMMEM 开）

每轮用户输入（query 路径）
  │
  └─ startRelevantMemoryPrefetch()   （GB tengu_moth_copse）
        └─ findRelevantMemories() → 最多 5 个主题文件
              → relevant_memories attachment（不阻塞主模型）

主 agent 回合中
  └─ 可直接 Write/Edit memdir / team / agent-memory（权限 carve-out）

主 agent 回合结束（stop hooks）
  ├─ extractMemories（若本轮主 agent 没写过 memdir → fork 补抽）
  └─ autoDream（时间 + 会话数门槛，后台整理）

采样后（post-sampling hook）
  └─ Session Memory 抽取 → 更新 summary.md

压缩（compact）
  ├─ 清 getMemoryFiles 缓存并可能重载指令
  └─ 优先 trySessionMemoryCompaction（用 summary.md）否则传统 LLM 总结
```

关键挂载点：


| 阶段                | 文件                                                |
| ----------------- | ------------------------------------------------- |
| 指令加载              | `src/utils/claudemd.ts`、`src/context.ts`          |
| memory 指南进 system | `src/constants/prompts.ts` → `loadMemoryPrompt()` |
| 相关记忆预取            | `src/utils/attachments.ts`、`src/query.ts`         |
| 回合结束抽取/做梦         | `stopHooks` → `extractMemories` / `autoDream`     |
| 会话笔记              | `src/services/SessionMemory/sessionMemory.ts`     |
| Compact           | `src/services/compact/sessionMemoryCompact.ts`    |


---



## 4. Instructions Memory（CLAUDE.md 体系）



### 4.1 职责

跨会话、**人工维护**的指令层。会话一开始就注入，优先级高于模型默认行为。  
这是用户最熟悉的「记忆」——其实是 **规范**，不是自动学习。

### 4.2 四级加载顺序（后加载 = 更高优先级）

见 `claudemd.ts` 文件头注释：


| 顺序  | 类型          | 路径示例                                                                                                                                                                  | 作用域     |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Managed** | macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux: `/etc/claude-code/CLAUDE.md`；Windows: `C:\Program Files\ClaudeCode\CLAUDE.md` + 对应 `.claude/rules/` | 全机策略    |
| 2   | **User**    | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md`                                                                                                                        | 用户全局    |
| 3   | **Project** | `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`（CWD 向上遍历）                                                                                                        | 仓库 / 目录 |
| 4   | **Local**   | `CLAUDE.local.md`（CWD 向上遍历）                                                                                                                                           | 本机项目私有  |


规则要点：

- 离 CWD 越近 → 越晚加载 → 模型更关注  
- 支持 `@path` / `@./rel` / `@~/...` / `@/abs` **include**（叶子文本节点；防循环）  
- 嵌套 git worktree 会跳过主仓重复的 Project 文件；`CLAUDE.local.md` 仍可从主仓加载  
- `claudeMdExcludes` 可排除路径  
- `--add-dir` 下的 CLAUDE.md 需 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`  
- 工具触达嵌套目录时，可懒加载 nested / conditional rules → `nested_memory` attachment，并触发 `InstructionsLoaded` hook



### 4.3 注入方式

`getMemoryFiles()` → `getClaudeMds()` → `context.ts` 的 `userContext.claudeMd`。

可关闭：

- `CLAUDE_CODE_DISABLE_CLAUDE_MDS`
- bare / SIMPLE 模式（且无额外目录时）

单文件建议上限：`MAX_MEMORY_CHARACTER_COUNT = 40000`（`/status` 会提示过大文件）。

### 4.4 UI

`/memory` 命令 → `MemoryFileSelector`：列出/创建指令文件，用 `$VISUAL` / `$EDITOR` 打开；也可跳到 auto/team/agent memory 目录。

---



## 5. Auto Memory（memdir）



### 5.1 职责

跨会话、**项目作用域**的结构化主题记忆。存「无法从当前代码 / git / CLAUDE.md 推导」的上下文。  
主 agent 可直接写；也可由 `extractMemories` / `autoDream` 后台写。

### 5.2 路径

解析顺序（`getAutoMemPath`）：

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`（全路径覆盖）
2. settings `autoMemoryDirectory`（**仅** policy / flag / local / user；**禁止** project settings，防恶意仓库劫持）
3. `<memoryBase>/projects/<sanitized-canonical-git-root>/memory/`

其中 `memoryBase` = `CLAUDE_CODE_REMOTE_MEMORY_DIR` 或 `~/.claude`。  
同一 git 仓库的 worktree 共享同一目录（`findCanonicalGitRoot`）。

典型布局：  
├── project_*.md  
├── reference_*.md  
├── team/                  # Team Memory（见下节）  
│   └── [MEMORY.md](http://MEMORY.md)  
└── logs/YYYY/MM/YYYY-MM-DD.md   # KAIROS 日日志



### 5.3 开关（`isAutoMemoryEnabled`）

优先级：

1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY`（truthy → 关；显式 falsy → 开）
2. `CLAUDE_CODE_SIMPLE` / bare → 关
3. Remote 且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` → 关
4. `settings.autoMemoryEnabled`
5. 默认：**开**

关掉后一并影响：extractMemories、autoDream、`/remember`、team sync、agent memory 注入等「另一半」行为。

### 5.4 内容 taxonomy（四种 type）


| type          | 存什么                           | Team 开启时的 scope 倾向    |
| ------------- | ----------------------------- | --------------------- |
| **user**      | 角色、目标、知识背景、协作偏好               | 永远 private            |
| **feedback**  | 纠正或确认的工作方式（含成功案例）             | 默认 private；项目公约可 team |
| **project**   | 代码推不出来的进行中工作、动机、截止日期          | 强烈偏向 team             |
| **reference** | 外部系统指针（Linear、Slack、Grafana…） | 通常 team               |


**明确不要存**：代码模式、架构、文件结构、git 历史、调试配方、已在 CLAUDE.md 里的内容、仅当前对话有用的临时状态。

主题文件 frontmatter 示例：

```markdown
---
name: Prefer concise replies
description: User wants short answers without trailing summaries
type: feedback
---

规则正文…

**Why:** …
**How to apply:** …
```

保存两步（除非 prefetch gate 跳过索引维护）：

1. 写独立主题 `.md`
2. 在 `MEMORY.md` 加一行：`- [Title](file.md) — one-line hook`

`MEMORY.md` 硬限制：最多 **200 行** 且 **25KB**（`truncateEntrypointContent`）。  
扫描主题文件上限约 **200** 个。

### 5.5 如何进入上下文

1. **System prompt**：`loadMemoryPrompt()` —— 教模型何时读写、四种类型、与 Plan/Task 边界
2. **User context**：`getMemoryFiles()` 把 `MEMORY.md` 入口当作 `AutoMem` 类型拼进 `claudeMd`（可被 `tengu_moth_copse` 关掉，改由 prefetch 召回）
3. **按需**：模型 Grep/Read，或 `findRelevantMemories` 预取



### 5.6 与 Plan / Task 的边界

系统提示明确：

- **Plan** → 对齐实现方案，不要写 memory  
- **Task** → 当前对话步骤跟踪  
- **Memory** → 跨会话仍有价值的信息

---



## 6. Team Memory



### 6.1 职责

Auto Memory 的 **团队共享子树**：`<autoMemPath>/team/`。  
跨会话、可 API 同步（启动 pull，变更后 debounce push）。

### 6.2 开关

- 编译期 feature：`TEAMMEM`  
- 运行时：`isAutoMemoryEnabled()` **且** GrowthBook `tengu_herring_clock`  
- 需要 first-party OAuth + git remote 身份等同步前置条件



### 6.3 行为要点


| 项     | 说明                                                           |
| ----- | ------------------------------------------------------------ |
| 入口    | `team/MEMORY.md`，加载类型为 `TeamMem`，可包在 `<team-memory-content>` |
| 提示词   | `teamMemPrompts.ts` 合并 private + team 指南（含 scope）            |
| 安全写路径 | `validateTeamMemWritePath` / realpath，防 symlink 逃逸           |
| 同步    | `src/services/teamMemorySync/*`；watcher debounce ~2s         |
| 密钥    | Edit/Write 有 secret guard                                    |
| 删除    | **不**向服务端传播删除                                                |
| 限额    | 单文件约 250KB；PUT body 约 200KB                                  |


KAIROS 日日志模式开启时，与 Team Memory **互斥**（append-only 日志范式 vs 共享 MEMORY.md）。

---



## 7. Agent Memory（子 Agent 专属）



### 7.1 职责

某个 **自定义 / 插件 agent** 的跨会话私有记忆。  
仅当该 agent 的 frontmatter 声明 `memory: user|project|local`，且 auto-memory 总开关开启时注入。

### 7.2 路径（按 scope）


| Scope       | 目录                                                                                     | 语义          |
| ----------- | -------------------------------------------------------------------------------------- | ----------- |
| **user**    | `<memoryBase>/agent-memory/<agentType>/`                                               | 跨项目         |
| **project** | `<cwd>/.claude/agent-memory/<agentType>/`                                              | 可进 VCS      |
| **local**   | `<cwd>/.claude/agent-memory-local/<agentType>/`（或 remote mount 下 `agent-memory-local`） | 本机，通常不进 VCS |


入口同样是目录内 `MEMORY.md`。  
`agentType` 中的 `:`（插件命名空间）会替换成 `-`，避免 Windows 非法路径。

### 7.3 Snapshot

`agentMemorySnapshot.ts`：

- 仓库可提交：`.claude/agent-memory-snapshots/<agentType>/`  
- 本地记录：`.snapshot-synced.json`  
- 行为：`initialize` / `prompt-update` / `replaceFromSnapshot` / `markSnapshotSynced`



### 7.4 召回隔离

用户 `@agent-xxx` 时，相关记忆预取 **只搜该 agent 的 memory 目录**，不搜主 auto-memory。

创建 UI：`MemoryStep.tsx`（新建 agent 向导）。

---



## 8. Session Memory（单会话笔记）



### 8.1 职责

**一条会话内**的滚动笔记，供 compact 续接「做到哪了」。  
不是跨会话画像；主回复路径不阻塞（fork + fire-and-forget）。

### 8.2 路径与模板

```text
~/.claude/projects/<sanitized-cwd>/<sessionId>/session-memory/summary.md
```

自定义模板（可选）：

```text
~/.claude/session-memory/config/template.md
~/.claude/session-memory/config/prompt.md
```

默认章节包括：Session Title、Current State、Task specification、Files and Functions、Workflow、Errors & Corrections、Codebase and System Documentation、Learnings、Key results、Worklog。  
单节软上限约 2k tokens；整文件约 12k。

### 8.3 触发与门控

- `setup` → `initSessionMemory()` 注册 **post-sampling hook**  
- 前提：autocompact 开启；非 remote  
- GrowthBook：`tengu_session_memory`；阈值可被 `tengu_sm_config` 覆盖  
- 默认阈值量级：init ≥ ~10k tokens；更新间隔 ~5k tokens；每 ~3 次 tool call

抽取：`runForkedAgent`，工具权限收紧到几乎只能 Edit `summary.md`。  
手动：`/summary` → `manuallyExtractSessionMemory`。

### 8.4 与 Compact

`sessionMemoryCompact.ts`：

- Gate：`tengu_sm_compact` + session memory，可用 env `ENABLE/DISABLE_CLAUDE_CODE_SM_COMPACT` 覆盖  
- 可用时：**用 summary.md 当 compact 摘要**，保留尾部 messagesToKeep，跳过现场全文 LLM 总结  
- 等待 in-flight 抽取：约 15s 超时 / 60s stale

口号：**平时记账，满窗读账**。

---



## 9. 运行时流水线



### 9.1 extractMemories（回合结束补抽）


| 项    | 说明                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 代码   | `src/services/extractMemories/`                                                                                          |
| 何时   | 主 agent stop hooks；若本轮已写过 memdir 则 skip                                                                                  |
| 怎么做  | fork agent；Read/Grep/Glob + 受限 Bash + 仅 memdir 内 Edit/Write；`maxTurns` 约 5                                               |
| Gate | 编译 `EXTRACT_MEMORIES`；GB `tengu_passport_quail`；非交互另需 `tengu_slate_thimble`；节流 `tengu_bramble_lintel`（默认每 eligible turn） |
| 注意   | 主 agent 的 system prompt **始终**带完整「如何保存」说明；background 只是兜底                                                                |




### 9.2 findRelevantMemories / prefetch


| 项    | 说明                                                                 |
| ---- | ------------------------------------------------------------------ |
| 代码   | `src/memdir/findRelevantMemories.ts`、`attachments.ts`              |
| 何时   | 每轮用户输入；与主模型并行，**不阻塞**                                              |
| Gate | auto-memory 开 **且** GB `tengu_moth_copse`                          |
| 行为   | 侧路 Sonnet 从主题文件清单里最多选 **5** 个；读入后作为 `relevant_memories` attachment |
| 限额   | 单文件约 200 行 / 4KB；会话累计约 **60 KiB**；跳过单词语 prompt                     |
| 副作用  | 开启后，常驻注入的 MEMORY.md **索引**可从 userContext 去掉，改由预取承载细节               |


渲染时可能带记忆新鲜度 / 过期 caveat（`memoryAge.ts`）。

### 9.3 autoDream（后台整理）


| 项    | 说明                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 代码   | `src/services/autoDream/`                                                                                                   |
| 职责   | 把近期多会话沉淀 **蒸馏** 成主题文件 + 更新 MEMORY.md                                                                                        |
| Gate | `settings.autoDreamEnabled` 覆盖，否则 GB `tengu_onyx_plover.enabled`；需 auto-memory；非 remote；**KAIROS active 时不用这条**（走日日志 dream） |
| 门槛   | 默认约 `minHours: 24`、`minSessions: 5`（来自 GB）                                                                                  |
| 并发   | memdir 内 `.consolidate-lock`                                                                                                |
| UI   | `DreamTask`；`/memory` 选择器可看上次整理时间                                                                                           |


本 rev 里 bundled `/dream` skill 可能是 stub（`KAIROS || KAIROS_DREAM` 才注册）；真正 consolidation 文案在 `consolidationPrompt.ts`。

### 9.4 KAIROS daily log

长驻 Assistant 模式变体：

- 新记忆 **append** 到 `memory/logs/YYYY/MM/YYYY-MM-DD.md`  
- 不实时改 `MEMORY.md`；夜间 dream 再蒸馏成索引 + topic  
- `loadMemoryPrompt()` 走 `buildAssistantDailyLogPrompt`  
- 与 Team Memory 互斥；关闭常规 autoDream 路径

---



## 10. 其它相关能力


| 能力                   | 说明                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/memory`            | 管理指令文件 + 打开 auto/team/agent 目录；可联动 auto-dream 开关                                                                                       |
| `/remember`          | ant-only：提议把 auto-memory 条目晋升到 CLAUDE.md / local / team                                                                                |
| **Nested CLAUDE.md** | 工具触达子目录时懒加载；`InstructionsLoaded` reason：`nested` / `include` / `compact` / `session_start`                                             |
| **权限 carve-out**     | `filesystem.ts`：auto-mem / agent-memory 读写放行策略；Cowork path override **不**给静默写                                                          |
| **文件分类 UI**          | `memoryFileDetection.ts`：区分 auto/team/agent/session vs 用户管理的 CLAUDE.md，用于折叠徽章等                                                         |
| **遥测**               | `tengu_memdir_`*、`tengu_extract_memories_*`、`tengu_session_memory_*`、`tengu_auto_dream_*`、`tengu_team_mem_*`；可选 `memoryShapeTelemetry` |




### Compact 交互小结

1. Compact 后 `resetGetMemoryFilesCache('compact')`，指令可重载
2. Session Memory 可替代经典全文总结
3. `relevant_memories` 字节预算在 compact 后重置（attachment 没了）
4. postCompactCleanup 清掉包着 `getClaudeMds` 的 user-context memo

---



## 11. 对照总表


| #   | 系统                      | 生命周期        | 主要用途                 | 核心路径                                  |
| --- | ----------------------- | ----------- | -------------------- | ------------------------------------- |
| 1   | Instructions（CLAUDE.md） | 跨会话，人工      | 指令/规范，始终注入           | `src/utils/claudemd.ts`               |
| 2   | Auto Memory（memdir）     | 跨会话，自动+手动   | 用户/反馈/项目事实/指针        | `src/memdir/`                         |
| 3   | Team Memory             | 跨会话，团队同步    | 共享 memdir 子树         | `teamMemPaths.ts` + `teamMemorySync/` |
| 4   | Agent Memory            | 跨会话，按 agent | 子 agent 专属 MEMORY.md | `AgentTool/agentMemory.ts`            |
| 5   | Session Memory          | 单会话         | 进度笔记 → compact       | `services/SessionMemory/`             |
| 6   | extractMemories         | 运行时         | 回合结束补抽               | `services/extractMemories/`           |
| 7   | Relevant prefetch       | 运行时         | 每轮最多 5 条主题召回         | `findRelevantMemories.ts`             |
| 8   | autoDream               | 运行时/夜间      | 多会话蒸馏整理              | `services/autoDream/`                 |
| 9   | KAIROS daily log        | 长会话变体       | append-only 日日志      | `getAutoMemDailyLogPath`              |


---



## 12. Feature / Settings / Env 速查



### 编译期 feature


| Feature                   | 控制                   |
| ------------------------- | -------------------- |
| `TEAMMEM`                 | Team Memory 代码路径     |
| `EXTRACT_MEMORIES`        | extractMemories      |
| `KAIROS` / `KAIROS_DREAM` | 日日志模式、dream skill 注册 |
| `MEMORY_SHAPE_TELEMETRY`  | 记忆形态遥测               |




### GrowthBook（名称可能随版本变化）


| Gate                      | 控制                                           |
| ------------------------- | -------------------------------------------- |
| `tengu_herring_clock`     | Team Memory 开                                |
| `tengu_passport_quail`    | extractMemories 开                            |
| `tengu_slate_thimble`     | 非交互会话也 extract                               |
| `tengu_bramble_lintel`    | extract 每 N turn                             |
| `tengu_moth_copse`        | prefetch 召回；跳过 MEMORY.md 常驻注入                |
| `tengu_coral_fern`        | 「搜索过去上下文」类 prompt 段                          |
| `tengu_session_memory`    | Session Memory 抽取                            |
| `tengu_sm_config`         | SM 阈值覆盖                                      |
| `tengu_sm_compact`        | SM compact                                   |
| `tengu_sm_compact_config` | compact keep 的 token/消息上限                    |
| `tengu_onyx_plover`       | autoDream `{enabled, minHours, minSessions}` |
| `tengu_paper_halyard`     | 跳过 Project/Local CLAUDE.md 注入                |




### Settings

- `autoMemoryEnabled`  
- `autoMemoryDirectory`（受信 scope only）  
- `autoDreamEnabled`  
- `claudeMdExcludes`



### 环境变量


| Env                                                                | 作用                        |
| ------------------------------------------------------------------ | ------------------------- |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY`                                  | 强制开关 auto-memory 族        |
| `CLAUDE_CODE_SIMPLE`                                               | bare：关 auto-memory 族      |
| `CLAUDE_CODE_REMOTE` / `CLAUDE_CODE_REMOTE_MEMORY_DIR`             | 远程与持久 memory 根            |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`                               | Cowork 绝对路径覆盖             |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES`                            | 额外 memory 指南              |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS`                                   | 禁用全部 CLAUDE.md 注入         |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`                     | `--add-dir` 也加载 CLAUDE.md |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` / `DISABLE_CLAUDE_CODE_SM_COMPACT` | SM compact 覆盖             |


---



## 13. 源码索引（按目录）

```text
src/utils/claudemd.ts              # CLAUDE.md 发现、include、注入格式
src/utils/memory/types.ts          # 指令层 MemoryType
src/context.ts                     # userContext.claudeMd
src/constants/prompts.ts           # system 中 memory section

src/memdir/paths.ts                # auto-memory 开关与路径
src/memdir/memdir.ts               # loadMemoryPrompt、截断、入口常量
src/memdir/memoryTypes.ts          # user/feedback/project/reference
src/memdir/memoryScan.ts           # 扫描 frontmatter
src/memdir/memoryAge.ts            # 新鲜度文案
src/memdir/findRelevantMemories.ts # 相关主题选择
src/memdir/teamMemPaths.ts         # Team 路径与 enable
src/memdir/teamMemPrompts.ts       # Team+private 合并提示
src/memdir/memoryShapeTelemetry.ts # 可选遥测

src/tools/AgentTool/agentMemory.ts
src/tools/AgentTool/agentMemorySnapshot.ts

src/services/SessionMemory/        # 会话笔记抽取
src/services/compact/sessionMemoryCompact.ts
src/services/extractMemories/      # 回合结束补抽
src/services/autoDream/            # 后台蒸馏
src/services/teamMemorySync/       # Team 同步

src/commands/memory/memory.tsx
src/components/memory/MemoryFileSelector.tsx
src/utils/memoryFileDetection.ts
src/utils/teamMemoryOps.ts
src/utils/permissions/filesystem.ts  # 路径与权限 carve-out
src/skills/bundled/remember.ts       # ant-only 晋升
src/skills/bundled/dream.ts          # dream skill（可能 stub）
```

---



## 14. 一句话收束

Claude Code 的 memory = **指令层（CLAUDE.md）** + **跨会话学习层（Auto / Team / Agent）** + **单会话工作层（Session Memory）** + **三条流水线（prefetch 召回 / extract 补抽 / dream 整理）**。  

读代码时先分清「这是规范还是笔记、跨会话还是单会话、谁写入、靠哪个 GrowthBook」，再对照上表找文件即可。

---



## 相关文档

- 本仓库对照实现（BaiX agent）：`docs/agent-memory-guide.md`  
- Session Memory 设计笔记：`docs/cc_docs/session-memory-design.md`、`docs/cc_docs/claude-code-session-memory.md`  
- Auto Memory 设计笔记：`docs/cc_docs/auto-memory-design.md`  
- Compact 相关：`docs/cc_docs/claude-code-compacting.md`
`)

