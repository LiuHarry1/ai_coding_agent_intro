# IntelliJ IDEA（ACP）

通过 **ACP**（Agent Client Protocol）将 JetBrains IDE 连接到白泽（Baize）coding agent，走 stdio 通信，无需在 `:4567` 上启动 HTTP 服务。IDE 会以子进程方式拉起 agent，在 stdin/stdout 上进行 JSON-RPC 对话。

---

## 前置条件

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

---

## 配置 `acp.json`

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

API Key 通常从仓库根目录的 `.env` 或 `settings.json` 加载。若从 IDE 启动时鉴权失败，可在 `env` 中补充，例如 `"OPENAI_API_KEY": "sk-..."`。

3. 在 **Settings → AI Assistant → Agents** 中启用 **Pass IntelliJ MCP server** 和 **Pass custom MCP servers**（与上方 `default_mcp_settings` 对应）。

4. 重启 IDE。

---

## 在 AI Chat 中使用

1. 在 IntelliJ 中打开你的项目。
2. 打开 **AI Chat**。
3. 在 agent 下拉框中选择 **Baize**（不要选 Junie / Claude Agent）。
4. 发送消息，例如 `/help` 或 `List files in src`。

IntelliJ 还会在 ACP `session/new` 中传入项目目录（`cwd`），因此若你总是先打开目标项目，可在 `args` 中省略 `--workspace`；若需要固定默认目录，则保留 `--workspace`。

---

## 故障排查

| 现象 | 处理 |
|------|------|
| 下拉框中没有 agent | 检查 `~/.jetbrains/acp.json` 的 JSON 是否合法；重启 IDE |
| `Failed to load example "/Users/..."` | 使用 `--workspace /path`，不要在 flag 后写裸路径 |
| Agent 卡住 / 无回复 | 在终端运行相同的 `npx tsx ... start.js --acp` 命令排查 |
| `command` not found | 使用 `npx` 的绝对路径；IDE 不会继承 shell 的 `PATH` / nvm |
| IDE 出现 JSON 解析错误 | stdout 只能输出 ACP 协议；启动日志在 `--acp` 模式下走 stderr |

更多说明见 [JetBrains ACP 文档](https://www.jetbrains.com/help/ai-assistant/acp.html)。

---

## 相关文档

- [VS Code / Cursor 集成](vscode-acp.md)
- [本地开发](../development.md)
- [文档索引](../../../README.md#文档索引)
