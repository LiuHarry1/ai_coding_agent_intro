import * as path from 'path'
import { createHash } from 'crypto'
import type { LspServerConfig } from '../../core/types.js'
import {
  createLspServerManager,
  type LspServerManager,
} from './server-manager.js'
import { resetAllLSPDiagnosticState } from './LSPDiagnosticRegistry.js'

const managers = new Map<string, LspServerManager>()

export function hasLspServers(
  servers: Record<string, LspServerConfig> | undefined,
): servers is Record<string, LspServerConfig> {
  return Boolean(servers && Object.keys(servers).length > 0)
}

/** Normalize workspace cwd without Win32-resolving remote POSIX paths. */
export function normalizeWorkspaceCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/')
  if (normalized.startsWith('/') && !/^[a-zA-Z]:/.test(cwd)) {
    return path.posix.normalize(normalized)
  }
  return path.resolve(cwd)
}

export function getLspWorkspaceKey(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): string {
  return createHash('sha256')
    .update(normalizeWorkspaceCwd(cwd))
    .update('\0')
    .update(stableStringify(servers ?? {}))
    .digest('hex')
}

export function getLspManager(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): LspServerManager | undefined {
  if (!hasLspServers(servers)) return undefined

  const key = getLspWorkspaceKey(cwd, servers)
  const existing = managers.get(key)
  if (existing) return existing

  const resolvedCwd = normalizeWorkspaceCwd(cwd)
  const manager = createLspServerManager(resolvedCwd, servers, key)
  managers.set(key, manager)
  console.log(
    `[lsp:diagnostics] manager created cwd=${resolvedCwd} servers=${Object.keys(servers).join(', ')}`,
  )
  return manager
}

export async function shutdownAllLspManagers(): Promise<void> {
  const entries = [...managers.entries()]
  managers.clear()
  await Promise.allSettled(
    entries.map(async ([key, manager]) => {
      try {
        await manager.shutdown()
      } finally {
        resetAllLSPDiagnosticState(key)
      }
    }),
  )
}

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
