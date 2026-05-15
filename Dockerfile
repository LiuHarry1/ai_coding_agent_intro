# syntax=docker/dockerfile:1
# Multi-stage: Vite UI → Node agent server (default example: 07-basic).

# --- Stage 1: React/Vite frontend (served from client2/web/dist by 07-basic) ---
FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY client2/web/package.json client2/web/package-lock.json ./
RUN npm ci
COPY client2/web/ ./
RUN npm run build

# --- Stage 2: Agent + HTTP server ---
FROM node:22-bookworm-slim AS app
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    python3-venv \
    python3-pip \
    python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

# Python 3.11 + venv (agent bash 工具可调用 python / pip)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"
COPY requirements.txt ./
RUN python3 -m venv "${VIRTUAL_ENV}" \
  && pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -r requirements.txt

COPY package.json package-lock.json ./
# Runtime needs tsx to load TypeScript examples; keep production deps lean.
RUN npm ci --omit=dev \
  && npm install tsx@^4.21.0 --no-save \
  && npm cache clean --force

COPY examples/ ./examples/
COPY shared/ ./shared/
COPY start.js ./
COPY client/web ./client/web
COPY --from=ui /ui/dist ./client2/web/dist

# 07-basic：ConfigManager 读取 ~/.ai-agent/config.json（容器内 root 即 /root/.ai-agent）
COPY config.example.json /root/.ai-agent/config.json

ENV NODE_ENV=production
ENV PORT=4567
EXPOSE 4567

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4567)+'/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Override example: docker run ... <image> 05-basic
CMD ["./node_modules/.bin/tsx", "start.js", "07-basic"]
