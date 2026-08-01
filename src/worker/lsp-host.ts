/**
 * LSP host living inside the Agent Worker process.
 */
import { createHash } from 'crypto'
import * as path from 'path'
import type { DiagnosticFile } from '../core/types.js'
import type { LspServerConfig } from '../core/types.js'
import {
  createLspServerManager,
  type LspServerManager,
} from '../services/lsp/server-manager.js'
import type {
  RuntimeServerMessage,
  WorkerLspOp,
} from '../execution/runtime-protocol.js'

const DIAGNOSTICS_DEBOUNCE_MS = 100

let manager: LspServerManager | undefined
let managerKey = ''
let workspaceCwd = ''
let sendEvent: ((msg: RuntimeServerMessage) => void) | undefined
const pendingDiagnostics = new Map<
  string,
  { serverName: string; files: DiagnosticFile[]; timer: ReturnType<typeof setTimeout> }
>()

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Wire Worker stdout sender for lsp_event (call once from main). */
export function setLspEventSender(
  fn: ((msg: RuntimeServerMessage) => void) | undefined,
): void {
  sendEvent = fn
}

function flushDiagnosticsDebounce(): void {
  for (const entry of pendingDiagnostics.values()) {
    clearTimeout(entry.timer)
  }
  pendingDiagnostics.clear()
}

function emitDiagnosticsDebounced(
  serverName: string,
  files: DiagnosticFile[],
): void {
  const uri = files[0]?.uri ?? ''
  const key = `${serverName}\0${uri}`
  const existing = pendingDiagnostics.get(key)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    pendingDiagnostics.delete(key)
    if (!sendEvent) {
      console.error(
        `[lsp:diagnostics:verify] drop emit (no sender) server=${serverName} uri=${uri}`,
      )
      return
    }
    const count = files.reduce((n, f) => n + f.diagnostics.length, 0)
    console.error(
      `[lsp:diagnostics:verify] emit lsp_event server=${serverName} uri=${uri} diagnostics=${count}`,
    )
    sendEvent({
      type: 'lsp_event',
      event: 'diagnostics',
      serverName,
      files,
    })
  }, DIAGNOSTICS_DEBOUNCE_MS)

  pendingDiagnostics.set(key, { serverName, files, timer })
}

export function configureLspHost(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): void {
  workspaceCwd = path.resolve(cwd)
  if (!servers || Object.keys(servers).length === 0) {
    flushDiagnosticsDebounce()
    void manager?.shutdown()
    manager = undefined
    managerKey = ''
    return
  }
  const key = createHash('sha256')
    .update(workspaceCwd)
    .update('\0')
    .update(stableStringify(servers))
    .digest('hex')
  if (manager && managerKey === key) return
  flushDiagnosticsDebounce()
  void manager?.shutdown()
  manager = createLspServerManager(workspaceCwd, servers, key, {
    onDiagnostics: ({ serverName, files }) => {
      emitDiagnosticsDebounced(serverName, files)
    },
  })
  managerKey = key
}

export async function runLspOp(op: WorkerLspOp): Promise<unknown> {
  switch (op.op) {
    case 'configure': {
      configureLspHost(
        workspaceCwd || process.cwd(),
        op.servers as Record<string, LspServerConfig>,
      )
      return {
        ok: true,
        servers: manager ? [...manager.getAllServers().keys()] : [],
      }
    }
    case 'hasServerForFile': {
      if (!manager) return false
      return Boolean(manager.getServerForFile(op.filePath))
    }
    case 'ensure': {
      if (!manager) return { started: false, reason: 'no-lsp-config' }
      const server = await manager.ensureServerStarted(op.filePath)
      return {
        started: Boolean(server),
        name: server?.name,
        state: server?.state,
      }
    }
    case 'request': {
      if (!manager) throw new Error('No LSP servers configured in worker')
      return manager.sendRequest(op.filePath, op.method, op.params)
    }
    case 'openFile': {
      if (!manager) return null
      await manager.openFile(op.filePath, op.content)
      return null
    }
    case 'changeFile': {
      if (!manager) return null
      await manager.changeFile(op.filePath, op.content)
      return null
    }
    case 'saveFile': {
      if (!manager) return null
      await manager.saveFile(op.filePath)
      return null
    }
    case 'closeFile': {
      if (!manager) return null
      await manager.closeFile(op.filePath)
      return null
    }
    case 'isFileOpen': {
      if (!manager) return false
      return manager.isFileOpen(op.filePath)
    }
    case 'listStatus': {
      if (!manager) return { servers: [] as const }
      const servers = [...manager.getAllServers().values()].map(instance => {
        const extMap = instance.config.extensionToLanguage ?? {}
        return {
          name: instance.name,
          state: instance.state,
          command: instance.config.command,
          args: instance.config.args ?? [],
          extensions: Object.keys(extMap),
          languages: [...new Set(Object.values(extMap))],
          error: instance.lastError?.message,
        }
      })
      servers.sort((a, b) => a.name.localeCompare(b.name))
      return { servers }
    }
    default: {
      const _e: never = op
      throw new Error(`Unknown lsp op: ${JSON.stringify(_e)}`)
    }
  }
}

export async function shutdownLspHost(): Promise<void> {
  flushDiagnosticsDebounce()
  await manager?.shutdown()
  manager = undefined
  managerKey = ''
}
