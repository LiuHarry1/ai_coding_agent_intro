"""FastAPI application entrypoint.

Run locally:
    conda activate llm_ft
    uvicorn app.main:app --reload --port 8200

Interactive docs at /docs.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .database import dispose_engine, init_db
from .routers import dashboard, health, ingest, stats


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Coding Agent Analytics",
        version=__version__,
        summary="Collects usage, cost, and event telemetry from the coding agent.",
        lifespan=lifespan,
    )

    origins = [o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins or ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(ingest.router)
    app.include_router(stats.router)
    app.include_router(dashboard.router)
    return app


app = create_app()
