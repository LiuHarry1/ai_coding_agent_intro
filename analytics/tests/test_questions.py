from __future__ import annotations


def _seed_questions(client):
    client.post(
        "/v1/events",
        json={
            "events": [
                {
                    "type": "chat.user_message",
                    "event_id": "a1:q:0",
                    "user_email": "alice@co.com",
                    "session_id": "a1",
                },
                {
                    "type": "chat.user_message",
                    "event_id": "a1:q:2",
                    "user_email": "alice@co.com",
                    "session_id": "a1",
                },
                {
                    "type": "chat.user_message",
                    "event_id": "b1:q:0",
                    "user_email": "bob@co.com",
                    "session_id": "b1",
                },
            ]
        },
    )


def test_questions_per_user(client):
    _seed_questions(client)
    rows = client.get("/v1/stats/questions/users").json()
    by_user = {r["user_email"]: r["questions"] for r in rows}
    assert by_user["alice@co.com"] == 2
    assert by_user["bob@co.com"] == 1


def test_summary_includes_questions(client):
    _seed_questions(client)
    s = client.get("/v1/stats/summary").json()
    assert s["questions"] == 3


def test_questions_idempotent(client):
    body = {
        "events": [
            {
                "type": "chat.user_message",
                "event_id": "s1:q:0",
                "user_email": "alice@co.com",
                "session_id": "s1",
            }
        ]
    }
    assert client.post("/v1/events", json=body).json() == {"accepted": 1, "skipped": 0}
    assert client.post("/v1/events", json=body).json() == {"accepted": 0, "skipped": 1}
    assert client.get("/v1/stats/summary").json()["questions"] == 1
