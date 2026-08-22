# 浏览器自动化使用指南

让 coding agent 打开网页、点击、填表、截图,并把页面上看到的东西读回来。典型用途是改完前端后让它自己验证效果,或者去某个后台页面把数据捞出来。

## 两种模式,先选一个

| | `isolated`(默认) | `extension` |
|---|---|---|
| 用哪个浏览器 | agent 自己拉起的 Chrome,独立 profile | **你自己的 Chrome** |
| 登录态 | 没有,每次都是全新浏览器 | 你已登录的账号全都能用 |
| 需要装东西 | 不用 | 要装一个本地扩展(一次) |
| 默认可见性 | 无头,你看不见 | 就在你眼前的浏览器窗口里 |
| 适合 | 验证 localhost、公开页面 | 需要登录的站点、内网后台、会拦机器人的站点 |

判断很简单:**页面要不要登录**。不要就用 `isolated`,零配置;要就用 `extension`。

工具行为两种模式完全一致,切换模式不用改任何提示词。

---

## 方式一:isolated 模式(默认,零配置)

启动后端就能用:

```bash
npm start
```

然后直接跟 agent 说「打开 http://localhost:5173,看看登录按钮渲染对不对」即可。

默认是**无头**的,你什么都看不到。想看着它操作,在 `.ai-agent/settings.json` 里加:

```json
{
  "browser": {
    "mode": "isolated",
    "headless": false
  }
}
```

改完**重启 agent** 生效。之后会弹出一个独立的 Chrome 窗口,里面是 agent 的操作过程。

> 这个浏览器用的是 `~/.ai-agent/browser/profile`,和你日常 Chrome 完全隔离:没有你的 cookie、扩展和历史。所以百度、Google 这类站点可能会给它弹验证码——这不是 bug,是它看起来确实像个全新的机器人。遇到这种情况就换 `extension` 模式。

---

## 方式二:extension 模式(用你自己的 Chrome)

页面带着你的真实登录态加载,agent 不需要你写任何登录脚本。

### 1. 改配置

`.ai-agent/settings.json`:

```json
{
  "browser": {
    "mode": "extension"
  }
}
```

### 2. 重启 agent

```bash
npm start
```

**这一步不能省。** 中继服务在 **Browser Automation 专家**（或 `browser.enabled: true`）且 `mode: extension` 时才会监听；默认 coding agent 不会拉起中继。启动日志里应该出现:

```
[browser] extension relay listening on 127.0.0.1:8766
```

### 3. 取配对令牌

```bash
npm run browser:pair
```

会打印端口和令牌。令牌存在 `~/.ai-agent/browser/relay.json`(权限 0600),**不会变**,所以配对只需要做一次,以后重启 agent 扩展会自己重连。

### 4. 装扩展

你日常的 Chrome **不需要重启**:

1. 打开 `chrome://extensions`,右上角开启 **开发者模式**
2. 点 **加载已解压的扩展程序**,选仓库里的 `chrome-extension/` 目录
3. 点工具栏上新出现的扩展图标,粘贴令牌,点 **Pair**

圆点变绿即接通。

> 不要用旁边的「打包扩展程序」按钮。它生成的 `.crx` 在现代 Chrome 里没法拖拽安装(非商店来源会被拒),同时生成的 `.pem` 是签名私钥,别提交进仓库(已加进 `.gitignore`)。装本地扩展就用「加载已解压的扩展程序」。

### 5. 验证

跟 agent 说「打开 <某个你已登录的页面>,告诉我当前登录的是谁」。它应该直接读到你的账号,而不是登录页。

---

## agent 能看到什么,不能看到什么

这是 extension 模式最需要先讲清楚的一点:

- **能看**:它自己开的标签页,以及你在扩展弹窗里点了 **Share this tab** 主动分享的标签页
- **不能看**:你其余的标签页。它连列都列不出来,更读不到内容

所以如果你想让它看一个你已经打开的页面,得先在弹窗里分享一下。弹窗里会列出当前共享给 agent 的所有标签页,随时可以撤销。agent 操作过的标签页会被自动归到一个叫 **Agent** 的标签组里,方便你一眼看出哪些被动过。

关掉扩展或者点撤销,agent 立刻失去访问权。

**要输入就得切到那个标签页。** 读页面(打开、抓快照、截图、看网络)都在后台悄悄进行,不打扰你;但点击、输入、按键、滚动这类操作会先把目标标签页切到前台。这不是设计取舍,是 Chrome 的硬性行为:发给隐藏标签页的输入事件会被直接丢掉,命令还照样返回成功——真点了个寂寞。所以宁可抢一下焦点,也不能让点击悄悄失效。窗口最小化时输入同样送不到,这种情况 agent 会明确报错让你还原窗口,而不是假装点过了。

---

## 22 个工具

一般不用记,直接用自然语言描述目标就行。列出来是方便你看懂对话里的工具卡片:

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 打开 http(s) URL,或后退 / 前进 / 刷新 |
| `browser_snapshot` | 抓页面结构;可选 `includeDiff` / `urls` |
| `browser_click` | 按 snapshot ref 点击,或 `x`/`y` 点画布 |
| `browser_drag` | 把一个 ref 拖到另一个 ref |
| `browser_type` | 输入文本,可选回车提交 |
| `browser_fill_form` | 一次填多个字段(文本框、复选框、单选、下拉),逐个报结果 |
| `browser_select_option` | 原生 `<select>` 按可见文案选；自定义下拉先 snapshot 再点选项 ref |
| `browser_file_upload` | 拦截文件选择框并上传,不弹系统对话框 |
| `browser_handle_dialog` | 接受或取消原生 alert/confirm/prompt |
| `browser_press_key` | 按键,支持组合键 |
| `browser_wait_for` | 等待文字出现/消失,或等一小段时间 |
| `browser_hover` | 悬停 |
| `browser_scroll` | 滚动页面或某个元素 |
| `browser_screenshot` | 整页或单个元素截图; `labels` 叠 ref 标注 |
| `browser_resize` | 改视口尺寸 |
| `browser_wait_for_download` | 等下一次下载并保存 |
| `browser_console` | 读控制台输出和未捕获异常 |
| `browser_network` | 列出页面发的 fetch/XHR 请求,带状态码和耗时 |
| `browser_highlight` | 在页面上高亮一个 ref（视觉对齐） |
| `browser_get_bounding_box` | 读取 ref 的视口坐标框 |
| `browser_tabs` | 列出/新建/切换/关闭标签页 |
| `browser_lock` | 把控制权交给用户(`unlock`)或收回(`lock`) |

浏览器一旦拉起,聊天区顶部会出现一条横幅:**Take control** 暂停 agent,你自己操作页面;**Resume agent** 交还。暂停期间只能读（快照、截图、控制台、网络、列标签页），不能点击、输入。extension 模式的弹窗里有同样的按钮。

工具卡片上的 **Show page structure** 按钮会展开当次快照,也就是 agent 当时"看到"的页面。排查它为什么点错元素时看这个。

### 调接口问题时最有用的一条

`browser_network` 区分两种在界面上长得一模一样的失败:

- **请求到了服务器但被拒**——有状态码,比如 `500 POST /api/order/save`
- **请求压根没发出去**——显示 `never sent`,附带原因(地址写错、服务没起、CORS、被取消)

这两种的修法完全不同,靠肉眼看页面是分不出来的。

而且**不用专门去问**:任何动作(点击、输入、导航)如果引发了失败的请求,那次动作的工具卡片会直接把它带回来,和控制台报错一样。所以典型的"点了没反应"一轮就能定位:

> 点"保存"没反应,帮我看看为什么

agent 点一下,就能看到 `500 POST /api/order/save`,再读页面脚本发现 `catch(() => {})` 把错误吞了。

只能看见 fetch 和 XMLHttpRequest,看不到文档导航本身和图片/脚本/样式表这些子资源——那需要 CDP 的事件通道,当前架构刻意没有(见[对比文档](docs/browser-automation-comparison.md)的落地复盘)。

---

## 配置项

全部放在 `.ai-agent/settings.json` 的 `browser` 下:

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `isolated` | `isolated` 或 `extension` |
| `enabled` | `false` | 默认 coding / 其它 primary 无 `browser_*`；`true` 时恢复 deferred；**Browser Automation 专家始终有 browser 工具** |
| `headless` | `true` | 仅 isolated 模式;设 `false` 可看见窗口 |
| `relayPort` | `8766` | 仅 extension 模式;改了要在弹窗里同步改 |
| `channel` | `chrome` | 仅 isolated 模式,指定 Chrome 渠道 |
| `viewportWidth` | `1280` | 仅 isolated 模式 |
| `viewportHeight` | `800` | 仅 isolated 模式 |
| `idleTimeoutMinutes` | `30` | 闲置多久后关掉浏览器 |

改任何一项都要重启 agent。

---

## 故障排查

| 现象 | 原因和处理 |
|---|---|
| 「我没看见它动我的浏览器」 | 多半还在默认的 isolated 无头模式。查中继端口:`nc -z 127.0.0.1 8766`,不通就说明不是 extension 模式 |
| `No browser extension is connected on 127.0.0.1:8766` | 扩展没装、没配对,或改完 `mode` 没重启 agent |
| 弹窗里点 Pair 没反应 | agent 没起来或不在 extension 模式,中继没在监听 |
| 百度/Google 弹验证码 | isolated 模式的空白 profile 像机器人。换 extension 模式用你的真实会话 |
| `Ref e3 is stale` | 页面变了,快照过期。让它重新抓一次快照即可,通常它会自己处理 |
| 「它一操作就把我的标签页切过去」 | 预期行为,输入类操作必须在可见标签页上才生效,见上文 |
| `The page is still hidden after being brought to front` | Chrome 窗口被最小化了,还原窗口再让它重试 |
| 端口 8766 被占 | 另一个 agent 实例在跑,或改 `relayPort`(弹窗里也要同步改) |
| 重装扩展后连不上 | 令牌不变,重新在弹窗粘一次即可 |

---

## 相关命令

| 命令 | 说明 |
|---|---|
| `npm run browser:pair` | 打印配对端口和令牌 |
| `npm run browser:dev-chrome` | 起一个已装好扩展并配对的独立 Chrome,用来试 extension 模式而不动你日常浏览器 |
| `npm run test:browser:unit` | 浏览器相关单元测试,约 1 秒,不需要 Chrome |
| `npm run test:browser` | 全量:单元 + 边界 + 隔离后端 + 中继 + 真实扩展端到端 |

## 延伸阅读

- 扩展本身的说明:[`chrome-extension/README.md`](chrome-extension/README.md)
- 各家方案的架构对比:[`browser-automation-comparison.md`](docs/browser-automation-comparison.md)
- 让 agent 自己做前端验证的技能:`.ai-agent/skills/verify-in-browser/SKILL.md`
