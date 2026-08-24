# Coding Agent 记忆系统入门

> 面向还不熟悉「agent memory」的读者。  
> 基于本仓库 `src/` 的实际实现（不是 Claude Code 源码导读）。  
> 相关代码：`src/utils/rules-loader.ts`、`src/services/auto-memory/`、`src/services/session-memory/`、`src/services/compact/`、`src/turn/memory-lifecycle.ts`。

---

## 1. 先搞清楚：Agent 为什么需要「记忆」？

大模型每次对话都有一个 **上下文窗口（context window）**——能塞进模型的文字总量有上限（大约按 token 计）。

Coding agent 会不断：

- 读你的消息
- 读文件、跑命令、搜代码（工具结果往往很长）
- 再回复、再调工具……

对话一长，历史消息就会把窗口塞满。满了以后有两个问题：

1. **塞不下** → 必须丢掉或压缩旧内容，否则模型报错 / 拒绝继续。
2. **新开会话时什么都不记得** → 上次聊过的偏好、约定、项目冷知识会丢失。

所以本项目的「记忆」不是一个单一模块，而是好几层互相配合的机制：

| 层 | 一句话 | 管多久 |
|----|--------|--------|
| **Project Rules** | 你写好的项目说明书，开聊就塞进提示词 | 跨会话（人工维护） |
| **Auto Memory** | 自动记下「下次还会用」的偏好/事实；每轮 **prefetch** 召回 ≤5 篇主题文件 | 跨会话（自动 + 半自动） |
| **Session Memory** | 当前这次会话的进度笔记 | 单会话 |
| **Compaction** | 上下文快满时，把旧对话压短 | 运行时（为了继续聊） |

可以把它想成人类工作方式：

- **Project Rules** = 写在墙上的团队规范（AGENTS.md）
- **Auto Memory** = 你随身带的记事本（偏好、踩坑经验）
- **Session Memory** = 今天这张草稿纸上的任务进度
- **Compaction** = 草稿纸写满了，先擦掉旧的大段日志，只留摘要和最近几行

---

## 2. 总览：一次对话里它们怎么串起来

```
会话启动 / 每轮 prepare
  │
  ├─ loadAllAgentRules()             ← user ~/.ai-agent/AGENTS.md + 项目 AGENTS.md / local
  └─ buildAutoMemorySystemAppend()   ← 只注入「如何写 memory」指南（**不再**塞整份 MEMORY.md）

用户发消息
  └─ startRelevantMemoryPrefetch()   ← small 模型选 ≤5 个主题文件（不阻塞）

每个 agent step 之前
  └─ compactIfNeeded()
        ├─ ① micro-compaction（清旧工具结果，不调大模型）
        └─ ② 仍超阈值？→ Session Memory Compact 或 Full Compact

每个 step 之后（tools 跑完）
  ├─ 若 prefetch 已 settled → 注入 relevant_memories attachment（user + isMeta）
  └─ Session Memory 后台抽取（fire-and-forget）

整轮结束（本轮不再调工具）
  └─ Auto Memory 后台抽取（fire-and-forget）→ 主题 .md（prefetch 模式下不强制维护 MEMORY.md 索引）
```

挂载点在代码里很清晰：

- 启动注入：`prepare_chat_turn.ts`
- 压缩入口：`compactIfNeeded`（`services/compact/autoCompact.ts`）
- 后台抽取钩子：`createMemoryLifecycleHooks`（`turn/memory-lifecycle.ts`）
  - `onAfterStep` → Session Memory
  - `onTurnEnd` → Auto Memory

---

## 3. Project Rules（项目规则）

### 这是什么？

**人工写的指令**，告诉 agent：这个仓库怎么协作、用什么风格、禁止做什么。  
它不是「学出来的记忆」，而是「你规定的行为」。冲突时通常优先于模型默认习惯。

### 从哪里加载？

实现：`src/utils/rules-loader.ts` 的 `loadProjectRules(cwd)`。

从当前工作目录一路向上走到 git root，收集：

1. 目录下的 `AGENTS.md`
2. `{appDir}/AGENTS.md`（默认 `.ai-agent/AGENTS.md`）
3. `{appDir}/rules/*.md`（按文件名排序）

规则：

- **离 cwd 越近的文件越晚加载** → 对模型来说优先级更高（后出现的内容更受关注）
- 单文件约 40KB 上限，合并后也有总上限
- 多份规则会带 `<!-- from ... -->` 来源标注

### 怎么进模型？

准备一轮聊天时读出原文，放进 system prompt 的 **Project rules** 区域。  
子 agent 也可以注入；部分内置 agent（如 plan）可设 `omitProjectRules: true` 跳过。

### 你该怎么用？

在仓库里维护：

```text
AGENTS.md                 # 或
.ai-agent/AGENTS.md
.ai-agent/rules/*.md      # 按主题拆分也可以
```

适合写：构建命令、代码风格、测试要求、安全红线、目录约定等 **稳定规范**。  
不适合写：今天做到哪一步、临时 bug 现场——那些交给 Session / Auto Memory。

---

## 4. Auto Memory（跨会话自动记忆）

### 这是什么？

跨会话的 **结构化主题记忆**：用户偏好、纠错反馈、项目里「代码读不出来」的事实、外部资料指针等。  
下次你打开同一个仓库再聊，agent 仍能通过索引想起这些事。

和 Project Rules 的区别：

| | Project Rules | Auto Memory |
|--|---------------|-------------|
| 谁写 | 主要是你 | agent 自动写 / 你也可要求记住 |
| 性质 | 规范、指令 | 偏好、反馈、冷知识 |
| 位置 | 仓库内（常进 git） | 默认在用户主目录下，避免误提交 |

### 存在哪里？

默认路径（概念上）：

```text
~/.ai-agent/projects/<仓库路径消毒后的名字>/memory/
├── MEMORY.md           # 索引（会注入上下文）
├── prefer-concise.md   # 主题文件示例
└── …
```

解析优先级大致是：

1. 受信配置里的 `autoMemory.directory` / `autoMemoryDirectory`（**只允许 user/local settings，禁止项目配置劫持**）
2. 上面的默认 `~/.ai-agent/projects/.../memory/`

同一 git 仓库的 worktree 会归一到主仓，共享一份 memory。  
在 settings 里设 `autoMemory.enabled: false` 可关掉整族；`prefetchEnabled: false` 只关每轮召回。SSH Remote 会跳过 memdir / prefetch。

### 记什么 / 不记什么？

四种类型（frontmatter 里的 `type`）：

- **user** — 你是谁、怎么协作
- **feedback** — 「别这样写」「要那样测」
- **project** — 代码里推不出来的项目事实
- **reference** — 外部文档/链接指针

明确 **不要** 记（见 `services/auto-memory/types.ts`）：

- 当前代码/目录结构里已经能读到的东西
- git 历史（`git log` 更权威）
- 已经写在 AGENTS.md 里的规范
- **仅对当前这次任务有用** 的临时进度（那是 Session Memory / Todo / Plan 的事）

### 怎么写入？

两条路径：

1. **主 agent 直接写**：对话中用 Write/Edit 往 memory 目录写主题文件，并更新 `MEMORY.md` 索引。
2. **回合结束自动抽取**：整轮结束（没有更多 tool calls）时，后台 fork 一个受限子 agent，只允许读搜 + 写 memory 目录，补抽本轮值得记住的内容。

触发钩子：`memory-lifecycle.ts` 的 `onTurnEnd` → `extractAutoMemoriesInBackground`。  
有节流（例如每 N 个 eligible turn）；若本轮已经写过 memory，会跳过重复抽取。

### 怎么读回来？

会话启动时 `buildAutoMemorySystemAppend()`：

1. 注入「如何使用 auto memory」的指南
2. 若 `MEMORY.md` 非空，再注入截断后的 **索引**（不是整本笔记）

索引太长会截断；细节要靠模型按需 `Read` memory 目录里的主题文件。  
注入排在 Project Rules **之后**：人工规范优先。

---

## 5. Session Memory（会话笔记）

### 这是什么？

**当前这一次会话** 的进度账本。平时在后台慢慢记；上下文快满做 compact 时，优先拿这份笔记当摘要，而不是临时再让模型从头总结整段聊天。

口号可以记成：**平时记账，满窗读账**。

### 存在哪里？

```text
.sessions/{sessionId}/session-memory/summary.md
```

模板固定若干节（实现里约 10 节），例如：

- Session Title / Current State / Task specification
- Files and Functions / Workflow / Errors & Corrections
- Codebase and System Documentation / Learnings / Key results / Worklog

其中 **Current State** 最关键：compact 之后靠它接上「现在做到哪」。

### 什么时候更新？

每个 step 结束后后台抽取（`onAfterStep`），不阻塞你看回复。  
通常还要满足 token / tool-call 间隔阈值，避免每句话都重写一遍。  
抽取本身是 fork 出去的小任务：默认 cache-safe（尽量复用主循环的模型与 prompt cache），但工具权限收得很紧——基本上只许改 `summary.md`。

注意：Session Memory 的自动抽取还要求 **compaction 总开关是开的**；compaction 关了，这套「为 compact 准备的账」也不会跑。

### 和 Auto Memory 别搞混

| | Session Memory | Auto Memory |
|--|----------------|-------------|
| 生命周期 | 这次会话 | 跨会话 |
| 典型内容 | 当前任务进度、刚改的文件、下一步 | 偏好、纠错、长期事实 |
| 主要消费者 | Compaction | 下次新对话的 system 注入 |
| 触发时机 | 每个 step 后 | 整轮 turn 结束 |

---

## 6. Compaction（上下文压缩）家族

Compaction 解决的是：**窗口快满了，怎么腾出空间继续干活**。  
入口：`compactIfNeeded`，在每个 agent step **之前**调用。

可以分成三档，从轻到重：

### 6.1 Micro-compaction（微压缩）

- **不调用大模型**，几乎免费
- 只处理「旧的工具调用内容」：
  - 读类工具（bash / grep / read / web…）：清掉 **输出**
  - 写类工具（write / edit…）：清掉 **输入**
- 工具调用的「壳」还在，保证 tool_call ↔ tool_result 配对不断裂
- 被清掉的地方换成简短占位说明（例如 *Old tool result content cleared…*）
- 默认保留最近 N 条工具结果原文（`microCompactKeepRecent`）

何时触发：

- token 接近「完整 compact」阈值前一段距离（提前量）
- 或手动 / 激进模式
- 或（可选）距上次 assistant 回复已过很久——prompt cache 反正冷了，顺手清一下

Micro 做完如果已经低于完整 compact 阈值，就到此为止。

### 6.2 Session Memory Compact（优先的「真压缩」）

若 micro 之后仍超阈值（或手动 `/compact`）：

1. 先等一会儿后台 Session Memory 抽取写完（避免读到半成品）
2. 若 `summary.md` 可用且游标可信：
   - 用笔记生成一条 compact summary 消息
   - 丢掉笔记已覆盖的旧消息
   - **保留**尾部一段最近对话（`messagesToKeep`）
   - 再挂上 todos、最近读过的文件片段、attachment 等

这条路径 **不再额外调用一次「总结全文」的 LLM**，所以更快、也更稳。

### 6.3 Full Compact（完整 LLM 压缩）

Session Memory 不可用时的后备：再调一次模型，把旧对话收成摘要，形状与上一条相同：

```text
[boundary] + [summary 消息] + [messagesToKeep] + [attachments…]
```

连续失败多次会触发简易熔断，避免反复 compact 打挂会话。

### 阈值直觉（不必背数字）

配置在 `CompactionConfig`：以 `contextWindow` 为底，减去输出预留和安全 buffer，得到 auto-compact 阈值；micro 阈值再往前挪一截。  
也可用环境变量覆盖（如 `COMPACT_THRESHOLD_OVERRIDE`、`DISABLE_AUTO_COMPACT` 等）。

---

## 7. 一张表：四层各自负责什么

| 机制 | 解决什么问题 | 谁触发 | 是否调 LLM | 持久化 |
|------|--------------|--------|------------|--------|
| Project Rules | 稳定规范从哪来 | 会话启动加载 | 否（读文件） | 仓库文件 |
| Auto Memory | 跨会话记住偏好/事实 | 启动注入；turn 结束抽取；或主 agent 当场写 | 抽取时可能 fork | `~/.ai-agent/.../memory/` |
| Session Memory | 本会话进度账 | 每 step 后抽取 | fork 抽取 | `.sessions/.../summary.md` |
| Micro-compaction | 便宜地甩掉旧工具大包 | step 前，接近阈值 | 否 | 改内存中的 messages |
| SM / Full Compact | 真的缩短历史 | step 前超阈值或手动 | SM 否 / Full 是 | 写入会话 transcript |

---

## 8. 小白常见问题

**Q：Agent「记住了」是不是把所有聊天都存进了数据库？**  
A：不是。跨会话主要靠你写的 AGENTS.md + auto-memory 目录里的主题文件；单会话靠消息历史 + summary.md。窗口满了还会主动丢掉细节。

**Q：我改了 AGENTS.md，旧会话会自动更新吗？**  
A：规则是每轮准备聊天时重新 `loadProjectRules` 的；新 turn 会看到新内容。已经发生过的旧消息不会改写。

**Q：为什么 compact 之后 agent 好像「忘了」中间某次命令的完整输出？**  
A：正常。Micro 或 Full/SM compact 会清掉或折叠旧工具结果。重要结论应已经进 Session Memory / 你的文件 / Auto Memory。

**Q：我想让它永远记住「回复短一点」——写哪？**  
A：长期偏好 → Auto Memory（或你直接写进 AGENTS.md）。不要塞进 Session Memory。

**Q：当前任务做到一半，怕 compact 丢进度——写哪？**  
A：Session Memory 的 Current State / Todo；重要里程碑也可以写进真正的文件或 Plan。

**Q：远程 SSH 会话呢？**  
A：当前实现里 remote 不会加载本地 Project Rules / Auto Memory 注入与抽取（避免把本机记忆路径套到远端工作区）。以 `prepare_chat_turn.ts` 为准。

---

## 9. 想继续深入时看这些文件

| 主题 | 代码 / 设计文档 |
|------|-----------------|
| 生命周期钩子 | `src/turn/memory-lifecycle.ts` |
| Project Rules | `src/utils/rules-loader.ts` |
| Auto Memory | `src/services/auto-memory/`，设计稿 `docs/reference/claude-code/auto-memory-design.md` |
| Session Memory | `src/services/session-memory/`，设计稿 `docs/reference/claude-code/session-memory-design.md` |
| Compaction 编排 | `src/services/compact/autoCompact.ts` |
| Micro-compaction | `src/services/compact/microCompact.ts` |
| 配置类型 | `src/core/types.ts` 里的 `CompactionConfig` / `SessionMemoryConfig` / `AutoMemoryConfig` |
| Claude Code 对照长文 | `docs/reference/claude-code/claude-code-memory-systems.md`（上游概念，不完全等于本仓库） |

---

## 10. 一句话收束

把本仓库的 memory 理解成四件事即可：

1. **Project Rules** — 你写的长期说明书  
2. **Auto Memory** — 跨会话的自动记事本  
3. **Session Memory** — 本会话进度账，专门喂给 compact  
4. **Compaction** — 先廉价清工具垃圾（micro），再必要时用账本或 LLM 把历史压短  

它们一起保证：规范稳定、偏好可延续、长对话还能继续干。
`)