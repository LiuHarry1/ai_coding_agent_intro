"""Python client for the coding-agent backend (skills + chat over HTTP).

Quick start::

    from agent_client import AgentClient

    agent = AgentClient(
        base_url="http://10.150.115.69:4567",
        jwt_secret="<JWT_SECRET>",   # mints a token locally
        email="service@bot",          # decides the pinned workspace
    )

    print(agent.list_skills()["skills"])
    print(agent.invoke_skill("SWR-content-generator", {"foo": "bar"})["result"])
"""

from .auth import mint_jwt
from .client import AgentClient, collect_text
from .errors import AgentClientError

__all__ = [
    "AgentClient",
    "AgentClientError",
    "mint_jwt",
    "collect_text",
]

__version__ = "0.1.0"
