# Baize（白泽）— AI Coding Agent

> **第一次使用？** 请先看 [快速开始](docs/guide/getting-started.md)（下载代码 → 安装环境 → 运行桌面版 → 配对浏览器）。

可本地运行的 AI 编程助手：聊天、读写代码、调用工具、浏览器自动化。支持 **桌面版**、**Web UI**、**VS Code / Cursor / IntelliJ** 集成。

---

## 你想怎么用？

| 我是… | 从这里开始 |
|--------|------------|
| 新用户，只想跑起来试试浏览器自动化 | [快速开始](docs/guide/getting-started.md) |
| 开发者，本地改前端 / 调试 agent | [本地开发](docs/guide/development.md) |
| 想在 VS Code / Cursor 里用 | [VS Code 集成](docs/guide/integrations/vscode-acp.md) |
| 想在 IntelliJ 里用 | [IntelliJ 集成](docs/guide/integrations/intellij-acp.md) |
| 运维，部署到公司内网 | [Docker 部署](deploy/README.md) |
| 二次开发 / 加工具 | [Agent 源码说明](src/README.md) |

---

## 核心能力

- **编程助手** — 读改文件、跑 Shell、搜索代码库、子代理并行探索
- **浏览器自动化** — 打开网页、点击填表、截图读页面；可驱动你自己的 Chrome（需登录站点）
- **可扩展** — Skills、Commands、Plugins、MCP、自定义 Subagent
- **多入口** — Electron 桌面、Web UI、ACP（IDE 侧边栏）、HTTP API / SDK
- **记忆与压缩** — Session memory、Auto memory、上下文自动压缩

---

## 5 分钟快速体验（桌面版）

**前置**：Node.js 20+、团队提供的 API 配置（见 `.ai-agent/settings.json`）

```bash
git clone <你的仓库地址>
cd ai_coding_agent_intro
npm install && cd client/web && npm install && cd ../..
cp .ai-agent/settings.example.json .ai-agent/settings.json   # 填写 API
npm run desktop:dev
```

弹出桌面窗口后，选择 **Browser Automation**，输入例如：

> 打开 https://example.com ，告诉我页面标题

需要登录的网站？见 [浏览器自动化指南](docs/guide/browser.md) 中的 extension 模式与 Pair。

---

## 配置速查

| 配置什么 | 放哪里 |
|----------|--------|
| 大模型 API（baseURL、apiKey、model） | `.ai-agent/settings.json` |
| 端口、工作区路径等运行时 | `.env`（可选，见 `.env.example`） |
| 浏览器模式（isolated / extension） | `.ai-agent/settings.json` 的 `browser` |

用户级配置：`~/.ai-agent/settings.json`。项目级：`<workspace>/.ai-agent/settings.json`，优先级更高。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run desktop:dev` | 启动桌面版（推荐新用户） |
| `npm start` | 仅启动 agent 后端（:4567） |
| `npm run dev:web` | Web UI 开发模式（需另开终端 `npm start`） |
| `npm run browser:pair` | 获取 Chrome 扩展配对令牌 |
| `npm run desktop:pack` | 打包桌面安装包 |
| `npm run desktop:pack:win` | 打包 Windows 安装包 |
| `npm run build:web` | 构建前端到 `client/web/dist` |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run format` | Prettier 格式化 |

---

## 浏览器自动化

让 agent 打开网页、点击填表、截图并读回页面内容。默认用它自己拉起的浏览器（零配置）；也可以让它驱动**你自己的 Chrome**，这样需要登录的站点无需任何登录脚本即可访问。

```bash
npm start                 # isolated 模式开箱即用
npm run browser:pair      # 想用自己的 Chrome 时，取配对令牌
```

完整说明见 [docs/guide/browser.md](docs/guide/browser.md)。

---

## 生产部署

使用 Docker 一键部署 Web 版，详见 [deploy/README.md](deploy/README.md)。

```bash
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d
# 访问 http://localhost:9999（账号/密码：WEB_USERNAME / WEB_PASSWORD）
```

---

## 项目结构

```
├── start.js              # 统一启动入口
├── src/                  # Agent 实现（tools / core / services）
├── client/web/           # React 前端
├── electron/             # Electron 桌面壳
├── chrome-extension/     # 浏览器扩展（extension 模式）
├── client-sdk/           # TypeScript 客户端 SDK
├── deploy/               # Docker 部署配置
└── .ai-agent/            # 项目级 skills / commands / config
```

---

## 文档索引

### 用户指南

| 主题 | 文档 |
|------|------|
| 零基础安装运行 | [docs/guide/getting-started.md](docs/guide/getting-started.md) |
| 浏览器自动化 | [docs/guide/browser.md](docs/guide/browser.md) |
| 本地 Web 开发 | [docs/guide/development.md](docs/guide/development.md) |
| VS Code / Cursor | [docs/guide/integrations/vscode-acp.md](docs/guide/integrations/vscode-acp.md) |
| IntelliJ IDEA | [docs/guide/integrations/intellij-acp.md](docs/guide/integrations/intellij-acp.md) |
| Docker 部署 | [deploy/README.md](deploy/README.md) |
| 客户端 SDK | [client-sdk/](client-sdk/) |

### 开发与架构

| 主题 | 文档 |
|------|------|
| 文档总览 | [docs/README.md](docs/README.md) |
| Agent 源码与扩展 | [src/README.md](src/README.md) |
| 开发文档索引 | [docs/dev/README.md](docs/dev/README.md) |
| 记忆系统 | [docs/dev/memory/agent-memory-guide.md](docs/dev/memory/agent-memory-guide.md) |
| 远程 SSH 执行 | [docs/dev/remote/ssh-architecture.md](docs/dev/remote/ssh-architecture.md) |
