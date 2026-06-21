from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_quota_limit(monkeypatch):
    monkeypatch.setenv("ANALYTICS_DEFAULT_DAILY_TOKEN_LIMIT", "0")
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_quota_status_unlimited_by_default(client):
    r = client.get("/v1/quota/status", params={"user_email": "alice@co.com"})
    assert r.status_code == 200
    body = r.json()
    assert body["unlimited"] is True
    assert body["exceeded"] is False
    assert body["used"] == 0


def test_quota_commit_and_status(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_DEFAULT_DAILY_TOKEN_LIMIT", "1000")

    # Reload settings cache after env change
    from app.config import get_settings

    get_settings.cache_clear()

    commit = client.post(
        "/v1/quota/commit",
        json={
            "user_email": "alice@co.com",
            "tokens": 400,
            "event_id": "s1:chat:req1",
        },
    )
    assert commit.status_code == 200
    assert commit.json()["accepted"] is True
    assert commit.json()["used"] == 400
    assert commit.json()["remaining"] == 600

    status = client.get("/v1/quota/status", params={"user_email": "alice@co.com"}).json()
    assert status["used"] == 400
    assert status["exceeded"] is False

    # idempotent retry
    again = client.post(
        "/v1/quota/commit",
        json={
            "user_email": "alice@co.com",
            "tokens": 400,
            "event_id": "s1:chat:req1",
        },
    ).json()
    assert again["skipped"] is True
    assert again["used"] == 400


def test_quota_exceeded(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_DEFAULT_DAILY_TOKEN_LIMIT", "500")
    from app.config import get_settings

    get_settings.cache_clear()

    client.post(
        "/v1/quota/commit",
        json={"user_email": "bob@co.com", "tokens": 500, "event_id": "s2:chat:a"},
    )
    status = client.get("/v1/quota/status", params={"user_email": "bob@co.com"}).json()
    assert status["exceeded"] is True
    assert status["remaining"] == 0
