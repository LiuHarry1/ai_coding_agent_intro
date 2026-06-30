"""End-to-end demo of the Python agent client against an SSO deployment.

Run (from client-sdk-py/)::

    conda activate llm_ft
    pip install -e .
    set AGENT_BASE_URL=http://10.150.115.69:4567
    set AGENT_JWT_SECRET=9afd313591dc5a84dcf3022cb9f9bea05023672ca24716d1d7d9743d9be5d95d
    set AGENT_EMAIL=service@bot
    python examples/quickstart.py
"""

from __future__ import annotations

import os

from agent_client import AgentClient, collect_text


def main() -> None:
    agent = AgentClient(
        base_url=os.environ.get("AGENT_BASE_URL", "http://10.150.115.69:4567"),
        jwt_secret=os.environ.get("AGENT_JWT_SECRET", "9afd313591dc5a84dcf3022cb9f9bea05023672ca24716d1d7d9743d9be5d95d"),
        email=os.environ.get("AGENT_EMAIL", "harry.liu@advantest.com"),
    )

    print("== health ==")
    print(agent.health())

    print("\n== skills ==")
    skills = agent.list_skills()["skills"]
    for s in skills:
        print(f"  - {s['name']:30} [{s['context']}] {s['description'][:60]}")

    if not skills:
        print("(no skills found in this workspace)")
        return

    # Invoke the first inline skill we find (no LLM call, instant).
    inline = next((s for s in skills if s["context"] == "inline"), None)
    if inline:
        print(f"\n== invoke inline skill: {inline['name']} ==")
        out = agent.invoke_skill(inline["name"])
        print(out["result"][:500])

    # Stream the first fork skill, if any (this DOES call the model).
    fork = next((s for s in skills if s["context"] == "fork"), None)
    if fork:
        print(f"\n== stream fork skill: {fork['name']} ==")
        for ev in agent.invoke_skill_stream(fork["name"]):
            if ev["type"] == "text_delta":
                print(ev["delta"], end="", flush=True)
            elif ev["type"] == "tool_call":
                print(f"\n[tool] {ev.get('name')}", flush=True)
            elif ev["type"] == "finish":
                print("\n[done]", ev.get("reason"))

    # Free-form chat, buffered.
    print("\n== chat (buffered) ==")
    res = agent.chat_complete("List the files in the workspace root.")
    print(res.get("text", "")[:500])
    print("session_id:", res.get("session_id"))


if __name__ == "__main__":
    main()
