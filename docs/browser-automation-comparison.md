# 浏览器自动化：六个方案的架构与实现对比

对比对象：Claude Code、Cursor、VS Code、opencode、OpenClaw、Playwright。

调研方式：Claude Code / Cursor / VS Code 三家直接读了本机安装的源码与打包产物；OpenClaw 与 Playwright 读官方文档、源码与 PR；opencode 读官方文档与 DeepWiki。

---

## 摘要

六个方案在**「浏览器从哪来」**这一个问题上分成三派，其余差异基本都是这个选择的下游后果。

- **自己启动一个浏览器**（Playwright、OpenClaw 的 `openclaw` profile）：控制力最强、最好写，但拿不到用户的登录态。
- **内嵌一个浏览器**（Cursor、VS Code Simple Browser）：不用装任何东西，但那是产品自己的浏览器，同样没有用户登录态，且受宿主环境限制。
- **接管用户日常的浏览器**（Claude Code、OpenClaw 的 `chrome` / `user` profile）：唯一能拿到登录态的路子，代价是必须引入 Chrome 扩展或触发 Chrome 的远程调试授权弹窗。

最值得抄的实现是 **OpenClaw**：它用扩展接管了用户的 Chrome，但把扩展做成了一个**说 CDP 协议的 loopback 中继**，于是上层可以直接用 Playwright 的 `connectOverCDP` 连上去。这样「隔离浏览器」和「用户浏览器」共用同一套工具层代码，不需要写两遍。Claude Code 用的是自定义 `execute_tool` 协议，做不到这一点。

这个做法不是孤例——**Qwen Code 独立收敛到了几乎完全相同的架构**，详见下面的「行业收敛」一节。

---

## 速览

| 方案 | 浏览器来源 | 传输层 | 用户登录态 | 元素引用机制 | 需要用户安装 |
|---|---|---|---|---|---|
| Playwright | 自己启动 | CDP（pipe 或 WS） | 无 | `e1`/`f1e5`，绑在元素上 | 无（库） |
| Claude Code | 用户日常 Chrome | 扩展 → native host → Unix socket | **有** | `ref_1`，扩展内部生成 | Chrome 商店扩展 |
| Cursor | IDE 内嵌 webview | 内部 CDP | 无（独立持久化） | opaque ref，绑最近一次快照 | 无 |
| VS Code Simple Browser | webview 里的 iframe | 无 | 无 | 无（不支持自动化） | 无 |
| VS Code js-debug | 自己启动 | CDP（调试端口） | 无 | 无（调试用途，非自动化） | 无 |
| opencode | 不内置 | 外挂 Playwright MCP | 取决于 MCP | 由 MCP 决定 | 配 MCP server |
| OpenClaw | 三选一（隔离/扩展/远程调试） | CDP（统一） | **有**（后两种） | 复用 Playwright + Chrome MCP | 扩展（可选） |

---

## Playwright

其它方案的地基。不是 agent，是库，但它定义了这个领域的事实标准。

### 架构

```mermaid
flowchart LR
  Lib["Playwright 库<br/>Node 进程"]
  Chrome["自己启动的 Chromium<br/>--remote-debugging-pipe"]
  Page["页面"]
  Inject["注入脚本<br/>injectedScript.ts"]

  Lib -->|CDP| Chrome
  Chrome --> Page
  Lib -->|"注入"| Inject
  Inject --> Page
```

关键点：Playwright **自己启动浏览器**，启动时带上调试通道，所以它是这个浏览器实例的主人，不需要往里面装任何扩展。默认使用一个全新的临时 profile，因此拿不到你日常浏览器的 cookie 和登录态。

### 快照与 ref（`_snapshotForAI`）

这是全场最成熟的元素引用实现，源码在 `packages/injected/src/ariaSnapshot.ts`。

`generateAriaTree()` 遍历 DOM 生成可访问性树，`renderAriaTree()` 序列化成 YAML。ref 分配逻辑：

```js
function computeAriaRef(ariaNode, options) {
  if (options.refs === 'none') return
  if (options.refs === 'interactable' &&
      (!ariaNode.box.visible || !ariaNode.receivesPointerEvents)) return

  const element = ariaNodeElement(ariaNode)
  let ariaRef = element._ariaRef
  if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
    ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: (options.refPrefix ?? '') + 'e' + (++lastRef) }
    element._ariaRef = ariaRef
  }
  ariaNode.ref = ariaRef.ref
}
```

三个值得注意的设计：

**ref 挂在元素对象上（`element._ariaRef`），不是存在一张全局表里。** 这意味着只要元素还在、role 和 name 没变，重新快照时 ref 保持不变。对模型很友好——多轮交互中同一个按钮始终是同一个 `e5`，不会因为重新快照就全部错位。

**ref 复用带语义校验。** 判断条件是 `role` 和 `name` 都没变才复用，否则重新编号。这天然处理了「DOM 节点复用但内容换了」的情况。

**iframe 用前缀区分。** `refPrefix` 取 `'f' + frameSeq`，所以 iframe 里的元素是 `f1e5` 这种形式，`aria-ref` 选择器引擎能跨 frame 解析回真实元素。Playwright 是这几家里唯一正经处理 iframe 的。

### 优劣

强在成熟度：auto-waiting（等元素可交互再操作）、locator 体系、网络拦截、trace viewer。弱在它天生就够不着用户已经打开的浏览器——`connectOverCDP` 可以连一个带调试端口启动的浏览器，但一个正常双击启动的 Chrome 没有那个端口。

---

## Claude Code

### 架构

```mermaid
flowchart LR
  CC["Claude Code 主进程"]
  MCP["claude-in-chrome<br/>MCP server"]
  Host["native host<br/>claude --chrome-native-host"]
  Ext["Chrome 扩展<br/>闭源"]
  Tab["用户日常 Chrome 的标签页"]

  CC <-->|stdio MCP| MCP
  MCP <-->|"Unix socket<br/>4 字节 LE + JSON"| Host
  Host <-->|"native messaging<br/>4 字节 LE + JSON"| Ext
  Ext -->|"chrome.debugger + chrome.tabs"| Tab
```

三跳。走这么曲折的路只为一件事：**接管用户已经登录好的 Chrome**。外部进程连不进一个正常启动的 Chrome，只有住在里面的扩展能通过 `chrome.debugger` 拿到 CDP 权限。

### 传输细节

两跳都用 4 字节小端长度前缀 + UTF-8 JSON，上限 1 MiB。

socket 路径 `/tmp/claude-mcp-browser-bridge-${user}/${pid}.sock`，目录 `0700`、文件 `0600`；Windows 用命名管道。**native host 是 server，MCP 端是 client**——因为 Chrome 负责拉起 native host。启动时会遍历目录里的 `<pid>.sock`，对每个 pid 做 `process.kill(pid, 0)`，死进程的 socket 直接删掉。多个 socket 同时存在时，client 全连上，按 `tabId` 路由。

消息格式：

```json
// agent → host
{ "method": "execute_tool",
  "params": { "client_id": "claude-code", "tool": "read_page", "args": { "tabId": 123 } } }

// host → 扩展（加个 type）
{ "type": "tool_request", "method": "execute_tool", "params": { ... } }

// 扩展 → host → agent
{ "result": { "content": [ { "type": "text", "text": "..." } ] } }
```

native host 自己处理 `ping`/`pong` 和 `get_status`，并在 client 连断时向扩展推 `mcp_connected` / `mcp_disconnected`。

除了本地 socket，还有一条云端 WebSocket 通道（`wss://bridge.claudeusercontent.com`，feature flag 控制），用于手机上操作桌面浏览器的场景，带完整的配对和权限请求协议。

### 工具集

18 个，MCP 名字前缀 `mcp__claude-in-chrome__`：

`read_page`、`get_page_text`、`find`、`form_input`、`computer`、`navigate`、`javascript_tool`、`resize_window`、`gif_creator`、`upload_image`、`tabs_context_mcp`、`tabs_create_mcp`、`update_plan`、`read_console_messages`、`read_network_requests`、`shortcuts_list`、`shortcuts_execute`、`switch_browser`。

`computer` 是个大杂烩工具，action 枚举涵盖 `left_click`/`type`/`screenshot`/`scroll`/`key`/`hover`/`zoom` 等，既接受坐标也接受 ref。

值得一提的是 `gif_creator`——录制一段浏览器操作导出 GIF，方便用户回看 agent 到底干了什么。这个产品思路其它家都没有。

### 元素引用

`ref_1`、`ref_2` 格式，由扩展内部在构建可访问性树时生成。`read_page` 支持 `ref_id` 参数下钻子树，用于输出过长时分段读取。**生成逻辑在闭源扩展里，无法参考。**

### 标签页归属

「MCP tab group」概念：扩展维护一个专属标签组，所有工具的 `tabId` 必须落在组内。系统提示明确要求会话开始先调 `tabs_context_mcp`，且「绝不复用上一个会话的 tabId」。

### 权限

三档模式：`ask`、`skip_all_permission_checks`、`follow_a_plan`。站点级授权在扩展的设置里管理。有个 `update_plan` 工具让模型先提交「我要访问这些域名、按这些步骤做」，用户批准后进入 `follow_a_plan` 模式批量放行。

### 提示词

系统提示在 `src/utils/claudeInChrome/prompt.ts`，且工具被 skill 门控——启动时只注入一句提示：

> Before using any `mcp__claude-in-chrome__*` tools, invoke the skill by calling the Skill tool with skill: "claude-in-chrome".

这样 18 个工具的 schema 不会常驻上下文。

### 分发

扩展上架了 Chrome 商店（ID `fcoeoabgfenejglbffodgkkbkcdhcgfn`），用户一键安装。CC 通过扫描各浏览器的 `Extensions/` 目录检测是否已装。native host manifest 由 CC 写入各浏览器的 `NativeMessagingHosts/` 目录；因为 Chrome 不允许 manifest 的 `path` 带参数，还要额外生成一个 wrapper 脚本。

---

## Cursor

### 架构

```mermaid
flowchart LR
  Agent["Cursor Agent"]
  Ext["内置扩展<br/>cursor-browser-automation"]
  View["Electron webview<br/>IDE 内的浏览器 pane"]
  Page["页面"]

  Agent <-->|MCP| Ext
  Ext -->|CDP| View
  View --> Page
  Ext -->|"注入 __cursorBrowserAutomationInjected"| Page
```

实现在 `/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-automation/`，一个注册了 MCP server 的内置扩展。浏览器是 **IDE 内嵌的 Electron webview**，不是你的 Chrome。profile 按 workspace 持久化但与你日常浏览器隔离，所以拿不到你的登录态。

### 工具集

16 个：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_mouse_click_xy`、`browser_type`、`browser_fill`、`browser_select_option`、`browser_press_key`、`browser_scroll`、`browser_drag`、`browser_get_bounding_box`、`browser_highlight`、`browser_tabs`、`browser_cdp`、`browser_take_screenshot`、`browser_lock`。

粒度比 CC 细——CC 一个 `computer` 包办的事，Cursor 拆成了七八个工具。另外它保留了一个 `browser_cdp` 逃生口，可以直接发原始 CDP 命令。

### 几个高明的设计

**`element` 参数做 stale ref 语义校验。** 每个按 ref 操作的工具除了 `ref` 还要求传一个 `element: "人类可读的元素描述"`。执行时会拿它跟 ref 当前指向的元素对账，不匹配就报错：

```
Stale element reference: {ref} expected a button but found {actual}.
The page may have changed. Take a new snapshot.
```

这比单纯的快照版本号更细，能抓住「快照还新鲜但 DOM 已经变了」的情况。

**快照 10 秒 TTL 自动重拍。** 代码里是 `Date.now() - last > 1e4` 就打日志 `Auto-snapshotting view X (stale or missing)` 然后自动重新快照。模型完全不用管快照生命周期。

**点击自带鲁棒性重试。** 默认值 `maxScrollAttempts: 5`、`retryOnStaleRef: true`、`autoCloseDropdowns: true`、`retryWithOffset: true`，还会检测模态框遮挡并提示先关弹窗。

**几乎每个工具都有 `take_screenshot_afterwards`。** 动作和视觉验证一次往返完成，省一轮 tool call。

**`browser_snapshot` 支持 `includeDiff`。** 只返回跟上一张快照的差异，填完表单后确认变化不用再吞一整棵树。

**`browser_lock` 互斥。** 因为用户和 agent 共用同一个 pane，锁上之后用户点「Take Control」才能夺回控制权。

### 限制

`browser_cdp` 禁用所有 `Input.*` 方法，官方理由是「在 Electron webview 里焦点敏感，可能把输入路由到 Cursor 自己的 UI」。此外 cookie、storage、permission、download、target 管理、系统级命令、CDP 导航类命令也在黑名单里。

iframe 内容访问不到——服务器描述里明写「Iframe content is not accessible」。

大 CDP 响应写文件返回路径，不直接塞进上下文。

### 提示词

MCP server 描述里带了一整套工作流和防兜圈子的规则，值得抄：

> Do not repeat the same failing action more than once without new evidence such as a fresh snapshot, a different ref, a changed page state, or a clear new hypothesis.
>
> IMPORTANT: If four attempts fail or progress stalls, stop acting and report what you observed, what blocked progress, and the most likely next step.

---

## VS Code

VS Code 本身**没有**浏览器自动化能力。相关的两个东西一个是反面教材，一个提供了重要的反证。

### Simple Browser：纯展示

内置扩展 `simple-browser`，实现就是在 webview 里塞一个 `<iframe sandbox="allow-scripts allow-same-origin">`，加个地址栏，只有 `simpleBrowser.show` 一个命令。跨源隔离导致扩展宿主读不到 iframe 里的 DOM，**自动化能力为零**。

值得一提：Cursor 把这个扩展的实现整个删了只留转发壳子，README 写着「upstream webview implementation has been removed」，命令全部重定向到它自己的 browser editor。说明 Cursor 认定 iframe 这条路走不通才自研的。

结论：**预览和自动化是两回事**，iframe 方案在自动化上完全不可用。

### js-debug：最重要的一条反证

`ms-vscode.js-debug` 是微软出品、生态里最成熟的 CDP 客户端。策略：

- **launch 模式**：自己拉起 Chrome，带 `--remote-debugging-port`、`--user-data-dir`（一次性 profile）、`--no-first-run`、`--no-default-browser-check`
- **attach 模式**：连已知端口，通过 HTTP `/json/version` 发现 target

关键在它的报错文案：

> It looks like a browser is already running from {0}. Please close it before trying to debug, otherwise VS Code may not be able to connect to it.

**连微软最成熟的 CDP 客户端也接管不了一个已经正常启动的 Chrome。** 这从反面坐实了：想复用日常浏览器的登录态，扩展是绕不开的。

---

## opencode

**不内置任何浏览器工具。**

内置工具只有 `read`/`edit`/`write`/`apply_patch`/`grep`/`glob`/`lsp`/`bash`/`webfetch`/`websearch`/`task`/`skill`/`todowrite`。`webfetch` 和白泽的 WebFetch 一样是静态 HTML 抓取，不执行 JS。

浏览器自动化的官方姿势是**外挂 Playwright MCP**，官网把它列为推荐 recipe：

> Let OpenCode drive a real browser to test, scrape, or verify web flows. Connect the Playwright MCP server and capture regression artifacts.

管理方式是 `opencode mcp add/list/auth`。

### 这个选择的代价

省掉了全部实现工作，但也放弃了全部集成度：工具结果进不了它自己的 UI 体系、图片处理走 MCP 的通用路径、权限模型只能靠 MCP 层的粗粒度开关、用户要自己配 `mcp.json`。而且拿不到登录态——Playwright MCP 跑的是独立 profile。

对「什么时候该自研」这个问题，opencode 给的答案是：**如果你的差异化不在浏览器上，就别自研。**

---

## OpenClaw

六家里架构最成熟的，而且是唯一一个**同时提供三种浏览器来源、但共用一套上层**的。

### 三种 driver

- **`openclaw`**：托管的隔离 profile（Chrome/Brave/Edge/Chromium 均可），agent 专用，不碰你的个人浏览器。不需要扩展。
- **`user`**：通过 Chrome DevTools MCP 附着到你正在用的签入 Chrome 会话。代价是 Chrome 会弹一个阻塞式的「Allow remote debugging?」授权框，**必须有人在电脑前点确认**。
- **`chrome`**：通过 OpenClaw 自己的 Chrome 扩展驱动你的签入 Chrome。**唯一一种没人在电脑前也能用的签入浏览器模式**，因为走 `chrome.debugger` 不触发那个弹窗。

### 扩展中继架构（最值得抄的部分）

```mermaid
flowchart LR
  Agent["Agent / CLI / mcporter"]
  Ctrl["browser control service<br/>Gateway 内，仅 loopback"]
  Relay["loopback relay<br/>127.0.0.1:18792"]
  Ext["MV3 扩展<br/>薄"]
  Tab["用户签入的 Chrome 标签页"]

  Agent --> Ctrl
  Ctrl -->|"CDP over WS"| Relay
  Relay <-->|"WebSocket"| Ext
  Ext -->|"chrome.debugger"| Tab
```

**核心创新：中继对上层伪装成一个标准的 CDP 端点。** PR 里写得很清楚：

> `relay-bridge.ts` owns **all** CDP target synthesis (emulates the browser target for Playwright's `connectOverCDP`, maps session-scoped commands and child/iframe sessions to `chrome.debugger`).

也就是说，上层可以直接用 Playwright 的 `connectOverCDP` 连这个中继，**隔离浏览器和用户浏览器共用完全相同的工具层代码**。Claude Code 用自定义的 `execute_tool` 协议就做不到这一点，它的工具层和扩展是绑死的。

### 他们踩过的坑

这个扩展路径被删过一次又恢复。删的原因和恢复时的设计原则都记在 PR 里：

> The removed extension put this logic in a 1000-line untestable MV3 service worker — that is why it rotted.

恢复后的原则是**扩展要薄**：

> `extensions/browser/chrome-extension/` — a thin MV3 extension: WebSocket client + `chrome.debugger` forwarding + tab-group management, nothing more. Pure logic (pairing parse, backoff, color mapping) is split into a unit-tested module.

所有复杂逻辑（CDP target 合成、session 映射、iframe 子会话）放在宿主侧的 TypeScript 里，可单测。这是血泪教训，直接抄。

### native messaging 只用于配对

和 CC 不同，OpenClaw 的**数据通道是 WebSocket，不是 native messaging**。native host `ai.openclaw.browser_bootstrap` 只在配对时用一次：

> Each `chrome.runtime.sendNativeMessage` call starts one process, reads one request, writes one response, and exits.

一次性、长度前缀 JSON 帧、带 16 字节 nonce、输入上限 4 KiB、校验调用方 origin 是否匹配已安装的 manifest、只返回本地生成的配对信息。

这个设计比 CC 好在：native host 不需要常驻，不需要维护 socket 生命周期和陈旧 socket 清理，攻击面小得多。

### 安全

中继鉴权 token 是**宿主本地密钥**，首次使用时生成在 `credentials/` 下、权限 `0600`，不从 gateway 凭据派生。这样每台跑浏览器的机器各自持有 token，跨机场景下 gateway 凭据不会外流。远程 CDP 有 SSRF 策略，`/json/version` 探测也走同一套检查，状态输出里 `cdpUrl` 的 token 会被打码。

文档对风险讲得很直白：

> If you attach to your daily-driver profile/tab, you're granting access to that account state.

### 一个环境变化要注意

PR 的验证记录里提到，他们用的是 Chrome for Testing v149，因为**稳定版 Chrome 137+ 已经移除了 `--load-extension`**。同时 `chrome.debugger` 附着不触发「Allow remote debugging?」弹窗，而 CDP 端口附着会触发——这是比 js-debug 那个年代更新的行为。

---

## 行业收敛：还有谁在这么做

调研过程中确认了另外几家，它们不在主对比范围内，但收敛的方向很说明问题。

### 「扩展 + `chrome.debugger` + 彩色 tab group」已经是事实标准

至少五家在用同一个形状：Claude Code、**OpenAI Codex**、OpenClaw、Qwen Code，以及第三方的 Chrome Relay。OpenClaw 的 PR 里直接写了这一点：

> Both Codex and Claude use the same shape: an MV3 extension that drives tabs with `chrome.debugger` (no remote-debugging port → no modal) and scopes automated tabs into a colored tab group.

**Codex** 2026 年 5 月上线了官方扩展（ID `hehggadaopoacecdllhhajmbjkdcmajg`）。从它申请的权限列表能反推出实现：`Access the page debugger`（即 `chrome.debugger`）、`View and manage your tab groups`、`Communicate with cooperating native applications`（native messaging）。官方文档的说法是「Chrome browser tasks run in Chrome tab groups so the work for a task stays grouped together」，明确强调不接管你正在用的标签页。

Codex 还有一个和白泽处境高度相似的产品判断——它把浏览器分成三层，按任务自动选：需要登录态的走 Chrome 扩展，**localhost 和文件预览走内置浏览器**，有专门集成的走 plugin。这恰好印证了「验证本地前端」和「操作登录站点」是两个该分开对待的场景。

### CDP 端点这个具体做法，Qwen Code 也在用

Qwen Code 的架构（PR #5777、#6472）：

```
Chrome 侧边栏      ── iframe/HTTP ──────────▶ qwen serve Web Shell
Chrome service worker ── CDP frames over /acp ─▶ qwen serve /cdp tunnel
Chrome 当前标签页   ◀── chrome.debugger ────────┘
外部 MCP adapter   ── stdio MCP + /cdp WS ───▶ qwen serve
```

daemon 的 `/cdp` 端点把外部适配器的**浏览器级 CDP 连接**翻译成 `cdp_*` 帧，扩展再把 page 域的命令通过 `chrome.debugger` 转发到标签页。这和 OpenClaw 的「合成 browser target 让 `connectOverCDP` 能连」是同一件事，两家独立做到了一起。

它还有两个和 OpenClaw 一模一样的结论：

**native messaging 被彻底移除。** PR 原话：「The extension is no longer a Native Messaging host stack — it's a thin client of the local `qwen serve` daemon... Native Messaging is gone from both the chat and tool paths.」数据通道改走 WebSocket。

**扩展要薄。** 「much less surface」，扩展没有 content script，也不维护自己的工具目录，页面检查和自动化全部通过 CDP 隧道提供。

### 两次「删掉又复活」

OpenClaw 和 Qwen Code 的扩展都经历过**先被删除、后来用更好的架构复活**：OpenClaw 在 2026.3.22 删掉 `driver: "extension"`（#47893），后来由 PR #100619 恢复；Qwen Code 的 PR #5777 标题就叫「revive Chrome extension via daemon-direct architecture」。

两家给出的复活理由高度一致——原来的实现把太多逻辑塞进了 MV3 service worker。OpenClaw 说得最直白：

> The removed extension put this logic in a 1000-line untestable MV3 service worker — that is why it rotted.

同一个教训被两个独立项目学了两遍，值得当成硬约束而不是建议。

## 横向对比

### 传输层

Playwright 和 Cursor 直接说 CDP。CC 自己发明了一套 `execute_tool` JSON 协议，两跳都是 4 字节长度前缀帧。OpenClaw 表面看也是扩展中继，但**中继输出的是标准 CDP**，所以上层不需要为它单独写一套。

这个差别的后果很大：CC 的工具层和它的扩展是绑死的，换传输就要重写；OpenClaw 换传输只是换个 CDP endpoint。

### 浏览器归属与登录态

只有 CC 和 OpenClaw 的后两种 driver 能拿到用户登录态，且都是通过扩展或远程调试授权。Cursor 的 webview、Playwright 的托管实例、OpenClaw 的 `openclaw` profile 都是独立 profile——可以持久化，但和你日常浏览器是两个世界。

### 快照与 ref

三种失效策略，可以叠加：

- **Playwright**：ref 挂在元素上，role + name 不变就复用。天然稳定，多轮交互中同一个元素编号不变。
- **Cursor**：ref 绑定到该 tab 最近一次快照，配合 `element` 描述做语义校验，加 10 秒 TTL 自动重拍。
- **Claude Code**：`ref_1` 递增，生成逻辑闭源。

iframe 处理只有 Playwright 做了（`f1e5` 前缀 + `aria-ref` 跨 frame 解析），Cursor 明确不支持。

### 截图

Cursor 把截图和快照的职责分得最清楚：`browser_snapshot` 用来决定做什么，`browser_take_screenshot` 用来视觉验证，工具描述里直说「You can't perform actions based on the screenshot」。而且几乎每个动作工具都带 `take_screenshot_afterwards`，动作加验证一次往返。

CC 的截图走 `computer` 工具的 `screenshot` action，返回标准的 base64 image block 塞进 `tool_result.content`。

### 权限

- CC：三档模式 + 扩展内的站点级授权 + `update_plan` 批量预授权
- Cursor：origin allowlist（官方承认是 best-effort，链接跳转、重定向、`window.location` 都能绕过）+ 审批模式 + 企业级 MCP 开关
- OpenClaw：宿主本地 token、0600 权限、SSRF 策略、tailnet-only 建议
- opencode：交给 MCP 层的粗粒度开关

### 标签页归属

CC 和 OpenClaw 都用 Chrome 的 tab group 做视觉隔离（OpenClaw 还给不同 profile 配了颜色）。Cursor 是共用一个 pane，所以需要 lock/unlock 互斥。

---

## 对白泽的启示

### 一、工具层写一次就够，前提是传输层统一到 CDP

这是本次调研最重要的结论，OpenClaw 和 Qwen Code 独立收敛到了同一个答案。

如果扩展中继对上层伪装成标准 CDP 端点，那么「隔离浏览器」和「用户日常 Chrome」就只是两个不同的 CDP endpoint，工具层、ref 机制、快照脚本、UI 卡片全部共用。**不要照抄 CC 的 `execute_tool` 自定义协议**——那会把工具层和扩展绑死。

实践上意味着：先做 CDP 通道把工具层跑通，之后加扩展通道时只是多一个 endpoint，不需要重写任何上层代码。两个阶段之间没有返工。

### 二、扩展必须薄

OpenClaw 和 Qwen Code 都因为「逻辑塞进 MV3 service worker」而删过一次扩展，又都用薄扩展的形态复活。同一个教训学了两遍，按硬约束对待。

扩展只负责 WebSocket 客户端、`chrome.debugger` 转发、tab group 管理三件事，CDP target 合成和 session 映射放在宿主侧的 TypeScript 里做单测。

### 三、native messaging 只用于配对，甚至可以完全不用

数据通道走 WebSocket。这样 native host 不用常驻，省掉 socket 生命周期管理、陈旧 socket 清理、多实例路由这一大堆 CC 里的复杂度。Qwen Code 走得更远，把 native messaging 从聊天和工具两条路径上全部移除了。

### 四、ref 机制三家的优点可以叠加

- 借 Playwright：ref 挂元素上，role + name 不变就复用
- 借 Cursor：`element` 描述做语义校验 + 快照 TTL 自动重拍
- 自己补：iframe 前缀（Playwright 那套 `f{n}e{m}`）

### 五、工具粒度学 Cursor，不学 CC

CC 的 `computer` 大杂烩工具让模型更容易传错参数。Cursor 拆成细粒度工具，每个 schema 都很窄，加上 `take_screenshot_afterwards` 这种省往返的开关，实际效果更好。

### 六、真正的产品价值在 verify loop

工具本身是基础设施，让 coding agent 好用的是那个闭环：改完前端 → 起 dev server → 导航 → 快照 → 截图自查 → 修 → 再验。这需要 skill 和 prompt 配套，而不只是把工具注册上去。CC 用 skill 门控工具（避免十几个 schema 常驻上下文），这个做法值得抄。

### 七、防兜圈子的提示词要写

Cursor 那段值得直接翻译过来：没有新证据不要重复同一个失败动作；四次失败就停下来报告；遇到登录、验证码、需要人工确认的地方直接停下问用户，不要自己瞎试。浏览器自动化最容易烧 token 的就是模型在页面上反复乱点。

---

## 参考位置

- Claude Code：`src/utils/claudeInChrome/`（`common.ts` socket 路径、`chromeNativeHost.ts` 中继、`setup.ts` manifest 安装、`prompt.ts` 系统提示）；扩展本体闭源
- Cursor：`/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-automation/`
- VS Code：`extensions/simple-browser/`、`extensions/ms-vscode.js-debug/`
- Playwright：`packages/injected/src/ariaSnapshot.ts`、`packages/injected/src/injectedScript.ts`
- OpenClaw：`extensions/browser/src/browser/extension-relay/`、`extensions/browser/chrome-extension/`；文档 `docs/tools/browser.md`、`docs/tools/chrome-extension.md`
- opencode：`packages/opencode/src/tool/`
