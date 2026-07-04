import * as path from 'path'
import { createHash } from 'crypto'
import type { LspServerConfig } from '../../core/types.js'
import {
  createLspServerManager,
  type LspServerManager,
} from './server-manager.js'
import { clearWorkspaceLspDiagnostics } from './diagnostics.js'

const managers = new Map<string, LspServerManager>()

export function hasLspServers(
  servers: Record<string, LspServerConfig> | undefined,
): servers is Record<string, LspServerConfig> {
  return Boolean(servers && Object.keys(servers).length > 0)
}

export function getLspWorkspaceKey(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): string {
  return createHash('sha256')
    .update(path.resolve(cwd))
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

  const manager = createLspServerManager(path.resolve(cwd), servers, key)
  managers.set(key, manager)
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
        clearWorkspaceLspDiagnostics(key)
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
