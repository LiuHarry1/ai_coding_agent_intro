---
layout: home

hero:
  name: Coding Agent
  text: See how an AI coding system works
  tagline: Visual, source-grounded guides for users and maintainers.
  actions:
    - theme: brand
      text: Get started
      link: /readme/getting-started
    - theme: alt
      text: Understand the architecture
      link: /architecture/

features:
  - title: Use it
    details: Install the agent, connect an IDE, automate a browser, and learn the everyday workflows.
    link: /readme/getting-started
  - title: Understand it
    details: Follow one message through the turn host, agent loop, tools, memory, protocol, and execution plane.
    link: /architecture/
  - title: Extend it
    details: Add primary agents, subagents, skills, MCP servers, plugins, and language servers.
    link: /architecture/extensions
---

## Choose a reading path

### I am new to Coding Agent

Start with [Quick start](./readme/getting-started.md), then read the
[system overview](./architecture/index.md). Each architecture chapter begins
with the mental model before linking to implementation details.

### I am integrating it

Read [Protocol and clients](./architecture/protocol.md),
[Execution plane](./architecture/execution.md), and
[Extension architecture](./architecture/extensions.md).

### I maintain the codebase

Start with the [Architecture map](./architecture/index.md), then open the
chapter for the subsystem you are changing. Each chapter ends with its source
map. The [Memory guide](./architecture/memory-guide.md) is the canonical
source for memory and compaction behavior.

## Documentation policy

- The current repository implementation is the source of truth.
- Markdown chapters are canonical.
- Every consolidated chapter includes a verification date and source paths.
