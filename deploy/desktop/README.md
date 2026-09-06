# `deploy/desktop/` — Desktop 发布 seed

桌面版（Electron）安装包自带的工作区模板。首次打开一个还没有 seed 标记的目录时，会把这里的内容拷进该工作区（**不覆盖已有文件**）。

与 Docker SSO 的 [`../workspace-seed/`](../workspace-seed/) 职责相同、内容不同：Docker seed 面向全功能 coding；本目录默认是 **Browser-only** 产品形态。

## 目录

| 路径 | 说明 |
|------|------|
| `workspace-seed/.ai-agent/settings.json` | `agents.picker` / `agents.default` + browser 默认（无密钥） |
| `workspace-seed/.ai-agent/agents/browser.md` | Browser Automation primary |

密钥（`apiKey` 等）**不要**放进 seed；装机后写入用户 `~/.ai-agent/settings.json` 或项目 local settings。

## `agents.picker` / `agents.default`

| 字段 | 语义 |
|------|------|
| `picker.modes` | 页面上显示的权限模式 allowlist。省略 = `agent/ask/plan` 全显；`[]` = 不显示模式行 |
| `picker.primaries` | 页面上显示的 primary allowlist。省略 = 全部 `mode: primary`；`[]` = Specialist 区为空 |
| `default.mode` / `default.agentType` | 新 session 初始态 |

本 seed 默认：

```json
{
  "agents": {
    "picker": { "modes": [], "primaries": ["browser"] },
    "default": { "mode": "agent", "agentType": "browser" }
  }
}
```

页面上只出现 Browser Automation；后端仍是 `permissionMode=agent` + `agentType=browser`。

### 改成全功能 coding

在工作区（或改本 seed 后重新打包）的 `.ai-agent/settings.json`：

```json
{
  "agents": {
    "picker": {
      "modes": ["agent", "ask", "plan"],
      "primaries": ["browser"]
    },
    "default": {
      "mode": "agent",
      "agentType": null
    }
  }
}
```

去掉整个 `agents` 段则回到开发默认：三模式 + 磁盘上全部 primary。

可按需把更多 skills / agents 放进 `workspace-seed/.ai-agent/`。

## 打包

[`electron-builder.config.cjs`](../../electron-builder.config.cjs) 通过 `extraResources` 把 `workspace-seed` 打进安装目录的 `resources/workspace-seed`。

Packaged Electron 默认 `WORKSPACE=~/.ai-agent/workspace`（启动时 `mkdir`；可用 `AI_AGENT_DIR` 改 basename）。开发态不设 `WORKSPACE`，沿用仓库根。UI 选目录后由请求覆盖。

Electron 在 packaged / 开发态会设置 `WORKSPACE_SEED_DIR`；agent 首次发现该工作区（`loadWorkspaceContributions`）时落盘，与 SSO 共用同一套 seed 逻辑。

```bash
npm run desktop:pack        # 当前平台
npm run desktop:pack:win    # Windows
```

## 验收清单

1. 干净目录打开桌面版：出现 `.ai-agent/agents/browser.md`，ModePicker 只见 Browser Automation。
2. 新会话为 `agent` + `browser`。
3. 临时改 settings 为三模式 + `primaries: ["browser"]`：三模式 + 仅 Browser。
4. 去掉 `agents` 段：三模式 + 全部 primary。
5. API 强切不在 allowlist 的 mode/agentType → 400。
