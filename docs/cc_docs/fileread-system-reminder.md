# FileRead：`system-reminder` 与 `readFileState` 去重

本文覆盖 Claude Code FileRead 的两块机制：

1. **malware `system-reminder`**：每次读到正文常追加的安全护栏（文案固定，但不是每次都加）
2. **`readFileState` / `file_unchanged`**：用 mtime 记住已读文件，重复 Read 同一未改范围时只回 stub，省 token

对应源码：

- `claude-code-rev/src/tools/FileReadTool/FileReadTool.ts`
- `claude-code-rev/src/tools/FileReadTool/prompt.ts`（`FILE_UNCHANGED_STUB`）
- `claude-code-rev/src/utils/file.ts`（`getFileModificationTimeAsync`）
- `claude-code-rev/src/services/compact/microCompact.ts` / `compact.ts`

---

## 0. system-reminder 简短结论

**安全（malware）那条文案是固定常量，但并不是每次文件读取都会带上同一段 reminder。**

---

## 1. 最常见情况：读到正文 → 同一段安全 reminder

假设文件 `src/login.ts` 内容为：

```ts
export function login(user: string, pass: string) {
  return fetch('/api/login', { method: 'POST', body: JSON.stringify({ user, pass }) })
}
```

**发给模型的 `tool_result`（节选）大致是：**

```text
1→export function login(user: string, pass: string) {
2→  return fetch('/api/login', { method: 'POST', body: JSON.stringify({ user, pass }) })
3→}

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>
```

要点：

- 前面是**带行号的全文**（随文件变化）
- 后面的 malware `<system-reminder>` 是常量 `CYBER_RISK_MITIGATION_REMINDER`
- **读 `a.ts` / `b.py` / `config.json`，这段英文提醒文字都一样**

**同一时刻页面上只显示：** `Read 3 lines`（不展示全文，也不展示 reminder）

---

## 2. 例子：换文件，reminder 文案不变

| 读取 | 模型看到的正文 | 尾部 malware reminder |
|------|----------------|------------------------|
| `login.ts`（3 行） | 该文件 3 行 + 行号 | **同一段** |
| `huge-module.ts`（800 行） | 该文件 800 行 + 行号 | **同一段** |
| `README.md` | README 全文 + 行号 | **同一段** |

所以日常说「每次文件读取的安全 reminder 都一样」——**指文案相同，不是指整段 tool_result 相同。**

---

## 3. 例子：有时根本不加这条 reminder

源码里 `claude-opus-4-6` 在豁免名单中：

```ts
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6'])

function shouldIncludeFileReadMitigation(): boolean {
  const shortName = getCanonicalName(getMainLoopModel())
  return !MITIGATION_EXEMPT_MODELS.has(shortName)
}
```

**例子：**

- 主循环模型是普通模型 → 读到正文后 **追加** malware reminder  
- 主循环模型是 `claude-opus-4-6` → 同样读到正文，**只有带行号全文，没有** 这段 malware reminder  

同一文件、同一内容，换模型后 tool_result 尾巴会变。

---

## 4. 例子：读失败 / 空文件 → 换成别的 reminder（不是 malware 那条）

这些分支**不会**再叠那条 malware 文案：

### 4.1 文件存在但是空的

```text
<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>
```

### 4.2 offset 超出文件长度

例如文件只有 10 行，却从第 50 行开始读：

```text
<system-reminder>Warning: the file exists but is shorter than the provided offset (50). The file has 10 lines.</system-reminder>
```

这里的数字随参数变化，和 malware 提醒完全不是同一段。

---

## 5. 例子：auto-memory 文件可能多一段「新鲜度」前缀

读自动 memory 相关文件时，正文前还可能插入 `memoryFreshnessNote(mtime)`（mtime 不同，前缀不同）。  
这是**另一段**说明，不是 malware reminder 的变体。

示意（非逐字）：

```text
（可选：关于该 memory 文件多久未更新的说明）

1→...文件内容...

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. ...
</system-reminder>
```

---

## 6. 一张表记清楚

| 场景 | 有没有 malware reminder | 文案是否固定 |
|------|-------------------------|--------------|
| 正常读到正文（非豁免模型） | 有 | **固定同一段英文** |
| 正常读到正文（`claude-opus-4-6`） | **无** | — |
| 空文件 | 无（换成 empty 警告） | 另一段固定文案 |
| offset 过大 | 无（换成 offset 警告） | 模板固定，数字变化 |
| auto-memory | 可能仍有 malware 条 | 前面可能再加 freshness |

---

## 7. 分片读同一文件：会不会出现 10 次？

会。**每次成功的 FileRead（读到正文）各自 map 一次，各自追加一段 reminder；源码没有「同一文件只提醒一次」的去重。**

例子：500 行文件，每次读 50 行，offset 推进 10 次：

| 第几次 | 模型 `tool_result` 里大致有什么 |
|--------|----------------------------------|
| 1 | 第 1–50 行 + **1 段** malware reminder |
| 2 | 第 51–100 行 + **又 1 段** 相同 reminder |
| … | … |
| 10 | 第 451–500 行 + **又 1 段** 相同 reminder |

对话历史里模型侧会累计 **10 份相同英文提醒**（占 token）。  
页面仍是 10 条 `Read 50 lines`，**看不到**这些 reminder。

唯一常见例外仍是：主模型在豁免名单（如 `claude-opus-4-6`）→ 10 次都**不加**；或某次没读到正文（空/offset 错）→ 那一次换成别的 warning，而不是这条 malware。

> **本仓库已对齐：**
> - 空文件 / offset 越界短 reminder：`src/utils/read/boundary-reminders.ts`
> - Read `file_unchanged` dedup + Edit/Write 更新账本：`src/utils/read/read-file-state.ts`
> - Microcompact / full compact 同步清 `readFileState`：`microCompact.ts` / `autoCompact.ts`
> - **Out 存裸正文，map 才加行号/header**：`formatTextReadForModel`（UI 展开看裸内容）
> - UI：`ReadFileCard` 显示 `unchanged` / `empty` / offset 越界标签

---

## 8. 和「双路数据」的关系（给别人看时很有用）

- **模型路**：全文 +（通常）同一段 malware `system-reminder`  
- **页面路**：只有 `Read N lines` 之类摘要  

因此：

1. 用户**看不见**这段「请判断是不是 malware」的提醒——它是给模型的安全纪律。  
2. 若 UI 错误地渲染模型那一路，用户会反复看到同一段英文说教，还会在 transcript 搜索里搜到 `malware` 等幽灵命中。  

更完整的双路说明见同目录：`claude-code-dual-path-tool-results.md`。

---

## 9. `readFileState` / `file_unchanged`：重复 Read 如何省 token

### 9.1 一句话

同一会话里，若某文件（同一 offset/limit）已经 Read 过，且磁盘 **mtime 未变**，再次 Read **不再把全文塞进上下文**，只回一句 stub，让模型去回顾更早那次 `tool_result`。

### 9.2 mtime 是什么、怎么来的

**mtime** = modification time，文件内容最后被修改的时间。由**操作系统文件系统**维护，不是 CC 自己生成的。

Node / CC 取值：

```ts
const s = await fs.stat(filePath)
const mtime = Math.floor(s.mtimeMs)  // 毫秒时间戳，向下取整
```

对应 `getFileModificationTimeAsync`。只读文件一般不改 mtime；Edit/保存/写入会更新。

| 操作 | mtime |
|------|--------|
| 创建 / 保存改内容 | 变成新值 |
| 只 Read，不改内容 | **不变** |

### 9.3 用对话举例

文件 `auth.ts` 有 400 行，磁盘 mtime = `T1`。

**第 1 次 Read**

1. 读盘，拿到全文  
2. 写入本地账本 `readFileState`：`{ path, mtime: T1, offset, limit }`  
3. `tool_result` 塞进 **整份 400 行**（占很多 token）

**第 2 次：同一文件、同一 range，磁盘未改**

命中条件（源码逻辑）：

- `readFileState` 里有该路径  
- 不是 `isPartialView`  
- 条目来自先前 Read（`offset !== undefined`；Edit/Write 写入的条目 offset 为 undefined，故意不参与 dedup）  
- `offset` / `limit` 与上次相同  
- 当前磁盘 mtime === 账本里的 `timestamp`

则返回：

```text
File unchanged since last read. The content from the earlier Read
tool_result in this conversation is still current — refer to that
instead of re-reading.
```

（常量 `FILE_UNCHANGED_STUB`）

页面侧类似：`Unchanged since last read`。

**文件被改过（mtime → T2）**

再 Read → 不走 stub，重新读盘送全文，并更新账本。

**读的是另一段**

上次 `offset=1, limit=50`，这次 `offset=51, limit=50` → range 不同，不算命中，照常读新的 50 行。

对比表：

| 次数 | 无 readFileState（朴素实现） | CC（文件未改、同 range） |
|------|------------------------------|-------------------------|
| 第 1 次 | 400 行进上下文 | 400 行进上下文 |
| 第 2 次 | **又 400 行** | 一句 stub |
| 第 3 次 | **再 400 行** | 还是 stub |

CC 注释称约 **18%** 的 Read 是这种 same-file 碰撞；重复全文会浪费后续轮次的 cache/token。

---

## 10. 怎么知道「上次全文还在 LLM 上下文」？

**短答：stub 当下并不会扫描当前 prompt，确认那 400 行还在。**

靠的是会话侧约定：

```
发给 LLM 的 messages              本地 readFileState（内存账本）
... 第1次 Read → 400行全文  ←假定仍在→  auth.ts @ mtime=T1
```

第 2 次只查账本（路径 / range / mtime），**不**去 messages 里找「全文还在不在」。  
注释里 “The earlier Read tool_result is still in context” 是**产品假设**，不是运行时校验。

### 10.1 假设何时成立：靠清账本对齐生命周期

| 事件 | 对 messages | 对 readFileState |
|------|-------------|------------------|
| 正常多轮，旧 Read 还在历史 | 全文还在 | 保留 → stub 合理 |
| **Full compact** | 旧 tool_result 被摘要替换 | **`clear()`**，下次必须重读 |
| `/clear`、新会话、部分 fork agent | 历史没了 | **`clear()`** |
| 文件 mtime 变了 | — | 对不上 → 不 stub，重读 |

不是「查 LLM 脑子」，而是「账本还在时，默认历史里通常还有那次结果」。

### 10.2 Microcompact：**不会**清 `readFileState`（已核对源码）

`src/services/compact/microCompact.ts` 中 **`readFileState` 零引用**。

Microcompact（含 time-based）实际只做：

1. 收集可压缩工具的 `tool_use_id`（**包括 Read**、Bash、Grep 等）  
2. 保留最近 N 个，更早的 `tool_result.content` 改成：

```text
[Old tool result content cleared]
```

3. **到此结束**——没有 `readFileState.delete` / `clear`

对比：

| 路径 | 清不清 readFileState |
|------|----------------------|
| **microcompact** | **否** |
| **full compact**（`compact.ts`） | **是** → `context.readFileState.clear()` |
| `/clear` 等 | 是 |

### 10.3 因此存在的灰色地带

可能出现：

1. 很早的 `Read auth.ts` 全文已被 MC 清成 `[Old tool result content cleared]`  
2. `readFileState` 里仍记着 `auth.ts @ mtime=T1`  
3. 磁盘未改 → 再 Read 同 range → **仍可能返回 `file_unchanged` stub**  
4. stub 让模型「去看更早那次 Read」，但那次内容其实已被清掉  

**结论：microcompact 与 Read dedup 的账本不同步；full compact 才会两边一起清。**

若自研 coding agent 要做同类 dedup，更稳的做法是：

- MC 清掉某次 Read 时，同步从 `readFileState` 删除对应路径；或  
- 发 stub 前扫一眼历史里是否还有「非 cleared」的全文  

---

## 11. 和 malware reminder 的关系（别混）

| | malware `system-reminder` | `file_unchanged` / readFileState |
|--|---------------------------|----------------------------------|
| 目的 | 安全护栏（勿增强恶意代码） | 省 token（避免重复塞全文） |
| 触发 | 每次成功读到正文（非豁免模型） | 重复 Read + 同 range + mtime 未变 |
| 模型看到 | 全文 **后面** 再加一段英文 | **没有全文**，只有 stub 句子 |
| 分片读 10 次 | 可出现 10 段相同 reminder | 同 range 未改时第 2 次起应是 stub，不是 10 份全文 |

二者独立；命中 `file_unchanged` 时走 stub 分支，不会再 map 出「全文 + malware reminder」。
