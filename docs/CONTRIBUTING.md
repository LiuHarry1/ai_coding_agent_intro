# Contributing to the Documentation

## Choose the canonical location

- User task and setup instructions belong in `readme/`.
- System explanations belong in `architecture/`.
- Product workflows belong in `features/`.

Verify implementation claims against this repository before adding them to the
documentation.

## Chapter structure

Use only the sections that add value:

1. Overview — the mental model and why the subsystem exists.
2. How it works — the main data flow.
3. Key decisions — meaningful branches and trade-offs.
4. Configuration or API — exact user-facing controls.
5. Failure modes — degraded behavior and security boundaries.
6. Source map — authoritative implementation and tests.

End consolidated architecture and feature pages with:

```markdown
**Last verified:** YYYY-MM-DD
```

## Diagrams

- Prefer a small SVG for the chapter's beginner view.
- Put detailed explanations below the diagram, not inside every node.
- Use Mermaid for flows that are easier to maintain as text.
- Verify SVGs as UTF-8 XML and check them in light and dark themes.

## Build and checks

```bash
npm run docs:check
npm run docs:build
```

The link check verifies local Markdown links and required visual assets. The
VitePress build validates page rendering, Mermaid blocks, and internal routes.
