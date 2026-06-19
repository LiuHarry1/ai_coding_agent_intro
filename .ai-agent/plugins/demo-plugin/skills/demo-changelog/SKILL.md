---
description: Draft a concise changelog entry from a short description of a change.
context: inline
arguments: "summary"
---

Write a single changelog entry for the following change: $summary

Format: `- <type>: <imperative summary>` where type is one of feat/fix/docs/refactor.
Keep it to one line. Reference bundled templates at ${PLUGIN_ROOT} if needed.
