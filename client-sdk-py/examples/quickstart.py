"""End-to-end demo of the Python agent client against an SSO deployment.

Run (from client-sdk-py/)::

    conda activate llm_ft
    pip install -e .
    set AGENT_BASE_URL=http://10.150.115.69:4567
    set AGENT_JWT_SECRET=9afd313591dc5a84dcf3022cb9f9bea05023672ca24716d1d7d9743d9be5d95d
    set AGENT_EMAIL=harry.liu@advantest.com
    python examples/quickstart.py              # full demo
    python examples/quickstart.py wetrack      # wetrack skill (streaming, shows steps)
    python examples/quickstart.py wetrack-stream  # same as wetrack
    python examples/quickstart.py chat         # multi-turn chat only
    python examples/quickstart.py health       # health check only
    python examples/quickstart.py skills       # list skills only
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable, Iterable, Mapping

from agent_client import AgentClient, AgentClientError, collect_text


def create_client() -> AgentClient:
    return AgentClient(
        base_url=os.environ.get("AGENT_BASE_URL", "http://10.150.115.69:4567"),
        jwt_secret=os.environ.get(
            "AGENT_JWT_SECRET",
            "9afd313591dc5a84dcf3022cb9f9bea05023672ca24716d1d7d9743d9be5d95d",
        ),
        email=os.environ.get("AGENT_EMAIL", "harry.liu@advantest.com"),
    )


def _truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."


def consume_agent_stream(
    events: Iterable[Mapping[str, object]],
    *,
    show_reasoning: bool = False,
    tool_result_max: int = 400,
) -> str:
    """Print agent SSE events as they arrive; return the final answer text."""
    deltas: list[str] = []
    final: str | None = None

    for ev in events:
        t = ev.get("type")
        if t == "session":
            print(f"[session] id={ev.get('session_id')}", flush=True)
        elif t == "skill_start":
            print(
                f"[skill_start] {ev.get('skill')} (agent={ev.get('agentType')})",
                flush=True,
            )
        elif t == "reasoning_delta":
            if show_reasoning:
                print(ev.get("delta", ""), end="", flush=True)
        elif t == "text_delta":
            delta = str(ev.get("delta", ""))
            deltas.append(delta)
            print(delta, end="", flush=True)
        elif t == "tool_call":
            print(f"\n[tool_call] {ev.get('name')}", flush=True)
            args = ev.get("args", ev.get("arguments"))
            if args:
                print(f"  args: {_truncate(str(args), 300)}", flush=True)
        elif t == "tool_result":
            result = str(ev.get("result", ""))
            print(f"\n[tool_result] {ev.get('name')}", flush=True)
            print(f"  {_truncate(result, tool_result_max)}", flush=True)
        elif t == "finish":
            if isinstance(ev.get("text"), str):
                final = ev["text"]
            print(f"\n[finish] reason={ev.get('reason')}", flush=True)
        elif t == "error":
            raise AgentClientError(str(ev.get("message", "stream error")), 0, ev)
        elif t == "unknown":
            print(f"\n[unknown] event={ev.get('event')} data={ev.get('data')}", flush=True)

    if deltas or final:
        print(flush=True)
    return final if final is not None else "".join(deltas)


def _print_stream(events: Iterable[Mapping[str, object]], *, label: str = "") -> str:
    """Drain an SSE event stream to stdout; return the final text."""
    if label:
        print(label, flush=True)
    text = collect_text(events)
    if text:
        print(text, flush=True)
    return text


def test_health(agent: AgentClient | None = None) -> dict[str, Any]:
    """GET /health — readiness check (no auth required)."""
    agent = agent or create_client()
    print("== health ==")
    result = agent.health()
    print(result)
    return result


def test_list_skills(agent: AgentClient | None = None) -> list[dict[str, Any]]:
    """List discoverable skills for the pinned workspace."""
    agent = agent or create_client()
    print("\n== skills ==")
    skills: list[dict[str, Any]] = agent.list_skills()["skills"]
    if not skills:
        print("(no skills found in this workspace)")
        return skills
    for s in skills:
        print(f"  - {s['name']:30} [{s['context']}] {s['description'][:60]}")
    return skills


def test_invoke_inline_skill(
    agent: AgentClient | None = None,
    *,
    skill_name: str | None = None,
) -> str | None:
    """Invoke an inline skill (template expansion only, no LLM call).

    When ``skill_name`` is omitted, uses the first inline skill found.
    """
    agent = agent or create_client()
    skills = agent.list_skills()["skills"]
    if skill_name:
        target = next((s for s in skills if s["name"] == skill_name), None)
        if not target:
            raise RuntimeError(f"skill not found: {skill_name!r}")
        if target["context"] != "inline":
            raise RuntimeError(f"skill {skill_name!r} is not inline (context={target['context']})")
    else:
        target = next((s for s in skills if s["context"] == "inline"), None)
        if not target:
            print("\n(no inline skill found, skipping)")
            return None

    name = target["name"]
    print(f"\n== invoke inline skill: {name} ==")
    out = agent.invoke_skill(name)
    result = out["result"]
    print(result[:500])
    return result


def test_invoke_fork_skill_stream(
    agent: AgentClient | None = None,
    *,
    skill_name: str | None = None,
) -> str | None:
    """Stream a fork skill invocation (calls the model).

    When ``skill_name`` is omitted, uses the first fork skill found.
    """
    agent = agent or create_client()
    skills = agent.list_skills()["skills"]
    if skill_name:
        target = next((s for s in skills if s["name"] == skill_name), None)
        if not target:
            raise RuntimeError(f"skill not found: {skill_name!r}")
        if target["context"] != "fork":
            raise RuntimeError(f"skill {skill_name!r} is not fork (context={target['context']})")
    else:
        target = next((s for s in skills if s["context"] == "fork"), None)
        if not target:
            print("\n(no fork skill found, skipping)")
            return None

    name = target["name"]
    print(f"\n== stream fork skill: {name} ==")
    for ev in agent.invoke_skill_stream(name):
        if ev["type"] == "text_delta":
            print(ev["delta"], end="", flush=True)
        elif ev["type"] == "tool_call":
            print(f"\n[tool] {ev.get('name')}", flush=True)
        elif ev["type"] == "finish":
            print("\n[done]", ev.get("reason"))
    return None


def test_chat_buffered(
    agent: AgentClient | None = None,
    *,
    message: str = "List the files in the workspace root.",
) -> dict[str, Any]:
    """One-shot buffered chat (no session reuse)."""
    agent = agent or create_client()
    print("\n== chat (buffered) ==")
    res = agent.chat_complete(message)
    print(res.get("text", "")[:500])
    print("session_id:", res.get("session_id"))
    return res


def test_wetrack_skill_stream(
    agent: AgentClient | None = None,
    *,
    query: str = "Get summary, status, and assignee for WeTrack issue DZ-149.",
    show_reasoning: bool = False,
) -> str:
    """Invoke wetrack via streaming and print intermediate steps (tool_call, etc.).

    Uses ``invoke_skill_stream`` for ``context: fork`` skills, or ``agent.chat``
    with ``/wetrack <query>`` for inline skills. Both paths yield SSE events so
    you can watch shell/API tool calls as they happen.
    """
    agent = agent or create_client()
    skills = {s["name"]: s for s in agent.list_skills()["skills"]}
    skill = skills.get("wetrack")
    if not skill:
        raise RuntimeError("wetrack skill not found in workspace")

    context = skill["context"]
    print(f"\n== wetrack skill stream (context={context}) ==")
    print(f"query: {query}")

    if context == "fork":
        events = agent.invoke_skill_stream("wetrack", query)
    else:
        message = f"/wetrack {query}"
        print(f"slash message: {message}")
        events = agent.chat(message)

    return consume_agent_stream(events, show_reasoning=show_reasoning)


def test_wetrack_skill(
    agent: AgentClient | None = None,
    *,
    query: str = "Get summary, status, and assignee for WeTrack issue DZ-149.",
) -> str:
    """Invoke the wetrack skill and query a WeTrack issue.

    For ``context: fork`` skills, calls ``invoke_skill_stream`` directly.
    For ``context: inline`` skills (the default), uses ``/wetrack <query>`` via
    chat so the agent receives both the skill instructions and the user request.
    """
    agent = agent or create_client()
    skills = {s["name"]: s for s in agent.list_skills()["skills"]}
    skill = skills.get("wetrack")
    if not skill:
        raise RuntimeError("wetrack skill not found in workspace")

    context = skill["context"]
    print(f"\n== wetrack skill test (context={context}) ==")
    print(f"query: {query}")

    if context == "fork":
        events = agent.invoke_skill_stream("wetrack", query)
        return _print_stream(events)

    message = f"/wetrack {query}"
    print(f"slash message: {message}")
    return _print_stream(agent.chat(message))


def test_chat_same_session(agent: AgentClient | None = None) -> str:
    """Multi-turn chat that reuses the same session_id across turns."""
    agent = agent or create_client()

    print("\n== chat same-session test ==")

    turn1 = agent.chat_complete("My name is Harry. Please remember it for this conversation.")
    session_id = turn1.get("session_id")
    print("\n--- turn 1 ---")
    print(turn1.get("text", ""))
    print("session_id:", session_id)

    if not session_id:
        raise RuntimeError("server did not return session_id on first turn")

    turn2 = agent.chat_complete(
        "What is my name? Answer in one short sentence.",
        session_id=session_id,
    )
    print("\n--- turn 2 (same session) ---")
    print(turn2.get("text", ""))
    print("session_id:", turn2.get("session_id"))

    if turn2.get("session_id") != session_id:
        raise RuntimeError(
            f"session_id changed: {session_id!r} -> {turn2.get('session_id')!r}"
        )

    return session_id


def main() -> None:
    agent = create_client()
    test_health(agent)
    skills = test_list_skills(agent)
    if not skills:
        return
    test_invoke_inline_skill(agent)
    test_invoke_fork_skill_stream(agent)
    test_chat_buffered(agent)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    dispatch: dict[str, Callable[[], object]] = {
        "wetrack": test_wetrack_skill_stream,
        "wetrack-stream": test_wetrack_skill_stream,
        "chat": test_chat_same_session,
        "health": test_health,
        "skills": test_list_skills,
        "inline": test_invoke_inline_skill,
        "fork": test_invoke_fork_skill_stream,
        "buffered": test_chat_buffered,
    }
    fn = dispatch.get(cmd)
    if fn:
        fn()
    else:
        main()
