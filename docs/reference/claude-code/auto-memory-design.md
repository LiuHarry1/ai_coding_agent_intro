# Auto Memory 设计（src，参考 Claude Code）

> 状态：**已实现（MVP）** — 2026-07-26  
> 前置：Instructions（`.ai-agent/AGENTS.md`）✅ · Session Memory ✅  
> 对齐对象：CC `src/memdir/*` + `src/services/extractMemories/*`  
> 日期：2026-07-26

---

## 1. 目标与非目标

### 目标

补上 **跨会话** 的结构化记忆（与「人工指令」和「单会话笔记」正交）：

| 层 | 生命周期 | 存什么 |
|----|----------|--------|
| Instructions | 跨会话，人工 | 仓库规范 → `AGENTS.md` |
| Session Memory | 单会话 | 当前任务进度 → compact |
| **Auto Memory** | **跨会话，自动/半自动** | 用户偏好、纠错、项目事实、外部指针 |

闭环：

1. 系统提示教会主 agent **何时写** memory  
2. **整轮收尾**（无后续 tool）若本轮没写 → **fork extract** 补抽  
3. 启动时把 **`MEMORY.md` 索引** 注入上下文（空索引不注入）

### 非目标（本阶段不做）

- Team Memory（`team/` sync）
- Agent Memory（子 agent 专属目录）
- Auto Dream / KAIROS 日日志
- Sonnet `findRelevantMemories` 按需召回（`tengu_moth_copse`）
- GrowthBook 多 gate（收敛为 settings + env）

### 与 Session Memory 的硬边界

| | Session Memory | Auto Memory |
|--|----------------|-------------|
| 路径 | `.sessions/{id}/session-memory/summary.md` | `~/.ai-agent/projects/<sanitized-git-root>/memory/` |
| 用途 | compact 续接、当前 State | 下次打开仓库仍有用 |
| 不要混写 | 临时任务进度 | 代码里能推出来的架构 |
| 触发 | 采样后，按 token / tool 阈值 | **仅 turn 收尾**（`tool_calls=0`），与 SM **分钩子** |

---

## 2. 架构（对齐 CC stopHooks）

```
会话启动
  ├─ loadProjectRules()              ← AGENTS.md（已有）
  ├─ loadAutoMemoryPrompt()          ← 「如何读写 memory」指南 → system
  └─ inject MEMORY.md (truncated)    ← 非空才注入；排在 AGENTS 之后

主 agent 回合中
  └─ 可直接 Write/Edit memdir（sandbox carve-out + 审计日志）

整轮结束（最后一步 assistant 无 tool_calls）
  ├─ void extractSessionMemory…      ← 现有 SM（阈值门控，可与本步并行或先跑）
  └─ void extractAutoMemories…       ← 本设计：独立钩子
        ├─ 节流：每 N 个 eligible turn（默认 3）
        ├─ 若 since cursor 已有 memdir Write/Edit → skip
        ├─ 可选：若 SM extract 正在 in-flight → 延后排队（错峰）
        └─ runForkedAgent + canUseTool(memdir write-only; read scoped)
              → topic .md + 更新 MEMORY.md
              → 写后校验索引；缺条目则补或 warn
```

复用基建：

- `core/forked-agent.ts`（CacheSafeParams + canUseTool）
- 泛化 `extractQueue`：**按 memdir 路径锁**（多 session 同 repo 不抢写），不仅 per-sessionId
- `core/agent.ts`：**单独**的 turn-end 钩子，**不要**挂在「每个 step 后」与 SM 混用

---

## 3. 存储

### 3.1 路径（对齐 CC `getAutoMemPath`）

默认：

```
~/.ai-agent/projects/<sanitize(canonicalGitRoot|cwd)>/memory/
├── MEMORY.md           # 索引（入口，注入上下文）
├── prefer-concise.md   # 主题文件（文件名任意；type 在 frontmatter）
└── …
```

`<sanitize>`：非 `[a-zA-Z0-9]` → `-`；过长截断 + hash（对齐 CC `sanitizePath`）。  
`canonicalGitRoot`：worktree 归一到主仓，使同 repo 共享一份 memory。

解析顺序：

1. env `AI_AGENT_MEMORY_PATH`（绝对路径；trusted）
2. settings `autoMemoryDirectory`（**仅** user / local settings；**禁止** project settings）
3. 默认：`~/.ai-agent/projects/<sanitize(…)>/memory/`

> **不**默认写到 `<repo>/.ai-agent/memory/`，避免误提交。

目录 `0o700`，文件 `0o600`。

### 3.2 主题文件格式

文件名 **任意**（推荐可读 slug）；**必填** frontmatter：

```markdown
---
name: Prefer concise replies
description: User wants short answers without trailing summaries
type: feedback
---

## Why
…

## How to apply
…
```

| `type` | 存什么 | 勿存 |
|--------|--------|------|
| `user` | 角色、背景、协作偏好 | — |
| `feedback` | 纠正 / 确认的工作方式 | — |
| `project` | 无法从代码推导的事实、截止日期 | 目录结构、git 历史、可从代码推的架构 |
| `reference` | Linear / Slack / Dashboard 指针 | 大段粘贴 |

**去重规则（写进 extract prompt）：** 同主题优先 **Edit 已有文件**；禁止平行新建近义条目。验收：重复 feedback 应合并。

### 3.3 MEMORY.md 索引

- 无 frontmatter；`- [Title](file.md) — one-line hook`
- 硬上限：约 **200 行 / 25KB**（截断；注入时再可只取最近 N 条作预算）
- 两步写入：① topic ② 索引行  
- **写后校验**：新/改 topic 若索引缺失 → 自动补一行或 `console.warn`；P1 提供 `rebuildIndex()`

---

## 4. 写入路径

### 4.1 主 agent（eager）

- System：`loadAutoMemoryPrompt()` — 何时写、四类型、两步保存、与 Plan/Task/Session Memory 边界、去重。
- Sandbox：`isAutoMemPath(abs)` 允许 Write/Edit；打审计日志（不挡 MVP）。
- 本轮若已写 memdir → extract **跳过**（见游标）。

### 4.2 Extract fork（catch-up）

对齐 CC `extractMemories` + 本 repo review：

| 项 | 行为 |
|----|------|
| 触发 | **仅**主线程 turn 收尾：`tool_calls === 0`；`autoMemoryEnabled`；非 SM/Auto 自身 fork |
| Skip | `hasMemoryWritesSince(lastAutoMemoryMessageUuid)` 为 true |
| 节流 | 默认 **每 1 个** eligible turn（对齐 CC `tengu_bramble_lintel` default）；非 settings 字段 |
| 错峰 | SM extract in-flight 时 Auto 进入 memdir 队列延后（不 drop；latest-wins coalesce） |
| Fork | `runForkedAgent` + `cacheSafeParams`（默认 cacheSafe） |
| 工具 | Read/Grep/Glob：**workspace cwd ∪ memdir**；Edit/Write：**仅 memdir**；Bash 写否认 |
| maxSteps | 5 |
| 预注入 | memory manifest（path + description），避免先 ls |
| 队列锁 | **按 memdir 绝对路径** 串行（多 tab 同 repo 安全） |
| 收尾 | 校验索引；日志 `skipped\|ran\|wrote N\|indexLines` |

游标：`lastAutoMemoryMessageUuid`（进程内；P1 持久化到 session meta）。  
语义：自该 uuid **之后** 的消息里是否出现过 memdir 写入——不是「session 历史上写过一次就永远 skip」。

### 4.3 手动（P1）

- `/memory`：**先**打印路径、最近文件、是否启用（比 force extract 优先）
- `/remember`：force 一次 extract（可选）

---

## 5. 读取 / 召回（MVP）

1. 启动读 `MEMORY.md`；**空 / 仅空白 → 不注入**。  
2. 注入位置：与 AGENTS 同级 user/instructions 区，标题 `## Auto memory`，**排在 AGENTS.md 之后**（人工规范优先）。  
3. 可选预算：注入最近 N 条索引行（默认 N=50 或 25KB 截断，先到先限）。  
4. 细节：主 agent 按路径 Read topic（prompt 写明 memdir）。

**P2：** 关闭常驻索引 + Sonnet 选 ≤5 条 attachment；`memoryAge` 新鲜度提示。

---

## 6. 配置

```ts
// Settings（对齐 CC 扁平字段）
autoMemoryEnabled: boolean      // default true
autoMemoryDirectory?: string    // trusted only

// Runtime（代码默认，非 settings）
interface AutoMemoryConfig {
  enabled: boolean
  directory?: string
  extractEveryNTurns: number    // default 1
  cacheSafe: boolean
  injectIndex: boolean
  injectMaxIndexLines: number
}
```

Env：

- `AI_AGENT_DISABLE_AUTO_MEMORY=1` → 关  
- `AI_AGENT_MEMORY_PATH=/abs/path` → 覆盖目录（trusted）

Settings：

- Project `.ai-agent/settings.json` 可设 `autoMemoryEnabled`  
- **不可**用 project settings 设 `autoMemoryDirectory`（防指到 `~/.ssh`）  
- User/local settings 可设 `autoMemoryDirectory`

---

## 7. 模块落点

```
src/services/auto-memory/
  paths.ts          # getAutoMemPath, isAutoMemPath, sanitize, canonical git root
  types.ts          # MemoryType + frontmatter
  prompts.ts        # loadAutoMemoryPrompt, extract prompt, dedupe rules
  scan.ts           # manifest, truncate index, rebuildIndex
  extract.ts        # turn-end fork + skip-if-wrote + throttle + post-write verify
  inject.ts         # non-empty MEMORY.md → context slice (after AGENTS)
  index.ts

utils/permissions/filesystem.ts # memdir write carve-out (extraWriteRoots)
core/agent.ts                   # turn-end hook only (tool_calls===0)
services/…/extractQueue.ts      # 泛化：lockKey = memdir path（Auto）或 sessionId（SM）
prepare_chat_turn / prompts     # memory guide + index inject
settings-manager / types        # AutoMemoryConfig
```

---

## 8. 实现分期

### MVP

1. paths + types + scan + truncate / 空索引不注入  
2. system 指南 + AGENTS 之后注入索引  
3. sandbox 写放行 + 简单审计 log  
4. turn-end extract + skip-if-wrote + 节流默认 3 + memdir 锁队列  
5. 写后索引校验  
6. settings / env（**默认 autoMemoryEnabled: true**，节流每 turn）

### P1

- `/memory` 状态命令  
- `rebuildIndex()`  
- 游标持久化  
- SM in-flight 错峰  

### P2

- Relevant memory prefetch  
- Team / Dream  
- 主 agent 写路径更严的 canUseTool 门闸  

---

## 9. 验收标准

- 用户说「以后回复短一点」→ 收尾 extract 或主 agent 写出 topic + 索引有条目  
- 重复说同一偏好 → **Edit 已有文件**，不新增平行条目  
- 新会话：非空索引出现在 AGENTS **之后**；空索引无 Auto memory 段  
- 本轮已 Write memdir → 日志 `extract skipped (direct write)`  
- project settings 配置 `autoMemoryDirectory: ~/.ssh` → **忽略/拒绝**  
- 同 repo 两 session 并发 extract → 串行，无交叉写坏 `MEMORY.md`  
- SM 与 Auto **不同钩子**；tool 风暴中途不跑 Auto extract  
- Session Memory 目录与 Auto memdir **互不写入**

---

## 10. 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储根 | `~/.ai-agent/projects/<sanitize>/memory/` | 对齐 CC；不污染仓库 |
| 召回 MVP | 非空 MEMORY.md 注入（限行） | 无额外模型成本 |
| Extract 模型 | cacheSafe 主模型 | 与 SM / CC 一致 |
| 索引 | 两步 + 写后校验 | 防漂移 |
| 触发 | **仅 turn 收尾** | 对齐 CC stopHooks |
| 默认开关 | **`autoMemoryEnabled: true`** | 对齐 CC |
| 节流 | **每 1 个 eligible turn** | 对齐 CC `tengu_bramble_lintel` |
| 读工具范围 | workspace ∪ memdir | 多租户安全 |
| 写工具范围 | 仅 memdir | 同 CC |
| 队列锁 | **memdir 路径** | 多 session 同 repo |
| 文件名 | 任意 + frontmatter type | 对齐 CC，非强制前缀 |
| 注入顺序 | AGENTS → Auto memory | 人工规范优先 |

---

## 11. 一句话

**Instructions = 人写的仓库宪法；Session Memory = 这一局的草稿本；Auto Memory = 跨局仍有用的便签柜（索引进场，细节按需读；默认开、收尾抽）。**
