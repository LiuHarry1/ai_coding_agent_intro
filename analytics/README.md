# Coding Agent Analytics

A standalone Python (FastAPI) backend that collects **usage, cost, and event
telemetry** from the coding agent. The agent POSTs lightweight, fire-and-forget
records; this service stores them and exposes aggregation endpoints for
dashboards and billing.

It is deliberately decoupled from the agent: no shared database, no code
dependency — just an HTTP contract. The agent can run with telemetry off and
nothing changes.

## Why a separate service

- **Isolation** — analytics load/outages never affect the agent.
- **Language fit** — Python for data work; reuse pandas/notebooks/BI later.
- **Multi-tenant aware** — every record carries `user_email` + `session_id`, so
  the SSO deployment's per-user model maps straight onto per-user reporting.

## Architecture

```
 coding agent (Node)                analytics (FastAPI)
 ───────────────────                ───────────────────
 logStepCompletion ─┐   POST /v1/usage   ┌─ ingest ─▶ usage_records
 tool/session hooks ┼──────────────────▶ ┤
                    │   POST /v1/events   └─ ingest ─▶ events
                                              │
 dashboard / BI ◀──── GET /v1/stats/* ───────┘ (aggregations)
```

## Data model

| Table | One row per | Key columns |
|-------|-------------|-------------|
| `usage_records` | LLM call / step | `user_email`, `session_id`, `model`, `input/output/cached/reasoning/total_tokens`, `latency_ms`, `tool_calls`, `cost_usd` |
| `events` | anything else | `type`, `user_email`, `session_id`, `payload` (JSON) |

`cost_usd` is computed at ingest from `app/pricing.py` (USD per 1M tokens, model
prefix-matched) and stored, so later price edits don't rewrite history.
`event_id` is unique → safe retries (duplicates are skipped, not errored).

The token fields mirror the agent's `AttachedTokenUsage`
(`examples/08-basic/services/compact/tokens.ts`): `inputTokens`,
`outputTokens`, `totalTokens`, `cachedInputTokens`, `reasoningTokens`.

## Endpoints

### Ingest (write, guarded by `X-API-Key` = `ANALYTICS_INGEST_API_KEY`)

| Method | Path | Body |
|--------|------|------|
| POST | `/v1/usage` | a `UsageIn` object **or** `{ "records": [UsageIn, ...] }` |
| POST | `/v1/events` | an `EventIn` object **or** `{ "events": [EventIn, ...] }` |

### Quota (agent enforcement, same ingest API key)

Daily token cap per user (**UTC calendar day**). The agent checks once per new
`POST /chat`, commits total tokens when the request finishes.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/quota/status?user_email=` | `{ used, limit, remaining, exceeded, reset_at }` |
| POST | `/v1/quota/commit` | `{ user_email, tokens, event_id }` — idempotent |

Set `ANALYTICS_DEFAULT_DAILY_TOKEN_LIMIT` (0 = unlimited). Agent env:
`QUOTA_ENABLED=true`, `ANALYTICS_URL`, `ANALYTICS_INGEST_API_KEY`. `role=super`
bypasses quota.

### Reporting (read, guarded by `ANALYTICS_QUERY_API_KEY`)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/stats/summary` | totals: calls, sessions, users, **questions**, tokens, cost |
| GET | `/v1/stats/usage?group_by=day\|model\|user\|provider` | grouped time series / breakdown |
| GET | `/v1/stats/users` | per-user leaderboard by cost |
| GET | `/v1/stats/questions/users` | per-user count of chat messages (questions asked) |
| GET | `/v1/stats/sessions?user=` | per-session rollups |
| GET | `/healthz` | liveness |

All reporting endpoints accept `start`, `end` (ISO datetime) and `user` filters.

## Run locally

```bash
conda activate llm_ft
cd analytics
pip install -r requirements.txt
cp .env.example .env          # optional; defaults work out of the box
uvicorn app.main:app --reload --port 8200
# open http://localhost:8200/docs
```

### Quick smoke test

```bash
# report one call
curl -X POST localhost:8200/v1/usage -H 'Content-Type: application/json' -d '{
  "user_email": "alice@co.com", "session_id": "s1", "model": "gpt-4o",
  "input_tokens": 1200, "output_tokens": 300, "tool_calls": 2
}'

# see the rollup
curl localhost:8200/v1/stats/summary
curl 'localhost:8200/v1/stats/users'
```

## Deploy

```bash
# SQLite (single container, simplest)
docker build -t agent-analytics .
docker run -p 8200:8200 \
  -e ANALYTICS_DATABASE_URL=sqlite:///./analytics.db \
  -e ANALYTICS_INGEST_API_KEY=secret agent-analytics

# MySQL (compose: app + mysql:8.0)
ANALYTICS_INGEST_API_KEY=secret ANALYTICS_QUERY_API_KEY=secret \
  docker compose up -d

# MySQL (external server) — reuse chat-service MYSQL_* env (database: knowbot)
docker run -p 8200:8200 \
  -e MYSQL_HOST=mysql.prod -e MYSQL_PORT=3306 \
  -e MYSQL_USER=root -e MYSQL_PASSWORD=*** -e MYSQL_DATABASE=knowbot \
  -e ANALYTICS_INGEST_API_KEY=secret agent-analytics
```

### Database

Analytics uses the **same MySQL database as knowbot/chat-service** (`knowbot` by
default). It only adds its own tables (`usage_records`, `events`); it does not
create a separate database.

The stack is **fully async** (SQLAlchemy 2.0 asyncio) for high concurrency.
The backend is chosen by this order (see `app/config.py`):

1. `ANALYTICS_DATABASE_URL` — explicit SQLAlchemy URL (wins if set). A sync URL
   (e.g. `sqlite:///` or `mysql+pymysql://`) is auto-upgraded to its async
   driver (`aiosqlite` / `aiomysql`).
2. `MYSQL_*` — when `MYSQL_HOST` is set, connects to `MYSQL_DATABASE` (default
   `knowbot`) via `mysql+aiomysql://...?charset=utf8mb4` with a pre-pinged,
   recycled pool. Same env vars as chat-service — point both services at one MySQL.
3. SQLite fallback (`sqlite+aiosqlite:///./analytics.db`) for local dev / tests.

**SQL scripts** (MySQL, mirrors `app/models.py`) live in `analytics/scripts/`:

| Script | Purpose |
|--------|---------|
| `create_database.sql` | Create shared `knowbot` database (skip if chat-service already did) |
| `init_tables.sql` | Add `usage_records`, `events`, `user_daily_usage`, `quota_commit_log` into `knowbot` |
| `migrate_cost_usd_to_decimal.sql` | Upgrade existing `cost_usd` column from FLOAT → DECIMAL(18,8) |

Bootstrap example (tables only — typical when chat-service is already deployed):

```bash
mysql -uroot -p knowbot < scripts/init_tables.sql
```

If the `knowbot` database does not exist yet:

```bash
mysql -uroot -p < scripts/create_database.sql
mysql -uroot -p knowbot < scripts/init_tables.sql
```

The app still auto-creates tables on startup via `init_db()`; use the scripts when
you want explicit DDL (prod bootstrap, DBA review, or no app startup yet).

For schema changes after launch, prefer Alembic over ad-hoc ALTER scripts.

## Wiring the agent

`clients/agentTelemetry.ts` is a ready-to-drop reference reporter (batched,
fire-and-forget, never throws). Call `reportUsage(...)` from
`logStepCompletion` in `examples/08-basic/core/agent.ts` — it already has the
model, token usage, and timings — and pass the session's `ownerEmail` / `id`.
Set `ANALYTICS_URL` + `ANALYTICS_INGEST_API_KEY` in the agent's env to enable;
leave unset to disable.

## Configuration

All env vars are prefixed `ANALYTICS_` — see `.env.example`.
