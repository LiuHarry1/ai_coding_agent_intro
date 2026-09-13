# Analytics and quota

Last verified: 2026-09-13

## Overview

Analytics is a separate FastAPI service for usage records, generic events, cost calculation, reporting, and per-user daily token counters. The agent can run without it. Telemetry delivery is asynchronous and non-fatal; quota enforcement is an optional SSO admission check.

## How it works

Usage records capture identity, session, model/provider, token categories, latency, tool calls, and an ingest-time `cost_usd`. Pricing is matched by model prefix and stored with the record, so later price changes do not rewrite history. Generic events retain a JSON payload. Unique event IDs make retries idempotent.

Storage selection is explicit `ANALYTICS_DATABASE_URL`, then `MYSQL_*`, then local SQLite. The async service creates its tables at startup. In SSO, the agent checks quota once before a new chat request and commits accumulated turn tokens afterward. Scheduled turns use the same status and commit APIs. `role=super` bypasses enforcement.

## Configuration and API

Agent variables:

```text
ANALYTICS_URL=http://analytics:8200
ANALYTICS_INGEST_API_KEY=<shared-secret>
QUOTA_ENABLED=true
```

Analytics variables include `ANALYTICS_INGEST_API_KEY`, `ANALYTICS_QUERY_API_KEY`, `ANALYTICS_DATABASE_URL`, `MYSQL_*`, `ANALYTICS_PRICING_JSON`, `ANALYTICS_MAX_BATCH_SIZE`, `ANALYTICS_CORS_ALLOW_ORIGINS`, and `ANALYTICS_DEFAULT_DAILY_TOKEN_LIMIT`. A limit of `0` is unlimited. Days reset at midnight UTC.

Write endpoints, guarded by the ingest key when configured:

- `POST /v1/usage`
- `POST /v1/events`
- `GET /v1/quota/status?user_email=<email>`
- `POST /v1/quota/commit` with `user_email`, `tokens`, and unique `event_id`

Reporting endpoints, guarded by the query key when configured, include `/v1/stats/summary`, `/v1/stats/usage`, `/v1/stats/users`, `/v1/stats/questions/users`, and `/v1/stats/sessions`. `/healthz` is the liveness endpoint; FastAPI schema documentation is at `/docs`.

## Failure modes and security notes

- Empty API-key settings leave the corresponding ingest or query surface open; production must set both secrets and restrict network access.
- The reference telemetry client batches records and swallows transport errors. Failed batches are not re-enqueued, so reporting is best-effort.
- Quota status failures are logged and fail open. Commit failures are also logged, so temporary analytics outages can undercount usage.
- Admission checks and commits are separate: a turn that begins below the limit may finish above it.
- Quota commits are idempotent by `event_id`; callers must generate stable unique IDs appropriate to their retry model.
- CORS defaults to `*`; narrow it for browser-accessible production deployments.

## Source map

- `analytics/README.md` — service contract, schema, and deployment.
- `analytics/app/main.py` — FastAPI lifecycle and routers.
- `analytics/app/config.py` — environment and database resolution.
- `analytics/app/quota_service.py` — UTC counters and idempotent commits.
- `analytics/app/pricing.py` — model pricing.
- `analytics/clients/agentTelemetry.ts` — reference best-effort reporter.
- `src/server/telemetry.ts` — agent telemetry integration.
- `src/server/quota.ts` — quota client and enforcement predicates.
- `src/services/cron/fire.ts` — scheduled-turn quota behavior.
