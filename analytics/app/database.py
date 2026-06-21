"""Async database engine, session factory, and schema bootstrap.

Uses SQLAlchemy 2.0 asyncio so the collector can sustain high write/read
concurrency. Backend is selected by `Settings.resolved_database_url()`:
  * MySQL (mirrors knowbot/chat-service) when `MYSQL_HOST` is set — async
    driver `aiomysql`, charset utf8mb4, pooled with pre-ping + recycle.
  * SQLite otherwise (dev / tests) — async driver `aiosqlite`, WAL + FK pragmas.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

settings = get_settings()

DATABASE_URL = settings.resolved_database_url()
_is_sqlite = DATABASE_URL.startswith("sqlite")
_is_mysql = DATABASE_URL.startswith("mysql")

_connect_args: dict = {}
_engine_kwargs: dict = {"pool_pre_ping": True, "future": True}

if _is_sqlite:
    # Allow the connection to be used across threads (aiosqlite worker thread).
    _connect_args = {"check_same_thread": False}
elif _is_mysql:
    # Match knowbot/chat-service pool semantics.
    _engine_kwargs.update(
        pool_size=settings.mysql_pool_size,
        max_overflow=settings.mysql_pool_size,  # up to 2x pool_size
        pool_recycle=settings.mysql_pool_recycle,
    )

engine = create_async_engine(DATABASE_URL, connect_args=_connect_args, **_engine_kwargs)


if _is_sqlite:

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):  # noqa: ANN001
        """WAL + FK enforcement for SQLite."""
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    autoflush=False,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    """Create tables if they don't exist. For real migrations use Alembic."""
    from . import models  # noqa: F401  (register mappers)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def dispose_engine() -> None:
    """Dispose the connection pool (call on shutdown)."""
    await engine.dispose()


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an async session."""
    async with AsyncSessionLocal() as db:
        yield db
