"""Test fixtures: a fresh in-temp-dir SQLite DB + TestClient per test session.

Env is set BEFORE importing the app so settings/engine pick up the test DB.
The stack is async (aiosqlite); the sync ``TestClient`` drives the ASGI app via
its own event loop, so schema reset is run with ``asyncio.run``.
"""
from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

_tmpdir = tempfile.mkdtemp(prefix="analytics-test-")
# Sync-style URL is auto-upgraded to sqlite+aiosqlite by Settings.
os.environ["ANALYTICS_DATABASE_URL"] = f"sqlite:///{_tmpdir}/test.db"
os.environ["ANALYTICS_INGEST_API_KEY"] = ""  # open in tests
os.environ["ANALYTICS_QUERY_API_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


async def _reset_schema() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    # Drop pooled connections so none cross over into the TestClient loop.
    await engine.dispose()


@pytest.fixture(autouse=True)
def _clean_db():
    asyncio.run(_reset_schema())
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
