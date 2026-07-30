/**
 * Agent Worker — FS/shell/LSP for Control Plane via stdio NDJSON.
 *
 * Run: node dist/worker/baix-worker.js --stdio
 *   or: npx tsx src/worker/main.ts --stdio
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
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
      return execCommand(op.command, op.cwd, op.timeoutMs ?? 120_000)
    default: {
      const _exhaustive: never = op
      throw new Error(`Unknown op: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  stdout: string
  stderr: string
  code: number | null
  cwdAfter?: string
}> {
  const isWin = process.platform === 'win32'
  const marker = '__BAIX_CWD__'
  const wrapped = isWin
    ? command
    : `cd ${shellQuote(cwd)} || exit 127\n${command}\n__ec=$?\necho "${marker}$(pwd -P)"\nexit $__ec`

  const shell = isWin ? 'cmd.exe' : 'bash'
  const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', wrapped]
  const spawnCwd = isWin ? cwd : undefined

  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: spawnCwd,
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`exec timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      let cwdAfter: string | undefined
      if (!isWin) {
        const idx = stdout.lastIndexOf(marker)
        if (idx >= 0) {
          cwdAfter = stdout
            .slice(idx + marker.length)
            .trim()
            .split(/\r?\n/)[0]
          stdout = stdout.slice(0, idx).replace(/\n$/, '')
        }
      }
      resolve({ stdout, stderr, code, cwdAfter })
    })
  })
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`
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
