"""Local HS256 JWT minting for the coding-agent backend.

The agent's SSO deploy mode (``deploy/docker-compose.sso.yml``) verifies a
shared-secret HS256 token statelessly — no auth-service round-trip, no DB.
See ``src/server/auth/identity.py``/``identity.ts``
(``verifyJwt``): it only checks the signature, ``exp``/``nbf``, and reads
``sub`` (email), ``username`` and ``role``.

Because the secret is shared, a programmatic caller can mint its own token
instead of going through the browser SSO flow. This is the cleanest way to
do service-to-service calls. We implement it with the standard library
(``hmac`` + ``hashlib`` + ``base64``) so there is no ``PyJWT`` dependency.

The token's email (``sub``) decides which workspace the server pins the
caller to (``/USERS_ROOT/<slug(email)>``). Pick a stable identity per
service so it always lands in the same workspace.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Mapping


def _b64url(raw: bytes) -> str:
    """Base64url-encode without padding (JWT convention)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def mint_jwt(
    secret: str,
    email: str,
    *,
    username: str | None = None,
    role: str = "user",
    ttl_seconds: int = 3600,
    extra_claims: Mapping[str, Any] | None = None,
) -> str:
    """Create a signed HS256 JWT the agent backend will accept.

    Args:
        secret: The shared ``JWT_SECRET`` the agent was deployed with.
        email: Becomes the ``sub`` claim; decides the pinned workspace.
        username: Display name (``username`` claim). Defaults to ``email``.
        role: ``role`` claim. Use ``"super"`` to view all users' sessions.
        ttl_seconds: Token lifetime; sets ``exp = now + ttl_seconds``.
        extra_claims: Any additional claims to merge into the payload.

    Returns:
        The compact ``header.payload.signature`` JWT string.
    """
    if not secret:
        raise ValueError("mint_jwt: secret is required")
    if not email:
        raise ValueError("mint_jwt: email is required")

    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload: dict[str, Any] = {
        "sub": email,
        "username": username or email,
        "role": role,
        "iat": now,
        "exp": now + int(ttl_seconds),
    }
    if extra_claims:
        payload.update(extra_claims)

    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    )
    signature = hmac.new(
        secret.encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return signing_input + "." + _b64url(signature)
