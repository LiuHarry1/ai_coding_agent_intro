# Claude Code Session Memory 实现细节

> 基于源码：`/Users/harry/cursor_workspace/public_repo/claude-code-rev`  
> 核心目录：`src/services/SessionMemory/`、`src/services/compact/sessionMemoryCompact.ts`  
> 文档日期：2026-07-26

---

## 1. 一句话定义

Session Memory = **单会话、后台维护的一份结构化 Markdown 工作笔记**（`summary.md`）。  
对话增长时不断 Edit 更新；到 compact 阈值时，**优先直接拿这份文件当 compact summary**，从而跳过「整段对话再 LLM 总结」的 full compact。

它不是跨会话记忆，也不是第三种压缩算法。

---

## 2. 模块与文件

| 文件 | 职责 |
|------|------|
| `SessionMemory/sessionMemory.ts` | 初始化、触发判定、fork 抽取、手动 `/summary` |
| `SessionMemory/sessionMemoryUtils.ts` | 阈值配置、cursor（`lastSummarizedMessageId`）、等待抽取完成 |
| `SessionMemory/prompts.ts` | 模板、更新 prompt、空模板检测、compact 前截断 |
| `compact/sessionMemoryCompact.ts` | Session Memory Compact（用笔记代替 LLM summary） |
| `compact/autoCompact.ts` | Auto compact 时先 `trySessionMemoryCompaction` |
| `commands/compact/compact.ts` | 手动 `/compact`（无自定义指令时）同样优先 SM compact |
| `setup.ts` | 启动时 `initSessionMemory()` |
| `permissions/filesystem.ts` | 路径：`…/<sessionId>/session-memory/summary.md` |

---

## 3. 存储

### 3.1 路径

```
{projectDir}/{sessionId}/session-memory/summary.md
```

- `projectDir`：`~/.claude/projects/<sanitized-cwd>/`
- 目录权限：`0o700`；文件：`0o600`
- 首次创建用 `wx`（O_CREAT\|O_EXCL），再写入模板；已存在则不覆盖

### 3.2 模板结构（10 个固定章节）

默认模板 `DEFAULT_SESSION_MEMORY_TEMPLATE`：

1. **Session Title** — 5–10 词高密度标题  
2. **Current State** — 正在做什么 / pending / 下一步（compact 续接最关键）  
3. **Task specification** — 用户要什么、设计决策  
4. **Files and Functions** — 关键文件与作用  
5. **Workflow** — 常用命令与如何解读输出  
6. **Errors & Corrections** — 错误修复 + 用户纠正 + 勿再试的路  
7. **Codebase and System Documentation** — 系统如何拼在一起  
8. **Learnings** — 有效/无效做法（勿与其它节重复）  
9. **Key results** — 用户要的完整输出（表、答案等原文）  
10. **Worklog** — 极简步骤日志  

每个 `#` 标题后有一行斜体 `_…_`：**模板说明，禁止改**；模型只改说明下面的正文。

可自定义：

- `~/.claude/session-memory/config/template.md`
- `~/.claude/session-memory/config/prompt.md`（支持 `{{currentNotes}}`、`{{notesPath}}`）

### 3.3 体量预算

| 限制 | 值 | 作用时机 |
|------|-----|----------|
| 单节建议上限 | ~2000 tokens | 更新 prompt 里提醒压缩 |
| 整文件建议上限 | ~12000 tokens | 超则 CRITICAL 要求大幅 condensed |
| Compact 注入时硬截断 | 单节约 `2000*4` 字符 | `truncateSessionMemoryForCompact`，防撑爆 post-compact 预算 |

超限截断后会追加：完整文件路径提示。

---

## 4. 生命周期与触发

### 4.1 初始化

```
setup.ts
  → initSessionMemory()
       若 remote mode → return
       若 auto-compact 关闭 → return（SM 主要为 compact 服务）
       否则 registerPostSamplingHook(extractSessionMemory)
```

Gate **不在 init 时检查**，而在 hook 运行时懒检查（避免阻塞启动）。

### 4.2 何时更新（`shouldExtractMemory`）

计量与 autocompact 一致：`tokenCountWithEstimation(messages)`（上下文窗口占用，不是累计 API billing）。

**默认阈值**（`tengu_sm_config` 可覆盖，仅正数生效）：

| 配置项 | 默认 | 含义 |
|--------|------|------|
| `minimumMessageTokensToInit` | 10_000 | 上下文达到后才开始抽 |
| `minimumTokensBetweenUpdate` | 5_000 | 距上次抽取上下文再涨这么多 |
| `toolCallsBetweenUpdates` | 3 | 距上次触发累计 tool_use 次数 |

触发逻辑（**token 增长门槛始终必需**）：

```
(已涨够 tokens AND tool calls ≥ 3)
  OR
(已涨够 tokens AND 上一轮 assistant 没有 tool_use)   ← 对话自然停顿时也抽
```

设计意图：

- 避免工具风暴中每轮都抽  
- 又在「说完一轮、暂时不调工具」时及时落盘 Current State  

仅主线程：`querySource === 'repl_main_thread'`（subagent / teammate 不跑）。

Feature gate：`tengu_session_memory`（GrowthBook 缓存，可能略 stale）。

### 4.3 抽取执行（`extractSessionMemory`）

用 `sequential(...)` 包装 → **同一时间只有一次抽取**（排队串行）。

流程：

1. `markExtractionStarted()`（compact 侧会 wait）  
2. `createSubagentContext` — 隔离 `readFileState`，不污染主会话  
3. `setupSessionMemoryFile` — mkdir + 确保文件 + **清除该 path 的 read cache** + FileReadTool 读全文  
4. `buildSessionMemoryUpdatePrompt` — 注入当前内容 + 路径 + 分节超限提醒  
5. `runForkedAgent`：
   - `cacheSafeParams: createCacheSafeParams(context)` → **共享父会话 prompt cache**
   - `canUseTool`: **只允许 Edit 精确等于 `memoryPath` 的路径**（其它一律 deny）
   - `querySource: 'session_memory'`（防 compact 递归等）
   - `forkLabel: 'session_memory'`
6. `recordExtractionTokenCount`  
7. `updateLastSummarizedMessageIdIfSafe` — **仅当上一轮 assistant 没有 tool_use** 时才更新 cursor（避免悬空 tool_result）  
8. `markExtractionCompleted()`

主会话消息列表**不被替换**；fork 只改磁盘文件。

### 4.4 手动触发

`manuallyExtractSessionMemory` — 注释写明供 **`/summary`** 使用：跳过阈值，同样 fork + 只 Edit summary.md。

---

## 5. Compact 如何消费 Session Memory

### 5.1 入口优先级

**Auto compact**（`autoCompactIfNeeded`）：

```
shouldCompact?
  → trySessionMemoryCompaction(...)
       成功 → wasCompacted，return（不再 full LLM compact）
       null  → compactConversation(...)   // 传统 full compact
```

**手动 `/compact`**（无 custom instructions 时）：同样先 `trySessionMemoryCompaction`；有自定义指令则跳过 SM（SM compact 不支持自定义总结指令）。

开关：

- `tengu_session_memory` **且** `tengu_sm_compact`
- 或 env：`ENABLE_CLAUDE_CODE_SM_COMPACT=1` / `DISABLE_CLAUDE_CODE_SM_COMPACT=1`

### 5.2 `trySessionMemoryCompaction` 细节

```
1. waitForSessionMemoryExtraction()
   - 若正在抽：最多等 15s
   - 抽取已跑 >60s 视为 stale，不等

2. 读 summary.md
   - 无文件 → null
   - 内容 trim 后 == 模板 → null（尚未真正抽取）

3. 定 lastSummarizedIndex
   - 有 lastSummarizedMessageId 且在 messages 中 → 用其 index
   - id 找不到 → null（无法划界，回退 full compact）
   - 无 id（resume 等）→ 设为 messages.length-1
     （注释写 “keep all”；实际是先不 keep，再靠 minTokens 向前扩尾部）

4. calculateMessagesToKeepIndex
   - 默认从「已总结边界」之后开始
   - 向前扩展直到：
       tokens ≥ minTokens(10k) 且 text-block 消息数 ≥ 5
     或 tokens ≥ maxTokens(40k) 停下
   - floor：不得越过上一个 compact boundary
   - adjustIndexToPreserveAPIInvariants：不拆 tool_use/tool_result，不丢同 message.id 的 thinking

5. createCompactionResultFromSessionMemory
   - truncateSessionMemoryForCompact
   - getCompactUserSummaryMessage(content, suppressFollowUp=true, transcriptPath, recentMessagesPreserved=true)
   - 造 compact boundary + isCompactSummary user message
   - SessionStart hooks（重注 CLAUDE.md 等）
   - 可选 plan attachment

6. 若提供了 autoCompactThreshold 且压完仍 ≥ 阈值 → null（回退 full）

7. 成功后 autoCompact 侧：
   - setLastSummarizedMessageId(undefined)  // 旧 uuid 会被 prune 掉
   - postCompact cleanup / cache-break 通知
```

### 5.3 Compact 后消息形态

```
[compact boundary marker]
[user: isCompactSummary = true]
    "This session is being continued from a previous conversation..."
    + summary.md 正文（可能分节截断）
    + transcript 路径提示
    + "Recent messages are preserved verbatim."
    + "Continue ... without asking ... Pick up the last task..."
[messagesToKeep：尾部原文]
[hook results / plan attachments …]
```

**关键：此路径没有调用 compact summarizer LLM。**  
成本 ≈ 读文件 + 拼消息；质量取决于此前后台抽取是否及时、Current State 是否新。

### 5.4 与 Full Compact 对照

| | Session Memory Compact | Full Compact (`compactConversation`) |
|--|------------------------|--------------------------------------|
| Summary 来源 | 磁盘 `summary.md` | 触发时 LLM 读对话生成 `<analysis>+<summary>` |
| 触发时 API | 无（抽取已在平时付过） | 一次大总结调用 |
| 尾部消息 | **保留**一段（10k–40k / ≥5 text msgs） | 实现可不同；CC full 后靠 attachments 重建 |
| 失败策略 | 多条件 return null → 回退 full | 自身失败另计 |
| Custom `/compact` 指令 | 不支持 | 支持 |

---

## 6. 关键工程细节

### 6.1 Prompt Cache 友好

Fork 用 `createCacheSafeParams`：与主会话相同 system / tools / 前缀消息，尽量命中 cache。抽取是「在完整对话后追加一条 note-taking 指令」，再只允许 Edit。

### 6.2 工具沙箱极严

`createMemoryFileCanUseTool`：**仅** `Edit` + `file_path === memoryPath`。  
不能 Read/Bash/Write 其它文件（当前内容已塞进 prompt 的 `<current_notes_content>`）。

### 6.3 Cursor：`lastSummarizedMessageId`

- 抽取成功且最后一轮无 tool_use → 更新  
- SM compact 成功后 → **清空**（消息被 prune，旧 id 失效）  
- Compact 用它划分「笔记已覆盖 / 还需保留原文」的边界  

### 6.4 与其它系统的边界

| 系统 | 关系 |
|------|------|
| Micro-compact | 无关；仍可先清旧 tool 结果 |
| Full compact | SM compact 失败时的 fallback |
| Auto Memory / memdir | 无关；跨会话事实不在 summary.md |
| Remote mode | `initSessionMemory` 直接跳过 |
| `querySource === 'session_memory'` | Autocompact 递归守卫会跳过 |
| Reactive-only / Context-collapse | 可能抑制 **auto** compact 路径；手动 `/compact` 仍可试 SM |

### 6.5 观测事件（节选）

| Event | 含义 |
|-------|------|
| `tengu_session_memory_init` | 初始化（是否开了 autocompact） |
| `tengu_session_memory_gate_disabled` | gate 关（ant 每会话一次） |
| `tengu_session_memory_file_read` | 读文件 |
| `tengu_session_memory_extraction` | 一次后台抽取 + token/配置 |
| `tengu_session_memory_manual_extraction` | `/summary` |
| `tengu_sm_compact_*` | compact 路径：无文件/空模板/id 丢失/超阈值/error/成功相关 |

### 6.6 其它消费者

- Attachment 类型 `current_session_memory`（UI 侧常为 null-render）  
- Bundled skill `skillify` 会引用 `<session_memory>` 块  
- `sessionFileAccessHooks` 对 session-memory 路径访问打点  

---

## 7. 端到端时序

```
对话开始（上下文 < 10k）
  → 不抽 Session Memory

上下文 ≥ 10k，且之后再涨 ≥ 5k，并满足 tool 次数或自然停顿
  → post-sampling hook
  → fork agent Edit summary.md
  → 更新 lastSummarizedMessageId（若安全）

……多次增量更新……

上下文触及 autocompact 阈值
  → wait 抽取（≤15s）
  → 读 summary.md
  → 若可用：boundary + SM summary + keep 尾部  → 完成
  → 若不可用：full LLM compactConversation

Compact 后
  → lastSummarizedMessageId = undefined
  → 继续对话；上下文再涨后再抽新笔记
```

---

## 8. 实现上的设计取舍（读源码可见）

1. **为 compact 服务**：autocompact 关则不 init；Current State 在 prompt 里被标成「compact 后续接关键」。  
2. **增量 Edit 而非整文件重写**：保留章节骨架，降低结构漂移。  
3. **Token 门槛硬约束**：即使 tool 很多，没涨够上下文也不抽，控成本。  
4. **宁可不 SM compact**：空模板 / 丢 cursor / 压完仍超阈 → 明确回退 full，不硬用烂笔记。  
5. **尾部原文 + 笔记**：纯笔记会丢最近工具细节；keep recent 补上「刚发生」的精确性。  
6. **权限最小化**：fork 几乎不能碰盘，只改一个文件。  

---

## 9. 对自研 Agent 的可移植清单

若要在类似 `src` 的栈上复刻，最小闭环：

1. **路径**：`.sessions/{id}/session-memory/summary.md` + 固定模板  
2. **Hook**：主 agent 回合结束后，按 token/tool 阈值 fork（或侧路小模型）只改该文件  
3. **沙箱**：只能 Edit 该 path  
4. **Cursor**：记录「笔记覆盖到哪条 message id」  
5. **Compact 分支**：阈值到时先读文件；非空则拼 summary 消息 + keep 尾部；否则走现有 full compact  
6. **Compact 成功后**重置 cursor  

可选增强：自定义 template/prompt、分节预算、与 `/summary` 共用同一抽取函数、压后超阈回退。

---

## 10. 源码锚点速查

```
initSessionMemory              sessionMemory.ts
shouldExtractMemory            sessionMemory.ts
extractSessionMemory           sessionMemory.ts（post-sampling hook）
createMemoryFileCanUseTool     sessionMemory.ts
manuallyExtractSessionMemory   sessionMemory.ts
DEFAULT_SESSION_MEMORY_*       prompts.ts / sessionMemoryUtils.ts
truncateSessionMemoryForCompact prompts.ts
trySessionMemoryCompaction     sessionMemoryCompact.ts
calculateMessagesToKeepIndex   sessionMemoryCompact.ts
autoCompactIfNeeded            autoCompact.ts（先 SM 后 full）
/compact call                  commands/compact/compact.ts
getSessionMemoryPath           permissions/filesystem.ts
```

---

## 11. 结论

Session Memory 在 CC 里是一条完整的 **「平时记账 → 满窗直接用账」** 管线：

- **产出**：一份持续更新的结构化 `summary.md`  
- **主消费者**：Session Memory Compact（替换 full LLM summarizer）  
- **价值**：降低 compact 成本与延迟，并靠固定章节（尤其 Current State / Errors）提高长会话续接稳定性  

没有它，micro + full compact 仍能腾窗口；有了它，full compact 从「每次现场写摘要」变成「多数时候读已写好的摘要」。
