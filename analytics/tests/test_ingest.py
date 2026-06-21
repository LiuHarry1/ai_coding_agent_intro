from __future__ import annotations


def test_ingest_single_usage_and_cost(client):
    r = client.post(
        "/v1/usage",
        json={
            "user_email": "alice@co.com",
            "session_id": "s1",
            "model": "gpt-4o",
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
        },
    )
    assert r.status_code == 200
    assert r.json() == {"accepted": 1, "skipped": 0}

    summary = client.get("/v1/stats/summary").json()
    assert summary["calls"] == 1
    assert summary["total_tokens"] == 2_000_000
    # gpt-4o: 2.5 in + 10 out per 1M → 12.5 USD.
    assert abs(summary["cost_usd"] - 12.5) < 1e-6


def test_total_tokens_derived_when_missing(client):
    client.post("/v1/usage", json={"input_tokens": 30, "output_tokens": 12})
    assert client.get("/v1/stats/summary").json()["total_tokens"] == 42


def test_batch_and_idempotent_event_id(client):
    body = {
        "records": [
            {"event_id": "s1:0", "model": "gpt-4o", "input_tokens": 10, "output_tokens": 5},
            {"event_id": "s1:1", "model": "gpt-4o", "input_tokens": 20, "output_tokens": 5},
        ]
    }
    assert client.post("/v1/usage", json=body).json() == {"accepted": 2, "skipped": 0}
    # Re-send the same batch: both should be skipped.
    assert client.post("/v1/usage", json=body).json() == {"accepted": 0, "skipped": 2}
    assert client.get("/v1/stats/summary").json()["calls"] == 2


def test_unknown_model_zero_cost(client):
    client.post("/v1/usage", json={"model": "mystery-llm", "input_tokens": 100, "output_tokens": 100})
    assert client.get("/v1/stats/summary").json()["cost_usd"] == 0.0


def test_events_ingest(client):
    r = client.post(
        "/v1/events",
        json={"type": "session_created", "user_email": "bob@co.com", "session_id": "s9", "payload": {"mode": "agent"}},
    )
    assert r.status_code == 200
    assert r.json()["accepted"] == 1
