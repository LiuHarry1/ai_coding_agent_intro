"""AgentClient — a thin, typed Python client for the coding-agent backend.

Mirrors the TypeScript ``client-sdk`` (``AgentClient``) but adds local JWT
minting so it works out-of-the-box against an SSO-mode deployment
(``AUTH_ENABLED=true``).

Three layers, one class:

* Discovery   — :meth:`list_skills`, :meth:`list_agents`
* Direct      — :meth:`invoke_skill` (buffered) / :meth:`invoke_skill_stream` (SSE)
* Free-form   — :meth:`chat_complete` (buffered) / :meth:`chat` (SSE)

Auth (pick one, in priority order):

1. ``token=...``        — use a JWT you already have.
2. ``jwt_secret=...``   — mint one locally from the shared secret (+ ``email``).
3. neither              — send no ``Authorization`` header (only works when
                          the backend has ``AUTH_ENABLED`` off).

Only dependency is ``requests``.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any, Iterable, Iterator, Mapping

import requests

from .auth import mint_jwt
from .errors import AgentClientError

# Arguments accepted by skill invocation: either a raw "key=value --flag"
# string or a structured mapping the server flattens for you.
SkillArgs = "str | Mapping[str, str | int | bool] | None"


class AgentClient:
    """HTTP client for the agent backend's skill / chat API.

    Args:
        base_url: Origin of the agent backend, e.g. ``http://10.150.115.69:4567``.
        token: A ready-made bearer JWT. Takes precedence over ``jwt_secret``.
        jwt_secret: Shared ``JWT_SECRET`` used to mint a token locally when
            ``token`` is not given.
        email: Identity for the minted token (``sub`` claim). Decides the
            server-pinned workspace. Required when minting.
        username: Display name for the minted token. Defaults to ``email``.
        role: Role claim for the minted token (``"user"`` or ``"super"``).
        token_ttl: Lifetime in seconds for the minted token.
        default_workspace: Sent as ``workspace`` when a call omits it. Note:
            in SSO mode the server IGNORES this and uses the token's pinned
            workspace; it only matters for non-auth deployments.
        timeout: Per-request timeout (seconds) for buffered calls. Streaming
            calls use it as a connect/read timeout for the initial response.
        headers: Extra headers merged into every request.
        session: A pre-configured ``requests.Session`` (proxies, retries,
            TLS verification, ...). One is created if omitted.
        verify: Passed to ``requests`` for TLS verification.
    """

    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        jwt_secret: str | None = None,
        email: str | None = None,
        username: str | None = None,
        role: str = "user",
        token_ttl: int = 3600,
        default_workspace: str | None = None,
        timeout: float = 300.0,
        headers: Mapping[str, str] | None = None,
        session: requests.Session | None = None,
        verify: bool | str = True,
    ) -> None:
        if not base_url:
            raise ValueError("AgentClient: base_url is required")
        self._base_url = base_url.rstrip("/")
        self._default_workspace = default_workspace
        self._timeout = timeout
        self._verify = verify
        self._session = session or requests.Session()
        self._extra_headers = dict(headers or {})

        if token:
            self._token: str | None = token
        elif jwt_secret:
            if not email:
                raise ValueError(
                    "AgentClient: email is required when minting from jwt_secret"
                )
            self._token = mint_jwt(
                jwt_secret,
                email,
                username=username,
                role=role,
                ttl_seconds=token_ttl,
            )
        else:
            self._token = None

    # ── discovery ──────────────────────────────────────────────────────────

    def list_skills(self, workspace: str | None = None) -> dict[str, Any]:
        """List skills discoverable for a workspace (active + conditional)."""
        ws = workspace or self._default_workspace
        qs = f"?workspace={urllib.parse.quote(ws)}" if ws else ""
        return self._get_json(f"/skills{qs}")

    def list_agents(self, workspace: str | None = None) -> dict[str, Any]:
        """List subagents (built-in + project-level ``.agents/``)."""
        ws = workspace or self._default_workspace
        qs = f"?workspace={urllib.parse.quote(ws)}" if ws else ""
        return self._get_json(f"/agents{qs}")

    # ── direct skill invocation ──────────────────────────────────────────────

    def invoke_skill(
        self,
        name: str,
        arguments: "SkillArgs" = None,
        workspace: str | None = None,
    ) -> dict[str, Any]:
        """Run a skill directly and return the final result as a dict.

        For ``inline`` skills this is pure template expansion (no LLM call):
        ``{"context": "inline", "result": "<expanded markdown>", ...}``.
        For ``fork`` skills it spins up a subagent, waits for completion,
        and returns ``{"context": "fork", "result": "<final text>", ...}``.
        Use :meth:`invoke_skill_stream` to watch a fork skill's progress.
        """
        body: dict[str, Any] = {
            "workspace": workspace or self._default_workspace,
            "stream": False,
        }
        if arguments is not None:
            body["arguments"] = arguments
        path = f"/skills/{urllib.parse.quote(name)}/invoke?stream=false"
        return self._post_json(path, body)

    def invoke_skill_stream(
        self,
        name: str,
        arguments: "SkillArgs" = None,
        workspace: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Streaming variant of :meth:`invoke_skill`.

        Yields event dicts (each has a ``type`` key): ``skill_start``,
        ``text_delta``, ``reasoning_delta``, ``tool_call``, ``tool_result``,
        ``finish``, ``error``, or ``unknown``. Inline skills surface as a
        single ``text_delta`` + ``finish``.
        """
        body: dict[str, Any] = {"workspace": workspace or self._default_workspace}
        if arguments is not None:
            body["arguments"] = arguments
        return self._post_sse(f"/skills/{urllib.parse.quote(name)}/invoke", body)

    # ── free-form chat ─────────────────────────────────────────────────────

    def chat_complete(
        self,
        message: str,
        *,
        workspace: str | None = None,
        session_id: str | None = None,
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        """One-shot chat: fire a turn, wait for the final text (JSON)."""
        body = self._chat_body(message, workspace, session_id, images)
        body["stream"] = False
        return self._post_json("/chat?stream=false", body)

    def chat(
        self,
        message: str,
        *,
        workspace: str | None = None,
        session_id: str | None = None,
        images: list[str] | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Streaming chat: yields the agent's event dicts as they arrive."""
        body = self._chat_body(message, workspace, session_id, images)
        return self._post_sse("/chat", body)

    def health(self) -> dict[str, Any]:
        """GET /health — does not require auth. Handy for readiness checks."""
        return self._get_json("/health")

    # ── helpers ────────────────────────────────────────────────────────────

    def _chat_body(
        self,
        message: str,
        workspace: str | None,
        session_id: str | None,
        images: list[str] | None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "message": message,
            "workspace": workspace or self._default_workspace,
        }
        if session_id:
            body["session_id"] = session_id
        if images:
            body["images"] = images
        return body

    def _auth_headers(self) -> dict[str, str]:
        h = dict(self._extra_headers)
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def _get_json(self, path: str) -> dict[str, Any]:
        res = self._session.get(
            self._base_url + path,
            headers={"Accept": "application/json", **self._auth_headers()},
            timeout=self._timeout,
            verify=self._verify,
        )
        return self._parse_json(res)

    def _post_json(self, path: str, body: Any) -> dict[str, Any]:
        res = self._session.post(
            self._base_url + path,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                **self._auth_headers(),
            },
            data=json.dumps(body),
            timeout=self._timeout,
            verify=self._verify,
        )
        return self._parse_json(res)

    @staticmethod
    def _parse_json(res: requests.Response) -> dict[str, Any]:
        text = res.text
        try:
            parsed = json.loads(text) if text else None
        except json.JSONDecodeError as e:
            raise AgentClientError(
                f"Invalid JSON from server: {e}", res.status_code, text
            ) from e
        if not res.ok:
            msg = (
                parsed.get("error")
                if isinstance(parsed, dict) and parsed.get("error")
                else f"HTTP {res.status_code}"
            )
            raise AgentClientError(str(msg), res.status_code, parsed)
        return parsed if isinstance(parsed, dict) else {"result": parsed}

    def _post_sse(self, path: str, body: Any) -> Iterator[dict[str, Any]]:
        res = self._session.post(
            self._base_url + path,
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                **self._auth_headers(),
            },
            data=json.dumps(body),
            stream=True,
            timeout=self._timeout,
            verify=self._verify,
        )
        if not res.ok:
            text = res.text
            try:
                parsed: Any = json.loads(text)
            except json.JSONDecodeError:
                parsed = text
            msg = (
                parsed.get("error")
                if isinstance(parsed, dict) and parsed.get("error")
                else f"HTTP {res.status_code}"
            )
            res.close()
            raise AgentClientError(str(msg), res.status_code, parsed)
        return _parse_sse(res)


def _parse_sse(res: requests.Response) -> Iterator[dict[str, Any]]:
    """Decode the backend's ``event:/data:`` SSE stream into event dicts.

    The wire format is a strict subset of SSE:
    ``event: <name>\\ndata: <json>\\n\\n`` (no ``id:``/``retry:``/multi-line
    ``data:``), matching ``sse-transport.ts`` on the server.
    """
    try:
        event_name = "message"
        data_line = ""
        for raw in res.iter_lines(decode_unicode=True):
            if raw is None:
                continue
            line = raw.rstrip("\r")
            if line == "":
                ev = _discriminate(event_name, data_line)
                if ev is not None:
                    yield ev
                event_name, data_line = "message", ""
                continue
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_line = line[5:].strip()
        # Flush a trailing record with no final blank line.
        ev = _discriminate(event_name, data_line)
        if ev is not None:
            yield ev
    finally:
        res.close()


def _discriminate(event: str, data_line: str) -> dict[str, Any] | None:
    if not data_line:
        return None
    try:
        data = json.loads(data_line)
    except json.JSONDecodeError:
        return {"type": "unknown", "event": event, "data": data_line}
    d = data if isinstance(data, dict) else {}
    known = {
        "session",
        "skill_start",
        "text_delta",
        "reasoning_delta",
        "tool_call",
        "tool_result",
        "finish",
        "error",
    }
    if event in known:
        return {"type": event, **d}
    return {"type": "unknown", "event": event, "data": data}


def collect_text(events: Iterable[Mapping[str, Any]]) -> str:
    """Convenience: drain an event stream and return the concatenated text.

    Prefers the ``finish`` event's ``text`` (the server's authoritative final
    answer) and falls back to accumulated ``text_delta`` chunks.
    """
    deltas: list[str] = []
    final: str | None = None
    for ev in events:
        t = ev.get("type")
        if t == "text_delta":
            deltas.append(str(ev.get("delta", "")))
        elif t == "finish":
            if isinstance(ev.get("text"), str):
                final = ev["text"]
        elif t == "error":
            raise AgentClientError(str(ev.get("message", "stream error")), 0, ev)
    return final if final is not None else "".join(deltas)
