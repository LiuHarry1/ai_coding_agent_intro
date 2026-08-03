# Claude Code 工具结果双路数据：为什么必须拆成「给模型」和「给页面」

> 基于源码：`/Users/harry/cursor_workspace/public_repo/claude-code-rev`  
> 核心入口：`src/Tool.ts`、`src/services/tools/toolExecution.ts`、`src/utils/messages.ts`、`src/utils/transcriptSearch.ts`  
> 文档目的：解释 **为什么工具返回必须是双路**；若只保留大模型这一路，产品和工程上会坏成什么样。

---

## 0. 先给结论（读完这段就该被说服）

Claude Code 每次工具成功执行后，**同一次 `call()` 产出的原生结果 `Out` 会被投影成两条完全不同的消费路径**：

| 路径 | 字段 / 函数 | 消费者 | 设计目标 |
|------|-------------|--------|----------|
| **LLM 路** | `mapToolResultToToolResultBlockParam(Out)` → `message.content` 里的 `tool_result` | Anthropic API / 下一轮模型上下文 | 让模型能继续推理：完整载荷、行为指令、提醒、持久化指针、内部 ID |
| **UI 路** | `message.toolUseResult = Out` → `renderToolResultMessage(Out)` | 终端 transcript / Ink 页面 / 搜索索引 | 让人能扫一眼：摘要 chrome、diff、原始 stdout，**绝不**把模型专用噪音刷到屏幕上 |

这不是「同一份字符串渲染两次」，而是 **两个受众、两套信息论约束**：

1. **模型需要「可行动的完整上下文」**——文件正文、搜索命中全文、`<system-reminder>`、`agentId`、磁盘上的 `<persisted-output>` 路径。
2. **用户需要「可审查的工作痕迹」**——`Read 42 lines`、彩色 diff、命令 stdout；不要看恶意软件提醒文案、不要看「do not mention to user」的内部 ID。

源码自己把这件事写死了（`transcriptSearch.ts`）：

> `b.content` 是 **MODEL-facing** serialization；UI 渲染的是 `msg.toolUseResult`——**DIFFERENT text**。若用模型文本做搜索索引，会出现 phantom：搜 `/malware` 命中提醒文案，但屏幕上根本没有那行字。

**若只保留大模型这一路、拿 `tool_result.content` 当页面展示**：transcript 会瞬间变成「模型草稿纸」，diff 消失、搜索撒谎、内部 ID 泄漏到用户视野、大输出包装器污染终端。下面按工具举例证明。

---

## 1. 架构：一次执行，两份投影

```
tool.call()
    │
    ▼
  Out  （工具原生结构化结果，即 toolUseResult）
    │
    ├──────────────────────────────┐
    ▼                              ▼
mapToolResultToToolResultBlockParam   renderToolResultMessage
    │                              │
    ▼                              ▼
message.content (tool_result)      Ink / transcript UI
    │
    ▼
normalizeMessagesForAPI → 只送 content
（toolUseResult / mcpMeta 留在本地，不进模型）
```

### 1.1 类型契约（`src/Tool.ts`）

每个工具必须实现：

- `mapToolResultToToolResultBlockParam(content, toolUseID) → ToolResultBlockParam`  
  → **唯一**决定模型看到的 `tool_result`
- 可选：`renderToolResultMessage(content, …) → ReactNode`  
  → 决定 transcript 长什么样；省略则页面不渲染该结果（如 TodoWrite 改侧栏，不占对话行）
- 可选：`extractSearchText(out)`  
  → 明确要求返回 **屏幕可见文本**，而不是 `mapToolResult…` 的模型序列化（禁止把 `system-reminder` / `persisted-output` 编进搜索）

### 1.2 写入点（`toolExecution.ts`）

执行成功后创建一条 user 消息时 **同时**挂上两路：

```ts
createUserMessage({
  content: contentBlocks,          // ← LLM：已 map 过的 tool_result（+ 可能的大结果持久化改写）
  toolUseResult: toolUseResult,    // ← UI：原生 Out（子 agent 可省略以省内存）
  mcpMeta: mcpMeta,                // ← SDK：永不送模型
})
```

### 1.3 UI 读取点（`UserToolSuccessMessage.tsx`）

页面 **拒绝**从 `param.content` 渲染成功结果：

```ts
if (!message.toolUseResult || !tool) return null
const rendered = tool.renderToolResultMessage?.(toolResult, …)
```

也就是说：产品层已经假设「没有 `toolUseResult` = 没有可展示的成功态」。只留 LLM 路时，成功工具调用在 UI 上直接变空白（或你被迫拿模型文本硬渲染——见第 3 节灾难清单）。

### 1.4 为什么不能「共用一份字符串」

| 约束 | LLM 路 | UI 路 |
|------|--------|-------|
| Token / 上下文 | 可以很长；必要时落盘成 `<persisted-output>` | 必须短、可扫 |
| 指令注入 | 需要 reminder / nudge /「勿向用户提及 ID」 | 绝不能显示这些 |
| 结构化 | 最终压成 API content blocks | 需要 `structuredPatch`、原始 `stdout` 等字段做 rich UI |
| 搜索 / 无障碍 | 无关 | 必须与像素一致，否则 count≠highlight |
| SDK | 不需要 `mcpMeta` | 宿主需要 `_meta` / `structuredContent` |

一份字符串无法同时满足「给模型足够多」和「给用户足够少且结构化」。

---

## 2. 双路分流的四种典型模式

不是每个工具两边内容都「差很多」，但 **机制始终是双路**。差异程度分四档：

| 模式 | 含义 | 代表工具 |
|------|------|----------|
| **A. 反转载荷** | 模型拿正文/全文；UI 只拿 chrome 摘要 | FileRead、WebSearch、WebFetch（非 verbose） |
| **B. 反转 ACK** | 模型只拿一句话成功 ACK；UI 拿完整 diff/预览 | FileEdit、FileWrite |
| **C. 同源不同包装** | 两边都基于 stdout 等，但模型多包装/指令；UI 看裸输出 | Bash、PowerShell、Grep/Glob |
| **D. 指令侧信道** | 模型拿内部编排指令；UI 拿状态 chrome 或侧栏 | Agent、TodoWrite、Skill、Task* |

A/B 是「必须双路」的铁证；C/D 说明即使数据同源，**序列化目标不同**也不能合并。

---

## 3. 按工具：双路各自是什么 + 若只有 LLM 路会怎样

下列「只有 LLM 路」= 假设删掉 `toolUseResult`，或 UI 直接渲染 `mapToolResult…` 的文本。

### 3.1 FileRead（模式 A）——最强反例

**原生 Out**：`{ type:'text', file:{ content, numLines, … } }` 等  

| 路 | 实际内容 |
|----|----------|
| LLM | 带行号的全文 + 可选 `CYBER_RISK_MITIGATION_REMINDER` + 空文件 `<system-reminder>`；图片走 base64 image block |
| UI | 仅 `"Read N lines"` / `"Read image (42KB)"` / `"Unchanged since last read"`——**从不展示正文** |

源码注释（`FileReadTool.ts`）：

> UI 只渲染 summary chrome。模型序列化发送 content + CYBER_RISK_MITIGATION_REMINDER + line prefixes；UI 一个都不显示。

**只有 LLM 路时的后果（举例）**

1. 用户让 Claude 读 `src/auth.ts`（800 行）。页面刷出整文件 + 安全提醒段落。  
2. 对话变成不可读的代码瀑布；真正有用的「改了哪几行」被淹没。  
3. 用户 Ctrl+F 搜 `malware`（来自 mitigation 文案）「命中」，但若你后来改成用 UI chrome 渲染又对不上——这正是 `transcriptSearch` 要消灭的 phantom。  
4. 图片场景：模型需要 base64；页面若傻渲染模型 content，终端会吐出巨量 base64，而不是「Read image (42KB)」。

**说服点**：Read 的产品语义是「我知道你读了什么文件、多少行」；模型语义是「这是文件内容，请基于它推理」。两者不可共用文本。

---

### 3.2 FileEdit / FileWrite（模式 B）——另一极反例

**FileEdit Out** 含：`filePath, oldString, newString, originalFile, structuredPatch, userModified, …`  

| 路 | 实际内容 |
|----|----------|
| LLM | 一句 ACK：`"The file X has been updated successfully."`（可附 user-modified / replaceAll 说明） |
| UI | 完整 diff（`FileEditToolUpdatedMessage`），依赖 `structuredPatch` / 原文 |

FileWrite 同理：模型拿 `"File created successfully at: …"`；UI 拿创建预览或 update diff。

**只有 LLM 路时的后果（举例）**

1. Claude 改了 `payment.ts` 里关键计费逻辑。  
2. 页面只显示：`The file /Users/…/payment.ts has been updated successfully.`  
3. 用户 **看不到任何 diff**——无法做代码审查、无法发现模型改错、无法信任 auto-apply。  
4. `structuredPatch` 根本不在 mapped 字符串里；从 ACK **还原不了** diff。UI 路不是「美化」，而是 **唯一承载审查数据的通道**。

**说服点**：对模型，重复发送整份 patch 浪费 token 且它已经知道自己提了什么；对人，ACK 毫无信息量。双路正好各取所需。

---

### 3.3 Bash / PowerShell（模式 C）

**Out**：`{ stdout, stderr, interrupted, backgroundTaskId, persistedOutputPath, … }`  

| 路 | 实际内容 |
|----|----------|
| LLM | stdout/stderr 拼接；中断标签；**backgroundInfo**（含 task ID 与路径说明）；超大输出改写成 `<persisted-output>` + 预览 |
| UI | `BashToolResultMessage` 直接吃 `stdout`/`stderr`——注释写明：**UI never shows persistedOutputPath wrapper, backgroundInfo** |

**只有 LLM 路时的后果（举例）**

1. `npm test` 输出 2MB。模型收到：短 preview +「完整结果在磁盘某路径，请用 Read 读取」。  
2. 若 UI 渲染同一段：用户在终端看到包装器 XML，而不是他们习惯的测试日志；或看不到完整 stdout（被 preview 截断），却以为命令只输出了那么点。  
3. 后台任务：模型文本含 `Command running in background with ID: xxx`。刷到页面会暴露内部 task 编排细节，且和真正的后台任务面板重复/冲突。

**说服点**：大结果持久化是 **给模型的上下文压缩协议**；人要的是真实终端流。协议文本进 UI = UX 与信任双崩。

---

### 3.4 Grep / Glob（模式 C，偏 chrome）

| 路 | 实际内容 |
|----|----------|
| LLM | 命中列表全文 + 分页/截断说明（模型要用这些继续定位） |
| UI | `Found N files` 类摘要；非 verbose 时常不铺开全部命中 |

**只有 LLM 路**：一次宽 Grep 把成百上千行匹配砸进 scrollback，对话不可用；或 verbose 开关失效（模型文本没有「摘要模式」概念）。

---

### 3.5 WebSearch（模式 A）

| 路 | 实际内容 |
|----|----------|
| LLM | 完整结果 + 强制文案：`REMINDER: You MUST include the sources…` |
| UI | 仅 `"Did N searches in Xs"`；`extractSearchText` **故意返回空字符串** |

**只有 LLM 路时的后果（举例）**

1. 用户看见整页链接 JSON + 「你必须用 markdown 超链接引用来源」。  
2. 这是 **对模型的引用纪律指令**，不是给人看的搜索结果页。  
3. 搜 transcript 里的 `REMINDER` / 某 URL 会出现幽灵命中（源码已点名这类 phantom）。

---

### 3.6 WebFetch（模式 A）

| 路 | 实际内容 |
|----|----------|
| LLM | 页面正文/摘要全文（`result` 字符串） |
| UI | 默认 `"Received 42KB (200 OK)"`；verbose 才展开 |

**只有 LLM 路**：每次 fetch 把整页 HTML/markdown 灌进 transcript，会话变成网页转储；网络工具的「可观测性」本应是状态码与体积，不是正文。

---

### 3.7 Agent（模式 D）——隐私与编排

异步启动时，模型侧文本包含类似：

```text
agentId: … (internal ID - do not mention to user. Use SendMessage with to: '…' to continue…)
```

| 路 | 实际内容 |
|----|----------|
| LLM | 子代理全文结果 + continuation 指令 + `<usage>` trailer + 「勿向用户提及 ID」 |
| UI | `"Done (N tool uses · tokens · duration)"` / `"Backgrounded agent"` 等统计 chrome |

**只有 LLM 路时的后果（举例）**

1. 页面明文出现 `agentId` 和 “do not mention to user”——产品自己打脸。  
2. 用户被内部 mailbox/SendMessage 协议污染，误以为要自己去操作这些 ID。  
3. usage trailer、空结果 marker 等模型防呆文案全部可见，对话像调试日志。

**说服点**：这里双路不只是 UX，而是 **信息隔离策略**（need-to-know）：编排元数据只给父 agent。

---

### 3.8 TodoWrite（模式 D）——UI 甚至可以「没有结果行」

| 路 | 实际内容 |
|----|----------|
| LLM | 成功说明 + 继续用 todo 的行为约束；可能附 verification agent nudge |
| UI | **不实现** `renderToolResultMessage`——结果走 todo 面板（`setAppState`），transcript 不刷一段说教 |

**只有 LLM 路**：要么 transcript 出现长段「Ensure that you continue to use the todo list…」（对用户无意义的行为主义话术），要么你丢弃文本后连面板数据也没有（面板依赖的是 Out 里的 `oldTodos`/`newTodos`，不是 mapped 字符串）。

---

### 3.9 NotebookEdit

| 路 | 实际内容 |
|----|----------|
| LLM | 类似 `"Updated cell id with ${new_source}"` 的扁平字符串 |
| UI | 对 `new_source` 做高亮代码块 |

**只有 LLM 路**：失去语法高亮与单元格语义；长 cell 变成难读的一行转义文本。

---

### 3.10 Skill / MCP / mcpMeta

**Skill**：模型拿 `"Launching skill: …"` 或 forked 结果转储；UI 拿 `"Successfully loaded skill"` 类 chrome。  

**MCP**：

- LLM：`content` 透传（再经大小持久化）
- UI：专用渲染（如 Slack「Sent to #channel」、图片 `[Image]`、截断警告）
- **第三条旁路** `mcpMeta`（`_meta` / `structuredContent`）：注释写明 **never sent to model**，专供 SDK 宿主

**只有 LLM 路**：MCP 富交互退化成原始 content dump；SDK 宿主丢失 structured meta；图片/截断策略无法按产品规则呈现。

---

### 3.11 其他 Task* / Team* / ToolSearch 等

多数仍遵循同一契约：`map*` 产模型可读摘要或 `tool_reference`；UI 有独立 chrome 或侧栏。  
**ToolSearch** 甚至给模型 `tool_reference` 块（API 特殊类型），这在人类 transcript 里几乎不可读——更证明不能单路。

---

## 4. 「只有大模型一路」的总后果清单

把各工具失败模式收束成产品级论证：

| # | 后果 | 直接原因 |
|---|------|----------|
| 1 | Transcript 不可用 | Read/Search/Fetch 全文 + Bash 包装器淹没对话 |
| 2 | 无法做变更审查 | Edit/Write 的 diff 只存在于 Out，不在 mapped ACK |
| 3 | 搜索说谎（phantom） | 索引模型专用 reminder / background / persisted-output |
| 4 | 内部编排泄漏 | Agent `agentId`、「勿告知用户」原文上屏 |
| 5 | 大输出 UX 错误 | 人看到的是持久化协议，不是真实 stdout |
| 6 | 行为指令污染 UI | WebSearch REMINDER、Todo verification nudge 像系统故障文案 |
| 7 | SDK/MCP 宿主受损 | `mcpMeta` / 结构化 Out 无法从纯 `tool_result` 字符串还原 |
| 8 | Resume/校验脆弱 | UI 依赖 `outputSchema.safeParse(toolUseResult)`；只有字符串时无法安全渲染 |
| 9 | 子 agent 内存策略失效 | 今日可对子 agent 丢掉 `toolUseResult` 省内存，只留 mapped content 给模型；单路设计做不到这种裁剪 |

对称地：**若只有 UI Out、不做 map**——模型会丢掉 reminder、continuation ID、persisted 指针、空结果防呆、Edit 的短 ACK（变成被迫吞 patch）等，agent 循环质量会显著下降。双路是双向刚需。

---

## 5. 反方意见与驳回

**「为什么不让模型也看 UI 摘要？」**  
因为摘要不够推理：Read 只说「42 行」模型无法改代码；Edit 只给 diff 不给 ACK 会重复占用上下文且缺少「用户改过你的提案」这类元信息通道。

**「为什么不让 UI 聪明地从 tool_result 再解析？」**  
`map*` 输出是面向 API 的扁平/半结构化文本，**有意丢弃** `structuredPatch`、完整 `todos`、原始 stdout（超大时）等。从 ACK 反解 diff 是不可能的；为 UI 再解析 reminder 又是脆弱的字符串协议。原生 Out 才是 UI 的 source of truth。

**「这不是重复存储浪费吗？」**  
`content` 与 `toolUseResult` 确实并存，但：

- 子 agent 可丢 `toolUseResult`；
- 进 API 前本来就要丢掉 UI 字段；
- 换来的是正确的人机界面 + 正确的模型控制面。  
这是典型的 **CQRS 式读写分离**（同一写入，两种读模型），不是无脑双写。

---

## 6. 关键源码索引

| 主题 | 路径 |
|------|------|
| 双路接口定义 | `src/Tool.ts`（`mapToolResult…` / `renderToolResultMessage` / `extractSearchText`） |
| 执行后同时写入 | `src/services/tools/toolExecution.ts` |
| 消息工厂与 mcpMeta | `src/utils/messages.ts` → `createUserMessage` |
| UI 只读 toolUseResult | `src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx` |
| 「两路文本不同」的铁证注释 | `src/utils/transcriptSearch.ts` |
| 大结果仅改 LLM 路 | `src/utils/toolResultStorage.ts`、`BashTool.mapToolResult…` |
| Read UI chrome | `src/tools/FileReadTool/UI.tsx` |
| Edit ACK vs diff | `src/tools/FileEditTool/FileEditTool.ts` + UI |
| Agent 内部 ID 指令 | `src/tools/AgentTool/AgentTool.tsx` |
| WebSearch REMINDER | `src/tools/WebSearchTool/WebSearchTool.ts` |

---

## 7. 一句话记住

> **工具的 `Out` 是事实；`mapToolResultToToolResultBlockParam` 是给模型的「简报+指令」；`renderToolResultMessage` 是给人的「工作台视图」。**  
> 取消双路 = 强迫人类阅读模型简报，或强迫模型阅读人类摘要——两条路都会让 Claude Code 同时失去「能干活」和「能被信任地看着干活」。
