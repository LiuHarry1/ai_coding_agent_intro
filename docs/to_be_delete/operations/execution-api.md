# Execution API

Last verified: 2026-09-13

## Overview

The execution API exposes available environments, remote filesystem browsing, connection lifecycle, and the workspace bound to a session. A workspace is always identified by `{ environmentId, cwd }`; `local` and SSH use the same control-plane abstractions.

## How it works

At startup, the execution plane registers Local and SSH providers, starts the credential broker's local auth proxy when possible, and constructs shared registry, runtime, workspace, and permission services. Binding a session normalizes the handle, stores it, computes a display label, and prewarms its runtime in the background.

Providers implement environment discovery, resolution, connect/disconnect, worker installation, runtime opening, and filesystem access. SSH connections probe and upload the versioned worker bundle with non-interactive `ssh`/`scp`; local execution also runs through a worker backend.

## API

- `GET /environments` lists descriptors without provider-private endpoint data.
- `POST /environments/resolve` with `{ "input": "local-or-host" }` resolves a descriptor.
- `POST /environments/connect` accepts `environmentId` or `input`, plus optional `preferredCwd`.
- `POST /environments/disconnect` accepts `connectionId`.
- `GET /environments/fs/list?environmentId=<id>&path=<dir>` lists a directory.
- `GET /environments/fs/stat?environmentId=<id>&path=<path>` returns file metadata.
- `GET /environments/fs/file?environmentId=<id>&path=<file>` returns UTF-8 content, capped at 2 MiB with a `truncated` flag.
- `POST /sessions/:id/workspace` accepts `{ "environmentId": "...", "cwd": "..." }`.
- `GET /sessions/:id/workspace` returns the bound handle and label, or null values.

SSH hosts may be configured under `environments.ssh` with `sshHost`, optional `id`, `name`, `sshUser`, `sshPort`, `sshIdentityFile`, `proxyJump`, and `startDirectory`.

## Failure modes and security notes

- Requests return 503 if the execution plane was not bootstrapped and 500 for provider or filesystem failures; missing required query/body fields return 400.
- Session workspace endpoints enforce session ownership and return 404 when inaccessible.
- The file endpoint currently labels returned data as non-binary and requests UTF-8; it is not a general binary download API.
- SSH uses `BatchMode=yes` and a 15-second connect timeout for uploads, so password prompts cannot rescue missing key configuration.
- Provider credentials remain provider-private; worker startup uses broker/runtime authentication rather than embedding long-lived model keys in the workspace API.

## Source map

- `src/execution/types.ts` — provider, connection, runtime, filesystem, and workspace contracts.
- `src/execution/bootstrap.ts` — control-plane initialization.
- `src/server/routes/execution.ts` — HTTP routes and response shapes.
- `src/execution/environment-registry.ts` — provider lookup and connections.
- `src/execution/workspace-service.ts` — normalized filesystem operations.
- `src/execution/providers/ssh/ssh-deploy.ts` — remote worker installation.
- `docs/dev/remote/execution-architecture.md` — architecture rationale.
