"""Pydantic request/response models for the public API."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ── Ingest: usage ─────────────────────────────────────────────────────────
class UsageIn(BaseModel):
    """One LLM call/step. Mirrors the agent's `AttachedTokenUsage` + context."""

    model_config = ConfigDict(extra="ignore")

    event_id: str | None = Field(
        default=None,
        description="Idempotency key, e.g. '<session_id>:<turn_index>'. "
        "Duplicate event_ids are silently skipped.",
    )
    ts: datetime | None = Field(default=None, description="When the call happened (defaults to now).")

    user_email: str | None = None
    session_id: str | None = None
    turn_index: int | None = None

    model: str | None = None
    provider: str | None = None
    source: str | None = Field(default=None, description="e.g. 'agent' or 'subagent'.")

    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0
    total_tokens: int | None = Field(
        default=None, description="Optional; derived from input+output when omitted."
    )

    latency_ms: int | None = None
    ttfb_ms: int | None = None
    tool_calls: int = 0


class UsageBatch(BaseModel):
    records: list[UsageIn]


# ── Ingest: generic events ────────────────────────────────────────────────
class EventIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    event_id: str | None = None
    ts: datetime | None = None
    type: str
    user_email: str | None = None
    session_id: str | None = None
    payload: dict = Field(default_factory=dict)


class EventBatch(BaseModel):
    events: list[EventIn]


class IngestResult(BaseModel):
    accepted: int
    skipped: int = 0


# ── Reporting ─────────────────────────────────────────────────────────────
class UsageSummary(BaseModel):
    calls: int
    sessions: int
    users: int
    questions: int = Field(default=0, description="User chat messages (type=chat.user_message).")
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    reasoning_tokens: int
    total_tokens: int
    cost_usd: float


class UserQuestionRow(BaseModel):
    user_email: str
    questions: int


class GroupedUsageRow(BaseModel):
    key: str
    calls: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: float


class SessionRollup(BaseModel):
    session_id: str
    user_email: str | None
    calls: int
    total_tokens: int
    cost_usd: float
    first_seen: datetime | None
    last_seen: datetime | None
