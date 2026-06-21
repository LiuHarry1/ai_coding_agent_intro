"""Write endpoints the agent calls to report telemetry.

All endpoints accept either a single object or a batch wrapper, are protected
by the ingest API key, and are idempotent on `event_id`.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..database import get_db
from ..models import Event, UsageRecord
from ..pricing import compute_cost_usd
from ..schemas import EventBatch, EventIn, IngestResult, UsageBatch, UsageIn
from ..security import require_ingest_key

router = APIRouter(prefix="/v1", tags=["ingest"], dependencies=[Depends(require_ingest_key)])


async def _existing_event_ids(db: AsyncSession, model, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    rows = (await db.execute(select(model.event_id).where(model.event_id.in_(ids)))).all()
    return {r[0] for r in rows}


def _enforce_batch_size(n: int) -> None:
    limit = get_settings().max_batch_size
    if n > limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Batch too large: {n} > {limit}",
        )


def _usage_to_row(u: UsageIn) -> UsageRecord:
    total = u.total_tokens if u.total_tokens is not None else u.input_tokens + u.output_tokens
    cost = compute_cost_usd(
        u.model, u.input_tokens, u.output_tokens, u.cached_input_tokens
    )
    fields = {
        "event_id": u.event_id,
        "user_email": u.user_email,
        "session_id": u.session_id,
        "turn_index": u.turn_index,
        "model": u.model,
        "provider": u.provider,
        "source": u.source,
        "input_tokens": u.input_tokens,
        "output_tokens": u.output_tokens,
        "cached_input_tokens": u.cached_input_tokens,
        "reasoning_tokens": u.reasoning_tokens,
        "total_tokens": total,
        "latency_ms": u.latency_ms,
        "ttfb_ms": u.ttfb_ms,
        "tool_calls": u.tool_calls,
        "cost_usd": cost,
    }
    if u.ts is not None:
        fields["ts"] = u.ts
    return UsageRecord(**fields)


@router.post("/usage", response_model=IngestResult)
async def ingest_usage(
    body: Annotated[UsageIn | UsageBatch, Body(...)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> IngestResult:
    records = body.records if isinstance(body, UsageBatch) else [body]
    _enforce_batch_size(len(records))

    incoming_ids = [r.event_id for r in records if r.event_id]
    seen = await _existing_event_ids(db, UsageRecord, incoming_ids)

    accepted = skipped = 0
    batch_ids: set[str] = set()
    for r in records:
        if r.event_id and (r.event_id in seen or r.event_id in batch_ids):
            skipped += 1
            continue
        if r.event_id:
            batch_ids.add(r.event_id)
        db.add(_usage_to_row(r))
        accepted += 1

    await db.commit()
    return IngestResult(accepted=accepted, skipped=skipped)


@router.post("/events", response_model=IngestResult)
async def ingest_events(
    body: Annotated[EventIn | EventBatch, Body(...)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> IngestResult:
    events = body.events if isinstance(body, EventBatch) else [body]
    _enforce_batch_size(len(events))

    incoming_ids = [e.event_id for e in events if e.event_id]
    seen = await _existing_event_ids(db, Event, incoming_ids)

    accepted = skipped = 0
    batch_ids: set[str] = set()
    for e in events:
        if e.event_id and (e.event_id in seen or e.event_id in batch_ids):
            skipped += 1
            continue
        if e.event_id:
            batch_ids.add(e.event_id)
        fields = {
            "event_id": e.event_id,
            "type": e.type,
            "user_email": e.user_email,
            "session_id": e.session_id,
            "payload": e.payload,
        }
        if e.ts is not None:
            fields["ts"] = e.ts
        db.add(Event(**fields))
        accepted += 1

    await db.commit()
    return IngestResult(accepted=accepted, skipped=skipped)
