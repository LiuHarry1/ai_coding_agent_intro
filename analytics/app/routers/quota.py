"""Per-user daily token quota endpoints (agent enforcement)."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..quota_service import commit_quota, get_quota_status
from ..schemas import QuotaCommitIn, QuotaCommitResult, QuotaStatus
from ..security import require_ingest_key

router = APIRouter(prefix="/v1/quota", tags=["quota"], dependencies=[Depends(require_ingest_key)])


@router.get("/status", response_model=QuotaStatus)
async def quota_status(
    db: Annotated[AsyncSession, Depends(get_db)],
    user_email: str = Query(..., min_length=1, max_length=320),
) -> QuotaStatus:
    """Return today's usage vs limit for a user (UTC day)."""
    return await get_quota_status(db, user_email.strip())


@router.post("/commit", response_model=QuotaCommitResult)
async def quota_commit(
    body: QuotaCommitIn,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> QuotaCommitResult:
    """Atomically record tokens consumed by one chat request (idempotent)."""
    return await commit_quota(db, body)
