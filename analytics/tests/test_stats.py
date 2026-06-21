from __future__ import annotations


def _seed(client):
    client.post(
        "/v1/usage",
        json={
            "records": [
                {"user_email": "alice@co.com", "session_id": "a1", "provider": "openai",
                 "model": "gpt-4o", "input_tokens": 1000, "output_tokens": 500, "ts": "2026-01-01T10:00:00Z"},
                {"user_email": "alice@co.com", "session_id": "a1", "provider": "openai",
                 "model": "gpt-4o", "input_tokens": 2000, "output_tokens": 800, "ts": "2026-01-01T11:00:00Z"},
                {"user_email": "bob@co.com", "session_id": "b1", "provider": "deepseek",
                 "model": "deepseek-chat", "input_tokens": 5000, "output_tokens": 1000, "ts": "2026-01-02T09:00:00Z"},
            ]
        },
    )


def test_summary_counts(client):
    _seed(client)
    s = client.get("/v1/stats/summary").json()
    assert s["calls"] == 3
    assert s["users"] == 2
    assert s["sessions"] == 2


def test_group_by_user(client):
    _seed(client)
    rows = client.get("/v1/stats/usage", params={"group_by": "user"}).json()
    by_key = {r["key"]: r for r in rows}
    assert by_key["alice@co.com"]["calls"] == 2
    assert by_key["bob@co.com"]["calls"] == 1


def test_group_by_day(client):
    _seed(client)
    rows = client.get("/v1/stats/usage", params={"group_by": "day"}).json()
    keys = {r["key"] for r in rows}
    assert "2026-01-01" in keys and "2026-01-02" in keys


def test_user_filter_isolation(client):
    _seed(client)
    s = client.get("/v1/stats/summary", params={"user": "alice@co.com"}).json()
    assert s["calls"] == 2
    assert s["users"] == 1


def test_users_leaderboard_sorted_by_cost(client):
    _seed(client)
    rows = client.get("/v1/stats/users").json()
    costs = [r["cost_usd"] for r in rows]
    assert costs == sorted(costs, reverse=True)


def test_sessions_rollup(client):
    _seed(client)
    rows = client.get("/v1/stats/sessions", params={"user": "alice@co.com"}).json()
    assert len(rows) == 1
    assert rows[0]["session_id"] == "a1"
    assert rows[0]["calls"] == 2


def test_date_range_filter(client):
    _seed(client)
    s = client.get("/v1/stats/summary", params={"start": "2026-01-02T00:00:00Z"}).json()
    assert s["calls"] == 1
