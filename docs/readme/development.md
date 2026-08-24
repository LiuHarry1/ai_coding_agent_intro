# 本地开发

本文面向需要**改前端界面**或**调试 Agent 后端**的开发者。若你只想试用产品，请先看 [快速开始](getting-started.md) 里的桌面版路径。

---

## 安装依赖

```bash
npm install
cd client/web && npm install && cd ../..
```

---

## 配置

### 大模型与 MCP

用户级配置：`~/.ai-agent/settings.json`（`models`、MCP 等）。

项目级配置：`<workspace>/.ai-agent/settings.json`，优先级高于用户级。

可从示例复制：

```bash
cp .ai-agent/settings.example.json .ai-agent/settings.json
```

### 环境变量（可选）

```bash
cp .env.example .env
```

`.env` 用于端口、工作区路径、dump-prompts 等运行时选项；**大模型 API 主要在 `settings.json`**。

| 配置什么 | 放哪里 |
|----------|--------|
| 大模型 API（baseURL、apiKey、model） | `.ai-agent/settings.json` |
| 端口、工作区路径等 | `.env`（可选） |
| 浏览器模式 | `.ai-agent/settings.json` 的 `browser` 段 |

---

## Web UI 开发（双终端）

前后端分开跑，**用两个终端**：

### 终端 A — 启动后端

```bash
npm start              # 加载 src/，监听 http://localhost:4567
```

### 终端 B — 启动 Web UI（热更新）

```bash
npm run dev:web        # http://localhost:5173
```

浏览器打开 **http://localhost:5173**。前端 dev server 会把 `/chat`、`/workspace` 等 API 代理到后端的 4567，所以本地没有跨域问题（代理配置见 `client/web/vite.config.js`）。

---

## 调试 LLM prompt / tool 轨迹

开启 CC 风格 dump-prompts：

```bash
DUMP_PROMPTS=1 npm start
# 或
DUMP_PROMPTS=1 DUMP_PROMPTS_DIR=/tmp/dump-prompts-live npm start
```

默认写入 `~/.ai-agent/dump-prompts/{sessionId}.jsonl`；设置 `DUMP_PROMPTS_DIR` 可覆盖输出目录。

---

## 桌面版

```bash
npm run desktop:dev      # 构建前端 + 启动 Electron 窗口
npm run desktop:start    # dist 已存在时直接启动
npm run desktop:pack     # 打包当前平台安装包（macOS → dmg 等）
npm run desktop:pack:win # 打包 Windows 安装包
```

Electron 会自动启动 agent 子进程，窗口加载 `http://127.0.0.1:4567`。

---

## 常用开发命令

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 agent 后端 |
| `npm run dev:web` | 启动 Web UI 开发服务器（热更新） |
| `npm run build:web` | 构建前端到 `client/web/dist` |
| `npm run desktop:dev` | 启动桌面版 |
| `npm run typecheck` | TypeScript 类型检查（src + protocol + client-sdk） |
| `npm run format` | 按项目 Prettier 规则格式化代码 |
| `npm run acp -- --workspace /path/to/project` | 终端验证 ACP 模式 |

---

## 相关文档

- [Agent 源码与扩展](../../src/README.md)
- [浏览器自动化](browser.md)
- [VS Code / Cursor 集成](integrations/vscode-acp.md)
- [IntelliJ 集成](integrations/intellij-acp.md)
