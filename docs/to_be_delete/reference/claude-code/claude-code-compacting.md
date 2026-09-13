# Claude Code Compacting 功能详解

> 基于源码目录：`C:\Users\Harry\cursor_workspace\public\claude-code-rev`  
> 核心代码位于 `src/services/compact/`  
> 文档生成日期：2026-06-24

---

## 1. 概述

Claude Code（以下简称 CC）在长时间对话中会不断累积消息、工具结果、附件和系统上下文，最终逼近模型的 context window。**Compacting（上下文压缩）** 是一组分层策略，用于在**不丢失关键工作上下文**的前提下释放 token 空间。

CC 的 compacting 不是单一功能，而是**多层协作**的上下文管理系统：

| 层级 | 名称 | 触发时机 | 作用 |
|------|------|----------|------|
| L0 | Snip（历史裁剪） | 每轮 query 前 | 移除用户标记为 snip 的旧消息（UI 保留 scrollback） |
| L1 | Microcompact | 每轮 API 调用前 | 清除旧 tool result，不改动对话结构 |
| L1b | API Microcompact | API 请求参数 | 服务端 `context_management` 策略 |
| L2 | Context Collapse | 每轮 query 前（实验） | 结构化折叠旧上下文，保留粒度 |
| L3 | Auto Compact | token 超阈值 | 主动总结整段对话 |
| L3b | Session Memory Compact | auto/manual 优先尝试 | 用 session memory 文件代替 LLM 总结 |
| L4 | Reactive Compact | API 413 / prompt too long | 被动压缩，从尾部逐轮剥离再总结 |
| 手动 | `/compact` | 用户命令 | 手动触发完整压缩 |
| 手动 | Partial Compact | 消息选择器 | 以某条消息为 pivot 做部分总结 |

---

## 2. 架构总览

### 2.1 主循环中的执行顺序

每轮用户 query 进入 `src/query.ts` 后，在真正调用模型之前，按以下顺序处理消息：

```
原始 messages
  → content replacement（大结果替换）
  → snipCompactIfNeeded（HISTORY_SNIP）
  → microcompactMessages
  → applyCollapsesIfNeeded（CONTEXT_COLLAPSE）
  → autoCompactIfNeeded
  → callModel（正常对话）
  → 若 413/prompt-too-long → tryReactiveCompact（REACTIVE_COMPACT）
```

关键源码：`src/query.ts` 约 396–543 行（snip → microcompact → collapse → autocompact）。

### 2.2 模块依赖关系

```
src/query/deps.ts
  ├── microcompactMessages   ← microCompact.ts
  └── autoCompactIfNeeded    ← autoCompact.ts
        ├── trySessionMemoryCompaction  ← sessionMemoryCompact.ts
        └── compactConversation         ← compact.ts
              ├── streamCompactSummary（fork 或 streaming）
              ├── executePreCompactHooks / executePostCompactHooks
              └── createPostCompact*Attachments
```

手动命令入口：`src/commands/compact/compact.ts`（`/compact`）。

---

## 3. 完整压缩（Full Compact）

### 3.1 核心函数：`compactConversation`

文件：`src/services/compact/compact.ts`

**职责**：将**整段**（或 compact boundary 之后的）对话交给专门的 summarizer，生成结构化摘要，并用 boundary marker + summary 替换旧历史。

**流程**：

1. **PreCompact Hooks** — `executePreCompactHooks({ trigger: 'auto'|'manual' })`
2. **生成摘要** — `streamCompactSummary()` 调用 LLM
3. **清理本地状态** — 清空 `readFileState`、`loadedNestedMemoryPaths`
4. **并行重建附件** — 文件、plan、skill、deferred tools、MCP、async agent 等
5. **SessionStart Hooks** — `processSessionStartHooks('compact')` 重新注入 CLAUDE.md 等
6. **创建 boundary + summary 消息**
7. **PostCompact Hooks** — `executePostCompactHooks({ compactSummary })`
8. **返回 `CompactionResult`**

### 3.2 摘要生成：`streamCompactSummary`

两种路径，优先 **Prompt Cache Sharing（fork 路径）**：

#### 路径 A：Forked Agent（默认开启）

- Feature flag：`tengu_compact_cache_prefix`（默认 `true`）
- 通过 `runForkedAgent()` 复用主对话的 system prompt / tools / messages prefix 的 prompt cache
- `querySource: 'compact'`，`maxTurns: 1`，**禁止 tool use**（`createCompactCanUseTool()` 一律 deny）
- **不能**设置 `maxOutputTokens`，否则 thinking config 不匹配导致 cache miss

#### 路径 B：Streaming Fallback

- fork 失败或无文本输出时回退
- 独立 system prompt：`"You are a helpful AI assistant tasked with summarizing conversations."`
- thinking 关闭；可选 `FileReadTool` + `ToolSearchTool`（tool search 开启时）
- 发送前预处理：
  - `stripImagesFromMessages` — 图片/文档替换为 `[image]`/`[document]`
  - `stripReinjectedAttachments` — 去掉会在 post-compact 重新注入的 skill 附件
  - `getMessagesAfterCompactBoundary` — 只总结 boundary 之后的内容

#### Prompt Too Long 重试（CC-1180）

若 compact API 自身也 hit prompt-too-long：

- 调用 `truncateHeadForPTLRetry()` — 按 API round 分组，丢弃最旧的组
- 最多重试 3 次（`MAX_PTL_RETRIES`）
- 仍失败则抛出：`Conversation too long. Press esc twice...`

### 3.3 摘要 Prompt 结构

文件：`src/services/compact/prompt.ts`

- **`getCompactPrompt`** — 全量对话总结，9 个 section（Primary Request、Key Concepts、Files、Errors、Problem Solving、All user messages、Pending Tasks、Current Work、Optional Next Step）
- 要求输出 `<analysis>` + `<summary>` XML 块；`formatCompactSummary()` 会 strip analysis，格式化 summary
- **`NO_TOOLS_PREAMBLE`** — 强制纯文本，防止 Sonnet 4.6+ 误调 tool 浪费唯一 turn

### 3.4 压缩后消息组装

`buildPostCompactMessages(result)` 固定顺序：

```
boundaryMarker
→ summaryMessages（isCompactSummary: true）
→ messagesToKeep（partial/reactive/SM-compact 才有）
→ attachments（文件/plan/skill/tools 等）
→ hookResults（SessionStart hooks）
```

Boundary 消息类型：`system` + `subtype: 'compact_boundary'`，含 `compactMetadata`（trigger、preTokens、preCompactDiscoveredTools、preservedSegment 等）。

---

## 4. 自动压缩（Auto Compact）

### 4.1 核心函数

文件：`src/services/compact/autoCompact.ts`

- **`shouldAutoCompact`** — 判断是否该压缩
- **`autoCompactIfNeeded`** — 执行压缩并返回 `CompactionResult`
- **`calculateTokenWarningState`** — 计算 warning/error/blocking 阈值状态（供 UI `/context` 使用）

### 4.2 Token 阈值计算

```typescript
effectiveContextWindow = contextWindow(model) - min(maxOutputTokens, 20_000)
autoCompactThreshold     = effectiveContextWindow - 13_000  // AUTOCOMPACT_BUFFER_TOKENS
warningThreshold         = autoCompactThreshold - 20_000
errorThreshold           = autoCompactThreshold - 20_000
blockingLimit            = effectiveContextWindow - 3_000   // MANUAL_COMPACT_BUFFER_TOKENS
```

**Token 计数 canonical 函数**：`tokenCountWithEstimation(messages)`（`src/utils/tokens.ts`）

- 使用最后一次 API response 的 usage（input + output + cache）
- 对之后新增的消息做 rough estimate
- 处理 parallel tool call 导致的 assistant 消息拆分（按 `message.id` 回溯 sibling）

### 4.3 启用/禁用条件

| 条件 | 效果 |
|------|------|
| `DISABLE_COMPACT=1` | 禁用所有 compact（含 manual） |
| `DISABLE_AUTO_COMPACT=1` | 仅禁用自动压缩，manual `/compact` 仍可用 |
| `config.autoCompactEnabled = false` | 用户设置关闭 |
| `querySource === 'compact' \| 'session_memory'` | 防递归 |
| `REACTIVE_COMPACT` + `tengu_cobalt_raccoon` | 抑制 proactive autocompact |
| `CONTEXT_COLLAPSE` 开启 | 由 collapse 接管，autocompact 关闭 |

环境变量 override：

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — 限制有效 context window
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — 按百分比设置阈值（测试用）
- `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` — 覆盖 blocking limit

### 4.4 自动压缩优先级

`autoCompactIfNeeded` 内部顺序：

1. **Circuit breaker** — 连续失败 ≥ 3 次则跳过（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`）
2. **Session Memory Compact** — `trySessionMemoryCompaction()`（实验，需 feature flags）
3. **Legacy Full Compact** — `compactConversation(..., isAutoCompact: true, suppressFollowUpQuestions: true)`

成功后：

- `setLastSummarizedMessageId(undefined)`
- `runPostCompactCleanup(querySource)`
- 重置 `autoCompactTracking`（turnCounter、turnId、consecutiveFailures）

Autocompact 失败**不弹错误通知**（manual 才会）；下轮继续重试，直到 circuit breaker 触发。

---

## 5. Session Memory Compact（实验）

文件：`src/services/compact/sessionMemoryCompact.ts`

**思路**：CC 在后台维护 session memory 文件（Markdown），持续提取对话要点。压缩时**直接读取该文件作为 summary**，无需再调 LLM，成本更低、速度更快。

### 5.1 启用条件

- GrowthBook：`tengu_session_memory` && `tengu_sm_compact`
- 或 env：`ENABLE_CLAUDE_CODE_SM_COMPACT=1`
- 禁用：`DISABLE_CLAUDE_CODE_SM_COMPACT=1`

### 5.2 保留消息策略

基于 `lastSummarizedMessageId`（上次 SM 提取覆盖到的消息 UUID）：

1. 从该 ID 之后开始保留
2. 向后扩展直到满足：
   - `minTokens`（默认 10,000）
   - `minTextBlockMessages`（默认 5）
3. 不超过 `maxTokens`（默认 40,000）
4. `adjustIndexToPreserveAPIInvariants()` — 不拆分 tool_use/tool_result 对、不丢失 thinking 块

### 5.3 与 Full Compact 的差异

| 项目 | Session Memory | Full Compact |
|------|----------------|--------------|
| Summary 来源 | 磁盘 session memory 文件 | LLM 实时生成 |
| 保留最近消息 | 是（messagesToKeep） | 否（全替换） |
| 额外 LLM 调用 | 无 | 有（compact API call） |
| 自定义 instructions | 不支持 | 支持（manual） |
| post-compact 附件 | 较少（plan 等） | 完整（文件/skill/tools 等） |

若 SM compact 后 token 仍 ≥ autoCompactThreshold，则**放弃** SM 路径，回退 legacy compact。

---

## 6. Microcompact（微压缩）

文件：`src/services/compact/microCompact.ts`

**目标**：在每轮 API 调用前**轻量**释放空间，**不改变对话语义结构**（不做 LLM 总结）。

### 6.1 三条路径（按优先级）

#### ① Time-based Microcompact

- Config：`tengu_slate_heron`（默认 disabled）
- 当距上次 assistant 消息超过 `gapThresholdMinutes`（默认 60 分钟）时触发
- 逻辑：服务端 prompt cache 已过期，反正要全量 rewrite → 提前把旧 tool result 内容替换为 `[Old tool result content cleared]`
- 保留最近 N 个 compactable tool results（`keepRecent`，默认 5）
- **直接修改本地 message content**（与 cached MC 不同）

#### ② Cached Microcompact（内部/ant 构建）

- Feature：`CACHED_MICROCOMPACT`
- 通过 API 的 **cache_edits** 机制删除旧 tool result，**不修改本地 messages**
- 仅 main thread 运行（`querySource.startsWith('repl_main_thread')`）
- 可 compact 的工具：`Read`、`Bash/Shell`、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`Edit`、`Write`
- 状态：`cachedMCState`（registeredTools、deletedRefs、pinnedEdits）
- API 层插入 `cache_reference` + `cache_edits` blocks

#### ③ Legacy path

- 已移除；外部构建若 cached MC 不可用，microcompact 为 no-op，依赖 autocompact

### 6.2 与 Autocompact 的关系

Microcompact 在 autocompact **之前**运行（`query.ts`）。若 microcompact 释放足够 token，可能避免触发 autocompact。

Snip 释放的 token 通过 `snipTokensFreed` 参数传给 `shouldAutoCompact`，因为 `tokenCountWithEstimation` 读的是 assistant usage，看不到 snip 节省的空间。

---

## 7. API Microcompact

文件：`src/services/compact/apiMicrocompact.ts`

在 API 请求中附加 `context_management.edits` 策略，由**服务端**执行 tool result / thinking 清理：

| 策略类型 | 作用 |
|----------|------|
| `clear_thinking_20251015` | 保留 thinking（redact-thinking 活跃时跳过） |
| `clear_tool_uses_20250919` | 按 input_tokens 阈值清除 tool uses/results |

环境变量（ant-only tool clearing）：

- `USE_API_CLEAR_TOOL_RESULTS=1` — 清除 Read/Shell/Grep 等**结果**
- `USE_API_CLEAR_TOOL_USES=1` — 清除 Edit/Write 等**调用**（exclude_tools 反向配置）

默认阈值：

- `DEFAULT_MAX_INPUT_TOKENS = 180_000`（trigger）
- `DEFAULT_TARGET_INPUT_TOKENS = 40_000`（保留目标）

---

## 8. Partial Compact（部分压缩）

文件：`src/services/compact/compact.ts` → `partialCompactConversation`

入口：`src/screens/REPL.tsx` 消息选择器的 compact 操作。

### 8.1 两种方向

| 方向 | 总结范围 | 保留范围 | Prompt Cache |
|------|----------|----------|--------------|
| `from` | pivot 之后的消息 | pivot 之前 | 保留部分失效（summary 在 kept 之后） |
| `up_to` | pivot 之前的消息 | pivot 之后 | prefix 可命中 cache |

`up_to` 会从 kept 消息中过滤旧的 compact boundary 和 summary，避免 `findLastCompactBoundaryIndex` 误选旧 boundary。

### 8.2 元数据

Summary 消息可带 `summarizeMetadata`：

```typescript
{ messagesSummarized, userContext, direction }
```

UI 组件 `CompactSummary.tsx` 据此显示 "Summarized N messages from/up to this point"。

---

## 9. Reactive Compact（被动压缩）

文件：`src/services/compact/reactiveCompact.ts`

> **注意**：公开逆向仓库中该文件为 **stub**（`runReactiveCompact` 直接返回原 messages）。完整实现依赖 `REACTIVE_COMPACT` feature flag，在 ant 内部构建中可用。

### 9.1 触发场景

`src/query.ts` 在 API 返回 withheld 413 或 media size error 时调用 `tryReactiveCompact`：

1. 若 `CONTEXT_COLLAPSE` 开启，先尝试 `recoverFromOverflow`（drain collapses）
2. 仍 413 → reactive compact
3. `hasAttemptedReactiveCompact` 防止无限循环

### 9.2 Reactive-only 模式

当 `tengu_cobalt_raccoon` 开启时：

- 抑制 proactive autocompact
- `/compact` 命令路由到 `reactiveCompactOnPromptTooLong`
- 依赖 API 的 prompt-too-long 作为压缩信号

### 9.3 消息分组

`groupMessagesByApiRound()`（`grouping.ts`）：

- 按 assistant `message.id` 变化划分 API round
- 比旧的 "human turn" 分组更细，支持单轮 agentic 长会话（SDK/CCR）

Reactive compact 从**尾部**逐轮剥离再总结；PTL retry 则从**头部**丢弃（`truncateHeadForPTLRetry`）。

---

## 10. Snip Compact（历史裁剪）

文件：`src/services/compact/snipCompact.ts`（公开仓库为 stub）

- Feature：`HISTORY_SNIP`
- 用户可将旧消息 snip 掉；REPL 保留完整 scrollback，但模型只看 snip boundary 之后
- `getMessagesAfterCompactBoundary` 默认也会应用 `projectSnippedView`
- Snip 与 microcompact **不互斥**，snip 先运行

---

## 11. Post-Compact 状态恢复

压缩会丢失大量上下文，CC 通过 **attachments + hooks** 重建关键状态。

### 11.1 文件恢复

`createPostCompactFileAttachments()`：

| 常量 | 值 | 含义 |
|------|-----|------|
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | 最多恢复文件数 |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | 总 token 预算 |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | 单文件上限 |

- 按 `readFileState` 时间戳取最近访问的文件
- 通过 `FileReadTool` 重新读取（带 validation）
- 跳过 plan 文件、CLAUDE.md/memory 文件
- 跳过 preserved tail 中已有 Read 结果的路径

### 11.2 Skill 恢复

`createSkillAttachmentIfNeeded()`：

- 从 `getInvokedSkillsForAgent()` 取已 invoke 的 skills
- 按最近 invoke 排序；单 skill 最多 5,000 tokens；总预算 25,000 tokens
- **故意不** reset `sentSkillNames`（避免每轮 re-inject 4K+ skill_listing）

### 11.3 其他附件

- `createPlanAttachmentIfNeeded` — plan 文件
- `createPlanModeAttachmentIfNeeded` — plan mode 指令
- `createAsyncAgentAttachmentsIfNeeded` — 后台 running/finished 的 local agent
- `getDeferredToolsDeltaAttachment` — 重新公告 deferred/MCP tools
- `getAgentListingDeltaAttachment` — agent 列表
- `getMcpInstructionsDeltaAttachment` — MCP 指令

### 11.4 Post-Compact Cleanup

`runPostCompactCleanup(querySource)`（`postCompactCleanup.ts`）：

- `resetMicrocompactState()`
- `resetContextCollapse()`（main thread only）
- `getUserContext.cache.clear()` + `resetGetMemoryFilesCache('compact')`
- `clearSystemPromptSections()`、`clearClassifierApprovals()`、`clearSpeculativeChecks()`
- `clearSessionMessagesCache()`、`clearBetaTracingState()`
- **不**清除 invoked skill content

---

## 12. Hooks 集成

文件：`src/utils/hooks.ts`

### PreCompact

```typescript
{
  hook_event_name: 'PreCompact',
  trigger: 'manual' | 'auto',
  custom_instructions: string | null
}
// 返回 newCustomInstructions → 合并进 compact prompt
```

### PostCompact

```typescript
{
  hook_event_name: 'PostCompact',
  trigger: 'manual' | 'auto',
  compact_summary: string
}
```

### SessionStart（compact 触发）

`processSessionStartHooks('compact')` — 压缩成功后重新加载 CLAUDE.md 等环境上下文。

---

## 13. 消息类型与 Transcript 语义

### 13.1 Compact Boundary

```typescript
// createCompactBoundaryMessage
{
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  compactMetadata: {
    trigger: 'manual' | 'auto',
    preTokens: number,
    userContext?: string,
    messagesSummarized?: number,
    preCompactDiscoveredTools?: string[],
    preservedSegment?: { headUuid, anchorUuid, tailUuid }
  }
}
```

### 13.2 Compact Summary

```typescript
{
  type: 'user',
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,  // 默认 UI 折叠，Ctrl+O 展开
  content: getCompactUserSummaryMessage(...)
}
```

### 13.3 视图投影

- **`getMessagesAfterCompactBoundary(messages)`** — 模型/API 只看最后一个 boundary 之后
- **`findLastCompactBoundaryIndex`** — 从尾部扫描
- Partial/SM compact 的 `preservedSegment` — 磁盘 dedup 后 loader 用 metadata 修复 parent chain

---

## 14. 手动 `/compact` 命令

文件：`src/commands/compact/compact.ts`

执行顺序：

1. `getMessagesAfterCompactBoundary` — 排除已 snip 内容
2. 无 custom instructions → **trySessionMemoryCompaction**
3. Reactive-only 模式 → `compactViaReactive`
4. 否则：`microcompactMessages` → `compactConversation`
5. 成功后：`suppressCompactWarning()`、`runPostCompactCleanup()`、`getUserContext.cache.clear()`

Custom instructions 通过命令参数传入：`/compact focus on test output`。

---

## 15. UI 与用户体验

| 组件 | 作用 |
|------|------|
| `CompactBoundaryMessage.tsx` | 显示 "✻ Conversation compacted (Ctrl+O for history)" |
| `CompactSummary.tsx` | 折叠/展开 summary；partial compact 显示 metadata |
| `compactWarningState.ts` | 压缩成功后 suppress "context left until autocompact" 警告 |
| `usePostCompactSurvey.tsx` | 压缩后反馈调查 |

Autocompact 进行中：`context.setSDKStatus('compacting')`，stream mode 在 requesting/responding 间切换。

---

## 16. 分析与遥测

主要 Statsig 事件：

| 事件 | 含义 |
|------|------|
| `tengu_compact` | Full compact 成功 |
| `tengu_partial_compact` | Partial compact |
| `tengu_compact_failed` | 失败（reason: prompt_too_long / no_summary / api_error 等） |
| `tengu_compact_ptl_retry` | PTL 重试 |
| `tengu_compact_cache_sharing_success/fallback` | Fork cache 路径 |
| `tengu_auto_compact_succeeded` | Autocompact 成功 |
| `tengu_cached_microcompact` | Cached MC |
| `tengu_time_based_microcompact` | Time-based MC |
| `tengu_sm_compact_*` | Session memory compact 各阶段 |

`/context` 命令通过 `analyzeContext.ts` 模拟 microcompact 后展示 token 分布和建议。

---

## 17. 配置速查

### 用户配置（`~/.claude/settings.json`）

```json
{
  "autoCompactEnabled": true
}
```

### 环境变量

| 变量 | 作用 |
|------|------|
| `DISABLE_COMPACT` | 禁用全部 compact |
| `DISABLE_AUTO_COMPACT` | 仅禁用自动 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 限制有效 window |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 阈值百分比 override |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | 强制 SM compact |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | 禁用 SM compact |
| `USE_API_CLEAR_TOOL_RESULTS` | API 端清除 tool results |
| `USE_API_CLEAR_TOOL_USES` | API 端清除 tool uses |

### GrowthBook Feature Flags（部分）

| Flag | 作用 |
|------|------|
| `tengu_compact_cache_prefix` | Compact fork cache sharing |
| `tengu_compact_streaming_retry` | Streaming 失败重试 |
| `tengu_session_memory` + `tengu_sm_compact` | Session memory compact |
| `tengu_sm_compact_config` | SM compact 阈值 remote config |
| `tengu_slate_heron` | Time-based microcompact |
| `tengu_cobalt_raccoon` | Reactive-only 模式 |
| `tengu_cache_plum_violet` | Legacy microcompact（已 always true，路径已移除） |

---

## 18. 源码文件索引

```
src/services/compact/
├── compact.ts              # 核心：full/partial compact、streamCompactSummary、post-compact attachments
├── autoCompact.ts          # 自动压缩阈值、shouldAutoCompact、autoCompactIfNeeded
├── microCompact.ts         # 微压缩：time-based / cached MC
├── apiMicrocompact.ts      # API context_management 策略
├── sessionMemoryCompact.ts # Session memory 实验路径
├── reactiveCompact.ts      # 被动压缩（公开仓库为 stub）
├── snipCompact.ts          # Snip（公开仓库为 stub）
├── snipProjection.ts       # Snip 视图投影
├── postCompactCleanup.ts   # 压缩后 cache/state 清理
├── prompt.ts               # Compact prompt 模板与 summary 格式化
├── grouping.ts             # API round 消息分组
├── compactWarningState.ts  # UI 警告 suppress 状态
├── compactWarningHook.ts   # React hook
├── timeBasedMCConfig.ts    # Time-based MC GrowthBook config
└── cachedMCConfig.ts       # Cached MC config（公开仓库 stub）

src/commands/compact/compact.ts   # /compact 命令
src/query.ts                      # 主循环集成点
src/query/deps.ts                 # 依赖注入（便于测试 mock）
src/utils/messages.ts             # boundary/summary 消息工厂
src/utils/tokens.ts               # tokenCountWithEstimation
src/utils/hooks.ts                # PreCompact / PostCompact hooks
src/components/CompactSummary.tsx
src/components/messages/CompactBoundaryMessage.tsx
```

---

## 19. 设计要点总结

1. **分层释放**：Snip → Micro → Collapse → Auto → Reactive，从轻到重，尽量保留语义粒度。
2. **Cache 感知**：Fork compact 复用 prompt cache；cached microcompact 用 cache_edits 避免 invalidate prefix；time-based MC 在 cache 已 cold 时主动清 tool results。
3. **状态重建**：Compact 不是简单删消息——通过 attachments 恢复文件、skills、plan、tools、async agents。
4. **API 安全**：SM/partial compact 用 `adjustIndexToPreserveAPIInvariants` 保证 tool_use/tool_result 配对；PTL retry 用 synthetic user marker 保证首条为 user。
5. **防螺旋**：Autocompact circuit breaker（3 次）、reactive `hasAttemptedReactiveCompact`、SM compact threshold 回退。
6. **Transcript vs Model view**：REPL 保留完整历史 + compact boundary 标记；模型通过 `getMessagesAfterCompactBoundary` + snip projection 看裁剪视图。

---

## 20. 与 src 示例项目的对应关系

本仓库 `src/services/compact/` 是 CC compacting 的简化移植版，包含：

- `compact.ts` / `autoCompact.ts` / `microCompact.ts` — 核心逻辑子集
- 不含 Session Memory、Reactive、Cached MC、Snip 等实验/内部特性

更完整的图文说明见：`docs/dev/html/session-compacting-guide.html`（面向 src 实现）。
