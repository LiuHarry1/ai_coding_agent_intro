-- Shared KnowBot MySQL database (same instance used by chat-service).
--
-- Usage (MySQL):
--   mysql -uroot -p < scripts/create_database.sql
--
-- Skip this if the `knowbot` database already exists (typical when chat-service
-- is deployed). Analytics only adds tables via init_tables.sql — it does not
-- use a separate database.

CREATE DATABASE IF NOT EXISTS knowbot
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
