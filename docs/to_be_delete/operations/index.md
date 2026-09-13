# Operations

Last verified: 2026-09-13

## Overview

This section covers the operational surfaces for execution environments, Docker deployment, analytics and quota enforcement, and repository testing.

## How it works

The Node control plane serves sessions and streams while tools execute through a workspace-bound worker backend. Local and SSH environments implement the same provider interfaces. Production Web deployments separate the static frontend from the agent API; SSO deployments can add the independent Python analytics service for reporting and daily quotas.

- [Execution API](execution-api.md) documents environments, remote files, and session workspace binding.
- [Workspace IDE API](workspace-api.md) covers file, Git, preview, upload, and download operations used by the Web UI.
- [Deployment](deployment.md) covers desktop builds and the admin and SSO Docker stacks.
- [Analytics and quota](analytics-quota.md) covers collection, reporting, cost, and daily limits.
- [Testing](testing.md) explains the available checks and their operational boundaries.

## Configuration

Runtime environment variables are documented in `.env.example`; model, tool, permission, environment, and feature settings belong in `.ai-agent/settings.json`. Container deployment values belong in `deploy/.env`, and analytics values in `analytics/.env`.

## Failure modes and security notes

- Admin mode does not authenticate the agent API; network isolation is mandatory.
- SSO filesystem checks are application-level and do not sandbox shell processes.
- SSH workers require a compatible built artifact and non-interactive SSH/SCP access.
- Analytics is decoupled from chat telemetry, but enabled quota checks affect admission decisions.

## Source map

- `deploy/README.md` — authoritative deployment procedures and cautions.
- `src/execution/` — execution-plane interfaces and providers.
- `src/server/routes/execution.ts` — execution HTTP API.
- `analytics/README.md` — analytics contract and deployment.
- `package.json` — supported build and test scripts.
