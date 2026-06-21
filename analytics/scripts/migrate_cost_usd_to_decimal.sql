-- Migrate usage_records.cost_usd to DECIMAL(18,8) for exact monetary storage.
--
-- Run this on databases created before cost_usd was switched from FLOAT to
-- DECIMAL in app/models.py. Fresh installs using init_tables.sql already have
-- the correct type — skip this migration.
--
-- Usage (MySQL):
--   mysql -uroot -p knowbot < scripts/migrate_cost_usd_to_decimal.sql

ALTER TABLE usage_records
    MODIFY COLUMN cost_usd DECIMAL(18, 8) NOT NULL DEFAULT 0
    COMMENT 'Computed USD cost; exact decimal for SUM';
