/**
 * Unified tool execution surface — always backed by Agent Worker (RuntimePort).
 */
import type { EnvironmentId, FsPort } from './types.js'

export type ExecResult = {
  stdout: string
  stderr: string
  code: number | null
}

export interface ExecutionBackend {
  /** Always `worker` after isomorphic cut. */
  readonly kind: 'worker'
  readonly environmentId: EnvironmentId
  resolve(cwd: string, filePath: string): string
  assertInWorkspace(cwd: string, absPath: string, access: 'read' | 'write'): void
  readText(absPath: string): Promise<string>
  writeText(absPath: string, content: string): Promise<void>
  mkdirp(dirPath: string): Promise<void>
  exists(absPath: string): Promise<boolean>
  isDirectory(absPath: string): Promise<boolean>
  exec(
    command: string,
    opts: { cwd: string; timeoutMs?: number },
  ): Promise<ExecResult & { cwdAfter?: string }>
  fsPort?: FsPort
}
