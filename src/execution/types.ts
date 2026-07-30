/**
 * Execution Environments — platform types.
 * Control Plane must not import provider internals (ssh/…).
 */

export type EnvironmentId = string

export type EnvironmentKind = 'local' | 'ssh' | 'bridge' | 'cloud' | 'direct'

export type EnvironmentCapabilities = {
  canBrowseFs: boolean
  canDeployWorker: boolean
  canForwardPorts: boolean
  requiresOnlineConnector: boolean
  credentialMode: 'broker-tunnel' | 'broker-http' | 'none'
}

export type EnvironmentDescriptor = {
  id: EnvironmentId
  kind: EnvironmentKind
  displayName: string
  defaultCwd?: string
  capabilities: EnvironmentCapabilities
  /** Provider-private connection params; opaque to Control Plane. */
  endpoint: unknown
}

export type WorkspaceHandle = {
  environmentId: EnvironmentId
  /** Absolute path inside the environment (realpath when possible). */
  cwd: string
}

export type ConnectOptions = {
  /** Override default cwd hint during connect (not required to open Runtime). */
  preferredCwd?: string
}

export type WorkerInstallInfo = {
  version: string
  path: string
  freshlyInstalled: boolean
}

export type RuntimeAuth = {
  token: string
  brokerUrl: string
  expiresAt: number
}

export type LocalPortMapping = {
  remotePort: number
  localPort: number
  url: string
}

export type DirEntry = {
  name: string
  path: string
  type: 'file' | 'dir' | 'other'
}

export type FileStat = {
  path: string
  type: 'file' | 'dir' | 'other'
  size?: number
  mtimeMs?: number
}

export type ReadOpts = {
  encoding?: BufferEncoding
}

export interface FsPort {
  list(dirPath: string): Promise<DirEntry[]>
  stat(filePath: string): Promise<FileStat>
  read(filePath: string, opts?: ReadOpts): Promise<Uint8Array | string>
  realpath(filePath: string): Promise<string>
  close(): Promise<void>
}

export interface RuntimePort {
  readonly workspace: WorkspaceHandle
  send(msg: import('./runtime-protocol.js').RuntimeClientMessage): void
  onMessage(
    handler: (
      msg: import('./runtime-protocol.js').RuntimeServerMessage,
    ) => void,
  ): () => void
  interrupt(): void
  close(): Promise<void>
  health(): Promise<'ok' | 'dead'>
}

export type ConnectionStatus = 'connected' | 'degraded' | 'disconnected'

export interface EnvironmentConnection {
  id: string
  env: EnvironmentDescriptor
  status: ConnectionStatus
  ensureWorker(desiredVersion: string): Promise<WorkerInstallInfo>
  openRuntime(cwd: string, auth: RuntimeAuth): Promise<RuntimePort>
  openFs(): FsPort
  forwardPort?(remotePort: number): Promise<LocalPortMapping>
}

export interface EnvironmentProvider {
  readonly kind: EnvironmentKind
  list(): Promise<EnvironmentDescriptor[]>
  resolve(input: string): Promise<EnvironmentDescriptor>
  connect(
    env: EnvironmentDescriptor,
    opts?: ConnectOptions,
  ): Promise<EnvironmentConnection>
  disconnect(connectionId: string): Promise<void>
}

/** Format for UI title bars, e.g. `atsrws0049:/home/u/proj`. */
export function formatWorkspaceLabel(
  env: Pick<EnvironmentDescriptor, 'displayName'>,
  handle: WorkspaceHandle,
): string {
  return `${env.displayName}:${handle.cwd}`
}

export function isWorkspaceHandle(v: unknown): v is WorkspaceHandle {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.environmentId === 'string' &&
    o.environmentId.length > 0 &&
    typeof o.cwd === 'string' &&
    o.cwd.length > 0
  )
}
