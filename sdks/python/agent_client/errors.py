"""Error types raised by :class:`agent_client.AgentClient`."""

from __future__ import annotations

from typing import Any


class AgentClientError(Exception):
    """Raised when the agent backend returns a non-2xx response.

    Attributes:
        status: The HTTP status code returned by the server.
        body: The parsed JSON body (``dict``/``list``) when available, else
            the raw response text. Useful for surfacing the server's
            ``{"error": "..."}`` payload to callers.
    """

    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body

    def __str__(self) -> str:
        base = super().__str__()
        return f"{base} (HTTP {self.status})"
