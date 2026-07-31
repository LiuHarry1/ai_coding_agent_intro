/**
 * Agent Worker — FS/shell/LSP for Control Plane via stdio NDJSON.
 *
 * Run: node dist/worker/baix-worker.js --stdio
 *   or: npx tsx src/worker/main.ts --stdio
 */
import * as fs from 'fs'
import * as path from 'path'
import { createInterface } from 'readline'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
  WorkerFsOp,
} from '../execution/runtime-protocol.js'
import {
  configureLspHost,
  runLspOp,
  setLspEventSender,
  shutdownLspHost,
} from './lsp-host.js'
import type { LspServerConfig } from '../core/types.js'
import { runShellCommand, type ShellKind } from '../core/shell/spawn-shell.js'
import { runRg } from './run-rg.js'

const WORKER_VERSION =
  process.env.BAIX_WORKER_VERSION ??
  process.env.npm_package_version ??
  '1.0.0'

let boundCwd: string | null = null
let boundEnvId = 'local'
let shuttingDown = false

function send(msg: RuntimeServerMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

setLspEventSender(send)

function logErr(msg: string): void {
  process.stderr.write(`[baix-worker] ${msg}\n`)
}

async function runFsOp(op: WorkerFsOp): Promise<unknown> {
  switch (op.op) {
    case 'readText':
      return fs.promises.readFile(op.path, 'utf-8')
    case 'writeText': {
      await fs.promises.mkdir(path.dirname(op.path), { recursive: true })
      await fs.promises.writeFile(op.path, op.content, 'utf-8')
      return null
    }
    case 'mkdirp': {
      await fs.promises.mkdir(op.path, { recursive: true })
      return null
    }
    case 'exists': {
      try {
        await fs.promises.access(op.path)
        return true
      } catch {
        return false
      }
    }
    case 'isDirectory': {
      try {
        return (await fs.promises.stat(op.path)).isDirectory()
      } catch {
        return false
      }
    }
    case 'exec':
      return runShellCommand({
        shell: (op.shell ?? 'bash') as ShellKind,
        command: op.command,
        cwd: op.cwd,
        timeoutMs: op.timeoutMs ?? 120_000,
        cwdFilePrefix: 'baix-worker-cwd',
      })
    case 'rg':
      return runRg({
        args: op.args,
        target: op.target,
        timeoutMs: op.timeoutMs,
      })
    default: {
      const _exhaustive: never = op
      throw new Error(`Unknown op: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

async function handle(msg: RuntimeClientMessage): Promise<void> {
  switch (msg.type) {
    case 'bind': {
      boundEnvId = msg.workspace.environmentId
      try {
        boundCwd = await fs.promises.realpath(msg.workspace.cwd)
      } catch {
        boundCwd = path.resolve(msg.workspace.cwd)
      }
      try {
        process.chdir(boundCwd)
      } catch (err) {
        send({
          type: 'error',
          message: `Cannot chdir to ${boundCwd}: ${err instanceof Error ? err.message : err}`,
        })
        return
      }
      if (msg.lspServers) {
        configureLspHost(
          boundCwd,
          msg.lspServers as Record<string, LspServerConfig>,
        )
        logErr(
          `lsp configured: ${Object.keys(msg.lspServers).join(', ') || '(none)'}`,
        )
      }
      send({
        type: 'ready',
        workspace: { environmentId: boundEnvId, cwd: boundCwd },
        workerVersion: WORKER_VERSION,
      })
      return
    }
    case 'fs_op': {
      try {
        const data = await runFsOp(msg.op)
        send({ type: 'fs_op_result', requestId: msg.requestId, ok: true, data })
      } catch (err) {
        send({
          type: 'fs_op_result',
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'lsp_op': {
      try {
        const data = await runLspOp(msg.op)
        send({
          type: 'lsp_op_result',
          requestId: msg.requestId,
          ok: true,
          data,
        })
      } catch (err) {
        send({
          type: 'lsp_op_result',
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'ping':
      send({ type: 'pong', id: msg.id })
      return
    case 'shutdown':
      shuttingDown = true
      await shutdownLspHost().catch(() => {})
      process.exit(0)
      return
    case 'interrupt':
      logErr(`interrupt ${msg.runId} (no-op in worker v1)`)
      return
    case 'control_response':
      return
    default:
      send({
        type: 'error',
        message: `Unknown message: ${(msg as { type: string }).type}`,
      })
  }
}

function main(): void {
  if (!process.argv.includes('--stdio')) {
    process.stderr.write('Usage: baix-worker --stdio\n')
    process.exit(2)
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', line => {
    if (shuttingDown) return
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: RuntimeClientMessage
    try {
      msg = JSON.parse(trimmed) as RuntimeClientMessage
    } catch {
      send({ type: 'error', message: `Invalid JSON: ${trimmed.slice(0, 120)}` })
      return
    }
    void handle(msg)
  })
  rl.on('close', () => {
    if (!shuttingDown) process.exit(0)
  })

  logErr(
    `started version=${WORKER_VERSION} pid=${process.pid} agentRoot=${process.env.BAIX_AGENT_ROOT || '(default)'}`,
  )
}

main()
