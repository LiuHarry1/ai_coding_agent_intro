-- Analytics telemetry tables in the shared `knowbot` database.
-- Mirrors SQLAlchemy models in app/models.py (UsageRecord, Event).
-- Coexists with chat-service tables (conversations, knowledge_bases, …).
--
-- Usage (MySQL):
--   mysql -uroot -p knowbot < scripts/init_tables.sql
--
-- Full bootstrap (only if `knowbot` DB does not exist yet):
--   mysql -uroot -p < scripts/create_database.sql
--   mysql -uroot -p knowbot < scripts/init_tables.sql
--
-- The FastAPI app also auto-creates these via init_db() on startup; use this
-- script when you prefer explicit DDL (prod bootstrap, DBA review, CI).

CREATE TABLE IF NOT EXISTS usage_records (
    id                   INT             NOT NULL AUTO_INCREMENT,
    event_id             VARCHAR(128)    NULL COMMENT 'Producer idempotency key (e.g. session_id:turn_index)',
    ts                   DATETIME        NOT NULL COMMENT 'Event time (UTC, set by producer or server)',
    received_at          DATETIME        NOT NULL COMMENT 'Ingest time (UTC)',
    user_email           VARCHAR(320)    NULL,
    session_id           VARCHAR(64)     NULL,
    turn_index           INT             NULL,
    model                VARCHAR(128)    NULL,
    provider             VARCHAR(64)     NULL,
    source               VARCHAR(32)     NULL,
    input_tokens         INT             NOT NULL DEFAULT 0,
    output_tokens        INT             NOT NULL DEFAULT 0,
    cached_input_tokens  INT             NOT NULL DEFAULT 0,
    reasoning_tokens     INT             NOT NULL DEFAULT 0,
    total_tokens         INT             NOT NULL DEFAULT 0,
    latency_ms           INT             NULL,
    ttfb_ms              INT             NULL,
    tool_calls           INT             NOT NULL DEFAULT 0,
    cost_usd             DECIMAL(18, 8)  NOT NULL DEFAULT 0 COMMENT 'Computed USD cost; exact decimal for SUM',
    PRIMARY KEY (id),
    UNIQUE KEY uq_usage_event_id (event_id),
    KEY ix_usage_ts (ts),
    KEY ix_usage_user_ts (user_email, ts),
    KEY ix_usage_session (session_id),
    KEY ix_usage_model (model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per LLM call/step: tokens, latency, computed cost';

CREATE TABLE IF NOT EXISTS events (
    id           INT             NOT NULL AUTO_INCREMENT,
    event_id     VARCHAR(128)    NULL COMMENT 'Producer idempotency key',
    ts           DATETIME        NOT NULL COMMENT 'Event time (UTC)',
    received_at  DATETIME        NOT NULL COMMENT 'Ingest time (UTC)',
    type         VARCHAR(64)     NOT NULL COMMENT 'Event type (session.start, tool.call, error, ...)',
    user_email   VARCHAR(320)    NULL,
    session_id   VARCHAR(64)     NULL,
    payload      JSON            NOT NULL COMMENT 'Arbitrary event payload',
    PRIMARY KEY (id),
    UNIQUE KEY uq_event_event_id (event_id),
    KEY ix_event_ts (ts),
    KEY ix_event_type_ts (type, ts),
    KEY ix_event_user_ts (user_email, ts),
    KEY ix_event_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Generic append-only event log';
