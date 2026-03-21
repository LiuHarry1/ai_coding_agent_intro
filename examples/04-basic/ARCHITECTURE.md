# 04-basic Architecture

Visual overview of how the **primary agent**, **explore subagent**, and **HTTP/session** layers fit together.

## Diagram (image) — agent & tools only

**Primary agent** holds five tools; **`explore`** is one of them and **starts** the **Explore sub-agent** (same `runAgent`, empty messages, read-only tools).

![Primary agent, explore, Explore sub-agent](./architecture.svg)

## Primary · tools · sub-agent (Mermaid)

关系与上图一致：**主代理**挂五个工具；**`explore`** 是其中一个工具，被调用时会启动 **Explore 子代理**（同一套 `runAgent`，独立 `messages`，只读工具）。

```mermaid
flowchart TB
  subgraph primary["Primary agent — runAgent"]
    direction LR
    bash[bash]
    read_file[read_file]
    write_file[write_file]
    edit_file[edit_file]
    explore[explore]
  end

  subgraph sub["Explore sub-agent — runAgent"]
    direction LR
    s_read[read_file]
    s_bash[bash]
  end

  explore -->|tool call · isolated context · read-only| sub
```

```mermaid
flowchart LR
  subgraph shared["Shared"]
    RA["runAgent() · agent.js"]
  end

  subgraph cfgP["Primary"]
    MP["messages: session history"]
    TP["tools: bash, read_file, write_file, edit_file, explore"]
  end

  subgraph cfgS["Explore sub-agent"]
    MS["messages: empty → isolated"]
    TS["tools: read_file, bash only"]
  end

  RA --> cfgP
  RA --> cfgS
```

## Full stack: client → server → agents (Mermaid)

```mermaid
flowchart TB
  subgraph client["Client"]
    UI["Web UI\n(client/web)"]
  end

  subgraph server["Server"]
    HTTP["server.js\nPOST /chat · SSE"]
    SESS["session.js\nmessages[] · JSONL"]
  end

  subgraph primary["Primary agent — agent.js · runAgent"]
    COMP["context.js\nsummarizeIfNeeded"]
    LOOP1["streamText loop"]
    T1["Tools:\nbash · read_file · write_file · edit_file · explore"]
  end

  subgraph exploreTool["explore tool — subagents/explore.js"]
    EX["execute: runAgent\ntask + messages=[]"]
  end

  subgraph sub["Explore subagent — same runAgent"]
    LOOP2["streamText loop"]
    T2["Read-only:\nread_file · bash"]
    OUT["finalText → tool result"]
  end

  UI <-->|SSE| HTTP
  HTTP --> SESS
  HTTP --> LOOP1
  SESS -.->|conversation| LOOP1
  COMP --> LOOP1
  LOOP1 --> T1
  T1 -->|explore call| EX
  EX --> LOOP2
  LOOP2 --> T2
  LOOP2 --> OUT
  OUT -->|string result| LOOP1
```

## Request / data flow (one chat turn)

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web UI
  participant S as server.js
  participant P as Primary runAgent
  participant E as explore tool
  participant X as Explore runAgent

  U->>W: message
  W->>S: POST /chat + session_id
  S->>P: runAgent(message, session.messages, tools)
  loop Primary steps
    P->>P: streamText → tools / text
  end
  opt tool == explore
    P->>E: execute(task)
    E->>X: runAgent(task, messages=[], read-only tools)
    loop Explore steps
      X->>X: read_file / bash
    end
    X-->>E: finalText
    E-->>P: tool result string
  end
  P-->>S: append new messages
  S-->>W: SSE events
  W-->>U: UI update
```

## Same loop, two configurations

```mermaid
flowchart LR
  subgraph shared["Shared code"]
    RA["runAgent() in agent.js"]
  end

  subgraph cfg1["Primary"]
    M1["messages = session\n(full history)"]
    G1["all tools + edit"]
  end

  subgraph cfg2["Explore subagent"]
    M2["messages = []\n(isolated)"]
    G2["read_file + bash only"]
  end

  RA --> cfg1
  RA --> cfg2
```

---

*Mermaid diagrams render on GitHub/GitLab and in many Markdown viewers. If your viewer does not support Mermaid, use the ASCII overview in [README.md](./README.md).*
