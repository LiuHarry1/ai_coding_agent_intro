# 白泽（Baize）快速开始

白泽是一个**浏览器自动化助手**：你告诉它要做什么，它会自动打开网页、点击按钮、填写表单，并把页面上看到的内容告诉你。同时也支持读写代码、运行命令等编程辅助能力。

本指南面向**第一次使用**的用户，从零到能跑起来，大约 15～30 分钟。

> 开发者本地调试 Web UI，见 [本地开发](development.md)。完整功能索引见 [README](../../README.md)。

---

## 你需要准备

| 项目 | 说明 |
|------|------|
| 电脑 | Windows 10/11、macOS 或 Linux |
| [Node.js](https://nodejs.org/) | **20 或更高版本**（安装时勾选 “Add to PATH”） |
| [Google Chrome](https://www.google.com/chrome/) | 仅在使用「自己的浏览器登录态」时需要 |
| 大模型 API | 向团队索取 API 地址和 Key |

### 打开终端

- **Windows**：按 `Win + R`，输入 `cmd`，回车
- **macOS**：打开「终端」应用

验证 Node 已安装：

```bash
node -v
npm -v
```

若分别显示 `v20.x.x` 和 `10.x.x` 之类的版本号，说明环境 OK。

---

## 第一步：下载代码

### 方式 A — 用 Git（推荐）

```bash
git clone <你的仓库地址>
cd ai_coding_agent_intro
```

### 方式 B — 下载 ZIP

1. 打开 GitHub 仓库页面
2. 点击绿色 **Code** → **Download ZIP**
3. 解压到例如 `C:\Users\你的用户名\baize`
4. 在终端里进入该文件夹：

```bash
cd C:\Users\你的用户名\baize
```

---

## 第二步：安装依赖

在项目根目录依次执行（每条等它跑完再执行下一条）：

```bash
npm install
```

```bash
cd client/web && npm install && cd ../..
```

**成功标志**：没有红色 `ERROR`，最后回到项目根目录。

---

## 第三步：配置大模型

模型配置在 `.ai-agent/settings.json`（不是 `.env`）。

1. 若还没有 `settings.json`，复制示例文件：

```bash
cp .ai-agent/settings.example.json .ai-agent/settings.json
```

Windows 若没有 `cp`，可在资源管理器里手动复制 `.ai-agent/settings.example.json` 并重命名为 `settings.json`。

2. 用记事本或 VS Code 打开 `.ai-agent/settings.json`
3. 把 `baseURL`、`apiKey`、`model` 改成团队提供的值

保存文件。

| 配置什么 | 放哪里 |
|----------|--------|
| 大模型 API（baseURL、apiKey、model） | `.ai-agent/settings.json` |
| 端口、工作区路径等（可选） | 仓库根目录 `.env` |
| 浏览器模式 | `.ai-agent/settings.json` 的 `browser` 段 |

---

## 第四步：启动桌面版

在项目根目录执行：

```bash
npm run desktop:dev
```

第一次会稍慢（要构建界面）。

**成功标志**：弹出一个桌面窗口，里面是白泽的聊天界面。

> 桌面版会自动在后台启动 Agent，一般**不需要**再单独开 `npm start`。

---

## 第五步：试用浏览器自动化（无需装扩展）

1. 在聊天界面选择专家：**Browser Automation**（浏览器自动化）
2. 直接输入，例如：

   > 打开 https://example.com ，告诉我页面标题是什么

默认使用 **isolated** 模式：Agent 会自己开一个独立 Chrome，**不用登录的网站**可以直接用，**零配置**。

---

## 第六步（可选）：用自己的 Chrome + 登录网站

如果任务需要**已登录的账号**（后台、邮箱、内网等），按下面做一次即可；**配对只需做一次**。

### 6.1 改配置

编辑 `.ai-agent/settings.json`，确保有：

```json
{
  "browser": {
    "mode": "extension"
  }
}
```

若文件里已有其他字段，只改 `browser` 这一段，保留其余内容。

### 6.2 重启桌面版

关掉 Electron 窗口，再执行：

```bash
npm run desktop:dev
```

### 6.3 获取配对令牌

**保持桌面版开着**，新开一个终端，在项目根目录执行：

```bash
npm run browser:pair
```

终端会打印 **Port** 和 **Token**，先复制 Token 备用。

### 6.4 安装 Chrome 扩展（只需一次）

1. Chrome 地址栏输入 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目里的 `chrome-extension` 文件夹（不是整个仓库根目录）

### 6.5 Pair（配对）

1. 点击 Chrome 工具栏上的白泽扩展图标
2. 粘贴上一步的 **Token**
3. 点击 **Pair**

**成功标志**：扩展图标旁圆点变**绿色**。

### 6.6 验证

对 Agent 说：

> 打开我已登录的某某网站，告诉我当前登录的是谁

应能读到你的账号，而不是登录页。

完整说明见 [浏览器自动化指南](browser.md)。

---

## 日常使用

| 你想做什么 | 怎么做 |
|------------|--------|
| 打开桌面版 | 项目根目录：`npm run desktop:dev` |
| 公开网页、本地页面 | 不用扩展，直接聊 |
| 需要登录的网站 | 确保扩展已 Pair（绿点），必要时在扩展里 **Share this tab** 分享当前标签页 |
| 重新查看配对码 | `npm run browser:pair`（Token 一般不变） |

---

## 常见问题

| 现象 | 处理 |
|------|------|
| `node` 不是内部或外部命令 | 重装 Node.js，勾选 Add to PATH，重启终端 |
| 桌面版打不开 / 白屏 | 确认已执行 `npm install` 和 `client/web` 下的 `npm install` |
| Agent 不回复 | 检查 `.ai-agent/settings.json` 里 API 是否正确 |
| 扩展 Pair 没反应 | 确认 `browser.mode` 为 `extension` 且已**重启**桌面版 |
| `No browser extension is connected` | 扩展未安装、未 Pair，或 Agent 未在 extension 模式下运行 |
| 百度/Google 出验证码 | 换 extension 模式，用你自己的 Chrome 登录态 |

---

## 下一步

- [README](../../README.md) — 功能总览与文档索引
- [浏览器自动化指南](browser.md) — 两种模式、工具说明、故障排查
- [本地开发](development.md) — Web UI 热更新、调试 prompt 轨迹
