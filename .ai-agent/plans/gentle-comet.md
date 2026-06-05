# Overview

对当前项目做一次只读巡检后，最值得优先重构的是：前端两个 Zustand 巨型 store、后端 agent 主循环/单步执行流程、手写 HTTP router、工具/常量命名同步、以及 `examples/07-basic` 与 `examples/08-basic` 的重复演进代码。目标不是一次性“大改”，而是按风险和收益拆成可验证的小步：先抽纯函数与类型边界，再拆模块，最后清理重复和兼容层。

# Implementation Steps

1. **先建立重构安全网**
   - 确认并运行现有 `npm run typecheck` 覆盖 `examples/08-basic`。
   - 给 `client/web` 增加最小静态检查脚本（如 build/type-free lint 的替代检查），避免 JSX/store 拆分时只靠手测。
   - 对高风险纯逻辑（SSE 解析、路径/标签切换、工具事件归并）补少量单元测试或可独立调用的测试夹具。

2. **拆分 `client/web/src/stores/chat-store.js`**
   - 将 SSE 文本解析从 `sendMessage` 中抽到 `client/web/src/lib/sse.js`，把“读流/切分 event/data/JSON.parse”变成纯函数或异步迭代器。
   - 将 `_handleSSE` 的大 switch 拆成事件处理映射：session/mode、reasoning/text、tool events、plan/ask events 分文件组织。
   - 将反复出现的“复制最后一条 assistant message 并更新 parts”抽成 helper，减少 `_append*` 系列函数的重复不可变更新代码。
   - 保持 store 对外 API 不变，先做内部拆分，避免影响组件。

3. **拆分 `client/web/src/stores/workspace-ide-store.js`**
   - 按功能域拆成 slice/helpers：layout、tree/cache、create/delete/upload、git changes、tabs/diffs、editing。
   - 把 `parentDir`、`isUnderPath`、tab 选择逻辑、dirty 文件确认逻辑抽到 `client/web/src/stores/workspace-ide-helpers.js` 或 `client/web/src/lib/workspace-paths.js`。
   - 将 `window.confirm/window.alert` 从 store 中隔离为可注入/可替换的 confirmation adapter，降低 UI 副作用和测试难度。
   - 保持 `useWorkspaceIdeStore` 入口不变，仅组合 slices。

4. **收敛后端 agent 编排逻辑**
   - 在 `examples/08-basic/core/agent.ts` 中继续拆分：将 deferred tool activation、todo reminder、compaction logging、retry strategy、LLM request construction 分到 `core/agent/*` 下独立模块。
   - 将 `runOneStep` 的 `while(true)` + 多类 retry 改为显式 retry policy/helper，使 context-length retry 与 transient retry 的预算和日志更清晰。
   - 将 `streamText` 参数构造提取为纯函数，方便独立检查消息准备顺序（reasoning inline → tool pairing → cache control）。

5. **替换/拆分手写 HTTP router**
   - `examples/08-basic/server/router.ts` 目前把静态资源、settings、sessions、MCP、plan approval、question answer、chat 分发混在一个函数中。
   - 先不引入重型框架也可以：新增轻量 route registry（method + path matcher + handler），并将 handlers 拆到 `server/routes/*.ts`。
   - 已经存在 `server/routes/chat.ts`，可沿这个模式继续迁移 sessions/settings/mcp/plan/question。

6. **清理工具名常量和重复兼容层**
   - `examples/08-basic/tools/tool-names.ts` 已标记 deprecated，但仍有多处从该兼容 re-export 导入；统一迁移到 `examples/08-basic/constants/tool_names.ts`。
   - 同步前端 `client/web/src/lib/tool-names.js` 与后端常量，考虑生成或共享一份 schema，减少“keep in sync”注释背后的漂移风险。

7. **处理 `examples/07-basic` 与 `examples/08-basic` 的重复代码**
   - 先判定 `07-basic` 是否仍作为教学阶段/历史版本必须保留。
   - 如果保留：在 README 标明“冻结/教学用”，避免继续维护两套近似实现。
   - 如果仍需维护：把共同的 core（event-bus、provider-manager、tool-registry、workspace path-safety/fs-ops、LLM resolve/strategies）抽到共享包或 `examples/shared`，再让 07/08 只保留差异层。

8. **专门重构 `examples/08-basic/utils/ripgrep-fallback.ts`**
   - 该文件承担 args 解析、glob 转 regex、文件枚举、gitignore 行为、搜索输出格式等多重职责。
   - 拆成 `parse-rg-args.ts`、`glob-match.ts`、`file-enumerator.ts`、`format-rg-output.ts`，并用 rg 兼容样例做回归测试。
   - 由于这是工具基础能力，建议排在 store/agent 拆分之后，避免一次改动过多基础设施。

# Critical Files

- `client/web/src/stores/chat-store.js` — 783 行，集成会话、SSE 解析、事件归并、消息 parts 更新，是前端最高收益重构点。
- `client/web/src/stores/workspace-ide-store.js` — 534 行，混合 IDE 布局、文件树、上传删除、git diff、编辑保存，适合按 slice 拆分。
- `examples/08-basic/core/agent.ts` — 559 行，核心 agent loop、compaction、retry、streamText 调用集中，建议拆成可测试编排模块。
- `examples/08-basic/server/router.ts` — 269 行手写路由分发，多个业务域混合，适合迁移到 route registry + routes 目录。
- `examples/08-basic/process_input/prepare_chat_turn.ts` — 262 行，串联 slash、subagents、skills、tools、attachments、mode restrictions，可进一步管线化。
- `examples/08-basic/utils/ripgrep-fallback.ts` — 494 行基础工具兼容实现，职责过多且边界复杂，适合最后按职责拆分。
- `examples/08-basic/tools/tool-names.ts` / `examples/08-basic/constants/tool_names.ts` / `client/web/src/lib/tool-names.js` — 工具名来源不统一，长期容易前后端漂移。