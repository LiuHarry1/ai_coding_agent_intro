# VS Code / Cursor（ACP）

通过 **ACP**（Agent Client Protocol）在 VS Code 或 Cursor 侧边栏中使用白泽（Baize）。

---

## 前置条件

- 本仓库已执行 `npm install`
- 已配置 `.ai-agent/settings.json`（大模型 API）

---

## 安装 ACP Client 扩展

安装 [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client)。

---

## 配置

在 User Settings (JSON) 中添加：

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

---

## 使用

1. 在 Activity Bar 打开 **ACP** 面板
2. 点击 **Baize** 连接

可选：在 `args` 末尾加 `"--workspace", "/path/to/project"` 固定默认工作区。

API Key 通常从仓库 `.env` 或 `settings.json` 读取；若从 IDE 启动时鉴权失败，在 `env` 中补充。

---

## 终端验证

```bash
npm run acp -- --workspace /path/to/project
```

看到 `[acp] workspace=...` 后等待输入即正常。

---

## 相关文档

- [本地开发](../development.md)
- [README 文档索引](../../../README.md#文档索引)
