# Session Memory 设计（08-basic，参考 Claude Code）

> 状态：**已实现** — `core/forked-agent.ts` + Session Memory extract/compact  
> 消息游标字段：`uuid`（非 API round `id`）；创建时尽量打标，缺失时运行时补齐  
> 模板：10 节（对齐 CC，含 Workflow / Codebase and System Documentation）  
> CacheSafeParams：默认 `sessionMemory.cacheSafe: true` — 主循环 `createCacheSafeParams` + `saveCacheSafeParams`，SM fork 复用主模型/system/全量 tools schema，`canUseTool` 仅允许 Edit summary.md  
> 日期：2026-07-26

---

## 1. 目标与非目标

### 目标

把 compact 升级成 **「平时记账 + 满窗优先读账」** 的一等能力（不是可选插件）：

1. 会话中后台维护 `.sessions/{id}/session-memory/summary.md`
2. Compact：**统一**为 `summary + messagesToKeep(+ attachments)`；SM 有可用笔记则跳过现场 LLM 总结
3. 主回复路径不阻塞（`void` 抽取）

### 非目标

- Auto / Team / Agent Memory
- 保留「旧 full compact 整段替换、无尾部」行为

> 注：默认已启用 cache-safe 主模型 fork（`cacheSafe: true`）。设 `cacheSafe: false` 可退回 medium 受限 Edit-only 抽取。

### 打破兼容时允许动的东西

- `Message` 强制稳定 `id`
- `compactConversation` / `CompactResult` / `applyFullCompaction` 签名与语义
- `CompactionConfig` 字段重组（可删除无用项、改默认）
- jsonl compact 记录格式
- 旧 session 文件：不保证可读；坏了就当新会话

---

## 2. 架构

```
assistant 采样完成
  └─ void extractSessionMemoryIfNeeded(...)   # fire-and-forget

step 前 / 手动 compact
  ├─ micro-compact
  └─ 超阈值或 force？
        ├─ waitExtraction(≤15s)
        ├─ 若 summary.md 可用 → SessionMemoryCompact（无 LLM）
        └─ 否则 → FullCompact（LLM 总结）
              两者产出同一形状：
              [boundary][summaryMsg][messagesToKeep][attachments…]
```

| 名称 | 位置 |
|------|------|
| Session Memory 文件 | `.sessions/{sessionId}/session-memory/summary.md` |
| Compact summary | **仅**消息链内（`role` + `isCompactSummary`）；full **不写**磁盘 md |

---

## 3. 存储与模板

路径：

```
.sessions/{sessionId}/
  tool-results/…
  session-memory/summary.md
```

模板（8 节，固定骨架；标题 + 斜体说明不可改）：

`Session Title` / `Current State` / `Task specification` / `Files and Functions` /  
`Errors & Corrections` / `Learnings` / `Key results` / `Worklog`

- 单节软上限 ~2k tokens；整文件 ~12k  
- Compact 注入前按节硬截断  
- 自定义模板：`.ai-agent/session-memory/{template,prompt}.md`（可与实现同期做，无旧格式包袱）

---

## 4. Message 与 Cursor（硬要求）

所有进入 agent loop 的消息 **必须有** `id: string`（创建时 `randomUUID()`）。  
jsonl / resume 无 id 的旧记录：**丢弃或拒绝加载**，不做迁移。

Session 内存状态（进程内，按 `sessionId`）：

```ts
{
  initialized: boolean
  tokensAtLastExtraction: number
  lastTriggerMessageId?: string      // 阈值用：上次触发抽取时的末消息
  lastSummarizedMessageId?: string   // compact 边界：笔记覆盖到哪
  extractionStartedAt?: number
  inFlight: boolean
}
```

- 抽取成功且末条 assistant **无** tool_call → 写 `lastSummarizedMessageId`  
- 任意成功 compact 后 → `lastSummarizedMessageId = undefined`  
- Compact 用 `lastSummarizedMessageId` 算 `messagesToKeep`；找不到 id → **直接 FullCompact**（不做弱 cursor）

---

## 5. 抽取

### 挂载

主 agent **每次 assistant 采样完成**后 `void extract…`（对齐 CC post-sampling）。  
Subagent / skill fork 不跑。

### 配置（默认开启）

```ts
sessionMemory: {
  enabled: true,                    // 默认开；仅当 compaction.enabled===false 时整体不跑
  minimumTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  modelTier: 'medium',              // 'small' | 'medium' | 'main'
  compactMinTokens: 10_000,
  compactMaxTokens: 40_000,
  compactMinTextMessages: 5,
}
```

可并入 `AppConfig`；与 `compaction` 并列或嵌套均可，**无旧 settings 兼容义务**。

### 触发（同 CC）

`tokenCountWithEstimation` 与 autoCompact 同口径：

- 未 init：`< minimumTokensToInit` 不抽  
- 之后：上下文再涨 `≥ minimumTokensBetweenUpdate`，且  
  `(tool_calls ≥ N) OR (上轮 assistant 无 tool_call)`  

`inFlight` 时丢弃新请求（或只保留最新一次；实现选一种即可）。

### 实现策略（对齐 CC）

**受限侧路 agent（`runAgent` fork）：**

1. 确保目录/文件存在（空则写模板）
2. 侧路 `runAgent`：对话作为 prior `messages`；user 消息为 Edit-only update prompt
3. 工具集仅 `Edit`，且 `createMemoryFileEditTool` 只允许精确 `summary.md` 绝对路径（绕过 workspace sandbox）
4. `maxSteps: 8`；fork 内禁用 compaction / sessionMemory 再抽取
5. 成功后更新 `tokensAtLastExtraction` / `lastSummarizedMessageId`

自定义模板/prompt：`.ai-agent/session-memory/{template,prompt}.md`（cwd 优先，否则 `~/…`）

无工具的「整文件 generateText 重写」已移除。

---

## 6. Compact（统一语义）

### 新的唯一结果形状

```ts
type CompactOutcome = {
  source: 'session_memory' | 'full'
  messages: Message[]  // boundary + summary + keep + attachments
  messagesToKeep: Message[]
  summaryText: string
}
```

**FullCompact 与 SessionMemoryCompact 都保留尾部**（废除「full 无 tail」）：

- 有 `lastSummarizedMessageId`：从其后开始扩 keep  
- 无（full 现场总结 / resume）：从末尾向前扩到 minTokens / minTextMessages，cap 在 maxTokens  
- 必须：不拆 tool_call/tool_result；去掉旧 boundary  

FullCompact：LLM 只总结 **keep 之前** 的历史（或整段减去 keep，实现时选清晰一种）；summary 消息壳与 SM 共用同一 `formatCompactSummaryMessage()`。

### `compactIfNeeded` 顺序

```
micro
if !force && tokens < threshold → return
waitExtraction
if sessionMemory.enabled && summary.md 非空模板:
  try SM compact → 成功则 return（source=session_memory）
FullCompact（source=full）
```

SM 失败条件：无文件 / 空模板 / cursor 丢失 / 拼完仍 ≥ threshold / IO 错 → fall through。

手动 `/compact`：无自定义 instructions → 同上；有 instructions → 强制 FullCompact（可把 instructions 塞进 summarizer）。

`/summary`：跳过阈值强制抽一次。

### 与 session / UI

- 成功 compact 一律 `appendCompaction` + 现有 wire；带上 `source`  
- post-compact attachments（files/todos/skills）**两条路径都跑**  
- 删除 session 时 rm `session-memory/`

---

## 7. 模块落点

```
core/forked-agent.ts          # runForkedAgent / CacheSafeParams / canUseTool / createSubagentContext
services/session-memory/
  extract.ts                  # 调 runForkedAgent（Edit-only）
  memoryEditTool.ts
  compact.ts
  …
services/compact/
  autoCompact.ts              # SM → full（full 也带 keep）
  …
```

允许删除/重命名旧「summarize ALL、无 tail」逻辑；测试与脚本一并改。

---

## 8. 交付（不再按「灰度兼容」分期）

### P0 — 类型与路径

- Message 强制 `id`；创建/反序列化路径改完  
- `session-memory/` 路径 + 模板 + state  
- keep-index 单测（含 tool pair）

### P1 — 闭环

- Edit-only 抽取 + 阈值 + `void` 挂载  
- SM compact + **FullCompact 统一带 keep**  
- `/summary`、`/compact`  
- 配置默认 `enabled: true`  
- 测试：mock 抽取后 force compact → 不走 full summarizer；SM 空 → 走 full 且仍有 keep

### P2 — 抛光

- 自定义 template/prompt  
- wire/UI 展示 source  
- 抽取与 compact 竞态压测  

---

## 9. 风险（在无兼容前提下）

| 风险 | 处理 |
|------|------|
| 抽取费用 | medium + 阈值；可 settings 关 `sessionMemory.enabled` |
| Edit agent 跑飞 | 硬沙箱只允许一个 path；maxTurns 小（如 3–5） |
| 旧 jsonl 挂掉 | 接受；文档写明需新 session |
| Full 与 SM 行为接近 | **有意为之**：差别只在 summary 来源（文件 vs 现场 LLM） |

---

## 10. 成功标准

1. Compact 默认路径：有笔记则 **无** 现场 summarizer 调用  
2. 任意 compact 后上下文 = summary + recent keep + attachments  
3. 主回复不因抽取 await 变慢  
4. 关掉 `sessionMemory.enabled` 时仍能 FullCompact（带 keep）正常工作  

---

## 11. 下一步

直接按 P0 → P1 实现即可，无需再确认「是否保持旧 full 行为 / 是否默认关闭」。  
实现前唯一实现细节自选：抽取挂在「每次采样后」还是「step 结束」——**优先采样后**。
