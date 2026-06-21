from __future__ import annotations


def test_dashboard_renders_with_data(client):
    client.post(
        "/v1/usage",
        json={
            "user_email": "alice@co.com",
            "session_id": "s1",
            "model": "gpt-4o",
            "input_tokens": 1000,
            "output_tokens": 500,
            "ts": "2026-01-01T10:00:00Z",
        },
    )
    r = client.get("/dashboard")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    body = r.text
    # Server-embedded data + the user row should be present.
    assert "Coding Agent Analytics" in body
    assert "alice@co.com" in body
    assert "__DATA__" not in body  # placeholder was substituted


def test_dashboard_empty_ok(client):
    r = client.get("/dashboard")
    assert r.status_code == 200
    assert "Coding Agent Analytics" in r.text
