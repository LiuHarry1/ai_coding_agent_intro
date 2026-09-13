# Testing

Last verified: 2026-09-13

## Overview

The repository uses TypeScript type-checking, executable `tsx` test scripts, Node tests for selected frontend policies, Python analytics tests, SDK builds/examples, and production builds as complementary checks. There is no checked-in GitHub Actions workflow, and the root package does not expose one all-inclusive `npm test`.

## How it works

Most backend tests are standalone scripts under `src/scripts/`; each throws on a failed assertion and exits non-zero. Root scripts aggregate the browser, memory, and compaction suites. Type-checking covers `src`, `protocol`, and `client-sdk`. The web package has its own build lifecycle, analytics has a pytest suite, and the SDK packages currently provide builds and examples rather than checked-in automated test suites.

Tests that touch filesystem policy, auth, cron, compaction, or workers generally create controlled temporary state and exercise real module boundaries. Browser coverage ranges from unit/boundary checks to Playwright, relay, extension, and live-browser paths, so environment requirements vary.

## Configuration and commands

Install root and web dependencies:

```bash
npm install
npm --prefix client/web install
```

Core checks:

```bash
npm run typecheck
npm run build:web
npm run test:density
npm run test:browser:unit
npm run test:browser
npm run test:memory
npm run test:compact
npm run check:echarts-skill
```

Targeted backend scripts can be run directly, for example:

```bash
npx tsx src/scripts/test-cron.ts
npx tsx src/scripts/test-filesystem-permissions.ts
npx tsx src/scripts/test-primary-agent-parse.ts
npx tsx src/scripts/test-worker-launch.ts
```

Python analytics commands must run in the project environment:

```bash
conda activate llm_ft
cd analytics
pip install -r requirements.txt
pytest
```

The TypeScript SDK can be checked with `npm --prefix client-sdk run typecheck`, built with `npm --prefix client-sdk run build`, and exercised against a running deployment with `npm --prefix client-sdk run example`. Its examples read `AGENT_BASE_URL`, `AGENT_JWT_SECRET`, and `AGENT_EMAIL`.

## Failure modes and security notes

- `npm run test:browser` includes live and extension-oriented checks that may require installed browsers, a paired extension, ports, or platform capabilities; use unit and boundary scripts for a hermetic first pass.
- Integration tests may contact a configured agent, model provider, SSH host, or analytics database. Verify endpoints and credentials before running them.
- Python dependencies are managed separately from Node dependencies; activate `llm_ft` before analytics commands.
- Formatting writes files. Use `npm run check:echarts-skill`, type-checking, tests, and builds for read-only verification when scope must remain unchanged.
- Passing targeted scripts does not imply full product coverage because no root command aggregates every script and package.

## Source map

- `package.json` — root build and aggregate test scripts.
- `src/scripts/` — backend executable checks.
- `src/tsconfig.json` — backend type-check configuration.
- `client/web/package.json` — frontend build and tests.
- `client-sdk/package.json` and `client-sdk/README.md` — TypeScript SDK checks.
- `client-sdk-py/` — Python SDK implementation and tests.
- `analytics/requirements.txt` and `analytics/tests/` — analytics dependencies and tests.
- `docs/readme/development.md` — local development workflow.
