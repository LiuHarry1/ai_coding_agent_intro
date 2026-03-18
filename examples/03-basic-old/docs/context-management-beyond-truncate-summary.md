# 除了 Truncate 和 Summary，还有哪些上下文管理方法？

结合 **Claude Code**、**Cursor**、**OpenCode**、**Pi** 的做法，把「更好管理 context、避免无限膨胀」的方法归纳如下。

---

## 一、你已经在做的：Truncate + Summary

- **Truncate（Microcompaction）**：旧工具输出替换成一行摘要，只保留最近 N 次完整结果。
- **Summary（Compaction）**：消息多了就把旧消息压成一段摘要，保留最近几条。

这两类能减 token，但容易带来「截断后 agent 又去读同一文件」的循环。下面是可以叠加或替代的其它手段。

---

## 二、Claude Code：三层 + 落盘 + Rehydration

### 1. 工具输出落盘（Cold storage）

- **做法**：大体积工具输出不只在 context 里截断，而是**先存到磁盘**，在 context 里只留**路径引用**。
- **效果**：agent 需要时按路径读缓存，而不是反复读「原始文件」，减少重复读同一文件的循环。
- **要点**：引用要带路径，例如 `[Output saved to .agent-cache/xxx.txt (4827 chars). read_file that path if needed.]`。

### 2. Headroom / 预留 token（Reserve token floor）

- **做法**：为「压缩过程 + 后续回复」预留固定 token（例如 200K 窗口预留 ~33K），**按剩余空间**决定何时做 compaction，而不是只按消息条数。
- **效果**：避免刚压完又立刻顶满；压完后还有足够空间继续对话。

### 3. Compaction 后 Rehydration（你已经实现了一版）

- **做法**：做完 summary 之后，**系统主动**把「最近读过的几个文件」再读一遍，写回 context（或带路径的摘要块）。
- **效果**：agent 不用自己再调 `read_file`，既控制长度又减少「读→压掉→再读」的循环。

### 4. Manual compaction + focus hint

- **做法**：提供 `/compact` 一类命令，让用户在**任务边界**手动触发压缩，并可带一句「保留重点」的提示（例如：Focus on API changes）。
- **效果**：摘要更贴合当前任务，减少重要信息被压掉。

---

## 三、Cursor：动态上下文 + 子 agent + 长输出写文件

### 1. 动态上下文发现（Dynamic context discovery）

- **做法**：**不在一开始塞满**静态 context，而是按需拉取：需要时再加载 MCP、技能、文件等。
- **效果**：基础 context 更小，只有「当前用到的」才进窗口，从源头控制膨胀。

### 2. 长工具输出写文件

- **做法**：Shell / MCP 等长输出**不直接截断**，而是**写入文件**，给 agent 一个引用；agent 用 `tail` 或 `read_file(offset/limit)` 按需看。
- **效果**：不丢信息，又不会一次性撑爆 context；agent 知道「要看去哪个文件」，不会盲目重跑原命令。

### 3. 子 agent（Subagents）隔离重操作

- **做法**：把「探索 / Bash / Browser」等重、吵的工具放到**独立 context** 的子 agent；主 agent 只收到**结论或摘要**。
- **效果**：主对话里工具输出很少，context 增长慢，重复读、重复试错不会堆在主线程。

### 4. 压缩时引用历史文件

- **做法**：做 summarization 时，把**完整历史**也当成可读文件（例如 chat history 的路径）；压缩后若 agent 发现摘要里缺细节，可以去**查历史文件**恢复。
- **效果**：压缩是「可逆」的，缺什么再查，而不是一压就永久丢。

---

## 四、OpenCode：Compaction 恢复 + 状态持久

### 1. Compaction 后自动恢复技能/上下文

- **做法**：检测到 `session.compacted` 后，用**合成消息**把「技能列表、关键配置」等重新注入，不让一次 compaction 把能力描述也压没。
- **效果**：压完还能继续用技能和配置，不会「失忆」。

### 2. 改进 Compaction 的 prompt

- **问题**：通用摘要容易把「用户贴的日志、具体错误信息、路径、版本」压成模糊描述。
- **做法**：在 compaction 的 system 里明确要求保留：用户粘贴内容、精确技术细节、约束与偏好、已排除的假设等。
- **效果**：摘要更「可执行」，减少 agent 为补信息而反复读同一文件。

### 3. 状态持久（如 DCP 插件）

- **做法**：把 pruning/compaction 的**历史与统计**持久化到磁盘，跨会话复用。
- **效果**：可以做更细的 token 预算和策略，而不是每次会话从零开始。

---

## 五、Pi：会话树 + 按 token 触发 + 小 system

### 1. 会话当树而不是单线（/tree）

- **做法**：会话是**树**，当前「叶节点」才是 LLM 看到的 branch；用 `/tree` 切到别的节点继续，**离开的 branch 可做 branch summarization**，把摘要带到新 branch。
- **效果**：探索、试错放在侧枝，主枝保持短且干净；换枝时用摘要带走关键信息，而不是整段历史都进 context。

### 2. 按 token 预算触发 compaction

- **做法**：用**预估 token 数**（或 API 的 token 限制）触发 compaction，并设 **reserve floor**（例如 16K–20K），压完后保证剩余空间。
- **效果**：不会「消息数还没到 20 条但 token 已经爆了」；压完也有空间继续生成。

### 3. 极简 system prompt

- **做法**：system 控制在约 1K token 内，角色/工具/规则分层、按需组装。
- **效果**：更多预算留给对话和工具结果，延长「第一次需要 compaction」的时间。

### 4. Branch summarization vs 全局 compaction

- **Branch**：换枝时对**当前离开的那条枝**做摘要，注入新枝。
- **Compaction**：整段历史 token 超阈值时，对**整段**做摘要。
- **效果**：两套机制，一个管「分支切换」，一个管「总长度」，互不替代。

---

## 六、其它常见思路（业界/论文）

| 方法 | 说明 |
|------|------|
| **Preventive filtering** | 在**写入 context 前**就过滤/压缩（例如只保留关键子树、关键行），从入口控制体积，延迟或减少 reactive compaction。 |
| **Token 预算 + 预留** | 维护「当前已用 / 剩余」token， compaction 后检查「压完 < 压前」且「剩余 ≥ reserve」，再重试请求。 |
| **MessageGroup 原子性** | 以「assistant + 对应 tool 消息」为原子组，压缩时整组保留或整组压成摘要，避免出现「只有 tool 没有 call」的非法状态。 |
| **API 侧 compaction** | 若提供商有 `/responses/compact` 一类接口，用服务端压缩（有时带 latent 表示），减少客户端逻辑和重试。 |
| **Delta summarization** | 对「新增消息」基于「已有摘要」做增量摘要（1–2 句），而不是每次都重跑整段历史。 |

---

## 七、和「Truncate + Summary」的关系

- **Truncate / Summary** 主要解决：**已经变长**的 context 如何变短。
- 上面这些是在**同一目标**下的补充手段：
  - **减少「变长」的速度**：落盘引用、长输出写文件、子 agent、动态加载、小 system。
  - **减少「压完又立刻再读」**：Rehydration、压缩时引用历史文件、改进 compaction prompt。
  - **更稳地触发与回退**：按 token + reserve 触发、MessageGroup、overflow 检测 + 有限次重试。

所以：**除了 truncate 和 summary，还可以做**落盘引用、按 token 触发 + 预留、Rehydration、会话树/分支摘要、子 agent、长输出写文件、压缩时历史可查、以及更好的 compaction prompt**；它们和 truncate/summary 是叠加关系，不是二选一。

---

## 八、若要在 03-basic 里逐步加强，可考虑的优先级

1. **已做**：truncate（带工具/文件提示）+ summary + rehydration + prompt 里「用 summary，必要时 offset/limit 再读」。
2. **容易加**：  
   - 工具输出**落盘 + 引用**（大结果写 `.agent-cache/xxx.txt`，context 里只留路径 + 一句说明）。  
   - **按 token 估算**（或简单按「消息条数 + 最近工具结果总字符」）触发 compaction，并设 reserve。
3. **中等**：  
   - **Manual compact**：例如 `/compact [focus hint]`，带一句「保留 XXX」的 prompt。  
   - **Compaction prompt 细化**：明确保留错误信息、路径、用户粘贴内容、已排除假设。
4. **架构级**：  
   - **子 agent**：把 explore/bash 等放到单独 context，主 agent 只收摘要。  
   - **会话树**：多 branch + branch summarization（需要改 session 结构和 UI）。

如果你说下当前 03-basic 最痛的点（例如「还是经常重复读」或「压完就 429」），可以按上面表针对性地选 1～2 个先做。
