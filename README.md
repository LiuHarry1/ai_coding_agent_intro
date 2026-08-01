# Coding Agent

一个可本地运行的 AI 编程助手，支持 Web UI 和 Electron 桌面版。Agent 后端提供聊天、工具调用、Workspace 文件操作等能力；前端为 React + Vite 构建的聊天界面。

## 快速开始

### 1. 安装依赖

```bash
npm install
cd client/web && npm install && cd ../..
```

### 2. 配置

复制并编辑环境变量（API Key 等）：

```bash
cp .env.example .env   # 如有示例文件
```

用户级配置位于 `~/.ai-agent/settings.json`（`models`、MCP 等）。项目级配置可放在 `<workspace>/.ai-agent/settings.json`，优先级高于用户级配置。

本地开发前后端分开跑,**用两个终端**:

### 3. 启动后端(终端 A)

```bash
npm start              # 加载 src/，监听 http://localhost:4567
```

### 4. 启动 Web UI(终端 B,开发模式,支持热更新)

```bash
npm run dev:web        # http://localhost:5173
```

浏览器打开 **http://localhost:5173**。前端 dev server 会把 `/chat`、`/workspace` 等 API 代理到后端的 4567,所以本地没有跨域问题(代理配置见 `client/web/vite.config.js`)。

## 桌面版

```bash
npm run desktop:dev      # 构建前端 + 启动 Electron 窗口
npm run desktop:start    # dist 已存在时直接启动
npm run desktop:pack     # 打包当前平台安装包（macOS → dmg 等）
npm run desktop:pack:win # 打包 Windows 安装包
```

Electron 会自动启动 agent 子进程，窗口加载 `http://127.0.0.1:4567`。

## VS Code / Cursor（ACP）

安装扩展 [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client)，在本仓库执行 `npm install` 后，在 User Settings (JSON) 中添加：

```json
{
  "acp.agents": {
    "Baize": {
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/ai_coding_agent_intro/start.js",
        "--acp"
      ],
      "env": {}
    }
  }
}
```

Windows 路径用双反斜杠，例如 `C:\\Users\\you\\ai_coding_agent_intro\\start.js`。

> **`args` 必须先写 `tsx`**，再写 `start.js` 绝对路径。省略 `tsx` 会导致 agent 启动失败，侧边栏显示 **Failed to load sessions**。

在 Activity Bar 打开 **ACP** 面板，点击 **Baize** 连接即可。可选：在 `args` 末尾加 `"--workspace", "/path/to/project"` 固定默认工作区；API Key 从仓库 `.env` 读取，失败时在 `env` 中补充。

终端验证：`npm run acp -- --workspace /path/to/project`（看到 `[acp] workspace=...` 后等待输入即正常）。

## IntelliJ IDEA（ACP）

通过 **ACP**（Agent Client Protocol）将 JetBrains IDE 连接到本 coding agent，走 stdio 通信，无需在 `:4567` 上启动 HTTP 服务。IDE 会以子进程方式拉起 agent，在 stdin/stdout 上进行 JSON-RPC 对话。

### 前置条件

- IntelliJ IDEA **2025.3+**（或其他已启用 AI Assistant + ACP 的 JetBrains IDE）
- 已启用 AI Assistant
- 本仓库已执行 `npm install`
- 终端冒烟测试：

```bash
cd /path/to/ai_coding_agent_intro
npm run acp -- --workspace /path/to/your/project
```

应看到 `[start] Loading agent from src/` 和 `[acp] workspace=...`，随后进程等待输入（正常）。

> **注意：** `--workspace` 用于设置默认项目根目录。不要把 workspace 路径作为裸位置参数传入，应使用 `--workspace /abs/path`。

### 配置 `acp.json`

注册表中的 agent（Settings → AI Assistant → **Agents** → Install）**不是**自定义 agent 的入口。请通过 **`~/.jetbrains/acp.json`** 添加：

1. 打开 **AI Chat** → 右上角 **⚙** → **Add Custom Agent**（会创建/打开 `~/.jetbrains/acp.json`），或手动编辑该文件：

```bash
mkdir -p ~/.jetbrains
```

2. 粘贴以下内容（按实际路径调整）：

```json
{
  "default_mcp_settings": {
    "use_idea_mcp": true,
    "use_custom_mcp": true
  },
  "agent_servers": {
    "Baize": {
      "command": "/opt/homebrew/opt/node@22/bin/npx",
      "args": [
        "tsx",
        "/Users/you/ai_coding_agent_intro/start.js",
        "--acp",
        "--workspace",
        "/Users/you/IdeaProjects/my-app"
      ],
      "env": {}
    }
  }
}
```

| 字段 | 含义 |
|------|------|
| `command` | `npx` 或 `node` 的**绝对路径**（`which npx`） |
| `args` | `tsx`、指向 `start.js` 的路径、`--acp`、可选的 `--workspace` |
| `env` | 可选；若子进程未读取到 `.env`，可在此传入 API Key |

API Key 通常从仓库根目录的 `.env` 加载。若从 IDE 启动时鉴权失败，可在 `env` 中补充，例如 `"OPENAI_API_KEY": "sk-..."`。

3. 在 **Settings → AI Assistant → Agents** 中启用 **Pass IntelliJ MCP server** 和 **Pass custom MCP servers**（与上方 `default_mcp_settings` 对应）。

4. 重启 IDE。

### 在 AI Chat 中使用

1. 在 IntelliJ 中打开你的项目。
2. 打开 **AI Chat**。
3. 在 agent 下拉框中选择 **Baize**（不要选 Junie / Claude Agent）。
4. 发送消息，例如 `/help` 或 `List files in src`。

IntelliJ 还会在 ACP `session/new` 中传入项目目录（`cwd`），因此若你总是先打开目标项目，可在 `args` 中省略 `--workspace`；若需要固定默认目录，则保留 `--workspace`。

### 故障排查

| 现象 | 处理 |
|------|------|
| 下拉框中没有 agent | 检查 `~/.jetbrains/acp.json` 的 JSON 是否合法；重启 IDE |
| `Failed to load example "/Users/..."` | 使用 `--workspace /path`，不要在 flag 后写裸路径 |
| Agent 卡住 / 无回复 | 在终端运行相同的 `npx tsx ... start.js --acp` 命令排查 |
| `command` not found | 使用 `npx` 的绝对路径；IDE 不会继承 shell 的 `PATH` / nvm |
| IDE 出现 JSON 解析错误 | stdout 只能输出 ACP 协议；启动日志在 `--acp` 模式下走 stderr |

更多说明见 [JetBrains ACP 文档](https://www.jetbrains.com/help/ai-assistant/acp.html)。

## 生产部署

使用 Docker 一键部署 Web 版，详见 [`deploy/README.md`](deploy/README.md)。

```bash
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d
# 访问 http://localhost:9999（账号/密码：WEB_USERNAME / WEB_PASSWORD）
```

## 项目结构

```
├── start.js              # 统一启动入口
├── src/                  # Agent 实现（tools / core / services）
├── client/web/          # React 前端
├── electron/             # Electron 桌面壳
├── client-sdk/           # TypeScript 客户端 SDK
├── deploy/               # Docker 部署配置
└── .ai-agent/            # 项目级 skills / commands / config
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 agent 后端 |
| `npm run dev:web` | 启动 Web UI 开发服务器（热更新） |
| `npm run build:web` | 构建前端到 `client/web/dist` |
| `npm run desktop:dev` | 启动桌面版 |
| `npm run desktop:pack` | 打包当前平台桌面安装包 |
| `npm run typecheck` | TypeScript 类型检查（src + protocol + client-sdk） |
| `npm run format` | 按项目 Prettier 规则格式化代码 |

## 更多文档

- Agent 能力详解：[`src/README.md`](src/README.md)
- Docker 部署：[`deploy/README.md`](deploy/README.md)
- 客户端 SDK：[`client-sdk/`](client-sdk/)
- VS Code / Cursor ACP 集成：见上文 [VS Code / Cursor（ACP）](#vs-code--cursoracp)
- IntelliJ ACP 集成：见上文 [IntelliJ IDEA（ACP）](#intellij-ideaacp)
