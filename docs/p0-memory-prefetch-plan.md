# P0 Memory 实现计划（严格对齐 Claude Code）

> 对齐源码：`/Users/harry/cursor_workspace/public_repo/claude-code-rev`  
> 主路径：`findRelevantMemories.ts` · `attachments.ts`（prefetch）· `claudemd.ts`（`filterInjectedMemoryFiles`）· `memdir.ts`（`skipIndex`）· `query.ts`（consume）· `memoryAge.ts` · `memoryScan.ts`  
> **不做向后兼容**：prefetch 模式即唯一主路径；删除「常驻注入整份 MEMORY.md」的 legacy。  
> 日期：2026-08-08（对照 CC review 修订）

---

## Review：旧计划 vs CC（必须改掉的偏差）

| # | 旧计划写法 | CC 实际 | 本计划修正 |
|---|------------|---------|------------|
| 1 | （曾误写成必须 Sonnet） | CC 用 `getDefaultSonnetModel()` | **产品决定：选择器用 small**（有意偏离 CC，省成本/延迟；见 §2） |
| 2 | JSON `{ files: [...] }` | `{ selected_memories: string[] }` + json_schema | 字段名与 schema 与 CC 一致 |
| 3 | manifest：`relPath [type]: title — desc` | `- [type] filename (ISO mtime): description` | **改 `formatMemoryManifest` 对齐 CC**（extract 共用同一格式） |
| 4 | 进程内 `surfacedPaths` / `totalBytes`，compact 时手动 reset | **`collectSurfacedMemories(messages)`** 扫 transcript；compact 后 attachment 消失即自然清零 | **禁止**旁路 session state 记账 |
| 5 | consume「首轮 tool 前或每轮」含糊 | **每轮 loop、工具结果收集之后**：仅当 `settledAt != null && 未消费` 才 `await promise`（已 settled，零等待） | 挂到 agent step 的 **post-tools** collect |
| 6 | `injectIndex` hybrid / 默认 false 兼容 | GB `tengu_moth_copse`：**prefetch 与「不注入 MEMORY.md」同开同关**；`filterInjectedMemoryFiles` 滤掉 AutoMem/TeamMem | **删除 injectIndex 开关**；prefetch 开 ⇒ 永不注入索引 |
| 7 | prefetch 开仍强调 Step 2 写 MEMORY.md | `skipIndex=true` 时 **How to save 只有写主题文件**，无 Step 2 | prompts / extract 同步 `skipIndex` |
| 8 | 新鲜度一句「verify before acting」 | `memoryFreshnessText`：>1 天才 caveat；header 用 `memoryAge` / stale 两套 | **照抄语义** |
| 9 | 漏掉 | 过滤 `readFileState` 已读路径；`recentTools`；单词语 skip；单 attachment 包数组 | 全部纳入 |
| 10 | P0-3「compact 清 prefetch 预算」 | CC **无**显式 reset，靠扫 messages | 删掉显式 reset；只保证 rules/system 每 turn 重算 |

以下正文已按上表重写。

---

## 0. P0 范围与非目标

### 做

1. **Relevant memory prefetch**（CC `tengu_moth_copse` 行为，默认开启）  
2. **指令层**：User / Project / Local（映射到 AGENTS.md 命名，行为对齐 CLAUDE.md 层级）  
3. **System 每 turn 重载**（无 session 级永久缓存 rules/memory 指南）

### 不做（与 CC 后续能力对齐时再开）

- Team Memory / team sync  
- Agent Memory 目录（`memory:` frontmatter）——CC 的 `@agent` 改搜 agent memdir 一并延后  
- autoDream / KAIROS  
- GrowthBook；用 settings/env 布尔代替 `tengu_moth_copse`  
- 保留「只注入 MEMORY.md、无 prefetch」旧模式  

---

## 1. 目标行为（与 CC 同构）

```text
turn 开始（query / runAgent 入口）
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(messages, ctx)
        │ 条件：autoMemory on && prefetch on
        │ 取最后一条非 meta user 文本；单词语 → 不启动
        │ collectSurfacedMemories(messages)：bytes ≥ 60KiB → 不启动
        │ child AbortController 挂到 turn abort
        └─ async：getRelevantMemoryAttachments(...)

主模型第 1 次请求（可与 prefetch 并行）
  system = rules + loadMemoryPrompt(skipIndex=true)   ← 无 MEMORY.md 正文
  （此时 transcript 里通常还没有 relevant_memories）

while steps:
  stream + tools
  post-tools attachments…
  if prefetch.settled && not consumed:
      attachments = await prefetch.promise   # 已 settled，不阻塞
      filter readFileState 重复
      yield attachment(type=relevant_memories)
      mark consumed

turn 结束 → dispose prefetch → abort 未完成的 sideQuery
```

`MEMORY.md`：磁盘可仍存在（人工 / 旧数据）；**运行时主路径不读、不注入、prompt 不要求更新**（`skipIndex`）。

---

## 2. 配置（打破兼容）

### 删除 / 废弃

| 旧字段 | 处理 |
|--------|------|
| `injectIndex` | **删除** |
| `injectMaxIndexLines` | **删除**（仅截断工具可留私有常量给 UI，不再注入） |
| 「prefetch 关则整份索引注入」 | **删除** |

### 新 / 保留

```ts
export interface AutoMemoryConfig {
  enabled: boolean
  directory?: string
  extractEveryNTurns: number
  cacheSafe: boolean
  modelTier?: ModelTier

  /** 对齐 CC tengu_moth_copse；默认 true */
  prefetchEnabled: boolean

  /**
   * 选择器用的模型。
   * CC 用 Sonnet；本产品固定默认 'small'（成本/延迟优先，有意偏离）。
   */
  prefetchModelTier: ModelTier  // default 'small'
}
```

Defaults（`settings-manager`）：

```ts
prefetchEnabled: true,
prefetchModelTier: 'small',
// 不再有 injectIndex
```

Env：

| Env | 行为 |
|-----|------|
| `AI_AGENT_DISABLE_AUTO_MEMORY=1` | 整族关（已有） |
| `AI_AGENT_MEMORY_PREFETCH=0` | 强制关 prefetch（同时：无召回且仍不注入索引——与「关 moth_copse 但走旧索引」不同；我们不提供旧索引） |

> 若 `prefetchEnabled=false`：行为 = **无相关记忆注入 + 无 MEMORY.md 常驻**（仅保留 write 指南）。不回退到整份索引。接受这一 break。

---

## 3. P0-1：Relevant Memory Prefetch（核心）

### 3.1 文件映射（CC → 本仓库）

| CC | 本仓库 |
|----|--------|
| `memdir/findRelevantMemories.ts` | `services/auto-memory/findRelevant.ts`（新） |
| `memdir/memoryScan.ts` | 重构现有 `scan.ts`（manifest 格式对齐） |
| `memdir/memoryAge.ts` | `services/auto-memory/memoryAge.ts`（新，语义照抄） |
| `attachments.ts`：`startRelevantMemoryPrefetch` / `readMemoriesForSurfacing` / `collectSurfacedMemories` / `getRelevantMemoryAttachments` | `services/auto-memory/prefetch.ts` + `utils/attachments` 挂钩 |
| `messages.ts` `case 'relevant_memories'` | `attachment-to-messages` |
| `query.ts` consume | `core/agent.ts`（或 turn 内与 tool 结果同级的 collect） |
| `claudemd.filterInjectedMemoryFiles` | `inject.ts`：**永久不读 MEMORY.md 进 system** |
| `memdir.buildMemoryLines(skipIndex)` | `prompts.ts`：`skipIndex` 分支 |
| `sideQuery` + json_schema | 新增薄封装 `sideQuery` 或复用 provider.complete + JSON parse |

### 3.2 常量（与 CC 一致）

```ts
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096
const MAX_SESSION_BYTES = 60 * 1024  // RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES
const MAX_MEMORY_FILES = 200
const SELECT_MAX_TOKENS = 256
```

### 3.3 `scanMemoryFiles` / manifest（对齐 CC）

Header 形状：

```ts
type MemoryHeader = {
  filename: string      // 相对 memdir，可含子路径；basename≠MEMORY.md
  filePath: string      // abs
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}
```

**Manifest 一行格式（选择器 + extract 共用，替换现有 format）：**

```text
- [feedback] prefer-concise.md (2026-08-01T12:00:00.000Z): User wants short answers
```

无 description 则无冒号后段。按 mtime 新→旧，最多 200。

### 3.4 `findRelevantMemories`

签名对齐 CC：

```ts
findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<Array<{ path: string; mtimeMs: number }>>
```

流程：

1. `scanMemoryFiles` → filter `!alreadySurfaced.has(filePath)`  
2. 空 → `[]`  
3. `sideQuery`：  
   - model = **small**（`prefetchModelTier`，默认 small；有意不用 CC 的 Sonnet）  
   - system = **原样使用** CC `SELECT_MEMORIES_SYSTEM_PROMPT`（可把 “Claude Code” 换成产品名，规则句子不改）  
   - user = `Query: ${query}\n\nAvailable memories:\n${manifest}` + 可选 `\n\nRecently used tools: a, b`  
   - `max_tokens: 256`  
   - output JSON schema：

```json
{
  "type": "object",
  "properties": {
    "selected_memories": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["selected_memories"],
  "additionalProperties": false
}
```

4. `selected_memories.filter(f => validFilenames.has(f))` → map 到 path/mtime  
5. abort / 错误 → `[]`（不抛到主路径）

### 3.5 `memoryAge`（照抄 CC）

- `memoryAgeDays`：floor 天，负数夹 0  
- `memoryAge`：`today` / `yesterday` / `${d} days ago`  
- `memoryFreshnessText`：`d <= 1` → `''`；否则完整 stale caveat（point-in-time / verify code）  
- `memoryHeader(path, mtimeMs)`：  
  - 有 freshness → `${staleness}\n\nMemory: ${path}:`  
  - 否则 → `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`

### 3.6 `readMemoriesForSurfacing`

- 并行 `readFileInRange(0, MAX_MEMORY_LINES, MAX_MEMORY_BYTES, { truncateOnByteLimit: true })`  
- 截断尾注：与 CC 同文案（byte limit vs first N lines + Read 工具名）  
- 返回 `{ path, content, mtimeMs, header, limit? }`  
- **header 在创建时算好并存进 attachment**（保证跨 turn 渲染字节稳定 → prompt cache）

### 3.7 `getRelevantMemoryAttachments`

```text
dirs = [getAutoMemPath()]   // P0：不做 @agent 分目录（无 Agent Memory）
selected = findRelevant… → filter !readFileState.has(path) && !alreadySurfaced
         → slice(0, 5)
memories = readMemoriesForSurfacing(selected)
return memories.length ? [{ type: 'relevant_memories', memories }] : []
```

Attachment 类型：

```ts
type RelevantMemoriesAttachment = {
  type: 'relevant_memories'
  memories: Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
}
```

### 3.8 `collectSurfacedMemories(messages)`

```ts
// 扫 role=attachment 且 attachment.type==='relevant_memories'
// paths = Set(mem.path), totalBytes += mem.content.length
```

**不要**另建 `sessionId → { surfaced, bytes }`。Compact 丢掉旧 attachment 后，自然允许重新召回——与 CC 一致。

### 3.9 `startRelevantMemoryPrefetch`

```ts
type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number  // -1 = 未消费
  dispose(): void              // abort + 可选日志
}
```

启动条件（全部满足）：

1. `isAutoMemoryEnabled()` / config  
2. `prefetchEnabled`  
3. 存在最后一条 **非 meta** user 消息  
4. 文本 `/\s/.test(trim)`（单词语跳过）  
5. `collectSurfacedMemories(messages).totalBytes < 60KiB`  

`recentTools`：对齐 CC `collectRecentSuccessfulTools`——自上一条真实 user 以来，**有成功 tool_result 且从未 error** 的工具名；无结果或曾失败的不列入。

### 3.10 Consume 点（对齐 `query.ts`）

挂在 **工具执行完毕、下一轮 API 之前**（你们 `runAgent` 内 toolResults 汇总处）：

```ts
if (
  prefetch &&
  prefetch.settledAt !== null &&
  prefetch.consumedOnIteration === -1
) {
  const atts = filterDuplicateMemoryAttachments(
    await prefetch.promise,  // already settled
    readFileState,
  )
  // 插入 messages / yield attachment messages
  prefetch.consumedOnIteration = iterationIndex
}
```

规则：

- **第一次**主模型调用前 **不要** await prefetch  
- 仅 settled 后消费；未 settled → 本 iteration 跳过，下 iteration 再看  
- turn 结束 `dispose()` abort  

### 3.11 渲染（对齐 `messages.ts`）

`relevant_memories` → 对每条 memory 建 **isMeta user** 消息：

```text
${header}

${content}
```

再包进 `wrapInSystemReminder`（可一条 reminder 含多条，或 CC 那样 map 多条再 wrap——保持与现有 `wrapMessagesInSystemReminder` 习惯一致即可，**内容格式**必须 `header + blank + content`）。

### 3.12 System prompt：`skipIndex`（对齐 `buildMemoryLines`）

`prefetchEnabled === true`（默认）时：

**How to save** = 只写主题文件 + frontmatter 维护规则（**无** Step 2 / **无**「MEMORY.md always loaded」）。

`buildAutoMemorySystemAppend`：

- 只输出指南（`skipIndex` 版）  
- **禁止** `readEntrypointRaw` / 注入 `## Auto memory index`  

Extract fork 的 prompt 同样传 `skipIndex=true`（对齐 `extractMemories/prompts.ts`）。

可选清理（推荐一并做，避免死代码误导）：

- 主路径不再调用 `ensureIndexEntry` / `verifyAndRepairIndex`（或仅保留 CLI 维护命令）  
- `MEMORY.md` 仍可 `ensureAutoMemDir` 建空文件，但不参与 runtime  

### 3.13 测试

| 用例 | 期望 |
|------|------|
| manifest 格式 | 匹配 CC 行格式（含 ISO 时间） |
| select schema | 解析 `selected_memories`；非法名过滤 |
| alreadySurfaced | 选前过滤 |
| readFileState | 选后过滤 |
| 单词语 | 不启动 prefetch |
| session bytes ≥ 60KiB（messages 内已有 attachment） | 不启动 |
| 截断 200 行 / 4KB | 尾注正确 |
| freshness | ≤1 天无 caveat；>1 天有完整 stale 文案 |
| consume | settled 前不插入；settled 后只消费一次 |
| abort | dispose 后无未处理 rejection |
| system | 无 MEMORY.md 索引段；How to save 无 Step 2 |
| compact 后 | transcript 无旧 relevant_memories → 可再次召回（靠扫 messages，非手动 reset） |

---

## 4. P0-2：指令层（行为对齐 CLAUDE.md 层级）

CC：Managed → User → Project → Local。  
本产品命名：`AGENTS.md`（不做 Managed 企业路径，除非已有）。

| CC | 本仓库 |
|----|--------|
| `~/.claude/CLAUDE.md` + `~/.claude/rules` | `~/.ai-agent/AGENTS.md` + `~/.ai-agent/rules/*.md` |
| 仓库 `CLAUDE.md` / `.claude/…` | `AGENTS.md` / `.ai-agent/AGENTS.md` / `.ai-agent/rules/*.md` |
| `CLAUDE.local.md` | `AGENTS.local.md` / `.ai-agent/AGENTS.local.md` |

加载：user 先；cwd→git root 收集 project；local 同层更高优；近 cwd 后加载。

**删除** AgentTool 中未实现的 `CLAUDE.md` / `.cursor/rules` 承诺，或改为真实实现——P0 **只承诺 AGENTS 族**。

---

## 5. P0-3：与 Compact 的关系（按 CC，勿自创 reset）

| 项 | 做法 |
|----|------|
| Prefetch 预算 | **只** `collectSurfacedMemories(messages)`；compact 去掉 attachment 即重置 |
| Rules / memory 指南 | **每 turn** `prepare` 重读磁盘；禁止 session 级永久 memo |
| 显式 `resetRelevantMemorySessionState` | **不要实现** |

回归测试：造含 `relevant_memories` 的 messages → compact 后 messages 无该类 attachment → 下一 turn 可再次 prefetch 同文件。

---

## 6. 实施执行计划（按 PR / 按日）

建议拆 **2 个 PR**（都可独立合并测试），默认一步打开 prefetch、不做索引回退。

```text
PR-A  Prefetch 核心（P0-1 + P0-3 消息扫描语义）
PR-B  指令层 + 文档（P0-2）+ agent-memory-guide 更新
```

---

### PR-A — Prefetch 核心（约 4–5 日）

#### Day 1 — 纯库，不挂主循环

| 任务 | 文件 | 做什么 |
|------|------|--------|
| A1 | **新** `services/auto-memory/memoryAge.ts` | 照抄 CC：`memoryAgeDays` / `memoryAge` / `memoryFreshnessText` / `memoryHeader` |
| A2 | 改 `services/auto-memory/scan.ts` | `MemoryFileMeta` → 对齐 `MemoryHeader`（`filename`/`filePath`/`description`/`type`/`mtimeMs`）；**重写** `formatMemoryManifest` 为 `- [type] file (ISO): desc` |
| A3 | **新** `src/scripts/test-memory-age-manifest.ts` | 固定 mtime 测 age 文案 + manifest 行格式 |

验收：`npx tsx src/scripts/test-memory-age-manifest.ts` 全绿。

#### Day 2 — 选择器 + 读文件

| 任务 | 文件 | 做什么 |
|------|------|--------|
| A4 | **新** `services/auto-memory/sideQuery.ts`（或 `core/llm/side-query.ts`） | 单次 completion：system + user，解析 JSON；支持 `AbortSignal`；**不用** tool loop |
| A5 | **新** `services/auto-memory/findRelevant.ts` | `findRelevantMemories` + `SELECT_MEMORIES_SYSTEM_PROMPT`；schema 字段 `selected_memories`；模型经 `resolveSidePathModel({ cacheSafe: false, modelTier: 'small' })` |
| A6 | 同文件或 `prefetch.ts` 内 | `readMemoriesForSurfacing`：200 行 / 4KB 截断 + header 预存 |
| A7 | **新** `src/scripts/test-find-relevant-memories.ts` | mock sideQuery；测过滤非法名 / alreadySurfaced / 截断 |

验收：选择器单测不打真实 API。

#### Day 3 — Attachment 类型 + 渲染 + 预算扫描

| 任务 | 文件 | 做什么 |
|------|------|--------|
| A8 | `utils/attachments/types.ts` + `core/types.ts` 若需要 | 增加 `RelevantMemoriesAttachment`；并入 `Attachment` 联合 |
| A9 | `utils/messages.ts` → `normalizeAttachmentForAPI` | `case 'relevant_memories'`：每条 memory → `role:user` + `isMeta` + `<system-reminder>`（header\\n\\ncontent） |
| A10 | `attachment-to-messages.ts` | 若走该文件：同样处理；或统一只在 `normalizeAttachmentForAPI` |
| A11 | **新** `services/auto-memory/prefetch.ts` | `collectSurfacedMemories(messages)`、`collectRecentSuccessfulTools`、`startRelevantMemoryPrefetch`、`MemoryPrefetch` 句柄 |
| A12 | 单测 | 单词语不启动；bytes≥60KiB 不启动；扫 messages 累加 bytes |

#### Day 4 — 挂 `runAgent` + 配置打破兼容

| 任务 | 文件 | 做什么 |
|------|------|--------|
| A13 | `core/types.ts` `AutoMemoryConfig` | **删** `injectIndex` / `injectMaxIndexLines`；**加** `prefetchEnabled`（default true）、`prefetchModelTier`（default `'small'`） |
| A14 | `settings-manager.ts` | `resolveAutoMemoryConfig` / nested settings / env `AI_AGENT_MEMORY_PREFETCH=0` |
| A15 | `auto-memory/inject.ts` | **删除**读 MEMORY.md 注入；只留 `skipIndex` 指南 |
| A16 | `auto-memory/prompts.ts` | `skipIndex` 分支（无 Step 2）；extract 用同一套 |
| A17 | `auto-memory/extract.ts` | 主路径去掉 `ensureIndexEntry`/`verifyAndRepairIndex` 硬依赖（或仅 warn） |
| A18 | `core/types.ts` `ToolUseContext`（或 AgentOptions） | 挂 `memoryPrefetch?: MemoryPrefetch`、以及启动所需的 provider/models/memPath |
| A19 | `turn/run-chat-turn.ts` | turn 入口：`startRelevantMemoryPrefetch(...)`；`try/finally dispose`；把 handle 放进 toolUseContext / agent opts |
| A20 | `core/agent.ts` | **post-tools**（约 toolResults push 之后、下一轮 stream 之前）：若 `settledAt != null && consumedOnIteration === -1` → `createAttachmentMessage` 推进 `messages`；标记 consumed。**首轮 API 前禁止 await** |

挂载伪代码（贴进 agent 循环）：

```ts
// run-chat-turn / runAgent 入口
const memoryPrefetch = startRelevantMemoryPrefetch(messages, {
  autoMemory, memPath, provider: smallProvider, modelId: smallModel,
  abortSignal, readFileState, agents: [],
})
try {
  await runAgent(..., { memoryPrefetch })
} finally {
  memoryPrefetch?.dispose()
}

// agent.ts：tools 执行完、append tool message 之后
if (
  memoryPrefetch &&
  memoryPrefetch.settledAt !== null &&
  memoryPrefetch.consumedOnIteration === -1
) {
  const atts = await memoryPrefetch.promise // already settled
  for (const a of atts) {
    messages.push(createAttachmentMessage(a))
  }
  memoryPrefetch.consumedOnIteration = stepIndex
}
```

#### Day 5 — 回归 + compact 语义

| 任务 | 文件 | 做什么 |
|------|------|--------|
| A21 | `src/scripts/test-auto-memory-prefetch-e2e.ts` | 假 memdir + mock select → 消息里出现 attachment → expand 后为 user/isMeta |
| A22 | compact 脚本或扩展现有 | 含 `relevant_memories` 的 messages compact 后无该类 attachment → `collectSurfacedMemories` bytes=0 |
| A23 | 跑现有 `test-auto-memory.ts` | 修因删除 injectIndex 导致的断言 |

验收（PR-A DoD）：

- [ ] prefetch 默认 on；system **无** MEMORY.md 索引  
- [ ] small 选择器；post-tools 消费一次  
- [ ] 预算扫 messages；compact 后可再召回  
- [ ] 相关单测绿  

---

### PR-B — 指令层 + 文档（约 1–2 日，可与 PR-A Day1–2 并行）

| 任务 | 文件 | 做什么 |
|------|------|--------|
| B1 | `utils/rules-loader.ts` | `loadUserRules`（`~/.ai-agent/AGENTS.md` + rules）；`AGENTS.local.md`；导出 `loadAllAgentRules(cwd)` |
| B2 | `prepare_chat_turn.ts` | 改用 `loadAllAgentRules` |
| B3 | `tools/AgentTool/AgentTool.ts` | 文案只承诺 AGENTS 族 |
| B4 | `docs/agent-memory-guide.md` | Prefetch 模式、`MEMORY.md` 角色、`isMeta`/attachment 说明 |
| B5 | 本文件勾选 §7 DoD | |

---

### 依赖与风险（执行时注意）

| 点 | 处理 |
|----|------|
| sideQuery 无现成模块 | Day2 用 `provider` 的非流式/单次 generate；JSON 解析失败 → `[]` |
| `readFileInRange` | 查是否已有；没有则在 auto-memory 内做简易按行/字节截断读 |
| agent 循环多出口 | dispose 必须 `finally`；consume 只一处 post-tools |
| 设置破坏性删除 injectIndex | changelog / .env.example 注明；改测试默认 |
| remote | 继续 skip（与现 prepare 一致），prefetch 入口直接 return |

---

### 建议开工命令顺序

```bash
# Day1
npx tsx src/scripts/test-memory-age-manifest.ts

# Day2
npx tsx src/scripts/test-find-relevant-memories.ts

# Day5
npx tsx src/scripts/test-auto-memory.ts
npx tsx src/scripts/test-auto-memory-prefetch-e2e.ts
# 若有 compact attachment 测
npx tsx src/scripts/test-compaction-attachments.ts
```

### 谁先动哪几个文件（最小启动集）

若立刻开干，建议顺序：

1. `memoryAge.ts`（新）  
2. `scan.ts`（manifest）  
3. `findRelevant.ts` + `sideQuery`（新）  
4. `types` attachment + `messages.ts` 渲染  
5. `prefetch.ts`（新）  
6. `settings` 删 injectIndex  
7. `inject.ts` / `prompts.ts`  
8. `run-chat-turn.ts` + `agent.ts` 挂钩  

---

### 旧「实施顺序」表（保留对照）

| 步 | 内容 | 对齐验收 |
|----|------|----------|
| 1 | `memoryAge.ts` + 改 `formatMemoryManifest` + scan header 形状 | 与 CC 单测向量一致 |
| 2 | `findRelevant.ts` + sideQuery(json_schema) | mock 返回 `selected_memories` |
| 3 | `readMemoriesForSurfacing` + attachment 类型 + 渲染 | header 稳定 |
| 4 | `prefetch.ts` + `collectSurfacedMemories` + recentTools | 启动门控 |
| 5 | `agent` post-tools consume + dispose | 不阻塞首请求 |
| 6 | **删除** injectIndex；`skipIndex` prompts；extract 同步 | system 无索引 |
| 7 | P0-2 rules 层级 | user/local |
| 8 | compact 回归（扫 messages）+ 文档 | DoD |

建议：**PR-A 一步切换**（prefetch 默认 on + 去掉索引注入），不留 feature 双轨。

---

## 7. Definition of Done

- [ ] 选择器：**small**、`selected_memories`、CC 系 system prompt、manifest 含 ISO 时间  
- [ ] 限额：5 文件 × 200 行 × 4KB；会话 60KiB 按 **messages 扫描**  
- [ ] 消费：post-tools、仅 settled、只一次；dispose abort  
- [ ] System：**无** MEMORY.md 注入；**skipIndex** 写入说明  
- [ ] 过滤：alreadySurfaced + readFileState + 单词语 + recentTools  
- [ ] 新鲜度：`memoryFreshnessText` / `memoryHeader` 语义一致  
- [ ] User/Project/Local AGENTS 生效；文案与 loader 一致  
- [ ] Compact 后靠 transcript 自然恢复召回资格  
- [ ] 无 `injectIndex` / 无「关 prefetch 回退整份索引」路径  

---

## 8. 仍与 CC 有意不同（写明，避免误以为 bug）

| 点 | 原因 |
|----|------|
| **选择器用 small，不用 Sonnet** | 产品决定：侧路便宜、更快 settled；接受选准率可能略低于 CC |
| 无 GrowthBook；settings `prefetchEnabled` | 产品简化 |
| 无 TeamMem 入口过滤 | 未实现 Team |
| 无 `@agent` → agent memdir | 未实现 Agent Memory；接口先留 `dirs = [autoMem]` |
| 产品名替换 prompt 里的 “Claude Code” | 品牌 |
| `sideQuery` 自研薄封装 | 无 CC 同名模块，语义对齐即可 |

除此以外，**召回 / 注入 / skipIndex / 预算 / consume 时序不得再自创变体。**

---

## 9. 一句话

P0 = 把 CC 的 **`tengu_moth_copse` 整条链路**搬过来：**small** sideQuery 选 ≤5 个主题文件 → post-tools 零等待注入 → 主上下文不再吃 `MEMORY.md` → 写入指南 `skipIndex`；预算扫 messages；砍掉索引注入兼容层。
`)