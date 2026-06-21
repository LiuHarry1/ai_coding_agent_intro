"""SQLAlchemy ORM models.

Two tables:
  * usage_records — one row per LLM call/step: tokens, latency, computed cost.
  * events        — generic append-only log for everything else (session
                    lifecycle, tool invocations, errors, custom events).

Both carry `user_email` and `session_id` so every query can slice by tenant.
`event_id` gives the producer a dedup handle (unique) for safe retries.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UsageRecord(Base):
    __tablename__ = "usage_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Producer-supplied idempotency key (e.g. f"{session_id}:{turn_index}").
    event_id: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    user_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    turn_index: Mapped[int | None] = mapped_column(Integer, nullable=True)

    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)

    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)

    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ttfb_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)

    # DECIMAL(18,8) on MySQL for exact monetary storage + exact SUM aggregation;
    # asdecimal=False keeps the Python value a plain float for the JSON API.
    cost_usd: Mapped[float] = mapped_column(
        Numeric(18, 8, asdecimal=False), default=0.0
    )

    __table_args__ = (
        Index("ix_usage_ts", "ts"),
        Index("ix_usage_user_ts", "user_email", "ts"),
        Index("ix_usage_session", "session_id"),
        Index("ix_usage_model", "model"),
        # MySQL-only DDL hints (ignored by SQLite); mirrors knowbot tables.
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    type: Mapped[str] = mapped_column(String(64))
    user_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    payload: Mapped[dict] = mapped_column(JSON, default=dict)

    __table_args__ = (
        Index("ix_event_ts", "ts"),
        Index("ix_event_type_ts", "type", "ts"),
        Index("ix_event_user_ts", "user_email", "ts"),
        Index("ix_event_session", "session_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
