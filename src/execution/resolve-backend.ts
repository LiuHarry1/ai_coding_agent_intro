import type { Session, LspServerConfig } from '../core/types.js'
import { getExecutionPlane } from './bootstrap.js'
import type { ExecutionBackend } from './execution-backend.js'
import {
  WorkerExecutionBackend,
  isWorkerExecutionBackend,
} from './worker-execution-backend.js'
import type { WorkspaceHandle } from './types.js'
import { getDefaultWorkspace } from '../core/workspace.js'

export function isRemoteWorkspace(
  workspace?: WorkspaceHandle | null,
): boolean {
  return Boolean(
    workspace &&
      workspace.environmentId !== 'local' &&
      workspace.environmentId.startsWith('ssh:'),
  )
}

/**
 * Ensure Worker Runtime is up and return ExecutionBackend over RuntimePort RPC.
 * Optionally configure LSP servers inside the Worker.
 */
export async function resolveExecutionBackend(
  session: Session,
  lspServers?: Record<string, LspServerConfig>,
): Promise<ExecutionBackend> {
  const plane = getExecutionPlane()
  const handle: WorkspaceHandle = session.workspace ?? {
    environmentId: 'local',
    cwd: getDefaultWorkspace(),
  }

  const sessionId = session.id || 'anonymous'
  const runtime = await plane.runtimes.getOrCreate(handle, sessionId)
  const backend = new WorkerExecutionBackend(
    handle.environmentId,
    runtime,
    handle.environmentId === 'local' ? 'local' : 'posix',
    handle.cwd,
    lspServers,
  )
  if (lspServers && Object.keys(lspServers).length > 0) {
    await backend.configureLsp(lspServers)
  }
  return backend
}

export { isWorkerExecutionBackend }
