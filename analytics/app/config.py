"""Runtime configuration, loaded from environment / .env.

All settings are optional with sensible dev defaults so the service runs with
zero config locally. For production set at least `INGEST_API_KEY` and a
real `DATABASE_URL`.
"""
from __future__ import annotations

from functools import lru_cache
from urllib.parse import quote

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="ANALYTICS_",
        extra="ignore",
    )

    # ── Storage ───────────────────────────────────────────────────────────
    # Resolution order (see `resolved_database_url`):
    #   1. ANALYTICS_DATABASE_URL  — explicit override (also how tests pin SQLite)
    #   2. MYSQL_*                  — build a MySQL URL (mirrors knowbot/chat-service)
    #   3. SQLite fallback          — sqlite:///./analytics.db
    database_url: str = ""

    # MySQL connection — bare MYSQL_* env vars (NO prefix), matching
    # knowbot/chat-service so the same deployment env works here. Analytics
    # tables (usage_records, events) live in the shared `knowbot` database.
    mysql_host: str = Field(default="", validation_alias="MYSQL_HOST")
    mysql_port: int = Field(default=3306, validation_alias="MYSQL_PORT")
    mysql_user: str = Field(default="root", validation_alias="MYSQL_USER")
    mysql_password: str = Field(default="", validation_alias="MYSQL_PASSWORD")
    mysql_database: str = Field(default="knowbot", validation_alias="MYSQL_DATABASE")
    mysql_pool_size: int = Field(default=5, validation_alias="MYSQL_POOL_SIZE")
    mysql_pool_recycle: int = Field(default=3600, validation_alias="MYSQL_POOL_RECYCLE")

    def resolved_database_url(self) -> str:
        """Effective async SQLAlchemy URL after applying the resolution order.

        Always returns an async-capable URL (aiomysql / aiosqlite); a sync
        URL supplied via ANALYTICS_DATABASE_URL is upgraded automatically.
        """
        if self.database_url.strip():
            return _to_async_url(self.database_url.strip())
        if self.mysql_host.strip():
            pw = quote(self.mysql_password, safe="")
            return (
                f"mysql+aiomysql://{self.mysql_user}:{pw}"
                f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}"
                f"?charset=utf8mb4"
            )
        return "sqlite+aiosqlite:///./analytics.db"

    # ── Auth ──────────────────────────────────────────────────────────────
    # Shared secret the agent sends as `X-API-Key` when POSTing telemetry.
    # Empty string disables ingest auth (dev only).
    ingest_api_key: str = ""
    # Separate key guarding the read/reporting endpoints. Empty = open.
    query_api_key: str = ""

    # ── Behavior ──────────────────────────────────────────────────────────
    # Optional JSON string OR file path overriding the per-model price table
    # (see pricing.py). Prices are USD per 1,000,000 tokens.
    pricing_json: str = ""
    # Max records accepted in a single batch POST.
    max_batch_size: int = 1000

    cors_allow_origins: str = "*"

    # Daily token cap per user (UTC calendar day). 0 = unlimited (quota API still works).
    default_daily_token_limit: int = 0


def _to_async_url(url: str) -> str:
    """Map a (possibly sync) SQLAlchemy URL onto its async driver."""
    if url.startswith(("sqlite+aiosqlite", "mysql+aiomysql", "postgresql+asyncpg")):
        return url
    if url.startswith("sqlite"):
        return url.replace("sqlite://", "sqlite+aiosqlite://", 1)
    if url.startswith("mysql+pymysql"):
        return url.replace("mysql+pymysql", "mysql+aiomysql", 1)
    if url.startswith("mysql://"):
        return url.replace("mysql://", "mysql+aiomysql://", 1)
    return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
