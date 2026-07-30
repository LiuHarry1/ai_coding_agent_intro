import type { CredentialBroker } from './credential-broker.js'
import type { EnvironmentRegistry } from './environment-registry.js'
import type { RuntimePort, WorkspaceHandle } from './types.js'
import { readWorkerVersion } from './worker-paths.js'

function handleKey(h: WorkspaceHandle): string {
  return `${h.environmentId}::${h.cwd}`
}

/**
 * Owns open RuntimePort instances keyed by WorkspaceHandle.
 */
export class RuntimeBroker {
  private runtimes = new Map<string, RuntimePort>()

  constructor(
    private registry: EnvironmentRegistry,
    private credentials: CredentialBroker,
  ) {}

  async getOrCreate(
    handle: WorkspaceHandle,
    sessionId: string,
  ): Promise<RuntimePort> {
    const key = handleKey(handle)
    const existing = this.runtimes.get(key)
    if (existing) {
      const health = await existing.health()
      if (health === 'ok') return existing
      await existing.close().catch(() => {})
      this.runtimes.delete(key)
    }

    let conn = this.registry.getConnectionForEnv(handle.environmentId)
    if (!conn) {
      conn = await this.registry.connect(handle.environmentId, {
        preferredCwd: handle.cwd,
      })
    }

    const version = readWorkerVersion()
    await conn.ensureWorker(version)

    const auth = this.credentials.issueRuntimeAuth(
      sessionId,
      handle.environmentId,
    )
    const runtime = await conn.openRuntime(handle.cwd, auth)
    this.runtimes.set(key, runtime)
    return runtime
  }

  get(handle: WorkspaceHandle): RuntimePort | undefined {
    return this.runtimes.get(handleKey(handle))
  }

  async close(handle: WorkspaceHandle): Promise<void> {
    const key = handleKey(handle)
    const rt = this.runtimes.get(key)
    if (!rt) return
    this.runtimes.delete(key)
    await rt.close().catch(() => {})
  }

  async closeAll(): Promise<void> {
    const all = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.all(all.map(r => r.close().catch(() => {})))
  }
}
