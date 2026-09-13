# Memory Flow: One Message

> Beginner-friendly overview. Full detail: [agent-memory-guide.md](./agent-memory-guide.md).

![Memory flow for one message](./memory-flow-simplified.svg)

## 1. Which files are Project Rules?

Yes, `AGENTS.md` is the entry file of Project Rules. `loadAllAgentRules()` merges three scopes in this order, and later entries win:

1. **Managed** policy rules (platform-pushed)
2. **User** rules: `~/.ai-agent/AGENTS.md`
3. **Project** rules: walked from `cwd` up to the git root, closer directories win

Within one directory the order is:

| Order | File |
|-------|------|
| 1 | `AGENTS.md` (repo root or a nested package) |
| 2 | `.ai-agent/AGENTS.md` |
| 3 | `.ai-agent/rules/**/*.md` |
| 4 | `.ai-agent/AGENTS.local.md` |
| 5 | `AGENTS.local.md` |

Caps are 40 KiB per file and 40 KiB combined. A rule file whose frontmatter has `paths:` is **not** in the static system prompt; it is attached as `conditional_rules` only after a tool touches a matching file.

## 2. How the two recall lanes are decided

They are **either/or, never merged**. The fast lane always runs first because it is free; the semantic lane only runs if the fast lane was not confident.

|  | Fast lane | Semantic lane |
|--|-----------|---------------|
| How | keyword score on file name, `name`, `description` | small model reads the manifest and picks |
| Cost | no model call | one side query |
| Wins when | exact identity phrase, **or** top score >= `0.82` and leads #2 by >= `0.12` | the fast lane produced no strong hit |
| Result | up to 3 files, attached before step 1 | up to 5 files, attached after a later step |
| Waiting | none | none, unless you explicitly ask to recall, then up to 4s |

Two more cut-offs:

- A strong fast hit sets `skipSemantic` — the semantic lane never starts that turn.
- If there is no strong hit **and** the query has no whitespace and is under 10 characters, the semantic lane is skipped too, and the turn gets no recall at all.
- Files already surfaced this session, or already open via the Read tool, are filtered out of both lanes.

## 3. How the four mechanisms relate

Two of them are **stores**, two are **context-shrinking strategies**:

```
Auto Memory      store, cross-session   <- read at recall, written at turn end
Session Memory   store, this chat only  <- written each step, read by compaction
Micro compact    strategy, no model
Full compact     strategy, one LLM call
```

Compaction escalates and stops as soon as the context fits:

| Step | What | Cost | Persisted? |
|------|------|------|------------|
| A | **Micro** — clear old tool input/output from the in-process view | free | no |
| B | **Session Memory compact** — reuse `summary.md` as the summary, keep a recent tail | free (notes already written) | yes, appends a `compact_boundary` |
| C | **Full LLM compact** — model rewrites the whole active history | one LLM call | yes, appends a `compact_boundary` |

The key relationship: **Session Memory exists mainly so that step B is possible.** Because notes are written incrementally during the turn, compaction usually has a summary ready and can skip the expensive step C. Step C is the fallback when the notes are missing, stale, or when `/compact <instructions>` steers the summary.

**Auto Memory is not part of compaction at all.** It is the long-term store; compaction never reads or writes it. Conversely Session Memory never survives into the next chat.

Remote SSH turns Auto Memory off entirely; Session Memory and compaction still run.

**Last verified:** 2026-09-13
