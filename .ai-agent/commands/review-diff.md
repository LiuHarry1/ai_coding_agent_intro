---
description: Review the current uncommitted diff and flag bugs, style issues, and missing tests.
argument-hint: "[optional: path or focus area]"
arguments: "focus"
---

Please review the following local diff and act as a senior reviewer.

Focus area (optional, may be empty): **$focus**

Repo: !`git rev-parse --show-toplevel`
Branch: !`git rev-parse --abbrev-ref HEAD`

Diff:

!`git diff`

Untracked files worth attention:

!`git ls-files --others --exclude-standard`

For each issue, output one bullet:

- **[severity]** `file:line` — what's wrong, why it matters, and a concrete fix.

Severity: `bug` > `correctness` > `style` > `nit`. Skip lint-fixable nits. If the diff is empty, say so and stop — don't invent issues.
