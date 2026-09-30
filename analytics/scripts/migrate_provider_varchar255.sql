-- Widen usage_records.provider from VARCHAR(64) to VARCHAR(255).
--
-- The agent reports the provider description (e.g.
-- "openai-compatible model=... structuredOutputs=true vision=true"), which can
-- exceed 64 chars and fail ingest with MySQL 1406 "Data too long".
-- Fresh installs using init_tables.sql already have the wider column.
--
-- Usage (MySQL):
--   mysql -uroot -p knowbot < scripts/migrate_provider_varchar255.sql

ALTER TABLE usage_records
    MODIFY COLUMN provider VARCHAR(255) NULL;
