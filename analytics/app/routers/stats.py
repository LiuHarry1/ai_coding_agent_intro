"""Read/reporting endpoints: aggregate usage and cost across tenants.

All endpoints support optional `start` / `end` (ISO datetime) and `user`
filters. Protected by the query API key.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from ..database import engine, get_db
from ..models import Event, UsageRecord
from ..schemas import GroupedUsageRow, SessionRollup, UsageSummary, UserQuestionRow
from ..security import require_query_key

router = APIRouter(prefix="/v1/stats", tags=["stats"], dependencies=[Depends(require_query_key)])

GroupBy = Literal["day", "model", "user", "provider"]

# Agent reports one event per user chat POST (see server/telemetry.ts).
USER_QUESTION_EVENT = "chat.user_message"


def _apply_filters(stmt, start: datetime | None, end: datetime | None, user: str | None):
    if start is not None:
        stmt = stmt.where(UsageRecord.ts >= start)
    if end is not None:
        stmt = stmt.where(UsageRecord.ts <= end)
    if user is not None:
        stmt = stmt.where(UsageRecord.user_email == user)
    return stmt


def _day_bucket() -> ColumnElement:
    """Portable 'truncate ts to day' expression."""
    name = engine.sync_engine.dialect.name
    if name == "sqlite":
        return func.strftime("%Y-%m-%d", UsageRecord.ts)
    if name == "mysql":
        return func.date_format(UsageRecord.ts, "%Y-%m-%d")
    # Postgres / others: date_trunc returns a timestamp; cast to date text.
    return func.to_char(func.date_trunc("day", UsageRecord.ts), "YYYY-MM-DD")


def _group_column(group_by: GroupBy) -> ColumnElement:
    if group_by == "model":
        return func.coalesce(UsageRecord.model, "unknown")
    if group_by == "user":
        return func.coalesce(UsageRecord.user_email, "anonymous")
    if group_by == "provider":
        return func.coalesce(UsageRecord.provider, "unknown")
    return _day_bucket()


def _apply_event_filters(stmt, start: datetime | None, end: datetime | None, user: str | None):
    if start is not None:
        stmt = stmt.where(Event.ts >= start)
    if end is not None:
        stmt = stmt.where(Event.ts <= end)
    if user is not None:
        stmt = stmt.where(Event.user_email == user)
    return stmt


async def _count_questions(
    db: AsyncSession,
    start: datetime | None = None,
    end: datetime | None = None,
    user: str | None = None,
) -> int:
    stmt = select(func.count(Event.id)).where(Event.type == USER_QUESTION_EVENT)
    stmt = _apply_event_filters(stmt, start, end, user)
    return int((await db.execute(stmt)).scalar_one())


@router.get("/summary", response_model=UsageSummary)
async def summary(
    db: Annotated[AsyncSession, Depends(get_db)],
    start: datetime | None = None,
    end: datetime | None = None,
    user: str | None = None,
) -> UsageSummary:
    stmt = select(
        func.count(UsageRecord.id),
        func.count(func.distinct(UsageRecord.session_id)),
        func.count(func.distinct(UsageRecord.user_email)),
        func.coalesce(func.sum(UsageRecord.input_tokens), 0),
        func.coalesce(func.sum(UsageRecord.output_tokens), 0),
        func.coalesce(func.sum(UsageRecord.cached_input_tokens), 0),
        func.coalesce(func.sum(UsageRecord.reasoning_tokens), 0),
        func.coalesce(func.sum(UsageRecord.total_tokens), 0),
        func.coalesce(func.sum(UsageRecord.cost_usd), 0.0),
    )
    stmt = _apply_filters(stmt, start, end, user)
    row = (await db.execute(stmt)).one()
    questions = await _count_questions(db, start, end, user)
    return UsageSummary(
        calls=row[0],
        sessions=row[1],
        users=row[2],
        questions=questions,
        input_tokens=row[3],
        output_tokens=row[4],
        cached_input_tokens=row[5],
        reasoning_tokens=row[6],
        total_tokens=row[7],
        cost_usd=round(float(row[8]), 6),
    )


@router.get("/usage", response_model=list[GroupedUsageRow])
async def grouped_usage(
    db: Annotated[AsyncSession, Depends(get_db)],
    group_by: GroupBy = Query(default="day"),
    start: datetime | None = None,
    end: datetime | None = None,
    user: str | None = None,
    limit: int = Query(default=100, le=1000),
) -> list[GroupedUsageRow]:
    key = _group_column(group_by)
    stmt = select(
        key.label("key"),
        func.count(UsageRecord.id),
        func.coalesce(func.sum(UsageRecord.input_tokens), 0),
        func.coalesce(func.sum(UsageRecord.output_tokens), 0),
        func.coalesce(func.sum(UsageRecord.total_tokens), 0),
        func.coalesce(func.sum(UsageRecord.cost_usd), 0.0),
    )
    stmt = _apply_filters(stmt, start, end, user).group_by(key).order_by(key).limit(limit)
    rows = (await db.execute(stmt)).all()
    return [
        GroupedUsageRow(
            key=str(r[0]),
            calls=r[1],
            input_tokens=r[2],
            output_tokens=r[3],
            total_tokens=r[4],
            cost_usd=round(float(r[5]), 6),
        )
        for r in rows
    ]


@router.get("/users", response_model=list[GroupedUsageRow])
async def per_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = Query(default=100, le=1000),
) -> list[GroupedUsageRow]:
    """Leaderboard: usage + cost per user, highest cost first."""
    key = func.coalesce(UsageRecord.user_email, "anonymous")
    cost = func.coalesce(func.sum(UsageRecord.cost_usd), 0.0)
    stmt = select(
        key.label("key"),
        func.count(UsageRecord.id),
        func.coalesce(func.sum(UsageRecord.input_tokens), 0),
        func.coalesce(func.sum(UsageRecord.output_tokens), 0),
        func.coalesce(func.sum(UsageRecord.total_tokens), 0),
        cost,
    )
    stmt = _apply_filters(stmt, start, end, None).group_by(key).order_by(cost.desc()).limit(limit)
    rows = (await db.execute(stmt)).all()
    return [
        GroupedUsageRow(
            key=str(r[0]),
            calls=r[1],
            input_tokens=r[2],
            output_tokens=r[3],
            total_tokens=r[4],
            cost_usd=round(float(r[5]), 6),
        )
        for r in rows
    ]


@router.get("/sessions", response_model=list[SessionRollup])
async def sessions(
    db: Annotated[AsyncSession, Depends(get_db)],
    user: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = Query(default=100, le=1000),
) -> list[SessionRollup]:
    stmt = select(
        UsageRecord.session_id,
        func.max(UsageRecord.user_email),
        func.count(UsageRecord.id),
        func.coalesce(func.sum(UsageRecord.total_tokens), 0),
        func.coalesce(func.sum(UsageRecord.cost_usd), 0.0),
        func.min(UsageRecord.ts),
        func.max(UsageRecord.ts),
    ).where(UsageRecord.session_id.isnot(None))
    stmt = _apply_filters(stmt, start, end, user)
    stmt = (
        stmt.group_by(UsageRecord.session_id)
        .order_by(func.max(UsageRecord.ts).desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    return [
        SessionRollup(
            session_id=r[0],
            user_email=r[1],
            calls=r[2],
            total_tokens=r[3],
            cost_usd=round(float(r[4]), 6),
            first_seen=r[5],
            last_seen=r[6],
        )
        for r in rows
    ]


@router.get("/questions/users", response_model=list[UserQuestionRow])
async def questions_per_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = Query(default=100, le=1000),
) -> list[UserQuestionRow]:
    """Per-user count of chat messages sent (questions asked)."""
    key = func.coalesce(Event.user_email, "anonymous")
    count = func.count(Event.id)
    stmt = (
        select(key.label("user_email"), count.label("questions"))
        .where(Event.type == USER_QUESTION_EVENT)
        .group_by(key)
        .order_by(count.desc())
        .limit(limit)
    )
    stmt = _apply_event_filters(stmt, start, end, None)
    rows = (await db.execute(stmt)).all()
    return [UserQuestionRow(user_email=str(r[0]), questions=r[1]) for r in rows]
