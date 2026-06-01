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

用户级配置位于 `~/.ai-agent/config.json`（provider、model、skills 等）。项目级配置可放在 `.ai-agent/` 目录。

### 3. 启动后端

```bash
npm start              # 默认加载 08-basic，监听 http://localhost:4567
```

### 4. 启动 Web UI（开发模式，支持热更新）

```bash
cd client/web
npm run dev            # http://localhost:5173，API 代理到 4567
```

## 桌面版

```bash
npm run desktop:dev    # 构建前端 + 启动 Electron 窗口
npm run desktop:start  # dist 已存在时直接启动
npm run desktop:pack:win   # 打包 Windows 安装包
```

Electron 会自动启动 agent 子进程，窗口加载 `http://127.0.0.1:4567`。

## 生产部署

使用 Docker 一键部署 Web 版，详见 [`deploy/README.md`](deploy/README.md)。

```bash
docker compose -f deploy/docker-compose.yml up -d
# 访问 http://localhost:8080
```

## 项目结构

```
├── start.js              # 统一启动入口
├── examples/             # 各版本 agent 实现（默认 08-basic）
├── client/web/          # React 前端
├── electron/             # Electron 桌面壳
├── shared/               # 共享服务端工具
├── client-sdk/           # TypeScript 客户端 SDK
├── deploy/               # Docker 部署配置
└── .ai-agent/            # 项目级 skills / commands / config
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 agent 后端 |
| `npm run server:stop` | 释放 4567 端口 |
| `npm run build:web` | 构建前端到 `client/web/dist` |
| `npm run desktop:dev` | 启动桌面版 |
| `npm run typecheck` | TypeScript 类型检查 |

## 更多文档

- Agent 能力详解：[`examples/08-basic/README.md`](examples/08-basic/README.md)
- Docker 部署：[`deploy/README.md`](deploy/README.md)
- 客户端 SDK：[`client-sdk/`](client-sdk/)
