"""Daily per-user token quota (UTC calendar day, no timezone config).

Enforcement counter lives in ``user_daily_usage``; ``usage_records`` remains
the async detail ledger for reporting.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .database import engine
from .models import QuotaCommitLog, UserDailyUsage
from .schemas import QuotaCommitIn, QuotaCommitResult, QuotaStatus


def utc_usage_date() -> date:
    return datetime.now(timezone.utc).date()


def utc_reset_at(usage_date: date) -> datetime:
    nxt = usage_date + timedelta(days=1)
    return datetime(nxt.year, nxt.month, nxt.day, tzinfo=timezone.utc)


def effective_daily_limit() -> int:
    return max(0, get_settings().default_daily_token_limit)


async def _read_used(db: AsyncSession, user_email: str, usage_date: date) -> int:
    row = (
        await db.execute(
            select(UserDailyUsage.tokens_used).where(
                UserDailyUsage.user_email == user_email,
                UserDailyUsage.usage_date == usage_date,
            )
        )
    ).scalar_one_or_none()
    return int(row or 0)


def _build_status(user_email: str, usage_date: date, used: int) -> QuotaStatus:
    limit = effective_daily_limit()
    unlimited = limit <= 0
    remaining = 0 if unlimited else max(0, limit - used)
    exceeded = not unlimited and used >= limit
    return QuotaStatus(
        user_email=user_email,
        usage_date=usage_date.isoformat(),
        used=used,
        limit=limit,
        remaining=remaining,
        exceeded=exceeded,
        unlimited=unlimited,
        reset_at=utc_reset_at(usage_date),
    )


async def get_quota_status(db: AsyncSession, user_email: str) -> QuotaStatus:
    usage_date = utc_usage_date()
    used = await _read_used(db, user_email, usage_date)
    return _build_status(user_email, usage_date, used)


async def _upsert_daily_tokens(
    db: AsyncSession,
    user_email: str,
    usage_date: date,
    tokens: int,
) -> None:
    dialect = engine.sync_engine.dialect.name
    now = datetime.now(timezone.utc)
    if dialect == "mysql":
        stmt = mysql_insert(UserDailyUsage).values(
            user_email=user_email,
            usage_date=usage_date,
            tokens_used=tokens,
            updated_at=now,
        )
        stmt = stmt.on_duplicate_key_update(
            tokens_used=UserDailyUsage.tokens_used + tokens,
            updated_at=now,
        )
    else:
        stmt = sqlite_insert(UserDailyUsage).values(
            user_email=user_email,
            usage_date=usage_date,
            tokens_used=tokens,
            updated_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_email", "usage_date"],
            set_={
                "tokens_used": UserDailyUsage.tokens_used + tokens,
                "updated_at": now,
            },
        )
    await db.execute(stmt)


async def commit_quota(db: AsyncSession, body: QuotaCommitIn) -> QuotaCommitResult:
    usage_date = utc_usage_date()
    tokens = max(0, body.tokens)

    existing = (
        await db.execute(
            select(QuotaCommitLog.event_id).where(QuotaCommitLog.event_id == body.event_id)
        )
    ).scalar_one_or_none()
    if existing:
        used = await _read_used(db, body.user_email, usage_date)
        status = _build_status(body.user_email, usage_date, used)
        return QuotaCommitResult(accepted=False, skipped=True, **status.model_dump())

    try:
        db.add(
            QuotaCommitLog(
                event_id=body.event_id,
                user_email=body.user_email,
                usage_date=usage_date,
                tokens=tokens,
            )
        )
        if tokens > 0:
            await _upsert_daily_tokens(db, body.user_email, usage_date, tokens)
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    used = await _read_used(db, body.user_email, usage_date)
    status = _build_status(body.user_email, usage_date, used)
    return QuotaCommitResult(accepted=True, skipped=False, **status.model_dump())
