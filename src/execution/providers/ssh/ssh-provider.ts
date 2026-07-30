import type {
  ConnectOptions,
  EnvironmentConnection,
  EnvironmentDescriptor,
  EnvironmentProvider,
  FsPort,
  RuntimeAuth,
  RuntimePort,
  WorkerInstallInfo,
} from '../../types.js'
import { EnvironmentRegistry } from '../../environment-registry.js'
import {
  environmentIdForAlias,
  loadSystemSshConfig,
  mergeSshHosts,
  type ParsedSshHost,
  type SshSettingsEntry,
} from './ssh-config.js'
import { sshProbe } from './ssh-exec.js'
import { SshFsPort } from './ssh-fs.js'
import { ensureRemoteWorker } from './ssh-deploy.js'
import { openSshWorkerRuntime } from './ssh-stdio-session.js'
import { readWorkerVersion } from '../../worker-paths.js'

const SSH_CAPS = {
  canBrowseFs: true,
  canDeployWorker: true,
  canForwardPorts: true,
  requiresOnlineConnector: false,
  credentialMode: 'broker-tunnel' as const,
}

function toDescriptor(host: ParsedSshHost): EnvironmentDescriptor {
  return {
    id: environmentIdForAlias(host.alias),
    kind: 'ssh',
    displayName: host.alias,
    defaultCwd: host.startDirectory,
    capabilities: SSH_CAPS,
    endpoint: host,
  }
}

function hostFromEnv(env: EnvironmentDescriptor): ParsedSshHost {
  return env.endpoint as ParsedSshHost
}

class SshConnection implements EnvironmentConnection {
  readonly id: string
  readonly env: EnvironmentDescriptor
  status: EnvironmentConnection['status'] = 'connected'
  private fsPort: SshFsPort | null = null
  private host: ParsedSshHost

  constructor(env: EnvironmentDescriptor) {
    this.id = EnvironmentRegistry.newConnectionId('ssh')
    this.env = env
    this.host = hostFromEnv(env)
  }

  private workerVersion: string | null = null

  async ensureWorker(desiredVersion: string): Promise<WorkerInstallInfo> {
    const info = await ensureRemoteWorker(this.host, desiredVersion)
    this.workerVersion = info.version
    return info
  }

  async openRuntime(cwd: string, auth: RuntimeAuth): Promise<RuntimePort> {
    const fs = this.openFs()
    const resolved = await fs.realpath(cwd)
    const version = this.workerVersion ?? readWorkerVersion()
    if (!this.workerVersion) {
      const info = await this.ensureWorker(version)
      this.workerVersion = info.version
    }
    return openSshWorkerRuntime(
      this.host,
      { environmentId: this.env.id, cwd: resolved },
      this.workerVersion,
      auth,
    )
  }

  openFs(): FsPort {
    if (!this.fsPort) this.fsPort = new SshFsPort(this.host)
    return this.fsPort
  }
}

export type SshProviderOptions = {
  /** Extra hosts from AppConfig / settings */
  settingsHosts?: SshSettingsEntry[]
  /** Override ssh config path (tests) */
  configPath?: string
}

export class SshProvider implements EnvironmentProvider {
  readonly kind = 'ssh' as const
  private connections = new Map<string, SshConnection>()
  private settingsHosts: SshSettingsEntry[]
  private configPath?: string

  constructor(opts?: SshProviderOptions) {
    this.settingsHosts = opts?.settingsHosts ?? []
    this.configPath = opts?.configPath
  }

  setSettingsHosts(hosts: SshSettingsEntry[]): void {
    this.settingsHosts = hosts
  }

  private allHosts(): ParsedSshHost[] {
    const fromFile = loadSystemSshConfig(this.configPath)
    return mergeSshHosts(fromFile, this.settingsHosts)
  }

  async list(): Promise<EnvironmentDescriptor[]> {
    return this.allHosts().map(toDescriptor)
  }

  async resolve(input: string): Promise<EnvironmentDescriptor> {
    let raw = input.trim()
    if (raw.startsWith('ssh:')) raw = raw.slice(4)

    const hosts = this.allHosts()
    const byAlias = hosts.find(
      h => h.alias === raw || h.hostName === raw || environmentIdForAlias(h.alias) === input.trim(),
    )
    if (byAlias) return toDescriptor(byAlias)

    // user@host or host
    let user: string | undefined
    let hostName = raw
    if (raw.includes('@')) {
      const idx = raw.lastIndexOf('@')
      user = raw.slice(0, idx)
      hostName = raw.slice(idx + 1)
    }
    if (!hostName || hostName.includes(' ')) {
      throw new Error(`Cannot resolve SSH host: ${input}`)
    }
    return toDescriptor({
      alias: hostName,
      hostName,
      user,
    })
  }

  async connect(
    env: EnvironmentDescriptor,
    _opts?: ConnectOptions,
  ): Promise<EnvironmentConnection> {
    if (env.kind !== 'ssh') {
      throw new Error('SshProvider cannot connect non-ssh env')
    }
    const host = hostFromEnv(env)
    await sshProbe(host)
    const conn = new SshConnection(env)
    this.connections.set(conn.id, conn)
    return conn
  }

  async disconnect(connectionId: string): Promise<void> {
    const c = this.connections.get(connectionId)
    if (!c) return
    c.status = 'disconnected'
    this.connections.delete(connectionId)
  }
}
