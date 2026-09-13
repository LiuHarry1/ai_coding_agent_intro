# Documentation Sources

The published documentation site starts at [`index.md`](index.md). Run it
locally with:

```bash
npm run docs:dev
```

Build the static site with:

```bash
npm run docs:build
```

Documentation conventions and verification rules are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Source areas

| Directory | Audience | Purpose |
|---|---|---|
| [`readme/`](readme/getting-started.md) | Users and integrators | Installation, usage, browser, and IDE integration |
| [`architecture/`](architecture/) | All technical readers | Consolidated architecture chapters |
| [`features/`](features/) | Users and integrators | Product feature guides |

## Canonical content

- Architecture chapters under `architecture/` are the maintained system
  narrative.
- `architecture/memory-guide.md` is canonical for memory and compaction.
- Feature guides under `features/` document user-facing product workflows.
