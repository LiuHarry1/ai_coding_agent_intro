import type { EnvironmentRegistry } from './environment-registry.js'
import type {
  DirEntry,
  EnvironmentId,
  FileStat,
  FsPort,
  ReadOpts,
  WorkspaceHandle,
} from './types.js'
import { formatWorkspaceLabel } from './types.js'

/**
 * FS operations always go through the Environment's FsPort.
 * Never use Node fs here for non-local environments.
 */
export class WorkspaceService {
  constructor(private registry: EnvironmentRegistry) {}

  async ensureFs(environmentId: EnvironmentId): Promise<FsPort> {
    let conn = this.registry.getConnectionForEnv(environmentId)
    if (!conn) {
      conn = await this.registry.connect(environmentId)
    }
    return conn.openFs()
  }

  async realpath(handle: WorkspaceHandle): Promise<string> {
    const fs = await this.ensureFs(handle.environmentId)
    return fs.realpath(handle.cwd)
  }

  async normalizeHandle(handle: WorkspaceHandle): Promise<WorkspaceHandle> {
    const cwd = await this.realpath(handle)
    return { environmentId: handle.environmentId, cwd }
  }

  async list(
    handle: WorkspaceHandle,
    dirPath?: string,
  ): Promise<DirEntry[]> {
    const fs = await this.ensureFs(handle.environmentId)
    if ('listResolved' in fs && typeof (fs as { listResolved?: unknown }).listResolved === 'function') {
      const result = await (
        fs as {
          listResolved: (
            p: string,
          ) => Promise<{ dir: string; entries: DirEntry[] }>
        }
      ).listResolved(dirPath ?? handle.cwd)
      Object.defineProperty(result.entries, 'resolvedDir', {
        value: result.dir,
        enumerable: false,
      })
      return result.entries
    }
    return fs.list(dirPath ?? handle.cwd)
  }

  async listWithDir(
    handle: WorkspaceHandle,
    dirPath?: string,
  ): Promise<{ dir: string; entries: DirEntry[] }> {
    const fs = await this.ensureFs(handle.environmentId)
    const target = dirPath ?? handle.cwd
    if (
      'listResolved' in fs &&
      typeof (fs as { listResolved?: unknown }).listResolved === 'function'
    ) {
      return (
        fs as {
          listResolved: (
            p: string,
          ) => Promise<{ dir: string; entries: DirEntry[] }>
        }
      ).listResolved(target)
    }
    const entries = await fs.list(target)
    const dir = await fs.realpath(target).catch(() => target)
    return { dir, entries }
  }

  async stat(handle: WorkspaceHandle, filePath: string): Promise<FileStat> {
    const fs = await this.ensureFs(handle.environmentId)
    return fs.stat(filePath)
  }

  async read(
    handle: WorkspaceHandle,
    filePath: string,
    opts?: ReadOpts,
  ): Promise<Uint8Array | string> {
    const fs = await this.ensureFs(handle.environmentId)
    return fs.read(filePath, opts)
  }

  async label(handle: WorkspaceHandle): Promise<string> {
    const envs = await this.registry.listAll()
    const env = envs.find(e => e.id === handle.environmentId)
    return formatWorkspaceLabel(
      env ?? { displayName: handle.environmentId },
      handle,
    )
  }
}
