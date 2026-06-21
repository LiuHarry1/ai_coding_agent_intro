"""API-key auth dependencies.

Two independent keys:
  * ingest  — write endpoints (the agent uses this)
  * query   — read/reporting endpoints (dashboards use this)

When a key is left empty in config the corresponding gate is OPEN, which keeps
local development friction-free. Set both in production.
"""
from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import get_settings


def _check(provided: str | None, expected: str) -> None:
    if not expected:
        return  # gate disabled
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": "API-Key"},
        )


def require_ingest_key(x_api_key: str | None = Header(default=None)) -> None:
    _check(x_api_key, get_settings().ingest_api_key)


def require_query_key(x_api_key: str | None = Header(default=None)) -> None:
    _check(x_api_key, get_settings().query_api_key)
