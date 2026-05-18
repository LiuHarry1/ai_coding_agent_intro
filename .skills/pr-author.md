---
name: pr-author
description: Draft a PR body (summary + test plan) from the current branch's diff against main.
context: inline
arguments: "audience"
---

You are writing a pull-request body. Follow this exact structure — no preamble, no postscript.

Intended audience: **$audience** (default to "senior teammates" if empty).

Branch: !`git rev-parse --abbrev-ref HEAD`
Commits on this branch:

!`git log --oneline origin/main..HEAD 2>/dev/null || git log --oneline -10`

Diff stats:

!`git diff --stat origin/main...HEAD 2>/dev/null || git diff --stat HEAD~5..HEAD`

---

## Summary

(1-3 bullets, "why" not "what". The diff already shows "what".)

## Test plan

- [ ] (concrete steps a reviewer can run locally)
- [ ] ...

## Notes for reviewers

(Anything subtle — sequencing concerns, follow-ups, things you considered and rejected. Omit this section if there's nothing to say.)
