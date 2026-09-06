# 迁移旧 `.sessions` → `~/.ai-agent/projects/`

旧布局（进程 cwd）：

```text
.sessions/
  <id>.jsonl
  <id>/          # tool-results、tasks、uploads…
  scheduled_tasks.json   # 可选
```

新布局：

```text
{agentHome}/.ai-agent/
  projects/<projectKey>/
    <id>.jsonl
    <id>/
  session-index.json

# cron（进程级，与用户目录无关）
{AI_AGENT_DATA_DIR 或 cwd/.ai-agent}/scheduled_tasks.json
```

---

## SSO Docker（`docker-compose.sso.yml`）

宿主路径约定（相对 `deploy/`）：

| 旧 | 新 |
|----|----|
| `./sessions/*.jsonl` + `./sessions/<id>/` | `./workspaces/users/<email-slug>/.ai-agent/projects/<projectKey>/` |
| `./sessions/scheduled_tasks.json` | `./agent-data/scheduled_tasks.json` |

`email-slug`（与代码 `slugifyEmail` 一致）：

1. trim + lower-case  
2. 非 `[a-z0-9._-]` → `_`  
3. 去掉首尾 `_`；空则用 `user`

例：`Alice.Wang@Corp.com` → `alice.wang_corp.com`

`projectKey`：把绝对路径里非字母数字字符换成 `-`（与 `sanitizePath` 一致）。  
SSO 不确定项目路径时，可先统一用一个 bucket，例如 `migrated`；用户之后绑定 workspace 会 relocate。

### 步骤

1. **停 agent**，备份：

   ```bash
   cp -a sessions sessions.bak
   ```

2. **按 jsonl 第一行 `ownerEmail` 分拣**，对每个 `<id>.jsonl`：

   ```bash
   # 读 owner（无则归到 _unowned，或按运维约定处理）
   head -1 sessions/<id>.jsonl
   ```

3. **搬文件**（示例 `projectKey=migrated`）：

   ```bash
   SLUG=<email-slug>
   KEY=migrated
   DEST=workspaces/users/$SLUG/.ai-agent/projects/$KEY
   mkdir -p "$DEST"
   mv sessions/<id>.jsonl "$DEST/"
   # 若有同名目录：
   [ -d sessions/<id> ] && mv sessions/<id> "$DEST/"
   ```

4. **写/合并** `workspaces/users/$SLUG/.ai-agent/session-index.json`：

   ```json
   {
     "version": 1,
     "sessions": {
       "<id>": {
         "projectKey": "migrated",
         "createdAt": 1234567890,
         "ownerEmail": "user@example.com"
       }
     }
   }
   ```

   `createdAt` / `ownerEmail` 取自 jsonl 第一行 `session_created`。

5. **cron**（若有）：

   ```bash
   mkdir -p agent-data
   mv sessions/scheduled_tasks.json agent-data/
   ```

6. 确认 compose 已挂：

   - `./workspaces:/workspace`
   - `./agent-data:/app/.ai-agent`
   - 且设置了 `AI_AGENT_DATA_DIR=/app/.ai-agent`  
   **不要**再挂 `./sessions:/app/.sessions`。

7. 启动后：用户 `GET /sessions`、super 看全部，抽查几条 transcript。

---

## 本地 / admin（无 AUTH）

- `agentHome` = `$HOME`（admin 容器若设了 `HOME=/workspace`，则是 `/workspace`）
- 源：旧 cwd 下 `.sessions/`（或以前的 `deploy/sessions`）
- 目标：`$HOME/.ai-agent/projects/<sanitize(defaultWorkspace)>/`
- cron → `$AI_AGENT_DATA_DIR/scheduled_tasks.json` 或 `cwd/.ai-agent/scheduled_tasks.json`

步骤同 SSO，只是不用按 email 拆用户目录。

---

## 给 Agent 的一句话指令

> 按 `deploy/MIGRATE-SESSIONS.md`，在服务器 `deploy/` 目录把旧 `sessions/` 迁到各用户 `workspaces/users/<slug>/.ai-agent/projects/`，写好 `session-index.json`，cron 放到 `agent-data/`，迁前备份。
