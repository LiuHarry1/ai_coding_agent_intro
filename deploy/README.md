# `deploy/` — Docker 部署

三个镜像、两种部署模式。前端(web)和后端(agent)**完全分离**,跑在不同的源上:浏览器从 web 源加载页面,直接跨域调用 agent API。

```
                    ${FRONTEND_ORIGIN}
   browser ─┬─ 加载 SPA ──────────▶ web   (nginx 静态站)
            └─ API 调用 ──────────▶ agent (headless API)
                ${AGENT_PUBLIC_URL}
```

| 模式 | Compose 文件 | 网关 | 工作区 |
|------|--------------|------|--------|
| **admin** | `docker-compose.admin.yml` | web 源一个共享密码(Basic Auth);agent 源不鉴权,靠内网保护 | 自由切换 |
| **sso** | `docker-compose.sso.yml` | 外部 auth-service 签发 JWT,agent 逐请求校验 | 按用户锁定 |

---

## 一、构建镜像(三步)

```bash
# 1. base 镜像(含 agent 代码+依赖,慢,代码变了才重建)
docker build -f deploy/Dockerfile.agent-base -t ai-agent-base:latest .

# 2. tenant 镜像(FROM base + 你的 .ai-agent/ settings,秒级)
docker build -f deploy/Dockerfile.agent-tenant --build-arg BASE_TAG=latest -t ai-agent-tenant:latest .

# 3. web 镜像(vite 构建 → nginx 静态站)
docker build -f deploy/Dockerfile.web -t ai-agent-web:latest .
```

> 密钥(`OPENAI_API_KEY` 等)**不要**打进镜像,放在 `deploy/.env`,compose 会注入容器。

Agent base 镜像通过 `requirements.txt` 安装 **`mcp-server-fetch`**（venv: `/opt/venv`）。SSO seed 里 `mcp_server` 使用 `/opt/venv/bin/python -m mcp_server_fetch`。已有用户目录需手动改 settings 或删目录让 seed 重建。

---

## 二、admin 模式(共享密码)

`deploy/.env`:

```bash
WEB_USERNAME=admin
WEB_PASSWORD=super-secret              # UI 登录密码
WEB_PORT=9999                          # web 源端口
AGENT_PORT=4567                        # agent 源端口
FRONTEND_ORIGIN=http://localhost:9999  # web 源(= agent 的 CORS 白名单)
AGENT_PUBLIC_URL=http://localhost:4567 # 浏览器访问 agent 的地址
OPENAI_API_KEY=sk-...                  # 按需填 provider 密钥
```

```bash
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d
# 打开 http://localhost:9999,输入 WEB_USERNAME / WEB_PASSWORD
```

> **安全**:密码只挡 web 源的页面加载,**agent 源不鉴权**——必须把 `AGENT_PORT` 放在内网/VPN/防火墙后,不要暴露公网。生产环境给两个源都套 HTTPS。

---

## 三、sso 模式(外部 auth-service + 按用户工作区)

前提:你已经单独部署了一个签发 HS256 JWT 的 auth-service。

`deploy/.env`:

```bash
JWT_SECRET=<与 auth-service 签名密钥完全一致>   # 信任锚,必填
FRONTEND_ORIGIN=https://app.example.com         # web 源(= agent CORS 白名单)
AGENT_PUBLIC_URL=https://agent.example.com      # 浏览器访问 agent 的地址
AUTH_PUBLIC_URL=https://auth.example.com        # 浏览器访问 auth-service 的地址
WEB_PORT=8090
AGENT_PORT=4567
OPENAI_API_KEY=sk-...
# 可选:每日 token 配额(需 analytics + MySQL)
QUOTA_ENABLED=false
MYSQL_HOST=host.docker.internal
MYSQL_DATABASE=knowbot
```

```bash
docker compose -f deploy/docker-compose.sso.yml --env-file deploy/.env up -d
# 打开 ${FRONTEND_ORIGIN}
```

还需在**外部 auth-service** 把 `FRONTEND_ORIGIN` 加入 `SSO_ALLOWED_RETURN_ORIGINS` 和 `CORS_ALLOWED_ORIGINS`,否则登录回跳会被拒(400)。

每个用户被锁定到 `/workspace/users/<email>`,首次登录会从 `deploy/workspace-seed/`(打进 tenant 镜像)复制一份初始内容。

### 工作区沙箱 (`SANDBOX_MODE`)

SSO 模式默认 `SANDBOX_MODE=strict`：`read_file` / `grep` / `glob` / `write_file` / `edit_file` 以及 HTTP `/workspace/*` 只能访问当前用户的 pinned 目录。系统提示词也会声明该边界。

| 值 | 场景 |
|----|------|
| `strict`（或未设但 `AUTH_ENABLED=true`） | SSO：读/写均限制在用户 workspace |
| `off` / 不设（且无 AUTH） | 本地 / admin：读可越界，写仍限 workspace |

说明：这是**应用层**隔离，不阻止 bash 用绝对路径读其它目录。本地开发不要设 `SANDBOX_MODE`（或显式 `off`）。

可选：`SANDBOX_EXTRA_READ_ROOTS=/opt/shared-templates`（逗号分隔）在 strict 下额外允许只读根。

---

## 工作区挂载

两个 compose 都把宿主 `./workspaces` 挂到容器 `/workspace`。把项目放在 `./workspaces/<name>`,调用时传 `"workspace": "/workspace/<name>"`。改挂载路径就编辑 `agent.volumes`:

```yaml
volumes:
  - ./workspaces:/workspace:rw   # ← 换成你的路径
  - ./sessions:/app/.sessions:rw
```

---

## 运维

```bash
# 改了配置/重建镜像后,重新 up 即可(只重建有变化的容器)
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d

docker compose -f deploy/docker-compose.admin.yml logs -f agent   # 看日志
docker compose -f deploy/docker-compose.admin.yml exec agent bash # 进容器
docker compose -f deploy/docker-compose.admin.yml down            # 停止
```

(sso 模式把文件名换成 `docker-compose.sso.yml`。)

## 排错

| 现象 | 原因 / 解决 |
|------|-------------|
| `Unable to find image 'ai-agent-*'` | 镜像没构建——先跑上面的"构建镜像"三步。 |
| 浏览器控制台报 CORS 错误 | `FRONTEND_ORIGIN` 没设成浏览器实际打开的源,或与 agent 的 `ALLOWED_ORIGINS` 不一致。改对后重新 `up -d`。 |
| `/chat` 连接失败 | `AGENT_PUBLIC_URL` 访问不到 agent,或 agent 没起来:`docker compose logs agent`。 |
| provider 报 401 / 缺 key | `.env` 里没填对应的 `OPENAI_API_KEY` 等。 |
| 页面空白 | web 镜像构建失败,用 `docker build --no-cache -f deploy/Dockerfile.web -t ai-agent-web:latest .` 重建。 |
| sso 登录回跳被拒(400) | 把 `FRONTEND_ORIGIN` 加进 auth-service 的 `SSO_ALLOWED_RETURN_ORIGINS` 和 `CORS_ALLOWED_ORIGINS`。 |
| sso 登录跳到 localhost | 没设 `AUTH_PUBLIC_URL`,改成真实 auth-service 源。 |
| 日志里中文显示为 `<E4><BD>…` 乱码 | 日志本身是合法 UTF-8,是查看端 locale 不对。SSH/终端里先 `export LANG=C.UTF-8 LESSCHARSET=utf-8` 再看;`docker logs` 输出别经过非 UTF-8 的 pager。容器内已默认 `LANG=C.UTF-8`。 |
